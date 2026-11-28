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
