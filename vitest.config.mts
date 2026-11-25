import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

const compat = {
	compatibilityDate: '2026-04-15',
	durableObjects: { TUS_UPLOADS: { className: 'TusUpload', useSQLite: true } },
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
			// Independent workers: never warm a custom route via the default path.
			...['/custom', '/'].map(path => ({
				plugins: [cloudflareTest({ main: 'src/worker.ts', miniflare: {
					...compat, bindings: { ...davBindings, PATH: path },
				} })],
				test: { name: 'routing-' + (path === '/' ? 'root' : path.slice(1)), include: ['test/routing.test.ts'] },
			})),
			// Single missing binding plus whitespace-only aggregate validation.
			...[1, 7].map(mask => {
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
			{ test: { name: 'unit', include: ['test/dav-properties.test.ts'] } },
			{
				plugins: [cloudflareTest({ main: 'src/worker.ts', miniflare: { ...compat, bindings: davBindings } })],
				test: { name: 'worker', include: ['test/dav.test.ts', 'test/properties.test.ts', 'test/tus.test.ts'] },
			},
			{
				plugins: [cloudflareTest({ main: 'src/worker.ts', miniflare: { ...compat } })],
				test: { name: 'auth', include: ['test/auth.test.ts'] },
			},
		],
	},
});
