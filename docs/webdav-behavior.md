# WebDAV behavior

## Routing and mount path

- Generic WebDAV is mounted at `WEBDAV_PATH` (default `/webdav/`). Requests to `<basePath without trailing slash>` redirect (`301`) to `<basePath>`, and requests outside `<basePath>` return `404 Not Found`.
- There is no `OCIS_ENABLED` switch. To avoid shadowing oCIS endpoints, `WEBDAV_PATH` cannot be `/`, contain query/fragment/dot/empty/percent-encoded/whitespace segments, or overlap reserved oCIS prefixes (`/dav/spaces/`, `/remote.php/`, `/ocs/`, `/graph/`, `/oauth/`, `/status.php`, `/.well-known/`), including `/dav/` (which overlaps `/dav/spaces/`). Misconfigured `WEBDAV_PATH` values fail closed with `500`.

## Locking

- WebDAV locking is not supported. `OPTIONS` advertises `DAV: 1` (not Class 2) and omits `LOCK`/`UNLOCK` from `Allow`. `PROPFIND` returns an empty `<D:supportedlock/>` element for files and collections.
- Authenticated `LOCK` (including refresh) and `UNLOCK` requests return **501 Not Implemented** without issuing a lock token, creating a resource, or calling Google Drive.
- Clients must operate without locks; there is no lock-based protection against concurrent overwrites.

## Properties (PROPFIND / PROPPATCH)

- `OPTIONS` includes `PROPPATCH`. `PROPFIND` supports an empty body / `allprop`, `propname`, selected `prop`, and `allprop` with `include`. Unknown requested properties receive a separate `404` propstat. Dead properties are included in listings and can be read back after setting them.
- `PROPPATCH` processes `set` / `remove` operations in document order. Property identity is the expanded name (namespace URI plus local name), not the prefix. Dead properties retain XML child elements, attributes, mixed text, significant whitespace, in-scope namespace bindings, and inherited `xml:lang` / `xml:space`. Empty values are distinct from absent properties; removing an absent dead property succeeds. UTF-8 XML is limited to 64 KiB and 128 nesting levels; malformed XML and DTD/entity declarations are rejected before writing.
- `DAV:displayname` is a writable text property stored alongside dead properties. It does **not** rename the Drive file or change its URL; `REMOVE` stores a small tombstone so subsequent `PROPFIND` reports `displayname` absent instead of falling back to the Drive filename, and `SET` makes it visible again. `MOVE` preserves dead properties (including this tombstone) and `COPY` explicitly passes `appProperties` to Drive, since Drive's copy endpoint does not inherit `appProperties` automatically.
- `PROPFIND` sets `getetag` from Drive ID and `headRevisionId` (`"<id>-<headRevisionId>"`, falling back to `version` when `headRevisionId` is absent, and omitting `getetag` if neither exists), matching the strong `ETag` returned by `GET` and `HEAD`. Content writes change `headRevisionId` and advance `version`, whereas `appProperties` and metadata-only updates advance `version` without changing `headRevisionId`.
- `PROPFIND` dynamically computes `{http://owncloud.org/ns}checksums` (`<oc:checksums><oc:checksum>...</oc:checksum></oc:checksums>`) on non-folder files from Drive's real `sha1Checksum`, `md5Checksum`, and `sha256Checksum` fields (emitting available `SHA1:<hex>`, `MD5:<hex>`, and `SHA256:<hex>` digests, and omitting the property on folders or files without Drive digests).
- Quota integers (`quota-used-bytes` and `quota-available-bytes`, returned on `Depth: 0` root `PROPFIND`) are computed with `BigInt` without JavaScript floating-point rounding. If Drive does not report a finite quota limit, `quota-available-bytes` is absent (explicitly requesting it returns `404` in multistatus), not `0` or `NaN`. Exhausted finite quotas report `0` available bytes.

### Drive-backed live properties

