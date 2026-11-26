import { type DriveClient } from '../drive/client';
import { StatusError, errorStatus, getUrl, splitPath } from '../http';
import { uploadChunks } from './upload-stream';

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

async function putUnknownLength(
    drive: DriveClient,
    body: ReadableStream<Uint8Array>,
    fpath: string,
    name: string,
    parentId: string,
    existingFileId: string | null,
    mimeType: string,
): Promise<Response> {
    let uploadUrl: string | null = null;
    let offset = 0;
    try {
        for await (const { bytes, final } of uploadChunks(body)) {
            if (!bytes.length) return putEmpty(drive, fpath, name, parentId, existingFileId, mimeType);
            if (!uploadUrl) {
                const init = await drive.initResumableUpload({ existingFileId, name, parentId, mimeType });
                if (!init.ok) return new Response('Failed to initiate Google Drive upload', { status: init.status });
                uploadUrl = init.headers.get('Location');
                if (!uploadUrl) return new Response('Failed to get Resumable Upload URL', { status: 502 });
            }
            const end = offset + bytes.length;
            const response = await drive.uploadResumableChunk(
                uploadUrl,
                bytes.length,
                `bytes ${offset}-${end - 1}/${final ? end : '*'}`,
                bytes,
            );
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
    const mimeType = request.headers.get('Content-Type') || 'application/octet-stream';

    const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
    const body: ReadableStream<Uint8Array> | null = request.body;

    const { name, parent } = splitPath(fpath);
    const parentMetadata = await drive.getFolderMetadata(parent);
    if (!parentMetadata) return new Response('Parent collection is missing or not a collection', { status: 409 });
    const metadata = await drive.getMetadata(fpath);
    const existingFileId = metadata?.id || null;
    if (body && !request.headers.has('Content-Length')) {
        return putUnknownLength(drive, body, fpath, name, parentMetadata.id, existingFileId, mimeType);
    }
    if (contentLength === 0 || !body) {
        return putEmpty(drive, fpath, name, parentMetadata.id, existingFileId, mimeType);
    }
    if (contentLength <= 5 * 1024 * 1024) {
        const reader = body.getReader();
        if (existingFileId) {
            const { readable, writable } = new FixedLengthStream(contentLength);
            const writer = writable.getWriter();
            const uploadPromise = drive.uploadMediaStream(existingFileId, mimeType, readable);
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    await writer.write(value);
                }
                await writer.close();
            } catch (err) { try { await reader.cancel(); } catch { } await writer.abort(err); } finally { reader.releaseLock(); }
            const res = await uploadPromise;
            if (res.ok) {
                await drive.cache.invalidateFileAndParent(fpath, parentMetadata.id);
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
            const uploadPromise = drive.uploadMultipartStream(boundary, readable);

            try {
                await writer.write(preArray);
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    await writer.write(value);
                }
                await writer.write(postArray);
                await writer.close();
            } catch (err) { try { await reader.cancel(); } catch { } await writer.abort(err); } finally { reader.releaseLock(); }

            const res = await uploadPromise;
            if (res.ok) {
                await drive.cache.invalidateFileAndParent(fpath, parentMetadata.id);
                return new Response(null, { status: 201 });
            }
            return new Response(await res.text(), { status: res.status });
        }
    }

    const initRes = await drive.initResumableUpload({ existingFileId, name, parentId: parentMetadata.id, mimeType, contentLength });

    const uploadUrl = initRes.headers.get('Location');
    if (!uploadUrl) return new Response('Failed to get Resumable Upload URL', { status: 500 });

    const reader = body.getReader();
    const CHUNK_SIZE = 10 * 1024 * 1024;
    let offset = 0;
    let residualBuffer: Uint8Array | null = null;

    try {
        while (offset < contentLength) {
            const currentChunkSize = Math.min(CHUNK_SIZE, contentLength - offset);
            const { readable, writable } = new FixedLengthStream(currentChunkSize);
            const writer = writable.getWriter();

            const uploadPromise = drive.uploadResumableChunk(
                uploadUrl,
                currentChunkSize,
                `bytes ${offset}-${offset + currentChunkSize - 1}/${contentLength}`,
                readable,
                true,
            );

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
                // Intermediate chunk accepted (strict Range verification tracked in todo.md).
            } else if (chunkRes.status === 200 || chunkRes.status === 201) {
                // completed; offset advances and loop exits
            } else {
                throw new StatusError(`Google Drive chunk failed: ${await chunkRes.text()}`, chunkRes.status);
            }
            offset += currentChunkSize;
        }

        await drive.cache.invalidateFileAndParent(fpath, parentMetadata.id);
        return new Response(null, { status: existingFileId ? 204 : 201 });

    } catch (err: any) {
        console.error('Upload Failed:', err);
        try { await reader.cancel(); } catch { }
        return new Response(err?.message || 'Upload Failed', { status: errorStatus(err) });
    } finally {
        if (reader) reader.releaseLock();
    }
}
