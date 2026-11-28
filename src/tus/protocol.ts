import { type UploadedDriveFile, fileEtag } from '../drive/types';
import { StatusError } from '../http';

export const TUS_VERSION = '1.0.0';
export const TUS_EXTENSIONS = 'creation,creation-with-upload,checksum';
export const TUS_CHECKSUM_ALGORITHMS = 'sha1,md5,sha256';
export const TUS_ALIGNMENT = 256 * 1024;
export const DRIVE_FLUSH_SIZE = 10 * 1024 * 1024;
export const MAX_TUS_REQUEST_BYTES = 16 * 1024 * 1024;
export const UPLOAD_FILE_PERM = 'RDNVW';

export type ChecksumAlgorithm = 'sha1' | 'md5' | 'sha256';

export interface ExpectedChecksum {
    algorithm: ChecksumAlgorithm;
    hex: string;
}

export interface TusMetadata {
    filename?: string;
    filetype: string;
    mtime?: string;
    checksum?: ExpectedChecksum;
}

export const EMPTY_CHECKSUMS: Record<ChecksumAlgorithm, string> = {
    md5: 'd41d8cd98f00b204e9800998ecf8427e',
    sha1: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

const HEX_LENGTH: Record<ChecksumAlgorithm, number> = {
    md5: 32,
    sha1: 40,
    sha256: 64,
};

const WEB_CRYPTO_ALGORITHM: Record<ChecksumAlgorithm, string> = {
    md5: 'MD5',
    sha1: 'SHA-1',
    sha256: 'SHA-256',
};

const MIME_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]*)?$/;
const MAX_DATE_MS = 8640000000000000n;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export function parseNonNegativeInt(value: string | null): number | null {
    if (value === null || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

export function isOffsetStreamContentType(header: string | null): boolean {
    if (!header) return false;
    return header.split(';', 1)[0].trim().toLowerCase() === 'application/offset+octet-stream';
}

/**
 * Parses integer or fractional Unix seconds using exact decimal millisecond
 * scaling so floating-point arithmetic never introduces timestamp drift.
 */
export function parseUnixMtime(raw: string): string {
    const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(raw);
    if (!match) throw new StatusError('Invalid mtime', 400);
    const whole = BigInt(match[2]);
    const frac = BigInt((match[3] ?? '').slice(0, 3).padEnd(3, '0'));
    const unsignedMs = whole * 1000n + frac;
    const ms = match[1] ? -unsignedMs : unsignedMs;
    if (ms < -MAX_DATE_MS || ms > MAX_DATE_MS) {
        throw new StatusError('Invalid mtime', 400);
    }
    return new Date(Number(ms)).toISOString();
}

function parseHexDigest(rawAlg: string, rawHex: string, errorMessage: string): ExpectedChecksum {
    const algorithm = rawAlg.toLowerCase();
    if (algorithm !== 'sha1' && algorithm !== 'md5' && algorithm !== 'sha256') {
        throw new StatusError(errorMessage, 400);
    }
    const hex = rawHex.toLowerCase();
    if (hex.length !== HEX_LENGTH[algorithm] || !/^[0-9a-f]+$/.test(hex)) {
        throw new StatusError(errorMessage, 400);
    }
    return { algorithm, hex };
}

export function parseOcChecksum(header: string): ExpectedChecksum {
    const match = /^([A-Za-z0-9]+):([0-9a-fA-F]+)$/.exec(header.trim());
    if (!match) throw new StatusError('Invalid OC-Checksum', 400);
    return parseHexDigest(match[1], match[2], 'Invalid OC-Checksum');
}

export function parseTusChecksumMetadata(value: string): ExpectedChecksum {
    const match = /^([A-Za-z0-9]+)(?:\s+|:)([0-9a-fA-F]+)$/.exec(value.trim());
    if (!match) throw new StatusError('Invalid checksum metadata', 400);
    return parseHexDigest(match[1], match[2], 'Invalid checksum metadata');
}

export function mergeExpectedChecksums(first?: ExpectedChecksum, second?: ExpectedChecksum): ExpectedChecksum[] {
    const list: ExpectedChecksum[] = [];
    for (const item of [first, second]) {
        if (!item) continue;
        const existing = list.find(entry => entry.algorithm === item.algorithm);
        if (existing) {
            if (existing.hex !== item.hex) throw new StatusError('Conflicting checksums', 400);
        } else {
            list.push(item);
        }
    }
    return list;
}

function decodeBase64Strict(encoded: string): Uint8Array {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
        throw new StatusError('Invalid Base64 value', 400);
    }
    try {
        return Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0));
    } catch {
        throw new StatusError('Invalid Base64 value', 400);
    }
}

function decodeBase64Utf8(encoded: string): string {
    const bytes = decodeBase64Strict(encoded);
    try {
        return utf8Decoder.decode(bytes);
    } catch {
        throw new StatusError('Invalid UTF-8 metadata value', 400);
    }
}

