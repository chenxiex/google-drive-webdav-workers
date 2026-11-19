# Google Drive mock contract

`helpers.ts` implements the existing worker-facing mock endpoints. `mock-drive.test.ts` checks their upstream contracts in fast, isolated Node tests; `dav.test.ts` checks the WebDAV integration in workerd. Normal tests never load `.dev.vars`, contact Google, or mutate remote files.

## Live audit: 2026-11-13

The audit made 115 HTTP requests to the real Google OAuth/Drive API using the configured account and the environment's existing authenticated-network route. It started read-only, then used two uniquely named fixture folders. Only newly created test data was changed. After separate approval for each folder's permanent deletion, all 12 created resources were removed and individually verified to return 404. No credentials or upload-session URLs were committed, and no existing Drive files were overwritten or deleted.

The requests include setup, independent readbacks, and cleanup; **115 is not a count of distinct test cases**. This was one My Drive account, not an exhaustive certification of every Google Drive behavior or account type.

| Existing mock interface | Live observations incorporated |
| --- | --- |
| POST `/oauth2/v4/token` | Form-encoded refresh grant, successful bearer response, missing client/secret/refresh parameters, invalid refresh token and unsupported grant errors. Expiry values vary; the mock uses deterministic synthetic credentials. |
| GET `/drive/v3/about` | `fields` is required; quota integers are JSON decimal strings; projection of quota subfields. |
| GET `/drive/v3/files` | Default/explicit field selection, no-query listing, reordered and uppercase conjunctions, escaped apostrophe/backslash names, `trashed` filtering, inequality, sorting, page size, continuation and malformed-query/token errors. Page sizes 0 and 1001 returned 400 on the audited account. |
| POST `/drive/v3/files` | Default file fields, persistent identity, parent selection, unnamed `Untitled`, binary zero-byte size, folders without size, invalid/nonfolder/multiple parents. |
| PATCH `/drive/v3/files/{id}` | Missing target 404; rename; add/remove parents; adding a different parent moves rather than adds a second parent; direct `parents` replacement 403; empty names and metadata-only binary MIME changes are ignored. |
| POST `/drive/v3/files/{id}/copy` | Missing source 404; folder copy 403; copies retain bytes/size, have new identity and independent parent arrays. |
| DELETE `/drive/v3/files/{id}` | Empty 204; repeat/missing delete 404; deleting a folder removes descendants. |
| POST multipart upload | Declared and quoted MIME boundary, UTF-8 metadata, nested destination, byte-exact binary payload, response ID matches persisted ID, size is decimal-string in API output. |
| PATCH media upload | Overwrite and zero-byte truncation update bytes/size without replacing identity; original binary MIME type is preserved. |
| POST/PATCH resumable initialization and PUT session | Unique Location with empty 200 body; no early commit; status PUT and nonfinal chunks return empty 308 with Range; final 200 returns File and commits bytes; successful create and overwrite; completed status returns 200. Small nonfinal chunks and conflicting totals return 400 and leave the session failed. |

Independent real GET metadata and media/range requests verified mutation effects. They were **not added as mock interfaces in that audit**, because they were not provided by the original mock. The later media-download extension below adds a bounded subset.

### Non-obvious Google behavior

An invalid `fields` parameter does **not** guarantee an atomic failure. In the live audit, metadata create, update, and copy returned 400 but still performed their mutation. A media upload with the same invalid mask returned 400 without changing content. The mock and regression tests preserve that distinction instead of imposing an assumed transactional contract.

Real `size` and quota values are decimal strings. Fixture setup still accepts numeric sizes for existing tests, but API responses serialize them correctly. Binary content is stored separately from metadata and multipart parsing searches bytes directly, avoiding a large per-byte string allocation at the 5 MiB boundary.

## MOVE/COPY contract extension: 2026-11-15

The overwrite fix required contracts that the original audit did **not** establish: binary-file trash/restore, nonempty folder-tree trash/restore, explicit versus inherited trash, copy staging with a caller-selected name and destination parent, and folder moves preserving descendants. These were checked directly against the configured My Drive account using seven new disposable resources in one isolated folder (136 HTTP requests including setup, polling, readbacks and cleanup, not 136 test cases). No existing user files were changed, and no permanent deletion was performed. The test folder and all six descendants were explicitly moved to Trash at cleanup; they remain recoverable there.

The mock now models **settled** folder-tree trash state, with separate `explicitlyTrashed` and effective `trashed` fields. Google propagates descendant changes asynchronously: immediate metadata/list responses can still show the old state. A deterministic mock is not a real-time consistency guarantee. WebDAV tests additionally inject the observed stale-descendant state and check that old paths stay inaccessible after overwrite/cache eviction.

**Important restore side effect:** after settling, restoring an ancestor also restored a child that had already been explicitly trashed before the ancestor was trashed. Immediate reads temporarily suggested the opposite. The mock clears descendant explicit-trash state on folder restore, and recovery tests assert this observed behavior. Consequently, rolling back a collection overwrite can also restore previously trashed children; it is not an exact snapshot rollback.

