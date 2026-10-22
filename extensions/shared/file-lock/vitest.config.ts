import { defaultExclude } from "vitest/config";

import { guardProjectSetup, taijiTestConfig } from "../../../test-guard/factory.ts";

/**
 * vitest 分池维护契约（两池：unit 默认轨 / integration 串行尾组），范式同
 * packages/runtime/vitest.config.ts（三池契约的完整版见该文件头）。
 *
 * 调度契约（vitest 4）：fileParallelism: false 在配置解析层强制单 worker，task
 * groups 之间严格串行——unit 组完整结束、worker 全部释放后，串行尾组文件才逐个
 * 以单 worker 执行，零时间重叠。入口命令不变（vitest run）；分组只影响调度，
 * 不影响跑哪些用例；组内用例的门控（TAIJI_TEST_INTEGRATION，SSOT =
 * test-guard/integration-gate.ts）照常生效。
 *
 * 两池分工：
 * - **unit**：除登记文件外的全部测试，保持默认满并行。本包测试面当前整体是真实
 *   fs IO（见下条），故本轨当前为零文件——新增纯逻辑（mock fs）测试文件自动落本轨。
 * - **integration**：真实 fs / 真子进程用例。本包的测试面就是跨进程 mkdir 锁的
 *   磁盘协议本身（mkdtemp 真目录 + mkdir/rmdir 真锁 + 子进程持锁），满并行下与
 *   其他包的资源竞争会放大单条耗时（CI 慢盘单条 7s+ 实录），故测试文件整体登记
 *   进串行尾组；其中跨进程子进程用例另经 describe.skipIf(!INTEGRATION_TESTS_ENABLED)
 *   门控（本地默认跳过，CI 或按改动范围触发时设 env 真跑）。
 *
 * 维护契约：
 * - 新增「真进程 / 真 IO」测试文件 → 路径加入 INTEGRATION_TESTS（该数组同时喂
 *   integration project 的 include 与 unit project 的 exclude，漏加 = 文件落回
 *   unit 满并行轨）；纯逻辑（mock fs）文件不加。
 * - 登记文件内只有部分用例需门控 → 用 describe.skipIf(!INTEGRATION_TESTS_ENABLED)
 *   包裹该用例组（用例级门控），快用例照常本地跑。
 * - 防线（globalSetup env 固定 + fs-guard 切面）经 test-guard/factory 顶层注入；
 *   projects 内 setupFiles 不继承 root 级，各 project 经 guardProjectSetup 显式挂
 *   FS_GUARD_PATH + ENV_PURITY_PATH，漏挂由 scripts/check-vitest-guard.mjs 第 5 条拦截。
 * - 本表成员须在 docs/testing/e2e-map.json 登记 R2 规则（trigger: on-diff、
 *   layer: L2、serial: true、run 命令带 TAIJI_TEST_INTEGRATION=1）；新增 / 删除
 *   成员须同 commit 更新 e2e-map.json 与 docs/TEST-STRATEGY.md「集成测试门控约定」。
 */
const INTEGRATION_TESTS = [
	"src/__tests__/file-lock.test.ts",
	"src/__tests__/lock-core.test.ts",
] as const;

export default taijiTestConfig({
	test: {
		projects: [
			{
				// unit 默认轨：除登记文件外全部测试，默认满并行
				test: guardProjectSetup({
					name: "unit",
					include: ["src/__tests__/**/*.test.ts"],
					exclude: [...defaultExclude, ...INTEGRATION_TESTS],
				}),
			},
			{
				// 集成串行尾组：真实 fs / 真子进程用例；组内跨进程子进程用例另经
				// TAIJI_TEST_INTEGRATION 门控（本地默认跳过）
				test: guardProjectSetup({
					name: "integration",
					include: [...INTEGRATION_TESTS],
					fileParallelism: false,
				}),
			},
		],
	},
	build: {
		target: "es2022",
	},
	esbuild: {
		target: "es2022",
	},
});
