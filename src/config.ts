import { StatusError } from './http';

export const DEFAULT_WEBDAV_PATH = '/webdav/';

export const RESERVED_OCIS_PREFIXES = [
    '/dav/spaces/',
    '/remote.php/',
    '/ocs/',
    '/graph/',
    '/oauth/',
    '/status.php',
    '/.well-known/',
] as const;

export interface OidcConfig {
    accessAud: string;
    accessTeamDomain: string;
    signingKey: string;
    signingKid?: string;
}

export interface RuntimeConfig {
    client_id: string;
    client_secret: string;
    refresh_token: string;
    path: string;
    basePath: string;
    rootId: string;
    name: string;
    users: Record<string, string>;
    publicOrigin?: string;
    oidc?: OidcConfig;
}

function normalizeOrigin(raw: string, label: string, allowImplicitHttps: boolean): string {
    const candidate = allowImplicitHttps && !raw.includes('://') ? `https://${raw}` : raw;
    let url: URL;
    try {
        url = new URL(candidate);
    } catch {
        throw new StatusError(`Server not configured: ${label} must be an https:// origin without path, query, or fragment`, 500);
    }
    if (
        url.protocol !== 'https:'
        || !url.hostname
        || url.username !== ''
        || url.password !== ''
        || url.pathname !== '/'
        || url.search !== ''
        || url.hash !== ''
    ) {
        throw new StatusError(`Server not configured: ${label} must be an https:// origin without path, query, or fragment`, 500);
    }
    return url.origin;
}

function resolveOidcConfig(env?: Partial<Env>): OidcConfig | undefined {
    const accessAud = env?.CF_ACCESS_AUD?.trim() || '';
    const rawTeamDomain = env?.CF_ACCESS_TEAM_DOMAIN?.trim() || '';
    const signingKey = env?.OIDC_SIGNING_KEY?.trim() || '';
    const signingKid = env?.OIDC_SIGNING_KID?.trim() || '';

    if (!accessAud && !rawTeamDomain && !signingKey && !signingKid) {
        return undefined;
    }

    const missing: string[] = [];
    if (!accessAud) missing.push('CF_ACCESS_AUD');
    if (!rawTeamDomain) missing.push('CF_ACCESS_TEAM_DOMAIN');
    if (!signingKey) missing.push('OIDC_SIGNING_KEY');
    if (missing.length > 0) {
        throw new StatusError('Server not configured: missing ' + missing.join(', '), 500);
    }

    return {
        accessAud,
        accessTeamDomain: normalizeOrigin(rawTeamDomain, 'CF_ACCESS_TEAM_DOMAIN', true),
        signingKey,
        ...(signingKid ? { signingKid } : {}),
    };
}

function resolveMountPath(rawPath?: string): { path: string; basePath: string } {
    if (rawPath === undefined || rawPath === '') {
        return { path: DEFAULT_WEBDAV_PATH, basePath: DEFAULT_WEBDAV_PATH };
    }
    if (!rawPath.startsWith('/')) {
        throw new StatusError('Server not configured: WEBDAV_PATH must start with "/"', 500);
    }
    if (/[\s\x00-\x1f\x7f?#\\%]/u.test(rawPath)) {
        throw new StatusError('Server not configured: WEBDAV_PATH contains unsupported characters', 500);
    }
    const trimmed = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
    if (trimmed === '') {
        throw new StatusError('Server not configured: WEBDAV_PATH cannot be "/"', 500);
    }
    if (trimmed.slice(1).split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
        throw new StatusError('Server not configured: WEBDAV_PATH cannot contain empty or dot segments', 500);
    }
    const basePath = trimmed + '/';
    if (new URL(basePath, 'https://example.com').pathname !== basePath) {
        throw new StatusError('Server not configured: WEBDAV_PATH must be a canonical URL path', 500);
    }
    for (const reserved of RESERVED_OCIS_PREFIXES) {
        const reservedPrefix = reserved.endsWith('/') ? reserved : reserved + '/';
        if (basePath.startsWith(reservedPrefix) || reservedPrefix.startsWith(basePath)) {
            throw new StatusError(`Server not configured: WEBDAV_PATH "${rawPath}" conflicts with reserved prefix "${reserved}"`, 500);
        }
    }
    return { path: rawPath, basePath };
}

export function parseUsers(raw: unknown): Record<string, string> {
    if (typeof raw === 'string' && raw.length > 0) {
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            console.error('USERS is not valid JSON');
            return {};
        }
    }
    return raw && typeof raw === 'object' ? raw as Record<string, string> : {};
}

export function resolveConfig(env?: Partial<Env>): RuntimeConfig {
    const { path, basePath } = resolveMountPath(env?.WEBDAV_PATH);
    const rawPublicOrigin = env?.PUBLIC_ORIGIN?.trim() || '';
    const publicOrigin = rawPublicOrigin ? normalizeOrigin(rawPublicOrigin, 'PUBLIC_ORIGIN', false) : undefined;
    const oidc = resolveOidcConfig(env);
    return {
        client_id: env?.CLIENT_ID?.trim() || '',
        client_secret: env?.CLIENT_SECRET?.trim() || '',
        refresh_token: env?.REFRESH_TOKEN?.trim() || '',
        path,
        basePath,
        rootId: env?.ROOT_ID || 'root',
        name: env?.NAME || 'My Cloud Drive',
        users: parseUsers(env?.USERS),
        ...(publicOrigin ? { publicOrigin } : {}),
        ...(oidc ? { oidc } : {}),
    };
}
