export { TusUpload } from './tus-upload';
import { uploadChunks } from './upload-stream';
import { DOMParser } from '@xmldom/xmldom';
import { DavProperty, key as propertyKey, parsePatch, parseFind, readDeadProperties, writeDeadProperties, propertyNameXml } from './dav-properties';

var config: AppConfig = {
    client_id: '', // Configure your own Google OAuth client through bindings
    client_secret: '', // No shared OAuth credentials are bundled
    refresh_token: '', // Google Drive API Refresh Token

    path: '/dav/',
    name: 'My Cloud Drive', // Display name for the web interface
    copyright: '@ixiumu', // Copyright text displayed in the footer
    copyright_link: 'https://github.com/ixiumu/google-drive-webdav-workers', // URL link for the footer

    users: {
        'user': 'password' // Global Authentication credentials (username: password)
    },

    env: false,
    working_dir: '/', // Root directory path for the drive mapping
    cache: {
        meta: {
            '/': { data: { id: 'root', mimeType: 'application/vnd.google-apps.folder', size: 0, modifiedTime: null }, expire: Infinity }
        },
        putUrl: {},
        config: {}
    }
};

if (typeof CONFIG !== 'undefined') Object.assign(config, CONFIG);

const pathJoin = (...args: string[]): string => args.join('/').replace(/\\/g, '/').replace(/(?<!^)\/+/g, '/').replace(/\/\//g, '/');
const encodeQueryString = (data: Record<string, string>): string => Object.keys(data).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(data[k])).join('&');
const trimString = (string: string, char?: string): string => char ? string.replace(new RegExp('^\\' + char + '+|\\' + char + '+$', 'g'), '') : string.replace(/^\s+|\s+$/g, '');
const formatSize = (n: number | string): string => {
    let num = typeof n === 'string' ? parseFloat(n) : Math.round(n);
    if (num === 0 || isNaN(num)) return '';
    if (num < 1024) return num + 'B'; if (num < 1024 * 1024) return Math.round(num / 1024) + 'K';
    return parseFloat((num / 1024 / 1024).toFixed(1)) + 'M';
};

const FOLDER_MIME = 'application/vnd.google-apps.folder';

const escapeXml = (value: unknown): string =>
    String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Percent-encode each path segment individually so hrefs stay valid for names
// containing spaces, "&", "#" or non-ASCII characters.
const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

// Collections are addressed with a trailing slash. Strip it so the final
// segment is the resource name and not an empty string.
const splitPath = (path: string): { name: string; parent: string } => {
    const parts = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
    const name = parts.pop()!;
    return { name, parent: parts.join('/') };
};

// Drive query values are single-quoted; a literal backslash or quote inside
// the value has to be escaped with a backslash.
const escapeQuery = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Decode a raw pathname a single time. Refusing to decode malformed input
// (e.g. a literal "%zz") keeps a client from coercing the worker into a 500.
const decodePath = (url: string): string => {
    try {
        return decodeURIComponent(new URL(url, 'http://localhost').pathname);
    } catch {
        throw new StatusError('Invalid path encoding', 400);
    }
};

const getUrl = (url: string): { rpath: string; fpath: string } => {
    const rpath = decodePath(url);
    let fpath_relative = rpath;
    const basePath = config.path.endsWith('/') ? config.path : config.path + '/';
    if (basePath !== '/' && fpath_relative.startsWith(basePath)) {
        fpath_relative = '/' + fpath_relative.substring(basePath.length);
    }
    return {
        rpath,
        fpath: pathJoin(config.working_dir, fpath_relative)
    };
};

// Constant-time string comparison. `crypto.subtle.timingSafeEqual` throws when
// the buffers differ in length, and returning early would leak the length of
// the stored secret through timing, so compare a value against itself instead.
function timingSafeEqual(a: string, b: string): boolean {
    const encoder = new TextEncoder();
    const left = encoder.encode(a);
    const right = encoder.encode(b);
    return left.byteLength === right.byteLength
        ? crypto.subtle.timingSafeEqual(left, right)
        : !crypto.subtle.timingSafeEqual(left, left);
}

// Carry an upstream failure's HTTP status through to the client instead of
// collapsing every error into a 500.
function errorStatus(e: unknown): number {
    const status = (e as any)?.status;
    return typeof status === 'number' && status >= 400 && status <= 599 ? status : 500;
}

function isValidUser(users: Record<string, string>, creds: { user: string; pass: string }): boolean {
    if (!Object.prototype.hasOwnProperty.call(users, creds.user)) return false;
    return timingSafeEqual(String(users[creds.user]), creds.pass);
}

function basicAuthentication(request: Request): { user: string; pass: string } | null {
    const Authorization = request.headers.get('Authorization');
    if (!Authorization) return null;
    const [scheme, encoded] = Authorization.split(' ');
    if (!encoded || scheme !== 'Basic') return null;
    let decoded: string;
    try {
        const buffer = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
        decoded = new TextDecoder().decode(buffer).normalize();
    } catch {
        // Malformed base64 should not collapse into a 500.
        return null;
    }
    const index = decoded.indexOf(':');
    if (index === -1 || /[\0-\x1F\x7F]/.test(decoded)) return null;
    return { user: decoded.substring(0, index), pass: decoded.substring(index + 1) };
}

// Shared only within this isolate. Entries expire and are capped per namespace;
// large listings are fetched normally rather than retained in memory.
const CACHE_ENTRIES = 128;
const CACHE_ENTRY_BYTES = 64 * 1024;

class MemoryCache {
    async get(k: string, ns: string): Promise<any> {
        const entries = config.cache[ns];
        const entry = entries?.[k];
        if (entry && entry.expire > Date.now()) return entry.data;
        if (entries) delete entries[k];
        return null;
    }

    async put(k: string, v: any, ns: string, ttl = 300000): Promise<void> {
        const entries = config.cache[ns] ??= {};
        const now = Date.now();
        for (const key of Object.keys(entries)) {
            if (entries[key].expire <= now) delete entries[key];
        }
        delete entries[k];
        if (!v || new TextEncoder().encode(k + JSON.stringify(v)).byteLength > CACHE_ENTRY_BYTES) return;
        const keys = Object.keys(entries).filter(key => !(ns === 'meta' && key === '/'));
        if (keys.length >= CACHE_ENTRIES) delete entries[keys[0]];
        entries[k] = { data: v, expire: now + ttl };
    }

    async delete(k: string, ns: string): Promise<void> {
        if (ns === 'meta' && !k.endsWith('/')) k += '/';
        if (ns === 'meta' && k === '/') return;
        if (config.cache[ns]) delete config.cache[ns]![k];
    }

    async invalidateFileAndParent(fpath: string, parentId?: string | null): Promise<void> {
        const { parent } = splitPath(fpath);
        await this.delete(fpath, 'meta');
        if (parent !== fpath) await this.delete(parent, 'meta');
        if (parentId) await this.delete(parentId, 'objects');
    }

    async invalidateTransferPath(path: string, parentId?: string, tree = false): Promise<void> {
        const prefix = path.replace(/\/+$/, '') + '/';
        if (tree) {
            for (const key of Object.keys(config.cache.meta)) {
                if (key.startsWith(prefix)) delete config.cache.meta[key];
            }
        }
        await this.invalidateFileAndParent(path, parentId);
    }
}

class StatusError extends Error {
    status: number;
    code?: number;

    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

class TransferError extends StatusError {
    constructor(message: string, status: number, public definitive: boolean) {
        super(message, status);
    }
}

// The OAuth access token has its own short-lived isolate-local cache.
let tokenCache: { access_token: string; expires: number } | null = null;

async function readPropertyBody(request: Request): Promise<string> {
    if (!request.body) return '';
    const reader = request.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    let size = 0, text = '';
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 65536) {
                await reader.cancel();
                throw new StatusError('Property XML exceeds 64 KiB', 413);
            }
            text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
    } catch (error) {
        if (error instanceof TypeError) throw new StatusError('Property XML must be valid UTF-8', 400);
        throw error;
    } finally { reader.releaseLock(); }
}

