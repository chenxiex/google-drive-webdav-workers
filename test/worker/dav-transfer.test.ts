import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH, FOLDER, ORIGIN, type Mutation, installDriveMock, recordMutations, seedStandardDrive } from '../support/client';
import { MockDrive } from '../support/mock-drive';

let drive: MockDrive;

const request = (path: string, init: RequestInit = {}): Promise<Response> =>
	SELF.fetch(ORIGIN + path, {
		...init,
		headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) },
	});

beforeEach(() => {
	drive = new MockDrive();
	seedStandardDrive(drive);
	installDriveMock(drive);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const overwrite = (method: string, target = '/dav/dest.txt') => request('/dav/a.txt', {
	method, headers: { Destination: ORIGIN + target },
});
const mutationSummary = (calls: Mutation[]) => calls.map(({ method, path, body }) => ({ method, path, body }));
const isPublish = (call: Mutation) => call.method === 'PATCH' && call.body.name === 'dest.txt';
const ambiguousStatus = (failure: string) => failure === 'network' ? 500 : /^\d+$/.test(failure) ? Number(failure) : 502;
const rejectMutation = (status: number) => new Response(JSON.stringify({ error: { message: 'Injected Drive rejection' } }), { status });

describe('MOVE / COPY overwrite semantics', () => {
	it.each([
		['COPY', '/dav/cp-new.txt'],
		['MOVE', '/dav/mv-new.txt'],
	] as const)('%s to a new destination returns 201', async (method, destination) => {
		const res = await request('/dav/a.txt', { method, headers: { Destination: ORIGIN + destination } });
		expect(res.status).toBe(201);
		if (method === 'MOVE') {
			expect(res.headers.get('Location')).toBe(ORIGIN + destination);
			expect(drive.findById('file-a')?.name).toBe('mv-new.txt');
			expect(drive.children('root').some(f => f.name === 'a.txt')).toBe(false);
		} else {
			expect(drive.findById('file-a')?.name).toBe('a.txt');
			expect(drive.children('root').some(f => f.name === 'cp-new.txt')).toBe(true);
		}
	});

	it.each(['MOVE', 'COPY'])('%s with Overwrite: F onto an existing target returns 412', async method => {
		const res = await request('/dav/a.txt', {
			method,
			headers: { Destination: ORIGIN + '/dav/dest.txt', Overwrite: 'F' },
		});
		expect(res.status).toBe(412);
		expect(drive.findById('file-dest')).toBeDefined();
		expect(drive.findById('file-a')).toBeDefined();
	});

	it.each([
		['COPY', 403],
		['MOVE', 204],
	] as const)('%s onto itself returns %i', async (method, status) => {
		const res = await request('/dav/a.txt', {
			method,
			headers: { Destination: ORIGIN + '/dav/a.txt' },
		});
		expect(res.status).toBe(status);
		expect(drive.findById('file-a')).toBeDefined();
	});

	it.each([
		['MOVE', '/dav/a.txt', undefined],
		['COPY', '/dav/a.txt', undefined],
		['MOVE', '/dav/', ORIGIN + '/dav/x/'],
		['COPY', '/dav/', ORIGIN + '/dav/x/'],
	] as const)('rejects invalid %s on %s with 403', async (method, path, destination) => {
		const res = await request(path, { method, ...(destination ? { headers: { Destination: destination } } : {}) });
		expect(res.status).toBe(403);
	});

	it.each([
		'/dav/',
		'/dav/a.txt',
		'/dav/docs/',
		'/dav/tus_uploads',
		'/dav/folder/tus_uploads/file',
	])('rejects non-TUS PATCH on %s with 405 without forwarding to COPY', async path => {
		const spy = vi.spyOn(drive, 'handle');
		for (const extraHeaders of [{}, { 'Tus-Resumable': '1.0.0' }] as Record<string, string>[]) {
			const res = await request(path, {
				method: 'PATCH',
				headers: { Destination: ORIGIN + '/dav/cp-new.txt', ...extraHeaders },
			});
			expect(res.status).toBe(405);
			expect(await res.text()).toBe('Method Not Allowed');
		}
		expect(spy).not.toHaveBeenCalled();
		expect(drive.children('root').some(f => f.name === 'cp-new.txt')).toBe(false);
	});
});

describe('recoverable overwrite operations', () => {
	it('MOVE trashes the old target before moving the source and never deletes it', async () => {
		const calls = recordMutations(drive);
		expect((await overwrite('MOVE')).status).toBe(204);
		expect(mutationSummary(calls)).toEqual([
			{ method: 'PATCH', path: '/drive/v3/files/file-dest', body: { trashed: true } },
			{ method: 'PATCH', path: '/drive/v3/files/file-a', body: { name: 'dest.txt' } },
		]);
		expect(drive.findById('file-dest')).toMatchObject({ name: 'dest.txt', size: 456, trashed: true });
		expect(drive.findById('file-a')).toMatchObject({ name: 'dest.txt', size: 123, parents: ['root'] });
	});

	it('cross-parent MOVE explicitly adds the destination parent and removes the source parent', async () => {
		drive.findById('file-dest')!.parents = ['folder-docs'];
		const calls = recordMutations(drive);
		expect((await overwrite('MOVE', '/dav/docs/dest.txt')).status).toBe(204);
		expect(calls.map(c => c.method)).toEqual(['PATCH', 'PATCH']);
		expect(calls[1].url.searchParams.get('addParents')).toBe('folder-docs');
		expect(calls[1].url.searchParams.get('removeParents')).toBe('root');
		expect(drive.findById('file-a')).toMatchObject({ name: 'dest.txt', parents: ['folder-docs'] });
		expect(drive.findById('file-dest')?.trashed).toBe(true);
	});

	it.each(['root', 'folder-docs'])('COPY stages before trashing and publishing in parent %s', async parentId => {
		drive.findById('file-dest')!.parents = [parentId];
		const calls = recordMutations(drive);
		expect((await overwrite('COPY', parentId === 'root' ? '/dav/dest.txt' : '/dav/docs/dest.txt')).status).toBe(204);
		const copied = drive.files.find(f => !['file-a', 'file-dest'].includes(f.id) && f.name === 'dest.txt' && !f.trashed)!;
		expect(copied).toMatchObject({ parents: [parentId], size: 123 });
		expect(mutationSummary(calls)).toEqual([
			{ method: 'POST', path: '/drive/v3/files/file-a/copy', body: { name: expect.stringMatching(/^\.webdav-copy-[0-9a-f-]{36}$/i), parents: [parentId] } },
			{ method: 'PATCH', path: '/drive/v3/files/file-dest', body: { trashed: true } },
			{ method: 'PATCH', path: '/drive/v3/files/' + copied.id, body: { name: 'dest.txt' } },
		]);
		expect(drive.findById('file-dest')?.trashed).toBe(true);
		expect(drive.findById('file-a')).toMatchObject({ name: 'a.txt', size: 123, parents: ['root'] });
	});

	it.each(['MOVE', 'COPY'])('%s aborts publication when destination trashing fails', async method => {
		const calls = recordMutations(drive, async call => call.path === '/drive/v3/files/file-dest' && call.body.trashed === true ? rejectMutation(403) : undefined);
		expect((await overwrite(method)).status).toBe(403);
		expect(calls.some(isPublish)).toBe(false);
		expect(calls.map(c => c.method)).toEqual(method === 'COPY' ? ['POST', 'PATCH', 'PATCH'] : ['PATCH']);
		expect(drive.findById('file-dest')).toMatchObject({ name: 'dest.txt', size: 456 });
		expect(drive.findById('file-dest')?.trashed).not.toBe(true);
		expect(drive.findById('file-a')?.name).toBe('a.txt');
		if (method === 'COPY') {
			expect(drive.files.some(f => f.name.startsWith('.webdav-copy-') && f.trashed)).toBe(true);
			expect(drive.files.some(f => f.name.startsWith('.webdav-copy-') && !f.trashed)).toBe(false);
		}
	});

	it.each(['network', '500', 'source-id'])('COPY preserves a committed stage after ambiguous %s response without touching the target', async failure => {
		const calls = recordMutations(drive, async (call, commit) => {
			if (call.method !== 'POST') return;
			await commit();
			if (failure === 'network') throw new Error('Injected lost staging response');
			if (failure === '500') return rejectMutation(500);
			return new Response(JSON.stringify({ id: 'file-a' }), { status: 200 });
		});
		expect((await overwrite('COPY')).status).toBe(ambiguousStatus(failure));
		expect(calls.map(c => c.method)).toEqual(['POST']);
		expect(drive.findById('file-dest')?.trashed).not.toBe(true);
		expect(drive.findById('file-a')?.name).toBe('a.txt');
		expect(drive.files.some(f => f.name === calls[0].body.name && !f.trashed)).toBe(true);
	});

	it.each([
		{ method: 'MOVE', failure: '500' },
		{ method: 'MOVE', failure: '408' },
		{ method: 'COPY', failure: 'network' },
	])('$method aborts without rollback when trashing commits but its $failure response is ambiguous', async ({ method, failure }) => {
		const calls = recordMutations(drive, async (call, commit) => {
			if (call.path !== '/drive/v3/files/file-dest' || call.body.trashed !== true) return;
			await commit();
			if (failure === 'network') throw new Error('Injected lost trash response');
			return rejectMutation(Number(failure));
		});
		expect((await overwrite(method)).status).toBe(ambiguousStatus(failure));
		expect(calls.map(c => c.method)).toEqual(method === 'COPY' ? ['POST', 'PATCH', 'PATCH'] : ['PATCH']);
		expect(drive.findById('file-dest')?.trashed).toBe(true);
		expect(drive.findById('file-a')?.name).toBe('a.txt');
		if (method === 'COPY') {
			expect(drive.files.some(f => f.name === calls[0].body.name && f.trashed)).toBe(true);
			expect(drive.files.some(f => f.name === calls[0].body.name && !f.trashed)).toBe(false);
		}
	});

	it('COPY staging failure leaves the target untouched and retries use distinct staging names', async () => {
		let failStage = true;
		const calls = recordMutations(drive, async call => {
			if (failStage && call.method === 'POST') return rejectMutation(403);
			if (!failStage && call.path === '/drive/v3/files/file-dest' && call.body.trashed === true) return rejectMutation(403);
		});
		expect((await overwrite('COPY')).status).toBe(403);
		expect(calls.map(c => c.method)).toEqual(['POST']);
		expect(drive.findById('file-dest')?.trashed).not.toBe(true);

		failStage = false;
		calls.length = 0;
		expect((await overwrite('COPY')).status).toBe(403);
		expect((await overwrite('COPY')).status).toBe(403);
		const names = calls.filter(c => c.method === 'POST').map(c => c.body.name);
		expect(names).toHaveLength(2);
		expect(new Set(names).size).toBe(2);
		expect(drive.files.filter(f => names.includes(f.name) && f.trashed)).toHaveLength(2);
		expect(drive.files.filter(f => names.includes(f.name) && !f.trashed)).toHaveLength(0);
		expect(calls.some(c => c.method === 'DELETE')).toBe(false);
	});

	it.each(['MOVE', 'COPY'])('%s restores the old destination after definitive 403 publication rejection', async method => {
		const calls = recordMutations(drive, async call => isPublish(call) ? rejectMutation(403) : undefined);
		expect((await overwrite(method)).status).toBe(403);
		expect(calls.map(c => c.method)).toEqual(method === 'COPY' ? ['POST', 'PATCH', 'PATCH', 'PATCH', 'PATCH'] : ['PATCH', 'PATCH', 'PATCH']);
		expect(mutationSummary(calls).some(c => c.method === 'PATCH' && c.path === '/drive/v3/files/file-dest' && c.body.trashed === false)).toBe(true);
		expect(drive.findById('file-dest')).toMatchObject({ name: 'dest.txt', size: 456, trashed: false });
		expect(drive.findById('file-a')?.name).toBe('a.txt');
		if (method === 'COPY') {
			expect(drive.files.some(f => f.name.startsWith('.webdav-copy-') && f.trashed)).toBe(true);
			expect(drive.files.some(f => f.name.startsWith('.webdav-copy-') && !f.trashed)).toBe(false);
		}
	});

	it.each(['MOVE', 'COPY'])('%s reports failure if destination restoration is rejected', async method => {
		const calls = recordMutations(drive, async call => isPublish(call) || call.body.trashed === false ? rejectMutation(403) : undefined);
		const res = await overwrite(method);
		expect(res.status).toBe(403);
		expect(await res.text()).toContain('destination restore failed');
		expect(calls.some(c => c.path === '/drive/v3/files/file-dest' && c.body.trashed === false)).toBe(true);
		expect(calls.some(c => c.method === 'DELETE')).toBe(false);
		expect(drive.findById('file-dest')?.trashed).toBe(true);
		expect(drive.findById('file-a')?.name).toBe('a.txt');
		if (method === 'COPY') {
			expect(calls.at(-1)?.body).toEqual({ trashed: true });
			expect(drive.files.some(f => f.name.startsWith('.webdav-copy-') && f.trashed)).toBe(true);
		}
	});

	it.each([
		{ method: 'MOVE', failure: 'network', committed: true },
		{ method: 'MOVE', failure: '408', committed: true },
		{ method: 'MOVE', failure: 'wrong-id', committed: true },
		{ method: 'COPY', failure: 'network', committed: false },
	])('$method does not undo or delete after ambiguous $failure publication (committed=$committed)', async ({ method, failure, committed }) => {
		const calls = recordMutations(drive, async (call, commit) => {
			if (!isPublish(call)) return;
			if (committed) await commit();
			if (failure === 'network') throw new Error('Injected connection loss');
			if (failure === 'wrong-id') return new Response(JSON.stringify({ id: 'unrelated-id' }), { status: 200 });
			return rejectMutation(Number(failure));
		});
		expect((await overwrite(method)).status).toBe(ambiguousStatus(failure));
		expect(calls.map(c => c.method)).toEqual(method === 'COPY' ? ['POST', 'PATCH', 'PATCH'] : ['PATCH', 'PATCH']);
		expect(drive.findById('file-dest')).toMatchObject({ name: 'dest.txt', size: 456, trashed: true });
		expect(drive.findById('file-a')?.name).toBe(method === 'MOVE' && committed ? 'dest.txt' : 'a.txt');
		if (method === 'COPY') expect(drive.files.some(f => f.id !== 'file-dest' && f.name === (committed ? 'dest.txt' : calls[0].body.name))).toBe(true);
	});
});

describe('MOVE / COPY destructive-operation guards', () => {
	it.each(['MOVE', 'COPY'])('%s protects an identical Drive ID resolved through a different path', async method => {
		const handle = drive.handle.bind(drive);
		const mutations: string[] = [];
		vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
			const req = new Request(input, init);
			const url = new URL(req.url);
			if (url.pathname.startsWith('/drive/v3/files') && req.method !== 'GET') mutations.push(req.method);
			const response = await handle(input, init);
			if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
				const body = await response.clone().json() as { files?: { id: string }[] };
				if (body.files?.some(f => f.id === 'file-dest')) {
					body.files = body.files.map(f => f.id === 'file-dest' ? { ...f, id: 'file-a' } : f);
					return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
				}
			}
			return response;
		});
		expect((await overwrite(method)).status).toBe(method === 'MOVE' ? 204 : 403);
		expect(mutations).toEqual([]);
		expect(drive.findById('file-a')?.name).toBe('a.txt');
		expect(drive.findById('file-dest')?.trashed).not.toBe(true);
	});

	it.each(['MOVE', 'COPY'])('%s resolves a trailing-slash self destination without mutations', async method => {
		const calls = recordMutations(drive);
		const res = await request('/dav/docs', { method, headers: { Destination: ORIGIN + '/dav/docs/' } });
		expect(res.status).toBe(method === 'MOVE' ? 204 : 403);
		expect(calls).toEqual([]);
		expect(drive.findById('folder-docs')).toBeDefined();
		expect(drive.findById('file-b')).toBeDefined();
	});

	it.each(['MOVE', 'COPY'].flatMap(method => [
		{ source: '/dav/docs/', destination: '/dav/docs/sub%26dir/' },
		{ source: '/dav/docs/', destination: '/dav/docs/new-child/' },
		{ source: '/dav/docs/sub%26dir/', destination: '/dav/docs/' },
		{ source: '/dav/docs/b%20%26%20c.txt', destination: '/dav/docs/' },
	].map(paths => ({ method, ...paths }))))('$method rejects related paths $source → $destination before mutation', async ({ method, source, destination }) => {
		const calls = recordMutations(drive);
		expect((await request(source, { method, headers: { Destination: ORIGIN + destination } })).status).toBe(403);
		expect(calls).toEqual([]);
		expect(drive.findById('folder-docs')).toBeDefined();
		expect(drive.findById('file-b')).toBeDefined();
	});

	it.each(['MOVE', 'COPY'].flatMap(method => ['/dav/missing/file.txt', '/dav/dest.txt/file.txt'].map(destination => ({ method, destination }))))(
		'$method rejects missing or non-folder parent $destination before mutation', async ({ method, destination }) => {
			const calls = recordMutations(drive);
			expect((await overwrite(method, destination)).status).toBe(409);
			expect(calls).toEqual([]);
			expect(drive.findById('file-a')?.name).toBe('a.txt');
		},
	);

	it('MOVE of a directory invalidates cached descendant paths', async () => {
		expect((await request('/dav/docs/b%20%26%20c.txt', { method: 'HEAD' })).status).toBe(200);
		const calls = recordMutations(drive);
		const res = await request('/dav/docs/', { method: 'MOVE', headers: { Destination: ORIGIN + '/dav/renamed/' } });
		expect(res.status).toBe(201);
		expect(calls.map(c => c.method)).toEqual(['PATCH']);
		expect((await request('/dav/docs/b%20%26%20c.txt', { method: 'HEAD' })).status).toBe(404);
		expect((await request('/dav/renamed/b%20%26%20c.txt', { method: 'HEAD' })).status).toBe(200);
		expect(drive.findById('folder-docs')?.name).toBe('renamed');
		expect(drive.findById('file-b')?.parents).toEqual(['folder-docs']);
	});
});

