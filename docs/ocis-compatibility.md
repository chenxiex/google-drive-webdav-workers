# oCIS-compatible personal-drive profile (design)

Status: **proposed design specification** (not yet implemented in `src/`). The SQLite Durable Object TUS foundation and Drive v2 media ETag download handling are merged in `dev`; the oCIS discovery, OAuth/OIDC, Spaces, sync, and preview layers below remain open tasks.

- Probe evidence and gaps: [probe report](ocis-probe-report.md)
- Verified client source contracts & fixtures: [client contracts](ocis-client-contracts.json)
- Implementation backlog: [todo](../todo.md#ocis-兼容层实施计划)

## 1. Goal and boundary

Expose one Google Drive root through unmodified desktop and Android clients with bounded requests through Cloudflare Workers, while retaining generic WebDAV and rclone support. This defines a minimal **oCIS-compatible profile** rather than deploying the full oCIS stack.

Target clients are ownCloud Desktop 7.1.1 (Linux and Windows), OpenCloud Android 1.3.1 (distinct from ownCloud Android), and rclone 1.76.0. Cyberduck CLI 9.6.0 and ownCloud CLI 6.0.3 served as additional dynamic probe clients.

Required capabilities: login/refresh, one personal Space, directory discovery/sync, original download/resume, bounded upload/resume, empty files, mkdir, rename/move, copy, delete, conflict reporting, stable IDs, metadata, and authenticated previews, alongside existing `PROPFIND`/`PROPPATCH` behavior.

Out of scope (disable via capabilities rather than faking): collaboration/shares/public links, teams/project Spaces, Space management, cloud recycle-bin UI, revision UI, favorites/search APIs, notifications, SSE, online editors, federation, dynamic OAuth registration, distributed WebDAV locks, and parallel TUS concatenation. If a target client requires any disabled capability during normal file operations, resolve that gate before release.

## 2. Architecture and dependencies

Worker routes extend the existing Drive/WebDAV handler; SQLite-backed Durable Objects hold upload journals, thin OAuth authorization-code/token state, and the lightweight sync directory/item index (`items`), while Cloudflare Access handles interactive browser authentication on `/oauth/authorize`. No R2, Redis, LDAP, Keycloak, or external staging service is required. Measure actual SQLite/DO request and storage costs before finalizing limits, and never buffer an entire upload.

Drive resumable uploads are sequential; bounded journal/tail storage bridges arbitrary client chunks to Drive's 256 KiB alignment. Metadata and listing caching is isolate-local memory only (no Workers KV binding) and is never the source of truth for upload offsets, auth sessions, or sync generations.

All URLs returned to clients use the configured external HTTPS origin and base path (never trust unchecked `Host` or forwarded headers). Generic WebDAV (default `/webdav/`, configurable via `WEBDAV_PATH`) and oCIS DAV/Space routes (`/dav/spaces/<spaceId>/`, `/remote.php/webdav/`, `/remote.php/dav/files/<username>/`) are always enabled on the same Drive/WebDAV handler.

## 3. Authentication and bootstrap contract

HTTP Basic (`USERS`) remains enabled for generic DAV/rclone clients. Desktop 7.1.1 and Android require Bearer/OAuth and enabled Spaces.

Interactive login is delegated to **Cloudflare Access** (Self-hosted Access application; Zero Trust Free tier supports up to 50 users), paired with a thin Worker OAuth/OIDC adapter:
- **Access boundary & auto-activation**: OIDC/OAuth routes (`/oauth/*`) activate automatically when Cloudflare Access configuration (e.g., `CF_ACCESS_AUD`) is present; when absent, the Worker operates in HTTP Basic (`USERS`) mode only. When enabled, configure Cloudflare Access to protect **only** `/oauth/authorize`. All other routes (`/webdav/*` or custom `WEBDAV_PATH`, `/dav/*`, `/remote.php/*`, `/status.php`, `/.well-known/*`, `/oauth/token`, `/oauth/userinfo`, `/oauth/jwks`, `/ocs/*`, `/graph/*`) must bypass Access so HTTP Basic Auth (`USERS`) and Bearer Token API traffic work without redirect interference.
- **Authorization endpoint (`/oauth/authorize`)**: Cloudflare Access authenticates the browser session (Email OTP, IdP, Passkey, MFA) and forwards the `Cf-Access-Jwt-Assertion` header. The Worker verifies that assertion against the Cloudflare Access team JWKS and configured `CF_ACCESS_AUD`, extracts the authenticated identity (`email`/`sub`), validates the allowlisted Desktop (`127.0.0.1:<port>` / `localhost:<port>`) or Android (`oc://android.opencloud.eu`) `client_id` and `redirect_uri`, records a short-lived single-use authorization code bound to PKCE `S256` in the Auth DO, and redirects back with `code` and original `state`.
- **Token & OIDC endpoints**: `/oauth/token` verifies PKCE `S256` and consumes the authorization code, issuing DO-backed opaque random `access_token` and `refresh_token` alongside a minimal signed OIDC `id_token` (`iss`, `aud`, `sub`, `preferred_username`, `email`, `iat`/`exp`, `nonce`). Desktop requires `access_token`, `refresh_token`, and `token_type=Bearer`; Android also reads non-null `expires_in` (`Int`) and extracts `preferred_username` / `email` / `sub` directly from the `id_token` JWT payload (without fetching JWKS). Accept `client_secret_basic` and `client_secret_post` for Desktop (`xdXOt13JKxym1B1QcEncf2XDkLAexMBFwiT9j6EfhhHFJhs2KM9jbjTmf8JBXE69` / `UBntmLjC2yYCeHwsyj73Uwo9TAaecAetRwMw0xYcvNL9yRdLSUi0hUAHfvCHFeFh`), and `none` (PKCE `S256`, `client_id` in form body) for public client `OpenCloudAndroid`.

Required endpoints (base-path routing must be integration-tested; canonical responses in [client contracts](ocis-client-contracts.json)):

| Endpoint | Contract |
| --- | --- |
| `GET /status.php` | `200` JSON with `installed: true`, truthful maintenance state, and non-blank `version` + `productversion` (both required by Android `StatusRequester`/`OpenCloudVersion`); publish a tested compatibility product/version profile (not `package.json` version), with no redirects. |
| unauthenticated `PROPFIND /remote.php/webdav/` | `401` with `Bearer` challenge. |
| `GET /.well-known/webfinger?resource=...` | Return `404 Not Found` in this single-instance Worker profile (keep `/.well-known/` reserved): both Desktop (`urlpagecontroller.cpp:223`) and Android (`OCServerInfoRepository.kt:87`) fall back directly to `status.php` and `/.well-known/openid-configuration`. |
| `GET /.well-known/openid-configuration` | Real issuer and authorization/token/userinfo/JWKS URLs, `code` response, `S256` PKCE, `token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"]`; omit `registration_endpoint` so Android uses static `OpenCloudAndroid`; advertise only implemented methods/scopes. |
| `GET /oauth/authorize` (CF Access protected) | Verify `Cf-Access-Jwt-Assertion` (`CF_ACCESS_AUD` + team JWKS), enforce client/redirect allowlist, issue single-use PKCE code, redirect with original `state`. |
| `POST /oauth/token` | `authorization_code` and `refresh_token` grants; `client_secret_basic`, `client_secret_post` (allowlisted clients), and `none` (PKCE `S256` for public `OpenCloudAndroid`). |
| `GET /oauth/userinfo` | Authenticated, stable `sub` and truthful profile claims. |
| `GET /oauth/jwks` | Public verification keys for signed ID tokens (never expose private keys). |
| `GET /ocs/{v1,v2}.php/cloud/user` | OCS envelope with non-null `data.id` and `data["display-name"]` in XML/JSON. |
| `GET /ocs/{v1,v2}.php/cloud/capabilities` | OCS envelope with `data.capabilities` and `data.version`; honor `OCS-APIREQUEST` and XML/JSON selection. |
| authenticated `OPTIONS /remote.php/webdav` (with or without trailing `/`) | Discovery response advertising supported DAV/TUS capabilities (reference returns `204`). |
| `GET /graph/v1.0/me/drives` | Graph `value` array containing the personal Space. |

OCS representation details:
- OCS v1 uses envelope `meta.statuscode=100` and `Ocs-Api-Version: 1`; v2 uses `meta.statuscode=200`.
- Support `format=json` and `format=xml`; when omitted, honor `Accept` and default to XML (Cyberduck requests XML; ownCloud CLI 6 uses v1).
- Cyberduck probes `HEAD /remote.php/dav/files/<user>/Personal/`: reference `404` triggers fallback to OCS/Graph discovery.

Security and token simplifications:
- Enforce HTTPS, short-lived single-use authorization codes bound to client/redirect/user with PKCE `S256`, and refresh-token revocation. Do not maintain custom login HTML, login CSRF tokens, or password-guessing rate limiters in Worker code (handled by Cloudflare Access).
- Restrict Desktop loopback redirects to `127.0.0.1`/`localhost` with variable port, and exactly allowlist Android's `oc://android.opencloud.eu` custom-scheme URI. Use standard OAuth errors without leaking secrets, and never log credentials, assertions, codes, tokens, or Drive session URLs.
- Sign OIDC `id_token`s with a single static asymmetric key stored in Worker Secrets (`RS256` with fixed `kid`, matching oCIS 8.2.3's advertised algorithm family, rotated by updating the Secret rather than dynamic DO key rotation), exposed via `/oauth/jwks`.
- Keep `refresh_token` reusable in the Auth DO until expiry or explicit logout/revocation rather than rotating on every refresh (avoiding concurrent refresh-rotation locking complexity).
- **Shared `ROOT_ID` Space model (`15A`)**: Basic Auth (`USERS`) and Cloudflare Access subjects share one Google OAuth identity and `ROOT_ID` (no per-user subdirectory isolation): auth subjects, OAuth tokens, and TUS session ownership are isolated per user, while underlying Drive storage is shared. Omit Graph `owner` (or populate truthfully for the current authenticated subject without exposing Google account identity).

## 4. Capabilities and Space model

Set `files_sharing.api_enabled = false` and `files_sharing.public.enabled = false` (Desktop defaults both to `true` when omitted), set `files_sharing.user.profile_picture = false`, disable versioning/undelete, omit `notifications` and unsupported `app_providers`/`archivers`, and omit lock capabilities. Enable `spaces.enabled = true`, `spaces.version = "1.0.0"` (required by Desktop `SpaceSupport::isValid()`), and `spaces.projects = false` (non-null Moshi `Boolean` required by Android `SpacesCapabilities`), and include `ocs.data.version`. Set `core.pollinterval` to **`30000`** (milliseconds = 30 s, `#12`), matching Desktop 7.1.1's millisecond parsing (Android parses `pollinterval` as `Int?` without scheduling timers; Desktop `SpacesManager` also polls `/graph/v1.0/me/drives` every 30 s).

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

- **Default `10485760` (10 MiB = 40 × 256 KiB)** matches rclone/Cyberduck full chunks and aligns CLI/Desktop/Android clients that follow the capability. Keep a separate accepted ingress ceiling (`>= 10 MiB`, below Worker ingress limits) because clients may send 10,240,000-byte (Android `CHUNK_SIZE` when cap omitted/higher), 10,000,000-byte, smaller chunks, or local overrides (see [controlled experiment](ocis-probe-report.md#controlled-chunk-announcement-experiment)). `POST`-with-data and `PATCH` share this ceiling.
- `Tus-Max-Size` is the whole-file limit, not the per-request chunk limit.
- Under `core`, set `webdav-root: "webdav"` (matching oCIS 8.2.3); under `checksums`, advertise `supportedTypes: ["sha1", "md5", "sha256"]` and `preferredUploadType: "sha1"` (lowercase matching oCIS 8.2.3; Desktop normalizes case, Android uses `"sha1"`).
- Graph drive entry requires `driveType=personal`, stable `id` matching `root.id`, `name`, **both top-level `eTag` and `root.eTag`** set to the changing root ETag (Desktop `Space::setDrive()` checks `root.eTag` while `ETagWatcher::slotSpaceChanged()` reads top-level `drive.eTag`), and `root.webDavUrl` with literal `$` and **no trailing slash** (Android `RemoteFile.getRemotePathFromUrl` URL-decodes `href` before splitting by `spaceWebDavUrl`). Under `15A`, compute `quota` integers from Drive `about.storageQuota` using `BigInt` (ensuring non-null integer `quota.total` when `quota` is present for Android); omit `quota` when Drive reports no finite limit or incomplete fields (never fabricate `0` or fake totals), and omit `special`, `owner` (unless populated truthfully for the authenticated subject), `webUrl`, or `description` when inapplicable. Restrict all access within `ROOT_ID`.

## 5. DAV resource and synchronization contract

Retain DAV XML namespaces/escaping, `207` propstat grouping (`404` propstat for unknown properties), `Content-Type: application/xml; charset=utf-8` on `PROPFIND` responses (verified verbatim by Desktop `discoveryphase.cpp`), and `Depth: 0`/`1` only. Never mask failed or partial Drive listings as empty directories.

Required property surface:
- `DAV:`: `displayname`, `resourcetype`, `getcontenttype`, `getcontentlength`, `getlastmodified`, `creationdate`, `getetag`
- `http://owncloud.org/ns`: `id`, `fileid`, `spaceid`, `file-parent`, `name`, `permissions` (non-empty using Desktop `" WDNVCKRSMmz"` flags, e.g. `RDNVW` / `RDNVCK` / `R`), `checksums`, `size`, `has-preview` (`"1"` or `"0"`, checked strictly against `"1"` by Android `OCHasPreview`)
- Optional (return `404` when unsupported): `share-types`, `privatelink`, `downloadURL`, `dDC`, root `data-fingerprint`
- Use `oc:size` on collections rather than `d:getcontentlength` (do not invent recursive totals). Map `oc:id` and `oc:fileid` to stable Drive IDs that survive rename/move, and reflect actual writable permissions.
- Support `Prefer: return=minimal` by omitting `404` propstat entries and returning `Preference-Applied: return=minimal`.

Validators and synchronization:
- **Unified Drive v3 validators & immutable revision downloads (`4A-1`)**:
  - Unify `GET`, `HEAD`, and `PROPFIND` file validators on Drive **v3** using `"<id>-<headRevisionId>"` (falling back to `version` when `headRevisionId` is absent), removing the Drive v2 dependency.
  - Live Drive v3 verification (2026-11-24) confirmed `headRevisionId` is populated immediately and identically across `multipart`, `media`, `resumable` final `200`, metadata-only empty `POST`, `files.get`, and `files.list`; content overwrites change `headRevisionId` and advance `version`, whereas `appProperties` updates advance `version` without changing `headRevisionId`.
  - `GET` downloads immutable bytes from `GET /drive/v3/files/{id}/revisions/{headRevisionId}?alt=media` (live-verified `200`, `Range` `206`, out-of-bounds `416`, zero-byte `200`, and immutable `206` reads of the previous `rev1` after overwriting the file to `rev2`), falling back to `files/{id}?alt=media` on `403` (read-only shared items) or `404` (purged revision).
  - On `Range` + `If-Range`, bypass the isolate memory cache to fetch the live `headRevisionId`: if changed (or weak/date `If-Range`), return `200` with the full latest revision; if matched, serve `206` from immutable `revisions/{headRevisionId}?alt=media`.
- Directory and Space-root `eTag`s must reflect descendant changes (Drive folder `modifiedTime`/`version` alone does not update on child edits).
- **Sync change discovery (OC-05, SQLite DO item index + Drive `changes.list`)**:
  - A single SQLite-backed Durable Object maintains a lightweight index `items(id, parent_id, is_folder, etag_gen)` alongside the Drive `changes.list` `pageToken` and last-poll timestamp. The single-threaded DO actor serializes cursor advancement with tree updates, while keeping the hot `root.eTag` and polling throttle timestamp in DO memory.
  - Local Worker mutations and throttled on-demand `changes.list` polls update affected rows and bubble `etag_gen++` upward along `parent_id` ancestors to `ROOT_ID` only. Changes outside `ROOT_ID` are ignored, and untouched sibling subtrees keep their existing `etag_gen` so clients only rescan modified branches.
  - Indexing both folders and files (`id -> parent_id`) lets external file moves (old parent looked up in SQLite, new parent from `changes.list`) and permanent deletions (`removed: true`, old parent looked up in SQLite) bubble accurately without full-tree rescans.
  - On missing/invalid DO state or lost `pageToken` cursor, re-seed the index from `getStartPageToken` / tree scan and advance an epoch so clients perform a clean rescan rather than asserting unchanged.
  - Bind isolate memory metadata/listing caches to directory `etag_gen` (and in-flight request starting generation) so stale cached listings are never served under a newer ETag. Audit Drive `changes.list` / `getStartPageToken` (tokens do not expire; handle pagination and permission loss) and extend `MockDrive` before implementing `OC-05`.

## 6. File operations and errors

| Operation | Required behavior |
| --- | --- |
| `GET` / `HEAD` | Original bytes, actual MIME/length, and unified Drive v3 ETag (`"<id>-<headRevisionId>"`, falling back to `version`); `GET` downloads immutable `revisions/{headRevisionId}?alt=media` (fallback `files/{id}?alt=media` on `403`/`404`) with `Range` (`206` / `416`) and live-checked `If-Range`. |
| `PUT` | Bounded streaming; `201` new / `204` replace; honor `mtime` (`X-OC-Mtime`), optional whole-file `OC-Checksum` (`SHA1:<hex>` sent by Android for `< 10,240,000` B files, rejecting mismatch with `400`), and preconditions (`If-Match` mismatch returns RFC standard `412 Precondition Failed`, `#11`, natively mapped to conflict/rediscovery by both Desktop 7.1.1 and Android 1.3.1 rather than oCIS 8.2.3's `409`). |
| `MKCOL` | `201`; missing or non-collection parent `409` globally (`9.2B`, no implicit parent creation). |
| `MOVE` / rename | Destination validation, existing overwrite/trash-recovery semantics (`201`/`204`), `412` on `Overwrite: F` or precondition failure, reject self/descendant overlap, preserve source ID. |
| `COPY` | `201`/`204` and new ID; `412` on `Overwrite: F`; support RFC 4918 folder `COPY` (`8B`): `Depth: 0` creates the folder shell with metadata/properties, `Depth: infinity` (default) stages a `.webdav-copy-<UUID>` root folder and performs level-by-level BFS copying via Google Drive v3 Batch API (`POST /batch/drive/v3`, up to 100 calls/batch, with lightweight internal retry on transient `429`/`5xx` sub-items and explicit subrequest/item budget) before publishing. Unified failure cleanup for file and folder `COPY`: if staging/copying, target-trashing, or final rename definitively fails (non-`408` `4xx`), trash the unpublished stage (`trashed: true`, best-effort) and return a single `4xx`/`5xx` error (restoring the trashed destination on definitive rename rejection); leave stage and trash untouched only on an ambiguous final-rename failure (`5xx`/`408`/network loss). |
| `DELETE` | `204` (or `200`), distinguishing missing/forbidden; move deleted items to Drive Trash (`trashed: true`) without permanent deletion to align with recoverable overwrite semantics and protect against accidental sync wipes. |
| `PROPPATCH` | Retain native and `appProperties`-backed dead properties (`10.1A`, simplifying over-defensive XML validation/re-parsing in `src/webdav/property-xml.ts`), protected-property `403`, quota `507`, and single-PATCH error reporting; ignore writes to `{http://owncloud.org/ns}checksums` as a `200` no-op (`10.2A`, never storing client digests; `PROPFIND` always computes `oc:checksums` from Google Drive's real digests). |
| `LOCK` / `UNLOCK` | Disabled (`501`), no Class 2 / lock claims. |

Map upstream failures accurately (`401`, `403`, `404`, `409`, `412`, `413`, `429`, `507`) without turning unknown errors into `404`/`507` or partial failures into success. Exclude Google Workspace native documents and Drive Shortcuts (any `mimeType` starting with `application/vnd.google-apps.` other than `application/vnd.google-apps.folder`) from listings and path resolution (`7A`), avoiding broken downloads, missing `size`/checksums, and bidirectional sync loops.

### Unified route layout and migration boundary

Unified single-handler routing (`9.3`):
- Default generic WebDAV `WEBDAV_PATH` changes from `/dav/` to **`/webdav/`** (still configurable via `WEBDAV_PATH`). Reject `WEBDAV_PATH` values equal to `/` or overlapping reserved oCIS prefixes (`/dav/spaces/`, `/remote.php/`, `/ocs/`, `/graph/`, `/oauth/`, `/status.php`, `/.well-known/`) with a `500` configuration error so generic DAV routes never shadow oCIS endpoints.
- Always expose oCIS WebDAV and discovery endpoints at origin root (`/dav/spaces/<spaceId>/...`, `/remote.php/webdav/...`, `/remote.php/dav/files/<username>/...`, `/status.php`, `/ocs/*`, `/graph/*`, `/.well-known/*`) backed by the same Drive/WebDAV handler. OIDC `/oauth/*` routes activate automatically only when Cloudflare Access configuration is present (otherwise HTTP Basic `USERS` only).
- Decode each path segment once; treat literal `$` and `%24` in Space IDs identically while blocking traversal or mount escapes.
- Remove `ensureDir` globally (`9.2B`): `MKCOL`, `PUT`, and TUS creation return RFC 4918 `409 Conflict` whenever the parent collection is missing or not a folder, matching `MOVE`/`COPY`.
- Remove the legacy non-TUS `PATCH`-to-`COPY` alias globally (`9.1A`): reject any non-TUS `PATCH` with `405 Method Not Allowed` across all routes.
- Compute quota integers with `BigInt` (`15A`: omit absent limits as unlimited; omit Graph `quota` when Drive has no finite limit or client expectations are unmet).

## 7. TUS upload and recovery

- **Creation & paths**: Desktop requires `creation-with-upload` (`POST` with initial body) and `Upload-Length: 0` immediate completion. Desktop `filename` metadata may be a relative subpath, while Android sends a basename under `<spaceWebDavUrl>/<parentDir>` (no trailing slash) for files `>= 10,240,000` B; resolve once relative to the upload collection and reject traversal, NUL, ambiguous encoding, or absolute URLs.
- **Metadata (`14A`)**: Strictly validate `filename`, `mtime` (accept finite fractional Unix seconds and reconcile `X-OC-Mtime`), `checksum`, and path safety. Tolerate trailing commas and Cyberduck 9.6.0's unencoded `filetype` (`filename <b64>, filetype application/octet-stream,`), falling back invalid/unrecognized `filetype` values to `application/octet-stream`, and ignore unused unknown metadata keys without failing on their Base64 encoding. Note rclone 1.76.0 `SetModTime` sends `PROPPATCH` with `{DAV:}lastmodified` (integer Unix seconds) plus `{http://owncloud.org/ns}checksums`: under `10.2A`, treat `PROPPATCH` writes to `oc:checksums` as a `200` no-op (never persisting client-supplied digests into `appProperties`, avoiding `424` batch failure on `DAV:lastmodified`) and always compute `PROPFIND` `oc:checksums` dynamically from Google Drive's real `md5Checksum`/`sha1Checksum`/`sha256Checksum`.
- **Protocol surface**: Implement TUS `OPTIONS`, `POST`, `HEAD`, `PATCH` with `Tus-Resumable`, `Upload-Offset`, `Upload-Length`, and Worker-scoped `Location` (never expose Google's resumable URL). Advertise `Tus-Extension: creation,creation-with-upload,checksum` and `Tus-Checksum-Algorithm: sha1,md5,sha256` on TUS responses (omitting unimplemented `termination`/`expiration`, while keeping OCS `files.tus_support.extension` as `"creation,creation-with-upload"`). Tolerate an omitted `Tus-Resumable` header on TUS `HEAD` (sent by Desktop 7.1.1 journal resume in `propagateuploadtus.cpp:123`), while returning `412` on any non-empty unsupported version. Return `409` on offset mismatch, `415` on bad content type, `404`/`410` on missing/expired sessions. Validate per-chunk `Upload-Checksum` (sent as `sha1 <base64>` by Android on data-bearing `POST` and `PATCH`) via Workers native Web Crypto (`crypto.subtle.digest`) before flushing to Drive and reject mismatches with `460` (`400`/`460` triggers immediate failure and state reset in Android `TusUploadHelper`), plus honor optional whole-file `OC-Checksum` on TUS `POST` (sent by rclone 1.76.0).
- **Completion & recovery**: Retain DO serialization and `bytes */<total>` reconciliation against Drive's `Range`. Upon completion, immediately delete the DO session state and cancel its alarm (`deleteAll()` + `deleteAlarm()`, `13B`): subsequent `HEAD`/`PATCH` on the completed URL return `404` without `Upload-Offset` (matching TUS 1.0.0 and reference oCIS 8.2.3), zero-length `POST` uploads complete directly without creating a DO, and the 24-hour alarm cleans up only abandoned in-progress sessions. Target completion headers should include `ETag`, `OC-FileID`, and `OC-Perm` (clients fall back to `PROPFIND` if absent). Honor `mtime` and overwrite preconditions (`If-Match` mismatch returns RFC standard `412 Precondition Failed`, `#11`, rather than oCIS 8.2.3's `409`).
- **Whole-file checksum verification**: Do not run pure-JS resumable hashing in Worker CPU or withhold the final block. Request Drive's native `md5Checksum`, `sha1Checksum`, and `sha256Checksum` on upload completion. Live Drive v3 probing (2026-11-24) confirmed all three digests are populated immediately and match bytes on `multipart`, `media`, zero-byte media truncation, and `resumable` final `200` responses; **metadata-only empty creation (`POST /drive/v3/files`) populates `md5Checksum` only** (omitting `sha1Checksum` and `sha256Checksum`), so zero-byte uploads must validate client checksums against constant empty-input digests in Worker code. If a supplied client `checksum` mismatches: trash/delete a newly created file and return `400`/`460`; for an in-place overwrite, return `400`/`460` so the client retries or clears broken TUS state (previous content remains recoverable via Google Drive Revisions).
- **Block flushing & storage (`5A`)**: Replace the current `1 MiB` write-ahead `pending` blob journal with direct `<= 10 MiB` (`10,485,760` B, 256 KiB-aligned) flushes to Drive (`prevTail` + aligned prefix of the current request). Persist only the `< 256 KiB` unaligned `tail` plus a lightweight `inflight` flag in SQLite (staying far below SQLite DO's 8 MB row limit and reducing a 10 MiB `PATCH` from 10 Drive PUTs / 20 DO writes to 1 Drive PUT / 2 tiny metadata writes). If a flush fails or crashes while `inflight` is set, recovery queries Drive via `bytes */<total>`: if Drive accepted nothing, the persisted previous `tail` remains intact; if Drive accepted past the previous `tail`, advance `offset`/`driveOffset` to Drive's real range and clear `tail` before resuming.

### Worker-to-Drive alignment acceptance gate

Clients may ignore the 10 MiB recommendation (e.g., `10,000,000`-byte chunks leave a **38,528-byte** remainder mod 256 KiB) or change chunk sizes on resume. Preserve arbitrary client chunk boundaries and reblock only toward Drive with a bounded tail:

1. Run supported clients through the actual Worker compatibility layer (not reference oCIS) on files > 2 chunks: `10,000,000`-byte data-bearing `POST` + `PATCH`es, Android `10,240,000`-byte chunks (`16,384`-byte mod 256 KiB remainder), `10 MiB` default, and irregular/varying resume chunk sizes, verifying downloaded SHA-256 and 256 KiB alignment of Drive-facing non-final chunks.
2. Against the aligned Drive mock, inject interruptions after tail/inflight persistence, after Drive accepts bytes (dropped response), and before client ack; restart Worker/DO, recover via `HEAD` + Drive `Range`, resume with a different chunk size, and verify byte-exact completion.

## 8. Preview and metadata

- Support authenticated DAV `GET` with `preview=1` and `x`/`y`/`c` query parameters (`c` is a cache validator hint), plus `oc:has-preview`.
- Proxy Drive `thumbnailLink` server-side (never redirect to Google URLs or expose tokens), returning actual image `Content-Type` and bytes with client-side HTTP cache validators (`Cache-Control: private, max-age=300`, `ETag`, `Vary: Authorization`, `If-None-Match` `304`) backed by the existing isolate metadata cache rather than buffering thumbnail binaries in Worker heap.
- Follow actual Drive thumbnail availability (reference oCIS generates JPEG previews for text files and `404` for opaque binaries; never mask missing previews with original file bytes). Validate requested dimensions without promising exact server-side resizing unless implemented.
- Retain `DAV:lastmodified` (integer Unix seconds) vs `DAV:getlastmodified` (HTTP-date) and existing Drive `appProperties`-backed custom/native property behavior (`10.1A`, while simplifying over-defensive XML validation/re-parsing).

## 9. Release gate and evidence policy

Freeze schemas and defaults only after end-to-end tests with target binaries:
- Linux and Windows Desktop sync in both directions (local edits and external Drive edits).
- Android browse, edit/upload, download, and background/interrupted transfers, plus rclone regression.
- Real deployed Cloudflare Workers ingress-limit validation for multi-chunk uploads beyond single-request limits.
- Keep default automated tests (`pnpm test --run`) offline and mock-only; keep live Drive checks opt-in and scoped to unverified contracts.
