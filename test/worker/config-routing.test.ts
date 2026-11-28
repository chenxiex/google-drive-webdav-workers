import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { StatusError } from '../../src/http';
import { AUTH, ORIGIN, basic } from '../support/client';
import { drainUnmockedFetches, setFetchMock } from '../support/network';
import { invokeWorker } from '../support/worker';

describe('env config without USERS binding', () => {
    it.each([
        ['no credentials', undefined],
        ['placeholder credentials', { Authorization: basic('user', 'password') }],
    ] as const)('fails closed for %s', async (_label, headers) => {
        const response = await invokeWorker({} as Env, '/webdav/', { headers });
        expect(response.status).toBe(500);
        expect(await response.text()).toContain('USERS');
    });
});

describe('explicit OAuth bindings', () => {
    const keys = ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN'] as const;
    it.each([
        { missing: ['CLIENT_ID'], value: '' },
        { missing: ['CLIENT_SECRET'], value: '' },
        { missing: ['REFRESH_TOKEN'], value: '' },
        { missing: keys, value: '   ' },
    ] as const)('rejects missing $missing before any Google request', async ({ missing, value }) => {
        const bindings = { ...env };
        for (const key of missing) bindings[key] = value;
        const response = await invokeWorker(bindings, '/webdav/', { headers: AUTH });
        expect(response.status).toBe(500);
        expect(await response.text()).toBe('Server not configured: missing ' + missing.join(', '));
    });
});

describe('path routing', () => {
    it('uses the configured mount per request and keeps its auth boundary', async () => {
        const bindings = { ...env, WEBDAV_PATH: '/files/dav' };
        const mount = '/files/dav/';
        const redirect = await invokeWorker(bindings, '/files/dav');
        expect(redirect.status).toBe(301);
        expect(redirect.headers.get('Location')).toBe(ORIGIN + mount);

        const unauthenticated = await invokeWorker(bindings, mount);
        expect(unauthenticated.status).toBe(401);
        expect(unauthenticated.headers.get('WWW-Authenticate')).toContain('Basic realm=');
        expect((await invokeWorker(bindings, mount, { method: 'OPTIONS', headers: AUTH })).status).toBe(200);
        expect((await invokeWorker(bindings, '/files/dav-other/')).status).toBe(404);
        expect((await invokeWorker(bindings, '/webdav/')).status).toBe(404);
        expect((await invokeWorker(env, '/webdav/', { method: 'OPTIONS', headers: AUTH })).status).toBe(200);
    });

    it.each([
        ['a.txt', 405],
        ['tus_uploads', 405],
        ['tus_uploads/00000000-0000-4000-8000-000000000000', 412],
    ])('routes PATCH for %s at a custom mount', async (resource, status) => {
        const bindings = { ...env, WEBDAV_PATH: '/custom/' };
        const response = await invokeWorker(bindings, '/custom/' + resource, { method: 'PATCH', headers: AUTH });
        expect(response.status).toBe(status);
    });

    it('reports a reserved mount as a configuration error and serves robots.txt', async () => {
        const bindings = { ...env, WEBDAV_PATH: '/dav/' };
        const response = await invokeWorker(bindings, '/dav/', { headers: AUTH });
        expect(response.status).toBe(500);
        expect(await response.text()).toContain('Server not configured: WEBDAV_PATH');
        expect((await invokeWorker(bindings, '/robots.txt')).status).toBe(200);
    });
});

describe('top-level error handling', () => {
    it.each([
        { thrown: new StatusError('Rate limited', 429), status: 429, body: '429: Rate limited' },
        { thrown: { status: 503, message: 'upstream down' }, status: 503, body: '503: upstream down' },
        { thrown: null, status: 500, body: '500: null' },
    ])('responds to an upstream failure with HTTP $status', async ({ thrown, status, body }) => {
        const fetch = vi.fn(async () => { throw thrown; });
        setFetchMock(fetch);

        const response = await invokeWorker(env, '/webdav/err-probe.txt', { method: 'HEAD', headers: AUTH });
        expect(fetch).toHaveBeenCalledOnce();
        expect(response.status).toBe(status);
        expect(await response.text()).toBe(body);
    });
});

it('records the Worker outbound request even when the handler turns it into a response', async () => {
    const response = await invokeWorker(env, '/webdav/leak-probe.txt', { method: 'HEAD', headers: AUTH });
    expect(response.status).toBe(500);
    expect(drainUnmockedFetches()).toEqual(['POST https://www.googleapis.com/oauth2/v4/token']);
});
