import { DOMParser } from '@xmldom/xmldom';
import { SELF, abortAllDurableObjects, createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { SYNC_POLL_INTERVAL_MS } from '../../src/sync/index-do';
import { AUTH, FOLDER, ORIGIN, installDriveMock } from '../support/client';
import { MockDrive } from '../support/mock-drive';

const DAV = 'DAV:';
let drive: MockDrive;

async function callWorker(path: string, init: RequestInit = {}, bindings: Env = env as Env): Promise<Response> {
    if (bindings === (env as Env)) {
        return SELF.fetch(ORIGIN + path, {
            ...init,
            headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) },
        });
    }
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(ORIGIN + path, {
        ...init,
        headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) },
    }), bindings, ctx);
    await waitOnExecutionContext(ctx);
    return res;
}

async function propfindTree(path: string, depth = '1', bindings: Env = env as Env): Promise<{ status: number; etags: Map<string, string>; names: string[] }> {
    const res = await callWorker(path, {
        method: 'PROPFIND',
        headers: { Depth: depth },
    }, bindings);
    const etags = new Map<string, string>();
    const names: string[] = [];
    if (res.status !== 207) return { status: res.status, etags, names };
    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
    const responses = Array.from(doc.getElementsByTagNameNS(DAV, 'response'));
    for (const node of responses) {
        const href = node.getElementsByTagNameNS(DAV, 'href')[0]?.textContent ?? '';
        const etag = node.getElementsByTagNameNS(DAV, 'getetag')[0]?.textContent ?? '';
        const displayName = node.getElementsByTagNameNS(DAV, 'displayname')[0]?.textContent ?? '';
        if (href) etags.set(href, etag);
        if (displayName) names.push(displayName);
    }
    return { status: res.status, etags, names };
}

async function getFolderEtag(path: string, bindings: Env = env as Env): Promise<string> {
    const { status, etags } = await propfindTree(path, '0', bindings);
    expect(status).toBe(207);
    const etag = etags.get(path);
    expect(etag).toBeTruthy();
    return etag!;
}

async function snapshotFolderEtags(bindings: Env = env as Env): Promise<Map<string, string>> {
    const rootTree = await propfindTree('/webdav/', '1', bindings);
    expect(rootTree.status).toBe(207);
    const aTree = await propfindTree('/webdav/a/', '1', bindings);
    expect(aTree.status).toBe(207);
    return new Map([...rootTree.etags, ...aTree.etags]);
}

async function getGraphRootEtag(bindings: Env = env as Env): Promise<string> {
    const res = await callWorker('/graph/v1.0/me/drives', {}, bindings);
    expect(res.status).toBe(200);
    const data = await res.json<{ value: Array<{ eTag: string; root: { eTag: string } }> }>();
    expect(data.value[0].eTag).toBe(data.value[0].root.eTag);
    return data.value[0].eTag;
}

function seedTree(targetDrive: MockDrive, rootParent = 'root'): void {
    targetDrive.add({ id: 'folder-a', name: 'a', mimeType: FOLDER, parents: [rootParent] });
    targetDrive.add({ id: 'folder-a-sub', name: 'sub', mimeType: FOLDER, parents: ['folder-a'] });
    targetDrive.add({ id: 'file-a1', name: 'f1.txt', mimeType: 'text/plain', size: 2, content: new Uint8Array([1, 2]), parents: ['folder-a-sub'] });
    targetDrive.add({ id: 'folder-b', name: 'b', mimeType: FOLDER, parents: [rootParent] });
    targetDrive.add({ id: 'file-b2', name: 'f2.txt', mimeType: 'text/plain', size: 2, content: new Uint8Array([3, 4]), parents: ['folder-b'] });
    targetDrive.add({ id: 'folder-c', name: 'c', mimeType: FOLDER, parents: [rootParent] });
    targetDrive.add({ id: 'file-c3', name: 'f3.txt', mimeType: 'text/plain', size: 2, content: new Uint8Array([5, 6]), parents: ['folder-c'] });
}

function parseGen(etag: string): { id: string; epoch: string; gen: number } {
    const match = /^"(.+)-([0-9a-f]{8})-(\d+)"$/.exec(etag);
    if (!match) throw new Error(`Unexpected folder ETag format: ${etag}`);
    return { id: match[1], epoch: match[2], gen: Number(match[3]) };
}