Use the project namespace `urn:google:drive` for native Drive extensions (for example, `<G:description xmlns:G="urn:google:drive">Notes</G:description>`). These update real Drive metadata:

| Property | Write value / behavior |
| --- | --- |
| `DAV:getlastmodified` | HTTP-date (`Mon, 16 Nov 2026 08:00:00 GMT`); updates Drive `modifiedTime` |
| `DAV:lastmodified` | Integer Unix seconds (ownCloud/rclone write alias); updates Drive `modifiedTime` (not saved as a dead property) |
| `G:modifiedTime` | RFC 3339 timestamp; updates Drive `modifiedTime` |
| `G:description` | Text description |
| `G:starred` | `true` / `false` (also `1` / `0`) |
| `G:folderColorRgb` | `#rrggbb` on folders; Drive quantizes to its nearest supported palette color |

Present native live properties cannot be removed (`409`): set an empty description or `starred=false` to clear those values. Removing an already absent optional native property succeeds as a no-op without calling `files.update`.

`DAV:creationdate` / `G:createdTime` are read-only, as are `getcontentlength`, `getcontenttype`, `getetag`, `resourcetype`, `supportedlock`, `lockdiscovery`, `quota-used-bytes`, `quota-available-bytes`, and unsupported `urn:google:drive` names. Metadata-only updates do not change an existing binary file's MIME type; use file-content operations for content and `MOVE` for renaming.

Writes (`set` or `remove`) to `{http://owncloud.org/ns}checksums` in `PROPPATCH` (such as `rclone` batching `oc:checksums` with `DAV:lastmodified`) are silently ignored as a `200` no-op without persisting client digests to `appProperties` (still returning `424 Failed Dependency` if another property in the batch fails).

