import { type DriveClient } from '../drive/client';
import { FOLDER_MIME, fileEtag } from '../drive/types';
import { StatusError, errorStatus, escapeXml, formatDavHref } from '../http';
import { PERSONAL_SPACE_NAME, personalSpaceId } from '../ocis/profile';
import { UPLOAD_FILE_PERM } from '../tus/protocol';
import { type DavMount } from './mount';
import { DavProperty, key as propertyKey, parseFind, parsePatch, propertyNameXml, readDeadProperties, writeDeadProperties } from './property-xml';

const DAV_NAMESPACE = 'DAV:';
const DRIVE_NAMESPACE = 'urn:google:drive';
const OC_NAMESPACE = 'http://owncloud.org/ns';

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

function propertyResponse(href: string, content: string): string {
    return `<D:response><D:href>${escapeXml(href)}</D:href>${content}</D:response>`;
}

function multiStatus(content: string, extraHeaders?: Record<string, string>): Response {
    return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:" xmlns:oc="http://owncloud.org/ns">${content}</D:multistatus>`,
        {
            status: 207,
            headers: {
                'Content-Type': 'application/xml; charset=utf-8',
                'Cache-Control': 'no-store',
                ...extraHeaders,
            },
        },
    );
}

const PROTECTED_DAV_PROPS = new Set([
    'creationdate', 'getcontentlength', 'getcontenttype', 'getetag',
    'resourcetype', 'supportedlock', 'lockdiscovery', 'quota-used-bytes', 'quota-available-bytes',
]);
const PROTECTED_OC_PROPS = new Set([
    'id', 'fileid', 'spaceid', 'file-parent', 'name', 'permissions', 'size', 'has-preview',
]);

function isNativeProperty(property: DavProperty): boolean {
    return property.namespace === DAV_NAMESPACE && ['getlastmodified', 'lastmodified'].includes(property.name)
        || property.namespace === DRIVE_NAMESPACE && ['description', 'starred', 'modifiedTime', 'folderColorRgb'].includes(property.name);
}

function isProtectedProperty(property: DavProperty): boolean {
    return (property.namespace === DAV_NAMESPACE && PROTECTED_DAV_PROPS.has(property.name))
        || (property.namespace === DRIVE_NAMESPACE && !['description', 'starred', 'modifiedTime', 'folderColorRgb'].includes(property.name))
        || (property.namespace === OC_NAMESPACE && PROTECTED_OC_PROPS.has(property.name));
}

