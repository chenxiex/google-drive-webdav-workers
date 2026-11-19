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
- Drive permits 30 private properties per application per file, each with at most 124 UTF-8 bytes for key plus value. Each five-byte chunk key leaves 119 payload bytes: at most 3,570 bytes **including the versioned JSON/XML representation**, less if other private properties use slots. Drive's aggregate 100-property limit can further constrain storage. This is bounded metadata storage, not unlimited arbitrary XML; a capacity failure returns 507 without applying the other requested updates. No sidecar files or KV property database are created.
- All operations are parsed and validated before a single `files.update` PATCH containing the final native fields and dead-property changes. Invalid values receive 409, protected writes receive 403 with `cannot-modify-protected-property`, and the other properties in a rejected batch receive 424. Missing resources receive 404. A 207 is a container: inspect each property's status, not just the outer response.
- The one Drive PATCH is the atomic boundary. Real-API contract tests verified that invalid multi-field requests do not partially modify valid fields; this is not a cross-request transaction or lock. Concurrent read-modify-write requests can still overwrite one another. A lost response returns 502 with an uncertain-outcome explanation, without retry or rollback; read the properties before deciding whether to retry.
- Property writes invalidate metadata and parent listings, waiting for this instance's already-started KV write and eviction before returning. A KV failure is logged without changing the confirmed Drive outcome. This cannot synchronously invalidate other instances or guarantee global immediate freshness.
- Changing dead properties can advance Drive's modification time. When a request also explicitly sets `modifiedTime`, that timestamp is sent in the same PATCH. Folder colors and timestamp precision can be normalized by Drive; read-back uses the returned Drive representation.

## PUT uploads

- PUT with a known `Content-Length` retains the small media/multipart and large resumable upload paths. Without a length, the worker streams through resumable uploads instead of buffering the entire file.
- Unknown-length uploads hold a 10 MiB upload buffer plus the current input chunk, with one-read lookahead to identify the final chunk (including an exact 10 MiB boundary). Each chunk is acknowledged before assembling the next. Runtime/network buffering and concurrent requests still consume additional memory; this does not bypass the Worker ingress request-size limit.
- Empty uploads create an empty file or truncate an existing file. Nonempty uploads report success only after Drive confirms completion. An unexpected offset, incomplete final response, stream error, or upstream failure stops the upload; there is no automatic retry or rollback. An ambiguous failure can follow a committed write, so inspect the destination before retrying.

## File downloads

- Ordinary file GET uses Drive's original-content endpoint (`files.get?alt=media`), including for images with a `thumbnailLink`. It does not substitute a preview or fetch the thumbnail CDN. The former image `param` query parameter no longer selects a preview size.
- Client `Range` is forwarded to Drive; successful upstream status, body and content headers are returned unchanged. This does not add thumbnail generation or Google Workspace document export.

## MOVE / COPY replacement

- `Overwrite: F` rejects an existing destination with 412. Otherwise, successful replacement returns 204; creating a new destination returns 201.
- MOVE trashes the previous destination, then renames/moves the source by ID. COPY first creates a uniquely named `.webdav-copy-<UUID>` file in the destination folder, trashes the previous destination, then publishes the staged copy under its final name. COPY to a new path uses one copy request. Collection COPY is rejected before any mutation; overlapping paths and same-ID resources are protected.
- Replacement never permanently deletes the previous destination. If the final write is definitively rejected (4xx other than 408), the worker attempts to restore that destination. A failed restore is reported, not hidden. The account must have permission to trash and restore the destination; deletion permission alone is insufficient. Ordinary WebDAV DELETE still uses permanent deletion and is unchanged by this replacement fix.
- Restoring a replaced collection can also restore descendants that were independently trashed before the replacement. This was observed after Drive propagation settled; restoration is not an exact snapshot rollback.
- A timeout, network error, 5xx, 408, or invalid success response can mean a write already happened. The worker returns an error without retrying or blindly rolling back. Inspect Drive before retrying: the previous destination may be in Trash, and COPY may leave a staged file (or an already-published copy). Error responses include recovery names/known IDs. Failed COPY stages are retained, not automatically deleted; clean them up manually once their outcome is known. Trash is subject to Google Drive's retention rules and is not a permanent backup.
- This is a recoverable, multi-request workflow, **not an atomic transaction**. Concurrent clients can still produce duplicate names or race with restoration, and there is a brief interval without the destination name. Existing metadata caches and cross-instance KV propagation can also be stale. Directory transfers evict affected descendant metadata locally and attempt KV eviction after the Drive writes. KV failures are logged without masking the Drive result; they can leave stale entries. This does not provide cross-instance locking or eliminate in-flight cache races.

## Metadata and listing caches

- Fresh Drive metadata is cached in the writing instance for 300 seconds and directory listings for 30 seconds. With KV configured, those writes also use KV TTLs of 300 and 60 seconds respectively; KV's minimum TTL means a listing can remain available there after its local 30-second entry expires.
- Metadata and listing hits from KV are returned directly, without promotion to instance memory. A hit near KV expiry no longer starts another five-minute local lifetime. Once the local entry is absent or expired, each read consults KV again; this deliberately trades more KV reads for avoiding that lifetime extension. Fresh Drive results still populate both caches.
- This does not enforce a 30-second end-to-end listing freshness limit or immediate visibility of external Drive changes. KV propagation and edge caching remain eventually consistent. Invalidating one instance cannot synchronously clear other instances' existing memory entries.
- TUS session caching is unchanged: session writes are awaited in KV, use a one-day TTL, and KV session hits retain the existing five-minute local promotion.

## Verification and scope

The mock contract and acceptance tests cover the behaviors above within their documented limits. They do not certify shared-drive permissions, concurrent mutations, or cross-region cache consistency. See the [Drive mock contract and audit](../test/mock-drive.md) for verification details.

[Back to README](../README.md)

## Validators, modification times and quotas

File downloads use Drive v2 `files.get?alt=media`; metadata and writes remain
on v3. GET preserves the media response's strong HTTP ETag, not the v2 JSON
`etag` or a validator constructed from cached metadata. HEAD remains a cheap
metadata lookup: it advertises byte ranges but omits ETag rather than claiming
its cached metadata identifies the current bytes. PROPFIND's `getetag` remains
an ID/version synchronization marker, distinct from the GET media validator.
Directory subtree change detection remains part of the oCIS implementation plan.

Ordinary Range requests are forwarded unchanged. Drive ignores If-Range, so
the worker compares the client's If-Range with the actual partial response's
strong ETag. Only an exact strong-tag match permits the 206 stream through.
For a mismatch, weak/date validator, or missing/weak upstream validator, the
worker cancels the partial body and requests the full representation (200).
A 416 with If-Range also triggers a full download, since a stale validator must
not cause an erroneous range failure; other errors are not hidden by a retry.
If Drive already returns 200, it is passed through without a second request.

This binds resume decisions to the returned media representation without a
separate metadata check. It does not provide conditional writes, cross-instance
cache coherence, or atomic metadata/media snapshots. Clients must retain GET's
ETag for resumption; HEAD and PROPFIND do not supply that media validator.

`PROPPATCH` accepts ownCloud/rclone's `DAV:lastmodified` Unix-seconds write alias
as well as `DAV:getlastmodified` HTTP-date. Both update Drive `modifiedTime`;
the alias is not persisted as a dead property.

Quota integers are preserved without JavaScript floating-point rounding. If
Drive does not report a finite quota limit, `quota-available-bytes` is absent
(and explicitly requesting it returns `404` in the multistatus), not zero or
`NaN`. Exhausted finite quotas report zero available bytes.
