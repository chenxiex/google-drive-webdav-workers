import { DurableObject } from 'cloudflare:workers';
import { isScopeSubset } from './clients';
import { base64UrlEncode, sha256Hex } from './jwt';

const AUTH_CODE_TTL_MS = 60 * 1000;
const ACCESS_TOKEN_TTL_SEC = 3600;
const ACCESS_TOKEN_TTL_MS = ACCESS_TOKEN_TTL_SEC * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface AuthCodeRow extends Record<string, SqlStorageValue> {
    code_hash: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    scope: string;
    nonce: string | null;
    sub: string;
    email: string;
    preferred_username: string;
    name: string;
    expires_at: number;
}

interface RefreshTokenRow extends Record<string, SqlStorageValue> {
    token_hash: string;
    client_id: string;
    scope: string;
    sub: string;
    email: string;
    preferred_username: string;
    name: string;
    created_at: number;
    expires_at: number;
}

interface AccessTokenRow extends Record<string, SqlStorageValue> {
    token_hash: string;
    refresh_hash: string;
    client_id: string;
    scope: string;
    sub: string;
    email: string;
    preferred_username: string;
    name: string;
    expires_at: number;
}

function generateOpaqueToken(prefix: string): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return `${prefix}_${base64UrlEncode(bytes)}`;
}

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    });
}

/**
 * SQLite-backed Durable Object persisting short-lived single-use OAuth
 * authorization codes, opaque access tokens, and reusable refresh tokens.
 */
