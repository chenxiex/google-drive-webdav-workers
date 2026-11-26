import { type DriveClient } from '../drive/client';
import { FOLDER_MIME, fileEtag } from '../drive/types';
import { StatusError, errorStatus, getUrl, splitPath } from '../http';

export function handleOptions(isTusPath = false): Response {
    // Locking (Class 2) is not implemented; PATCH is supported only on TUS upload URLs.
    const allowed_methods = [
        'GET', 'HEAD', 'OPTIONS', 'PUT', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'DELETE', 'MOVE', 'COPY', 'POST',
        ...(isTusPath ? ['PATCH'] : []),
    ].join(',');
    return new Response(null, { status: 200, headers: { 'Allow': allowed_methods, 'DAV': '1', 'MS-Author-Via': 'DAV', 'Accept-Ranges': 'bytes', 'Tus-Version': '1.0.0', 'Tus-Extension': 'creation' } });
}

export async function handleMkcol(drive: DriveClient, request: Request): Promise<Response> {
    const { fpath } = getUrl(request.url, drive.config.basePath);

    const { name, parent } = splitPath(fpath);
    const parentMetadata = await drive.getFolderMetadata(parent);
    if (!parentMetadata) return new Response('Parent collection is missing or not a collection', { status: 409 });

    const metadata = await drive.getMetadata(fpath);
    if (metadata) return new Response('<D:error xmlns:D="DAV:"><D:exception>MethodNotAllowed</D:exception><D:message>The resource you tried to create already exists</D:message></D:error>', { status: 405 });

    const response = await drive.createFolder(name, parentMetadata.id);

    if (response.ok) {
        await drive.cache.invalidateFileAndParent(fpath, parentMetadata.id);
        return new Response(null, { status: 201 });
    }
    return new Response(await response.text(), { status: response.status });
}

function methodNotAllowedOnCollection(): Response {
    return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'HEAD, OPTIONS, PROPFIND, PROPPATCH, DELETE, MOVE, POST' },
    });
}

export async function handleGet(drive: DriveClient, request: Request): Promise<Response> {
    const { fpath } = getUrl(request.url, drive.config.basePath);
    const url = new URL(request.url);
    const range = request.headers.get('Range');
    const ifRange = request.headers.get('If-Range');
    const bypassLeafCache = !range || ifRange !== null;
    const metadata = await drive.getMetadata(fpath, { bypassLeafCache });
    if (!metadata) return new Response(null, { status: 404 });

    try {
        if (metadata.mimeType === FOLDER_MIME) return methodNotAllowedOnCollection();

        const abuse = url.searchParams.get('abuse') === 'true';
        let effectiveRange = range;

        if (range && ifRange !== null) {
            const liveEtag = fileEtag(metadata);
            const matches = liveEtag !== undefined && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(ifRange) && ifRange === liveEtag;
            if (!matches) effectiveRange = null;
        }

        const revisionId = typeof metadata.headRevisionId === 'string' && metadata.headRevisionId
            ? metadata.headRevisionId
            : null;
        let response: Response;
        if (revisionId) {
            response = await drive.getRevisionContent(metadata.id, revisionId, effectiveRange, abuse);
            if (response.status === 403) {
                const result: any = await response.json().catch(() => ({}));
                const reason = result?.error?.errors?.[0]?.reason;
                if (!abuse && reason === 'cannotDownloadAbusiveFile') {
                    return Response.redirect(url.origin + url.pathname + '?abuse=true', 302);
                }
                response = await drive.getFileContent(metadata.id, effectiveRange, abuse);
            } else if (response.status === 404) {
                await response.body?.cancel();
                await drive.cache.invalidateFileAndParent(fpath, metadata.parents?.[0]);
                response = await drive.getFileContent(metadata.id, effectiveRange, abuse);
            }
        } else {
            response = await drive.getFileContent(metadata.id, effectiveRange, abuse);
        }

        if (response.status >= 400 && response.status !== 416) {
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
        const etag = fileEtag(metadata);
        if (etag) response.headers.set('ETag', etag);
        return response;
    } catch (e: any) { return new Response(e.message, { status: errorStatus(e) }); }
}

export async function handleHead(drive: DriveClient, request: Request): Promise<Response> {
    const { fpath } = getUrl(request.url, drive.config.basePath);
    const metadata = await drive.getMetadata(fpath, { bypassLeafCache: true });
    if (metadata) {
        const size = metadata.size ? metadata.size.toString() : '0';
        const mimeType = metadata.mimeType || 'application/octet-stream';
        const modifiedTime = metadata.modifiedTime ? new Date(metadata.modifiedTime).toUTCString() : new Date().toUTCString();
        const etag = metadata.mimeType !== FOLDER_MIME ? fileEtag(metadata) : undefined;
        return new Response(null, {
            status: 200,
            headers: {
                'Content-Length': size,
                'Content-Type': mimeType,
                'Last-Modified': modifiedTime,
                ...(metadata.mimeType !== FOLDER_MIME ? { 'Accept-Ranges': 'bytes' } : {}),
                ...(etag ? { 'ETag': etag } : {}),
            },
        });
    }
    return new Response(null, { status: 404 });
}

export async function handleDelete(drive: DriveClient, request: Request): Promise<Response> {
    const { fpath } = getUrl(request.url, drive.config.basePath);
    if (fpath === '/') return new Response(null, { status: 403 });
    const metadata = await drive.getMetadata(fpath);
    if (metadata) {
        try {
            const response = await drive.trashFile(metadata.id);
            if (response.ok) {
                await response.body?.cancel();
                return new Response(null, { status: 204 });
            }
            return new Response(await response.text(), { status: response.status });
        } finally {
            // Evict even after an ambiguous upstream failure. Clear local paths
            // first, and never replace the Drive outcome with a cache error.
            await drive.cache.invalidateTransferPath(fpath, metadata.parents?.[0], metadata.mimeType === FOLDER_MIME)
                .catch(error => console.error('DELETE cache invalidation failed:', error));
        }
    }
    return new Response(null, { status: 404 });
}

export function handleLock(): Response {
    return new Response('WebDAV locking is not supported', { status: 501 });
}
