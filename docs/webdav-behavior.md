# WebDAV behavior

## Locking

- WebDAV locking is not supported. OPTIONS advertises `DAV: 1`, not Class 2, and does not list LOCK/UNLOCK in Allow. PROPFIND returns an empty `supportedlock` property for files and collections.
- Authenticated LOCK (including refresh) and UNLOCK requests return **501 Not Implemented**, without issuing a lock token, creating a resource, or calling Drive. Locking is unavailable throughout the service, rather than merely disallowed on a particular resource.
- Clients must work without locks; clients that require them may refuse writes or editing. There is no lock-based protection against concurrent overwrites. This is not a claim of complete WebDAV conformance or client-by-client compatibility.

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
