import { type RuntimeConfig } from '../config';
import { StatusError, TransferError, encodeQueryString, escapeQuery, trimString } from '../http';
import { type SyncIndexClient } from '../sync/client';
import { type SyncMutation } from '../sync/types';
import { type MemoryCache, isolateCache, scopedCacheKey } from './cache';
import { getAccessToken, invalidateAccessToken } from './oauth';
import { FOLDER_MIME, PROPERTY_FIELDS, type StorageQuota, UPLOAD_RESULT_FIELDS, isVisibleDriveItem } from './types';

const FOLDER_META_TTL = 300000;
const FILE_META_TTL = 30000;
const OBJECTS_TTL = 30000;

function parseNonNegativeBigInt(value: unknown): bigint | undefined {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return /^\d+$/.test(trimmed) ? BigInt(trimmed) : undefined;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        return BigInt(value);
    }
    return undefined;
}

export class DriveClient {
    readonly config: RuntimeConfig;
    readonly cache: MemoryCache;
    readonly sync: SyncIndexClient | null;

    constructor(config: RuntimeConfig, sync: SyncIndexClient | null = null) {
        this.config = config;
        this.cache = isolateCache;
        this.sync = sync;
    }

    getAccessToken(): Promise<string> {
        return getAccessToken(this.config);
    }

    refreshAccessToken(): Promise<string> {
        invalidateAccessToken(this.config);
        return getAccessToken(this.config);
    }

    async notifySync(mutation: SyncMutation): Promise<void> {
        await this.sync?.mutate(mutation);
    }

    private rootMetadata() {
        return { id: this.config.rootId, mimeType: FOLDER_MIME, size: 0, modifiedTime: null };
    }

    async jsonHeaders(): Promise<Record<string, string>> {
        return {
            'Content-Type': 'application/json; charset=UTF-8',
            Authorization: 'Bearer ' + (await this.getAccessToken()),
        };
    }

