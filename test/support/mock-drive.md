# Google Drive mock contract

[test/support/mock-drive.ts](mock-drive.ts) implements `MockDrive`, a bounded in-memory test double verified against live Google OAuth and Drive APIs, exercised by the WebDAV and TUS test suites in `workerd`. Default tests never load `.dev.vars`, contact Google, or mutate live Drive files.

## Verification commands

```sh
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm exec tsc --noEmit -p test/tsconfig.json
pnpm test --run
pnpm run build
```

## Modeled endpoints and verified API behavior

| Endpoint | Modeled behavior & verified quirks |
| --- | --- |
| `POST /oauth2/v4/token` | Form-encoded `refresh_token` grant; checks `client_id`, `client_secret`, and `refresh_token` errors (`invalid_request`, `invalid_client`, `invalid_grant`, `unsupported_grant_type`). |
| `GET /drive/v3/about` | Requires `fields`; projects `storageQuota` subfields with quota integers serialized as JSON decimal strings. |
| `GET /drive/v3/files` | Supports `fields` projection, `q` conjunctions (`'id' in parents`, `name`/`mimeType` `=`/`!=`, `trashed`), escaped `'` and `\`, `orderBy` (`folder`, `name`, `name_natural`, `modifiedTime`), `pageSize` (1–1000), and `pageToken` validation. |
| `POST /drive/v3/files` | Persistent UUID identity, parent validation (`404`/`403`), `Untitled` default name, zero-byte file size with `md5Checksum` only (omitting `sha1Checksum`/`sha256Checksum`) vs omitted folder size/checksums, `description`, `starred`, `modifiedTime`, `appProperties`, and quantized `folderColorRgb` on folders (`403 colorNotSupportedForItem` on non-folders). |
| `PATCH /drive/v3/files/{id}` | Rename, `addParents`/`removeParents` (adding a single new parent moves the item even without `removeParents`), direct `parents` replacement (`403 fieldNotWritable`), empty `name` and metadata-only binary MIME updates ignored, monotonic `version` increment, existing content digests preserved. |
| `POST /drive/v3/files/{id}/copy` | Folder copy returns `403 cannotCopyFile`; copies content, `size`, `description`, and `starred`, but **does not inherit `appProperties`** unless explicitly supplied in the request body. |
| `POST /batch/drive/v3` | `multipart/mixed` request/response wrapper (up to 100 parts, 0 or >100 parts or invalid boundary returns outer `400` JSON array); outer `200` even when outer `Authorization` is missing/invalid (returning inner `403`/`401` per part); mirrors `Content-ID` (`<id>` -> `<response-id>`, `id` -> `response-id`), inherits outer `Authorization` when omitted inside a part, validates UTF-8 `Content-Length`, and rejects media/upload operations in batch. |
| `DELETE /drive/v3/files/{id}` | Returns empty `204`, `404` when missing, and recursively deletes descendants when deleting a folder. |
| Multipart & media uploads | `POST ?uploadType=multipart` parses quoted/unquoted boundaries, UTF-8 metadata, and exact binary bytes; `PATCH ?uploadType=media` overwrites/truncates while preserving the existing binary MIME type; both populate `md5Checksum`, `sha1Checksum`, and `sha256Checksum`. |
| Resumable uploads (`uploadType=resumable`) | Empty `200` `Location` session init; status `PUT` (`bytes */total`) and non-final chunks return `308` with `Range`; omitted `X-Upload-Content-Length` (`*`) supported until final chunk; non-final chunks require >= 256 KiB and acknowledge only whole 256 KiB multiples (discarding unaligned tails); replay/overlapping chunks preserve already-accepted prefix bytes; `bytes */0` finalizes empty files; explicit `modifiedTime` is preserved; completed status queries and final-chunk replays return `200` with `md5Checksum`, `sha1Checksum`, and `sha256Checksum`; conflicting totals or small non-final chunks fail with `400` and poison the session. |
| Media download (`GET /drive/v{2,3}/files/{id}?alt=media`) | Returns exact fixture bytes and MIME; supports in-bounds closed `Range` (`206`); v2 returns a deterministic SHA-256-derived strong `ETag` and `416` when start >= length; deliberately ignores `If-Range` (matching live v2 behavior). |

### Non-obvious Drive contracts modeled in `MockDrive`

- **Non-atomic invalid `fields` behavior**: an invalid `fields` mask on metadata `create`, `update`, and `copy` returns `400` **after** applying the mutation, whereas on `uploadType=media` / `multipart` / `resumable` init it returns `400` before mutating.
- **Decimal string sizes & quotas**: `size` and `storageQuota` integers are serialized as JSON decimal strings (fixture setup still accepts numeric `size`).
- **Settled Trash & restore side effects**: models `explicitlyTrashed` alongside effective `trashed` across nested folders. Real Drive propagates descendant trash flags asynchronously; `MockDrive` models settled state, where restoring a trashed folder (`trashed: false`) **also clears `explicitlyTrashed` on descendants that were independently trashed before the folder was trashed**. Trash/restore preserves `modifiedTime`; rename/move updates it.
- **`appProperties` & native property rules**:
  - `appProperties` merge by key (`null` removes, `""` keeps an empty value), limited to 124 UTF-8 bytes per `key + value` (`403 propertyLengthLimitExceeded`) and 30 private keys (`403 propertyCountLimitExceeded`).
  - Non-empty `appProperties` and `description` changes bump `modifiedTime` (unless `modifiedTime` is supplied in the same PATCH); `starred` and `folderColorRgb` updates do not; `description: null` is ignored while `""` clears it.
  - `createdTime` updates return `403 fieldNotWritable`; invalid timestamps return `400`. Rejected mixed updates leave all supplied fields unchanged.
  - Folder color quantization models the measured palette mappings (`#ff0000` -> `#f83a22`, `#f83a22`, `#8f8f8f`, `nope` -> `#8f8f8f`, default `#8f8f8f`); binary file color writes return `403 colorNotSupportedForItem`.
  - Root (`root`) metadata can be read via `files.get` without appearing in `files.list`.

