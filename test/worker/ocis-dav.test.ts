import { createHash } from 'node:crypto';
import { DOMParser, type Document, type Element, type Node } from '@xmldom/xmldom';
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH, FOLDER, ORIGIN, installDriveMock } from '../support/client';
import { type MockDrive } from '../support/mock-drive';
import { generateRsaPair } from '../support/rsa';
import { invokeWorker, useMockDrive } from '../support/worker';

const DAV = 'DAV:';
const OC = 'http://owncloud.org/ns';
const sha1Hex = (data: Uint8Array) => createHash('sha1').update(data).digest('hex');
const xml = (text: string) => new DOMParser().parseFromString(text, 'application/xml');
const propValue = (doc: Document, ns: string, name: string) => doc.getElementsByTagNameNS(ns, name)[0]?.textContent;

let signingKey: string;
let drive: MockDrive;

beforeAll(async () => {
    signingKey = (await generateRsaPair()).pkcs8Pem;
});

const fixture = useMockDrive(d => {
    d.add({ id: 'folder-docs', name: 'docs', mimeType: FOLDER, parents: ['root'] });
    d.add({
        id: 'file-a',
        name: 'a.txt',
        mimeType: 'text/plain',
        size: 3,
        content: new TextEncoder().encode('abc'),
        parents: ['root'],
    });
    d.add({
        id: 'file-img',
        name: 'photo.png',
        mimeType: 'image/png',
        size: 4,
        content: new Uint8Array([137, 80, 78, 71]),
        parents: ['folder-docs'],
        thumbnailLink: 'https://thumb.example/photo',
    });
});

beforeEach(() => {
    drive = fixture.drive;
});

function oidcBindings(overrides: Partial<Env> = {}): Env {
    return {
        ...env,
        CF_ACCESS_AUD: 'cf-access-test-aud',
        CF_ACCESS_TEAM_DOMAIN: 'https://access-test.cloudflareaccess.com',
        OIDC_SIGNING_KEY: signingKey,
        OIDC_SIGNING_KID: 'worker-kid-1',
        ...overrides,
    };
}

async function issueBearerToken(bindings: Env): Promise<string> {
    const store = bindings.AUTH_DO!;
    const response = await store.get(store.idFromName('default')).fetch('https://auth.internal/tokens', {
        method: 'POST',
        body: JSON.stringify({
            clientId: 'OpenCloudAndroid',
            scope: 'openid email profile',
            sub: 'cf-sub-alice',
            email: 'alice@example.com',
            preferredUsername: 'alice@example.com',
            name: 'Alice Example',
        }),
    });
    expect(response.status).toBe(201);
    return (await response.json<{ accessToken: string }>()).accessToken;
}

function propStatus(doc: Document, ns: string, name: string): string | null | undefined {
    const node = doc.getElementsByTagNameNS(ns, name)[0];
    const propstat = node?.parentNode?.parentNode;
    if (!propstat) return undefined;
    for (let child: Node | null = propstat.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && (child as Element).localName === 'status') {
            return child.textContent;
        }
    }
    return undefined;
}