    async getPropertyMetadata(id: string): Promise<any> {
        const response = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id)
            + '?supportsAllDrives=true&fields=' + encodeURIComponent(PROPERTY_FIELDS), {
            headers: { Authorization: 'Bearer ' + (await this.getAccessToken()) },
        });
        if (!response.ok) throw new StatusError('Drive property read failed: ' + await response.text(), response.status);
        return response.json();
    }

    async createFolder(name: string, parentId: string): Promise<Response> {
        return fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
            method: 'POST',
            headers: await this.jsonHeaders(),
            body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
        });
    }

    async createEmptyFile(name: string, parentId: string, mimeType: string, modifiedTime?: string): Promise<Response> {
        return fetch('https://www.googleapis.com/drive/v3/files?fields=' + encodeURIComponent(UPLOAD_RESULT_FIELDS), {
            method: 'POST',
            headers: await this.jsonHeaders(),
            body: JSON.stringify({ name, parents: [parentId], mimeType, modifiedTime }),
        });
    }

    async truncateFile(fileId: string, mimeType: string): Promise<Response> {
        // A JSON PATCH with "{}" only touches metadata and would leave the
        // previous bytes behind, so truncate through the media endpoint.
        return fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=${encodeURIComponent(UPLOAD_RESULT_FIELDS)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': mimeType, Authorization: 'Bearer ' + (await this.getAccessToken()) },
            body: new Uint8Array(0),
        });
    }

    async updateFileMetadata(fileId: string, body: Record<string, unknown>, query?: string): Promise<Response> {
        const suffix = query ? '?' + query : '';
        return fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + suffix, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await this.getAccessToken()) },
            body: JSON.stringify(body),
        });
    }

    async trashFile(id: string): Promise<Response> {
        return this.updateFileMetadata(id, { trashed: true }, 'supportsAllDrives=true&fields=id');
    }

    async initResumableUpload(options: {
        existingFileId: string | null;
        name: string;
        parentId: string;
        mimeType: string;
        contentLength?: number;
        modifiedTime?: string;
    }): Promise<Response> {
        const { existingFileId, name, parentId, mimeType, contentLength, modifiedTime } = options;
        const api = 'https://www.googleapis.com/upload/drive/v3/files';
        const initUrl = `${api}${existingFileId ? '/' + existingFileId : ''}?uploadType=resumable&fields=${encodeURIComponent(UPLOAD_RESULT_FIELDS)}`;
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': mimeType,
            Authorization: 'Bearer ' + (await this.getAccessToken()),
        };
        if (contentLength !== undefined) {
            headers['X-Upload-Content-Length'] = String(contentLength);
        }
        const body = existingFileId
            ? (modifiedTime !== undefined ? { modifiedTime } : {})
            : { name, parents: [parentId], mimeType, ...(modifiedTime !== undefined ? { modifiedTime } : {}) };
        return fetch(initUrl, {
            method: existingFileId ? 'PATCH' : 'POST',
            headers,
            body: JSON.stringify(body),
        });
    }

    async uploadMediaStream(fileId: string, mimeType: string, body: ReadableStream<Uint8Array>): Promise<Response> {
        return fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=${encodeURIComponent(UPLOAD_RESULT_FIELDS)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': mimeType, Authorization: 'Bearer ' + (await this.getAccessToken()) },
            body,
            // @ts-expect-error RequestInit lacks Fetch half-duplex typing
            duplex: 'half',
        });
    }

    async uploadMultipartStream(boundary: string, body: ReadableStream<Uint8Array>): Promise<Response> {
        return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=' + encodeURIComponent(UPLOAD_RESULT_FIELDS), {
            method: 'POST',
            headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, Authorization: 'Bearer ' + (await this.getAccessToken()) },
            body,
            // @ts-expect-error RequestInit lacks Fetch half-duplex typing
            duplex: 'half',
        });
    }

    async uploadResumableChunk(
        uploadUrl: string,
        contentLength: number,
        contentRange: string,
        body: Uint8Array | ReadableStream<Uint8Array>,
        streaming = false,
    ): Promise<Response> {
        return fetch(uploadUrl, {
            method: 'PUT',
            headers: {
                'Content-Length': String(contentLength),
                'Content-Range': contentRange,
            },
            body,
            ...(streaming ? { duplex: 'half' } : {}),
        });
    }

    private async parseTransferId(response: Response, label: string, expectedNotId?: string, expectedId?: string): Promise<{ id: string }> {
        if (!response.ok) {
            throw new TransferError(label + ' failed: ' + await response.text(), response.status,
                response.status >= 400 && response.status < 500 && response.status !== 408);
        }
        let result: any;
        try { result = await response.json(); } catch { /* success with an unreadable body is ambiguous */ }
        if (!result || typeof result.id !== 'string' || !result.id
            || (expectedNotId !== undefined && result.id === expectedNotId)
            || (expectedId !== undefined && result.id !== expectedId)) {
            throw new TransferError(label + ' returned no valid ID; outcome uncertain', 502, false);
        }
        return result;
    }

    async transferCreate(body: Record<string, unknown>, headers: Record<string, string>): Promise<{ id: string }> {
        const response = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id', {
            method: 'POST', headers, body: JSON.stringify(body),
        });
        return this.parseTransferId(response, 'Drive create');
    }

    async transferWrite(id: string, body: Record<string, unknown>, headers: Record<string, string>, copy = false, parents = ''): Promise<{ id: string }> {
        const response = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id)
            + (copy ? '/copy' : '') + '?supportsAllDrives=true&fields=id' + parents, {
            method: copy ? 'POST' : 'PATCH', headers, body: JSON.stringify(body),
        });
        return this.parseTransferId(response, 'Drive write for ' + id, copy ? id : undefined, copy ? undefined : id);
    }

    /** Resolves `path` only when it refers to an existing visible folder, otherwise `null`. */
    async getFolderMetadata(path: string): Promise<any | null> {
        const metadata = await this.getMetadata(path || '/');
        return metadata?.mimeType === FOLDER_MIME ? metadata : null;
    }

    async getMetadata(path: string, options?: { bypassLeafCache?: boolean }): Promise<any> {
        path = path.startsWith('/') ? path : '/' + path;
        path = path.endsWith('/') ? path : path + '/';
        if (path === '/') return this.rootMetadata();
        const bypassLeafCache = options?.bypassLeafCache ?? false;
        if (!this.sync && !bypassLeafCache) {
            const cached = await this.cache.get(path, 'meta');
            if (cached) return cached;
        }

        let fullpath = '/';
        let metadata: any = this.rootMetadata();

        const fragments = trimString(path, '/').split('/').filter(Boolean);

        for (let i = 0; i < fragments.length; i++) {
            const name = fragments[i];
            const isLeaf = i === fragments.length - 1;
            if (metadata.mimeType !== FOLDER_MIME) return null;
            fullpath += name + '/';
            const parentScope = this.sync ? await this.sync.getGeneration(metadata.id) : null;
            const canUseCache = !this.sync || parentScope !== null;
            const cacheKey = scopedCacheKey(fullpath, parentScope);
            let meta = canUseCache && !(isLeaf && bypassLeafCache) ? await this.cache.get(cacheKey, 'meta') : null;
            if (!meta) {
                // `getUrl` already decoded the path once; decoding again here
                // threw a URIError for any name containing a literal "%".
                let pageToken: string | undefined;
                let visible: any;
                do {
                    const result = await this.queryDrive({
                        includeItemsFromAllDrives: true,
                        supportsAllDrives: true,
                        pageSize: 1000,
                        q: `'${metadata.id}' in parents and name = '${escapeQuery(name)}' and trashed = false`,
                        fields: `nextPageToken, files(${PROPERTY_FIELDS},thumbnailLink,imageMediaMetadata)`,
                        ...(pageToken ? { pageToken } : {}),
                    });
                    visible = result.files?.find(isVisibleDriveItem) ?? null;
                    pageToken = result.nextPageToken;
                } while (!visible && pageToken);
                if (!visible) {
                    if (isLeaf && bypassLeafCache) await this.cache.delete(fullpath, 'meta');
                    return null;
                }
                if (canUseCache) {
                    const ttl = visible.mimeType === FOLDER_MIME ? FOLDER_META_TTL : FILE_META_TTL;
                    await this.cache.put(cacheKey, visible, 'meta', ttl);
                }
                meta = visible;
            }
            metadata = meta;
        }
        return metadata;
    }

    async getObjects(id: string): Promise<any[]> {
        const scope = this.sync ? await this.sync.getGeneration(id) : null;
        const canUseCache = !this.sync || scope !== null;
        const cacheKey = scopedCacheKey(id, scope);
        const cachedList = canUseCache ? await this.cache.get(cacheKey, 'objects') : null;
        if (cachedList) return cachedList;

        let pageToken: string | undefined;
        const list: any[] = [];
        const params: any = {
            pageSize: 1000,
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            q: `'${id}' in parents and trashed = false`,
            fields: `nextPageToken, files(${PROPERTY_FIELDS},thumbnailLink,imageMediaMetadata)`,
            orderBy: 'folder, name',
        };
        do {
            if (pageToken) params.pageToken = pageToken;
            const result = await this.queryDrive(params);
            pageToken = result.nextPageToken;
            if (result.files) list.push(...result.files.filter(isVisibleDriveItem));
        } while (pageToken);

        if (canUseCache) {
            await this.cache.put(cacheKey, list, 'objects', OBJECTS_TTL);
        }
        return list;
    }

    private async fetchMedia(url: URL, range: string | null, abuse: boolean): Promise<Response> {
        const headers: Record<string, string> = { Authorization: 'Bearer ' + (await this.getAccessToken()) };
        if (range) headers['Range'] = range;
        url.searchParams.set('alt', 'media');
        url.searchParams.set('acknowledgeAbuse', abuse ? 'true' : 'false');
        return fetch(url.toString(), { headers });
    }

    getRevisionContent(id: string, revisionId: string, range: string | null, abuse: boolean): Promise<Response> {
        const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}`);
        return this.fetchMedia(url, range, abuse);
    }

    getFileContent(id: string, range: string | null, abuse: boolean): Promise<Response> {
        const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`);
        url.searchParams.set('supportsAllDrives', 'true');
        return this.fetchMedia(url, range, abuse);
    }

    async queryDrive(params: Record<string, any>, retryCount: number = 0): Promise<any> {
        const driveUrl = 'https://www.googleapis.com/drive/v3/files?' + encodeQueryString(params);
        const response = await fetch(driveUrl, { headers: { Authorization: 'Bearer ' + (await this.getAccessToken()) } });
        const result: any = await response.json();

        if (result.error) {
            const errMsg = result.error.message || '';
            const retriable = response.status === 429
                || (typeof response.status === 'number' && response.status >= 500)
                || errMsg.includes('Rate Limit')
                || errMsg.includes('Quota exceeded');
            if (retriable && retryCount < 3) {
                await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, retryCount)));
                return this.queryDrive(params, retryCount + 1);
            }
            throw new StatusError(errMsg || 'Unknown Google Drive API Error', response.status);
        }
        return result;
    }

    async getQuota(): Promise<StorageQuota | undefined> {
        const response = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', {
            headers: { Authorization: 'Bearer ' + (await this.getAccessToken()) },
        });
        if (!response.ok) {
            await response.body?.cancel();
            return undefined;
        }
        const result: any = await response.json().catch(() => null);
        const quota = result?.storageQuota;
        if (!quota || typeof quota !== 'object') {
            return undefined;
        }
        const used = parseNonNegativeBigInt(quota.usage);
        if (used === undefined) {
            return undefined;
        }
        const limit = parseNonNegativeBigInt(quota.limit);
        if (limit === undefined) {
            return { used: used.toString() };
        }
        const available = limit > used ? limit - used : 0n;
        return { limit: limit.toString(), available: available.toString(), used: used.toString() };
    }
}
