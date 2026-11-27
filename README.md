# GDrive WebDAV Worker

A Cloudflare Workers script that transforms Google Drive into a WebDAV server.

## Features

- **WebDAV Support**: Mount your Google Drive in Windows Explorer, macOS Finder, Infuse, rclone, and other DAV clients.
- **High Performance**: Uses Cloudflare Workers with bounded isolate-local caching.
- **Resumable Uploads**: Supports Google Drive resumable uploads for streaming `PUT` and Durable Object-backed TUS sessions.
- **Multi-Status Support**: Implements WebDAV operations (`PROPFIND`, `PROPPATCH`, `MKCOL`, `MOVE`, `COPY`, `DELETE`, etc.).
- **Environment Variables**: Configure credentials and behavior via Cloudflare bindings and secrets.

See [WebDAV behavior details](docs/webdav-behavior.md) for protocol semantics and implementation boundaries.

## Quick Start

1. **Get Google Credentials & Refresh Token**:

   Create your own Google OAuth client and authorize with that same client to obtain a refresh token. Shared rclone OAuth credentials are not bundled or supported.

   You can use rclone locally to obtain the token with your own client:
   1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and enable the **Google Drive API**.
   2. Create an **OAuth 2.0 Client ID** (select "Desktop app" as the application type) to get your `client_id` and `client_secret`.
   3. Download and install [rclone](https://rclone.org/downloads/) on your local computer.
   4. Open your terminal/command prompt and run `rclone config`.
   5. Create a new remote (press `n`), give it a name, and choose `drive` as the storage type.
   6. When prompted, paste your newly created `client_id` and `client_secret`. Do not leave these prompts blank.
   7. Follow the prompts to authenticate via your web browser.
   8. Once completed, open your `rclone.conf` file (locate it with `rclone config file`) and copy the `refresh_token`.

2. **Deploy to Cloudflare**:

   - Install dependencies with `pnpm install --frozen-lockfile` and deploy with `pnpm exec wrangler deploy`. Choose your Worker name in `wrangler.jsonc` first.
   - Keep the Durable Object bindings and migrations in `wrangler.jsonc`; resumable TUS uploads and OAuth tokens require durable storage.
   - Set `CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN`, and `USERS` (or optional Cloudflare Access + OIDC secrets below) before using the Worker. Store sensitive values as Cloudflare encrypted secrets rather than committing them to source.

## Environment Variables

Instead of editing [src/config.ts](src/config.ts), configure variables via Cloudflare secrets or the Dashboard (**Settings -> Variables -> Environment Variables**):

| Variable | Required | Description | Example |
| :--- | :---: | :--- | :--- |
| `CLIENT_ID` | **Yes** | Google Cloud OAuth client id. | `*.apps.googleusercontent.com` |
| `CLIENT_SECRET` | **Yes** | Google Cloud OAuth client secret. | `GOCSPX-...` |
| `REFRESH_TOKEN` | **Yes** | Your Google Drive API Refresh Token. | `1//04x...` |
| `USERS` | **Yes**\* | A JSON formatted string containing your WebDAV usernames and passwords (`*` optional only when Cloudflare Access OIDC is configured). | `{"admin": "mypassword"}` |
| `ROOT_ID` | No | Specific Google Drive Folder ID to mount as root. Defaults to your entire drive (`root`). | `1B2a_xYz...` |
| `WEBDAV_PATH` | No | Mount path prefix (defaults to `/webdav/`; cannot be `/` or overlap reserved paths). | `/webdav/` |
| `NAME` | No | Server name used in the authentication realm. | `My Cloud Drive` |
| `CF_ACCESS_AUD` | No | Cloudflare Access Application Audience (AUD) tag protecting `/oauth/authorize`. | `64-char-hex-aud` |
| `CF_ACCESS_TEAM_DOMAIN` | No | Cloudflare Access team domain (`https://<team>.cloudflareaccess.com`). | `https://team.cloudflareaccess.com` |
| `OIDC_SIGNING_KEY` | No | Static RSA private key (base64 PKCS#8 DER, PKCS#8 PEM, or private JWK JSON) used to sign OIDC ID tokens. | `MIIEvQIBADANBg...` |
| `OIDC_SIGNING_KID` | No | Optional key ID (`kid`) for `OIDC_SIGNING_KEY` (auto-derived if omitted). | `oidc-key-2026` |
| `PUBLIC_ORIGIN` | No | Optional canonical `https://` origin URL for OAuth/OIDC metadata instead of the incoming request origin. | `https://dav.example.com` |

`CLIENT_ID` and `CLIENT_SECRET` must belong to the same OAuth client, and `REFRESH_TOKEN` must have been issued to that client (tokens obtained with shared rclone credentials will not work). Missing Google OAuth bindings fail closed with a `500` configuration error. `.env.example` contains placeholders only.

## Optional: Enabling Cloudflare Access (OAuth/OIDC)

Cloudflare Access is a Zero Trust edge policy rather than a Worker binding, so it cannot be enabled directly inside `wrangler.jsonc`. When you want browser-based OAuth/OIDC login alongside (or instead of) HTTP Basic `USERS`:

> [!IMPORTANT]
> Do **not** enable whole-Worker Access protection in the Workers dashboard. Only `/oauth/authorize` should be gated by Cloudflare Access; all other routes (WebDAV, `/.well-known/*`, `/oauth/token`, `/oauth/userinfo`, `/oauth/jwks`, `/oauth/revoke`) must bypass Access so non-browser WebDAV and API clients are not redirected.

1. **Bind a Custom Domain**: Attach a Cloudflare-managed custom domain (for example, `dav.example.com`) to your Worker via `wrangler.jsonc` (`routes`) or Cloudflare Dashboard (**Workers & Pages -> Settings -> Domains & Routes**). A custom domain on Cloudflare DNS is required for path-scoped Self-hosted Access policies.
2. **Create a Self-hosted Access Application**:
   1. Open the [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/) (Zero Trust Free supports up to 50 users) and note your team domain (`https://<your-team>.cloudflareaccess.com`).
   2. Go to **Access -> Applications -> Add an application -> Self-hosted**.
   3. Set **Domain** to your custom domain (e.g., `dav.example.com`) and set **Path** strictly to `oauth/authorize` (do not leave Path blank or match `oauth/*`).
   4. Add an **Allow** policy (such as email One-Time PIN or your IdP) and save the application.
   5. Open the saved application (**Edit -> Overview -> Additional settings**) and copy the **Application Audience (AUD) Tag** (see [Cloudflare's AUD tag guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag)).
3. **Generate an OIDC Signing Key**: Generate a single-line base64 PKCS#8 private key locally (portable on Linux & macOS, ready to paste directly into `.env` or `wrangler secret put` without `\n` escaping):

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -outform DER | base64 | tr -d '\n'
   ```

   If you prefer a `.pem` file (`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out oidc-private.pem`), you can upload it directly via `pnpm exec wrangler secret put OIDC_SIGNING_KEY < oidc-private.pem`, paste it multi-line inside quotes in `.env`, or convert it to a single line with `base64 < oidc-private.pem | tr -d '\n'`.

4. **Configure Worker Secrets and Deploy**: Upload `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, and `OIDC_SIGNING_KEY` (plus optional `OIDC_SIGNING_KID` and `PUBLIC_ORIGIN`):

   ```bash
   pnpm exec wrangler secret put CF_ACCESS_AUD
   pnpm exec wrangler secret put CF_ACCESS_TEAM_DOMAIN
   pnpm exec wrangler secret put OIDC_SIGNING_KEY   # or: ... < oidc-private.pem
   pnpm exec wrangler deploy
   ```

   Alternatively, populate `.env` from [.env.example](.env.example) and run `node scripts/sync-staging-secrets.mjs --config wrangler.jsonc`. Setting these secrets auto-activates OAuth/OIDC support. Once OIDC is configured, `USERS` becomes optional: keep it for HTTP Basic WebDAV clients (such as `rclone` or Finder), or omit it to allow OAuth/Bearer access only.

5. **Verify**:
   - Confirm discovery and public JWKS endpoints bypass Access and return `200` JSON directly (no login redirect):
     ```bash
     curl -i https://dav.example.com/.well-known/openid-configuration
     curl -i https://dav.example.com/oauth/jwks
     ```
   - Open `https://dav.example.com/oauth/authorize` in a browser: it should prompt for Cloudflare Access login first, then reach the Worker (returning `400` because no OAuth query parameters were supplied).

## Documentation

- [WebDAV & OAuth/OIDC behavior](docs/webdav-behavior.md) — Implemented protocol semantics and boundaries.
