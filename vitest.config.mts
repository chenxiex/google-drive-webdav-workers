import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

const compat = {
	compatibilityDate: '2026-04-15',
	kvNamespaces: ['KV'],
};

const davBindings = {
	USERS: JSON.stringify({ test: 'pass' }),
	CLIENT_ID: 'test-client-id',
	CLIENT_SECRET: 'test-client-secret',
	REFRESH_TOKEN: 'test-refresh-token-history',
};

export default defineConfig({
	test: {
		projects: [
            ...[1, 2, 3, 4, 5, 6, 7].map(mask => {
                const keys = ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN'] as const;
                const bindings: Record<string, string> = { ...davBindings };
                const missing = keys.filter((key, index) => mask & (1 << index));
                for (const key of missing) bindings[key] = mask === 7 ? '   ' : '';
                bindings.EXPECT_MISSING = missing.join(', ');
                return {
                    plugins: [cloudflareTest({ main: 'src/worker.ts', miniflare: { ...compat, bindings } })],
                    test: { name: 'oauth-missing-' + mask, include: ['test/oauth-config.test.ts'] },
                };
            }),
			{ test: { name: 'mock-drive', include: ['test/mock-drive.test.ts'] } },
			{
				plugins: [
					cloudflareTest({
						main: 'src/worker.ts',
						miniflare: { ...compat, bindings: davBindings },
					}),
				],
				test: { name: 'dav', include: ['test/dav.test.ts'] },
			},
			{
				plugins: [
					cloudflareTest({
						main: 'src/worker.ts',
						miniflare: { ...compat },
					}),
				],
				test: { name: 'auth', include: ['test/auth.test.ts'] },
			},
		],
	},
});