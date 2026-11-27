import { type OidcConfig } from '../config';
import { StatusError } from '../http';
import { timingSafeEqual } from './basic';

const CLOCK_SKEW_SEC = 60;
const MAX_IAT_FUTURE_SEC = 300;
const MAX_ASSERTION_LENGTH = 16384;
const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_MIN_REFRESH_INTERVAL_MS = 30 * 1000;
const MAX_SIGNING_KEY_CACHE = 8;
const MAX_JWKS_CACHE = 16;

export interface PublicRsaJwk {
    kty: 'RSA';
    use: 'sig';
    alg: 'RS256';
    kid: string;
    n: string;
    e: string;
}

export interface SigningKeyBundle {
    privateKey: CryptoKey;
    publicJwk: PublicRsaJwk;
    kid: string;
}

export interface AccessIdentity {
    sub: string;
    email: string;
    preferredUsername: string;
    name: string;
}

interface AccessJwk {
    kty?: unknown;
    kid?: unknown;
    alg?: unknown;
    use?: unknown;
    n?: unknown;
    e?: unknown;
}

interface JwksCacheEntry {
    keys: AccessJwk[];
    fetchedAtMs: number;
}

const signingKeyCache = new Map<string, SigningKeyBundle>();
const jwksCache = new Map<string, JwksCacheEntry>();

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export function base64UrlEncode(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(input: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]*$/.test(input) || input.length % 4 === 1) {
        throw new StatusError('Invalid base64url encoding', 400);
    }
    const base64 = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
    let binary: string;
    try {
        binary = atob(base64);
    } catch {
        throw new StatusError('Invalid base64url encoding', 400);
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export async function sha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export function isValidCodeChallenge(value: string): boolean {
    return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function isValidCodeVerifier(value: string): boolean {
    return /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

export async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
    if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge)) {
        return false;
    }
    const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(verifier));
    const computed = base64UrlEncode(new Uint8Array(digest));
    return timingSafeEqual(computed, challenge);
}

function decodeJwtJson(segment: string, status: number, message: string): Record<string, unknown> {
    try {
        const bytes = base64UrlDecode(segment);
        const parsed = JSON.parse(textDecoder.decode(bytes));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Expected JSON object');
        }
        return parsed as Record<string, unknown>;
    } catch {
        throw new StatusError(message, status);
    }
}

const PKCS8_PEM_RE = /^-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+)\s*-----END PRIVATE KEY-----$/;

function decodeStandardBase64(compact: string): Uint8Array {
    if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
        throw new Error('Invalid base64 key encoding');
    }
    const binary = atob(compact);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function decodePkcs8PemBody(pem: string): Uint8Array {
    const match = PKCS8_PEM_RE.exec(pem.trim());
    if (!match) {
        throw new Error('Invalid PKCS#8 PEM format');
    }
    return decodeStandardBase64(match[1].replace(/\s+/g, ''));
}

function decodePkcs8Der(raw: string): Uint8Array {
    const normalized = raw.trim().replace(/\\n/g, '\n');
    if (normalized.includes('-----BEGIN ')) {
        return decodePkcs8PemBody(normalized);
    }
    const bytes = decodeStandardBase64(normalized.replace(/\s+/g, ''));
    if (bytes[0] === 0x2d) {
        const decoded = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
        if (decoded.startsWith('-----BEGIN ')) {
            return decodePkcs8PemBody(decoded);
        }
    }
    return bytes;
}

async function computeRfc7638Thumbprint(n: string, e: string): Promise<string> {
    const canonical = JSON.stringify({ e, kty: 'RSA', n });
    const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(canonical));
    return base64UrlEncode(new Uint8Array(digest));
}

function setBoundedCache<K, V>(cache: Map<K, V>, key: K, value: V, maxSize: number): void {
    if (cache.has(key)) {
        cache.delete(key);
    } else if (cache.size >= maxSize) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
}

