// Opt-in integration: RCLONE_BIN=/path/to/rclone pnpm exec vitest run --config test/rclone.config.mts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/rclone.integration.ts'], testTimeout: 120_000 } });