const DAV_NAMESPACE = 'DAV:';
const DRIVE_NAMESPACE = 'urn:google:drive';
const PROPERTY_FIELDS = 'id,version,name,mimeType,size,modifiedTime,createdTime,description,starred,folderColorRgb,appProperties,parents';
const statusLabels: Record<number, string> = { 200: 'OK', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 424: 'Failed Dependency', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 507: 'Insufficient Storage' };
function propstat(xml: string, status: number, protectedProperty = false): string {
    return `<D:propstat><D:prop>${xml}</D:prop><D:status>HTTP/1.1 ${status} ${statusLabels[status] || 'Error'}</D:status>`
        + (protectedProperty ? '<D:error><D:cannot-modify-protected-property/></D:error>' : '') + '</D:propstat>';
}
function propertyResponse(path: string, folder: boolean, content: string): string {
    if (folder && !path.endsWith('/')) path += '/';
    return `<D:response><D:href>${escapeXml(encodePath(path))}</D:href>${content}</D:response>`;
}
function multiStatus(content: string): Response {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:">${content}</D:multistatus>`, {
        status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' }
    });
}
function isNativeProperty(property: DavProperty): boolean {
    return property.namespace === DAV_NAMESPACE && ['getlastmodified', 'lastmodified'].includes(property.name)
        || property.namespace === DRIVE_NAMESPACE && ['description', 'starred', 'modifiedTime', 'folderColorRgb'].includes(property.name);
}
function isProtectedProperty(property: DavProperty): boolean {
    return property.namespace === DAV_NAMESPACE && ['creationdate', 'getcontentlength', 'getcontenttype', 'getetag', 'resourcetype', 'supportedlock', 'lockdiscovery', 'quota-used-bytes', 'quota-available-bytes'].includes(property.name)
        || property.namespace === DRIVE_NAMESPACE && !['description', 'starred', 'modifiedTime', 'folderColorRgb'].includes(property.name);
}
function applyNativeProperty(patch: Record<string, unknown>, property: DavProperty, action: 'set' | 'remove', metadata: any): void {
    const field = property.namespace === DAV_NAMESPACE ? 'modifiedTime' : property.name;
    if (action === 'remove') {
        if (metadata[field] === undefined && patch[field] === undefined) return;
        // Clearing a description or un-starring is a SET, not removal of the
        // live property itself. Do not report a false successful REMOVE.
        throw new StatusError('This Drive live property cannot be removed; set an appropriate value instead', 409);
    }
    const element = new DOMParser().parseFromString(property.xml, 'application/xml').documentElement!;
    for (let node = element.firstChild; node; node = node.nextSibling) {
        if (node.nodeType === 1) throw new StatusError('This property requires a text value', 409);
    }
    const value = element.textContent || '';
    // ownCloud/rclone's writable DAV alias uses Unix seconds, not HTTP-date.
    if (property.namespace === DAV_NAMESPACE && property.name === 'lastmodified') {
        const seconds = Number(value);
        const date = new Date(seconds * 1000);
        if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(seconds) || !Number.isFinite(date.getTime())) throw new StatusError('Invalid timestamp', 409);
        patch.modifiedTime = date.toISOString();
        return;
    }
    if (field === 'description') patch.description = value;
    else if (field === 'starred') {
        if (!['true', 'false', '1', '0'].includes(value.trim())) throw new StatusError('Expected a boolean', 409);
        patch.starred = ['true', '1'].includes(value.trim());
    } else if (field === 'folderColorRgb') {
        if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new StatusError('Expected an RGB color', 409);
        patch.folderColorRgb = value;
    } else {
        // DAV uses an HTTP-date; the native extension uses RFC 3339.
        const validSyntax = property.namespace === DAV_NAMESPACE
            ? /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)
            : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
        const date = new Date(value);
        if (!validSyntax || !Number.isFinite(date.getTime())
            || (property.namespace === DAV_NAMESPACE ? date.toUTCString() !== value
                : new Date(value.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) !== value.slice(0, 10))) {
            throw new StatusError('Invalid timestamp', 409);
        }
        patch.modifiedTime = date.toISOString();
    }
}
const fileEtag = (file: any): string => '"' + (file.id || 'root') + '-' + (file.version ?? file.modifiedTime ?? '') + '"';

function davProperties(file: any, quota?: { used: string; available?: string }): Map<string, DavProperty> {
    const result = new Map<string, DavProperty>();
    const add = (name: string, value: unknown, namespace = DAV_NAMESPACE, raw = false) => {
        const prefix = namespace === DAV_NAMESPACE ? 'D' : 'G';
        const property = { namespace, name, xml: `<${prefix}:${name}${namespace === DAV_NAMESPACE ? '' : ` xmlns:${prefix}="${namespace}"`}>${raw ? value : escapeXml(value)}</${prefix}:${name}>` };
        result.set(propertyKey(property), property);
    };
    const folder = file.mimeType === FOLDER_MIME;
    add('resourcetype', folder ? '<D:collection/>' : '', DAV_NAMESPACE, true);
    add('displayname', file.name || '');
    if (!folder) {
        add('getcontentlength', Number(file.size) || 0);
        add('getcontenttype', file.mimeType || 'application/octet-stream');
    }
    add('getetag', fileEtag(file));
    if (file.modifiedTime) add('getlastmodified', new Date(file.modifiedTime).toUTCString());
    if (file.createdTime) add('creationdate', file.createdTime);
    // Keep the existing empty lock capability element (Class 1, no locks).
    result.set(propertyKey({ namespace: DAV_NAMESPACE, name: 'supportedlock' }), { namespace: DAV_NAMESPACE, name: 'supportedlock', xml: '<D:supportedlock/>' });
    if (quota) {
        add('quota-used-bytes', quota.used);
        // No finite limit is reported for unlimited Drive accounts. Do not
        // invent zero free space or round int64 quotas through Number.
        if (quota.available !== undefined) add('quota-available-bytes', quota.available);
    }
    for (const name of ['description', 'starred', 'modifiedTime', 'createdTime', 'folderColorRgb']) {
        if (file[name] !== undefined) add(name, file[name], DRIVE_NAMESPACE);
    }
    for (const [key, property] of readDeadProperties(file.appProperties)) {
        if (property.removed) result.delete(key);
        else result.set(key, property);
    }
    return result;
}

class GDrive {
    cache: MemoryCache;
    env: Env;
    owner: string;
    static fetchingTokenPromise: Promise<string> | null = null;

    constructor(env: Env, ctx: ExecutionContext<unknown>, owner = '') {
        this.owner = owner;
        this.env = env;
        this.cache = new MemoryCache();
    }

