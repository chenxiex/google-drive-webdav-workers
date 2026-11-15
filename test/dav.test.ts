import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH, FOLDER, MockDrive, ORIGIN, installDriveMock } from './helpers';

const MEGA = 1024 * 1024;

let drive: MockDrive;

function seed(d: MockDrive): void {
	d.add({ id: 'folder-docs', name: 'docs', mimeType: FOLDER, parents: ['root'] });
	d.add({ id: 'file-a', name: 'a.txt', mimeType: 'text/plain', size: 123, parents: ['root'] });
	d.add({ id: 'file-dest', name: 'dest.txt', mimeType: 'text/plain', size: 456, parents: ['root'] });
	d.add({ id: 'file-hostile', name: 'x & y [#].txt', mimeType: 'text/plain', size: 100, parents: ['root'] });
	d.add({ id: 'file-b', name: 'b & c.txt', mimeType: 'text/plain', size: 999, parents: ['folder-docs'] });
	d.add({ id: 'folder-sub', name: 'sub&dir', mimeType: FOLDER, parents: ['folder-docs'] });
}

const request = (path: string, init: RequestInit = {}): Promise<Response> =>
	SELF.fetch(ORIGIN + path, {
		...init,
		headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) },
	});

beforeEach(() => {
	drive = new MockDrive();
	seed(drive);
	installDriveMock(drive);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('auth', () => {
	it('requires credentials', async () => {
		const res = await SELF.fetch(ORIGIN + '/dav/');
		expect(res.status).toBe(401);
		expect(res.headers.get('WWW-Authenticate')).toMatch(/^Basic realm=/);
	});

	it('rejects a wrong password', async () => {
		const res = await request('/dav/', { headers: { Authorization: 'Basic ' + btoa('test:wrong') } });
		expect(res.status).toBe(401);
	});

	it('rejects malformed base64 without crashing', async () => {
		const res = await request('/dav/', { headers: { Authorization: 'Basic not-valid@#$' } });
		expect(res.status).toBe(401);
	});
});

describe('server metadata', () => {
	it('answers robots.txt and favicon unauthenticated', async () => {
		const robots = await SELF.fetch(ORIGIN + '/robots.txt');
		expect(robots.status).toBe(200);
		expect(await robots.text()).toContain('Disallow');

		const favicon = await SELF.fetch(ORIGIN + '/favicon.ico');
		expect(favicon.status).toBe(204);
	});

	it('advertises class 1 and 2 in OPTIONS', async () => {
		const res = await request('/dav/', { method: 'OPTIONS' });
		expect(res.status).toBe(200);
		expect(res.headers.get('DAV')).toBe('1, 2');
		expect(res.headers.get('Allow')).toContain('PROPFIND');
		expect(res.headers.get('Allow')).toContain('MOVE');
	});

	it('returns 404 for paths outside the base path', async () => {
		const res = await request('/other');
		expect(res.status).toBe(404);
	});

	it('rejects invalid percent-encoding with a 400, not a 500', async () => {
		const res = await request('/dav/%zz');
		expect(res.status).toBe(400);
		expect(await res.text()).toContain('Invalid path encoding');
	});

	it('returns 404 for a missing resource', async () => {
		const res = await request('/dav/missing.txt');
		expect(res.status).toBe(404);
	});
});

describe('PROPFIND', () => {
	it('lists children with encoded hrefs and numeric sizes (Depth 1)', async () => {
		const res = await request('/dav/', {
			method: 'PROPFIND',
			headers: { Depth: '1' },
		});
		expect(res.status).toBe(207);
		expect(res.headers.get('Content-Type')).toMatch(/xml/);
		const body = await res.text();

		expect(body).toContain('<D:href>/dav/</D:href>');
		expect(body).toContain('<D:href>/dav/docs/</D:href>');
		expect(body).toContain('<D:href>/dav/a.txt</D:href>');
		expect(body).toContain('<D:href>/dav/dest.txt</D:href>');
		expect(body).toContain('<D:href>/dav/x%20%26%20y%20%5B%23%5D.txt</D:href>');
		expect(body).toContain('<D:getcontentlength>123</D:getcontentlength>');
		expect(body).toContain('<D:getcontentlength>100</D:getcontentlength>');
		expect(body).toContain('<D:displayname>x &amp; y [#].txt</D:displayname>');
		expect(body).toContain('<D:resourcetype><D:collection/></D:resourcetype>');
	});

	it('lists nested folder children (Depth 1)', async () => {
		const res = await request('/dav/docs/', {
			method: 'PROPFIND',
			headers: { Depth: '1' },
		});
		const body = await res.text();
		expect(body).toContain('<D:href>/dav/docs/sub%26dir/</D:href>');
		expect(body).toContain('<D:href>/dav/docs/b%20%26%20c.txt</D:href>');
		expect(body).toContain('<D:getcontentlength>999</D:getcontentlength>');
	});

	it('only returns the requested resource at Depth 0 (and quota on root)', async () => {
		const res = await request('/dav/', {
			method: 'PROPFIND',
			headers: { Depth: '0' },
		});
		const body = await res.text();
		expect(body).toContain('<D:href>/dav/</D:href>');
		expect(body).not.toContain('/dav/docs/');
		expect(body).not.toContain('getcontentlength');
		expect(body).toContain('<D:quota-used-bytes>4096</D:quota-used-bytes>');
		expect(body).toContain('<D:quota-available-bytes>1073737728</D:quota-available-bytes>');
	});

	it('resolves a hostile file name through its encoded path', async () => {
		const res = await request('/dav/x%20%26%20y%20%5B%23%5D.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0' },
		});
		expect(res.status).toBe(207);
		const body = await res.text();
		expect(body).toContain('<D:href>/dav/x%20%26%20y%20%5B%23%5D.txt</D:href>');
		expect(body).toContain('<D:getcontentlength>100</D:getcontentlength>');
	});
});

