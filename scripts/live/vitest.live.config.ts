import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Live checks against real downloads and real game files (never part of `npm test`):
//   npx vitest run --config scripts/live/vitest.live.config.ts
// They only write into LIVE_DIR (default: <repo>/.smoke/live); real game folders are read, never changed.
export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, '../../src/shared') } },
  test: {
    include: ['scripts/live/**/*.live.ts'],
    root: resolve(import.meta.dirname, '../..'),
    environment: 'node',
    testTimeout: 15 * 60_000,
    hookTimeout: 15 * 60_000,
    fileParallelism: false
  }
})
