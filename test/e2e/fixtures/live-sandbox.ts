import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import process from 'node:process';
import { URL } from 'node:url';

const STREAM_BLOCK_SIZE = 64 * 1024;
const BASE_PATTERN = Buffer.allocUnsafe(STREAM_BLOCK_SIZE);
for (let i = 0; i < BASE_PATTERN.length; i++) {
	BASE_PATTERN[i] = ((i * 73) ^ (i >> 8) ^ 0x5a) & 0xff;
}

export interface LiveConfig {
	origin: string;
	basePath: string;
	authHeader: string;
	gateHeaders: Record<string, string>;
}

export interface LiveResponse {
	status: number;
	headers: http.IncomingHttpHeaders;
	bytes: number;
	sha256: string | null;
	bodyText: string;
	durationMs: number;
}

export interface LiveRequestOptions {
	url: string;
	method: string;
	headers?: Record<string, string>;
	bodyBuffer?: Buffer;
	streamRange?: { startOffset: number; length: number; hash?: crypto.Hash };
	hashResponse?: boolean;
	timeoutMs?: number;
}

export interface LiveSandbox {
	config: LiveConfig;
	baseUrl: string;
	sandboxName: string;
	sandboxUrl: string;
	fileUrl: (name: string) => string;
	request: (opts: LiveRequestOptions) => Promise<LiveResponse>;
	putStream: (name: string, totalBytes: number) => Promise<{
		status: number;
		headers: http.IncomingHttpHeaders;
		sha256: string;
		bytes: number;
		durationMs: number;
	}>;
	getAndHash: (name: string, headers?: Record<string, string>) => Promise<LiveResponse>;
	tusUpload: (name: string, totalBytes: number, chunkBytes: number) => Promise<{
		chunks: number;
		sha256: string;
		bytes: number;
		location: string;
		durationMs: number;
	}>;
	cleanup: () => Promise<void>;
}

function parseEnvFile(filePath: string): Map<string, string> {
	const result = new Map<string, string>();
	if (!existsSync(filePath)) return result;
	const text = readFileSync(filePath, 'utf8');
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eqIndex = trimmed.indexOf('=');
		if (eqIndex === -1) continue;
		const key = trimmed.slice(0, eqIndex).trim().replace(/^export\s+/, '');
		if (!key) continue;
		let value = trimmed.slice(eqIndex + 1).trim();
		const quote = value[0] === '"' || value[0] === "'" ? value[0] : null;
		if (quote) {
			if (value.length >= 2 && value.endsWith(quote)) {
				value = value.slice(1, -1);
			} else {
				const parts = [value.slice(1)];
				let closed = false;
				while (++i < lines.length) {
					const endTrimmed = lines[i].trimEnd();
					if (endTrimmed.endsWith(quote)) {
						parts.push(endTrimmed.slice(0, -1));
						closed = true;
						break;
					}
					parts.push(lines[i]);
				}
				if (!closed) {
					throw new Error(`Unterminated quoted value for ${key} in ${filePath}`);
				}
				value = parts.join('\n');
			}
		}
		result.set(key, value);
	}
	return result;
}

function normalizeBasePath(raw: string): string {
	const trimmed = raw.trim().replace(/\/+$/, '');
	if (!trimmed || trimmed === '/') {
		throw new Error(`Invalid mount path "${raw}": cannot be empty or "/"`);
	}
	return (trimmed.startsWith('/') ? trimmed : '/' + trimmed) + '/';
}

function fillDeterministicSlice(scratch: Buffer, stampBuf: Buffer, absOffset: number, remaining: number): Buffer {
	const blockIndex = Math.floor(absOffset / STREAM_BLOCK_SIZE);
	const inBlock = absOffset % STREAM_BLOCK_SIZE;
	const take = Math.min(remaining, STREAM_BLOCK_SIZE - inBlock);
	BASE_PATTERN.copy(scratch, 0, inBlock, inBlock + take);
	if (inBlock < 8) {
		const high = Math.floor(blockIndex / 0x100000000) >>> 0;
		const low = blockIndex >>> 0;
		stampBuf.writeUInt32BE(high, 0);
		stampBuf.writeUInt32BE(low, 4);
		const stampTake = Math.min(8 - inBlock, take);
		stampBuf.copy(scratch, 0, inBlock, inBlock + stampTake);
	}
	return scratch.subarray(0, take);
}

