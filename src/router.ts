import { basicAuthentication, isValidUser } from './auth/basic';
import { resolveConfig } from './config';
import { DriveClient } from './drive/client';
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
        const basePath = config.basePath;
        if (basePath !== '/') {
            if (pathname + '/' === basePath) {
                const u = new URL(request.url);
                u.pathname += '/';
                return Response.redirect(u.toString(), 301);
            }
            if (!pathname.startsWith(basePath)) {
                return new Response('404 Not Found', { status: 404 });
            }
        }

        // Global Basic Authentication
        if (Object.keys(config.users).length === 0) {
            return new Response('Server not configured: set the USERS variable', { status: 500 });
        }
        if (!request.headers.has('Authorization')) {
            return new Response('Authentication Required.', {
                status: 401,
                headers: { 'WWW-Authenticate': `Basic realm="${config.name}", charset="UTF-8"` },
            });
        }

        const auth = basicAuthentication(request);
        if (!auth || !isValidUser(config.users, auth)) {
            return new Response('Unauthorized', { status: 401 });
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
                return await (isTusPath ? handleTusUpload(drive, env, auth.user, request) : handleHead(drive, request));
            case 'PUT':
                return await handlePut(drive, request);
            case 'POST':
                return await handleTusCreate(drive, env, auth.user, request);
            case 'PATCH':
                if (isTusPath) return await handleTusUpload(drive, env, auth.user, request);
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
    } catch (e: any) {
        const status = e.status || e.code || 500;
        return new Response(status + ': ' + e.message, { status });
    }
}