beforeEach(() => {
    drive = new MockDrive();
    seedTree(drive);
    installDriveMock(drive);
});

describe('SyncIndex hot root.eTag and 30s throttle', () => {
    it('shares consistent root.eTag across Graph and PROPFIND and throttles changes.list for 30s', async () => {
        let now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const spy = vi.spyOn(drive, 'handle');
        const changesCalls = () => spy.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/drive/v3/changes').length;

        const graph1 = await getGraphRootEtag();
        const dav1 = await getFolderEtag('/webdav/');
        expect(graph1).toBe(dav1);
        expect(parseGen(graph1).gen).toBe(1);
        expect(changesCalls()).toBe(0);

        drive.add({ id: 'ext-1', name: 'ext.txt', mimeType: 'text/plain', size: 3, content: new Uint8Array([7, 8, 9]), parents: ['folder-a'] });

        now += SYNC_POLL_INTERVAL_MS - 1;
        expect(await getGraphRootEtag()).toBe(graph1);
        expect(await getFolderEtag('/webdav/')).toBe(dav1);
        expect(changesCalls()).toBe(0);

        now += 1;
        const graph2 = await getGraphRootEtag();
        const dav2 = await getFolderEtag('/webdav/');
        expect(graph2).toBe(dav2);
        expect(parseGen(graph2).gen).toBeGreaterThan(1);
        expect(changesCalls()).toBe(1);
    });
});

interface LocalMutationCase {
    label: string;
    changed: string[];
    unchanged: string[];
    mutate: () => Promise<void>;
}