describe('PROPPATCH', () => {
	it('answers with a 207 multistatus', async () => {
		const res = await request('/dav/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml; charset=utf-8' },
			body: '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"/>',
		});
		expect(res.status).toBe(207);
		const body = await res.text();
		expect(body).toContain('<D:href>/dav/a.txt</D:href>');
		expect(body).toContain('<D:status>HTTP/1.1 200 OK</D:status>');
	});
});

describe('MOVE / COPY overwrite semantics', () => {
	it('COPY to a new destination returns 201', async () => {
		const res = await request('/dav/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/dav/cp-new.txt' },
		});
		expect(res.status).toBe(201);
		expect(drive.findById('file-a')).toBeDefined();
		expect(drive.children('root').some((f) => f.name === 'cp-new.txt')).toBe(true);
	});

	it('COPY with Overwrite: F onto an existing target returns 412', async () => {
		const res = await request('/dav/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/dav/dest.txt', Overwrite: 'F' },
		});
		expect(res.status).toBe(412);
		expect(drive.findById('file-dest')).toBeDefined();
	});

	it('COPY onto an existing target overwrites and returns 204', async () => {
		const res = await request('/dav/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/dav/dest.txt' },
		});
		expect(res.status).toBe(204);
		// The replaced file remains recoverable in Trash.
		expect(drive.findById('file-dest')?.trashed).toBe(true);
		const dest = drive.children('root').find((f) => f.name === 'dest.txt' && !f.trashed);
		expect(dest).toBeDefined();
		expect(dest!.id).not.toBe('file-dest');
	});

	it('COPY onto itself returns 403', async () => {
		const res = await request('/dav/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/dav/a.txt' },
		});
		expect(res.status).toBe(403);
	});

	it('MOVE onto itself returns 204', async () => {
		const res = await request('/dav/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/dav/a.txt' },
		});
		expect(res.status).toBe(204);
		expect(drive.findById('file-a')).toBeDefined();
	});

	it('MOVE to a new destination returns 201 with a Location header', async () => {
		const res = await request('/dav/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/dav/mv-new.txt' },
		});
		expect(res.status).toBe(201);
		expect(res.headers.get('Location')).toBe(ORIGIN + '/dav/mv-new.txt');
		expect(drive.findById('file-a')?.name).toBe('mv-new.txt');
		expect(drive.children('root').some((f) => f.name === 'a.txt')).toBe(false);
	});

	it('MOVE with Overwrite: F onto an existing target returns 412', async () => {
		const res = await request('/dav/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/dav/dest.txt', Overwrite: 'F' },
		});
		expect(res.status).toBe(412);
		expect(drive.findById('file-dest')).toBeDefined();
		expect(drive.findById('file-a')).toBeDefined();
	});

	it('rejects MOVE/COPY without a Destination header', async () => {
		const move = await request('/dav/a.txt', { method: 'MOVE' });
		expect(move.status).toBe(403);
		const copy = await request('/dav/a.txt', { method: 'COPY' });
		expect(copy.status).toBe(403);
	});

	it('rejects MOVE/COPY of the collection root', async () => {
		const move = await request('/dav/', { method: 'MOVE', headers: { Destination: ORIGIN + '/dav/x/' } });
		expect(move.status).toBe(403);
		const copy = await request('/dav/', { method: 'COPY', headers: { Destination: ORIGIN + '/dav/x/' } });
		expect(copy.status).toBe(403);
	});
	it('MOVE with Overwrite: T replaces the target and returns 204', async () => {
		const res = await request('/dav/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/dav/dest.txt' },
		});
		expect(res.status).toBe(204);
		expect(drive.findById('file-dest')?.trashed).toBe(true);
		expect(drive.findById('file-a')?.name).toBe('dest.txt');
	});
});

describe('PUT and MKCOL', () => {
	it.each([11, 5 * MEGA])('PUT creates a %i-byte multipart file', async (size) => {
		const res = await request('/dav/put-new.txt', {
			method: 'PUT',
			headers: { 'Content-Type': 'text/plain' },
			body: 'x'.repeat(size),
		});
		expect(res.status).toBe(201);
		const created = drive.children('root').find((f) => f.name === 'put-new.txt');
		expect(created?.size).toBe(size);
		expect(created?.content?.every(byte => byte === 120)).toBe(true);
	});

	it('PUT over an existing file returns 204', async () => {
		const res = await request('/dav/a.txt', {
			method: 'PUT',
			headers: { 'Content-Type': 'text/plain' },
			body: 'hello world',
		});
		expect(res.status).toBe(204);
	});

	it('PUT larger than one chunk persists the complete resumable upload', async () => {
		const res = await request('/dav/big.dat', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/octet-stream' },
			body: 'x'.repeat(11 * MEGA),
		});
		expect(res.status).toBe(201);
		const created = drive.children('root').find((f) => f.name === 'big.dat');
		expect(created?.size).toBe(11 * MEGA);
		expect(created?.content?.every(byte => byte === 120)).toBe(true);
	});

	it('MKCOL on an existing resource returns 405', async () => {
		const res = await request('/dav/a.txt', { method: 'MKCOL' });
		expect(res.status).toBe(405);
	});

	it('MKCOL creates a folder and returns 201', async () => {
		const res = await request('/dav/new-folder', { method: 'MKCOL' });
		expect(res.status).toBe(201);
		const created = drive.children('root').find((f) => f.name === 'new-folder');
		expect(created?.mimeType).toBe(FOLDER);
	});
});

