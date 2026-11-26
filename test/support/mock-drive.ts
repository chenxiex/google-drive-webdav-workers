export const FOLDER = 'application/vnd.google-apps.folder';

export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	size?: number | string;
	parents: string[];
	version?: string;
	modifiedTime?: string;
	createdTime?: string;
	description?: string;
	starred?: boolean;
	folderColorRgb?: string;
	appProperties?: Record<string, string>;
	trashed?: boolean;
	explicitlyTrashed?: boolean;
	content?: Uint8Array;
	md5Checksum?: string;
	sha1Checksum?: string;
	sha256Checksum?: string;
	thumbnailLink?: string;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type Metadata = { name?: string; mimeType?: string; parents?: string[]; trashed?: boolean; createdTime?: string; modifiedTime?: string; description?: string | null; starred?: boolean; folderColorRgb?: string | null; appProperties?: Record<string, string | null> };
type Session = { metadata: Metadata; id?: string; mimeType: string; total?: number; bytes: Uint8Array; fields: string | null; completed?: DriveFile; failure?: string };
const API = 'https://www.googleapis.com';
const STATUS_TEXT: Record<number, string> = {
	200: 'OK',
	204: 'No Content',
	400: 'Bad Request',
	401: 'Unauthorized',
	403: 'Forbidden',
	404: 'Not Found',
	409: 'Conflict',
	429: 'Too Many Requests',
	500: 'Internal Server Error',
	502: 'Bad Gateway',
	503: 'Service Unavailable',
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), {
	status, headers: { 'Content-Type': 'application/json; charset=UTF-8' },
});
const batchBadRequest = (message: string): Response => json([{
	error: { code: 400, message, errors: [{ message, domain: 'global', reason: 'badRequest' }], status: 'INVALID_ARGUMENT' },
}], 400);
const apiError = (status: number, reason: string, message: string, location?: string): Response => json({
	error: { code: status, message, errors: [{ message, domain: 'global', reason, ...(location ? { location, locationType: 'parameter' } : {}) }] },
}, status);
const notFound = (id: string): Response => apiError(404, 'notFound', `File not found: ${id}.`, 'fileId');
const invalid = (location: string): Response => apiError(400, 'invalid', 'Invalid Value', location);
function unsupported(detail: string): never { throw new Error(`MockDrive does not implement ${detail}. Extend its verified contract before using it.`); }

async function bodyBytes(input: FetchInput, init?: FetchInit): Promise<Uint8Array> {
	const body = init?.body !== undefined ? init.body : input instanceof Request ? input.body : null;
	return body ? new Uint8Array(await new Response(body as BodyInit).arrayBuffer()) : new Uint8Array();
}
function parseMetadata(bytes: Uint8Array): Metadata | Response {
	if (!bytes.length) return {};
	try {
		const value = JSON.parse(decoder.decode(bytes));
		if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('body');
		for (const key of Object.keys(value)) if (!['name', 'mimeType', 'parents', 'trashed', 'createdTime', 'modifiedTime', 'description', 'starred', 'folderColorRgb', 'appProperties'].includes(key)) unsupported(`metadata field ${key}`);
		for (const key of ['name', 'mimeType']) if (value[key] !== undefined && typeof value[key] !== 'string') return invalid(key);
		for (const key of ['description', 'folderColorRgb']) if (value[key] != null && typeof value[key] !== 'string') return invalid(key);
		if (value.starred !== undefined && typeof value.starred !== 'boolean') return invalid('starred');
		for (const key of ['createdTime', 'modifiedTime']) if (value[key] !== undefined && (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key])))) return invalid(key);
		if (value.appProperties !== undefined && (!value.appProperties || Array.isArray(value.appProperties) || typeof value.appProperties !== 'object' || Object.values(value.appProperties).some(v => v !== null && typeof v !== 'string'))) return invalid('appProperties');
		if (value.trashed !== undefined && typeof value.trashed !== 'boolean') return invalid('trashed');
		if (value.parents !== undefined && (!Array.isArray(value.parents) || value.parents.some((p: unknown) => typeof p !== 'string'))) return invalid('parents');
		return value;
	} catch (error) {
		if (error instanceof SyntaxError) return apiError(400, 'parseError', 'Parse Error');
		throw error;
	}
}

// Drive partial-response selectors used by this worker. Unknown supported-API
// features fail loudly instead of pretending that the real API accepted them.
const fileFields = new Set(['kind', 'id', 'version', 'name', 'mimeType', 'size', 'modifiedTime', 'createdTime', 'starred', 'folderColorRgb', 'appProperties', 'parents', 'trashed', 'explicitlyTrashed', 'description', 'iconLink', 'thumbnailLink', 'imageMediaMetadata', 'md5Checksum', 'sha1Checksum', 'sha256Checksum']);
const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
const MD5_SHIFTS = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
	5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
	4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
	6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
const toHex = (buffer: ArrayBuffer): string => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');