const LOCAL_MUTATION_CASES: LocalMutationCase[] = [
    {
        label: 'MKCOL',
        changed: ['/webdav/', '/webdav/a/', '/webdav/a/sub/'],
        unchanged: ['/webdav/b/', '/webdav/c/'],
        mutate: async () => {
            expect((await callWorker('/webdav/a/sub/created-dir', { method: 'MKCOL' })).status).toBe(201);
        },
    },
    {
        label: 'PUT create',
        changed: ['/webdav/', '/webdav/a/', '/webdav/a/sub/'],
        unchanged: ['/webdav/b/', '/webdav/c/'],
        mutate: async () => {
            expect((await callWorker('/webdav/a/sub/new.txt', { method: 'PUT', body: 'hi' })).status).toBe(201);
        },
    },
    {
        label: 'PUT overwrite',
        changed: ['/webdav/', '/webdav/a/', '/webdav/a/sub/'],
        unchanged: ['/webdav/b/', '/webdav/c/'],
        mutate: async () => {
            expect((await callWorker('/webdav/a/sub/f1.txt', { method: 'PUT', body: 'updated' })).status).toBe(204);
        },
    },
    {
        label: 'PROPPATCH',
        changed: ['/webdav/', '/webdav/a/', '/webdav/a/sub/'],
        unchanged: ['/webdav/b/', '/webdav/c/'],
        mutate: async () => {
            const res = await callWorker('/webdav/a/sub/f1.txt', {
                method: 'PROPPATCH',
                body: '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><X:tag>1</X:tag></D:prop></D:set></D:propertyupdate>',
            });
            expect(res.status).toBe(207);
        },
    },
    {
        label: 'DELETE',
        changed: ['/webdav/', '/webdav/a/', '/webdav/a/sub/'],
        unchanged: ['/webdav/b/', '/webdav/c/'],
        mutate: async () => {
            expect((await callWorker('/webdav/a/sub/f1.txt', { method: 'DELETE' })).status).toBe(204);
        },
    },
    {
        label: 'MOVE rename',
        changed: ['/webdav/', '/webdav/a/', '/webdav/a/sub/'],
        unchanged: ['/webdav/b/', '/webdav/c/'],
        mutate: async () => {
            expect((await callWorker('/webdav/a/sub/f1.txt', {
                method: 'MOVE',
                headers: { Destination: ORIGIN + '/webdav/a/sub/f1-renamed.txt' },
            })).status).toBe(201);
        },
    },
    {
        label: 'MOVE cross-parent',
        changed: ['/webdav/', '/webdav/a/', '/webdav/a/sub/', '/webdav/b/'],
        unchanged: ['/webdav/c/'],
        mutate: async () => {
            expect((await callWorker('/webdav/a/sub/f1.txt', {
                method: 'MOVE',
                headers: { Destination: ORIGIN + '/webdav/b/f1-moved.txt' },
            })).status).toBe(201);
        },
    },
    {
        label: 'COPY file',
        changed: ['/webdav/', '/webdav/a/', '/webdav/a/sub/'],
        unchanged: ['/webdav/b/', '/webdav/c/'],
        mutate: async () => {
            expect((await callWorker('/webdav/b/f2.txt', {
                method: 'COPY',
                headers: { Destination: ORIGIN + '/webdav/a/sub/f2-copy.txt' },
            })).status).toBe(201);
        },
    },
    {
        label: 'COPY folder Depth: 0',
        changed: ['/webdav/', '/webdav/a/'],
        unchanged: ['/webdav/a/sub/', '/webdav/b/', '/webdav/c/'],
        mutate: async () => {
            expect((await callWorker('/webdav/a/sub/', {
                method: 'COPY',
                headers: { Destination: ORIGIN + '/webdav/a/sub-shallow/', Depth: '0' },
            })).status).toBe(201);
        },
    },
    {
        label: 'COPY folder Depth: infinity',
        changed: ['/webdav/', '/webdav/a/'],
        unchanged: ['/webdav/a/sub/', '/webdav/b/', '/webdav/c/'],
        mutate: async () => {
            expect((await callWorker('/webdav/a/sub/', {
                method: 'COPY',
                headers: { Destination: ORIGIN + '/webdav/a/sub-deep/', Depth: 'infinity' },
            })).status).toBe(201);
        },
    },
    {
        label: 'TUS zero-byte',
        changed: ['/webdav/', '/webdav/a/', '/webdav/a/sub/'],
        unchanged: ['/webdav/b/', '/webdav/c/'],
        mutate: async () => {
            const res = await callWorker('/webdav/a/sub/', {
                method: 'POST',
                headers: {
                    'Tus-Resumable': '1.0.0',
                    'Upload-Length': '0',
                    'Upload-Metadata': 'filename ' + btoa('tus-empty.txt'),
                },
            });
            expect(res.status).toBe(201);
        },
    },
    {
        label: 'TUS multi-request',
        changed: ['/webdav/', '/webdav/a/', '/webdav/a/sub/'],
        unchanged: ['/webdav/b/', '/webdav/c/'],
        mutate: async () => {
            const createRes = await callWorker('/webdav/a/sub/', {
                method: 'POST',
                headers: {
                    'Tus-Resumable': '1.0.0',
                    'Upload-Length': '5',
                    'Upload-Metadata': 'filename ' + btoa('tus-data.txt'),
                },
            });
            expect(createRes.status).toBe(201);
            const loc = new URL(createRes.headers.get('Location')!).pathname;
            const patchRes = await callWorker(loc, {
                method: 'PATCH',
                headers: {
                    'Tus-Resumable': '1.0.0',
                    'Content-Type': 'application/offset+octet-stream',
                    'Upload-Offset': '0',
                },
                body: 'hello',
            });
            expect(patchRes.status).toBe(204);
        },
    },
];

describe('SyncIndex local mutations and selective bubbling', () => {
    it.each(LOCAL_MUTATION_CASES)('bubbles affected ancestors for $label without touching siblings', async ({ changed, unchanged, mutate }) => {
        const before = await snapshotFolderEtags();
        await mutate();
        const after = await snapshotFolderEtags();
        for (const path of changed) {
            expect(parseGen(after.get(path)!).gen).toBeGreaterThan(parseGen(before.get(path)!).gen);
        }
        for (const path of unchanged) {
            expect(after.get(path)).toBe(before.get(path));
        }
    });
});

