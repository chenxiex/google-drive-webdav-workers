import { describe, expect, it } from 'vitest';
import { FOLDER, MockDrive } from './helpers';

const API = 'https://www.googleapis.com';
const FILES = '/drive/v3/files';
const UPLOADS = '/upload/drive/v3/files';
const bytes = new Uint8Array([0, 255, 13, 10, 65]);
const api = (drive: MockDrive, path: string, init: RequestInit = {}) => drive.handle(API + path, {
	...init, headers: { Authorization: 'Bearer test-access-token', ...init.headers },
});
const metadata = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function fixture(): MockDrive {
	const drive = new MockDrive();
	drive.add({ id: 'a', name: 'a', mimeType: FOLDER, parents: ['root'] });
	drive.add({ id: 'b', name: 'b', mimeType: FOLDER, parents: ['root'] });
	drive.add({ id: 'source', name: 'source.bin', mimeType: 'application/octet-stream', parents: ['a'], size: bytes.length, content: bytes.slice() });
	return drive;
}
const listed = (drive: MockDrive, q: string, rest = '') => api(drive, FILES + '?q=' + encodeURIComponent(q) + rest);

// Expected observations were checked against live Drive v3 on 2026-11-13.
// Test each upstream contract here rather than repeating it in WebDAV tests.
describe('Google response contracts', () => {
	it('encodes quota as decimal strings and requires an about field mask', async () => {
		const drive = fixture();
		expect((await api(drive, '/drive/v3/about')).status).toBe(400);
		const response = await api(drive, '/drive/v3/about?fields=storageQuota(limit,usage)');
		expect(await response.json()).toEqual({ storageQuota: { limit: '1073741824', usage: '4096' } });
	});

	it('uses OAuth form parameters and a bearer-token response', async () => {
		const drive = fixture();
		const response = await api(drive, '/oauth2/v4/token', {
			method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ client_id: 'test-client-id', client_secret: 'test-client-secret', refresh_token: 'test-refresh-token-history', grant_type: 'refresh_token' }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ access_token: 'test-access-token', token_type: 'Bearer', expires_in: expect.any(Number) });
	});
	it.each([
		['client_id', '', 'invalid_request'],
		['client_secret', '', 'invalid_request'],
		['refresh_token', '', 'invalid_request'],
		['refresh_token', 'invalid', 'invalid_grant'],
		['grant_type', 'invalid', 'unsupported_grant_type'],
	])('rejects OAuth %s=%s', async (key, value, error) => {
		const form = { client_id: 'test-client-id', client_secret: 'test-client-secret', refresh_token: 'test-refresh-token-history', grant_type: 'refresh_token', [key]: value };
		const response = await api(fixture(), '/oauth2/v4/token', { method: 'POST', body: new URLSearchParams(form) });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error });
	});

	it.each([
		[undefined, 403, 'forbidden'],
		['Bearer invalid', 401, 'authError'],
	] as const)('rejects missing or invalid API authorization (%s)', async (authorization, status, reason) => {
		const response = await fixture().handle(API + FILES, { headers: authorization ? { Authorization: authorization } : {} });
		expect(response.status).toBe(status);
		expect(await response.json()).toMatchObject({ error: { errors: [expect.objectContaining({ reason })] } });
	});

	it.each([
		['PATCH', FILES + '/missing'],
		['DELETE', FILES + '/missing'],
		['POST', FILES + '/missing/copy'],
		['PATCH', UPLOADS + '/missing?uploadType=media'],
		['PATCH', UPLOADS + '/missing?uploadType=resumable'],
	])('returns structured 404 for %s %s', async (method, path) => {
		const response = await api(fixture(), path, method === 'DELETE' ? { method } : metadata({}, method));
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: { code: 404, errors: [{ domain: 'global', reason: 'notFound', location: 'fileId' }] } });
	});
});

