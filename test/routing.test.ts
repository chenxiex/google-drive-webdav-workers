import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { AUTH, ORIGIN, basic } from './helpers';

afterEach(() => vi.unstubAllGlobals());

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
