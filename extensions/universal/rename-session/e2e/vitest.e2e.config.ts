import { defineConfig } from "vitest/config";

// E2E 场景专用 vitest 配置（A1-A7 真实 pi + 真实模型，2-15 分钟）：
// 主 vitest.config.ts 的 include 白名单不含本目录的 scenarios.test.mjs，
// 常规 CI / pnpm extensions:test 不会误触真实模型调用；显式入口：
//   cd extensions/universal/rename-session && npx vitest run --config e2e/vitest.e2e.config.ts
export default defineConfig({
  test: {
    include: ["e2e/scenarios.test.mjs", "e2e/harness.test.mjs"],
  },
});
