import { type DriveClient } from '../drive/client';
import { FOLDER_MIME, UPLOAD_RESULT_FIELDS, type UploadedDriveFile, fileEtag } from '../drive/types';
import { StatusError, splitPath } from '../http';
import {
    type ExpectedChecksum,
    applyCompletionHeaders,
    matchesIfMatch,
    parseNonNegativeInt,
    parseOcChecksum,
    parseUnixMtime,
    verifyDriveChecksums,
} from '../tus/protocol';
import { type DavMount } from './mount';
import { uploadChunks } from './upload-stream';

async function finalizePutSuccess(
    drive: DriveClient,
    fpath: string,
    parentId: string,
    existingFileId: string | null,
    file: UploadedDriveFile | null,
    expectedChecksum?: ExpectedChecksum,
): Promise<Response> {
    const fileId = existingFileId ?? file?.id ?? null;
    if (expectedChecksum && !verifyDriveChecksums([expectedChecksum], file, false)) {
        if (!existingFileId && file?.id) {
            await drive.trashFile(file.id).catch(() => undefined);
        }
        await drive.notifySync(existingFileId && fileId
            ? { type: 'touch', id: fileId, parentId, isFolder: false }
            : { type: 'touch', id: parentId, isFolder: true })
            .catch(() => undefined);
        await drive.cache.invalidateFileAndParent(fpath, parentId).catch(() => undefined);
        return new Response('Checksum mismatch', { status: 400 });
    }
    await drive.notifySync(fileId
        ? { type: 'upsert', id: fileId, parentId, isFolder: false }
        : { type: 'touch', id: parentId, isFolder: true });
    await drive.cache.invalidateFileAndParent(fpath, parentId);
    const headers = new Headers();
    applyCompletionHeaders(headers, { ...file, ...(fileId ? { id: fileId } : {}) });
    return new Response(null, { status: existingFileId ? 204 : 201, headers });
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
        if (!response.ok) return new Response(null, { status: response.status });
        let file = await response.json<UploadedDriveFile>().catch(() => null);
        let metadataStatus = 204;
        if (modifiedTime !== undefined) {
            const updated = await drive.updateFileMetadata(
                existingFileId,
                { modifiedTime },
                'supportsAllDrives=true&fields=' + encodeURIComponent(UPLOAD_RESULT_FIELDS),
            );
            if (!updated.ok) {
                await updated.body?.cancel().catch(() => undefined);
                metadataStatus = updated.status;
            } else {
                file = (await updated.json<UploadedDriveFile>().catch(() => null)) ?? file;
            }
        }
        await drive.notifySync({ type: 'touch', id: existingFileId, parentId, isFolder: false });
        await drive.cache.invalidateFileAndParent(fpath, parentId);
        const headers = new Headers();
        if (metadataStatus === 204) {
            applyCompletionHeaders(headers, { ...file, id: existingFileId });
        }
        return new Response(null, { status: metadataStatus, headers });
    }
    const response = await drive.createEmptyFile(name, parentId, mimeType, modifiedTime);
    if (!response.ok) return new Response(null, { status: response.status });
    const created = await response.json<UploadedDriveFile>().catch(() => null);
    await drive.notifySync(created?.id
        ? { type: 'upsert', id: created.id, parentId, isFolder: false }
        : { type: 'touch', id: parentId, isFolder: true });
    await drive.cache.invalidateFileAndParent(fpath, parentId);
    const headers = new Headers();
    applyCompletionHeaders(headers, created);
    return new Response(null, { status: 201, headers });
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
    modifiedTime?: string,
    expectedChecksum?: ExpectedChecksum,
): Promise<Response> {
    const boundary = '-------webdav_boundary';
    let prefix: Uint8Array | null = null;
    let suffix: Uint8Array | null = null;
    let totalLength = contentLength;
    if (!existingFileId) {
        const fileMetadata = JSON.stringify({
            name,
            parents: [parentId],
            mimeType,
            ...(modifiedTime !== undefined ? { modifiedTime } : {}),
        });
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
    if (!res.ok) {
        return new Response(await res.text(), { status: res.status });
    }

    let uploaded = await res.json<UploadedDriveFile>().catch(() => null);
    if (expectedChecksum && !verifyDriveChecksums([expectedChecksum], uploaded, false)) {
        return finalizePutSuccess(drive, fpath, parentId, existingFileId, uploaded, expectedChecksum);
    }
    if (existingFileId && modifiedTime !== undefined) {
        const updated = await drive.updateFileMetadata(
            existingFileId,
            { modifiedTime },
            'supportsAllDrives=true&fields=' + encodeURIComponent(UPLOAD_RESULT_FIELDS),
        );
        if (!updated.ok) {
            await drive.notifySync({ type: 'touch', id: existingFileId, parentId, isFolder: false }).catch(() => undefined);
            await drive.cache.invalidateFileAndParent(fpath, parentId).catch(() => undefined);
            return new Response(await updated.text(), { status: updated.status });
        }
        uploaded = (await updated.json<UploadedDriveFile>().catch(() => null)) ?? uploaded;
    }
    return finalizePutSuccess(drive, fpath, parentId, existingFileId, uploaded);
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
    modifiedTime?: string,
    expectedChecksum?: ExpectedChecksum,
): Promise<Response> {
    let uploadUrl: string | null = null;
    let offset = 0;
    let completedFile: UploadedDriveFile | null = null;
    try {
        for await (const { bytes, final } of uploadChunks(body)) {
            if (!bytes.length) {
                if (contentLength !== undefined) {
                    return new Response('Incomplete request body', { status: 400 });
                }
                if (expectedChecksum && !verifyDriveChecksums([expectedChecksum], null, true)) {
                    return new Response('Checksum mismatch', { status: 400 });
                }
                return putEmpty(drive, fpath, name, parentId, existingFileId, mimeType, modifiedTime);
            }
            const end = offset + bytes.length;
            if (contentLength !== undefined && (end > contentLength || (final ? end !== contentLength : end === contentLength))) {
                return new Response('Request body does not match Content-Length', { status: 400 });
            }
            if (!uploadUrl) {
                const init = await drive.initResumableUpload({
                    existingFileId,
                    name,
                    parentId,
                    mimeType,
                    contentLength,
                    modifiedTime,
                });
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
            // Never report success or continue from an unconfirmed offset.
            // Ambiguous failures are not retried: the upload may have committed.
            if (final ? response.status !== 200 && response.status !== 201 : response.status !== 308) {
                await response.body?.cancel().catch(() => undefined);
                return new Response('Google Drive upload did not confirm the chunk', {
                    status: response.status >= 400 && response.status <= 599 ? response.status : 502,
                });
            }
            if (!final && response.headers.get('Range') !== `bytes=0-${end - 1}`) {
                await response.body?.cancel().catch(() => undefined);
                return new Response('Google Drive upload offset mismatch', { status: 502 });
            }
            if (final) {
                completedFile = await response.json<UploadedDriveFile>().catch(() => null);
            } else {
                await response.body?.cancel().catch(() => undefined);
            }
            offset = end;
        }
        return finalizePutSuccess(drive, fpath, parentId, existingFileId, completedFile, expectedChecksum);
    } catch {
        // Do not expose the resumable session URL in errors or logs.
        return new Response('Upload failed', { status: 502 });
    }
}

export async function handlePut(drive: DriveClient, request: Request, mount: DavMount): Promise<Response> {
    const { fpath } = mount;
    if (fpath.slice(-1) === '/') return new Response(null, { status: 405 });
    const rawContentLength = request.headers.get('Content-Length');
    const contentLength = parseNonNegativeInt(rawContentLength);
    if (rawContentLength !== null && contentLength === null) {
        return new Response('Content-Length must be a nonnegative safe integer', { status: 400 });
    }

    let modifiedTime: string | undefined;
    let expectedChecksum: ExpectedChecksum | undefined;
    try {
        const rawMtime = request.headers.get('X-OC-Mtime');
        if (rawMtime !== null) modifiedTime = parseUnixMtime(rawMtime);
        const rawChecksum = request.headers.get('OC-Checksum');
        if (rawChecksum !== null) expectedChecksum = parseOcChecksum(rawChecksum);
    } catch (error) {
        if (error instanceof StatusError) return new Response(error.message, { status: error.status });
        throw error;
    }

    const mimeType = request.headers.get('Content-Type') || 'application/octet-stream';
    const body: ReadableStream<Uint8Array> | null = request.body;

    const { name, parent } = splitPath(fpath);
    const parentMetadata = await drive.getFolderMetadata(parent);
    if (!parentMetadata) return new Response('Parent collection is missing or not a collection', { status: 409 });

    const ifMatch = request.headers.get('If-Match');
    const metadata = await drive.getMetadata(fpath, { bypassLeafCache: ifMatch !== null });
    if (metadata?.mimeType === FOLDER_MIME) {
        return new Response('Cannot overwrite a collection', {
            status: 405,
            headers: { Allow: 'HEAD, OPTIONS, PROPFIND, PROPPATCH, DELETE, MOVE, COPY, POST' },
        });
    }
    const existingFileId = metadata?.id || null;
    if (!matchesIfMatch(ifMatch, metadata ? fileEtag(metadata) : undefined, Boolean(metadata))) {
        return new Response('Precondition Failed', { status: 412 });
    }

    if (contentLength === null) {
        if (!body) {
            if (expectedChecksum && !verifyDriveChecksums([expectedChecksum], null, true)) {
                return new Response('Checksum mismatch', { status: 400 });
            }
            return putEmpty(drive, fpath, name, parentMetadata.id, existingFileId, mimeType, modifiedTime);
        }
        return putResumable(drive, body, fpath, name, parentMetadata.id, existingFileId, mimeType, undefined, modifiedTime, expectedChecksum);
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
        if (expectedChecksum && !verifyDriveChecksums([expectedChecksum], null, true)) {
            return new Response('Checksum mismatch', { status: 400 });
        }
        return putEmpty(drive, fpath, name, parentMetadata.id, existingFileId, mimeType, modifiedTime);
    }
    if (!body) {
        return new Response('Incomplete request body', { status: 400 });
    }
    if (contentLength <= 5 * 1024 * 1024) {
        return putSmallKnownLength(drive, body, fpath, name, parentMetadata.id, existingFileId, mimeType, contentLength, modifiedTime, expectedChecksum);
    }
    return putResumable(drive, body, fpath, name, parentMetadata.id, existingFileId, mimeType, contentLength, modifiedTime, expectedChecksum);
}
