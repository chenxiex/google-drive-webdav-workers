import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { base64UrlDecode, base64UrlEncode } from '../../src/auth/jwt';
import { AUTH, ORIGIN, basic } from '../support/client';
import { MockDrive } from '../support/mock-drive';
import { setFetchMock } from '../support/network';
import { generateRsaPair } from '../support/rsa';
import { invokeWorker as callWorker } from '../support/worker';

const DESKTOP_ID = 'xdXOt13JKxym1B1QcEncf2XDkLAexMBFwiT9j6EfhhHFJhs2KM9jbjTmf8JBXE69';
const DESKTOP_SECRET = 'UBntmLjC2yYCeHwsyj73Uwo9TAaecAetRwMw0xYcvNL9yRdLSUi0hUAHfvCHFeFh';
const DESKTOP_REDIRECT = 'http://127.0.0.1:41234';
const ANDROID_ID = 'OpenCloudAndroid';
const ANDROID_REDIRECT = 'oc://android.opencloud.eu';
const ACCESS_AUD = 'cf-access-test-aud';
const ACCESS_TEAM = 'https://access-test.cloudflareaccess.com';

const encoder = new TextEncoder();

let signingFixture: Awaited<ReturnType<typeof generateRsaPair>>;
let accessFixture: Awaited<ReturnType<typeof generateRsaPair>>;

async function signJwt(privateKey: CryptoKey, header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string> {
    const h = base64UrlEncode(encoder.encode(JSON.stringify(header)));
    const p = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
    const sig = await crypto.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        privateKey,
        encoder.encode(`${h}.${p}`),
    );
    return `${h}.${p}.${base64UrlEncode(new Uint8Array(sig))}`;
}

async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
    const raw = new Uint8Array(32);
    crypto.getRandomValues(raw);
    const verifier = base64UrlEncode(raw);
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
    return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

function makeAccessAssertion(overrides: Record<string, unknown> = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return signJwt(
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
            ...overrides,
        },
    );
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

