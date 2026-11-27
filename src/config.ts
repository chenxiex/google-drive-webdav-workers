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

export interface RuntimeConfig {
    client_id: string;
    client_secret: string;
    refresh_token: string;
    path: string;
    basePath: string;
    rootId: string;
    name: string;
    users: Record<string, string>;
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
    return {
        client_id: env?.CLIENT_ID?.trim() || '',
        client_secret: env?.CLIENT_SECRET?.trim() || '',
        refresh_token: env?.REFRESH_TOKEN?.trim() || '',
        path,
        basePath,
        rootId: env?.ROOT_ID || 'root',
        name: env?.NAME || 'My Cloud Drive',
        users: parseUsers(env?.USERS),
    };
}
