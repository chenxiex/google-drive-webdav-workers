# Client chunk-negotiation and CRUD probes

Captured against local **oCIS 8.2.3** using **owncloudcmd 6.0.3.18040**, **rclone 1.76.0**, and **Cyberduck CLI 9.6.0.46406**.

## Contents & capture rules

- `cap-*.json`, `run-*.txt`, `wire-*.json`, `summary.json`: retained outputs for the four server `max_chunk_size` announcements (`10000000`, `8388608`, `12582912`, `10485760`), the 21-command CRUD pass (including Cyberduck's 110 MB transfer), and the 5 local override runs (`overrides`).
- `wire-*.json` records headers, body lengths, redacted queries, and bounded DAV XML / OCS / Graph bodies (<= 128 KiB). XML is parsed and re-serialized by `capture.py` during redaction, so prefixes/whitespace are normalized and QName-valued attributes or unused `xmlns` declarations are not preserved verbatim.
- `Authorization`/`Cookie`/`Set-Cookie` headers are dropped; signed URLs use `REDACTED_TOKEN_*` hashes.
- `Go-http-client/1.1` requests are oCIS internal `creation-with-upload` forwards and are excluded from client chunk totals by `validate.py`.
- The TLS-terminating recording proxy buffers requests on `localhost:9200` and forwards unmodified HTTP to oCIS on `localhost:9201`.

Run `python3 -m unittest discover -s . -p 'test_*.py'` from this directory to run the offline capture redaction tests.

## Reproducing the matrix

Download the pinned artifacts from `versions.json`, extract the AppImage (`--appimage-extract`) and `.deb` (`dpkg-deb -x`), and set `OCIS_BINARY`, `RCLONE_BINARY`, `OWNCLOUD_APPRUN`, and `DUCK_BINARY`:

```sh
export PROBE_OUTPUT=/absolute/path/to/new-output
mkdir -p "$PROBE_OUTPUT"
python3 probe.py 10000000 > "$PROBE_OUTPUT/run-10000000.txt" 2>&1
python3 probe.py 8388608 > "$PROBE_OUTPUT/run-8388608.txt" 2>&1
python3 probe.py 12582912 > "$PROBE_OUTPUT/run-12582912.txt" 2>&1
python3 probe.py 10485760 > "$PROBE_OUTPUT/run-10485760.txt" 2>&1
python3 probe.py 10485760 overrides > "$PROBE_OUTPUT/run-overrides.txt" 2>&1
PROBE_OUTPUT="$PROBE_OUTPUT" python3 validate.py
```

## rclone PROPPATCH capture

`rclone-proppatch-construction.json` records `rclone touch` against `record-rclone-proppatch.py`'s synthetic localhost server (337-byte `PROPPATCH` with integer `{DAV:}lastmodified` and `{http://owncloud.org/ns}checksums`):

```sh
RCLONE_BINARY=/path/to/rclone python3 docs/probes/2026-11-17/clients/record-rclone-proppatch.py
```