function md5Hex(bytes: Uint8Array): string {
	const bitLen = bytes.length * 8;
	const paddedLen = (((bytes.length + 8) >>> 6) + 1) * 64;
	const padded = new Uint8Array(paddedLen);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(paddedLen - 8, bitLen >>> 0, true);
	view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);
	let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
	for (let offset = 0; offset < paddedLen; offset += 64) {
		let a = a0, b = b0, c = c0, d = d0;
		for (let i = 0; i < 64; i++) {
			let f: number, g: number;
			if (i < 16) { f = (b & c) | (~b & d); g = i; }
			else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
			else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
			else { f = c ^ (b | ~d); g = (7 * i) & 15; }
			const sum = (a + f + MD5_K[i] + view.getUint32(offset + g * 4, true)) >>> 0;
			const shift = MD5_SHIFTS[i];
			const rot = ((sum << shift) | (sum >>> (32 - shift))) >>> 0;
			a = d; d = c; c = b; b = (b + rot) >>> 0;
		}
		a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
	}
	return [a0, b0, c0, d0].map(word => {
		const out = new Uint8Array(4);
		new DataView(out.buffer).setUint32(0, word, true);
		return toHex(out.buffer);
	}).join('');
}

async function computeChecksums(bytes: Uint8Array): Promise<{ md5Checksum: string; sha1Checksum: string; sha256Checksum: string }> {
	const copy = bytes.slice();
	const [sha1, sha256] = await Promise.all([
		crypto.subtle.digest('SHA-1', copy),
		crypto.subtle.digest('SHA-256', copy),
	]);
	return { md5Checksum: md5Hex(copy), sha1Checksum: toHex(sha1), sha256Checksum: toHex(sha256) };
}
function selections(fields: string): string[] {
	let depth = 0;
	let start = 0;
	const result: string[] = [];
	for (let i = 0; i < fields.length; i++) {
		if (fields[i] === '(') depth++;
		if (fields[i] === ')') depth--;
		if (fields[i] === ',' && depth === 0) { result.push(fields.slice(start, i).trim()); start = i + 1; }
	}
	if (depth !== 0) return [];
	result.push(fields.slice(start).trim());
	return result;
}
function project(data: Record<string, unknown>, fields: string, allowed: Set<string>, nested?: { key: string; fields: Set<string> }): Record<string, unknown> | Response {
	if (fields === '*') return data;
	const parts = selections(fields);
	if (!parts.length) return invalid('fields');
	const result: Record<string, unknown> = {};
	for (const part of parts) {
		const match = part.match(/^(\w+)(?:\((.*)\)|\/(.*))?$/);
		if (!match || !allowed.has(match[1])) return apiError(400, 'invalidParameter', `Invalid field selection ${part}`, 'fields');
		const [, key, group, path] = match;
		const subfields = group ?? path;
		if (subfields !== undefined) {
			if (nested?.key !== key) unsupported(`nested fields selector ${part}`);
			const values = Array.isArray(data[key]) ? data[key] as Record<string, unknown>[] : [data[key] as Record<string, unknown>];
			// Validate masks even on an empty list.
			const checked = project({}, subfields, nested.fields);
			if (checked instanceof Response) return checked;
			const projected = values.filter(Boolean).map(v => project(v, subfields, nested.fields));
			result[key] = Array.isArray(data[key]) ? projected : projected[0];
		} else if (key in data) result[key] = data[key];
	}
	return result;
}
function representation(file: DriveFile): Record<string, unknown> {
	return {
		kind: 'drive#file', id: file.id, version: file.version ?? '1', name: file.name, mimeType: file.mimeType,
		createdTime: file.createdTime, starred: file.starred ?? false,
		...(file.description !== undefined ? { description: file.description } : {}),
		...(file.folderColorRgb !== undefined ? { folderColorRgb: file.folderColorRgb } : {}),
		...(file.appProperties && Object.keys(file.appProperties).length ? { appProperties: { ...file.appProperties } } : {}),
		...(file.thumbnailLink ? { thumbnailLink: file.thumbnailLink } : {}),
		parents: [...file.parents], modifiedTime: file.modifiedTime, trashed: file.trashed ?? false, explicitlyTrashed: file.explicitlyTrashed ?? false,
		...(!file.mimeType.startsWith('application/vnd.google-apps.') ? {
			size: String(file.size ?? 0),
			...(file.md5Checksum !== undefined ? { md5Checksum: file.md5Checksum } : {}),
			...(file.sha1Checksum !== undefined ? { sha1Checksum: file.sha1Checksum } : {}),
			...(file.sha256Checksum !== undefined ? { sha256Checksum: file.sha256Checksum } : {}),
		} : {}),
	};
}

function findBytes(bytes: Uint8Array, needle: Uint8Array, start = 0): number {
	outer: for (let i = start; i <= bytes.length - needle.length; i++) {
		for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
		return i;
	}
	return -1;
}

function multipart(bytes: Uint8Array, contentType: string): { metadata: Metadata; content: Uint8Array; mimeType: string } | Response {
	const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
	if (!/^multipart\/related\b/i.test(contentType) || !boundary) return apiError(400, 'badRequest', 'Invalid multipart request.');
	const encoder = new TextEncoder();
	const marker = '--' + (boundary[1] ?? boundary[2]);
	const separator = encoder.encode('\r\n\r\n');
	const firstHeader = findBytes(bytes, separator);
	const middle = findBytes(bytes, encoder.encode('\r\n' + marker + '\r\n'), firstHeader + 4);
	const secondHeader = findBytes(bytes, separator, middle + marker.length + 4);
	const end = findBytes(bytes, encoder.encode('\r\n' + marker + '--'), secondHeader + 4);
	if (findBytes(bytes, encoder.encode(marker + '\r\n')) !== 0 || firstHeader < 0 || middle < 0 || secondHeader < 0 || end < secondHeader) return apiError(400, 'badRequest', 'Invalid multipart request.');
	if (!/Content-Type:\s*application\/json\b/i.test(decoder.decode(bytes.subarray(0, firstHeader)))) return apiError(400, 'badRequest', 'Invalid multipart request.');
	const metadata = parseMetadata(bytes.slice(firstHeader + 4, middle));
	if (metadata instanceof Response) return metadata;
	const mimeType = decoder.decode(bytes.subarray(middle, secondHeader)).match(/Content-Type:\s*([^\r\n]+)/i)?.[1] ?? 'application/octet-stream';
	return { metadata, content: bytes.slice(secondHeader + 4, end), mimeType };
}