describe('files.list', () => {
	it.each([
		["'a' in parents and name = 'quote\\\'\\\\.txt'", ['quoted']],
		["trashed = false AND 'a' in parents AND name != '.password'", ['source', 'quoted']],
		["'a' in parents and trashed = true", ['trash']],
		["'a' in parents", ['source', 'quoted', 'password', 'trash']],
	])('evaluates %s', async (q, ids) => {
		const drive = fixture();
		for (const [id, name, trashed] of [['quoted', "quote'\\.txt", false], ['password', '.password', false], ['trash', 'trash', true]] as const) {
			drive.add({ id, name, trashed, mimeType: 'text/plain', parents: ['a'] });
		}
		const response = await listed(drive, q, '&fields=files(id)');
		expect(await response.json()).toEqual({ files: ids.map(id => ({ id })) });
	});

	it('honors default masks, explicit masks, ordering, page size and continuation tokens', async () => {
		const drive = fixture();
		const defaults: any = await (await listed(drive, "'a' in parents")).json();
		expect(defaults).toEqual({ kind: 'drive#fileList', incompleteSearch: false, files: [{ kind: 'drive#file', id: 'source', name: 'source.bin', mimeType: 'application/octet-stream' }] });
		const query = "'root' in parents";
		const options = '&orderBy=name%20desc&pageSize=1&fields=files(id),nextPageToken';
		const first: any = await (await listed(drive, query, options)).json();
		expect(first.files).toEqual([{ id: 'b' }]);
		expect(first.nextPageToken).toEqual(expect.any(String));
		const second = await listed(drive, query, options + '&pageToken=' + first.nextPageToken);
		expect(await second.json()).toEqual({ files: [{ id: 'a' }] });
		const selected = await listed(drive, "'a' in parents", '&fields=files(id,size,parents)');
		expect(await selected.json()).toEqual({ files: [{ id: 'source', size: '5', parents: ['a'] }] });
	});

	it.each(['fields=notARealField', 'pageToken=invalid', 'q=name%20%3D%3D%3D%20%27bad%27'])('rejects invalid %s', async query => {
		expect((await api(fixture(), FILES + '?' + query)).status).toBe(400);
	});

	it('fails loudly for unimplemented queries rather than returning a false success', async () => {
		await expect(listed(fixture(), "fullText contains 'word'")).rejects.toThrow('MockDrive does not implement');
	});
});

