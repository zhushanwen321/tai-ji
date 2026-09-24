import { taijiTestConfig } from "../../test-guard/factory.ts";

/**
 * Vitest config for @zhushanwen/pi-subagent-cli.
 *
 * 照 AGENTS.md 测试纪律（W5 任务书：新包 vitest 配置带 junit reporter + fs-guard）：
 * - junit reporter 落盘用例级耗时（test-results/ 已 gitignore）；
 * 防线经仓库根 test-guard/factory 统一注入（taijiTestConfig），[HISTORICAL]
 * 2026-09-02 会话丢失事故双层防线 + 2026-09-16 prod 数据目录删除事故升级为仓库级强制。
 */
export default taijiTestConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // 包级 env 净化：剥离宿主 ambient RELAY 五键（详见
    // src/__tests__/setup/ambient-relay-strip.setup.ts 头注——pi 子进程链宿主跑测时
    // relay 分支会绕过 PATH fixture 致 protocol e2e 族成批红）
    setupFiles: ["./src/__tests__/setup/ambient-relay-strip.setup.ts"],
    // live 真机测试仅在 TAIJI_PI_LIVE=1 时真正执行（随迁原 core 侧口径）
  },
});
