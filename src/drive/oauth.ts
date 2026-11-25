import { type RuntimeConfig } from '../config';
import { StatusError, encodeQueryString } from '../http';

// The OAuth access token has its own short-lived isolate-local cache.
let tokenCache: { key: string; access_token: string; expires: number } | null = null;
const fetchingTokens = new Map<string, Promise<string>>();

export async function getAccessToken(config: Pick<RuntimeConfig, 'client_id' | 'client_secret' | 'refresh_token'>): Promise<string> {
    const cacheKey = `${config.client_id}\0${config.refresh_token}`;
    if (tokenCache && tokenCache.key === cacheKey && tokenCache.expires > Date.now()) return tokenCache.access_token;
    const inflight = fetchingTokens.get(cacheKey);
    if (inflight) return await inflight;
    const promise = (async () => {
        try {
            const response = await fetch('https://www.googleapis.com/oauth2/v4/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: encodeQueryString({
                    client_id: config.client_id,
                    client_secret: config.client_secret,
                    refresh_token: config.refresh_token,
                    grant_type: 'refresh_token',
                }),
            });
            const result: any = await response.json();
            if (result.error) {
                throw new StatusError(result.error_description, response.status);
            }
            tokenCache = { key: cacheKey, expires: Date.now() + 3500 * 1000, access_token: result.access_token };
            return result.access_token;
        } finally {
            fetchingTokens.delete(cacheKey);
        }
    })();
    fetchingTokens.set(cacheKey, promise);
    return await promise;
}
