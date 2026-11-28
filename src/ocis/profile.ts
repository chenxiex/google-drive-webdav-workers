import { TUS_CHECKSUM_ALGORITHMS, TUS_EXTENSIONS, TUS_VERSION } from '../tus/protocol';

export interface AuthPrincipal {
    owner: string;
    id: string;
    displayName: string;
    email?: string;
}

export const STATUS_PROFILE = {
    installed: true,
    maintenance: false,
    needsDbUpgrade: false,
    version: '10.11.0.0',
    versionstring: '10.11.0',
    edition: 'Community',
    productname: 'Infinite Scale',
    product: 'Infinite Scale',
    productversion: '8.2.3',
} as const;

export const VERSION_PROFILE = {
    major: 10,
    minor: 11,
    micro: 0,
    string: '10.11.0',
    edition: 'Community',
    product: 'Infinite Scale',
    productversion: '8.2.3',
} as const;

export const PERSONAL_SPACE_NAME = 'Personal';

export function personalSpaceId(rootId: string): string {
    return `personal$${encodeURIComponent(rootId)}`;
}

export function handleStatusPhp(request: Request): Response {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    return new Response(method === 'HEAD' ? null : JSON.stringify(STATUS_PROFILE), {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    });
}

export function handleOcisDavOptions(): Response {
    const allowedMethods = [
        'GET', 'HEAD', 'OPTIONS', 'PUT', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'DELETE', 'MOVE', 'COPY', 'POST',
    ].join(', ');
    return new Response(null, {
        status: 204,
        headers: {
            Allow: allowedMethods,
            DAV: '1',
            'MS-Author-Via': 'DAV',
            'Accept-Ranges': 'bytes',
            'Tus-Resumable': TUS_VERSION,
            'Tus-Version': TUS_VERSION,
            'Tus-Extension': TUS_EXTENSIONS,
            'Tus-Checksum-Algorithm': TUS_CHECKSUM_ALGORITHMS,
        },
    });
}
