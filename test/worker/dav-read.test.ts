import { SELF, env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { AUTH, FOLDER, ORIGIN, installDriveMock, seedStandardDrive } from '../support/client';
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

describe('Google Workspace native docs and Shortcuts (7A)', () => {
	const workspaceTypes = [
		['Google Doc', 'application/vnd.google-apps.document', 'Project Plan'],
		['Google Sheet', 'application/vnd.google-apps.spreadsheet', 'Budget'],
		['Google Slides', 'application/vnd.google-apps.presentation', 'Deck'],
		['Google Drawing', 'application/vnd.google-apps.drawing', 'Diagram'],
		['Drive Shortcut', 'application/vnd.google-apps.shortcut', 'Folder Shortcut'],
		['Drive SDK file', 'application/vnd.google-apps.drive-sdk.42', 'Third Party'],
	] as const;

	const paginate = (pageSize: number) => {
		const original = drive.handle.bind(drive);
		return vi.spyOn(drive, 'handle').mockImplementation((input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.pathname === '/drive/v3/files' && (init?.method ?? 'GET') === 'GET') {
				url.searchParams.set('pageSize', String(pageSize));
			}
			return original(url.toString(), init);
		});
	};

	it('excludes native Google Workspace docs and Shortcuts from multi-page PROPFIND listings while retaining folders and Office files', async () => {
		const dir = 'ws-list-' + crypto.randomUUID();
		drive.add({ id: dir, name: dir, mimeType: FOLDER, parents: ['root'] });
		for (const [label, mimeType, name] of workspaceTypes) {
			drive.add({ id: dir + '-' + label, name, mimeType, parents: [dir] });
		}
		drive.add({ id: dir + '-sub', name: 'Real Folder', mimeType: FOLDER, parents: [dir] });
		drive.add({
			id: dir + '-docx',
			name: 'Spec.docx',
			mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			size: 4,
			content: new Uint8Array([80, 75, 3, 4]),
			parents: [dir],
		});
		drive.add({ id: dir + '-txt', name: 'readme.txt', mimeType: 'text/plain', size: 2, content: new Uint8Array([111, 107]), parents: [dir] });

		const spy = paginate(2);
		const res = await request('/dav/' + dir + '/', { method: 'PROPFIND', headers: { Depth: '1' } });
		expect(res.status).toBe(207);
		const xml = await res.text();
		for (const [, , name] of workspaceTypes) expect(xml).not.toContain(name);
		expect(xml).toContain('/dav/' + dir + '/Real%20Folder/');
		expect(xml).toContain('/dav/' + dir + '/Spec.docx');
		expect(xml).toContain('/dav/' + dir + '/readme.txt');
		expect(spy.mock.calls.filter(([input]) => String(input).includes('orderBy=')).length).toBeGreaterThan(1);
	});

	it.each(workspaceTypes)('returns 404 for %s across read, metadata, copy/move source, and delete without downloading or mutating', async (label, mimeType, name) => {
		const dir = 'ws-hide-' + crypto.randomUUID();
		const itemId = dir + '-item';
		drive.add({ id: dir, name: dir, mimeType: FOLDER, parents: ['root'] });
		drive.add({ id: itemId, name, mimeType, parents: [dir] });
		drive.add({ id: dir + '-child', name: 'hidden-child.txt', mimeType: 'text/plain', size: 3, parents: [itemId] });
		const path = '/dav/' + dir + '/' + encodeURIComponent(name);

		const spy = vi.spyOn(drive, 'handle');
		for (const init of [
			{ method: 'GET' },
			{ method: 'HEAD' },
			{ method: 'PROPFIND', headers: { Depth: '0' } },
			{ method: 'PROPFIND', headers: { Depth: '1' } },
			{ method: 'PROPPATCH', body: '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><X:k>v</X:k></D:prop></D:set></D:propertyupdate>' },
			{ method: 'DELETE' },
			{ method: 'MOVE', headers: { Destination: ORIGIN + '/dav/' + dir + '/moved-' + label } },
			{ method: 'COPY', headers: { Destination: ORIGIN + '/dav/' + dir + '/copied-' + label } },
		] as RequestInit[]) {
			expect((await request(path, init)).status).toBe(404);
		}
		expect((await request(path + '/hidden-child.txt')).status).toBe(404);
		expect(drive.findById(itemId)?.trashed).not.toBe(true);
		const calls = spy.mock.calls.map(([input, init]) => ({
			url: String(input),
			method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
		}));
		expect(calls.some(call => call.url.includes('alt=media') || call.method !== 'GET')).toBe(false);
	});

	it('resolves a visible file or folder when hidden items share the same name across pages and stops traversal at non-folders', async () => {
		const dir = 'ws-same-' + crypto.randomUUID();
		drive.add({ id: dir, name: dir, mimeType: FOLDER, parents: ['root'] });
		drive.add({ id: dir + '-doc', name: 'Report', mimeType: 'application/vnd.google-apps.document', parents: [dir] });
		drive.add({ id: dir + '-shortcut', name: 'Report', mimeType: 'application/vnd.google-apps.shortcut', parents: [dir] });
		const pdf = new TextEncoder().encode('%PDF-1.4');
		drive.add({ id: dir + '-pdf', name: 'Report', mimeType: 'application/pdf', size: pdf.length, content: pdf, parents: [dir] });
		drive.add({ id: dir + '-folder-shortcut', name: 'Shared', mimeType: 'application/vnd.google-apps.shortcut', parents: [dir] });
		drive.add({ id: dir + '-folder-real', name: 'Shared', mimeType: FOLDER, parents: [dir] });
		drive.add({ id: dir + '-inner', name: 'inside.txt', mimeType: 'text/plain', size: 2, content: new Uint8Array([49, 50]), parents: [dir + '-folder-real'] });

		const spy = paginate(1);
		const listing = await request('/dav/' + dir + '/', { method: 'PROPFIND', headers: { Depth: '1' } });
		expect(listing.status).toBe(207);
		const listingXml = await listing.text();
		expect(listingXml).not.toContain('application/vnd.google-apps.document');
		expect(listingXml).not.toContain('application/vnd.google-apps.shortcut');
		expect(listingXml).toContain('<D:getcontenttype>application/pdf</D:getcontenttype>');
		expect(listingXml).toContain('/dav/' + dir + '/Shared/');

		const download = await request('/dav/' + dir + '/Report');
		expect(download.status).toBe(200);
		expect(download.headers.get('Content-Type')).toBe('application/pdf');
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(pdf);

		const sub = await request('/dav/' + dir + '/Shared/', { method: 'PROPFIND', headers: { Depth: '1' } });
		expect(sub.status).toBe(207);
		expect(await sub.text()).toContain('/dav/' + dir + '/Shared/inside.txt');

		const callsBeforeNonFolder = spy.mock.calls.length;
		expect((await request('/dav/' + dir + '/Report/child.txt')).status).toBe(404);
		expect(spy.mock.calls.length).toBe(callsBeforeNonFolder);
	});
});
