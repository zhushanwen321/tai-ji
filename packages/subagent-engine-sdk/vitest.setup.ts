// vitest.setup.ts
//
// 全局测试 env 净化（对齐 subagent-core vitest.setup.ts 范式）。
//
// 本包测试对 env 的语义基线是「未设」：data-dir.test.ts 断言 resolveEngineDataDir
// 的 env 优先 / 注入回退 / 缺失报错三态，宿主 shell export TAIJI_AGENT_DATA_DIR（或
// globalSetup 注入的 tmp 路径——见下）会让「env 未设」分支假红。setupFiles 在每个
// 测试文件的模块加载前运行，用例内 stubEnv 前先净化，一次根治。
//
// 注意 global-setup.ts 已把 TAIJI_AGENT_DATA_DIR 指向测试 tmp（结构性防线，不删）——
// 「env 缺失报错」分支的用例用 vi.stubEnv/删除属性在用例内构造，不依赖进程 env 基线。
// 本净化补的是宿主链路泄漏类（zcode 引擎 ZCODE_ENG_* 家族，对齐 core setup 同款前缀），
// 防止宿主 shell export 造成的缺失前置假红。
const HOST_CHAIN_ENV_PREFIXES = ["ZCODE_ENG_", "TAIJI_ZCODE_", "TAIJI_ENGINE_"] as const;

for (const prefix of HOST_CHAIN_ENV_PREFIXES) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(prefix)) delete process.env[key];
  }
}
