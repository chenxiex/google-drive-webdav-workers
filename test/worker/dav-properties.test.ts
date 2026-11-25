import { SELF } from 'cloudflare:test';
import { DOMParser } from '@xmldom/xmldom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH, FOLDER, ORIGIN, installDriveMock } from '../support/client';
import { MockDrive } from '../support/mock-drive';

const DAV = 'DAV:';
let drive: MockDrive;
const request = (path: string, init: RequestInit = {}) => SELF.fetch(ORIGIN + path, { ...init, headers: { ...AUTH, ...(init.headers as Record<string, string>) } });
const patch = (operations: string, path = '/dav/a.txt') => request(path, { method: 'PROPPATCH', body: `<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test" xmlns:G="urn:google:drive">${operations}</D:propertyupdate>` });
const set = (properties: string) => `<D:set><D:prop>${properties}</D:prop></D:set>`;
const remove = (properties: string) => `<D:remove><D:prop>${properties}</D:prop></D:remove>`;
const find = (properties?: string, path = '/dav/a.txt') => request(path, { method: 'PROPFIND', headers: { Depth: '0' }, ...(properties !== undefined ? { body: `<D:propfind xmlns:D="DAV:" xmlns:X="urn:test" xmlns:G="urn:google:drive"><D:prop>${properties}</D:prop></D:propfind>` } : {}) });
const xml = (text: string) => new DOMParser().parseFromString(text, 'application/xml');
const value = (text: string, namespace: string, name: string) => xml(text).getElementsByTagNameNS(namespace, name)[0]?.textContent;
function propStatus(text: string, namespace: string, name: string): string | null | undefined {
    const node = xml(text).getElementsByTagNameNS(namespace, name)[0];
    return node?.parentNode?.parentNode?.childNodes && Array.from(node.parentNode.parentNode.childNodes).find(n => n.nodeType === 1 && n.localName === 'status')?.textContent;
}
const source = () => drive.findById('file-a')!;
const mutationCalls = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.filter(([input, init]: any[]) => (init?.method || (input instanceof Request ? input.method : 'GET')) === 'PATCH');

