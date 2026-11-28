import { DOMParser } from '@xmldom/xmldom';
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AUTH, FOLDER } from '../support/client';
import { type MockDrive } from '../support/mock-drive';
import { setFetchMock } from '../support/network';
import { generateRsaPair } from '../support/rsa';
import { invokeWorker, useMockDrive } from '../support/worker';

const OC = 'http://owncloud.org/ns';
const DAV = 'DAV:';
const ORIG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const THUMB_BYTES_V1 = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 11, 22, 33]);
const THUMB_BYTES_V2 = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 2]);
const CDN_THUMB_BYTES = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

type ThumbCall = { url: string; authorization: string | null };

let signingKey: string;

beforeAll(async () => {
    signingKey = (await generateRsaPair()).pkcs8Pem;
});

const fixture = useMockDrive(d => {
    d.add({ id: 'folder-docs', name: 'docs', mimeType: FOLDER, parents: ['root'] });
    d.add({
        id: 'file-photo',
        name: 'photo.png',
        mimeType: 'image/png',
        size: ORIG_BYTES.length,
        content: ORIG_BYTES,
        parents: ['folder-docs'],
        modifiedTime: '2026-11-20T12:00:00.000Z',
        thumbnailContent: THUMB_BYTES_V1,
        thumbnailContentType: 'image/png',
    });
    d.add({
        id: 'file-no-thumb',
        name: 'opaque.bin',
        mimeType: 'application/octet-stream',
        size: 4,
        content: new Uint8Array([1, 2, 3, 4]),
        parents: ['root'],
    });
    d.add({
        id: 'file-http-thumb',
        name: 'insecure.png',
        mimeType: 'image/png',
        size: 4,
        content: new Uint8Array([5, 6, 7, 8]),
        parents: ['root'],
        thumbnailLink: 'http://lh3.googleusercontent.com/drive-storage/insecure=s220',
    });
    d.add({
        id: 'ws-doc',
        name: 'Native Doc',
        mimeType: 'application/vnd.google-apps.document',
        parents: ['root'],
    });
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

async function issueBearerToken(bindings: Env, sub = 'cf-sub-alice', email = 'alice@example.com'): Promise<string> {
    const store = bindings.AUTH_DO!;
    const response = await store.get(store.idFromName('default')).fetch('https://auth.internal/tokens', {
        method: 'POST',
        body: JSON.stringify({
            clientId: 'OpenCloudAndroid',
            scope: 'openid email profile',
            sub,
            email,
            preferredUsername: email,
            name: sub,
        }),
    });
    expect(response.status).toBe(201);
    return (await response.json<{ accessToken: string }>()).accessToken;
}

function installThumbnailFaultMock(
    drive: MockDrive,
    handler: (url: URL, init?: RequestInit) => Promise<Response> | Response,
): ThumbCall[] {
    const calls: ThumbCall[] = [];
    setFetchMock((input, init) => {
        const req = input instanceof Request ? input : undefined;
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.origin === 'https://www.googleapis.com') {
            return drive.handle(input, init);
        }
        const headers = new Headers(init?.headers ?? req?.headers);
        calls.push({ url: url.toString(), authorization: headers.get('Authorization') });
        return handler(url, init);
    });
    return calls;
}

describe('OC-08 Android preview proxy', () => {
    it('requires authentication on preview requests across generic and oCIS mounts', async () => {
        const bindings = oidcBindings();
        const oCISUnauth = await invokeWorker(bindings, '/dav/spaces/personal$root/docs/photo.png?preview=1&x=256&y=256');
        expect(oCISUnauth.status).toBe(401);
        expect(oCISUnauth.headers.get('WWW-Authenticate')).toContain('Bearer ');

        const genericUnauth = await invokeWorker(env, '/webdav/docs/photo.png?preview=1');
        expect(genericUnauth.status).toBe(401);
        expect(genericUnauth.headers.get('WWW-Authenticate')).toContain('Basic ');
    });

    it('proxies MockDrive /drive-storage/ thumbnails across mounts while keeping non-preview GETs on original file bytes', async () => {
        const { drive } = fixture;
        const bindings = oidcBindings();
        const token = await issueBearerToken(bindings);
        const file = drive.findById('file-photo')!;
        const fileEtag = `"file-photo-${file.headRevisionId}"`;
        const spy = vi.spyOn(drive, 'handle');

        const androidPreview = await invokeWorker(
            bindings,
            `/dav/spaces/personal$root/docs/photo.png?x=256&y=256&c=${encodeURIComponent(fileEtag)}&preview=1`,
            { headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'identity' } },
        );
        expect(androidPreview.status).toBe(200);
        expect(androidPreview.headers.get('Content-Type')).toBe('image/png');
        expect(androidPreview.headers.get('Content-Length')).toBe(String(THUMB_BYTES_V1.length));
        expect(androidPreview.headers.get('Cache-Control')).toBe('private, max-age=300');
        expect(androidPreview.headers.get('Vary')).toBe('Authorization');
        expect(androidPreview.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(androidPreview.headers.get('ETag')).toBe(`"preview-file-photo-${file.headRevisionId}"`);
        expect(androidPreview.headers.get('Last-Modified')).toBe('Fri, 20 Nov 2026 12:00:00 GMT');
        expect(androidPreview.headers.get('Location')).toBeNull();
        expect(new Uint8Array(await androidPreview.arrayBuffer())).toEqual(THUMB_BYTES_V1);

        const thumbFetch = spy.mock.calls.find(([input]) => String(input).includes('/drive-storage/'));
        expect(thumbFetch?.[0]).toBe(file.thumbnailLink);
        expect(new Headers(thumbFetch?.[1]?.headers).get('Authorization')).toBe('Bearer test-access-token');

        for (const path of [
            '/webdav/docs/photo.png?preview=1&x=128&y=128',
            '/remote.php/webdav/docs/photo.png?preview=1',
            '/remote.php/dav/files/test/docs/photo.png?preview=1&x=64&y=64&c=',
        ]) {
            const res = await invokeWorker(env, path, { headers: AUTH });
            expect(res.status, path).toBe(200);
            expect(res.headers.get('Content-Type')).toBe('image/png');
            expect(new Uint8Array(await res.arrayBuffer())).toEqual(THUMB_BYTES_V1);
        }

        const thumbCallsBefore = spy.mock.calls.filter(([input]) => String(input).includes('/drive-storage/')).length;
        for (const suffix of ['', '?preview=0']) {
            const orig = await invokeWorker(bindings, `/dav/spaces/personal$root/docs/photo.png${suffix}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(orig.status).toBe(200);
            expect(orig.headers.get('Content-Type')).toBe('image/png');
            expect(new Uint8Array(await orig.arrayBuffer())).toEqual(ORIG_BYTES);
        }
        expect(spy.mock.calls.filter(([input]) => String(input).includes('/drive-storage/')).length).toBe(thumbCallsBefore);
    });

    it('keeps oc:has-preview consistent with preview availability and returns 404 when absent or non-file', async () => {
        const { drive } = fixture;
        const spy = vi.spyOn(drive, 'handle');

        const propRes = await invokeWorker(env, '/dav/spaces/personal$root/', {
            method: 'PROPFIND',
            headers: { ...AUTH, Depth: '1' },
        });
        expect(propRes.status).toBe(207);
        const doc = new DOMParser().parseFromString(await propRes.text(), 'application/xml');
        const byHref = new Map(
            Array.from(doc.getElementsByTagNameNS(DAV, 'response')).map(node => [
                node.getElementsByTagNameNS(DAV, 'href')[0]?.textContent ?? '',
                node.getElementsByTagNameNS(OC, 'has-preview')[0]?.textContent,
            ]),
        );
        expect(byHref.get('/dav/spaces/personal$root/docs/')).toBe('0');
        expect(byHref.get('/dav/spaces/personal$root/opaque.bin')).toBe('0');
        expect(byHref.get('/dav/spaces/personal$root/insecure.png')).toBe('0');

        for (const path of [
            '/dav/spaces/personal$root/opaque.bin?preview=1',
            '/dav/spaces/personal$root/insecure.png?preview=1',
            '/dav/spaces/personal$root/docs/?preview=1',
            '/dav/spaces/personal$root/missing.png?preview=1',
            '/dav/spaces/personal$root/Native%20Doc?preview=1',
        ]) {
            const res = await invokeWorker(env, path, { headers: AUTH });
            expect(res.status, path).toBe(404);
            expect((await res.arrayBuffer()).byteLength).toBe(0);
        }
        expect(spy.mock.calls.some(([input]) => String(input).includes('/drive-storage/'))).toBe(false);
    });

    it('reuses 30s metadata cache, supports If-None-Match 304, and invalidates on updates and DELETE', async () => {
        const { drive } = fixture;
        const spy = vi.spyOn(drive, 'handle');
        const listCalls = () => spy.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/drive/v3/files').length;
        const thumbCalls = () => spy.mock.calls.filter(([input]) => String(input).includes('/drive-storage/')).length;

        const first = await invokeWorker(env, '/webdav/docs/photo.png?preview=1&x=128&y=128', { headers: AUTH });
        expect(first.status).toBe(200);
        const previewEtag = first.headers.get('ETag')!;
        expect(listCalls()).toBeGreaterThan(0);
        expect(thumbCalls()).toBe(1);

        // Repeat requests reuse the 30s metadata cache (0 files.list calls) and proxy from MockDrive
        spy.mockClear();
        const second = await invokeWorker(env, '/webdav/docs/photo.png?preview=1&x=256&y=256', { headers: AUTH });
        expect(second.status).toBe(200);
        expect(new Uint8Array(await second.arrayBuffer())).toEqual(THUMB_BYTES_V1);
        expect(listCalls()).toBe(0);
        expect(thumbCalls()).toBe(1);

        for (const inm of [previewEtag, `W/${previewEtag}`]) {
            const notModified = await invokeWorker(env, '/webdav/docs/photo.png?preview=1', {
                headers: { ...AUTH, 'If-None-Match': inm },
            });
            expect(notModified.status).toBe(304);
            expect(notModified.headers.get('ETag')).toBe(previewEtag);
            expect(notModified.headers.get('Vary')).toBe('Authorization');
            expect((await notModified.arrayBuffer()).byteLength).toBe(0);
        }

        // External replacement updates thumbnailVersion/thumbnailLink; `c` bypasses 30s metadata cache
        const photo = drive.findById('file-photo')!;
        const oldLink = photo.thumbnailLink;
        drive.replaceContent('file-photo', new Uint8Array([9, 9, 9, 9]), {
            thumbnailContent: THUMB_BYTES_V2,
            thumbnailContentType: 'image/jpeg',
        });
        expect(photo.thumbnailLink).not.toBe(oldLink);
        const newEtag = `"file-photo-${photo.headRevisionId}"`;
        const updated = await invokeWorker(env, `/webdav/docs/photo.png?preview=1&c=${encodeURIComponent(newEtag)}`, {
            headers: AUTH,
        });
        expect(updated.status).toBe(200);
        expect(updated.headers.get('Content-Type')).toBe('image/jpeg');
        expect(updated.headers.get('ETag')).toBe(`"preview-file-photo-${photo.headRevisionId}"`);
        expect(new Uint8Array(await updated.arrayBuffer())).toEqual(THUMB_BYTES_V2);

        // Local PUT overwrite rotates ETag and invalidates cached metadata
        expect((await invokeWorker(env, '/webdav/docs/photo.png', {
            method: 'PUT',
            headers: { ...AUTH, 'Content-Type': 'image/png' },
            body: new Uint8Array([4, 3, 2, 1]),
        })).status).toBe(204);
        const afterPut = await invokeWorker(env, '/webdav/docs/photo.png?preview=1', { headers: AUTH });
        expect(afterPut.status).toBe(200);
        expect(afterPut.headers.get('ETag')).toBe(`"preview-file-photo-${photo.headRevisionId}"`);

        expect((await invokeWorker(env, '/webdav/docs/photo.png', { method: 'DELETE', headers: AUTH })).status).toBe(204);
        expect((await invokeWorker(env, '/webdav/docs/photo.png?preview=1', { headers: AUTH })).status).toBe(404);
    });

    it('recovers from MockDrive 400 stale /drive-storage/ links and maps persistent 400 HTML to 502', async () => {
        const { drive } = fixture;
        drive.add({
            id: 'file-stale-400',
            name: 'stale-400.png',
            mimeType: 'image/png',
            size: ORIG_BYTES.length,
            content: ORIG_BYTES,
            parents: ['root'],
            thumbnailLink: 'https://lh3.googleusercontent.com/drive-storage/stale-unregistered=s220',
        });
        // Prime the 30s isolate metadata cache with the unregistered stale link
        expect((await invokeWorker(env, '/webdav/stale-400.png', {
            method: 'PROPFIND',
            headers: { ...AUTH, Depth: '0' },
        })).status).toBe(207);

        // Update Drive with a live thumbnail link while cached leaf still points to stale-unregistered
        drive.replaceContent('file-stale-400', new Uint8Array([1, 2, 3, 4]), {
            thumbnailContent: THUMB_BYTES_V2,
            thumbnailContentType: 'image/jpeg',
        });

        const spy = vi.spyOn(drive, 'handle');
        const recovered = await invokeWorker(env, '/webdav/stale-400.png?preview=1', { headers: AUTH });
        expect(recovered.status).toBe(200);
        expect(recovered.headers.get('Content-Type')).toBe('image/jpeg');
        expect(new Uint8Array(await recovered.arrayBuffer())).toEqual(THUMB_BYTES_V2);
        const thumbRequests = spy.mock.calls.filter(([input]) => String(input).includes('/drive-storage/'));
        expect(thumbRequests).toHaveLength(2);

        // Permanently unknown /drive-storage/ path returns 400 text/html from MockDrive -> mapped to 502 without leaking HTML
        drive.add({
            id: 'file-missing-storage',
            name: 'missing-storage.png',
            mimeType: 'image/png',
            size: 4,
            content: new Uint8Array([1, 2, 3, 4]),
            parents: ['root'],
            thumbnailLink: 'https://lh3.googleusercontent.com/drive-storage/unknown-forever=s220',
        });
        const badRes = await invokeWorker(env, '/webdav/missing-storage.png?preview=1', { headers: AUTH });
        expect(badRes.status).toBe(502);
        expect(await badRes.text()).not.toContain('<!DOCTYPE html>');
    });

    it('restricts Bearer token to Google hosts, follows Google redirects safely, and retries 403/401 faults', async () => {
        const { drive } = fixture;

        drive.add({
            id: 'file-cdn',
            name: 'cdn.png',
            mimeType: 'image/png',
            size: ORIG_BYTES.length,
            content: ORIG_BYTES,
            parents: ['root'],
            thumbnailLink: 'https://cdn.example/thumb.webp',
        });
        const cdnCalls = installThumbnailFaultMock(drive, () =>
            new Response(CDN_THUMB_BYTES, { status: 200, headers: { 'Content-Type': 'image/webp' } }),
        );
        const cdnRes = await invokeWorker(env, '/webdav/cdn.png?preview=1', { headers: AUTH });
        expect(cdnRes.status).toBe(200);
        expect(cdnRes.headers.get('Content-Type')).toBe('image/webp');
        expect(new Uint8Array(await cdnRes.arrayBuffer())).toEqual(CDN_THUMB_BYTES);
        expect(cdnCalls).toEqual([{ url: 'https://cdn.example/thumb.webp', authorization: null }]);

        const redirCalls = installThumbnailFaultMock(drive, url => {
            if (url.hostname === 'lh3.googleusercontent.com') {
                return new Response(null, { status: 302, headers: { Location: 'https://lh4.googleusercontent.com/final=s220' } });
            }
            return new Response(THUMB_BYTES_V1, { status: 200, headers: { 'Content-Type': 'image/png' } });
        });
        const redirected = await invokeWorker(env, '/dav/spaces/personal$root/docs/photo.png?preview=1', { headers: AUTH });
        expect(redirected.status).toBe(200);
        expect(redirected.headers.get('Location')).toBeNull();
        expect(redirCalls).toHaveLength(2);
        expect(redirCalls[1]).toEqual({
            url: 'https://lh4.googleusercontent.com/final=s220',
            authorization: 'Bearer test-access-token',
        });

        drive.add({
            id: 'file-evil-redir',
            name: 'evil-redir.png',
            mimeType: 'image/png',
            size: 4,
            content: new Uint8Array([1, 2, 3, 4]),
            parents: ['root'],
            thumbnailLink: 'https://lh3.googleusercontent.com/drive-storage/evil-start',
        });
        const evilCalls = installThumbnailFaultMock(drive, () =>
            new Response(null, { status: 302, headers: { Location: 'https://evil.example/steal-token' } }),
        );
        expect((await invokeWorker(env, '/webdav/evil-redir.png?preview=1', { headers: AUTH })).status).toBe(502);
        expect(evilCalls.some(c => c.url.includes('evil.example'))).toBe(false);

        drive.add({
            id: 'file-loop-redir',
            name: 'loop-redir.png',
            mimeType: 'image/png',
            size: 4,
            content: new Uint8Array([1, 2, 3, 4]),
            parents: ['root'],
            thumbnailLink: 'https://lh3.googleusercontent.com/drive-storage/loop-0',
        });
        installThumbnailFaultMock(drive, url => new Response(null, {
            status: 302,
            headers: { Location: `https://lh3.googleusercontent.com/drive-storage/loop-${Number(url.pathname.split('-').pop()) + 1}` },
        }));
        expect((await invokeWorker(env, '/webdav/loop-redir.png?preview=1', { headers: AUTH })).status).toBe(502);

        drive.add({
            id: 'file-refresh-link',
            name: 'refresh-link.png',
            mimeType: 'image/png',
            size: 4,
            content: new Uint8Array([1, 2, 3, 4]),
            parents: ['root'],
            thumbnailLink: 'https://lh3.googleusercontent.com/drive-storage/stale-link',
        });
        expect((await invokeWorker(env, '/webdav/refresh-link.png', { method: 'PROPFIND', headers: { ...AUTH, Depth: '0' } })).status).toBe(207);
        drive.findById('file-refresh-link')!.thumbnailLink = 'https://lh3.googleusercontent.com/drive-storage/fresh-link';
        installThumbnailFaultMock(drive, url => {
            if (url.pathname.endsWith('/stale-link')) return new Response('forbidden', { status: 403 });
            return new Response(THUMB_BYTES_V2, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
        });
        const refreshedLinkRes = await invokeWorker(env, '/webdav/refresh-link.png?preview=1', { headers: AUTH });
        expect(refreshedLinkRes.status).toBe(200);
        expect(new Uint8Array(await refreshedLinkRes.arrayBuffer())).toEqual(THUMB_BYTES_V2);

        drive.add({
            id: 'file-refresh-token',
            name: 'refresh-token.png',
            mimeType: 'image/png',
            size: 4,
            content: new Uint8Array([1, 2, 3, 4]),
            parents: ['root'],
            thumbnailLink: 'https://lh3.googleusercontent.com/drive-storage/token-check',
        });
        let tokenChecks = 0;
        installThumbnailFaultMock(drive, () => {
            tokenChecks++;
            if (tokenChecks === 1) return new Response('unauthorized', { status: 401 });
            return new Response(THUMB_BYTES_V1, { status: 200, headers: { 'Content-Type': 'image/png' } });
        });
        expect((await invokeWorker(env, '/webdav/refresh-token.png?preview=1', { headers: AUTH })).status).toBe(200);
        expect(tokenChecks).toBe(2);
    });

    it('rejects invalid preview query parameters with 400 before contacting Drive', async () => {
        const spy = vi.spyOn(fixture.drive, 'handle');
        for (const query of ['preview=1&x=0', 'preview=1&y=4097', 'preview=1&x=abc', `preview=1&c=${'a'.repeat(513)}`]) {
            const res = await invokeWorker(env, `/webdav/docs/photo.png?${query}`, { headers: AUTH });
            expect(res.status, query).toBe(400);
        }
        expect(spy).not.toHaveBeenCalled();
    });

    it.each([
        {
            label: 'upstream 404',
            makeResponse: () => new Response('missing', { status: 404 }),
            expectedStatus: 404,
            expectedRetryAfter: null,
        },
        {
            label: 'upstream 410',
            makeResponse: () => new Response('gone', { status: 410 }),
            expectedStatus: 404,
            expectedRetryAfter: null,
        },
        {
            label: 'upstream 429',
            makeResponse: () => new Response('slow down', { status: 429, headers: { 'Retry-After': '12' } }),
            expectedStatus: 429,
            expectedRetryAfter: '12',
        },
        {
            label: 'persistent upstream 401',
            makeResponse: () => new Response('unauthorized', { status: 401 }),
            expectedStatus: 502,
            expectedRetryAfter: null,
        },
        {
            label: 'upstream 403',
            makeResponse: () => new Response('forbidden', { status: 403 }),
            expectedStatus: 502,
            expectedRetryAfter: null,
        },
        {
            label: 'upstream 500',
            makeResponse: () => new Response('boom', { status: 500 }),
            expectedStatus: 502,
            expectedRetryAfter: null,
        },
        {
            label: '200 text/html login page',
            makeResponse: () => new Response('<html>login</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
            expectedStatus: 502,
            expectedRetryAfter: null,
        },
        {
            label: '200 image/svg+xml',
            makeResponse: () => new Response('<svg/>', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } }),
            expectedStatus: 502,
            expectedRetryAfter: null,
        },
        {
            label: '200 empty body',
            makeResponse: () => new Response(new Uint8Array(0), { status: 200, headers: { 'Content-Type': 'image/png' } }),
            expectedStatus: 502,
            expectedRetryAfter: null,
        },
        {
            label: 'oversized > 4 MiB stream',
            makeResponse: () => new Response(new Uint8Array(4 * 1024 * 1024 + 1), { status: 200, headers: { 'Content-Type': 'image/png' } }),
            expectedStatus: 502,
            expectedRetryAfter: null,
        },
    ])('maps $label safely without returning 401 or original bytes', async ({ makeResponse, expectedStatus, expectedRetryAfter }) => {
        const { drive } = fixture;
        const id = 'err-' + crypto.randomUUID();
        drive.add({
            id,
            name: id + '.png',
            mimeType: 'image/png',
            size: ORIG_BYTES.length,
            content: ORIG_BYTES,
            parents: ['root'],
            thumbnailLink: `https://lh3.googleusercontent.com/drive-storage/${id}=s220`,
        });
        installThumbnailFaultMock(drive, () => makeResponse());

        const res = await invokeWorker(env, `/dav/spaces/personal$root/${id}.png?preview=1`, { headers: AUTH });
        expect(res.status).toBe(expectedStatus);
        expect(res.headers.get('Retry-After')).toBe(expectedRetryAfter);
        expect(new Uint8Array(await res.arrayBuffer())).not.toEqual(ORIG_BYTES);
    });
});
