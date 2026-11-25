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
			{ test: { name: 'unit', include: ['test/dav-properties.test.ts'] } },
			{
				plugins: [cloudflareTest({ main: 'src/worker.ts', miniflare: { ...compat, bindings: davBindings } })],
				test: {
					name: 'worker',
					include: [
						'test/dav.test.ts',
						'test/properties.test.ts',
						'test/tus.test.ts',
						'test/auth.test.ts',
						'test/oauth-config.test.ts',
						'test/routing.test.ts',
					],
				},
			},
		],
	},
});
