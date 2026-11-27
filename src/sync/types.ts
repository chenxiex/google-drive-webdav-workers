export type SyncMutation =
    | { type: 'upsert'; id: string; parentId: string; isFolder: boolean }
    | { type: 'upsert_tree'; parentId: string; replacedId?: string | null; items: Array<{ id: string; parentId: string; isFolder: boolean }> }
    | { type: 'touch'; id: string; parentId?: string | null; isFolder: boolean }
    | { type: 'delete'; id: string; parentId?: string | null }
    | { type: 'move'; id: string; oldParentId?: string | null; newParentId: string; isFolder: boolean; replacedId?: string | null };

export function folderEtag(folderId: string, epoch: string, etagGen: number): string {
    return `"${folderId}-${epoch}-${etagGen}"`;
}
