# Official oCIS 8.2.3 HTTP probe

Probes an isolated local oCIS 8.2.3 server using Python standard library only.

## Artifacts

- [`../../../ocis-reference-observations.json`](../../../ocis-reference-observations.json): 54 requests covering discovery, OCS, Graph, WebDAV properties/ranges/locks/CRUD, TUS `creation-with-upload`, process restart recovery, root `eTag` changes, and previews (`probe.py` writes `observations.json` locally when rerun).
- `validation.json`: passing assertions (66 checks).
- `facts.json`: fixture image dimensions (`96×64`) and `root_etag_changed: true`.

Key observations:
- A plain text file returned a generated JPEG preview (`200`), while an opaque binary returned `404`.
- A `96×64` PNG returned a `32×32` PNG preview while `GET` returned original bytes.
- Completed TUS `HEAD` returned `404`, and completion omitted `ETag` and `OC-Perm`.
- Stopping and restarting the server mid-TUS upload preserved offset `3` and completed on resume.

## Reproduce

Download `ocis-8.2.3-linux-amd64` (SHA-256 `7a386c4e85ffe629d6ffdfb0a0ea4e60c87ac3620892b9534d0a3ec8b14fc68a`) and run on a machine where default oCIS ports (`9200`, etc.) are free:

```sh
OCIS_BINARY=/absolute/path/to/ocis python3 probe.py
```

Note: `probe.py` waits 18 seconds for services to settle and selects the personal drive by `driveType=personal`.
