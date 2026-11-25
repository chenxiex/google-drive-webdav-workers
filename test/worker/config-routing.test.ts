import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { AUTH, ORIGIN, basic } from '../support/client';

afterEach(() => vi.unstubAllGlobals());

// Invoke with an empty env: missing USERS must fail closed rather than falling
// back to any placeholder "user"/"password" credentials.
async function runEmptyEnv(path: string, headers?: HeadersInit): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(ORIGIN + path, { headers }), {} as Env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

describe('env config without USERS binding', () => {
	it('serves pre-auth routes', async () => {
		const res = await runEmptyEnv('/robots.txt');
		expect(res.status).toBe(200);
	});

	it('refuses to serve the webdav root with a 500, not the placeholder creds', async () => {
		const res = await runEmptyEnv('/dav/');
		expect(res.status).toBe(500);
		expect(await res.text()).toContain('USERS');
	});

	it('rejects even the default placeholder credentials', async () => {
		const res = await runEmptyEnv('/dav/', { Authorization: basic('user', 'password') });
		expect(res.status).toBe(500);
	});
});

describe('explicit OAuth bindings', () => {
	it.each([1, 2, 4, 7])('rejects incomplete credentials before any Google request (mask=%i)', async mask => {
		const fetch = vi.fn(() => { throw new Error('Unexpected external request'); });
		vi.stubGlobal('fetch', fetch);
		const keys = ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN'] as const;
		const bindings: Record<string, unknown> = { ...env };
		const missing = keys.filter((_, index) => mask & (1 << index));
		for (const key of missing) bindings[key] = mask === 7 ? '   ' : '';

		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request(ORIGIN + '/dav/', { headers: AUTH }), bindings as unknown as Env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		expect(await response.text()).toBe('Server not configured: missing ' + missing.join(', '));
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('path routing', () => {
	it.each([undefined, '/custom/', '/custom', '/'])('routes from bindings per request (%s) and preserves authentication', async path => {
		const fetch = vi.fn(() => { throw new Error('Unexpected external request'); });
		vi.stubGlobal('fetch', fetch);
		const bindings: Record<string, unknown> = { ...env };
		if (path === undefined) delete bindings.PATH;
		else bindings.PATH = path;

		const run = async (urlPath: string, init: RequestInit = {}) => {
			const ctx = createExecutionContext();
			const response = await worker.fetch(new Request(ORIGIN + urlPath, init), bindings as unknown as Env, ctx);
			await waitOnExecutionContext(ctx);
			return response;
		};

		const effectivePath = path ?? '/dav/';
		const base = effectivePath.endsWith('/') ? effectivePath : effectivePath + '/';

		if (!effectivePath.endsWith('/')) {
			const redirect = await run(effectivePath);
			expect(redirect.status).toBe(301);
			expect(redirect.headers.get('Location')).toBe(ORIGIN + base);
		}
		const unauthenticated = await run(base);
		expect(unauthenticated.status).toBe(401);
		expect(unauthenticated.headers.get('WWW-Authenticate')).toContain('Basic realm=');

		if (base !== '/') {
			const redirect = await run(base.slice(0, -1));
			expect(redirect.status).toBe(301);
			expect(redirect.headers.get('Location')).toBe(ORIGIN + base);
			expect((await run(base.slice(0, -1) + '-other/')).status).toBe(404);
			if (base !== '/dav/') expect((await run('/dav/')).status).toBe(404);
		}
		expect((await run(base, {
			headers: { Authorization: basic('test', 'wrong') },
		})).status).toBe(401);
		expect((await run(base, { method: 'OPTIONS', headers: AUTH })).status).toBe(200);
		expect((await run('/robots.txt')).status).toBe(200);
		expect((await run('/favicon.ico')).status).toBe(204);
		expect(fetch).not.toHaveBeenCalled();
	});
});
