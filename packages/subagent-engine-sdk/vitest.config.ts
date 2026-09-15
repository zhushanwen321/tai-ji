import { defineConfig } from "vitest/config";

/**
 * Vitest config for @zhushanwen/subagent-engine-sdk.
 *
 * 照 AGENTS.md 测试纪律（W1 任务书：新包自建 vitest 配置）：
 * - junit reporter 落盘用例级耗时（test-results/ 已 gitignore）；
 * - globalSetup 把 TAIJI_AGENT_DATA_DIR 重定向 tmp + 注入真实目录时 fail-fast（test/global-setup.ts）；
 * - setupFiles 挂 fs-guard 切面（破坏性 fs 操作白名单外抛错；test/fs-guard.ts，
 *   复制自 runtime 防线——[HISTORICAL] 2026-09-02 会话丢失事故双层防线的第二层）。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/fs-guard.ts"],
    reporters: ["default", "junit"],
    outputFile: {
      junit: "./test-results/vitest-junit.xml",
    },
  },
});
