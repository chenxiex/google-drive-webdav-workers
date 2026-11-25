import { SELF, env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH, FOLDER, MockDrive, ORIGIN, installDriveMock } from './helpers';

import worker from '../src/worker';
import { UPLOAD_CHUNK_SIZE, uploadChunks } from '../src/upload-stream';

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

	it('does not advertise Class 2 or locking methods in OPTIONS', async () => {
		const res = await request('/dav/', { method: 'OPTIONS' });
		expect(res.status).toBe(200);
		expect(res.headers.get('DAV')).toBe('1');
		expect(res.headers.get('Allow')).not.toContain('LOCK');
		expect(res.headers.get('Allow')).toContain('PROPFIND');
		expect(res.headers.get('Allow')).toContain('MOVE');
	});

	it.each(['/other', '/_/16/type/application/vnd.google-apps.folder'])('returns 404 for paths outside the base path (%s)', async path => {
		const spy = vi.spyOn(drive, 'handle');
		const res = await SELF.fetch(ORIGIN + path);
		expect(res.status).toBe(404);
		expect(spy).not.toHaveBeenCalled();
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

describe('unsupported locking', () => {
	it.each(['/dav/a.txt', '/dav/missing.txt'])('rejects LOCK and UNLOCK without contacting Drive (%s)', async path => {
		const spy = vi.spyOn(drive, 'handle');
		for (const attempt of [
			{ method: 'LOCK', headers: { 'Content-Type': 'application/xml', Timeout: 'Second-3600' },
				body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>' },
			{ method: 'LOCK', headers: { If: '(<opaquelocktoken:test>)' } },
			{ method: 'UNLOCK', headers: { 'Lock-Token': '<opaquelocktoken:test>' } },
		] as RequestInit[]) {
			const response = await request(path, attempt);
			expect(response.status).toBe(501);
			expect(response.headers.has('Lock-Token')).toBe(false);
			expect(await response.text()).toBe('WebDAV locking is not supported');
		}
		expect(spy).not.toHaveBeenCalled();
	});

	it('still authenticates LOCK/UNLOCK and reports empty supportedlock in PROPFIND', async () => {
		for (const method of ['LOCK', 'UNLOCK']) {
			expect((await SELF.fetch(ORIGIN + '/dav/a.txt', { method })).status).toBe(401);
		}
		const response = await request('/dav/', { method: 'PROPFIND', headers: { Depth: '1' } });
		expect(response.status).toBe(207);
		const xml = await response.text();
		expect(xml.match(/<D:supportedlock\/>/g)?.length).toBe(xml.match(/<D:response>/g)?.length);
		expect(xml).not.toContain('<D:lockentry>');
		expect(xml).not.toContain('<D:activelock>');
	});
});

describe('original file downloads', () => {
	const content = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 42, 99]);
	beforeEach(() => {
		drive.add({ id: 'image', name: 'image.png', mimeType: 'image/png', parents: ['root'], size: content.length, content,
			thumbnailLink: 'https://thumbnail.example/image=s220' });
	});

	it.each(['', '?param=s32'])('downloads original image bytes, not a thumbnail (%s)', async query => {
		const spy = vi.spyOn(drive, 'handle');
		const head = await request('/dav/image.png', { method: 'HEAD' });
		const response = await request('/dav/image.png' + query);
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('image/png');
		expect(response.headers.get('Content-Length')).toBe(String(content.length));
		expect(head.headers.get('Content-Length')).toBe(response.headers.get('Content-Length'));
		expect(head.headers.get('ETag')).toBeNull();
		expect(response.headers.get('ETag')).toMatch(/^"[^"]+"$/);
		expect(head.headers.get('Accept-Ranges')).toBe('bytes');
		expect(response.headers.get('Accept-Ranges')).toBe('bytes');
		expect(head.headers.get('Date')).not.toBe(head.headers.get('Last-Modified'));
		const properties = await (await request('/dav/image.png', { method: 'PROPFIND', headers: { Depth: '0' } })).text();
		expect(properties).toContain('<D:getetag>&quot;image-1&quot;</D:getetag>');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(content);
		const urls = spy.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : String(input)));
		expect(urls.some(url => url.searchParams.get('alt') === 'media')).toBe(true);
		expect(urls.every(url => url.hostname === 'www.googleapis.com')).toBe(true);
	});

	it.each(['matching', 'stale', 'weak', 'missing-upstream', 'unsatisfiable'] as const)('handles If-Range safely (%s)', async mode => {
		const initial = await request('/dav/image.png');
		const tag = initial.headers.get('ETag')!;
		await initial.arrayBuffer();
		const handle = drive.handle.bind(drive);
		const calls: (string | null)[] = [];
		vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
			const response = await handle(input, init);
			if (String(input).includes('alt=media')) {
				calls.push(new Headers(init?.headers).get('Range'));
				if (mode === 'missing-upstream') response.headers.delete('ETag');
			}
			return response;
		});
		const validator = mode === 'stale' ? '"old-version"' : mode === 'weak' ? 'W/' + tag : tag;
		const range = mode === 'unsatisfiable' ? 'bytes=100-102' : 'bytes=1-3';
		const response = await request('/dav/image.png', { headers: { Range: range, 'If-Range': validator } });
		const matching = mode === 'matching';
		expect(response.status).toBe(matching ? 206 : 200);
		expect(response.headers.get('Content-Range')).toBe(matching ? 'bytes 1-3/12' : null);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(matching ? content.slice(1, 4) : content);
		expect(calls).toEqual(matching ? [range] : [range, null]);
	});

	it('uses the media validator even when cached metadata, size and mtime stay unchanged', async () => {
		const first = await request('/dav/image.png');
		const tag = first.headers.get('ETag')!;
		await first.arrayBuffer();
		const file = drive.files.find(file => file.id === 'image')!;
		const modifiedTime = file.modifiedTime;
		const changed = content.slice(); changed[0] = 1;
		file.content = changed;
		const response = await request('/dav/image.png', { headers: { Range: 'bytes=1-3', 'If-Range': tag } });
		expect(response.status).toBe(200);
		expect(response.headers.get('ETag')).not.toBe(tag);
		expect(file.modifiedTime).toBe(modifiedTime);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(changed);
	});

	it('cancels discarded partial bytes and preserves a failed full-download retry', async () => {
		const handle = drive.handle.bind(drive);
		let cancelled = false;
		let mediaCalls = 0;
		vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
			if (!String(input).includes('alt=media')) return handle(input, init);
			mediaCalls++;
			if (mediaCalls === 1) return new Response(new ReadableStream({
				cancel() { cancelled = true; },
			}), { status: 206, headers: { ETag: '"new"' } });
			expect(cancelled).toBe(true);
			expect(new Headers(init?.headers).has('Range')).toBe(false);
			return new Response('retry failed', { status: 503 });
		});
		const response = await request('/dav/image.png', { headers: { Range: 'bytes=1-3', 'If-Range': '"old"' } });
		expect(response.status).toBe(503);
		expect(mediaCalls).toBe(2);
		expect(cancelled).toBe(true);
	});

	it.each([404, 500])('does not hide upstream %s with an If-Range retry', async status => {
		const handle = drive.handle.bind(drive);
		let mediaCalls = 0;
		vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
			if (String(input).includes('alt=media')) {
				mediaCalls++;
				return new Response('upstream failure', { status });
			}
			return handle(input, init);
		});
		const response = await request('/dav/image.png', { headers: { Range: 'bytes=1-3', 'If-Range': '"old"' } });
		expect(response.status).toBe(status);
		expect(mediaCalls).toBe(1);
	});

	it('forwards the client Range and preserves the partial original response', async () => {
		const spy = vi.spyOn(drive, 'handle');
		const response = await request('/dav/image.png', { headers: { Range: 'bytes=1-3' } });
		expect(response.status).toBe(206);
		expect(response.headers.get('Content-Type')).toBe('image/png');
		expect(response.headers.get('Content-Length')).toBe('3');
		expect(response.headers.get('Content-Range')).toBe('bytes 1-3/12');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(content.slice(1, 4));
		const media = spy.mock.calls.find(([input]) => String(input).includes('alt=media'));
		expect(media).toBeDefined();
		expect(String(media![0])).toContain('/drive/v2/files/');
		expect(new Headers(media![1]?.headers).get('Range')).toBe('bytes=1-3');
		expect(new Headers(media![1]?.headers).get('Authorization')).toBe('Bearer test-access-token');
	});
});