## Deliberate limits

`MockDrive` fails loudly (`MockDrive does not implement ...`) for unverified or unimplemented features instead of faking success, including:
- Media downloads of folders/Workspace documents, missing fixture bytes/mismatched size, and open/suffix/multipart/out-of-bounds ranges (other than v2 `start >= length` `416`)
- Unverified `folderColorRgb` values, `createdTime` on `create`, writes to `root`, Workspace conversions, nested non-`files` `fields` selectors, and unmodeled `q` operators or `orderBy` keys
- Moving items from/into Trash, changing trash state under a trashed ancestor, and folder cycles
- `changes.list` / `getStartPageToken` (not yet implemented; must be audited and modeled before `OC-05`)
- Media/upload operations inside `POST /batch/drive/v3` (rejected by Google Drive)
- `headRevisionId` and `revisions.get?alt=media` (including immutable post-overwrite `Range` reads) were live-verified on 2026-11-24 and remain to be modeled in `MockDrive` when migrating away from v2 downloads and implementing `OC-06` (`md5Checksum`, `sha1Checksum`, and `sha256Checksum`, including the metadata-only empty-file exception, are modeled).
- Shared-drive permissions, cross-app 100-property aggregate quotas, real OAuth token expiry/revocation, network/rate-limit retries, and asynchronous trash propagation delays (covered via fault injection in tests).

## Official Google Drive references

- [File resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
- [Files list](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)
- [Files update](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update)
- [About and quota](https://developers.google.com/workspace/drive/api/reference/rest/v3/about)
- [Partial responses](https://developers.google.com/workspace/drive/api/guides/fields-parameter)
- [Upload protocols](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Copy limitations](https://developers.google.com/workspace/drive/api/guides/create-file#copy-files)
- [Drive errors](https://developers.google.com/workspace/drive/api/guides/handle-errors)
- [Trash and restore semantics](https://developers.google.com/workspace/drive/api/guides/delete)
