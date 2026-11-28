import { type DriveClient } from '../drive/client';
import { FOLDER_MIME, type UploadedDriveFile, fileEtag } from '../drive/types';
import { StatusError, pathJoin, splitPath } from '../http';
import { type DavMount } from '../webdav/mount';
import { putEmpty } from '../webdav/upload';
import {
    DRIVE_FLUSH_SIZE,
    type ExpectedChecksum,
    MAX_TUS_REQUEST_BYTES,
    TUS_CHECKSUM_ALGORITHMS,
    TUS_EXTENSIONS,
    TUS_VERSION,
    applyCompletionHeaders,
    isOffsetStreamContentType,
    matchesIfMatch,
    mergeExpectedChecksums,
    parseDriveUploadResponse,
    parseNonNegativeInt,
    parseOcChecksum,
    parseTusMetadata,
    parseUnixMtime,
    parseUploadChecksum,
    readBoundedBody,
    verifyChunkChecksum,
    verifyDriveChecksums,
} from './protocol';
import { type TusSession } from './upload-do';

function tusHeaders(extra?: Record<string, string>): Headers {
    const headers = new Headers({
        'Tus-Resumable': TUS_VERSION,
        'Tus-Extension': TUS_EXTENSIONS,
        'Tus-Checksum-Algorithm': TUS_CHECKSUM_ALGORITHMS,
    });
    if (extra) {
        for (const [key, value] of Object.entries(extra)) headers.set(key, value);
    }
    return headers;
}

function tusError(message: string, status: number): Response {
    return new Response(message, { status, headers: tusHeaders() });
}

function tusVersion(request: Request, allowOmittedOnHead = false): Response | undefined {
    const header = request.headers.get('Tus-Resumable');
    const valid = allowOmittedOnHead && request.method.toUpperCase() === 'HEAD'
        ? (!header || header === TUS_VERSION)
        : header === TUS_VERSION;
    if (!valid) {
        return new Response('Unsupported Tus-Resumable version', {
            status: 412,
            headers: tusHeaders({ 'Tus-Version': TUS_VERSION }),
        });
    }
}

async function uploadSingleShotCreation(
    drive: DriveClient,
    uploadUrl: string,
    bytes: Uint8Array,
): Promise<UploadedDriveFile> {
    let sent = 0;
    while (true) {
        const sliceLen = Math.min(DRIVE_FLUSH_SIZE, bytes.byteLength - sent);
        const sliceEnd = sent + sliceLen;
        const response = await drive.uploadResumableChunk(
            uploadUrl,
            sliceLen,
            `bytes ${sent}-${sliceEnd - 1}/${bytes.byteLength}`,
            bytes.subarray(sent, sliceEnd),
        );
        const result = await parseDriveUploadResponse(response, bytes.byteLength);
        if (result.completed) return result.file;
        if (result.confirmedOffset <= sent || result.confirmedOffset > sliceEnd) {
            throw new StatusError('Drive upload offset mismatch', result.confirmedOffset === sent ? 503 : 502);
        }
        sent = result.confirmedOffset;
    }
}

async function cleanupFailedChecksum(
    drive: DriveClient,
    targetPath: string,
    parentId: string,
    fileId: string | null,
    isNew: boolean,
): Promise<void> {
    if (isNew && fileId) {
        await drive.trashFile(fileId).catch(() => undefined);
    }
    await drive.notifySync(!isNew && fileId
        ? { type: 'touch', id: fileId, parentId, isFolder: false }
        : { type: 'touch', id: parentId, isFolder: true })
        .catch(() => console.error('TUS sync update failed'));
    await drive.cache.invalidateFileAndParent(targetPath, parentId)
        .catch(() => console.error('TUS cache invalidation failed'));
}

