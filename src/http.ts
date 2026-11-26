export class StatusError extends Error {
    status: number;

    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

export class TransferError extends StatusError {
    constructor(message: string, status: number, public definitive: boolean) {
        super(message, status);
    }
}

// Carry an upstream failure's HTTP status through to the client instead of
// collapsing every error into a 500.
export function errorStatus(e: unknown): number {
    const status = (e as any)?.status;
    return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

export const pathJoin = (...args: string[]): string => args.join('/').replace(/\\/g, '/').replace(/(?<!^)\/+/g, '/').replace(/\/\//g, '/');

export const encodeQueryString = (data: Record<string, string>): string => Object.keys(data).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(data[k])).join('&');

export const trimString = (string: string, char?: string): string => char ? string.replace(new RegExp('^\\' + char + '+|\\' + char + '+$', 'g'), '') : string.replace(/^\s+|\s+$/g, '');

export const escapeXml = (value: unknown): string =>
    String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Percent-encode each path segment individually so hrefs stay valid for names
// containing spaces, "&", "#" or non-ASCII characters.
export const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

// Collections are addressed with a trailing slash. Strip it so the final
// segment is the resource name and not an empty string.
export const splitPath = (path: string): { name: string; parent: string } => {
    const parts = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
    const name = parts.pop()!;
    return { name, parent: parts.join('/') };
};

// Drive query values are single-quoted; a literal backslash or quote inside
// the value has to be escaped with a backslash.
export const escapeQuery = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Decode a raw pathname a single time. Refusing to decode malformed input
// (e.g. a literal "%zz") keeps a client from coercing the worker into a 500.
export const decodePath = (url: string): string => {
    try {
        return decodeURIComponent(new URL(url, 'http://localhost').pathname);
    } catch {
        throw new StatusError('Invalid path encoding', 400);
    }
};

export const getUrl = (url: string, basePath: string): { rpath: string; fpath: string } => {
    const rpath = decodePath(url);
    const relative = basePath !== '/' && rpath.startsWith(basePath) ? '/' + rpath.substring(basePath.length) : rpath;
    return {
        rpath,
        fpath: pathJoin('/', relative),
    };
};