describe('SyncIndex external Drive changes via changes.list', () => {
    it.each([
        'file-edit',
        'new-file',
        'new-folder',
        'move-inside',
        'trash',
        'permanent-delete',
        'revoke-subfolder',
    ] as const)('bubbles external change (%s) selectively after throttle window', async scenario => {
        let now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);

        const before = await snapshotFolderEtags();

        if (scenario === 'file-edit') {
            drive.replaceContent('file-a1', new Uint8Array([9, 9, 9]));
        } else if (scenario === 'new-file') {
            drive.add({ id: 'ext-file', name: 'ext.txt', mimeType: 'text/plain', size: 1, content: new Uint8Array([1]), parents: ['folder-a-sub'] });
        } else if (scenario === 'new-folder') {
            drive.add({ id: 'ext-dir', name: 'extdir', mimeType: FOLDER, parents: ['folder-a-sub'] });
        } else if (scenario === 'move-inside') {
            await drive.handle('https://www.googleapis.com/drive/v3/files/file-a1?addParents=folder-b&removeParents=folder-a-sub', {
                method: 'PATCH',
                headers: { Authorization: 'Bearer test-access-token', 'Content-Type': 'application/json' },
                body: '{}',
            });
        } else if (scenario === 'trash') {
            await drive.handle('https://www.googleapis.com/drive/v3/files/file-a1', {
                method: 'PATCH',
                headers: { Authorization: 'Bearer test-access-token', 'Content-Type': 'application/json' },
                body: JSON.stringify({ trashed: true }),
            });
        } else if (scenario === 'permanent-delete') {
            drive.remove('file-a1');
        } else if (scenario === 'revoke-subfolder') {
            drive.revokeAccess('folder-a-sub');
        }

        now += SYNC_POLL_INTERVAL_MS;
        const after = await snapshotFolderEtags();
        expect(parseGen(after.get('/webdav/')!).gen).toBeGreaterThan(parseGen(before.get('/webdav/')!).gen);
        expect(parseGen(after.get('/webdav/a/')!).gen).toBeGreaterThan(parseGen(before.get('/webdav/a/')!).gen);
        if (scenario === 'revoke-subfolder') {
            expect((await callWorker('/webdav/a/sub/', { method: 'PROPFIND', headers: { Depth: '0' } })).status).toBe(404);
        } else {
            expect(parseGen(after.get('/webdav/a/sub/')!).gen).toBeGreaterThan(parseGen(before.get('/webdav/a/sub/')!).gen);
        }
        if (scenario === 'move-inside') {
            expect(parseGen(after.get('/webdav/b/')!).gen).toBeGreaterThan(parseGen(before.get('/webdav/b/')!).gen);
        } else {
            expect(after.get('/webdav/b/')).toBe(before.get('/webdav/b/'));
        }
        expect(after.get('/webdav/c/')).toBe(before.get('/webdav/c/'));
    });

    it('handles populated folder move into and out of ROOT_ID and tracks moved-in descendants', async () => {
        let now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        drive.add({ id: 'space-root', name: 'Space', mimeType: FOLDER, parents: ['root'] });
        seedTree(drive, 'space-root');
        drive.add({ id: 'outside-dir', name: 'outside', mimeType: FOLDER, parents: ['root'] });
        drive.add({ id: 'outside-nested', name: 'nested', mimeType: FOLDER, parents: ['outside-dir'] });
        drive.add({ id: 'outside-leaf', name: 'deep.txt', mimeType: 'text/plain', size: 2, content: new Uint8Array([4, 5]), parents: ['outside-nested'] });

        const customEnv = { ...env, ROOT_ID: 'space-root' } as unknown as Env;

        const root1 = await getFolderEtag('/webdav/', customEnv);
        const a1 = await getFolderEtag('/webdav/a/', customEnv);
        const b1 = await getFolderEtag('/webdav/b/', customEnv);

        // Move populated folder INTO space-root.
        await drive.handle('https://www.googleapis.com/drive/v3/files/outside-dir?addParents=folder-a&removeParents=root', {
            method: 'PATCH',
            headers: { Authorization: 'Bearer test-access-token', 'Content-Type': 'application/json' },
            body: '{}',
        });
        now += SYNC_POLL_INTERVAL_MS;
        const root2 = await getFolderEtag('/webdav/', customEnv);
        const a2 = await getFolderEtag('/webdav/a/', customEnv);
        const outside2 = await getFolderEtag('/webdav/a/outside/', customEnv);
        const nested2 = await getFolderEtag('/webdav/a/outside/nested/', customEnv);
        expect(parseGen(root2).gen).toBeGreaterThan(parseGen(root1).gen);
        expect(parseGen(a2).gen).toBeGreaterThan(parseGen(a1).gen);
        expect(await getFolderEtag('/webdav/b/', customEnv)).toBe(b1);

        // Permanent deletion of a grandchild inside the newly moved-in folder must bubble cleanly.
        drive.remove('outside-leaf');
        now += SYNC_POLL_INTERVAL_MS;
        const root3 = await getFolderEtag('/webdav/', customEnv);
        expect(parseGen(root3).gen).toBeGreaterThan(parseGen(root2).gen);
        expect(parseGen(await getFolderEtag('/webdav/a/', customEnv)).gen).toBeGreaterThan(parseGen(a2).gen);
        expect(parseGen(await getFolderEtag('/webdav/a/outside/', customEnv)).gen).toBeGreaterThan(parseGen(outside2).gen);
        expect(parseGen(await getFolderEtag('/webdav/a/outside/nested/', customEnv)).gen).toBeGreaterThan(parseGen(nested2).gen);

        // Move folder OUT of space-root: bubbles old parents, then further external edits are ignored.
        await drive.handle('https://www.googleapis.com/drive/v3/files/outside-dir?addParents=root&removeParents=folder-a', {
            method: 'PATCH',
            headers: { Authorization: 'Bearer test-access-token', 'Content-Type': 'application/json' },
            body: '{}',
        });
        now += SYNC_POLL_INTERVAL_MS;
        const root4 = await getFolderEtag('/webdav/', customEnv);
        expect(parseGen(root4).gen).toBeGreaterThan(parseGen(root3).gen);

        drive.add({ id: 'after-exit', name: 'after.txt', mimeType: 'text/plain', size: 1, content: new Uint8Array([1]), parents: ['outside-nested'] });
        now += SYNC_POLL_INTERVAL_MS;
        expect(await getFolderEtag('/webdav/', customEnv)).toBe(root4);
    });

    it('handles out-of-order folder+child changes and multi-page changes.list pagination', async () => {
        let now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        await getFolderEtag('/webdav/');

        drive.add({ id: 'ooo-parent', name: 'ooo', mimeType: FOLDER, parents: ['folder-a'] });
        drive.add({ id: 'ooo-child', name: 'child', mimeType: FOLDER, parents: ['ooo-parent'] });
        drive.add({ id: 'ooo-file', name: 'leaf.txt', mimeType: 'text/plain', size: 1, content: new Uint8Array([7]), parents: ['ooo-child'] });

        const original = drive.handle.bind(drive);
        const changeCalls: string[] = [];
        vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
            const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : input.href);
            if (url.pathname === '/drive/v3/changes') {
                url.searchParams.set('pageSize', '1');
                changeCalls.push(url.searchParams.get('pageToken') ?? '');
                const res = await original(url.toString(), init);
                const payload = await res.json<any>();
                if (Array.isArray(payload.changes)) {
                    payload.changes = [...payload.changes].reverse();
                }
                return new Response(JSON.stringify(payload), res);
            }
            return original(input, init);
        });

        now += SYNC_POLL_INTERVAL_MS;
        const tree = await propfindTree('/webdav/a/ooo/child/');
        expect(tree.status).toBe(207);
        expect(tree.names).toContain('leaf.txt');
        expect(changeCalls.length).toBeGreaterThanOrEqual(3);
    });
});

