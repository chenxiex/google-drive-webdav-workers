# Worker Source Guide

- **Workers runtime constraints**: Code under `src/` runs on Cloudflare Workers without `nodejs_compat`. Use pure Web APIs only (`crypto.subtle`, `Uint8Array`, `TextEncoder`/`TextDecoder`, `atob`/`btoa`); never import `node:*` modules or use `Buffer`.
- **Durable Object registration**: Every SQLite Durable Object class must be exported from `src/index.ts` and declared consistently across `wrangler.jsonc`, `wrangler.staging.example.jsonc`, `vitest.config.mts`, and `worker-configuration.d.ts`.
- **Caching boundary**: Isolate-local memory caches must remain bounded and are never the source of truth for durable state.