function parsePropfindDepth(request: Request): '0' | '1' | Response {
    const raw = request.headers.get('Depth');
    if (raw === null) return '1';
    const normalized = raw.trim().toLowerCase();
    if (normalized === '0' || normalized === '1') return normalized;
    if (normalized === 'infinity') {
        return new Response('<?xml version="1.0" encoding="UTF-8"?><D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>', {
            status: 403,
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
    }
    return new Response('Invalid Depth header for PROPFIND; expected 0 or 1', { status: 400 });
}

function prefersReturnMinimal(request: Request): boolean {
    const prefer = request.headers.get('Prefer');
    if (!prefer) return false;
    for (const part of prefer.split(',')) {
        const token = part.split(';', 1)[0].trim();
        if (/^return=(?:"minimal"|minimal)$/i.test(token)) return true;
    }
    return false;
}

function fileSizeString(file: { size?: string | number | null }): string {
    if (typeof file.size === 'string') {
        const trimmed = file.size.trim();
        if (/^\d+$/.test(trimmed)) return trimmed;
    }
    if (typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0) {
        return String(Math.trunc(file.size));
    }
    return '0';
}

function ocPermissions(file: any, folder: boolean): string {
    if (file?.capabilities?.canEdit === false) return 'R';
    return folder ? 'RDNVCK' : UPLOAD_FILE_PERM;
}

const isIgnoredProperty = (property: DavProperty): boolean =>
    property.namespace === OC_NAMESPACE && property.name === 'checksums';

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

function fileChecksums(file: any): string | undefined {
    const parts: string[] = [];
    if (typeof file.sha1Checksum === 'string' && file.sha1Checksum) parts.push('SHA1:' + file.sha1Checksum);
    if (typeof file.md5Checksum === 'string' && file.md5Checksum) parts.push('MD5:' + file.md5Checksum);
    if (typeof file.sha256Checksum === 'string' && file.sha256Checksum) parts.push('SHA256:' + file.sha256Checksum);
    return parts.length ? parts.join(' ') : undefined;
}

function davProperties(
    file: any,
    options: {
        spaceId: string;
        isRoot: boolean;
        quota?: { used: string; available?: string };
        folderEtagOverride?: string;
    },
): Map<string, DavProperty> {
    const result = new Map<string, DavProperty>();
    const add = (name: string, value: unknown, namespace = DAV_NAMESPACE, raw = false) => {
        const prefix = namespace === DAV_NAMESPACE ? 'D' : namespace === OC_NAMESPACE ? 'oc' : 'G';
        const nsDecl = namespace === DAV_NAMESPACE || namespace === OC_NAMESPACE ? '' : ` xmlns:${prefix}="${namespace}"`;
        const property = { namespace, name, xml: `<${prefix}:${name}${nsDecl}>${raw ? value : escapeXml(value)}</${prefix}:${name}>` };
        result.set(propertyKey(property), property);
    };
    const folder = file.mimeType === FOLDER_MIME;
    add('resourcetype', folder ? '<D:collection/>' : '', DAV_NAMESPACE, true);
    add('displayname', file.name || '');
    if (!folder) {
        add('getcontentlength', fileSizeString(file));
        add('getcontenttype', file.mimeType || 'application/octet-stream');
    }
    const etag = folder ? (options.folderEtagOverride ?? fileEtag(file)) : fileEtag(file);
    if (etag) add('getetag', etag);
    if (file.modifiedTime) add('getlastmodified', new Date(file.modifiedTime).toUTCString());
    if (file.createdTime) add('creationdate', file.createdTime);
    // Keep the existing empty lock capability element (Class 1, no locks).
    result.set(propertyKey({ namespace: DAV_NAMESPACE, name: 'supportedlock' }), { namespace: DAV_NAMESPACE, name: 'supportedlock', xml: '<D:supportedlock/>' });
    if (options.quota) {
        add('quota-used-bytes', options.quota.used);
        // No finite limit is reported for unlimited Drive accounts. Do not
        // invent zero free space or round int64 quotas through Number.
        if (options.quota.available !== undefined) add('quota-available-bytes', options.quota.available);
    }
    for (const name of ['description', 'starred', 'modifiedTime', 'createdTime', 'folderColorRgb']) {
        if (file[name] !== undefined) add(name, file[name], DRIVE_NAMESPACE);
    }
    for (const [key, property] of readDeadProperties(file.appProperties)) {
        if (property.removed) result.delete(key);
        else result.set(key, property);
    }
    if (typeof file.id === 'string' && file.id) {
        add('id', file.id, OC_NAMESPACE);
        add('fileid', file.id, OC_NAMESPACE);
    }
    add('spaceid', options.spaceId, OC_NAMESPACE);
    if (!options.isRoot && Array.isArray(file.parents) && typeof file.parents[0] === 'string' && file.parents[0]) {
        add('file-parent', file.parents[0], OC_NAMESPACE);
    }
    const ocName = typeof file.name === 'string' && file.name ? file.name : (options.isRoot ? PERSONAL_SPACE_NAME : '');
    if (ocName !== '') {
        add('name', ocName, OC_NAMESPACE);
    }
    add('permissions', ocPermissions(file, folder), OC_NAMESPACE);
    add('size', folder ? '0' : fileSizeString(file), OC_NAMESPACE);
    add('has-preview', !folder && typeof file.thumbnailLink === 'string' && file.thumbnailLink.length > 0 ? '1' : '0', OC_NAMESPACE);
    if (!folder) {
        const checksums = fileChecksums(file);
        if (checksums) add('checksums', `<oc:checksum>${escapeXml(checksums)}</oc:checksum>`, OC_NAMESPACE, true);
    }
    return result;
}

export async function handlePropfind(drive: DriveClient, request: Request, mount: DavMount): Promise<Response> {
    const selection = parseFind(await readPropertyBody(request));
    const depth = parsePropfindDepth(request);
    if (depth instanceof Response) return depth;
    const returnMinimal = prefersReturnMinimal(request);
    const { fpath } = mount;
    if (drive.sync) {
        await drive.sync.poll();
    }
    let metadata = await drive.getMetadata(fpath);
    if (!metadata) return new Response(null, { status: 404 });
    // The mapping root is otherwise synthetic; properties belong to the
    // actual Drive folder, including a configured ROOT_ID.
    if (fpath === '/') metadata = await drive.getPropertyMetadata(metadata.id);
    const files = [{ ...metadata, href: formatDavHref(mount.hrefBase, mount.segments, metadata.mimeType === FOLDER_MIME) }];
    if (metadata.mimeType === FOLDER_MIME) {
        if (drive.sync) {
            await drive.sync.getGeneration(metadata.id);
        }
        if (depth !== '0') {
            files.push(...(await drive.getObjects(metadata.id)).map(file => ({
                ...file,
                href: formatDavHref(mount.hrefBase, [...mount.segments, file.name], file.mimeType === FOLDER_MIME),
            })));
        }
    }
    const folderIds = files.filter(file => file.mimeType === FOLDER_MIME).map(file => file.id as string);
    const folderEtags = drive.sync && folderIds.length > 0
        ? await drive.sync.getFolderEtags(folderIds)
        : undefined;
    const spaceId = personalSpaceId(drive.config.rootId);
    const quota = metadata.mimeType === FOLDER_MIME && depth === '0' && fpath === '/' ? await drive.getQuota() : undefined;
    const responses = files.map((file, index) => {
        const properties = davProperties(file, {
            spaceId,
            isRoot: index === 0 && fpath === '/',
            quota: index === 0 ? quota : undefined,
            folderEtagOverride: folderEtags?.get(file.id),
        });
        const requested = selection.mode === 'prop' ? selection.properties
            : [...properties.values(), ...selection.properties.filter(prop => !properties.has(propertyKey(prop)))];
        const found: string[] = [], missing: string[] = [];
        for (const prop of new Map(requested.map(prop => [propertyKey(prop), prop])).values()) {
            const value = properties.get(propertyKey(prop));
            if (value) found.push(selection.mode === 'propname' ? propertyNameXml(value) : value.xml);
            else missing.push(propertyNameXml(prop));
        }
        const include200 = found.length > 0 || !missing.length || returnMinimal;
        const include404 = missing.length > 0 && !returnMinimal;
        return propertyResponse(
            file.href,
            (include200 ? propstat(found.join(''), 200) : '') + (include404 ? propstat(missing.join(''), 404) : ''),
        );
    });
    return multiStatus(responses.join(''), returnMinimal ? { 'Preference-Applied': 'return=minimal' } : undefined);
}

export async function handleProppatch(drive: DriveClient, request: Request, mount: DavMount): Promise<Response> {
    const operations = parsePatch(await readPropertyBody(request));
    const { fpath } = mount;
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
            } else if (isIgnoredProperty(property)) {
                // Client-supplied oc:checksums digests (e.g. rclone PROPPATCH
                // alongside DAV:lastmodified) are a silent 200 no-op; never
                // persist them into appProperties.
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
            for (const { property } of operations) {
                if (!isNativeProperty(property) && !isIgnoredProperty(property)) errors.set(propertyKey(property), { status: errorStatus(error) });
            }
        }
    }
    const targetHref = formatDavHref(mount.hrefBase, mount.segments, metadata.mimeType === FOLDER_MIME);
    const result = (fallback: number) => {
        const unique = new Map(operations.map(({ property }) => [propertyKey(property), property]));
        return multiStatus(propertyResponse(targetHref,
            [...unique].map(([key, property]) => {
                const error = errors.get(key);
                return propstat(propertyNameXml(property), error?.status || fallback, error?.protected);
            }).join('')));
    };
    if (errors.size) return result(424);
    if (!Object.keys(patch).length) return result(200);
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
        await drive.notifySync({
            type: 'touch',
            id: metadata.id,
            parentId: metadata.parents?.[0],
            isFolder: metadata.mimeType === FOLDER_MIME,
        });
        return result(200);
    } catch {
        // A lost response does not prove the PATCH failed. Do not claim
        // success or undo a potentially completed operation.
        await drive.notifySync({
            type: 'touch',
            id: metadata.id,
            parentId: metadata.parents?.[0],
            isFolder: metadata.mimeType === FOLDER_MIME,
        }).catch(error => console.error('PROPPATCH sync invalidation failed:', error));
        return new Response('Drive property update outcome uncertain; read properties before retrying', { status: 502 });
    } finally {
        await drive.cache.invalidateFileAndParent(fpath, metadata.parents?.[0])
            .catch(error => console.error('PROPPATCH cache invalidation failed:', error));
    }
}
