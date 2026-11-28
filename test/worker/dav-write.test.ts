import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_CHUNK_SIZE } from '../../src/webdav/upload-stream';
import { AUTH, FOLDER, ORIGIN, recordMutations, seedStandardDrive } from '../support/client';
import type { MockDrive } from '../support/mock-drive';
import { invokeWorker, request, useMockDrive } from '../support/worker';
import { filledStream } from '../support/upload-stream';

const MEGA = 1024 * 1024;

const fixture = useMockDrive(seedStandardDrive);
let drive: MockDrive;

// Use the handler directly for framing/disconnect tests: SELF's HTTP bridge
// can reject malformed Content-Length headers or turn producer errors into EOF.
function directPut(path: string, body: BodyInit | null, headers: Record<string, string> = {}): Promise<Response> {
	return invokeWorker(env as Env, path, {
		method: 'PUT',
		headers: { ...AUTH, ...headers },
		body,
	});
}

beforeEach(() => {
	drive = fixture.drive;
});

function expectFilledBytes(content: Uint8Array | undefined, expectedLength: number, fillByte: number): void {
	expect(content).toBeInstanceOf(Uint8Array);
	expect(content!.length).toBe(expectedLength);
	const bytes = content!;
	if (bytes.byteOffset % 4 === 0 && bytes.length >= 4) {
		const word = ((fillByte << 24) | (fillByte << 16) | (fillByte << 8) | fillByte) >>> 0;
		const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >>> 2);
		for (let i = 0; i < words.length; i++) {
			if (words[i] !== word) expect.fail(`Byte mismatch at word offset ${i * 4}`);
		}
		for (let i = words.length * 4; i < bytes.length; i++) {
			if (bytes[i] !== fillByte) expect.fail(`Byte mismatch at offset ${i}`);
		}
		return;
	}
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] !== fillByte) expect.fail(`Byte mismatch at offset ${i}`);
	}
}