/** Generate deterministic test bytes matching `streamRange` chunks for a given file offset. */
export function deterministicBytes(startOffset: number, length: number): Buffer {
	const out = Buffer.allocUnsafe(length);
	const scratch = Buffer.allocUnsafe(STREAM_BLOCK_SIZE);
	const stampBuf = Buffer.allocUnsafe(8);
	let pos = 0;
	while (pos < length) {
		const slice = fillDeterministicSlice(scratch, stampBuf, startOffset + pos, length - pos);
		slice.copy(out, pos);
		pos += slice.length;
	}
	return out;
}

/** Return lowercase hex SHA-256 digest for a byte buffer. */
export function sha256Hex(buffer: Uint8Array): string {
	return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Resolve live WebDAV target, credentials, and optional Edge gate header from env/.env without logging secrets. */
export function loadLiveConfig(envFile = '.env'): LiveConfig {
	const fileEnv = parseEnvFile(envFile);
	const getEnv = (key: string): string | undefined =>
		process.env[key] !== undefined ? process.env[key] : fileEnv.get(key);

	const rawUrl = getEnv('LIVE_WEBDAV_URL')?.trim();
	if (!rawUrl) {
		throw new Error('LIVE_WEBDAV_URL is required to run live E2E tests.');
	}
	const parsedUrl = new URL(rawUrl);
	if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
		throw new Error(`Unsupported LIVE_WEBDAV_URL protocol: ${parsedUrl.protocol}`);
	}

	const basePath = normalizeBasePath(getEnv('WEBDAV_PATH') || '/webdav/');

	let user = getEnv('LIVE_WEBDAV_USER')?.trim();
	let pass = getEnv('LIVE_WEBDAV_PASS');
	if (!user || pass === undefined) {
		const usersRaw = getEnv('USERS');
		if (!usersRaw) {
			throw new Error('Missing WebDAV credentials (set LIVE_WEBDAV_USER/LIVE_WEBDAV_PASS or USERS).');
		}
		const parsedUsers = JSON.parse(usersRaw) as Record<string, unknown>;
		const entries = parsedUsers && typeof parsedUsers === 'object' && !Array.isArray(parsedUsers)
			? Object.entries(parsedUsers)
			: [];
		if (entries.length === 0) {
			throw new Error('USERS JSON object is empty.');
		}
		if (user) {
			const candidate = parsedUsers[user];
			if (typeof candidate !== 'string') {
				throw new Error(`User "${user}" not found in USERS.`);
			}
			pass = candidate;
		} else {
			user = entries[0][0];
			pass = typeof entries[0][1] === 'string' ? entries[0][1] : String(entries[0][1]);
		}
	}
	if (!user || !pass) {
		throw new Error('WebDAV username and password must be non-empty.');
	}

	const gate = getEnv('X_DEV_GATE')?.trim();
	return {
		origin: parsedUrl.origin,
		basePath,
		authHeader: 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64'),
		gateHeaders: gate ? { 'X-Dev-Gate': gate } : {},
	};
}

