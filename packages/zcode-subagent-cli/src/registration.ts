// src/registration.ts
//
// zcode 引擎构造入口（W5 迁移承接，原 core engines/zcode/registration.ts）。
//
// 与 core 版差异（登记）：core 版把 'zcode' 登记进 core 进程内 registry
// （registerEngine + getEngineDataDir）；引擎包是独立 CLI 进程，无 core registry 可
// 登记——发现与装载走 package.json manifest（taiji.subagentEngine 节点）+ 宿主
// 侧发现器（W4 engine-discovery），本文件只剩「构造 + engineDataDir 解析」组合根。
//
// engineDataDir 通道：SDK resolveEngineDataDir（env TAIJI_AGENT_DATA_DIR，宿主
// buildEngineChildEnv L0 注入 → 缺失即显式报错——不再回退 piAgentDir，引擎进程内
// 无 pi 语义可回退）。组合根可显式传 getter 覆盖（测试 / 宿主 DI）。

import { resolveEngineDataDir } from "@zhushanwen/subagent-engine-sdk";

import { ZcodeEngine } from "./zcode-engine.ts";
import type { ZcodeEngineDeps } from "./zcode-engine.ts";

export { ZCODE_ADAPTER_VERSION, ZCODE_ENGINE_ID } from "./constants.ts";
export { ZcodeEngine } from "./zcode-engine.ts";
export type { ZcodeEngineDeps } from "./zcode-engine.ts";

/** 引擎数据根缺省解析（env 权威通道；见文件头）。 */
export function defaultEngineDataDir(): string {
  return resolveEngineDataDir(process.env);
}

/** 构造 ZcodeEngine（DI 工厂——测试/宿主注入 deps）。 */
export function createZcodeEngine(deps: ZcodeEngineDeps): ZcodeEngine {
  return new ZcodeEngine(deps);
}

/**
 * 缺省 deps 组合：engineDataDir 走 env 解析，cliPath 支持 TAIJI_ZCODE_CLI 覆盖
 * （spawn-env-contract 出站白名单既有条目，随包迁移锚点改指本包——W12 回写项）。
 */
export function createDefaultZcodeEngine(): ZcodeEngine {
  return createZcodeEngine({
    engineDataDir: defaultEngineDataDir,
    ...(process.env["TAIJI_ZCODE_CLI"] !== undefined ? { cliPath: process.env["TAIJI_ZCODE_CLI"] } : {}),
  });
}