export async function handleTusCreate(
    drive: DriveClient,
    env: Env,
    owner: string,
    request: Request,
    mount: DavMount,
): Promise<Response> {
    const version = tusVersion(request);
    if (version) return version;
    if (request.headers.has('Upload-Defer-Length')) {
        return tusError('Deferred length is not supported', 400);
    }

    const rawLength = request.headers.get('Upload-Length');
    const totalSize = parseNonNegativeInt(rawLength);
    if (totalSize === null) {
        return tusError('Upload-Length must be a nonnegative integer', 400);
    }
    const uploadOffset = request.headers.get('Upload-Offset');
    if (uploadOffset !== null && uploadOffset !== '0') {
        return tusError('Initial Upload-Offset must be 0', 400);
    }
    const rawContentLength = request.headers.get('Content-Length');
    const declaredLength = parseNonNegativeInt(rawContentLength);
    if (rawContentLength !== null && declaredLength === null) {
        return tusError('Invalid Content-Length', 400);
    }
    if (declaredLength !== null && declaredLength > MAX_TUS_REQUEST_BYTES) {
        return tusError('Upload exceeds maximum allowed size', 413);
    }
    if (declaredLength !== null && declaredLength > totalSize) {
        return tusError('Upload exceeds declared length', 413);
    }
    if (declaredLength !== null && declaredLength > 0 && !isOffsetStreamContentType(request.headers.get('Content-Type'))) {
        return tusError('Expected application/offset+octet-stream', 415);
    }

    const requestUrl = new URL(request.url);
    if (/%(?:2f|5c|00)/i.test(requestUrl.pathname)) {
        return tusError('Invalid upload path', 400);
    }

    let metadata;
    let modifiedTime: string | undefined;
    let expectedChecksums: ExpectedChecksum[];
    const uploadChecksumHeader = request.headers.get('Upload-Checksum');
    try {
        metadata = parseTusMetadata(request.headers.get('Upload-Metadata') ?? '');
        const rawOcMtime = request.headers.get('X-OC-Mtime');
        const headerMtime = rawOcMtime !== null ? parseUnixMtime(rawOcMtime) : undefined;
        modifiedTime = metadata.mtime ?? headerMtime;
        const rawOcChecksum = request.headers.get('OC-Checksum');
        const ocChecksum = rawOcChecksum !== null ? parseOcChecksum(rawOcChecksum) : undefined;
        expectedChecksums = mergeExpectedChecksums(metadata.checksum, ocChecksum);
        if (uploadChecksumHeader !== null) parseUploadChecksum(uploadChecksumHeader);
    } catch (error) {
        if (error instanceof StatusError) return tusError(error.message, error.status);
        throw error;
    }

    const { fpath } = mount;
    if (/[\x00-\x1f\x7f\\]/.test(fpath) || fpath.split('/').some(seg => seg === '.' || seg === '..')) {
        return tusError('Invalid upload path', 400);
    }
    if (metadata.filename === undefined && fpath.endsWith('/')) {
        return tusError('A filename is required', 400);
    }
    const targetPath = metadata.filename === undefined ? fpath : pathJoin(fpath, metadata.filename);
    const { name, parent } = splitPath(targetPath);
    if (!name) return tusError('A filename is required', 400);

    const parentMetadata = await drive.getFolderMetadata(parent);
    if (!parentMetadata) return tusError('Parent collection is missing or not a collection', 409);

    const ifMatch = request.headers.get('If-Match');
    const existing = await drive.getMetadata(targetPath, { bypassLeafCache: ifMatch !== null });
    if (existing?.mimeType === FOLDER_MIME) return tusError('Cannot overwrite a collection', 409);
    const existingFileId = existing?.id || null;
    if (!matchesIfMatch(ifMatch, existing ? fileEtag(existing) : undefined, Boolean(existing))) {
        return tusError('Precondition Failed', 412);
    }

    let initialChunk: Uint8Array;
    try {
        initialChunk = await readBoundedBody(request.body, {
            maxBytes: Math.min(MAX_TUS_REQUEST_BYTES, totalSize),
            declaredLength,
        });
        if (initialChunk.byteLength > 0 && !isOffsetStreamContentType(request.headers.get('Content-Type'))) {
            return tusError('Expected application/offset+octet-stream', 415);
        }
        if (uploadChecksumHeader !== null) {
            await verifyChunkChecksum(uploadChecksumHeader, initialChunk);
        }
    } catch (error) {
        if (error instanceof StatusError) return tusError(error.message, error.status);
        throw error;
    }

    const origin = drive.config.publicOrigin ?? requestUrl.origin;
    const sessionId = crypto.randomUUID();
    const location = `${origin}${mount.hrefBase}tus_uploads/${sessionId}`;

    if (totalSize === 0) {
        if (!verifyDriveChecksums(expectedChecksums, null, true)) {
            return tusError('Checksum mismatch', 460);
        }
        const emptyResponse = await putEmpty(
            drive,
            targetPath,
            name,
            parentMetadata.id,
            existingFileId,
            metadata.filetype,
            modifiedTime,
        );
        if (!emptyResponse.ok) {
            await emptyResponse.body?.cancel().catch(() => undefined);
            return tusError('Drive empty upload failed', emptyResponse.status);
        }
        const headers = tusHeaders({ Location: location, 'Upload-Offset': '0' });
        for (const key of ['ETag', 'OC-FileID', 'OC-Perm']) {
            const value = emptyResponse.headers.get(key);
            if (value) headers.set(key, value);
        }
        await emptyResponse.body?.cancel().catch(() => undefined);
        return new Response(null, { status: 201, headers });
    }

    if (initialChunk.byteLength === totalSize) {
        const initRes = await drive.initResumableUpload({
            existingFileId,
            name,
            parentId: parentMetadata.id,
            mimeType: metadata.filetype,
            contentLength: totalSize,
            modifiedTime,
        });
        const uploadUrl = initRes.headers.get('Location') || '';
        await initRes.body?.cancel().catch(() => undefined);
        if (!initRes.ok || !uploadUrl) {
            return tusError('Drive upload initialization failed', initRes.ok ? 502 : initRes.status);
        }

        let completedFile: UploadedDriveFile;
        try {
            completedFile = await uploadSingleShotCreation(drive, uploadUrl, initialChunk);
        } catch (error) {
            if (error instanceof StatusError) return tusError(error.message, error.status);
            return tusError('Upload failed', 502);
        }

        const fileId = existingFileId ?? completedFile.id ?? null;
        if (!verifyDriveChecksums(expectedChecksums, completedFile, false)) {
            await cleanupFailedChecksum(drive, targetPath, parentMetadata.id, fileId, existingFileId === null);
            return tusError('Checksum mismatch', 460);
        }

        await drive.notifySync(fileId
            ? { type: 'upsert', id: fileId, parentId: parentMetadata.id, isFolder: false }
            : { type: 'touch', id: parentMetadata.id, isFolder: true })
            .catch(() => console.error('TUS sync update failed'));
        await drive.cache.invalidateFileAndParent(targetPath, parentMetadata.id)
            .catch(() => console.error('TUS cache invalidation failed'));

        const headers = tusHeaders({ Location: location, 'Upload-Offset': String(totalSize) });
        applyCompletionHeaders(headers, { ...completedFile, ...(fileId ? { id: fileId } : {}) });
        return new Response(null, { status: 201, headers });
    }

    const namespace = env.TUS_UPLOADS;
    if (!namespace) return tusError('TUS_UPLOADS Durable Object binding is required', 503);

    const initRes = await drive.initResumableUpload({
        existingFileId,
        name,
        parentId: parentMetadata.id,
        mimeType: metadata.filetype,
        contentLength: totalSize,
        modifiedTime,
    });
    const uploadUrl = initRes.headers.get('Location') || '';
    await initRes.body?.cancel().catch(() => undefined);
    if (!initRes.ok || !uploadUrl) {
        return tusError('Drive upload initialization failed', initRes.ok ? 502 : initRes.status);
    }

    const session: TusSession = {
        uploadUrl,
        totalSize,
        targetPath,
        parentId: parentMetadata.id,
        owner,
        existingFileId,
        expectedChecksums,
    };
    const stub = namespace.get(namespace.idFromName(sessionId));
    const initialized = await stub.fetch('https://tus.internal/initialize', {
        method: 'POST',
        headers: { 'x-tus-session': encodeURIComponent(JSON.stringify(session)) },
        body: initialChunk.byteLength > 0 ? initialChunk : null,
    });
    if (!initialized.ok) {
        const message = await initialized.text().catch(() => 'Upload session could not be persisted');
        const status = initialized.status >= 400 && initialized.status <= 599 ? initialized.status : 503;
        return tusError(message || 'Upload session could not be persisted', status);
    }
    const confirmedOffset = initialized.headers.get('Upload-Offset') ?? String(initialChunk.byteLength);
    await initialized.body?.cancel().catch(() => undefined);
    return new Response(null, {
        status: 201,
        headers: tusHeaders({ Location: location, 'Upload-Offset': confirmedOffset }),
    });
}

