import { describe, expect, it, vi } from 'vitest';
import { MemoryCache, scopedCacheKey } from '../../src/drive/cache';
import { folderEtag } from '../../src/sync/types';
import { FOLDER, MockDrive } from '../support/mock-drive';
import { clearFetchMock, drainUnmockedFetches, setFetchMock } from '../support/network';

describe('folderEtag and scoped MemoryCache', () => {
    it('formats folder ETags with ID, epoch, and generation', () => {
        expect(folderEtag('folder-docs', 'deadbeef', 7)).toBe('"folder-docs-deadbeef-7"');
        expect(scopedCacheKey('/docs/', { epoch: 'deadbeef', gen: 7 })).toBe('deadbeef:7:/docs/');
        expect(scopedCacheKey('/docs/', null)).toBe('/docs/');
    });

    it('isolates cache entries by (epoch, gen) while supporting logical invalidation', async () => {
        const cache = new MemoryCache();
        const scope1 = { epoch: 'aaaa1111', gen: 1 };
        const scope2 = { epoch: 'aaaa1111', gen: 2 };
        const scopeEpoch2 = { epoch: 'bbbb2222', gen: 1 };

        await cache.put(scopedCacheKey('/a/file.txt/', scope1), { id: 'old' }, 'meta', 60_000);
        await cache.put(scopedCacheKey('/a/file.txt/', scope2), { id: 'new' }, 'meta', 60_000);
        await cache.put(scopedCacheKey('/a/file.txt/', scopeEpoch2), { id: 'reseeded' }, 'meta', 60_000);
        await cache.put(scopedCacheKey('/a/', scope1), { id: 'folder-a' }, 'meta', 60_000);
        await cache.put(scopedCacheKey('folder-a', scope1), [{ id: 'f1' }], 'objects', 60_000);
        await cache.put(scopedCacheKey('/a/sub/child.txt/', scope1), { id: 'child' }, 'meta', 60_000);
        await cache.put(scopedCacheKey('/b/keep.txt/', scope1), { id: 'keep' }, 'meta', 60_000);

        expect(await cache.get(scopedCacheKey('/a/file.txt/', scope1), 'meta')).toEqual({ id: 'old' });
        expect(await cache.get(scopedCacheKey('/a/file.txt/', scope2), 'meta')).toEqual({ id: 'new' });
        expect(await cache.get(scopedCacheKey('/a/file.txt/', scopeEpoch2), 'meta')).toEqual({ id: 'reseeded' });

        await cache.invalidateFileAndParent('/a/file.txt/', 'folder-a');
        expect(await cache.get(scopedCacheKey('/a/file.txt/', scope1), 'meta')).toBeNull();
        expect(await cache.get(scopedCacheKey('/a/file.txt/', scope2), 'meta')).toBeNull();
        expect(await cache.get(scopedCacheKey('/a/file.txt/', scopeEpoch2), 'meta')).toBeNull();
        expect(await cache.get(scopedCacheKey('/a/', scope1), 'meta')).toBeNull();
        expect(await cache.get(scopedCacheKey('folder-a', scope1), 'objects')).toBeNull();
        expect(await cache.get(scopedCacheKey('/b/keep.txt/', scope1), 'meta')).toEqual({ id: 'keep' });

        await cache.invalidateTransferPath('/a/', undefined, true);
        expect(await cache.get(scopedCacheKey('/a/sub/child.txt/', scope1), 'meta')).toBeNull();
        expect(await cache.get(scopedCacheKey('/b/keep.txt/', scope1), 'meta')).toEqual({ id: 'keep' });

        await cache.put(scopedCacheKey('/', scope1), { id: 'root' }, 'meta', 60_000);
        await cache.delete('/', 'meta');
        expect(await cache.get(scopedCacheKey('/', scope1), 'meta')).toEqual({ id: 'root' });
    });
});