/** A verified subset of Drive v3, not a general Google API emulator. See mock-drive.md. */
export class MockDrive {
	files: DriveFile[] = [];
	private root: DriveFile = { id: 'root', name: 'My Drive', mimeType: FOLDER, parents: [], createdTime: '2024-01-01T00:00:00.000Z', modifiedTime: '2024-01-01T00:00:00.000Z' };
	private sessions = new Map<string, Session>();
	private pages = new Map<string, { offset: number; query: string; order: string }>();
	private hashedContent = new WeakMap<DriveFile, Uint8Array>();
	constructor(private oauth = { clientId: 'test-client-id', clientSecret: 'test-client-secret', refreshToken: 'test-refresh-token-history' }) {}

	add(file: DriveFile): DriveFile {
		file.version ??= '1';
		file.parents = [...file.parents];
		file.modifiedTime ??= '2024-01-01T00:00:00.000Z';
		file.createdTime ??= file.modifiedTime;
		if (file.mimeType === FOLDER) file.folderColorRgb ??= '#8f8f8f';
		if (file.appProperties) file.appProperties = { ...file.appProperties };
		file.explicitlyTrashed ??= file.trashed ?? false;
		if (file.content !== undefined && (file.md5Checksum !== undefined || file.sha1Checksum !== undefined || file.sha256Checksum !== undefined)) {
			this.hashedContent.set(file, file.content);
		}
		this.files.push(file);
		this.refreshTrashState();
		return file;
	}
	private async ensureChecksums(file: DriveFile): Promise<void> {
		if (file.mimeType.startsWith('application/vnd.google-apps.') || file.content === undefined) return;
		if (this.hashedContent.get(file) === file.content) return;
		Object.assign(file, await computeChecksums(file.content));
		this.hashedContent.set(file, file.content);
	}
	private async fileResponse(file: DriveFile, fields: string | null): Promise<Response> {
		await this.ensureChecksums(file);
		const selected = project(representation(file), fields ?? 'kind,id,name,mimeType', fileFields);
		return selected instanceof Response ? selected : json(selected);
	}
	remove(id: string): void {
		const removed = new Set([id]);
		for (const parent of removed) for (const child of this.children(parent)) removed.add(child.id);
		this.files = this.files.filter(f => !removed.has(f.id));
	}
	findById(id: string): DriveFile | undefined { return this.files.find(f => f.id === id) ?? (id === 'root' ? this.root : undefined); }
	children(parentId: string): DriveFile[] { return this.files.filter(f => f.parents.includes(parentId)); }

