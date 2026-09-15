import { defineConfig } from "vitest/config";

/**
 * Vitest config for @zhushanwen/zcode-subagent-cli.
 *
 * 照 AGENTS.md 测试纪律（W5 任务书：新包 vitest 配置带 junit reporter + fs-guard）：
 * - junit reporter 落盘用例级耗时（test-results/ 已 gitignore）；
 * - globalSetup 把 TAIJI_AGENT_DATA_DIR 重定向 tmp + 注入真实目录时 fail-fast；
 * - setupFiles 挂 fs-guard 切面（破坏性 fs 操作白名单外抛错）。
 * 两者均复制自 subagent-engine-sdk test/（同源于 runtime 防线，[HISTORICAL]
 * 2026-09-02 会话丢失事故双层防线）。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // live 真机测试仅在 TAIJI_ZCODE_LIVE=1 时真正执行（随迁原 core 侧口径）
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/fs-guard.ts"],
    reporters: ["default", "junit"],
    outputFile: {
      junit: "./test-results/vitest-junit.xml",
    },
  },
});