describe('HEAD and folder redirects', () => {
	it('HEAD reports the file size', async () => {
		const res = await request('/dav/a.txt', { method: 'HEAD' });
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Length')).toBe('123');
		expect(res.headers.get('Content-Type')).toBe('text/plain');
	});

	it('redirects a folder URL to the trailing-slash variant', async () => {
		const res = await request('/dav/docs', { method: 'GET', redirect: 'manual' });
		expect(res.status).toBe(301);
		expect(res.headers.get('Location')).toBe(ORIGIN + '/dav/docs/');
	});
});
// Fault injection wraps the verified mock rather than extending its API contract.
// Injected failures test worker recovery policy, not claims that Google emits each response.
type Mutation = { method: string; path: string; body: Record<string, unknown>; url: URL };
function recordMutations(intercept?: (call: Mutation, commit: () => Promise<Response>) => Promise<Response | undefined>): Mutation[] {
	const calls: Mutation[] = [];
	const handle = drive.handle.bind(drive);
	vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
		const req = new Request(input, init);
		const url = new URL(req.url);
		if (url.pathname.startsWith('/drive/v3/files') && req.method !== 'GET') {
			const text = await req.clone().text();
			const call = { method: req.method, path: url.pathname, body: text ? JSON.parse(text) : {}, url };
			calls.push(call);
			const response = await intercept?.(call, () => handle(input, init));
			if (response) return response;
		}
		return handle(input, init);
	});
	return calls;
}
const overwrite = (method: string, target = '/dav/dest.txt') => request('/dav/a.txt', {
	method, headers: { Destination: ORIGIN + target },
});
const mutationSummary = (calls: Mutation[]) => calls.map(({ method, path, body }) => ({ method, path, body }));
const isPublish = (call: Mutation) => call.method === 'PATCH' && call.body.name === 'dest.txt';
const rejectMutation = (status: number) => new Response(JSON.stringify({ error: { message: 'Injected Drive rejection' } }), { status });

