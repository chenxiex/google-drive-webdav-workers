import { type RuntimeConfig } from '../config';
import { StatusError, TransferError, encodeQueryString, escapeQuery, trimString } from '../http';
import { type MemoryCache, isolateCache } from './cache';
import { getAccessToken } from './oauth';
import { FOLDER_MIME, PROPERTY_FIELDS, type StorageQuota, isVisibleDriveItem } from './types';

export class DriveClient {
    readonly config: RuntimeConfig;
    readonly cache: MemoryCache;

    constructor(config: RuntimeConfig) {
        this.config = config;
        this.cache = isolateCache;
    }

    getAccessToken(): Promise<string> {
        return getAccessToken(this.config);
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
        return fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: await this.jsonHeaders(),
            body: JSON.stringify({ name, parents: [parentId], mimeType, modifiedTime }),
        });
    }

    async truncateFile(fileId: string, mimeType: string): Promise<Response> {
        // A JSON PATCH with "{}" only touches metadata and would leave the
        // previous bytes behind, so truncate through the media endpoint.
        return fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
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
        const initUrl = `${api}${existingFileId ? '/' + existingFileId : ''}?uploadType=resumable`;
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
        return fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
            method: 'PATCH',
            headers: { 'Content-Type': mimeType, Authorization: 'Bearer ' + (await this.getAccessToken()) },
            body,
            // @ts-expect-error RequestInit lacks Fetch half-duplex typing
            duplex: 'half',
        });
    }

    async uploadMultipartStream(boundary: string, body: ReadableStream<Uint8Array>): Promise<Response> {
        return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
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

    async transferWrite(id: string, body: Record<string, unknown>, headers: Record<string, string>, copy = false, parents = ''): Promise<{ id: string }> {
        const response = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id)
            + (copy ? '/copy' : '') + '?supportsAllDrives=true&fields=id' + parents, {
            method: copy ? 'POST' : 'PATCH', headers, body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw new TransferError('Drive write for ' + id + ' failed: ' + await response.text(), response.status,
                response.status >= 400 && response.status < 500 && response.status !== 408);
        }
        let result: any;
        try { result = await response.json(); } catch { /* success with an unreadable body is ambiguous */ }
        if (!result || typeof result.id !== 'string' || !result.id || (copy ? result.id === id : result.id !== id)) {
            throw new TransferError('Drive write for ' + id + ' returned no valid ID; outcome uncertain', 502, false);
        }
        return result;
    }

    // Create any missing folder along the way to `path`, so a client can PUT
    // `/a/b/c.txt` without having to MKCOL `/a` and `/a/b` first.
    async ensureDir(path: string): Promise<any | null> {
        let current = await this.getMetadata('/');
        if (!current) return null;
        const dir = path.endsWith('/') ? path : path + '/';
        if (dir === '/') return current;

        const names = dir.split('/').filter(Boolean);
        for (let i = 0; i < names.length; i++) {
            const sub = '/' + names.slice(0, i + 1).join('/') + '/';
            let meta = await this.getMetadata(sub);
            if (!meta) {
                const created = await this.createFolder(names[i], current.id);
                if (!created.ok) return null;
                await this.cache.invalidateFileAndParent(sub, current.id);
                meta = await this.getMetadata(sub);
                if (!meta) return null;
            }
            current = meta;
        }
        return current;
    }

    async getMetadata(path: string): Promise<any> {
        path = path.startsWith('/') ? path : '/' + path;
        path = path.endsWith('/') ? path : path + '/';
        if (path === '/') return this.rootMetadata();
        let meta = await this.cache.get(path, 'meta');
        if (meta) return meta;

        let fullpath = '/';
        let metadata: any = this.rootMetadata();

        const fragments = trimString(path, '/').split('/');

        for (const name of fragments) {
            if (!name) continue;
            if (metadata.mimeType !== FOLDER_MIME) return null;
            fullpath += name + '/';
            meta = await this.cache.get(fullpath, 'meta');
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
                if (!visible) return null;
                await this.cache.put(fullpath, visible, 'meta');
                meta = visible;
            }
            metadata = meta;
        }
        return metadata;
    }

    async getObjects(id: string): Promise<any[]> {
        const cachedList = await this.cache.get(id, 'objects');
        if (cachedList) return cachedList;

        let pageToken: string | undefined;
        const list: any[] = [];
        const params: any = {
            pageSize: 1000,
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            q: `'${id}' in parents and trashed = false AND name != '.password'`,
            fields: `nextPageToken, files(${PROPERTY_FIELDS},thumbnailLink,imageMediaMetadata)`,
            orderBy: 'folder, name',
        };
        do {
            if (pageToken) params.pageToken = pageToken;
            const result = await this.queryDrive(params);
            pageToken = result.nextPageToken;
            if (result.files) list.push(...result.files.filter(isVisibleDriveItem));
        } while (pageToken);

        await this.cache.put(id, list, 'objects', 30000);
        return list;
    }

    async getRawContent(id: string, range: string | null, abuse: boolean): Promise<Response> {
        const headers: Record<string, string> = { Authorization: 'Bearer ' + (await this.getAccessToken()) };
        if (range) headers['Range'] = range;
        const url = new URL(`https://www.googleapis.com/drive/v2/files/${id}`);
        url.searchParams.set('supportsAllDrives', 'true');
        url.searchParams.set('alt', 'media');
        url.searchParams.set('acknowledgeAbuse', abuse ? 'true' : 'false');
        return await fetch(url.toString(), { headers });
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
        const result: any = await response.json();
        if (result.storageQuota) {
            const { limit, usage } = result.storageQuota;
            const used = BigInt(usage || '0');
            if (limit === undefined) return { used: used.toString() };
            const available = BigInt(limit) - used;
            return { available: (available < 0n ? 0n : available).toString(), used: used.toString() };
        }
    }
}
