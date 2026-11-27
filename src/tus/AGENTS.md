# TUS Upload Guide

- **Durable Object (`TUS_UPLOADS`)**: `TusUpload` (`src/tus/upload-do.ts`, SQLite migration `v1-tus`) stores TUS upload session state and serializes chunk flushing. Keep its binding and migration consistent across `src/index.ts`, `wrangler.jsonc`, `wrangler.staging.example.jsonc`, and `vitest.config.mts`.
- **Session boundaries**: Never expose or log Google Drive resumable upload URLs (`Location` must remain Worker-scoped), and keep session ownership isolated per authenticated principal (`basic:<username>` / `oidc:<sub>`).
