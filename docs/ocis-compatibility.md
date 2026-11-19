# oCIS-compatible personal-drive profile (design)

Status: **proposed implementation contract, not an implemented or fully client-certified service**.
Baseline: `dev` `873aff9`; recovered independent TUS foundation is
`fix/durable-tus-upload` `c45b349`. It is not included in this documentation commit.
The original local TUS commit `fef204e` was lost with the newer workspace snapshot.
Evidence and remaining acceptance gates: [probe report](ocis-probe-report.md).
Implementation progress: [todo](../todo.md#ocis-兼容层实施计划).

Recovery note: reconstructed from the original writing commands and subsequent recorded
edits after the environment reverted to an older snapshot. Meaning and recorded decisions
are preserved; this is not asserted to be byte-identical to the lost Git blob.
Fresh 2026-11-17 reference HTTP/OIDC evidence now supersedes the partial response
recovery, as documented in the probe report; this does not implement the adapter.

## 1. Goal and boundary

Expose one Google Drive root through existing, unmodified desktop and Android clients,
with bounded multipart requests through Workers. Retain standard WebDAV clients and
rclone. Implement a small **oCIS-compatible profile**, not deploy the oCIS service stack
or claim complete ownCloud/OpenCloud server compatibility.

Initial target versions are ownCloud Desktop 7.1.1 (Linux and Windows), OpenCloud
Android 1.3.1, and rclone 1.76.0. Cyberduck CLI 9.6.0 and ownCloud CLI 6.0.3 are additional
dynamically probed clients. Android here means **OpenCloud Android**, not the separate
ownCloud Android product. Windows shares source but still needs platform acceptance.
New versions require a compatibility smoke run, not an assumed guarantee.

Required: login/refresh, one personal Space, directory discovery/synchronization,
original download/resume, bounded upload/resume, empty files, mkdir, rename/move,
copy, delete, conflict reporting, stable IDs, metadata, and authenticated previews.
Existing PROPFIND/PROPPATCH semantics remain available to generic WebDAV clients.

Not initially supported: collaboration/shares/public links, teams/project Spaces,
Space management, cloud recycle-bin UI, revision UI, favorites/search APIs, notifications,
SSE, online editors, federation, dynamic OAuth registration, distributed WebDAV locks,
and parallel TUS concatenation. Disable capabilities rather than returning fake success.
If a targeted client requires any disabled feature on its normal file workflow, that is
an acceptance failure to resolve before release, not permission to silently fake it.

## 2. Architecture and dependencies

Worker routes adapt the existing Drive/WebDAV implementation. Durable Objects hold
upload journals and authentication sessions. No R2, Redis, LDAP, Keycloak, or complete
file staging service is required by this design. Actual SQLite/DO request and storage
costs must be measured before choosing limits. Do not buffer an entire uploaded file.

Drive resumable uploads are sequential; bounded journal/tail storage bridges client
chunks to Google alignment. Arbitrary parallel S3-style part assembly is outside scope.
Existing KV remains a performance cache, not the authority for upload offsets, login
sessions, or synchronization generations.

All URLs returned to clients use the configured external HTTPS origin and base path.
Never derive a trusted redirect/issuer from an unchecked Host or forwarded header.
Keep the existing DAV path; a Space URL can route to the same implementation. Discover
paths from responses rather than requiring clients to guess Google IDs.

## 3. Authentication and bootstrap contract

Basic remains available for existing generic DAV/rclone access. Desktop 7.1.1 explicitly
requires Bearer/OAuth and enabled Spaces. A Basic-only server is not this profile.

A lightweight first-party login page may validate the existing USERS credentials.
The user password is **not** the application's client_id/client_secret. Installed-app
client secrets are public identifiers, not a substitute for user authentication.

Required endpoints (base-path routing must be integration-tested):

| Endpoint | Contract |
| --- | --- |
| `GET /status.php` | 200 JSON with installed=true, truthful installed/maintenance status; publish a tested compatibility version/product profile, not package.json version and not an assertion that the upstream oCIS binary is running. Exact accepted values are a client-probe gate. |
| unauthenticated `PROPFIND /remote.php/webdav/` | 401 with Bearer challenge; do not return a fake successful directory. |
| `GET /.well-known/webfinger?resource=...` | Valid subject when supplied; issuer link with rel `http://openid.net/specs/connect/1.0/issuer`; client configuration only for approved client IDs. |
| `GET /.well-known/openid-configuration` | Real issuer and authorization/token/userinfo/JWKS endpoints, code response, S256; advertise only implemented methods/scopes. |
| authorization endpoint | User login, code response and original state, approved exact redirect rules. |
| token endpoint | authorization_code and refresh_token grants; supported client_secret_basic/post for these clients. |
| userinfo endpoint | Authenticated, stable sub and truthful profile claims. |
| JWKS endpoint | Public keys for valid signed ID tokens; never publish private keys. |
| `GET /ocs/{v1,v2}.php/cloud/user` | OCS envelope with data.id and data["display-name"], XML/JSON representation as below. |
| `GET /ocs/{v1,v2}.php/cloud/capabilities` | OCS envelope with data.capabilities; honor OCS-APIREQUEST and representation selection below. |
| authenticated `OPTIONS /remote.php/webdav` (also trailing slash) | Discovery response with DAV/TUS support matching enabled operations; reference returns 204. |
| `GET /graph/v1.0/me/drives` | Graph value array containing the authorized personal Space. |

OCS v1 success uses envelope `meta.statuscode=100`; v2 success uses `200`. These
are envelope values, not interchangeable with HTTP status. Support `format=json` and
`format=xml` explicitly; without format honor XML/JSON Accept and use the reference XML
default. Preserve OCS envelope/error shapes and the observed v1 `Ocs-Api-Version: 1`
header. Cyberduck requests XML and CLI 6 uses v1, so JSON-only v2 is insufficient.
Cyberduck also probes `HEAD /remote.php/dav/files/<user>/Personal/`; reference 404 is a
valid fallback to OCS/Graph discovery, not an obligation to synthesize another mount.

Minimal implementation still requires HTTPS, login CSRF protection/rate limiting,
short-lived unpredictable one-use authorization codes, PKCE S256, code binding to
client/redirect/user, expiry, refresh-token revocation/rotation policy and authenticated
subject isolation. Desktop loopback redirect permits the registered loopback host with
a variable port, not arbitrary hosts. Android's approved custom-scheme callback is
exactly allowlisted. Token/code errors use OAuth error responses without leaking secrets.
Never log passwords, authorization codes, bearer tokens, or Drive upload session URLs.

Opaque random access/refresh tokens backed by DO are a reasonable implementation
choice; every token need not be a JWT. This does not license fake OIDC: when advertising
openid, issue correctly signed ID tokens with valid issuer, audience, sub, timestamps
and requested nonce semantics. Implement a limited standards-valid provider, not all
possible OIDC grants. Dynamic registration and federation can be omitted entirely.
Desktop token success requires access_token, refresh_token and token_type=Bearer;
Android also consumes expires_in. Verify renewal, restart persistence, logout/revocation,
expired tokens and concurrent refresh before accepting the auth implementation.

Signing keys must survive isolate restart and work across instances: use deployment
Secrets or persisted Auth DO key material, never cold-start-only random keys. Choose
a supported Web Crypto signing algorithm (RS256 is a candidate), stable `kid`, and
retain public verification keys until issued tokens expire when rotating. Freeze the
actual desktop/Android public client IDs and callback rules from pinned sources into
a tested allowlist; an embedded desktop client secret is not confidential. Do not
accept arbitrary IDs, wildcard custom schemes or arbitrary loopback hosts. A concurrent
refresh must have a documented atomic policy (single winner or bounded same-result
retry); a grace window is not permission to mint independent unlimited token chains.

USERS accounts currently share one Google identity and ROOT_ID. Authentication subjects
and upload/session ownership remain distinct, but this is not per-user file isolation.
One configured shared view may have one stable Space identity and common generation;
Graph owner must describe that model truthfully or be omitted. Do not imply that
different login names create private Google roots.

## 4. Capabilities and Space model

Explicitly disable `files_sharing.api_enabled` (Desktop defaults it to true when absent),
public sharing and versioning. Omit notifications.ocs-endpoints and unsupported app
providers rather than advertising empty placeholders. Do not advertise lock support.
Enable spaces.enabled and declare a single personal Space; do not disable Spaces to
simplify the implementation. Desktop 7.1.1 parses core.pollinterval as **milliseconds**,
although the observed oCIS 8.2.3 response is 60. Resolve this server/client discrepancy
in compatibility acceptance rather than copying 60 and assuming a 60-second interval.

TUS capabilities under files.tus_support:

```json
{
  "version": "1.0.0",
  "resumable": "1.0.0",
  "extension": "creation,creation-with-upload",
  "max_chunk_size": 10485760,
  "http_method_override": ""
}
```

User-selected default: **10 MiB (10,485,760 bytes)**, exactly 40 × 256 KiB.
This matches the tested rclone/Cyberduck defaults and gives clients that honor the
announcement the same aligned full-chunk target. Other clients, smaller requests,
resumed transfers and final chunks may still differ; keep bounded durable tail buffering.
The hard accepted request ceiling must be separate, at least the default, and below the
actual ingress limit. Dynamic reference tests show CLI 6 follows the 10,000,000-byte
capability while rclone sends 10,485,760-byte chunks. Accept both; do not enforce the
recommendation as a hard limit. POST-with-data and PATCH share the accepted ceiling.
Controlled reference tests also varied the announcement to 8 MiB and 12 MiB:
ownCloud CLI 6.0.3 followed both values, including first POST; rclone 1.76 and Cyberduck
9.6 remained at 10 MiB. The rclone Nextcloud chunk-size option is overridden for its
infinitescale vendor; Cyberduck has its own local tus.chunk.size preference. Neither
is evidence of server negotiation. An aligned recommendation can reduce reblocking
for clients that honor it but cannot remove the durable tail/recovery requirement.
See the [controlled experiment](ocis-probe-report.md#controlled-chunk-announcement-experiment).

Tus-Max-Size is the maximum **whole file**, not the per-request chunk size. Never
confuse these two limits. Advertise checksum algorithms only when actually verified;
omitting preferredUploadType does not mean none (Desktop defaults to SHA1).
Checksum choice and the exact capability envelope are client acceptance gates.

Graph drive entry contains driveType=personal, stable id, name, and root with stable
id, webDavUrl and changing eTag. Desktop identifies the Space using root.id.
Optional quota, special, owner, webUrl and description must be complete and truthful
or omitted. Android quota.total must be an integer when quota is present. Do not
invent unlimited quota or return partially populated special entries. One configured
Drive root maps to one Space per authorized view. No access outside that root is allowed.

## 5. DAV resource and synchronization contract

Use existing DAV XML namespaces/escaping and correct 207 propstat grouping. Unknown
properties are 404 propstat, not invented empty values. Support Depth 0/1 discovery;
reject unsupported unbounded recursion explicitly. A failed/partial upstream listing
must never be reported as a successful empty or complete directory.

Required property surface from client source includes DAV displayname, resourcetype,
getcontenttype, getcontentlength, getlastmodified, creationdate and getetag; ownCloud
id and fileid, spaceid, file-parent, name, permissions, checksums, size, has-preview,
plus requested optional share-types,
privatelink, downloadURL, dDC and root data-fingerprint. Return only valid semantics;
unsupported optional properties use 404. Permissions must describe actual operations,
not a universal writable string. ID survives rename/move; real replacement/new objects
must not reuse an unrelated identity. Proper namespaced errors matter.

Reference collections expose `oc:size` rather than a file `d:getcontentlength`. Define
folder size honestly (do not invent a recursively computed total). Map `oc:id` and
`oc:fileid` consistently to stable identity; requested unsupported optional fields remain
404. Support `Prefer: return=minimal` for PROPFIND by omitting 404 Not Found property propstat entries
only when applying that preference, with `Preference-Applied: return=minimal`; it does
not permit omitting successful requested properties or partial listing errors.

Separate synchronization change markers from HTTP media validators. PROPFIND currently
uses Drive version (including metadata/dead-property mutations); `id + modifiedTime`
is insufficient when a client preserves mtime across a content update. Binary GET uses
the actual Drive v2 `alt=media` response ETag, never the v2 JSON etag or a derived
metadata version. HEAD currently omits ETag rather than claim its cached metadata
validator identifies the downloaded representation. The future compatibility profile
must test client synchronization and HEAD expectations with this distinction; do not
claim all three validators agree without a verified representation-bound implementation.
For Range + If-Range, compare the requested strong tag with the actual partial response
ETag before exposing its body. A mismatch, weak/date validator, absent response tag, or
416 falls back to full GET; unrelated errors do not. Google does not enforce If-Range
for this media path. Ordinary Range is unchanged. Directory and Space-root validators must
reflect descendant changes; Drive folder modifiedTime/version alone is insufficient.
Clients can skip a complete tree when root.eTag is unchanged. A constant synthetic
root validator silently loses synchronization.

**Unresolved implementation gate:** choose the cheapest correct change discovery
strategy. A per-view DO generation, advanced by local mutations plus Drive changes
polling, and used conservatively for every directory, is a candidate, not a proven
solution. It avoids an ancestor index but rescans more. Evaluate persisted feed cursors,
external creates/edits/moves/deletes, changes outside the mounted root, missing/invalid cursors,
cache invalidation, multiple users/views, polling lag and Drive/DO costs. Compare it
against deliberately invalidating discovery on a poll interval/full traversal; do not
promise zero lag or no missed changes without tests. Feed outage must not issue a false
"unchanged" assertion from an unverified generation. KV eventual consistency must not
silently restore an older validator. This profile does not require a globally distributed
lock service, but honest synchronization cannot ignore stale directory validators.

Drive changes start/page tokens are documented as non-expiring; do not invent a token
TTL (unlike OAuth or upload sessions). Recovery still needs invalid/missing state,
permission loss and pagination/crash handling. Before using changes, audit
getStartPageToken/changes.list and extend the mock; the existing mock does not cover it.

A generation may never label an older cached listing as current. For the candidate
DO design, namespace both metadata and listing caches by authoritative view generation,
and ensure in-flight results retain the generation they started under. A request that
observes a generation change must not publish old data under the new key; retry or fail
without an unchanged assertion. KV deletion alone cannot enforce this across instances.
Test old memory/KV hits, in-flight stale fills, external deletion/move and restart after
feed checkpointing. This is a new sync correctness requirement, not a reversal of the
accepted generic DAV 30/60-second cache policy. If changes cannot cheaply be scoped to
a mounted subtree, account-wide generation invalidation is safe but can cause excess
traversals; measure that tradeoff rather than pretending unrelated changes are free.

## 6. File operations and errors

| Operation | Required behavior |
| --- | --- |
| GET/HEAD | Original bytes, actual MIME/length/ETag; authenticated Range and If-Range; 206 with consistent Content-Range; 416 for unsatisfiable range. Never substitute preview bytes. |
| PUT | Retain bounded streaming; success 201 new/204 replacement; honor applicable preconditions and mtime; single-request ingress ceiling still applies. |
| MKCOL | 201; missing parent 409; do not invent parent creation unless requested by a separate client operation. |
| MOVE/rename | Destination validation, existing overwrite semantics, 201/204; 412 when overwrite/preconditions forbid; reject self/descendant movement. Preserve source ID. |
| COPY | 201/204 and real destination ID; 412 if overwrite forbidden. Existing unsupported directory copy stays explicit until implemented and tested. |
| DELETE | Successful deletion 204 (clients also accept 200); missing/forbidden distinguished. See deletion policy gate below. |
| PROPPATCH | Keep existing native/dead property support, protected-property rejection, quota limits and atomic request error reporting. |
| LOCK/UNLOCK | Remain unsupported, no Class 2/false exclusive lock claim. |

Use 401 for failed authentication, 403 for authorization, 404 for absent resources,
409 for structural conflicts, 412 for failed conditions, 413 for request-size rejection,
429 for throttling and 507 for genuinely identified storage/quota exhaustion. Preserve
retry guidance where available; unknown Google failures are not automatically 404 or
507. Do not convert partial operations into unconditional success. Client 412 triggers
rediscovery/conflict handling; maintain the existing safe-overwrite design without
adding speculative check-then-act loops that cannot eliminate races.

Deletion policy is **not yet changed**: dev currently permanently deletes ordinary
DELETE. Decide whether the compatibility path should trash instead, and document
restoration limitations, before release. No fake recycle-bin endpoint. Google Docs
native documents/export remain a separate product decision; do not expose them as
ordinary downloadable binary files unless a defined export representation exists.

### Legacy route and migration boundary

The oCIS profile is opt-in. With it disabled, existing PATH routing and its legacy
parent-creating PUT/MKCOL behavior remain unchanged. When enabled, bootstrap endpoints
above are origin-root endpoints and `/dav/spaces/<spaceId>/...` is reserved for the
compatibility dispatcher before legacy PATH dispatch. Do not silently shadow a real
legacy `spaces` folder under PATH=/dav/: require a non-overlapping legacy mount (for
example `/webdav/`) or reject the conflicting configuration before enabling the profile.
This migration is explicit and must be documented and tested, not silently renamed.

Decode each path segment once. Both literal `$` and `%24` in a Space ID identify the
same authorized Space; encoded separators and double-decoding must not escape the
mount. Compatibility MKCOL/PUT/TUS creation require existing parent collections (409
when absent); legacy recursive ensureDir is not reused there. Preserve the old test
for legacy behavior and add separate compatibility tests. Non-TUS PATCH must not be
dispatched to COPY in the compatibility route; return method-not-supported instead.
The existing legacy PATCH alias is a separate migration choice.

Native Google documents and shortcuts need an explicit sync representation or an
explicitly excluded, discoverable unsupported-resource policy. Do not promise that
every such item produces a 403 loop; verify actual client response. An export or
shortcut-resolution feature is not implicitly authorized by this design correction.

Quota arithmetic must handle absent Drive limit (unlimited) and decimal-string values
without NaN/unsafe integer rounding. Use exact integer arithmetic internally; do not
copy oCIS's 2^63-1 sentinel into a JS Number. Optional Graph quota should be omitted
when a truthful client-safe representation has not been established.

## 7. TUS upload and recovery

Desktop requires creation-with-upload, not merely creation. POST to a DAV collection
creates a session and may contain initial bytes; support Upload-Length: 0 with immediate
empty-file completion. Desktop filename metadata can be a relative full path, whereas
Android supplies a basename to the destination collection. Define path resolution once:
relative to the addressed upload collection, normalize once, reject traversal, ambiguous
encoding, NUL and absolute URLs; prevent root escape and duplicate path-prefix insertion.
This exact routing is an end-to-end client-probe gate, not a guessed rewrite rule.

Parse metadata filename, mtime, checksum and optional MIME safely. Observed Cyberduck
9.6.0 sends `filename <base64>, filetype application/octet-stream,`: the extra filetype
value is not Base64 and there is a trailing comma. To support this client, tolerate
that narrowly scoped optional hint (or ignore it and infer MIME); do not relax filename,
checksum, path authorization or arbitrary mandatory metadata validation. Accept finite
fractional Unix-second mtime where observed, define conversion precision, and reconcile
X-OC-Mtime with metadata mtime explicitly. Pinned rclone 1.76.0 SetModTime source uses `DAV:lastmodified` (integer Unix
seconds), optionally alongside `oc:checksums`; this differs from DAV:getlastmodified.
The historical 337-byte capture lacks its body. A fresh original-client synthetic
recorder probe now confirms that property combination and body length; it is not
a recovery of the old values or a live oCIS semantic acceptance test. Document this
as a vendor deviation from strict TUS syntax, not a reason to accept all malformed input.
Support TUS 1.0 OPTIONS, POST, HEAD and PATCH with correct Tus-Resumable/Upload-Offset/
Upload-Length and Location. The Location remains reachable through the Worker and
scoped to the authenticated user; never expose Google's resumable URL. Offset mismatch
returns 409 and current offset; unsupported version 412, invalid content type 415,
expired/missing session 404/410 under a documented retention policy. Do not advertise
termination/expiration/checksum protocol extensions merely because internal cleanup or
metadata checksum handling exists.

A per-upload DO serializes requests and persists pending bytes before acknowledging.
After ambiguous Google timeout, reconcile Google's accepted offset before resending;
client HEAD must report durable accepted progress. Incomplete finalization must not
report a completed file. Keep completion receipts for response-loss retries; retain
bounded recovery/cleanup semantics from the recorded TUS foundation. Never depend on
KV or one isolate's RAM.

Our preferred completion returns actual ETag, OC-FileID and OC-Perm, matching immediate
PROPFIND; Desktop/Android may fall back to PROPFIND when completion metadata is absent.
The reference 8.2.3 server actually returned only OC-FileID and removed the completed
TUS session (subsequent HEAD 404). Our retained completion receipt is an intentional
recovery improvement, not a claim of identical reference-server lifecycle. Honor mtime
and overwrite preconditions on the applicable creation/finalization paths. Test whether
each client carries If-Match on TUS independently of its ordinary PUT path. Checksum
mismatch must be surfaced, not ignored after claiming verification. Verify checksum
availability and Drive digest timing in the mock contract before relying on it.

The oCIS whole-file checksum metadata is distinct from the TUS per-request
Upload-Checksum extension; do not advertise the latter merely for implementing the former.

Checksum verification for an in-place replacement must finish **before** sending the
Google-finalizing bytes, otherwise mismatch detection is too late to protect the old
content. Persist incremental digest state and its byte position alongside the upload
journal (or demonstrate an equally bounded recoverable alternative); hash each byte
once despite client replay and upstream partial acknowledgments. Hold the final block
until the declared whole-file checksum is validated, including exact-block and empty
files. Native digest APIs alone do not supply serializable cross-request hash state.
Audit Drive finalization and checksum response fields before relying on them; a digest
returned after commit can validate success but cannot undo a failed replacement.
A temporary-file replacement changes Google identity and is not equivalent to stable-ID
in-place overwrite. This is OC-06 work, not functionality promised by the independent
generic TUS foundation. It does not provide atomic exclusion of concurrent writers.

A replay at an old Upload-Offset can correctly return 409 even after completion; HEAD
then exposes retained completed progress. Probe client recovery rather than changing
this to fake unconditional PATCH success. Reference HEAD 404 and our receipt HEAD 200
are an intentional lifecycle difference. Measure current 1 MiB upstream/journal writes
and bound the accepted request size against platform request and CPU/storage budgets;
10 MiB announcement alone does not prove cost or large-request safety.

Acceptance cases: new/overwrite/empty files; paths with Unicode/spaces; data-bearing POST;
multiple PATCHes; smaller than/at/over chunk bound; arbitrary client chunk alignment;
concurrent PATCH; stale offset; client restart; lost responses; Google partial Range,
308/timeout/401/429/5xx; expiry; final response loss; quota and checksum failure; unchanged
old target on failed replacement where the existing safe-overwrite contract promises it.

### Worker-to-Drive alignment acceptance gate

Reference-server tests do not exercise this adapter's Worker-to-Drive upload path.
In particular, 10,000,000-byte client chunks leave a **38,528-byte remainder** modulo
Google's 256 KiB (262,144-byte) upload alignment. Advertising an aligned preferred
size is not a correctness solution: clients may ignore it, use smaller chunks, or
change chunk sizes when resuming. Preserve arbitrary accepted client boundaries and
reblock only at the Google-facing boundary, with a bounded durable tail and journal.

Before releasing OC-06/OC-09, run a real supported client through the **actual Worker
compatibility layer**, not directly against oCIS, with a file larger than two client
chunks. Include a data-bearing 10,000,000-byte POST followed by at least two PATCHes,
and separate 10 MiB/default and irregular/resumed-chunk cases. Download the resulting
file through the adapter and compare complete bytes or SHA256 with the source. Assert
Google-facing non-final chunks satisfy alignment while the final remainder is preserved.

Inject interruption/response loss across a client boundary that leaves a buffered tail:
after durably saving tail/pending bytes, after Google accepts bytes but before its reply
is observed, and after server acceptance but before the client receives acknowledgment.
Restart the Worker/DO, recover via HEAD and Google's accepted Range, then retry/resume.
Verify neither duplicate nor missing bytes, stable final length/hash, truthful durable
Upload-Offset, and bounded buffering. Also test a resume chunk size different from the
initial size. Run these deterministically against the already-aligned Drive mock; audit
any missing mock behavior first. Fresh real-Drive validation is not required merely
because the client boundary changes, unless the required upstream behavior is unverified.

## 8. Preview and metadata

Support authenticated DAV file GET with preview=1 and x/y/c parameters consumed by
Android. c is a cache validator hint, not authentication. Fetch Drive thumbnailLink
server-side, never redirect clients to a Google URL or expose credentials. Return actual
image Content-Type and bounded bytes. Do not treat every non-image source as lacking
a preview: the reference server can render text to JPEG, while an opaque binary lacks
a preview. This adapter follows actual Drive thumbnail availability, not oCIS rendering
coverage or an image-only heuristic. Validate dimensions; do not promise exact resize
semantics absent an implementation. Missing preview produces a real not-found/unsupported
response and has-preview=false where known, not the original file masquerading as a
thumbnail. Cache by identity and version, enforce the same user/root authorization.

For rclone compatibility, writable `{DAV:}lastmodified` uses integer Unix seconds,
while readable `{DAV:}getlastmodified` uses HTTP-date. A request can also contain
`{http://owncloud.org/ns}checksums`; do not mistake stored client claims for verified
content digests.

Keep Drive-backed custom properties and native metadata mapping from the existing
WebDAV behavior document. Unmapped rich Drive capabilities can remain unavailable;
this is a deliberate lean subset, not full Drive API equivalence.

## 9. Release gate and evidence policy

Freeze schemas and defaults only after recorded, reproducible tests with the target
binaries. The comprehensive operation list above removes the need for repeated broad
research, but source tracing does not replace first implementation acceptance. Track
uncertain items explicitly instead of calling the protocol fully settled.

Run each target's login/refresh, discovery, CRUD, upload/resume, download/resume,
conflicts, remote changes and preview scenarios. Linux and Windows sync need both
local-to-cloud and externally-edited-Drive-to-local flows. Android needs actual browse,
edit/upload, download and background/interrupted transfers. rclone remains an independent
baseline. Verify large uploads through a real deployed ingress limit after local simulated
limits; no deployment or external state changes are implied by these documents.

Default automated tests remain mock-only. Extend/audit any missing Drive mock behavior
first, then accept implementation using deterministic contract tests. Keep real-Drive
checks opt-in and scoped; do not retest known aligned behavior merely for ceremony.
