import { SELF, env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { UPLOAD_CHUNK_SIZE } from '../../src/webdav/upload-stream';
import { AUTH, FOLDER, ORIGIN, installDriveMock, recordMutations, seedStandardDrive } from '../support/client';
import { MockDrive } from '../support/mock-drive';

const MEGA = 1024 * 1024;

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
		expect(drive.findById('file-a')).toMatchObject({ id: 'file-a', size: 11, content: new TextEncoder().encode('hello world') });
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

describe('unknown-length PUT', () => {
	// Use the handler directly for disconnect/error tests: SELF's HTTP bridge
	// can turn a producer error into EOF before the handler sees it.
	async function directPut(path: string, body: ReadableStream<Uint8Array>): Promise<Response> {
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request(ORIGIN + path, { method: 'PUT', headers: AUTH, body }), env as Env, ctx);
		await waitOnExecutionContext(ctx);
		return response;
	}

	// Zero queueing makes the producer's reads observable independently of
	// the request transport's own buffering.
	function stream(size: number, onPull = () => {}, onCancel = () => {}): ReadableStream<Uint8Array> {
		let offset = 0;
		return new ReadableStream({
			pull(controller) {
				onPull();
				if (offset === size) { controller.close(); return; }
				const length = Math.min(256 * 1024, size - offset);
				controller.enqueue(new Uint8Array(length).fill(97));
				offset += length;
			},
			cancel: onCancel,
		}, { highWaterMark: 0 });
	}

	it.each([
		['partial', 2 * UPLOAD_CHUNK_SIZE + 3, '/dav/stream.dat', 201],
		['exact', UPLOAD_CHUNK_SIZE, '/dav/a.txt', 204],
	] as const)('uploads %s EOF with a known final total, preserving bytes', async (_, size, path, status) => {
		const ranges: string[] = [];
		let produced = 0;
		const original = drive.handle.bind(drive);
		vi.spyOn(drive, 'handle').mockImplementation((input, init) => {
			const headers = new Headers(init?.headers);
			if (String(input).includes('uploadType=resumable') && init?.method !== 'PUT') {
				expect(headers.has('X-Upload-Content-Length')).toBe(false);
			}
			if (headers.has('Content-Range')) {
				if (!ranges.length && size > UPLOAD_CHUNK_SIZE) expect(produced).toBeLessThan(size / (256 * 1024));
				ranges.push(headers.get('Content-Range')!);
			}
			return original(input, init);
		});
		const response = await request(path, { method: 'PUT', body: stream(size, () => produced++) });
		expect(response.status).toBe(status);
		const file = drive.children('root').find(f => f.name === path.split('/').at(-1));
		expect(file?.size).toBe(size);
		expect(file?.content?.every(byte => byte === 97)).toBe(true);
		expect(ranges).toEqual(size === UPLOAD_CHUNK_SIZE
			? [`bytes 0-${size - 1}/${size}`]
			: [`bytes 0-${UPLOAD_CHUNK_SIZE - 1}/*`, `bytes ${UPLOAD_CHUNK_SIZE}-${2 * UPLOAD_CHUNK_SIZE - 1}/*`, `bytes ${2 * UPLOAD_CHUNK_SIZE}-${size - 1}/${size}`]);
	});

	it('creates and truncates empty streams without an unusable resumable session', async () => {
		const handle = vi.spyOn(drive, 'handle');
		for (const [path, status] of [['/dav/empty.dat', 201], ['/dav/a.txt', 204]] as const) {
			expect((await request(path, { method: 'PUT', body: stream(0) })).status).toBe(status);
			const file = drive.children('root').find(f => f.name === path.split('/').at(-1));
			expect(Number(file?.size)).toBe(0);
		}
		expect(handle.mock.calls.some(([input]) => String(input).includes('uploadType=resumable'))).toBe(false);
	});

	it.each(['init', 'chunk', 'range', 'early-complete', 'final-incomplete'] as const)(
		'stops without retrying or reporting success after %s failure', async failure => {
			let chunks = 0;
			let produced = 0;
			const cancel = vi.fn();
			const original = drive.handle.bind(drive);
			vi.spyOn(drive, 'handle').mockImplementation((input, init) => {
				const url = String(input);
				if (!url.includes('uploadType=resumable')) return original(input, init);
				if (init?.method !== 'PUT') return failure === 'init'
					? Promise.resolve(new Response('injected', { status: 503 })) : original(input, init);
				chunks++;
				if (failure === 'chunk') return Promise.resolve(new Response('injected', { status: 503 }));
				if (failure === 'range') return Promise.resolve(new Response(null, { status: 308, headers: { Range: 'bytes=0-2' } }));
				if (failure === 'early-complete') return Promise.resolve(new Response('{}', { status: 200 }));
				return Promise.resolve(new Response(null, { status: 308 }));
			});
			const size = failure === 'final-incomplete' ? 3 : 4 * UPLOAD_CHUNK_SIZE;
			const result = await directPut('/dav/failed.dat', stream(size, () => produced++, cancel));
			expect(result.status).toBe(failure === 'init' || failure === 'chunk' ? 503 : 502);
			expect(chunks).toBe(failure === 'init' ? 0 : 1);
			expect(drive.children('root').some(file => file.name === 'failed.dat')).toBe(false);
			if (failure !== 'final-incomplete') {
				// Transport may queue an input chunk, but must not drain the file.
				expect(produced).toBeLessThan(size / (256 * 1024));
				expect(cancel).toHaveBeenCalledOnce();
			}
		},
	);

	it('does not commit a truncated file when the incoming stream errors', async () => {
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (++pulls > 43) { controller.error(new Error('injected input failure')); return; }
				controller.enqueue(new Uint8Array(256 * 1024));
			},
		}, { highWaterMark: 0 });
		const original = drive.handle.bind(drive);
		let chunks = 0;
		vi.spyOn(drive, 'handle').mockImplementation((input, init) => {
			if (new Headers(init?.headers).has('Content-Range')) chunks++;
			return original(input, init);
		});
		expect((await directPut('/dav/input-error.dat', body)).status).toBe(502);
		expect(chunks).toBe(1);
		expect(drive.children('root').some(file => file.name === 'input-error.dat')).toBe(false);
	});
});

