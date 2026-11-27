import { DurableObject } from 'cloudflare:workers';
import { FOLDER_MIME, isVisibleDriveItem } from '../drive/types';
import { StatusError, encodeQueryString, errorStatus, escapeQuery } from '../http';
import { type SyncMutation, folderEtag } from './types';

export { type SyncMutation, folderEtag } from './types';

export const SYNC_POLL_INTERVAL_MS = 30_000;
const MAX_CHANGE_PAGES = 50;
const SEED_CONCURRENCY = 6;
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 1000;
const CHANGES_FIELDS = 'nextPageToken,newStartPageToken,changes(changeType,fileId,removed,file(id,name,mimeType,parents,trashed))';
const SEED_LIST_FIELDS = 'nextPageToken,files(id,mimeType,parents)';

interface ItemRow extends Record<string, SqlStorageValue> {
    id: string;
    parent_id: string | null;
    is_folder: number;
    etag_gen: number;
}

interface MetaRow extends Record<string, SqlStorageValue> {
    key: string;
    value: string;
}

interface DriveChangeFile {
    id?: string;
    name?: string;
    mimeType?: string;
    parents?: string[];
    trashed?: boolean;
}

interface DriveChange {
    changeType?: string;
    fileId?: string;
    removed?: boolean;
    file?: DriveChangeFile;
}

interface ScannedItem {
    id: string;
    parentId: string;
    isFolder: boolean;
}

function generateEpoch(previousEpoch: string): string {
    for (let attempt = 0; attempt < 8; attempt++) {
        const bytes = new Uint8Array(4);
        crypto.getRandomValues(bytes);
        const candidate = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        if (candidate !== previousEpoch) return candidate;
    }
    return ((Date.now() >>> 0).toString(16)).padStart(8, '0');
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    });
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter && /^\d+$/.test(retryAfter.trim())) {
        return Math.min(MAX_RETRY_DELAY_MS, Number(retryAfter.trim()) * 1000);
    }
    return Math.min(MAX_RETRY_DELAY_MS, 50 * (attempt + 1));
}

async function fetchDriveJson<T = any>(
    url: string,
    accessToken: string,
    attempt = 0,
): Promise<{ status: number; ok: boolean; data: T | null }> {
    const response = await fetch(url, {
        headers: { Authorization: 'Bearer ' + accessToken },
    });
    if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        throw new StatusError('Drive unauthorized', 401);
    }
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const delayMs = retryDelayMs(attempt, response.headers.get('Retry-After'));
        await response.body?.cancel().catch(() => undefined);
        if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        return fetchDriveJson<T>(url, accessToken, attempt + 1);
    }
    const data = await response.json<T>().catch(() => null);
    return { status: response.status, ok: response.ok, data };
}

function extractDriveError(data: any, fallback: string): string {
    const message = data?.error?.message;
    return typeof message === 'string' && message ? message : fallback;
}

/**
 * SQLite-backed Durable Object maintaining a lightweight visible folder/file
 * index and Drive changes cursor with selective ancestor ETag bubbling.
 */