	// Model settled My Drive state. Real descendant propagation is asynchronous;
	// this deterministic mock does not simulate its transient visibility window.
	private refreshTrashState(): void {
		const byId = new Map(this.files.map(f => [f.id, f]));
		byId.set('root', this.root);
		const memo = new Map<string, boolean>();
		const isTrashed = (file: DriveFile, seen = new Set<string>()): boolean => {
			const cached = memo.get(file.id);
			if (cached !== undefined) return cached;
			if (file.explicitlyTrashed) { memo.set(file.id, true); return true; }
			if (seen.has(file.id)) unsupported('folder cycles');
			seen.add(file.id);
			const trashed = file.parents.some(id => {
				const parent = byId.get(id);
				return parent ? isTrashed(parent, seen) : false;
			});
			seen.delete(file.id);
			memo.set(file.id, trashed);
			return trashed;
		};
		for (const file of this.files) file.trashed = isTrashed(file);
	}
	private quantizeFolderColor(mimeType: string, folderColorRgb: string | null | undefined, fallback?: string): string | undefined | Response {
		if (folderColorRgb == null || folderColorRgb === '') return fallback;
		if (mimeType !== FOLDER) return apiError(403, 'colorNotSupportedForItem', 'Color is not supported on this item.');
		const verified: Record<string, string> = { '#ff0000': '#f83a22', '#f83a22': '#f83a22', '#8f8f8f': '#8f8f8f', 'nope': '#8f8f8f' };
		if (!(folderColorRgb in verified)) unsupported('unverified folder color quantization');
		return verified[folderColorRgb];
	}
	private validateParents(parents: string[]): Response | undefined {
		if (parents.length > 1) return apiError(403, 'cannotAddParent', 'Increasing the number of parents is not allowed');
		for (const parent of parents) {
			if (parent === 'root') continue;
			const found = this.findById(parent);
			if (!found) return notFound(parent);
			if (found.mimeType !== FOLDER) return apiError(403, 'parentNotAFolder', 'The specified parent is not a folder.');
		}
	}
	private properties(existing: Record<string, string> = {}, patch: Record<string, string | null> = {}): Record<string, string> | Response {
		const next = { ...existing };
		for (const [key, value] of Object.entries(patch)) {
			if (value === null) delete next[key];
			else {
				if (new TextEncoder().encode(key + value).length > 124) return apiError(403, 'propertyLengthLimitExceeded', 'Properties and app properties are limited to 124 bytes in UTF-8 encoding, counting both the key and the value.');
				next[key] = value;
			}
		}
		if (Object.keys(next).length > 30) return apiError(403, 'propertyCountLimitExceeded', "The file's property and app property limit has been reached. Files can have up to 30 properties and 30 app properties per app, with a maximum of 100 in total.");
		return next;
	}
	private async create(
		meta: Metadata,
		options: { content?: Uint8Array; mimeType?: string; size?: number | string; md5Checksum?: string; sha1Checksum?: string; sha256Checksum?: string } = {},
	): Promise<DriveFile | Response> {
		if (meta.createdTime !== undefined) unsupported('unverified timestamps on create');
		if (meta.mimeType?.startsWith('application/vnd.google-apps.') && meta.mimeType !== FOLDER) unsupported('Google Workspace document conversion');
		const resolvedMime = meta.mimeType || options.mimeType || 'application/octet-stream';
		const folderColorRgb = this.quantizeFolderColor(resolvedMime, meta.folderColorRgb);
		if (folderColorRgb instanceof Response) return folderColorRgb;
		const parents = meta.parents?.length ? meta.parents : ['root'];
		const error = this.validateParents(parents);
		if (error) return error;
		const appProperties = this.properties({}, meta.appProperties);
		if (appProperties instanceof Response) return appProperties;
		const isGoogleApp = resolvedMime.startsWith('application/vnd.google-apps.');
		const hasExplicitChecksums = options.md5Checksum !== undefined || options.sha1Checksum !== undefined || options.sha256Checksum !== undefined;
		const content = options.content !== undefined ? options.content.slice() : isGoogleApp || options.size !== undefined ? undefined : new Uint8Array();
		const digests = isGoogleApp ? {}
			: hasExplicitChecksums ? {
				...(options.md5Checksum !== undefined ? { md5Checksum: options.md5Checksum } : {}),
				...(options.sha1Checksum !== undefined ? { sha1Checksum: options.sha1Checksum } : {}),
				...(options.sha256Checksum !== undefined ? { sha256Checksum: options.sha256Checksum } : {}),
			}
			: options.content !== undefined ? await computeChecksums(content!)
			: { md5Checksum: EMPTY_MD5 };
		const created = this.add({
			appProperties, description: meta.description ?? undefined, starred: meta.starred, folderColorRgb, createdTime: meta.createdTime,
			id: crypto.randomUUID(), name: meta.name || 'Untitled', mimeType: resolvedMime, parents,
			...(content !== undefined ? { content } : {}),
			size: options.size ?? content?.length ?? 0,
			...digests,
			trashed: meta.trashed ?? false,
			modifiedTime: meta.modifiedTime === undefined ? new Date().toISOString() : new Date(meta.modifiedTime).toISOString(),
		});
		if (created.content !== undefined) this.hashedContent.set(created, created.content);
		return created;
	}
	private async update(file: DriveFile, meta: Metadata, url: URL, content?: Uint8Array): Promise<Response | undefined> {
		if (file === this.root) unsupported('writing My Drive root metadata');
		if (meta.createdTime !== undefined) return apiError(403, 'fieldNotWritable', 'The resource body includes fields which are not directly writable.');
		const appProperties = this.properties(file.appProperties, meta.appProperties);
		if (appProperties instanceof Response) return appProperties;
		if (meta.parents !== undefined) return apiError(403, 'fieldNotWritable', 'The parents field is not directly writable in update requests. Use the addParents and removeParents parameters instead.');
		const folderColorRgb = this.quantizeFolderColor(file.mimeType, meta.folderColorRgb, file.folderColorRgb);
		if (folderColorRgb instanceof Response) return folderColorRgb;
		const added = (url.searchParams.get('addParents') ?? '').split(',').filter(Boolean);
		const removed = (url.searchParams.get('removeParents') ?? '').split(',').filter(Boolean);
		if ((added.length || removed.length) && (file.trashed || added.some(id => this.findById(id)?.trashed))) unsupported('moving from or into Trash');
		if (meta.trashed !== undefined && file.parents.some(id => this.findById(id)?.trashed)) unsupported('changing trash state under a trashed ancestor');
		const error = this.validateParents(added);
		if (error) return error;
		if (file.mimeType === FOLDER && added.length) {
			const descendants = new Set([file.id]);
			for (const parent of descendants) for (const child of this.children(parent)) descendants.add(child.id);
			if (descendants.has(added[0])) unsupported('moving a folder into itself or a descendant');
		}
		// In My Drive, adding a different single parent moves the file even if
		// removeParents is absent. Confirmed with live Drive on 2026-11-13.
		// Exact Drive increments are opaque; only monotonic advancement is modeled.
		file.version = (BigInt(file.version ?? '1') + 1n).toString();
		const nextParents = added.length ? [...added] : file.parents.filter(p => !removed.includes(p));
		if ((meta.name && meta.name !== file.name) || JSON.stringify(nextParents) !== JSON.stringify(file.parents)) file.modifiedTime = new Date().toISOString();
		if ((meta.description != null && meta.description !== file.description) || Object.keys(meta.appProperties ?? {}).length) file.modifiedTime = new Date().toISOString();
		if (meta.description != null) file.description = meta.description;
		if (meta.starred !== undefined) file.starred = meta.starred;
		file.appProperties = appProperties;
		file.folderColorRgb = folderColorRgb;
		file.parents = nextParents;
		if (meta.name) file.name = meta.name;
		if (meta.trashed !== undefined) file.explicitlyTrashed = meta.trashed;
		if (meta.trashed === false && file.mimeType === FOLDER) {
			// Live settled behavior: restoring a folder also restores descendants
			// that had been explicitly trashed before the ancestor was trashed.
			const restored = new Set([file.id]);
			for (const parent of restored) for (const child of this.children(parent)) {
				child.explicitlyTrashed = false;
				restored.add(child.id);
			}
		}
		if (meta.modifiedTime !== undefined) file.modifiedTime = new Date(meta.modifiedTime).toISOString();
		this.refreshTrashState();
		// Metadata-only MIME changes are ignored by Drive for binary files.
		if (content !== undefined) {
			file.content = content.slice(); file.size = content.length;
			Object.assign(file, await computeChecksums(file.content));
			this.hashedContent.set(file, file.content);
			// Updating a binary file's bytes preserves its existing MIME type,
			// even when the media request declares a different Content-Type.
			if (meta.modifiedTime === undefined) file.modifiedTime = new Date().toISOString();
		}
	}
	private async list(url: URL): Promise<Response> {
		const q = url.searchParams.get('q') ?? '';
		let files = [...this.files];
		let remaining = q.trim();
		// Parse the conjunctions the worker uses without splitting quoted names
		// containing "and", apostrophes, or escaped backslashes.
		while (remaining) {
			const parent = remaining.match(/^'((?:\\.|[^'\\])*)'\s+in\s+parents/i);
			const name = remaining.match(/^(name|mimeType)\s*(!=|=)\s*'((?:\\.|[^'\\])*)'/i);
			const trash = remaining.match(/^trashed\s*=\s*(true|false)/i);
			const match = parent ?? name ?? trash;
			if (!match) {
				if (remaining.includes('===')) return invalid('q');
				unsupported(`query expression ${remaining}`);
			}
			const unescape = (s: string) => s.replace(/\\(['\\])/g, '$1');
			if (parent) files = files.filter(f => f.parents.includes(unescape(parent[1])));
			else if (name) files = files.filter(f => (f[name[1] as 'name' | 'mimeType'] === unescape(name[3])) === (name[2] === '='));
			else if (trash) files = files.filter(f => (f.trashed ?? false) === (trash[1].toLowerCase() === 'true'));
			remaining = remaining.slice(match[0].length).trim();
			if (remaining) {
				if (!/^and\s+/i.test(remaining)) unsupported(`query conjunction ${remaining}`);
				remaining = remaining.replace(/^and\s+/i, '');
				if (!remaining) return invalid('q');
			}
		}
		const order = url.searchParams.get('orderBy') ?? '';
		const sortKeys = order ? order.split(',').map(s => s.trim().split(/\s+/)) : [];
		for (const [key, direction] of sortKeys) if (!['folder', 'name', 'name_natural', 'modifiedTime'].includes(key) || (direction && direction !== 'desc')) unsupported(`orderBy ${order}`);
		files.sort((a, b) => {
			for (const [key, direction] of sortKeys) {
				const left = key === 'folder' ? a.parents[0] ?? '' : key === 'modifiedTime' ? a.modifiedTime ?? '' : a.name;
				const right = key === 'folder' ? b.parents[0] ?? '' : key === 'modifiedTime' ? b.modifiedTime ?? '' : b.name;
				const compared = left.localeCompare(right, 'en', { numeric: key === 'name_natural' });
				if (compared) return direction === 'desc' ? -compared : compared;
			}
			return 0;
		});
		const size = Number(url.searchParams.get('pageSize') ?? 100);
		if (!Number.isInteger(size) || size < 1 || size > 1000) return invalid('pageSize');
		const pageToken = url.searchParams.get('pageToken');
		const page = pageToken ? this.pages.get(pageToken) : undefined;
		if (pageToken && (!page || page.query !== q || page.order !== order)) return invalid('pageToken');
		const offset = page?.offset ?? 0;
		let nextPageToken: string | undefined;
		if (offset + size < files.length) { nextPageToken = crypto.randomUUID(); this.pages.set(nextPageToken, { offset: offset + size, query: q, order }); }
		const pageFiles = files.slice(offset, offset + size);
		await Promise.all(pageFiles.map(file => this.ensureChecksums(file)));
		const data = { kind: 'drive#fileList', incompleteSearch: false, ...(nextPageToken ? { nextPageToken } : {}), files: pageFiles.map(representation) };
		const result = project(data, url.searchParams.get('fields') ?? 'kind,incompleteSearch,nextPageToken,files(kind,id,name,mimeType)', new Set(['kind', 'incompleteSearch', 'nextPageToken', 'files']), { key: 'files', fields: fileFields });
		return result instanceof Response ? result : json(result);
	}
	private async uploadSession(url: URL, method: string, headers: Headers, bytes: Uint8Array): Promise<Response> {
		if (method !== 'PUT') unsupported(`resumable session method ${method}`);
		const session = this.sessions.get(url.searchParams.get('upload_id')!);
		if (!session) return new Response(null, { status: 404 });
		if (url.pathname !== '/upload/drive/v3/files' + (session.id ? '/' + session.id : '')) return new Response(null, { status: 404 });
		if (session.failure) return new Response(session.failure, { status: 400 });
		const range = headers.get('Content-Range');
		if (session.completed) return this.fileResponse(session.completed, session.fields);
		const progress = () => new Response(null, { status: 308, headers: session.bytes.length ? { Range: `bytes=0-${session.bytes.length - 1}` } : {} });
		const emptyFinal = range === 'bytes */0' && !bytes.length && !session.bytes.length;
		if (range?.match(/^bytes \*\/(\d+|\*)$/) && !bytes.length && !emptyFinal) return progress();
		let total = emptyFinal ? 0 : session.total;
		let start = 0;
		if (!range && total === undefined) total = bytes.length;
		if (range && !emptyFinal) {
			const parsed = range.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
			if (!parsed || +parsed[2] - +parsed[1] + 1 !== bytes.length) return new Response('Invalid Content-Range header.', { status: 400 });
			start = +parsed[1];
			if (parsed[3] !== '*') total = +parsed[3];
		}
		if (session.total !== undefined && total !== session.total) {
			session.failure = `Invalid request.  According to the Content-Range header, the final size of the upload is ${total} byte(s). This does not match the expected size of ${session.total} byte(s), which was specified in an earlier request.`;
			return new Response(session.failure, { status: 400 });
		}
		if (total !== undefined) session.total = total;
		if (!range && total !== undefined && bytes.length < total && bytes.length >= 262144) unsupported('a short whole-file resumable PUT without Content-Range');
		// Drive keeps the already accepted prefix, even if replayed bytes differ.
		if (start < session.bytes.length) {
			bytes = bytes.subarray(Math.min(bytes.length, session.bytes.length - start));
			start = session.bytes.length;
			if (!bytes.length) return progress();
		}
		if (start !== session.bytes.length || (total !== undefined && start + bytes.length > total)) return new Response('Invalid upload offset.', { status: 400 });
		if ((total === undefined || start + bytes.length < total) && bytes.length < 262144) {
			session.failure = `Invalid request.  The number of bytes uploaded is required to be equal or greater than 262144, except for the final request (it's recommended to be the exact multiple of 262144).  The received request contained ${bytes.length} bytes, which does not meet this requirement.`;
			return new Response(session.failure, { status: 400 });
		}
		// Non-final requests only acknowledge whole 256 KiB blocks.
		if (total === undefined || start + bytes.length < total) bytes = bytes.subarray(0, Math.floor(bytes.length / 262144) * 262144);
		const accumulated = new Uint8Array(start + bytes.length);
		accumulated.set(session.bytes); accumulated.set(bytes, start);
		session.bytes = accumulated;
		if (total !== undefined && accumulated.length < total || range && total === undefined) return progress();
		let file: DriveFile | Response;
		if (session.id) {
			const existing = this.findById(session.id);
			if (!existing) return notFound(session.id);
			const error = await this.update(existing, session.metadata, url, accumulated);
			if (error) return error;
			file = existing;
		} else file = await this.create(session.metadata, { content: accumulated, mimeType: session.mimeType });
		if (file instanceof Response) return file;
		session.completed = file;
		return this.fileResponse(file, session.fields);
	}

	private async batch(method: string, headers: Headers, bytes: Uint8Array): Promise<Response> {
		if (method !== 'POST') unsupported(`batch method ${method}`);
		const ct = headers.get('Content-Type') ?? '';
		const boundaryMatch = ct.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
		if (!/^multipart\/mixed\b/i.test(ct) || !boundaryMatch) return batchBadRequest('Failed to get multipart boundary.');
		const reqBoundary = boundaryMatch[1] ?? boundaryMatch[2];
		const raw = decoder.decode(bytes);
		const escaped = reqBoundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const delimiter = new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?(?:\\r?\\n|$)`, 'g');
		const parts: string[] = [];
		let partStart = -1;
		let closed = false;
		let match: RegExpExecArray | null;
		while ((match = delimiter.exec(raw)) !== null) {
			if (partStart >= 0) parts.push(raw.slice(partStart, match.index));
			if (match[1] === '--') { closed = true; break; }
			partStart = delimiter.lastIndex;
		}
		if (!closed || parts.length === 0 || parts.length > 100) {
			return batchBadRequest(`Failed to parse batch request, error:  ${parts.length} items.`);
		}

		const resBoundary = 'batch_' + crypto.randomUUID().replace(/-/g, '');
		const resChunks: string[] = [];
		for (const part of parts) {
			const outerSep = part.match(/\r?\n\r?\n/);
			if (!outerSep || outerSep.index === undefined) return batchBadRequest('Malformed batch part.');
			const outerHead = part.slice(0, outerSep.index);
			const innerRaw = part.slice(outerSep.index + outerSep[0].length);
			let partType = '';
			let contentId: string | undefined;
			for (const line of outerHead.split(/\r?\n/)) {
				const colon = line.indexOf(':');
				if (colon <= 0) continue;
				const k = line.slice(0, colon).trim().toLowerCase();
				const v = line.slice(colon + 1).trim();
				if (k === 'content-type') partType = v;
				else if (k === 'content-id') contentId = v;
			}
			if (!/^application\/http\b/i.test(partType)) return batchBadRequest('Batch part must have Content-Type: application/http.');

			const innerSep = innerRaw.match(/\r?\n\r?\n/);
			const innerHead = innerSep && innerSep.index !== undefined ? innerRaw.slice(0, innerSep.index) : innerRaw;
			const innerBody = innerSep && innerSep.index !== undefined ? innerRaw.slice(innerSep.index + innerSep[0].length) : '';
			const headLines = innerHead.split(/\r?\n/);
			const reqLine = headLines[0]?.match(/^([A-Z]+)\s+(\S+)(?:\s+HTTP\/\d(?:\.\d)?)?$/);
			if (!reqLine) return batchBadRequest('Malformed inner HTTP request line.');
			const [, innerMethod, innerTarget] = reqLine;

			const innerHeaders = new Headers();
			for (const line of headLines.slice(1)) {
				const colon = line.indexOf(':');
				if (colon <= 0) continue;
				innerHeaders.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
			}
			if (!innerHeaders.has('Authorization') && headers.has('Authorization')) {
				innerHeaders.set('Authorization', headers.get('Authorization')!);
			}
			if (innerHeaders.has('Content-Length') && Number(innerHeaders.get('Content-Length')) !== encoder.encode(innerBody).byteLength) {
				return batchBadRequest('Mismatched inner Content-Length.');
			}

			const innerUrl = new URL(innerTarget, API);
			if (innerUrl.pathname.startsWith('/upload/') || innerUrl.searchParams.get('alt') === 'media') {
				unsupported('media operations in batch');
			}
			if (innerUrl.pathname === '/batch/drive/v3') unsupported('nested batch requests');

			const innerRes = await this.handle(innerUrl.toString(), {
				method: innerMethod,
				headers: innerHeaders,
				body: innerBody.length ? encoder.encode(innerBody) : undefined,
			});
			const resBodyText = await innerRes.text();
			const resContentType = innerRes.headers.get('Content-Type') ?? 'application/json; charset=UTF-8';
			const resByteLength = encoder.encode(resBodyText).byteLength;
			const mirroredId = contentId === undefined
				? undefined
				: contentId.startsWith('<') && contentId.endsWith('>')
					? `<response-${contentId.slice(1, -1)}>`
					: `response-${contentId}`;
			const statusReason = STATUS_TEXT[innerRes.status] ?? 'Error';

			let partOut = `\r\n--${resBoundary}\r\nContent-Type: application/http\r\n`;
			if (mirroredId !== undefined) partOut += `Content-ID: ${mirroredId}\r\n`;
			partOut += `\r\nHTTP/1.1 ${innerRes.status} ${statusReason}\r\nContent-Type: ${resContentType}\r\nContent-Length: ${resByteLength}\r\n\r\n${resBodyText}`;
			resChunks.push(partOut);
		}
		return new Response(resChunks.join('') + `\r\n--${resBoundary}--\r\n`, {
			status: 200,
			headers: { 'Content-Type': `multipart/mixed; boundary=${resBoundary}` },
		});
	}

	async handle(input: FetchInput, init?: FetchInit): Promise<Response> {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
		const req = input instanceof Request ? input : undefined;
		const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
		const headers = new Headers(init?.headers ?? req?.headers);
		if (url.origin !== API) unsupported(`${method} ${url.origin}${url.pathname}`);
		if (url.pathname === '/batch/drive/v3') return this.batch(method, headers, await bodyBytes(input, init));
		if (url.pathname === '/oauth2/v4/token') {
			if (method !== 'POST') unsupported(`OAuth method ${method}`);
			const form = new URLSearchParams(decoder.decode(await bodyBytes(input, init)));
			if (form.get('grant_type') !== 'refresh_token') return json({ error: 'unsupported_grant_type', error_description: 'Invalid grant_type: ' + (form.get('grant_type') ?? '') }, 400);
			if (!form.get('client_id')) return json({ error: 'invalid_request', error_description: 'Could not determine client ID from request.' }, 400);
			if (!form.get('client_secret')) return json({ error: 'invalid_request', error_description: 'client_secret is missing.' }, 400);
			if (!form.get('refresh_token')) return json({ error: 'invalid_request', error_description: 'Missing required parameter: refresh_token' }, 400);
			if (form.get('client_id') !== this.oauth.clientId || form.get('client_secret') !== this.oauth.clientSecret) return json({ error: 'invalid_client', error_description: 'The OAuth client was not found.' }, 401);
			if (form.get('refresh_token') !== this.oauth.refreshToken) return json({ error: 'invalid_grant', error_description: 'Bad Request' }, 400);
			return json({ access_token: 'test-access-token', token_type: 'Bearer', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive' });
		}
		if (/^\/upload\/drive\/v3\/files(?:\/[^/]+)?$/.test(url.pathname) && url.searchParams.has('upload_id')) return this.uploadSession(url, method, headers, await bodyBytes(input, init));
		if (!headers.has('Authorization')) return apiError(403, 'forbidden', 'Permission denied on the service.');
		if (headers.get('Authorization') !== 'Bearer test-access-token') return json({ error: {
			code: 401, message: 'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.',
			errors: [{ message: 'Invalid Credentials', domain: 'global', reason: 'authError', location: 'Authorization', locationType: 'header' }], status: 'UNAUTHENTICATED',
		} }, 401);
		const fields = url.searchParams.get('fields');
		if (url.pathname === '/drive/v3/about' && method === 'GET') {
			if (!fields) return apiError(400, 'required', "The 'fields' parameter is required for this method.", 'fields');
			const data = { storageQuota: { limit: '1073741824', usage: '4096', usageInDrive: '4096', usageInDriveTrash: '0' } };
			const result = project(data, fields, new Set(['storageQuota']), { key: 'storageQuota', fields: new Set(Object.keys(data.storageQuota)) });
			return result instanceof Response ? result : json(result);
		}
		const upload = url.pathname.match(/^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/);
		if (upload) {
			const id = upload[1];
			if (method !== (id ? 'PATCH' : 'POST')) unsupported(`upload method ${method}`);
			const file = id ? this.findById(id) : undefined;
			if (id && !file) { await bodyBytes(input, init); return notFound(id); }
			if (file?.mimeType.startsWith('application/vnd.google-apps.')) { await bodyBytes(input, init); unsupported('media uploads to folders or Google Workspace documents'); }
			const type = url.searchParams.get('uploadType');
			const bytes = await bodyBytes(input, init);
			// Unlike metadata-only writes, upload endpoints reject bad masks
			// before committing media. This distinction was observed live.
			if (fields) { const selection = project({}, fields, fileFields); if (selection instanceof Response) return selection; }
			if (type === 'resumable') {
				const meta = parseMetadata(bytes); if (meta instanceof Response) return meta;
				if (meta.parents && id) return apiError(403, 'fieldNotWritable', 'The parents field is not directly writable in update requests. Use the addParents and removeParents parameters instead.');
				const error = this.validateParents(meta.parents ?? []); if (error) return error;
				const sessionId = crypto.randomUUID();
				this.sessions.set(sessionId, { id, metadata: meta, mimeType: headers.get('X-Upload-Content-Type') ?? meta.mimeType ?? file?.mimeType ?? 'application/octet-stream',
					total: headers.has('X-Upload-Content-Length') ? Number(headers.get('X-Upload-Content-Length')) : undefined, bytes: new Uint8Array(), fields });
				return new Response(null, { status: 200, headers: { Location: `${API}${url.pathname}?uploadType=resumable&upload_id=${sessionId}` } });
			}
			let meta: Metadata = {}; let content = bytes; let mimeType = headers.get('Content-Type') ?? 'application/octet-stream';
			if (type === 'multipart') {
				const parsed = multipart(bytes, mimeType); if (parsed instanceof Response) return parsed;
				meta = parsed.metadata; content = parsed.content; mimeType = meta.mimeType ?? parsed.mimeType;
			} else if (type !== 'media') unsupported(`uploadType ${type}`);
			if (file) { const error = await this.update(file, meta, url, content); return error ?? this.fileResponse(file, fields); }
			const created = await this.create(meta, { content, mimeType });
			return created instanceof Response ? created : this.fileResponse(created, fields);
		}
		const copy = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)\/copy$/);
		if (copy && method === 'POST') {
			const source = this.findById(copy[1]);
			const meta = parseMetadata(await bodyBytes(input, init)); if (meta instanceof Response) return meta;
			if (!source) return notFound(copy[1]);
			if (source.mimeType === FOLDER) return apiError(403, 'cannotCopyFile', 'This file cannot be copied by the user.');
			await this.ensureChecksums(source);
			const created = await this.create(
				{ name: source.name, parents: source.parents, description: source.description, starred: source.starred, ...meta, mimeType: source.mimeType },
				{ content: source.content, size: source.size ?? 0, md5Checksum: source.md5Checksum, sha1Checksum: source.sha1Checksum, sha256Checksum: source.sha256Checksum },
			);
			if (created instanceof Response) return created;
			return this.fileResponse(created, fields);
		}
		if (url.pathname === '/drive/v3/files') {
			if (method === 'GET') return this.list(url);
			if (method === 'POST') {
				const meta = parseMetadata(await bodyBytes(input, init)); if (meta instanceof Response) return meta;
				const created = await this.create(meta);
				return created instanceof Response ? created : this.fileResponse(created, fields);
			}
		}
		const match = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
		const media = url.pathname.match(/^\/drive\/v[23]\/files\/([^/]+)$/);
		if (media && method === 'GET' && url.searchParams.get('alt') === 'media') {
			const file = this.findById(media[1]);
			if (!file) return notFound(media[1]);
			if (file.mimeType.startsWith('application/vnd.google-apps.')) unsupported('media downloads of folders/native documents');
			const content = file.content;
			if (!content || Number(file.size) !== content.length) unsupported('media fixture without explicit bytes and matching size');
			// v2 media ETag is an opaque strong representation validator, not
			// the v2 JSON etag or v3 metadata version. If-Range is ignored.
			const digest = await crypto.subtle.digest('SHA-256', content.slice());
			const etag = '"' + toHex(digest) + '"';
			const mediaHeaders = { 'Content-Type': file.mimeType, ...(url.pathname.includes('/v2/') ? { ETag: etag } : {}) };
			const range = headers.get('Range');
			if (!range) return new Response(content.slice(), { headers: { ...mediaHeaders, 'Content-Length': String(content.length) } });
			const parsed = range.match(/^bytes=(\d+)-(\d+)$/);
			if (!parsed) unsupported('unverified media range syntax');
			const start = Number(parsed[1]), end = Number(parsed[2]);
			if (url.pathname.includes('/v2/') && start >= content.length) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${content.length}` } });
			if (start > end || end >= content.length) unsupported('unverified media range bounds');
			return new Response(content.slice(start, end + 1), {
				status: 206, headers: { ...mediaHeaders, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${content.length}` },
			});
		}
		if (match && method === 'GET') {
			const file = this.findById(match[1]);
			return file ? this.fileResponse(file, fields) : notFound(match[1]);
		}
		if (match && ['PATCH', 'DELETE'].includes(method)) {
			const file = this.findById(match[1]);
			const bytes = await bodyBytes(input, init);
			if (!file) return notFound(match[1]);
			if (method === 'DELETE') { this.remove(file.id); return new Response(null, { status: 204 }); }
			const meta = parseMetadata(bytes); if (meta instanceof Response) return meta;
			const error = await this.update(file, meta, url);
			return error ?? this.fileResponse(file, fields);
		}
		unsupported(`${method} ${url.pathname}`);
	}
}
