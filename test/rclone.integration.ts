import { test, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { MockDrive } from './helpers';

// Use the versions already installed by Wrangler, not an additional runtime.
const requireWrangler = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'));
const { Miniflare } = requireWrangler('miniflare');
const { build } = requireWrangler('esbuild');
const exec = promisify(execFile);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('real rclone uploads more than the simulated ingress limit using bounded TUS requests', async () => {
    const bin = process.env.RCLONE_BIN;
    if (!bin) throw new Error('Set RCLONE_BIN to a rclone build supporting webdav vendor=infinitescale.');
    const { stdout: version } = await exec(bin, ['version']);
    const dir = await mkdtemp(join(tmpdir(), 'webdav-rclone-'));
    const drive = new MockDrive();
    const ingressLimit = 12 * 1024 * 1024;
    const bytes = randomBytes(25 * 1024 * 1024 + 123);
    const requests: { method: string; size: number; status: number }[] = [];
    const bundle = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false, format: 'esm', external: ['cloudflare:workers'] });
    const mf = new Miniflare({
        modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-04-15',
        durableObjects: { TUS_UPLOADS: { className: 'TusUpload', useSQLite: true } },
        bindings: { USERS: JSON.stringify({ test: 'pass' }), CLIENT_ID: 'test-client-id', CLIENT_SECRET: 'test-client-secret', REFRESH_TOKEN: 'test-refresh-token-history' },
        outboundService: async (request: Request) => {
            const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
            const response = await drive.handle(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body });
            return new Response(response.body, { status: response.status, headers: response.headers });
        },
    });
    const server = createServer(async (req, res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        try {
            for await (const chunk of req) {
                size += chunk.length;
                if (size > ingressLimit) { requests.push({ method: req.method!, size, status: 413 }); res.writeHead(413).end(); return; }
                chunks.push(chunk);
            }
            const url = `http://${req.headers.host}${req.url}`;
            const headers = new Headers();
            for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
            const response = await mf.dispatchFetch(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method!) || size === 0 ? undefined : Buffer.concat(chunks) });
            requests.push({ method: req.method!, size, status: response.status });
            res.writeHead(response.status, Object.fromEntries(response.headers));
            res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) { res.writeHead(500).end(String(error)); }
    });
    try {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as { port: number };
        const url = `http://127.0.0.1:${address.port}/dav/`;
        await writeFile(join(dir, 'payload.bin'), bytes);
        const modifiedTime = new Date('2025-01-02T03:04:05Z');
        await utimes(join(dir, 'payload.bin'), modifiedTime, modifiedTime);
        const { stdout: password } = await exec(bin, ['obscure', 'pass']);
        const config = join(dir, 'rclone.conf');
        await writeFile(config, `[test]\ntype = webdav\nurl = ${url}\nvendor = infinitescale\nuser = test\npass = ${password.trim()}\n`);
        await exec(bin, ['copy', join(dir, 'payload.bin'), 'test:', '--config', config, '--retries', '1', '--low-level-retries', '1', '--log-level', 'INFO'], { timeout: 100_000 });
        const file = drive.files.find(file => file.name === 'payload.bin');
        expect(file?.content?.length).toBe(bytes.length);
        expect(hash(file!.content!)).toBe(hash(bytes));
        expect(file?.modifiedTime).toBe(modifiedTime.toISOString());
        const patches = requests.filter(request => request.method === 'PATCH');
        expect(patches.length).toBeGreaterThan(1);
        expect(patches.every(request => request.status === 204 && request.size <= ingressLimit)).toBe(true);
        expect(patches.reduce((total, request) => total + request.size, 0)).toBe(bytes.length);
        expect(requests.some(request => request.method === 'PUT')).toBe(false);
        // The same front door demonstrably rejects one oversized request.
        const rejected = await fetch(url + 'oversize.bin', { method: 'PUT', headers: { Authorization: 'Basic ' + btoa('test:pass') }, body: bytes });
        expect(rejected.status).toBe(413);
        process.stdout.write(JSON.stringify({ rclone: version.split('\n')[0], totalBytes: bytes.length, simulatedIngressBytes: ingressLimit, patchBytes: patches.map(request => request.size), sha256: hash(bytes), oversizedPutStatus: rejected.status }) + "\n");
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await mf.dispose();
        await rm(dir, { recursive: true, force: true });
    }
});