describe('recoverable overwrite operations', () => {
	it('MOVE trashes the old target before moving the source and never deletes it', async () => {
		const calls = recordMutations();
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
		const calls = recordMutations();
		expect((await overwrite('MOVE', '/dav/docs/dest.txt')).status).toBe(204);
		expect(calls.map(c => c.method)).toEqual(['PATCH', 'PATCH']);
		expect(calls[1].url.searchParams.get('addParents')).toBe('folder-docs');
		expect(calls[1].url.searchParams.get('removeParents')).toBe('root');
		expect(drive.findById('file-a')).toMatchObject({ name: 'dest.txt', parents: ['folder-docs'] });
		expect(drive.findById('file-dest')?.trashed).toBe(true);
	});

	it('COPY stages a unique copy in the destination parent before trashing and publishing', async () => {
		drive.findById('file-dest')!.parents = ['folder-docs'];
		const calls = recordMutations();
		expect((await overwrite('COPY', '/dav/docs/dest.txt')).status).toBe(204);
		const copied = drive.files.find(f => !['file-a', 'file-dest'].includes(f.id) && f.name === 'dest.txt' && !f.trashed)!;
		expect(copied).toMatchObject({ parents: ['folder-docs'], size: 123 });
		expect(mutationSummary(calls)).toEqual([
			{ method: 'POST', path: '/drive/v3/files/file-a/copy', body: { name: expect.stringMatching(/^\.webdav-copy-[0-9a-f-]{36}$/i), parents: ['folder-docs'] } },
			{ method: 'PATCH', path: '/drive/v3/files/file-dest', body: { trashed: true } },
			{ method: 'PATCH', path: '/drive/v3/files/' + copied.id, body: { name: 'dest.txt' } },
		]);
		expect(drive.findById('file-dest')?.trashed).toBe(true);
		expect(drive.findById('file-a')).toMatchObject({ name: 'a.txt', size: 123, parents: ['root'] });
	});

	it.each(['MOVE', 'COPY'])('%s aborts publication when destination trashing fails', async method => {
		const calls = recordMutations(async call => call.body.trashed === true ? rejectMutation(403) : undefined);
		expect((await overwrite(method)).status).toBeGreaterThanOrEqual(400);
		expect(calls.some(isPublish)).toBe(false);
		expect(calls.map(c => c.method)).toEqual(method === 'COPY' ? ['POST', 'PATCH'] : ['PATCH']);
		expect(drive.findById('file-dest')).toMatchObject({ name: 'dest.txt', size: 456 });
		expect(drive.findById('file-dest')?.trashed).not.toBe(true);
		expect(drive.findById('file-a')?.name).toBe('a.txt');
		if (method === 'COPY') expect(drive.files.some(f => f.name.startsWith('.webdav-copy-') && !f.trashed)).toBe(true);
	});

	it.each(['network', '500', 'malformed', 'missing-id'])('COPY preserves a committed stage after ambiguous %s response without touching the target', async failure => {
		const calls = recordMutations(async (call, commit) => {
			if (call.method !== 'POST') return;
			await commit();
			if (failure === 'network') throw new Error('Injected lost staging response');
			if (failure === '500') return rejectMutation(500);
			return new Response(failure === 'malformed' ? '{invalid JSON' : '{}', { status: 200 });
		});
		expect((await overwrite('COPY')).status).toBeGreaterThanOrEqual(400);
		expect(calls.map(c => c.method)).toEqual(['POST']);
		expect(drive.findById('file-dest')?.trashed).not.toBe(true);
		expect(drive.findById('file-a')?.name).toBe('a.txt');
		expect(drive.files.some(f => f.name === calls[0].body.name && !f.trashed)).toBe(true);
	});

	it.each(['MOVE', 'COPY'].flatMap(method => ['network', '500', '408', 'malformed'].map(failure => ({ method, failure }))))(
		'$method aborts without rollback when trashing commits but its $failure response is ambiguous', async ({ method, failure }) => {
			const calls = recordMutations(async (call, commit) => {
				if (call.body.trashed !== true) return;
				await commit();
				if (failure === 'network') throw new Error('Injected lost trash response');
				if (failure === 'malformed') return new Response('{invalid JSON', { status: 200 });
				return rejectMutation(Number(failure));
			});
			expect((await overwrite(method)).status).toBeGreaterThanOrEqual(400);
			expect(calls.map(c => c.method)).toEqual(method === 'COPY' ? ['POST', 'PATCH'] : ['PATCH']);
			expect(drive.findById('file-dest')?.trashed).toBe(true);
			expect(drive.findById('file-a')?.name).toBe('a.txt');
			if (method === 'COPY') expect(drive.files.some(f => f.name === calls[0].body.name && !f.trashed)).toBe(true);
		},
	);

	it('COPY retries use distinct staging names and retain both recoverable copies', async () => {
		const calls = recordMutations(async call => call.body.trashed === true ? rejectMutation(403) : undefined);
		expect((await overwrite('COPY')).status).toBeGreaterThanOrEqual(400);
		expect((await overwrite('COPY')).status).toBeGreaterThanOrEqual(400);
		const names = calls.filter(c => c.method === 'POST').map(c => c.body.name);
		expect(names).toHaveLength(2);
		expect(new Set(names).size).toBe(2);
		expect(drive.files.filter(f => names.includes(f.name) && !f.trashed)).toHaveLength(2);
		expect(calls.some(c => c.method === 'DELETE')).toBe(false);
	});

	it.each([403, 500])('COPY staging failure (%i) leaves the old target untouched', async status => {
		const calls = recordMutations(async call => call.method === 'POST' ? rejectMutation(status) : undefined);
		expect((await overwrite('COPY')).status).toBeGreaterThanOrEqual(400);
		expect(calls.map(c => c.method)).toEqual(['POST']);
		expect(drive.findById('file-dest')?.trashed).not.toBe(true);
		expect(drive.findById('file-a')?.name).toBe('a.txt');
	});

	it.each(['MOVE', 'COPY'].flatMap(method => [400, 403, 404, 409, 429].map(status => ({ method, status }))))(
		'$method restores the old destination after definitive $status publication rejection', async ({ method, status }) => {
			const calls = recordMutations(async call => isPublish(call) ? rejectMutation(status) : undefined);
			expect((await overwrite(method)).status).toBeGreaterThanOrEqual(400);
			expect(mutationSummary(calls).at(-1)).toEqual({ method: 'PATCH', path: '/drive/v3/files/file-dest', body: { trashed: false } });
			expect(calls.map(c => c.method)).toEqual(method === 'COPY' ? ['POST', 'PATCH', 'PATCH', 'PATCH'] : ['PATCH', 'PATCH', 'PATCH']);
			expect(drive.findById('file-dest')).toMatchObject({ name: 'dest.txt', size: 456, trashed: false });
			expect(drive.findById('file-a')?.name).toBe('a.txt');
			if (method === 'COPY') expect(drive.files.some(f => f.name.startsWith('.webdav-copy-') && !f.trashed)).toBe(true);
		},
	);

	it.each(['MOVE', 'COPY'])('%s reports failure if destination restoration is rejected', async method => {
		const calls = recordMutations(async call => isPublish(call) || call.body.trashed === false ? rejectMutation(403) : undefined);
		const res = await overwrite(method);
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(await res.text()).toContain('destination restore failed');
		expect(calls.at(-1)?.body).toEqual({ trashed: false });
		expect(calls.some(c => c.method === 'DELETE')).toBe(false);
		expect(drive.findById('file-dest')?.trashed).toBe(true);
		expect(drive.findById('file-a')?.name).toBe('a.txt');
	});

	it.each(['MOVE', 'COPY'].flatMap(method => ['network', '500', '408', 'malformed', 'missing-id'].flatMap(failure => [false, true].map(committed => ({ method, failure, committed })))))(
		'$method does not undo or delete after ambiguous $failure publication (committed=$committed)', async ({ method, failure, committed }) => {
			const calls = recordMutations(async (call, commit) => {
				if (!isPublish(call)) return;
				if (committed) await commit();
				if (failure === 'network') throw new Error('Injected connection loss');
				if (failure === 'malformed') return new Response('{invalid JSON', { status: 200 });
				if (failure === 'missing-id') return new Response('{}', { status: 200 });
				return rejectMutation(Number(failure));
			});
			expect((await overwrite(method)).status).toBeGreaterThanOrEqual(400);
			expect(calls.map(c => c.method)).toEqual(method === 'COPY' ? ['POST', 'PATCH', 'PATCH'] : ['PATCH', 'PATCH']);
			expect(drive.findById('file-dest')).toMatchObject({ name: 'dest.txt', size: 456, trashed: true });
			expect(drive.findById('file-a')?.name).toBe(method === 'MOVE' && committed ? 'dest.txt' : 'a.txt');
			if (method === 'COPY') expect(drive.files.some(f => f.id !== 'file-dest' && f.name === (committed ? 'dest.txt' : calls[0].body.name))).toBe(true);
		},
	);
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
		const calls = recordMutations();
		const res = await request('/dav/docs', { method, headers: { Destination: ORIGIN + '/dav/docs/' } });
		expect(res.status).toBe(method === 'MOVE' ? 204 : 403);
		expect(calls).toEqual([]);
		expect(drive.findById('folder-docs')).toBeDefined();
		expect(drive.findById('file-b')).toBeDefined();
	});

	it.each(['/dav/new-folder/', '/dav/dest.txt'])('rejects folder COPY to %s before any mutation', async destination => {
		const calls = recordMutations();
		const res = await request('/dav/docs/', { method: 'COPY', headers: { Destination: ORIGIN + destination } });
		expect(res.status).toBe(403);
		expect(calls).toEqual([]);
		expect(drive.findById('file-dest')?.trashed).not.toBe(true);
	});

	it.each(['MOVE', 'COPY'].flatMap(method => [
		{ source: '/dav/docs/', destination: '/dav/docs/sub%26dir/' },
		{ source: '/dav/docs/', destination: '/dav/docs/new-child/' },
		{ source: '/dav/docs/sub%26dir/', destination: '/dav/docs/' },
		{ source: '/dav/docs/b%20%26%20c.txt', destination: '/dav/docs/' },
	].map(paths => ({ method, ...paths }))))('$method rejects related paths $source → $destination before mutation', async ({ method, source, destination }) => {
		const calls = recordMutations();
		expect((await request(source, { method, headers: { Destination: ORIGIN + destination } })).status).toBe(403);
		expect(calls).toEqual([]);
		expect(drive.findById('folder-docs')).toBeDefined();
		expect(drive.findById('file-b')).toBeDefined();
	});

	it.each(['MOVE', 'COPY'].flatMap(method => ['/dav/missing/file.txt', '/dav/dest.txt/file.txt'].map(destination => ({ method, destination }))))(
		'$method rejects missing or non-folder parent $destination before mutation', async ({ method, destination }) => {
			const calls = recordMutations();
			expect((await overwrite(method, destination)).status).toBe(409);
			expect(calls).toEqual([]);
			expect(drive.findById('file-a')?.name).toBe('a.txt');
		},
	);

	it('directory MOVE preserves its success and logs failures when KV listing fails', async () => {
		drive.add({ id: 'folder-kv-failure', name: 'kv-failure-source', mimeType: FOLDER, parents: ['root'] });
		drive.add({ id: 'file-kv-failure', name: 'child.txt', mimeType: 'text/plain', size: 123, parents: ['folder-kv-failure'] });
		expect((await request('/dav/kv-failure-source/child.txt', { method: 'HEAD' })).status).toBe(200);
		const kv = (env as Env).KV!;
		const list = vi.spyOn(kv, 'list').mockRejectedValue(new Error('Injected KV list failure'));
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const calls = recordMutations();
		const res = await request('/dav/kv-failure-source/', { method: 'MOVE', headers: { Destination: ORIGIN + '/dav/kv-failure-dest/' } });
		expect(res.status).toBe(201);
		expect(res.headers.get('Location')).toBe(ORIGIN + '/dav/kv-failure-dest/');
		expect(list).toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith('Transfer cache invalidation failed:', expect.any(Error));
		expect(calls.map(c => c.method)).toEqual(['PATCH']);
		expect(drive.findById('folder-kv-failure')?.name).toBe('kv-failure-dest');
		// Durable descendant cache entries may remain after failed KV invalidation.
		expect((await request('/dav/kv-failure-dest/child.txt', { method: 'HEAD' })).status).toBe(200);
	});

	it('MOVE of a directory invalidates cached descendant paths', async () => {
		expect((await request('/dav/docs/b%20%26%20c.txt', { method: 'HEAD' })).status).toBe(200);
		const calls = recordMutations();
		const res = await request('/dav/docs/', { method: 'MOVE', headers: { Destination: ORIGIN + '/dav/renamed/' } });
		expect(res.status).toBe(201);
		expect(calls.map(c => c.method)).toEqual(['PATCH']);
		expect((await request('/dav/docs/b%20%26%20c.txt', { method: 'HEAD' })).status).toBe(404);
		expect((await request('/dav/renamed/b%20%26%20c.txt', { method: 'HEAD' })).status).toBe(200);
		expect(drive.findById('folder-docs')?.name).toBe('renamed');
		expect(drive.findById('file-b')?.parents).toEqual(['folder-docs']);
	});
});

