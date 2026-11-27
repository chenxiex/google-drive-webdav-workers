# Auth & OIDC Guide

- **Constant-time comparison**: `crypto.subtle.timingSafeEqual` exists in `workerd` but not in Node.js unit tests—always use `timingSafeEqual` from `src/auth/basic.ts`.
- **Durable Object (`AUTH_DO`)**: `AuthStore` (`src/auth/auth-do.ts`, SQLite migration `v2-auth`) persists hashed authorization codes, access tokens, and refresh tokens. Keep its binding and migration consistent across `src/index.ts`, `wrangler.jsonc`, `wrangler.staging.example.jsonc`, and `vitest.config.mts`.
- **Cloudflare Access & OIDC boundaries**: OIDC auto-activates when any `CF_ACCESS_*` or `OIDC_*` binding is present and fails closed with `500` on partial or invalid configuration. Cloudflare Access is a Zero Trust edge policy (cannot be configured in `wrangler.jsonc`) and protects only `/oauth/authorize`.
- **Sensitive data**: Never log `Cf-Access-Jwt-Assertion`, authorization codes, `code_verifier`, `client_secret`, access/refresh tokens, or `OIDC_SIGNING_KEY`.