beforeEach(() => {
    drive = new MockDrive();
    drive.add({ id: 'file-a', name: 'a.txt', mimeType: 'text/plain', size: 3, content: new TextEncoder().encode('abc'), parents: ['root'] });
    drive.add({ id: 'folder-docs', name: 'docs', mimeType: FOLDER, parents: ['root'] });
    installDriveMock(drive);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('persisted WebDAV properties', () => {
    it('persists a dead property and distinguishes empty from absent', async () => {
        const response = await patch(set('<X:label>hello</X:label><X:empty/>'));
        expect(response.status).toBe(207);
        expect(propStatus(await response.text(), 'urn:test', 'label')).toBe('HTTP/1.1 200 OK');
        let body = await (await find('<X:label/><X:empty/><X:missing/>')).text();
        expect(value(body, 'urn:test', 'label')).toBe('hello');
        expect(propStatus(body, 'urn:test', 'empty')).toBe('HTTP/1.1 200 OK');
        expect(propStatus(body, 'urn:test', 'missing')).toBe('HTTP/1.1 404 Not Found');
        expect((await patch(remove('<X:label/><X:missing/>'))).status).toBe(207);
        body = await (await find('<X:label/><X:empty/>')).text();
        expect(propStatus(body, 'urn:test', 'label')).toBe('HTTP/1.1 404 Not Found');
        expect(propStatus(body, 'urn:test', 'empty')).toBe('HTTP/1.1 200 OK');
    });

    it('returns dead properties in allprop, propname, allprop/include and deduplicates by expanded name', async () => {
        await patch(set('<X:label>secret-value</X:label>'));
        expect(value(await (await find()).text(), 'urn:test', 'label')).toBe('secret-value');
        const names = await request('/dav/a.txt', { method: 'PROPFIND', headers: { Depth: '0' }, body: '<propfind xmlns="DAV:"><propname/></propfind>' });
        const namesBody = await names.text();
        expect(value(namesBody, 'urn:test', 'label')).toBe('');
        expect(namesBody).not.toContain('secret-value');

        const explicit = xml(await (await find('<X:label/><Y:label xmlns:Y="urn:test"/><X:missing/><X:missing/>')).text());
        expect(explicit.getElementsByTagNameNS('urn:test', 'label').length).toBe(1);
        expect(explicit.getElementsByTagNameNS('urn:test', 'missing').length).toBe(1);

        const included = await request('/dav/a.txt', { method: 'PROPFIND', headers: { Depth: '0' }, body: '<D:propfind xmlns:D="DAV:" xmlns:X="urn:test" xmlns:Y="urn:test"><D:allprop/><D:include><X:label/><Y:label/><X:missing/><Y:missing/></D:include></D:propfind>' });
        const includeDocument = xml(await included.text());
        expect(includeDocument.getElementsByTagNameNS('urn:test', 'label').length).toBe(1);
        expect(includeDocument.getElementsByTagNameNS('urn:test', 'missing').length).toBe(1);
        expect(value(await (await request('/dav/a.txt', { method: 'PROPFIND', headers: { Depth: '0' }, body: '<D:propfind xmlns:D="DAV:" xmlns:X="urn:test"><D:allprop/><D:include><X:missing/></D:include></D:propfind>' })).text(), 'urn:test', 'label')).toBe('secret-value');
    });

    it('manages displayname without renaming and preserves absence tombstone across COPY', async () => {
        await patch(set('<D:displayname>Friendly title</D:displayname>'));
        expect(source().name).toBe('a.txt');
        expect(value(await (await find()).text(), DAV, 'displayname')).toBe('Friendly title');
        expect((await find(undefined, '/dav/Friendly%20title')).status).toBe(404);

        await patch(remove('<D:displayname/>'));
        expect(propStatus(await (await find('<D:displayname/>')).text(), DAV, 'displayname')).toBe('HTTP/1.1 404 Not Found');
        expect(xml(await (await find()).text()).getElementsByTagNameNS(DAV, 'displayname').length).toBe(0);
        const names = await request('/dav/a.txt', { method: 'PROPFIND', headers: { Depth: '0' }, body: '<propfind xmlns="DAV:"><propname/></propfind>' });
        expect(xml(await names.text()).getElementsByTagNameNS(DAV, 'displayname').length).toBe(0);

        const destination = '/dav/displayname-absent-copy.txt';
        expect((await request('/dav/a.txt', { method: 'COPY', headers: { Destination: ORIGIN + destination } })).status).toBe(201);
        expect(propStatus(await (await find('<D:displayname/>', destination)).text(), DAV, 'displayname')).toBe('HTTP/1.1 404 Not Found');
        expect(xml(await (await find(undefined, destination)).text()).getElementsByTagNameNS(DAV, 'displayname').length).toBe(0);

        await patch(set('<D:displayname>Restored title</D:displayname>'));
        expect(value(await (await find()).text(), DAV, 'displayname')).toBe('Restored title');
    });

    it('submits native and dead changes in a single metadata PATCH and clears optional fields', async () => {
        const spy = vi.spyOn(drive, 'handle');
        const response = await patch(set('<G:description>new description</G:description><G:starred>true</G:starred><D:getlastmodified>Wed, 01 Jan 2020 00:00:00 GMT</D:getlastmodified><X:label>new</X:label>'));
        expect(response.status).toBe(207);
        expect(await response.text()).not.toContain('424');
        expect(mutationCalls(spy)).toHaveLength(1);
        expect(source().description).toBe('new description');
        expect(source().starred).toBe(true);
        expect(source().modifiedTime).toBe('2020-01-01T00:00:00.000Z');
        expect(value(await (await find()).text(), 'urn:test', 'label')).toBe('new');

        await patch(set('<G:description/><G:starred>false</G:starred><G:modifiedTime>2021-02-03T04:05:06Z</G:modifiedTime>'));
        expect(source().description).toBe('');
        expect(source().starred).toBe(false);
        expect(source().modifiedTime).toBe('2021-02-03T04:05:06.000Z');
        const cleared = await (await find('<G:description/><G:starred/>')).text();
        expect(propStatus(cleared, 'urn:google:drive', 'description')).toBe('HTTP/1.1 200 OK');
        expect(value(cleared, 'urn:google:drive', 'description')).toBe('');
        expect(value(cleared, 'urn:google:drive', 'starred')).toBe('false');
    });

    it('updates folder color, rclone DAV:lastmodified, ETag, and absent optional removals', async () => {
        const spy = vi.spyOn(drive, 'handle');
        const absentBody = await (await patch(remove('<G:description/><G:folderColorRgb/>'))).text();
        expect(propStatus(absentBody, 'urn:google:drive', 'description')).toBe('HTTP/1.1 200 OK');
        expect(propStatus(absentBody, 'urn:google:drive', 'folderColorRgb')).toBe('HTTP/1.1 200 OK');
        for (const [input, init] of mutationCalls(spy)) expect(await new Request(input, init).json()).toEqual({});

        await patch(set('<G:folderColorRgb>#ff0000</G:folderColorRgb>'), '/dav/docs/');
        expect(drive.findById('folder-docs')!.folderColorRgb).toBe('#f83a22');

        const tags: (string | null | undefined)[] = [];
        for (const content of ['abcd', 'efgh']) {
            expect((await request('/dav/a.txt', { method: 'PUT', body: content })).status).toBe(204);
            const patchBody = await (await patch(set('<D:lastmodified>1577836800</D:lastmodified>'))).text();
            expect(propStatus(patchBody, DAV, 'lastmodified')).toBe('HTTP/1.1 200 OK');
            expect(source().size).toBe(4);
            expect(source().modifiedTime).toBe('2020-01-01T00:00:00.000Z');
            expect(JSON.stringify(source().appProperties ?? {})).not.toContain('lastmodified');
            tags.push(value(await (await find('<D:getetag/>')).text(), DAV, 'getetag'));
        }
        expect(tags[0]).toBeTruthy();
        expect(tags[1]).not.toBe(tags[0]);
    });

    it.each([
        { label: 'present-native-remove', seedDescription: 'keep', namespace: 'urn:google:drive', prop: 'description', operations: remove('<G:description/>') + set('<X:label>not saved</X:label><G:starred>true</G:starred>') },
        { label: 'set-then-remove-native', namespace: 'urn:google:drive', prop: 'description', operations: set('<G:description>temporary</G:description><X:label>not saved</X:label>') + remove('<G:description/>') },
        { label: 'remove-starred', namespace: 'urn:google:drive', prop: 'starred', operations: remove('<G:starred/>') + set('<X:label>not saved</X:label>') },
        { label: 'remove-getlastmodified', namespace: DAV, prop: 'getlastmodified', operations: remove('<D:getlastmodified/>') + set('<X:label>not saved</X:label>') },
        { label: 'invalid-starred', namespace: 'urn:google:drive', prop: 'starred', operations: set('<G:starred>yes</G:starred><X:label>not saved</X:label>') },
        { label: 'invalid-getlastmodified', namespace: DAV, prop: 'getlastmodified', operations: set('<D:getlastmodified>yesterday</D:getlastmodified><X:label>not saved</X:label>') },
        { label: 'invalid-modifiedTime', namespace: 'urn:google:drive', prop: 'modifiedTime', operations: set('<G:modifiedTime>invalid</G:modifiedTime><X:label>not saved</X:label>') },
        { label: 'structured-description', namespace: 'urn:google:drive', prop: 'description', operations: set('<G:description><X:nested/></G:description><X:label>not saved</X:label>') },
        { label: 'structured-displayname', namespace: DAV, prop: 'displayname', operations: set('<D:displayname><X:child>invalid</X:child></D:displayname><X:label>not saved</X:label>') },
    ])('rejects invalid or unremovable property atomically ($label)', async ({ seedDescription, namespace, prop, operations }) => {
        if (seedDescription !== undefined) source().description = seedDescription;
        const spy = vi.spyOn(drive, 'handle');
        const body = await (await patch(operations)).text();
        expect(propStatus(body, namespace, prop)).toBe('HTTP/1.1 409 Conflict');
        expect(propStatus(body, 'urn:test', 'label')).toBe('HTTP/1.1 424 Failed Dependency');
        expect(mutationCalls(spy)).toHaveLength(0);
        expect(source().description).toBe(seedDescription);
        expect(source().appProperties).toBeUndefined();
    });

    it('rejects every protected property and applies none of the batch', async () => {
        const names = ['creationdate', 'getetag', 'getcontentlength', 'getcontenttype', 'resourcetype', 'supportedlock', 'lockdiscovery', 'quota-used-bytes', 'quota-available-bytes'];
        const spy = vi.spyOn(drive, 'handle');
        const body = await (await patch(set(names.map(name => `<D:${name}/>`).join('')
            + '<G:createdTime/><X:label>not saved</X:label><G:description>not saved</G:description>'))).text();
        for (const name of names) expect(propStatus(body, DAV, name)).toBe('HTTP/1.1 403 Forbidden');
        expect(propStatus(body, 'urn:google:drive', 'createdTime')).toBe('HTTP/1.1 403 Forbidden');
        expect(xml(body).getElementsByTagNameNS(DAV, 'cannot-modify-protected-property').length).toBe(names.length + 1);
        expect(propStatus(body, 'urn:test', 'label')).toBe('HTTP/1.1 424 Failed Dependency');
        expect(propStatus(body, 'urn:google:drive', 'description')).toBe('HTTP/1.1 424 Failed Dependency');
        expect(mutationCalls(spy)).toHaveLength(0);
        expect(source().description).toBeUndefined();
        expect(source().appProperties).toBeUndefined();
    });

    it.each(['COPY', 'MOVE'])('preserves dead XML properties across %s', async method => {
        await patch(set('<X:label>carried</X:label>'));
        // Worker in-memory caches outlive test fixtures. Use distinct targets
        // so the MOVE fixture cannot see the prior COPY fixture's cached ID.
        const destination = '/dav/destination-' + method.toLowerCase() + '.txt';
        expect((await request('/dav/a.txt', { method, headers: { Destination: ORIGIN + destination } })).status).toBe(201);
        expect(value(await (await find(undefined, destination)).text(), 'urn:test', 'label')).toBe('carried');
    });

    it('invalidates cached property values and parent listings', async () => {
        await find();
        await request('/dav/', { method: 'PROPFIND', headers: { Depth: '1' } });
        await patch(set('<X:label>fresh</X:label>'));
        expect(value(await (await find()).text(), 'urn:test', 'label')).toBe('fresh');
        const listing = await request('/dav/', { method: 'PROPFIND', headers: { Depth: '1' } });
        expect(value(await listing.text(), 'urn:test', 'label')).toBe('fresh');
    });

    it('writes collection properties and reads actual My Drive root metadata', async () => {
        await patch(set('<X:label>folder</X:label>'), '/dav/docs/');
        expect(value(await (await find(undefined, '/dav/docs/')).text(), 'urn:test', 'label')).toBe('folder');
        const spy = vi.spyOn(drive, 'handle');
        const root = await find('<D:resourcetype/><D:displayname/>', '/dav/');
        expect(spy.mock.calls.some(([input]) => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname === '/drive/v3/files/root')).toBe(true);
        expect(root.status).toBe(207);
        const document = xml(await root.text());
        expect(document.getElementsByTagNameNS(DAV, 'collection').length).toBe(1);
        expect(document.getElementsByTagNameNS(DAV, 'displayname')[0].textContent).toBe('My Drive');
    });

    it.each([
        ['invalid-xml', 'not XML'],
        ['malformed-utf8', new Uint8Array([0xc3, 0x28])],
    ] as const)('returns HTTP 400 for %s without writing to Drive', async (_, body) => {
        const spy = vi.spyOn(drive, 'handle');
        expect((await request('/dav/a.txt', { method: 'PROPPATCH', body })).status).toBe(400);
        expect(mutationCalls(spy)).toHaveLength(0);
    });

    it('returns 404 for a missing target without creating it', async () => {
        const spy = vi.spyOn(drive, 'handle');
        expect((await patch(set('<X:label>new</X:label>'), '/dav/missing.txt')).status).toBe(404);
        expect(mutationCalls(spy)).toHaveLength(0);
    });

    it.each(['PROPPATCH', 'PROPFIND'])('rejects oversized %s bodies without Drive writes', async method => {
        const spy = vi.spyOn(drive, 'handle');
        const response = await request('/dav/a.txt', { method, body: 'x'.repeat(64 * 1024 + 1) });
        expect(response.status).toBe(413);
        expect(mutationCalls(spy)).toHaveLength(0);
    });

    it.each(['propertyLengthLimitExceeded', 'propertyCountLimitExceeded'])('maps upstream quota rejection %s to 507 without applying the batch', async reason => {
        const handle = drive.handle.bind(drive);
        const spy = vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
            if (init?.method === 'PATCH') return new Response(JSON.stringify({ error: { errors: [{ reason }] } }), { status: 403 });
            return handle(input, init);
        });
        const body = await (await patch(set('<X:label>small</X:label><G:description>not saved</G:description>'))).text();
        expect(propStatus(body, 'urn:test', 'label')).toBe('HTTP/1.1 507 Insufficient Storage');
        expect(propStatus(body, 'urn:google:drive', 'description')).toBe('HTTP/1.1 507 Insufficient Storage');
        expect(mutationCalls(spy)).toHaveLength(1);
        expect(source().appProperties).toBeUndefined();
        expect(source().description).toBeUndefined();
    });

    it('reports an upstream rejection without claiming success', async () => {
        const handle = drive.handle.bind(drive);
        vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
            if (init?.method === 'PATCH') return new Response(JSON.stringify({ error: { errors: [{ reason: 'insufficientFilePermissions' }] } }), { status: 403 });
            return handle(input, init);
        });
        const body = await (await patch(set('<X:label>not saved</X:label>'))).text();
        expect(propStatus(body, 'urn:test', 'label')).toBe('HTTP/1.1 403 Forbidden');
        expect(source().appProperties).toBeUndefined();
    });

    it('reports an uncertain write outcome and never retries or rolls back', async () => {
        const handle = drive.handle.bind(drive);
        const spy = vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
            const response = await handle(input, init);
            if (init?.method === 'PATCH') throw new Error('Injected lost response after commit');
            return response;
        });
        const response = await patch(set('<X:label>committed</X:label>'));
        expect(response.status).toBe(502);
        expect(await response.text()).toContain('outcome uncertain');
        expect(mutationCalls(spy)).toHaveLength(1);
        expect(value(await (await find()).text(), 'urn:test', 'label')).toBe('committed');
    });
});
