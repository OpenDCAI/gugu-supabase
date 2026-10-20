import { defineConfig } from 'vitest/config'

// unit:纯函数与脚本判据,不要库。integration:要一个跑过全部迁移的库(GUGU_INTEGRATION_DATABASE_URL),
// CI 里由 schema-baseline 那个 job 起;本地用 `pnpm dev:db start` 起。
export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' } },
      { extends: true, test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], environment: 'node', testTimeout: 60_000 } },
    ],
  },
})
