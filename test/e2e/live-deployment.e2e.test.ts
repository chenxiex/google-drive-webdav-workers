// Opt-in live deployment E2E suite (never runs in default `pnpm test`).
// Default (~12 MiB PUT + 12 MiB TUS):
//   LIVE_WEBDAV_URL=https://dav-staging.example.com pnpm test:e2e test/e2e/live-deployment.e2e.test.ts
// Large/memory-ceiling acceptance:
//   LIVE_WEBDAV_URL=https://dav-staging.example.com LIVE_PUT_MB=95 LIVE_TUS_MB=105 LIVE_TUS_CHUNK_MB=10 pnpm test:e2e test/e2e/live-deployment.e2e.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLiveSandbox, deterministicBytes, sha256Hex, type LiveSandbox } from './fixtures/live-sandbox';

const LIVE_URL = process.env.LIVE_WEBDAV_URL?.trim();

function parseMiB(envName: string, fallback: number): number {
	const raw = process.env[envName];
	if (raw === undefined || raw === '') return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${envName} must be a positive number (got ${raw})`);
	}
	return parsed;
}

describe.skipIf(!LIVE_URL)('live deployed Worker + Drive E2E', () => {
	let sandbox: LiveSandbox | undefined;

	beforeAll(async () => {
		sandbox = await createLiveSandbox();
	}, 60_000);

	afterAll(async () => {
		await sandbox?.cleanup();
	}, 60_000);

	it('serves small PUT, Drive v3 ETag on HEAD, GET, Range 206, and PROPFIND listing', async () => {
		const size = 64 * 1024;
		const payload = deterministicBytes(0, size);
		const url = sandbox!.fileUrl('small-e2e.bin');

		const putRes = await sandbox!.request({
			url,
			method: 'PUT',
			headers: { 'Content-Type': 'application/octet-stream' },
			bodyBuffer: payload,
		});
		expect(putRes.status).toBe(201);

		const headRes = await sandbox!.request({ url, method: 'HEAD' });
		expect(headRes.status).toBe(200);
		expect(headRes.headers['content-length']).toBe(String(size));
		expect(String(headRes.headers.etag || '')).not.toBe('');

		const getRes = await sandbox!.getAndHash('small-e2e.bin');
		expect(getRes.status).toBe(200);
		expect(getRes.bytes).toBe(size);
		expect(getRes.sha256).toBe(sha256Hex(payload));

		const rangeRes = await sandbox!.getAndHash('small-e2e.bin', { Range: 'bytes=0-1023' });
		expect(rangeRes.status).toBe(206);
		expect(rangeRes.bytes).toBe(1024);
		expect(rangeRes.sha256).toBe(sha256Hex(payload.subarray(0, 1024)));

		const propRes = await sandbox!.request({
			url: sandbox!.sandboxUrl,
			method: 'PROPFIND',
			headers: { Depth: '1' },
		});
		expect(propRes.status).toBe(207);
		expect(propRes.bodyText).toContain('small-e2e.bin');
	});

    it.each([
        {
            kind: 'resumable PUT', name: 'stream-e2e.bin', sizeEnv: 'LIVE_PUT_MB',
            upload: async (sandbox: LiveSandbox, name: string, totalBytes: number) => {
                const uploaded = await sandbox.putStream(name, totalBytes);
                expect([201, 204]).toContain(uploaded.status);
                return uploaded;
            },
        },
        {
            kind: 'multi-chunk TUS', name: 'tus-e2e.bin', sizeEnv: 'LIVE_TUS_MB',
            upload: async (sandbox: LiveSandbox, name: string, totalBytes: number) => {
                const chunkBytes = Math.round(parseMiB('LIVE_TUS_CHUNK_MB', 4) * 1024 * 1024);
                const uploaded = await sandbox.tusUpload(name, totalBytes, chunkBytes);
                expect(uploaded.chunks).toBe(Math.ceil(totalBytes / chunkBytes));
                return uploaded;
            },
        },
    ])('uploads $kind and verifies downloaded bytes', async ({ name, sizeEnv, upload }) => {
        const totalBytes = Math.round(parseMiB(sizeEnv, 12) * 1024 * 1024);
        const uploaded = await upload(sandbox!, name, totalBytes);

        const downloaded = await sandbox!.getAndHash(name);
        expect(downloaded.status).toBe(200);
        expect(downloaded.bytes).toBe(totalBytes);
        expect(downloaded.sha256).toBe(uploaded.sha256);
        expect(String(downloaded.headers.etag || '')).not.toBe('');
    }, 300_000);
});