The extension verifies repeated trash/restore PATCH requests with `fields=id`, preserved identity/parents/bytes, copy bytes and independent identity in the requested parent, publication by rename, and ordinary cross-parent folder moves preserving descendants. Rename/move updates modification time; trash/restore preserves it. Normal tests remain offline.

Overwrite acceptance covers file and collection targets, folder MOVE, successful replacement, rejected publication and restoration, ambiguous committed writes, no permanent cleanup, and descendant-cache invalidation. Network failures, malformed responses, rate limits and permission failures are **fault injection**, not claims that Google necessarily emits these responses or that every 4xx response is mutation-free. The existing invalid-fields contract still demonstrates a committed write can return 400; production transfer uses a fixed valid `fields=id` mask.

This is acceptance of the current MOVE/COPY implementation against these bounded contracts, not exhaustive Drive or distributed-consistency certification. No extra live WebDAV acceptance pass was needed or run. Shared-drive permissions, concurrent changes, trash propagation latency and cross-region KV visibility remain outside this mock's guarantees.

## Media-download contract extension: 2026-11-16

Ordinary image GET now uses the original-content endpoint rather than a thumbnail CDN. The mock previously had no media GET endpoint. A read-only recheck of an existing retained four-byte binary audit fixture made one OAuth request and three media GET requests, with no Drive writes: full download returned 200 and byte-identical content; `bytes=0-2` and `bytes=1-3` returned 206 with exact bytes and matching Content-Type, Content-Length and Content-Range. Earlier audit evidence also includes a five-byte range readback after a larger upload.

MockDrive now models full binary media GET and in-bounds closed byte ranges using those observations. It requires explicit fixture bytes and matching size. Open-ended, suffix, multipart, invalid and out-of-bounds ranges, and native-document/folder downloads remain deliberately unsupported rather than guessed. The worker forwards Range unchanged, so these mock limits are not restrictions introduced into production downloads. Thumbnail links are optional fixture metadata; no CDN response or thumbnail-generation contract is modeled.

WebDAV regressions verify original image bytes/MIME/length even when thumbnail metadata is present, HEAD/GET length agreement, removal of the old preview `param` behavior, no CDN fetch, and forwarding of Range with the original partial response. These fixtures are synthetic; this is not a claim that a live thumbnail necessarily changes image bytes, nor a live JPEG/PNG end-to-end acceptance pass. Default tests stay entirely offline. After this extension, all 197 tests pass; both TypeScript checks and the Wrangler dry-run build pass. The three new WebDAV download regressions fail against the pre-fix worker and pass with the fix.

## Property metadata contract extension: 2026-11-16

Four isolated live audit runs created five binary/folder fixtures plus two copies (all moved to Trash afterward; no permanent deletion). A separate root metadata GET was read-only. These observations extend the mock for PROPPATCH/PROPFIND:

- `files.get`, `files.list` and field masks expose `createdTime`, `modifiedTime`, `description`, `starred`, `folderColorRgb` and `appProperties`. Absent/empty app properties are omitted from the response. Mock root identifiers and dates remain synthetic.
- One `files.update` can set `modifiedTime`, `description`, `starred` and `appProperties`. `createdTime` on an existing file returns 403 `fieldNotWritable`. Invalid timestamp strings return 400. Explicit modification timestamps are normalized to RFC 3339 milliseconds and override the automatic timestamp bump.
- Private properties merge by key: omitted keys survive, `null` removes a key, and `""` is a present empty value. Nonempty app-property patches advance modification time, including setting a key to its current value; `{}` does not. Description changes advance modification time; `description: null` is ignored and an empty string clears it. Star and folder-color changes do not advance modification time.
- A key plus value of 124 UTF-8 bytes succeeds; 125 bytes returns 403 `propertyLengthLimitExceeded`. Both ASCII and multibyte boundaries were tested. Thirty private properties succeed; adding a thirty-first returns 403 `propertyCountLimitExceeded`. The mock covers one application's private-property quota; the real API additionally limits total public/private properties across applications. It does not emulate other applications' hidden properties.
- Mixed updates rejected for an invalid timestamp, a non-writable creation timestamp or excessive property length left the other supplied fields unchanged. Count rejection preserved the existing property set. This supports using a single PATCH rather than a chain of property writes; it is not evidence of cross-request/distributed transactions or certainty after a lost response.
- `files.copy` inherits description and starred state, **not appProperties**. Passing appProperties explicitly in the copy request preserves them. This matters for WebDAV dead properties.
- Folder colors are quantized by Drive: `#ff0000` became `#f83a22`; palette colors `#f83a22` and `#8f8f8f` stayed unchanged. A fresh folder uses `#8f8f8f`. An invalid string `nope` also became gray with HTTP 200; `""`/`null` retained the current color. Binary-file color writes return 403 `colorNotSupportedForItem`. The mock recognizes only these measured colors and fails loudly for unverified color quantization.

