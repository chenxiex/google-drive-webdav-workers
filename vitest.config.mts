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
			{ test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
			{
				plugins: [cloudflareTest({ main: 'src/index.ts', miniflare: { ...compat, bindings: davBindings } })],
				test: {
					name: 'worker',
					include: ['test/worker/**/*.test.ts'],
				},
			},
		],
	},
});
