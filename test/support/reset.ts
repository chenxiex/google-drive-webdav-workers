import { expect, vi } from 'vitest';
import { isolateCache } from '../../src/drive/cache';
import { invalidateAccessToken } from '../../src/drive/oauth';
import { driveBindings } from './drive-bindings';
import { clearFetchMock, drainUnmockedFetches } from './network';

export function resetTestState(): void {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearFetchMock();
    isolateCache.clear();
    invalidateAccessToken({ client_id: driveBindings.CLIENT_ID, refresh_token: driveBindings.REFRESH_TOKEN });
    const leaked = drainUnmockedFetches();
    expect(leaked, `Unexpected unmocked outbound fetch call(s): ${leaked.join(', ')}`).toEqual([]);
}
