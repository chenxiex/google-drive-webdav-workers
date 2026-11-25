// Opt-in E2E: RCLONE_BIN=/path/to/rclone pnpm test:e2e
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/e2e/**/*.e2e.test.ts'], testTimeout: 120_000 } });
