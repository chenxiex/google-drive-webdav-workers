# Reference oCIS 8.2.3 probes (2026-11-17)

Local reference probes run against an unmodified official **oCIS 8.2.3** server and pinned client binaries (temporary local config/storage only; no Google Drive or Worker changes).

See [the main probe report](../../ocis-probe-report.md) for findings and remaining Worker compatibility gates.

## Suites

- [HTTP](http/README.md): 54 requests, 66 assertions; response headers, small synthetic bodies, and binary hashes stored in [`ocis-reference-observations.json`](../../ocis-reference-observations.json).
- [OIDC](oidc/README.md): two ephemeral instances, 19 response records covering PKCE `S256` login, refresh, code replay, and invalid-verifier code consumption.
- [Clients](clients/README.md): 12 chunk-announcement matrix runs, 21 CRUD commands, 5 local chunk-size overrides, and rclone `PROPPATCH` construction capture.

## Notes

- Secrets, OAuth codes, cookies, `Authorization` headers, and signed session URLs are omitted or replaced with stable `REDACTED_TOKEN_*` hashes.
- In `clients/wire-*.json`, requests with `User-Agent: Go-http-client/1.1` are oCIS's internal forwarding of `creation-with-upload` bodies; `validate.py` excludes them when tallying client chunks.
