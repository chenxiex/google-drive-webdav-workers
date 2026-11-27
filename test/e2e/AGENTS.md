# End-to-End Testing & Staging Deployment Guide

All tests under `test/e2e/` are **opt-in** and excluded from the default offline `pnpm test --run` / `pnpm check` suite.

## E2E Suites

- **Offline `rclone` E2E** (`test/e2e/rclone.e2e.test.ts`, Miniflare + `MockDrive`):
  ```bash
  RCLONE_BIN=/path/to/rclone pnpm test:e2e test/e2e/rclone.e2e.test.ts
  ```
- **Live deployment E2E** (`test/e2e/live-deployment.e2e.test.ts`, real Cloudflare Workers + SQLite Durable Objects + Google Drive):
  - Skipped automatically unless `LIVE_WEBDAV_URL` is set.

---

## Staging Worker Workflow

### 1. Local Config & Security Boundaries

- Copy `wrangler.staging.example.jsonc` to `wrangler.staging.jsonc` (gitignored) and set your staging custom domain. Never commit `wrangler.staging.jsonc`, `.env`, personal hostnames, or secrets, and never print secret values in terminal output or logs.
- Keep `"workers_dev": false` and `"preview_urls": false` in `wrangler.staging.jsonc` so all staging traffic is forced through your custom domain and its Cloudflare Edge WAF gate (e.g. requiring the `X-Dev-Gate` header from `.env`).
- **Google Drive sandbox isolation**:
  - Use either a dedicated test Google account or set `ROOT_ID` in `.env` to a dedicated sandbox subfolder's **Google Drive Folder ID** (from the folder URL `https://drive.google.com/drive/folders/<ID>`, *not* the folder display name).
  - Remember `ROOT_ID` is an application-layer root mapping only; it protects non-sandbox Drive files from Worker mutations, but does not narrow the OAuth refresh token's Google API scope.

### 2. Deploy, Test, and Tear Down

```bash
# 1. Deploy isolated staging Worker + TUS_UPLOADS and AUTH_DO SQLite DOs
pnpm exec wrangler deploy -c wrangler.staging.jsonc

# 2. Sync allowlisted runtime bindings from .env (excludes X_DEV_GATE; Worker validates config at runtime)
node scripts/sync-staging-secrets.mjs

# 3. Run live E2E tests (default: 12 MiB streaming PUT + 12 MiB multi-chunk TUS)
LIVE_WEBDAV_URL=https://<staging-host> pnpm test:e2e test/e2e/live-deployment.e2e.test.ts

# Optional: large-payload / isolate-memory acceptance (e.g. OC-06 / OC-10)
LIVE_WEBDAV_URL=https://<staging-host> LIVE_PUT_MB=95 LIVE_TUS_MB=105 LIVE_TUS_CHUNK_MB=10 pnpm test:e2e test/e2e/live-deployment.e2e.test.ts

# 4. Tear down staging immediately after verification (unless explicitly asked to keep it running)
pnpm exec wrangler delete -c wrangler.staging.jsonc --force
```

`scripts/sync-staging-secrets.mjs` uploads only non-empty keys from the runtime allowlist (`CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN`, `USERS`, `ROOT_ID`, `WEBDAV_PATH`, `NAME`, `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, `OIDC_SIGNING_KEY`, `OIDC_SIGNING_KID`, `PUBLIC_ORIGIN`).

---

## Writing Live E2E Tests & Fixtures

- **Reuse the sandbox fixture**: import `createLiveSandbox`, `loadLiveConfig`, `deterministicBytes`, and `sha256Hex` from `test/e2e/fixtures/live-sandbox.ts`.
  - `createLiveSandbox()` creates an isolated `e2e-sandbox-<timestamp>-<rand>/` folder under `WEBDAV_PATH` via `MKCOL` and exposes `putStream()`, `getAndHash()`, `tusUpload()`, `request()`, and `cleanup()`.
  - Create one suite-level sandbox in `beforeAll` and always call `await sandbox?.cleanup()` in `afterAll` (moves the temporary folder to Google Drive Trash).
- **Gate opt-in execution**: wrap live suites in `describe.skipIf(!process.env.LIVE_WEBDAV_URL)`.
- **Keep scope focused on our system**: test real Worker + Durable Object + Google Drive integration contracts (streaming memory behavior, TUS chunk persistence, Drive v3 ETags/revisions/range reads, Drive metadata/listing consistency). Do **not** add tests for Cloudflare platform behavior (e.g. Edge WAF `403` rules or plan-level `413` ingress limits) or duplicate unit/mocked assertions already covered in `test/worker/`.

### Environment Variables (`test/e2e/fixtures/live-sandbox.ts` & `live-deployment.e2e.test.ts`)

| Variable | Source / Default | Purpose |
| --- | --- | --- |
| `LIVE_WEBDAV_URL` | Required (env or `.env`) | Target HTTPS origin; gates live E2E execution |
| `WEBDAV_PATH` | `.env` or env / `/webdav/` | Mounted generic WebDAV base path |
| `USERS` | `.env` or env | JSON map of WebDAV credentials (uses first entry by default) |
| `LIVE_WEBDAV_USER` / `LIVE_WEBDAV_PASS` | Optional override | Overrides `USERS` credentials for Basic Auth |
| `X_DEV_GATE` | Optional (`.env` or env) | Sent as `X-Dev-Gate` header when present to pass Edge WAF |
| `LIVE_PUT_MB` | `12` | Streaming resumable `PUT` payload size in MiB |
| `LIVE_TUS_MB` | `12` | Total TUS multi-chunk upload size in MiB |
| `LIVE_TUS_CHUNK_MB` | `4` | Per-`PATCH` TUS chunk size in MiB |
| `LIVE_KEEP_SANDBOX` | unset (`1` to keep) | Skip `afterAll` Drive Trash deletion when debugging |