export class AuthStore extends DurableObject {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS auth_codes (
                code_hash TEXT PRIMARY KEY,
                client_id TEXT NOT NULL,
                redirect_uri TEXT NOT NULL,
                code_challenge TEXT NOT NULL,
                scope TEXT NOT NULL,
                nonce TEXT,
                sub TEXT NOT NULL,
                email TEXT NOT NULL,
                preferred_username TEXT NOT NULL,
                name TEXT NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS refresh_tokens (
                token_hash TEXT PRIMARY KEY,
                client_id TEXT NOT NULL,
                scope TEXT NOT NULL,
                sub TEXT NOT NULL,
                email TEXT NOT NULL,
                preferred_username TEXT NOT NULL,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS access_tokens (
                token_hash TEXT PRIMARY KEY,
                refresh_hash TEXT NOT NULL,
                client_id TEXT NOT NULL,
                scope TEXT NOT NULL,
                sub TEXT NOT NULL,
                email TEXT NOT NULL,
                preferred_username TEXT NOT NULL,
                name TEXT NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_access_refresh ON access_tokens(refresh_hash);
            CREATE INDEX IF NOT EXISTS idx_access_expires ON access_tokens(expires_at);
            CREATE INDEX IF NOT EXISTS idx_refresh_expires ON refresh_tokens(expires_at);
            CREATE INDEX IF NOT EXISTS idx_codes_expires ON auth_codes(expires_at);
        `);
    }

    private async scheduleCleanup(candidateMs: number): Promise<void> {
        const current = await this.ctx.storage.getAlarm();
        if (current === null || candidateMs < current) {
            await this.ctx.storage.setAlarm(candidateMs);
        }
    }

    async alarm(): Promise<void> {
        const now = Date.now();
        this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec('DELETE FROM auth_codes WHERE expires_at <= ?', now);
            this.ctx.storage.sql.exec('DELETE FROM access_tokens WHERE expires_at <= ?', now);
            this.ctx.storage.sql.exec('DELETE FROM refresh_tokens WHERE expires_at <= ?', now);
        });
        const next = this.ctx.storage.sql.exec<{ next_exp: number | null }>(`
            SELECT MIN(expires_at) AS next_exp FROM (
                SELECT expires_at FROM auth_codes
                UNION ALL
                SELECT expires_at FROM access_tokens
                UNION ALL
                SELECT expires_at FROM refresh_tokens
            )
        `).one().next_exp;
        if (typeof next === 'number' && Number.isFinite(next)) {
            await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
        } else {
            await this.ctx.storage.deleteAlarm();
        }
    }

    async fetch(request: Request): Promise<Response> {
        const { pathname } = new URL(request.url);
        if (request.method !== 'POST') {
            return new Response('Method Not Allowed', { status: 405 });
        }

        switch (pathname) {
            case '/codes':
                return this.createCode(request);
            case '/codes/consume':
                return this.consumeCode(request);
            case '/tokens':
                return this.issueTokens(request);
            case '/tokens/refresh':
                return this.refreshTokens(request);
            case '/tokens/introspect':
                return this.introspectToken(request);
            case '/tokens/revoke':
                return this.revokeToken(request);
            default:
                return new Response('Not Found', { status: 404 });
        }
    }

    private async createCode(request: Request): Promise<Response> {
        const body = await request.json<{
            clientId: string;
            redirectUri: string;
            codeChallenge: string;
            scope: string;
            nonce: string | null;
            sub: string;
            email: string;
            preferredUsername: string;
            name: string;
        }>();
        const code = generateOpaqueToken('ocac');
        const codeHash = await sha256Hex(code);
        const expiresAt = Date.now() + AUTH_CODE_TTL_MS;

        this.ctx.storage.sql.exec(
            `INSERT INTO auth_codes (
                code_hash, client_id, redirect_uri, code_challenge, scope, nonce,
                sub, email, preferred_username, name, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            codeHash,
            body.clientId,
            body.redirectUri,
            body.codeChallenge,
            body.scope,
            body.nonce,
            body.sub,
            body.email,
            body.preferredUsername,
            body.name,
            expiresAt,
        );
        await this.scheduleCleanup(expiresAt);
        return jsonResponse({ code }, 201);
    }

    private async consumeCode(request: Request): Promise<Response> {
        const { code } = await request.json<{ code: string }>();
        if (!code) return jsonResponse({ error: 'invalid_grant' }, 404);
        const codeHash = await sha256Hex(code);
        const now = Date.now();

        const row = this.ctx.storage.transactionSync(() => {
            const rows = this.ctx.storage.sql.exec<AuthCodeRow>(
                'SELECT * FROM auth_codes WHERE code_hash = ?',
                codeHash,
            ).toArray();
            this.ctx.storage.sql.exec('DELETE FROM auth_codes WHERE code_hash = ?', codeHash);
            return rows[0];
        });

        if (!row || row.expires_at <= now) {
            return jsonResponse({ error: 'invalid_grant' }, 404);
        }
        return jsonResponse({
            clientId: row.client_id,
            redirectUri: row.redirect_uri,
            codeChallenge: row.code_challenge,
            scope: row.scope,
            nonce: row.nonce,
            sub: row.sub,
            email: row.email,
            preferredUsername: row.preferred_username,
            name: row.name,
        }, 200);
    }

    private async issueTokens(request: Request): Promise<Response> {
        const body = await request.json<{
            clientId: string;
            scope: string;
            sub: string;
            email: string;
            preferredUsername: string;
            name: string;
        }>();
        const accessToken = generateOpaqueToken('ocat');
        const refreshToken = generateOpaqueToken('ocrt');
        const [accessHash, refreshHash] = await Promise.all([
            sha256Hex(accessToken),
            sha256Hex(refreshToken),
        ]);
        const now = Date.now();
        const accessExpiresAt = now + ACCESS_TOKEN_TTL_MS;
        const refreshExpiresAt = now + REFRESH_TOKEN_TTL_MS;

        this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec(
                `INSERT INTO refresh_tokens (
                    token_hash, client_id, scope, sub, email, preferred_username, name, created_at, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                refreshHash,
                body.clientId,
                body.scope,
                body.sub,
                body.email,
                body.preferredUsername,
                body.name,
                now,
                refreshExpiresAt,
            );
            this.ctx.storage.sql.exec(
                `INSERT INTO access_tokens (
                    token_hash, refresh_hash, client_id, scope, sub, email, preferred_username, name, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                accessHash,
                refreshHash,
                body.clientId,
                body.scope,
                body.sub,
                body.email,
                body.preferredUsername,
                body.name,
                accessExpiresAt,
            );
        });
        await this.scheduleCleanup(accessExpiresAt);
        return jsonResponse({
            accessToken,
            refreshToken,
            expiresIn: ACCESS_TOKEN_TTL_SEC,
        }, 201);
    }

    private async refreshTokens(request: Request): Promise<Response> {
        const body = await request.json<{
            refreshToken: string;
            clientId: string;
            scope?: string;
        }>();
        if (!body.refreshToken) {
            return jsonResponse({ error: 'invalid_grant' }, 400);
        }
        const refreshHash = await sha256Hex(body.refreshToken);
        const now = Date.now();
        const rows = this.ctx.storage.sql.exec<RefreshTokenRow>(
            'SELECT * FROM refresh_tokens WHERE token_hash = ?',
            refreshHash,
        ).toArray();
        const row = rows[0];

        if (!row) {
            return jsonResponse({ error: 'invalid_grant' }, 400);
        }
        if (row.expires_at <= now) {
            this.ctx.storage.transactionSync(() => {
                this.ctx.storage.sql.exec('DELETE FROM access_tokens WHERE refresh_hash = ?', refreshHash);
                this.ctx.storage.sql.exec('DELETE FROM refresh_tokens WHERE token_hash = ?', refreshHash);
            });
            return jsonResponse({ error: 'invalid_grant' }, 400);
        }
        if (row.client_id !== body.clientId) {
            return jsonResponse({ error: 'invalid_grant' }, 400);
        }

        let effectiveScope = row.scope;
        if (body.scope !== undefined) {
            const subset = isScopeSubset(body.scope, row.scope);
            if (!subset) {
                return jsonResponse({ error: 'invalid_scope' }, 400);
            }
            effectiveScope = subset;
        }

        const accessToken = generateOpaqueToken('ocat');
        const accessHash = await sha256Hex(accessToken);
        const accessExpiresAt = Date.now() + ACCESS_TOKEN_TTL_MS;

        const inserted = this.ctx.storage.transactionSync(() => {
            const active = this.ctx.storage.sql.exec<{ token_hash: string; expires_at: number }>(
                'SELECT token_hash, expires_at FROM refresh_tokens WHERE token_hash = ?',
                refreshHash,
            ).toArray()[0];
            if (!active || active.expires_at <= Date.now()) {
                return false;
            }
            this.ctx.storage.sql.exec(
                `INSERT INTO access_tokens (
                    token_hash, refresh_hash, client_id, scope, sub, email, preferred_username, name, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                accessHash,
                refreshHash,
                row.client_id,
                effectiveScope,
                row.sub,
                row.email,
                row.preferred_username,
                row.name,
                accessExpiresAt,
            );
            return true;
        });

        if (!inserted) {
            return jsonResponse({ error: 'invalid_grant' }, 400);
        }
        await this.scheduleCleanup(accessExpiresAt);
        return jsonResponse({
            accessToken,
            expiresIn: ACCESS_TOKEN_TTL_SEC,
            scope: effectiveScope,
            sub: row.sub,
            email: row.email,
            preferredUsername: row.preferred_username,
            name: row.name,
        }, 200);
    }

    private async introspectToken(request: Request): Promise<Response> {
        const { accessToken } = await request.json<{ accessToken: string }>();
        if (!accessToken) {
            return jsonResponse({ error: 'invalid_token' }, 401);
        }
        const tokenHash = await sha256Hex(accessToken);
        const row = this.ctx.storage.sql.exec<AccessTokenRow>(
            'SELECT * FROM access_tokens WHERE token_hash = ?',
            tokenHash,
        ).toArray()[0];
        if (!row) {
            return jsonResponse({ error: 'invalid_token' }, 401);
        }
        if (row.expires_at <= Date.now()) {
            this.ctx.storage.sql.exec('DELETE FROM access_tokens WHERE token_hash = ?', tokenHash);
            return jsonResponse({ error: 'invalid_token' }, 401);
        }
        return jsonResponse({
            sub: row.sub,
            email: row.email,
            preferredUsername: row.preferred_username,
            name: row.name,
            scope: row.scope,
            clientId: row.client_id,
            expiresAt: row.expires_at,
        }, 200);
    }

    private async revokeToken(request: Request): Promise<Response> {
        const body = await request.json<{
            token: string;
            clientId: string;
            tokenTypeHint?: string;
        }>();
        if (!body.token) {
            return jsonResponse({ revoked: true }, 200);
        }
        const tokenHash = await sha256Hex(body.token);
        this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec(
                'DELETE FROM access_tokens WHERE refresh_hash = ? AND client_id = ?',
                tokenHash,
                body.clientId,
            );
            this.ctx.storage.sql.exec(
                'DELETE FROM refresh_tokens WHERE token_hash = ? AND client_id = ?',
                tokenHash,
                body.clientId,
            );
            this.ctx.storage.sql.exec(
                'DELETE FROM access_tokens WHERE token_hash = ? AND client_id = ?',
                tokenHash,
                body.clientId,
            );
        });
        return jsonResponse({ revoked: true }, 200);
    }
}
