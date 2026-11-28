import { describe, expect, it, vi } from 'vitest';
import {
	type DriveBatchRequest,
	MAX_BATCH_SIZE,
	executeBatchWithRetry,
	parseBatchResponse,
	serializeBatchRequest,
} from '../../src/drive/batch';
import { setFetchMock } from '../support/network';

const noopDelay = async () => {};

function batchHttpResponse(boundary: string, parts: Array<{ id: string; status: number; headers?: Record<string, string>; body?: string }>): Response {
	const chunks = parts.map(p => {
		const body = p.body ?? '';
		const headerLines = Object.entries({
			'Content-Type': 'application/json; charset=UTF-8',
			'Content-Length': String(new TextEncoder().encode(body).byteLength),
			...p.headers,
		}).map(([k, v]) => `${k}: ${v}`).join('\r\n');
		return `\r\n--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-${p.id}>\r\n\r\nHTTP/1.1 ${p.status} Status\r\n${headerLines}\r\n\r\n${body}`;
	});
	return new Response(chunks.join('') + `\r\n--${boundary}--\r\n`, {
		status: 200,
		headers: { 'Content-Type': `multipart/mixed; boundary=${boundary}` },
	});
}

describe('Drive batch serialization and parsing', () => {
	it('serializes GET without body and POST with UTF-8 byte Content-Length', () => {
		const payload = { name: '文件夹-αβγ', parents: ['p1'] };
		const expectedBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
		const serialized = serializeBatchRequest([
			{ id: 'g0', method: 'GET', path: '/drive/v3/files?q=test' },
			{ id: 'p1', method: 'POST', path: '/drive/v3/files?fields=id', body: payload },
		], 'b_test');

		expect(serialized).toContain('--b_test\r\nContent-Type: application/http\r\nContent-ID: <g0>\r\n\r\nGET /drive/v3/files?q=test HTTP/1.1\r\n\r\n\r\n');
		expect(serialized).toContain(`Content-Length: ${expectedBytes}\r\n\r\n${JSON.stringify(payload)}\r\n--b_test--\r\n`);
		expect(expectedBytes).toBeGreaterThan(JSON.stringify(payload).length);
	});

	it.each([0, MAX_BATCH_SIZE + 1])('rejects invalid batch size %i', count => {
		const reqs: DriveBatchRequest[] = Array.from({ length: count }, (_, i) => ({
			id: 'r' + i,
			method: 'GET',
			path: '/drive/v3/files/root',
		}));
		expect(() => serializeBatchRequest(reqs, 'b_limit')).toThrow();
	});

	it('parses quoted/unquoted boundaries, out-of-order response IDs, and error JSON', () => {
		const raw = [
			'\r\n--b_resp\r\nContent-Type: application/http\r\nContent-ID: response-second\r\n\r\nHTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"error":{"message":"missing"}}',
			'\r\n--b_resp\r\nContent-Type: application/http\r\nContent-ID: <response-first>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Custom: val\r\n\r\n{"id":"123"}',
			'\r\n--b_resp--\r\n',
		].join('');
		const parsed = parseBatchResponse('multipart/mixed; boundary="b_resp"', raw);
		expect(parsed.get('first')).toMatchObject({ id: 'first', status: 200, headers: { 'x-custom': 'val' }, json: { id: '123' } });
		expect(parsed.get('second')).toMatchObject({ id: 'second', status: 404, json: { error: { message: 'missing' } } });
	});

	it.each([
		['missing boundary', 'application/json', '--b--\r\n'],
		['truncated body', 'multipart/mixed; boundary=b', '--b\r\nContent-Type: application/http\r\nContent-ID: <response-a>\r\n\r\nHTTP/1.1 200 OK\r\n\r\n{}'],
		['missing Content-ID', 'multipart/mixed; boundary=b', '--b\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\n\r\n{}\r\n--b--\r\n'],
		['duplicate Content-ID', 'multipart/mixed; boundary=b', '--b\r\nContent-Type: application/http\r\nContent-ID: <response-a>\r\n\r\nHTTP/1.1 200 OK\r\n\r\n{}\r\n--b\r\nContent-Type: application/http\r\nContent-ID: <response-a>\r\n\r\nHTTP/1.1 200 OK\r\n\r\n{}\r\n--b--\r\n'],
		['malformed HTTP status', 'multipart/mixed; boundary=b', '--b\r\nContent-Type: application/http\r\nContent-ID: <response-a>\r\n\r\nNOT_HTTP\r\n\r\n--b--\r\n'],
	])('throws 502 TransferError on %s', (_, ct, body) => {
		expect(() => parseBatchResponse(ct, body)).toThrow(expect.objectContaining({ status: 502, definitive: false }));
	});
});