describe('OC-07 unified mount routing matrix', () => {
    it.each([
        { label: 'generic /webdav/', base: '/webdav/', rootProbe: '/webdav/', authMode: 'basic', expectedHrefBase: '/webdav/' },
        { label: 'space literal $', base: '/dav/spaces/personal$root/', rootProbe: '/dav/spaces/personal$root', authMode: 'basic', expectedHrefBase: '/dav/spaces/personal$root/' },
        { label: 'space encoded %24', base: '/dav/spaces/personal%24root/', rootProbe: '/dav/spaces/personal%24root', authMode: 'bearer', expectedHrefBase: '/dav/spaces/personal$root/' },
        { label: 'remote.php webdav', base: '/remote.php/webdav/', rootProbe: '/remote.php/webdav', authMode: 'basic', expectedHrefBase: '/remote.php/webdav/' },
        { label: 'remote.php files Basic', base: '/remote.php/dav/files/test/', rootProbe: '/remote.php/dav/files/test', authMode: 'basic', expectedHrefBase: '/remote.php/dav/files/test/' },
        { label: 'remote.php files Bearer', base: '/remote.php/dav/files/alice%40example.com/', rootProbe: '/remote.php/dav/files/alice@example.com', authMode: 'bearer', expectedHrefBase: '/remote.php/dav/files/alice%40example.com/' },
    ] as const)('supports full DAV + TUS lifecycle on $label', async ({ base, rootProbe, authMode, expectedHrefBase }) => {
        const bindings = authMode === 'bearer' ? oidcBindings() : env;
        const authHeader = authMode === 'bearer'
            ? { Authorization: `Bearer ${await issueBearerToken(bindings)}` }
            : AUTH;
        const call = (path: string, init: RequestInit = {}) => invokeWorker(bindings, path, {
            ...init,
            headers: { ...authHeader, ...(init.headers as Record<string, string> | undefined) },
        });

        // Root PROPFIND (without trailing slash on oCIS mounts, no 301 redirect)
        const rootProp = await call(rootProbe, { method: 'PROPFIND', headers: { Depth: '1' } });
        expect(rootProp.status).toBe(207);
        expect(rootProp.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
        const rootXml = await rootProp.text();
        expect(rootXml).toContain(`<D:href>${expectedHrefBase}</D:href>`);
        expect(rootXml).toContain(`<D:href>${expectedHrefBase}a.txt</D:href>`);

        // 9.2B missing-parent 409 + 9.1A non-TUS PATCH 405
        expect((await call(`${base}no-parent/dir`, { method: 'MKCOL' })).status).toBe(409);
        expect((await call(`${base}no-parent/file.txt`, { method: 'PUT', body: 'x' })).status).toBe(409);
        expect((await call(`${base}no-parent/`, {
            method: 'POST',
            headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': '1', 'Upload-Metadata': `filename ${btoa('x.txt')}` },
        })).status).toBe(409);
        const spy = vi.spyOn(drive, 'handle');
        expect((await call(`${base}a.txt`, { method: 'PATCH' })).status).toBe(405);
        expect(spy).not.toHaveBeenCalled();

        // MKCOL + PUT with OC-Checksum + GET/HEAD v3 ETag + If-Range + If-Match 412
        expect((await call(`${base}work/`, { method: 'MKCOL' })).status).toBe(201);
        const payload = new TextEncoder().encode('hello-oc07');
        const badPut = await call(`${base}work/bad.txt`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain', 'OC-Checksum': 'SHA1:' + '0'.repeat(40) },
            body: payload,
        });
        expect(badPut.status).toBe(400);
        expect(drive.files.some(f => f.name === 'bad.txt' && !f.trashed)).toBe(false);

        const putRes = await call(`${base}work/note.txt`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain', 'OC-Checksum': 'SHA1:' + sha1Hex(payload) },
            body: payload,
        });
        expect(putRes.status).toBe(201);
        const etag = putRes.headers.get('ETag')!;
        expect(etag).toMatch(/^".+-rev-\d+"$/);
        expect((await call(`${base}work/note.txt`, {
            method: 'PUT',
            headers: { 'If-Match': '"stale-etag"' },
            body: 'blocked',
        })).status).toBe(412);

        const headRes = await call(`${base}work/note.txt`, { method: 'HEAD' });
        expect(headRes.status).toBe(200);
        expect(headRes.headers.get('ETag')).toBe(etag);
        spy.mockClear();
        const partial = await call(`${base}work/note.txt`, { headers: { Range: 'bytes=0-4', 'If-Range': etag } });
        expect(partial.status).toBe(206);
        expect(await partial.text()).toBe('hello');
        expect(spy.mock.calls.some(([input]) => String(input).includes('/revisions/') && String(input).includes('alt=media'))).toBe(true);
        const staleRange = await call(`${base}work/note.txt`, { headers: { Range: 'bytes=0-4', 'If-Range': '"stale"' } });
        expect(staleRange.status).toBe(200);
        expect(await staleRange.text()).toBe('hello-oc07');

        // COPY + MOVE within mount (exercising %24 <-> $ equivalence on space mount) + DELETE trash
        const destBase = base.includes('%24') ? '/dav/spaces/personal$root/' : base;
        expect((await call(`${base}work/note.txt`, {
            method: 'COPY',
            headers: { Destination: ORIGIN + `${destBase}work/copied.txt` },
        })).status).toBe(201);
        expect((await call(`${base}work/copied.txt`, {
            method: 'MOVE',
            headers: { Destination: ORIGIN + `${destBase}work/moved.txt` },
        })).status).toBe(201);
        expect((await call(`${base}work/moved.txt`, { method: 'DELETE' })).status).toBe(204);
        expect((await call(`${base}work/moved.txt`, { method: 'HEAD' })).status).toBe(404);

        // TUS lifecycle scoped to active mount (with literal $ on space mount)
        const tusPayload = new TextEncoder().encode('tus-mount-bytes');
        const tusCreate = await call(`${base}work`, {
            method: 'POST',
            headers: {
                'Tus-Resumable': '1.0.0',
                'Upload-Length': String(tusPayload.length),
                'Upload-Metadata': `filename ${btoa('tus.bin')}`,
            },
        });
        expect(tusCreate.status).toBe(201);
        const location = tusCreate.headers.get('Location')!;
        expect(location).toBe(`${ORIGIN}${expectedHrefBase}tus_uploads/${location.split('/').pop()}`);
        const tusPath = new URL(location).pathname;
        expect((await call(tusPath, { method: 'HEAD' })).headers.get('Upload-Offset')).toBe('0');
        const tusPatch = await call(tusPath, {
            method: 'PATCH',
            headers: {
                'Tus-Resumable': '1.0.0',
                'Content-Type': 'application/offset+octet-stream',
                'Upload-Offset': '0',
            },
            body: tusPayload,
        });
        expect(tusPatch.status).toBe(204);
        expect(new Uint8Array(await (await call(`${base}work/tus.bin`)).arrayBuffer())).toEqual(tusPayload);
        expect((await call(`${base}work`, {
            method: 'POST',
            headers: {
                'Tus-Resumable': '1.0.0',
                'Upload-Length': '1',
                'Upload-Metadata': `filename ${btoa('tus.bin')}`,
                'If-Match': '"stale-etag"',
            },
        })).status).toBe(412);
    });
});

