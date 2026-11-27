# Project Guide

## Verification

- Run `pnpm check` (`pnpm typecheck && pnpm lint && pnpm test --run`) after edits; default tests run offline against Miniflare and `MockDrive`.

## Index

- [E2E & Staging Deployment Guide](test/e2e/AGENTS.md) — Staging Cloudflare Worker deployment, secret sync, teardown, and opt-in `rclone` / live E2E tests.
- [WebDAV Behavior](docs/webdav-behavior.md) — Implemented WebDAV & TUS protocol semantics and boundaries.
- [oCIS Compatibility Profile](docs/ocis-compatibility.md) — Proposed design specification for desktop/mobile clients.
- [MockDrive Contract](test/support/mock-drive.md) — Verified Google Drive API behavior modeled by offline tests.
- [Implementation Backlog](todo.md) — Current tasks and release gates.