describe('PUT and MKCOL', () => {
	it.each([11, 5 * MEGA])('PUT creates a %i-byte multipart file', async (size) => {
		const res = await request('/webdav/put-new.txt', {
			method: 'PUT',
			headers: { 'Content-Type': 'text/plain' },
			body: 'x'.repeat(size),
		});
		expect(res.status).toBe(201);
		const created = drive.children('root').find((f) => f.name === 'put-new.txt');
		expect(created?.size).toBe(size);
		expectFilledBytes(created?.content, size, 120);
	});

	it('PUT over an existing file returns 204', async () => {
		const res = await request('/webdav/a.txt', {
			method: 'PUT',
			headers: { 'Content-Type': 'text/plain' },
			body: 'hello world',
		});
		expect(res.status).toBe(204);
		expect(drive.findById('file-a')).toMatchObject({ id: 'file-a', size: 11, content: new TextEncoder().encode('hello world') });
	});

	it('MKCOL on an existing resource returns 405', async () => {
		const res = await request('/webdav/a.txt', { method: 'MKCOL' });
		expect(res.status).toBe(405);
	});

	it('MKCOL creates a folder and returns 201', async () => {
		const res = await request('/webdav/new-folder', { method: 'MKCOL' });
		expect(res.status).toBe(201);
		const created = drive.children('root').find((f) => f.name === 'new-folder');
		expect(created?.mimeType).toBe(FOLDER);
	});

	it.each([
		['MKCOL', '/webdav/missing/new-folder', undefined],
		['MKCOL', '/webdav/missing/nested/new-folder/', undefined],
		['MKCOL', '/webdav/a.txt/new-folder', undefined],
		['PUT', '/webdav/missing/file.txt', 'hello'],
		['PUT', '/webdav/missing/empty.txt', ''],
		['PUT', '/webdav/a.txt/file.txt', 'hello'],
		['PUT-stream', '/webdav/missing/stream.dat', 'stream'],
		['PUT-stream', '/webdav/a.txt/stream.dat', 'stream'],
	] as const)('%s on %s rejects missing or non-folder parent with 409 without mutating Drive', async (kind, path, payload) => {
		const methods: string[] = [];
		const original = drive.handle.bind(drive);
		vi.spyOn(drive, 'handle').mockImplementation((input, init) => {
			const req = new Request(input, init);
			if (!new URL(req.url).pathname.startsWith('/oauth2/')) {
				methods.push(req.method);
			}
			return original(input, init);
		});
		const init: RequestInit = kind === 'MKCOL'
			? { method: 'MKCOL' }
			: kind === 'PUT-stream'
				? {
					method: 'PUT',
					body: new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(payload!));
							controller.close();
						},
					}),
				}
				: { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: payload };
		const res = await request(path, init);
		expect(res.status).toBe(409);
		expect(methods.every(method => method === 'GET')).toBe(true);
		expect(drive.children('root').some(f => f.name === 'missing')).toBe(false);
		expect(drive.findById('file-a')?.size).toBe(123);
	});

	it.each([
		['single-chunk create', '/webdav/resumable-single.dat', 5 * MEGA + 1, 201],
		['exact-chunk overwrite', '/webdav/a.txt', UPLOAD_CHUNK_SIZE, 204],
		['multi-chunk create', '/webdav/resumable-multi.dat', UPLOAD_CHUNK_SIZE + 1, 201],
	] as const)('PUT with known Content-Length > 5 MiB (%s at %s, %i bytes) returns %i', async (_, path, size, expectedStatus) => {
		const res = await request(path, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/octet-stream' },
			body: 'x'.repeat(size),
		});
		expect(res.status).toBe(expectedStatus);
		const file = drive.children('root').find(f => f.name === path.split('/').at(-1));
		expect(Number(file?.size)).toBe(size);
		if (expectedStatus === 204) expect(file?.id).toBe('file-a');
		expectFilledBytes(file?.content, size, 120);
	});

	it.each(['-1', 'abc', '12abc', '1.5', '', String(Number.MAX_SAFE_INTEGER + 1)])(
		'rejects invalid Content-Length (%j) with 400 before calling Drive',
		async contentLength => {
			const spy = vi.spyOn(drive, 'handle');
			const res = await directPut('/webdav/invalid-len.txt', 'hello', { 'Content-Length': contentLength });
			expect(res.status).toBe(400);
			expect(spy).not.toHaveBeenCalled();
			expect(drive.children('root').some(f => f.name === 'invalid-len.txt')).toBe(false);
		},
	);

	it.each([
		['/webdav/docs', 'empty', '', {}],
		['/webdav/docs', 'small', 'hello', { 'Content-Type': 'text/plain' }],
		['/webdav/docs', 'unknown-length', () => filledStream(3), {}],
		['/webdav/docs', 'large-resumable', () => filledStream(6 * MEGA), { 'Content-Length': String(6 * MEGA) }],
		['/webdav/docs/', 'trailing-slash', 'hello', { 'Content-Type': 'text/plain' }],
	] as const)('rejects PUT overwriting existing folder %s (%s) with 405 without mutating Drive', async (path, _kind, payload, headers) => {
		const methods: string[] = [];
		const original = drive.handle.bind(drive);
		vi.spyOn(drive, 'handle').mockImplementation((input, init) => {
			const req = new Request(input, init);
			if (!new URL(req.url).pathname.startsWith('/oauth2/')) {
				methods.push(req.method);
			}
			return original(input, init);
		});
		const body = typeof payload === 'function' ? payload() : payload;
		const res = path.endsWith('/') || typeof payload === 'string'
			? await request(path, { method: 'PUT', headers, body })
			: await directPut(path, body, headers);
		expect(res.status).toBe(405);
		if (!path.endsWith('/')) {
			const allow = res.headers.get('Allow')!.split(',').map(m => m.trim());
			expect(allow).not.toContain('PUT');
			expect(allow).toContain('PROPFIND');
		}
		expect(methods.every(method => method === 'GET')).toBe(true);
		expect(drive.findById('folder-docs')?.trashed).not.toBe(true);
	});
});