describe('OC-07 auth gates, mount isolation, and single-pass decoding', () => {
    it('enforces Bearer-preferred 401 on oCIS mounts and isolates unknown spaces/users and cross-mount transfers', async () => {
        const bindings = oidcBindings();
        const token = await issueBearerToken(bindings);

        const unauthSpace = await invokeWorker(bindings, '/dav/spaces/personal$root/', { method: 'PROPFIND' });
        expect(unauthSpace.status).toBe(401);
        expect(unauthSpace.headers.get('WWW-Authenticate')).toContain('Bearer ');

        const spy = vi.spyOn(drive, 'handle');
        for (const badPath of [
            '/dav/spaces/personal$other/',
            '/dav/spaces/personal%2524root/',
            '/dav/spaces/',
            '/remote.php/dav/files/other/',
        ]) {
            expect((await invokeWorker(bindings, badPath, {
                method: 'PROPFIND',
                headers: { Authorization: `Bearer ${token}` },
            })).status, badPath).toBe(404);
        }
        for (const [src, dest] of [
            ['/dav/spaces/personal$root/a.txt', `${ORIGIN}/webdav/cross.txt`],
            ['/remote.php/webdav/a.txt', `${ORIGIN}/remote.php/dav/files/test/cross.txt`],
            ['/dav/spaces/personal$root/a.txt', `${ORIGIN}/dav/spaces/personal$other/cross.txt`],
        ]) {
            expect((await invokeWorker(env, src, {
                method: 'MOVE',
                headers: { ...AUTH, Destination: dest },
            })).status).toBe(403);
        }
        expect((await invokeWorker(env, '/dav/spaces/personal$root/a.txt', {
            method: 'COPY',
            headers: { ...AUTH, Destination: 'https://evil.example/dav/spaces/personal$root/evil.txt' },
        })).status).toBe(502);
        expect(spy).not.toHaveBeenCalled();
    });

    it('decodes segments once (preserving literal % names) and blocks traversal/malformed paths', async () => {
        const spy = vi.spyOn(drive, 'handle');
        expect((await invokeWorker(env, '/dav/spaces/personal$root/%2e%2e/secret', { headers: AUTH })).status).toBe(404);
        for (const badPath of [
            '/dav/spaces/personal$root/dir%2ffile.txt',
            '/dav/spaces/personal$root/dir%5cfile.txt',
            '/dav/spaces/personal$root/null%00.txt',
            '/dav/spaces/personal$root/%zz',
        ]) {
            expect((await invokeWorker(env, badPath, { headers: AUTH })).status, badPath).toBe(400);
        }
        expect(spy).not.toHaveBeenCalled();

        // Single-pass decoding: "a%20b.txt" encoded once as "a%2520b.txt", "100% done.txt" as "100%25%20done.txt"
        for (const [rawSeg, literalName] of [
            ['a%2520b.txt', 'a%20b.txt'],
            ['100%25%20done.txt', '100% done.txt'],
        ]) {
            const path = `/dav/spaces/personal$root/${rawSeg}`;
            expect((await invokeWorker(env, path, {
                method: 'PUT',
                headers: { ...AUTH, 'Content-Type': 'text/plain' },
                body: literalName,
            })).status).toBe(201);
            expect(drive.children('root').some(f => f.name === literalName)).toBe(true);

            const propRes = await invokeWorker(env, path, {
                method: 'PROPFIND',
                headers: { ...AUTH, Depth: '0' },
            });
            expect(propRes.status).toBe(207);
            const propDoc = xml(await propRes.text());
            expect(propValue(propDoc, DAV, 'href')).toBe(path);
            expect(propValue(propDoc, DAV, 'displayname')).toBe(literalName);
            expect(await (await invokeWorker(env, path, { headers: AUTH })).text()).toBe(literalName);
        }
    });
});

