import { type DriveClient } from '../drive/client';
import { FOLDER_MIME } from '../drive/types';
import { getUrl, pathJoin, splitPath } from '../http';
import { putEmpty } from '../webdav/upload';

function tusError(message: string, status: number): Response {
    return new Response(message, { status, headers: { 'Tus-Resumable': '1.0.0' } });
}

function tusVersion(request: Request): Response | undefined {
    if (request.headers.get('Tus-Resumable') !== '1.0.0') {
        return new Response('Unsupported Tus-Resumable version', { status: 412, headers: { 'Tus-Version': '1.0.0', 'Tus-Resumable': '1.0.0' } });
    }
}

export async function handleTusCreate(drive: DriveClient, env: Env, owner: string, request: Request): Promise<Response> {
    const version = tusVersion(request);
    if (version) return version;
    const rawLength = request.headers.get('Upload-Length');
    if (!rawLength || !/^\d+$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength))) {
        return tusError('Upload-Length must be a nonnegative integer', 400);
    }
    // Only the creation extension is offered. Do not silently discard data.
    if (request.headers.has('Upload-Defer-Length')) {
        return tusError('Deferred length and creation-with-upload are not supported', 400);
    }
    if (request.body) {
        const reader = request.body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value.length) {
                    await reader.cancel();
                    return tusError('Creation-with-upload is not supported', 400);
                }
            }
        } finally { reader.releaseLock(); }
    }
    const totalSize = Number(rawLength);
    const { fpath } = getUrl(request.url, drive.config.basePath);
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
        } catch { return tusError('Invalid Upload-Metadata', 400); }
    }
    const filename = metadata.get('filename');
    if (filename !== undefined && (!filename || filename === '.' || filename === '..' || /[/\\\x00-\x1f\x7f]/.test(filename))) {
        return tusError('Invalid filename', 400);
    }
    const mimeType = metadata.get('filetype') || 'application/octet-stream';
    if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]*)?$/.test(mimeType)) return tusError('Invalid filetype', 400);
    let modifiedTime: string | undefined;
    const mtime = metadata.get('mtime');
    if (mtime !== undefined) {
        const milliseconds = Number(mtime) * 1000;
        if (!/^-?\d+$/.test(mtime) || !Number.isSafeInteger(milliseconds) || Math.abs(milliseconds) > 8640000000000000) {
            return tusError('Invalid mtime', 400);
        }
        modifiedTime = new Date(milliseconds).toISOString();
    }
    const targetPath = filename === undefined ? fpath : pathJoin(fpath, filename);
    const { name, parent } = splitPath(targetPath);
    if (!name) return tusError('A filename is required', 400);
    const parentMetadata = await drive.getFolderMetadata(parent);
    if (!parentMetadata) return tusError('Parent collection is missing or not a collection', 409);
    const existing = await drive.getMetadata(targetPath);
    if (existing?.mimeType === FOLDER_MIME) return tusError('Cannot overwrite a collection', 409);
    const existingFileId = existing?.id || null;
    const namespace = env.TUS_UPLOADS;
    if (!namespace) return tusError('TUS_UPLOADS Durable Object binding is required', 503);
    let uploadUrl = '';
    if (totalSize === 0) {
        const response = await putEmpty(drive, targetPath, name, parentMetadata.id, existingFileId, mimeType, modifiedTime);
        if (!response.ok) return tusError('Drive empty upload failed', response.status);
    } else {
        const response = await drive.initResumableUpload({
            existingFileId,
            name,
            parentId: parentMetadata.id,
            mimeType,
            contentLength: totalSize,
            modifiedTime,
        });
        uploadUrl = response.headers.get('Location') || '';
        if (!response.ok || !uploadUrl) return tusError('Drive upload initialization failed', response.ok ? 502 : response.status);
    }
    const sessionId = crypto.randomUUID();
    const stub = namespace.get(namespace.idFromName(sessionId));
    const initialized = await stub.fetch('https://tus.internal/initialize', {
        method: 'POST', body: JSON.stringify({ uploadUrl, totalSize, targetPath, parentId: parentMetadata.id, owner, completed: totalSize === 0 }),
    });
    if (!initialized.ok) return tusError('Upload session could not be persisted', 503);
    return new Response(null, { status: 201, headers: {
        'Tus-Resumable': '1.0.0',
        Location: `${new URL(request.url).origin}${drive.config.basePath}tus_uploads/${sessionId}`,
    } });
}

export async function handleTusUpload(drive: DriveClient, env: Env, owner: string, request: Request): Promise<Response> {
    const version = tusVersion(request);
    if (version) return version;
    const basePath = drive.config.basePath;
    const path = new URL(request.url).pathname;
    const sessionId = path.slice((basePath + 'tus_uploads/').length);
    if (!path.startsWith(basePath + 'tus_uploads/') || !/^[0-9a-f-]{36}$/.test(sessionId)) return tusError('Session not found', 404);
    const namespace = env.TUS_UPLOADS;
    if (!namespace) return tusError('TUS_UPLOADS Durable Object binding is required', 503);
    const headers = new Headers(request.headers);
    headers.set('x-tus-owner', owner);
    const response = await namespace.get(namespace.idFromName(sessionId)).fetch(new Request('https://tus.internal/upload', { method: request.method, headers, body: request.body }));
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
    }
    const result = new Response(response.body, response);
    for (const key of [...result.headers.keys()]) if (key.startsWith('x-tus-')) result.headers.delete(key);
    return result;
}
