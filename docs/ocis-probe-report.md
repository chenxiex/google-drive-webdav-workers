# oCIS compatibility probe report

Probe date: 2026-11-16. Recovery date: 2026-11-17.
The first pass was source-level investigation. Follow-up added **actual official server,
official CLI and rclone/Cyberduck execution**. It is not full multi-platform certification.
The proposed [profile](ocis-compatibility.md) separates normative goals from unresolved
implementation/acceptance gates.

**Evidence provenance:** the original 2026-11-16 raw logs were lost in a snapshot
rollback. The narrative was first reconstructed honestly; on 2026-11-17 the missing
reference HTTP and OAuth flows were **executed again**. The canonical HTTP JSON now
contains new complete response-header captures and small bodies, not reconstructed
old values. Credentials/session URLs remain deliberately redacted. Old and new runs
are distinguished below; remaining client/platform/Worker acceptance gates still apply.

## Reproducible versions

- ownCloud Desktop 7.1.1, commit `9525d7331115d04ab0dd7646db3d0c084c7a1599`.
- OpenCloud Android 1.3.1, commit `958f6a8c4142f621989f616b66d3906f08ddc669`.
- ownCloud CLI 6.0.3.18040, source `7c8209b457e0fceeb56efcf771384b1eefa9de27`.
- Cyberduck CLI 9.6.0, source `7ca434ece1b7502faec04c9f9c1b2bebbf4e5d35`.
- rclone 1.76.0, vendor=infinitescale.
- Official oCIS reference server v8.2.3; development docs are not a guaranteed wire
  contract for these client versions.

