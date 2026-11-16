// Drive requires non-final chunks to be multiples of 256 KiB.
export const UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024;

// Own buffering is bounded to one upload chunk plus the current input chunk.
// A one-read lookahead distinguishes exact chunk boundaries from EOF. No next
// upload chunk is assembled until the consumer has acknowledged this one.
// Yielded bytes borrow the buffer and remain valid only until the next read.
export async function* uploadChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<{ bytes: Uint8Array; final: boolean }> {
    const reader = body.getReader();
    let pending: Uint8Array = new Uint8Array(0);
    let done = false;
    const buffer = new Uint8Array(UPLOAD_CHUNK_SIZE);
    try {
        while (true) {
            let size = 0;
            while (true) {
                while (!pending.length && !done) {
                    const next = await reader.read();
                    done = next.done;
                    pending = next.value ?? new Uint8Array(0);
                }
                if (done || size === buffer.length) break;
                const take = Math.min(pending.length, buffer.length - size);
                buffer.set(pending.subarray(0, take), size);
                size += take;
                pending = pending.subarray(take);
            }
            yield { bytes: buffer.subarray(0, size), final: done };
            if (done) return;
        }
    } finally {
        if (!done) { try { await reader.cancel(); } catch {} }
        reader.releaseLock();
    }
}
