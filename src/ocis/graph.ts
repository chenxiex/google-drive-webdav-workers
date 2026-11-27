import { type RuntimeConfig, resolvePublicOrigin } from '../config';
import { type DriveClient } from '../drive/client';
import { FOLDER_MIME, type StorageQuota, fileEtag } from '../drive/types';
import { StatusError } from '../http';
import { PERSONAL_SPACE_NAME, personalSpaceId } from './profile';

export interface GraphQuota {
    total: bigint;
    used: bigint;
    remaining: bigint;
    state: 'normal' | 'nearing' | 'critical' | 'exceeded';
}

export interface GraphDriveInput {
    id: string;
    name: string;
    eTag: string;
    webDavUrl: string;
    lastModifiedDateTime?: string;
    quota?: GraphQuota;
}

export function buildGraphQuota(quota: StorageQuota | undefined): GraphQuota | undefined {
    if (!quota || quota.limit === undefined || quota.available === undefined) {
        return undefined;
    }
    const total = BigInt(quota.limit);
    const used = BigInt(quota.used);
    const remaining = BigInt(quota.available);
    if (total <= 0n) {
        return undefined;
    }
    const state = used >= total
        ? 'exceeded'
        : used * 100n >= total * 90n
            ? 'critical'
            : used * 100n >= total * 75n
                ? 'nearing'
                : 'normal';
    return { total, used, remaining, state };
}

export function computeSpaceRootEtag(
    rootMeta: { id?: string; headRevisionId?: string | null; version?: string | number; modifiedTime?: string | null },
    fallbackId: string,
): string {
    return fileEtag(rootMeta) ?? `"${rootMeta.id || fallbackId}-${rootMeta.modifiedTime || '0'}"`;
}

export function serializeGraphDrivesJson(drive: GraphDriveInput): string {
    const entry: Record<string, unknown> = {
        id: drive.id,
        driveType: 'personal',
        name: drive.name,
        eTag: drive.eTag,
        ...(drive.lastModifiedDateTime ? { lastModifiedDateTime: drive.lastModifiedDateTime } : {}),
        root: {
            id: drive.id,
            eTag: drive.eTag,
            webDavUrl: drive.webDavUrl,
        },
    };
    const baseJson = JSON.stringify(entry);
    if (!drive.quota) {
        return `{"value":[${baseJson}]}`;
    }
    // Emit integer strings verbatim so int64 quotas above MAX_SAFE_INTEGER never lose precision.
    const quotaJson = `{"remaining":${drive.quota.remaining.toString()},"state":${JSON.stringify(drive.quota.state)},"total":${drive.quota.total.toString()},"used":${drive.quota.used.toString()}}`;
    return `{"value":[${baseJson.slice(0, -1)},"quota":${quotaJson}}]}`;
}

export async function handleGraphMeDrives(
    request: Request,
    config: RuntimeConfig,
    drive: DriveClient,
): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const origin = resolvePublicOrigin(request, config, 'HTTPS is required for Graph endpoints');
    const [rootMeta, rawQuota] = await Promise.all([
        drive.getPropertyMetadata(config.rootId),
        drive.getQuota().catch(() => undefined),
    ]);
    if (rootMeta?.mimeType !== FOLDER_MIME) {
        throw new StatusError('Configured ROOT_ID is not a folder', 500);
    }

    const spaceId = personalSpaceId(config.rootId);
    const rootEtag = drive.sync
        ? (await drive.sync.poll()).rootEtag
        : computeSpaceRootEtag(rootMeta, config.rootId);
    const body = method === 'HEAD'
        ? null
        : serializeGraphDrivesJson({
            id: spaceId,
            name: PERSONAL_SPACE_NAME,
            eTag: rootEtag,
            webDavUrl: `${origin}/dav/spaces/${spaceId}`,
            ...(typeof rootMeta.modifiedTime === 'string' && rootMeta.modifiedTime
                ? { lastModifiedDateTime: rootMeta.modifiedTime }
                : {}),
            quota: buildGraphQuota(rawQuota),
        });

    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    });
}