describe('metadata mutations', () => {
	it.each([
		[{ name: 'zero.txt', parents: ['b'], mimeType: 'text/plain' }, 'zero.txt', 'text/plain', ['b'], '0'],
		[{ name: 'new-folder', parents: ['a'], mimeType: FOLDER }, 'new-folder', FOLDER, ['a'], undefined],
	])('creates %j with response identity and correct file types', async (meta, name, mimeType, parents, size) => {
		const drive = fixture();
		const response = await api(drive, FILES + '?fields=id,name,mimeType,parents,size', metadata(meta));
		expect(response.status).toBe(200);
		const result: any = await response.json();
		expect(result).toEqual({ id: expect.any(String), name, mimeType, parents, ...(size ? { size } : {}) });
		expect(drive.findById(result.id)?.name).toBe(name);
	});

	it('renames and moves the same identity, and rejects directly replacing parents', async () => {
		const drive = fixture();
		const moved = await api(drive, FILES + '/source?addParents=b&fields=id,name,parents', metadata({ name: 'renamed.bin' }, 'PATCH'));
		expect(await moved.json()).toEqual({ id: 'source', name: 'renamed.bin', parents: ['b'] });
		expect((await api(drive, FILES + '/source', metadata({ parents: ['a'] }, 'PATCH'))).status).toBe(403);
		expect(drive.findById('source')?.parents).toEqual(['b']);
		await api(drive, FILES + '/source?removeParents=b&addParents=a', metadata({ name: '' }, 'PATCH'));
		expect(drive.findById('source')).toMatchObject({ name: 'renamed.bin', parents: ['a'] });
	});

	it('copies bytes, size and independent parent state, but refuses folder copy', async () => {
		const drive = fixture();
		const response = await api(drive, FILES + '/source/copy?fields=id,name,size,parents', metadata({ name: 'copy.bin' }));
		const copy: any = await response.json();
		expect(copy).toEqual({ id: expect.any(String), name: 'copy.bin', size: '5', parents: ['a'] });
		expect(drive.findById(copy.id)?.content).toEqual(bytes);
		await api(drive, FILES + '/' + copy.id + '?addParents=b', metadata({}, 'PATCH'));
		expect(drive.findById('source')?.parents).toEqual(['a']);
		expect((await api(drive, FILES + '/a/copy', metadata({}))).status).toBe(403);
	});

	it.each([
		['POST', '', 'created'],
		['POST', '/source/copy', 'copied'],
		['PATCH', '/source', 'renamed'],
	])('retains the live API metadata-write side effect despite invalid fields (%s %s)', async (method, suffix, name) => {
		const drive = fixture();
		const response = await api(drive, FILES + suffix + '?fields=notARealField', metadata({ name }, method));
		expect(response.status).toBe(400);
		expect(drive.files.some(f => f.name === name)).toBe(true);
	});

	it.each([
		[['missing'], 404],
		[['a', 'b'], 403],
		[['source'], 403],
	])('validates parent %j', async (parents, status) => {
		const drive = fixture();
		expect((await api(drive, FILES, metadata({ name: 'child', parents }))).status).toBe(status);
		expect(drive.files).toHaveLength(3);
	});

	it('permanently deletes a folder and its descendants, with an empty 204 body', async () => {
		const drive = fixture();
		const response = await api(drive, FILES + '/a', { method: 'DELETE' });
		expect(response.status).toBe(204);
		expect(await response.text()).toBe('');
		expect(drive.files.map(f => f.id)).toEqual(['b']);
	});
});

describe('media and multipart uploads', () => {
	it('rejects an invalid media field mask before mutation, unlike metadata-only writes', async () => {
		const drive = fixture();
		const response = await api(drive, UPLOADS + '/source?uploadType=media&fields=notARealField', { method: 'PATCH', body: 'replacement' });
		expect(response.status).toBe(400);
		expect(drive.findById('source')?.content).toEqual(bytes);
	});
	it.each([bytes, new Uint8Array()])('overwrites and truncates the existing file with %j', async content => {
		const drive = fixture();
		const response = await api(drive, UPLOADS + '/source?uploadType=media&fields=id,size', {
			method: 'PATCH', headers: { 'Content-Type': 'text/plain' }, body: content,
		});
		expect(await response.json()).toEqual({ id: 'source', size: String(content.length) });
		expect(drive.findById('source')?.content).toEqual(content);
		expect(drive.findById('source')?.mimeType).toBe('application/octet-stream');
	});

	it('parses the declared multipart boundary and preserves nested parents and binary bytes', async () => {
		const drive = fixture();
		const boundary = 'not-the-workers-hardcoded-boundary';
		const meta = JSON.stringify({ name: '中文.bin', parents: ['b'] });
		const pre = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
		const post = new TextEncoder().encode(`\r\n--${boundary}--`);
		const wire = new Uint8Array(pre.length + bytes.length + post.length);
		wire.set(pre); wire.set(bytes, pre.length); wire.set(post, pre.length + bytes.length);
		const response = await api(drive, UPLOADS + '?uploadType=multipart&fields=id,name,parents,size', {
			method: 'POST', headers: { 'Content-Type': `multipart/related; boundary="${boundary}"` }, body: wire,
		});
		const file: any = await response.json();
		expect(file).toEqual({ id: expect.any(String), name: '中文.bin', parents: ['b'], size: '5' });
		expect(drive.findById(file.id)?.content).toEqual(bytes);
	});
});

