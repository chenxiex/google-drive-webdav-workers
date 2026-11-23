# Fresh official-client probes

This evidence is a new run, not reconstruction. Server oCIS 8.2.3, owncloudcmd 6.0.3.18040, rclone 1.76.0, Cyberduck CLI 9.6.0.46406. No GUI 7.1.1 / Android / Windows acceptance is implied. The sandbox clock printed 2026-11-16; this is the 2026-11-17 task rerun.

## Evidence

`summary.json` was created only after `validate.py` independently asserted the retained exit logs, byte hashes, client methods, byte lengths and statuses. Four announcement sizes × three original clients passed. Five local chunk-setting tests passed. CRUD logs and all sanitized HTTP headers are retained. The direct hash downloads in the matrix are authenticated HTTP reads. The separate CRUD pass also downloaded via actual owncloudcmd/rclone/Cyberduck; the 110,000,000-byte Cyberduck transfer matched SHA256 in both directions.

The retained `wire-*.json` records headers and body lengths, not raw payloads. The updated runner additionally retains sanitized query parameters and bounded DAV XML / OCS / Graph bodies (128 KiB maximum); this does not retroactively fill the old traces. XML is parsed and serialized for redaction, so namespace prefix spelling/whitespace is not a byte-for-byte trace. Expanded element/attribute namespace URIs are preserved, but QName-valued text/attributes and unused namespace declarations are not preserved by ElementTree; do not use this normalized capture as a lossless XML round-trip fixture. Unknown query values are redacted while parameter names remain. Run `python -m unittest test_capture.py` for the offline capture tests. Authorization/Cookie/Set-Cookie headers were omitted; signed upload URLs are replaced with stable REDACTED_TOKEN hashes. These are fresh local test accounts and files only. Requests from Go-http-client/1.1 are oCIS's internal forwarding of creation-with-upload; retained in wire but excluded from client chunk totals. Client requests must be distinguished from those internal requests.

The harness exposes HTTPS localhost:9200 with a disposable self-signed certificate, terminates TLS, records the request, and forwards method/path/body to unmodified official oCIS on HTTP localhost:9201. The server generates its own capabilities and responses; no protocol fields are synthesized or rewritten by the proxy. This is not a production transport/performance test. Proxy buffering allows accurate byte recording and is not a claim of Worker streaming memory behavior.

## Reproduce

Download the official pinned artifacts listed in `versions.json`. Extract the AppImage (`--appimage-extract`) and Debian archive (`dpkg-deb -x`) without installing system packages. Set absolute `OCIS_BINARY`, `RCLONE_BINARY`, `OWNCLOUD_APPRUN` (extracted AppRun), and `DUCK_BINARY` (extracted opt/duck/bin/duck). Run each server and its clients in the same execution context; sandbox exec loopback namespaces are isolated.

```
export PROBE_OUTPUT=/absolute/path/to/new-output
python probe.py 10000000 > "$PROBE_OUTPUT/run-10000000.txt" 2>&1
python probe.py 8388608 > "$PROBE_OUTPUT/run-8388608.txt" 2>&1
python probe.py 12582912 > "$PROBE_OUTPUT/run-12582912.txt" 2>&1
python probe.py 10485760 > "$PROBE_OUTPUT/run-10485760.txt" 2>&1
python probe.py 10485760 overrides > "$PROBE_OUTPUT/run-overrides.txt" 2>&1
```

Create output directory before shell redirection. The public runner generates random disposable credentials and self-signed keys, removes its private config at normal completion, and does not export raw client logs. The original run used a fixed disposable local password. Review the script before running; it intentionally creates local test storage and accepts the local self-signed certificate. It does not access the user's real Drive. All outputs are local. Run `validate.py` in the output directory to verify assertions. Do not reuse a previous nonempty output directory for acceptance.

A returned zero is not the only acceptance criterion: validator checks the recorded fields. Individual CRUD actions also retain HTTP methods/statuses, but are not a proof of every error/permission/race path. Cyberduck copy is GET plus PUT, not server-side COPY. The owncloudcmd test uses Basic and is not a GUI OAuth test.

## Separate client request-construction probe

`rclone-proppatch-construction.json` is a later, narrow capture using the existing
pinned rclone 1.76.0 binary against `record-rclone-proppatch.py`'s synthetic localhost
recorder. It is **not** a recovered original trace, an oCIS behavior test, or adapter
acceptance. The recorder supplies a known SHA1 property and records rclone `touch`:
its 337-byte PROPPATCH contains `{DAV:}lastmodified` as Unix seconds and
`{http://owncloud.org/ns}checksums`. This resolves the client's request shape without
claiming the reference server's property-write semantics. From the repository root,
run `RCLONE_BINARY=/path/to/pinned/rclone python docs/probes/2026-11-17/clients/record-rclone-proppatch.py`.
