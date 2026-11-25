import { type DriveClient } from '../drive/client';
import { FOLDER_MIME } from '../drive/types';
import { StatusError, errorStatus, getUrl, splitPath } from '../http';

export function handleOptions(): Response {
    // Locking (Class 2) is not implemented.
    const allowed_methods = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'DELETE', 'MOVE', 'COPY', 'POST', 'PATCH'].join(',');
    return new Response(null, { status: 200, headers: { 'Allow': allowed_methods, 'DAV': '1', 'MS-Author-Via': 'DAV', 'Accept-Ranges': 'bytes', 'Tus-Version': '1.0.0', 'Tus-Extension': 'creation' } });
}

export async function handleMkcol(drive: DriveClient, request: Request): Promise<Response> {
    const { fpath } = getUrl(request.url, drive.config.basePath);

    const metadata = await drive.getMetadata(fpath);
    if (metadata) return new Response('<D:error xmlns:D="DAV:"><D:exception>MethodNotAllowed</D:exception><D:message>The resource you tried to create already exists</D:message></D:error>', { status: 405 });

    const { name, parent } = splitPath(fpath);
    const parentMetadata = await drive.ensureDir(parent);
    if (!parentMetadata) return new Response(null, { status: 404 });

    const response = await drive.createFolder(name, parentMetadata.id);

    if (response.ok) {
        await drive.cache.invalidateFileAndParent(fpath, parentMetadata.id);
        return new Response(null, { status: 201 });
    }
    return new Response(await response.text(), { status: response.status });
}

export async function handleGet(drive: DriveClient, request: Request): Promise<Response> {
    const { fpath } = getUrl(request.url, drive.config.basePath);
    const url = new URL(request.url);
    let response: Response;
    const metadata = await drive.getMetadata(fpath);
    if (metadata) {
        try {
            if (metadata.mimeType === FOLDER_MIME) {
                return new Response('Method Not Allowed', {
                    status: 405,
                    headers: { Allow: 'HEAD, OPTIONS, PROPFIND, PROPPATCH, DELETE, MOVE, POST' },
                });
            }
            const abuse = url.searchParams.get('abuse') === 'true';
            const range = request.headers.get('Range');
            const ifRange = request.headers.get('If-Range');
            response = await drive.getRawContent(metadata.id, range, abuse);
            if (range && ifRange !== null && (response.status === 206 || response.status === 416)) {
                // Drive ignores If-Range. Compare against the validator of
                // the actual partial representation, never cached metadata.
                const etag = response.headers.get('ETag');
                const matches = etag !== null && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag) && ifRange === etag;
                if (response.status === 416 || !matches) {
                    await response.body?.cancel();
                    response = await drive.getRawContent(metadata.id, null, abuse);
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

export async function handleHead(drive: DriveClient, request: Request): Promise<Response> {
    const { fpath } = getUrl(request.url, drive.config.basePath);
    const metadata = await drive.getMetadata(fpath);
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
                ...(metadata.mimeType !== FOLDER_MIME ? { 'Accept-Ranges': 'bytes' } : {}),
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
            const response = await drive.deleteFile(metadata.id);
            return new Response(null, { status: response.status });
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
