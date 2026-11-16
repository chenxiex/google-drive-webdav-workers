import { env, SELF } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { AUTH, ORIGIN, basic } from './helpers';

afterEach(() => vi.unstubAllGlobals());

// One ordered scenario per isolated project keeps the first request truly cold.
it('routes from bindings on a cold worker and preserves authentication', async () => {
    const fetch = vi.fn(() => { throw new Error('Unexpected external request'); });
    vi.stubGlobal('fetch', fetch);
    const path = (env as unknown as { PATH?: string }).PATH ?? '/dav/';
    const base = path.endsWith('/') ? path : path + '/';

    if (!path.endsWith('/')) {
        const redirect = await SELF.fetch(ORIGIN + path, { redirect: 'manual' });
        expect(redirect.status).toBe(301);
        expect(redirect.headers.get('Location')).toBe(ORIGIN + base);
    }
    const unauthenticated = await SELF.fetch(ORIGIN + base);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('WWW-Authenticate')).toContain('Basic realm=');

    if (base !== '/') {
        const redirect = await SELF.fetch(ORIGIN + base.slice(0, -1), { redirect: 'manual' });
        expect(redirect.status).toBe(301);
        expect(redirect.headers.get('Location')).toBe(ORIGIN + base);
        expect((await SELF.fetch(ORIGIN + base.slice(0, -1) + '-other/')).status).toBe(404);
        if (base !== '/dav/') expect((await SELF.fetch(ORIGIN + '/dav/')).status).toBe(404);
    }
    expect((await SELF.fetch(ORIGIN + base, {
        headers: { Authorization: basic('test', 'wrong') },
    })).status).toBe(401);
    expect((await SELF.fetch(ORIGIN + base, { method: 'OPTIONS', headers: AUTH })).status).toBe(200);
    expect((await SELF.fetch(ORIGIN + '/robots.txt')).status).toBe(200);
    expect((await SELF.fetch(ORIGIN + '/favicon.ico')).status).toBe(204);
    expect(fetch).not.toHaveBeenCalled();
});
