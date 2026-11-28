# oCIS compatibility probe report

Probe runs: 2026-11-16 and 2026-11-17 against an unmodified local **oCIS 8.2.3** server, pinned client releases, and upstream client source. This report documents observed protocol behavior and remaining gaps; the Worker oCIS compatibility layer itself is not yet implemented.

## Target versions and source references

- **ownCloud Desktop 7.1.1**, commit `9525d7331115d04ab0dd7646db3d0c084c7a1599` ([source](https://github.com/owncloud/client/tree/9525d7331115d04ab0dd7646db3d0c084c7a1599))
  - Linux `ownCloud-7.1.1.19543-x86_64.AppImage` (SHA-256 `d4e97ded7ac09031d1f1d540dd63275c4a1fc28df2ee4798f82b8e6dcbe28548`) extracted cleanly (`Qt 6.8.3`, `OpenSSL 3.4.5`), but has no `owncloudcmd`. Launching GUI under dummy Xorg failed because the sandbox blocks `AF_UNIX` socket creation (`QLocalServer` reported `EPERM` / `"Already running, exiting"` before login).
- **OpenCloud Android 1.3.1**, commit `958f6a8c4142f621989f616b66d3906f08ddc669` ([source](https://github.com/opencloud-eu/android/tree/958f6a8c4142f621989f616b66d3906f08ddc669)) — source-inspected only (no emulator/device).
- **ownCloud CLI 6.0.3.18040**, source `7c8209b457e0fceeb56efcf771384b1eefa9de27` (Linux AppImage SHA-256 `6e86833830398d33b834ff4496e5a2e9a905d5a39e475a1a8e84d23c32b0cc0d`, provides `AppRun --cmd` over Basic auth).
- **Cyberduck CLI 9.6.0.46406**, source `7ca434ece1b7502faec04c9f9c1b2bebbf4e5d35`.
- **rclone 1.76.0**, `vendor = infinitescale`.
- **Official oCIS reference server v8.2.3** (Linux binary SHA-256 `7a386c4e85ffe629d6ffdfb0a0ea4e60c87ac3620892b9534d0a3ec8b14fc68a`).

Inspected source modules:
- **Desktop 7.1.1**: `determineauthtypeadapter.cpp` (Bearer requirement), `discoverwebfingerserviceadapter.cpp` (issuer discovery), `oauthpagecontroller.cpp` (Spaces requirement), `oauth.cpp` (PKCE, token fields, refresh, basic/post client auth), `checkserverjobfactory.cpp` (`status.php`), `fetchuserinfojobfactory.cpp` (OCS user), `capabilities.cpp` (sharing default `true`, notifications presence check, `SHA1` default, `pollinterval` parsed as milliseconds), `graphapi/jobs/drives.cpp` & `graphapi/space.cpp`, `propagateuploadtus.cpp` (`creation-with-upload`, metadata, chunks, `HEAD` recovery, empty POST, completion fallback), `propagateuploadcommon.cpp` (`mtime`/preconditions), `discoveryphase.cpp` (PROPFIND properties), `propagatedownload.cpp` (ETag & resume validation).
- **Android 1.3.1**: `LoginActivity.kt`, `setup.xml`, `OCServerInfoRepository.kt`, `TokenResponse.kt`, `UserInfoResponse.kt`, `SpacesResponse.kt`, `TusUploadHelper.kt` (`creation-with-upload`, basename metadata, chunk clamp, `HEAD` retry), `Copy/Move/Rename/CreateFolder/RemoveRemoteFileOperation.kt`, `DavUtils.kt` (properties and `preview=1` + `x/y/c`).

## Source-derived compatibility matrix

| Area | Finding | Evidence |
| --- | --- | --- |
| Authentication | Desktop requires Bearer + OAuth code/PKCE; Basic-only rejected | Source + oCIS OIDC HTTP probe |
| Discovery | `status.php`, OCS user/capabilities, Graph drives, enabled Spaces required | Source + oCIS HTTP probe |
| TUS | `creation-with-upload` mandatory on Desktop; clients cap POST/PATCH | Source + CLI 6 / rclone / Cyberduck probes |
| Paths | Desktop sends relative subpath in `filename`; Android sends basename at parent | Source |
| Recovery | `HEAD` offsets, completion `ETag`/`OC-FileID`/`OC-Perm` (`PROPFIND` fallback), zero-byte POST | Source + oCIS HTTP probe |
| Download | Desktop requires `ETag` and validates `Content-Range`/length on resume | Source |
| CRUD | Distinct `201`/`204`/`409`/`412` expectations | Source + oCIS HTTP/client probes |
| Sync | Root/directory `eTag` controls subtree traversal skipping | Source + oCIS HTTP probe; Drive strategy open |
| Preview | Android DAV `preview=1` with `x`/`y`/`c` | Source + oCIS HTTP probe |
| Local rclone baseline | 25 MiB + 123 B in 3 PATCHes under 12 MiB cap; SHA-256/`mtime` match; single PUT `413` | Local Worker + DO + MockDrive |
| 7.1.1 GUI / Windows / Android / Real ingress | Not yet executed end-to-end | Open gate |

## Reference server HTTP and OIDC probes (oCIS 8.2.3)

### HTTP & WebDAV contract (54 requests, 66 assertions)

Captured in [ocis-reference-observations.json](ocis-reference-observations.json) and [probes/2026-11-17/http/validation.json](probes/2026-11-17/http/validation.json):
- **Bootstrap**: OCS user/capabilities, Graph `/me/drives`, OIDC discovery JSON, unauthenticated DAV `401`. Wait for Graph/services beyond `status.php` at startup (early requests returned transient `502`).
- **DAV & preconditions**: `PROPFIND` `207` mixed `200`/`404` propstat; `Range` `206` and out-of-range `416`; missing file `404`; missing-parent `MKCOL` `409`; `COPY` `Overwrite: F` `412`; stale `If-Match` `PUT` returned **`409`** (preserving target bytes; differs from `412`); `COPY`/`MOVE` content checks.
- **TUS lifecycle**: data-bearing `POST` accepted `3/6` bytes; `HEAD` returned offset `3`; stale `PATCH` offset returned `409`; final `PATCH` returned `204` (`Upload-Offset: 6`); completion returned `OC-FileID` without `ETag`/`OC-Perm`; **completed `HEAD` returned `404`** (matching our target `13B` immediate-cleanup design; current `dev` still retains a 24h `200` receipt until migrated). Zero-length `POST` created an empty readable file; `filename` `probe-run/path-file.txt` at Space root resolved to the nested path.
- **Restart recovery**: terminating and restarting the local oCIS process mid-upload preserved offset `3`, resumed via `HEAD`, and completed `abcdef`.
- **Previews**: `96×64` PNG (207 B) with `preview=1&x=32&y=32` returned a `32×32` PNG (103 B) while original `GET` stayed 207 B; plain text returned a generated JPEG (`200`); opaque binary returned `404`.
- **Sync root ETag**: uploading a descendant changed Graph personal `root.eTag`.
- **Locking**: reference `LOCK` returned `200` and conflicting lock returned `423` (Desktop/Android must be tested with locks disabled in our profile).

### Reference OIDC HTTP probe (19 records across two instances)

Captured in [probes/2026-11-17/oidc/results.json](probes/2026-11-17/oidc/results.json):
- Discovery, login, consent (`200`), callback redirect (`302` with `code`), `S256` PKCE exchange (`200` with `access_token`, `id_token`, `refresh_token`, `expires_in`, `token_type`), Bearer Graph `200`, and refresh `200`.
- Wrong-password login returned `204`; invalid Bearer returned `401`; code replay returned `400 invalid_grant`.
- Invalid PKCE verifier returned `400 invalid_grant` and **consumed the code** (subsequent retry with the correct verifier also failed `400 invalid_grant`).

### Reference reproduction outline

Use a disposable temporary directory and local password (never real Drive credentials):

```sh
export OCIS_CONFIG_DIR="$TMPDIR/ocis-probe/config"
export OCIS_BASE_DATA_PATH="$TMPDIR/ocis-probe/data"
export OCIS_URL=https://localhost:9200 OCIS_INSECURE=true
export PROXY_ENABLE_BASIC_AUTH=true
ocis init --insecure true --admin-password "$LOCAL_TEST_PASSWORD"
ocis server &
# Read personal root.webDavUrl from Graph after startup settles:
# AppRun --cmd --trust --non-interactive --user admin --password "$LOCAL_TEST_PASSWORD" \
#   --server https://localhost:9200 LOCAL_DIRECTORY SPACE_WEBDAV_URL /
# rclone: type=webdav, vendor=infinitescale, url=SPACE_WEBDAV_URL
```

## Controlled chunk-announcement experiment

Varied only oCIS `FRONTEND_UPLOAD_MAX_CHUNK_SIZE` across `10,000,000`, `8,388,608` (8 MiB), `12,582,912` (12 MiB), and the selected default `10,485,760` (10 MiB) using a **26,214,403-byte** file (SHA-256 `7be259d71245aebcf1073acdc3c2262f8910873766ce02358df010cbdf2c68a3`) behind a local TLS recording proxy ([ocis-chunk-negotiation.json](ocis-chunk-negotiation.json)):

| Client | Server `max_chunk_size` | Creation `POST` body | Subsequent `PATCH` bodies |
| --- | ---: | ---: | --- |
| ownCloud CLI 6.0.3 | `10,000,000` | `10,000,000` | `10,000,000`; `6,214,403` |
| ownCloud CLI 6.0.3 | `8,388,608` | `8,388,608` | `8,388,608`; `8,388,608`; `1,048,579` |
| ownCloud CLI 6.0.3 | `12,582,912` | `12,582,912` | `12,582,912`; `1,048,579` |
| ownCloud CLI 6.0.3 | `10,485,760` | `10,485,760` | `10,485,760`; `5,242,883` |
| rclone 1.76.0 | all 4 values | `0` | `10,485,760`; `10,485,760`; `5,242,883` |
| Cyberduck CLI 9.6.0 | all 4 values | `0` | `10,485,760`; `10,485,760`; `5,242,883` |

All 12 uploads downloaded with matching SHA-256. Note:
- **ownCloud CLI 6.0.3** uses `min(remaining, max_chunk_size)` (same pattern in Desktop 7.1.1 `propagateuploadtus.cpp`), including on the initial `POST`. oCIS's internal Go client (`User-Agent: Go-http-client/1.1`) forwards `creation-with-upload` bodies as internal `PATCH`es, which the trace validator excludes from client totals.
- **rclone 1.76.0** hard-codes `ChunkSize = 10 MiB` for `vendor = infinitescale` (`webdav.go`). Passing `--webdav-nextcloud-chunk-size 8Mi` or `12Mi` against an 8 MiB server capability still produced 10 MiB chunks.
- **Cyberduck CLI 9.6.0** uses `min(local tus.chunk.size, remaining)` (`TusUploadFeature.java`, default 10 MiB). Overriding via `env 'tus.chunk.size=...'` (`8388608`, `12582912`, `262144`) changed client `PATCH` sizes as expected (3×8 MiB + 1 MiB + 3 B; 2×12 MiB + 1 MiB + 3 B; 100×256 KiB + 3 B), all matching source SHA-256.
- **Selected default**: **10 MiB (`10,485,760` bytes, 40 × 256 KiB)**, aligning CLI clients with rclone/Cyberduck while maintaining a separate accepted ingress ceiling and durable tail reblocking for smaller or unaligned requests (e.g., `10,000,000` leaves `38,528` bytes mod 256 KiB).

### Client CRUD & wire quirks

- **21-command CRUD pass**: `mkdir`, Unicode/space names, empty files, copy, move, overwrite, download, and delete succeeded across all 3 clients (`cli`/`rclone` downloads hash-verified). Cyberduck copy performs `GET` + `PUT` rather than server-side `COPY`. Cyberduck also uploaded and downloaded a **110,000,000-byte** file (empty `POST`, ten `10,485,760`-byte `PATCH`es, `5,142,400`-byte final `PATCH`, matching SHA-256 `d04c2e7d8c8e01027ddd2ba299705657a43306d395aeceeb8f008fa7abd69bf3`).
- **Cyberduck `Upload-Metadata` quirk**: sends `Upload-Metadata: filename <base64>, filetype application/octet-stream,` (unencoded `filetype` and trailing comma).
- **rclone `PROPPATCH` construction**: `rclone touch` sent a 337-byte body containing `{DAV:}lastmodified` (integer Unix seconds) and `{http://owncloud.org/ns}checksums` ([rclone-proppatch-construction.json](probes/2026-11-17/clients/rclone-proppatch-construction.json)).

## Source-verified minimal profile contracts (`OC-02`, 2026-11-27)

To resolve remaining `OC-02` protocol ambiguities without a headless GUI environment, a targeted source and upstream fixture audit was performed against the pinned `owncloud/client@9525d7331115d04ab0dd7646db3d0c084c7a1599` (plus `owncloud/libre-graph-api-cpp-qt-client@main`), `opencloud-eu/android@958f6a8c4142f621989f616b66d3906f08ddc669`, and Desktop `test/testconnectionvalidator/` fixtures. Canonical fixtures and field contracts are recorded in [ocis-client-contracts.json](ocis-client-contracts.json). Key parser-enforced invariants identified by the audit:

- **WebFinger & OIDC discovery**: Both Desktop `urlpagecontroller.cpp:223` and Android `OCServerInfoRepository.kt:87` fall back cleanly to standard single-instance `status.php` + OIDC discovery when `/.well-known/webfinger` returns `404` (avoiding Desktop's multi-instance `DiscoverWebFingerServiceAdapter` `application/json` check and post-login `acct:me@<host>` `WebFingerLookupAdapter` flow). Desktop uses `client_secret_basic`/`client_secret_post` and calls `/ocs/v2.php/cloud/user` (ignoring `id_token`/`userinfo`/`jwks`), whereas Android's `OpenCloudAndroid` is a public client (`oauth2_client_secret=""`) that selects `token_endpoint_auth_method=none` when advertised, skips dynamic registration if `registration_endpoint` is omitted, requires non-null `expires_in`, and decodes `id_token` payload claims (`preferred_username` -> `email` -> `sub`) without checking JWKS signatures; `id_token` signing standardizes on `RS256` to match oCIS 8.2.3.
- **Minimal `status.php` & `capabilities`**: Android `StatusRequester`/`OpenCloudVersion` require both `version` and `productversion` to be non-blank strings. In OCS capabilities, `core.webdav-root` stays `"webdav"` and `checksums` stays lowercase (`["sha1", "md5", "sha256"]` / `"sha1"`) matching oCIS 8.2.3; `files_sharing.api_enabled=false` and `files_sharing.public.enabled=false` must be explicit (Desktop defaults both to `true`), `spaces.version` is required by Desktop `SpaceSupport::isValid()`, `spaces.projects` is a non-null Moshi `Boolean` on Android, `ocs.data.version` should be populated, and `core.pollinterval=30000` is safe on Android (parsed as `Int?` without scheduling polling timers).
- **Graph `/graph/v1.0/me/drives`**: Desktop `Space::setDrive()` checks `root.eTag`, whereas `ETagWatcher::slotSpaceChanged()` reads top-level `OAIDrive::getETag()` (`space->eTag()`), so **both top-level `eTag` and `root.eTag` must be populated and updated together**; `drive.id` must equal `root.id`. `root.webDavUrl` must use literal `$` and **omit any trailing slash** because Android `RemoteFile.getRemotePathFromUrl` URL-decodes the href before splitting by `spaceWebDavUrl`. `quota`, `owner`, `special`, `webUrl`, `description`, and `virtual/shares` are all safe to omit.
- **DAV, TUS, & Conflicts**: Desktop requires `PROPFIND` `Content-Type: application/xml; charset=utf-8` and non-empty `oc:permissions` (`" WDNVCKRSMmz"`). Android strictly parses `oc:has-preview` as `text == "1"` (`"1"`/`"0"`). Desktop journal resume sends `HEAD <tus-location>` **without** `Tus-Resumable` (`propagateuploadtus.cpp:123`), so TUS `HEAD` must tolerate an omitted header. Android uses TUS for files `>= 10,240,000` B with `10,240,000`-byte `PATCH`es, sends per-chunk `Upload-Checksum: sha1 <base64>` on data-bearing `POST` and `PATCH` (fast-failing on HTTP `400`/`460`), and sends `OC-Checksum: SHA1:<hex>` on smaller plain `PUT`s (while rclone 1.76.0 sends `OC-Checksum` on TUS `POST`); TUS responses advertise `Tus-Extension: creation,creation-with-upload,checksum` and `Tus-Checksum-Algorithm: sha1,md5,sha256` and verify per-chunk digests via Web Crypto. Both clients natively map `If-Match` `412 Precondition Failed` to conflict/rediscovery.

## Offline upload recovery (`OC-09`)

- The [runtime restart test](../test/unit/tus-runtime-restart.test.ts) stops Miniflare after the DO starts an outbound PUT and before MockDrive accepts its body. A new Worker runtime reopens the same SQLite storage. TUS `HEAD` probes Drive, which returns `308` without a `Range`, and preserves the previously acknowledged tail.
- The [Worker tests](../test/worker/tus.test.ts) cover lost intermediate and final Drive responses, a disconnected final response body, a lost client acknowledgement, offset conflicts, and rate limits after a partial Drive acknowledgement. They check the recovered offsets and Drive request ranges, resume with different chunk sizes, and compare the DAV download SHA-256 with the source bytes.

## Remaining acceptance gaps and retained artifacts

Open gates tracked in [todo.md](../todo.md#ocis-兼容层实施计划):
- Runtime end-to-end validation and live Staging traffic capture (`wrangler tail` / sanitized logging) for Linux/Windows Desktop OAuth/sync/polling and OpenCloud Android Custom Tabs/preview/background transfers (`OC-10`).
- Minimal-capability fallbacks, conditional TUS overwrite with Drive-digest checksum verification, Drive `changes.list` sync strategy (`OC-03`–`OC-08`).
- Live Cloudflare ingress limits (`OC-10`).

Retained probe artifacts:
- Verified Desktop 7.1.1 & Android 1.3.1 source contracts and canonical fixtures: [ocis-client-contracts.json](ocis-client-contracts.json)
- Reference server HTTP captures: [ocis-reference-observations.json](ocis-reference-observations.json)
- Chunk negotiation matrix: [ocis-chunk-negotiation.json](ocis-chunk-negotiation.json)
- Probe scripts, logs, and unit tests: [probes/2026-11-17/README.md](probes/2026-11-17/README.md)
- Real Drive `version` check: [probes/2026-11-18/drive-version.json](probes/2026-11-18/drive-version.json)
