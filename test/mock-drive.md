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

Independent real GET metadata and media/range requests verified mutation effects. They were **not added as mock interfaces**, because they were not provided by the original mock.

### Non-obvious Google behavior

An invalid `fields` parameter does **not** guarantee an atomic failure. In the live audit, metadata create, update, and copy returned 400 but still performed their mutation. A media upload with the same invalid mask returned 400 without changing content. The mock and regression tests preserve that distinction instead of imposing an assumed transactional contract.

Real `size` and quota values are decimal strings. Fixture setup still accepts numeric sizes for existing tests, but API responses serialize them correctly. Binary content is stored separately from metadata and multipart parsing searches bytes directly, avoiding a large per-byte string allocation at the 5 MiB boundary.

## Verification

From a fresh checkout, install Node.js 24 and pnpm 11, then run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm exec tsc --noEmit -p test/tsconfig.json
pnpm test --run
pnpm run build
```

The audit's final suite has 44 focused mock contract tests and 34 existing/auth/WebDAV cases (78 total). The WebDAV upload cases now verify persisted content at the 5 MiB multipart boundary and across two resumable chunks (11 MiB), rather than checking only HTTP success. Build is Wrangler's dry run, not a deployment.

## Deliberate limits

This is a **bounded test double**, not a full Google API emulator. It supports the worker's ordinary binary-file and folder operations and the query/field expressions described above. It fails loudly for unimplemented routes, verbs, query operators, metadata fields, Workspace conversion, media writes to folders/native documents, folder-tree trash/restore, folder cycles, overlapping/replayed chunks, and selected unverified upload forms. Extend the verified contract before using those features in tests.

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
