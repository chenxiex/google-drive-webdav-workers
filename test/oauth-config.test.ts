import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { AUTH, ORIGIN } from './helpers';

afterEach(() => vi.unstubAllGlobals());

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