describe('recoverable collection overwrites', () => {
	let targetName: string;
	function targetTree(): void {
		targetName = 'target-tree-' + crypto.randomUUID();
		drive.add({ id: 'old-tree', name: targetName, mimeType: FOLDER, parents: ['root'] });
		drive.add({ id: 'old-sub', name: 'nested', mimeType: FOLDER, parents: ['old-tree'] });
		drive.add({ id: 'old-leaf', name: 'keep.bin', mimeType: 'application/octet-stream', parents: ['old-sub'], content: new Uint8Array([1, 2, 255]), size: 3 });
		drive.add({ id: 'old-trash', name: 'already-trashed', mimeType: 'text/plain', parents: ['old-tree'], trashed: true });
	}
	const transfer = (method: string, folder = false) => request(folder ? '/dav/docs/' : '/dav/a.txt', {
		method, headers: { Destination: ORIGIN + '/dav/' + targetName + '/' },
	});

	it.each(['MOVE', 'COPY'])('%s replacing a collection preserves its whole tree in Trash and evicts cached descendants', async method => {
		targetTree();
		expect((await request('/dav/' + targetName + '/nested/keep.bin', { method: 'HEAD' })).status).toBe(200);
		const calls = recordMutations(drive);
		expect((await transfer(method)).status).toBe(204);
		for (const id of ['old-tree', 'old-trash', 'old-sub', 'old-leaf']) expect(drive.findById(id)?.trashed).toBe(true);
		expect(drive.findById('old-leaf')?.content).toEqual(new Uint8Array([1, 2, 255]));
		expect((await request('/dav/' + targetName + '/nested/keep.bin', { method: 'HEAD' })).status).toBe(404);
		expect((await request('/dav/' + targetName, { method: 'HEAD' })).status).toBe(200);
		expect(calls.some(c => c.method === 'DELETE')).toBe(false);
	});

	it('MOVE hides old paths even while descendant trash flags lag behind the parent', async () => {
		targetTree();
		expect((await request('/dav/' + targetName + '/nested/keep.bin', { method: 'HEAD' })).status).toBe(200);
		recordMutations(drive, async (call, commit) => {
			if (call.body.trashed !== true) return;
			const response = await commit();
			// Observed live transient state; timing is intentionally deterministic.
			for (const id of ['old-sub', 'old-leaf']) drive.findById(id)!.trashed = false;
			return response;
		});
		expect((await transfer('MOVE')).status).toBe(204);
		// Publication may recompute the mock's settled flags. Reproduce stale
		// descendant reads at the moment the client next resolves the old path.
		for (const id of ['old-sub', 'old-leaf']) drive.findById(id)!.trashed = false;
		expect((await request('/dav/' + targetName + '/nested/keep.bin', { method: 'HEAD' })).status).toBe(404);
	});

	it('folder MOVE overwrites an unrelated folder without losing either subtree', async () => {
		targetTree();
		expect((await request('/dav/docs/b%20%26%20c.txt', { method: 'HEAD' })).status).toBe(200);
		expect((await request('/dav/' + targetName + '/nested/keep.bin', { method: 'HEAD' })).status).toBe(200);
		const calls = recordMutations(drive);
		expect((await transfer('MOVE', true)).status).toBe(204);
		expect(drive.findById('old-tree')?.trashed).toBe(true);
		expect(drive.findById('old-leaf')?.parents).toEqual(['old-sub']);
		expect(drive.findById('file-b')?.trashed).not.toBe(true);
		expect(drive.findById('file-b')?.parents).toEqual(['folder-docs']);
		expect((await request('/dav/docs/b%20%26%20c.txt', { method: 'HEAD' })).status).toBe(404);
		expect((await request('/dav/' + targetName + '/b%20%26%20c.txt', { method: 'HEAD' })).status).toBe(200);
		expect((await request('/dav/' + targetName + '/nested/keep.bin', { method: 'HEAD' })).status).toBe(404);
		expect(calls.map(c => c.method)).toEqual(['PATCH', 'PATCH']);
	});

	it('MOVE restores the destination tree after an injected publication rejection, including independently trashed children', async () => {
		targetTree();
		const calls = recordMutations(drive, async call => call.body.name === targetName ? rejectMutation(403) : undefined);
		expect((await transfer('MOVE')).status).toBe(403);
		expect(drive.findById('old-tree')?.trashed).toBe(false);
		for (const id of ['old-sub', 'old-leaf']) expect(drive.findById(id)?.trashed).not.toBe(true);
		expect(drive.findById('old-trash')).toMatchObject({ trashed: false, explicitlyTrashed: false });
		expect(drive.findById('old-leaf')?.content).toEqual(new Uint8Array([1, 2, 255]));
		expect((await request('/dav/' + targetName + '/nested/keep.bin', { method: 'HEAD' })).status).toBe(200);
		expect(calls.at(-1)?.body).toEqual({ trashed: false });
		expect(calls.some(c => c.method === 'DELETE')).toBe(false);
	});
});

