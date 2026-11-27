import { StatusError, escapeXml } from '../http';
import { type AuthPrincipal, STATUS_PROFILE, VERSION_PROFILE } from './profile';

export type OcsVersion = 1 | 2;
export type OcsFormat = 'json' | 'xml';

const CAPABILITIES_DATA = {
    capabilities: {
        core: {
            pollinterval: 30000,
            'webdav-root': 'webdav',
            status: STATUS_PROFILE,
            'support-url-signing': false,
            'support-sse': false,
        },
        checksums: {
            supportedTypes: ['sha1', 'md5', 'sha256'],
            preferredUploadType: 'sha1',
        },
        files: {
            privateLinks: false,
            bigfilechunking: false,
            undelete: false,
            versioning: false,
            favorites: false,
            full_text_search: false,
            tags: false,
            blacklisted_files: [] as string[],
            tus_support: {
                version: '1.0.0',
                resumable: '1.0.0',
                extension: 'creation,creation-with-upload',
                max_chunk_size: 10485760,
                http_method_override: '',
            },
        },
        dav: {
            chunking: '',
        },
        files_sharing: {
            api_enabled: false,
            resharing: false,
            public: {
                enabled: false,
            },
            user: {
                profile_picture: false,
            },
        },
        spaces: {
            version: '1.0.0',
            enabled: true,
            projects: false,
            share_jail: false,
            has_multiple_personal_spaces: false,
        },
    },
    version: VERSION_PROFILE,
};

function parseMediaQuality(params: string[]): number | null {
    let quality = 1;
    for (const rawParam of params) {
        const trimmed = rawParam.trim();
        if (!trimmed) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;
        const name = trimmed.slice(0, eqIndex).trim().toLowerCase();
        if (name !== 'q') continue;
        const rawValue = trimmed.slice(eqIndex + 1).trim();
        if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(rawValue)) {
            return null;
        }
        quality = Number(rawValue);
        break;
    }
    return quality > 0 ? quality : null;
}

export function negotiateOcsFormat(request: Request): OcsFormat {
    const rawFormat = new URL(request.url).searchParams.get('format')?.trim().toLowerCase();
    if (rawFormat) {
        if (rawFormat === 'json' || rawFormat === 'xml') {
            return rawFormat;
        }
        throw new StatusError('Unsupported OCS format', 400);
    }

    const accept = request.headers.get('Accept');
    if (!accept) return 'xml';

    let jsonQ = -1;
    let xmlQ = -1;

    for (const range of accept.split(',')) {
        const [rawMediaType, ...params] = range.split(';');
        const mediaType = rawMediaType.trim().toLowerCase();
        if (!mediaType) continue;

        const isJson = mediaType === 'application/json'
            || mediaType === 'text/json'
            || (mediaType.startsWith('application/') && mediaType.endsWith('+json'));
        const isXml = mediaType === 'application/xml'
            || mediaType === 'text/xml'
            || (mediaType.startsWith('application/') && mediaType.endsWith('+xml'));
        if (!isJson && !isXml) continue;

        const quality = parseMediaQuality(params);
        if (quality === null) continue;
        if (isJson && quality > jsonQ) jsonQ = quality;
        if (isXml && quality > xmlQ) xmlQ = quality;
    }

    return jsonQ > xmlQ ? 'json' : 'xml';
}

function serializeXmlNode(tag: string, value: unknown): string {
    if (value === null || value === undefined || value === '') {
        return `<${tag}/>`;
    }
    if (Array.isArray(value)) {
        if (value.length === 0) return `<${tag}/>`;
        return `<${tag}>${value.map(item => serializeXmlNode('element', item)).join('')}</${tag}>`;
    }
    if (typeof value === 'object') {
        const children = Object.entries(value as Record<string, unknown>)
            .filter(([, child]) => child !== undefined)
            .map(([key, child]) => serializeXmlNode(key, child))
            .join('');
        return children ? `<${tag}>${children}</${tag}>` : `<${tag}/>`;
    }
    return `<${tag}>${escapeXml(value)}</${tag}>`;
}

export function serializeOcsXml(envelope: {
    ocs: { meta: Record<string, unknown>; data: Record<string, unknown> };
}): string {
    return '<?xml version="1.0" encoding="UTF-8"?>' + serializeXmlNode('ocs', envelope.ocs);
}

function ocsResponse(request: Request, version: OcsVersion, data: Record<string, unknown>): Response {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const format = negotiateOcsFormat(request);
    const envelope = {
        ocs: {
            meta: {
                status: 'ok',
                statuscode: version === 1 ? 100 : 200,
                message: 'OK',
            },
            data,
        },
    };
    const body = method === 'HEAD'
        ? null
        : format === 'json'
            ? JSON.stringify(envelope)
            : serializeOcsXml(envelope);

    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'application/xml; charset=utf-8',
            'Ocs-Api-Version': String(version),
            'Cache-Control': 'no-store',
            Vary: 'Accept',
        },
    });
}

export function handleOcsUser(request: Request, version: OcsVersion, principal: AuthPrincipal): Response {
    return ocsResponse(request, version, {
        id: principal.id,
        'display-name': principal.displayName,
        ...(principal.email ? { email: principal.email } : {}),
    });
}

export function handleOcsCapabilities(request: Request, version: OcsVersion): Response {
    return ocsResponse(request, version, CAPABILITIES_DATA);
}
