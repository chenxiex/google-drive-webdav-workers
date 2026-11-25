export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GOOGLE_APPS_MIME_PREFIX = 'application/vnd.google-apps.';
export const PROPERTY_FIELDS = 'id,version,name,mimeType,size,modifiedTime,createdTime,description,starred,folderColorRgb,appProperties,parents';

export interface StorageQuota {
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
