# GDrive WebDAV Worker

A Cloudflare Workers script that transforms Google Drive into a fully functional WebDAV server. 

## Features

- **WebDAV Support**: Mount your Google Drive in Windows Explorer, macOS Finder, Infuse, and other DAV clients.
- **High Performance**: Leverages Cloudflare Workers and bounded in-memory caching for minimal latency.
- **Resumable Uploads**: Supports the Google Drive Resumable API for reliable file transfers.
- **Multi-Status Support**: Full implementation of WebDAV protocols (PROPFIND, MKCOL, MOVE, COPY, etc.).
- **Environment Variables**: Configure your worker securely without modifying the source code.

[WebDAV behavior details](docs/webdav-behavior.md)

## Quick Start

1. **Get Google Credentials & Refresh Token**:
   
   Create your own Google OAuth client and authorize with that same client to obtain a refresh token. Shared rclone OAuth credentials are no longer bundled or supported as defaults.

   You can use rclone locally to obtain the token with your own client:
     1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and enable the **Google Drive API**.
     2. Create an **OAuth 2.0 Client ID** (select "Desktop app" as the application type) to get your `client_id` and `client_secret`.
     3. Download and install [rclone](https://rclone.org/downloads/) on your local computer.
     4. Open your terminal/command prompt and run `rclone config`.
     5. Create a new remote (press `n`), give it a name, and choose `drive` as the storage type.
     6. When prompted, explicitly paste your newly created `client_id` and `client_secret`. Do not leave these prompts blank or use rclone’s shared defaults.
     7. Follow the prompts to authenticate via your web browser.
     8. Once completed, open your `rclone.conf` file (you can find its location by running `rclone config file`) and copy the `refresh_token`.

2. **Deploy to Cloudflare**:

   - Install dependencies with `pnpm install --frozen-lockfile` and deploy the repository with `pnpm exec wrangler deploy`. Choose your Worker name in `wrangler.jsonc` first.
   - Keep the `TUS_UPLOADS` Durable Object binding and SQLite class migration in `wrangler.jsonc`. Upload sessions require durable storage; pasting the built script alone does not create the binding or migrate the class.
   - Set `CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN`, and `USERS` before using the Worker. Store sensitive values as Cloudflare encrypted secrets. Do not paste credentials into the source or built file.

## Environment Variables (Recommended)

Instead of hardcoding your sensitive information and configurations in the `worker.js` file, you can set them securely via the Cloudflare Dashboard (**Settings -> Variables -> Environment Variables**). 

The Worker supports the following variables:

| Variable | Required | Description | Example |
| :--- | :---: | :--- | :--- |
| `CLIENT_ID` | **Yes** | Google Cloud OAuth client id. | `*.apps.googleusercontent.com` |
| `CLIENT_SECRET` | **Yes** | Google Cloud OAuth client secret . | `GOCSPX-...` |
| `REFRESH_TOKEN` | **Yes** | Your Google Drive API Refresh Token. | `1//04x...` |
| `USERS` | **Yes** | A JSON formatted string containing your WebDAV usernames and passwords. | `{"admin": "mypassword"}` |
| `ROOT_ID` | No | Specific Google Drive Folder ID to mount as root. Defaults to your entire drive. | `1B2a_xYz...` |
| `PATH` | No | Deployed in subdirectory. | `/dav/` |
| `NAME` | No | Display name for the web interface. | `My Cloud Drive` |
| `COPYRIGHT` | No | Copyright text displayed in the footer. | `@ixiumu` |
| `COPYRIGHT_LINK` | No | URL link for the copyright text. | `https://github.com/...` |

`CLIENT_ID` and `CLIENT_SECRET` must belong to the same OAuth client, and `REFRESH_TOKEN` must have been issued to that client. Tokens obtained with shared rclone credentials cannot be reused with a different client: authorize again with your own client to obtain a new token. The Worker checks that all three bindings are nonempty; Google validates that they match when the token is refreshed.

There are no built-in OAuth defaults. Missing or whitespace-only OAuth bindings fail closed with a configuration error after WebDAV authentication, without contacting Google. In binding mode, partial bindings do not fall back to a static `CONFIG` credential. `.env.example` contains placeholders only; supply real values through your local untracked configuration or Cloudflare secrets.

## Authentication

- **WebDAV**: Access requires the username and password defined in your `USERS` environment variable or the `config.users` object.

## Design and implementation tracking

- [oCIS compatibility profile (design)](docs/ocis-compatibility.md)
- [Client probe evidence and remaining gates](docs/ocis-probe-report.md)
- [Implementation todo](todo.md)