export async function handleTusUpload(
    drive: DriveClient,
    env: Env,
    owner: string,
    request: Request,
    mount: DavMount,
): Promise<Response> {
    const version = tusVersion(request, true);
    if (version) return version;

    const sessionId = mount.tusSessionId;
    if (!sessionId || !/^[0-9a-f-]{36}$/.test(sessionId)) {
        return tusError('Session not found', 404);
    }
    const namespace = env.TUS_UPLOADS;
    if (!namespace) return tusError('TUS_UPLOADS Durable Object binding is required', 503);

    const headers = new Headers(request.headers);
    headers.set('x-tus-owner', owner);
    const response = await namespace.get(namespace.idFromName(sessionId)).fetch(
        new Request('https://tus.internal/upload', { method: request.method, headers, body: request.body }),
    );

    if (response.headers.get('x-tus-complete') === '1') {
        const targetPath = decodeURIComponent(response.headers.get('x-tus-target-path')!);
        const parentId = response.headers.get('x-tus-parent-id')!;
        const fileId = response.headers.get('x-tus-file-id');
        await drive.notifySync(fileId
            ? { type: 'upsert', id: fileId, parentId, isFolder: false }
            : { type: 'touch', id: parentId, isFolder: true })
            .catch(() => console.error('TUS sync update failed'));
        await drive.cache.invalidateFileAndParent(targetPath, parentId)
            .catch(() => console.error('TUS cache invalidation failed'));
    } else if (response.headers.get('x-tus-checksum-mismatch') === '1') {
        const targetPath = decodeURIComponent(response.headers.get('x-tus-target-path')!);
        const parentId = response.headers.get('x-tus-parent-id')!;
        const fileId = response.headers.get('x-tus-file-id');
        const isNew = response.headers.get('x-tus-is-new') === '1';
        await cleanupFailedChecksum(drive, targetPath, parentId, fileId, isNew);
    }

    const result = new Response(response.body, response);
    for (const key of [...result.headers.keys()]) if (key.startsWith('x-tus-')) result.headers.delete(key);
    return result;
}
