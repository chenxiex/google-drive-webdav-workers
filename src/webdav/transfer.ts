import { type BatchBudget, type DriveBatchRequest, type DriveBatchResponse, MAX_BATCH_SIZE, executeBatchWithRetry } from '../drive/batch';
import { type DriveClient } from '../drive/client';
import { FOLDER_MIME, isVisibleDriveItem } from '../drive/types';
import { StatusError, TransferError, encodeQueryString, errorStatus, escapeQuery, splitPath } from '../http';
import { type AuthPrincipal } from '../ocis/profile';
import { type DavMount, resolveDestinationMount } from './mount';

export const FOLDER_COPY_LIMITS = {
    maxBatchSize: MAX_BATCH_SIZE,
    maxItems: 1000,
    maxBatches: 40,
} as const;

const BATCH_LIST_FIELDS = 'nextPageToken,files(id,name,mimeType,modifiedTime,description,starred,folderColorRgb,appProperties)';

function parseCopyDepth(request: Request): '0' | 'infinity' {
    const raw = request.headers.get('Depth');
    if (raw === null) return 'infinity';
    const normalized = raw.trim().toLowerCase();
    if (normalized === '0' || normalized === 'infinity') return normalized;
    throw new StatusError('Invalid Depth header for COPY; expected 0 or infinity', 400);
}

function folderCopyBody(source: any, name: string, parentId: string): Record<string, unknown> {
    const body: Record<string, unknown> = { name, mimeType: FOLDER_MIME, parents: [parentId] };
    if (source.description !== undefined) body.description = source.description;
    if (source.starred !== undefined) body.starred = source.starred;
    if (source.modifiedTime) body.modifiedTime = source.modifiedTime;
    if (source.folderColorRgb) body.folderColorRgb = source.folderColorRgb;
    if (source.appProperties && Object.keys(source.appProperties).length > 0) {
        body.appProperties = source.appProperties;
    }
    return body;
}

function fileCopyBody(source: any, name: string, parentId: string): Record<string, unknown> {
    return {
        name,
        parents: [parentId],
        ...(source.appProperties && Object.keys(source.appProperties).length > 0
            ? { appProperties: source.appProperties }
            : {}),
    };
}

function extractBatchError(res: DriveBatchResponse): string {
    return res.json?.error?.message || res.text || `Drive batch sub-request failed with status ${res.status}`;
}

async function populateFolderCopy(
    drive: DriveClient,
    sourceId: string,
    stageId: string,
    budget: BatchBudget,
): Promise<Array<{ id: string; parentId: string; isFolder: boolean }>> {
    const visited = new Set<string>([sourceId, stageId]);
    const copiedItems: Array<{ id: string; parentId: string; isFolder: boolean }> = [];
    let totalItems = 0;
    let frontier: Array<{ srcId: string; dstId: string }> = [{ srcId: sourceId, dstId: stageId }];
    let reqCounter = 0;

    while (frontier.length > 0) {
        const discovered: Array<{ child: any; dstParentId: string }> = [];
        let listQueue: Array<{ srcId: string; dstId: string; pageToken?: string }> =
            frontier.map(node => ({ srcId: node.srcId, dstId: node.dstId }));

        while (listQueue.length > 0) {
            const listReqs: DriveBatchRequest[] = listQueue.map(item => ({
                id: 'r' + (reqCounter++),
                method: 'GET',
                path: '/drive/v3/files?' + encodeQueryString({
                    includeItemsFromAllDrives: 'true',
                    supportsAllDrives: 'true',
                    pageSize: '1000',
                    q: `'${escapeQuery(item.srcId)}' in parents and trashed = false`,
                    fields: BATCH_LIST_FIELDS,
                    ...(item.pageToken ? { pageToken: item.pageToken } : {}),
                }),
            }));

            const listRes = await executeBatchWithRetry(listReqs, () => drive.getAccessToken(), budget);
            const nextListQueue: Array<{ srcId: string; dstId: string; pageToken?: string }> = [];

            for (let i = 0; i < listQueue.length; i++) {
                const res = listRes[i];
                if (!res || res.status < 200 || res.status >= 300) {
                    throw new StatusError(res ? extractBatchError(res) : 'Drive batch list failed', res?.status || 502);
                }
                if (!res.json || !Array.isArray(res.json.files)) {
                    throw new TransferError('Drive batch list returned invalid payload', 502, false);
                }
                for (const child of res.json.files) {
                    if (!isVisibleDriveItem(child) || visited.has(child.id)) continue;
                    totalItems++;
                    if (totalItems > FOLDER_COPY_LIMITS.maxItems) {
                        throw new StatusError(`Folder COPY exceeds item limit (${FOLDER_COPY_LIMITS.maxItems})`, 413);
                    }
                    discovered.push({ child, dstParentId: listQueue[i].dstId });
                }
                if (typeof res.json.nextPageToken === 'string' && res.json.nextPageToken) {
                    nextListQueue.push({ srcId: listQueue[i].srcId, dstId: listQueue[i].dstId, pageToken: res.json.nextPageToken });
                }
            }
            listQueue = nextListQueue;
        }

        if (discovered.length === 0) break;

        const writeReqs: DriveBatchRequest[] = discovered.map(({ child, dstParentId }) =>
            child.mimeType === FOLDER_MIME
                ? {
                    id: 'r' + (reqCounter++),
                    method: 'POST',
                    path: '/drive/v3/files?supportsAllDrives=true&fields=id',
                    body: folderCopyBody(child, child.name, dstParentId),
                }
                : {
                    id: 'r' + (reqCounter++),
                    method: 'POST',
                    path: `/drive/v3/files/${encodeURIComponent(child.id)}/copy?supportsAllDrives=true&fields=id`,
                    body: fileCopyBody(child, child.name, dstParentId),
                },
        );

        const writeRes = await executeBatchWithRetry(writeReqs, () => drive.getAccessToken(), budget);
        const nextFrontier: Array<{ srcId: string; dstId: string }> = [];

        for (let i = 0; i < discovered.length; i++) {
            const res = writeRes[i];
            if (!res || res.status < 200 || res.status >= 300) {
                throw new StatusError(res ? extractBatchError(res) : 'Drive batch copy failed', res?.status || 502);
            }
            const createdId = res.json?.id;
            const child = discovered[i].child;
            if (typeof createdId !== 'string' || !createdId || (child.mimeType !== FOLDER_MIME && createdId === child.id)) {
                throw new TransferError('Drive batch write returned no valid ID', 502, false);
            }
            const childIsFolder = child.mimeType === FOLDER_MIME;
            copiedItems.push({ id: createdId, parentId: discovered[i].dstParentId, isFolder: childIsFolder });
            if (childIsFolder) {
                visited.add(child.id);
                visited.add(createdId);
                nextFrontier.push({ srcId: child.id, dstId: createdId });
            }
        }
        frontier = nextFrontier;
    }
    return copiedItems;
}