Official Linux artifact: [ownCloud-7.1.1.19543-x86_64.AppImage](https://github.com/owncloud/client/releases/download/v7.1.1/ownCloud-7.1.1.19543-x86_64.AppImage).
Its published SHA256 matched:
`d4e97ded7ac09031d1f1d540dd63275c4a1fc28df2ee4798f82b8e6dcbe28548`.
Extraction and offscreen --version succeeded (Qt 6.8.3, OpenSSL 3.4.5).
The artifact has no owncloudcmd. A dummy-Xorg launch was attempted, but the environment
refused Unix-domain socket creation; QLocalServer failed and the client reported
"Already running, exiting" before login. No 7.1.1 GUI login or file-operation traffic
was captured in that attempt. No Android emulator/device or Windows runtime was
available. These are explicit platform gaps, not passed tests. The older official CLI
and reference server below provided a working route without changing the sandbox/client.

## Evidence matrix

This table describes the initial source pass; follow-up dynamic results are below.
"Source" means inspected request/response handling, not actual client acceptance.

| Area | Finding | Initial evidence |
| --- | --- | --- |
| Authentication | Desktop requires Bearer and OAuth code/PKCE; Basic-only rejected | Source |
| Discovery | status.php, OCS user/capabilities, Graph drives, enabled Spaces required | Source |
| Auth simplification | Existing password backend possible; real code/token binding needed | Design derived from source/security contract |
| TUS | creation-with-upload mandatory on Desktop; both clients cap initial POST/PATCH | Source |
| Paths | Desktop full relative path vs Android basename at parent collection | Source |
| Recovery | HEAD offsets, final ETag/ID/permissions, empty POST completion | Source |
| Download | Desktop requires ETag; validates resume Content-Range/length | Source |
| CRUD | Clients use distinct 201/204/409/412 responses | Source |
| Sync | Root/directory validators affect traversal skipping | Source; Drive strategy unresolved |
| Preview | Android DAV preview=1 with x/y/c parameters | Source |
| Optional services | Capabilities can disable many services, not proof of all UI fallbacks | Source |
| rclone earlier Worker test | 25 MiB+123 bytes, three PATCHes under simulated 12 MiB ingress; hash/mtime match; single PUT 413 | Local Worker+DO+mock runtime |
| Real ingress / Windows / Android | No end-to-end acceptance | Not tested |

## Fixed source references

Desktop: [owncloud/client 7.1.1](https://github.com/owncloud/client/tree/9525d7331115d04ab0dd7646db3d0c084c7a1599).
Relevant files:

- `src/gui/networkadapters/determineauthtypeadapter.cpp`: Bearer challenge requirement.
- `src/gui/networkadapters/discoverwebfingerserviceadapter.cpp`: issuer discovery.
- `src/gui/newaccountwizard/oauthpagecontroller.cpp`: Spaces requirement.
- `src/gui/creds/oauth.cpp`: code/PKCE, token fields, refresh, basic/post token auth.
- `src/libsync/networkjobs/checkserverjobfactory.cpp`: status.php.
- `src/libsync/networkjobs/fetchuserinfojobfactory.cpp`: OCS user fields.
- `src/libsync/capabilities.cpp`: sharing true by default, notifications presence test,
  SHA1 fallback and milliseconds poll-interval parsing.
- `src/libsync/graphapi/jobs/drives.cpp`, `graphapi/space.cpp`: Graph and Space identity.
- `src/libsync/propagateuploadtus.cpp`: creation-with-upload assertion, metadata, chunks,
  HEAD recovery, zero-byte upload, completion fallback.
- `src/libsync/propagateuploadcommon.cpp`: ordinary upload mtime/preconditions/conflicts;
  do not assume every TUS path uses every common header without testing.
- `src/libsync/discoveryphase.cpp`: requested properties/discovery.
- `src/libsync/propagatedownload.cpp`: ETag and resume validation.

Android: [opencloud-eu/android 1.3.1](https://github.com/opencloud-eu/android/tree/958f6a8c4142f621989f616b66d3906f08ddc669).
Relevant files in the corresponding app/data/library module:

- `LoginActivity.kt`, `setup.xml`, `OCServerInfoRepository.kt`: discovery/login/defaults;
  registration attempted only when advertised and needed.
- `TokenResponse.kt`, `UserInfoResponse.kt`, `SpacesResponse.kt`: required JSON fields.
- `TusUploadHelper.kt`: data-bearing creation, metadata, chunk clamp, HEAD retry.
- `CopyRemoteFileOperation.kt`, `MoveRemoteFileOperation.kt`, `RenameRemoteFileOperation.kt`,
  `CreateRemoteFolderOperation.kt`, `RemoveRemoteFileOperation.kt`: paths/status handling.
- `DavUtils.kt`: requested properties; thumbnail paths use preview=1/x/y/c.

Additional primary references: [TUS 1.0](https://tus.io/protocols/resumable-upload),
[WebDAV RFC 4918](https://www.rfc-editor.org/rfc/rfc4918),
[oCIS efficient polling design](https://doc.owncloud.com/ocis/9.0/developer/architecture/efficient-stat-polling.html).
The last is development architecture guidance, not proof the Drive adapter supplies
correct recursive directory ETags.

## Conclusions and remaining gates

A personal-Space profile can avoid the full oCIS stack and whole-file R2 assembly.
It cannot reduce to TUS alone: desktop login, capabilities, Space discovery, validators
and metadata are genuine requirements. The TUS foundation requires creation-with-upload
and client path handling beyond its earlier feature set.

The investigation covers normal operations and failure recovery, not only login/list.
Nevertheless the complete protocol cannot honestly be called empirically frozen.
Remaining gates include exact minimal bootstrap/capability fixtures, optional-feature
fallbacks, safe conditional TUS overwrite, recursive Drive change discovery, and actual
platform/interruption tests. Close these bounded gaps rather than repeat broad research.

The historical independent TUS commit `fef204e` was recorded as passing 305 tests in
14 files, both TypeScript checks, dry-run build and diff check. It was not included in
the dev documentation commits. Its old Git object was lost; the independently recovered TUS branch was pushed as
`c45b349`. The new reference probes below do not rerun its production test suite. The probes did not mutate real Drive,
deploy a Worker, or push branches.

## Follow-up: reference server and real-client execution

The official oCIS **8.2.3** Linux binary ran unmodified with isolated temporary config
and local filesystem storage; its published SHA256 was checked. TCP services worked.
The GUI issue was specifically AF_UNIX socket creation returning EPERM. No sandbox
settings were weakened. Each server/client ran in the same command environment because
separate command network namespaces could not reach one another's loopback services.
Wait for authenticated Graph and the remaining services, not only status.php: early
probes produced transient 502 responses that disappeared after startup settled.

Official ownCloud **6.0.3.18040** includes a functioning `AppRun --cmd`; 7.1.1 does not.
The 6.0.3 AppImage matched its official checksum:
`6e86833830398d33b834ff4496e5a2e9a905d5a39e475a1a8e84d23c32b0cc0d`.
This is an additional tested client, not a substitute for 7.1.1 GUI/platform acceptance.
The CLI used local Basic authentication, not the GUI OAuth flow.

Actual CLI sync against the reference server passed: directory/small-file upload;
**26,214,403-byte** upload; independent clean-directory download with matching hash;
rename/MOVE; overwrite then content comparison; delete then 404. Large upload used a
**10,000,000-byte POST**, then PATCH bodies 10,000,000 and 6,214,403. This verifies
creation-with-upload and advertised max_chunk_size consumption dynamically.

rclone **1.76.0**, vendor=infinitescale, separately passed mkdir/list, Unicode+space
filename, empty file, 26,214,403-byte TUS upload, download SHA256 match, server COPY,
MOVE, overwrite and DELETE. Its chunks were **10,485,760 / 10,485,760 / 5,242,883 bytes**.
That is not the reference capability's 10,000,000-byte size. Do not claim all clients
negotiate that capability; enforcing exactly 10,000,000 would reject this configuration.

Direct HTTP reference probes (not client certification) additionally verified:

- OCS user/capabilities, Graph and OIDC discovery JSON; unauthenticated DAV 401.
- PROPFIND 207 with mixed properties; Range 206 with ten requested bytes, out-of-range
  416, missing file 404, missing-parent MKCOL 409.
- COPY Overwrite:F conflict 412; stale If-Match PUT **409**, preserving old content.
  This differs from the proposed standards-based 412 mapping.
- TUS POST accepted 3/6 bytes; HEAD offset 3; stale PATCH offset 409; final PATCH 204
  and offset 6. Completed HEAD **404**. Completion had OC-FileID but no ETag/OC-Perm;
  the client's PROPFIND fallback matters.
- Zero-length POST created a readable empty file. filename `probe-run/path-file.txt`
  submitted at Space root resolved to that nested path.
- A 96x64 PNG preview x=32/y=32 returned a 32x32 PNG; original GET remained the 207-byte
  source, distinct from the 103-byte preview. The opaque binary preview returned 404. A fresh text-file probe below demonstrates
  that this must not be generalized to all non-image inputs.
- Descendant upload changed Graph personal-root eTag. This verifies the reference
  requirement, not a working Drive-backed generation implementation.
- Reference LOCK succeeded (200); a repeat conflicting lock returned 423. The intentionally
  lock-free profile must still test client behavior with locks disabled.

The earlier partial recovery has been superseded by a fresh run in
[ocis-reference-observations.json](ocis-reference-observations.json). These are new
values with all response-header keys, small synthetic JSON/XML bodies and binary
hashes. Request headers are the explicitly supplied headers (urllib may add defaults).
Session URLs, credentials and bearer material are redacted; stable UUID aliases preserve
correlations. This is not a claim that the lost old response values were recovered.

### Reproduction outline

Use a disposable local directory/password, never real Drive credentials:

```sh
export OCIS_CONFIG_DIR="$TMPDIR/ocis-probe/config"
export OCIS_BASE_DATA_PATH="$TMPDIR/ocis-probe/data"
export OCIS_URL=https://localhost:9200 OCIS_INSECURE=true
export PROXY_ENABLE_BASIC_AUTH=true
ocis init --insecure true --admin-password "$LOCAL_TEST_PASSWORD"
ocis server &
# Wait for authenticated Graph and OCS endpoints; read personal root.webDavUrl.
# AppRun --cmd --trust --non-interactive --user admin --password "$LOCAL_TEST_PASSWORD" \
#   --server https://localhost:9200 LOCAL_DIRECTORY SPACE_WEBDAV_URL /
# rclone: webdav remote, vendor=infinitescale, url=SPACE_WEBDAV_URL, local admin login.
# Run upload/download/hash, rename/copy/overwrite/delete, then stop the server.
```

Insecure/TLS-bypass settings are for isolated reference probing, not production.
Only temporary local data was touched. Remaining gaps include current GUI OAuth,
Android/Windows, disabled-capability fixtures, Drive changes and deployment limits.

### Third-party client: Cyberduck CLI

Official Cyberduck CLI **9.6.0** (`duck`) used its owncloud profile against the reference.
List, mkdir, upload, download with byte comparison, move and delete passed. Its copy
command used GET+PUT, not server COPY; separate rclone/HTTP probes cover server COPY.
A **110,000,000-byte** upload used creation POST and eleven successful PATCHes without
manual tuning. Full download matched SHA256
`57308f535ab67d4ca61dcd39793d541978c08472ac95cc293037614692be1b98`.
Overwrite, zero-byte and Unicode+space uploads passed separately. This is local-server
behavior, not a Cloudflare ingress test.

Captured metadata: `Upload-Metadata: filename bGFyZ2UuYmlu, filetype application/octet-stream,`.
The optional filetype is raw, not Base64, and there is a trailing comma. The profile
records a narrowly scoped tolerated hint/ignored-field policy, not acceptance of all
malformed TUS. Filename/checksum/path validation remains strict.

### Server restart recovery

TUS accepted three of six bytes, then the complete reference server stopped/restarted
with the same data. HEAD returned 200/offset 3; PATCH completed 204; GET was exactly
`abcdef`. This demonstrates reference persistence, not ambiguous Google timeout behavior
or the future Worker-to-Drive journal. Those retain deterministic mock acceptance gates.

### Authentication: real reference OAuth/OIDC flow

A separate official 8.2.3 instance completed the actual HTTP sequence used by its login
pages: discovery 200, login/consent 200, redirect with authorization code, S256-PKCE
exchange 200 with access_token, id_token, refresh_token, expires_in and token_type.
Bearer Graph access and refresh both returned 200. Code reuse returned 400 invalid_grant;
invalid Bearer returned 401. Wrong-password login returned 204 rather than the success
response; this internal login API behavior is not a recommended public OAuth error map.

A fresh code with incorrect S256 verifier returned 400 invalid_grant. Retrying that code
with the correct verifier then returned invalid_grant/code not found: the failed exchange
consumed the code. This is a tested negative case, not a complete OIDC security audit.

This was official-server real authentication driven through HTTP, not a mocked provider
or GUI-client run. It does not prove the future reduced provider, signing/redirect/nonce
or revocation policies are implemented. Tokens/code URLs are not included in artifacts.

## Controlled chunk-announcement experiment

Changed only official oCIS 8.2.3 `FRONTEND_UPLOAD_MAX_CHUNK_SIZE` between 10,000,000,
8,388,608 (8 MiB), and 12,582,912 (12 MiB). Every run used fresh server configuration/data,
fresh client HOME/session, no client chunk override and the same **26,214,403-byte**
source. Actual OCS response was checked to contain the selected value. All nine uploads
succeeded and downloads were compared byte-for-byte with the source.

| Client | Server announcement | Creation POST body | PATCH bodies |
| --- | ---: | ---: | --- |
| ownCloud CLI 6.0.3 | 10,000,000 | 10,000,000 | 10,000,000; 6,214,403 |
| ownCloud CLI 6.0.3 | 8,388,608 | 8,388,608 | 8,388,608; 8,388,608; 1,048,579 |
| ownCloud CLI 6.0.3 | 12,582,912 | 12,582,912 | 12,582,912; 1,048,579 |
| rclone 1.76.0 | each of three values | 0 | 10,485,760; 10,485,760; 5,242,883 |
| Cyberduck CLI 9.6.0 | each of three values | 0 | 10,485,760; 10,485,760; 5,242,883 |

CLI follows the announcement downward/upward, including first POST. rclone and Cyberduck
do not in these versions. Final chunks are remaining bytes, not necessarily 256 KiB
multiples. Reference oCIS accepted 10 MiB requests while advertising 8 MiB, so that
capability was not enforced as a strict ingress-body limit.

### Cause in version-pinned source and independent client settings

- [ownCloud 6.0.3 upload](https://github.com/owncloud/client/blob/7c8209b457e0fceeb56efcf771384b1eefa9de27/src/libsync/propagateuploadtus.cpp)
  uses min(remaining, advertised max_chunk_size). The pattern also exists in inspected
  7.1.1 source, but this dynamic experiment used 6.0.3.
- [rclone 1.76.0 WebDAV initialization](https://github.com/rclone/rclone/blob/v1.76.0/backend/webdav/webdav.go)
  hard-sets ChunkSize=`10 * fs.Mebi` for infinitescale. Its TUS uploader uses that value,
  not OCS max_chunk_size. Actual `--webdav-nextcloud-chunk-size 8Mi` and `12Mi` tests
  against an 8 MiB announcement still produced 10 MiB, 10 MiB, 5 MiB+3. This option
  is not a working infinitescale TUS size override in that release.
- [Cyberduck 9.6.0 source](https://github.com/iterate-ch/cyberduck/tree/7ca434ece1b7502faec04c9f9c1b2bebbf4e5d35):
  OwncloudSession selects OcisUploadFeature, inheriting TusUploadFeature. It uses
  min(local tus.chunk.size, remaining), without reading server max_chunk_size or
  rounding to 256 KiB. TerminalPreferences permits the same-named environment preference.

Cyberduck local preference was tested separately against default reference settings,
using a separate same-sized source fixture:

| Local process preference | Creation POST | PATCH bodies |
| --- | ---: | --- |
| `tus.chunk.size=8388608` | 0 | 8,388,608 × 3; 1,048,579 |
| `tus.chunk.size=12582912` | 0 | 12,582,912 × 2; 1,048,579 |
| `tus.chunk.size=262144` | 0 | 262,144 × 100; 3 |

All three uploads/client downloads passed with source-matching SHA256
`336a4326216ee23f825a2e6c9ccf2492c73c67d424df857973db0b46fc2e8bae`.
Use `env 'tus.chunk.size=8388608' duck ...`; shell `export tus.chunk.size=...` is invalid.
This is a CLI override, not server negotiation or a tested GUI-setting workflow.
Do not test zero/negative sizes: the inspected loop lacks useful validation for them.

The historical matrix above is retained as history. The canonical
[ocis-chunk-negotiation.json](ocis-chunk-negotiation.json) now contains the freshly
validated 2026-11-17 matrix and override tests described below, not a reconstruction.

### Consequence for the adapter

An 8 MiB announcement can make tested CLI full chunks aligned/smaller; it cannot compel
all clients. 12 MiB increases CLI requests while other tested clients remain at 10 MiB.
Recommendation affects request count/performance, not correctness. Do not reject
rclone/Cyberduck defaults just because they exceed a smaller recommendation. Keep a
separate hard ceiling below Worker ingress limits and actual Worker-to-Drive cross-boundary
recovery tests. No Worker implementation/deployed setting was changed by the experiment.

### Selected compatibility-layer default

The user subsequently selected **10 MiB (10,485,760 bytes)**, matching tested
rclone/Cyberduck full chunks and aligning to 40 × 256 KiB. 8/12 MiB experiments remain
historical evidence, not the selected default. This is not the hard ceiling, does not
promise all clients follow it, and does not remove tail buffering/recovery tests.
No new runtime measurement or production setting change is implied by this decision.

## Fresh verification after snapshot loss (2026-11-17)

The official oCIS 8.2.3 binary was downloaded again and matched its vendor SHA256:
`7a386c4e85ffe629d6ffdfb0a0ea4e60c87ac3620892b9534d0a3ec8b14fc68a`.
Seven fixed-version primary source files were retrieved and hashed again. Reproducible
scripts, validators, evidence boundaries and manifests are in
[the new probe bundle](probes/2026-11-17/README.md).

### Reference HTTP contract

A fresh isolated server completed **54 requests with 66 passing assertions**. The
[HTTP reproduction instructions](probes/2026-11-17/http/README.md) and
[validation results](probes/2026-11-17/http/validation.json) cover all cases retained
in the partial recovery, plus explicit mixed 200/404 property results and successful
COPY/MOVE with content checks. Failed overwrite uses two distinct existing files,
not a same-path shortcut; the target remained unchanged.

The fresh fixtures are not identical to the old fixtures, so body sizes/hashes and
ETags can differ without implying a behavior change. The tests verify exact bytes,
Range, stale-write preservation, TUS offsets and final bytes, empty-file visibility,
paths, root ETag changes, and a real server stop/restart/resume. Completed TUS HEAD
still returns 404; completion includes OC-FileID without ETag/OC-Perm; stale PUT
If-Match still yields 409 in this reference version.

**Preview correction:** a plain text file receives a generated JPEG preview (200),
while an unsupported opaque binary gets 404. Therefore "non-image preview always
returns 404" is incorrect. The PNG test confirms a 32×32 preview while the original
96×64 image still downloads byte-for-byte unchanged. The adapter must use actual Drive
preview availability, not infer it solely from an image/non-image MIME distinction.

All response headers are captured with security-sensitive values redacted. Small
synthetic XML/JSON bodies are retained; binary bodies have length/hash/dimensions.
The scripts clean up temporary server configuration, keys and data. Do not interpret
this reference contract as a Worker/Drive acceptance result or as support for every
possible file preview type.

### Reference authentication

The updated assertion-bearing [OIDC script](probes/2026-11-17/oidc/probe.py) ran two
fresh instances and finished with `complete=true`, `passed=true` in
[its results](probes/2026-11-17/oidc/results.json). Nineteen response records cover
real login/consent, code+S256 exchange, Bearer Graph access and refresh, code replay,
wrong password, wrong Bearer and wrong verifier followed by reuse of that consumed
code. Token field names and error codes are retained, never token values.

This is still an HTTP sequence against the official identity provider, not current
native GUI/Android login or a validation of our future reduced provider. Expiry,
revocation, logout and the full redirect/client-binding security matrix remain outside
this run. Partial-run files cannot claim pass: the scripts mark completion only after
their explicit assertions succeed.

### Fresh actual-client matrix and file operations

[Client evidence and reproduction](probes/2026-11-17/clients/README.md) now contain
new runs with official ownCloud CLI 6.0.3.18040, rclone 1.76.0 and Cyberduck CLI
9.6.0.46406. Their pinned artifact URLs and checksums are retained. Four server
announcements (**10,000,000; 8 MiB; 12 MiB; and the selected 10 MiB default**) × three
clients give **12 passing upload/download comparisons**, independently checked from
recorded exit logs, OCS capability values and request methods/statuses/byte lengths.
All used 26,214,403 bytes with source/download SHA256
`7be259d71245aebcf1073acdc3c2262f8910873766ce02358df010cbdf2c68a3`.

The old three-value result reproduced. At the newly tested **10 MiB** announcement:

| Client | Initial POST | Subsequent PATCH bodies |
| --- | ---: | --- |
| ownCloud CLI 6.0.3 | 10,485,760 | 10,485,760; 5,242,883 |
| rclone 1.76.0 | 0 | 10,485,760; 10,485,760; 5,242,883 |
| Cyberduck CLI 9.6.0 | 0 | 10,485,760; 10,485,760; 5,242,883 |

Five independent local-setting tests also passed again: Cyberduck 8 MiB/12 MiB/256 KiB
preferences changed its request sizes, while rclone's Nextcloud 8Mi/12Mi options still
did not change infinitescale's 10 MiB chunks. All five download hashes matched.

A separate **21-command file-operation run** covered mkdir, Unicode/space names,
empty files, copy, move, overwrite, download and delete across the clients. All client
commands returned zero, and actual ownCloud CLI/rclone downloads matched the source
hash. Cyberduck uploaded and downloaded **110,000,000 bytes**, matching SHA256
`d04c2e7d8c8e01027ddd2ba299705657a43306d395aeceeb8f008fa7abd69bf3`.
That large fixture differs from the old zero-filled fixture, so the different hash is
expected. Its creation POST was empty, followed by ten 10,485,760-byte PATCHes and a
5,142,400-byte final PATCH. Individual CRUD exit codes are not assertions of every
possible semantic/race condition; response traces remain available for inspection.
Cyberduck's copy still uses download/upload rather than server-side COPY.

A loopback HTTPS recording proxy terminated a disposable local certificate and forwarded
unchanged methods, paths and bodies to the unmodified official server on HTTP loopback.
It did not invent capabilities or rewrite protocol responses. The trace also captures
oCIS's own Go-client forwarding of data-bearing POSTs; those internal PATCHes are
explicitly excluded from the client chunk totals, not silently counted twice. This
buffering recorder is test infrastructure, not a production streaming/memory model.

The independent [validator](probes/2026-11-17/clients/validate.py) requires every matrix
capability value, exit code, hash and chunk sequence, plus all five overrides. It cannot
quietly skip missing override files. The public runner uses random temporary credentials;
the parameterized runner itself was additionally smoke-tested on the 10,000,000-byte
three-client case. Fresh traces, immutable input manifests and SHA256SUMS are included.

### Current evidence boundary

The missing reference HTTP/client/auth evidence has now been replaced by new,
reproducible, sanitized executions. This does not turn the design into an implemented
Worker adapter. Current 7.1.1 GUI, Android and Windows, minimal disabled capabilities,
Drive-backed change discovery, actual Worker-to-Drive arbitrary-boundary recovery,
complete authentication hardening and real deployed ingress still have their explicit
TODO gates. No real Drive changes or deployment were needed for this re-probe.
