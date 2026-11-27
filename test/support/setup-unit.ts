import { afterEach, beforeEach, expect, vi } from 'vitest';
import { clearFetchMock, drainUnmockedFetches } from './network';

beforeEach(() => {
	drainUnmockedFetches();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	clearFetchMock();
	const leaked = drainUnmockedFetches();
	expect(leaked, `Unexpected unmocked outbound fetch call(s): ${leaked.join(', ')}`).toEqual([]);
});
