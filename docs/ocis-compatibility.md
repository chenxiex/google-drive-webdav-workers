# oCIS-compatible personal-drive profile (design)

Status: **proposed design specification** (not yet implemented in `src/`). The SQLite Durable Object TUS foundation and Drive v2 media ETag download handling are merged in `dev`; the oCIS discovery, OAuth/OIDC, Spaces, sync, and preview layers below remain open tasks.

- Probe evidence and gaps: [probe report](ocis-probe-report.md)
- Implementation backlog: [todo](../todo.md#ocis-兼容层实施计划)

## 1. Goal and boundary

Expose one Google Drive root through unmodified desktop and Android clients with bounded requests through Cloudflare Workers, while retaining generic WebDAV and rclone support. This defines a minimal **oCIS-compatible profile** rather than deploying the full oCIS stack.

Target clients are ownCloud Desktop 7.1.1 (Linux and Windows), OpenCloud Android 1.3.1 (distinct from ownCloud Android), and rclone 1.76.0. Cyberduck CLI 9.6.0 and ownCloud CLI 6.0.3 served as additional dynamic probe clients.

Required capabilities: login/refresh, one personal Space, directory discovery/sync, original download/resume, bounded upload/resume, empty files, mkdir, rename/move, copy, delete, conflict reporting, stable IDs, metadata, and authenticated previews, alongside existing `PROPFIND`/`PROPPATCH` behavior.

Out of scope (disable via capabilities rather than faking): collaboration/shares/public links, teams/project Spaces, Space management, cloud recycle-bin UI, revision UI, favorites/search APIs, notifications, SSE, online editors, federation, dynamic OAuth registration, distributed WebDAV locks, and parallel TUS concatenation. If a target client requires any disabled capability during normal file operations, resolve that gate before release.

## 2. Architecture and dependencies

Worker routes extend the existing Drive/WebDAV handler; Durable Objects store upload journals and auth sessions. No R2, Redis, LDAP, Keycloak, or external staging service is required. Measure actual SQLite/DO request and storage costs before finalizing limits, and never buffer an entire upload.

Drive resumable uploads are sequential; bounded journal/tail storage bridges arbitrary client chunks to Drive's 256 KiB alignment. Metadata and listing caching is isolate-local memory only (no Workers KV binding) and is never the source of truth for upload offsets, auth sessions, or sync generations.

All URLs returned to clients use the configured external HTTPS origin and base path (never trust unchecked `Host` or forwarded headers). Keep the legacy WebDAV mount working; Space URLs route to the same Drive backend.

## 3. Authentication and bootstrap contract

HTTP Basic remains enabled for generic DAV/rclone clients. Desktop 7.1.1 requires Bearer/OAuth and enabled Spaces.

A first-party login page validates `USERS` credentials (user passwords must never be `client_id` or `client_secret`, as installed-app secrets are public identifiers).

Required endpoints (base-path routing must be integration-tested):

| Endpoint | Contract |
| --- | --- |
| `GET /status.php` | `200` JSON with `installed: true` and truthful maintenance state; publish a tested compatibility product/version profile (not `package.json` version). |
| unauthenticated `PROPFIND /remote.php/webdav/` | `401` with `Bearer` challenge. |
| `GET /.well-known/webfinger?resource=...` | Valid subject when supplied; issuer link with rel `http://openid.net/specs/connect/1.0/issuer`; client config only for allowlisted client IDs. |
| `GET /.well-known/openid-configuration` | Real issuer and authorization/token/userinfo/JWKS URLs, `code` response, `S256` PKCE; advertise only implemented methods/scopes. |
| authorization endpoint | User login, `code` response with original `state`, exact allowlisted redirect rules. |
| token endpoint | `authorization_code` and `refresh_token` grants; `client_secret_basic` and `client_secret_post` for allowlisted clients. |
| userinfo endpoint | Authenticated, stable `sub` and truthful profile claims. |
| JWKS endpoint | Public verification keys for signed ID tokens (never expose private keys). |
| `GET /ocs/{v1,v2}.php/cloud/user` | OCS envelope with `data.id` and `data["display-name"]` in XML/JSON. |
| `GET /ocs/{v1,v2}.php/cloud/capabilities` | OCS envelope with `data.capabilities`; honor `OCS-APIREQUEST` and XML/JSON selection. |
| authenticated `OPTIONS /remote.php/webdav` (with or without trailing `/`) | Discovery response advertising supported DAV/TUS capabilities (reference returns `204`). |
| `GET /graph/v1.0/me/drives` | Graph `value` array containing the personal Space. |

OCS representation details:
- OCS v1 uses envelope `meta.statuscode=100` and `Ocs-Api-Version: 1`; v2 uses `meta.statuscode=200`.
- Support `format=json` and `format=xml`; when omitted, honor `Accept` and default to XML (Cyberduck requests XML; ownCloud CLI 6 uses v1).
- Cyberduck probes `HEAD /remote.php/dav/files/<user>/Personal/`: reference `404` triggers fallback to OCS/Graph discovery.

Security and token requirements:
- Enforce HTTPS, login CSRF protection and rate limiting, short-lived single-use authorization codes bound to client/redirect/user with PKCE `S256`, and refresh-token revocation/rotation.
- Restrict Desktop loopback redirects to the registered loopback host with variable port, and exactly allowlist Android's custom-scheme URI. Use standard OAuth errors without leaking secrets, and never log passwords, codes, tokens, or Drive session URLs.
- Access/refresh tokens may be opaque random DO-backed tokens; when advertising `openid`, issue properly signed ID tokens (`iss`, `aud`, `sub`, `iat`/`exp`, `nonce`). Desktop requires `access_token`, `refresh_token`, and `token_type=Bearer`; Android also reads `expires_in`.
- Persist signing keys in secrets or Auth DO (e.g., `RS256` with stable `kid` and key retention during rotation). Freeze the official Desktop/Android public client IDs and redirect rules in a tested allowlist, and document an atomic concurrent-refresh policy (single winner or bounded same-result retry).
- `USERS` accounts share one Google OAuth identity and `ROOT_ID`: auth subjects and TUS session ownership are isolated per user, but Drive storage is shared (represent Graph `owner` truthfully or omit it).

## 4. Capabilities and Space model

Set `files_sharing.api_enabled = false` (Desktop defaults it to `true` when omitted), disable public sharing and versioning, omit `notifications.ocs-endpoints` and unsupported app providers, and omit lock capabilities. Enable `spaces.enabled` and expose one personal Space. Note that Desktop 7.1.1 parses `core.pollinterval` in **milliseconds**, whereas oCIS 8.2.3 returns `60`; confirm the accepted value during client testing.

TUS capabilities under `files.tus_support`:

```json
{
  "version": "1.0.0",
  "resumable": "1.0.0",
  "extension": "creation,creation-with-upload",
  "max_chunk_size": 10485760,
  "http_method_override": ""
}
```

- **Default `10485760` (10 MiB = 40 × 256 KiB)** matches rclone/Cyberduck full chunks and aligns CLI clients that follow the capability. Keep a separate accepted ingress ceiling (`>= 10 MiB`, below Worker ingress limits) because clients may send 10,000,000-byte chunks, smaller chunks, or local overrides (see [controlled experiment](ocis-probe-report.md#controlled-chunk-announcement-experiment)). `POST`-with-data and `PATCH` share this ceiling.
- `Tus-Max-Size` is the whole-file limit, not the per-request chunk limit.
- Only advertise checksum algorithms that are verified; omitting `preferredUploadType` causes Desktop to default to `SHA1`.
- Graph drive entry requires `driveType=personal`, stable `id`, `name`, and `root` (`id`, `webDavUrl`, changing `eTag`); Desktop keys the Space by `root.id`. If included, `quota.total` for Android must be an integer; omit `quota`, `special`, `owner`, `webUrl`, or `description` if incomplete. Restrict all access within `ROOT_ID`.

## 5. DAV resource and synchronization contract

Retain DAV XML namespaces/escaping, `207` propstat grouping (`404` propstat for unknown properties), and `Depth: 0`/`1` only. Never mask failed or partial Drive listings as empty directories.

Required property surface:
- `DAV:`: `displayname`, `resourcetype`, `getcontenttype`, `getcontentlength`, `getlastmodified`, `creationdate`, `getetag`
- `http://owncloud.org/ns`: `id`, `fileid`, `spaceid`, `file-parent`, `name`, `permissions`, `checksums`, `size`, `has-preview`
- Optional (return `404` when unsupported): `share-types`, `privatelink`, `downloadURL`, `dDC`, root `data-fingerprint`
- Use `oc:size` on collections rather than `d:getcontentlength` (do not invent recursive totals). Map `oc:id` and `oc:fileid` to stable Drive IDs that survive rename/move, and reflect actual writable permissions.
- Support `Prefer: return=minimal` by omitting `404` propstat entries and returning `Preference-Applied: return=minimal`.

Validators and synchronization:
- `PROPFIND` `getetag` uses Drive `id` + `version` (detects content and dead-property edits even when `mtime` is preserved). Binary `GET` uses the Drive v2 `alt=media` strong HTTP `ETag` and enforces `If-Range` locally against the partial response's `ETag` (falling back to full `200` on mismatch, weak/date validator, missing/weak upstream tag, or `416`). `HEAD` currently omits `ETag`; verify client `HEAD` expectations during OC-07.
- Directory and Space-root `eTag`s must change on descendant mutations (Drive folder `modifiedTime`/`version` alone does not update on child edits).
- **Unresolved sync gate (OC-05)**: audit Drive `changes.list` / `getStartPageToken` (tokens do not expire; still test missing/invalid cursors, permission loss, and pagination recovery) and extend the mock before choosing between "Drive changes + DO generation" and periodic full-tree discovery. If using DO generation, key isolate memory caches by generation and bind in-flight fetches to their starting generation so old listings are never published under a new ETag; measure traversal cost when `ROOT_ID` mounts a subdirectory alongside account-wide changes.

## 6. File operations and errors

| Operation | Required behavior |
| --- | --- |
| `GET` / `HEAD` | Original bytes, actual MIME/length; `GET` provides the v2 media `ETag` and enforces `Range` (`206` / `416`) + `If-Range`; `HEAD` currently omits `ETag` (validate client behavior in OC-07). |
| `PUT` | Bounded streaming; `201` new / `204` replace; honor preconditions and `mtime`. |
| `MKCOL` | `201`; missing parent `409` on compatibility paths (no implicit parent creation). |
| `MOVE` / rename | Destination validation, existing overwrite/trash-recovery semantics (`201`/`204`), `412` on `Overwrite: F` or precondition failure, reject self/descendant overlap, preserve source ID. |
| `COPY` | `201`/`204` and new ID; `412` on `Overwrite: F`; explicit folder-copy decision (`403` until implemented). |
| `DELETE` | `204` (or `200`), distinguishing missing/forbidden; resolve permanent delete vs `trashed: true` policy before release. |
| `PROPPATCH` | Retain native/dead properties, protected-property `403`, quota `507`, and single-PATCH error reporting. |
| `LOCK` / `UNLOCK` | Disabled (`501`), no Class 2 / lock claims. |

Map upstream failures accurately (`401`, `403`, `404`, `409`, `412`, `413`, `429`, `507`) without turning unknown errors into `404`/`507` or partial failures into success. Explicitly decide how Google Workspace native documents and shortcuts are represented or excluded rather than exposing broken binary links.

### Legacy route and migration boundary

The oCIS profile is opt-in:
- When disabled, legacy `PATH` routing and parent-creating `PUT`/`MKCOL`/`TUS` remain unchanged.
- When enabled, bootstrap endpoints sit at origin root and `/dav/spaces/<spaceId>/...` dispatches ahead of legacy `PATH`. Reject or require migration (e.g., moving legacy mount to `/webdav/`) if a real `spaces` folder exists under legacy `/dav/`.
- Decode each path segment once; treat literal `$` and `%24` in Space IDs identically while blocking traversal or mount escapes.
- Compatibility `MKCOL`/`PUT`/TUS creation must return `409` for missing parents (do not reuse legacy `ensureDir`).
- Reject non-TUS `PATCH` with `405` on compatibility routes instead of dispatching to `COPY`.
- Compute quota integers with `BigInt` (omit absent limits as unlimited; omit Graph `quota` if client expectations are unmet).

## 7. TUS upload and recovery

- **Creation & paths**: Desktop requires `creation-with-upload` (`POST` with initial body) and `Upload-Length: 0` immediate completion. Desktop `filename` metadata may be a relative subpath, while Android sends a basename under the collection URL; resolve once relative to the upload collection and reject traversal, NUL, ambiguous encoding, or absolute URLs.
- **Metadata**: Parse `filename`, `mtime` (accept finite fractional Unix seconds and reconcile `X-OC-Mtime`), `checksum`, and optional `filetype`. Tolerate Cyberduck 9.6.0's unencoded `filetype` and trailing comma (`filename <b64>, filetype application/octet-stream,`) without relaxing `filename`, `checksum`, or path validation. Note rclone 1.76.0 `SetModTime` sends `PROPPATCH` with `{DAV:}lastmodified` (integer Unix seconds) plus `{http://owncloud.org/ns}checksums` (stored client checksums are not verified digests).
- **Protocol surface**: Implement TUS `OPTIONS`, `POST`, `HEAD`, `PATCH` with `Tus-Resumable`, `Upload-Offset`, `Upload-Length`, and Worker-scoped `Location` (never expose Google's resumable URL). Return `409` on offset mismatch, `412` on bad version, `415` on bad content type, `404`/`410` on missing/expired sessions. Do not advertise TUS `checksum`/`termination`/`expiration` extensions just because internal metadata checksum or cleanup exists.
- **Completion & recovery**: Retain DO serialization, `bytes */<total>` reconciliation against Drive's `Range`, and completed session receipts (`HEAD 200`, stale replay `409`; intentional recovery improvement over reference oCIS's completed `HEAD 404`). Target completion headers should include `ETag`, `OC-FileID`, and `OC-Perm` (clients fall back to `PROPFIND` if absent). Honor `mtime` and overwrite preconditions (`If-Match`).
- **Whole-file checksum before overwrite**: For in-place overwrites, verify whole-file checksum **before** sending Google's finalizing bytes, keeping recoverable incremental digest state in the DO journal (holding the final block until validated) and verifying Drive CPU/cost budgets.
- **Cost check**: Current DO flushes in 1 MiB blocks; evaluate increasing block size / tuning journal writes against Worker subrequest and DO billing budgets.

### Worker-to-Drive alignment acceptance gate

Clients may ignore the 10 MiB recommendation (e.g., `10,000,000`-byte chunks leave a **38,528-byte** remainder mod 256 KiB) or change chunk sizes on resume. Preserve arbitrary client chunk boundaries and reblock only toward Drive with a bounded tail:

1. Run supported clients through the actual Worker compatibility layer (not reference oCIS) on files > 2 chunks: `10,000,000`-byte data-bearing `POST` + `PATCH`es, `10 MiB` default, and irregular/varying resume chunk sizes, verifying downloaded SHA-256 and 256 KiB alignment of Drive-facing non-final chunks.
2. Against the aligned Drive mock, inject interruptions after tail/pending persistence, after Drive accepts bytes (dropped response), and before client ack; restart Worker/DO, recover via `HEAD` + Drive `Range`, resume with a different chunk size, and verify byte-exact completion.

## 8. Preview and metadata

- Support authenticated DAV `GET` with `preview=1` and `x`/`y`/`c` query parameters (`c` is a cache validator hint), plus `oc:has-preview`.
- Proxy Drive `thumbnailLink` server-side (never redirect to Google URLs or expose tokens), returning actual image `Content-Type` and bytes. Cache by identity and version under user/root auth.
- Follow actual Drive thumbnail availability (reference oCIS generates JPEG previews for text files and `404` for opaque binaries; never mask missing previews with original file bytes). Validate requested dimensions without promising exact server-side resizing unless implemented.
- Retain `DAV:lastmodified` (integer Unix seconds) vs `DAV:getlastmodified` (HTTP-date) and existing Drive-backed custom/native property behavior.

## 9. Release gate and evidence policy

Freeze schemas and defaults only after end-to-end tests with target binaries:
- Linux and Windows Desktop sync in both directions (local edits and external Drive edits).
- Android browse, edit/upload, download, and background/interrupted transfers, plus rclone regression.
- Real deployed Cloudflare Workers ingress-limit validation for multi-chunk uploads beyond single-request limits.
- Keep default automated tests (`pnpm test --run`) offline and mock-only; keep live Drive checks opt-in and scoped to unverified contracts.