export class SyncIndex extends DurableObject {
    private queue: Promise<unknown> = Promise.resolve();
    private loaded = false;
    private configRootId = '';
    private resolvedRootId = '';
    private pageToken = '';
    private epoch = '';
    private genSeq = 0;
    private rootEtagGen = 1;
    private lastPollAt = 0;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS sync_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS items (
                id TEXT PRIMARY KEY,
                parent_id TEXT,
                is_folder INTEGER NOT NULL,
                etag_gen INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id);
        `);
    }

    fetch(request: Request): Promise<Response> {
        const result = this.queue.then(() => this.handle(request));
        this.queue = result.catch(() => undefined);
        return result;
    }

    private loadFromStorage(): void {
        const currentEpoch = this.ctx.storage.sql.exec<{ value: string }>(
            "SELECT value FROM sync_meta WHERE key = 'epoch'",
        ).toArray()[0]?.value ?? '';
        if (this.loaded && currentEpoch === this.epoch) return;
        const rows = this.ctx.storage.sql.exec<MetaRow>('SELECT key, value FROM sync_meta').toArray();
        const meta = new Map(rows.map(row => [row.key, row.value]));
        this.configRootId = meta.get('config_root_id') ?? '';
        this.resolvedRootId = meta.get('resolved_root_id') ?? '';
        this.pageToken = meta.get('page_token') ?? '';
        this.epoch = meta.get('epoch') ?? '';
        const genSeq = Number(meta.get('gen_seq') ?? '0');
        this.genSeq = Number.isSafeInteger(genSeq) && genSeq >= 0 ? genSeq : 0;
        const lastPoll = Number(meta.get('last_poll_at') ?? '0');
        this.lastPollAt = Number.isFinite(lastPoll) && lastPoll >= 0 ? lastPoll : 0;
        this.refreshRootEtagGen();
        this.loaded = true;
    }

    private refreshRootEtagGen(): void {
        if (!this.resolvedRootId) {
            this.rootEtagGen = 1;
            return;
        }
        const row = this.getItemRow(this.resolvedRootId);
        this.rootEtagGen = row?.etag_gen ?? 1;
    }

    private setMeta(key: string, value: string): void {
        this.ctx.storage.sql.exec(
            'INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            key,
            value,
        );
    }

    private getItemRow(id: string): ItemRow | undefined {
        return this.ctx.storage.sql.exec<ItemRow>(
            'SELECT id, parent_id, is_folder, etag_gen FROM items WHERE id = ?',
            id,
        ).toArray()[0];
    }

    private normalizeId(id: string): string {
        if (id === this.configRootId && this.resolvedRootId) {
            return this.resolvedRootId;
        }
        return id;
    }

    private collectAncestors(startId: string | null | undefined, out: Set<string>): void {
        let current = startId ? this.normalizeId(startId) : null;
        const seen = new Set<string>();
        while (current && !seen.has(current)) {
            seen.add(current);
            const row = this.getItemRow(current);
            if (!row || !row.is_folder) break;
            out.add(row.id);
            current = row.parent_id;
        }
    }

    private deleteSubtree(rootId: string): void {
        const stack = [rootId];
        const seen = new Set<string>();
        while (stack.length > 0) {
            const current = stack.pop()!;
            if (seen.has(current)) continue;
            seen.add(current);
            const children = this.ctx.storage.sql.exec<{ id: string }>(
                'SELECT id FROM items WHERE parent_id = ?',
                current,
            ).toArray();
            for (const child of children) {
                stack.push(child.id);
            }
            this.ctx.storage.sql.exec('DELETE FROM items WHERE id = ?', current);
        }
    }

    private bumpTargets(targets: Set<string>): number {
        if (targets.size === 0) return this.genSeq;
        const nextGen = this.genSeq + 1;
        for (const folderId of targets) {
            this.ctx.storage.sql.exec(
                'UPDATE items SET etag_gen = ? WHERE id = ? AND is_folder = 1',
                nextGen,
                folderId,
            );
        }
        this.genSeq = nextGen;
        this.setMeta('gen_seq', String(nextGen));
        this.refreshRootEtagGen();
        return nextGen;
    }

    private async listFolderChildren(
        folderId: string,
        accessToken: string,
    ): Promise<Array<{ id?: string; mimeType?: string; parents?: string[] }>> {
        const items: Array<{ id?: string; mimeType?: string; parents?: string[] }> = [];
        let pageToken: string | undefined;
        do {
            const query = encodeQueryString({
                includeItemsFromAllDrives: 'true',
                supportsAllDrives: 'true',
                pageSize: '1000',
                q: `'${escapeQuery(folderId)}' in parents and trashed = false`,
                fields: SEED_LIST_FIELDS,
                ...(pageToken ? { pageToken } : {}),
            });
            const res = await fetchDriveJson<{
                nextPageToken?: string;
                files?: Array<{ id?: string; mimeType?: string; parents?: string[] }>;
            }>('https://www.googleapis.com/drive/v3/files?' + query, accessToken);
            if (!res.ok || !res.data) {
                throw new StatusError(extractDriveError(res.data, 'Drive folder scan failed'), res.status || 502);
            }
            if (Array.isArray(res.data.files)) {
                items.push(...res.data.files);
            }
            pageToken = typeof res.data.nextPageToken === 'string' && res.data.nextPageToken
                ? res.data.nextPageToken
                : undefined;
        } while (pageToken);
        return items;
    }

    private async scanSubtree(
        startFolderIds: string[],
        accessToken: string,
        visited: Set<string>,
    ): Promise<ScannedItem[]> {
        const discovered: ScannedItem[] = [];
        let frontier: string[] = [];
        for (const id of startFolderIds) {
            if (!visited.has(id)) {
                visited.add(id);
                frontier.push(id);
            }
        }
        while (frontier.length > 0) {
            const nextFrontier: string[] = [];
            for (let i = 0; i < frontier.length; i += SEED_CONCURRENCY) {
                const batch = frontier.slice(i, i + SEED_CONCURRENCY);
                const lists = await Promise.all(
                    batch.map(async parentId => ({ parentId, children: await this.listFolderChildren(parentId, accessToken) })),
                );
                for (const { parentId, children } of lists) {
                    for (const child of children) {
                        if (!child.id || !isVisibleDriveItem(child) || visited.has(child.id)) continue;
                        visited.add(child.id);
                        const isFolder = child.mimeType === FOLDER_MIME;
                        discovered.push({ id: child.id, parentId, isFolder });
                        if (isFolder) nextFrontier.push(child.id);
                    }
                }
            }
            frontier = nextFrontier;
        }
        return discovered;
    }

    private async seed(configRootId: string, accessToken: string): Promise<void> {
        // Fetch startPageToken before scanning so any concurrent edits during
        // the scan are picked up on the next poll without gaps.
        const tokenRes = await fetchDriveJson<{ startPageToken?: string }>(
            'https://www.googleapis.com/drive/v3/changes/startPageToken?supportsAllDrives=true&fields=startPageToken',
            accessToken,
        );
        if (!tokenRes.ok || typeof tokenRes.data?.startPageToken !== 'string' || !tokenRes.data.startPageToken) {
            throw new StatusError(extractDriveError(tokenRes.data, 'Drive changes startPageToken failed'), tokenRes.ok ? 502 : tokenRes.status || 502);
        }
        const startPageToken = tokenRes.data.startPageToken;

        const rootRes = await fetchDriveJson<{ id?: string; mimeType?: string; trashed?: boolean }>(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(configRootId)}?supportsAllDrives=true&fields=id,mimeType,trashed`,
            accessToken,
        );
        if (!rootRes.ok || !rootRes.data) {
            throw new StatusError(extractDriveError(rootRes.data, 'Drive root metadata failed'), rootRes.status || 502);
        }
        if (rootRes.data.trashed === true) {
            throw new StatusError('Configured ROOT_ID is trashed', 404);
        }
        if (rootRes.data.mimeType !== FOLDER_MIME) {
            throw new StatusError('Configured ROOT_ID is not a folder', 500);
        }
        const resolvedRootId = typeof rootRes.data.id === 'string' && rootRes.data.id ? rootRes.data.id : configRootId;
        const scanned = await this.scanSubtree([resolvedRootId], accessToken, new Set<string>());
        const nextEpoch = generateEpoch(this.epoch);
        const now = Date.now();

        this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec('DELETE FROM items');
            this.ctx.storage.sql.exec(
                'INSERT INTO items (id, parent_id, is_folder, etag_gen) VALUES (?, NULL, 1, 1)',
                resolvedRootId,
            );
            for (const item of scanned) {
                this.ctx.storage.sql.exec(
                    'INSERT OR REPLACE INTO items (id, parent_id, is_folder, etag_gen) VALUES (?, ?, ?, ?)',
                    item.id,
                    item.parentId,
                    item.isFolder ? 1 : 0,
                    item.isFolder ? 1 : 0,
                );
            }
            this.setMeta('config_root_id', configRootId);
            this.setMeta('resolved_root_id', resolvedRootId);
            this.setMeta('page_token', startPageToken);
            this.setMeta('epoch', nextEpoch);
            this.setMeta('gen_seq', '1');
            this.setMeta('last_poll_at', String(now));
        });

        this.configRootId = configRootId;
        this.resolvedRootId = resolvedRootId;
        this.pageToken = startPageToken;
        this.epoch = nextEpoch;
        this.genSeq = 1;
        this.rootEtagGen = 1;
        this.lastPollAt = now;
    }

    private async ensureSeeded(configRootId: string, accessToken: string): Promise<boolean> {
        this.loadFromStorage();
        if (!this.pageToken || !this.resolvedRootId || this.configRootId !== configRootId) {
            await this.seed(configRootId, accessToken);
            return true;
        }
        return false;
    }

    private async pollChanges(
        configRootId: string,
        accessToken: string,
    ): Promise<{ reseeded: boolean; polled: boolean }> {
        let cursor = this.pageToken;
        let newStartPageToken = '';
        const allChanges: DriveChange[] = [];

        for (let page = 0; page < MAX_CHANGE_PAGES; page++) {
            const query = encodeQueryString({
                pageToken: cursor,
                pageSize: '1000',
                includeItemsFromAllDrives: 'true',
                supportsAllDrives: 'true',
                includeRemoved: 'true',
                fields: CHANGES_FIELDS,
            });
            const res = await fetchDriveJson<{
                nextPageToken?: string;
                newStartPageToken?: string;
                changes?: DriveChange[];
            }>('https://www.googleapis.com/drive/v3/changes?' + query, accessToken);

            if (res.status === 400 || res.status === 410) {
                await this.seed(configRootId, accessToken);
                return { reseeded: true, polled: true };
            }
            if (!res.ok || !res.data) {
                throw new StatusError(extractDriveError(res.data, 'Drive changes.list failed'), res.status || 502);
            }
            if (Array.isArray(res.data.changes)) {
                allChanges.push(...res.data.changes);
            }
            if (typeof res.data.nextPageToken === 'string' && res.data.nextPageToken) {
                cursor = res.data.nextPageToken;
                continue;
            }
            if (typeof res.data.newStartPageToken === 'string' && res.data.newStartPageToken) {
                newStartPageToken = res.data.newStartPageToken;
                break;
            }
            await this.seed(configRootId, accessToken);
            return { reseeded: true, polled: true };
        }

        if (!newStartPageToken) {
            await this.seed(configRootId, accessToken);
            return { reseeded: true, polled: true };
        }

        const latestById = new Map<string, DriveChange>();
        for (const change of allChanges) {
            if (!change || typeof change.fileId !== 'string' || !change.fileId) continue;
            if (change.changeType && change.changeType !== 'file') continue;
            latestById.set(change.fileId, change);
        }

        const rootChange = latestById.get(this.resolvedRootId);
        if (rootChange && (rootChange.removed || !rootChange.file || rootChange.file.trashed === true || !isVisibleDriveItem(rootChange.file))) {
            await this.seed(configRootId, accessToken);
            return { reseeded: true, polled: true };
        }

        const existingFolders = new Map<string, string | null>();
        for (const row of this.ctx.storage.sql.exec<{ id: string; parent_id: string | null }>('SELECT id, parent_id FROM items WHERE is_folder = 1').toArray()) {
            existingFolders.set(row.id, row.parent_id);
        }

        const postFolderParent = new Map(existingFolders);
        const removedIds = new Set<string>();
        const liveFolderIds: string[] = [];
        const liveFiles: Array<{ id: string; parentId: string | null }> = [];

        for (const [fileId, change] of latestById) {
            if (fileId === this.resolvedRootId) continue;
            const file = change.file;
            if (change.removed || !file || file.trashed === true || !isVisibleDriveItem(file)) {
                removedIds.add(fileId);
                postFolderParent.delete(fileId);
                continue;
            }
            const rawParent = file.parents?.[0];
            const parentId = rawParent ? this.normalizeId(rawParent) : null;
            if (file.mimeType === FOLDER_MIME) {
                postFolderParent.set(fileId, parentId);
                liveFolderIds.push(fileId);
            } else {
                liveFiles.push({ id: fileId, parentId });
            }
        }

        const isInsideRoot = (folderId: string): boolean => {
            let current: string | null | undefined = folderId;
            const seen = new Set<string>();
            while (current && !seen.has(current)) {
                if (current === this.resolvedRootId) return true;
                if (!postFolderParent.has(current)) return false;
                seen.add(current);
                current = postFolderParent.get(current);
            }
            return false;
        };

        const movedOutFolderIds: string[] = [];
        for (const folderId of existingFolders.keys()) {
            if (folderId !== this.resolvedRootId && !removedIds.has(folderId) && !isInsideRoot(folderId)) {
                movedOutFolderIds.push(folderId);
            }
        }

        const liveInsideFolders: Array<{ id: string; parentId: string }> = [];
        const newlyEnteredFolders: string[] = [];
        for (const folderId of liveFolderIds) {
            const parentId = postFolderParent.get(folderId);
            if (parentId && isInsideRoot(folderId)) {
                liveInsideFolders.push({ id: folderId, parentId });
                if (!existingFolders.has(folderId)) {
                    newlyEnteredFolders.push(folderId);
                }
            } else if (existingFolders.has(folderId)) {
                movedOutFolderIds.push(folderId);
            }
        }

        const keptExistingFolders = new Set<string>([this.resolvedRootId]);
        for (const folderId of existingFolders.keys()) {
            if (!removedIds.has(folderId) && !movedOutFolderIds.includes(folderId) && isInsideRoot(folderId)) {
                keptExistingFolders.add(folderId);
            }
        }

        const scannedChildren = newlyEnteredFolders.length > 0
            ? await this.scanSubtree(newlyEnteredFolders, accessToken, keptExistingFolders)
            : [];

        const now = Date.now();
        this.ctx.storage.transactionSync(() => {
            const bubbleTargets = new Set<string>();
            for (const fileId of latestById.keys()) {
                if (fileId === this.resolvedRootId) {
                    bubbleTargets.add(this.resolvedRootId);
                    continue;
                }
                const existing = this.getItemRow(fileId);
                if (existing) {
                    this.collectAncestors(existing.parent_id, bubbleTargets);
                }
            }

            for (const fileId of removedIds) {
                if (fileId !== this.resolvedRootId) this.deleteSubtree(fileId);
            }
            for (const folderId of movedOutFolderIds) {
                this.deleteSubtree(folderId);
            }

            const newGenCandidate = this.genSeq + 1;
            for (const folder of liveInsideFolders) {
                const existing = this.getItemRow(folder.id);
                if (existing) {
                    this.ctx.storage.sql.exec(
                        'UPDATE items SET parent_id = ?, is_folder = 1 WHERE id = ?',
                        folder.parentId,
                        folder.id,
                    );
                } else {
                    this.ctx.storage.sql.exec(
                        'INSERT INTO items (id, parent_id, is_folder, etag_gen) VALUES (?, ?, 1, ?)',
                        folder.id,
                        folder.parentId,
                        newGenCandidate,
                    );
                }
            }
            for (const item of scannedChildren) {
                this.ctx.storage.sql.exec(
                    'INSERT INTO items (id, parent_id, is_folder, etag_gen) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, is_folder = excluded.is_folder',
                    item.id,
                    item.parentId,
                    item.isFolder ? 1 : 0,
                    item.isFolder ? newGenCandidate : 0,
                );
            }

            const affectedParents = new Set<string>();
            for (const file of liveFiles) {
                const parentRow = file.parentId ? this.getItemRow(file.parentId) : undefined;
                if (parentRow && parentRow.is_folder) {
                    this.ctx.storage.sql.exec(
                        'INSERT INTO items (id, parent_id, is_folder, etag_gen) VALUES (?, ?, 0, 0) ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, is_folder = 0',
                        file.id,
                        file.parentId,
                    );
                    affectedParents.add(parentRow.id);
                } else {
                    this.ctx.storage.sql.exec('DELETE FROM items WHERE id = ?', file.id);
                }
            }

            for (const folder of liveInsideFolders) {
                const row = this.getItemRow(folder.id);
                if (row?.is_folder) {
                    bubbleTargets.add(folder.id);
                    this.collectAncestors(row.parent_id, bubbleTargets);
                }
            }
            for (const parentId of affectedParents) {
                this.collectAncestors(parentId, bubbleTargets);
            }

            this.bumpTargets(bubbleTargets);
            this.setMeta('page_token', newStartPageToken);
            this.setMeta('last_poll_at', String(now));
            this.pageToken = newStartPageToken;
            this.lastPollAt = now;
        });

        return { reseeded: false, polled: true };
    }

    private applyMutation(configRootId: string, mutation: SyncMutation): { initialized: boolean } {
        this.loadFromStorage();
        if (!this.pageToken || !this.resolvedRootId || this.configRootId !== configRootId) {
            return { initialized: false };
        }

        this.ctx.storage.transactionSync(() => {
            const bubbleTargets = new Set<string>();
            const nextGenCandidate = this.genSeq + 1;

            switch (mutation.type) {
                case 'upsert': {
                    const id = this.normalizeId(mutation.id);
                    const parentId = this.normalizeId(mutation.parentId);
                    const existing = this.getItemRow(id);
                    if (existing) this.collectAncestors(existing.parent_id, bubbleTargets);
                    const parentRow = this.getItemRow(parentId);
                    if (parentRow?.is_folder) {
                        this.ctx.storage.sql.exec(
                            'INSERT INTO items (id, parent_id, is_folder, etag_gen) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, is_folder = excluded.is_folder',
                            id,
                            parentId,
                            mutation.isFolder ? 1 : 0,
                            existing ? existing.etag_gen : (mutation.isFolder ? nextGenCandidate : 0),
                        );
                        if (mutation.isFolder) bubbleTargets.add(id);
                        this.collectAncestors(parentId, bubbleTargets);
                    }
                    break;
                }
                case 'upsert_tree': {
                    const parentId = this.normalizeId(mutation.parentId);
                    if (mutation.replacedId) {
                        const replacedId = this.normalizeId(mutation.replacedId);
                        const repRow = this.getItemRow(replacedId);
                        if (repRow) this.collectAncestors(repRow.parent_id, bubbleTargets);
                        this.deleteSubtree(replacedId);
                    }
                    if (this.getItemRow(parentId)?.is_folder) {
                        for (const item of mutation.items) {
                            const itemId = this.normalizeId(item.id);
                            const itemParentId = this.normalizeId(item.parentId);
                            this.ctx.storage.sql.exec(
                                'INSERT INTO items (id, parent_id, is_folder, etag_gen) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, is_folder = excluded.is_folder',
                                itemId,
                                itemParentId,
                                item.isFolder ? 1 : 0,
                                item.isFolder ? nextGenCandidate : 0,
                            );
                            if (item.isFolder && itemParentId === parentId) {
                                bubbleTargets.add(itemId);
                            }
                        }
                        this.collectAncestors(parentId, bubbleTargets);
                    }
                    break;
                }
                case 'touch': {
                    const id = this.normalizeId(mutation.id);
                    const existing = this.getItemRow(id);
                    if (mutation.isFolder) {
                        if (existing?.is_folder || id === this.resolvedRootId) {
                            bubbleTargets.add(id);
                            this.collectAncestors(existing?.parent_id, bubbleTargets);
                        } else if (mutation.parentId) {
                            this.collectAncestors(this.normalizeId(mutation.parentId), bubbleTargets);
                        }
                    } else {
                        const pid = existing?.parent_id ?? (mutation.parentId ? this.normalizeId(mutation.parentId) : null);
                        if (pid) {
                            this.collectAncestors(pid, bubbleTargets);
                            if (!existing && this.getItemRow(pid)?.is_folder) {
                                this.ctx.storage.sql.exec(
                                    'INSERT OR IGNORE INTO items (id, parent_id, is_folder, etag_gen) VALUES (?, ?, 0, 0)',
                                    id,
                                    pid,
                                );
                            }
                        }
                    }
                    break;
                }
                case 'delete': {
                    const id = this.normalizeId(mutation.id);
                    if (id === this.resolvedRootId) break;
                    const existing = this.getItemRow(id);
                    const pid = existing?.parent_id ?? (mutation.parentId ? this.normalizeId(mutation.parentId) : null);
                    if (pid) this.collectAncestors(pid, bubbleTargets);
                    this.deleteSubtree(id);
                    break;
                }
                case 'move': {
                    const id = this.normalizeId(mutation.id);
                    const newParentId = this.normalizeId(mutation.newParentId);
                    if (mutation.replacedId) {
                        const replacedId = this.normalizeId(mutation.replacedId);
                        const repRow = this.getItemRow(replacedId);
                        if (repRow) this.collectAncestors(repRow.parent_id, bubbleTargets);
                        this.deleteSubtree(replacedId);
                    }
                    const existing = this.getItemRow(id);
                    const oldParentId = existing?.parent_id ?? (mutation.oldParentId ? this.normalizeId(mutation.oldParentId) : null);
                    if (oldParentId) this.collectAncestors(oldParentId, bubbleTargets);
                    if (this.getItemRow(newParentId)?.is_folder) {
                        this.ctx.storage.sql.exec(
                            'INSERT INTO items (id, parent_id, is_folder, etag_gen) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, is_folder = excluded.is_folder',
                            id,
                            newParentId,
                            mutation.isFolder ? 1 : 0,
                            existing ? existing.etag_gen : (mutation.isFolder ? nextGenCandidate : 0),
                        );
                        if (mutation.isFolder) bubbleTargets.add(id);
                        this.collectAncestors(newParentId, bubbleTargets);
                    }
                    break;
                }
            }

            this.bumpTargets(bubbleTargets);
        });

        return { initialized: true };
    }

    private async handle(request: Request): Promise<Response> {
        if (request.method !== 'POST') {
            return new Response('Method Not Allowed', { status: 405 });
        }
        const { pathname } = new URL(request.url);
        try {
            switch (pathname) {
                case '/poll': {
                    const body = await request.json<{ rootId: string; accessToken: string; force?: boolean }>();
                    let reseeded = await this.ensureSeeded(body.rootId, body.accessToken);
                    let polled = reseeded;
                    if (!reseeded && (body.force || Date.now() - this.lastPollAt >= SYNC_POLL_INTERVAL_MS)) {
                        const result = await this.pollChanges(body.rootId, body.accessToken);
                        reseeded = result.reseeded;
                        polled = result.polled;
                    }
                    return jsonResponse({
                        epoch: this.epoch,
                        rootId: this.resolvedRootId,
                        rootGen: this.rootEtagGen,
                        rootEtag: folderEtag(this.resolvedRootId, this.epoch, this.rootEtagGen),
                        reseeded,
                        polled,
                    });
                }
                case '/generations': {
                    const body = await request.json<{ rootId: string; accessToken: string; ids: string[]; poll?: boolean }>();
                    const reseeded = await this.ensureSeeded(body.rootId, body.accessToken);
                    if (!reseeded && body.poll && Date.now() - this.lastPollAt >= SYNC_POLL_INTERVAL_MS) {
                        await this.pollChanges(body.rootId, body.accessToken);
                    }
                    const generations: Record<string, number> = {};
                    for (const rawId of body.ids) {
                        const row = this.getItemRow(this.normalizeId(rawId));
                        if (row?.is_folder) {
                            generations[rawId] = row.etag_gen;
                        }
                    }
                    return jsonResponse({
                        epoch: this.epoch,
                        rootId: this.resolvedRootId,
                        rootGen: this.rootEtagGen,
                        generations,
                    });
                }
                case '/mutate': {
                    const body = await request.json<{ rootId: string; mutation: SyncMutation }>();
                    const result = this.applyMutation(body.rootId, body.mutation);
                    return jsonResponse({
                        ...result,
                        ...(result.initialized ? {
                            epoch: this.epoch,
                            rootId: this.resolvedRootId,
                            rootGen: this.rootEtagGen,
                        } : {}),
                    });
                }
                default:
                    return new Response('Not Found', { status: 404 });
            }
        } catch (error) {
            const status = errorStatus(error);
            const message = error instanceof Error ? error.message : String(error);
            return jsonResponse({ error: message }, status);
        }
    }
}
