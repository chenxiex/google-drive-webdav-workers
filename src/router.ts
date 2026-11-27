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
import { resolveConfig } from './config';
import { DriveClient } from './drive/client';
import { errorStatus } from './http';
import { handleTusCreate, handleTusUpload } from './tus/handler';
import { handleDelete, handleGet, handleHead, handleLock, handleMkcol, handleOptions } from './webdav/handler';
import { handlePropfind, handleProppatch } from './webdav/properties';
import { handleCopy, handleMove } from './webdav/transfer';
import { handlePut } from './webdav/upload';

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

        const basePath = config.basePath;
        if (pathname + '/' === basePath) {
            const u = new URL(request.url);
            u.pathname += '/';
            return Response.redirect(u.toString(), 301);
        }
        if (!pathname.startsWith(basePath)) {
            return new Response('404 Not Found', { status: 404 });
        }

        const hasUsers = Object.keys(config.users).length > 0;
        if (!hasUsers && !config.oidc) {
            return new Response('Server not configured: set the USERS variable', { status: 500 });
        }

        const buildChallenges = (bearerError: boolean): Headers => {
            const headers = new Headers();
            if (hasUsers) {
                headers.append('WWW-Authenticate', `Basic realm="${config.name}", charset="UTF-8"`);
            }
            if (config.oidc) {
                headers.append(
                    'WWW-Authenticate',
                    bearerError
                        ? `Bearer realm="${config.name}", error="invalid_token"`
                        : `Bearer realm="${config.name}", charset="UTF-8"`,
                );
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

        let owner: string;
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
            owner = `oidc:${principal.sub}`;
        } else if (scheme === 'basic') {
            if (!hasUsers) {
                return new Response('Unauthorized', { status: 401, headers: buildChallenges(false) });
            }
            const auth = basicAuthentication(request);
            if (!auth || !isValidUser(config.users, auth)) {
                return new Response('Unauthorized', { status: 401 });
            }
            owner = `basic:${auth.user}`;
        } else {
            return new Response('Unauthorized', { status: 401, headers: buildChallenges(false) });
        }

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

        const drive = new DriveClient(config);
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