function installFetchRouter(drive?: MockDrive): void {
    setFetchMock(async (input, init) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (url.origin === ACCESS_TEAM && url.pathname === '/cdn-cgi/access/certs') {
            return new Response(JSON.stringify({
                keys: [{ ...accessFixture.publicJwk, kid: 'cf-access-kid-1', alg: 'RS256', use: 'sig' }],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (drive) {
            return drive.handle(input, init);
        }
        throw new Error(`Unexpected external fetch: ${req.url}`);
    });
}

async function authorizeAndExchange(
    bindings: Env,
    options: {
        clientId: string;
        redirectUri: string;
        clientSecret?: string;
        authMethod?: 'basic' | 'post' | 'none';
        scope?: string;
        nonce?: string;
        assertionOverrides?: Record<string, unknown>;
    },
): Promise<{
    tokens: {
        access_token: string;
        refresh_token: string;
        token_type: string;
        expires_in: number;
        scope: string;
        id_token: string;
    };
    code: string;
    verifier: string;
}> {
    const { verifier, challenge } = await createPkcePair();
    const assertion = await makeAccessAssertion(options.assertionOverrides);
    const state = 'st-' + crypto.randomUUID();

    const authUrl = new URL(ORIGIN + '/oauth/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', options.clientId);
    authUrl.searchParams.set('redirect_uri', options.redirectUri);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    if (options.scope) authUrl.searchParams.set('scope', options.scope);
    if (options.nonce) authUrl.searchParams.set('nonce', options.nonce);

    const authRes = await callWorker(bindings, authUrl.toString(), {
        headers: { 'Cf-Access-Jwt-Assertion': assertion },
    });
    expect(authRes.status).toBe(302);
    const callback = new URL(authRes.headers.get('Location')!);
    expect(callback.searchParams.get('state')).toBe(state);
    const code = callback.searchParams.get('code')!;
    expect(code).toBeTruthy();

    const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: options.redirectUri,
        code_verifier: verifier,
    });
    const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (options.authMethod === 'basic') {
        headers.Authorization = basic(options.clientId, options.clientSecret ?? '');
    } else if (options.authMethod === 'post') {
        form.set('client_id', options.clientId);
        form.set('client_secret', options.clientSecret ?? '');
    } else {
        form.set('client_id', options.clientId);
    }

    const tokenRes = await callWorker(bindings, '/oauth/token', {
        method: 'POST',
        headers,
        body: form.toString(),
    });
    expect(tokenRes.status).toBe(200);
    return { tokens: await tokenRes.json(), code, verifier };
}

beforeAll(async () => {
    [signingFixture, accessFixture] = await Promise.all([generateRsaPair(), generateRsaPair()]);
});

describe('OIDC auto-activation and config boundaries', () => {
    it('disables OIDC/OAuth when Access config is absent while keeping WebFinger 404', async () => {
        for (const path of [
            '/.well-known/webfinger?resource=acct:alice@example.com',
            '/.well-known/openid-configuration',
            '/oauth/authorize',
            '/oauth/token',
            '/oauth/userinfo',
            '/oauth/jwks',
            '/oauth/revoke',
        ]) {
            expect((await SELF.fetch(ORIGIN + path)).status).toBe(404);
        }

        const davUnauth = await SELF.fetch(ORIGIN + '/webdav/', { method: 'PROPFIND' });
        expect(davUnauth.status).toBe(401);
        expect(davUnauth.headers.get('WWW-Authenticate')).toContain('Basic ');
        expect(davUnauth.headers.get('WWW-Authenticate')).not.toContain('Bearer ');

        const bearerRejected = await SELF.fetch(ORIGIN + '/webdav/', {
            method: 'PROPFIND',
            headers: { Authorization: 'Bearer fake-token' },
        });
        expect(bearerRejected.status).toBe(401);
    });

    it.each([
        ['missing CF_ACCESS_TEAM_DOMAIN', { CF_ACCESS_AUD: ACCESS_AUD, OIDC_SIGNING_KEY: 'k' }],
        ['missing OIDC_SIGNING_KEY', { CF_ACCESS_AUD: ACCESS_AUD, CF_ACCESS_TEAM_DOMAIN: ACCESS_TEAM }],
        ['missing CF_ACCESS_AUD', { CF_ACCESS_TEAM_DOMAIN: ACCESS_TEAM, OIDC_SIGNING_KEY: 'k' }],
        ['invalid CF_ACCESS_TEAM_DOMAIN', { CF_ACCESS_AUD: ACCESS_AUD, CF_ACCESS_TEAM_DOMAIN: 'http://insecure.example.com', OIDC_SIGNING_KEY: 'k' }],
        ['invalid PUBLIC_ORIGIN', { PUBLIC_ORIGIN: 'https://example.com/subpath' }],
    ])('fails closed with 500 on %s', async (_label, partial) => {
        const res = await callWorker({ ...env, ...partial } as unknown as Env, '/webdav/');
        expect(res.status).toBe(500);
    });

    it('fails with 500 when AUTH_DO is missing while OIDC is enabled', async () => {
        installFetchRouter();
        const bindings = oidcBindings({ AUTH_DO: undefined });
        const { challenge } = await createPkcePair();
        const url = `/oauth/authorize?response_type=code&client_id=${ANDROID_ID}&redirect_uri=${encodeURIComponent(ANDROID_REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`;
        const authRes = await callWorker(bindings, url, {
            headers: { 'Cf-Access-Jwt-Assertion': await makeAccessAssertion() },
        });
        expect(authRes.status).toBe(500);

        const davRes = await callWorker(bindings, '/webdav/', {
            headers: { Authorization: 'Bearer some-token' },
        });
        expect(davRes.status).toBe(500);
    });

    it('enforces HTTPS and honors PUBLIC_ORIGIN over Host / X-Forwarded-Host', async () => {
        const bindings = oidcBindings();
        expect((await callWorker(bindings, 'http://example.com/.well-known/openid-configuration')).status).toBe(400);

        const withPublic = oidcBindings({ PUBLIC_ORIGIN: 'https://files.example.org' });
        const res = await callWorker(withPublic, 'http://internal.local/.well-known/openid-configuration', {
            headers: { Host: 'evil.example', 'X-Forwarded-Host': 'evil.example' },
        });
        expect(res.status).toBe(200);
        const doc = await res.json<Record<string, unknown>>();
        expect(doc.issuer).toBe('https://files.example.org');
        expect(doc.authorization_endpoint).toBe('https://files.example.org/oauth/authorize');
    });
});

describe('OIDC discovery, JWKS, authorize, token, and userinfo', () => {
    it('serves oCIS-compatible discovery without registration_endpoint and public-only JWKS', async () => {
        const bindings = oidcBindings();
        expect((await callWorker(bindings, '/.well-known/webfinger?resource=acct:alice@example.com')).status).toBe(404);

        const discRes = await callWorker(bindings, '/.well-known/openid-configuration');
        expect(discRes.status).toBe(200);
        expect(discRes.headers.get('Content-Type')).toContain('application/json');
        const disc = await discRes.json<Record<string, unknown>>();
        expect(disc).toEqual({
            issuer: ORIGIN,
            authorization_endpoint: `${ORIGIN}/oauth/authorize`,
            token_endpoint: `${ORIGIN}/oauth/token`,
            userinfo_endpoint: `${ORIGIN}/oauth/userinfo`,
            revocation_endpoint: `${ORIGIN}/oauth/revoke`,
            jwks_uri: `${ORIGIN}/oauth/jwks`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            scopes_supported: ['openid', 'offline_access', 'email', 'profile'],
            token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
        });
        expect(disc).not.toHaveProperty('registration_endpoint');

        const jwksRes = await callWorker(bindings, '/oauth/jwks');
        expect(jwksRes.status).toBe(200);
        const jwks = await jwksRes.json<{ keys: Array<Record<string, unknown>> }>();
        expect(jwks.keys).toHaveLength(1);
        expect(Object.keys(jwks.keys[0]).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
        expect(jwks.keys[0]).toMatchObject({ kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'worker-kid-1' });
    });

    it('rejects unauthenticated or unallowlisted /oauth/authorize without redirecting and redirects PKCE errors', async () => {
        installFetchRouter();
        const bindings = oidcBindings();
        const { challenge } = await createPkcePair();

        // Missing Access assertion -> 401
        expect((await callWorker(
            bindings,
            `/oauth/authorize?response_type=code&client_id=${DESKTOP_ID}&redirect_uri=${encodeURIComponent(DESKTOP_REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`,
        )).status).toBe(401);

        const assertion = await makeAccessAssertion();

        // Unallowlisted redirect_uri -> 400 JSON, no Location header
        const badRedirect = await callWorker(
            bindings,
            `/oauth/authorize?response_type=code&client_id=${DESKTOP_ID}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=${challenge}&code_challenge_method=S256`,
            { headers: { 'Cf-Access-Jwt-Assertion': assertion } },
        );
        expect(badRedirect.status).toBe(400);
        expect(badRedirect.headers.has('Location')).toBe(false);

        // Unknown client -> 400 JSON
        expect((await callWorker(
            bindings,
            `/oauth/authorize?response_type=code&client_id=bogus&redirect_uri=${encodeURIComponent(DESKTOP_REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`,
            { headers: { 'Cf-Access-Jwt-Assertion': assertion } },
        )).status).toBe(400);

        // Allowlisted redirect + bad PKCE method -> 302 error redirect preserving state
        const badPkce = await callWorker(
            bindings,
            `/oauth/authorize?response_type=code&client_id=${DESKTOP_ID}&redirect_uri=${encodeURIComponent(DESKTOP_REDIRECT)}&code_challenge=${challenge}&code_challenge_method=plain&state=s123`,
            { headers: { 'Cf-Access-Jwt-Assertion': assertion } },
        );
        expect(badPkce.status).toBe(302);
        const location = new URL(badPkce.headers.get('Location')!);
        expect(location.searchParams.get('error')).toBe('invalid_request');
        expect(location.searchParams.get('state')).toBe('s123');
    });

    it('completes Desktop Basic-auth flow with a verifiable RS256 ID token, single-use code, and userinfo', async () => {
        installFetchRouter();
        const bindings = oidcBindings();
        const nonce = 'nonce-' + crypto.randomUUID();
        const { tokens, code, verifier } = await authorizeAndExchange(bindings, {
            clientId: DESKTOP_ID,
            redirectUri: DESKTOP_REDIRECT,
            clientSecret: DESKTOP_SECRET,
            authMethod: 'basic',
            scope: 'openid offline_access email profile',
            nonce,
        });

        expect(tokens.token_type).toBe('Bearer');
        expect(tokens.expires_in).toBe(3600);
        expect(tokens.scope).toBe('openid offline_access email profile');
        expect(tokens.access_token).toBeTruthy();
        expect(tokens.refresh_token).toBeTruthy();

        const jwks = await (await callWorker(bindings, '/oauth/jwks')).json<{ keys: JsonWebKey[] }>();
        const [h, p, s] = tokens.id_token.split('.');
        const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(h)));
        const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(p)));
        expect(header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'worker-kid-1' });
        expect(payload).toMatchObject({
            iss: ORIGIN,
            sub: 'cf-sub-alice',
            aud: DESKTOP_ID,
            preferred_username: 'alice@example.com',
            email: 'alice@example.com',
            name: 'Alice Example',
            nonce,
        });
        const verifyKey = await crypto.subtle.importKey(
            'jwk',
            jwks.keys[0],
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify'],
        );
        expect(await crypto.subtle.verify(
            { name: 'RSASSA-PKCS1-v1_5' },
            verifyKey,
            base64UrlDecode(s),
            encoder.encode(`${h}.${p}`),
        )).toBe(true);

        // Single-use code replay rejected
        const replay = await callWorker(bindings, '/oauth/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: basic(DESKTOP_ID, DESKTOP_SECRET),
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: DESKTOP_REDIRECT,
                code_verifier: verifier,
            }).toString(),
        });
        expect(replay.status).toBe(400);
        expect((await replay.json<{ error: string }>()).error).toBe('invalid_grant');

        // UserInfo
        const userinfo = await callWorker(bindings, '/oauth/userinfo', {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        expect(userinfo.status).toBe(200);
        expect(await userinfo.json()).toEqual({
            sub: 'cf-sub-alice',
            preferred_username: 'alice@example.com',
            email: 'alice@example.com',
            name: 'Alice Example',
        });

        expect((await callWorker(bindings, '/oauth/userinfo')).status).toBe(401);
        expect((await callWorker(bindings, '/oauth/userinfo', {
            headers: { Authorization: 'Bearer unknown-token' },
        })).status).toBe(401);
    });

    it('issues Desktop tokens with client credentials in the form body', async () => {
        installFetchRouter();
        const { tokens } = await authorizeAndExchange(oidcBindings(), {
            clientId: DESKTOP_ID,
            redirectUri: DESKTOP_REDIRECT,
            clientSecret: DESKTOP_SECRET,
            authMethod: 'post',
            scope: 'openid offline_access',
        });
        expect(tokens).toMatchObject({
            access_token: expect.any(String),
            refresh_token: expect.any(String),
            id_token: expect.any(String),
            scope: 'openid offline_access',
        });
    });

    it('completes Android public client flow (none + PKCE) and burns code on failed verifier', async () => {
        installFetchRouter();
        const bindings = oidcBindings();
        const { tokens } = await authorizeAndExchange(bindings, {
            clientId: ANDROID_ID,
            redirectUri: ANDROID_REDIRECT,
            authMethod: 'none',
            scope: 'openid offline_access email profile',
        });
        expect(Number.isInteger(tokens.expires_in)).toBe(true);
        const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(tokens.id_token.split('.')[1])));
        expect(payload.aud).toBe(ANDROID_ID);
        expect(payload.preferred_username).toBe('alice@example.com');

        // Non-empty secret rejected for public client
        const rejectSecret = await callWorker(bindings, '/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: ANDROID_ID,
                client_secret: 'not-allowed',
                refresh_token: tokens.refresh_token,
            }).toString(),
        });
        expect(rejectSecret.status).toBe(401);

        // Failed PKCE burns single-use code so a subsequent valid exchange fails
        const { verifier, challenge } = await createPkcePair();
        const authRes = await callWorker(
            bindings,
            `/oauth/authorize?response_type=code&client_id=${ANDROID_ID}&redirect_uri=${encodeURIComponent(ANDROID_REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`,
            { headers: { 'Cf-Access-Jwt-Assertion': await makeAccessAssertion() } },
        );
        const code = new URL(authRes.headers.get('Location')!).searchParams.get('code')!;

        const badAttempt = await callWorker(bindings, '/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: ANDROID_ID,
                code,
                redirect_uri: ANDROID_REDIRECT,
                code_verifier: 'wrong-' + verifier.slice(6),
            }).toString(),
        });
        expect(badAttempt.status).toBe(400);

        const secondAttempt = await callWorker(bindings, '/oauth/token', {
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
        expect(secondAttempt.status).toBe(400);
    });

    it('supports reusable refresh_token, revocation, and deterministic DO expiration', async () => {
        installFetchRouter();
        const bindings = oidcBindings();
        const { tokens } = await authorizeAndExchange(bindings, {
            clientId: DESKTOP_ID,
            redirectUri: DESKTOP_REDIRECT,
            clientSecret: DESKTOP_SECRET,
            authMethod: 'basic',
            scope: 'openid offline_access email profile',
        });

        // Two refreshes with the same refresh_token both succeed
        for (const scope of [undefined, 'openid email']) {
            const body = new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: tokens.refresh_token,
                ...(scope ? { scope } : {}),
            });
            const refreshRes = await callWorker(bindings, '/oauth/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Authorization: basic(DESKTOP_ID, DESKTOP_SECRET),
                },
                body: body.toString(),
            });
            expect(refreshRes.status).toBe(200);
            const refreshed = await refreshRes.json<Record<string, unknown>>();
            expect(refreshed.refresh_token).toBe(tokens.refresh_token);
            expect(refreshed.expires_in).toBe(3600);
            if (scope) expect(refreshed.scope).toBe(scope);
        }

        // Cross-client refresh rejected
        const crossClient = await callWorker(bindings, '/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: ANDROID_ID,
                refresh_token: tokens.refresh_token,
            }).toString(),
        });
        expect(crossClient.status).toBe(400);

        // Expire an issued access token deterministically in SQLite and verify 401 + alarm cleanup
        const storeStub = bindings.AUTH_DO!.get(bindings.AUTH_DO!.idFromName('default'));
        await runInDurableObject(storeStub, async (instance, state) => {
            state.storage.sql.exec('UPDATE access_tokens SET expires_at = ?', Date.now() - 1000);
            await instance.alarm();
            expect(state.storage.sql.exec<{ c: number }>('SELECT COUNT(*) AS c FROM access_tokens').one().c).toBe(0);
        });
        expect((await callWorker(bindings, '/oauth/userinfo', {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        })).status).toBe(401);

        // Mint a fresh access token via refresh, then revoke the refresh token
        const freshRes = await callWorker(bindings, '/oauth/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: basic(DESKTOP_ID, DESKTOP_SECRET),
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: tokens.refresh_token,
            }).toString(),
        });
        const freshAccess = (await freshRes.json<{ access_token: string }>()).access_token;
        expect((await callWorker(bindings, '/oauth/userinfo', {
            headers: { Authorization: `Bearer ${freshAccess}` },
        })).status).toBe(200);

        const revokeRes = await callWorker(bindings, '/oauth/revoke', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: basic(DESKTOP_ID, DESKTOP_SECRET),
            },
            body: new URLSearchParams({ token: tokens.refresh_token }).toString(),
        });
        expect(revokeRes.status).toBe(200);

        // Both refresh token and derived access token are now invalid
        expect((await callWorker(bindings, '/oauth/userinfo', {
            headers: { Authorization: `Bearer ${freshAccess}` },
        })).status).toBe(401);
        expect((await callWorker(bindings, '/oauth/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: basic(DESKTOP_ID, DESKTOP_SECRET),
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: tokens.refresh_token,
            }).toString(),
        })).status).toBe(400);
    });
});