describe('DELETE cache invalidation', () => {
	let path: string;
	const head = (suffix = '/nested/leaf.txt') => request('/dav' + path + suffix, { method: 'HEAD' });
	beforeEach(() => {
		path = '/delete-' + crypto.randomUUID();
		drive.add({ id: 'delete-tree', name: path.slice(1), mimeType: FOLDER, parents: ['root'] });
		drive.add({ id: 'delete-sub', name: 'nested', mimeType: FOLDER, parents: ['delete-tree'] });
		drive.add({ id: 'delete-leaf', name: 'leaf.txt', mimeType: 'text/plain', size: 3, parents: ['delete-sub'] });
	});

	it.each(['', '/'])('evicts cached descendants with directory suffix "%s" and resolves recreated names to new IDs', async suffix => {
		expect((await head()).status).toBe(200);
		expect((await head('/nested/')).status).toBe(200);
		expect((await request('/dav' + path + suffix, { method: 'DELETE' })).status).toBe(204);
		expect(drive.findById('delete-leaf')).toBeUndefined();
		expect((await head()).status).toBe(404);
		expect((await head('/nested/')).status).toBe(404);
		expect((await head('/')).status).toBe(404);
		expect((await request('/dav' + path + '/nested/', { method: 'MKCOL' })).status).toBe(201);
		expect((await request('/dav' + path + '/nested/leaf.txt', { method: 'PUT', body: 'replacement', headers: { 'Content-Type': 'text/plain', 'Content-Length': '11' } })).status).toBe(201);
		const recreated = await head();
		expect(recreated.status).toBe(200);
		expect(recreated.headers.get('Content-Length')).toBe('11');
		const calls = recordMutations();
		expect((await request('/dav' + path + '/nested/leaf.txt', { method: 'DELETE' })).status).toBe(204);
		expect(calls).toHaveLength(1);
		expect(calls[0].path).not.toBe('/drive/v3/files/delete-leaf');
	});

	it('deletes paginated KV-only descendant mappings without touching adjacent names', async () => {
		const kv = (env as Env).KV!;
		const keys = ['meta.' + path + '/cold/', 'meta.' + path + '/cold/deep.txt/'];
		const adjacent = 'meta.' + path + '-other/keep.txt/';
		for (const key of [...keys, adjacent]) await kv.put(key, JSON.stringify({ id: 'stale', mimeType: 'text/plain' }));
		const list = vi.spyOn(kv, 'list')
			.mockResolvedValueOnce({ keys: [{ name: keys[0] }], list_complete: false, cursor: 'next-page', cacheStatus: null })
			.mockResolvedValueOnce({ keys: [{ name: keys[1] }], list_complete: true, cacheStatus: null });
		expect((await request('/dav' + path, { method: 'DELETE' })).status).toBe(204);
		expect(list).toHaveBeenNthCalledWith(1, { prefix: 'meta.' + path + '/', cursor: undefined });
		expect(list).toHaveBeenNthCalledWith(2, { prefix: 'meta.' + path + '/', cursor: 'next-page' });
		for (const key of keys) expect(await kv.get(key)).toBeNull();
		expect(await kv.get(adjacent)).not.toBeNull();
		expect((await head('/cold/deep.txt')).status).toBe(404);
	});

	it.each([403, 500])('preserves upstream %s without deleting the live subtree', async status => {
		expect((await head()).status).toBe(200);
		const calls = recordMutations(async call => call.method === 'DELETE' ? new Response(null, { status }) : undefined);
		expect((await request('/dav' + path, { method: 'DELETE' })).status).toBe(status);
		expect(calls).toHaveLength(1);
		expect(drive.findById('delete-leaf')).toBeDefined();
		expect((await head()).status).toBe(200);
	});

	it('evicts descendants even when the upstream deletion commits then loses its response', async () => {
		expect((await head()).status).toBe(200);
		recordMutations(async (call, commit) => {
			if (call.method === 'DELETE') { await commit(); throw new Error('Injected lost DELETE response'); }
		});
		expect((await request('/dav' + path, { method: 'DELETE' })).status).toBe(500);
		expect(drive.findById('delete-leaf')).toBeUndefined();
		expect((await head()).status).toBe(404);
	});

	it.each(['list', 'delete'])('preserves successful DELETE and evicts local descendants when KV %s fails', async failure => {
		expect((await head()).status).toBe(200);
		const kv = (env as Env).KV!;
		if (failure === 'list') vi.spyOn(kv, 'list').mockRejectedValue(new Error('Injected KV list failure'));
		else {
			const remove = kv.delete.bind(kv);
			vi.spyOn(kv, 'delete').mockImplementation(key => key === 'meta.' + path + '/nested/leaf.txt/'
				? Promise.reject(new Error('Injected KV descendant delete failure')) : remove(key));
		}
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect((await request('/dav' + path, { method: 'DELETE' })).status).toBe(204);
		expect(log).toHaveBeenCalledWith('DELETE cache invalidation failed:', expect.any(Error));
		expect(drive.findById('delete-leaf')).toBeUndefined();
		// KV failures may leave stale durable mappings. Remove those manually
		// to verify local eviction independently of durable cleanup.
		if (failure === 'delete') vi.mocked(kv.delete).mockRestore();
		await kv.delete('meta.' + path + '/nested/leaf.txt/');
		await kv.delete('meta.' + path + '/nested/');
		expect((await head()).status).toBe(404);
	});

	it('keeps file DELETE non-recursive and refreshes the parent listing', async () => {
		expect((await head()).status).toBe(200);
		await request('/dav' + path + '/nested/', { method: 'PROPFIND', headers: { Depth: '1' } });
		const list = vi.spyOn((env as Env).KV!, 'list');
		expect((await request('/dav' + path + '/nested/leaf.txt', { method: 'DELETE' })).status).toBe(204);
		expect(list).not.toHaveBeenCalled();
		expect((await head()).status).toBe(404);
		expect((await head('/nested/')).status).toBe(200);
		const listing = await request('/dav' + path + '/nested/', { method: 'PROPFIND', headers: { Depth: '1' } });
		expect(await listing.text()).not.toContain('leaf.txt');
	});

	it('does not mutate Drive for root or missing paths', async () => {
		const calls = recordMutations();
		expect((await request('/dav/', { method: 'DELETE' })).status).toBe(403);
		expect((await request('/dav' + path + '/missing', { method: 'DELETE' })).status).toBe(404);
		expect(calls).toEqual([]);
	});
});

