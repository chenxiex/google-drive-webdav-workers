# Fresh OIDC re-probe, 2026-11-17

Actual official oCIS 8.2.3 Linux server, two independent ephemeral instances.
Official binary SHA256: `7a386c4e85ffe629d6ffdfb0a0ea4e60c87ac3620892b9534d0a3ec8b14fc68a`.
Desktop public client registration extracted from owncloud/client commit
`9525d7331115d04ab0dd7646db3d0c084c7a1599`, src/libsync/theme.cpp.
Source SHA256: `a8bc1cf04d0f0aa2dfe226959f08977cbc5eca42848c50e171df3ee7a195cf27`.

Run `venv/bin/python probe.py /path/to/official/ocis` from this directory.
Python dependency: requests. Server and HTTP requests run under the same exec
network namespace. Local self-signed TLS only. Temporary admin passwords generated
in memory; server private config/data removed at end, server logs discarded.
No account password, code, bearer/refresh token, cookie, private key or full
redirect query is retained. theme.cpp contains only upstream's publicly embedded
application registration, not a user credential.

results.json and results.jsonl retain status, allowlisted response headers, JSON
field names, public discovery URLs and non-secret error codes. All expected status
assertions passed after this run:

- Discovery, hello, login, consent: 200; authorization callback: 302 with code.
- S256 PKCE code exchange: 200, access/id/refresh token fields present.
- Bearer Graph drives: 200; refresh: 200.
- Invalid password: 204; invalid bearer: 401.
- Authorization code replay: 400 invalid_grant.
- Separate fresh flow, invalid PKCE verifier: 400 invalid_grant.
- Correct verifier retry after that failure: 400 invalid_grant (consumed code).

Boundary: HTTP sequence equivalent to official login page behavior, not desktop
GUI or Android acceptance. This does not certify all OIDC security properties;
expiry, revocation, logout and all client/redirect binding variants not tested.

Before running a published copy without theme.cpp, fetch the fixed public source:

```sh
curl -fsSL https://raw.githubusercontent.com/owncloud/client/9525d7331115d04ab0dd7646db3d0c084c7a1599/src/libsync/theme.cpp -o theme.cpp
printf '%s  theme.cpp\n' a8bc1cf04d0f0aa2dfe226959f08977cbc5eca42848c50e171df3ee7a195cf27 | sha256sum -c -
```

The final fresh rerun used built-in assertions for statuses, required response
fields, authorization code presence, login/consent success and negative error
codes. It exited 0 and printed ALL CHECKS PASSED; results.json contains
complete=true and passed=true only after those assertions executed successfully.
