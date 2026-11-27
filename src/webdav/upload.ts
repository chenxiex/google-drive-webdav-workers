import { type DriveClient } from '../drive/client';
import { FOLDER_MIME } from '../drive/types';
import { StatusError, getUrl, splitPath } from '../http';
import { uploadChunks } from './upload-stream';

function parseContentLength(value: string | null): number | null {
    if (value === null || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function putEmpty(
    drive: DriveClient,
    fpath: string,
    name: string,
    parentId: string,
    existingFileId: string | null,
    mimeType: string,
    modifiedTime?: string,
): Promise<Response> {
    if (existingFileId) {
        const response = await drive.truncateFile(existingFileId, mimeType);
        if (response.ok) {
            let metadataStatus = 204;
            if (modifiedTime !== undefined) {
                const updated = await drive.updateFileMetadata(existingFileId, { modifiedTime });
                if (!updated.ok) metadataStatus = updated.status;
            }
            await drive.cache.invalidateFileAndParent(fpath, parentId);
            return new Response(null, { status: metadataStatus });
        }
        return new Response(null, { status: response.status });
    }
    const response = await drive.createEmptyFile(name, parentId, mimeType, modifiedTime);
    if (response.ok) {
        await drive.cache.invalidateFileAndParent(fpath, parentId);
        return new Response(null, { status: 201 });
    }
    return new Response(null, { status: response.status });
}

async function putSmallKnownLength(
    drive: DriveClient,
    body: ReadableStream<Uint8Array>,
    fpath: string,
    name: string,
    parentId: string,
    existingFileId: string | null,
    mimeType: string,
    contentLength: number,
): Promise<Response> {
    const boundary = '-------webdav_boundary';
    let prefix: Uint8Array | null = null;
    let suffix: Uint8Array | null = null;
    let totalLength = contentLength;
    if (!existingFileId) {
        const fileMetadata = JSON.stringify({ name, parents: [parentId], mimeType });
        const encoder = new TextEncoder();
        prefix = encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${fileMetadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
        suffix = encoder.encode(`\r\n--${boundary}--`);
        totalLength += prefix.byteLength + suffix.byteLength;
    }

    const { readable, writable } = new FixedLengthStream(totalLength);
    const writer = writable.getWriter();
    const uploadPromise = existingFileId
        ? drive.uploadMediaStream(existingFileId, mimeType, readable)
        : drive.uploadMultipartStream(boundary, readable);
    // Unblock writer backpressure if the upstream request rejects without consuming the stream.
    void uploadPromise.then(
        res => (!res.ok ? readable.cancel().catch(() => undefined) : undefined),
        () => readable.cancel().catch(() => undefined),
    );

    const reader = body.getReader();
    let clientError: StatusError | null = null;
    let finishedReading = false;
    try {
        if (prefix) await writer.write(prefix);
        let received = 0;
        while (true) {
            let next: ReadableStreamReadResult<Uint8Array>;
            try {
                next = await reader.read();
            } catch {
                clientError = new StatusError('Upload failed', 502);
                throw clientError;
            }
            if (next.done) {
                finishedReading = true;
                break;
            }
            const value = next.value;
            if (!value.length) continue;
            if (value.length > contentLength - received) {
                clientError = new StatusError('Request body exceeds Content-Length', 400);
                throw clientError;
            }
            await writer.write(value);
            received += value.length;
        }
        if (received !== contentLength) {
            clientError = new StatusError('Incomplete request body', 400);
            throw clientError;
        }
        if (suffix) await writer.write(suffix);
        await writer.close();
    } catch (err) {
        if (!finishedReading) {
            try { await reader.cancel(); } catch {}
        }
        try { await writer.abort(err); } catch {}
        if (clientError) {
            await uploadPromise.catch(() => undefined);
            return new Response(clientError.message, { status: clientError.status });
        }
    } finally {
        reader.releaseLock();
    }

    let res: Response;
    try {
        res = await uploadPromise;
    } catch {
        return new Response('Upload failed', { status: 502 });
    }
    if (res.ok) {
        await res.body?.cancel().catch(() => undefined);
        await drive.cache.invalidateFileAndParent(fpath, parentId);
        return new Response(null, { status: existingFileId ? 204 : 201 });
    }
    return new Response(await res.text(), { status: res.status });
}

async function putResumable(
    drive: DriveClient,
    body: ReadableStream<Uint8Array>,
    fpath: string,
    name: string,
    parentId: string,
    existingFileId: string | null,
    mimeType: string,
    contentLength?: number,
): Promise<Response> {
    let uploadUrl: string | null = null;
    let offset = 0;
    try {
        for await (const { bytes, final } of uploadChunks(body)) {
            if (!bytes.length) {
                if (contentLength !== undefined) {
                    return new Response('Incomplete request body', { status: 400 });
                }
                return putEmpty(drive, fpath, name, parentId, existingFileId, mimeType);
            }
            const end = offset + bytes.length;
            if (contentLength !== undefined && (end > contentLength || (final ? end !== contentLength : end === contentLength))) {
                return new Response('Request body does not match Content-Length', { status: 400 });
            }
            if (!uploadUrl) {
                const init = await drive.initResumableUpload({ existingFileId, name, parentId, mimeType, contentLength });
                await init.body?.cancel().catch(() => undefined);
                if (!init.ok) {
                    return new Response('Failed to initiate Google Drive upload', {
                        status: init.status >= 400 && init.status <= 599 ? init.status : 502,
                    });
                }
                uploadUrl = init.headers.get('Location');
                if (!uploadUrl) return new Response('Failed to get Resumable Upload URL', { status: 502 });
            }
            const total = contentLength ?? (final ? end : '*');
            const response = await drive.uploadResumableChunk(
                uploadUrl,
                bytes.length,
                `bytes ${offset}-${end - 1}/${total}`,
                bytes,
            );
            await response.body?.cancel().catch(() => undefined);
            // Never report success or continue from an unconfirmed offset.
            // Ambiguous failures are not retried: the upload may have committed.
            if (final ? response.status !== 200 && response.status !== 201 : response.status !== 308) {
                return new Response('Google Drive upload did not confirm the chunk', {
                    status: response.status >= 400 && response.status <= 599 ? response.status : 502,
                });
            }
            if (!final && response.headers.get('Range') !== `bytes=0-${end - 1}`) {
                return new Response('Google Drive upload offset mismatch', { status: 502 });
            }
            offset = end;
        }
        await drive.cache.invalidateFileAndParent(fpath, parentId);
        return new Response(null, { status: existingFileId ? 204 : 201 });
    } catch {
        // Do not expose the resumable session URL in errors or logs.
        return new Response('Upload failed', { status: 502 });
    }
}

export async function handlePut(drive: DriveClient, request: Request): Promise<Response> {
    const { fpath } = getUrl(request.url, drive.config.basePath);
    if (fpath.slice(-1) === '/') return new Response(null, { status: 405 });
    const rawContentLength = request.headers.get('Content-Length');
    const contentLength = parseContentLength(rawContentLength);
    if (rawContentLength !== null && contentLength === null) {
        return new Response('Content-Length must be a nonnegative safe integer', { status: 400 });
    }
    const mimeType = request.headers.get('Content-Type') || 'application/octet-stream';
    const body: ReadableStream<Uint8Array> | null = request.body;

    const { name, parent } = splitPath(fpath);
    const parentMetadata = await drive.getFolderMetadata(parent);
    if (!parentMetadata) return new Response('Parent collection is missing or not a collection', { status: 409 });
    const metadata = await drive.getMetadata(fpath);
    if (metadata?.mimeType === FOLDER_MIME) {
        return new Response('Cannot overwrite a collection', {
            status: 405,
            headers: { Allow: 'HEAD, OPTIONS, PROPFIND, PROPPATCH, DELETE, MOVE, COPY, POST' },
        });
    }
    const existingFileId = metadata?.id || null;

    if (contentLength === null) {
        if (!body) return putEmpty(drive, fpath, name, parentMetadata.id, existingFileId, mimeType);
        return putResumable(drive, body, fpath, name, parentMetadata.id, existingFileId, mimeType);
    }
    if (contentLength === 0) {
        if (body) {
            const reader = body.getReader();
            let done = false;
            try {
                while (true) {
                    const next = await reader.read();
                    if (next.done) { done = true; break; }
                    if (next.value.length) return new Response('Request body exceeds Content-Length', { status: 400 });
                }
            } catch {
                return new Response('Upload failed', { status: 502 });
            } finally {
                if (!done) { try { await reader.cancel(); } catch {} }
                reader.releaseLock();
            }
        }
        return putEmpty(drive, fpath, name, parentMetadata.id, existingFileId, mimeType);
    }
    if (!body) {
        return new Response('Incomplete request body', { status: 400 });
    }
    if (contentLength <= 5 * 1024 * 1024) {
        return putSmallKnownLength(drive, body, fpath, name, parentMetadata.id, existingFileId, mimeType, contentLength);
    }
    return putResumable(drive, body, fpath, name, parentMetadata.id, existingFileId, mimeType, contentLength);
}