async function sendStreamRequest({
	url,
	method,
	headers = {},
	bodyBuffer,
	streamRange,
	hashResponse = false,
	timeoutMs = 180_000,
}: LiveRequestOptions): Promise<LiveResponse> {
	const parsed = new URL(url);
	const transport = parsed.protocol === 'https:' ? https : http;
	const reqHeaders: http.OutgoingHttpHeaders = { ...headers };
	if (bodyBuffer !== undefined && reqHeaders['Content-Length'] === undefined) {
		reqHeaders['Content-Length'] = String(bodyBuffer.length);
	} else if (streamRange !== undefined && reqHeaders['Content-Length'] === undefined) {
		reqHeaders['Content-Length'] = String(streamRange.length);
	}

	const startedAt = Date.now();
	return new Promise<LiveResponse>((resolve, reject) => {
		let settled = false;
		let gotResponse = false;
		let stopWriting = false;
		let bytesSent = 0;
		let wakeDrain: (() => void) | null = null;

		const wake = () => {
			if (wakeDrain) {
				const fn = wakeDrain;
				wakeDrain = null;
				fn();
			}
		};

		const req = transport.request(parsed, { method, headers: reqHeaders, timeout: timeoutMs });

		req.on('timeout', () => {
			stopWriting = true;
			wake();
			req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${method} ${parsed.pathname}`));
		});

		req.on('error', (err) => {
			stopWriting = true;
			wake();
			if (gotResponse || settled) return;
			settled = true;
			reject(err);
		});

		req.on('response', (res) => {
			gotResponse = true;
			stopWriting = true;
			wake();

			const respHash = hashResponse ? crypto.createHash('sha256') : null;
			let respBytes = 0;
			const previewChunks: Buffer[] = [];
			let previewBytes = 0;

			res.on('data', (chunk: Buffer) => {
				respBytes += chunk.length;
				if (respHash) respHash.update(chunk);
				if (previewBytes < 4096) {
					const slice = chunk.subarray(0, 4096 - previewBytes);
					previewChunks.push(slice);
					previewBytes += slice.length;
				}
			});

			res.on('end', () => {
				if (settled) return;
				settled = true;
				resolve({
					status: res.statusCode ?? 0,
					headers: res.headers,
					bytes: respBytes,
					sha256: respHash ? respHash.digest('hex') : null,
					bodyText: Buffer.concat(previewChunks).toString('utf8'),
					durationMs: Date.now() - startedAt,
				});
			});

			res.on('error', (err) => {
				if (settled) return;
				settled = true;
				reject(err);
			});

			res.on('close', () => {
				if (settled) return;
				settled = true;
				reject(new Error(`Response closed prematurely (status ${res.statusCode ?? 0})`));
			});
		});

		const writeBody = async () => {
			if (bodyBuffer !== undefined) {
				if (bodyBuffer.length > 0 && !stopWriting) {
					req.write(bodyBuffer);
				}
				if (!stopWriting && !req.destroyed && !req.writableEnded) {
					req.end();
				}
				return;
			}

			if (streamRange !== undefined) {
				const scratch = Buffer.allocUnsafe(STREAM_BLOCK_SIZE);
				const stampBuf = Buffer.allocUnsafe(8);
				while (bytesSent < streamRange.length && !stopWriting && !req.destroyed && !req.writableEnded) {
					const slice = fillDeterministicSlice(
						scratch,
						stampBuf,
						streamRange.startOffset + bytesSent,
						streamRange.length - bytesSent,
					);
					if (streamRange.hash) streamRange.hash.update(slice);
					let canContinue: boolean;
					try {
						canContinue = req.write(slice);
					} catch {
						break;
					}
					bytesSent += slice.length;
					if (!canContinue && !stopWriting && bytesSent < streamRange.length) {
						await new Promise<void>((resolveDrain) => {
							const onUnblock = () => {
								if (wakeDrain === onUnblock) wakeDrain = null;
								req.removeListener('drain', onUnblock);
								req.removeListener('close', onUnblock);
								resolveDrain();
							};
							wakeDrain = onUnblock;
							req.once('drain', onUnblock);
							req.once('close', onUnblock);
						});
					}
				}
				if (!stopWriting && !req.destroyed && !req.writableEnded) {
					try {
						req.end();
					} catch {}
				}
				return;
			}

			if (!stopWriting && !req.destroyed && !req.writableEnded) {
				req.end();
			}
		};

		writeBody().catch((err: unknown) => {
			if (!gotResponse && !settled) {
				settled = true;
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	});
}

/** Create an isolated temporary directory in the target WebDAV root and return helpers plus Drive Trash cleanup. */
export async function createLiveSandbox(envFile = '.env'): Promise<LiveSandbox> {
	const config = loadLiveConfig(envFile);
	const baseUrl = `${config.origin}${config.basePath}`;
	const sandboxName = `e2e-sandbox-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
	const sandboxUrl = `${baseUrl}${sandboxName}/`;
	const authHeaders: Record<string, string> = {
		...config.gateHeaders,
		Authorization: config.authHeader,
	};

	const request = (opts: LiveRequestOptions): Promise<LiveResponse> =>
		sendStreamRequest({
			...opts,
			headers: { ...authHeaders, ...opts.headers },
		});

	const mkcol = await request({ url: sandboxUrl, method: 'MKCOL' });
	if (mkcol.status !== 201) {
		throw new Error(`Failed to create Drive sandbox (${mkcol.status}): ${mkcol.bodyText.slice(0, 200)}`);
	}

	const fileUrl = (name: string): string => `${sandboxUrl}${name.replace(/^\/+/, '')}`;
	let cleaned = false;

	return {
		config,
		baseUrl,
		sandboxName,
		sandboxUrl,
		fileUrl,
		request,
		async putStream(name: string, totalBytes: number) {
			const hash = crypto.createHash('sha256');
			const res = await request({
				url: fileUrl(name),
				method: 'PUT',
				headers: { 'Content-Type': 'application/octet-stream' },
				streamRange: { startOffset: 0, length: totalBytes, hash },
			});
			return {
				status: res.status,
				headers: res.headers,
				sha256: hash.digest('hex'),
				bytes: totalBytes,
				durationMs: res.durationMs,
			};
		},
		getAndHash(name: string, headers?: Record<string, string>) {
			return request({
				url: fileUrl(name),
				method: 'GET',
				headers,
				hashResponse: true,
			});
		},
		async tusUpload(name: string, totalBytes: number, chunkBytes: number) {
			if (chunkBytes <= 0) throw new Error('chunkBytes must be positive');
			const startedAt = Date.now();
			const filenameB64 = Buffer.from(name, 'utf8').toString('base64');
			const createRes = await request({
				url: sandboxUrl,
				method: 'POST',
				headers: {
					'Tus-Resumable': '1.0.0',
					'Upload-Length': String(totalBytes),
					'Upload-Metadata': `filename ${filenameB64}`,
				},
			});
			const rawLocation = String(createRes.headers.location || '');
			const sessionUrl = rawLocation ? new URL(rawLocation, config.origin).toString() : '';
			if (createRes.status !== 201 || !sessionUrl || !new URL(sessionUrl).pathname.startsWith(config.basePath + 'tus_uploads/')) {
				throw new Error(`TUS creation failed (${createRes.status}, location=${rawLocation}): ${createRes.bodyText.slice(0, 200)}`);
			}

			const hash = crypto.createHash('sha256');
			let offset = 0;
			let chunks = 0;
			while (offset < totalBytes) {
				const len = Math.min(chunkBytes, totalBytes - offset);
				const patchRes = await request({
					url: sessionUrl,
					method: 'PATCH',
					headers: {
						'Tus-Resumable': '1.0.0',
						'Content-Type': 'application/offset+octet-stream',
						'Upload-Offset': String(offset),
					},
					streamRange: { startOffset: offset, length: len, hash },
				});
				const nextOffset = Number(patchRes.headers['upload-offset']);
				if (patchRes.status !== 204 || nextOffset !== offset + len) {
					throw new Error(`TUS PATCH chunk ${chunks + 1} failed (${patchRes.status}, offset=${patchRes.headers['upload-offset']}): ${patchRes.bodyText.slice(0, 200)}`);
				}
				offset = nextOffset;
				chunks += 1;

				if (chunks === 1 && offset < totalBytes) {
					const headRes = await request({
						url: sessionUrl,
						method: 'HEAD',
						headers: { 'Tus-Resumable': '1.0.0' },
					});
					if (
						headRes.status !== 200 ||
						Number(headRes.headers['upload-offset']) !== offset ||
						Number(headRes.headers['upload-length']) !== totalBytes
					) {
						throw new Error(`TUS HEAD verification failed (${headRes.status}, offset=${headRes.headers['upload-offset']})`);
					}
				}
			}

			return {
				chunks,
				sha256: hash.digest('hex'),
				bytes: totalBytes,
				location: sessionUrl,
				durationMs: Date.now() - startedAt,
			};
		},
		async cleanup() {
			if (cleaned || process.env.LIVE_KEEP_SANDBOX === '1') return;
			cleaned = true;
			const res = await request({ url: sandboxUrl, method: 'DELETE' });
			if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
				throw new Error(`Failed to trash sandbox "${sandboxName}" (${res.status}): ${res.bodyText.slice(0, 200)}`);
			}
		},
	};
}