describe('DELETE trash, cache invalidation, and restore semantics', () => {
	let path: string;
	const head = (suffix = '/nested/leaf.txt') => request('/dav' + path + suffix, { method: 'HEAD' });
	const propfind = (suffix = '/nested/leaf.txt', depth = '0') =>
		request('/dav' + path + suffix, { method: 'PROPFIND', headers: { Depth: depth } });

	beforeEach(() => {
		path = '/delete-' + crypto.randomUUID();
		drive.add({ id: 'delete-tree', name: path.slice(1), mimeType: FOLDER, parents: ['root'] });
		drive.add({ id: 'delete-sub', name: 'nested', mimeType: FOLDER, parents: ['delete-tree'] });
		drive.add({
			id: 'delete-leaf',
			name: 'leaf.txt',
			mimeType: 'text/plain',
			size: 3,
			content: new TextEncoder().encode('abc'),
			modifiedTime: '2024-02-03T04:05:06.000Z',
			parents: ['delete-sub'],
		});
	});

	it.each(['', '/'])('moves folder tree to Trash with suffix "%s", evicts descendants, and resolves recreated names to new IDs', async suffix => {
		expect((await head()).status).toBe(200);
		expect((await head('/nested/')).status).toBe(200);
		const calls = recordMutations(drive);
		expect((await request('/dav' + path + suffix, { method: 'DELETE' })).status).toBe(204);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/drive/v3/files/delete-tree', body: { trashed: true } });
		expect(calls[0].url.searchParams.get('supportsAllDrives')).toBe('true');
		expect(drive.findById('delete-tree')).toMatchObject({ trashed: true, explicitlyTrashed: true });
		expect(drive.findById('delete-sub')?.trashed).toBe(true);
		expect(drive.findById('delete-leaf')).toMatchObject({ trashed: true, content: new TextEncoder().encode('abc') });
		expect((await head()).status).toBe(404);
		expect((await head('/nested/')).status).toBe(404);
		expect((await head('/')).status).toBe(404);
		expect((await request('/dav' + path + '/nested/', { method: 'MKCOL' })).status).toBe(201);
		expect((await request('/dav' + path + '/nested/leaf.txt', { method: 'PUT', body: 'replacement', headers: { 'Content-Type': 'text/plain', 'Content-Length': '11' } })).status).toBe(201);
		const recreated = await head();
		expect(recreated.status).toBe(200);
		expect(recreated.headers.get('Content-Length')).toBe('11');
		calls.length = 0;
		expect((await request('/dav' + path + '/nested/leaf.txt', { method: 'DELETE' })).status).toBe(204);
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe('PATCH');
		expect(calls[0].body).toEqual({ trashed: true });
		expect(calls[0].path).not.toBe('/drive/v3/files/delete-leaf');
		expect(drive.findById('delete-leaf')?.content).toEqual(new TextEncoder().encode('abc'));
	});

	it('hides deleted folder descendants immediately even while Drive trash flags lag', async () => {
		expect((await head()).status).toBe(200);
		recordMutations(drive, async (call, commit) => {
			if (call.body.trashed !== true) return;
			const response = await commit();
			for (const id of ['delete-sub', 'delete-leaf']) drive.findById(id)!.trashed = false;
			return response;
		});
		expect((await request('/dav' + path, { method: 'DELETE' })).status).toBe(204);
		expect((await head()).status).toBe(404);
		expect((await head('/nested/')).status).toBe(404);
	});

	it.each([
		['file', '/nested/leaf.txt', 'delete-leaf'],
		['folder', '/', 'delete-tree'],
	] as const)('preserves %s content, timestamps, and dead properties in Trash and supports Drive restore', async (_, suffix, targetId) => {
		const proppatch = await request('/dav' + path + '/nested/leaf.txt', {
			method: 'PROPPATCH',
			body: '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><X:label>kept</X:label></D:prop></D:set></D:propertyupdate>',
		});
		expect(proppatch.status).toBe(207);
		const before = drive.findById('delete-leaf')!.modifiedTime;
		expect((await request('/dav' + path + suffix, { method: 'DELETE' })).status).toBe(204);
		expect((await head()).status).toBe(404);
		expect(drive.findById(targetId)?.trashed).toBe(true);
		expect(drive.findById('delete-leaf')?.modifiedTime).toBe(before);

		const restore = await drive.handle('https://www.googleapis.com/drive/v3/files/' + targetId + '?supportsAllDrives=true', {
			method: 'PATCH',
			headers: { Authorization: 'Bearer test-access-token', 'Content-Type': 'application/json' },
			body: JSON.stringify({ trashed: false }),
		});
		expect(restore.status).toBe(200);
		expect((await head()).status).toBe(200);
		const get = await request('/dav' + path + '/nested/leaf.txt');
		expect(get.status).toBe(200);
		expect(await get.text()).toBe('abc');
		const propXml = await (await propfind()).text();
		expect(propXml).toContain('kept');
	});

	it.each([
		[403, 'insufficientFilePermissions'],
		[404, 'notFound'],
		[500, 'internalError'],
	] as const)('preserves upstream %i (%s) without trashing the live subtree', async (status, reason) => {
		expect((await head()).status).toBe(200);
		const calls = recordMutations(drive, async call => call.method === 'PATCH'
			? new Response(JSON.stringify({ error: { code: status, message: 'Drive rejection', errors: [{ reason }] } }), { status })
			: undefined);
		const res = await request('/dav' + path, { method: 'DELETE' });
		expect(res.status).toBe(status);
		expect(await res.text()).toContain(reason);
		expect(calls).toHaveLength(1);
		expect(drive.findById('delete-tree')?.trashed).not.toBe(true);
		expect(drive.findById('delete-leaf')?.trashed).not.toBe(true);
		expect((await head()).status).toBe(200);
	});

	it('evicts descendants even when the upstream trash request commits then loses its response', async () => {
		expect((await head()).status).toBe(200);
		recordMutations(drive, async (call, commit) => {
			if (call.method === 'PATCH' && call.body.trashed === true) {
				await commit();
				throw new Error('Injected lost DELETE response');
			}
		});
		expect((await request('/dav' + path, { method: 'DELETE' })).status).toBe(500);
		expect(drive.findById('delete-leaf')?.trashed).toBe(true);
		expect((await head()).status).toBe(404);
	});

	it('keeps file DELETE non-recursive and refreshes the parent listing', async () => {
		expect((await head()).status).toBe(200);
		await propfind('/nested/', '1');
		expect((await request('/dav' + path + '/nested/leaf.txt', { method: 'DELETE' })).status).toBe(204);
		expect(drive.findById('delete-leaf')?.trashed).toBe(true);
		expect(drive.findById('delete-sub')?.trashed).not.toBe(true);
		expect((await head()).status).toBe(404);
		expect((await head('/nested/')).status).toBe(200);
		const listing = await propfind('/nested/', '1');
		expect(await listing.text()).not.toContain('leaf.txt');
	});

	it('does not mutate Drive for root or missing paths', async () => {
		const calls = recordMutations(drive);
		expect((await request('/dav/', { method: 'DELETE' })).status).toBe(403);
		expect((await request('/dav' + path + '/missing', { method: 'DELETE' })).status).toBe(404);
		expect(calls).toEqual([]);
	});
});

