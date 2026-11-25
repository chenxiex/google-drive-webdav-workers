import { SELF, env, abortAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH, FOLDER, ORIGIN, installDriveMock } from '../support/client';
import { MockDrive } from '../support/mock-drive';

let drive: MockDrive;
const TUS = { 'Tus-Resumable': '1.0.0' };
const send = (url: string, init: RequestInit = {}) => SELF.fetch(new URL(url, ORIGIN), {
    ...init, headers: { ...AUTH, ...TUS, ...Object.fromEntries(new Headers(init.headers)) },
});
const create = async (length: number, name = crypto.randomUUID() + '.bin', metadata = '') => {
    const response = await send('/dav/', { method: 'POST', headers: {
        'Upload-Length': String(length), 'Upload-Metadata': 'filename ' + btoa(name) + metadata,
    } });
    expect(response.status, response.status === 201 ? '' : await response.text()).toBe(201);
    return { url: response.headers.get('Location')!, name };
};
const patch = (url: string, offset: number, body: Uint8Array, headers: Record<string, string> = {}) => send(url, {
    method: 'PATCH', body, headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset), ...headers },
});
const head = (url: string) => send(url, { method: 'HEAD' });
const bytes = (size: number) => Uint8Array.from({ length: size }, (_, i) => i * 73 % 251);

beforeEach(() => { drive = new MockDrive(); installDriveMock(drive); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('durable TUS', () => {
    it('persists arbitrary PATCH tails across eviction and returns an exact completed receipt', async () => {
        const data = bytes(1024 * 1024 + 321);
        const { url, name } = await create(data.length);
        let offset = 0;
        for (const size of [13, 262144 + 7, data.length - 262164]) {
            const response = await patch(url, offset, data.slice(offset, offset + size));
            offset += size;
            expect(response.status).toBe(204);
            expect(response.headers.get('Upload-Offset')).toBe(String(offset));
            expect([...response.headers.keys()].some(key => key.startsWith('x-tus-'))).toBe(false);
            await abortAllDurableObjects();
            expect((await head(url)).headers.get('Upload-Offset')).toBe(String(offset));
        }
        expect(drive.files.find(file => file.name === name)?.content).toEqual(data);
        const completed = await head(url);
        expect(completed.status).toBe(200);
        expect(completed.headers.get('Upload-Length')).toBe(String(data.length));
        expect(completed.headers.get('Cache-Control')).toBe('no-store');
        expect((await patch(url, 0, data)).status).toBe(409);
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
        const data = bytes(1024 * 1024 + 17);
        const { url, name } = await create(data.length);
        const original = drive.handle.bind(drive);
        let dropped = false;
        let probes = 0;
        vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
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
        expect(offset).toBe(final ? data.length : 1024 * 1024);
        if (!final) expect((await patch(url, offset, data.slice(offset))).status).toBe(204);
        expect(drive.files.find(file => file.name === name)?.content).toEqual(data);
    });

    it('keeps pending bytes durable when Drive fails before accepting and does not turn expiry into offset zero', async () => {
        const data = bytes(262144);
        const { url, name } = await create(data.length);
        const original = drive.handle.bind(drive);
        vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            if (new Headers(init?.headers).has('Content-Range')) return new Response(null, { status: 503 });
            return original(input, init);
        });
        expect((await patch(url, 0, data)).status).toBe(503);
        await abortAllDurableObjects();
        installDriveMock(drive);
        expect((await head(url)).headers.get('Upload-Offset')).toBe(String(data.length));
        expect(drive.files.find(file => file.name === name)?.content).toEqual(data);
        const next = await create(data.length);
        vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
        expect((await patch(next.url, 0, data)).status).toBe(410);
        expect((await head(next.url)).status).toBe(410);
    });

    it('replays an aligned journal block when Drive accepts only a prefix', async () => {
        const data = bytes(1024 * 1024 + 9);
        const { url, name } = await create(data.length);
        const original = drive.handle.bind(drive);
        const ranges: string[] = [];
        vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const headers = new Headers(init?.headers);
            const range = headers.get('Content-Range');
            if (range && !range.startsWith('bytes */')) {
                ranges.push(range);
                if (ranges.length === 1) {
                    // Fault injection: deliver only the aligned prefix to the
                    // mock, so its returned Range reflects actual stored bytes.
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
        // Replay the original aligned block: Google safely ignores its
        // already-confirmed prefix, even if a future Range ends unaligned.
        expect(ranges[1]).toBe(`bytes 0-1048575/${data.length}`);
        expect(drive.files.find(file => file.name === name)?.content).toEqual(data);
    });

    it('handles empty creation and overwrite without a resumable zero-byte request', async () => {
        const mtime = 1700000000;
        const { url, name } = await create(0, undefined, ',mtime ' + btoa(String(mtime)));
        expect((await head(url)).headers.get('Upload-Offset')).toBe('0');
        expect(Number(drive.files.find(file => file.name === name)?.size)).toBe(0);
        expect(drive.files.find(file => file.name === name)?.modifiedTime).toBe(new Date(mtime * 1000).toISOString());
        const initial = await create(3, undefined, ',mtime ' + btoa(String(mtime + 50)));
        expect((await patch(initial.url, 0, new Uint8Array([1, 2, 3]))).status).toBe(204);
        expect(drive.files.find(file => file.name === initial.name)?.modifiedTime).toBe(new Date((mtime + 50) * 1000).toISOString());
        const empty = await create(0, initial.name, ',mtime ' + btoa(String(mtime + 100)));
        expect((await head(empty.url)).headers.get('Upload-Length')).toBe('0');
        expect(drive.files.find(file => file.name === initial.name)?.content).toEqual(new Uint8Array());
        expect(drive.files.find(file => file.name === initial.name)?.modifiedTime).toBe(new Date((mtime + 100) * 1000).toISOString());
    });

    it('rejects unsupported/malformed creation before writing Drive and advertises only implemented extensions', async () => {
        const options = await send('/dav/', { method: 'OPTIONS' });
        expect(options.headers.get('Tus-Extension')).toBe('creation');
        expect(options.headers.get('Tus-Version')).toBe('1.0.0');
        for (const headers of [
            { 'Upload-Length': '-1' }, { 'Upload-Length': '12oops' },
            { 'Upload-Length': '2', 'Upload-Metadata': 'filename ' + btoa('../escape') },
            { 'Upload-Length': '2', 'Upload-Metadata': 'filename ###' },
            { 'Upload-Length': '2', 'Upload-Metadata': 'filetype ' + btoa(String.fromCharCode(...new TextEncoder().encode('text/☃'))) },
            { 'Upload-Length': '2', 'Upload-Defer-Length': '1' },
        ] as Record<string, string>[]) expect((await send('/dav/', { method: 'POST', headers })).status).toBe(400);
        expect((await send('/dav/', { method: 'POST', headers: { 'Upload-Length': '1' }, body: 'x' })).status).toBe(400);
        expect((await send('/dav/', { method: 'POST', headers: { 'Tus-Resumable': '0.2', 'Upload-Length': '1' } })).status).toBe(412);
        expect(drive.files).toHaveLength(0);
        await create(0, undefined, ',opaque /w==');
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
        const ordinary = await head('/dav/folder/tus_uploads/file');
        expect(ordinary.status).toBe(200);
        expect(ordinary.headers.get('Content-Length')).toBe('7');
        expect(ordinary.headers.has('Upload-Offset')).toBe(false);
    });
});
