import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH, ORIGIN } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('explicit OAuth bindings', () => {
    it('rejects incomplete credentials before any Google request', async () => {
        const fetch = vi.fn(() => { throw new Error('Unexpected external request'); });
        vi.stubGlobal('fetch', fetch);
        const response = await SELF.fetch(ORIGIN + '/dav/', { headers: AUTH });
        expect(response.status).toBe(500);
        expect(await response.text()).toBe('Server not configured: missing ' + (env as unknown as { EXPECT_MISSING: string }).EXPECT_MISSING);
        expect(fetch).not.toHaveBeenCalled();
    });
});