describe('resumable uploads', () => {
	it.each([
		['bytes 0-3/6', 'abcd'],
		['bytes 0-2/3', 'abc'],
		[undefined, 'abc'],
	])('rejects incomplete or conflicting upload size (%s) and keeps the failed session failed', async (range, body) => {
		const drive = fixture();
		const init = await api(drive, UPLOADS + '/source?uploadType=resumable', {
			...metadata({}, 'PATCH'), headers: { 'X-Upload-Content-Length': '6', 'Content-Type': 'application/json' },
		});
		const location = init.headers.get('Location')!;
		const response = await drive.handle(location, { method: 'PUT', headers: range ? { 'Content-Range': range } : {}, body });
		expect(response.status).toBe(400);
		expect(drive.findById('source')?.content).toEqual(bytes);
		const retry = await drive.handle(location, { method: 'PUT', headers: { 'Content-Range': 'bytes */6' }, body: '' });
		expect(retry.status).toBe(400);
	});
	it.each([false, true])('tracks status, chunks and final commit (overwrite=%s)', async overwrite => {
		const drive = fixture();
		const endpoint = UPLOADS + (overwrite ? '/source' : '') + '?uploadType=resumable&fields=id,name,size';
		const init = await api(drive, endpoint, {
			...metadata(overwrite ? {} : { name: 'upload.bin', parents: ['b'] }, overwrite ? 'PATCH' : 'POST'),
			headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': '262149' },
		});
		expect(init.status).toBe(200);
		expect(await init.text()).toBe('');
		expect(drive.files).toHaveLength(3);
		const location = init.headers.get('Location')!;
		const put = (range: string, body: BodyInit = '') => drive.handle(location, { method: 'PUT', headers: { 'Content-Range': range }, body });
		const empty = await put('bytes */262149');
		expect(empty.status).toBe(308); expect(empty.headers.get('Range')).toBeNull();
		const first = await put('bytes 0-262143/262149', new Uint8Array(262144).fill(65));
		expect(first.status).toBe(308); expect(first.headers.get('Range')).toBe('bytes=0-262143');
		const status = await put('bytes */262149');
		expect(status.status).toBe(308); expect(status.headers.get('Range')).toBe('bytes=0-262143');
		const finished = await put('bytes 262144-262148/262149', bytes);
		expect(finished.status).toBe(200);
		const file: any = await finished.json();
		expect(file).toEqual({ id: overwrite ? 'source' : expect.any(String), name: overwrite ? 'source.bin' : 'upload.bin', size: '262149' });
		expect(drive.findById(file.id)?.content?.slice(-5)).toEqual(bytes);
		expect(drive.findById(file.id)?.parents).toEqual([overwrite ? 'a' : 'b']);
		expect(drive.files).toHaveLength(overwrite ? 3 : 4);
		expect((await put('bytes */262149')).status).toBe(200);
	});

	it('issues distinct session URLs and rejects unknown sessions', async () => {
		const drive = fixture();
		const start = () => api(drive, UPLOADS + '?uploadType=resumable', metadata({ name: 'new' }));
		const [first, second] = await Promise.all([start(), start()]);
		expect(first.headers.get('Location')).not.toBe(second.headers.get('Location'));
		expect((await api(drive, UPLOADS + '?uploadType=resumable&upload_id=missing', { method: 'PUT' })).status).toBe(404);
	});
});