describe('Google Workspace native docs and Shortcuts coexistence (7A)', () => {
	it('treats paths occupied only by hidden Workspace items or Shortcuts as absent on PUT, MKCOL, MOVE, and DELETE', async () => {
		const dir = 'ws-write-' + crypto.randomUUID();
		drive.add({ id: dir, name: dir, mimeType: FOLDER, parents: ['root'] });
		drive.add({ id: dir + '-doc', name: 'Notes', mimeType: 'application/vnd.google-apps.document', parents: [dir] });
		drive.add({ id: dir + '-shortcut', name: 'Linked', mimeType: 'application/vnd.google-apps.shortcut', parents: [dir] });
		drive.add({ id: dir + '-sheet', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', parents: [dir] });

		expect((await request('/dav/' + dir + '/Notes', {
			method: 'PUT',
			headers: { 'Content-Type': 'text/plain' },
			body: 'plain text copy',
		})).status).toBe(201);
		const fetched = await request('/dav/' + dir + '/Notes');
		expect(fetched.status).toBe(200);
		expect(await fetched.text()).toBe('plain text copy');

		expect((await request('/dav/' + dir + '/Linked', { method: 'MKCOL' })).status).toBe(201);
		expect((await request('/dav/' + dir + '/Linked/child.txt', {
			method: 'PUT',
			headers: { 'Content-Type': 'text/plain' },
			body: 'inside folder',
		})).status).toBe(201);
		expect(await (await request('/dav/' + dir + '/Linked/', { method: 'PROPFIND', headers: { Depth: '1' } })).text())
			.toContain('/dav/' + dir + '/Linked/child.txt');

		expect((await request('/dav/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/dav/' + dir + '/Budget' },
		})).status).toBe(201);
		const movedHead = await request('/dav/' + dir + '/Budget', { method: 'HEAD' });
		expect(movedHead.status).toBe(200);
		expect(movedHead.headers.get('Content-Length')).toBe('123');

		expect((await request('/dav/' + dir + '/Notes', { method: 'DELETE' })).status).toBe(204);
		expect((await request('/dav/' + dir + '/Notes', { method: 'HEAD' })).status).toBe(404);
		expect(drive.findById(dir + '-doc')?.trashed).not.toBe(true);
		expect(drive.findById(dir + '-shortcut')?.trashed).not.toBe(true);
		expect(drive.findById(dir + '-sheet')?.trashed).not.toBe(true);
	});
});