export function parseUploadChecksum(header: string): { algorithm: ChecksumAlgorithm; bytes: Uint8Array } {
    const match = /^([A-Za-z0-9_-]+)\s+([^\s]+)$/.exec(header.trim());
    if (!match) throw new StatusError('Invalid Upload-Checksum', 400);
    const algorithm = match[1].toLowerCase();
    if (algorithm !== 'sha1' && algorithm !== 'md5' && algorithm !== 'sha256') {
        throw new StatusError('Unsupported Upload-Checksum algorithm', 400);
    }
    const rawDigest = match[2];
    const hexLen = HEX_LENGTH[algorithm];
    if (rawDigest.length === hexLen && /^[0-9a-fA-F]+$/.test(rawDigest)) {
        const bytes = new Uint8Array(hexLen / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(rawDigest.slice(i * 2, i * 2 + 2), 16);
        }
        return { algorithm, bytes };
    }
    return { algorithm, bytes: decodeBase64Strict(rawDigest) };
}

function bytesEqualConstantTime(left: Uint8Array, right: Uint8Array): boolean {
    let diff = left.byteLength ^ right.byteLength;
    const len = Math.max(left.byteLength, right.byteLength);
    for (let i = 0; i < len; i++) {
        diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
    }
    return diff === 0;
}

export async function verifyChunkChecksum(header: string, chunk: Uint8Array): Promise<void> {
    const { algorithm, bytes } = parseUploadChecksum(header);
    const digestBuffer = await crypto.subtle.digest(WEB_CRYPTO_ALGORITHM[algorithm], chunk);
    const actual = new Uint8Array(digestBuffer);
    if (!bytesEqualConstantTime(bytes, actual)) {
        throw new StatusError('Checksum mismatch', 460);
    }
}

export function verifyDriveChecksums(
    expected: readonly ExpectedChecksum[],
    file: UploadedDriveFile | null | undefined,
    isEmpty = false,
): boolean {
    for (const item of expected) {
        let actual: string | undefined;
        if (isEmpty) {
            actual = EMPTY_CHECKSUMS[item.algorithm];
        } else {
            actual = item.algorithm === 'md5'
                ? file?.md5Checksum
                : item.algorithm === 'sha1'
                    ? file?.sha1Checksum
                    : file?.sha256Checksum;
        }
        if (typeof actual !== 'string' || actual.toLowerCase() !== item.hex) {
            return false;
        }
    }
    return true;
}

/**
 * Evaluates RFC 9110 strong `If-Match` preconditions. Weak tags (`W/"..."`)
 * and unquoted or malformed entity-tags never satisfy a strong precondition.
 */