describe('executeBatchWithRetry', () => {
	it('chunks >100 requests and retries only transient 429/5xx sub-items without re-running succeeded siblings', async () => {
		const reqs: DriveBatchRequest[] = Array.from({ length: 102 }, (_, i) => ({
			id: `r${i}`,
			method: 'POST',
			path: '/drive/v3/files?fields=id',
			body: { name: `f${i}` },
		}));
		const seenBatches: string[][] = [];
		const delays: number[] = [];
		let callCount = 0;

		setFetchMock(vi.fn(async (_input: any, init?: RequestInit) => {
			callCount++;
			const ct = (init?.headers as Record<string, string>)['Content-Type'];
			const boundary = ct.match(/boundary=([^\s;]+)/)![1];
			const body = String(init?.body ?? '');
			const ids = [...body.matchAll(/Content-ID: <([^>]+)>/g)].map(m => m[1]);
			seenBatches.push(ids);

			if (callCount === 1) {
				expect(ids).toHaveLength(100);
				return batchHttpResponse(boundary, ids.map(id =>
					id === 'r5'
						? { id, status: 429, headers: { 'Retry-After': '0' }, body: '{"error":{"message":"rate"}}' }
						: id === 'r99'
							? { id, status: 503, body: '{"error":{"message":"unavailable"}}' }
							: { id, status: 200, body: JSON.stringify({ id: `out-${id}` }) },
				));
			}
			if (callCount === 2) {
				expect(ids).toEqual(['r5', 'r99']);
				return batchHttpResponse(boundary, [
					{ id: 'r5', status: 200, body: '{"id":"out-r5"}' },
					{ id: 'r99', status: 500, body: '{"error":{"message":"retry once more"}}' },
				]);
			}
			if (callCount === 3) {
				expect(ids).toEqual(['r99']);
				return batchHttpResponse(boundary, [{ id: 'r99', status: 200, body: '{"id":"out-r99"}' }]);
			}
			expect(ids).toEqual(['r100', 'r101']);
			return batchHttpResponse(boundary, ids.map(id => ({ id, status: 200, body: JSON.stringify({ id: `out-${id}` }) })));
		}));

		const budget = { usedBatches: 0, maxBatches: 10 };
		const res = await executeBatchWithRetry(reqs, async () => 'tok', budget, { delay: async ms => { delays.push(ms); } });
		expect(res).toHaveLength(102);
		expect(res.every(r => r.status === 200)).toBe(true);
		expect(res[5].json.id).toBe('out-r5');
		expect(res[99].json.id).toBe('out-r99');
		expect(res[101].json.id).toBe('out-r101');
		expect(budget.usedBatches).toBe(4);
		expect(delays).toEqual([0, 300]);
	});

	it.each([
		[403, 1],
		[503, 3],
	])('returns sub-item status %i after %i batch attempts', async (status, attempts) => {
		const reqs: DriveBatchRequest[] = [{ id: 'r0', method: 'POST', path: '/drive/v3/files', body: { name: 'a' } }];
		setFetchMock(async (_input: any, init?: RequestInit) => {
			const boundary = (init?.headers as Record<string, string>)['Content-Type'].match(/boundary=([^\s;]+)/)![1];
			return batchHttpResponse(boundary, [{ id: 'r0', status, body: '{"error":{"message":"failed"}}' }]);
		});
		const budget = { usedBatches: 0, maxBatches: 5 };
		const result = await executeBatchWithRetry(reqs, async () => 'tok', budget, { delay: noopDelay });
		expect(result[0].status).toBe(status);
		expect(budget.usedBatches).toBe(attempts);
	});

	it('retries outer 503 and rejects with 413 when batch budget is exhausted', async () => {
		const reqs: DriveBatchRequest[] = [{ id: 'r0', method: 'GET', path: '/drive/v3/files/root' }];
		let calls = 0;
		setFetchMock(vi.fn(async (_input: any, init?: RequestInit) => {
			calls++;
			if (calls === 1) return new Response('try again', { status: 503 });
			const boundary = (init?.headers as Record<string, string>)['Content-Type'].match(/boundary=([^\s;]+)/)![1];
			return batchHttpResponse(boundary, [{ id: 'r0', status: 200, body: '{"id":"root"}' }]);
		}));

		const okBudget = { usedBatches: 0, maxBatches: 2 };
		const res = await executeBatchWithRetry(reqs, async () => 'tok', okBudget, { delay: noopDelay });
		expect(res[0].status).toBe(200);
		expect(okBudget.usedBatches).toBe(2);

		await expect(executeBatchWithRetry(reqs, async () => 'tok', { usedBatches: 2, maxBatches: 2 }, { delay: noopDelay }))
			.rejects.toMatchObject({ status: 413 });
	});

	it('throws 502 when a batch response omits a pending Content-ID', async () => {
		const reqs: DriveBatchRequest[] = [
			{ id: 'r0', method: 'GET', path: '/drive/v3/files/root' },
			{ id: 'r1', method: 'GET', path: '/drive/v3/files/root' },
		];
		setFetchMock(vi.fn(async (_input: any, init?: RequestInit) => {
			const boundary = (init?.headers as Record<string, string>)['Content-Type'].match(/boundary=([^\s;]+)/)![1];
			return batchHttpResponse(boundary, [{ id: 'r0', status: 200, body: '{"id":"root"}' }]);
		}));
		await expect(executeBatchWithRetry(reqs, async () => 'tok', { usedBatches: 0, maxBatches: 5 }, { delay: noopDelay }))
			.rejects.toMatchObject({ status: 502, definitive: false });
	});
});
