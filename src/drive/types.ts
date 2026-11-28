export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GOOGLE_APPS_MIME_PREFIX = 'application/vnd.google-apps.';
export const PROPERTY_FIELDS = 'id,version,headRevisionId,name,mimeType,size,modifiedTime,createdTime,description,starred,folderColorRgb,appProperties,parents,md5Checksum,sha1Checksum,sha256Checksum';
export const UPLOAD_RESULT_FIELDS = 'id,version,headRevisionId,md5Checksum,sha1Checksum,sha256Checksum';

export interface UploadedDriveFile {
    id?: string;
    version?: string | number;
    headRevisionId?: string | null;
    md5Checksum?: string;
    sha1Checksum?: string;
    sha256Checksum?: string;
}

export function fileEtag(file: {
    id?: string;
    headRevisionId?: string | null;
    version?: string | number;
}): string | undefined {
    if (!file.id) return undefined;
    const validator = typeof file.headRevisionId === 'string' && file.headRevisionId
        ? file.headRevisionId
        : (typeof file.version === 'string' && file.version
            ? file.version
            : (typeof file.version === 'number' ? String(file.version) : undefined));
    return validator ? `"${file.id}-${validator}"` : undefined;
}

export interface StorageQuota {
    limit?: string;
    available?: string;
    used: string;
}

/**
 * Excludes Google Workspace native documents and Drive Shortcuts while keeping
 * folders and ordinary files visible to WebDAV clients.
 */
export function isVisibleDriveItem(file: { mimeType?: string }): boolean {
    return !file.mimeType?.startsWith(GOOGLE_APPS_MIME_PREFIX) || file.mimeType === FOLDER_MIME;
}

const GOOGLE_THUMBNAIL_HOST_SUFFIXES = [
    'googleusercontent.com',
    'googleapis.com',
    'google.com',
    'gstatic.com',
    'ggpht.com',
] as const;

export function isGoogleThumbnailHost(hostname: string): boolean {
    const normalized = hostname.trim().toLowerCase().replace(/\.+$/, '');
    if (!normalized) return false;
    return GOOGLE_THUMBNAIL_HOST_SUFFIXES.some(
        suffix => normalized === suffix || normalized.endsWith('.' + suffix),
    );
}

export function parseThumbnailUrl(raw: unknown): URL | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
        return null;
    }
    const bareHost = url.hostname.toLowerCase().replace(/\.+$/, '');
    if (
        !bareHost
        || bareHost === 'localhost'
        || bareHost.endsWith('.localhost')
        || bareHost.startsWith('[')
        || bareHost.includes(':')
        || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bareHost)
        || !bareHost.includes('.')
    ) {
        return null;
    }
    return url;
}

export function hasUsableThumbnail(file: { mimeType?: string; thumbnailLink?: unknown }): boolean {
    return file.mimeType !== FOLDER_MIME && isVisibleDriveItem(file) && parseThumbnailUrl(file.thumbnailLink) !== null;
}