describe('PROPFIND', () => {
	// Documented Drive int64 / absent-limit shapes injected at the boundary.
	// This does not claim the synthetic account has an unlimited plan.
	it.each([
		[{ usage: '9007199254740993', limit: '9223372036854775807' }, '9214364837600034814'],
		[{ usage: '4096' }, undefined],
		[{ usage: '4096', limit: '1024' }, '0'],
	])('preserves quota integers and handles absent or exhausted limits', async (storageQuota, available) => {
		const original = drive.handle.bind(drive);
		vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
			if (String(input).includes('/drive/v3/about?')) return new Response(JSON.stringify({ storageQuota }));
			return original(input, init);
		});
		const response = await request('/dav/', { method: 'PROPFIND', headers: { Depth: '0' } });
		expect(response.status).toBe(207);
		const xml = await response.text();
		expect(xml).toContain('<D:quota-used-bytes>' + storageQuota.usage + '</D:quota-used-bytes>');
		if (available === undefined) expect(xml).not.toContain('<D:quota-available-bytes>');
		else expect(xml).toContain('<D:quota-available-bytes>' + available + '</D:quota-available-bytes>');
	});

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

	it('bounds assembly to one chunk plus lookahead and stops reading while the consumer waits', async () => {
		const pull = vi.fn();
		const cancel = vi.fn();
		const body = stream(4 * UPLOAD_CHUNK_SIZE, pull, cancel);
		const chunks = uploadChunks(body);
		const first = await chunks.next();
		expect(first.value?.bytes.length).toBe(UPLOAD_CHUNK_SIZE);
		expect(first.value?.final).toBe(false);
		expect(pull).toHaveBeenCalledTimes(UPLOAD_CHUNK_SIZE / (256 * 1024) + 1);
		await Promise.resolve();
		expect(pull).toHaveBeenCalledTimes(UPLOAD_CHUNK_SIZE / (256 * 1024) + 1);
		await chunks.return(undefined);
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});

	it('splits oversized input chunks and ignores empty input chunks without losing bytes', async () => {
		const input = new Uint8Array(UPLOAD_CHUNK_SIZE + 7).fill(19);
		input.fill(31, UPLOAD_CHUNK_SIZE);
		const body = new ReadableStream<Uint8Array>({ start(controller) {
			controller.enqueue(new Uint8Array(0));
			controller.enqueue(input);
			controller.enqueue(new Uint8Array(0));
			controller.close();
		} });
		const results = [];
		for await (const chunk of uploadChunks(body)) {
			// The assembler reuses its bounded buffer on the next iteration.
			results.push({ bytes: chunk.bytes.slice(), final: chunk.final });
		}
		expect(results.map(chunk => [chunk.bytes.length, chunk.final])).toEqual([[UPLOAD_CHUNK_SIZE, false], [7, true]]);
		expect(results[0].bytes.every(byte => byte === 19)).toBe(true);
		expect(results[1].bytes).toEqual(new Uint8Array(7).fill(31));
		expect(body.locked).toBe(false);
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

describe('HEAD and collection GET', () => {
	it('HEAD reports the file size', async () => {
		const res = await request('/dav/a.txt', { method: 'HEAD' });
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Length')).toBe('123');
		expect(res.headers.get('Content-Type')).toBe('text/plain');
	});

	it.each(['/dav/', '/dav/docs', '/dav/docs/'])('rejects GET on collection %s with 405 without listing children', async path => {
		const spy = vi.spyOn(drive, 'handle');
		const res = await request(path, { method: 'GET', redirect: 'manual' });
		expect(res.status).toBe(405);
		expect(res.headers.get('Allow')).toContain('PROPFIND');
		expect(res.headers.get('Allow')).not.toContain('GET');
		expect(res.headers.get('Content-Type')).not.toMatch(/html/i);
		const listCalls = spy.mock.calls.filter(([input]) => String(input).includes('orderBy='));
		expect(listCalls).toEqual([]);
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
const ambiguousStatus = (failure: string) => failure === 'network' ? 500 : /^\d+$/.test(failure) ? Number(failure) : 502;
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

	it.each(['root', 'folder-docs'])('COPY stages before trashing and publishing in parent %s', async parentId => {
		drive.findById('file-dest')!.parents = [parentId];
		const calls = recordMutations();
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
		const calls = recordMutations(async call => call.body.trashed === true ? rejectMutation(403) : undefined);
		expect((await overwrite(method)).status).toBe(403);
		expect(calls.some(isPublish)).toBe(false);
		expect(calls.map(c => c.method)).toEqual(method === 'COPY' ? ['POST', 'PATCH'] : ['PATCH']);
		expect(drive.findById('file-dest')).toMatchObject({ name: 'dest.txt', size: 456 });
		expect(drive.findById('file-dest')?.trashed).not.toBe(true);
		expect(drive.findById('file-a')?.name).toBe('a.txt');
		if (method === 'COPY') expect(drive.files.some(f => f.name.startsWith('.webdav-copy-') && !f.trashed)).toBe(true);
	});

	it.each(['network', '500', 'source-id'])('COPY preserves a committed stage after ambiguous %s response without touching the target', async failure => {
		const calls = recordMutations(async (call, commit) => {
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
		const calls = recordMutations(async (call, commit) => {
			if (call.body.trashed !== true) return;
			await commit();
			if (failure === 'network') throw new Error('Injected lost trash response');
			return rejectMutation(Number(failure));
		});
		expect((await overwrite(method)).status).toBe(ambiguousStatus(failure));
		expect(calls.map(c => c.method)).toEqual(method === 'COPY' ? ['POST', 'PATCH'] : ['PATCH']);
		expect(drive.findById('file-dest')?.trashed).toBe(true);
		expect(drive.findById('file-a')?.name).toBe('a.txt');
		if (method === 'COPY') expect(drive.files.some(f => f.name === calls[0].body.name && !f.trashed)).toBe(true);
	});

	it('COPY staging failure leaves the target untouched and retries use distinct staging names', async () => {
		let failStage = true;
		const calls = recordMutations(async call => {
			if (failStage && call.method === 'POST') return rejectMutation(403);
			if (!failStage && call.body.trashed === true) return rejectMutation(403);
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
		expect(drive.files.filter(f => names.includes(f.name) && !f.trashed)).toHaveLength(2);
		expect(calls.some(c => c.method === 'DELETE')).toBe(false);
	});

	it.each(['MOVE', 'COPY'])('%s restores the old destination after definitive 403 publication rejection', async method => {
		const calls = recordMutations(async call => isPublish(call) ? rejectMutation(403) : undefined);
		expect((await overwrite(method)).status).toBe(403);
		expect(mutationSummary(calls).at(-1)).toEqual({ method: 'PATCH', path: '/drive/v3/files/file-dest', body: { trashed: false } });
		expect(calls.map(c => c.method)).toEqual(method === 'COPY' ? ['POST', 'PATCH', 'PATCH', 'PATCH'] : ['PATCH', 'PATCH', 'PATCH']);
		expect(drive.findById('file-dest')).toMatchObject({ name: 'dest.txt', size: 456, trashed: false });
		expect(drive.findById('file-a')?.name).toBe('a.txt');
		if (method === 'COPY') expect(drive.files.some(f => f.name.startsWith('.webdav-copy-') && !f.trashed)).toBe(true);
	});

	it.each(['MOVE', 'COPY'])('%s reports failure if destination restoration is rejected', async method => {
		const calls = recordMutations(async call => isPublish(call) || call.body.trashed === false ? rejectMutation(403) : undefined);
		const res = await overwrite(method);
		expect(res.status).toBe(403);
		expect(await res.text()).toContain('destination restore failed');
		expect(calls.at(-1)?.body).toEqual({ trashed: false });
		expect(calls.some(c => c.method === 'DELETE')).toBe(false);
		expect(drive.findById('file-dest')?.trashed).toBe(true);
		expect(drive.findById('file-a')?.name).toBe('a.txt');
	});

	it.each([
		{ method: 'MOVE', failure: 'network', committed: true },
		{ method: 'MOVE', failure: '408', committed: true },
		{ method: 'MOVE', failure: 'wrong-id', committed: true },
		{ method: 'COPY', failure: 'network', committed: false },
	])('$method does not undo or delete after ambiguous $failure publication (committed=$committed)', async ({ method, failure, committed }) => {
		const calls = recordMutations(async (call, commit) => {
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

	// Collection COPY is rejected earlier; only MOVE reaches these tree guards.
	it.each(['MOVE', 'COPY'].flatMap(method => [
		{ source: '/dav/docs/', destination: '/dav/docs/sub%26dir/' },
		{ source: '/dav/docs/', destination: '/dav/docs/new-child/' },
		{ source: '/dav/docs/sub%26dir/', destination: '/dav/docs/' },
		{ source: '/dav/docs/b%20%26%20c.txt', destination: '/dav/docs/' },
	].filter(paths => method === 'MOVE' || paths.source.endsWith('.txt')).map(paths => ({ method, ...paths }))))('$method rejects related paths $source → $destination before mutation', async ({ method, source, destination }) => {
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

	it('keeps file DELETE non-recursive and refreshes the parent listing', async () => {
		expect((await head()).status).toBe(200);
		await request('/dav' + path + '/nested/', { method: 'PROPFIND', headers: { Depth: '1' } });
		expect((await request('/dav' + path + '/nested/leaf.txt', { method: 'DELETE' })).status).toBe(204);
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
		for (const id of ['old-tree', 'old-trash', 'old-sub', 'old-leaf']) expect(drive.findById(id)?.trashed).toBe(true);
		expect(drive.findById('old-leaf')?.content).toEqual(new Uint8Array([1, 2, 255]));
		expect((await request('/dav/' + targetName + '/nested/keep.bin', { method: 'HEAD' })).status).toBe(404);
		expect((await request('/dav/' + targetName, { method: 'HEAD' })).status).toBe(200);
		expect(calls.some(c => c.method === 'DELETE')).toBe(false);
	});

	it('MOVE hides old paths even while descendant trash flags lag behind the parent', async () => {
		targetTree();
		expect((await request('/dav/' + targetName + '/nested/keep.bin', { method: 'HEAD' })).status).toBe(200);
		recordMutations(async (call, commit) => {
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

	it('MOVE restores the destination tree after an injected publication rejection, including independently trashed children', async () => {
		targetTree();
		const calls = recordMutations(async call => call.body.name === targetName ? rejectMutation(403) : undefined);
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

describe('isolate cache bounds and lifetime', () => {
    it.each(['meta', 'objects'])('expires %s entries without extending their lifetime on hits', async ns => {
        const name = 'memory-ttl-' + ns;
        drive.add({ id: name, name, mimeType: ns === 'objects' ? FOLDER : 'text/plain', size: 123, parents: ['root'] });
        const start = Date.now();
        let now = start;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const read = async () => {
            const response = await request('/dav/' + name, { method: ns === 'meta' ? 'HEAD' : 'PROPFIND', headers: { Depth: '1' } });
            expect(response.status).toBe(ns === 'meta' ? 200 : 207);
            return ns === 'meta' ? response.headers.get('Content-Length') : response.text();
        };
        const original = await read();
        if (ns === 'meta') drive.findById(name)!.size = 456;
        else drive.add({ id: name + '-new', name: 'new-child.txt', mimeType: 'text/plain', parents: [name] });
        now = start + (ns === 'meta' ? 300000 : 30000) - 1;
        expect(await read()).toBe(original);
        now++;
        const fresh = await read();
        if (ns === 'meta') expect(fresh).toBe('456');
        else expect(fresh).toContain('new-child.txt');
    });

    it('evicts old metadata at capacity while preserving the mounted root', async () => {
        const directHead = async (path: string) => {
            const ctx = createExecutionContext();
            const response = await worker.fetch(new Request(ORIGIN + path, { method: 'HEAD', headers: AUTH }), env as Env, ctx);
            await waitOnExecutionContext(ctx);
            return response;
        };
        for (let i = 0; i <= 128; i++) {
            drive.add({ id: 'bounded-' + i, name: 'bounded-' + i, mimeType: 'text/plain', size: 123, parents: ['root'] });
        }
        expect((await directHead('/dav/bounded-0')).status).toBe(200);
        for (let start = 1; start < 128; start += 16) {
            const batch = Array.from({ length: Math.min(16, 128 - start) }, (_, j) => directHead('/dav/bounded-' + (start + j)));
            const responses = await Promise.all(batch);
            expect(responses.every(r => r.status === 200)).toBe(true);
        }
        expect((await directHead('/dav/bounded-128')).status).toBe(200);
        drive.findById('bounded-0')!.size = 456;
        drive.findById('bounded-128')!.size = 456;
        expect((await directHead('/dav/bounded-0')).headers.get('Content-Length')).toBe('456');
        expect((await directHead('/dav/bounded-128')).headers.get('Content-Length')).toBe('123');
        expect((await directHead('/dav/')).status).toBe(200);
    });

    it('does not retain oversized directory listings', async () => {
        drive.add({ id: 'large-list', name: 'large-list', mimeType: FOLDER, parents: ['root'] });
        for (let i = 0; i < 80; i++) drive.add({ id: 'large-' + i, name: 'x'.repeat(900) + i, mimeType: 'text/plain', parents: ['large-list'] });
        const read = async () => {
            const response = await request('/dav/large-list/', { method: 'PROPFIND', headers: { Depth: '1' } });
            expect(response.status).toBe(207);
            return response.text();
        };
        expect(await read()).not.toContain('fresh-child.txt');
        drive.add({ id: 'large-fresh', name: 'fresh-child.txt', mimeType: 'text/plain', parents: ['large-list'] });
        expect(await read()).toContain('fresh-child.txt');
    });
});
