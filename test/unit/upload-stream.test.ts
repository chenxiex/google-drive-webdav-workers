import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { UPLOAD_CHUNK_SIZE, uploadChunks } from '../../src/webdav/upload-stream';
import { filledStream } from '../support/upload-stream';

describe('uploadChunks', () => {
	it('bounds assembly to one chunk plus lookahead and stops reading while the consumer waits', async () => {
		const pull = vi.fn();
		const cancel = vi.fn();
		const body = filledStream(4 * UPLOAD_CHUNK_SIZE, pull, cancel);
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
		const input = Buffer.alloc(UPLOAD_CHUNK_SIZE + 7, 19);
		input.fill(31, UPLOAD_CHUNK_SIZE);
		const body = new ReadableStream<Uint8Array>({ start(controller) {
			controller.enqueue(new Uint8Array(0));
			controller.enqueue(input);
			controller.enqueue(new Uint8Array(0));
			controller.close();
		} });
		const results: Array<[number, boolean]> = [];
		let offset = 0;
		for await (const { bytes, final } of uploadChunks(body)) {
			// Compare the borrowed buffer while still valid, with no payload copy.
			const actual = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			expect(actual.compare(input.subarray(offset, offset + bytes.length))).toBe(0);
			results.push([bytes.length, final]);
			offset += bytes.length;
		}
		expect(results).toEqual([[UPLOAD_CHUNK_SIZE, false], [7, true]]);
		expect(body.locked).toBe(false);
	});
});
