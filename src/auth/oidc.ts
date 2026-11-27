import { type RuntimeConfig } from '../config';
import { StatusError } from '../http';
import {
    SUPPORTED_SCOPES,
    authenticateTokenClient,
    getOAuthClient,
    normalizeRequestedScopes,
} from './clients';
import {
    isValidCodeChallenge,
    isValidCodeVerifier,
    loadSigningKey,
    signIdToken,
    verifyCfAccessJwt,
    verifyPkceS256,
} from './jwt';

const ACCESS_TOKEN_TTL_SEC = 3600;
const MAX_PARAM_LENGTH = 1024;

export interface BearerPrincipal {
    sub: string;
    email: string;
    preferredUsername: string;
    name: string;
    scope: string;
    clientId: string;
    expiresAt: number;
}

function noStoreJson(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
    const headers = new Headers({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
    });
    if (extraHeaders) {
        for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
    }
    return new Response(JSON.stringify(body), { status, headers });
}

function methodNotAllowed(allow: string): Response {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: allow } });
}

function resolvePublicOrigin(request: Request, config: RuntimeConfig): string {
    if (config.publicOrigin) {
        return config.publicOrigin;
    }
    const url = new URL(request.url);
    if (url.protocol !== 'https:') {
        throw new StatusError('HTTPS is required for OAuth/OIDC endpoints', 400);
    }
    return url.origin;
}

function getAuthStore(env: Env): DurableObjectStub {
    if (!env.AUTH_DO) {
        throw new StatusError('Server not configured: AUTH_DO Durable Object binding is required', 500);
    }
    return env.AUTH_DO.get(env.AUTH_DO.idFromName('default'));
}

function oauthRedirectError(
    redirectUri: string,
    error: string,
    description: string,
    state: string | null,
): Response {
    const target = new URL(redirectUri);
    target.searchParams.set('error', error);
    target.searchParams.set('error_description', description);
    if (state !== null && state.length <= MAX_PARAM_LENGTH) {
        target.searchParams.set('state', state);
    }
    return new Response(null, {
        status: 302,
        headers: {
            Location: target.toString(),
            'Cache-Control': 'no-store',
            Pragma: 'no-cache',
        },
    });
}

function singleQueryParam(params: URLSearchParams, name: string): { present: boolean; duplicate: boolean; value: string | null } {
    const all = params.getAll(name);
    if (all.length === 0) return { present: false, duplicate: false, value: null };
    if (all.length > 1) return { present: true, duplicate: true, value: null };
    return { present: true, duplicate: false, value: all[0] };
}

export function handleWebFinger(request: Request): Response {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
        return methodNotAllowed('GET, HEAD');
    }
    return new Response(method === 'HEAD' ? null : 'Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
}

export function handleOidcDiscovery(request: Request, config: RuntimeConfig): Response {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
        return methodNotAllowed('GET, HEAD');
    }
    const origin = resolvePublicOrigin(request, config);
    const document = {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        userinfo_endpoint: `${origin}/oauth/userinfo`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        jwks_uri: `${origin}/oauth/jwks`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: [...SUPPORTED_SCOPES],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
    };
    return new Response(method === 'HEAD' ? null : JSON.stringify(document), {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    });
}

export async function handleJwks(request: Request, config: RuntimeConfig): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
        return methodNotAllowed('GET, HEAD');
    }
    resolvePublicOrigin(request, config);
    const bundle = await loadSigningKey(config.oidc!.signingKey, config.oidc!.signingKid);
    return new Response(method === 'HEAD' ? null : JSON.stringify({ keys: [bundle.publicJwk] }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
        },
    });
}