describe('PUT stream validation', () => {
	it.each([
		...['init', 'init-403', 'missing-location', 'chunk', 'range', 'early-complete', 'final-incomplete'].map(failure => ({ failure, knownLength: true })),
		...['init', 'chunk', 'range', 'early-complete', 'final-incomplete'].map(failure => ({ failure, knownLength: false })),
	])(
		'stops after $failure failure (known length=$knownLength)',
		async ({ failure, knownLength }) => {
			let chunks = 0;
			let produced = 0;
			const cancel = vi.fn();
			const original = drive.handle.bind(drive);
			vi.spyOn(drive, 'handle').mockImplementation((input, init) => {
				const url = String(input);
				if (!url.includes('uploadType=resumable')) return original(input, init);
				if (init?.method !== 'PUT') {
					if (failure === 'init') return Promise.resolve(new Response('injected', { status: 503 }));
					if (failure === 'init-403') return Promise.resolve(new Response('forbidden', { status: 403 }));
					if (failure === 'missing-location') return Promise.resolve(new Response(null, { status: 200 }));
					return original(input, init);
				}
				chunks++;
				if (failure === 'chunk') return Promise.resolve(new Response('injected', { status: 503 }));
				if (failure === 'range') return Promise.resolve(new Response(null, { status: 308, headers: { Range: 'bytes=0-2' } }));
				if (failure === 'early-complete') return Promise.resolve(new Response('{}', { status: 200 }));
				return Promise.resolve(new Response(null, { status: 308, headers: knownLength ? { Range: `bytes=0-${6 * MEGA - 1}` } : {} }));
			});
			const size = failure === 'final-incomplete' ? (knownLength ? 6 * MEGA : 3) : 2 * UPLOAD_CHUNK_SIZE + 3;
			const result = await directPut('/webdav/failed.dat', filledStream(size, () => produced++, cancel), {
				...(knownLength ? { 'Content-Length': String(size) } : {}),
			});
			const expectedStatus = failure === 'init' || failure === 'chunk' ? 503 : failure === 'init-403' ? 403 : 502;
			expect(result.status).toBe(expectedStatus);
			const expectedChunks = failure === 'init' || failure === 'init-403' || failure === 'missing-location' ? 0 : 1;
			expect(chunks).toBe(expectedChunks);
			expect(drive.children('root').some(file => file.name === 'failed.dat')).toBe(false);
			if (failure !== 'final-incomplete') {
				expect(produced).toBeLessThan(size / (256 * 1024));
				expect(cancel).toHaveBeenCalledOnce();
			}
		},
	);

	it.each([
		['null-body-nonzero', 10, null],
		['empty-stream-large', 6 * MEGA, () => filledStream(0)],
		['zero-length-nonempty-body', 0, () => filledStream(3)],
		['small-truncated', 10, () => filledStream(3)],
		['small-oversized', 10, () => filledStream(15)],
		['resumable-single-truncated', 6 * MEGA, () => filledStream(3)],
		['chunk-boundary-truncated', 11 * MEGA, () => filledStream(UPLOAD_CHUNK_SIZE)],
		['resumable-second-chunk-truncated', 11 * MEGA, () => filledStream(UPLOAD_CHUNK_SIZE + 3)],
		['resumable-oversized', UPLOAD_CHUNK_SIZE, () => filledStream(UPLOAD_CHUNK_SIZE + 1)],
	] as const)(
		'rejects Content-Length mismatch (%s) with 400 without committing a file',
		async (_label, declaredLength, makeBody) => {
			const original = drive.handle.bind(drive);
			const ranges: string[] = [];
			vi.spyOn(drive, 'handle').mockImplementation((input, init) => {
				const range = new Headers(init?.headers).get('Content-Range');
				if (range) ranges.push(range);
				return original(input, init);
			});
			const body = makeBody ? makeBody() : null;
			const res = await directPut('/webdav/bad-body.dat', body, { 'Content-Length': String(declaredLength) });
			expect(res.status).toBe(400);
			expect(drive.children('root').some(file => file.name === 'bad-body.dat')).toBe(false);
			if (declaredLength === 11 * MEGA) {
				expect(ranges.length).toBeLessThanOrEqual(1);
			}
		},
	);

	it.each([
		{ declaredLength: 10, knownLength: true, failAfter: 1 },
		{ declaredLength: 11 * MEGA, knownLength: true, failAfter: 43 },
		{ declaredLength: 11 * MEGA, knownLength: false, failAfter: 43 },
	])(
		'returns 502 when the input stream errors (length=$declaredLength, known=$knownLength)',
		async ({ declaredLength, knownLength, failAfter }) => {
			let pulls = 0;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (++pulls > failAfter) { controller.error(new Error('injected input failure')); return; }
					controller.enqueue(new Uint8Array(declaredLength <= 5 * MEGA ? 4 : 256 * 1024));
				},
			}, { highWaterMark: 0 });
			const original = drive.handle.bind(drive);
			let chunks = 0;
			vi.spyOn(drive, 'handle').mockImplementation((input, init) => {
				if (new Headers(init?.headers).has('Content-Range')) chunks++;
				return original(input, init);
			});
			const res = await directPut('/webdav/input-error.dat', body, knownLength ? { 'Content-Length': String(declaredLength) } : {});
			expect(chunks).toBe(declaredLength <= 5 * MEGA ? 0 : 1);
			expect(res.status).toBe(502);
			expect(drive.children('root').some(file => file.name === 'input-error.dat')).toBe(false);
		},
	);

	it('forwards upstream error without deadlocking when <= 5 MiB upload rejects before consuming body', async () => {
		const size = 5 * MEGA;
		const original = drive.handle.bind(drive);
		vi.spyOn(drive, 'handle').mockImplementation((input, init) => {
			if (String(input).includes('uploadType=multipart')) {
				return Promise.resolve(new Response('forbidden', { status: 403 }));
			}
			return original(input, init);
		});
		const res = await directPut('/webdav/early-reject.dat', filledStream(size), { 'Content-Length': String(size) });
		expect(res.status).toBe(403);
		expect(drive.children('root').some(file => file.name === 'early-reject.dat')).toBe(false);
	});
});

