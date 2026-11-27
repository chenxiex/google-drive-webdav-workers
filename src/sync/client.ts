import { type CacheScope } from '../drive/cache';
import { StatusError } from '../http';
import { type SyncIndex } from './index-do';
import { type SyncMutation, folderEtag } from './types';

interface PollPayload {
    epoch: string;
    rootId: string;
    rootGen: number;
    rootEtag: string;
    reseeded: boolean;
    polled: boolean;
}

interface GenerationsPayload {
    epoch: string;
    rootId: string;
    rootGen: number;
    generations: Record<string, number>;
}

interface MutatePayload {
    initialized: boolean;
    epoch?: string;
    rootId?: string;
    rootGen?: number;
}

/**
 * Per-request client for the SyncIndex Durable Object.
 * Pins starting directory generations within a single request so in-flight
 * Drive listings are never cached or tagged under a newer concurrent generation.
 */
export class SyncIndexClient {
    private readonly stub: DurableObjectStub<SyncIndex>;
    private epoch: string | null = null;
    private resolvedRootId: string | null = null;
    private pinnedGenerations = new Map<string, number>();
    private polledThisRequest = false;

    constructor(
        namespace: DurableObjectNamespace<SyncIndex>,
        private readonly configRootId: string,
        private readonly getAccessToken: () => Promise<string>,
        private readonly refreshAccessToken: () => Promise<string>,
    ) {
        this.stub = namespace.get(namespace.idFromName(`sync:${configRootId}`));
    }

    private async callWithAuth<T>(path: string, buildBody: (accessToken: string) => unknown): Promise<T> {
        let token = await this.getAccessToken();
        for (let attempt = 0; attempt < 2; attempt++) {
            const response = await this.stub.fetch(`https://sync.internal${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(buildBody(token)),
            });
            if (response.status === 401 && attempt === 0) {
                await response.body?.cancel().catch(() => undefined);
                token = await this.refreshAccessToken();
                continue;
            }
            const data = await response.json<T & { error?: string }>().catch(() => null);
            if (!response.ok || !data) {
                throw new StatusError(data?.error || 'Sync index request failed', response.status || 502);
            }
            return data;
        }
        throw new StatusError('Drive unauthorized', 401);
    }

    private syncEpochState(epoch: string, resolvedRootId: string, rootGen: number): void {
        if (this.epoch !== null && this.epoch !== epoch) {
            this.pinnedGenerations.clear();
        }
        this.epoch = epoch;
        this.resolvedRootId = resolvedRootId;
        if (!this.pinnedGenerations.has(this.configRootId)) {
            this.pinnedGenerations.set(this.configRootId, rootGen);
        }
        if (!this.pinnedGenerations.has(resolvedRootId)) {
            this.pinnedGenerations.set(resolvedRootId, rootGen);
        }
    }

    async poll(options?: { force?: boolean }): Promise<PollPayload> {
        const result = await this.callWithAuth<PollPayload>('/poll', accessToken => ({
            rootId: this.configRootId,
            accessToken,
            ...(options?.force ? { force: true } : {}),
        }));
        this.syncEpochState(result.epoch, result.rootId, result.rootGen);
        this.polledThisRequest = true;
        return result;
    }

    async getGeneration(folderId: string): Promise<CacheScope | null> {
        if (this.epoch !== null) {
            const pinned = this.pinnedGenerations.get(folderId);
            if (pinned !== undefined) {
                return { epoch: this.epoch, gen: pinned };
            }
        }
        const shouldPoll = !this.polledThisRequest;
        const result = await this.callWithAuth<GenerationsPayload>('/generations', accessToken => ({
            rootId: this.configRootId,
            accessToken,
            ids: [folderId],
            poll: shouldPoll,
        }));
        if (shouldPoll) this.polledThisRequest = true;
        this.syncEpochState(result.epoch, result.rootId, result.rootGen);
        const gen = result.generations[folderId];
        if (gen === undefined) return null;
        this.pinnedGenerations.set(folderId, gen);
        return { epoch: result.epoch, gen };
    }

    async getFolderEtags(folderIds: string[]): Promise<Map<string, string>> {
        const resultMap = new Map<string, string>();
        if (folderIds.length === 0) return resultMap;

        const missingIds = folderIds.filter(id => this.epoch === null || !this.pinnedGenerations.has(id));
        if (missingIds.length > 0) {
            const result = await this.callWithAuth<GenerationsPayload>('/generations', accessToken => ({
                rootId: this.configRootId,
                accessToken,
                ids: [...new Set(missingIds)],
                poll: false,
            }));
            this.syncEpochState(result.epoch, result.rootId, result.rootGen);
            for (const [id, gen] of Object.entries(result.generations)) {
                if (!this.pinnedGenerations.has(id)) {
                    this.pinnedGenerations.set(id, gen);
                }
            }
        }

        if (this.epoch === null) return resultMap;
        for (const id of folderIds) {
            const gen = this.pinnedGenerations.get(id);
            if (gen === undefined) continue;
            const canonicalId = id === this.configRootId && this.resolvedRootId ? this.resolvedRootId : id;
            resultMap.set(id, folderEtag(canonicalId, this.epoch, gen));
        }
        return resultMap;
    }

    async mutate(mutation: SyncMutation): Promise<void> {
        const response = await this.stub.fetch('https://sync.internal/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rootId: this.configRootId, mutation }),
        });
        const data = await response.json<MutatePayload & { error?: string }>().catch(() => null);
        if (!response.ok || !data) {
            throw new StatusError(data?.error || 'Sync index mutation failed', response.status || 502);
        }
        this.pinnedGenerations.clear();
        if (data.initialized && data.epoch && data.rootId && data.rootGen !== undefined) {
            this.epoch = data.epoch;
            this.resolvedRootId = data.rootId;
            this.pinnedGenerations.set(this.configRootId, data.rootGen);
            this.pinnedGenerations.set(data.rootId, data.rootGen);
        }
    }
}
