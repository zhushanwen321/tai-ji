// src/core/path-encoding.ts
//
// subagent 文件族（sessions / records / model-switch）的目录推导。
//
// [session-store-layout-inversion D2/D3] 分区键 = rootSessionId（ExecutionRecord 自带
// 字段，record-model.ts；嵌套派发全层同值——子进程经 PI_SUBAGENT_ROOT_SESSION_ID env
// 贯穿拿到真 ROOT sid）。落点 = session 存储树内 `<root>/<rootSessionId>/subagents/`
// （<root> = shared getSessionStoreDir，即 `<dataDir>/ext-sessions/`）——目录绑定
// session 生命周期，删除随整树回收。旧布局 `<agentDir>/subagents/<encodeCwd>/`
// （cwd 分区）已退役，存量不迁移（设计裁决 11）。
//
// 公式消费 shared 新函数族（subagent-core 直接 import @taiji/shared，非镜像场景；
// shared getDataDir 读 TAIJI_AGENT_DATA_DIR，taiji 生产链经 ENV_WHITELIST_PREFIXES
// 注入 pi/引擎进程，裸跑落缺省 dev 树）。encodeCwd 分区键随 D3 消除，本文件不再
// 持有编码逻辑（runtime pi-paths 的 encodeCwd re-export 源头在 shared）。

import {
  getSessionSubagentMessageDir,
  getSessionSubagentModelSwitchDir,
  getSessionSubagentRecordsDir,
  getSessionSubagentSessionsDir,
} from "@taiji/shared/paths";

/**
 * 获取 subagent session 持久化目录路径。
 *
 * `<root>/<rootSessionId>/subagents/sessions/`——子代理会话 jsonl 本体（pi 经
 * `--session-dir` 写入）与 worktree `.patch` 备份（worktree-patch-collection 落盘）
 * 同目录。
 *
 * C-ext-21（跨包隐式契约）：本函数产出的 `subagents/sessions` 路径形态被
 * extensions/universal/rename-session/src/llm.ts 的 isSubagentSession 嗅探
 * （路径含 `<sep>subagents<sep>` 段 → 判为 subagent 会话并跳过重命名）——改本布局
 * （移动/改名 subagents 段）必须同步该嗅探逻辑，反之亦然；约束登记见
 * docs/constraints.json C-ext-21。
 *
 * @param rootSessionId 根会话 id（分区键；同域校验由 shared 层承担，非法 throw）
 * @param dataDir 可选数据根目录（测试注入）；缺省读 shared getDataDir()
 * @returns session 持久化目录绝对路径
 */
export function getSubagentSessionDir(rootSessionId: string, dataDir?: string): string {
  return getSessionSubagentSessionsDir(rootSessionId, dataDir);
}

/**
 * 获取 subagent records（manifest）持久化目录路径。
 *
 * 与 getSubagentSessionDir 同分区键（rootSessionId），保证 records 与 sessions 在
 * 同一棵会话树内物理相邻（随整树同生共死）。
 *
 * @param rootSessionId 根会话 id（与 getSubagentSessionDir 同一取值——record 的
 *   rootSessionId 字段 / env 贯穿值；两目录必须同树，否则 GC/重建互相找不到）
 * @param dataDir 可选数据根目录（测试注入）；缺省读 shared getDataDir()
 * @returns records 持久化目录绝对路径
 */
export function getSubagentRecordsDir(rootSessionId: string, dataDir?: string): string {
  return getSessionSubagentRecordsDir(rootSessionId, dataDir);
}

/**
 * 获取 subagent 模型切换请求结果目录（subagent-model-switch §7.1.1 通道回执载体）。
 *
 * 布局 = `<root>/<rootSessionId>/subagents/model-switch/`——与 records/sessions 同
 * 会话树分区。extension（/subagent-model 命令写入侧）与 runtime
 * （SubagentModelSwitchGateway 读取侧）两侧 import 本单源，路径同源性由结构保证
 * （与 records 通道同款理由）。文件形态 = `<requestId>.json`，请求作用域生命周期
 * （写后读、读后即删，§7.1.1 要素 4）。
 *
 * @param rootSessionId 根会话 id（写侧 = 宿主进程当前 session id；读侧 = 目标会话 id）
 * @param dataDir 可选数据根目录（测试注入）；缺省读 shared getDataDir()
 * @returns 模型切换结果目录绝对路径
 */
export function getSubagentModelSwitchResultsDir(rootSessionId: string, dataDir?: string): string {
  return getSessionSubagentModelSwitchDir(rootSessionId, dataDir);
}

/**
 * 获取 subagent 定向消息请求结果目录（subagent-composer 2026-10-18，通道回执载体——
 * /subagent-model 结果文件同款机制：client.prompt 对命令 handler 异常不拒绝（真机实测），
 * 失败必须经请求作用域结果文件传回）。
 *
 * 与 getSubagentRecordsDir 同分区键（rootSessionId），保证 message 回执与 records 在
 * 同一棵会话树内物理相邻（随整树同生共死——旧 (agentDir, mainCwd) 键随 D3 消除，
 * 回执文件落 agentDir 会成为树删后的孤儿）。extension（/subagents message 写入侧）
 * 与 runtime（session-records 读取侧）两侧 import 本单源，路径同源性由结构保证。
 * 文件形态 = `<requestId>.json`，请求作用域生命周期（写后读、读后即删）。
 *
 * @param rootSessionId 根会话 id（写侧 = 宿主进程 resolveRootSessionId；读侧 = 当前会话 id）
 * @param dataDir 可选数据根目录（测试注入）；缺省读 shared getDataDir()
 * @returns 定向消息结果目录绝对路径
 */
export function getSubagentMessageResultsDir(rootSessionId: string, dataDir?: string): string {
  return getSessionSubagentMessageDir(rootSessionId, dataDir);
}
