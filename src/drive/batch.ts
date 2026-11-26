import { StatusError, TransferError } from '../http';

export const MAX_BATCH_SIZE = 100;
export const MAX_BATCH_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 1000;

export interface DriveBatchRequest {
    id: string;
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    body?: Record<string, unknown>;
}

export interface DriveBatchResponse {
    id: string;
    status: number;
    headers: Record<string, string>;
    text: string;
    json?: any;
}

export interface BatchBudget {
    usedBatches: number;
    maxBatches: number;
}

export interface BatchExecutionOptions {
    delay?: (ms: number) => Promise<void>;
    maxRetries?: number;
}

const encoder = new TextEncoder();

export function serializeBatchRequest(requests: readonly DriveBatchRequest[], boundary: string): string {
    if (!boundary || /[\r\n]/.test(boundary)) {
        throw new Error('Invalid multipart batch boundary');
    }
    if (requests.length === 0 || requests.length > MAX_BATCH_SIZE) {
        throw new Error(`Batch request count must be between 1 and ${MAX_BATCH_SIZE}, got ${requests.length}`);
    }
    const seenIds = new Set<string>();
    const parts: string[] = [];
    for (const req of requests) {
        if (!req.id || seenIds.has(req.id)) {
            throw new Error(`Batch request ID must be non-empty and unique: "${req.id}"`);
        }
        seenIds.add(req.id);
        let part = `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <${req.id}>\r\n\r\n${req.method} ${req.path} HTTP/1.1\r\n`;
        if (req.body !== undefined) {
            const payload = JSON.stringify(req.body);
            const byteLength = encoder.encode(payload).byteLength;
            part += `Content-Type: application/json; charset=UTF-8\r\nContent-Length: ${byteLength}\r\n\r\n${payload}\r\n`;
        } else {
            part += '\r\n\r\n';
        }
        parts.push(part);
    }
    return parts.join('') + `--${boundary}--\r\n`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseHeaderBlock(headerText: string): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const line of headerText.split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        headers[name] = value;
    }
    return headers;
}

function extractBoundary(contentType: string | null): string {
    const ct = contentType ?? '';
    const match = ct.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
    if (!/^multipart\/mixed\b/i.test(ct) || !match) {
        throw new TransferError('Malformed Drive batch response content type', 502, false);
    }
    return match[1] ?? match[2];
}

function splitMultipartParts(rawBody: string, boundary: string): string[] {
    const delimiter = new RegExp(`(?:^|\\r?\\n)--${escapeRegExp(boundary)}(--)?(?:\\r?\\n|$)`, 'g');
    const parts: string[] = [];
    let partStart = -1;
    let closed = false;
    let match: RegExpExecArray | null;
    while ((match = delimiter.exec(rawBody)) !== null) {
        if (partStart >= 0) {
            parts.push(rawBody.slice(partStart, match.index));
        }
        if (match[1] === '--') {
            closed = true;
            break;
        }
        partStart = delimiter.lastIndex;
    }
    if (!closed) {
        throw new TransferError('Truncated Drive batch response', 502, false);
    }
    return parts;
}

export function parseBatchResponse(contentType: string | null, rawBody: string): Map<string, DriveBatchResponse> {
    const boundary = extractBoundary(contentType);
    const parts = splitMultipartParts(rawBody, boundary);
    const results = new Map<string, DriveBatchResponse>();

    for (const part of parts) {
        const outerSep = part.match(/\r?\n\r?\n/);
        if (!outerSep || outerSep.index === undefined) {
            throw new TransferError('Malformed Drive batch response part', 502, false);
        }
        const outerHeaders = parseHeaderBlock(part.slice(0, outerSep.index));
        const innerRaw = part.slice(outerSep.index + outerSep[0].length);

        let id = (outerHeaders['content-id'] ?? '').trim();
        if (id.startsWith('<') && id.endsWith('>')) id = id.slice(1, -1).trim();
        if (id.startsWith('response-')) id = id.slice('response-'.length);
        if (!id || results.has(id)) {
            throw new TransferError('Invalid or duplicate Content-ID in Drive batch response', 502, false);
        }

        const innerSep = innerRaw.match(/\r?\n\r?\n/);
        const innerHeadText = innerSep && innerSep.index !== undefined ? innerRaw.slice(0, innerSep.index) : innerRaw;
        const innerBody = innerSep && innerSep.index !== undefined ? innerRaw.slice(innerSep.index + innerSep[0].length) : '';
        const headLines = innerHeadText.split(/\r?\n/);
        const statusMatch = headLines[0]?.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+.*)?$/);
        if (!statusMatch) {
            throw new TransferError('Malformed inner HTTP status in Drive batch response', 502, false);
        }

        const status = Number(statusMatch[1]);
        const innerHeaders = parseHeaderBlock(headLines.slice(1).join('\n'));
        let json: any;
        if (innerBody.length > 0) {
            try {
                json = JSON.parse(innerBody);
            } catch {
                // Non-JSON error bodies remain available in `text`.
            }
        }
        results.set(id, { id, status, headers: innerHeaders, text: innerBody, ...(json !== undefined ? { json } : {}) });
    }

    return results;
}

