// vitest.setup.ts
//
// 全局测试 env 净化（F-R5）。
//
// 背景：watchdog 三 env 是「宿主侧 opt-in 兜底」配置，测试的默认语义基线是
// 「未设」——宿主 shell export（如 TAIJI_SUBAGENT_SPAWN_WATCHDOG_MS=1000）会让
// 依赖未设基线的用例假红。此前仅 4 个测试文件各自 beforeEach 净化，30+ runSpawn
// 测试族仍有缺口；setupFiles 在每个测试文件的模块加载前运行，一次根治。
//
// 与既有 4 文件的 beforeEach vi.stubEnv 不冲突：stubEnv 栈叠加——本净化先删，
// 用例内 stubEnv 捕获的原始值为 undefined，afterEach unstubAllEnvs 恢复后仍是
// 「未设」状态，语义一致。
//
// 字面量与 SSOT 常量对应（四处分属不同模块，setup 在模块加载前运行，不 import
// 源码模块以避免拖入运行时副作用）：
// - TAIJI_SUBAGENT_SPAWN_WATCHDOG_MS = session-runner.ts SPAWN_WATCHDOG_ENV
// - TAIJI_SUBAGENT_RUN_WATCHDOG_MS   = launcher.ts RUN_WATCHDOG_ENV
// - TAIJI_SUBAGENT_IDLE_TIMEOUT_MS   = lifecycle-manager.ts IDLE_TIMEOUT_ENV
// - TAIJI_SUBAGENT_STATE_MAX_RUNS    = jsonl-run-store.ts STATE_MAX_RUNS_ENV
//   （B1 磁盘保留清理，非 watchdog 但同为「默认关、显式设置才启用」的 opt-in
//   配置，测试默认语义基线同样是「未设」，故并入同一净化）
const WATCHDOG_ENV_KEYS = [
  "TAIJI_SUBAGENT_SPAWN_WATCHDOG_MS",
  "TAIJI_SUBAGENT_RUN_WATCHDOG_MS",
  "TAIJI_SUBAGENT_IDLE_TIMEOUT_MS",
  "TAIJI_SUBAGENT_STATE_MAX_RUNS",
] as const;

for (const key of WATCHDOG_ENV_KEYS) {
  delete process.env[key];
}
