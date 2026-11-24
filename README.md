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
   - Keep the `TUS_UPLOADS` Durable Object binding and SQLite class migration in `wrangler.jsonc`; TUS upload sessions require durable storage.
   - Set `CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN`, and `USERS` before using the Worker. Store sensitive values as Cloudflare encrypted secrets rather than committing them to source.

## Environment Variables

Instead of editing [src/worker.ts](src/worker.ts), configure variables via Cloudflare secrets or the Dashboard (**Settings -> Variables -> Environment Variables**):

| Variable | Required | Description | Example |
| :--- | :---: | :--- | :--- |
| `CLIENT_ID` | **Yes** | Google Cloud OAuth client id. | `*.apps.googleusercontent.com` |
| `CLIENT_SECRET` | **Yes** | Google Cloud OAuth client secret. | `GOCSPX-...` |
| `REFRESH_TOKEN` | **Yes** | Your Google Drive API Refresh Token. | `1//04x...` |
| `USERS` | **Yes** | A JSON formatted string containing your WebDAV usernames and passwords. | `{"admin": "mypassword"}` |
| `ROOT_ID` | No | Specific Google Drive Folder ID to mount as root. Defaults to your entire drive (`root`). | `1B2a_xYz...` |
| `PATH` | No | Mount path prefix (defaults to `/dav/`). | `/dav/` |
| `NAME` | No | Display name for the web interface. | `My Cloud Drive` |
| `COPYRIGHT` | No | Copyright text displayed in the footer. | `@ixiumu` |
| `COPYRIGHT_LINK` | No | URL link for the copyright text. | `https://github.com/...` |

`CLIENT_ID` and `CLIENT_SECRET` must belong to the same OAuth client, and `REFRESH_TOKEN` must have been issued to that client (tokens obtained with shared rclone credentials will not work). There are no built-in OAuth defaults: missing or whitespace-only OAuth bindings fail closed with a `500` configuration error after WebDAV authentication without contacting Google. `.env.example` contains placeholders only.

## Authentication

- **WebDAV**: HTTP Basic authentication against the `USERS` JSON binding (`{"username": "password"}`). When running with Worker bindings, missing or invalid `USERS` fails closed with `500`.

## Design and implementation tracking

- [oCIS compatibility profile (design)](docs/ocis-compatibility.md)
- [Client probe evidence and remaining gates](docs/ocis-probe-report.md)
- [Implementation todo](todo.md)
