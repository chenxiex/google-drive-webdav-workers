import { type RuntimeConfig } from '../config';
import { StatusError, decodeRelativeSegments, decodeSegment } from '../http';
import { type AuthPrincipal, personalSpaceId } from '../ocis/profile';

export type DavMountKind = 'generic' | 'space' | 'remote-webdav' | 'remote-files';

export type DavPrefixClassification =
    | { kind: DavMountKind; preferBearer: boolean }
    | { redirect: string };

export interface DavMount {
    kind: DavMountKind;
    hrefBase: string;
    segments: string[];
    fpath: string;
    hasTrailingSlash: boolean;
    isTusPath: boolean;
    tusSessionId: string | null;
}

const SPACE_PREFIX = '/dav/spaces/';
const REMOTE_WEBDAV = '/remote.php/webdav';
const REMOTE_WEBDAV_PREFIX = '/remote.php/webdav/';
const REMOTE_FILES_PREFIX = '/remote.php/dav/files/';

function buildMount(kind: DavMountKind, hrefBase: string, rawTail: string): DavMount {
    const { segments, hasTrailingSlash, fpath } = decodeRelativeSegments(rawTail);
    const isTusPath = segments[0] === 'tus_uploads' && (segments.length >= 2 || hasTrailingSlash);
    const tusSessionId = isTusPath && segments.length === 2 && !hasTrailingSlash ? segments[1] : null;
    return { kind, hrefBase, segments, fpath, hasTrailingSlash, isTusPath, tusSessionId };
}

export function classifyDavPrefix(
    pathname: string,
    config: Pick<RuntimeConfig, 'basePath'>,
): DavPrefixClassification | null {
    if (pathname.startsWith(SPACE_PREFIX)) {
        return { kind: 'space', preferBearer: true };
    }
    if (pathname === REMOTE_WEBDAV || pathname.startsWith(REMOTE_WEBDAV_PREFIX)) {
        return { kind: 'remote-webdav', preferBearer: true };
    }
    if (pathname.startsWith(REMOTE_FILES_PREFIX)) {
        return { kind: 'remote-files', preferBearer: true };
    }
    if (pathname + '/' === config.basePath) {
        return { redirect: config.basePath };
    }
    if (pathname.startsWith(config.basePath)) {
        return { kind: 'generic', preferBearer: false };
    }
    return null;
}

export function resolveDavMount(
    pathname: string,
    config: Pick<RuntimeConfig, 'basePath' | 'rootId'>,
    principal: AuthPrincipal,
): DavMount | null {
    if (pathname.startsWith(SPACE_PREFIX)) {
        const rest = pathname.slice(SPACE_PREFIX.length);
        const slashIndex = rest.indexOf('/');
        const rawSpaceSeg = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
        if (!rawSpaceSeg) return null;
        const decodedSpaceId = decodeSegment(rawSpaceSeg);
        if (decodedSpaceId !== `personal$${config.rootId}`) {
            return null;
        }
        const rawTail = slashIndex === -1 ? '' : rest.slice(slashIndex + 1);
        return buildMount('space', `${SPACE_PREFIX}${personalSpaceId(config.rootId)}/`, rawTail);
    }

    if (pathname === REMOTE_WEBDAV || pathname.startsWith(REMOTE_WEBDAV_PREFIX)) {
        const rawTail = pathname === REMOTE_WEBDAV ? '' : pathname.slice(REMOTE_WEBDAV_PREFIX.length);
        return buildMount('remote-webdav', REMOTE_WEBDAV_PREFIX, rawTail);
    }

    if (pathname.startsWith(REMOTE_FILES_PREFIX)) {
        const rest = pathname.slice(REMOTE_FILES_PREFIX.length);
        const slashIndex = rest.indexOf('/');
        const rawUserSeg = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
        if (!rawUserSeg) return null;
        const decodedUser = decodeSegment(rawUserSeg);
        const matchesPrincipal = decodedUser === principal.id
            || (principal.email !== undefined && decodedUser === principal.email)
            || (principal.owner.startsWith('oidc:') && decodedUser === principal.owner.slice(5));
        if (!matchesPrincipal) {
            return null;
        }
        const rawTail = slashIndex === -1 ? '' : rest.slice(slashIndex + 1);
        return buildMount('remote-files', `${REMOTE_FILES_PREFIX}${encodeURIComponent(decodedUser)}/`, rawTail);
    }

    if (pathname.startsWith(config.basePath)) {
        const rawTail = pathname.slice(config.basePath.length);
        return buildMount('generic', config.basePath, rawTail);
    }

    return null;
}

export function resolveDestinationMount(
    destinationHeader: string,
    requestUrl: string,
    sourceMount: DavMount,
    config: Pick<RuntimeConfig, 'basePath' | 'rootId' | 'publicOrigin'>,
    principal: AuthPrincipal,
): DavMount {
    let destUrl: URL;
    try {
        destUrl = new URL(destinationHeader, requestUrl);
    } catch {
        throw new StatusError('Invalid Destination header', 400);
    }
    const requestOrigin = new URL(requestUrl).origin;
    if (destUrl.origin !== requestOrigin && (config.publicOrigin === undefined || destUrl.origin !== config.publicOrigin)) {
        throw new StatusError('Cross-origin Destination is not supported', 502);
    }
    const destMount = resolveDavMount(destUrl.pathname, config, principal);
    if (!destMount || destMount.kind !== sourceMount.kind) {
        throw new StatusError('Destination is outside the current WebDAV mount', 403);
    }
    return destMount;
}
