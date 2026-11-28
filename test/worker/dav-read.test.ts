import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FOLDER, ORIGIN, seedStandardDrive } from '../support/client';
import type { MockDrive } from '../support/mock-drive';
import { request, useMockDrive } from '../support/worker';

const fixture = useMockDrive(seedStandardDrive);
let drive: MockDrive;

beforeEach(() => {
	drive = fixture.drive;
});

describe('auth', () => {
	it('requires credentials', async () => {
		const res = await SELF.fetch(ORIGIN + '/webdav/');
		expect(res.status).toBe(401);
		expect(res.headers.get('WWW-Authenticate')).toMatch(/^Basic realm=/);
	});

	it('rejects a wrong password', async () => {
		const res = await request('/webdav/', { headers: { Authorization: 'Basic ' + btoa('test:wrong') } });
		expect(res.status).toBe(401);
	});

	it('rejects malformed base64 without crashing', async () => {
		const res = await request('/webdav/', { headers: { Authorization: 'Basic not-valid@#$' } });
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

	it('does not advertise Class 2, locking, or non-TUS PATCH methods in OPTIONS', async () => {
		const res = await request('/webdav/', { method: 'OPTIONS' });
		expect(res.status).toBe(200);
		expect(res.headers.get('DAV')).toBe('1');
		const allow = res.headers.get('Allow')!.split(',').map(m => m.trim());
		expect(allow).not.toContain('LOCK');
		expect(allow).not.toContain('PATCH');
		expect(allow).toContain('PROPFIND');
		expect(allow).toContain('MOVE');

		const tusOptions = await request('/webdav/tus_uploads/' + crypto.randomUUID(), { method: 'OPTIONS' });
		expect(tusOptions.status).toBe(200);
		expect(tusOptions.headers.get('Allow')!.split(',').map(m => m.trim())).toContain('PATCH');
	});

	it.each(['/other', '/dav/', '/dav/spaces', '/_/16/type/application/vnd.google-apps.folder'])('returns 404 for paths outside the base path (%s)', async path => {
		const spy = vi.spyOn(drive, 'handle');
		const res = await SELF.fetch(ORIGIN + path);
		expect(res.status).toBe(404);
		expect(spy).not.toHaveBeenCalled();
	});

	it('rejects invalid percent-encoding with a 400, not a 500', async () => {
		const res = await request('/webdav/%zz');
		expect(res.status).toBe(400);
		expect(await res.text()).toContain('Invalid path encoding');
	});

	it('returns 404 for a missing resource', async () => {
		const res = await request('/webdav/missing.txt');
		expect(res.status).toBe(404);
	});
});

describe('unsupported locking', () => {
	it.each(['/webdav/a.txt', '/webdav/missing.txt'])('rejects LOCK and UNLOCK without contacting Drive (%s)', async path => {
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
			expect((await SELF.fetch(ORIGIN + '/webdav/a.txt', { method })).status).toBe(401);
		}
		const response = await request('/webdav/', { method: 'PROPFIND', headers: { Depth: '1' } });
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
		const expectedEtag = `"image-${drive.findById('image')!.headRevisionId}"`;
		const head = await request('/webdav/image.png', { method: 'HEAD' });
		const response = await request('/webdav/image.png' + query);
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('image/png');
		expect(response.headers.get('Content-Length')).toBe(String(content.length));
		expect(head.headers.get('Content-Length')).toBe(response.headers.get('Content-Length'));
		expect(head.headers.get('ETag')).toBe(expectedEtag);
		expect(response.headers.get('ETag')).toBe(expectedEtag);
		expect(head.headers.get('Accept-Ranges')).toBe('bytes');
		expect(response.headers.get('Accept-Ranges')).toBe('bytes');
		expect(head.headers.get('Date')).not.toBe(head.headers.get('Last-Modified'));
		const properties = await (await request('/webdav/image.png', { method: 'PROPFIND', headers: { Depth: '0' } })).text();
		expect(properties).toContain(`<D:getetag>&quot;image-${drive.findById('image')!.headRevisionId}&quot;</D:getetag>`);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(content);
		const urls = spy.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : String(input)));
		expect(urls.some(url => url.pathname === `/drive/v3/files/image/revisions/${drive.findById('image')!.headRevisionId}`
			&& url.searchParams.get('alt') === 'media')).toBe(true);
		expect(urls.some(url => url.pathname.includes('/drive/v2/'))).toBe(false);
		expect(urls.every(url => url.hostname === 'www.googleapis.com')).toBe(true);
	});

	it.each(['matching', 'stale', 'weak', 'http-date', 'unsatisfiable'] as const)('handles If-Range safely (%s)', async mode => {
		const initial = await request('/webdav/image.png');
		const tag = initial.headers.get('ETag')!;
		await initial.arrayBuffer();
		const handle = drive.handle.bind(drive);
		const calls: (string | null)[] = [];
		vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
			const response = await handle(input, init);
			if (String(input).includes('alt=media')) {
				calls.push(new Headers(init?.headers).get('Range'));
			}
			return response;
		});
		const validator = mode === 'stale' ? '"old-version"'
			: mode === 'weak' ? 'W/' + tag
			: mode === 'http-date' ? 'Wed, 01 Jan 2020 00:00:00 GMT'
			: tag;
		const range = mode === 'unsatisfiable' ? 'bytes=100-102' : 'bytes=1-3';
		const response = await request('/webdav/image.png', { headers: { Range: range, 'If-Range': validator } });
		if (mode === 'unsatisfiable') {
			expect(response.status).toBe(416);
			expect(response.headers.get('Content-Range')).toBe('bytes */12');
			expect(response.headers.get('Accept-Ranges')).toBe('bytes');
			expect(response.headers.get('ETag')).toBe(tag);
			await response.body?.cancel();
			expect(calls).toEqual([range]);
			return;
		}
		const matching = mode === 'matching';
		expect(response.status).toBe(matching ? 206 : 200);
		expect(response.headers.get('Content-Range')).toBe(matching ? 'bytes 1-3/12' : null);
		expect(response.headers.get('ETag')).toBe(tag);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(matching ? content.slice(1, 4) : content);
		expect(calls).toEqual([matching ? range : null]);
	});

	it('serves immutable revision bytes for cached reads and bypasses cache for live If-Range', async () => {
		const id = 'immutable-' + crypto.randomUUID();
		const name = id + '.png';
		drive.add({ id, name, mimeType: 'image/png', parents: ['root'], size: content.length, content });
		const first = await request('/webdav/' + name);
		const tag1 = first.headers.get('ETag')!;
		await first.arrayBuffer();

		const modifiedTime = drive.findById(id)!.modifiedTime;
		const changed = content.slice();
		changed[0] = 1;
		drive.replaceContent(id, changed, { preserveModifiedTime: true });
		const tag2 = `"${id}-${drive.findById(id)!.headRevisionId}"`;
		expect(tag2).not.toBe(tag1);

		const partialOld = await request('/webdav/' + name, { headers: { Range: 'bytes=1-3' } });
		expect(partialOld.status).toBe(206);
		expect(partialOld.headers.get('ETag')).toBe(tag1);
		expect(new Uint8Array(await partialOld.arrayBuffer())).toEqual(content.slice(1, 4));

		const fullNew = await request('/webdav/' + name, { headers: { Range: 'bytes=1-3', 'If-Range': tag1 } });
		expect(fullNew.status).toBe(200);
		expect(fullNew.headers.get('ETag')).toBe(tag2);
		expect(drive.findById(id)!.modifiedTime).toBe(modifiedTime);
		expect(new Uint8Array(await fullNew.arrayBuffer())).toEqual(changed);
	});

	it.each([403, 404] as const)('falls back to files/{id}?alt=media when revision download returns %s', async status => {
		const id = `fallback-${status}-${crypto.randomUUID()}`;
		const name = id + '.bin';
		drive.add({ id, name, mimeType: 'application/octet-stream', parents: ['root'], size: content.length, content });
		const revId = drive.findById(id)!.headRevisionId!;
		if (status === 404) drive.purgeRevision(id, revId);

		const handle = drive.handle.bind(drive);
		const mediaUrls: string[] = [];
		vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
			const url = String(input);
			if (url.includes('alt=media')) mediaUrls.push(url);
			if (status === 403 && url.includes(`/revisions/${revId}`)) {
				return new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: 'insufficientFilePermissions' }] } }), { status: 403 });
			}
			return handle(input, init);
		});

		const response = await request('/webdav/' + name, { headers: { Range: 'bytes=1-3' } });
		expect(response.status).toBe(206);
		expect(response.headers.get('Content-Range')).toBe('bytes 1-3/12');
		expect(response.headers.get('ETag')).toBe(`"${id}-${revId}"`);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(content.slice(1, 4));
		expect(mediaUrls).toHaveLength(2);
		expect(mediaUrls[0]).toContain(`/drive/v3/files/${id}/revisions/${revId}`);
		expect(mediaUrls[1]).toContain(`/drive/v3/files/${id}?supportsAllDrives=true&alt=media`);
	});

	it('redirects 302 on cannotDownloadAbusiveFile without falling back to files/{id}', async () => {
		const id = 'abusive-' + crypto.randomUUID();
		const name = id + '.bin';
		drive.add({ id, name, mimeType: 'application/octet-stream', parents: ['root'], size: content.length, content });
		const revId = drive.findById(id)!.headRevisionId!;
		const handle = drive.handle.bind(drive);
		const mediaUrls: string[] = [];
		vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
			const url = String(input);
			if (url.includes('alt=media')) {
				mediaUrls.push(url);
				if (new URL(url).searchParams.get('acknowledgeAbuse') !== 'true') {
					return new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: 'cannotDownloadAbusiveFile' }] } }), { status: 403 });
				}
			}
			return handle(input, init);
		});

		const redirectRes = await request('/webdav/' + name, { redirect: 'manual' });
		expect(redirectRes.status).toBe(302);
		expect(redirectRes.headers.get('Location')).toBe(`${ORIGIN}/webdav/${name}?abuse=true`);
		expect(mediaUrls).toHaveLength(1);
		expect(mediaUrls[0]).toContain(`/revisions/${revId}`);

		const acknowledged = await request('/webdav/' + name + '?abuse=true');
		expect(acknowledged.status).toBe(200);
		expect(new Uint8Array(await acknowledged.arrayBuffer())).toEqual(content);
	});

	it.each([
		{ label: 'upstream-500', revStatus: 500, fileStatus: 200, expectedStatus: 500, expectedCalls: 1 },
		{ label: 'purged-and-missing', revStatus: 404, fileStatus: 404, expectedStatus: 404, expectedCalls: 2 },
	])('does not mask %s on revision/file media requests ($label)', async ({ revStatus, fileStatus, expectedStatus, expectedCalls }) => {
		const id = `err-${revStatus}-${crypto.randomUUID()}`;
		const name = id + '.bin';
		drive.add({ id, name, mimeType: 'application/octet-stream', parents: ['root'], size: content.length, content });
		const handle = drive.handle.bind(drive);
		let mediaCalls = 0;
		vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
			const url = String(input);
			if (url.includes('alt=media')) {
				mediaCalls++;
				return new Response('upstream failure', { status: url.includes('/revisions/') ? revStatus : fileStatus });
			}
			return handle(input, init);
		});
		const response = await request('/webdav/' + name, { headers: { Range: 'bytes=1-3', 'If-Range': '"old"' } });
		expect(response.status).toBe(expectedStatus);
		expect(mediaCalls).toBe(expectedCalls);
	});

	it.each(['version-fallback', 'no-validator'] as const)('handles absent headRevisionId (%s)', async mode => {
		const id = `no-rev-${mode}-${crypto.randomUUID()}`;
		const name = id + '.bin';
		drive.add({ id, name, mimeType: 'application/octet-stream', parents: ['root'], size: content.length, content, headRevisionId: null, version: '7' });
		const handle = drive.handle.bind(drive);
		const spy = vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
			const res = await handle(input, init);
			if (mode === 'no-validator' && (init?.method ?? 'GET') === 'GET' && !String(input).includes('alt=media')) {
				const payload = await res.json() as any;
				const strip = (f: any) => { if (f?.id === id) delete f.version; };
				strip(payload);
				payload.files?.forEach(strip);
				return new Response(JSON.stringify(payload), res);
			}
			return res;
		});
		const head = await request('/webdav/' + name, { method: 'HEAD' });
		const get = await request('/webdav/' + name);
		const prop = await (await request('/webdav/' + name, { method: 'PROPFIND', headers: { Depth: '0' } })).text();
		const expectedTag = mode === 'version-fallback' ? `"${id}-7"` : null;
		expect(head.headers.get('ETag')).toBe(expectedTag);
		expect(get.headers.get('ETag')).toBe(expectedTag);
		if (expectedTag) {
			expect(prop).toContain(`<D:getetag>&quot;${id}-7&quot;</D:getetag>`);
		} else {
			expect(prop).not.toContain('getetag');
			const ifRangeRes = await request('/webdav/' + name, { headers: { Range: 'bytes=1-3', 'If-Range': '"any"' } });
			expect(ifRangeRes.status).toBe(200);
			expect(ifRangeRes.headers.get('ETag')).toBeNull();
			expect(new Uint8Array(await ifRangeRes.arrayBuffer())).toEqual(content);
		}
		expect(new Uint8Array(await get.arrayBuffer())).toEqual(content);
		const media = spy.mock.calls.find(([input]) => String(input).includes('alt=media'));
		expect(String(media![0])).toContain(`/drive/v3/files/${id}?supportsAllDrives=true&alt=media`);
		expect(String(media![0])).not.toContain('/revisions/');
	});

	it('supports zero-byte files on GET, HEAD, and unsatisfiable Range', async () => {
		const id = 'empty-' + crypto.randomUUID();
		const name = id + '.txt';
		drive.add({ id, name, mimeType: 'text/plain', parents: ['root'], size: 0, content: new Uint8Array() });
		const expectedEtag = `"${id}-${drive.findById(id)!.headRevisionId}"`;

		const head = await request('/webdav/' + name, { method: 'HEAD' });
		expect(head.status).toBe(200);
		expect(head.headers.get('Content-Length')).toBe('0');
		expect(head.headers.get('ETag')).toBe(expectedEtag);

		const get = await request('/webdav/' + name);
		expect(get.status).toBe(200);
		expect(get.headers.get('Content-Length')).toBe('0');
		expect(get.headers.get('ETag')).toBe(expectedEtag);
		expect(new Uint8Array(await get.arrayBuffer())).toEqual(new Uint8Array());

		const range = await request('/webdav/' + name, { headers: { Range: 'bytes=0-0' } });
		expect(range.status).toBe(416);
		expect(range.headers.get('Content-Range')).toBe('bytes */0');
		expect(range.headers.get('ETag')).toBe(expectedEtag);
	});

	it('evicts stale cache on If-Range when cached file ID was trashed and replaced', async () => {
		const id1 = 'old-' + crypto.randomUUID();
		const id2 = 'new-' + crypto.randomUUID();
		const name = 'replaced-' + crypto.randomUUID() + '.bin';
		drive.add({ id: id1, name, mimeType: 'application/octet-stream', parents: ['root'], size: content.length, content });
		const first = await request('/webdav/' + name);
		const tag1 = first.headers.get('ETag')!;
		await first.arrayBuffer();

		await drive.handle(`https://www.googleapis.com/drive/v3/files/${id1}`, {
			method: 'PATCH',
			headers: { Authorization: 'Bearer test-access-token' },
			body: JSON.stringify({ trashed: true }),
		});
		const replacement = new Uint8Array([9, 8, 7, 6]);
		drive.add({ id: id2, name, mimeType: 'application/octet-stream', parents: ['root'], size: replacement.length, content: replacement });

		const res = await request('/webdav/' + name, { headers: { Range: 'bytes=0-1', 'If-Range': tag1 } });
		expect(res.status).toBe(200);
		expect(res.headers.get('ETag')).toBe(`"${id2}-${drive.findById(id2)!.headRevisionId}"`);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(replacement);
	});

	it('forwards the client Range and preserves the partial original response', async () => {
		const spy = vi.spyOn(drive, 'handle');
		const expectedEtag = `"image-${drive.findById('image')!.headRevisionId}"`;
		const response = await request('/webdav/image.png', { headers: { Range: 'bytes=1-3' } });
		expect(response.status).toBe(206);
		expect(response.headers.get('Content-Type')).toBe('image/png');
		expect(response.headers.get('Content-Length')).toBe('3');
		expect(response.headers.get('Content-Range')).toBe('bytes 1-3/12');
		expect(response.headers.get('ETag')).toBe(expectedEtag);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(content.slice(1, 4));
		const media = spy.mock.calls.find(([input]) => String(input).includes('alt=media'));
		expect(media).toBeDefined();
		expect(String(media![0])).toContain('/drive/v3/files/image/revisions/');
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
		const response = await request('/webdav/', { method: 'PROPFIND', headers: { Depth: '0' } });
		expect(response.status).toBe(207);
		const xml = await response.text();
		expect(xml).toContain('<D:quota-used-bytes>' + storageQuota.usage + '</D:quota-used-bytes>');
		if (available === undefined) expect(xml).not.toContain('<D:quota-available-bytes>');
		else expect(xml).toContain('<D:quota-available-bytes>' + available + '</D:quota-available-bytes>');
	});

	it('lists children with encoded hrefs and numeric sizes (Depth 1)', async () => {
		const res = await request('/webdav/', {
			method: 'PROPFIND',
			headers: { Depth: '1' },
		});
		expect(res.status).toBe(207);
		expect(res.headers.get('Content-Type')).toMatch(/xml/);
		const body = await res.text();

		expect(body).toContain('<D:href>/webdav/</D:href>');
		expect(body).toContain('<D:href>/webdav/docs/</D:href>');
		expect(body).toContain('<D:href>/webdav/a.txt</D:href>');
		expect(body).toContain('<D:href>/webdav/dest.txt</D:href>');
		expect(body).toContain('<D:href>/webdav/x%20%26%20y%20%5B%23%5D.txt</D:href>');
		expect(body).toContain('<D:getcontentlength>123</D:getcontentlength>');
		expect(body).toContain('<D:getcontentlength>100</D:getcontentlength>');
		expect(body).toContain('<D:displayname>x &amp; y [#].txt</D:displayname>');
		expect(body).toContain('<D:resourcetype><D:collection/></D:resourcetype>');
	});

	it('lists nested folder children (Depth 1)', async () => {
		const res = await request('/webdav/docs/', {
			method: 'PROPFIND',
			headers: { Depth: '1' },
		});
		const body = await res.text();
		expect(body).toContain('<D:href>/webdav/docs/sub%26dir/</D:href>');
		expect(body).toContain('<D:href>/webdav/docs/b%20%26%20c.txt</D:href>');
		expect(body).toContain('<D:getcontentlength>999</D:getcontentlength>');
	});

	it('only returns the requested resource at Depth 0 (and quota on root)', async () => {
		const res = await request('/webdav/', {
			method: 'PROPFIND',
			headers: { Depth: '0' },
		});
		const body = await res.text();
		expect(body).toContain('<D:href>/webdav/</D:href>');
		expect(body).not.toContain('/webdav/docs/');
		expect(body).not.toContain('getcontentlength');
		expect(body).toContain('<D:quota-used-bytes>4096</D:quota-used-bytes>');
		expect(body).toContain('<D:quota-available-bytes>1073737728</D:quota-available-bytes>');
	});

	it('resolves a hostile file name through its encoded path', async () => {
		const res = await request('/webdav/x%20%26%20y%20%5B%23%5D.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0' },
		});
		expect(res.status).toBe(207);
		const body = await res.text();
		expect(body).toContain('<D:href>/webdav/x%20%26%20y%20%5B%23%5D.txt</D:href>');
		expect(body).toContain('<D:getcontentlength>100</D:getcontentlength>');
	});
});