Unverified property contracts intentionally remain unsupported: writes to My Drive root, native-document specifics, creation-time/mtime/color overrides during file creation, arbitrary folder-color quantization, nested app-property field masks, and other clients' property quotas. No live end-to-end WebDAV acceptance is implied; default tests remain offline.

## Unknown-length upload contract extension: 2026-11-16

An isolated live audit initiated resumable create and update sessions without `X-Upload-Content-Length`. A 256 KiB chunk with `Content-Range: bytes 0-262143/*` returned 308 and `Range: bytes=0-262143`; the last chunk supplied the final total and returned 200. Downloaded bytes matched for a short tail, an aligned last chunk, a single aligned chunk and replacement of an existing file. Focused mock contracts cover unknown-total creation, replacement and aligned endings without multiplying every combination.

The same audit verified zero-byte create and replacement with `Content-Range: bytes */0`, but this form is not added to the mock: the worker keeps its existing empty-file paths. Empty finalization after previously uploaded unknown-total chunks was not tested. All fixtures were created in a unique audit folder, then moved to Trash with that folder; nothing was permanently deleted. Default tests remain offline.

The [official upload guide](https://developers.google.com/workspace/drive/api/guides/manage-uploads) makes the initial upload length optional, requires non-final chunks to be multiples of 256 KiB, and instructs callers to inspect the response Range rather than assume all sent bytes were accepted. The mock contracts above cover successful complete chunk acknowledgments, not partial acceptance, retries, interruptions or session expiry.

## Verification

From a fresh checkout, install Node.js 24 and pnpm 11, then run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm exec tsc --noEmit -p test/tsconfig.json
pnpm test --run
pnpm run build
```

The original audit had 44 focused mock contract tests and 34 existing/auth/WebDAV cases (78 total). The final extended suite has 172 passing tests: 50 mock contracts and 122 WebDAV/auth/configuration cases, including the overwrite contracts and recovery cases above. Both TypeScript checks and the Wrangler dry-run build pass. The WebDAV upload cases now verify persisted content at the 5 MiB multipart boundary and across two resumable chunks (11 MiB), rather than checking only HTTP success. Build is Wrangler's dry run, not a deployment.

## Deliberate limits

This is a **bounded test double**, not a full Google API emulator. It supports the worker's ordinary binary-file and folder operations and the query/field expressions described above. It fails loudly for unimplemented routes, verbs, query operators, metadata fields, Workspace conversion, media writes to folders/native documents, moves from/into Trash, changes to trash state beneath a trashed ancestor, folder cycles, overlapping/replayed chunks, and selected unverified upload forms. Extend the verified contract before using those features in tests.

Other unmodeled dimensions include shared-drive permissions and ownership, concurrent mutations during pagination, real account quota enforcement/unlimited plans, OAuth revocation/expiry/consent, retries/rate limiting, session expiry, Workspace document conversion/export, complex query grammar, and Google's optional metadata fields. The synthetic account, root/file IDs, timestamps, quota and token values are fixture data, not literal live values. Tests must not assert that unsupported or unprobed API combinations conform.

Official references:

- [File resource and JSON types](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
- [Files list](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)
- [Files update](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update)
- [About and quota](https://developers.google.com/workspace/drive/api/reference/rest/v3/about)
- [Partial responses](https://developers.google.com/workspace/drive/api/guides/fields-parameter)
- [Upload protocols](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Copy limitations](https://developers.google.com/workspace/drive/api/guides/create-file#copy-files)
- [Drive errors](https://developers.google.com/workspace/drive/api/guides/handle-errors)

- [Trash and restore semantics and asynchronous propagation](https://developers.google.com/workspace/drive/api/guides/delete)

## Version field audit (2026-11-18)

An isolated real Drive binary file was overwritten with different four-byte contents, then updated with the same explicit `modifiedTime` after each write. `version` advanced from `6` to `10`; a subsequent `appProperties` update preserving that timestamp advanced it to `11`. `files.get` and `files.list` returned the same decimal-string version. The test file was moved to Trash afterwards. The mock now exposes `version` and advances it on updates; the exact increment is deliberately not modeled. This supports validators that change even when clients preserve timestamps and sizes. No account identifiers or credentials are retained here.

## v2 media validator audit (2026-11-19)

The v2 media subset was added after isolated real Drive probes confirmed:
full and partial downloads of the same representation return the same strong
HTTP ETag; changing bytes while preserving file ID, size and modification time
changes that ETag; a stale If-Range sent upstream is ignored and the new partial
representation is still returned. Metadata and writes remain the v3 contract.
The mock uses a SHA-256-derived opaque tag for v2 media only, not Google's
undocumented tag algorithm, v2 JSON etag, or v3 version. It deliberately ignores
If-Range. Out-of-bounds range starts return 416; arbitrary malformed/multipart
ranges and native Google Workspace export behavior remain outside this subset.

Acceptance covers matching/stale/weak/date validators, missing/weak upstream
tags, 416 fallback, unchanged-metadata content replacement, and preservation of
other upstream failures. Missing/weak-tag cases are boundary fault injection,
not claims that the live Drive probe returned those values.
