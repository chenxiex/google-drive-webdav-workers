import { SELF, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach } from 'vitest';
import worker from '../../src/index';
import { AUTH, ORIGIN, installDriveMock } from './client';
import { MockDrive } from './mock-drive';

export function basicHeaders(init?: HeadersInit): Headers {
    const headers = new Headers(init);
    if (!headers.has('Authorization')) headers.set('Authorization', AUTH.Authorization);
    return headers;
}

export function request(path: string, init: RequestInit = {}): Promise<Response> {
    return SELF.fetch(new URL(path, ORIGIN), { ...init, headers: basicHeaders(init.headers) });
}

export async function invokeWorker(bindings: Env, path: string, init: RequestInit = {}): Promise<Response> {
    const ctx = createExecutionContext();
    try {
        return await worker.fetch(new Request(new URL(path, ORIGIN), init), bindings, ctx);
    } finally {
        await waitOnExecutionContext(ctx);
    }
}

export function useMockDrive(seed?: (drive: MockDrive) => void): { readonly drive: MockDrive } {
    let drive: MockDrive;
    beforeEach(() => {
        drive = new MockDrive();
        seed?.(drive);
        installDriveMock(drive);
    });
    return { get drive() { return drive; } };
}
