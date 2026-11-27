# Project Guide

## Verification

- Run `pnpm check` (`pnpm typecheck && pnpm lint && pnpm test --run`) after edits; default tests run offline against Miniflare and `MockDrive`.

## General Rules

## Index

- [Worker Source Guide](src/AGENTS.md) — Workers runtime constraints, Durable Object registration, and isolate cache boundaries.
- [Auth & OIDC Guide](src/auth/AGENTS.md) — `AuthStore` (`AUTH_DO`), constant-time comparison, Cloudflare Access, and OIDC configuration/logging boundaries.
- [TUS Upload Guide](src/tus/AGENTS.md) — `TusUpload` (`TUS_UPLOADS`) Durable Object and upload session boundaries.
- [E2E & Staging Deployment Guide](test/e2e/AGENTS.md) — Staging Cloudflare Worker deployment, secret sync, teardown, and opt-in `rclone` / live E2E tests.
- [WebDAV Behavior](docs/webdav-behavior.md) — Implemented WebDAV, TUS, and OAuth/OIDC protocol semantics and boundaries.
- [oCIS Compatibility Profile](docs/ocis-compatibility.md) — Proposed design specification for desktop/mobile clients.
- [Client Probe Report](docs/ocis-probe-report.md) — Target client probe evidence and remaining gates.
- [MockDrive Contract](test/support/mock-drive.md) — Verified Google Drive API behavior modeled by offline tests.
- [Implementation Backlog](todo.md) — Current tasks and release gates.
