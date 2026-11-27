import { basicAuthentication, isValidUser } from './auth/basic';
import {
    extractBearerToken,
    handleAuthorize,
    handleJwks,
    handleOidcDiscovery,
    handleRevoke,
    handleToken,
    handleUserInfo,
    handleWebFinger,
    introspectBearerToken,
} from './auth/oidc';
import { type RuntimeConfig, resolveConfig } from './config';
import { DriveClient } from './drive/client';
import { getAccessToken, invalidateAccessToken } from './drive/oauth';
import { decodePath, errorStatus } from './http';
import { handleGraphMeDrives } from './ocis/graph';
import { handleOcsCapabilities, handleOcsUser } from './ocis/ocs';
import { type AuthPrincipal, handleOcisDavOptions, handleStatusPhp } from './ocis/profile';
import { SyncIndexClient } from './sync/client';
import { handleTusCreate, handleTusUpload } from './tus/handler';
import { handleDelete, handleGet, handleHead, handleLock, handleMkcol, handleOptions } from './webdav/handler';
import { handlePropfind, handleProppatch } from './webdav/properties';
import { handleCopy, handleMove } from './webdav/transfer';
import { handlePut } from './webdav/upload';

async function authenticateRequest(
    request: Request,
    env: Env,
    config: RuntimeConfig,
    options: { preferBearer: boolean },
): Promise<AuthPrincipal | Response> {
    const hasUsers = Object.keys(config.users).length > 0;
    if (!hasUsers && !config.oidc) {
        return new Response('Server not configured: set the USERS variable', { status: 500 });
    }

    const buildChallenges = (bearerError: boolean): Headers => {
        const headers = new Headers();
        const appendBasic = () => {
            if (hasUsers) {
                headers.append('WWW-Authenticate', `Basic realm="${config.name}", charset="UTF-8"`);
            }
        };
        const appendBearer = () => {
            if (config.oidc) {
                headers.append(
                    'WWW-Authenticate',
                    bearerError
                        ? `Bearer realm="${config.name}", error="invalid_token"`
                        : `Bearer realm="${config.name}", charset="UTF-8"`,
                );
            }
        };
        if (options.preferBearer) {
            appendBearer();
            appendBasic();
        } else {
            appendBasic();
            appendBearer();
        }
        return headers;
    };

    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
        return new Response('Authentication Required.', {
            status: 401,
            headers: buildChallenges(false),
        });
    }

    const spaceIndex = authHeader.indexOf(' ');
    const scheme = (spaceIndex === -1 ? '' : authHeader.slice(0, spaceIndex)).toLowerCase();

    if (scheme === 'bearer') {
        if (!config.oidc) {
            return new Response('Unauthorized', { status: 401, headers: buildChallenges(false) });
        }
        const bearer = extractBearerToken(request);
        const principal = bearer.token ? await introspectBearerToken(bearer.token, env) : null;
        if (!principal) {
            return new Response('Unauthorized', { status: 401, headers: buildChallenges(true) });
        }
        const id = principal.preferredUsername || principal.email || principal.sub;
        const displayName = principal.name || id;
        return {
            owner: `oidc:${principal.sub}`,
            id,
            displayName,
            ...(principal.email ? { email: principal.email } : {}),
        };
    }

    if (scheme === 'basic') {
        if (!hasUsers) {
            return new Response('Unauthorized', { status: 401, headers: buildChallenges(false) });
        }
        const auth = basicAuthentication(request);
        if (!auth || !isValidUser(config.users, auth)) {
            return new Response('Unauthorized', { status: 401 });
        }
        return {
            owner: `basic:${auth.user}`,
            id: auth.user,
            displayName: auth.user,
        };
    }

    return new Response('Unauthorized', { status: 401, headers: buildChallenges(false) });
}

function assertDriveConfigured(config: RuntimeConfig): Response | null {
    const missing = [
        ['CLIENT_ID', config.client_id],
        ['CLIENT_SECRET', config.client_secret],
        ['REFRESH_TOKEN', config.refresh_token],
    ]
        .filter(([, value]) => !value)
        .map(([key]) => key);
    if (missing.length > 0) {
        return new Response('Server not configured: missing ' + missing.join(', '), { status: 500 });
    }
    return null;
}

function createDriveClient(config: RuntimeConfig, env: Env): DriveClient {
    const sync = env.SYNC_INDEX
        ? new SyncIndexClient(
            env.SYNC_INDEX,
            config.rootId,
            () => getAccessToken(config),
            () => {
                invalidateAccessToken(config);
                return getAccessToken(config);
            },
        )
        : null;
    return new DriveClient(config, sync);
}

