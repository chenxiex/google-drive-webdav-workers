import { describe, expect, it, vi } from 'vitest';
import {
    authenticateTokenClient,
    getOAuthClient,
    isScopeSubset,
    normalizeRequestedScopes,
} from '../../src/auth/clients';
import {
    base64UrlDecode,
    base64UrlEncode,
    isValidCodeChallenge,
    isValidCodeVerifier,
    loadSigningKey,
    signIdToken,
    verifyCfAccessJwt,
    verifyPkceS256,
} from '../../src/auth/jwt';
import { type OidcConfig } from '../../src/config';
import { StatusError } from '../../src/http';
import { setFetchMock } from '../support/network';

const DESKTOP_ID = 'xdXOt13JKxym1B1QcEncf2XDkLAexMBFwiT9j6EfhhHFJhs2KM9jbjTmf8JBXE69';
const DESKTOP_SECRET = 'UBntmLjC2yYCeHwsyj73Uwo9TAaecAetRwMw0xYcvNL9yRdLSUi0hUAHfvCHFeFh';
const ANDROID_ID = 'OpenCloudAndroid';

const encoder = new TextEncoder();

async function generateRsaPair(): Promise<{
    privateKey: CryptoKey;
    publicKey: CryptoKey;
    pkcs8Pem: string;
    privateJwk: JsonWebKey;
    publicJwk: JsonWebKey;
}> {
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
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
    return { privateKey: pair.privateKey, publicKey: pair.publicKey, pkcs8Pem, privateJwk, publicJwk };
}

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

async function pkceChallenge(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
    return base64UrlEncode(new Uint8Array(digest));
}

describe('PKCE S256', () => {
    it('accepts valid 43-128 char verifiers matching S256 challenges', async () => {
        for (const verifier of [
            'a'.repeat(43),
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'.slice(0, 64),
            'z'.repeat(128),
        ]) {
            const challenge = await pkceChallenge(verifier);
            expect(isValidCodeVerifier(verifier)).toBe(true);
            expect(isValidCodeChallenge(challenge)).toBe(true);
            expect(await verifyPkceS256(verifier, challenge)).toBe(true);
        }
    });

    it.each([
        ['mismatched verifier', 'b'.repeat(43), 'a'.repeat(43)],
        ['too short verifier', 'a'.repeat(42), 'a'.repeat(43)],
        ['too long verifier', 'a'.repeat(129), 'a'.repeat(43)],
        ['illegal verifier char', 'a'.repeat(42) + '+', 'a'.repeat(43)],
        ['short challenge', 'a'.repeat(43), 'a'.repeat(42)],
        ['padded challenge', 'a'.repeat(43), 'a'.repeat(43) + '='],
    ])('rejects %s', async (_label, verifier, challenge) => {
        expect(await verifyPkceS256(verifier, challenge)).toBe(false);
    });
});