describe('folder COPY (RFC 4918)', () => {
	const spyBatches = (
		intercept?: (parts: { boundary: string; ids: string[]; body: string; index: number }, commit: () => Promise<Response>) => Promise<Response | undefined>,
	) => {
		const calls: Array<{ body: string; ids: string[] }> = [];
		const handle = drive.handle.bind(drive);
		vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
			const req = new Request(input, init);
			const url = new URL(req.url);
			if (url.pathname === '/batch/drive/v3') {
				const body = new TextDecoder().decode(await req.clone().arrayBuffer());
				const ct = req.headers.get('Content-Type') ?? '';
				const boundary = ct.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)?.[1] ?? ct.match(/boundary=([^;\s]+)/i)?.[1] ?? '';
				const ids = [...body.matchAll(/Content-ID:\s*<([^>]+)>/g)].map(m => m[1]);
				const index = calls.push({ body, ids }) - 1;
				const response = await intercept?.({ boundary, ids, body, index }, () => handle(input, init));
				if (response) return response;
			}
			return handle(input, init);
		});
		return calls;
	};

	function batchMockResponse(boundary: string, items: Array<{ id: string; status: number; headers?: Record<string, string>; body?: unknown }>): Response {
		const encoder = new TextEncoder();
		const chunks = items.map(item => {
			const body = item.body === undefined ? '' : typeof item.body === 'string' ? item.body : JSON.stringify(item.body);
			const headers = Object.entries({
				'Content-Type': 'application/json; charset=UTF-8',
				'Content-Length': String(encoder.encode(body).byteLength),
				...item.headers,
			}).map(([k, v]) => `${k}: ${v}`).join('\r\n');
			return `\r\n--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-${item.id}>\r\n\r\nHTTP/1.1 ${item.status} Status\r\n${headers}\r\n\r\n${body}`;
		});
		return new Response(chunks.join('') + `\r\n--${boundary}--\r\n`, {
			status: 200,
			headers: { 'Content-Type': `multipart/mixed; boundary=${boundary}` },
		});
	}

	async function seedRichDocsTree() {
		const docs = drive.findById('folder-docs')!;
		docs.description = 'docs-desc';
		docs.starred = true;
		docs.folderColorRgb = '#f83a22';
		const fileB = drive.findById('file-b')!;
		fileB.content = new TextEncoder().encode('hello-b');
		fileB.size = 7;

		await request('/dav/docs/', {
			method: 'PROPPATCH',
			body: '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><X:folderTag>shallow-val</X:folderTag><D:getlastmodified>Mon, 04 Mar 2024 05:06:07 GMT</D:getlastmodified></D:prop></D:set><D:remove><D:prop><D:displayname/></D:prop></D:remove></D:propertyupdate>',
		});
		await request('/dav/docs/b%20%26%20c.txt', {
			method: 'PROPPATCH',
			body: '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><X:fileTag>leaf-val</X:fileTag></D:prop></D:set></D:propertyupdate>',
		});

		drive.add({
			id: 'file-deep',
			name: 'deep-αβγ.bin',
			mimeType: 'application/octet-stream',
			parents: ['folder-sub'],
			content: new Uint8Array([0, 1, 255, 42]),
			size: 4,
			appProperties: { nestedKey: 'nestedVal' },
		});
		drive.add({ id: 'file-pwd', name: '.password', mimeType: 'text/plain', parents: ['folder-docs'], content: new Uint8Array([1]), size: 1 });
		drive.add({ id: 'gdoc-hidden', name: 'Workspace Doc', mimeType: 'application/vnd.google-apps.document', parents: ['folder-docs'] });
		drive.add({ id: 'shortcut-hidden', name: 'Link', mimeType: 'application/vnd.google-apps.shortcut', parents: ['folder-sub'] });
	}

	it.each(['1', 'invalid', ''])('rejects invalid Depth "%s" on COPY with 400 before any mutation', async depth => {
		const calls = recordMutations(drive);
		const res = await request('/dav/docs/', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/dav/docs-copy/', Depth: depth },
		});
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	it.each([
		{ label: 'Overwrite: F on existing folder', path: '/dav/docs/', headers: { Destination: ORIGIN + '/dav/existing-dir/', Overwrite: 'F' } as Record<string, string>, status: 412 },
		{ label: 'missing parent', path: '/dav/docs/', headers: { Destination: ORIGIN + '/dav/missing/copy/' }, status: 409 },
		{ label: 'non-folder parent', path: '/dav/docs/', headers: { Destination: ORIGIN + '/dav/dest.txt/copy/' }, status: 409 },
		{ label: 'self copy', path: '/dav/docs/', headers: { Destination: ORIGIN + '/dav/docs/' }, status: 403 },
	])('rejects folder COPY ($label) with $status before mutation', async ({ path, headers, status }) => {
		drive.add({ id: 'folder-existing', name: 'existing-dir', mimeType: FOLDER, parents: ['root'] });
		const calls = recordMutations(drive);
		const res = await request(path, { method: 'COPY', headers });
		expect(res.status).toBe(status);
		expect(calls).toEqual([]);
	});

	it.each([
		{ mode: 'new', expectedStatus: 201 },
		{ mode: 'overwrite-folder', expectedStatus: 204 },
		{ mode: 'overwrite-file', expectedStatus: 204 },
	] as const)('Depth: 0 shallow copies folder metadata and properties without batching or children ($mode -> $expectedStatus)', async ({ mode, expectedStatus }) => {
		await seedRichDocsTree();
		const destName = `shallow-${mode}-${crypto.randomUUID()}`;
		const destination = mode === 'overwrite-file' ? `/dav/${destName}` : `/dav/${destName}/`;
		const targetId = mode === 'new' ? undefined : `target-${crypto.randomUUID()}`;
		if (mode === 'overwrite-folder') {
			drive.add({ id: targetId!, name: destName, mimeType: FOLDER, parents: ['root'] });
			drive.add({ id: 'existing-child-' + crypto.randomUUID(), name: 'old.txt', mimeType: 'text/plain', parents: [targetId!], content: new Uint8Array([9]), size: 1 });
		} else if (mode === 'overwrite-file') {
			drive.add({ id: targetId!, name: destName, mimeType: 'text/plain', parents: ['root'], content: new Uint8Array([9]), size: 1 });
		}
		const batches = spyBatches();
		const res = await request('/dav/docs/', {
			method: 'COPY',
			headers: { Destination: ORIGIN + destination, Depth: '0' },
		});
		expect(res.status).toBe(expectedStatus);
		expect(batches).toHaveLength(0);

		const copiedFolder = drive.children('root').find(f => f.name === destName && !f.trashed)!;
		expect(copiedFolder).toMatchObject({
			mimeType: FOLDER,
			description: 'docs-desc',
			starred: true,
			folderColorRgb: '#f83a22',
			modifiedTime: '2024-03-04T05:06:07.000Z',
		});
		expect(drive.children(copiedFolder.id)).toEqual([]);

		const propRes = await request(destination, { method: 'PROPFIND', headers: { Depth: '0' } });
		expect(propRes.status).toBe(207);
		const propXml = await propRes.text();
		expect(propXml).toContain('shallow-val');
		expect(propXml).not.toContain('displayname');

		if (targetId) {
			expect(drive.findById(targetId)?.trashed).toBe(true);
		}
	});

	it.each(['infinity', undefined])('Depth: %s copies full nested tree, bytes, and dead properties while skipping hidden items', async depth => {
		await seedRichDocsTree();
		const targetName = 'target-' + crypto.randomUUID();
		drive.add({ id: 'old-tree', name: targetName, mimeType: FOLDER, parents: ['root'] });
		drive.add({ id: 'old-sub', name: 'nested', mimeType: FOLDER, parents: ['old-tree'] });
		drive.add({ id: 'old-leaf', name: 'keep.bin', mimeType: 'application/octet-stream', parents: ['old-sub'], content: new Uint8Array([1, 2]), size: 2 });
		drive.add({ id: 'old-trash', name: 'already-trashed', mimeType: 'text/plain', parents: ['old-tree'], trashed: true });
		expect((await request(`/dav/${targetName}/nested/keep.bin`, { method: 'HEAD' })).status).toBe(200);

		const batches = spyBatches();
		const newDest = `/dav/full-copy-${depth ?? 'default'}/`;
		const createRes = await request('/dav/docs/', {
			method: 'COPY',
			headers: { Destination: ORIGIN + newDest, ...(depth ? { Depth: depth } : {}) },
		});
		expect(createRes.status).toBe(201);
		expect(batches.length).toBeGreaterThanOrEqual(3);

		const deepGet = await request(newDest + 'sub%26dir/deep-%CE%B1%CE%B2%CE%B3.bin', { method: 'GET' });
		expect(deepGet.status).toBe(200);
		expect(new Uint8Array(await deepGet.arrayBuffer())).toEqual(new Uint8Array([0, 1, 255, 42]));

		const leafProp = await (await request(newDest + 'b%20%26%20c.txt', { method: 'PROPFIND', headers: { Depth: '0' } })).text();
		expect(leafProp).toContain('leaf-val');
		expect((await request(newDest + 'Workspace%20Doc', { method: 'HEAD' })).status).toBe(404);
		expect((await request(newDest + 'sub%26dir/Link', { method: 'HEAD' })).status).toBe(404);
		expect((await request(newDest + '.password', { method: 'HEAD' })).status).toBe(200);
		expect(drive.findById('file-b')?.parents).toEqual(['folder-docs']);

		const overwriteRes = await request('/dav/docs/', {
			method: 'COPY',
			headers: { Destination: ORIGIN + `/dav/${targetName}/`, ...(depth ? { Depth: depth } : {}) },
		});
		expect(overwriteRes.status).toBe(204);
		for (const id of ['old-tree', 'old-sub', 'old-leaf', 'old-trash']) expect(drive.findById(id)?.trashed).toBe(true);
		expect((await request(`/dav/${targetName}/nested/keep.bin`, { method: 'HEAD' })).status).toBe(404);
		expect((await request(`/dav/${targetName}/sub%26dir/deep-%CE%B1%CE%B2%CE%B3.bin`, { method: 'HEAD' })).status).toBe(200);
	});

	it('chunks >100 child operations across multiple Drive batch calls', async () => {
		for (let i = 0; i < 125; i++) {
			drive.add({ id: `many-${i}`, name: `f-${String(i).padStart(3, '0')}.txt`, mimeType: 'text/plain', parents: ['folder-docs'], content: new Uint8Array([i % 256]), size: 1 });
		}
		const batches = spyBatches();
		const res = await request('/dav/docs/', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/dav/many-copy/' },
		});
		expect(res.status).toBe(201);
		expect(batches.every(b => b.ids.length <= 100)).toBe(true);
		expect(batches.some(b => b.ids.length === 100)).toBe(true);
		expect(batches.some(b => b.ids.length === 27)).toBe(true);
		const copiedFolder = drive.children('root').find(f => f.name === 'many-copy' && !f.trashed)!;
		expect(drive.children(copiedFolder.id)).toHaveLength(127);
	});

	it('retries transient 429 sub-item without duplicating already-copied siblings', async () => {
		let injected = false;
		const batches = spyBatches(async ({ boundary, ids, index }, commit) => {
			if (index === 1 && !injected) {
				injected = true;
				const realRes = await commit();
				expect(realRes.status).toBe(200);
				expect(ids).toHaveLength(2);
				// Simulate item 0 committing while item 1 was rejected with 429 before creation.
				const stagedSub = drive.files.find(f => !['folder-docs', 'folder-sub', 'file-a', 'file-dest', 'file-hostile', 'file-b'].includes(f.id) && f.name === 'sub&dir');
				const stagedFileB = drive.files.find(f => !['folder-docs', 'folder-sub', 'file-a', 'file-dest', 'file-hostile', 'file-b'].includes(f.id) && f.name === 'b & c.txt');
				if (stagedSub) drive.remove(stagedSub.id);
				return batchMockResponse(boundary, [
					{ id: ids[0], status: 200, body: { id: stagedFileB?.id ?? 'unused' } },
					{ id: ids[1], status: 429, headers: { 'Retry-After': '0' }, body: { error: { message: 'rate limit' } } },
				]);
			}
		});
		const res = await request('/dav/docs/', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/dav/retry-copy/' },
		});
		expect(res.status).toBe(201);
		expect(batches[2].ids).toHaveLength(1);
		const copiedRoot = drive.children('root').find(f => f.name === 'retry-copy' && !f.trashed)!;
		expect(drive.children(copiedRoot.id).map(f => f.name).sort()).toEqual(['b & c.txt', 'sub&dir']);
	});

	it.each([
		{ label: 'definitive 403 sub-item', status: 403 },
		{ label: 'persistent 503 sub-item', status: 503 },
	])('aborts on $label failure, trashes unpublished stage, and keeps target untouched', async ({ status }) => {
		const targetName = 'keep-target-' + crypto.randomUUID();
		const targetId = 'keep-id-' + crypto.randomUUID();
		drive.add({ id: targetId, name: targetName, mimeType: 'text/plain', parents: ['root'], content: new Uint8Array([7]), size: 1 });
		const batches = spyBatches(async ({ boundary, ids, index }) => {
			if (index === 1) {
				return batchMockResponse(boundary, ids.map((id, idx) =>
					idx === 0
						? { id, status, headers: { 'Retry-After': '0' }, body: { error: { message: 'injected batch failure' } } }
						: { id, status: 403, body: { error: { message: 'skipped' } } },
				));
			}
		});
		const res = await request('/dav/docs/', {
			method: 'COPY',
			headers: { Destination: ORIGIN + `/dav/${targetName}` },
		});
		expect(res.status).toBe(status);
		expect(batches.length).toBeGreaterThanOrEqual(2);
		expect(drive.findById(targetId)?.trashed).not.toBe(true);
		expect(drive.files.some(f => f.name.startsWith('.webdav-copy-') && f.trashed)).toBe(true);
		expect(drive.files.some(f => f.name.startsWith('.webdav-copy-') && !f.trashed)).toBe(false);
	});

	it('enforces maxItems (1000) across paginated lists and cleans up unpublished stage with 413', async () => {
		for (let i = 0; i < 999; i++) {
			drive.add({ id: `lim-${i}`, name: `n-${i}.txt`, mimeType: 'text/plain', parents: ['folder-docs'] });
		}
		const batches = spyBatches();
		const res = await request('/dav/docs/', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/dav/too-many/' },
		});
		expect(res.status).toBe(413);
		expect(batches).toHaveLength(2);
		expect(drive.files.some(f => f.name.startsWith('.webdav-copy-') && f.trashed)).toBe(true);
		expect(drive.files.some(f => f.name.startsWith('.webdav-copy-') && !f.trashed)).toBe(false);
	});

	it('enforces maxBatches (40) on deep folder chains and cleans up unpublished stage with 413', async () => {
		let parentId = 'folder-sub';
		for (let level = 0; level < 21; level++) {
			const id = `deep-dir-${level}`;
			drive.add({ id, name: `lvl-${level}`, mimeType: FOLDER, parents: [parentId] });
			parentId = id;
		}
		const batches = spyBatches();
		const res = await request('/dav/docs/', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/dav/too-deep/' },
		});
		expect(res.status).toBe(413);
		expect(batches).toHaveLength(40);
		expect(drive.files.some(f => f.name.startsWith('.webdav-copy-') && f.trashed)).toBe(true);
		expect(drive.files.some(f => f.name.startsWith('.webdav-copy-') && !f.trashed)).toBe(false);
	});

	it.each([
		{ mode: 'definitive-403', expectedStatus: 403, targetTrashed: false, stageTrashed: true },
		{ mode: 'ambiguous-network', expectedStatus: 500, targetTrashed: true, stageTrashed: false },
	])('folder overwrite publish failure ($mode) honors restore and cleanup contract', async ({ mode, expectedStatus, targetTrashed, stageTrashed }) => {
		const targetName = 'target-pub-' + crypto.randomUUID();
		drive.add({ id: 'old-tree', name: targetName, mimeType: FOLDER, parents: ['root'] });
		drive.add({ id: 'old-sub', name: 'nested', mimeType: FOLDER, parents: ['old-tree'] });
		drive.add({ id: 'old-leaf', name: 'keep.bin', mimeType: 'application/octet-stream', parents: ['old-sub'], content: new Uint8Array([1, 2]), size: 2 });
		drive.add({ id: 'old-trash', name: 'already-trashed', mimeType: 'text/plain', parents: ['old-tree'], trashed: true });

		recordMutations(drive, async call => {
			if (call.method === 'PATCH' && call.body.name === targetName) {
				if (mode === 'definitive-403') return rejectMutation(403);
				throw new Error('Injected publish network loss');
			}
		});
		const res = await request('/dav/docs/', {
			method: 'COPY',
			headers: { Destination: ORIGIN + `/dav/${targetName}/` },
		});
		expect(res.status).toBe(expectedStatus);
		expect(drive.findById('old-tree')?.trashed).toBe(targetTrashed);
		if (!targetTrashed) {
			expect(drive.findById('old-trash')).toMatchObject({ trashed: false, explicitlyTrashed: false });
		}
		expect(drive.files.some(f => f.name.startsWith('.webdav-copy-') && Boolean(f.trashed) === stageTrashed)).toBe(true);
		expect(drive.files.some(f => f.name.startsWith('.webdav-copy-') && Boolean(f.trashed) !== stageTrashed)).toBe(false);
	});
});
