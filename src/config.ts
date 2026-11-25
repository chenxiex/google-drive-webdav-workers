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
    const path = env?.PATH || '/dav/';
    return {
        client_id: env?.CLIENT_ID?.trim() || '',
        client_secret: env?.CLIENT_SECRET?.trim() || '',
        refresh_token: env?.REFRESH_TOKEN?.trim() || '',
        path,
        basePath: path.endsWith('/') ? path : path + '/',
        rootId: env?.ROOT_ID || 'root',
        name: env?.NAME || 'My Cloud Drive',
        users: parseUsers(env?.USERS),
    };
}
