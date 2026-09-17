import { taijiTestConfig } from "../../test-guard/factory.ts";

/**
 * Vitest config for @zhushanwen/subagent-engine-sdk.
 *
 * 照 AGENTS.md 测试纪律（W1 任务书：新包自建 vitest 配置）：
 * - junit reporter 落盘用例级耗时（test-results/ 已 gitignore）；
 * 防线经仓库根 test-guard/factory 统一注入（taijiTestConfig），[HISTORICAL]
 * 2026-09-02 会话丢失事故双层防线 + 2026-09-16 prod 数据目录删除事故升级为仓库级强制。
 */
export default taijiTestConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
