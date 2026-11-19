# 2026-11-18 independent review resolution

Baseline: `dev` `73398c2`; independent TUS foundation `c45b349` is not merged.
This review distinguishes existing implementation defects from missing design detail,
unimplemented release gates, and intentional differences from the reference server.

| Review item | Disposition | Resolution |
| --- | --- | --- |
| 1: OCS v1, XML, envelope status | Confirmed design omission | Contract now includes both versions, representation selection and distinct success envelope codes. |
| 2: bootstrap OPTIONS and encoded Space ID | Confirmed design omission | Add OPTIONS, HEAD fallback and segment-level single decoding. HEAD 404 is not itself a failure. |
| 3: DAV property aliases / Prefer / incomplete capture | Confirmed omission and evidence limitation | Specify observed property surface and minimal responses; future runner preserves safe query and XML. Old records are unchanged, not retroactively completed. |
| 4: new generation with stale listing | Valid future failure scenario, not implemented dev bug | Bind cache snapshots and in-flight results to generation; audit changes mock before implementing OC-05. Account-wide invalidation may remain a measured conservative tradeoff. |
| 5: checksum after overwrite commit | Valid OC-06 constraint | Validate whole-file checksum before final upstream commit with recoverable digest state. Final Drive digest cannot preserve unchanged old content on mismatch. This is not an already implemented checksum feature. |
| 6: ETag / HEAD / quota | Existing defects | Runtime corrections and regression checks are recorded below. Same mtime is not a safe content validator. |
| 6: recursive parents / route overlap / PATCH alias | Legacy behavior and migration boundaries | Preserve legacy behavior; opt-in compatibility routing has strict parents and no PATCH-to-COPY. Reject mount collisions instead of silently hiding data. |
| 7: signing keys / public client IDs | Design detail omission | Require stable keys, tested fixed client fixtures and refresh policy. Existing callback/security requirements were not wholly missing. |
| 7: shared ROOT_ID | Intentional model | Distinct auth/upload ownership does not imply distinct private file roots. Do not silently invent user data isolation. |
| 8: data-bearing POST, metadata and completion headers | Already planned OC-06 work | Refine checkpoints without claiming generic TUS is already oCIS. |
| 8: POST Upload-Offset:0 rejected | Incorrect | Foundation does not reject this header; data-bearing POST is the unsupported feature. |
| 8: completed HEAD200 / old-offset PATCH409 | Intentional / required behavior | Keep completion receipt; TUS offset mismatch requires 409. Client recovery acceptance remains pending. |
| 8: exact DO write count | Overstated precision | Measure actual journal/tail/recovery costs, not a fixed estimate. |
| todo status and repeated gates | Confirmed documentation drift | State pushed/unmerged foundation explicitly; scope historical records and consolidate stage acceptance. |

## Intentional choices retained for owner review

- Generic DAV cache TTLs and lack of cross-region strong consistency remain accepted.
  A future synchronization validator must nevertheless not assert that stale data is new.
- Keep completed TUS receipts instead of copying reference HEAD404 behavior.
- Legacy recursive parent creation remains; oCIS strict-parent semantics apply only to
  its opt-in compatibility paths. Enabling the profile must explicitly resolve a legacy
  `/dav/` mount collision, rather than hiding its real `spaces` directory.
- Multiple USERS currently share one Google root; authentication/session isolation is
  not private per-user storage. No hidden access-model change is made.
- Ordinary DELETE remains permanent; native Google Docs/shortcut representation and
  folder COPY remain explicit product/release decisions, not silently enabled features.
- No full oCIS implementation, TUS branch merge or deployment is part of these fixes.

## Corrections beyond the review's wording

Google Drive changes page/start tokens do not expire according to the official
[changes.list contract](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list).
Missing/invalid state and interrupted pagination still need recovery tests. Metadata
checksum is not the TUS per-request checksum extension. A committed Drive overwrite
has changed old content, but calling it necessarily irrecoverable ignores revisions.
[TUS HEAD/PATCH rules](https://tus.io/protocols/resumable-upload) allow retained completed
sessions and require offset-conflict rejection.

## Implemented runtime fixes and remaining boundary

- File validators now use Drive `version` (same timestamp/length content changes and
  dead-property mutations no longer collapse to the same validator). HEAD/GET and
  PROPFIND use the same construction; HEAD no longer mislabels Last-Modified as Date.
- rclone's writable `DAV:lastmodified` Unix-second alias updates native mtime instead
  of silently becoming an unrelated dead property.
- Unlimited quota no longer produces NaN; int64 quota arithmetic retains exact decimal
  values rather than rounding via Number, and unavailable limits are omitted.
- If-Range requests conservatively receive full content (200), not an unchecked Range
  against a potentially stale validator. Ordinary Range still works. This is an explicit
  bandwidth/recovery tradeoff, not a claim of efficient conditional resume or atomic
  revision-bound download; that remains an OC-07 acceptance concern. No extra Drive
  check-then-act loop or general cross-instance consistency mechanism was added.

The new Drive `version` mock behavior was first checked using one isolated real file:
versions advanced across same-mtime/same-size content replacement and appProperties
updates, and get/list agreed. Cleanup used Trash, not permanent deletion. See
[test/mock-drive.md](../test/mock-drive.md). Default tests remain offline/mock-only.

A fresh original rclone 1.76.0 request-construction probe against a synthetic localhost
recorder captured the 337-byte PROPPATCH body: DAV:lastmodified Unix seconds plus
oc:checksums/SHA1. This resolves the property-name uncertainty, but is not a recovery
of the old trace or a live oCIS/Worker semantic test. See
[construction evidence](probes/2026-11-17/clients/rclone-proppatch-construction.json).

## Verification

- Final mock-only application suite: 299 tests passed across 13 project/file runs.
- Capture sanitization: 3 offline tests passed.
- Source and test TypeScript checks, Wrangler build dry-run and `git diff --check`
  passed; tracked dist rebuilt. No deployment, commit or push performed.
- Narrow real-Drive audit is recorded separately in
  [drive-version.json](probes/2026-11-18/drive-version.json); it is not part of default tests.
- No GUI 7.1 / Android / Windows or deployed Worker acceptance is claimed. The
  unmerged TUS branch was not merged or re-tested as part of this dev patch.

## Subsequent download refinement (2026-11-19)

The review correction above is preserved as commit `eb1c95d`. The follow-up on
`fix/drive-download-etag` replaces derived GET validators and unconditional If-Range
full responses with Drive v2 media ETags and response-side comparison. HEAD omits
ETag; PROPFIND retains a version-based synchronization marker, not a media validator.
See [current WebDAV behavior](webdav-behavior.md) for the implemented contract.
The review-time description above is historical, not a claim these validators still match.
KV removal remains independent on the Durable Object TUS branch; neither branch is
merged into `dev` by this work.