export async function handleAuthorize(request: Request, env: Env, config: RuntimeConfig): Promise<Response> {
    if (request.method.toUpperCase() !== 'GET') {
        return methodNotAllowed('GET');
    }
    resolvePublicOrigin(request, config);

    const assertion = request.headers.get('Cf-Access-Jwt-Assertion') || '';
    let identity;
    try {
        identity = await verifyCfAccessJwt(assertion, config.oidc!);
    } catch (err) {
        if (err instanceof StatusError && err.status !== 401) throw err;
        return noStoreJson(
            { error: 'access_denied', error_description: 'Valid Cloudflare Access assertion is required' },
            401,
        );
    }

    const url = new URL(request.url);
    const clientParam = singleQueryParam(url.searchParams, 'client_id');
    const redirectParam = singleQueryParam(url.searchParams, 'redirect_uri');
    if (clientParam.duplicate || redirectParam.duplicate || !clientParam.value || !redirectParam.value) {
        return noStoreJson({ error: 'invalid_request', error_description: 'Missing or duplicate client_id or redirect_uri' }, 400);
    }
    const client = getOAuthClient(clientParam.value);
    if (!client || !client.isAllowedRedirectUri(redirectParam.value)) {
        return noStoreJson({ error: 'invalid_request', error_description: 'Client or redirect_uri is not allowlisted' }, 400);
    }
    const redirectUri = redirectParam.value;

    const stateParam = singleQueryParam(url.searchParams, 'state');
    if (stateParam.duplicate || (stateParam.value !== null && stateParam.value.length > MAX_PARAM_LENGTH)) {
        return oauthRedirectError(redirectUri, 'invalid_request', 'Invalid state parameter', null);
    }
    const state = stateParam.value;

    const responseTypeParam = singleQueryParam(url.searchParams, 'response_type');
    if (responseTypeParam.duplicate || !responseTypeParam.value) {
        return oauthRedirectError(redirectUri, 'invalid_request', 'Missing or duplicate response_type', state);
    }
    if (responseTypeParam.value !== 'code') {
        return oauthRedirectError(redirectUri, 'unsupported_response_type', 'Only response_type=code is supported', state);
    }

    const challengeParam = singleQueryParam(url.searchParams, 'code_challenge');
    const methodParam = singleQueryParam(url.searchParams, 'code_challenge_method');
    if (
        challengeParam.duplicate
        || methodParam.duplicate
        || methodParam.value !== 'S256'
        || !challengeParam.value
        || !isValidCodeChallenge(challengeParam.value)
    ) {
        return oauthRedirectError(redirectUri, 'invalid_request', 'PKCE S256 code_challenge is required', state);
    }

    const scopeParam = singleQueryParam(url.searchParams, 'scope');
    if (scopeParam.duplicate) {
        return oauthRedirectError(redirectUri, 'invalid_scope', 'Duplicate scope parameter', state);
    }
    const scope = normalizeRequestedScopes(scopeParam.value);
    if (!scope) {
        return oauthRedirectError(redirectUri, 'invalid_scope', 'Invalid or unsupported scope', state);
    }

    const nonceParam = singleQueryParam(url.searchParams, 'nonce');
    if (nonceParam.duplicate || (nonceParam.value !== null && nonceParam.value.length > MAX_PARAM_LENGTH)) {
        return oauthRedirectError(redirectUri, 'invalid_request', 'Invalid nonce parameter', state);
    }
    const nonce = nonceParam.value || null;

    const store = getAuthStore(env);
    const created = await store.fetch('https://auth.internal/codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            clientId: client.clientId,
            redirectUri,
            codeChallenge: challengeParam.value,
            scope,
            nonce,
            sub: identity.sub,
            email: identity.email,
            preferredUsername: identity.preferredUsername,
            name: identity.name,
        }),
    });
    if (!created.ok) {
        await created.body?.cancel();
        return oauthRedirectError(redirectUri, 'server_error', 'Failed to issue authorization code', state);
    }
    const { code } = await created.json<{ code: string }>();

    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    if (state !== null) {
        target.searchParams.set('state', state);
    }
    return new Response(null, {
        status: 302,
        headers: {
            Location: target.toString(),
            'Cache-Control': 'no-store',
            Pragma: 'no-cache',
        },
    });
}

async function parseTokenForm(request: Request): Promise<URLSearchParams | null> {
    const contentType = request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/x-www-form-urlencoded') {
        return null;
    }
    const text = new TextDecoder().decode(await request.arrayBuffer());
    return new URLSearchParams(text);
}

