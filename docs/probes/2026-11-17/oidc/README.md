# Official oCIS 8.2.3 OIDC probe

Runs the HTTP OAuth 2.0 / OIDC login, `S256` PKCE exchange, refresh, and failure cases against two ephemeral oCIS 8.2.3 instances (with `requests`).

## Recorded checks (`results.json`, 19 records)

- Discovery, login, consent (`200`), callback redirect (`302` with `code`).
- `S256` PKCE code exchange (`200` with `access_token`, `id_token`, `refresh_token`), Graph Bearer access (`200`), and refresh (`200`).
- Invalid password (`204`), invalid Bearer (`401`), authorization code replay (`400 invalid_grant`).
- Invalid PKCE verifier (`400 invalid_grant`), followed by retry with the correct verifier also returning `400 invalid_grant` (code consumed on failed attempt).

## Reproduce

Fetch `theme.cpp` from `owncloud/client@9525d7331115d04ab0dd7646db3d0c084c7a1599` (SHA-256 `a8bc1cf04d0f0aa2dfe226959f08977cbc5eca42848c50e171df3ee7a195cf27`, referenced in `inputs.json`) if not present locally, then run:

```sh
curl -fsSL https://raw.githubusercontent.com/owncloud/client/9525d7331115d04ab0dd7646db3d0c084c7a1599/src/libsync/theme.cpp -o theme.cpp
venv/bin/python probe.py /path/to/official/ocis
```
