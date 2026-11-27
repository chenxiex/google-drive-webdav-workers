import { DOMParser } from '@xmldom/xmldom';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import pkg from '../../package.json';
import { base64UrlEncode } from '../../src/auth/jwt';
import worker from '../../src/index';
import { AUTH, FOLDER, ORIGIN } from '../support/client';
import { MockDrive } from '../support/mock-drive';
import { setFetchMock } from '../support/network';

const ANDROID_ID = 'OpenCloudAndroid';
const ANDROID_REDIRECT = 'oc://android.opencloud.eu';
const ACCESS_AUD = 'cf-access-test-aud';
const ACCESS_TEAM = 'https://access-test.cloudflareaccess.com';
const encoder = new TextEncoder();

interface KeyFixture {
    privateKey: CryptoKey;
    pkcs8Pem: string;
    publicJwk: JsonWebKey;
}

let signingFixture: KeyFixture;
let accessFixture: KeyFixture;

async function createRsaFixture(): Promise<KeyFixture> {
    const pair = await crypto.subtle.generateKey(
        {
            name: 'RSASSA-PKCS1-v1_5',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
    ) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
    const b64 = btoa(String.fromCharCode(...pkcs8));
    const lines = b64.match(/.{1,64}/g)?.join('\n') ?? b64;
    const pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
    return { privateKey: pair.privateKey, pkcs8Pem, publicJwk };
}

async function signJwt(privateKey: CryptoKey, header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string> {
    const h = base64UrlEncode(encoder.encode(JSON.stringify(header)));
    const p = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
    const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, encoder.encode(`${h}.${p}`));
    return `${h}.${p}.${base64UrlEncode(new Uint8Array(sig))}`;
}

function oidcBindings(overrides: Record<string, unknown> = {}): Env {
    return {
        ...env,
        CF_ACCESS_AUD: ACCESS_AUD,
        CF_ACCESS_TEAM_DOMAIN: ACCESS_TEAM,
        OIDC_SIGNING_KEY: signingFixture.pkcs8Pem,
        OIDC_SIGNING_KID: 'worker-kid-1',
        ...overrides,
    } as unknown as Env;
}

async function callWorker(bindings: Env, url: string, init: RequestInit = {}): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(url.startsWith('http') ? url : ORIGIN + url, init), bindings, ctx);
    await waitOnExecutionContext(ctx);
    return res;
}

