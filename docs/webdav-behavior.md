# WebDAV behavior

## Locking

- WebDAV locking is not supported. OPTIONS advertises `DAV: 1`, not Class 2, and does not list LOCK/UNLOCK in Allow. PROPFIND returns an empty `supportedlock` property for files and collections.
- Authenticated LOCK (including refresh) and UNLOCK requests return **501 Not Implemented**, without issuing a lock token, creating a resource, or calling Drive. Locking is unavailable throughout the service, rather than merely disallowed on a particular resource.
- Clients must work without locks; clients that require them may refuse writes or editing. There is no lock-based protection against concurrent overwrites. This is not a claim of complete WebDAV conformance or client-by-client compatibility.

## Properties (PROPFIND / PROPPATCH)

- OPTIONS includes PROPPATCH. PROPFIND supports an empty body / `allprop`, `propname`, selected `prop`, and `allprop` with `include`. Unknown requested properties receive a separate 404 propstat. Dead properties are included in listings and can be read back after setting them.
- PROPPATCH processes `set` / `remove` in document order. Property identity is the namespace URI plus local name, not the prefix. Dead properties retain XML child elements, attributes, mixed text, significant whitespace, in-scope namespace bindings and inherited `xml:lang`. Empty values differ from absent properties; removing an absent dead property succeeds. UTF-8 XML is limited to 64 KiB and 128 nesting levels; malformed XML and DTD/entity declarations are rejected before writing.
- `DAV:displayname` is a writable text property stored with the custom metadata. It does **not** rename the Drive file or change its URL; REMOVE suppresses the computed default as well, so subsequent PROPFIND reports it absent; a small tombstone is stored with the property document. SET makes it visible again. Other custom XML properties are stored as dead properties. MOVE preserves them and COPY explicitly sends them to Drive, whose copy endpoint does not inherit `appProperties` automatically.

### Drive-backed live properties

Use the project-defined namespace `urn:google:drive` for native extensions (for example, `<G:description xmlns:G="urn:google:drive">Notes</G:description>`). These change real Drive metadata, not a parallel WebDAV-only value:

| Property | Write value / behavior |
| --- | --- |
| `DAV:getlastmodified` | HTTP-date, for example `Mon, 16 Nov 2026 08:00:00 GMT`; updates `modifiedTime` |
| `G:modifiedTime` | RFC 3339 timestamp; same Drive field as `DAV:getlastmodified` |
| `G:description` | Text description |
| `G:starred` | `true` / `false` (also `1` / `0`) |
| `G:folderColorRgb` | `#rrggbb` on folders; Drive maps it to its nearest supported palette color |

Native live properties cannot be removed while present (409): set an empty description or `starred=false` to clear those values. Removing an already absent native property is a no-op.

`DAV:creationdate` / `G:createdTime` are read-only: Drive rejects changing the creation timestamp of an existing file. Content type, size, ETag, resource type, lock capabilities and quota properties are also protected; metadata-only MIME updates do not change an existing binary file's MIME type. Use file-content operations for content, and MOVE for renaming. Unsupported native extension names are rejected, rather than silently saved as an unrelated custom value.