describe('SyncIndex outside-ROOT_ID and hidden-item isolation', () => {
    it('ignores edits outside custom ROOT_ID and hidden Workspace items while advancing pageToken', async () => {
        let now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        drive.add({ id: 'space-folder', name: 'Space', mimeType: FOLDER, parents: ['root'] });
        seedTree(drive, 'space-folder');
        drive.add({ id: 'other-folder', name: 'Other', mimeType: FOLDER, parents: ['root'] });

        const customEnv = { ...env, ROOT_ID: 'space-folder' } as unknown as Env;

        const stub = (env as Env).SYNC_INDEX!.get((env as Env).SYNC_INDEX!.idFromName('sync:space-folder'));
        const getToken = () => runInDurableObject(stub, (_instance, state) =>
            state.storage.sql.exec<{ value: string }>("SELECT value FROM sync_meta WHERE key = 'page_token'").toArray()[0]?.value,
        );

        const root1 = await getGraphRootEtag(customEnv);
        const a1 = await getFolderEtag('/webdav/a/', customEnv);
        const token1 = await getToken();

        // External mutations outside space-folder + hidden Workspace docs/shortcuts inside space-folder.
        drive.add({ id: 'out-1', name: 'outside.txt', mimeType: 'text/plain', size: 3, content: new Uint8Array([1, 2, 3]), parents: ['other-folder'] });
        drive.add({ id: 'ws-doc', name: 'Plan', mimeType: 'application/vnd.google-apps.document', parents: ['space-folder'] });
        drive.add({ id: 'ws-short', name: 'Link', mimeType: 'application/vnd.google-apps.shortcut', parents: ['folder-a'] });

        now += SYNC_POLL_INTERVAL_MS;
        expect(await getGraphRootEtag(customEnv)).toBe(root1);
        expect(await getFolderEtag('/webdav/a/', customEnv)).toBe(a1);
        const token2 = await getToken();
        expect(Number(token2)).toBeGreaterThan(Number(token1));
    });
});

