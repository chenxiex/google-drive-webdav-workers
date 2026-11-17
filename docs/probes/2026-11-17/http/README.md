# Official oCIS 8.2.3 HTTP re-probe

This is a **new execution**, not reconstruction of the lost earlier response values. It probes an isolated official server with a fresh synthetic local admin account and local filesystem storage. It does not contact Google Drive, test the project Worker, or establish client compatibility by itself.

## Reproduction

Download `https://github.com/owncloud/ocis/releases/download/v8.2.3/ocis-8.2.3-linux-amd64`, verify SHA-256 `7a386c4e85ffe629d6ffdfb0a0ea4e60c87ac3620892b9534d0a3ec8b14fc68a` against the vendor `.sha256`, and make it executable. Run:

```sh
OCIS_BINARY=/absolute/path/to/ocis python3 probe.py
```

Requires Python 3 standard library only. It starts/stops the server and client in the same process environment, using default service ports and HTTPS localhost:9200. Do not run beside another oCIS instance sharing those ports. Self-signed TLS is accepted only for this isolated local reference test. The script verifies the binary digest, creates a random local test password and fresh temporary config/data, then removes that directory in `finally`. Startup delay is 18 seconds; slow machines may require a longer delay. All operations use the personal drive selected by `driveType`, not the first Graph array element (which can be virtual shares).

## Evidence

- [`../../../ocis-reference-observations.json`](../../../ocis-reference-observations.json) (the script emits a local `observations.json` when rerun): explicit request headers and small synthetic request bodies; all response headers, small textual/XML/JSON bodies; SHA-256/size for binary bodies, and decoded PNG dimensions. Authorization/cookies/session JWTs/lock headers are redacted. UUID aliases preserve correlations. Exact new-run ETags are retained; these are local fixture metadata, not credentials. Python urllib may add implicit default Content-Type on body requests lacking one; evidence explicitly declares that header-capture scope.
- `validation.json`: full case presence, statuses, offsets, content preservation, hashes, dimensions, mixed property statuses and final pass/fail assertions.
- `facts.json`: source-image dimensions and root ETag change.

A text file can receive a generated JPEG preview (200). An unsupported opaque binary receives 404. Therefore “non-image always returns 404” is false. The PNG fixture receives a 32×32 PNG preview while downloading the source still returns its exact original 96×64 bytes.

TUS restart means terminate the official server process, start it with the **same** local persisted directory, then resume at offset 3 and verify final `abcdef`. It is not evidence for Worker Durable Object crash semantics or multi-region consistency.

Not covered by this harness: GUI/native client execution, OIDC browser login, token expiry/revocation, arbitrary file-type preview support, every WebDAV extension, real Google API contracts, or online Cloudflare deployment. Separate probe suites cover some of these; do not infer them from these HTTP results.
