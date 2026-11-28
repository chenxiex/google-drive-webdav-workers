import { describe, expect, it } from 'vitest';
import { DriveClient } from '../../src/drive/client';
import { MemoryCache } from '../../src/drive/cache';
import { resolveConfig } from '../../src/config';
import { installDriveMock } from '../support/client';
import { driveBindings } from '../support/drive-bindings';
import { MockDrive } from '../support/mock-drive';

describe('Drive cache bounds', () => {
    it('evicts the oldest metadata at capacity and retains the newest entry', async () => {
        const cache = new MemoryCache();
        for (let i = 0; i <= 128; i++) {
            await cache.put(`/file-${i}/`, { id: `file-${i}` }, 'meta');
        }
        expect(await cache.get('/file-0/', 'meta')).toBeNull();
        expect(await cache.get('/file-1/', 'meta')).toEqual({ id: 'file-1' });
        expect(await cache.get('/file-128/', 'meta')).toEqual({ id: 'file-128' });
    });

    it('fetches an oversized listing again and returns newly added children', async () => {
        const drive = new MockDrive();
        installDriveMock(drive);
        const client = new DriveClient(resolveConfig(driveBindings));
        const longName = '界'.repeat(600);
        drive.addFiles(Array.from({ length: 40 }, (_, i) => ({
            id: `large-${i}`, name: longName + i, mimeType: 'text/plain', parents: ['root'],
        })));
        expect(await client.getObjects('root')).toHaveLength(40);
        drive.add({ id: 'new-child', name: 'fresh-child.txt', mimeType: 'text/plain', parents: ['root'] });
        expect((await client.getObjects('root')).map(file => file.id)).toContain('new-child');
    });
});
