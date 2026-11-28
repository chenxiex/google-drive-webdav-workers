import { type DurableObject } from 'cloudflare:workers';
import { abortAllDurableObjects, env, listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { afterEach } from 'vitest';
import { resetTestState } from './reset';

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

afterEach(async () => {
	try {
		await clearAllDurableObjects();
	} finally {
		resetTestState();
	}
});
