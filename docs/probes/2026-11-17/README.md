# Fresh reference probes, 2026-11-17

These are **new executions**, not recovered copies of the lost 2026-11-16 logs.
They test an unmodified official oCIS 8.2.3 server with temporary local storage and
fixed client versions. They do not test the project's future oCIS adapter, Google Drive,
Cloudflare deployment, current GUI login, or Android/Windows platforms.

Only reviewed, sanitized artifacts belong here. Secrets, OAuth codes, cookies,
credential-bearing request headers and signed upload-session URLs must not be included.
Redacted values are labelled rather than silently dropped or invented. Historical
results elsewhere must not be silently attributed to this new run.

The source manifest records fresh retrieval hashes for fixed-version primary sources.
Source inspection supports explanations of client behavior, not runtime certification.
The probe scripts require official binaries and an isolated local-only environment;
self-signed TLS bypass is restricted to those temporary reference servers.

See the main probe report for coverage, run results, and remaining acceptance gates.

## Validated suites

- [HTTP](http/README.md): 54 new requests, 66 assertions; complete response headers,
  small synthetic bodies and binary hashes in [the canonical observations](../../ocis-reference-observations.json).
- [OIDC](oidc/README.md): two fresh instances, 19 response records; assertion-bearing
  runner reports complete/pass, with secret values omitted.
- [Clients](clients/README.md): 12 actual-client chunk-matrix runs, 21 CRUD commands,
  five local-setting cases, and matching downloads including Cyberduck 110 MB.

The client's recording proxy sees both original client requests and oCIS internal
forwarding. Validators separate them by the observed User-Agent; do not sum all PATCHes
in the wire log as if they originated from the client. Every suite states its transport,
fixture and assertion limits. The default project test suite was not changed.
