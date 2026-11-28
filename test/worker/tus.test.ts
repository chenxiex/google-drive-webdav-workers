import { createHash } from 'node:crypto';
import { env, abortAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FOLDER, installDriveMock } from '../support/client';
import { type MockDrive } from '../support/mock-drive';
import { setFetchMock } from '../support/network';
import { request, useMockDrive } from '../support/worker';

const ALIGN = 256 * 1024;
const TEN_MIB = 10 * 1024 * 1024;
const TUS = { 'Tus-Resumable': '1.0.0' };
let drive: MockDrive;

function send(url: string, init: RequestInit = {}, omitVersion = false): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!omitVersion && !headers.has('Tus-Resumable')) headers.set('Tus-Resumable', TUS['Tus-Resumable']);
    return request(url, { ...init, headers });
}

const create = async (
    length: number,
    name = crypto.randomUUID() + '.bin',
    metadata = '',
    options: { path?: string; headers?: Record<string, string>; body?: Uint8Array } = {},
) => {
    const response = await send(options.path ?? '/webdav/', {
        method: 'POST',
        headers: {
            'Upload-Length': String(length),
            'Upload-Metadata': 'filename ' + btoa(name) + metadata,
            ...(options.body?.byteLength ? { 'Content-Type': 'application/offset+octet-stream' } : {}),
            ...options.headers,
        },
        body: options.body,
    });
    expect(response.status, response.status === 201 ? '' : await response.text()).toBe(201);
    return { url: response.headers.get('Location')!, name, response };
};

const patch = (url: string, offset: number, body: Uint8Array, headers: Record<string, string> = {}) => send(url, {
    method: 'PATCH',
    body,
    headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset), ...headers },
});

const head = (url: string, omitVersion = false) => send(url, { method: 'HEAD' }, omitVersion);

const bytes = (size: number) => {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) out[i] = (i * 73) % 251;
    return out;
};

const digestHex = (alg: 'md5' | 'sha1' | 'sha256', data: Uint8Array) => createHash(alg).update(data).digest('hex');
const digestB64 = (alg: 'md5' | 'sha1' | 'sha256', data: Uint8Array) => createHash(alg).update(data).digest('base64');

const expectBytesEqual = (actual: Uint8Array | undefined, expected: Uint8Array) => {
    expect(actual).toBeInstanceOf(Uint8Array);
    expect(actual!.length).toBe(expected.length);
    expect(digestHex('sha256', actual!)).toBe(digestHex('sha256', expected));
};

async function expectDoCleared(sessionUrl: string): Promise<void> {
    const sessionId = sessionUrl.split('/').pop()!;
    const namespace = (env as Env).TUS_UPLOADS;
    const stub = namespace.get(namespace.idFromName(sessionId));
    await runInDurableObject(stub, async (_instance, state) => {
        expect(await state.storage.get('upload')).toBeUndefined();
        expect(await state.storage.getAlarm()).toBeNull();
    });
}

const fixture = useMockDrive();
beforeEach(() => { drive = fixture.drive; });

