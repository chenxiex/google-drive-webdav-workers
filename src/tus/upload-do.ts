import { DurableObject } from 'cloudflare:workers';
import { type UploadedDriveFile } from '../drive/types';
import { StatusError } from '../http';
import {
    DRIVE_FLUSH_SIZE,
    type ExpectedChecksum,
    MAX_TUS_REQUEST_BYTES,
    TUS_ALIGNMENT,
    TUS_CHECKSUM_ALGORITHMS,
    TUS_EXTENSIONS,
    TUS_VERSION,
    applyCompletionHeaders,
    isOffsetStreamContentType,
    parseDriveUploadResponse,
    parseNonNegativeInt,
    parseUploadChecksum,
    readBoundedBody,
    verifyChunkChecksum,
    verifyDriveChecksums,
} from './protocol';

const LIFETIME = 24 * 60 * 60 * 1000;

export interface TusSession {
    uploadUrl: string;
    totalSize: number;
    targetPath: string;
    parentId: string;
    owner: string;
    existingFileId: string | null;
    expectedChecksums: ExpectedChecksum[];
}

interface UploadState extends TusSession {
    offset: number;
    driveOffset: number;
    tail: Uint8Array;
    inflight: boolean;
    expires: number;
}

// Persist only the < 256 KiB unaligned tail and an inflight marker in SQLite;
// aligned <= 10 MiB blocks stream directly to Drive and recover via bytes */total.
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
        const headers = new Headers({
            'Tus-Resumable': TUS_VERSION,
            'Tus-Extension': TUS_EXTENSIONS,
            'Tus-Checksum-Algorithm': TUS_CHECKSUM_ALGORITHMS,
            'Cache-Control': 'no-store',
        });
        if (state) {
            headers.set('Upload-Offset', String(state.offset));
            headers.set('Upload-Length', String(state.totalSize));
        }
        return new Response(message ?? null, { status, headers });
    }

    private async save(state: UploadState): Promise<void> {
        await this.ctx.storage.put('upload', state);
    }

    private async clearStorage(): Promise<void> {
        await this.ctx.storage.deleteAlarm().catch(() => undefined);
        await this.ctx.storage.deleteAll().catch(() => undefined);
    }

    private async finalizeCompleted(state: UploadState, file: UploadedDriveFile, successStatus: number): Promise<Response> {
        const checksumOk = verifyDriveChecksums(state.expectedChecksums ?? [], file, false);
        await this.clearStorage();

        if (!checksumOk) {
            const response = this.response(undefined, 460, 'Checksum mismatch');
            response.headers.set('x-tus-checksum-mismatch', '1');
            response.headers.set('x-tus-is-new', state.existingFileId ? '0' : '1');
            response.headers.set('x-tus-target-path', encodeURIComponent(state.targetPath));
            response.headers.set('x-tus-parent-id', state.parentId);
            if (typeof file.id === 'string' && file.id) {
                response.headers.set('x-tus-file-id', file.id);
            }
            return response;
        }

        const headers = new Headers({
            'Tus-Resumable': TUS_VERSION,
            'Tus-Extension': TUS_EXTENSIONS,
            'Tus-Checksum-Algorithm': TUS_CHECKSUM_ALGORITHMS,
            'Cache-Control': 'no-store',
            'Upload-Offset': String(state.totalSize),
            'Upload-Length': String(state.totalSize),
            'x-tus-complete': '1',
            'x-tus-target-path': encodeURIComponent(state.targetPath),
            'x-tus-parent-id': state.parentId,
        });
        if (typeof file.id === 'string' && file.id) {
            headers.set('x-tus-file-id', file.id);
        }
        applyCompletionHeaders(headers, file);
        return new Response(null, { status: successStatus, headers });
    }

    private applyConfirmedRange(state: UploadState, confirmedOffset: number, maxAllowedOffset: number): void {
        if (confirmedOffset < state.driveOffset || confirmedOffset > maxAllowedOffset) {
            throw new StatusError('Inconsistent Drive upload offset', 502);
        }
        if (confirmedOffset > state.driveOffset) {
            const previousDriveOffset = state.driveOffset;
            state.driveOffset = confirmedOffset;
            if (confirmedOffset >= state.offset) {
                state.tail = new Uint8Array();
                state.offset = confirmedOffset;
            } else {
                state.tail = state.tail.subarray(confirmedOffset - previousDriveOffset);
            }
        }
    }

    private async recoverInflight(state: UploadState): Promise<UploadedDriveFile | null> {
        if (!state.inflight) return null;
        const response = await fetch(state.uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Length': '0', 'Content-Range': `bytes */${state.totalSize}` },
        });
        const result = await parseDriveUploadResponse(response, state.totalSize);
        if (result.completed) {
            return result.file;
        }
        this.applyConfirmedRange(state, result.confirmedOffset, state.totalSize - 1);
        state.inflight = false;
        await this.save(state);
        return null;
    }

    private async flushBytes(state: UploadState, chunk: Uint8Array): Promise<UploadedDriveFile | null> {
        if (!chunk.byteLength) return null;

        const isFinal = state.offset + chunk.byteLength === state.totalSize;
        if (!isFinal && state.tail.byteLength + chunk.byteLength < TUS_ALIGNMENT) {
            const nextTail = new Uint8Array(state.tail.byteLength + chunk.byteLength);
            nextTail.set(state.tail);
            nextTail.set(chunk, state.tail.byteLength);
            state.tail = nextTail;
            state.offset += chunk.byteLength;
            await this.save(state);
            return null;
        }

        const bufferStart = state.driveOffset;
        let buffer: Uint8Array;
        if (state.tail.byteLength === 0) {
            buffer = chunk;
        } else {
            buffer = new Uint8Array(state.tail.byteLength + chunk.byteLength);
            buffer.set(state.tail);
            buffer.set(chunk, state.tail.byteLength);
        }

        const sendTotal = isFinal ? buffer.byteLength : Math.floor(buffer.byteLength / TUS_ALIGNMENT) * TUS_ALIGNMENT;
        const newTail = sendTotal < buffer.byteLength ? buffer.slice(sendTotal) : new Uint8Array();
        let sent = 0;

        while (sent < sendTotal) {
            const sliceLen = Math.min(DRIVE_FLUSH_SIZE, sendTotal - sent);
            const sliceStart = bufferStart + sent;
            const sliceEnd = sliceStart + sliceLen;
            state.inflight = true;
            await this.save(state);

            const response = await fetch(state.uploadUrl, {
                method: 'PUT',
                headers: {
                    'Content-Length': String(sliceLen),
                    'Content-Range': `bytes ${sliceStart}-${sliceEnd - 1}/${state.totalSize}`,
                },
                body: buffer.subarray(sent, sent + sliceLen),
            });
            const result = await parseDriveUploadResponse(response, state.totalSize);
            if (result.completed) {
                return result.file;
            }
            const before = state.driveOffset;
            this.applyConfirmedRange(state, result.confirmedOffset, sliceEnd);
            if (state.driveOffset === before) {
                throw new StatusError('Drive did not acknowledge upload bytes', 503);
            }
            sent = state.driveOffset - bufferStart;
        }

        state.tail = newTail;
        state.offset = bufferStart + buffer.byteLength;
        state.inflight = false;
        await this.save(state);
        return null;
    }

    private async initialize(request: Request, existing: UploadState | undefined): Promise<Response> {
        if (existing) throw new StatusError('Session already exists', 409);
        const rawSession = request.headers.get('x-tus-session');
        if (!rawSession) throw new StatusError('Invalid upload session', 400);
        let session: TusSession;
        try {
            session = JSON.parse(decodeURIComponent(rawSession)) as TusSession;
        } catch {
            throw new StatusError('Invalid upload session', 400);
        }
        if (!Number.isSafeInteger(session.totalSize) || session.totalSize <= 0 || !session.owner || !session.uploadUrl) {
            throw new StatusError('Invalid upload session', 400);
        }
        const state: UploadState = {
            ...session,
            expectedChecksums: Array.isArray(session.expectedChecksums) ? session.expectedChecksums : [],
            offset: 0,
            driveOffset: 0,
            tail: new Uint8Array(),
            inflight: false,
            expires: Date.now() + LIFETIME,
        };
        await this.ctx.storage.transaction(async transaction => {
            await transaction.put('upload', state);
            await transaction.setAlarm(state.expires);
        });

        const initialBytes = request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array(0);
        if (initialBytes.byteLength > 0) {
            try {
                const completed = await this.flushBytes(state, initialBytes);
                if (completed) {
                    return await this.finalizeCompleted(state, completed, 201);
                }
            } catch (error) {
                await this.clearStorage();
                throw error;
            }
        }
        return this.response(state, 201);
    }

    private async patch(request: Request, state: UploadState): Promise<Response> {
        if (!isOffsetStreamContentType(request.headers.get('Content-Type'))) {
            throw new StatusError('Expected application/offset+octet-stream', 415);
        }
        const offset = parseNonNegativeInt(request.headers.get('Upload-Offset'));
        if (offset === null) throw new StatusError('Invalid Upload-Offset', 400);
        const lengthHeader = request.headers.get('Content-Length');
        const declaredLength = parseNonNegativeInt(lengthHeader);
        if (lengthHeader !== null && declaredLength === null) throw new StatusError('Invalid Content-Length', 400);
        if (declaredLength !== null && declaredLength > MAX_TUS_REQUEST_BYTES) {
            throw new StatusError('Upload exceeds maximum allowed size', 413);
        }
        const checksumHeader = request.headers.get('Upload-Checksum');
        if (checksumHeader !== null) parseUploadChecksum(checksumHeader);

        const recoveredCompletion = await this.recoverInflight(state);
        if (recoveredCompletion) {
            return await this.finalizeCompleted(state, recoveredCompletion, 409);
        }
        if (offset !== state.offset) {
            return this.response(state, 409, 'Upload offset mismatch');
        }
        if (declaredLength !== null && declaredLength > state.totalSize - state.offset) {
            throw new StatusError('Upload exceeds declared length', 413);
        }

        const chunkBytes = await readBoundedBody(request.body, {
            maxBytes: Math.min(MAX_TUS_REQUEST_BYTES, state.totalSize - state.offset),
            declaredLength,
        });
        if (checksumHeader !== null) {
            await verifyChunkChecksum(checksumHeader, chunkBytes);
        }

        const completed = await this.flushBytes(state, chunkBytes);
        if (completed) {
            return await this.finalizeCompleted(state, completed, 204);
        }
        return this.response(state, 204);
    }

    private async handle(request: Request): Promise<Response> {
        let state: UploadState | undefined;
        try {
            state = await this.ctx.storage.get<UploadState>('upload');
            if (request.method === 'POST' && new URL(request.url).pathname === '/initialize') {
                return await this.initialize(request, state);
            }
            if (!state || request.headers.get('x-tus-owner') !== state.owner) {
                return this.response(undefined, 404, 'Session not found');
            }
            if (state.expires <= Date.now()) {
                await this.clearStorage();
                return this.response(undefined, 404, 'Session not found');
            }
            const versionHeader = request.headers.get('Tus-Resumable');
            const validVersion = request.method === 'HEAD'
                ? (!versionHeader || versionHeader === TUS_VERSION)
                : versionHeader === TUS_VERSION;
            if (!validVersion) {
                const response = this.response(undefined, 412, 'Unsupported TUS version');
                response.headers.set('Tus-Version', TUS_VERSION);
                return response;
            }
            if (request.method === 'HEAD') {
                const recoveredCompletion = await this.recoverInflight(state);
                if (recoveredCompletion) {
                    return await this.finalizeCompleted(state, recoveredCompletion, 200);
                }
                return this.response(state, 200);
            }
            if (request.method === 'PATCH') {
                return await this.patch(request, state);
            }
            return this.response(undefined, 405, 'Method not allowed');
        } catch (error) {
            // A failed storage write must not expose an uncommitted offset.
            state = await this.ctx.storage.get<UploadState>('upload').catch(() => undefined);
            const status = error instanceof StatusError ? error.status : 503;
            const message = error instanceof StatusError ? error.message : 'Upload temporarily unavailable';
            return this.response(state, status, message);
        }
    }
}
