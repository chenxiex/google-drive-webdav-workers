import { timingSafeEqual } from './basic';

export interface OAuthClient {
    readonly clientId: string;
    readonly clientSecret: string | null;
    readonly isPublic: boolean;
    isAllowedRedirectUri(uri: string): boolean;
}

export const SUPPORTED_SCOPES = ['openid', 'offline_access', 'email', 'profile'] as const;

const SUPPORTED_SCOPE_SET = new Set<string>(SUPPORTED_SCOPES);
const SCOPE_TOKEN_RE = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const LOOPBACK_REDIRECT_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})\/?$/;

const DESKTOP_CLIENT: OAuthClient = {
    clientId: 'xdXOt13JKxym1B1QcEncf2XDkLAexMBFwiT9j6EfhhHFJhs2KM9jbjTmf8JBXE69',
    clientSecret: 'UBntmLjC2yYCeHwsyj73Uwo9TAaecAetRwMw0xYcvNL9yRdLSUi0hUAHfvCHFeFh',
    isPublic: false,
    isAllowedRedirectUri(uri: string): boolean {
        const match = LOOPBACK_REDIRECT_RE.exec(uri);
        if (!match) return false;
        const port = Number(match[1]);
        return port >= 1 && port <= 65535;
    },
};

const ANDROID_CLIENT: OAuthClient = {
    clientId: 'OpenCloudAndroid',
    clientSecret: null,
    isPublic: true,
    isAllowedRedirectUri(uri: string): boolean {
        return uri === 'oc://android.opencloud.eu';
    },
};

const ALLOWLISTED_CLIENTS = new Map<string, OAuthClient>([
    [DESKTOP_CLIENT.clientId, DESKTOP_CLIENT],
    [ANDROID_CLIENT.clientId, ANDROID_CLIENT],
]);

export function getOAuthClient(clientId: string): OAuthClient | undefined {
    return ALLOWLISTED_CLIENTS.get(clientId);
}

export function normalizeRequestedScopes(rawScope: string | null): string | null {
    if (rawScope === null || rawScope.trim() === '') {
        return 'openid';
    }
    const tokens = rawScope.trim().split(/\s+/);
    const seen = new Set<string>();
    for (const token of tokens) {
        if (!SCOPE_TOKEN_RE.test(token)) {
            return null;
        }
        if (SUPPORTED_SCOPE_SET.has(token)) {
            seen.add(token);
        }
    }
    if (!seen.has('openid')) {
        return null;
    }
    return Array.from(seen).join(' ');
}

export function isScopeSubset(requested: string, granted: string): string | null {
    const trimmed = requested.trim();
    if (!trimmed) return null;
    const grantedSet = new Set(granted.split(' '));
    const seen = new Set<string>();
    for (const token of trimmed.split(/\s+/)) {
        if (!SCOPE_TOKEN_RE.test(token) || !grantedSet.has(token)) {
            return null;
        }
        seen.add(token);
    }
    return seen.size > 0 ? Array.from(seen).join(' ') : null;
}

export type ClientAuthResult =
    | { ok: true; client: OAuthClient }
    | { ok: false; status: 400 | 401; error: 'invalid_request' | 'invalid_client'; description: string; basicAttempted: boolean };

function decodeFormComponent(value: string): string {
    return decodeURIComponent(value.replace(/\+/g, ' '));
}

function parseBasicClientHeader(header: string): { clientId: string; clientSecret: string } | null {
    const spaceIndex = header.indexOf(' ');
    if (spaceIndex === -1) return null;
    const scheme = header.slice(0, spaceIndex);
    const encoded = header.slice(spaceIndex + 1).trim();
    if (scheme.toLowerCase() !== 'basic' || !encoded) return null;
    let decoded: string;
    try {
        const binary = atob(encoded);
        const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
        decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
        return null;
    }
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1 || /[\0-\x1F\x7F]/.test(decoded)) return null;
    try {
        return {
            clientId: decodeFormComponent(decoded.slice(0, colonIndex)),
            clientSecret: decodeFormComponent(decoded.slice(colonIndex + 1)),
        };
    } catch {
        return null;
    }
}

export function authenticateTokenClient(request: Request, params: URLSearchParams): ClientAuthResult {
    const authHeader = request.headers.get('Authorization');
    const clientIds = params.getAll('client_id');
    const clientSecrets = params.getAll('client_secret');
    if (clientIds.length > 1 || clientSecrets.length > 1) {
        return { ok: false, status: 400, error: 'invalid_request', description: 'Duplicate client credentials parameters', basicAttempted: false };
    }

    if (authHeader !== null) {
        const isBasicScheme = authHeader.trimStart().toLowerCase().startsWith('basic ');
        const parsed = parseBasicClientHeader(authHeader);
        if (!parsed) {
            return { ok: false, status: 401, error: 'invalid_client', description: 'Invalid client authorization header', basicAttempted: isBasicScheme };
        }
        if (params.has('client_secret')) {
            return { ok: false, status: 400, error: 'invalid_request', description: 'Multiple client authentication methods used', basicAttempted: true };
        }
        if (params.has('client_id') && params.get('client_id') !== parsed.clientId) {
            return { ok: false, status: 400, error: 'invalid_request', description: 'Mismatched client_id across auth methods', basicAttempted: true };
        }
        const client = getOAuthClient(parsed.clientId);
        if (!client || client.isPublic || client.clientSecret === null || !timingSafeEqual(client.clientSecret, parsed.clientSecret)) {
            return { ok: false, status: 401, error: 'invalid_client', description: 'Client authentication failed', basicAttempted: true };
        }
        return { ok: true, client };
    }

    const clientId = params.get('client_id');
    if (!clientId) {
        return { ok: false, status: 401, error: 'invalid_client', description: 'Missing client authentication', basicAttempted: false };
    }
    const client = getOAuthClient(clientId);
    if (!client) {
        return { ok: false, status: 401, error: 'invalid_client', description: 'Unknown client', basicAttempted: false };
    }
    const clientSecret = params.get('client_secret');
    if (client.isPublic) {
        if (clientSecret !== null && clientSecret !== '') {
            return { ok: false, status: 401, error: 'invalid_client', description: 'Public client must not send client_secret', basicAttempted: false };
        }
        return { ok: true, client };
    }
    if (!clientSecret || client.clientSecret === null || !timingSafeEqual(client.clientSecret, clientSecret)) {
        return { ok: false, status: 401, error: 'invalid_client', description: 'Client authentication failed', basicAttempted: false };
    }
    return { ok: true, client };
}