export function matchesIfMatch(header: string | null, currentEtag: string | undefined, exists: boolean): boolean {
    if (header === null) return true;
    const trimmed = header.trim();
    if (trimmed === '*') return exists;
    if (!trimmed || !exists || !currentEtag) return false;

    const tagPattern = /(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"/gy;
    let index = 0;
    let matched = false;
    while (index < trimmed.length) {
        tagPattern.lastIndex = index;
        const match = tagPattern.exec(trimmed);
        if (!match) return false;
        const isWeak = Boolean(match[1]);
        const fullTag = match[0];
        if (!isWeak && fullTag === currentEtag) {
            matched = true;
        }
        index = tagPattern.lastIndex;
        while (index < trimmed.length && (trimmed[index] === ' ' || trimmed[index] === '\t')) index++;
        if (index === trimmed.length) break;
        if (trimmed[index] !== ',') return false;
        index++;
        while (index < trimmed.length && (trimmed[index] === ' ' || trimmed[index] === '\t')) index++;
        if (index === trimmed.length) return false;
    }
    return matched;
}

export function validateTusFilename(raw: string): string {
    if (!raw || /[\x00-\x1f\x7f\\]/.test(raw) || raw.includes('//') || raw.endsWith('/')) {
        throw new StatusError('Invalid filename', 400);
    }
    const stripped = raw.startsWith('/') ? raw.slice(1) : raw;
    if (!stripped) throw new StatusError('Invalid filename', 400);
    const segments = stripped.split('/');
    if (segments.some(seg => !seg || seg === '.' || seg === '..')) {
        throw new StatusError('Invalid filename', 400);
    }
    return stripped;
}

function tryValidMimeType(rawValue: string): string | undefined {
    if (!rawValue) return undefined;
    try {
        const decoded = decodeBase64Utf8(rawValue);
        if (MIME_PATTERN.test(decoded)) return decoded;
    } catch {
        // Fall through to plaintext MIME check (e.g. Cyberduck 9.6.0).
    }
    return MIME_PATTERN.test(rawValue) ? rawValue : undefined;
}

/**
 * Parses `Upload-Metadata` per 14A: strictly validates core keys (`filename`,
 * `mtime`, `checksum`), tolerates trailing commas and Cyberduck's plaintext
 * `filetype` (falling back invalid values to `application/octet-stream`), and
 * ignores unknown keys without validating their Base64 encoding.
 */
export function parseTusMetadata(header: string): TusMetadata {
    const seenCore = new Set<string>();
    let filename: string | undefined;
    let mtime: string | undefined;
    let checksum: ExpectedChecksum | undefined;
    let filetype: string | undefined;
    let mimetype: string | undefined;

    for (const rawEntry of header.split(',')) {
        const entry = rawEntry.trim();
        if (!entry) continue;
        const spaceIdx = entry.indexOf(' ');
        const key = spaceIdx === -1 ? entry : entry.slice(0, spaceIdx);
        const rawValue = spaceIdx === -1 ? '' : entry.slice(spaceIdx + 1).trim();
        if (!key || /[\s,\x00-\x1f\x7f]/.test(key)) {
            throw new StatusError('Invalid Upload-Metadata', 400);
        }
        if (key === 'filename' || key === 'mtime' || key === 'checksum') {
            if (seenCore.has(key)) throw new StatusError('Duplicate Upload-Metadata key', 400);
            seenCore.add(key);
            const decoded = decodeBase64Utf8(rawValue);
            if (key === 'filename') filename = validateTusFilename(decoded);
            else if (key === 'mtime') mtime = parseUnixMtime(decoded);
            else checksum = parseTusChecksumMetadata(decoded);
            continue;
        }
        if (key === 'filetype') {
            filetype ??= tryValidMimeType(rawValue);
        } else if (key === 'mimetype') {
            mimetype ??= tryValidMimeType(rawValue);
        }
    }

    return {
        ...(filename !== undefined ? { filename } : {}),
        filetype: filetype ?? mimetype ?? 'application/octet-stream',
        ...(mtime !== undefined ? { mtime } : {}),
        ...(checksum !== undefined ? { checksum } : {}),
    };
}

export function applyCompletionHeaders(headers: Headers, file: UploadedDriveFile | null | undefined): void {
    if (!file) return;
    const etag = fileEtag(file);
    if (etag) headers.set('ETag', etag);
    if (typeof file.id === 'string' && file.id) {
        headers.set('OC-FileID', file.id);
        headers.set('OC-Perm', UPLOAD_FILE_PERM);
    }
}

export type DriveUploadResult =
    | { completed: true; file: UploadedDriveFile }
    | { completed: false; confirmedOffset: number };

export async function parseDriveUploadResponse(
    response: Response,
    totalSize: number,
): Promise<DriveUploadResult> {
    if (response.status === 200 || response.status === 201) {
        // A lost response body leaves the Drive commit ambiguous. Keep the session
        // recoverable so a later status probe can retrieve the completion metadata.
        const file = await response.json<UploadedDriveFile>();
        return { completed: true, file: file ?? {} };
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404 || response.status === 410) {
        throw new StatusError('Upload session expired', 410);
    }
    if (response.status !== 308) {
        throw new StatusError('Drive upload temporarily unavailable', response.status === 429 ? 429 : 503);
    }
    const range = response.headers.get('Range');
    if (range === null) return { completed: false, confirmedOffset: 0 };
    const match = /^bytes=0-(\d+)$/.exec(range);
    const end = match ? parseNonNegativeInt(match[1]) : null;
    if (end === null || end >= totalSize - 1) {
        throw new StatusError('Invalid Drive upload offset', 502);
    }
    return { completed: false, confirmedOffset: end + 1 };
}

export async function readBoundedBody(
    body: ReadableStream<Uint8Array> | null,
    options: { maxBytes: number; declaredLength: number | null },
): Promise<Uint8Array> {
    const { maxBytes, declaredLength } = options;
    if (declaredLength !== null && declaredLength > maxBytes) {
        throw new StatusError('Upload exceeds maximum allowed size', 413);
    }
    if (!body) {
        if (declaredLength !== null && declaredLength > 0) {
            throw new StatusError('Incomplete request body', 400);
        }
        return new Uint8Array(0);
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let finished = false;
    try {
        while (true) {
            let next: ReadableStreamReadResult<Uint8Array>;
            try {
                next = await reader.read();
            } catch {
                throw new StatusError('Upload failed', 502);
            }
            if (next.done) {
                finished = true;
                break;
            }
            const value = next.value;
            if (!value.byteLength) continue;
            if (declaredLength !== null && value.byteLength > declaredLength - total) {
                throw new StatusError('Request body exceeds Content-Length', 400);
            }
            if (value.byteLength > maxBytes - total) {
                throw new StatusError('Upload exceeds maximum allowed size', 413);
            }
            chunks.push(value);
            total += value.byteLength;
        }
        if (declaredLength !== null && total !== declaredLength) {
            throw new StatusError('Incomplete request body', 400);
        }
        if (chunks.length === 0) return new Uint8Array(0);
        if (chunks.length === 1) return chunks[0];
        const result = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return result;
    } finally {
        if (!finished) {
            try { await reader.cancel(); } catch {}
        }
        reader.releaseLock();
    }
}