// Folder-tree behavior is independently verified in mock-drive.test.ts.
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
		const calls = recordMutations();
		expect((await transfer(method)).status).toBe(204);
		for (const id of ['old-tree', 'old-trash']) expect(drive.findById(id)?.trashed).toBe(true);
		for (const id of ['old-sub', 'old-leaf']) expect(drive.findById(id)?.trashed).toBe(true);
		expect(drive.findById('old-leaf')?.content).toEqual(new Uint8Array([1, 2, 255]));
		expect((await request('/dav/' + targetName + '/nested/keep.bin', { method: 'HEAD' })).status).toBe(404);
		expect((await request('/dav/' + targetName + '', { method: 'HEAD' })).status).toBe(200);
		expect(calls.some(c => c.method === 'DELETE')).toBe(false);
	});

	it.each(['MOVE', 'COPY'])('%s hides old paths even while descendant trash flags lag behind the parent', async method => {
		targetTree();
		expect((await request('/dav/' + targetName + '/nested/keep.bin', { method: 'HEAD' })).status).toBe(200);
		recordMutations(async (call, commit) => {
			if (call.body.trashed !== true) return;
			const response = await commit();
			// Observed live transient state; timing is intentionally deterministic.
			for (const id of ['old-sub', 'old-leaf']) drive.findById(id)!.trashed = false;
			return response;
		});
		expect((await transfer(method)).status).toBe(204);
		// Publication may recompute the mock's settled flags. Reproduce stale
		// descendant reads at the moment the client next resolves the old path.
		for (const id of ['old-sub', 'old-leaf']) drive.findById(id)!.trashed = false;
		expect((await request('/dav/' + targetName + '/nested/keep.bin', { method: 'HEAD' })).status).toBe(404);
	});

	it('folder MOVE overwrites an unrelated folder without losing either subtree', async () => {
		targetTree();
		expect((await request('/dav/docs/b%20%26%20c.txt', { method: 'HEAD' })).status).toBe(200);
		expect((await request('/dav/' + targetName + '/nested/keep.bin', { method: 'HEAD' })).status).toBe(200);
		const calls = recordMutations();
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

	it.each(['MOVE', 'COPY'])('%s restores the destination tree after an injected publication rejection, including independently trashed children', async method => {
		targetTree();
		const calls = recordMutations(async call => call.body.name === targetName ? rejectMutation(403) : undefined);
		expect((await transfer(method)).status).toBe(403);
		expect(drive.findById('old-tree')?.trashed).toBe(false);
		for (const id of ['old-sub', 'old-leaf']) expect(drive.findById(id)?.trashed).not.toBe(true);
		expect(drive.findById('old-trash')).toMatchObject({ trashed: false, explicitlyTrashed: false });
		expect(drive.findById('old-leaf')?.content).toEqual(new Uint8Array([1, 2, 255]));
		expect((await request('/dav/' + targetName + '/nested/keep.bin', { method: 'HEAD' })).status).toBe(200);
		expect(calls.at(-1)?.body).toEqual({ trashed: false });
		expect(calls.some(c => c.method === 'DELETE')).toBe(false);
	});

	it.each(['MOVE', 'COPY'])('%s preserves the recoverable tree after a committed publication loses its response', async method => {
		targetTree();
		const calls = recordMutations(async (call, commit) => {
			if (call.body.name !== targetName) return;
			await commit();
			throw new Error('Injected lost publication response');
		});
		expect((await transfer(method)).status).toBeGreaterThanOrEqual(400);
		expect(drive.findById('old-tree')?.trashed).toBe(true);
		for (const id of ['old-sub', 'old-leaf']) expect(drive.findById(id)).toBeDefined();
		expect(calls.some(c => c.body.trashed === false || c.method === 'DELETE')).toBe(false);
		expect((await request('/dav/' + targetName + '', { method: 'HEAD' })).status).toBe(200);
	});
});


