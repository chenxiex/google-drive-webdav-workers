import { type DriveClient } from '../drive/client';
import { FOLDER_MIME } from '../drive/types';
import { TransferError, errorStatus, getUrl, splitPath } from '../http';

// Drive has no atomic replace-by-name operation. Keep the old destination
// recoverable in Trash, and never compensate an ambiguous write: it may
// already have succeeded even when its response was lost.
async function handleTransfer(drive: DriveClient, request: Request, copy: boolean): Promise<Response> {
    const canonical = (path: string) => path.replace(/\/+$/, '') || '/';
    const fpath = canonical(getUrl(request.url, drive.config.basePath).fpath);
    const destination = request.headers.get('Destination');
    if (!destination) return new Response(null, { status: 403 });
    const destPath = canonical(getUrl(destination, drive.config.basePath).fpath);
    if (fpath === '/' || destPath === '/') return new Response(null, { status: 403 });

    const source = await drive.getMetadata(fpath);
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
    const target = await drive.getMetadata(destPath);
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
        : await drive.getMetadata(destParent || '/');
    if (!parentMetadata || parentMetadata.mimeType !== FOLDER_MIME) {
        return new Response('Destination parent is not a collection', { status: 409 });
    }
    if (parentMetadata.id === source.id || parentMetadata.id === target?.id) {
        return new Response('Source and destination overlap', { status: 403 });
    }

    const parentId = parentMetadata.id;
    const headers = await drive.jsonHeaders();
    let targetTrashed = false;
    let stageId: string | undefined;
    const stageName = copy && target ? '.webdav-copy-' + crypto.randomUUID() : undefined;
    try {
        if (copy) {
            const staged = await drive.transferWrite(source.id, { name: stageName || name, parents: [parentId], ...(source.appProperties ? { appProperties: source.appProperties } : {}) }, headers, true);
            stageId = staged.id;
        }
        if (target) {
            await drive.transferWrite(target.id, { trashed: true }, headers);
            targetTrashed = true;
        }
        if (copy) {
            if (target) await drive.transferWrite(stageId!, { name }, headers);
        } else {
            const parents = sourceParentId !== parentId
                ? '&addParents=' + encodeURIComponent(parentId) + (sourceParentId ? '&removeParents=' + encodeURIComponent(sourceParentId) : '')
                : '';
            await drive.transferWrite(source.id, { name }, headers, false, parents);
        }
        return new Response(null, {
            status: target ? 204 : 201,
            ...(!copy && !target ? { headers: { Location: destination } } : {}),
        });
    } catch (error) {
        let message = error instanceof Error ? error.message : String(error);
        if (targetTrashed && error instanceof TransferError && error.definitive) {
            try {
                await drive.transferWrite(target.id, { trashed: false }, headers);
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
        const invalidations = [drive.cache.invalidateTransferPath(destPath, parentId, target?.mimeType === FOLDER_MIME)];
        if (!copy) invalidations.push(drive.cache.invalidateTransferPath(fpath, sourceParentId, source.mimeType === FOLDER_MIME));
        await Promise.all(invalidations.map(promise => promise.catch(error => console.error('Transfer cache invalidation failed:', error))));
    }
}

export function handleMove(drive: DriveClient, request: Request): Promise<Response> {
    return handleTransfer(drive, request, false);
}

export function handleCopy(drive: DriveClient, request: Request): Promise<Response> {
    return handleTransfer(drive, request, true);
}