// Real My Drive audit on 2026-11-15. Descendant trash flags are settled-state
// contracts: the live API returned stale flags immediately after folder updates.
describe('trash/restore and transfer contracts', () => {
	it.each(['source', 'a'])('trash/restore %s returns the same ID and is repeatable', async id => {
		const drive = fixture();
		const before = structuredClone(drive.findById(id)!);
		for (const trashed of [true, true, false, false]) {
			const response = await api(drive, FILES + '/' + id + '?fields=id', metadata({ trashed }, 'PATCH'));
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ id });
			expect(drive.findById(id)).toMatchObject({ name: before.name, parents: before.parents, modifiedTime: before.modifiedTime, trashed, explicitlyTrashed: trashed });
		}
		expect(drive.findById('source')?.content).toEqual(bytes);
	});

	it('trashes a nested tree and restores even independently trashed descendants', async () => {
		const drive = fixture();
		drive.add({ id: 'sub', name: 'sub', mimeType: FOLDER, parents: ['a'] });
		drive.findById('source')!.parents = ['sub'];
		drive.add({ id: 'independent', name: 'independent', mimeType: 'text/plain', parents: ['sub'], trashed: true });
		await api(drive, FILES + '/a?fields=id', metadata({ trashed: true }, 'PATCH'));
		for (const id of ['a', 'sub', 'source', 'independent']) expect(drive.findById(id)?.trashed).toBe(true);
		expect(drive.findById('sub')?.explicitlyTrashed).toBe(false);
		expect(drive.findById('source')?.explicitlyTrashed).toBe(false);
		expect(await (await listed(drive, "'sub' in parents and trashed = false", '&fields=files(id)')).json()).toEqual({ files: [] });
		expect(await (await listed(drive, "'sub' in parents and trashed = true", '&fields=files(id,explicitlyTrashed)')).json()).toEqual({ files: [
			{ id: 'source', explicitlyTrashed: false }, { id: 'independent', explicitlyTrashed: true },
		] });
		await api(drive, FILES + '/a?fields=id', metadata({ trashed: false }, 'PATCH'));
		for (const id of ['a', 'sub', 'source']) expect(drive.findById(id)?.trashed).toBe(false);
		expect(drive.findById('independent')).toMatchObject({ trashed: false, explicitlyTrashed: false });
		expect(drive.findById('source')).toMatchObject({ parents: ['sub'], content: bytes, size: bytes.length });
	});

	it('fails loudly for unmodeled mutations under or across Trash', async () => {
		const drive = fixture();
		await api(drive, FILES + '/a?fields=id', metadata({ trashed: true }, 'PATCH'));
		await expect(api(drive, FILES + '/source?addParents=b&removeParents=a', metadata({}, 'PATCH'))).rejects.toThrow('moving from or into Trash');
		await expect(api(drive, FILES + '/source', metadata({ trashed: false }, 'PATCH'))).rejects.toThrow('changing trash state under a trashed ancestor');
		expect(drive.findById('source')).toMatchObject({ parents: ['a'], trashed: true });
	});

	it('moves a folder across parents while keeping descendant identities and bytes', async () => {
		const drive = fixture();
		const response = await api(drive, FILES + '/a?addParents=b&removeParents=root&fields=id,name,parents', metadata({ name: 'moved' }, 'PATCH'));
		expect(await response.json()).toEqual({ id: 'a', name: 'moved', parents: ['b'] });
		expect(drive.findById('source')).toMatchObject({ parents: ['a'], content: bytes });
		expect(drive.findById('a')?.modifiedTime).not.toBe('2024-01-01T00:00:00.000Z');
	});

	it('stages a named copy in a different parent and publishes without changing bytes or source', async () => {
		const drive = fixture();
		const copy: any = await (await api(drive, FILES + '/source/copy?fields=id', metadata({ name: '.webdav-copy-test', parents: ['b'] }))).json();
		expect(copy.id).not.toBe('source');
		expect(drive.findById(copy.id)).toMatchObject({ name: '.webdav-copy-test', parents: ['b'], content: bytes, size: bytes.length });
		expect(await (await api(drive, FILES + '/' + copy.id + '?fields=id', metadata({ name: 'published.bin' }, 'PATCH'))).json()).toEqual({ id: copy.id });
		expect(drive.findById(copy.id)).toMatchObject({ name: 'published.bin', parents: ['b'], content: bytes });
		expect(drive.findById('source')).toMatchObject({ name: 'source.bin', parents: ['a'], content: bytes });
	});
});