describe('OC-07 PROPFIND oCIS properties, Prefer: return=minimal, and Depth checks', () => {
    it('emits Desktop and Android oc:* properties, stabilizes oc:id across MOVE, and enforces root/read-only rules', async () => {
        drive.add({ id: 'custom-root', name: 'Workspace', mimeType: FOLDER, parents: ['outside-parent'] });
        drive.add({ id: 'child-dir', name: 'sub', mimeType: FOLDER, parents: ['custom-root'] });
        drive.add({ id: 'child-file', name: 'item.txt', mimeType: 'text/plain', size: 5, content: new Uint8Array([1, 2, 3, 4, 5]), parents: ['child-dir'] });
        drive.add({
            id: 'child-img',
            name: 'pic.png',
            mimeType: 'image/png',
            size: 4,
            content: new Uint8Array([1, 2, 3, 4]),
            parents: ['custom-root'],
            thumbnailLink: 'https://thumb.example/pic',
        });
        installDriveMock(drive);

        const customEnv = { ...env, ROOT_ID: 'custom-root' } as Env;
        const propXml = await (await invokeWorker(customEnv, '/dav/spaces/personal$custom-root/', {
            method: 'PROPFIND',
            headers: { ...AUTH, Depth: '1' },
        })).text();
        const doc = xml(propXml);
        const responses = Array.from(doc.getElementsByTagNameNS(DAV, 'response'));
        expect(responses).toHaveLength(3);

        const byHref = new Map(responses.map(node => [node.getElementsByTagNameNS(DAV, 'href')[0]?.textContent, node]));
        const rootNode = byHref.get('/dav/spaces/personal$custom-root/')!;
        expect(rootNode.getElementsByTagNameNS(OC, 'id')[0]?.textContent).toBe('custom-root');
        expect(rootNode.getElementsByTagNameNS(OC, 'fileid')[0]?.textContent).toBe('custom-root');
        expect(rootNode.getElementsByTagNameNS(OC, 'spaceid')[0]?.textContent).toBe('personal$custom-root');
        expect(rootNode.getElementsByTagNameNS(OC, 'file-parent').length).toBe(0); // Never leak outside-parent
        expect(rootNode.getElementsByTagNameNS(OC, 'name')[0]?.textContent).toBe('Workspace');
        expect(rootNode.getElementsByTagNameNS(OC, 'permissions')[0]?.textContent).toBe('RDNVCK');
        expect(rootNode.getElementsByTagNameNS(OC, 'size')[0]?.textContent).toBe('0');
        expect(rootNode.getElementsByTagNameNS(OC, 'has-preview')[0]?.textContent).toBe('0');
        expect(rootNode.getElementsByTagNameNS(DAV, 'getcontentlength').length).toBe(0);

        const dirNode = byHref.get('/dav/spaces/personal$custom-root/sub/')!;
        expect(dirNode.getElementsByTagNameNS(OC, 'file-parent')[0]?.textContent).toBe('custom-root');
        expect(dirNode.getElementsByTagNameNS(OC, 'permissions')[0]?.textContent).toBe('RDNVCK');
        expect(dirNode.getElementsByTagNameNS(OC, 'size')[0]?.textContent).toBe('0');
        expect(dirNode.getElementsByTagNameNS(OC, 'has-preview')[0]?.textContent).toBe('0');
        expect(dirNode.getElementsByTagNameNS(DAV, 'getcontentlength').length).toBe(0);

        const imgNode = byHref.get('/dav/spaces/personal$custom-root/pic.png')!;
        expect(imgNode.getElementsByTagNameNS(OC, 'id')[0]?.textContent).toBe('child-img');
        expect(imgNode.getElementsByTagNameNS(OC, 'file-parent')[0]?.textContent).toBe('custom-root');
        expect(imgNode.getElementsByTagNameNS(OC, 'permissions')[0]?.textContent).toBe('RDNVW');
        expect(imgNode.getElementsByTagNameNS(OC, 'size')[0]?.textContent).toBe('4');
        expect(imgNode.getElementsByTagNameNS(OC, 'has-preview')[0]?.textContent).toBe('1');
        expect(imgNode.getElementsByTagNameNS(OC, 'checksum')[0]?.textContent).toContain('SHA1:');

        // MOVE preserves oc:id and updates oc:file-parent
        expect((await invokeWorker(customEnv, '/dav/spaces/personal$custom-root/sub/item.txt', {
            method: 'MOVE',
            headers: { ...AUTH, Destination: ORIGIN + '/dav/spaces/personal$custom-root/moved-item.txt' },
        })).status).toBe(201);
        const movedDoc = xml(await (await invokeWorker(customEnv, '/dav/spaces/personal$custom-root/moved-item.txt', {
            method: 'PROPFIND',
            headers: { ...AUTH, Depth: '0' },
        })).text());
        expect(propValue(movedDoc, OC, 'id')).toBe('child-file');
        expect(propValue(movedDoc, OC, 'file-parent')).toBe('custom-root');
        expect(propValue(movedDoc, OC, 'has-preview')).toBe('0');

        // Live oc:* properties are protected on PROPPATCH (403) while oc:checksums remains a 200 no-op
        const patchRes = await invokeWorker(customEnv, '/dav/spaces/personal$custom-root/moved-item.txt', {
            method: 'PROPPATCH',
            headers: AUTH,
            body: `<D:propertyupdate xmlns:D="DAV:" xmlns:oc="${OC}"><D:set><D:prop><oc:id>fake</oc:id><oc:permissions>R</oc:permissions><oc:checksums><oc:checksum>SHA1:0000</oc:checksum></oc:checksums></D:prop></D:set></D:propertyupdate>`,
        });
        expect(patchRes.status).toBe(207);
        const patchDoc = xml(await patchRes.text());
        expect(propStatus(patchDoc, OC, 'id')).toBe('HTTP/1.1 403 Forbidden');
        expect(propStatus(patchDoc, OC, 'permissions')).toBe('HTTP/1.1 403 Forbidden');
        expect(propStatus(patchDoc, OC, 'checksums')).toBe('HTTP/1.1 424 Failed Dependency');
    });

    it('supports Prefer: return=minimal and enforces Depth 0/1 vs infinity (403) and invalid Depth (400)', async () => {
        const body = `<D:propfind xmlns:D="DAV:" xmlns:oc="${OC}"><D:prop><oc:id/><oc:share-types/><oc:privatelink/><oc:downloadURL/><oc:dDC/><oc:data-fingerprint/></D:prop></D:propfind>`;

        const normal = await invokeWorker(env, '/dav/spaces/personal$root/a.txt', {
            method: 'PROPFIND',
            headers: { ...AUTH, Depth: '0' },
            body,
        });
        expect(normal.status).toBe(207);
        expect(normal.headers.get('Preference-Applied')).toBeNull();
        const normalDoc = xml(await normal.text());
        expect(propStatus(normalDoc, OC, 'id')).toBe('HTTP/1.1 200 OK');
        expect(propStatus(normalDoc, OC, 'share-types')).toBe('HTTP/1.1 404 Not Found');

        const minimal = await invokeWorker(env, '/dav/spaces/personal$root/a.txt', {
            method: 'PROPFIND',
            headers: { ...AUTH, Depth: '0', Prefer: 'handling=lenient, return=minimal' },
            body,
        });
        expect(minimal.status).toBe(207);
        expect(minimal.headers.get('Preference-Applied')).toBe('return=minimal');
        const minimalText = await minimal.text();
        expect(minimalText).not.toContain('404 Not Found');
        expect(minimalText).not.toContain('share-types');
        expect(propValue(xml(minimalText), OC, 'id')).toBe('file-a');

        const allMissingMinimal = await invokeWorker(env, '/dav/spaces/personal$root/a.txt', {
            method: 'PROPFIND',
            headers: { ...AUTH, Depth: '0', Prefer: 'return="minimal"' },
            body: `<D:propfind xmlns:D="DAV:" xmlns:oc="${OC}"><D:prop><oc:share-types/></D:prop></D:propfind>`,
        });
        expect(allMissingMinimal.status).toBe(207);
        expect(allMissingMinimal.headers.get('Preference-Applied')).toBe('return=minimal');
        const allMissingText = await allMissingMinimal.text();
        expect(allMissingText).toContain('HTTP/1.1 200 OK');
        expect(allMissingText).not.toContain('404 Not Found');

        const spy = vi.spyOn(drive, 'handle');
        const infinityRes = await invokeWorker(env, '/dav/spaces/personal$root/', {
            method: 'PROPFIND',
            headers: { ...AUTH, Depth: 'infinity' },
        });
        expect(infinityRes.status).toBe(403);
        expect(infinityRes.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
        expect(await infinityRes.text()).toContain('<D:propfind-finite-depth/>');
        expect((await invokeWorker(env, '/dav/spaces/personal$root/', {
            method: 'PROPFIND',
            headers: { ...AUTH, Depth: '2' },
        })).status).toBe(400);
        expect(spy).not.toHaveBeenCalled();
    });

    it('enforces 7A native doc exclusion and 8B folder COPY (Depth 0 & infinity) on /dav/spaces/', async () => {
        drive.add({ id: 'ws-doc', name: 'Secret Doc', mimeType: 'application/vnd.google-apps.document', parents: ['folder-docs'] });

        const listText = await (await invokeWorker(env, '/dav/spaces/personal$root/docs/', {
            method: 'PROPFIND',
            headers: { ...AUTH, Depth: '1' },
        })).text();
        expect(listText).not.toContain('Secret Doc');
        expect((await invokeWorker(env, '/dav/spaces/personal$root/docs/Secret%20Doc', { headers: AUTH })).status).toBe(404);

        const shallow = await invokeWorker(env, '/dav/spaces/personal$root/docs/', {
            method: 'COPY',
            headers: { ...AUTH, Destination: ORIGIN + '/dav/spaces/personal$root/docs-shallow/', Depth: '0' },
        });
        expect(shallow.status).toBe(201);
        expect((await invokeWorker(env, '/dav/spaces/personal$root/docs-shallow/photo.png', {
            method: 'HEAD',
            headers: AUTH,
        })).status).toBe(404);

        const recursive = await invokeWorker(env, '/dav/spaces/personal$root/docs/', {
            method: 'COPY',
            headers: { ...AUTH, Destination: ORIGIN + '/dav/spaces/personal$root/docs-full/', Depth: 'infinity' },
        });
        expect(recursive.status).toBe(201);
        expect((await invokeWorker(env, '/dav/spaces/personal$root/docs-full/photo.png', {
            method: 'HEAD',
            headers: AUTH,
        })).status).toBe(200);
        expect((await invokeWorker(env, '/dav/spaces/personal$root/docs-full/Secret%20Doc', {
            method: 'HEAD',
            headers: AUTH,
        })).status).toBe(404);
    });
});