export async function handleRequest(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();

    if (pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /', { status: 200 });
    if (pathname === '/favicon.ico') return new Response(null, { status: 204 });
    if (pathname.indexOf('/desktop.ini') !== -1) return new Response(null, { status: 404 });

    try {
        const config = resolveConfig(env);

        if (pathname === '/.well-known/webfinger') {
            return handleWebFinger(request);
        }
        if (pathname === '/.well-known/openid-configuration') {
            return config.oidc ? handleOidcDiscovery(request, config) : new Response('404 Not Found', { status: 404 });
        }
        if (pathname.startsWith('/oauth/')) {
            if (!config.oidc) return new Response('404 Not Found', { status: 404 });
            switch (pathname) {
                case '/oauth/authorize':
                    return await handleAuthorize(request, env, config);
                case '/oauth/token':
                    return await handleToken(request, env, config);
                case '/oauth/userinfo':
                    return await handleUserInfo(request, env, config);
                case '/oauth/jwks':
                    return await handleJwks(request, config);
                case '/oauth/revoke':
                    return await handleRevoke(request, env, config);
                default:
                    return new Response('404 Not Found', { status: 404 });
            }
        }

        if (pathname === '/status.php') {
            return handleStatusPhp(request);
        }
        if (
            pathname === '/ocs/v1.php/cloud/user'
            || pathname === '/ocs/v2.php/cloud/user'
            || pathname === '/ocs/v1.php/cloud/capabilities'
            || pathname === '/ocs/v2.php/cloud/capabilities'
        ) {
            const auth = await authenticateRequest(request, env, config, { preferBearer: true });
            if (auth instanceof Response) return auth;
            const version = pathname.startsWith('/ocs/v1.php/') ? 1 : 2;
            return pathname.endsWith('/user')
                ? handleOcsUser(request, version, auth)
                : handleOcsCapabilities(request, version);
        }
        if (pathname === '/graph/v1.0/me/drives') {
            const auth = await authenticateRequest(request, env, config, { preferBearer: true });
            if (auth instanceof Response) return auth;
            if (method !== 'GET' && method !== 'HEAD') {
                return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
            }
            const missingDrive = assertDriveConfigured(config);
            if (missingDrive) return missingDrive;
            return await handleGraphMeDrives(request, config, createDriveClient(config, env));
        }
        if (pathname === '/remote.php/webdav' || pathname.startsWith('/remote.php/webdav/')) {
            const auth = await authenticateRequest(request, env, config, { preferBearer: true });
            if (auth instanceof Response) return auth;
            if (method === 'OPTIONS' && (pathname === '/remote.php/webdav' || pathname === '/remote.php/webdav/')) {
                return handleOcisDavOptions();
            }
            return new Response('404 Not Found', { status: 404 });
        }
        if (pathname.startsWith('/remote.php/dav/files/')) {
            const auth = await authenticateRequest(request, env, config, { preferBearer: true });
            if (auth instanceof Response) return auth;
            decodePath(request.url);
            return new Response('404 Not Found', { status: 404 });
        }

        const basePath = config.basePath;
        if (pathname + '/' === basePath) {
            const u = new URL(request.url);
            u.pathname += '/';
            return Response.redirect(u.toString(), 301);
        }
        if (!pathname.startsWith(basePath)) {
            return new Response('404 Not Found', { status: 404 });
        }

        const auth = await authenticateRequest(request, env, config, { preferBearer: false });
        if (auth instanceof Response) return auth;

        const missingDrive = assertDriveConfigured(config);
        if (missingDrive) return missingDrive;

        const owner = auth.owner;
        const drive = createDriveClient(config, env);
        const isTusPath = pathname.startsWith(basePath + 'tus_uploads/');

        switch (method) {
            case 'OPTIONS':
                return handleOptions(isTusPath);
            case 'PROPFIND':
                return await handlePropfind(drive, request);
            case 'PROPPATCH':
                return await handleProppatch(drive, request);
            case 'MKCOL':
                return await handleMkcol(drive, request);
            case 'GET':
                return await handleGet(drive, request);
            case 'HEAD':
                return await (isTusPath ? handleTusUpload(drive, env, owner, request) : handleHead(drive, request));
            case 'PUT':
                return await handlePut(drive, request);
            case 'POST':
                return await handleTusCreate(drive, env, owner, request);
            case 'PATCH':
                if (isTusPath) return await handleTusUpload(drive, env, owner, request);
                break;
            case 'MOVE':
                return await handleMove(drive, request);
            case 'COPY':
                return await handleCopy(drive, request);
            case 'DELETE':
                return await handleDelete(drive, request);
            case 'LOCK':
            case 'UNLOCK':
                return handleLock();
        }
        return new Response('Method Not Allowed', { status: 405 });
    } catch (e: unknown) {
        const status = errorStatus(e);
        const message = e instanceof Error
            ? e.message
            : typeof (e as any)?.message === 'string'
                ? (e as any).message
                : String(e);
        return new Response(status + ': ' + message, { status });
    }
}
