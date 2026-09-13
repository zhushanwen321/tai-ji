import { defineConfig } from "vitest/config";

/**
 * Vitest config for @zhushanwen/pi-rpc.
 *
 * 按 AGENTS.md 测试纪律（pi-subagent-cli / subagent-engine-sdk 同款）：
 * - junit reporter 落盘用例级耗时（test-results/ 已 gitignore）；
 * - globalSetup 把 XYZ_AGENT_DATA_DIR 重定向 tmp + 注入真实目录时 fail-fast；
 * - setupFiles 挂 fs-guard 切面（破坏性 fs 操作白名单外抛错）。
 * 本包源码是纯函数 + PassThrough 流测试（常态零 fs 触碰），防线是结构性
 * 兜底（防未来测试误删），[HISTORICAL] 2026-09-02 会话丢失事故双层防线。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/fs-guard.ts"],
    reporters: ["default", "junit"],
    outputFile: {
      junit: "./test-results/vitest-junit.xml",
    },
  },
});