export async function handleToken(request: Request, env: Env, config: RuntimeConfig): Promise<Response> {
    if (request.method.toUpperCase() !== 'POST') {
        return methodNotAllowed('POST');
    }
    const origin = resolvePublicOrigin(request, config);
    const params = await parseTokenForm(request);
    if (!params) {
        return noStoreJson({ error: 'invalid_request', error_description: 'Expected application/x-www-form-urlencoded' }, 400);
    }

    const auth = authenticateTokenClient(request, params);
    if (!auth.ok) {
        const extraHeaders = auth.status === 401 && auth.basicAttempted
            ? { 'WWW-Authenticate': `Basic realm="${origin}"` }
            : undefined;
        return noStoreJson({ error: auth.error, error_description: auth.description }, auth.status, extraHeaders);
    }

    const bundle = await loadSigningKey(config.oidc!.signingKey, config.oidc!.signingKid);
    const store = getAuthStore(env);
    const grantType = params.get('grant_type');

    if (grantType === 'authorization_code') {
        const code = params.get('code');
        const redirectUri = params.get('redirect_uri');
        const codeVerifier = params.get('code_verifier');
        if (!code || !redirectUri || !codeVerifier) {
            return noStoreJson({ error: 'invalid_request', error_description: 'Missing code, redirect_uri, or code_verifier' }, 400);
        }

        const consumed = await store.fetch('https://auth.internal/codes/consume', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
        });
        if (!consumed.ok) {
            await consumed.body?.cancel();
            return noStoreJson({ error: 'invalid_grant', error_description: 'Authorization code is invalid or expired' }, 400);
        }

        const record = await consumed.json<{
            clientId: string;
            redirectUri: string;
            codeChallenge: string;
            scope: string;
            nonce: string | null;
            sub: string;
            email: string;
            preferredUsername: string;
            name: string;
        }>();

        if (
            record.clientId !== auth.client.clientId
            || record.redirectUri !== redirectUri
            || !isValidCodeVerifier(codeVerifier)
            || !(await verifyPkceS256(codeVerifier, record.codeChallenge))
        ) {
            return noStoreJson({ error: 'invalid_grant', error_description: 'Authorization grant verification failed' }, 400);
        }

        const issued = await store.fetch('https://auth.internal/tokens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientId: auth.client.clientId,
                scope: record.scope,
                sub: record.sub,
                email: record.email,
                preferredUsername: record.preferredUsername,
                name: record.name,
            }),
        });
        if (!issued.ok) {
            await issued.body?.cancel();
            throw new StatusError('Failed to persist OAuth tokens', 503);
        }
        const { accessToken, refreshToken, expiresIn } = await issued.json<{
            accessToken: string;
            refreshToken: string;
            expiresIn: number;
        }>();

        const nowSec = Math.floor(Date.now() / 1000);
        const idToken = await signIdToken(bundle, {
            iss: origin,
            sub: record.sub,
            aud: auth.client.clientId,
            iat: nowSec,
            exp: nowSec + ACCESS_TOKEN_TTL_SEC,
            preferred_username: record.preferredUsername,
            ...(record.email ? { email: record.email } : {}),
            name: record.name,
            ...(record.nonce ? { nonce: record.nonce } : {}),
        });

        return noStoreJson({
            access_token: accessToken,
            refresh_token: refreshToken,
            token_type: 'Bearer',
            expires_in: expiresIn,
            scope: record.scope,
            id_token: idToken,
        }, 200);
    }

    if (grantType === 'refresh_token') {
        const refreshToken = params.get('refresh_token');
        if (!refreshToken) {
            return noStoreJson({ error: 'invalid_request', error_description: 'Missing refresh_token' }, 400);
        }
        const scope = params.has('scope') ? params.get('scope')! : undefined;
        if (scope !== undefined && scope.trim() === '') {
            return noStoreJson({ error: 'invalid_scope', error_description: 'Invalid scope parameter' }, 400);
        }

        const refreshed = await store.fetch('https://auth.internal/tokens/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                refreshToken,
                clientId: auth.client.clientId,
                ...(scope !== undefined ? { scope } : {}),
            }),
        });
        if (!refreshed.ok) {
            const err = await refreshed.json<{ error?: string }>().catch(() => ({ error: 'invalid_grant' }));
            const code = err.error === 'invalid_scope' ? 'invalid_scope' : 'invalid_grant';
            return noStoreJson({ error: code, error_description: 'Refresh token request rejected' }, 400);
        }
        const data = await refreshed.json<{
            accessToken: string;
            expiresIn: number;
            scope: string;
            sub: string;
            email: string;
            preferredUsername: string;
            name: string;
        }>();

        const nowSec = Math.floor(Date.now() / 1000);
        const idToken = await signIdToken(bundle, {
            iss: origin,
            sub: data.sub,
            aud: auth.client.clientId,
            iat: nowSec,
            exp: nowSec + ACCESS_TOKEN_TTL_SEC,
            preferred_username: data.preferredUsername,
            ...(data.email ? { email: data.email } : {}),
            name: data.name,
        });

        return noStoreJson({
            access_token: data.accessToken,
            refresh_token: refreshToken,
            token_type: 'Bearer',
            expires_in: data.expiresIn,
            scope: data.scope,
            id_token: idToken,
        }, 200);
    }

    if (!grantType) {
        return noStoreJson({ error: 'invalid_request', error_description: 'Missing grant_type' }, 400);
    }
    return noStoreJson({ error: 'unsupported_grant_type', error_description: 'Unsupported grant_type' }, 400);
}

