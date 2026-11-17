import { DurableObject } from 'cloudflare:workers';

const ALIGNMENT = 256 * 1024;
const BLOCK_SIZE = 1024 * 1024;
const LIFETIME = 24 * 60 * 60 * 1000;

export interface TusSession {
    uploadUrl: string;
    totalSize: number;
    targetPath: string;
    parentId: string;
    owner: string;
    completed?: boolean;
}

interface UploadState extends TusSession {
    offset: number;
    driveOffset: number;
    tail: Uint8Array;
    pending?: Uint8Array;
    pendingStart?: number;
    expires: number;
}

class UploadError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
}

function integer(value: string | null): number | null {
    if (value === null || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

// A single durable record is a write-ahead journal: acknowledged bytes always
// exist either in Drive or here. Never store an entire client PATCH in memory.
export class TusUpload extends DurableObject {
    private queue: Promise<unknown> = Promise.resolve();

    fetch(request: Request): Promise<Response> {
        const result = this.queue.then(() => this.handle(request));
        this.queue = result.catch(() => undefined);
        return result;
    }

    async alarm(): Promise<void> {
        const result = this.queue.then(async () => {
            const state = await this.ctx.storage.get<UploadState>('upload');
            if (state && state.expires > Date.now()) await this.ctx.storage.setAlarm(state.expires);
            else await this.ctx.storage.deleteAll();
        });
        this.queue = result.catch(() => undefined);
        await result;
    }

    private response(state: UploadState | undefined, status: number, message?: string): Response {
        const headers = new Headers({ 'Tus-Resumable': '1.0.0', 'Cache-Control': 'no-store' });
        if (state) {
            headers.set('Upload-Offset', String(state.offset));
            headers.set('Upload-Length', String(state.totalSize));
            if (state.completed) {
                headers.set('x-tus-complete', '1');
                headers.set('x-tus-target-path', encodeURIComponent(state.targetPath));
                headers.set('x-tus-parent-id', state.parentId);
            }
        }
        return new Response(message ?? null, { status, headers });
    }

    private async save(state: UploadState): Promise<void> {
        await this.ctx.storage.put('upload', state);
    }

    private confirmedOffset(response: Response, state: UploadState): number {
        if (response.status === 200 || response.status === 201) return state.totalSize;
        if (response.status === 404 || response.status === 410) throw new UploadError('Upload session expired', 410);
        if (response.status !== 308) throw new UploadError('Drive upload temporarily unavailable', 503);
        const range = response.headers.get('Range');
        if (range === null) return 0;
        const match = /^bytes=0-(\d+)$/.exec(range);
        const end = match ? integer(match[1]) : null;
        // A 308 acknowledging the entire file is not a completion receipt.
        // Preserve the pending journal until a status query confirms 200/201.
        if (end === null || end >= state.totalSize - 1) throw new UploadError('Invalid Drive upload offset', 502);
        return end + 1;
    }

    private async applyConfirmation(state: UploadState, response: Response): Promise<void> {
        const offset = this.confirmedOffset(response, state);
        const pendingEnd = (state.pendingStart ?? state.driveOffset) + (state.pending?.length ?? 0);
        if (offset < state.driveOffset || offset > pendingEnd) throw new UploadError('Inconsistent Drive upload offset', 502);
        state.driveOffset = offset;
        if (offset === pendingEnd) {
            delete state.pending;
            delete state.pendingStart;
        }
        if (response.status === 200 || response.status === 201) state.completed = true;
        await this.save(state);
    }

    private async drain(state: UploadState, recover: boolean): Promise<void> {
        if (!state.pending) return;
        if (recover) {
            const response = await fetch(state.uploadUrl, {
                method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${state.totalSize}` }
            });
            try { await this.applyConfirmation(state, response); }
            finally { await response.body?.cancel(); }
        }
        while (state.pending) {
            const before = state.driveOffset;
            const bytes = state.pending;
            const start = state.pendingStart ?? before;
            const response = await fetch(state.uploadUrl, {
                method: 'PUT',
                headers: {
                    'Content-Length': String(bytes.length),
                    'Content-Range': `bytes ${start}-${start + bytes.length - 1}/${state.totalSize}`
                },
                body: bytes
            });
            try { await this.applyConfirmation(state, response); }
            finally { await response.body?.cancel(); }
            if (state.driveOffset === before) throw new UploadError('Drive did not acknowledge upload bytes', 503);
        }
    }

    private async accept(state: UploadState, bytes: Uint8Array, final: boolean): Promise<void> {
        state.offset += bytes.length - state.tail.length;
        const sendSize = final ? bytes.length : Math.floor(bytes.length / ALIGNMENT) * ALIGNMENT;
        state.tail = bytes.slice(sendSize);
        if (sendSize) {
            state.pending = bytes.slice(0, sendSize);
            state.pendingStart = state.driveOffset;
        }
        // Persist BEFORE the external effect, including bytes from a previous
        // PATCH. Recovery replays the original aligned block: Drive preserves
        // its accepted prefix, even when its exact offset is not aligned.
        await this.save(state);
        await this.drain(state, false);
    }

    private async patch(request: Request, state: UploadState): Promise<Response> {
        if (request.headers.get('Content-Type')?.toLowerCase() !== 'application/offset+octet-stream') {
            throw new UploadError('Expected application/offset+octet-stream', 415);
        }
        const offset = integer(request.headers.get('Upload-Offset'));
        if (offset === null) throw new UploadError('Invalid Upload-Offset', 400);
        if (offset !== state.offset) throw new UploadError('Upload offset mismatch', 409);
        const lengthHeader = request.headers.get('Content-Length');
        const length = integer(lengthHeader);
        if (lengthHeader !== null && length === null) throw new UploadError('Invalid Content-Length', 400);
        if (length !== null && length > state.totalSize - state.offset) throw new UploadError('Upload exceeds declared length', 413);
        await this.drain(state, true);
        const reader = request.body?.getReader();
        let received = 0;
        let finished = false;
        const buffer = new Uint8Array(BLOCK_SIZE);
        buffer.set(state.tail);
        let size = state.tail.length;
        const start = state.offset;
        try {
            if (reader) while (true) {
                const chunk = await reader.read();
                if (chunk.done) { finished = true; break; }
                const input = chunk.value;
                if (input.length > state.totalSize - start - received || (length !== null && input.length > length - received)) {
                    throw new UploadError('Upload exceeds declared length', 413);
                }
                received += input.length;
                let cursor = 0;
                while (cursor < input.length) {
                    const take = Math.min(BLOCK_SIZE - size, input.length - cursor);
                    buffer.set(input.subarray(cursor, cursor + take), size);
                    size += take;
                    cursor += take;
                    if (size === BLOCK_SIZE) {
                        await this.accept(state, buffer, state.offset + size - state.tail.length === state.totalSize);
                        size = 0;
                    }
                }
            }
            if (length !== null && received !== length) throw new UploadError('Incomplete request body', 400);
            if (size > state.tail.length) {
                await this.accept(state, buffer.subarray(0, size), start + received === state.totalSize);
            }
            return this.response(state, 204);
        } finally {
            if (reader) {
                if (!finished) { try { await reader.cancel(); } catch {} }
                reader.releaseLock();
            }
        }
    }

    private async handle(request: Request): Promise<Response> {
        let state: UploadState | undefined;
        try {
            state = await this.ctx.storage.get<UploadState>('upload');
            if (request.method === 'POST' && new URL(request.url).pathname === '/initialize') {
                if (state) throw new UploadError('Session already exists', 409);
                const session = await request.json<TusSession>();
                if (!Number.isSafeInteger(session.totalSize) || session.totalSize < 0 || !session.owner) {
                    throw new UploadError('Invalid upload session', 400);
                }
                state = { ...session, offset: session.completed ? session.totalSize : 0, driveOffset: session.completed ? session.totalSize : 0, tail: new Uint8Array(), expires: Date.now() + LIFETIME };
                await this.ctx.storage.transaction(async transaction => {
                    await transaction.put('upload', state!);
                    await transaction.setAlarm(state!.expires);
                });
                return this.response(state, 201);
            }
            if (!state || state.expires <= Date.now() || request.headers.get('x-tus-owner') !== state.owner) {
                return this.response(undefined, 404, 'Session not found');
            }
            if (request.headers.get('Tus-Resumable') !== '1.0.0') {
                const response = this.response(undefined, 412, 'Unsupported TUS version');
                response.headers.set('Tus-Version', '1.0.0');
                return response;
            }
            if (request.method === 'HEAD') {
                await this.drain(state, true);
                return this.response(state, 200);
            }
            if (request.method === 'PATCH') return await this.patch(request, state);
            return this.response(undefined, 405, 'Method not allowed');
        } catch (error) {
            // A failed storage write must not expose an uncommitted offset.
            state = await this.ctx.storage.get<UploadState>('upload').catch(() => undefined);
            return this.response(state, error instanceof UploadError ? error.status : 503,
                error instanceof UploadError ? error.message : 'Upload temporarily unavailable');
        }
    }
}
