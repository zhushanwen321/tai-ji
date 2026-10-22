// src/execution/assembly/store-base.ts
//
// session 存储树数据根解析（pi 子树唯一合法通道，C-ext-31）。
//
// 为什么不能经 @taiji/shared/paths 的 env 缺省函数（getDataDir 族）：其内置 C-proc-26
// 准入检查要求「持有 prod 数据目录值的进程必须带 TAIJI_AGENT_PACKAGED=1」，而 C-proc-09
// 出站契约恰把该变量从 pi/引擎进程剥除——打包态 taiji 里本包所在的进程（extension
// bundle / 引擎子进程）读它必抛，session_start 装配失败、subagent 全灭（2026-10-19
// 起 0.11.8/0.11.9 打包版事故；机器门禁 = scripts/bundle-extensions.mjs 扫 staged
// bundle 禁含准入检查标记）。存储树公式本体 import 自纯公式模块
// '@taiji/shared/session-store-paths'（零 env 读写），base 一律经本文件解析。
//
// base 通道 = 既有 getEngineDataDir（与 engine journal 同一通道）：显式 dataDir 优先
// → env TAIJI_AGENT_DATA_DIR（taiji 宿主注入，dev/打包两形态都恒在场）→ 宿主数据根
// （getHostServices().dataRoot()，pi 壳 = getAgentDir()——独立 pi 用户不漂目录）。

import { getEngineDataDir } from "../engine/common/data-dir.ts";

/**
 * session 存储树数据根（`<dataDir>/ext-sessions/` 的基址）。
 *
 * @param dataDir 可选数据根（测试注入 / runtime 侧显式传递时优先）
 * @returns 数据根目录绝对路径
 */
export function resolveSessionStoreBase(dataDir?: string): string {
  return dataDir ?? getEngineDataDir();
}
