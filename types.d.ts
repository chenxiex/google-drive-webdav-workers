interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    size?: number | string;
    modifiedTime: string | null;
    description?: string;
    iconLink?: string;
    thumbnailLink?: string;
    imageMediaMetadata?: any;
    parents?: string[];
    dir?: boolean;
    lastmodified?: string | null;
    quota?: { used: number | string; available: number | string } | null;
    type?: string;
    etag?: string;
}