describe('durable TUS (5A + 13B + 14A)', () => {
    it('persists <256 KiB PATCH tails across eviction, returns completion headers, and cleans up DO state immediately (13B)', async () => {
        const data = bytes(1024 * 1024 + 321);
        const { url, name } = await create(data.length);
        const getStub = () => (env as Env).TUS_UPLOADS.get((env as Env).TUS_UPLOADS.idFromName(url.split('/').pop()!));

        let offset = 0;
        const sizes = [13, 262144 + 7, data.length - 262164];
        let finalResponse!: Response;
        for (const [index, size] of sizes.entries()) {
            const response = await patch(url, offset, data.slice(offset, offset + size));
            offset += size;
            expect(response.status).toBe(204);
            expect(response.headers.get('Upload-Offset')).toBe(String(offset));
            expect([...response.headers.keys()].some(key => key.startsWith('x-tus-'))).toBe(false);
            if (index < sizes.length - 1) {
                await runInDurableObject(getStub(), async (_instance, state) => {
                    const record = await state.storage.get<any>('upload');
                    expect(record.tail.byteLength).toBeLessThan(ALIGN);
                    expect(record.inflight).toBe(false);
                    expect(record.pending).toBeUndefined();
                });
                await abortAllDurableObjects();
                expect((await head(url)).headers.get('Upload-Offset')).toBe(String(offset));
            } else {
                finalResponse = response;
            }
        }

        const stored = drive.files.find(file => file.name === name)!;
        expectBytesEqual(stored.content, data);
        expect(finalResponse.headers.get('ETag')).toBe(`"${stored.id}-${stored.headRevisionId}"`);
        expect(finalResponse.headers.get('OC-FileID')).toBe(stored.id);
        expect(finalResponse.headers.get('OC-Perm')).toBe('RDNVW');

        await expectDoCleared(url);
        const afterHead = await head(url);
        expect(afterHead.status).toBe(404);
        expect(afterHead.headers.has('Upload-Offset')).toBe(false);
        expect((await patch(url, 0, data)).status).toBe(404);
    });

    it('serializes conflicting PATCH requests without accepting either twice', async () => {
        const { url, name } = await create(6);
        const responses = await Promise.all([patch(url, 0, new Uint8Array([1, 2, 3])), patch(url, 0, new Uint8Array([4, 5, 6]))]);
        expect(responses.map(response => response.status).sort()).toEqual([204, 409]);
        expect((await head(url)).headers.get('Upload-Offset')).toBe('3');
        expect((await patch(url, 3, new Uint8Array([7, 8, 9]))).status).toBe(204);
        expect(drive.files.find(file => file.name === name)?.content?.length).toBe(6);
    });

    it.each(['intermediate', 'final', 'final-308'] as const)('recovers an ambiguous Drive response (%s) after eviction without resending confirmed bytes', async failure => {
        const final = failure !== 'intermediate';
        const data = bytes(failure === 'intermediate' ? TEN_MIB + 17 : 1024 * 1024 + 17);
        const { url, name } = await create(data.length);
        const original = drive.handle.bind(drive);
        let dropped = false;
        let probes = 0;
        setFetchMock(async (input, init) => {
            const range = new Headers(init?.headers).get('Content-Range');
            const response = await original(input, init);
            if (range?.startsWith('bytes */')) probes++;
            if (!dropped && range?.startsWith('bytes ') && !range.startsWith('bytes */') && ((response.status === 200 || response.status === 201) === final)) {
                dropped = true;
                if (failure === 'final-308') return new Response(null, { status: 308, headers: { Range: `bytes=0-${data.length - 1}` } });
                throw new TypeError('Injected lost response after Drive accepted bytes');
            }
            return response;
        });

        expect((await patch(url, 0, data)).status).toBe(failure === 'final-308' ? 502 : 503);
        expect(dropped).toBe(true);
        await abortAllDurableObjects();

        const recovered = await head(url);
        expect(recovered.status).toBe(200);
        expect(probes).toBe(1);
        const offset = Number(recovered.headers.get('Upload-Offset'));
        expect(offset).toBe(final ? data.length : TEN_MIB);
        if (final) {
            expect(recovered.headers.get('OC-FileID')).toBeTruthy();
            expect(recovered.headers.get('ETag')).toBeTruthy();
            expect((await head(url)).status).toBe(404);
        } else {
            expect((await patch(url, offset, data.slice(offset))).status).toBe(204);
        }
        expectBytesEqual(drive.files.find(file => file.name === name)?.content, data);
    });

    it('keeps <256 KiB tail durable when Drive fails before accepting and preserves expiry 410', async () => {
        const data = bytes(262244); // 100-byte tail + 262,144-byte remaining
        const { url, name } = await create(data.length);
        expect((await patch(url, 0, data.slice(0, 100))).status).toBe(204);

        const original = drive.handle.bind(drive);
        setFetchMock(async (input, init) => {
            if (new Headers(init?.headers).has('Content-Range')) return new Response(null, { status: 503 });
            return original(input, init);
        });
        expect((await patch(url, 100, data.slice(100))).status).toBe(503);
        await abortAllDurableObjects();

        installDriveMock(drive);
        const recovered = await head(url);
        expect(recovered.status).toBe(200);
        expect(recovered.headers.get('Upload-Offset')).toBe('100');
        expect((await patch(url, 100, data.slice(100))).status).toBe(204);
        expectBytesEqual(drive.files.find(file => file.name === name)?.content, data);

        const next = await create(262144);
        setFetchMock(async () => new Response(null, { status: 404 }));
        expect((await patch(next.url, 0, data.slice(0, 262144))).status).toBe(410);
        expect((await head(next.url)).status).toBe(410);
    });

    it('continues flushing aligned suffix within a request when Drive accepts only a prefix', async () => {
        const data = bytes(1024 * 1024 + 9);
        const { url, name } = await create(data.length);
        const original = drive.handle.bind(drive);
        const ranges: string[] = [];
        setFetchMock(async (input, init) => {
            const headers = new Headers(init?.headers);
            const range = headers.get('Content-Range');
            if (range && !range.startsWith('bytes */')) {
                ranges.push(range);
                if (ranges.length === 1) {
                    headers.set('Content-Range', `bytes 0-262143/${data.length}`);
                    headers.set('Content-Length', '262144');
                    return original(input, { ...init, headers, body: data.slice(0, 262144) });
                }
            }
            return original(input, init);
        });
        const response = await patch(url, 0, data);
        expect(response.status).toBe(204);
        expect(response.headers.get('Upload-Offset')).toBe(String(data.length));
        expect(ranges).toEqual([`bytes 0-${data.length - 1}/${data.length}`, `bytes 262144-${data.length - 1}/${data.length}`]);
        expectBytesEqual(drive.files.find(file => file.name === name)?.content, data);
    });

    it('handles 0-byte creation and overwrite directly without creating a DO', async () => {
        const mtime = 1700000000;
        const emptySha1 = digestHex('sha1', new Uint8Array(0));
        const { url, name, response } = await create(0, undefined, ',mtime ' + btoa(String(mtime)), {
            headers: { 'OC-Checksum': 'SHA1:' + emptySha1 },
        });
        expect(response.headers.get('Upload-Offset')).toBe('0');
        const created = drive.files.find(file => file.name === name)!;
        expect(Number(created.size)).toBe(0);
        expect(created.modifiedTime).toBe(new Date(mtime * 1000).toISOString());
        expect(response.headers.get('ETag')).toBe(`"${created.id}-${created.headRevisionId}"`);
        expect(response.headers.get('OC-FileID')).toBe(created.id);
        expect(response.headers.get('OC-Perm')).toBe('RDNVW');
        await expectDoCleared(url);
        expect((await head(url)).status).toBe(404);

        const initial = await create(3, undefined, ',mtime ' + btoa(String(mtime + 50)));
        expect((await patch(initial.url, 0, new Uint8Array([1, 2, 3]))).status).toBe(204);
        expect(drive.findById(created.id)).toBeDefined();
        expect(drive.files.find(file => file.name === initial.name)?.modifiedTime).toBe(new Date((mtime + 50) * 1000).toISOString());

        const emptyOverwrite = await create(0, initial.name, ',mtime ' + btoa(String(mtime + 100)));
        expect(emptyOverwrite.response.headers.get('Upload-Offset')).toBe('0');
        expect(drive.files.find(file => file.name === initial.name)?.content).toEqual(new Uint8Array());
        expect(drive.files.find(file => file.name === initial.name)?.modifiedTime).toBe(new Date((mtime + 100) * 1000).toISOString());
        expect((await head(emptyOverwrite.url)).status).toBe(404);
    });

    it('validates creation headers/metadata (14A) and advertises implemented TUS extensions', async () => {
        const options = await send('/webdav/', { method: 'OPTIONS' });
        expect(options.headers.get('Tus-Resumable')).toBe('1.0.0');
        expect(options.headers.get('Tus-Version')).toBe('1.0.0');
        expect(options.headers.get('Tus-Extension')).toBe('creation,creation-with-upload,checksum');
        expect(options.headers.get('Tus-Checksum-Algorithm')).toBe('sha1,md5,sha256');

        for (const headers of [
            { 'Upload-Length': '-1' },
            { 'Upload-Length': '12oops' },
            { 'Upload-Offset': '1', 'Upload-Length': '2' },
            { 'Upload-Length': '2', 'Upload-Metadata': 'filename ' + btoa('../escape') },
            { 'Upload-Length': '2', 'Upload-Metadata': 'filename ###' },
            { 'Upload-Length': '2', 'Upload-Metadata': 'filename ' + btoa('a.bin') + ',checksum ' + btoa('SHA1 ' + 'a'.repeat(40)), 'OC-Checksum': 'SHA1:' + 'b'.repeat(40) },
            { 'Upload-Length': '2', 'Upload-Defer-Length': '1' },
        ] as Record<string, string>[]) {
            expect((await send('/webdav/', { method: 'POST', headers })).status).toBe(400);
        }
        expect((await send('/webdav/dir%2ffile.bin', { method: 'POST', headers: { 'Upload-Length': '1' } })).status).toBe(400);
        expect((await send('/webdav/', { method: 'POST', headers: { 'Tus-Resumable': '0.2', 'Upload-Length': '1' } })).status).toBe(412);
        expect(drive.files).toHaveLength(0);

        const cyberduck = await send('/webdav/', {
            method: 'POST',
            headers: {
                'Upload-Length': '0',
                'Upload-Metadata': `filename ${btoa('duck.bin')}, filetype application/octet-stream, opaque /w==,`,
            },
        });
        expect(cyberduck.status).toBe(201);
        expect(drive.files.find(f => f.name === 'duck.bin')?.mimeType).toBe('application/octet-stream');

        const badMime = await send('/webdav/', {
            method: 'POST',
            headers: {
                'Upload-Length': '0',
                'Upload-Metadata': `filename ${btoa('fallback.bin')}, filetype ${btoa(String.fromCharCode(...new TextEncoder().encode('text/☃')))}`,
            },
        });
        expect(badMime.status).toBe(201);
        expect(drive.files.find(f => f.name === 'fallback.bin')?.mimeType).toBe('application/octet-stream');
    });

    it.each([
        ['/webdav/missing/', { 'Upload-Length': '5', 'Upload-Metadata': 'filename ' + btoa('a.bin') }],
        ['/webdav/missing/', { 'Upload-Length': '0', 'Upload-Metadata': 'filename ' + btoa('empty.bin') }],
        ['/webdav/missing/a.bin', { 'Upload-Length': '5' }],
        ['/webdav/existing.txt/', { 'Upload-Length': '5', 'Upload-Metadata': 'filename ' + btoa('a.bin') }],
        ['/webdav/existing.txt/a.bin', { 'Upload-Length': '5' }],
    ] as const)('rejects creation on %s with 409 when parent collection is missing or not a folder', async (path, headers) => {
        drive.add({ id: 'file-existing', name: 'existing.txt', mimeType: 'text/plain', size: 1, parents: ['root'] });
        const methods: string[] = [];
        const original = drive.handle.bind(drive);
        vi.spyOn(drive, 'handle').mockImplementation((input, init) => {
            const req = new Request(input, init);
            if (!new URL(req.url).pathname.startsWith('/oauth2/')) {
                methods.push(req.method);
            }
            return original(input, init);
        });
        const response = await send(path, { method: 'POST', headers });
        expect(response.status).toBe(409);
        expect(response.headers.get('Tus-Resumable')).toBe('1.0.0');
        expect(methods.every(method => method === 'GET')).toBe(true);
        expect(drive.files).toHaveLength(1);
    });

    it('rejects invalid PATCH without consuming bytes, hides sessions from other owners, and expires receipts', async () => {
        const { url } = await create(3);
        expect((await patch(url, 0, bytes(1), { 'Content-Type': 'text/plain' })).status).toBe(415);
        expect((await patch(url, 0, bytes(1), { 'Upload-Offset': '0oops' })).status).toBe(400);
        expect((await patch(url, 0, bytes(4))).status).toBe(413);
        expect((await head(url)).headers.get('Upload-Offset')).toBe('0');
        const namespace = (env as Env).TUS_UPLOADS;
        const stub = namespace.get(namespace.idFromName(url.split('/').pop()!));
        expect((await stub.fetch('https://tus.internal/upload', { method: 'HEAD', headers: { ...TUS, 'x-tus-owner': 'another' } })).status).toBe(404);
        await runInDurableObject(stub, async (_instance, state) => {
            const record = await state.storage.get<any>('upload');
            record.expires = Date.now() - 1;
            await state.storage.put('upload', record);
        });
        expect((await head(url)).status).toBe(404);
        drive.add({ id: 'nested-folder', name: 'folder', mimeType: FOLDER, parents: ['root'] });
        drive.add({ id: 'nested-tus-folder', name: 'tus_uploads', mimeType: FOLDER, parents: ['nested-folder'] });
        drive.add({ id: 'nested-file', name: 'file', mimeType: 'text/plain', parents: ['nested-tus-folder'], size: 7 });
        const ordinary = await head('/webdav/folder/tus_uploads/file');
        expect(ordinary.status).toBe(200);
        expect(ordinary.headers.get('Content-Length')).toBe('7');
        expect(ordinary.headers.has('Upload-Offset')).toBe(false);
    });
});