describe('OAuth client allowlist and scopes', () => {
    it.each([
        [DESKTOP_ID, 'http://127.0.0.1:1', true],
        [DESKTOP_ID, 'http://127.0.0.1:54321', true],
        [DESKTOP_ID, 'http://127.0.0.1:65535/', true],
        [DESKTOP_ID, 'http://localhost:8080', true],
        [DESKTOP_ID, 'http://localhost:8080/', true],
        [DESKTOP_ID, 'http://127.0.0.1:0', false],
        [DESKTOP_ID, 'http://127.0.0.1:65536', false],
        [DESKTOP_ID, 'http://127.0.0.1:8080/cb', false],
        [DESKTOP_ID, 'http://127.0.0.1:8080?x=1', false],
        [DESKTOP_ID, 'http://127.0.0.1:8080#frag', false],
        [DESKTOP_ID, 'https://127.0.0.1:8080', false],
        [DESKTOP_ID, 'http://127.0.0.1', false],
        [DESKTOP_ID, 'http://127.0.0.2:8080', false],
        [DESKTOP_ID, 'http://localhost.evil.com:8080', false],
        [DESKTOP_ID, 'oc://android.opencloud.eu', false],
        [ANDROID_ID, 'oc://android.opencloud.eu', true],
        [ANDROID_ID, 'oc://android.opencloud.eu/', false],
        [ANDROID_ID, 'oc://android.opencloud.eu/cb', false],
        [ANDROID_ID, 'http://127.0.0.1:8080', false],
    ])('validates redirect_uri for %s (%s -> %s)', (clientId, redirectUri, expected) => {
        const client = getOAuthClient(clientId);
        expect(client).toBeDefined();
        expect(client!.isAllowedRedirectUri(redirectUri)).toBe(expected);
    });

    it('rejects unknown client_id', () => {
        expect(getOAuthClient('unknown-client')).toBeUndefined();
    });

    it('normalizes requested scopes and validates refresh subsets', () => {
        expect(normalizeRequestedScopes(null)).toBe('openid');
        expect(normalizeRequestedScopes('  ')).toBe('openid');
        expect(normalizeRequestedScopes('openid offline_access email unknown openid')).toBe('openid offline_access email');
        expect(normalizeRequestedScopes('profile email')).toBeNull();
        expect(normalizeRequestedScopes('openid\x00profile')).toBeNull();

        expect(isScopeSubset('email openid', 'openid offline_access email profile')).toBe('email openid');
        expect(isScopeSubset('profile', 'openid email')).toBeNull();
        expect(isScopeSubset('   ', 'openid email')).toBeNull();
    });

    it('authenticates Desktop Basic/POST, Android none, and rejects invalid/mixed client auth', () => {
        const basicAuth = 'Basic ' + btoa(`${encodeURIComponent(DESKTOP_ID)}:${encodeURIComponent(DESKTOP_SECRET)}`);
        const basicReq = new Request('https://example.com/oauth/token', {
            method: 'POST',
            headers: { Authorization: basicAuth },
        });
        expect(authenticateTokenClient(basicReq, new URLSearchParams())).toMatchObject({ ok: true, client: { clientId: DESKTOP_ID } });

        const postParams = new URLSearchParams({ client_id: DESKTOP_ID, client_secret: DESKTOP_SECRET });
        expect(authenticateTokenClient(new Request('https://example.com/oauth/token', { method: 'POST' }), postParams))
            .toMatchObject({ ok: true, client: { clientId: DESKTOP_ID } });

        expect(authenticateTokenClient(
            new Request('https://example.com/oauth/token', { method: 'POST' }),
            new URLSearchParams({ client_id: ANDROID_ID }),
        )).toMatchObject({ ok: true, client: { clientId: ANDROID_ID } });

        expect(authenticateTokenClient(
            new Request('https://example.com/oauth/token', { method: 'POST' }),
            new URLSearchParams({ client_id: ANDROID_ID, client_secret: '' }),
        )).toMatchObject({ ok: true, client: { clientId: ANDROID_ID } });

        // Mixed Basic + form client_secret -> 400 invalid_request
        expect(authenticateTokenClient(basicReq, new URLSearchParams({ client_secret: DESKTOP_SECRET })))
            .toMatchObject({ ok: false, status: 400, error: 'invalid_request' });

        // Wrong Desktop secret -> 401 invalid_client
        expect(authenticateTokenClient(
            new Request('https://example.com/oauth/token', { method: 'POST' }),
            new URLSearchParams({ client_id: DESKTOP_ID, client_secret: 'wrong' }),
        )).toMatchObject({ ok: false, status: 401, error: 'invalid_client' });

        // Public client sending secret or Basic header -> 401 invalid_client
        expect(authenticateTokenClient(
            new Request('https://example.com/oauth/token', { method: 'POST' }),
            new URLSearchParams({ client_id: ANDROID_ID, client_secret: 'secret' }),
        )).toMatchObject({ ok: false, status: 401, error: 'invalid_client' });
        expect(authenticateTokenClient(
            new Request('https://example.com/oauth/token', {
                method: 'POST',
                headers: { Authorization: 'Basic ' + btoa(`${ANDROID_ID}:`) },
            }),
            new URLSearchParams(),
        )).toMatchObject({ ok: false, status: 401, error: 'invalid_client' });
    });
});

