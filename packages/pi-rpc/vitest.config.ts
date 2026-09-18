import { taijiTestConfig } from "../../test-guard/factory.ts";

/**
 * Vitest config for @zhushanwen/pi-rpc.
 *
 * 按 AGENTS.md 测试纪律（pi-subagent-cli / subagent-engine-sdk 同款）：
 * - junit reporter 落盘用例级耗时（test-results/ 已 gitignore）；
 * 防线经仓库根 test-guard/factory 统一注入（taijiTestConfig），[HISTORICAL]
 * 2026-09-02 会话丢失事故双层防线 + 2026-09-16 prod 数据目录删除事故升级为仓库级强制。
 * 本包源码是纯函数 + PassThrough 流测试（常态零 fs 触碰），防线是结构性
 * 兜底（防未来测试误删）。
 */
export default taijiTestConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
