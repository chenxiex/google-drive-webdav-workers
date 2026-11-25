import { describe, expect, it, vi } from 'vitest';
import { UPLOAD_CHUNK_SIZE, uploadChunks } from '../../src/webdav/upload-stream';

// Zero queueing makes the producer's reads observable independently of
// the request transport's own buffering.
function stream(size: number, onPull = () => {}, onCancel = () => {}): ReadableStream<Uint8Array> {
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			onPull();
			if (offset === size) { controller.close(); return; }
			const length = Math.min(256 * 1024, size - offset);
			controller.enqueue(new Uint8Array(length).fill(97));
			offset += length;
		},
		cancel: onCancel,
	}, { highWaterMark: 0 });
}

describe('uploadChunks', () => {
	it('bounds assembly to one chunk plus lookahead and stops reading while the consumer waits', async () => {
		const pull = vi.fn();
		const cancel = vi.fn();
		const body = stream(4 * UPLOAD_CHUNK_SIZE, pull, cancel);
		const chunks = uploadChunks(body);
		const first = await chunks.next();
		expect(first.value?.bytes.length).toBe(UPLOAD_CHUNK_SIZE);
		expect(first.value?.final).toBe(false);
		expect(pull).toHaveBeenCalledTimes(UPLOAD_CHUNK_SIZE / (256 * 1024) + 1);
		await Promise.resolve();
		expect(pull).toHaveBeenCalledTimes(UPLOAD_CHUNK_SIZE / (256 * 1024) + 1);
		await chunks.return(undefined);
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});

	it('splits oversized input chunks and ignores empty input chunks without losing bytes', async () => {
		const input = new Uint8Array(UPLOAD_CHUNK_SIZE + 7).fill(19);
		input.fill(31, UPLOAD_CHUNK_SIZE);
		const body = new ReadableStream<Uint8Array>({ start(controller) {
			controller.enqueue(new Uint8Array(0));
			controller.enqueue(input);
			controller.enqueue(new Uint8Array(0));
			controller.close();
		} });
		const results = [];
		for await (const chunk of uploadChunks(body)) {
			// The assembler reuses its bounded buffer on the next iteration.
			results.push({ bytes: chunk.bytes.slice(), final: chunk.final });
		}
		expect(results.map(chunk => [chunk.bytes.length, chunk.final])).toEqual([[UPLOAD_CHUNK_SIZE, false], [7, true]]);
		expect(results[0].bytes.every(byte => byte === 19)).toBe(true);
		expect(results[1].bytes).toEqual(new Uint8Array(7).fill(31));
		expect(body.locked).toBe(false);
	});
});
