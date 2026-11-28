import { test, expect } from 'vitest';
import { mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createLocalWorker } from './fixtures/local-worker';

const exec = promisify(execFile);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('real rclone uploads more than the simulated ingress limit using bounded TUS requests', async () => {
    const bin = process.env.RCLONE_BIN;
    if (!bin) throw new Error('Set RCLONE_BIN to a rclone build supporting webdav vendor=infinitescale.');
    const { stdout: version } = await exec(bin, ['version']);
    const ingressLimit = 12 * 1024 * 1024;
    const bytes = randomBytes(25 * 1024 * 1024 + 123);
    const expectedHash = hash(bytes);
    const dir = await mkdtemp(join(tmpdir(), 'webdav-rclone-'));
    try {
        const worker = await createLocalWorker(ingressLimit);
        try {
            const { url, drive, requests } = worker;
            await writeFile(join(dir, 'payload.bin'), bytes);
            const modifiedTime = new Date('2025-01-02T03:04:05Z');
            await utimes(join(dir, 'payload.bin'), modifiedTime, modifiedTime);
            const { stdout: password } = await exec(bin, ['obscure', 'pass']);
            const config = join(dir, 'rclone.conf');
            await writeFile(config, ['[test]', 'type = webdav', `url = ${url}`, 'vendor = infinitescale', 'user = test', `pass = ${password.trim()}`, ''].join('\n'));
            await exec(bin, ['copy', join(dir, 'payload.bin'), 'test:', '--config', config, '--retries', '1', '--low-level-retries', '1', '--log-level', 'INFO'], { timeout: 100_000 });
            const file = drive.files.find(file => file.name === 'payload.bin');
            expect(file?.content?.length).toBe(bytes.length);
            expect(hash(file!.content!)).toBe(expectedHash);
            expect(file?.modifiedTime).toBe(modifiedTime.toISOString());
            const patches = requests.filter(request => request.method === 'PATCH');
            expect(patches.length).toBeGreaterThan(1);
            expect(patches.every(request => request.status === 204 && request.size <= ingressLimit)).toBe(true);
            expect(patches.reduce((total, request) => total + request.size, 0)).toBe(bytes.length);
            expect(requests.some(request => request.method === 'PUT')).toBe(false);
            // The same front door demonstrably rejects one oversized request.
            const rejected = await fetch(url + 'oversize.bin', { method: 'PUT', headers: { Authorization: 'Basic ' + btoa('test:pass') }, body: bytes });
            expect(rejected.status).toBe(413);
            process.stdout.write(JSON.stringify({ rclone: version.split('\n')[0], totalBytes: bytes.length, simulatedIngressBytes: ingressLimit, patchBytes: patches.map(request => request.size), sha256: expectedHash, oversizedPutStatus: rejected.status }) + "\n");
        } finally {
            await worker.dispose();
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
