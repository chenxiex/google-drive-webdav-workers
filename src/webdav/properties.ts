import { type DriveClient } from '../drive/client';
import { FOLDER_MIME } from '../drive/types';
import { StatusError, encodePath, errorStatus, escapeXml, getUrl, pathJoin } from '../http';
import { DavProperty, key as propertyKey, parseFind, parsePatch, propertyNameXml, readDeadProperties, writeDeadProperties } from './property-xml';

const DAV_NAMESPACE = 'DAV:';
const DRIVE_NAMESPACE = 'urn:google:drive';

const statusLabels: Record<number, string> = {
    200: 'OK',
    400: 'Bad Request',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    424: 'Failed Dependency',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    507: 'Insufficient Storage',
};

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
        status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' },
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

function applyNativeProperty(patch: Record<string, unknown>, property: DavProperty, action: 'set' | 'remove', metadata: any, text: string, hasElements: boolean): void {
    const field = property.namespace === DAV_NAMESPACE ? 'modifiedTime' : property.name;
    if (action === 'remove') {
        if (metadata[field] === undefined && patch[field] === undefined) return;
        // Clearing a description or un-starring is a SET, not removal of the
        // live property itself. Do not report a false successful REMOVE.
        throw new StatusError('This Drive live property cannot be removed; set an appropriate value instead', 409);
    }
    if (hasElements) throw new StatusError('This property requires a text value', 409);
    const value = text;
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

export async function handlePropfind(drive: DriveClient, request: Request): Promise<Response> {
    const selection = parseFind(await readPropertyBody(request));
    const { rpath, fpath } = getUrl(request.url, drive.config.basePath);
    let metadata = await drive.getMetadata(fpath);
    if (!metadata) return new Response(null, { status: 404 });
    // The mapping root is otherwise synthetic; properties belong to the
    // actual Drive folder, including a configured ROOT_ID.
    if (fpath === '/') metadata = await drive.getPropertyMetadata(metadata.id);
    const depth = request.headers.get('Depth');
    const files = [{ ...metadata, href: rpath }];
    if (metadata.mimeType === FOLDER_MIME && depth !== '0') {
        files.push(...(await drive.getObjects(metadata.id)).map(file => ({ ...file, href: pathJoin(rpath, file.name) })));
    }
    const quota = metadata.mimeType === FOLDER_MIME && depth === '0' && fpath === '/' ? await drive.getQuota() : undefined;
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

export async function handleProppatch(drive: DriveClient, request: Request): Promise<Response> {
    const operations = parsePatch(await readPropertyBody(request));
    const { rpath, fpath } = getUrl(request.url, drive.config.basePath);
    const resolved = await drive.getMetadata(fpath);
    if (!resolved) return new Response(null, { status: 404 });
    // Read the current property document, not the path cache: this is the
    // input to the single PATCH, not a read-after-write verification loop.
    const metadata = await drive.getPropertyMetadata(resolved.id);
    const dead = readDeadProperties(metadata.appProperties);
    const patch: Record<string, unknown> = {};
    const errors = new Map<string, { status: number; protected?: boolean }>();
    let deadChanged = false;
    for (const operation of operations) {
        const { property, action, text, hasElements } = operation;
        const key = propertyKey(property);
        try {
            if (isProtectedProperty(property)) {
                errors.set(key, { status: 403, protected: true });
            } else if (isNativeProperty(property)) {
                applyNativeProperty(patch, property, action, metadata, text, hasElements);
            } else {
                if (action === 'set' && property.namespace === DAV_NAMESPACE && property.name === 'displayname' && hasElements) {
                    throw new StatusError('Display name requires text', 409);
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
        const response = await drive.updateFileMetadata(metadata.id, patch, 'supportsAllDrives=true&fields=id');
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
        await drive.cache.invalidateFileAndParent(fpath, metadata.parents?.[0])
            .catch(error => console.error('PROPPATCH cache invalidation failed:', error));
    }
}
