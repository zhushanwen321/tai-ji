import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default", "junit"],
    outputFile: { junit: "./test-results/vitest-junit.xml" },
    // e2e/harness.test.mjs：E2E harness 断言纯函数单测（无网络/无进程 spawn，随单测跑）。
    // 场景脚本 run-aN.mjs 与 vitest 包装 scenarios.test.mjs（真实 pi + 真实模型，2-15 分钟，
    // 依赖 ~/.pi/agent/auth.json）必须留在常规 CI 之外——显式跑用
    // `npx vitest run --config e2e/vitest.e2e.config.ts`（见 e2e/README.md）
    include: ["src/__tests__/**/*.test.ts", "e2e/harness.test.mjs"],
  },
});