describe('SyncIndex recovery and error handling', () => {
    it.each(['invalid-token', '410-gone'] as const)('re-seeds with a new epoch when changes.list returns %s', async mode => {
        let now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const root1 = await getGraphRootEtag();
        const { epoch: epoch1 } = parseGen(root1);

        if (mode === 'invalid-token') {
            drive.invalidateChangeTokens();
        } else {
            const original = drive.handle.bind(drive);
            let sent410 = false;
            vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
                if (!sent410 && String(input).includes('/drive/v3/changes?')) {
                    sent410 = true;
                    return new Response(JSON.stringify({ error: { message: 'Change token expired' } }), { status: 410 });
                }
                return original(input, init);
            });
        }
        drive.add({ id: 'recovered-file', name: 'recovered.txt', mimeType: 'text/plain', size: 1, content: new Uint8Array([1]), parents: ['folder-a'] });

        now += SYNC_POLL_INTERVAL_MS;
        const root2 = await getGraphRootEtag();
        const { epoch: epoch2, gen: gen2 } = parseGen(root2);
        expect(epoch2).not.toBe(epoch1);
        expect(gen2).toBe(1);
        expect((await propfindTree('/webdav/a/')).names).toContain('recovered.txt');
    });

    it('re-seeds with a new epoch when DO storage is wiped and evicted', async () => {
        const root1 = await getGraphRootEtag();
        const { epoch: epoch1 } = parseGen(root1);

        const stub = (env as Env).SYNC_INDEX!.get((env as Env).SYNC_INDEX!.idFromName('sync:root'));
        await runInDurableObject(stub, async (_instance, state) => {
            await state.storage.deleteAll();
        });
        await abortAllDurableObjects();

        const root2 = await getGraphRootEtag();
        const { epoch: epoch2, gen: gen2 } = parseGen(root2);
        expect(epoch2).not.toBe(epoch1);
        expect(gen2).toBe(1);
    });

    it('preserves cursor on persistent 503 and catches up on subsequent poll', async () => {
        let now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const root1 = await getGraphRootEtag();
        drive.add({ id: 'queued-file', name: 'queued.txt', mimeType: 'text/plain', size: 1, content: new Uint8Array([2]), parents: ['folder-a'] });

        const original = drive.handle.bind(drive);
        let failChanges = true;
        vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
            if (failChanges && String(input).includes('/drive/v3/changes?')) {
                return new Response(JSON.stringify({ error: { message: 'Temporary error' } }), {
                    status: 503,
                    headers: { 'Retry-After': '0' },
                });
            }
            return original(input, init);
        });

        now += SYNC_POLL_INTERVAL_MS;
        const failedRes = await callWorker('/graph/v1.0/me/drives');
        expect(failedRes.status).toBe(503);

        failChanges = false;
        const root2 = await getGraphRootEtag();
        expect(parseGen(root2).gen).toBeGreaterThan(parseGen(root1).gen);
        expect((await propfindTree('/webdav/a/')).names).toContain('queued.txt');
    });

    it.each(['revoked', 'trashed'] as const)('surfaces 404 cleanly when custom ROOT_ID is %s externally', async mode => {
        let now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        drive.add({ id: 'space-lost', name: 'Space', mimeType: FOLDER, parents: ['root'] });
        const customEnv = { ...env, ROOT_ID: 'space-lost' } as unknown as Env;

        await getGraphRootEtag(customEnv);
        if (mode === 'revoked') {
            drive.revokeAccess('space-lost');
        } else {
            await drive.handle('https://www.googleapis.com/drive/v3/files/space-lost', {
                method: 'PATCH',
                headers: { Authorization: 'Bearer test-access-token', 'Content-Type': 'application/json' },
                body: JSON.stringify({ trashed: true }),
            });
        }

        now += SYNC_POLL_INTERVAL_MS;
        expect((await callWorker('/graph/v1.0/me/drives', {}, customEnv)).status).toBe(404);
    });
});