    async OPTIONS(request: Request): Promise<Response> {
        // Locking (Class 2) is not implemented.
        let allowed_methods = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'DELETE', 'MOVE', 'COPY', 'POST', 'PATCH'].join(',');
        return new Response(null, { status: 200, headers: { 'Allow': allowed_methods, 'DAV': '1', 'MS-Author-Via': 'DAV', 'Accept-Ranges': 'bytes', 'Tus-Version': '1.0.0', 'Tus-Extension': 'creation' } });
    }

    async PROPFIND(request: Request): Promise<Response> {
        const selection = parseFind(await readPropertyBody(request));
        const { rpath, fpath } = getUrl(request.url);
        let metadata = await this.getMetadata(fpath);
        if (!metadata) return new Response(null, { status: 404 });
        // The mapping root is otherwise synthetic; properties belong to the
        // actual Drive folder, including a configured ROOT_ID.
        if (fpath === '/') metadata = await this.getPropertyMetadata(metadata.id);
        const depth = request.headers.get('Depth');
        const files = [{ ...metadata, href: rpath }];
        if (metadata.mimeType === FOLDER_MIME && depth !== '0') {
            files.push(...(await this.getObjects(metadata.id)).map(file => ({ ...file, href: pathJoin(rpath, file.name) })));
        }
        const quota = metadata.mimeType === FOLDER_MIME && depth === '0' && fpath === '/' ? await this.getQuota() : undefined;
        const responses = files.map((file, index) => {
            const properties = davProperties(file, index === 0 ? quota : undefined);
            const requested = selection.mode === 'prop' ? selection.properties
                : [...properties.values(), ...selection.properties.filter(prop => !properties.has(propertyKey(prop)))];
            const found: string[] = [], missing: string[] = [];
            for (const prop of new Map(requested.map(prop => [propertyKey(prop), prop])).values()) {
                const value = properties.get(propertyKey(prop));
                if (value) found.push(selection.mode === 'propname' ? propertyNameXml(value) : value.xml);
                else missing.push(propertyNameXml(prop));
            }
            return propertyResponse(file.href, file.mimeType === FOLDER_MIME,
                (found.length || !missing.length ? propstat(found.join(''), 200) : '') + (missing.length ? propstat(missing.join(''), 404) : ''));
        });
        return multiStatus(responses.join(''));
    }

    async getPropertyMetadata(id: string): Promise<any> {
        const response = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id)
            + '?supportsAllDrives=true&fields=' + encodeURIComponent(PROPERTY_FIELDS), {
            headers: { Authorization: 'Bearer ' + (await this.getAccessToken()) }
        });
        if (!response.ok) throw new StatusError('Drive property read failed: ' + await response.text(), response.status);
        return response.json();
    }

    async MKCOL(request: Request): Promise<Response> {
        let { rpath, fpath } = getUrl(request.url);

        let metadata = await this.getMetadata(fpath);
        if (metadata) return new Response('<D:error xmlns:D="DAV:"><D:exception>MethodNotAllowed</D:exception><D:message>The resource you tried to create already exists</D:message></D:error>', { status: 405 });

        const { name, parent } = splitPath(fpath);
        const parentMetadata = await this.ensureDir(parent);
        if (!parentMetadata) return new Response(null, { status: 404 });

        let response = await fetch(new Request('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
            body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentMetadata.id] }),
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: 'Bearer ' + (await this.getAccessToken()) }
        }));

        if (response.ok) {
            await this.cache.invalidateFileAndParent(fpath, parentMetadata.id);
            return new Response(null, { status: 201 });
        }
        return new Response(await response.text(), { status: response.status });
    }

    async GET(request: Request): Promise<Response> {
        let { rpath, fpath } = getUrl(request.url);
        let url = new URL(request.url);
        let response: Response;
        const metadata = await this.getMetadata(fpath);
        if (metadata) {
            try {
                if (metadata.mimeType === FOLDER_MIME) {
                    // The listing below is built from relative links, so a
                    // collection URL without a trailing slash would resolve every
                    // child link against the wrong parent directory.
                    if (!url.pathname.endsWith('/')) {
                        const redirectUrl = new URL(request.url);
                        redirectUrl.pathname += '/';
                        return Response.redirect(redirectUrl.toString(), 301);
                    }
                    const objects = await this.getObjects(metadata.id);
                    let files: Partial<DriveFile>[] = [];
                    for (let i = 0; i < objects.length; i++) {
                        let object = objects[i];
                        files.push({ name: trimString(object.name, '/'), dir: object.mimeType === FOLDER_MIME, lastmodified: new Date(object.modifiedTime).toISOString().split('T')[0], size: object.size ? object.size : 0, iconLink: object.iconLink });
                    }
                    return new Response(arrayToHtml(rpath, files), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
                }
                const abuse = url.searchParams.get('abuse') === 'true';
                const range = request.headers.get('Range');
                const ifRange = request.headers.get('If-Range');
                response = await this.getRawContent(metadata.id, range, abuse);
                if (range && ifRange !== null && (response.status === 206 || response.status === 416)) {
                    // Drive ignores If-Range. Compare against the validator of
                    // the actual partial representation, never cached metadata.
                    const etag = response.headers.get('ETag');
                    const matches = etag !== null && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag) && ifRange === etag;
                    if (response.status === 416 || !matches) {
                        await response.body?.cancel();
                        response = await this.getRawContent(metadata.id, null, abuse);
                    }
                }
                if (response.status >= 400) {
                    // The body is not always JSON, and `errors` is not always
                    // populated; either would otherwise turn into a 500 that
                    // hides Drive's real status.
                    const result: any = await response.json().catch(() => ({}));
                    const reason = result?.error?.errors?.[0]?.reason;
                    if (!abuse && response.status === 403 && reason === 'cannotDownloadAbusiveFile') {
                        return Response.redirect(url.origin + url.pathname + '?abuse=true', 302);
                    }
                    throw new StatusError(result?.error?.message || response.statusText || 'Drive error', response.status);
                }
                response = new Response(response.body, response);
                response.headers.set('Accept-Ranges', 'bytes');
            } catch (e: any) { return new Response(e.message, { status: errorStatus(e) }); }
        } else { response = new Response(null, { status: 404 }); }
        return response;
    }

    async POST(request: Request): Promise<Response> {
        const version = this.tusVersion(request);
        if (version) return version;
        const rawLength = request.headers.get('Upload-Length');
        if (!rawLength || !/^\d+$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength))) {
            return this.tusError('Upload-Length must be a nonnegative integer', 400);
        }
        // Only the creation extension is offered. Do not silently discard data.
        if (request.headers.has('Upload-Defer-Length')) {
            return this.tusError('Deferred length and creation-with-upload are not supported', 400);
        }
        if (request.body) {
            const reader = request.body.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value.length) {
                        await reader.cancel();
                        return this.tusError('Creation-with-upload is not supported', 400);
                    }
                }
            } finally { reader.releaseLock(); }
        }
        const totalSize = Number(rawLength);
        const { fpath } = getUrl(request.url);
        const metadata = new Map<string, string>();
        const header = request.headers.get('Upload-Metadata');
        if (header) {
            try {
                for (const entry of header.split(',')) {
                    const match = /^([^\s,]+)(?: ([A-Za-z0-9+/]*={0,2}))?$/.exec(entry.trim());
                    if (!match || metadata.has(match[1])) throw new Error();
                    const bytes = Uint8Array.from(atob(match[2] || ''), c => c.charCodeAt(0));
                    metadata.set(match[1], ['filename', 'filetype', 'mtime'].includes(match[1])
                        ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) : '');
                }
            } catch { return this.tusError('Invalid Upload-Metadata', 400); }
        }
        const filename = metadata.get('filename');
        if (filename !== undefined && (!filename || filename === '.' || filename === '..' || /[\/\\\x00-\x1f\x7f]/.test(filename))) {
            return this.tusError('Invalid filename', 400);
        }
        const mimeType = metadata.get('filetype') || 'application/octet-stream';
        if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]*)?$/.test(mimeType)) return this.tusError('Invalid filetype', 400);
        let modifiedTime: string | undefined;
        const mtime = metadata.get('mtime');
        if (mtime !== undefined) {
            const milliseconds = Number(mtime) * 1000;
            if (!/^-?\d+$/.test(mtime) || !Number.isSafeInteger(milliseconds) || Math.abs(milliseconds) > 8640000000000000) {
                return this.tusError('Invalid mtime', 400);
            }
            modifiedTime = new Date(milliseconds).toISOString();
        }
        const targetPath = filename === undefined ? fpath : pathJoin(fpath, filename);
        const { name, parent } = splitPath(targetPath);
        if (!name) return this.tusError('A filename is required', 400);
        const parentMetadata = await this.ensureDir(parent);
        if (!parentMetadata) return this.tusError('Parent folder not found', 404);
        const existing = await this.getMetadata(targetPath);
        if (existing?.mimeType === FOLDER_MIME) return this.tusError('Cannot overwrite a collection', 409);
        const existingFileId = existing?.id || null;
        const namespace = this.env.TUS_UPLOADS;
        if (!namespace) return this.tusError('TUS_UPLOADS Durable Object binding is required', 503);
        let uploadUrl = '';
        if (totalSize === 0) {
            const response = await this.putEmpty(targetPath, name, parentMetadata.id, existingFileId, mimeType, modifiedTime);
            if (!response.ok) return this.tusError('Drive empty upload failed', response.status);
        } else {
            const api = 'https://www.googleapis.com/upload/drive/v3/files';
            const initUrl = existingFileId ? `${api}/${existingFileId}?uploadType=resumable` : `${api}?uploadType=resumable`;
            const response = await fetch(initUrl, {
                method: existingFileId ? 'PATCH' : 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Upload-Content-Type': mimeType,
                    'X-Upload-Content-Length': String(totalSize),
                    Authorization: 'Bearer ' + (await this.getAccessToken())
                },
                body: JSON.stringify(existingFileId ? { modifiedTime } : { name, parents: [parentMetadata.id], mimeType, modifiedTime })
            });
            uploadUrl = response.headers.get('Location') || '';
            if (!response.ok || !uploadUrl) return this.tusError('Drive upload initialization failed', response.ok ? 502 : response.status);
        }
        const sessionId = crypto.randomUUID();
        const stub = namespace.get(namespace.idFromName(sessionId));
        const initialized = await stub.fetch('https://tus.internal/initialize', {
            method: 'POST', body: JSON.stringify({ uploadUrl, totalSize, targetPath, parentId: parentMetadata.id, owner: this.owner, completed: totalSize === 0 })
        });
        if (!initialized.ok) return this.tusError('Upload session could not be persisted', 503);
        const basePath = config.path.endsWith('/') ? config.path : config.path + '/';
        return new Response(null, { status: 201, headers: {
            'Tus-Resumable': '1.0.0',
            Location: `${new URL(request.url).origin}${basePath}tus_uploads/${sessionId}`,
        } });
    }

    private tusError(message: string, status: number): Response {
        return new Response(message, { status, headers: { 'Tus-Resumable': '1.0.0' } });
    }

    private tusVersion(request: Request): Response | undefined {
        if (request.headers.get('Tus-Resumable') !== '1.0.0') {
            return new Response('Unsupported Tus-Resumable version', { status: 412, headers: { 'Tus-Version': '1.0.0', 'Tus-Resumable': '1.0.0' } });
        }
    }

    private async tusRequest(request: Request): Promise<Response> {
        const version = this.tusVersion(request);
        if (version) return version;
        const basePath = config.path.endsWith('/') ? config.path : config.path + '/';
        const path = new URL(request.url).pathname;
        const sessionId = path.slice((basePath + 'tus_uploads/').length);
        if (!path.startsWith(basePath + 'tus_uploads/') || !/^[0-9a-f-]{36}$/.test(sessionId)) return this.tusError('Session not found', 404);
        const namespace = this.env.TUS_UPLOADS;
        if (!namespace) return this.tusError('TUS_UPLOADS Durable Object binding is required', 503);
        const headers = new Headers(request.headers);
        headers.set('x-tus-owner', this.owner);
        const response = await namespace.get(namespace.idFromName(sessionId)).fetch(new Request('https://tus.internal/upload', { method: request.method, headers, body: request.body }));
        if (response.headers.get('x-tus-complete') === '1') {
            const targetPath = decodeURIComponent(response.headers.get('x-tus-target-path')!);
            await this.cache.invalidateFileAndParent(targetPath, response.headers.get('x-tus-parent-id')!)
                .catch(() => console.error('TUS cache invalidation failed'));
        }
        const result = new Response(response.body, response);
        for (const key of [...result.headers.keys()]) if (key.startsWith('x-tus-')) result.headers.delete(key);
        return result;
    }

    async PATCH(request: Request): Promise<Response> {
        return this.tusRequest(request);
    }

    private async putEmpty(fpath: string, name: string, parentId: string, existingFileId: string | null, mimeType: string, modifiedTime?: string): Promise<Response> {
        const api = 'https://www.googleapis.com/upload/drive/v3/files';
        if (existingFileId) {
            // A JSON PATCH with "{}" only touches metadata and would leave the
            // previous bytes behind, so truncate through the media endpoint.
            const response = await fetch(`${api}/${existingFileId}?uploadType=media`, {
                method: 'PATCH',
                headers: { 'Content-Type': mimeType, Authorization: 'Bearer ' + (await this.getAccessToken()) },
                body: new Uint8Array(0)
            });
            if (response.ok) {
                let metadataStatus = 204;
                if (modifiedTime !== undefined) {
                    const updated = await fetch(`https://www.googleapis.com/drive/v3/files/${existingFileId}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await this.getAccessToken()) },
                        body: JSON.stringify({ modifiedTime })
                    });
                    if (!updated.ok) metadataStatus = updated.status;
                }
                await this.cache.invalidateFileAndParent(fpath, parentId);
                return new Response(null, { status: metadataStatus });
            }
            return new Response(null, { status: response.status });
        }
        const response = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: 'Bearer ' + (await this.getAccessToken()) },
            body: JSON.stringify({ name, parents: [parentId], mimeType, modifiedTime })
        });
        if (response.ok) {
            await this.cache.invalidateFileAndParent(fpath, parentId);
            return new Response(null, { status: 201 });
        }
        return new Response(null, { status: response.status });
    }

    private async putUnknownLength(body: ReadableStream<Uint8Array>, fpath: string, name: string, parentId: string, existingFileId: string | null, mimeType: string): Promise<Response> {
        let uploadUrl: string | null = null;
        let offset = 0;
        try {
            for await (const { bytes, final } of uploadChunks(body)) {
                if (!bytes.length) return this.putEmpty(fpath, name, parentId, existingFileId, mimeType);
                if (!uploadUrl) {
                    const api = 'https://www.googleapis.com/upload/drive/v3/files';
                    const init = await fetch(`${api}${existingFileId ? '/' + existingFileId : ''}?uploadType=resumable`, {
                        method: existingFileId ? 'PATCH' : 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Upload-Content-Type': mimeType,
                            Authorization: 'Bearer ' + (await this.getAccessToken())
                        },
                        body: JSON.stringify(existingFileId ? {} : { name, parents: [parentId], mimeType })
                    });
                    if (!init.ok) return new Response('Failed to initiate Google Drive upload', { status: init.status });
                    uploadUrl = init.headers.get('Location');
                    if (!uploadUrl) return new Response('Failed to get Resumable Upload URL', { status: 502 });
                }
                const end = offset + bytes.length;
                const response = await fetch(uploadUrl, {
                    method: 'PUT',
                    headers: {
                        'Content-Length': String(bytes.length),
                        'Content-Range': `bytes ${offset}-${end - 1}/${final ? end : '*'}`
                    },
                    body: bytes
                });
                // Never report success or continue from an unconfirmed offset.
                // Ambiguous failures are not retried: the upload may have committed.
                if (final ? response.status !== 200 && response.status !== 201 : response.status !== 308) {
                    return new Response('Google Drive upload did not confirm the chunk', {
                        status: response.status >= 400 && response.status <= 599 ? response.status : 502
                    });
                }
                if (!final && response.headers.get('Range') !== `bytes=0-${end - 1}`) {
                    return new Response('Google Drive upload offset mismatch', { status: 502 });
                }
                offset = end;
            }
            await this.cache.invalidateFileAndParent(fpath, parentId);
            return new Response(null, { status: existingFileId ? 204 : 201 });
        } catch {
            // Do not expose the resumable session URL in errors or logs.
            return new Response('Upload failed', { status: 502 });
        }
    }

    async PUT(request: Request): Promise<Response> {
        let { fpath } = getUrl(request.url);
        if (fpath.slice(-1) === '/') return new Response(null, { status: 405 });
        const mimeType = request.headers.get('Content-Type') || 'application/octet-stream';

        const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
        const body: ReadableStream<Uint8Array> | null = request.body;

        const { name, parent } = splitPath(fpath);
        const parentMetadata = await this.ensureDir(parent);
        if (!parentMetadata) return new Response(null, { status: 404 });
        const metadata = await this.getMetadata(fpath);
        const existingFileId = metadata?.id || null;
        const api = 'https://www.googleapis.com/upload/drive/v3/files';
        if (body && !request.headers.has('Content-Length')) {
            return this.putUnknownLength(body, fpath, name, parentMetadata.id, existingFileId, mimeType);
        }
        if (contentLength === 0 || !body) {
            return this.putEmpty(fpath, name, parentMetadata.id, existingFileId, mimeType);
        }
        if (contentLength <= 5 * 1024 * 1024) {
            const reader = body.getReader();
            if (existingFileId) {
                // @ts-ignore
                const { readable, writable } = new FixedLengthStream(contentLength);
                const writer = writable.getWriter();
                const uploadPromise = fetch(`${api}/${existingFileId}?uploadType=media`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': mimeType, Authorization: 'Bearer ' + (await this.getAccessToken()) },
                    body: readable,
                    // @ts-ignore
                    duplex: 'half'
                });
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        await writer.write(value);
                    }
                    await writer.close();
                } catch (err) { try { await reader.cancel(); } catch (e) { } await writer.abort(err); } finally { reader.releaseLock(); }
                const res = await uploadPromise;
                if (res.ok) {
                    await this.cache.invalidateFileAndParent(fpath, parentMetadata.id);
                    return new Response(null, { status: 204 });
                }
                return new Response(await res.text(), { status: res.status });
            } else {
                const boundary = '-------webdav_boundary';
                const fileMetadata = JSON.stringify({ name: name, parents: [parentMetadata.id], mimeType: mimeType });
                const encoder = new TextEncoder();
                const preArray = encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${fileMetadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
                const postArray = encoder.encode(`\r\n--${boundary}--`);
                const totalLength = preArray.byteLength + contentLength + postArray.byteLength;
                const { readable, writable } = new FixedLengthStream(totalLength);
                const writer = writable.getWriter();
                const uploadPromise = fetch(`${api}?uploadType=multipart`, {
                    method: 'POST',
                    headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, Authorization: 'Bearer ' + (await this.getAccessToken()) },
                    body: readable,
                    // @ts-ignore
                    duplex: 'half'
                });

                try {
                    await writer.write(preArray);
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        await writer.write(value);
                    }
                    await writer.write(postArray);
                    await writer.close();
                } catch (err) { try { await reader.cancel(); } catch (e) { } await writer.abort(err); } finally { reader.releaseLock(); }

                const res = await uploadPromise;
                if (res.ok) {
                    await this.cache.invalidateFileAndParent(fpath, parentMetadata.id);
                    return new Response(null, { status: 201 });
                }
                return new Response(await res.text(), { status: res.status });
            }
        }

        const initUrl = existingFileId ? `${api}/${existingFileId}?uploadType=resumable` : `${api}?uploadType=resumable`;
        const initMethod = existingFileId ? 'PATCH' : 'POST';
        const initBody = existingFileId ? '{}' : JSON.stringify({ name, parents: [parentMetadata.id], mimeType });

        const initRes = await fetch(initUrl, {
            method: initMethod,
            headers: {
                'Content-Type': 'application/json',
                'X-Upload-Content-Type': mimeType,
                'X-Upload-Content-Length': contentLength.toString(),
                Authorization: 'Bearer ' + (await this.getAccessToken())
            },
            body: initBody
        });

        const uploadUrl = initRes.headers.get('Location');
        if (!uploadUrl) return new Response('Failed to get Resumable Upload URL', { status: 500 });

        const reader = body.getReader();
        const CHUNK_SIZE = 10 * 1024 * 1024;
        let offset = 0;
        let residualBuffer: Uint8Array | null = null;

        try {
            while (offset < contentLength) {
                const currentChunkSize = Math.min(CHUNK_SIZE, contentLength - offset);
                // @ts-ignore
                const { readable, writable } = new FixedLengthStream(currentChunkSize);
                const writer = writable.getWriter();

                const uploadPromise = fetch(uploadUrl, {
                    method: 'PUT',
                    headers: {
                        'Content-Length': `${currentChunkSize}`,
                        'Content-Range': `bytes ${offset}-${offset + currentChunkSize - 1}/${contentLength}`
                    },
                    body: readable,
                    // @ts-ignore
                    duplex: 'half'
                });

                let bytesSentInChunk = 0;
                while (bytesSentInChunk < currentChunkSize) {
                    let data: Uint8Array;
                    if (residualBuffer) {
                        data = residualBuffer;
                        residualBuffer = null;
                    } else {
                        const { done, value } = await reader.read();
                        if (done) break;
                        data = value;
                    }

                    const remaining = currentChunkSize - bytesSentInChunk;
                    if (data.length <= remaining) {
                        await writer.write(data);
                        bytesSentInChunk += data.length;
                    } else {
                        await writer.write(data.subarray(0, remaining));
                        residualBuffer = data.subarray(remaining);
                        bytesSentInChunk += remaining;
                    }
                }
                await writer.close();
                const chunkRes = await uploadPromise;

                if (chunkRes.status === 308) {
                } else if (chunkRes.status === 200 || chunkRes.status === 201) {
                    // completed; offset advances and loop exits
                } else {
                    throw new StatusError(`Google Drive chunk failed: ${await chunkRes.text()}`, chunkRes.status);
                }
                offset += currentChunkSize;
            }

            await this.cache.invalidateFileAndParent(fpath, parentMetadata.id);
            return new Response(null, { status: existingFileId ? 204 : 201 });

        } catch (err: any) {
            console.error('Upload Failed:', err);
            try { await reader.cancel(); } catch (e) { }
            return new Response(err?.message || 'Upload Failed', { status: errorStatus(err) });
        } finally {
            if (reader) reader.releaseLock();
        }
    }

    async MOVE(request: Request): Promise<Response> {
        return this.transfer(request, false);
    }

    async COPY(request: Request): Promise<Response> {
        return this.transfer(request, true);
    }

    // Drive has no atomic replace-by-name operation. Keep the old destination
    // recoverable in Trash, and never compensate an ambiguous write: it may
    // already have succeeded even when its response was lost.
    async transfer(request: Request, copy: boolean): Promise<Response> {
        const canonical = (path: string) => path.replace(/\/+$/, '') || '/';
        const fpath = canonical(getUrl(request.url).fpath);
        const destination = request.headers.get('Destination');
        if (!destination) return new Response(null, { status: 403 });
        const destPath = canonical(getUrl(destination).fpath);
        if (fpath === '/' || destPath === '/') return new Response(null, { status: 403 });

        const source = await this.getMetadata(fpath);
        if (!source) return new Response(null, { status: 404 });
        if (destPath === fpath) return new Response(null, { status: copy ? 403 : 204 });
        if (copy && source.mimeType === FOLDER_MIME) {
            return new Response('Collection COPY is not supported', { status: 403 });
        }
        // Reject overlapping trees before touching either resource. This is a
        // path guard, not a claim of isolation from concurrent Drive changes.
        if (fpath.startsWith(destPath + '/') || destPath.startsWith(fpath + '/')) {
            return new Response('Source and destination paths overlap', { status: 403 });
        }
        const target = await this.getMetadata(destPath);
        if (target?.id === source.id) return new Response(null, { status: copy ? 403 : 204 });
        if (target && (request.headers.get('Overwrite') || 'T').toUpperCase() === 'F') {
            return new Response(null, { status: 412 });
        }
        const { parent } = splitPath(fpath);
        const { name, parent: destParent } = splitPath(destPath);
        const sourceParentId = source.parents?.[0];
        // Same-directory operations already have the parent ID. Only resolve
        // the destination parent when needed; do not add read-after-write probes.
        const parentMetadata = parent === destParent && sourceParentId
            ? { id: sourceParentId, mimeType: FOLDER_MIME }
            : await this.getMetadata(destParent || '/');
        if (!parentMetadata || parentMetadata.mimeType !== FOLDER_MIME) {
            return new Response('Destination parent is not a collection', { status: 409 });
        }
        if (parentMetadata.id === source.id || parentMetadata.id === target?.id) {
            return new Response('Source and destination overlap', { status: 403 });
        }

        const parentId = parentMetadata.id;
        const headers = {
            'Content-Type': 'application/json; charset=UTF-8',
            Authorization: 'Bearer ' + (await this.getAccessToken())
        };
        let targetTrashed = false;
        let stageId: string | undefined;
        const stageName = copy && target ? '.webdav-copy-' + crypto.randomUUID() : undefined;
        try {
            if (copy) {
                const staged = await this.transferWrite(source.id, { name: stageName || name, parents: [parentId], ...(source.appProperties ? { appProperties: source.appProperties } : {}) }, headers, true);
                stageId = staged.id;
            }
            if (target) {
                await this.transferWrite(target.id, { trashed: true }, headers);
                targetTrashed = true;
            }
            if (copy) {
                if (target) await this.transferWrite(stageId!, { name }, headers);
            } else {
                const parents = sourceParentId !== parentId
                    ? '&addParents=' + encodeURIComponent(parentId) + (sourceParentId ? '&removeParents=' + encodeURIComponent(sourceParentId) : '')
                    : '';
                await this.transferWrite(source.id, { name }, headers, false, parents);
            }
            return new Response(null, {
                status: target ? 204 : 201,
                ...(!copy && !target ? { headers: { Location: destination } } : {})
            });
        } catch (error) {
            let message = error instanceof Error ? error.message : String(error);
            if (targetTrashed && error instanceof TransferError && error.definitive) {
                try {
                    await this.transferWrite(target.id, { trashed: false }, headers);
                    message += '; previous destination restored';
                } catch (restoreError) {
                    message += '; destination restore failed: ' + (restoreError instanceof Error ? restoreError.message : String(restoreError));
                }
            } else if (targetTrashed) {
                message += '; previous destination retained in Trash; write outcome uncertain, inspect before retrying';
            }
            // Retain staged data on failure rather than add cleanup writes that
            // could destroy a successfully published copy after a lost response.
            if (target) message += '; previous destination ID: ' + target.id;
            if (stageName) message += '; recovery copy: ' + stageName + (stageId ? ' (ID ' + stageId + ')' : ' (creation outcome may be uncertain)');
            return new Response(message, { status: errorStatus(error) });
        } finally {
            // Also evict after failed/ambiguous writes, not just confirmed ones.
            // Evict after Drive writes so the confirmed result is visible locally.
            // Cache failures must not hide the Drive outcome/recovery IDs or
            // prevent invalidating the other path. Local subtree eviction comes first.
            const invalidations = [this.cache.invalidateTransferPath(destPath, parentId, target?.mimeType === FOLDER_MIME)];
            if (!copy) invalidations.push(this.cache.invalidateTransferPath(fpath, sourceParentId, source.mimeType === FOLDER_MIME));
            await Promise.all(invalidations.map(promise => promise.catch(error => console.error('Transfer cache invalidation failed:', error))));
        }
    }

    async transferWrite(id: string, body: Record<string, unknown>, headers: Record<string, string>, copy = false, parents = ''): Promise<{ id: string }> {
        const response = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id)
            + (copy ? '/copy' : '') + '?supportsAllDrives=true&fields=id' + parents, {
            method: copy ? 'POST' : 'PATCH', headers, body: JSON.stringify(body)
        });
        if (!response.ok) {
            throw new TransferError('Drive write for ' + id + ' failed: ' + await response.text(), response.status,
                response.status >= 400 && response.status < 500 && response.status !== 408);
        }
        let result: any;
        try { result = await response.json(); } catch { /* success with an unreadable body is ambiguous */ }
        if (!result || typeof result.id !== 'string' || !result.id || (copy ? result.id === id : result.id !== id)) {
            throw new TransferError('Drive write for ' + id + ' returned no valid ID; outcome uncertain', 502, false);
        }
        return result;
    }

    async DELETE(request: Request): Promise<Response> {
        let { fpath } = getUrl(request.url);
        if (fpath === '/') return new Response(null, { status: 403 });
        const metadata = await this.getMetadata(fpath);
        if (metadata) {
            try {
                const response = await fetch('https://www.googleapis.com/drive/v3/files/' + metadata.id + '?supportsAllDrives=true', { method: 'DELETE', headers: { Authorization: 'Bearer ' + (await this.getAccessToken()) } });
                return new Response(null, { status: response.status });
            } finally {
                // Evict even after an ambiguous upstream failure. Clear local paths
                // first, and never replace the Drive outcome with a cache error.
                await this.cache.invalidateTransferPath(fpath, metadata.parents?.[0], metadata.mimeType === FOLDER_MIME)
                    .catch(error => console.error('DELETE cache invalidation failed:', error));
            }
        }
        return new Response(null, { status: 404 });
    }

    async HEAD(request: Request): Promise<Response> {
        let url = new URL(request.url);
        const basePath = config.path.endsWith('/') ? config.path : config.path + '/';
        if (url.pathname.startsWith(basePath + 'tus_uploads/')) return this.tusRequest(request);

        let { fpath } = getUrl(request.url);
        const metadata = await this.getMetadata(fpath);
        if (metadata) {
            const size = metadata.size ? metadata.size.toString() : '0';
            const mimeType = metadata.mimeType || 'application/octet-stream';
            const modifiedTime = metadata.modifiedTime ? new Date(metadata.modifiedTime).toUTCString() : new Date().toUTCString();
            return new Response(null, {
                status: 200,
                headers: {
                    'Content-Length': size,
                    'Content-Type': mimeType,
                    'Last-Modified': modifiedTime,
                    ...(metadata.mimeType !== FOLDER_MIME ? { 'Accept-Ranges': 'bytes' } : {})
                }
            });
        }
        return new Response(null, { status: 404 });
    }

    async LOCK(): Promise<Response> {
        return new Response('WebDAV locking is not supported', { status: 501 });
    }
    async UNLOCK(): Promise<Response> { return this.LOCK(); }
    async PROPPATCH(request: Request): Promise<Response> {
        const operations = parsePatch(await readPropertyBody(request));
        const { rpath, fpath } = getUrl(request.url);
        const resolved = await this.getMetadata(fpath);
        if (!resolved) return new Response(null, { status: 404 });
        // Read the current property document, not the path cache: this is the
        // input to the single PATCH, not a read-after-write verification loop.
        const metadata = await this.getPropertyMetadata(resolved.id);
        const dead = readDeadProperties(metadata.appProperties);
        const patch: Record<string, unknown> = {};
        const errors = new Map<string, { status: number; protected?: boolean }>();
        let deadChanged = false;
        for (const operation of operations) {
            const { property, action } = operation;
            const key = propertyKey(property);
            try {
                if (isProtectedProperty(property)) {
                    errors.set(key, { status: 403, protected: true });
                } else if (isNativeProperty(property)) {
                    applyNativeProperty(patch, property, action, metadata);
                } else {
                    if (action === 'set' && property.namespace === DAV_NAMESPACE && property.name === 'displayname') {
                        const element = new DOMParser().parseFromString(property.xml, 'application/xml').documentElement!;
                        if (Array.from(element.childNodes).some(node => node.nodeType === 1)) throw new StatusError('Display name requires text', 409);
                    }
                    if (action === 'remove') {
                        if (property.namespace === DAV_NAMESPACE && property.name === 'displayname') dead.set(key, { ...property, removed: true });
                        else dead.delete(key);
                    } else dead.set(key, property);
                    deadChanged = true;
                }
            } catch (error) { errors.set(key, { status: errorStatus(error) }); }
        }
        if (!errors.size && deadChanged) {
            try { patch.appProperties = writeDeadProperties(dead, metadata.appProperties || {}); }
            catch (error) {
                // Storage is shared by all dead properties in this request.
                for (const { property } of operations) if (!isNativeProperty(property)) errors.set(propertyKey(property), { status: errorStatus(error) });
            }
        }
        const result = (fallback: number) => {
            const unique = new Map(operations.map(({ property }) => [propertyKey(property), property]));
            return multiStatus(propertyResponse(rpath, metadata.mimeType === FOLDER_MIME,
                [...unique].map(([key, property]) => {
                    const error = errors.get(key);
                    return propstat(propertyNameXml(property), error?.status || fallback, error?.protected);
                }).join('')));
        };
        if (errors.size) return result(424);
        try {
            // One metadata PATCH is the atomic boundary. No split native/dead
            // writes, post-write checks, retries, or speculative rollback.
            const response = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(metadata.id)
                + '?supportsAllDrives=true&fields=id', {
                method: 'PATCH', headers: { Authorization: 'Bearer ' + (await this.getAccessToken()), 'Content-Type': 'application/json' },
                body: JSON.stringify(patch)
            });
            if (!response.ok) {
                const error: any = await response.json().catch(() => ({}));
                const reason = error.error?.errors?.[0]?.reason;
                const status = ['propertyLengthLimitExceeded', 'propertyCountLimitExceeded'].includes(reason) ? 507 : response.status;
                return result(status);
            }
            return result(200);
        } catch {
            // A lost response does not prove the PATCH failed. Do not claim
            // success or undo a potentially completed operation.
            return new Response('Drive property update outcome uncertain; read properties before retrying', { status: 502 });
        } finally {
            await this.cache.invalidateFileAndParent(fpath, metadata.parents?.[0])
                .catch(error => console.error('PROPPATCH cache invalidation failed:', error));
        }
    }

    // Create any missing folder along the way to `path`, so a client can PUT
    // `/a/b/c.txt` without having to MKCOL `/a` and `/a/b` first.
    async ensureDir(path: string): Promise<any | null> {
        let current = await this.getMetadata('/');
        if (!current) return null;
        const dir = path.endsWith('/') ? path : path + '/';
        if (dir === '/') return current;

        const names = dir.split('/').filter(Boolean);
        for (let i = 0; i < names.length; i++) {
            const sub = '/' + names.slice(0, i + 1).join('/') + '/';
            let meta = await this.getMetadata(sub);
            if (!meta) {
                const created = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: 'Bearer ' + (await this.getAccessToken()) },
                    body: JSON.stringify({ name: names[i], mimeType: FOLDER_MIME, parents: [current.id] })
                });
                if (!created.ok) return null;
                await this.cache.invalidateFileAndParent(sub, current.id);
                meta = await this.getMetadata(sub);
                if (!meta) return null;
            }
            current = meta;
        }
        return current;
    }

    async getMetadata(path: string): Promise<any> {
        path = path.startsWith('/') ? path : '/' + path;
        path = path.endsWith('/') ? path : path + '/';
        let meta = await this.cache.get(path, 'meta');
        if (meta) return meta;

        let fullpath = '/';
        let metadata = (config.cache.meta['/'] && config.cache.meta['/'].data) || null;
        if (!metadata) return null;

        const fragments = trimString(path, '/').split('/');

        for (let name of fragments) {
            if (!name) continue;
            fullpath += name + '/';
            meta = await this.cache.get(fullpath, 'meta');
            if (!meta) {
                // `getUrl` already decoded the path once; decoding again here
                // threw a URIError for any name containing a literal "%".
                const result = await this.queryDrive({
                    includeItemsFromAllDrives: true,
                    supportsAllDrives: true,
                    q: `'${metadata.id}' in parents and name = '${escapeQuery(name)}' and trashed = false`,
                    fields: `files(${PROPERTY_FIELDS},iconLink,thumbnailLink,imageMediaMetadata)`,
                });
                if (result.files && result.files.length > 0) {
                    await this.cache.put(fullpath, result.files[0], 'meta');
                    meta = result.files[0];
                } else {
                    return null;
                }
            }
            metadata = meta;
        }
        return metadata;
    }

    async getObjects(id: string): Promise<any[]> {
        let cachedList = await this.cache.get(id, 'objects');
        if (cachedList) return cachedList;

        let pageToken: string | undefined; const list: any[] = [];
        const params: any = {
            pageSize: 1000,
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            q: `'${id}' in parents and trashed = false AND name != '.password'`,
            fields: `nextPageToken, files(${PROPERTY_FIELDS},iconLink,thumbnailLink,imageMediaMetadata)`,
            orderBy: 'folder, name'
        };
        do {
            if (pageToken) params.pageToken = pageToken;
            const result = await this.queryDrive(params);
            pageToken = result.nextPageToken;
            if (result.files) list.push(...result.files);
        } while (pageToken);

        await this.cache.put(id, list, 'objects', 30000);
        return list;
    }

    async getRawContent(id: string, range: string | null, abuse: boolean): Promise<Response> {
        const headers: Record<string, string> = { Authorization: 'Bearer ' + (await this.getAccessToken()) };
        if (range) headers['Range'] = range;
        const url = new URL(`https://www.googleapis.com/drive/v2/files/${id}`);
        url.searchParams.set('supportsAllDrives', 'true');
        url.searchParams.set('alt', 'media');
        url.searchParams.set('acknowledgeAbuse', abuse ? 'true' : 'false');
        return await fetch(url.toString(), { headers });
    }

    async queryDrive(params: Record<string, any>, retryCount: number = 0): Promise<any> {
        const driveUrl = 'https://www.googleapis.com/drive/v3/files?' + encodeQueryString(params);
        const response = await fetch(driveUrl, { headers: { Authorization: 'Bearer ' + (await this.getAccessToken()) } });
        const result: any = await response.json();

        if (result.error) {
            const errMsg = result.error.message || '';
            const retriable = response.status === 429
                || (typeof response.status === 'number' && response.status >= 500)
                || errMsg.includes('Rate Limit')
                || errMsg.includes('Quota exceeded');
            if (retriable && retryCount < 3) {
                await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, retryCount)));
                return this.queryDrive(params, retryCount + 1);
            }
            throw new StatusError(errMsg || 'Unknown Google Drive API Error', response.status);
        }
        return result;
    }

    async getQuota(): Promise<{ available?: string; used: string } | undefined> {
        const response = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', { headers: { Authorization: 'Bearer ' + (await this.getAccessToken()) } });
        const result: any = await response.json();
        if (result.storageQuota) {
            const { limit, usage } = result.storageQuota;
            const used = BigInt(usage || '0');
            if (limit === undefined) return { used: used.toString() };
            const available = BigInt(limit) - used;
            return { available: (available < 0n ? 0n : available).toString(), used: used.toString() };
        }
    }

    async getAccessToken(): Promise<string> {
        if (tokenCache && tokenCache.expires > Date.now()) return tokenCache.access_token;
        if (GDrive.fetchingTokenPromise) {
            return await GDrive.fetchingTokenPromise;
        }
        GDrive.fetchingTokenPromise = (async () => {
            try {
                const response = await fetch('https://www.googleapis.com/oauth2/v4/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: encodeQueryString({
                        client_id: config.client_id,
                        client_secret: config.client_secret,
                        refresh_token: config.refresh_token,
                        grant_type: 'refresh_token'
                    })
                });
                const result: any = await response.json();
                if (result.error) {
                    throw new StatusError(result.error_description, response.status);
                }
                tokenCache = { expires: Date.now() + 3500 * 1000, access_token: result.access_token };
                return result.access_token;
            } finally {
                GDrive.fetchingTokenPromise = null;
            }
        })();
        return await GDrive.fetchingTokenPromise;
    }
}

