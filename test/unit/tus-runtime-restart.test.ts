import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { workerBindings } from '../support/drive-bindings';
import { MockDrive } from '../support/mock-drive';

const requireWrangler = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'));
const { Miniflare } = requireWrangler('miniflare');
const { build } = requireWrangler('esbuild');

it('recovers a durable tail and inflight upload after the Worker runtime stops before Drive acceptance', async () => {
    const drive = new MockDrive();
    const bundle = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', external: ['cloudflare:workers'] });
    const directory = await mkdtemp(join(tmpdir(), 'tus-runtime-restart-'));
    const reached = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<Response>();
    let interrupt = false;
    const probes: Array<{ requestRange: string; status: number; responseRange: string | null }> = [];
    const options = {
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: '2026-04-15',
        durableObjects: {
            TUS_UPLOADS: { className: 'TusUpload', useSQLite: true },
            SYNC_INDEX: { className: 'SyncIndex', useSQLite: true },
        },
        durableObjectsPersist: directory,
        bindings: workerBindings,
        outboundService: async (request: Request) => {
            const range = request.headers.get('Content-Range');
            if (interrupt && range?.startsWith('bytes ') && !range.startsWith('bytes */')) {
                reached.resolve();
                return blocked.promise;
            }
            const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
            const response = await drive.handle(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body });
            if (range?.startsWith('bytes */')) {
                probes.push({ requestRange: range, status: response.status, responseRange: response.headers.get('Range') });
            }
            return new Response(response.body, { status: response.status, headers: response.headers });
        },
    };
    let runtime = new Miniflare(options);
    const send = (path: string, init: RequestInit = {}) => runtime.dispatchFetch(new URL(path, 'https://example.com').href, {
        ...init,
        headers: { Authorization: 'Basic ' + btoa('test:pass'), 'Tus-Resumable': '1.0.0', ...init.headers },
    });
    const patch = (url: string, offset: number, data: Uint8Array) => send(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) },
        body: data,
    });
    try {
        const alignment = 256 * 1024;
        const tailSize = 113;
        const data = Uint8Array.from({ length: 1024 * 1024 + 97 }, (_, index) => index * 73 % 251);
        const created = await send('/webdav/', {
            method: 'POST',
            headers: { 'Upload-Length': String(data.length), 'Upload-Metadata': 'filename ' + btoa('restart.bin') },
        });
        expect(created.status).toBe(201);
        const url = created.headers.get('Location')!;
        expect((await patch(url, 0, data.subarray(0, tailSize))).status).toBe(204);
        interrupt = true;
        const pending = patch(url, tailSize, data.subarray(tailSize, 2 * alignment + 63)).then(
            (response: Response) => response.status,
            () => 'disconnected',
        );
        // The data PUT starts after the DO writes its inflight marker.
        expect(await Promise.race([reached.promise.then(() => 'gated'), pending])).toBe('gated');
        await runtime.dispose();
        expect(await pending).toBe('disconnected');
        interrupt = false;
        runtime = new Miniflare(options);
        const recovered = await send(url, { method: 'HEAD' });
        expect(recovered.status).toBe(200);
        let offset = Number(recovered.headers.get('Upload-Offset'));
        expect(offset).toBe(tailSize);
        expect(probes).toEqual([{ requestRange: `bytes */${data.length}`, status: 308, responseRange: null }]);
        for (const nextOffset of [tailSize + 71, alignment + 19, data.length]) {
            const response = await patch(url, offset, data.subarray(offset, nextOffset));
            offset = nextOffset;
            expect(response.status).toBe(204);
            expect(response.headers.get('Upload-Offset')).toBe(String(offset));
        }
        const downloaded = await send('/webdav/restart.bin');
        expect(downloaded.status).toBe(200);
        const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
        expect(sha256(new Uint8Array(await downloaded.arrayBuffer()))).toBe(sha256(data));
        expect((await send(url, { method: 'HEAD' })).status).toBe(404);
    } finally {
        blocked.resolve(new Response(null, { status: 503 }));
        try {
            await runtime.dispose();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
}, 20_000);
