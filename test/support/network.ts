type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

export type FetchHandler = (input: FetchInput, init?: FetchInit) => Promise<Response> | Response;

let activeHandler: FetchHandler | null = null;
const unmockedFetches: string[] = [];

const dispatchedFetch = (input: FetchInput, init?: FetchInit): Promise<Response> => {
	if (activeHandler) {
		return Promise.resolve(activeHandler(input, init));
	}
	const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
	const method = init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET');
	const label = `${method} ${url}`;
	unmockedFetches.push(label);
	return Promise.reject(new Error(`Blocked unmocked outbound fetch in test: ${label}`));
};

// Own globalThis.fetch permanently so vi.unstubAllGlobals() never reverts to live network fetch.
globalThis.fetch = dispatchedFetch as typeof fetch;

export function setFetchMock(handler: FetchHandler): void {
	activeHandler = handler;
}

export function clearFetchMock(): void {
	activeHandler = null;
}

export function drainUnmockedFetches(): string[] {
	return unmockedFetches.splice(0, unmockedFetches.length);
}