describe('RS256 signing key and ID token', () => {
    it('loads PKCS#8 PEM (literal/escaped), base64 DER/PEM, and JWK, exposes public JWK only, and signs verifiable JWTs', async () => {
        const pair = await generateRsaPair();
        const escapedPem = pair.pkcs8Pem.replace(/\n/g, '\\n');
        const derBase64 = pair.pkcs8Pem
            .replace('-----BEGIN PRIVATE KEY-----', '')
            .replace('-----END PRIVATE KEY-----', '')
            .replace(/\s+/g, '');
        const b64Pem = btoa(pair.pkcs8Pem);

        const fromPem = await loadSigningKey(pair.pkcs8Pem);
        const fromEscaped = await loadSigningKey(escapedPem);
        const fromDerBase64 = await loadSigningKey(derBase64);
        const fromB64Pem = await loadSigningKey(b64Pem);
        const fromJwk = await loadSigningKey(JSON.stringify(pair.privateJwk));
        const withCustomKid = await loadSigningKey(pair.pkcs8Pem, 'custom-kid-1');

        expect(fromPem.kid).toBe(fromEscaped.kid);
        expect(fromPem.kid).toBe(fromDerBase64.kid);
        expect(fromPem.kid).toBe(fromB64Pem.kid);
        expect(fromPem.kid).toBe(fromJwk.kid);
        expect(withCustomKid.kid).toBe('custom-kid-1');
        expect(fromDerBase64.publicJwk).toEqual(fromPem.publicJwk);
        expect(fromB64Pem.publicJwk).toEqual(fromPem.publicJwk);
        expect(Object.keys(fromPem.publicJwk).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
        expect(fromPem.publicJwk).toMatchObject({ kty: 'RSA', use: 'sig', alg: 'RS256' });

        const jwt = await signIdToken(withCustomKid, {
            iss: 'https://files.example.com',
            sub: 'user-1',
            aud: ANDROID_ID,
            iat: 1700000000,
            exp: 1700003600,
        });
        const [h, p, s] = jwt.split('.');
        const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(h)));
        expect(header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'custom-kid-1' });

        const verifyKey = await crypto.subtle.importKey(
            'jwk',
            withCustomKid.publicJwk,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify'],
        );
        const ok = await crypto.subtle.verify(
            { name: 'RSASSA-PKCS1-v1_5' },
            verifyKey,
            base64UrlDecode(s),
            encoder.encode(`${h}.${p}`),
        );
        expect(ok).toBe(true);
    });

    it('rejects malformed or public-only keys with 500 without leaking key material', async () => {
        const pair = await generateRsaPair();
        const publicOnly = JSON.stringify(pair.publicJwk);
        const sentinel = 'SECRET_SENTINEL_VALUE';
        for (const bad of [
            '',
            'not-a-pem-' + sentinel,
            btoa('not-a-pkcs8-key-' + sentinel),
            '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----',
            publicOnly,
            '{bad-json-' + sentinel,
        ]) {
            await expect(loadSigningKey(bad)).rejects.toMatchObject({ status: 500 });
            try {
                await loadSigningKey(bad);
            } catch (err) {
                expect(err).toBeInstanceOf(StatusError);
                expect((err as Error).message).not.toContain(sentinel);
                expect((err as Error).message).not.toContain(pair.publicJwk.n!);
            }
        }
    });
});