export async function loadSigningKey(rawKey: string, explicitKid?: string): Promise<SigningKeyBundle> {
    const trimmedKey = rawKey.trim();
    const normalizedKid = explicitKid?.trim() || undefined;
    const cacheKey = `${normalizedKid ?? ''}\0${trimmedKey}`;
    const cached = signingKeyCache.get(cacheKey);
    if (cached) return cached;

    try {
        let privateKey: CryptoKey;
        let n: string;
        let e: string;

        if (trimmedKey.startsWith('{')) {
            const parsed = JSON.parse(trimmedKey) as Record<string, unknown>;
            if (
                !parsed
                || typeof parsed !== 'object'
                || parsed.kty !== 'RSA'
                || typeof parsed.n !== 'string'
                || typeof parsed.e !== 'string'
                || typeof parsed.d !== 'string'
                || !parsed.n
                || !parsed.e
                || !parsed.d
            ) {
                throw new Error('Invalid RSA private JWK');
            }
            const jwkInput: JsonWebKey = {
                kty: 'RSA',
                n: parsed.n,
                e: parsed.e,
                d: parsed.d,
                alg: 'RS256',
                ext: false,
            };
            for (const opt of ['p', 'q', 'dp', 'dq', 'qi'] as const) {
                if (typeof parsed[opt] === 'string' && parsed[opt]) {
                    jwkInput[opt] = parsed[opt] as string;
                }
            }
            privateKey = await crypto.subtle.importKey(
                'jwk',
                jwkInput,
                { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
                false,
                ['sign'],
            );
            n = parsed.n;
            e = parsed.e;
        } else {
            const der = decodePkcs8Der(trimmedKey);
            const extractableKey = await crypto.subtle.importKey(
                'pkcs8',
                der,
                { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
                true,
                ['sign'],
            );
            const exported = await crypto.subtle.exportKey('jwk', extractableKey) as JsonWebKey;
            if (exported.kty !== 'RSA' || typeof exported.n !== 'string' || typeof exported.e !== 'string') {
                throw new Error('Key is not an RSA key');
            }
            privateKey = extractableKey;
            n = exported.n;
            e = exported.e;
        }

        const kid = normalizedKid ?? await computeRfc7638Thumbprint(n, e);
        const bundle: SigningKeyBundle = {
            privateKey,
            kid,
            publicJwk: {
                kty: 'RSA',
                use: 'sig',
                alg: 'RS256',
                kid,
                n,
                e,
            },
        };
        setBoundedCache(signingKeyCache, cacheKey, bundle, MAX_SIGNING_KEY_CACHE);
        return bundle;
    } catch {
        throw new StatusError('Server not configured: invalid OIDC_SIGNING_KEY', 500);
    }
}

export async function signIdToken(bundle: SigningKeyBundle, claims: Record<string, unknown>): Promise<string> {
    const header = { alg: 'RS256', typ: 'JWT', kid: bundle.kid };
    const headerB64 = base64UrlEncode(textEncoder.encode(JSON.stringify(header)));
    const payloadB64 = base64UrlEncode(textEncoder.encode(JSON.stringify(claims)));
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = await crypto.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        bundle.privateKey,
        textEncoder.encode(signingInput),
    );
    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function fetchAccessJwks(teamDomain: string): Promise<JwksCacheEntry> {
    const certsUrl = `${teamDomain}/cdn-cgi/access/certs`;
    let response: Response;
    try {
        response = await fetch(certsUrl, { headers: { Accept: 'application/json' } });
    } catch {
        throw new StatusError('Cloudflare Access JWKS unavailable', 503);
    }
    if (!response.ok) {
        await response.body?.cancel();
        throw new StatusError('Cloudflare Access JWKS unavailable', 503);
    }
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new StatusError('Cloudflare Access JWKS unavailable', 503);
    }
    const keys = (body as { keys?: unknown })?.keys;
    if (!Array.isArray(keys)) {
        throw new StatusError('Cloudflare Access JWKS unavailable', 503);
    }
    const entry: JwksCacheEntry = { keys: keys as AccessJwk[], fetchedAtMs: Date.now() };
    setBoundedCache(jwksCache, teamDomain, entry, MAX_JWKS_CACHE);
    return entry;
}

function findMatchingAccessJwk(keys: AccessJwk[], kid: string): AccessJwk | undefined {
    return keys.find(key =>
        key
        && typeof key === 'object'
        && key.kid === kid
        && key.kty === 'RSA'
        && (key.alg === undefined || key.alg === 'RS256')
        && (key.use === undefined || key.use === 'sig')
        && typeof key.n === 'string'
        && key.n.length > 0
        && typeof key.e === 'string'
        && key.e.length > 0,
    );
}

async function resolveAccessJwk(teamDomain: string, kid: string): Promise<AccessJwk | undefined> {
    const nowMs = Date.now();
    let cached = jwksCache.get(teamDomain);
    if (!cached || nowMs - cached.fetchedAtMs >= JWKS_TTL_MS) {
        cached = await fetchAccessJwks(teamDomain);
    }
    let match = findMatchingAccessJwk(cached.keys, kid);
    if (!match && nowMs - cached.fetchedAtMs >= JWKS_MIN_REFRESH_INTERVAL_MS) {
        cached = await fetchAccessJwks(teamDomain);
        match = findMatchingAccessJwk(cached.keys, kid);
    }
    return match;
}

function matchesAudience(aud: unknown, expectedAud: string): boolean {
    if (typeof aud === 'string') {
        return timingSafeEqual(aud, expectedAud);
    }
    if (Array.isArray(aud)) {
        return aud.some(item => typeof item === 'string' && timingSafeEqual(item, expectedAud));
    }
    return false;
}

export async function verifyCfAccessJwt(assertion: string, config: OidcConfig, nowSec?: number): Promise<AccessIdentity> {
    if (!assertion || assertion.length > MAX_ASSERTION_LENGTH) {
        throw new StatusError('Unauthorized', 401);
    }
    const parts = assertion.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
        throw new StatusError('Unauthorized', 401);
    }

    const header = decodeJwtJson(parts[0], 401, 'Unauthorized');
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0) {
        throw new StatusError('Unauthorized', 401);
    }

    const jwk = await resolveAccessJwk(config.accessTeamDomain, header.kid);
    if (!jwk) {
        throw new StatusError('Unauthorized', 401);
    }

    let signatureBytes: Uint8Array;
    try {
        signatureBytes = base64UrlDecode(parts[2]);
    } catch {
        throw new StatusError('Unauthorized', 401);
    }

    let verified: boolean;
    try {
        const publicKey = await crypto.subtle.importKey(
            'jwk',
            { kty: 'RSA', n: jwk.n as string, e: jwk.e as string, alg: 'RS256', ext: true },
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify'],
        );
        verified = await crypto.subtle.verify(
            { name: 'RSASSA-PKCS1-v1_5' },
            publicKey,
            signatureBytes,
            textEncoder.encode(`${parts[0]}.${parts[1]}`),
        );
    } catch {
        throw new StatusError('Unauthorized', 401);
    }
    if (!verified) {
        throw new StatusError('Unauthorized', 401);
    }

    const payload = decodeJwtJson(parts[1], 401, 'Unauthorized');
    const now = nowSec ?? Math.floor(Date.now() / 1000);

    if (typeof payload.iss !== 'string' || payload.iss.replace(/\/+$/, '') !== config.accessTeamDomain) {
        throw new StatusError('Unauthorized', 401);
    }
    if (!matchesAudience(payload.aud, config.accessAud)) {
        throw new StatusError('Unauthorized', 401);
    }
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || now >= payload.exp + CLOCK_SKEW_SEC) {
        throw new StatusError('Unauthorized', 401);
    }
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || now + CLOCK_SKEW_SEC < payload.nbf)) {
        throw new StatusError('Unauthorized', 401);
    }
    if (payload.iat !== undefined && (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > now + MAX_IAT_FUTURE_SEC)) {
        throw new StatusError('Unauthorized', 401);
    }
    if (typeof payload.sub !== 'string' || payload.sub.trim().length === 0) {
        throw new StatusError('Unauthorized', 401);
    }

    const sub = payload.sub.trim();
    const email = typeof payload.email === 'string' ? payload.email.trim() : '';
    const preferredUsername = email || sub;
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : preferredUsername;
    return { sub, email, preferredUsername, name };
}