Property semantics follow [RFC 4918](https://www.rfc-editor.org/rfc/rfc4918.html); backend limits follow [Drive custom properties](https://developers.google.com/workspace/drive/api/guides/properties).

### Storage and failure semantics

- Dead properties are stored on the resource in OAuth-client-private Drive `appProperties` under reserved keys `wdp00` through `wdp29`. Keep the same OAuth application to read them, and do not edit those keys directly. Unrelated `appProperties` are preserved; corrupt stored `wdp*` data fails with `500` rather than being overwritten.
- Drive permits 30 private properties per application per file, each at most 124 UTF-8 bytes for key plus value. Each 5-byte chunk key leaves 119 payload bytes: at most 3,570 bytes **including the versioned JSON/XML wrapper**, and less if other `appProperties` occupy slots (Drive also enforces an aggregate 100-property limit across applications). Exceeding capacity returns `507` without applying any updates in the batch.
- All operations are parsed and validated before a single `files.update` `PATCH`. Invalid values receive `409`, protected writes receive `403` with `cannot-modify-protected-property`, and sibling properties in a rejected batch receive `424`. Missing resources receive `404`. Inspect per-property statuses inside the `207` multistatus response.
- The single Drive `PATCH` is the atomic boundary for one request, not a cross-request transaction or lock; concurrent read-modify-write requests can overwrite each other. A lost `PATCH` response returns `502` without retry or rollback.
- Property writes invalidate the current isolate's metadata and parent directory caches before returning.
- Dead-property writes advance Drive's `modifiedTime` unless the same `PATCH` explicitly sets `modifiedTime`. Folder colors and timestamp precision may be normalized by Drive; read-back reflects Drive's stored values.

## PUT uploads

- `PUT` validates `Content-Length` as a nonnegative safe integer (`400` for negative, non-numeric, fractional, empty, or unsafe values) and rejects bodies whose byte count does not match `Content-Length` with `400` before committing (returning `502` if the incoming stream errors). Overwriting an existing collection (with or without a trailing slash) is rejected with `405 Method Not Allowed` without mutating Drive.
- `PUT` with a known `Content-Length` streams files `<= 5 MiB` via `uploadType=media` (overwrite) or `uploadType=multipart` (new). Empty uploads (`Content-Length: 0` or no body) create an empty file or truncate an existing file via `uploadType=media`.
- `PUT` without `Content-Length` and `PUT` with `Content-Length > 5 MiB` both stream through Drive resumable uploads (`putResumable`) instead of buffering the entire body. The uploader buffers at most one 10 MiB chunk plus one read lookahead to detect EOF (including exact 10 MiB boundaries), forwards upstream `init`/chunk `4xx`/`5xx` statuses (`502` if `Location` is missing), verifies each intermediate `308` status and `Range` header, and requires `200`/`201` on the final chunk before invalidating caches or returning success. Streaming reduces Worker memory usage but does not bypass Cloudflare's per-request ingress limit.
- Creating collections (`MKCOL`) or uploading files (`PUT`) requires the immediate parent collection to exist as a folder; missing or non-folder parents return `409 Conflict` per RFC 4918 rather than auto-creating intermediate directories.
- Uploads never automatically retry or roll back on error; an ambiguous network/upstream failure can follow a committed write, so inspect the destination before retrying.

## TUS and rclone uploads

TUS is a separate resumable-upload protocol outside WebDAV; an ordinary WebDAV `PUT` receiving `413` will not automatically retry with TUS.

The server implements TUS 1.0 core and the `creation` extension with a required `Upload-Length` (no `creation-with-upload`, deferred length, concatenation, checksum, or termination extensions). `OPTIONS` advertises `Tus-Version: 1.0.0` and `Tus-Extension: creation`; unsupported `Tus-Resumable` versions return `412`. Creation accepts optional Base64 UTF-8 `filename` / `filetype` metadata and integer Unix-seconds `mtime`. Missing or non-folder parent collections return `409 Conflict` (matching `PUT`, `MKCOL`, `MOVE`, and `COPY`; intermediate directories are never auto-created), overwriting a folder returns `409`, and zero-length uploads create or truncate the destination immediately.

Each upload session uses its own SQLite Durable Object (`TusUpload`):
- `PATCH` requests are accepted only on TUS upload session URLs (`<basePath>tus_uploads/<sessionId>`) and are serialized per session; non-TUS `PATCH` requests anywhere else return `405 Method Not Allowed` (without aliasing `COPY`), and `OPTIONS` omits `PATCH` from `Allow` on non-TUS paths. Unaligned or small client chunks are durably buffered (in 1 MiB blocks with a `< 256 KiB` alignment tail) and flushed as 256 KiB-aligned chunks to Drive; no entire upload is buffered in memory or storage.
- A write-ahead `pending` record persists bytes before flushing to Drive, and recovery reconciles via `bytes */<total>` against Drive's actual acknowledged `Range`.
- Returned `Upload-Offset` includes bytes safely persisted in the Durable Object journal as well as bytes already in Drive. Offset mismatches return `409`, expired Drive upload URLs return `410`, and upstream failures return `503`/`502` without resetting offset to zero.
- Sessions (including completed upload receipts for lost final responses) expire 24 hours after creation. The expiry alarm cleans up session state only, not the destination file. Sessions are scoped to the authenticated WebDAV username.

For rclone, configure its WebDAV remote with `vendor = infinitescale` to use TUS:

```ini
[worker]
type = webdav
url = https://YOUR-WORKER/webdav/
vendor = infinitescale
user = YOUR-WEBDAV-USER
pass = YOUR-RCLONE-OBSCURED-PASSWORD
```

Use `rclone config` to obscure the password and `rclone copy /path/to/file worker:`. Each TUS chunk sent by rclone must fit the deployment's ingress limit (in rclone v1.76.0, `vendor = infinitescale` sends 10 MiB chunks, does not resume failed TUS sessions, and sets `filename` from the source basename—so use `copy` and rename afterward rather than `copyto`).

### Reproducing the local rclone check

An opt-in test runs an installed `rclone` binary against a local Worker with SQLite Durable Objects, `MockDrive`, and a simulated 12 MiB ingress cap:

```bash
RCLONE_BIN=/path/to/rclone pnpm test:e2e
```

Verified with rclone v1.76.0: uploading a 26,214,523-byte file produced `PATCH` bodies of 10,485,760, 10,485,760, and 5,243,003 bytes (matching SHA-256 and `mtime`), while an oversized single `PUT` received `413`.

## File downloads and validators

- `GET` on a collection returns `405 Method Not Allowed` with an `Allow` header; HTML directory listings are not served.
- File `GET` uses Drive **v3** exclusively (no Drive v2 endpoints). It prefers immutable revision downloads from `GET /drive/v3/files/{id}/revisions/{headRevisionId}?alt=media` and falls back to `GET /drive/v3/files/{id}?supportsAllDrives=true&alt=media` when `headRevisionId` is absent, or when the revision endpoint returns `403` (excluding `cannotDownloadAbusiveFile`, such as read-only shared items) or `404` (purged revision, after invalidating cached metadata). Images with `thumbnailLink` download their original bytes rather than a preview CDN, and the legacy `param` query parameter is ignored. `?abuse=true` redirects (`302`) when Drive rejects abusive downloads unless already set.
- `GET`, `HEAD`, and `PROPFIND` emit the unified strong validator `"<id>-<headRevisionId>"` (falling back to `version` when `headRevisionId` is absent, and omitting `ETag` / `getetag` if neither exists). `HEAD` omits `ETag` on collections while returning `Content-Length`, `Content-Type`, `Last-Modified` (falling back to current UTC time if `modifiedTime` is null), `Accept-Ranges: bytes`, and `ETag` on files when available.
- `HEAD`, whole-file `GET` (without `Range`), and conditional `Range` + `If-Range` requests bypass the short file leaf cache (while still reusing cached parent folder IDs) to fetch live metadata and refresh the short file cache. Plain `Range` `GET` requests (without `If-Range`) use the 30-second file metadata cache for low-latency immutable revision reads without extra Drive metadata lookups.
- Ordinary `Range` requests are forwarded to Drive (returning `206` or `416` with `Content-Range` intact alongside `Accept-Ranges: bytes` and `ETag`). Because Drive ignores `If-Range` on `alt=media`, when a client supplies both `Range` and `If-Range`, the worker resolves live metadata for the path (reusing cached parent folder IDs and evicting stale leaf entries if gone):
  - If `If-Range` is a strong tag matching the live unified `ETag`, the worker forwards the `Range` request against the live revision (`206` or `416`).
  - On mismatch, weak tag, or HTTP-date `If-Range`, the worker clears `Range` and performs a full `GET` (`200`) of the latest revision directly.

## MOVE / COPY replacement

- `Overwrite: F` rejects an existing destination with `412`. Otherwise, successful replacement returns `204` and creating a new destination returns `201` (`MOVE` to a new destination also sets `Location`).
- `MOVE` trashes the previous destination, then renames/moves the source by ID. File `COPY` to a new destination uses a single copy request, while overwriting `COPY` stages a uniquely named `.webdav-copy-<UUID>` copy in the destination folder, trashes the previous destination, then renames the staged copy to its final name.
- Folder `COPY` follows RFC 4918 `Depth`: `Depth: 0` creates a shallow folder shell with copied metadata and properties (`description`, `starred`, `modifiedTime`, `folderColorRgb`, `appProperties` dead properties and `DAV:displayname` tombstone) without copying descendants. `Depth: infinity` (or omitted `Depth`) stages a `.webdav-copy-<UUID>` folder and copies visible descendants level-by-level (BFS) via Drive v3 Batch (`POST /batch/drive/v3`, up to 100 calls per batch, bounded at 1,000 items / 40 batches, with up to 2 lightweight retries on transient `429`/`5xx` sub-items, skipping hidden Google Workspace docs/Shortcuts) before trashing any existing target and publishing by rename. Invalid `Depth` headers return `400`, and exceeding item or batch limits returns `413`.
- Overlapping path trees, same-ID targets, and `/` endpoints are rejected (`403`) before any mutation; missing or non-folder destination parents return `409`.
- Replacement never permanently deletes the previous destination. If staging/copying fails, destination trashing fails, or the final publish rename fails with a definitive `4xx` (other than `408`), the worker attempts to trash the unpublished `.webdav-copy-<UUID>` stage (`trashed: true`, best-effort) and (after destination trashing) restore the trashed destination (`trashed: false`), returning a single error status. Restoring a replaced folder also restores descendants that had been explicitly trashed prior to replacement.
- Ambiguous final-publish errors (network errors, `5xx`, `408`, or unreadable/mismatched `id` responses) return an error without retry, destination restore, or stage cleanup, including known target/stage IDs and the `.webdav-copy-<UUID>` recovery name in the response text so an already-committed publish is never destroyed. Inspect Drive before retrying or deleting staged copies.
- This is a multi-request workflow, not an atomic transaction. Local metadata and descendant caches are evicted in `finally`. Ordinary `DELETE` likewise moves resources to Drive Trash (see [DELETE](#delete)).

## DELETE

- `DELETE` moves the target file or folder to Google Drive Trash via `PATCH /drive/v3/files/{id}?supportsAllDrives=true&fields=id` with `{ trashed: true }` (never permanently deleting items), returning `204 No Content` on success (`403` on the mount root `/`, `404` when missing or already trashed, and preserving upstream Drive error statuses such as `403`).
- Trashing a folder moves the entire folder tree to Trash while preserving content, `modifiedTime`, and `appProperties` (dead properties); local metadata, descendant, and parent listing caches are evicted in `finally`, so deleted paths return `404` immediately even while Drive propagates descendant `trashed` flags asynchronously.
- Trashed items and folders can be restored in Google Drive (`trashed: false`) with their original Drive IDs, bytes, timestamps, and dead properties intact (note Drive's settled folder-restore behavior also clears `explicitlyTrashed` on previously trashed descendants).
- Permissions: trashing requires `supportsAllDrives=true` and owner permission in My Drive or Content Manager / Manager permissions in a Shared Drive.

## Google Workspace native documents and Shortcuts

- Directory listings (`PROPFIND`) and path resolution (`getMetadata`) exclude every Drive item whose `mimeType` starts with `application/vnd.google-apps.` except `application/vnd.google-apps.folder` (such as Google Docs, Sheets, Slides, Drawings, Forms, third-party Drive apps, and Drive Shortcuts).
- Hidden Workspace items and Shortcuts return `404` for direct reads, property requests, `MOVE`/`COPY` sources, and `DELETE` without calling `alt=media` or mutating Drive, and cannot be traversed as collections.
- Because hidden items are filtered out during resolution and never cached, an ordinary file or folder sharing the same name in Drive resolves normally, and writes (`PUT`, `MKCOL`, `MOVE`/`COPY` destinations, TUS uploads) treat a path occupied only by a hidden item as absent without overwriting or trashing it.

## Metadata and listing caches

- Folder metadata is cached in isolate-local memory for 300 seconds, while file leaf metadata and directory listings (`objects`) are cached for 30 seconds. Cache hits do not extend TTL; expired or missing entries fetch from Drive. `HEAD`, whole-file `GET`, and `Range` + `If-Range` `GET` bypass the file leaf cache (reusing cached parent folder IDs) and refresh it with the live result.
- Each cache namespace holds at most 128 entries (excluding the fixed `/` root mapping). Expired entries are purged on write, and the oldest inserted entry is evicted at capacity. Entries whose key plus serialized JSON value exceed 64 KiB are not cached.
- There is no Workers KV binding or shared cache across isolates; external Drive edits or mutations handled by another isolate remain stale locally until expiry. TUS upload sessions remain durable in Durable Objects.

See [test/support/mock-drive.md](../test/support/mock-drive.md) for the Drive mock contract and verified API behavior.

[Back to README](../README.md)
