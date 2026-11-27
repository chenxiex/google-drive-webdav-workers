import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusError } from '../../src/http';
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
		const res = await runEmptyEnv('/webdav/');
		expect(res.status).toBe(500);
		expect(await res.text()).toContain('USERS');
		expect((await runEmptyEnv('/dav/')).status).toBe(404);
	});

	it('rejects even the default placeholder credentials', async () => {
		const res = await runEmptyEnv('/webdav/', { Authorization: basic('user', 'password') });
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
		const response = await worker.fetch(new Request(ORIGIN + '/webdav/', { headers: AUTH }), bindings as unknown as Env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		expect(await response.text()).toBe('Server not configured: missing ' + missing.join(', '));
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('path routing', () => {
	it.each([
		undefined,
		'/webdav/',
		'/webdav',
		'/custom/',
		'/custom',
		'/files/dav/',
		'/dav/other/',
		'/dav-legacy/',
		'/status.php-alt/',
	])('routes from bindings per request (%s) and preserves authentication', async path => {
		const fetch = vi.fn(() => { throw new Error('Unexpected external request'); });
		vi.stubGlobal('fetch', fetch);
		const bindings: Record<string, unknown> = { ...env };
		if (path === undefined) delete bindings.WEBDAV_PATH;
		else bindings.WEBDAV_PATH = path;

		const run = async (urlPath: string, init: RequestInit = {}) => {
			const ctx = createExecutionContext();
			const response = await worker.fetch(new Request(ORIGIN + urlPath, init), bindings as unknown as Env, ctx);
			await waitOnExecutionContext(ctx);
			return response;
		};

		const effectivePath = path ?? '/webdav/';
		const base = effectivePath.endsWith('/') ? effectivePath : effectivePath + '/';

		if (!effectivePath.endsWith('/')) {
			const redirect = await run(effectivePath);
			expect(redirect.status).toBe(301);
			expect(redirect.headers.get('Location')).toBe(ORIGIN + base);
		}
		const unauthenticated = await run(base);
		expect(unauthenticated.status).toBe(401);
		expect(unauthenticated.headers.get('WWW-Authenticate')).toContain('Basic realm=');

		const redirect = await run(base.slice(0, -1));
		expect(redirect.status).toBe(301);
		expect(redirect.headers.get('Location')).toBe(ORIGIN + base);
		expect((await run(base.slice(0, -1) + '-other/')).status).toBe(404);
		expect((await run('/dav/')).status).toBe(404);
		if (base !== '/webdav/') expect((await run('/webdav/')).status).toBe(404);

		expect((await run(base, {
			headers: { Authorization: basic('test', 'wrong') },
		})).status).toBe(401);
		const options = await run(base, { method: 'OPTIONS', headers: AUTH });
		expect(options.status).toBe(200);
		expect(options.headers.get('Allow')!.split(',').map(m => m.trim())).not.toContain('PATCH');
		expect((await run(base + 'a.txt', {
			method: 'PATCH',
			headers: { ...AUTH, Destination: ORIGIN + base + 'copy.txt' },
		})).status).toBe(405);
		expect((await run(base + 'tus_uploads', { method: 'PATCH', headers: AUTH })).status).toBe(405);
		expect((await run(base + 'tus_uploads/' + crypto.randomUUID(), { method: 'PATCH', headers: AUTH })).status).toBe(412);
		expect((await run('/robots.txt')).status).toBe(200);
		expect((await run('/favicon.ico')).status).toBe(204);
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		'/',
		'/dav/',
		'/dav',
		'/dav/spaces/',
		'/dav/spaces',
		'/dav/spaces/personal/',
		'/remote.php/',
		'/remote.php',
		'/remote.php/webdav/',
		'/remote.php/dav/files/test/',
		'/ocs/',
		'/ocs',
		'/ocs/v2.php/cloud/capabilities',
		'/graph/',
		'/graph',
		'/graph/v1.0/me/drives',
		'/oauth/',
		'/oauth',
		'/oauth/authorize',
		'/status.php',
		'/status.php/',
		'/status.php/sub',
		'/.well-known/',
		'/.well-known',
		'/.well-known/openid-configuration',
		'webdav',
		'   ',
		'//',
		'/./',
		'/custom/../ocs/',
		'/webdav?x=1',
		'/webdav#frag',
		'/%64av/',
	])('rejects invalid or conflicting WEBDAV_PATH (%s) with a 500 configuration error', async invalidPath => {
		const fetch = vi.fn(() => { throw new Error('Unexpected external request'); });
		vi.stubGlobal('fetch', fetch);
		const bindings = { ...env, WEBDAV_PATH: invalidPath } as unknown as Env;

		const run = async (urlPath: string, headers?: HeadersInit) => {
			const ctx = createExecutionContext();
			const response = await worker.fetch(new Request(ORIGIN + urlPath, { headers }), bindings, ctx);
			await waitOnExecutionContext(ctx);
			return response;
		};

		const probePath = invalidPath.startsWith('/') && !/[?#\s]/.test(invalidPath) ? invalidPath : '/webdav/';
		for (const res of [await run('/webdav/', AUTH), await run(probePath)]) {
			expect(res.status).toBe(500);
			expect(await res.text()).toContain('Server not configured: WEBDAV_PATH');
		}
		expect((await run('/robots.txt')).status).toBe(200);
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('top-level error handling', () => {
	it.each<[string, unknown, number, string]>([
		['string e.code', Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), 500, '500: socket reset'],
		['non-HTTP numeric e.code', Object.assign(new Error('sqlite busy'), { code: 5 }), 500, '500: sqlite busy'],
		['HTTP-like e.code without status', Object.assign(new Error('code ignored'), { code: 404 }), 500, '500: code ignored'],
		['DOMException with numeric code', new DOMException('Aborted', 'AbortError'), 500, '500: Aborted'],
		['valid StatusError status', new StatusError('Rate limited', 429), 429, '429: Rate limited'],
		['non-error 204 status', Object.assign(new Error('no content'), { status: 204 }), 500, '500: no content'],
		['out-of-range status', Object.assign(new Error('out of range'), { status: 999 }), 500, '500: out of range'],
		['fractional status', Object.assign(new Error('fractional'), { status: 404.5 }), 500, '500: fractional'],
		['non-numeric status', Object.assign(new Error('string status'), { status: '404' }), 500, '500: string status'],
		['plain object with valid status', { status: 503, message: 'upstream down' }, 503, '503: upstream down'],
		['thrown string', 'unexpected string failure', 500, '500: unexpected string failure'],
		['thrown null', null, 500, '500: null'],
	])('normalizes %s via errorStatus()', async (_label, thrown, expectedStatus, expectedBody) => {
		const fetch = vi.fn(async () => { throw thrown; });
		vi.stubGlobal('fetch', fetch);
		const bindings = { ...env, CLIENT_ID: 'err-' + crypto.randomUUID() } as unknown as Env;

		const ctx = createExecutionContext();
		const res = await worker.fetch(new Request(ORIGIN + '/webdav/err-probe.txt', { method: 'HEAD', headers: AUTH }), bindings, ctx);
		await waitOnExecutionContext(ctx);

		expect(fetch).toHaveBeenCalledOnce();
		expect(res.status).toBe(expectedStatus);
		expect(await res.text()).toBe(expectedBody);
	});
});
