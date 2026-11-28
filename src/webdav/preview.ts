import { type DriveClient } from '../drive/client';
import { FOLDER_MIME, fileEtag, parseThumbnailUrl } from '../drive/types';
import { StatusError, errorStatus } from '../http';
import { type DavMount } from './mount';

export const MAX_PREVIEW_DIMENSION = 4096;
export const MAX_PREVIEW_C_LENGTH = 512;

export interface PreviewQuery {
    x?: number;
    y?: number;
    c: string;
}

function parseDimensionParam(params: URLSearchParams, key: 'x' | 'y'): number | undefined {
    const values = params.getAll(key);
    if (values.length === 0) return undefined;
    if (values.length > 1) {
        throw new StatusError(`Duplicate preview dimension "${key}"`, 400);
    }
    const raw = values[0];
    if (!/^[1-9]\d*$/.test(raw)) {
        throw new StatusError(`Invalid preview dimension "${key}"`, 400);
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed > MAX_PREVIEW_DIMENSION) {
        throw new StatusError(`Preview dimension "${key}" exceeds ${MAX_PREVIEW_DIMENSION}`, 400);
    }
    return parsed;
}

export function parsePreviewQuery(url: URL): PreviewQuery | null {
    if (url.searchParams.get('preview') !== '1') return null;
    const x = parseDimensionParam(url.searchParams, 'x');
    const y = parseDimensionParam(url.searchParams, 'y');
    const cValues = url.searchParams.getAll('c');
    if (cValues.length > 1) {
        throw new StatusError('Duplicate preview cache hint "c"', 400);
    }
    const c = cValues[0] ?? '';
    if (c.length > MAX_PREVIEW_C_LENGTH || /[\x00-\x1f\x7f]/.test(c)) {
        throw new StatusError('Invalid preview cache hint "c"', 400);
    }
    return {
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
        c,
    };
}

function stripOuterQuotes(value: string): string {
    return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1)
        : value;
}

function formatLastModified(modifiedTime: unknown): string | undefined {
    if (typeof modifiedTime !== 'string' || !modifiedTime) return undefined;
    const timestamp = Date.parse(modifiedTime);
    if (!Number.isFinite(timestamp)) return undefined;
    return new Date(timestamp).toUTCString();
}

function resolvePreviewValidators(metadata: any): {
    previewEtag?: string;
    lastModified?: string;
} {
    const etag = fileEtag(metadata);
    const previewEtag = etag ? `"preview-${stripOuterQuotes(etag)}"` : undefined;
    const lastModified = formatLastModified(metadata.modifiedTime);
    return { previewEtag, lastModified };
}

function normalizePreviewContentType(raw: string | null): string | null {
    if (!raw) return null;
    const mediaType = raw.split(';', 1)[0].trim().toLowerCase();
    if (!/^image\/[a-z0-9!#$&^_.+-]+$/.test(mediaType) || mediaType === 'image/svg+xml') {
        return null;
    }
    return mediaType;
}

function matchesIfNoneMatch(headerValue: string, etag?: string): boolean {
    const trimmed = headerValue.trim();
    if (trimmed === '*') return true;
    if (!etag) return false;
    const candidates = trimmed.match(/(?:W\/)?"[^"]*"/g);
    if (!candidates) return false;
    const targetOpaque = etag.startsWith('W/') ? etag.slice(2) : etag;
    return candidates.some(tag => {
        const candidateOpaque = tag.startsWith('W/') ? tag.slice(2) : tag;
        return candidateOpaque === targetOpaque;
    });
}

function mapUpstreamErrorStatus(status: number, retryAfter: string | null): Response {
    if (status === 404 || status === 410) {
        return new Response(null, { status: 404 });
    }
    if (status === 429) {
        const headers = new Headers();
        const trimmed = retryAfter?.trim();
        if (trimmed && /^[\x20-\x7e]{1,64}$/.test(trimmed)) {
            headers.set('Retry-After', trimmed);
        }
        return new Response('Preview rate limited', { status: 429, headers });
    }
    return new Response('Preview upstream error', { status: 502 });
}

/**
 * Proxies a Drive file's `thumbnailLink` server-side for `?preview=1` requests
 * by streaming the response without buffering bytes or exposing Google URLs or upstream error details.
 */
export async function handlePreview(
    drive: DriveClient,
    request: Request,
    mount: DavMount,
): Promise<Response> {
    try {
        const params = parsePreviewQuery(new URL(request.url));
        if (!params) {
            return new Response('Missing preview=1 parameter', { status: 400 });
        }

        let metadata = await drive.getMetadata(mount.fpath);
        if (!metadata || metadata.mimeType === FOLDER_MIME) {
            return new Response(null, { status: 404 });
        }

        const initialEtag = fileEtag(metadata);
        if (params.c !== '' && (!initialEtag || stripOuterQuotes(params.c) !== stripOuterQuotes(initialEtag))) {
            metadata = await drive.getMetadata(mount.fpath, { bypassLeafCache: true });
            if (!metadata || metadata.mimeType === FOLDER_MIME) {
                return new Response(null, { status: 404 });
            }
        }

        const thumbnailUrl = parseThumbnailUrl(metadata.thumbnailLink);
        if (!thumbnailUrl) {
            return new Response(null, { status: 404 });
        }

        const validators = resolvePreviewValidators(metadata);
        const headers = new Headers({
            'Cache-Control': 'private, max-age=300',
            Vary: 'Authorization',
            'X-Content-Type-Options': 'nosniff',
        });
        if (validators.previewEtag) {
            headers.set('ETag', validators.previewEtag);
        }
        if (validators.lastModified) {
            headers.set('Last-Modified', validators.lastModified);
        }

        const ifNoneMatch = request.headers.get('If-None-Match');
        if (ifNoneMatch && matchesIfNoneMatch(ifNoneMatch, validators.previewEtag)) {
            return new Response(null, { status: 304, headers });
        }

        const upstream = await drive.fetchThumbnail(thumbnailUrl);
        if (upstream.status !== 200) {
            const retryAfter = upstream.status === 429 ? upstream.headers.get('Retry-After') : null;
            await upstream.body?.cancel();
            return mapUpstreamErrorStatus(upstream.status, retryAfter);
        }

        const contentType = normalizePreviewContentType(upstream.headers.get('Content-Type'));
        if (!contentType) {
            await upstream.body?.cancel();
            return new Response('Invalid preview content type', { status: 502 });
        }

        headers.set('Content-Type', contentType);
        const contentLength = upstream.headers.get('Content-Length')?.trim();
        if (contentLength && /^\d+$/.test(contentLength)) {
            headers.set('Content-Length', contentLength);
        }
        return new Response(upstream.body, { status: 200, headers });
    } catch (error: unknown) {
        const status = errorStatus(error);
        const message = error instanceof Error ? error.message : String(error);
        return new Response(message, { status });
    }
}