Property semantics follow [RFC 4918](https://www.rfc-editor.org/rfc/rfc4918.html); backend limits follow [Drive custom properties](https://developers.google.com/workspace/drive/api/guides/properties). These extensions expose selected file metadata, not every Google Drive API operation.

### Storage and failure semantics

- Dead properties are persisted on the resource in OAuth-client-private Drive `appProperties`, using reserved keys `wdp00` through `wdp29`. Keep the same OAuth application to read them. Do not edit those keys directly. Unrelated appProperties are preserved; corrupt stored WebDAV data causes an error rather than being overwritten.
- Drive permits 30 private properties per application per file, each with at most 124 UTF-8 bytes for key plus value. Each five-byte chunk key leaves 119 payload bytes: at most 3,570 bytes **including the versioned JSON/XML representation**, less if other private properties use slots. Drive's aggregate 100-property limit can further constrain storage. This is bounded metadata storage, not unlimited arbitrary XML; a capacity failure returns 507 without applying the other requested updates. No sidecar files or separate property database are created.
- All operations are parsed and validated before a single `files.update` PATCH containing the final native fields and dead-property changes. Invalid values receive 409, protected writes receive 403 with `cannot-modify-protected-property`, and the other properties in a rejected batch receive 424. Missing resources receive 404. A 207 is a container: inspect each property's status, not just the outer response.
- The one Drive PATCH is the atomic boundary. Real-API contract tests verified that invalid multi-field requests do not partially modify valid fields; this is not a cross-request transaction or lock. Concurrent read-modify-write requests can still overwrite one another. A lost response returns 502 with an uncertain-outcome explanation, without retry or rollback; read the properties before deciding whether to retry.
- Property writes invalidate this instance's metadata and parent listings before returning. This cannot synchronously invalidate other instances or guarantee global immediate freshness.
- Changing dead properties can advance Drive's modification time. When a request also explicitly sets `modifiedTime`, that timestamp is sent in the same PATCH. Folder colors and timestamp precision can be normalized by Drive; read-back uses the returned Drive representation.

## PUT uploads

- PUT with a known `Content-Length` retains the small media/multipart and large resumable upload paths. Without a length, the worker streams through resumable uploads instead of buffering the entire file.
- Unknown-length uploads hold a 10 MiB upload buffer plus the current input chunk, with one-read lookahead to identify the final chunk (including an exact 10 MiB boundary). Each chunk is acknowledged before assembling the next. Runtime/network buffering and concurrent requests still consume additional memory; this does not bypass the Worker ingress request-size limit.
- Empty uploads create an empty file or truncate an existing file. Nonempty uploads report success only after Drive confirms completion. An unexpected offset, incomplete final response, stream error, or upstream failure stops the upload; there is no automatic retry or rollback. An ambiguous failure can follow a committed write, so inspect the destination before retrying.

## TUS and rclone uploads

TUS is a separate resumable-upload protocol, not part of WebDAV. An ordinary WebDAV client sends a PUT for the whole file; a 413 response does not instruct it to retry using TUS. Streaming PUT reduces server memory use but does not remove Cloudflare’s per-request ingress limit.

The server implements TUS 1.0 core and the `creation` extension with a known `Upload-Length`. It does not advertise creation-with-upload, deferred length, concatenation, checksum or termination extensions. `OPTIONS` reports the supported version and extension; unsupported versions return 412. Creation accepts optional UTF-8 `filename` / `filetype` metadata and rclone's Unix-seconds `mtime` metadata. Zero-length uploads create or truncate the destination immediately.

Each upload has its own SQLite Durable Object. PATCH requests for that session are serialized. Small or unaligned client chunks are buffered durably and combined into Google-compatible blocks; no entire upload is buffered. A bounded write-ahead journal holds bytes until Drive confirms them, and recovery uses Drive's actual acknowledged range. The returned offset includes bytes safely held in this journal, not only bytes already in Drive. A failed or interrupted PATCH can have accepted a prefix: query HEAD and resume at its returned offset rather than blindly repeating the old offset. Offset mismatches return 409, and upstream failures never masquerade as offset zero.

Sessions, including completed-upload receipts, expire 24 hours after creation. HEAD remains usable after the final response is lost. The expiry alarm removes session state, not the destination file; incomplete uploads are not automatically rolled back. Sessions belong to the authenticated WebDAV username that created them. Different uploads to the same destination are not a distributed file lock and can still conflict. Ordinary metadata caching remains unchanged.

For rclone, configure its WebDAV remote with `vendor = infinitescale` to select its TUS upload path:

```ini
[worker]
type = webdav
url = https://YOUR-WORKER/dav/
vendor = infinitescale
user = YOUR-WEBDAV-USER
pass = YOUR-RCLONE-OBSCURED-PASSWORD
```

Use `rclone config` to enter the password, then upload with `rclone copy /path/to/file worker:`. The vendor setting selects the relevant rclone upload behavior; this service does not implement the entire ownCloud Infinite Scale API. The ordinary `other` vendor uses PUT instead. rclone's TUS chunks must each fit the deployment's request limit; splitting a large file across requests avoids that limit, rather than increasing it. In the tested rclone v1.76.0, upload-session resumption is not implemented. Its TUS filename metadata is the source basename, so use `copy` as shown rather than relying on `copyto` to rename during upload; rename separately afterward. See the [rclone TUS implementation](https://github.com/rclone/rclone/blob/v1.76.0/backend/webdav/tus.go).

### Reproducing the local client check

The opt-in test runs an installed rclone executable against a local Worker with SQLite Durable Objects and the Google Drive mock:

```bash
RCLONE_BIN=/path/to/rclone pnpm exec vitest run --config test/rclone.config.mts
```

It uses only test credentials, never `.dev.vars` or real Google/Cloudflare resources. Its front-door proxy rejects bodies above 12 MiB, while rclone uploads a file above 25 MiB in multiple TUS requests. It checks the final bytes by SHA-256, records each PATCH size, and separately checks that an oversized PUT gets 413. Verified with rclone v1.76.0: 26,214,523 bytes were sent in PATCH bodies of 10,485,760, 10,485,760 and 5,243,003 bytes, all below the 12,582,912-byte cap. This is a simulated ingress-limit test, not a deployed Cloudflare acceptance test. Default tests do not launch rclone.

## File downloads

- Ordinary file GET uses Drive's original-content endpoint (`files.get?alt=media`), including for images with a `thumbnailLink`. It does not substitute a preview or fetch the thumbnail CDN. The former image `param` query parameter no longer selects a preview size.
- Client `Range` is forwarded to Drive; successful upstream status, body and content headers are returned unchanged. This does not add thumbnail generation or Google Workspace document export.

## MOVE / COPY replacement

- `Overwrite: F` rejects an existing destination with 412. Otherwise, successful replacement returns 204; creating a new destination returns 201.
- MOVE trashes the previous destination, then renames/moves the source by ID. COPY first creates a uniquely named `.webdav-copy-<UUID>` file in the destination folder, trashes the previous destination, then publishes the staged copy under its final name. COPY to a new path uses one copy request. Collection COPY is rejected before any mutation; overlapping paths and same-ID resources are protected.
- Replacement never permanently deletes the previous destination. If the final write is definitively rejected (4xx other than 408), the worker attempts to restore that destination. A failed restore is reported, not hidden. The account must have permission to trash and restore the destination; deletion permission alone is insufficient. Ordinary WebDAV DELETE still uses permanent deletion and is unchanged by this replacement fix.
- Restoring a replaced collection can also restore descendants that were independently trashed before the replacement. This was observed after Drive propagation settled; restoration is not an exact snapshot rollback.
- A timeout, network error, 5xx, 408, or invalid success response can mean a write already happened. The worker returns an error without retrying or blindly rolling back. Inspect Drive before retrying: the previous destination may be in Trash, and COPY may leave a staged file (or an already-published copy). Error responses include recovery names/known IDs. Failed COPY stages are retained, not automatically deleted; clean them up manually once their outcome is known. Trash is subject to Google Drive's retention rules and is not a permanent backup.
- This is a recoverable, multi-request workflow, **not an atomic transaction**. Concurrent clients can still produce duplicate names or race with restoration, and there is a brief interval without the destination name. Directory transfers evict affected descendant metadata locally after the Drive writes. Other instances can retain stale entries until expiry. This does not provide cross-instance locking or eliminate in-flight cache races.

## Metadata and listing caches

- Fresh Drive metadata is cached in the current isolate for 300 seconds and directory listings for 30 seconds. Cache hits do not extend expiry; expired or absent entries are read from Drive.
- Each namespace retains at most 128 entries (plus the fixed root mapping). Expired entries are removed on lookup/write, and the oldest inserted entry is evicted at capacity. Entries whose key and serialized value exceed 64 KiB are not cached, so large listings still work without being retained.
- There is no Workers KV binding or shared metadata cache. This remains eventually consistent: local invalidation cannot clear another isolate's memory, and concurrent in-flight reads or external Drive changes can remain stale until expiry.
- TUS upload sessions still use Durable Objects. Removing metadata caching persistence does not remove upload recovery state.

## Verification and scope

The mock contract and acceptance tests cover the behaviors above within their documented limits. They do not certify shared-drive permissions, concurrent mutations, or cross-region cache consistency. See the [Drive mock contract and audit](../test/mock-drive.md) for verification details.

[Back to README](../README.md)
