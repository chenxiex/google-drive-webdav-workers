# WebDAV behavior

## MOVE / COPY replacement

- `Overwrite: F` rejects an existing destination with 412. Otherwise, successful replacement returns 204; creating a new destination returns 201.
- MOVE trashes the previous destination, then renames/moves the source by ID. COPY first creates a uniquely named `.webdav-copy-<UUID>` file in the destination folder, trashes the previous destination, then publishes the staged copy under its final name. COPY to a new path uses one copy request. Collection COPY is rejected before any mutation; overlapping paths and same-ID resources are protected.
- Replacement never permanently deletes the previous destination. If the final write is definitively rejected (4xx other than 408), the worker attempts to restore that destination. A failed restore is reported, not hidden. The account must have permission to trash and restore the destination; deletion permission alone is insufficient. Ordinary WebDAV DELETE still uses permanent deletion and is unchanged by this replacement fix.
- Restoring a replaced collection can also restore descendants that were independently trashed before the replacement. This was observed after Drive propagation settled; restoration is not an exact snapshot rollback.
- A timeout, network error, 5xx, 408, or invalid success response can mean a write already happened. The worker returns an error without retrying or blindly rolling back. Inspect Drive before retrying: the previous destination may be in Trash, and COPY may leave a staged file (or an already-published copy). Error responses include recovery names/known IDs. Failed COPY stages are retained, not automatically deleted; clean them up manually once their outcome is known. Trash is subject to Google Drive's retention rules and is not a permanent backup.
- This is a recoverable, multi-request workflow, **not an atomic transaction**. Concurrent clients can still produce duplicate names or race with restoration, and there is a brief interval without the destination name. Existing metadata caches and cross-instance KV propagation can also be stale. Directory transfers evict affected descendant metadata locally and attempt KV eviction after the Drive writes. KV failures are logged without masking the Drive result; they can leave stale entries. This does not provide cross-instance locking or eliminate in-flight cache races.

## Verification and scope

The mock contract and acceptance tests cover the behaviors above within their documented limits. They do not certify shared-drive permissions, concurrent mutations, or cross-region cache consistency. See the [Drive mock contract and audit](../test/mock-drive.md) for verification details.

[Back to README](../README.md)
