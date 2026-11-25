import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/worker';
import { ORIGIN, basic } from './helpers';

// Invoke with an empty env: missing USERS must fail closed rather than falling
// back to any placeholder "user"/"password" credentials.
async function run(path: string, headers?: HeadersInit): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(ORIGIN + path, { headers }), {} as Env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

describe('env config without USERS binding', () => {
	it('serves pre-auth routes', async () => {
		const res = await run('/robots.txt');
		expect(res.status).toBe(200);
	});

	it('refuses to serve the webdav root with a 500, not the placeholder creds', async () => {
		const res = await run('/dav/');
		expect(res.status).toBe(500);
		expect(await res.text()).toContain('USERS');
	});

	it('rejects even the default placeholder credentials', async () => {
		const res = await run('/dav/', { Authorization: basic('user', 'password') });
		expect(res.status).toBe(500);
	});
});