describe('MockDrive changes API contract', () => {
    const authHeaders = { Authorization: 'Bearer test-access-token' };

    it('issues monotonic startPageToken and paginates deduplicated changes in token order', async () => {
        const drive = new MockDrive();
        const startRes1 = await drive.handle('https://www.googleapis.com/drive/v3/changes/startPageToken?supportsAllDrives=true&fields=startPageToken', { headers: authHeaders });
        expect(startRes1.status).toBe(200);
        const start1 = (await startRes1.json<{ startPageToken: string }>()).startPageToken;
        expect(start1).toBe('1');

        drive.add({ id: 'dir-1', name: 'dir1', mimeType: FOLDER, parents: ['root'] });
        drive.add({ id: 'file-1', name: 'f1.txt', mimeType: 'text/plain', size: 1, content: new Uint8Array([1]), parents: ['dir-1'] });
        drive.add({ id: 'file-2', name: 'f2.txt', mimeType: 'text/plain', size: 1, content: new Uint8Array([2]), parents: ['dir-1'] });
        // Updating file-1 moves its latest change token after file-2.
        drive.replaceContent('file-1', new Uint8Array([9, 8]));

        const page1Res = await drive.handle(`https://www.googleapis.com/drive/v3/changes?pageToken=${start1}&pageSize=2&includeItemsFromAllDrives=true&supportsAllDrives=true`, { headers: authHeaders });
        expect(page1Res.status).toBe(200);
        const page1 = await page1Res.json<any>();
        expect(page1.nextPageToken).toBeTruthy();
        expect(page1.newStartPageToken).toBeUndefined();
        expect(page1.changes.map((c: any) => c.fileId)).toEqual(['dir-1', 'file-2']);

        const page2Res = await drive.handle(`https://www.googleapis.com/drive/v3/changes?pageToken=${page1.nextPageToken}&pageSize=2&includeItemsFromAllDrives=true&supportsAllDrives=true`, { headers: authHeaders });
        expect(page2Res.status).toBe(200);
        const page2 = await page2Res.json<any>();
        expect(page2.nextPageToken).toBeUndefined();
        expect(page2.newStartPageToken).toBe('5');
        expect(page2.changes.map((c: any) => c.fileId)).toEqual(['file-1']);
        expect(page2.changes[0].file).toMatchObject({ id: 'file-1', name: 'f1.txt' });

        const emptyRes = await drive.handle(`https://www.googleapis.com/drive/v3/changes?pageToken=${page2.newStartPageToken}&supportsAllDrives=true`, { headers: authHeaders });
        const empty = await emptyRes.json<any>();
        expect(empty.changes).toEqual([]);
        expect(empty.newStartPageToken).toBe('5');
    });

    it('rejects missing, invalid, out-of-range, and invalidated pageTokens with 400', async () => {
        const drive = new MockDrive();
        const startRes = await drive.handle('https://www.googleapis.com/drive/v3/changes/startPageToken', { headers: authHeaders });
        const { startPageToken } = await startRes.json<{ startPageToken: string }>();

        for (const url of [
            'https://www.googleapis.com/drive/v3/changes',
            'https://www.googleapis.com/drive/v3/changes?pageToken=0',
            'https://www.googleapis.com/drive/v3/changes?pageToken=abc',
            'https://www.googleapis.com/drive/v3/changes?pageToken=999',
        ]) {
            const res = await drive.handle(url, { headers: authHeaders });
            expect(res.status).toBe(400);
        }

        drive.invalidateChangeTokens();
        const invalidatedRes = await drive.handle(`https://www.googleapis.com/drive/v3/changes?pageToken=${startPageToken}`, { headers: authHeaders });
        expect(invalidatedRes.status).toBe(400);

        const refreshedStart = await drive.handle('https://www.googleapis.com/drive/v3/changes/startPageToken', { headers: authHeaders });
        const { startPageToken: freshToken } = await refreshedStart.json<{ startPageToken: string }>();
        const okRes = await drive.handle(`https://www.googleapis.com/drive/v3/changes?pageToken=${freshToken}`, { headers: authHeaders });
        expect(okRes.status).toBe(200);
    });

    it('models trash, permanent remove, permission revoke, includeRemoved, and nested fields projection', async () => {
        const drive = new MockDrive();
        drive.add({ id: 'sub', name: 'sub', mimeType: FOLDER, parents: ['root'] });
        drive.add({ id: 'f-trash', name: 't.txt', mimeType: 'text/plain', size: 1, content: new Uint8Array([1]), parents: ['root'] });
        drive.add({ id: 'f-perm', name: 'p.txt', mimeType: 'text/plain', size: 1, content: new Uint8Array([2]), parents: ['root'] });
        drive.add({ id: 'f-lost', name: 'l.txt', mimeType: 'text/plain', size: 1, content: new Uint8Array([3]), parents: ['sub'] });
        const { startPageToken } = await (await drive.handle('https://www.googleapis.com/drive/v3/changes/startPageToken', { headers: authHeaders })).json<{ startPageToken: string }>();

        await drive.handle('https://www.googleapis.com/drive/v3/files/f-trash', {
            method: 'PATCH',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ trashed: true }),
        });
        drive.remove('f-perm');
        drive.revokeAccess('sub');

        const fields = 'newStartPageToken,changes(changeType,fileId,removed,file(id,name,mimeType,parents,trashed))';
        const res = await drive.handle(`https://www.googleapis.com/drive/v3/changes?pageToken=${startPageToken}&fields=${encodeURIComponent(fields)}`, { headers: authHeaders });
        expect(res.status).toBe(200);
        const body = await res.json<any>();
        expect(body.changes).toEqual([
            {
                changeType: 'file',
                fileId: 'f-trash',
                removed: false,
                file: { id: 'f-trash', name: 't.txt', mimeType: 'text/plain', parents: ['root'], trashed: true },
            },
            { changeType: 'file', fileId: 'f-perm', removed: true },
            { changeType: 'file', fileId: 'sub', removed: true },
        ]);

        const noRemovedRes = await drive.handle(`https://www.googleapis.com/drive/v3/changes?pageToken=${startPageToken}&includeRemoved=false&fields=${encodeURIComponent(fields)}`, { headers: authHeaders });
        expect((await noRemovedRes.json<any>()).changes.map((c: any) => c.fileId)).toEqual(['f-trash']);

        const badFields = await drive.handle(`https://www.googleapis.com/drive/v3/changes?pageToken=${startPageToken}&fields=${encodeURIComponent('changes(file(nonExistent))')}`, { headers: authHeaders });
        expect(badFields.status).toBe(400);
    });
});

describe('offline network isolation guard', () => {
    it('blocks and records unmocked outbound fetch across setFetchMock and vi.unstubAllGlobals', async () => {
        await expect(fetch('https://example.invalid/unit-unmocked')).rejects.toThrow(/Blocked unmocked outbound fetch/);

        setFetchMock(async () => new Response('mocked-ok', { status: 200 }));
        expect(await (await fetch('https://example.invalid/unit-mocked')).text()).toBe('mocked-ok');
        clearFetchMock();

        vi.stubGlobal('fetch', async () => new Response('ok'));
        vi.unstubAllGlobals();

        await expect(fetch('https://example.invalid/unit-after-unstub')).rejects.toThrow(/Blocked unmocked outbound fetch/);
        expect(drainUnmockedFetches()).toEqual([
            'GET https://example.invalid/unit-unmocked',
            'GET https://example.invalid/unit-after-unstub',
        ]);
    });
});