describe('OC-06 client chunking, checksums, paths, and preconditions', () => {
    it.each([
        {
            label: '10,000,000-byte creation-with-upload POST + PATCHes (38,528 B remainder)',
            chunks: [10_000_000, 10_000_000, 6_214_403],
            postBody: true,
            perChunkSha1: false,
            evictBetween: false,
            useSubdirNoSlash: false,
        },
        {
            label: 'Android 10,240,000-byte chunks (16,384 B remainder) with Upload-Checksum',
            chunks: [TEN_MIB, 10_240_000, 5_488_643],
            postBody: true,
            perChunkSha1: true,
            evictBetween: false,
            useSubdirNoSlash: true,
        },
        {
            label: '10 MiB (10,485,760 B) aligned chunks (1 Drive PUT per PATCH)',
            chunks: [TEN_MIB, TEN_MIB, 5_242_883],
            postBody: false,
            perChunkSha1: false,
            evictBetween: false,
            useSubdirNoSlash: false,
        },
        {
            label: 'irregular varying resume chunks with 12 MiB chunk (> 10 MiB cap) and DO eviction',
            chunks: [777, 12 * 1024 * 1024, 262144 + 19, 13_951_463 - 262144 - 19],
            postBody: true,
            perChunkSha1: true,
            evictBetween: true,
            useSubdirNoSlash: false,
        },
    ])('handles $label with 256 KiB Drive alignment and exact SHA-256', async ({
        chunks, postBody, perChunkSha1, evictBetween, useSubdirNoSlash,
    }) => {
        const total = chunks.reduce((a, b) => a + b, 0);
        const payload = bytes(total);
        const driveChunks: Array<{ length: number; range: string; status: number }> = [];
        const original = drive.handle.bind(drive);
        setFetchMock(async (input, init) => {
            const headers = new Headers(init?.headers);
            const range = headers.get('Content-Range');
            const res = await original(input, init);
            if (range && !range.startsWith('bytes */')) {
                driveChunks.push({ length: Number(headers.get('Content-Length')), range, status: res.status });
            }
            return res;
        });

        if (useSubdirNoSlash) {
            drive.add({ id: 'android-dir', name: 'Camera', mimeType: FOLDER, parents: ['root'] });
        }
        const postPath = useSubdirNoSlash ? '/webdav/Camera' : '/webdav/';
        const fileName = 'payload-' + crypto.randomUUID() + '.bin';
        const firstSize = postBody ? chunks[0] : 0;
        const firstSlice = payload.subarray(0, firstSize);
        const extraMeta = `,mimetype ${btoa('application/octet-stream')},mtime ${btoa('1700000000.5')},checksum ${btoa('SHA1 ' + digestHex('sha1', payload))}`;

        const { url, response: postRes } = await create(total, fileName, extraMeta, {
            path: postPath,
            headers: {
                ...(firstSize > 0 && perChunkSha1 ? { 'Upload-Checksum': 'sha1 ' + digestB64('sha1', firstSlice) } : {}),
            },
            body: firstSize > 0 ? firstSlice : undefined,
        });
        expect(postRes.headers.get('Upload-Offset')).toBe(String(firstSize));

        let offset = firstSize;
        let lastRes = postRes;
        for (const size of chunks.slice(postBody ? 1 : 0)) {
            if (evictBetween) {
                await abortAllDurableObjects();
                const resumed = await head(url, true);
                expect(resumed.status).toBe(200);
                offset = Number(resumed.headers.get('Upload-Offset'));
            }
            const slice = payload.subarray(offset, offset + size);
            lastRes = await patch(url, offset, slice, perChunkSha1
                ? { 'Upload-Checksum': 'sha1 ' + digestB64('sha1', slice) }
                : {});
            expect(lastRes.status).toBe(204);
            offset += size;
            expect(lastRes.headers.get('Upload-Offset')).toBe(String(offset));
        }

        expect(offset).toBe(total);
        const nonFinalDrivePuts = driveChunks.filter(entry => entry.status === 308);
        expect(nonFinalDrivePuts.length).toBeGreaterThan(0);
        for (const entry of nonFinalDrivePuts) {
            expect(entry.length).toBeLessThanOrEqual(TEN_MIB);
            expect(entry.length).toBeGreaterThanOrEqual(ALIGN);
            expect(entry.length % ALIGN).toBe(0);
        }
        if (!postBody && chunks[0] === TEN_MIB && chunks[1] === TEN_MIB) {
            expect(driveChunks).toHaveLength(3);
        }

        const parentId = useSubdirNoSlash ? 'android-dir' : 'root';
        const stored = drive.children(parentId).find(f => f.name === fileName)!;
        expectBytesEqual(stored.content, payload);
        expect(stored.modifiedTime).toBe('2023-11-14T22:13:20.500Z');
        expect(lastRes.headers.get('ETag')).toBe(`"${stored.id}-${stored.headRevisionId}"`);
        expect(lastRes.headers.get('OC-FileID')).toBe(stored.id);
        expect(lastRes.headers.get('OC-Perm')).toBe('RDNVW');
        await expectDoCleared(url);
        expect((await head(url)).status).toBe(404);
    });

    it('completes single-shot creation-with-upload directly without creating a DO and rejects >16 MiB chunks with 413', async () => {
        const data = bytes(TEN_MIB + 500);
        const name = 'single-shot.bin';
        const { url, response } = await create(data.length, name, `,checksum ${btoa('SHA256 ' + digestHex('sha256', data))}`, {
            headers: { 'Upload-Checksum': 'sha1 ' + digestB64('sha1', data) },
            body: data,
        });
        expect(response.headers.get('Upload-Offset')).toBe(String(data.length));
        const stored = drive.files.find(f => f.name === name)!;
        expectBytesEqual(stored.content, data);
        expect(response.headers.get('ETag')).toBe(`"${stored.id}-${stored.headRevisionId}"`);
        expect(response.headers.get('OC-FileID')).toBe(stored.id);
        expect(response.headers.get('OC-Perm')).toBe('RDNVW');
        await expectDoCleared(url);
        expect((await head(url)).status).toBe(404);

        const oversized = await send('/webdav/', {
            method: 'POST',
            headers: {
                'Upload-Length': String(20 * 1024 * 1024),
                'Upload-Metadata': 'filename ' + btoa('too-big.bin'),
                'Content-Type': 'application/offset+octet-stream',
                'Content-Length': String(16 * 1024 * 1024 + 1),
            },
            body: new Uint8Array(1),
        });
        expect(oversized.status).toBe(413);
    });

    it('verifies MD5/SHA1/SHA256 per-chunk Upload-Checksum (Base64 and hex) and rejects mismatches with 460', async () => {
        const chunk1 = new TextEncoder().encode('alpha-chunk-');
        const chunk2 = new TextEncoder().encode('beta-chunk-');
        const chunk3 = new TextEncoder().encode('gamma-chunk');
        const all = new TextEncoder().encode('alpha-chunk-beta-chunk-gamma-chunk');

        // Mismatched Upload-Checksum on creation-with-upload POST fails with 460 without touching Drive.
        const badPost = await send('/webdav/', {
            method: 'POST',
            headers: {
                'Upload-Length': String(all.length),
                'Upload-Metadata': 'filename ' + btoa('bad-post.txt'),
                'Content-Type': 'application/offset+octet-stream',
                'Upload-Checksum': 'sha1 AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            },
            body: chunk1,
        });
        expect(badPost.status).toBe(460);
        expect(drive.files).toHaveLength(0);

        const { url, name } = await create(all.length, 'multi-alg.txt', '', {
            headers: { 'Upload-Checksum': 'md5 ' + digestHex('md5', chunk1) },
            body: chunk1,
        });
        // Mismatched PATCH leaves offset untouched.
        expect((await patch(url, chunk1.length, chunk2, { 'Upload-Checksum': 'sha256 ' + digestB64('sha256', chunk1) })).status).toBe(460);
        expect((await head(url)).headers.get('Upload-Offset')).toBe(String(chunk1.length));

        expect((await patch(url, chunk1.length, chunk2, { 'Upload-Checksum': 'md5 ' + digestB64('md5', chunk2) })).status).toBe(204);
        expect((await patch(url, chunk1.length + chunk2.length, chunk3, { 'Upload-Checksum': 'sha256 ' + digestB64('sha256', chunk3) })).status).toBe(204);
        expectBytesEqual(drive.files.find(f => f.name === name)?.content, all);
    });

    it('enforces whole-file checksums (0-byte, single-shot, DO) and cleans up failed new files vs overwrites', async () => {
        const badZero = await send('/webdav/', {
            method: 'POST',
            headers: {
                'Upload-Length': '0',
                'Upload-Metadata': 'filename ' + btoa('bad-zero.bin') + ',checksum ' + btoa('SHA1 ' + '0'.repeat(40)),
            },
        });
        expect(badZero.status).toBe(460);
        expect(drive.files).toHaveLength(0);

        const badSingleShot = await send('/webdav/', {
            method: 'POST',
            headers: {
                'Upload-Length': '5',
                'Upload-Metadata': 'filename ' + btoa('bad-single.bin'),
                'OC-Checksum': 'SHA1:' + '0'.repeat(40),
                'Content-Type': 'application/offset+octet-stream',
            },
            body: 'hello',
        });
        expect(badSingleShot.status).toBe(460);
        expect(drive.children('root').some(f => f.name === 'bad-single.bin' && !f.trashed)).toBe(false);

        const { url: badDoUrl } = await create(6, 'bad-do.bin', '', {
            headers: { 'OC-Checksum': 'SHA256:' + 'f'.repeat(64) },
        });
        expect((await patch(badDoUrl, 0, new Uint8Array([1, 2, 3]))).status).toBe(204);
        expect((await patch(badDoUrl, 3, new Uint8Array([4, 5, 6]))).status).toBe(460);
        expect(drive.children('root').some(f => f.name === 'bad-do.bin' && !f.trashed)).toBe(false);
        await expectDoCleared(badDoUrl);
        expect((await head(badDoUrl)).status).toBe(404);

        // Overwrite checksum mismatch preserves the file in Drive (recoverable via Revisions) and clears DO.
        drive.add({ id: 'keep-me', name: 'keep.bin', mimeType: 'application/octet-stream', size: 3, content: new Uint8Array([9, 9, 9]), parents: ['root'] });
        const { url: overwriteUrl } = await create(4, 'keep.bin', ',checksum ' + btoa('SHA1 ' + '1'.repeat(40)));
        expect((await patch(overwriteUrl, 0, new Uint8Array([1, 2, 3, 4]))).status).toBe(460);
        expect(drive.findById('keep-me')?.trashed).not.toBe(true);
        await expectDoCleared(overwriteUrl);
    });

    it('resolves Desktop subpaths, reconciles X-OC-Mtime, tolerates omitted HEAD version, and enforces If-Match 412', async () => {
        drive.add({ id: 'sub-dir', name: 'sub', mimeType: FOLDER, parents: ['root'] });
        const payload = new TextEncoder().encode('nested content');
        const { response } = await create(payload.length, '/sub/nested.txt', '', {
            headers: { 'X-OC-Mtime': '1700000001' },
            body: payload,
        });
        expect(response.status).toBe(201);
        const nested = drive.children('sub-dir').find(f => f.name === 'nested.txt')!;
        expectBytesEqual(nested.content, payload);
        expect(nested.modifiedTime).toBe('2023-11-14T22:13:21.000Z');

        const liveEtag = `"${nested.id}-${nested.headRevisionId}"`;
        const conflict = await send('/webdav/', {
            method: 'POST',
            headers: {
                'Upload-Length': '2',
                'Upload-Metadata': 'filename ' + btoa('sub/nested.txt'),
                'If-Match': '"wrong-etag"',
            },
        });
        expect(conflict.status).toBe(412);
        expectBytesEqual(drive.findById(nested.id)?.content, payload);

        const { url } = await create(4, 'sub/nested.txt', '', {
            headers: { 'If-Match': liveEtag },
        });
        expect((await head(url, true)).status).toBe(200);
        expect((await send(url, { method: 'HEAD', headers: { 'Tus-Resumable': '0.2' } })).status).toBe(412);
        expect((await patch(url, 0, new TextEncoder().encode('new!'))).status).toBe(204);
        expect(new TextDecoder().decode(drive.findById(nested.id)?.content)).toBe('new!');
    });
});