describe('WebDAV Bearer authentication and shared ROOT_ID', () => {
    it('allows Bearer auth alongside Basic and in OIDC-only mode with isolated TUS owners', async () => {
        const drive = new MockDrive();
        drive.add({ id: 'file-shared', name: 'shared.txt', mimeType: 'text/plain', size: 5, content: new TextEncoder().encode('hello'), parents: ['root'] });
        installFetchRouter(drive);

        const dualBindings = oidcBindings();
        const unauth = await callWorker(dualBindings, '/webdav/', { method: 'PROPFIND' });
        expect(unauth.status).toBe(401);
        const challenges = unauth.headers.get('WWW-Authenticate') ?? '';
        expect(challenges).toContain('Basic ');
        expect(challenges).toContain('Bearer ');

        const { tokens } = await authorizeAndExchange(dualBindings, {
            clientId: ANDROID_ID,
            redirectUri: ANDROID_REDIRECT,
            authMethod: 'none',
            scope: 'openid offline_access email profile',
        });

        // Both Basic and Bearer read the same shared ROOT_ID
        const basicGet = await callWorker(dualBindings, '/webdav/shared.txt', { headers: AUTH });
        expect(basicGet.status).toBe(200);
        expect(await basicGet.text()).toBe('hello');

        const bearerGet = await callWorker(dualBindings, '/webdav/shared.txt', {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        expect(bearerGet.status).toBe(200);
        expect(await bearerGet.text()).toBe('hello');

        // OIDC-only mode (empty USERS) works via Bearer and advertises Bearer only
        const oidcOnlyBindings = oidcBindings({ USERS: '' });
        const oidcOnlyUnauth = await callWorker(oidcOnlyBindings, '/webdav/', { method: 'PROPFIND' });
        expect(oidcOnlyUnauth.status).toBe(401);
        expect(oidcOnlyUnauth.headers.get('WWW-Authenticate')).toContain('Bearer ');
        expect(oidcOnlyUnauth.headers.get('WWW-Authenticate')).not.toContain('Basic ');

        const oidcOnlyGet = await callWorker(oidcOnlyBindings, '/webdav/shared.txt', {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        expect(oidcOnlyGet.status).toBe(200);
        expect(await oidcOnlyGet.text()).toBe('hello');

        // TUS sessions are isolated between Basic and Bearer owners
        const tusCreate = await callWorker(dualBindings, '/webdav/', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${tokens.access_token}`,
                'Tus-Resumable': '1.0.0',
                'Upload-Length': '4',
                'Upload-Metadata': 'filename ' + btoa('bearer-upload.bin'),
            },
        });
        expect(tusCreate.status).toBe(201);
        const tusLocation = tusCreate.headers.get('Location')!;

        const otherOwnerHead = await callWorker(dualBindings, tusLocation, {
            method: 'HEAD',
            headers: { ...AUTH, 'Tus-Resumable': '1.0.0' },
        });
        expect(otherOwnerHead.status).toBe(404);

        const sameOwnerHead = await callWorker(dualBindings, tusLocation, {
            method: 'HEAD',
            headers: { Authorization: `Bearer ${tokens.access_token}`, 'Tus-Resumable': '1.0.0' },
        });
        expect(sameOwnerHead.status).toBe(200);
    });
});