describe('unknown-length PUT', () => {
	it.each([
		['partial', UPLOAD_CHUNK_SIZE + MEGA + 3, '/webdav/stream.dat', 201],
		['exact', UPLOAD_CHUNK_SIZE, '/webdav/a.txt', 204],
	] as const)('uploads %s EOF with a known final total, preserving bytes', async (_, size, path, status) => {
		const ranges: string[] = [];
		let produced = 0;
		let pullsAtFirstChunk = 0;
		const original = drive.handle.bind(drive);
		vi.spyOn(drive, 'handle').mockImplementation((input, init) => {
			const headers = new Headers(init?.headers);
			if (String(input).includes('uploadType=resumable') && init?.method !== 'PUT') {
				expect(headers.has('X-Upload-Content-Length')).toBe(false);
			}
			if (headers.has('Content-Range')) {
				if (!ranges.length) pullsAtFirstChunk = produced;
				ranges.push(headers.get('Content-Range')!);
			}
			return original(input, init);
		});
		const response = await request(path, { method: 'PUT', body: filledStream(size, () => produced++) });
		expect(response.status, response.ok ? '' : await response.text()).toBe(status);
		if (size > UPLOAD_CHUNK_SIZE) expect(pullsAtFirstChunk).toBeLessThan(size / (256 * 1024));
		const file = drive.children('root').find(f => f.name === path.split('/').at(-1));
		expect(file?.size).toBe(size);
		expectFilledBytes(file?.content, size, 97);
		expect(ranges).toEqual(size === UPLOAD_CHUNK_SIZE
			? [`bytes 0-${size - 1}/${size}`]
			: [`bytes 0-${UPLOAD_CHUNK_SIZE - 1}/*`, `bytes ${UPLOAD_CHUNK_SIZE}-${size - 1}/${size}`]);
	});

	it('creates and truncates empty streams without an unusable resumable session', async () => {
		const handle = vi.spyOn(drive, 'handle');
		for (const [path, status] of [['/webdav/empty.dat', 201], ['/webdav/a.txt', 204]] as const) {
			expect((await request(path, { method: 'PUT', body: filledStream(0) })).status).toBe(status);
			const file = drive.children('root').find(f => f.name === path.split('/').at(-1));
			expect(Number(file?.size)).toBe(0);
		}
		expect(handle.mock.calls.some(([input]) => String(input).includes('uploadType=resumable'))).toBe(false);
	});
});