function computeRetryDelay(attempt: number, retryAfter: string | null | undefined): number {
    if (retryAfter && /^\d+$/.test(retryAfter.trim())) {
        return Math.min(MAX_RETRY_DELAY_MS, Number(retryAfter.trim()) * 1000);
    }
    return Math.min(MAX_RETRY_DELAY_MS, 150 * (attempt + 1));
}

function isTransientBatchStatus(status: number): boolean {
    return status === 429 || (status >= 500 && status <= 599);
}

export async function executeBatchWithRetry(
    requests: readonly DriveBatchRequest[],
    getAccessToken: () => Promise<string>,
    budget: BatchBudget,
    options: BatchExecutionOptions = {},
): Promise<DriveBatchResponse[]> {
    if (requests.length === 0) return [];
    const delay = options.delay ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const maxRetries = options.maxRetries ?? MAX_BATCH_RETRIES;
    const results = new Map<string, DriveBatchResponse>();

    for (let offset = 0; offset < requests.length; offset += MAX_BATCH_SIZE) {
        let pending = requests.slice(offset, offset + MAX_BATCH_SIZE);
        let attempt = 0;
        let chunkFailed = false;

        while (pending.length > 0) {
            if (budget.usedBatches >= budget.maxBatches) {
                throw new StatusError(`Folder COPY exceeds batch request budget (${budget.maxBatches})`, 413);
            }
            budget.usedBatches++;

            const boundary = 'batch_' + crypto.randomUUID().replace(/-/g, '');
            const response = await fetch('https://www.googleapis.com/batch/drive/v3', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer ' + (await getAccessToken()),
                    'Content-Type': `multipart/mixed; boundary=${boundary}`,
                },
                body: serializeBatchRequest(pending, boundary),
            });

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                if (isTransientBatchStatus(response.status) && attempt < maxRetries) {
                    await delay(computeRetryDelay(attempt, response.headers.get('Retry-After')));
                    attempt++;
                    continue;
                }
                throw new TransferError(
                    'Drive batch request failed: ' + errText,
                    response.status,
                    response.status >= 400 && response.status < 500 && response.status !== 408,
                );
            }

            const rawResponse = new TextDecoder().decode(await response.arrayBuffer());
            const parsed = parseBatchResponse(response.headers.get('Content-Type'), rawResponse);
            for (const req of pending) {
                if (!parsed.has(req.id)) {
                    throw new TransferError('Incomplete Drive batch response for ' + req.id, 502, false);
                }
            }

            const retryable: DriveBatchRequest[] = [];
            let hasNonRetriableFailure = false;
            let retryAfterHeader: string | undefined;
            for (const req of pending) {
                const res = parsed.get(req.id)!;
                if (res.status >= 200 && res.status < 300) {
                    results.set(req.id, res);
                } else if (isTransientBatchStatus(res.status)) {
                    retryable.push(req);
                    retryAfterHeader ??= res.headers['retry-after'];
                } else {
                    results.set(req.id, res);
                    hasNonRetriableFailure = true;
                }
            }

            if (hasNonRetriableFailure || retryable.length === 0 || attempt >= maxRetries) {
                for (const req of retryable) {
                    results.set(req.id, parsed.get(req.id)!);
                }
                chunkFailed = hasNonRetriableFailure || retryable.length > 0;
                break;
            }

            await delay(computeRetryDelay(attempt, retryAfterHeader));
            pending = retryable;
            attempt++;
        }

        if (chunkFailed) break;
    }

    return requests.filter(req => results.has(req.id)).map(req => results.get(req.id)!);
}