describe('Cloudflare Access JWT verification', () => {
    const baseAud = 'cf-access-aud-123';

    function makeConfig(teamDomain: string): OidcConfig {
        return {
            accessAud: baseAud,
            accessTeamDomain: teamDomain,
            signingKey: 'unused',
        };
    }

    it('verifies valid assertions with string or array aud and handles JWKS key rotation', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        const nowSec = 1_700_000_000;

        const key1 = await generateRsaPair();
        const key2 = await generateRsaPair();
        const teamDomain = 'https://rot-test.cloudflareaccess.com';
        const config = makeConfig(teamDomain);

        let jwksKeys = [{ ...key1.publicJwk, kid: 'kid-1', alg: 'RS256', use: 'sig' }];
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ keys: jwksKeys }), { status: 200 }));
        setFetchMock(fetchMock);

        const jwt1 = await signJwt(
            key1.privateKey,
            { alg: 'RS256', kid: 'kid-1' },
            { iss: teamDomain + '/', aud: [baseAud, 'other'], sub: 'sub-1', email: 'alice@example.com', name: 'Alice', exp: nowSec + 600, iat: nowSec },
        );
        expect(await verifyCfAccessJwt(jwt1, config, nowSec)).toEqual({
            sub: 'sub-1',
            email: 'alice@example.com',
            preferredUsername: 'alice@example.com',
            name: 'Alice',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Rotate JWKS server-side to kid-2
        jwksKeys = [{ ...key2.publicJwk, kid: 'kid-2', alg: 'RS256', use: 'sig' }];
        const jwt2 = await signJwt(
            key2.privateKey,
            { alg: 'RS256', kid: 'kid-2' },
            { iss: teamDomain, aud: baseAud, sub: 'sub-2', exp: nowSec + 600 },
        );

        // Within 30s cooldown, unknown kid does not hammer certs endpoint
        await expect(verifyCfAccessJwt(jwt2, config, nowSec)).rejects.toMatchObject({ status: 401 });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // After 31s, unknown kid triggers a refresh and succeeds
        vi.advanceTimersByTime(31_000);
        expect(await verifyCfAccessJwt(jwt2, config, nowSec + 31)).toEqual({
            sub: 'sub-2',
            email: '',
            preferredUsername: 'sub-2',
            name: 'sub-2',
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rejects invalid assertions with 401', async () => {
        const key = await generateRsaPair();
        const otherKey = await generateRsaPair();
        const teamDomain = 'https://reject-test.cloudflareaccess.com';
        const config = makeConfig(teamDomain);
        const nowSec = 1_700_000_000;

        setFetchMock(vi.fn(async () => new Response(JSON.stringify({
            keys: [{ ...key.publicJwk, kid: 'kid-1', alg: 'RS256', use: 'sig' }],
        }), { status: 200 })));

        const validPayload = { iss: teamDomain, aud: baseAud, sub: 'user-1', exp: nowSec + 300, iat: nowSec };
        const validJwt = await signJwt(key.privateKey, { alg: 'RS256', kid: 'kid-1' }, validPayload);
        const tamperedParts = validJwt.split('.');
        tamperedParts[1] = base64UrlEncode(encoder.encode(JSON.stringify({ ...validPayload, sub: 'admin' })));

        const badCases = [
            '',
            'not-a-jwt',
            await signJwt(key.privateKey, { alg: 'none', kid: 'kid-1' }, validPayload),
            await signJwt(key.privateKey, { alg: 'HS256', kid: 'kid-1' }, validPayload),
            await signJwt(key.privateKey, { alg: 'RS256' }, validPayload),
            await signJwt(key.privateKey, { alg: 'RS256', kid: 'unknown-kid' }, validPayload),
            await signJwt(otherKey.privateKey, { alg: 'RS256', kid: 'kid-1' }, validPayload),
            tamperedParts.join('.'),
            await signJwt(key.privateKey, { alg: 'RS256', kid: 'kid-1' }, { ...validPayload, aud: 'wrong-aud' }),
            await signJwt(key.privateKey, { alg: 'RS256', kid: 'kid-1' }, { ...validPayload, iss: 'https://other.cloudflareaccess.com' }),
            await signJwt(key.privateKey, { alg: 'RS256', kid: 'kid-1' }, { ...validPayload, exp: nowSec - 60 }),
            await signJwt(key.privateKey, { alg: 'RS256', kid: 'kid-1' }, { ...validPayload, nbf: nowSec + 61 }),
            await signJwt(key.privateKey, { alg: 'RS256', kid: 'kid-1' }, { ...validPayload, iat: nowSec + 301 }),
            await signJwt(key.privateKey, { alg: 'RS256', kid: 'kid-1' }, { ...validPayload, sub: '   ' }),
        ];

        for (const assertion of badCases) {
            await expect(verifyCfAccessJwt(assertion, config, nowSec)).rejects.toMatchObject({ status: 401 });
        }
    });

    it('returns 503 when Access JWKS endpoint fails', async () => {
        const key = await generateRsaPair();
        const teamDomain = 'https://down-test.cloudflareaccess.com';
        const config = makeConfig(teamDomain);
        const nowSec = 1_700_000_000;
        const jwt = await signJwt(
            key.privateKey,
            { alg: 'RS256', kid: 'kid-1' },
            { iss: teamDomain, aud: baseAud, sub: 'user-1', exp: nowSec + 300 },
        );

        setFetchMock(vi.fn(async () => new Response('down', { status: 502 })));
        await expect(verifyCfAccessJwt(jwt, config, nowSec)).rejects.toMatchObject({ status: 503 });
    });
});