describe('DELETE trash, cache invalidation, and restore semantics', () => {
	let path: string;
	const head = (suffix = '/nested/leaf.txt') => request('/webdav' + path + suffix, { method: 'HEAD' });
	const propfind = (suffix = '/nested/leaf.txt', depth = '0') =>
		request('/webdav' + path + suffix, { method: 'PROPFIND', headers: { Depth: depth } });

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
		expect((await request('/webdav' + path + suffix, { method: 'DELETE' })).status).toBe(204);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/drive/v3/files/delete-tree', body: { trashed: true } });
		expect(calls[0].url.searchParams.get('supportsAllDrives')).toBe('true');
		expect(drive.findById('delete-tree')).toMatchObject({ trashed: true, explicitlyTrashed: true });
		expect(drive.findById('delete-sub')?.trashed).toBe(true);
		expect(drive.findById('delete-leaf')).toMatchObject({ trashed: true, content: new TextEncoder().encode('abc') });
		expect((await head()).status).toBe(404);
		expect((await head('/nested/')).status).toBe(404);
		expect((await head('/')).status).toBe(404);
		expect((await request('/webdav' + path + '/nested/', { method: 'MKCOL' })).status).toBe(409);
		expect((await head('/')).status).toBe(404);
		expect((await request('/webdav' + path + '/', { method: 'MKCOL' })).status).toBe(201);
		expect((await request('/webdav' + path + '/nested/', { method: 'MKCOL' })).status).toBe(201);
		expect((await request('/webdav' + path + '/nested/leaf.txt', { method: 'PUT', body: 'replacement', headers: { 'Content-Type': 'text/plain', 'Content-Length': '11' } })).status).toBe(201);
		const recreated = await head();
		expect(recreated.status).toBe(200);
		expect(recreated.headers.get('Content-Length')).toBe('11');
		calls.length = 0;
		expect((await request('/webdav' + path + '/nested/leaf.txt', { method: 'DELETE' })).status).toBe(204);
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
		expect((await request('/webdav' + path, { method: 'DELETE' })).status).toBe(204);
		expect((await head()).status).toBe(404);
		expect((await head('/nested/')).status).toBe(404);
	});

	it.each([
		['file', '/nested/leaf.txt', 'delete-leaf'],
		['folder', '/', 'delete-tree'],
	] as const)('preserves %s content, timestamps, and dead properties in Trash and supports Drive restore', async (_, suffix, targetId) => {
		const proppatch = await request('/webdav' + path + '/nested/leaf.txt', {
			method: 'PROPPATCH',
			body: '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><X:label>kept</X:label></D:prop></D:set></D:propertyupdate>',
		});
		expect(proppatch.status).toBe(207);
		const before = drive.findById('delete-leaf')!.modifiedTime;
		expect((await request('/webdav' + path + suffix, { method: 'DELETE' })).status).toBe(204);
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
		const get = await request('/webdav' + path + '/nested/leaf.txt');
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
		const res = await request('/webdav' + path, { method: 'DELETE' });
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
		expect((await request('/webdav' + path, { method: 'DELETE' })).status).toBe(500);
		expect(drive.findById('delete-leaf')?.trashed).toBe(true);
		expect((await head()).status).toBe(404);
	});

	it('keeps file DELETE non-recursive and refreshes the parent listing', async () => {
		expect((await head()).status).toBe(200);
		await propfind('/nested/', '1');
		expect((await request('/webdav' + path + '/nested/leaf.txt', { method: 'DELETE' })).status).toBe(204);
		expect(drive.findById('delete-leaf')?.trashed).toBe(true);
		expect(drive.findById('delete-sub')?.trashed).not.toBe(true);
		expect((await head()).status).toBe(404);
		expect((await head('/nested/')).status).toBe(200);
		const listing = await propfind('/nested/', '1');
		expect(await listing.text()).not.toContain('leaf.txt');
	});

	it('does not mutate Drive for root or missing paths', async () => {
		const calls = recordMutations(drive);
		expect((await request('/webdav/', { method: 'DELETE' })).status).toBe(403);
		expect((await request('/webdav' + path + '/missing', { method: 'DELETE' })).status).toBe(404);
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

		expect((await request('/webdav/' + dir + '/Notes/child.txt', { method: 'PUT', body: 'x' })).status).toBe(409);
		expect((await request('/webdav/' + dir + '/Notes/sub', { method: 'MKCOL' })).status).toBe(409);

		expect((await request('/webdav/' + dir + '/Notes', {
			method: 'PUT',
			headers: { 'Content-Type': 'text/plain' },
			body: 'plain text copy',
		})).status).toBe(201);
		const fetched = await request('/webdav/' + dir + '/Notes');
		expect(fetched.status).toBe(200);
		expect(await fetched.text()).toBe('plain text copy');

		expect((await request('/webdav/' + dir + '/Linked', { method: 'MKCOL' })).status).toBe(201);
		expect((await request('/webdav/' + dir + '/Linked/child.txt', {
			method: 'PUT',
			headers: { 'Content-Type': 'text/plain' },
			body: 'inside folder',
		})).status).toBe(201);
		expect(await (await request('/webdav/' + dir + '/Linked/', { method: 'PROPFIND', headers: { Depth: '1' } })).text())
			.toContain('/webdav/' + dir + '/Linked/child.txt');

		expect((await request('/webdav/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/webdav/' + dir + '/Budget' },
		})).status).toBe(201);
		const movedHead = await request('/webdav/' + dir + '/Budget', { method: 'HEAD' });
		expect(movedHead.status).toBe(200);
		expect(movedHead.headers.get('Content-Length')).toBe('123');

		expect((await request('/webdav/' + dir + '/Notes', { method: 'DELETE' })).status).toBe(204);
		expect((await request('/webdav/' + dir + '/Notes', { method: 'HEAD' })).status).toBe(404);
		expect(drive.findById(dir + '-doc')?.trashed).not.toBe(true);
		expect(drive.findById(dir + '-shortcut')?.trashed).not.toBe(true);
		expect(drive.findById(dir + '-sheet')?.trashed).not.toBe(true);
	});
});