// Drive has no atomic replace-by-name operation. Keep the old destination
// recoverable in Trash, and never compensate an ambiguous write: it may
// already have succeeded even when its response was lost.
async function handleTransfer(
    drive: DriveClient,
    request: Request,
    mount: DavMount,
    principal: AuthPrincipal,
    copy: boolean,
): Promise<Response> {
    const canonical = (path: string) => path.replace(/\/+$/, '') || '/';
    const fpath = canonical(mount.fpath);
    const destination = request.headers.get('Destination');
    if (!destination) return new Response(null, { status: 403 });
    const destPath = canonical(resolveDestinationMount(destination, request.url, mount, drive.config, principal).fpath);
    if (fpath === '/' || destPath === '/') return new Response(null, { status: 403 });

    let depth: '0' | 'infinity' = 'infinity';
    if (copy) {
        try {
            depth = parseCopyDepth(request);
        } catch (error) {
            return new Response(error instanceof Error ? error.message : String(error), { status: errorStatus(error) });
        }
    }

    const source = await drive.getMetadata(fpath);
    if (!source) return new Response(null, { status: 404 });
    if (destPath === fpath) return new Response(null, { status: copy ? 403 : 204 });
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
        : await drive.getFolderMetadata(destParent);
    if (!parentMetadata) {
        return new Response('Destination parent is not a collection', { status: 409 });
    }
    if (parentMetadata.id === source.id || parentMetadata.id === target?.id) {
        return new Response('Source and destination overlap', { status: 403 });
    }

    const parentId = parentMetadata.id;
    const headers = await drive.jsonHeaders();
    const isFolder = source.mimeType === FOLDER_MIME;
    const isRecursiveFolderCopy = copy && isFolder && depth === 'infinity';
    const needsStage = copy && (Boolean(target) || isRecursiveFolderCopy);
    let targetTrashed = false;
    let publishAttempted = false;
    let stageId: string | undefined;
    let createdRootId: string | undefined;
    let copiedItems: Array<{ id: string; parentId: string; isFolder: boolean }> = [];
    let completed = false;
    const stageName = needsStage ? '.webdav-copy-' + crypto.randomUUID() : undefined;
    try {
        if (copy && isFolder) {
            const created = await drive.transferCreate(folderCopyBody(source, stageName || name, parentId), headers);
            createdRootId = created.id;
            if (needsStage) stageId = created.id;
            if (isRecursiveFolderCopy) {
                copiedItems = await populateFolderCopy(drive, source.id, stageId!, { usedBatches: 0, maxBatches: FOLDER_COPY_LIMITS.maxBatches });
            }
        } else if (copy) {
            const staged = await drive.transferWrite(source.id, fileCopyBody(source, stageName || name, parentId), headers, true);
            createdRootId = staged.id;
            if (needsStage) stageId = staged.id;
        }
        if (target) {
            await drive.transferWrite(target.id, { trashed: true }, headers);
            targetTrashed = true;
        }
        if (copy) {
            if (needsStage) {
                publishAttempted = true;
                await drive.transferWrite(stageId!, {
                    name,
                    ...(isFolder && source.modifiedTime ? { modifiedTime: source.modifiedTime } : {}),
                }, headers);
            }
        } else {
            const parents = sourceParentId !== parentId
                ? '&addParents=' + encodeURIComponent(parentId) + (sourceParentId ? '&removeParents=' + encodeURIComponent(sourceParentId) : '')
                : '';
            await drive.transferWrite(source.id, { name }, headers, false, parents);
        }
        completed = true;
        if (!copy) {
            await drive.notifySync({
                type: 'move',
                id: source.id,
                oldParentId: sourceParentId,
                newParentId: parentId,
                isFolder,
                replacedId: target?.id,
            });
        } else if (isFolder) {
            await drive.notifySync({
                type: 'upsert_tree',
                parentId,
                replacedId: target?.id,
                items: [{ id: createdRootId!, parentId, isFolder: true }, ...copiedItems],
            });
        } else {
            await drive.notifySync(target
                ? { type: 'upsert_tree', parentId, replacedId: target.id, items: [{ id: createdRootId!, parentId, isFolder: false }] }
                : { type: 'upsert', id: createdRootId!, parentId, isFolder: false });
        }
        return new Response(null, {
            status: target ? 204 : 201,
            ...(!copy && !target ? { headers: { Location: destination } } : {}),
        });
    } catch (error) {
        let message = error instanceof Error ? error.message : String(error);
        const definitive = error instanceof TransferError && error.definitive;
        if (targetTrashed && definitive) {
            try {
                await drive.transferWrite(target!.id, { trashed: false }, headers);
                message += '; previous destination restored';
            } catch (restoreError) {
                message += '; destination restore failed: ' + (restoreError instanceof Error ? restoreError.message : String(restoreError));
            }
        } else if (targetTrashed) {
            message += '; previous destination retained in Trash; write outcome uncertain, inspect before retrying';
        }
        // Clean up unpublished staged copies unless the final publish rename failed
        // ambiguously, where trashing could destroy a copy that already succeeded.
        if (stageId && (!publishAttempted || definitive)) {
            try {
                const cleanup = await drive.trashFile(stageId);
                if (cleanup.ok) {
                    await cleanup.body?.cancel();
                } else {
                    message += '; stage cleanup failed: ' + await cleanup.text();
                }
            } catch (cleanupError) {
                message += '; stage cleanup failed: ' + (cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
            }
        } else if (stageName) {
            message += '; recovery copy: ' + stageName + (stageId ? ' (ID ' + stageId + ')' : ' (creation outcome may be uncertain)');
        }
        if (target) message += '; previous destination ID: ' + target.id;
        return new Response(message, { status: errorStatus(error) });
    } finally {
        // Also evict after failed/ambiguous writes, not just confirmed ones.
        // Evict after Drive writes so the confirmed result is visible locally.
        // Cache failures must not hide the Drive outcome/recovery IDs or
        // prevent invalidating the other path. Local subtree eviction comes first.
        if (!completed && (targetTrashed || publishAttempted)) {
            const touches = [drive.notifySync({ type: 'touch', id: parentId, isFolder: true })];
            if (!copy && sourceParentId && sourceParentId !== parentId) {
                touches.push(drive.notifySync({ type: 'touch', id: sourceParentId, isFolder: true }));
            }
            await Promise.all(touches.map(promise => promise.catch(error => console.error('Transfer sync invalidation failed:', error))));
        }
        const invalidations = [drive.cache.invalidateTransferPath(destPath, parentId, target?.mimeType === FOLDER_MIME || isFolder)];
        if (!copy) invalidations.push(drive.cache.invalidateTransferPath(fpath, sourceParentId, isFolder));
        await Promise.all(invalidations.map(promise => promise.catch(error => console.error('Transfer cache invalidation failed:', error))));
    }
}

export function handleMove(drive: DriveClient, request: Request, mount: DavMount, principal: AuthPrincipal): Promise<Response> {
    return handleTransfer(drive, request, mount, principal, false);
}

export function handleCopy(drive: DriveClient, request: Request, mount: DavMount, principal: AuthPrincipal): Promise<Response> {
    return handleTransfer(drive, request, mount, principal, true);
}