describe('SyncIndex cache-generation pinning and race prevention', () => {
    it('prevents an in-flight PROPFIND from pairing a newer folder ETag with an older listing', async () => {
        await getGraphRootEtag();
        const beforeAEtag = await getFolderEtag('/webdav/a/');

        let resolveListStarted!: () => void;
        const listStarted = new Promise<void>(resolve => { resolveListStarted = resolve; });
        let releaseList!: () => void;
        const listGate = new Promise<void>(resolve => { releaseList = resolve; });

        const original = drive.handle.bind(drive);
        let intercepted = false;
        vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
            const url = String(input);
            if (!intercepted && url.includes('/drive/v3/files?') && url.includes('orderBy=') && url.includes('folder-a')) {
                intercepted = true;
                const snapshot = await original(input, init);
                const snapshotBody = await snapshot.text();
                resolveListStarted();
                await listGate;
                return new Response(snapshotBody, { status: snapshot.status, headers: snapshot.headers });
            }
            return original(input, init);
        });

        const directEnv = { ...env } as Env;
        const inflightPropfind = propfindTree('/webdav/a/', '1', directEnv);
        await listStarted;

        // Complete a concurrent PUT inside /a/ while PROPFIND Depth: 1's files.list is suspended.
        const putRes = await callWorker('/webdav/a/concurrent.txt', { method: 'PUT', body: 'new-bytes' }, directEnv);
        expect(putRes.status).toBe(201);

        releaseList();
        const inflightResult = await inflightPropfind;
        expect(inflightResult.status).toBe(207);
        // The in-flight response keeps the starting ETag matching its pre-PUT listing.
        expect(inflightResult.etags.get('/webdav/a/')).toBe(beforeAEtag);
        expect(inflightResult.names).not.toContain('concurrent.txt');

        // Next PROPFIND sees the bumped generation, misses the old cached listing, and returns fresh state.
        const nextResult = await propfindTree('/webdav/a/', '1');
        expect(nextResult.status).toBe(207);
        expect(parseGen(nextResult.etags.get('/webdav/a/')!).gen).toBeGreaterThan(parseGen(beforeAEtag).gen);
        expect(nextResult.names).toContain('concurrent.txt');
    });

    it('invalidates cached listings on external changes as soon as the 30s poll runs', async () => {
        let now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const first = await propfindTree('/webdav/a/', '1');
        expect(first.names).not.toContain('late-ext.txt');

        drive.add({ id: 'late-ext', name: 'late-ext.txt', mimeType: 'text/plain', size: 4, content: new Uint8Array([1, 2, 3, 4]), parents: ['folder-a'] });

        // Within 30s throttle window, cached listing and ETag remain pinned.
        now += SYNC_POLL_INTERVAL_MS - 1;
        const cached = await propfindTree('/webdav/a/', '1');
        expect(cached.etags.get('/webdav/a/')).toBe(first.etags.get('/webdav/a/'));
        expect(cached.names).not.toContain('late-ext.txt');

        // After 30s, changes.list bumps folder-a's generation and bypasses the old cache entry.
        now += 1;
        const refreshed = await propfindTree('/webdav/a/', '1');
        expect(parseGen(refreshed.etags.get('/webdav/a/')!).gen).toBeGreaterThan(parseGen(first.etags.get('/webdav/a/')!).gen);
        expect(refreshed.names).toContain('late-ext.txt');
    });
});
