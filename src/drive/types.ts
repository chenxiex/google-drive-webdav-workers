export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const PROPERTY_FIELDS = 'id,version,name,mimeType,size,modifiedTime,createdTime,description,starred,folderColorRgb,appProperties,parents';

export interface StorageQuota {
    available?: string;
    used: string;
}