export async function handleRevoke(request: Request, env: Env, config: RuntimeConfig): Promise<Response> {
    if (request.method.toUpperCase() !== 'POST') {
        return methodNotAllowed('POST');
    }
    const origin = resolvePublicOrigin(request, config);
    const params = await parseTokenForm(request);
    if (!params) {
        return noStoreJson({ error: 'invalid_request', error_description: 'Expected application/x-www-form-urlencoded' }, 400);
    }

    const auth = authenticateTokenClient(request, params);
    if (!auth.ok) {
        const extraHeaders = auth.status === 401 && auth.basicAttempted
            ? { 'WWW-Authenticate': `Basic realm="${origin}"` }
            : undefined;
        return noStoreJson({ error: auth.error, error_description: auth.description }, auth.status, extraHeaders);
    }

    const token = params.get('token');
    if (!token) {
        return noStoreJson({ error: 'invalid_request', error_description: 'Missing token parameter' }, 400);
    }

    const store = getAuthStore(env);
    const res = await store.fetch('https://auth.internal/tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            token,
            clientId: auth.client.clientId,
            tokenTypeHint: params.get('token_type_hint') ?? undefined,
        }),
    });
    await res.body?.cancel();
    if (!res.ok) {
        throw new StatusError('Failed to revoke token', 503);
    }

    return new Response(null, {
        status: 200,
        headers: {
            'Cache-Control': 'no-store',
            Pragma: 'no-cache',
        },
    });
}

export function extractBearerToken(request: Request): { present: boolean; token: string | null } {
    const header = request.headers.get('Authorization');
    if (header === null) return { present: false, token: null };
    const spaceIndex = header.indexOf(' ');
    if (spaceIndex === -1) return { present: true, token: null };
    const scheme = header.slice(0, spaceIndex);
    const token = header.slice(spaceIndex + 1).trim();
    if (scheme.toLowerCase() !== 'bearer' || !token || /\s/.test(token)) {
        return { present: true, token: null };
    }
    return { present: true, token };
}

export async function introspectBearerToken(token: string, env: Env): Promise<BearerPrincipal | null> {
    if (!token) return null;
    const store = getAuthStore(env);
    const res = await store.fetch('https://auth.internal/tokens/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: token }),
    });
    if (!res.ok) {
        await res.body?.cancel();
        return null;
    }
    return await res.json<BearerPrincipal>();
}

export async function handleUserInfo(request: Request, env: Env, config: RuntimeConfig): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
        return methodNotAllowed('GET, POST');
    }
    const origin = resolvePublicOrigin(request, config);
    const bearer = extractBearerToken(request);
    if (!bearer.present) {
        return noStoreJson(
            { error: 'invalid_token', error_description: 'Bearer token required' },
            401,
            { 'WWW-Authenticate': `Bearer realm="${origin}"` },
        );
    }
    const principal = bearer.token ? await introspectBearerToken(bearer.token, env) : null;
    if (!principal) {
        return noStoreJson(
            { error: 'invalid_token', error_description: 'Bearer token is invalid or expired' },
            401,
            { 'WWW-Authenticate': `Bearer realm="${origin}", error="invalid_token"` },
        );
    }

    return noStoreJson({
        sub: principal.sub,
        preferred_username: principal.preferredUsername,
        ...(principal.email ? { email: principal.email } : {}),
        name: principal.name,
    }, 200);
}