function arrayToHtml(rpath: string, files: Partial<DriveFile>[]): string {
    const basePath = config.path.endsWith('/') ? config.path : config.path + '/';
    const isRoot = rpath === basePath || rpath + '/' === basePath;
    const title = isRoot ? '' : ' - ' + rpath;
    const tpl = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/><link rel="icon" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAApVBMVEUAAAD///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////+4/eNVAAAANnRSTlMA9isRpA3y8NfOoQjl3amJgVcX2sm/cUAw+MO6s5ttOhsU+urfrZB6dWZQRCPSlUsyBeueYCQaPAIhAAABdUlEQVQ4y23S2WKCQAwF0EsRkMWyivvWqrVqF7vc//+0mjhQRM9TkoEZJgENi/l34bp+UB5wx6n0WesmDlrSiFe+XnEl0OoTG6bNTcZUh4eLF81yG5VCC7vZtCp0tdALTdrR1AK4N5UhVR9qT5UCCXH1DktNXI0LCbnFRTiiks+YUx2lfuAKqqrG57Cn0QzKL2CsteyFWGgwcszWHOBiQLVHSVH3bdSrook5Y6Y3bnT0w4SZuamOaGGKD+f4GUYsKxGk/3UH9emkyjxpnz5Q3S2lyhrfaUnbX2Dwws9WK9t2HPTliOD/0He6lmCe592zN58cY0drUU1o4NgiO098OPz8/J2SWzkogvI2uBZ6OsKI3En6SrSMScsB5PeRRnPeWv+QEZnJboDARcszyaUEPxpw2FpPtGfVWMb9bWt9SfLNxCf5JTadThB0xKNak14Gw855h3dEzZnwRrFEU2m11hO0ZHHU2P39iFthGk96rrvux6mN2h80rVPh8HjxPAAAAABJRU5ErkJggg=="/><title>${config.name}{{title}}</title><style>*{box-sizing:border-box}body{font:15px/1.3 Helvetica,Arial;background:#0E1117;color:#CAD1D9}h1,main{background:#0E1117;max-width:960px;margin:10px auto;border-radius:5px}h1{font-size:18px;padding:15px;border:#22262D 1px solid;color:#DDD;background:#171b22}a{color:inherit;text-decoration:none}h1 a,main a{display:flex;align-items:center}main a:first-child{border-top-left-radius:5px;border-top-right-radius:5px}main a:last-child{border-bottom-left-radius:5px;border-bottom-right-radius:5px}svg{margin-right:15px;fill:#F1F6FC}h1:hover{color:#BABBBD}main{border:#22262D 1px solid}main img{margin-right:10px}main a{padding:12px 15px;border-bottom:#22262D 1px solid;transition:all .3s}main a:last-child{border:0}main a:hover{background:#171B22;color:#58a6ff}main a>div{margin-left:10px}main a>div:first-child{flex:1;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center}main a>div:not(:first-child){color:#8C949E;font-size:13px}footer{text-align:center;color:#8C949E;font-size:13px}footer a:hover{text-decoration:underline}@media (max-width:640px){main a>div:last-child{display:none}}</style></head><body><h1><a href="${basePath}"><svg width="32" height="32" viewBox="0 0 320 320"><path d="M95 304 c-47 -24 -71 -51 -84 -95 -26 -87 20 -173 107 -199 145 -44 262 135 165 251 -48 56 -128 75 -188 43z m168 -73 c9 -16 17 -32 17 -35 0 -3 -35 -6 -78 -6 -85 0 -78 -4 -110 63 -2 4 32 7 75 7 76 0 79 -1 96 -29z m-149 -46 c38 -65 38 -65 16 -100 -22 -36 -22 -36 -62 32 -40 68 -40 68 -22 101 9 17 20 32 23 32 4 0 24 -29 45 -65z m166 -9 c0 -12 -75 -129 -86 -133 -7 -2 -26 -3 -42 -1 -30 3 -30 3 9 71 39 65 41 67 79 67 22 0 40 -2 40 -4z" /></svg>${config.name}</a></h1><main>{{content}}</main><footer><a target="_blank" href="${config.copyright_link}">${config.copyright}</a></footer></body></html>`;
    let frag: string[] = [];
    if (!isRoot) frag.push(`<a href="../"><div><img src="/_/16/type/application/vnd.google-apps.folder"><b>../</b></div></a>`);
    if (files) {
        for (let i = 0; i < files.length; i++) {
            const entry = files[i];
            const rawName = entry.name || '';
            const iconLink = entry.iconLink ? entry.iconLink.replace('https://drive-thirdparty.googleusercontent.com/', '/_/') : '';
            const modTime = entry.lastmodified ? `<div>${escapeXml(new Date(entry.lastmodified).toISOString().split('T')[0])}</div>` : '';
            // Names come from Drive and are fully attacker controlled: escape them
            // for HTML text and percent-encode them for the href.
            const name = escapeXml(rawName);
            const href = encodeURIComponent(rawName);
            if (entry.dir) {
                frag.push(`<a href="${href}/"><div><img src="${escapeXml(iconLink)}"/><b>${name}</b></div>${modTime}</a>`);
            } else {
                frag.push(`<a href="${href}" target="_blank"><div><img src="${escapeXml(iconLink)}"/>${name}</div><div>${formatSize(entry.size || 0)}</div>${modTime}</a>`);
            }
        }
    }
    const content = frag.join('');
    // Replacer functions: substitution patterns such as `$&` in a file name
    // would otherwise be expanded by `String.prototype.replace`.
    return tpl.trim().replace(/{{content}}/, () => content).replace(/{{title}}/, () => escapeXml(title));
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const { protocol, pathname } = new URL(request.url);
        let method = request.method.toUpperCase();

        if (pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /', { status: 200 });
        if (pathname === '/favicon.ico') return new Response(null, { status: 204 });
        if (pathname.indexOf('/desktop.ini') !== -1) return new Response(null, { status: 404 });

        try {
            // Static
            if (pathname.startsWith('/_/')) {
                const url = new URL(request.url);
                url.hostname = 'drive-thirdparty.googleusercontent.com';
                url.pathname = url.pathname.slice(2);
                // Plain fetch: do not forward the client's credentials to a
                // third-party host.
                let response = await fetch(url.toString());
                response = new Response(response.body, response);
                response.headers.set('Access-Control-Allow-Origin', '*');
                response.headers.set('Cache-Control', 'public, max-age=16768000');
                return response;
            }

            // Env
            if (env && !config.env) {
                if (typeof env.USERS === 'string' && env.USERS.length > 0) {
                    try {
                        const users = JSON.parse(env.USERS);
                        // Silently keeping the placeholder credentials below
                        // would leave the server reachable as user/password.
                        config.users = users && typeof users === 'object' ? users : {};
                    } catch (error) {
                        console.error('USERS is not valid JSON');
                        config.users = {};
                    }
                } else if (typeof env.USERS === 'object' && env.USERS) {
                    config.users = env.USERS as Record<string, string>;
                } else {
                    // Fail closed: when running from bindings, a missing USERS
                    // variable must never fall back to the static placeholder
                    // credentials shipped in the default config.
                    config.users = {};
                }
                // Bindings must supply the complete OAuth configuration. Never
                // combine a partial binding with credentials from static CONFIG.
                config.client_id = env.CLIENT_ID?.trim() || '';
                config.client_secret = env.CLIENT_SECRET?.trim() || '';
                config.refresh_token = env.REFRESH_TOKEN?.trim() || '';
                if (env.ROOT_ID) config.cache.meta['/']!.data.id = env.ROOT_ID;
                if (env.PATH) config.path = env.PATH;
                if (env.NAME) config.name = env.NAME;
                if (env.COPYRIGHT) config.copyright = env.COPYRIGHT;
                if (env.COPYRIGHT_LINK) config.copyright_link = env.COPYRIGHT_LINK;
                config.env = true;
            }

            // Routing must use the binding on the first request, not CONFIG defaults.
            let basePath = config.path.endsWith('/') ? config.path : config.path + '/';
            if (basePath !== '/') {
                if (pathname + '/' === basePath) {
                    const u = new URL(request.url);
                    u.pathname += '/';
                    return Response.redirect(u.toString(), 301);
                }
                if (!pathname.startsWith(basePath)) {
                    return new Response('404 Not Found', { status: 404 });
                }
            }

            // Global Basic Authentication
            if (Object.keys(config.users).length === 0) {
                return new Response('Server not configured: set the USERS variable', { status: 500 });
            }
            if (!request.headers.has('Authorization')) {
                return new Response('Authentication Required.', {
                    status: 401,
                    headers: { 'WWW-Authenticate': `Basic realm="${config.name}", charset="UTF-8"` }
                });
            }

            const auth = basicAuthentication(request);
            if (!auth || !isValidUser(config.users, auth)) {
                return new Response('Unauthorized', { status: 401 });
            }

            const missing = [
                ['CLIENT_ID', config.client_id],
                ['CLIENT_SECRET', config.client_secret],
                ['REFRESH_TOKEN', config.refresh_token]
            ]
                .filter(([, value]) => !value)
                .map(([key]) => key);
            if (missing.length > 0) {
                return new Response('Server not configured: missing ' + missing.join(', '), { status: 500 });
            }

            const drive = new GDrive(env, ctx, auth.user);

            // Method Routing
            if (method === 'PATCH' && !pathname.startsWith(basePath + 'tus_uploads/')) {
                method = 'COPY';
            }

            if (typeof (drive as any)[method] === 'function') {
                return await (drive as any)[method](request);
            }

            return new Response('Method Not Allowed', { status: 405 });

        } catch (e: any) {
            const status = e.status || e.code || 500;
            return new Response(status + ': ' + e.message, { status });
        }
    }
};