describe('HEAD and collection GET', () => {
	it('HEAD reports the file size and unified ETag without emitting ETag on collections', async () => {
		const res = await request('/webdav/a.txt', { method: 'HEAD' });
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Length')).toBe('123');
		expect(res.headers.get('Content-Type')).toBe('text/plain');
		expect(res.headers.get('ETag')).toBe(`"file-a-${drive.findById('file-a')!.headRevisionId}"`);

		const folderHead = await request('/webdav/docs/', { method: 'HEAD' });
		expect(folderHead.status).toBe(200);
		expect(folderHead.headers.get('ETag')).toBeNull();
	});

	it.each(['/webdav/', '/webdav/docs', '/webdav/docs/'])('rejects GET on collection %s with 405 without listing children', async path => {
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

describe('isolate cache lifetime and read consistency', () => {
	it.each(['folder-meta', 'file-meta', 'objects'] as const)('expires %s entries without extending their lifetime on hits', async kind => {
		const name = 'memory-ttl-' + kind;
		const isFolder = kind !== 'file-meta';
		drive.add({ id: name, name, mimeType: isFolder ? FOLDER : 'text/plain', size: 123, description: 'initial', parents: ['root'] });
		const start = Date.now();
		let now = start;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		const read = async () => {
			const response = await request('/webdav/' + name, {
				method: 'PROPFIND',
				headers: { Depth: kind === 'objects' ? '1' : '0' },
			});
			expect(response.status).toBe(207);
			return response.text();
		};
		const original = await read();
		if (kind === 'folder-meta') drive.findById(name)!.description = 'updated-folder';
		else if (kind === 'file-meta') drive.findById(name)!.size = 456;
		else drive.add({ id: name + '-new', name: 'new-child.txt', mimeType: 'text/plain', parents: [name] });
		now = start + (kind === 'folder-meta' ? 300000 : 30000) - 1;
		expect(await read()).toBe(original);
		now++;
		const fresh = await read();
		if (kind === 'folder-meta') expect(fresh).toContain('updated-folder');
		else if (kind === 'file-meta') expect(fresh).toContain('<D:getcontentlength>456</D:getcontentlength>');
		else expect(fresh).toContain('new-child.txt');
	});

	it('bypasses leaf cache for HEAD and whole-file GET while serving short-cached PROPFIND and plain Range GET', async () => {
		const subId = 'cache-sub-' + crypto.randomUUID();
		const fileId = 'cache-file-' + crypto.randomUUID();
		drive.add({ id: subId, name: subId, mimeType: FOLDER, parents: ['root'] });
		const v1 = new TextEncoder().encode('version-one!');
		drive.add({ id: fileId, name: 'doc.bin', mimeType: 'application/octet-stream', size: v1.length, content: v1, parents: [subId] });
		const tag1 = `"${fileId}-${drive.findById(fileId)!.headRevisionId}"`;
		const path = `/webdav/${subId}/doc.bin`;

		expect((await request(path, { method: 'PROPFIND', headers: { Depth: '0' } })).status).toBe(207);

		const v2 = new TextEncoder().encode('version-two!');
		drive.replaceContent(fileId, v2, { preserveModifiedTime: true });
		const tag2 = `"${fileId}-${drive.findById(fileId)!.headRevisionId}"`;

		const spy = vi.spyOn(drive, 'handle');
		const listCalls = () => spy.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/drive/v3/files').length;

		// PROPFIND and plain Range GET use the 30s file leaf cache (0 metadata calls).
		const prop1 = await request(path, { method: 'PROPFIND', headers: { Depth: '0' } });
		expect(await prop1.text()).toContain(tag1.replaceAll('"', '&quot;'));
		expect(listCalls()).toBe(0);

		const plainRange = await request(path, { headers: { Range: 'bytes=0-6' } });
		expect(plainRange.status).toBe(206);
		expect(plainRange.headers.get('ETag')).toBe(tag1);
		expect(new Uint8Array(await plainRange.arrayBuffer())).toEqual(v1.slice(0, 7));
		expect(listCalls()).toBe(0);

		// HEAD bypasses the leaf cache while reusing the cached parent folder (1 files.list call).
		const head = await request(path, { method: 'HEAD' });
		expect(head.status).toBe(200);
		expect(head.headers.get('ETag')).toBe(tag2);
		expect(listCalls()).toBe(1);

		// Whole-file GET bypasses the leaf cache (1 files.list call) and refreshes the cache.
		const v3 = new TextEncoder().encode('version-tri!');
		drive.replaceContent(fileId, v3, { preserveModifiedTime: true });
		const tag3 = `"${fileId}-${drive.findById(fileId)!.headRevisionId}"`;
		spy.mockClear();
		const fullGet = await request(path);
		expect(fullGet.status).toBe(200);
		expect(fullGet.headers.get('ETag')).toBe(tag3);
		expect(new Uint8Array(await fullGet.arrayBuffer())).toEqual(v3);
		expect(listCalls()).toBe(1);

		const propRefreshed = await request(path, { method: 'PROPFIND', headers: { Depth: '0' } });
		expect(await propRefreshed.text()).toContain(tag3.replaceAll('"', '&quot;'));
		expect(listCalls()).toBe(1);

		// Trashing externally is immediately seen by HEAD and evicts the stale cache entry.
		await drive.handle(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
			method: 'PATCH',
			headers: { Authorization: 'Bearer test-access-token' },
			body: JSON.stringify({ trashed: true }),
		});
		expect((await request(path, { method: 'HEAD' })).status).toBe(404);
		expect((await request(path, { method: 'PROPFIND', headers: { Depth: '0' } })).status).toBe(404);
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
		const res = await request('/webdav/' + dir + '/', { method: 'PROPFIND', headers: { Depth: '1' } });
		expect(res.status).toBe(207);
		const xml = await res.text();
		for (const [, , name] of workspaceTypes) expect(xml).not.toContain(name);
		expect(xml).toContain('/webdav/' + dir + '/Real%20Folder/');
		expect(xml).toContain('/webdav/' + dir + '/Spec.docx');
		expect(xml).toContain('/webdav/' + dir + '/readme.txt');
		expect(spy.mock.calls.filter(([input]) => String(input).includes('orderBy=')).length).toBeGreaterThan(1);
	});

	// MIME variants are covered by the multi-page listing above. Exercise the
	// shared path-resolution boundary once across methods.
	it('hides native items across read, metadata, copy/move source, delete, and traversal', async () => {
		const [, mimeType, name] = workspaceTypes[0];
		const dir = 'ws-hide-' + crypto.randomUUID();
		const itemId = dir + '-item';
		drive.add({ id: dir, name: dir, mimeType: FOLDER, parents: ['root'] });
		drive.add({ id: itemId, name, mimeType, parents: [dir] });
		drive.add({ id: dir + '-child', name: 'hidden-child.txt', mimeType: 'text/plain', size: 3, parents: [itemId] });
		const path = '/webdav/' + dir + '/' + encodeURIComponent(name);

		const spy = vi.spyOn(drive, 'handle');
		for (const init of [
			{ method: 'GET' },
			{ method: 'HEAD' },
			{ method: 'PROPFIND', headers: { Depth: '0' } },
			{ method: 'PROPFIND', headers: { Depth: '1' } },
			{ method: 'PROPPATCH', body: '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><X:k>v</X:k></D:prop></D:set></D:propertyupdate>' },
			{ method: 'DELETE' },
			{ method: 'MOVE', headers: { Destination: ORIGIN + '/webdav/' + dir + '/moved' } },
			{ method: 'COPY', headers: { Destination: ORIGIN + '/webdav/' + dir + '/copied' } },
		] as RequestInit[]) {
			expect((await request(path, init)).status, init.method).toBe(404);
		}
		expect((await request(path + '/hidden-child.txt')).status).toBe(404);
		expect(drive.findById(itemId)?.trashed).not.toBe(true);
		const calls = spy.mock.calls.map(([input, init]) => ({
			url: input instanceof Request ? input.url : String(input),
			method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
		})).filter(call => !new URL(call.url).pathname.startsWith('/oauth2/'));
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
		const listing = await request('/webdav/' + dir + '/', { method: 'PROPFIND', headers: { Depth: '1' } });
		expect(listing.status).toBe(207);
		const listingXml = await listing.text();
		expect(listingXml).not.toContain('application/vnd.google-apps.document');
		expect(listingXml).not.toContain('application/vnd.google-apps.shortcut');
		expect(listingXml).toContain('<D:getcontenttype>application/pdf</D:getcontenttype>');
		expect(listingXml).toContain('/webdav/' + dir + '/Shared/');

		const download = await request('/webdav/' + dir + '/Report');
		expect(download.status).toBe(200);
		expect(download.headers.get('Content-Type')).toBe('application/pdf');
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(pdf);

		const sub = await request('/webdav/' + dir + '/Shared/', { method: 'PROPFIND', headers: { Depth: '1' } });
		expect(sub.status).toBe(207);
		expect(await sub.text()).toContain('/webdav/' + dir + '/Shared/inside.txt');

		const callsBeforeNonFolder = spy.mock.calls.length;
		expect((await request('/webdav/' + dir + '/Report/child.txt')).status).toBe(404);
		expect(spy.mock.calls.length).toBe(callsBeforeNonFolder);
	});
});
