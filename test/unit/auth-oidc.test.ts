import { beforeAll, describe, expect, it, vi } from 'vitest';
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
import { generateRsaPair } from '../support/rsa';

const DESKTOP_ID = 'xdXOt13JKxym1B1QcEncf2XDkLAexMBFwiT9j6EfhhHFJhs2KM9jbjTmf8JBXE69';
const DESKTOP_SECRET = 'UBntmLjC2yYCeHwsyj73Uwo9TAaecAetRwMw0xYcvNL9yRdLSUi0hUAHfvCHFeFh';
const ANDROID_ID = 'OpenCloudAndroid';

const encoder = new TextEncoder();

// Signing does not mutate keys, so all scenarios can share the expensive key generation.
let keyPair: Awaited<ReturnType<typeof generateRsaPair>>;
let otherKeyPair: Awaited<ReturnType<typeof generateRsaPair>>;
beforeAll(async () => {
    [keyPair, otherKeyPair] = await Promise.all([generateRsaPair(), generateRsaPair()]);
});

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
    it.each([
        [43, 'a'.repeat(43)],
        [64, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'.slice(0, 64)],
        [128, 'z'.repeat(128)],
    ])('accepts a valid verifier of length %i', async (_length, verifier) => {
        const challenge = await pkceChallenge(verifier);
        expect(isValidCodeVerifier(verifier)).toBe(true);
        expect(isValidCodeChallenge(challenge)).toBe(true);
        expect(await verifyPkceS256(verifier, challenge)).toBe(true);
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

    const desktopBasic = 'Basic ' + btoa(`${encodeURIComponent(DESKTOP_ID)}:${encodeURIComponent(DESKTOP_SECRET)}`);
    it.each([
        ['Desktop Basic', desktopBasic, {}, { ok: true, client: { clientId: DESKTOP_ID } }],
        ['Desktop POST', undefined, { client_id: DESKTOP_ID, client_secret: DESKTOP_SECRET }, { ok: true, client: { clientId: DESKTOP_ID } }],
        ['Android public', undefined, { client_id: ANDROID_ID }, { ok: true, client: { clientId: ANDROID_ID } }],
        ['Android empty secret', undefined, { client_id: ANDROID_ID, client_secret: '' }, { ok: true, client: { clientId: ANDROID_ID } }],
        ['mixed Basic and POST', desktopBasic, { client_secret: DESKTOP_SECRET }, { ok: false, status: 400, error: 'invalid_request' }],
        ['incorrect Desktop secret', undefined, { client_id: DESKTOP_ID, client_secret: 'wrong' }, { ok: false, status: 401, error: 'invalid_client' }],
        ['Android secret', undefined, { client_id: ANDROID_ID, client_secret: 'secret' }, { ok: false, status: 401, error: 'invalid_client' }],
        ['Android Basic', 'Basic ' + btoa(`${ANDROID_ID}:`), {}, { ok: false, status: 401, error: 'invalid_client' }],
    ] satisfies Array<[string, string | undefined, Record<string, string>, object]>)('validates %s client authentication', (_label, authorization, params, expected) => {
        const request = new Request('https://example.com/oauth/token', {
            method: 'POST',
            headers: authorization ? { Authorization: authorization } : undefined,
        });
        expect(authenticateTokenClient(request, new URLSearchParams(params))).toMatchObject(expected);
    });
});

describe('RS256 signing key and ID token', () => {
    it.each([
        ['PKCS#8 PEM', () => keyPair.pkcs8Pem],
        ['escaped PEM', () => keyPair.pkcs8Pem.replace(/\n/g, '\\n')],
        ['base64 DER', () => keyPair.pkcs8Pem.replace(/-----[^\n]+-----|\s+/g, '')],
        ['base64 PEM', () => btoa(keyPair.pkcs8Pem)],
        ['JWK', () => JSON.stringify(keyPair.privateJwk)],
    ])('loads %s and exposes only the public signing JWK', async (_label, input) => {
        const loaded = await loadSigningKey(input());
        expect(Object.keys(loaded.publicJwk).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
        expect(loaded.publicJwk).toMatchObject({
            kty: 'RSA', use: 'sig', alg: 'RS256',
            n: keyPair.publicJwk.n, e: keyPair.publicJwk.e, kid: loaded.kid,
        });
        expect(loaded.kid).toBe((await loadSigningKey(keyPair.pkcs8Pem)).kid);
    });

    it('uses a custom kid and signs verifiable ID tokens', async () => {
        const withCustomKid = await loadSigningKey(keyPair.pkcs8Pem, 'custom-kid-1');
        expect(withCustomKid.kid).toBe('custom-kid-1');

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

    const sentinel = 'SECRET_SENTINEL_VALUE';
    it.each([
        ['empty', () => ''],
        ['invalid PEM', () => 'not-a-pem-' + sentinel],
        ['invalid DER', () => btoa('not-a-pkcs8-key-' + sentinel)],
        ['public PEM', () => '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----'],
        ['public JWK', () => JSON.stringify(keyPair.publicJwk)],
        ['invalid JSON', () => '{bad-json-' + sentinel],
    ])('rejects %s keys with 500 without leaking key material', async (_label, input) => {
        const error = await loadSigningKey(input()).catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(StatusError);
        expect(error).toMatchObject({ status: 500 });
        expect((error as Error).message).not.toContain(sentinel);
        expect((error as Error).message).not.toContain(keyPair.publicJwk.n!);
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

        const key1 = keyPair;
        const key2 = otherKeyPair;
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
        const key = keyPair;
        const otherKey = otherKeyPair;
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
        const key = keyPair;
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
