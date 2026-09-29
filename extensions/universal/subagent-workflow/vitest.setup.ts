// vitest.setup.ts
//
// 全局测试 env 净化（F-R5）+ 测试宿主装配（F-R6）。
//
// 背景：watchdog 类 env 是「宿主侧 opt-in 兜底」配置，测试的默认语义基线是
// 「未设」——宿主 shell export（如 TAIJI_SUBAGENT_IDLE_TIMEOUT_MS=1000）会让
// 依赖未设基线的用例假红。此前仅 4 个测试文件各自 beforeEach 净化，30+ runSpawn
// 测试族仍有缺口；setupFiles 在每个测试文件的模块加载前运行，一次根治。
//
// 与既有 4 文件的 beforeEach vi.stubEnv 不冲突：stubEnv 栈叠加——本净化先删，
// 用例内 stubEnv 捕获的原始值为 undefined，afterEach unstubAllEnvs 恢复后仍是
// 「未设」状态，语义一致。
//
// 字面量与 SSOT 常量对应（分属不同模块，setup 在模块加载前运行，不 import
// 源码模块以避免拖入运行时副作用）：
// - TAIJI_SUBAGENT_IDLE_TIMEOUT_MS   = lifecycle-manager.ts（裸字面量，包内无 env 名常量）

import os from "node:os";
import path from "node:path";

import { configureCore } from "../../../packages/subagent-core/src/core/host-services.ts";

const WATCHDOG_ENV_KEYS = [
  "TAIJI_SUBAGENT_IDLE_TIMEOUT_MS",
] as const;

for (const key of WATCHDOG_ENV_KEYS) {
  delete process.env[key];
}

// F-R6 测试宿主装配：subagent-core 的 logger facade 经 host-services 配置态解析，
// 未 configureCore 时 warn/error 落 NULL_HOST 缺省 console（`[subagents]` 前缀裸打
// stderr——如 notify-ledger 的 delivery bucket 日志）。多包连跑高负载下，这些
// console 输出经 vitest worker RPC（onUserConsoleLog）与 worker teardown 竞态会
// 随机触发 EnvironmentTeardownError（coverage-gate.py 已登记的已知竞态形态）。
// 此处统一装配 no-op log host：测试不依赖产品日志的 console 出口（日志断言面
// 一律 mock logger），消除 stderr 噪音与竞态载荷。setupFiles 每测试文件模块
// 加载前运行，模块 slot 逐文件重置，无跨文件泄漏。
configureCore({
  dataRoot: () => path.join(os.tmpdir(), "subagent-workflow-tests"),
  log: () => {},
});

