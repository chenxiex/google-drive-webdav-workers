import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MockDrive } from '../../support/mock-drive';
import { workerBindings } from '../../support/drive-bindings';

// Use the versions already installed by Wrangler, avoiding an additional runtime.
const requireWrangler = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'));
const { Miniflare } = requireWrangler('miniflare');
const { build } = requireWrangler('esbuild');

export interface RecordedRequest {
    method: string;
    size: number;
    status: number;
}

/** Run the Worker behind a local ingress cap, with Google API calls handled by MockDrive. */
export async function createLocalWorker(ingressLimit: number) {
    const drive = new MockDrive();
    const requests: RecordedRequest[] = [];
    const bundle = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', external: ['cloudflare:workers'] });
    const mf = new Miniflare({
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: '2026-04-15',
        durableObjects: {
            TUS_UPLOADS: { className: 'TusUpload', useSQLite: true },
            SYNC_INDEX: { className: 'SyncIndex', useSQLite: true },
        },
        bindings: workerBindings,
        outboundService: async (request: Request) => {
            const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
            const response = await drive.handle(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body });
            return new Response(response.body, { status: response.status, headers: response.headers });
        },
    });
    const server = createServer((req, res) => {
        void (async () => {
            let size = 0;
            const chunks: Buffer[] = [];
            try {
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > ingressLimit) {
                        requests.push({ method: req.method!, size, status: 413 });
                        res.writeHead(413).end();
                        return;
                    }
                    chunks.push(chunk);
                }
                const url = `http://${req.headers.host}${req.url}`;
                const headers = new Headers();
                for (const [key, value] of Object.entries(req.headers)) {
                    if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
                }
                const body = ['GET', 'HEAD'].includes(req.method!) || size === 0 ? undefined : Buffer.concat(chunks);
                const response = await mf.dispatchFetch(url, { method: req.method, headers, body });
                requests.push({ method: req.method!, size, status: response.status });
                res.writeHead(response.status, Object.fromEntries(response.headers));
                res.end(Buffer.from(await response.arrayBuffer()));
            } catch (error) {
                res.writeHead(500).end(String(error));
            }
        })();
    });
    const dispose = async () => {
        try {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        } finally {
            await mf.dispose();
        }
    };
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
    } catch (error) {
        await mf.dispose();
        throw error;
    }
    const address = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${address.port}/webdav/`, drive, requests, dispose };
}
