import { splitPath } from '../http';

// Shared only within this isolate. Entries expire and are capped per namespace;
// large listings are fetched normally rather than retained in memory.
const CACHE_ENTRIES = 128;
const CACHE_ENTRY_BYTES = 64 * 1024;

export class MemoryCache {
    private store: Record<string, Record<string, { data: any; expire: number }>> = {};

    async get(k: string, ns: string): Promise<any> {
        const entries = this.store[ns];
        const entry = entries?.[k];
        if (entry && entry.expire > Date.now()) return entry.data;
        if (entries) delete entries[k];
        return null;
    }

    async put(k: string, v: any, ns: string, ttl = 300000): Promise<void> {
        const entries = this.store[ns] ??= {};
        const now = Date.now();
        for (const key of Object.keys(entries)) {
            if (entries[key].expire <= now) delete entries[key];
        }
        delete entries[k];
        if (!v || new TextEncoder().encode(k + JSON.stringify(v)).byteLength > CACHE_ENTRY_BYTES) return;
        const keys = Object.keys(entries);
        if (keys.length >= CACHE_ENTRIES) delete entries[keys[0]];
        entries[k] = { data: v, expire: now + ttl };
    }

    async delete(k: string, ns: string): Promise<void> {
        if (ns === 'meta' && !k.endsWith('/')) k += '/';
        if (ns === 'meta' && k === '/') return;
        if (this.store[ns]) delete this.store[ns][k];
    }

    async invalidateFileAndParent(fpath: string, parentId?: string | null): Promise<void> {
        const { parent } = splitPath(fpath);
        await this.delete(fpath, 'meta');
        if (parent !== fpath) await this.delete(parent, 'meta');
        if (parentId) await this.delete(parentId, 'objects');
    }

    async invalidateTransferPath(path: string, parentId?: string, tree = false): Promise<void> {
        const prefix = path.replace(/\/+$/, '') + '/';
        if (tree && this.store.meta) {
            for (const key of Object.keys(this.store.meta)) {
                if (key.startsWith(prefix)) delete this.store.meta[key];
            }
        }
        await this.invalidateFileAndParent(path, parentId);
    }
}

export const isolateCache = new MemoryCache();