describe('KV cache lifetime', () => {
    it.each(['meta', 'objects'])('returns repeated %s KV hits directly, then observes KV expiry', async ns => {
        const kv = (env as Env).KV!;
        const path = '/kv-lifetime-' + ns;
        const id = 'kv-lifetime-' + ns;
        drive.add({ id, name: path.slice(1), mimeType: ns === 'objects' ? FOLDER : 'text/plain', size: 123, parents: ['root'] });
        const key = ns === 'meta' ? 'meta.' + path + '/' : 'objects.' + id;
        const stale = ns === 'meta'
            ? { id: 'old-id', name: path.slice(1), mimeType: 'text/plain', size: 999, parents: ['root'] }
            : [{ id: 'old-child', name: 'old-child.txt', mimeType: 'text/plain', size: 999 }];
        const start = Date.now();
        let now = start;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const originalGet = kv.get.bind(kv);
        // Model a value with only one second left in KV. This is not a
        // simulation of cross-region propagation or Cloudflare's edge cache.
        const get = vi.spyOn(kv as { get(key: string, options?: unknown): Promise<unknown> }, 'get').mockImplementation(((name: string, options: any) =>
            name === key ? Promise.resolve(now < start + 1000 ? stale : null) : originalGet(name, options)) as any);
        const read = () => request('/dav' + path, { method: ns === 'meta' ? 'HEAD' : 'PROPFIND', headers: { Depth: '1' } });
        for (let i = 0; i < 2; i++) {
            const response = await read();
            if (ns === 'meta') expect(response.headers.get('Content-Length')).toBe('999');
            else expect(await response.text()).toContain('old-child.txt');
        }
        // No instance promotion means another KV read for every hit.
        expect(get.mock.calls.filter(([name]) => name === key)).toHaveLength(2);
        now = start + 1000;
        const fresh = await read();
        if (ns === 'meta') expect(fresh.headers.get('Content-Length')).toBe('123');
        else expect(await fresh.text()).not.toContain('old-child.txt');
        expect(get.mock.calls.filter(([name]) => name === key).length).toBeGreaterThan(2);
    });

    it.each(['meta', 'objects'])('keeps locally written %s TTL and does not extend it after a KV fallback', async ns => {
        const kv = (env as Env).KV!;
        const path = '/kv-local-' + ns;
        const id = 'kv-local-' + ns;
        drive.add({ id, name: path.slice(1), mimeType: ns === 'objects' ? FOLDER : 'text/plain', size: 123, parents: ['root'] });
        const key = ns === 'meta' ? 'meta.' + path + '/' : 'objects.' + id;
        const ttl = ns === 'meta' ? 300000 : 30000;
        const start = Date.now();
        let now = start;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const originalGet = kv.get.bind(kv);
        const get = vi.spyOn(kv as { get(key: string, options?: unknown): Promise<unknown> }, 'get');
        const put = vi.spyOn(kv, 'put');
        const read = async () => {
            const res = await request('/dav' + path, { method: ns === 'meta' ? 'HEAD' : 'PROPFIND', headers: { Depth: '1' } });
            expect(res.status).toBe(ns === 'meta' ? 200 : 207);
            await res.text();
        };
        await read();
        expect(put).toHaveBeenCalledWith(key, expect.any(String), { expirationTtl: ns === 'meta' ? 300 : 60 });
        const reads = get.mock.calls.filter(([name]) => name === key).length;
        now = start + ttl - 1;
        await read();
        expect(get.mock.calls.filter(([name]) => name === key)).toHaveLength(reads);
        // Keep KV available after local expiry, as when a list's 30-second
        // memory entry expires before KV's 60-second minimum TTL.
        const stored = JSON.parse(put.mock.calls.find(([name]) => name === key)![1] as string);
        get.mockImplementation(((name: string, options: any) =>
            name === key ? Promise.resolve(stored) : originalGet(name, options)) as any);
        now = start + ttl;
        await read();
        await read();
        expect(get.mock.calls.filter(([name]) => name === key)).toHaveLength(reads + 2);
    });

    it('preserves TUS session promotion and its existing five-minute local lifetime', async () => {
        const kv = (env as Env).KV!;
        const sessionId = 'kv-session-lifetime';
        const key = 'tus_session.' + sessionId;
        const start = Date.now();
        let now = start;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const get = vi.spyOn(kv as { get(key: string, options?: unknown): Promise<unknown> }, 'get').mockResolvedValue({ uploadUrl: 'https://upload.example.test/session', totalSize: 10 });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 308, headers: { Range: 'bytes=0-4' } })));
        const read = () => request('/dav/tus_uploads/' + sessionId, { method: 'HEAD' });
        const first = await read();
        expect(first.status).toBe(200);
        expect(first.headers.get('Upload-Offset')).toBe('5');
        get.mockResolvedValue(null);
        now = start + 299999;
        expect((await read()).status).toBe(200);
        expect(get.mock.calls.filter(([name]) => name === key)).toHaveLength(1);
        now = start + 300000;
        expect((await read()).status).toBe(404);
        expect(get.mock.calls.filter(([name]) => name === key)).toHaveLength(2);
    });
});
