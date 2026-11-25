import { vi } from 'vitest';
import { FOLDER, type MockDrive } from './mock-drive';

export { FOLDER } from './mock-drive';
export const ORIGIN = 'https://example.com';
export const basic = (username: string, password: string): string => 'Basic ' + btoa(`${username}:${password}`);
export const AUTH = { Authorization: basic('test', 'pass') };

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

export function installDriveMock(drive: MockDrive): void {
	vi.stubGlobal('fetch', (input: FetchInput, init?: FetchInit): Promise<Response> => drive.handle(input, init));
}

export function seedStandardDrive(drive: MockDrive): void {
	drive.add({ id: 'folder-docs', name: 'docs', mimeType: FOLDER, parents: ['root'] });
	drive.add({ id: 'file-a', name: 'a.txt', mimeType: 'text/plain', size: 123, parents: ['root'] });
	drive.add({ id: 'file-dest', name: 'dest.txt', mimeType: 'text/plain', size: 456, parents: ['root'] });
	drive.add({ id: 'file-hostile', name: 'x & y [#].txt', mimeType: 'text/plain', size: 100, parents: ['root'] });
	drive.add({ id: 'file-b', name: 'b & c.txt', mimeType: 'text/plain', size: 999, parents: ['folder-docs'] });
	drive.add({ id: 'folder-sub', name: 'sub&dir', mimeType: FOLDER, parents: ['folder-docs'] });
}

// Fault injection wraps the verified mock rather than extending its API contract.
// Injected failures test worker recovery policy, not claims that Google emits each response.
export type Mutation = { method: string; path: string; body: Record<string, unknown>; url: URL };

export function recordMutations(
	drive: MockDrive,
	intercept?: (call: Mutation, commit: () => Promise<Response>) => Promise<Response | undefined>,
): Mutation[] {
	const calls: Mutation[] = [];
	const handle = drive.handle.bind(drive);
	vi.spyOn(drive, 'handle').mockImplementation(async (input, init) => {
		const req = new Request(input, init);
		const url = new URL(req.url);
		if (url.pathname.startsWith('/drive/v3/files') && req.method !== 'GET') {
			const text = await req.clone().text();
			const call = { method: req.method, path: url.pathname, body: text ? JSON.parse(text) : {}, url };
			calls.push(call);
			const response = await intercept?.(call, () => handle(input, init));
			if (response) return response;
		}
		return handle(input, init);
	});
	return calls;
}
