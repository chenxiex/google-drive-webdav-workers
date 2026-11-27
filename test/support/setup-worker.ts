import { type DurableObject } from 'cloudflare:workers';
import { abortAllDurableObjects, env, listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { isolateCache } from '../../src/drive/cache';
import { invalidateAccessToken } from '../../src/drive/oauth';
import { clearFetchMock, drainUnmockedFetches } from './network';

async function clearAllDurableObjects(): Promise<void> {
	// Abort live DO instances first (while mocks are still installed) so in-flight work stops cleanly.
	await abortAllDurableObjects();
	const bindings = env as Partial<Env>;
	const namespaces = [bindings.SYNC_INDEX, bindings.TUS_UPLOADS, bindings.AUTH_DO].filter(
		(ns): ns is DurableObjectNamespace<DurableObject> => ns !== undefined,
	);
	let wiped = false;
	await Promise.all(
		namespaces.map(async ns => {
			const ids = await listDurableObjectIds(ns);
			if (ids.length === 0) return;
			wiped = true;
			await Promise.all(
				ids.map(id => runInDurableObject(ns.get(id), async (_instance, state) => {
					await state.storage.deleteAll();
				})),
			);
		}),
	);
	// Evict instances opened by deleteAll() so constructors recreate fresh SQLite schemas on next use.
	if (wiped) {
		await abortAllDurableObjects();
	}
}

beforeEach(() => {
	drainUnmockedFetches();
});

afterEach(async () => {
	await clearAllDurableObjects();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	clearFetchMock();
	isolateCache.clear();
	const bindings = env as Partial<Env>;
	if (bindings.CLIENT_ID && bindings.REFRESH_TOKEN) {
		invalidateAccessToken({ client_id: bindings.CLIENT_ID, refresh_token: bindings.REFRESH_TOKEN });
	}
	const leaked = drainUnmockedFetches();
	expect(leaked, `Unexpected unmocked outbound fetch call(s): ${leaked.join(', ')}`).toEqual([]);
});