function installFetchRouter(drive?: MockDrive): void {
    setFetchMock(async (input, init) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (url.origin === ACCESS_TEAM && url.pathname === '/cdn-cgi/access/certs') {
            return new Response(JSON.stringify({
                keys: [{ ...accessFixture.publicJwk, kid: 'cf-access-kid-1', alg: 'RS256', use: 'sig' }],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (drive) return drive.handle(input, init);
        throw new Error(`Unexpected external fetch: ${req.url}`);
    });
}

async function issueBearerToken(bindings: Env): Promise<string> {
    const raw = new Uint8Array(32);
    crypto.getRandomValues(raw);
    const verifier = base64UrlEncode(raw);
    const challenge = base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
    const now = Math.floor(Date.now() / 1000);
    const assertion = await signJwt(
        accessFixture.privateKey,
        { alg: 'RS256', kid: 'cf-access-kid-1' },
        {
            iss: ACCESS_TEAM,
            aud: ACCESS_AUD,
            sub: 'cf-sub-alice',
            email: 'alice@example.com',
            name: 'Alice Example',
            iat: now,
            exp: now + 600,
        },
    );

    const authUrl = new URL(ORIGIN + '/oauth/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', ANDROID_ID);
    authUrl.searchParams.set('redirect_uri', ANDROID_REDIRECT);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', 'st-discovery');
    authUrl.searchParams.set('scope', 'openid offline_access email profile');

    const authRes = await callWorker(bindings, authUrl.toString(), {
        headers: { 'Cf-Access-Jwt-Assertion': assertion },
    });
    expect(authRes.status).toBe(302);
    const code = new URL(authRes.headers.get('Location')!).searchParams.get('code')!;

    const tokenRes = await callWorker(bindings, '/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: ANDROID_ID,
            code,
            redirect_uri: ANDROID_REDIRECT,
            code_verifier: verifier,
        }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const data = await tokenRes.json<{ access_token: string }>();
    return data.access_token;
}

beforeAll(async () => {
    [signingFixture, accessFixture] = await Promise.all([createRsaFixture(), createRsaFixture()]);
});

describe('status.php bootstrap discovery', () => {
    it('serves tested oCIS status profile unauthenticated on GET/HEAD without redirects', async () => {
        const fetch = vi.fn(() => { throw new Error('Unexpected external request'); });
        setFetchMock(fetch);

        const getRes = await callWorker({} as Env, '/status.php');
        expect(getRes.status).toBe(200);
        expect(getRes.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
        expect(getRes.headers.get('Cache-Control')).toBe('no-store');
        const body = await getRes.json<Record<string, unknown>>();
        expect(body).toEqual({
            installed: true,
            maintenance: false,
            needsDbUpgrade: false,
            version: '10.11.0.0',
            versionstring: '10.11.0',
            edition: 'Community',
            productname: 'Infinite Scale',
            product: 'Infinite Scale',
            productversion: '8.2.3',
        });
        expect(body.version).not.toBe(pkg.version);
        expect(body.productversion).not.toBe(pkg.version);

        const headRes = await callWorker(env, '/status.php', { method: 'HEAD' });
        expect(headRes.status).toBe(200);
        expect(await headRes.text()).toBe('');

        const postRes = await callWorker(env, '/status.php', { method: 'POST' });
        expect(postRes.status).toBe(405);
        expect(postRes.headers.get('Allow')).toBe('GET, HEAD');

        const badConfigRes = await callWorker({ ...env, WEBDAV_PATH: '/status.php' } as Env, '/status.php');
        expect(badConfigRes.status).toBe(500);
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('OCS v1/v2 cloud user and capabilities', () => {
    it.each<[1 | 2, string, Record<string, string>, 'json' | 'xml']>([
        [1, '?format=json', { 'OCS-APIRequest': 'true' }, 'json'],
        [2, '?format=json', {}, 'json'],
        [1, '?format=xml', { 'OCS-APIRequest': 'true' }, 'xml'],
        [2, '', { Accept: 'application/json' }, 'json'],
        [1, '', { Accept: 'application/xml' }, 'xml'],
        [2, '', {}, 'xml'],
    ])('serves /ocs/v%i.php/cloud/{user,capabilities}%s (%s)', async (version, query, extraHeaders, expectedFormat) => {
        installFetchRouter();
        const bindings = oidcBindings();
        const token = await issueBearerToken(bindings);

        // Unauthenticated requests challenge with Bearer
        const unauth = await callWorker(bindings, `/ocs/v${version}.php/cloud/user${query}`);
        expect(unauth.status).toBe(401);
        expect(unauth.headers.get('WWW-Authenticate')).toContain('Bearer ');

        // Basic & Bearer principals both resolve cleanly without Drive calls
        for (const [kind, authHeader] of [
            ['basic', AUTH.Authorization],
            ['bearer', `Bearer ${token}`],
        ] as const) {
            const userRes = await callWorker(bindings, `/ocs/v${version}.php/cloud/user${query}`, {
                headers: { Authorization: authHeader, ...extraHeaders },
            });
            expect(userRes.status).toBe(200);
            expect(userRes.headers.get('Ocs-Api-Version')).toBe(String(version));
            expect(userRes.headers.get('Content-Type')).toBe(
                expectedFormat === 'json' ? 'application/json; charset=utf-8' : 'application/xml; charset=utf-8',
            );

            const expectedStatus = version === 1 ? 100 : 200;
            const userText = await userRes.text();
            if (expectedFormat === 'json') {
                const json = JSON.parse(userText);
                expect(json.ocs.meta).toEqual({ status: 'ok', statuscode: expectedStatus, message: 'OK' });
                if (kind === 'basic') {
                    expect(json.ocs.data).toEqual({ id: 'test', 'display-name': 'test' });
                } else {
                    expect(json.ocs.data).toEqual({
                        id: 'alice@example.com',
                        'display-name': 'Alice Example',
                        email: 'alice@example.com',
                    });
                }
            } else {
                const doc = new DOMParser().parseFromString(userText, 'application/xml');
                expect(doc.getElementsByTagName('statuscode')[0]?.textContent).toBe(String(expectedStatus));
                expect(doc.getElementsByTagName('id')[0]?.textContent).toBe(kind === 'basic' ? 'test' : 'alice@example.com');
                expect(doc.getElementsByTagName('display-name')[0]?.textContent).toBe(kind === 'basic' ? 'test' : 'Alice Example');
            }
        }

        const capRes = await callWorker(bindings, `/ocs/v${version}.php/cloud/capabilities${query}`, {
            headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
        });
        expect(capRes.status).toBe(200);
        expect(capRes.headers.get('Ocs-Api-Version')).toBe(String(version));
        const capText = await capRes.text();
        if (expectedFormat === 'json') {
            const { ocs } = JSON.parse(capText);
            expect(ocs.meta.statuscode).toBe(version === 1 ? 100 : 200);
            const caps = ocs.data.capabilities;
            expect(caps.core.pollinterval).toBe(30000);
            expect(caps.core['webdav-root']).toBe('webdav');
            expect(caps.core.status.productversion).toBe('8.2.3');
            expect(caps.checksums).toEqual({
                supportedTypes: ['sha1', 'md5', 'sha256'],
                preferredUploadType: 'sha1',
            });
            expect(caps.files.tus_support).toEqual({
                version: '1.0.0',
                resumable: '1.0.0',
                extension: 'creation,creation-with-upload',
                max_chunk_size: 10485760,
                http_method_override: '',
            });
            expect(caps.files_sharing).toEqual({
                api_enabled: false,
                resharing: false,
                public: { enabled: false },
                user: { profile_picture: false },
            });
            expect(caps.spaces).toEqual({
                version: '1.0.0',
                enabled: true,
                projects: false,
                share_jail: false,
                has_multiple_personal_spaces: false,
            });
            expect(caps.notifications).toBeUndefined();
            expect(caps.files.archivers).toBeUndefined();
            expect(caps.files.app_providers).toBeUndefined();
            expect(ocs.data.version.productversion).toBe('8.2.3');
        } else {
            const doc = new DOMParser().parseFromString(capText, 'application/xml');
            expect(doc.getElementsByTagName('pollinterval')[0]?.textContent).toBe('30000');
            expect(doc.getElementsByTagName('webdav-root')[0]?.textContent).toBe('webdav');
            expect(doc.getElementsByTagName('max_chunk_size')[0]?.textContent).toBe('10485760');
            expect(doc.getElementsByTagName('projects')[0]?.textContent).toBe('false');
            expect(Array.from(doc.getElementsByTagName('supportedTypes')[0]!.getElementsByTagName('element')).map(n => n.textContent))
                .toEqual(['sha1', 'md5', 'sha256']);
        }
    });

    it('enforces methods and valid format query parameters on OCS endpoints', async () => {
        const postRes = await callWorker(env, '/ocs/v2.php/cloud/capabilities', { method: 'POST', headers: AUTH });
        expect(postRes.status).toBe(405);
        expect(postRes.headers.get('Allow')).toBe('GET, HEAD');

        const badFormat = await callWorker(env, '/ocs/v2.php/cloud/user?format=yaml', { headers: AUTH });
        expect(badFormat.status).toBe(400);
    });
});

describe('remote.php discovery and auth probes', () => {
    it('returns 401 Bearer challenge on unauthenticated /remote.php/webdav/ and 204 on authenticated OPTIONS', async () => {
        installFetchRouter();
        const dual = oidcBindings();
        const token = await issueBearerToken(dual);

        // Dual mode (OIDC + USERS): Bearer advertised first
        const dualUnauth = await callWorker(dual, '/remote.php/webdav/', { method: 'PROPFIND' });
        expect(dualUnauth.status).toBe(401);
        const dualChallenge = dualUnauth.headers.get('WWW-Authenticate') ?? '';
        expect(dualChallenge).toContain('Bearer ');
        expect(dualChallenge).toContain('Basic ');
        expect(dualChallenge.indexOf('Bearer ')).toBeLessThan(dualChallenge.indexOf('Basic '));

        // OIDC-only mode
        const oidcOnlyUnauth = await callWorker(oidcBindings({ USERS: '' }), '/remote.php/webdav/', { method: 'PROPFIND' });
        expect(oidcOnlyUnauth.status).toBe(401);
        expect(oidcOnlyUnauth.headers.get('WWW-Authenticate')).toContain('Bearer ');
        expect(oidcOnlyUnauth.headers.get('WWW-Authenticate')).not.toContain('Basic ');

        // Basic-only mode (no OIDC)
        const basicOnlyUnauth = await callWorker(env, '/remote.php/webdav/', { method: 'PROPFIND' });
        expect(basicOnlyUnauth.status).toBe(401);
        expect(basicOnlyUnauth.headers.get('WWW-Authenticate')).toContain('Basic ');

        // Authenticated OPTIONS works with or without trailing slash and returns 204
        for (const [path, authHeader] of [
            ['/remote.php/webdav', AUTH.Authorization],
            ['/remote.php/webdav/', `Bearer ${token}`],
        ]) {
            const optRes = await callWorker(dual, path, { method: 'OPTIONS', headers: { Authorization: authHeader } });
            expect(optRes.status).toBe(204);
            expect(optRes.headers.get('DAV')).toBe('1');
            expect(optRes.headers.get('Tus-Version')).toBe('1.0.0');
            expect(optRes.headers.get('Tus-Resumable')).toBe('1.0.0');
            const allow = optRes.headers.get('Allow')!.split(',').map(m => m.trim());
            expect(allow).not.toContain('LOCK');
            expect(allow).not.toContain('UNLOCK');
            expect(allow).not.toContain('PATCH');
        }

        // Cyberduck Personal probe preserves auth gate + 404 fallback
        expect((await callWorker(dual, '/remote.php/dav/files/test/Personal/', { method: 'HEAD' })).status).toBe(401);
        expect((await callWorker(dual, '/remote.php/dav/files/test/Personal/', { method: 'HEAD', headers: AUTH })).status).toBe(404);
        expect((await callWorker(dual, '/remote.php/dav/files/test/%zz', { method: 'HEAD', headers: AUTH })).status).toBe(400);
    });
});

describe('Graph /graph/v1.0/me/drives personal Space', () => {
    it('returns one personal Space for Basic and Bearer principals against shared ROOT_ID', async () => {
        const drive = new MockDrive();
        installFetchRouter(drive);
        const bindings = oidcBindings();
        const token = await issueBearerToken(bindings);

        expect((await callWorker(bindings, '/graph/v1.0/me/drives')).status).toBe(401);
        const postRes = await callWorker(bindings, '/graph/v1.0/me/drives', { method: 'POST', headers: AUTH });
        expect(postRes.status).toBe(405);

        for (const authHeader of [AUTH.Authorization, `Bearer ${token}`]) {
            const res = await callWorker(bindings, '/graph/v1.0/me/drives', { headers: { Authorization: authHeader } });
            expect(res.status).toBe(200);
            expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
            const body = await res.json<{ value: Array<Record<string, any>> }>();
            expect(body.value).toHaveLength(1);
            const [space] = body.value;
            expect(space.id).toBe('personal$root');
            expect(space.driveType).toBe('personal');
            expect(space.name).toBe('Personal');
            expect(space.eTag).toMatch(/^".+"$/);
            expect(space.root.id).toBe(space.id);
            expect(space.root.eTag).toBe(space.eTag);
            expect(space.root.webDavUrl).toBe(`${ORIGIN}/dav/spaces/personal$root`);
            expect(space.owner).toBeUndefined();
            expect(space.special).toBeUndefined();
            expect(space.quota).toEqual({
                remaining: 1073737728,
                state: 'normal',
                total: 1073741824,
                used: 4096,
            });
        }

        const headRes = await callWorker(bindings, '/graph/v1.0/me/drives', { method: 'HEAD', headers: AUTH });
        expect(headRes.status).toBe(200);
        expect(await headRes.text()).toBe('');
    });

    it('uses PUBLIC_ORIGIN over untrusted Host/http headers and rejects plain http without PUBLIC_ORIGIN', async () => {
        const drive = new MockDrive();
        installFetchRouter(drive);

        expect((await callWorker(env, 'http://example.com/graph/v1.0/me/drives', { headers: AUTH })).status).toBe(400);

        const withPublic = { ...env, PUBLIC_ORIGIN: 'https://files.example.org' } as Env;
        const res = await callWorker(withPublic, 'http://internal.local/graph/v1.0/me/drives', {
            headers: { ...AUTH, Host: 'evil.example', 'X-Forwarded-Host': 'evil.example' },
        });
        expect(res.status).toBe(200);
        const body = await res.json<{ value: Array<{ root: { webDavUrl: string } }> }>();
        expect(body.value[0].root.webDavUrl).toBe('https://files.example.org/dav/spaces/personal$root');
    });

    it('supports custom ROOT_ID folders and rejects non-folder ROOT_ID or missing Drive config', async () => {
        const drive = new MockDrive();
        drive.add({ id: 'space-folder', name: 'Workspace', mimeType: FOLDER, parents: ['root'] });
        drive.add({ id: 'not-a-folder', name: 'file.txt', mimeType: 'text/plain', size: 3, parents: ['root'] });
        installFetchRouter(drive);

        const customRes = await callWorker({ ...env, ROOT_ID: 'space-folder' } as Env, '/graph/v1.0/me/drives', { headers: AUTH });
        expect(customRes.status).toBe(200);
        const customBody = await customRes.json<{ value: Array<Record<string, any>> }>();
        expect(customBody.value[0].id).toBe('personal$space-folder');
        expect(customBody.value[0].eTag).toMatch(/^"space-folder-[0-9a-f]{8}-1"$/);
        expect(customBody.value[0].root.eTag).toBe(customBody.value[0].eTag);
        expect(customBody.value[0].root.webDavUrl).toBe(`${ORIGIN}/dav/spaces/personal$space-folder`);

        const nonFolder = await callWorker({ ...env, ROOT_ID: 'not-a-folder' } as Env, '/graph/v1.0/me/drives', { headers: AUTH });
        expect(nonFolder.status).toBe(500);

        const missingRoot = await callWorker({ ...env, ROOT_ID: 'missing-folder' } as Env, '/graph/v1.0/me/drives', { headers: AUTH });
        expect(missingRoot.status).toBe(404);

        const missingCreds = await callWorker({ ...env, CLIENT_ID: '' } as Env, '/graph/v1.0/me/drives', { headers: AUTH });
        expect(missingCreds.status).toBe(500);
    });

    it.each<[
        { status: number; body: Record<string, unknown> },
        string[] | 'omitted',
    ]>([
        [
            { status: 200, body: { storageQuota: { limit: '9223372036854775807', usage: '9007199254740993' } } },
            ['"total":9223372036854775807', '"used":9007199254740993', '"remaining":9214364837600034814', '"state":"normal"'],
        ],
        [
            { status: 200, body: { storageQuota: { limit: '1024', usage: '4096' } } },
            ['"total":1024', '"used":4096', '"remaining":0', '"state":"exceeded"'],
        ],
        [{ status: 200, body: { storageQuota: { usage: '4096' } } }, 'omitted'],
        [{ status: 200, body: { storageQuota: { limit: '1024' } } }, 'omitted'],
        [{ status: 500, body: { error: { message: 'about unavailable' } } }, 'omitted'],
    ])('handles Drive storageQuota shape %j accurately', async (aboutMock, expectedFragments) => {
        const drive = new MockDrive();
        const original = drive.handle.bind(drive);
        setFetchMock(async (input, init) => {
            if (String(input).includes('/drive/v3/about?')) {
                return new Response(JSON.stringify(aboutMock.body), {
                    status: aboutMock.status,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return original(input, init);
        });

        const res = await callWorker(env, '/graph/v1.0/me/drives', { headers: AUTH });
        expect(res.status).toBe(200);
        const text = await res.text();
        if (expectedFragments === 'omitted') {
            expect(JSON.parse(text).value[0].quota).toBeUndefined();
        } else {
            for (const fragment of expectedFragments) {
                expect(text).toContain(fragment);
            }
        }
    });
});
