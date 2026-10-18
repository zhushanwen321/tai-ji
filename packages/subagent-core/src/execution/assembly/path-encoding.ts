// src/core/path-encoding.ts
//
// cwd → 安全目录名的编码逻辑。Core 叶子原语（零依赖）。
//
// 被 session-runner（subagent session 持久化目录）与 runtime 删会话级联
// （session-content-cascade 的族枚举按同一 <enc> 布局寻址）等消费方共用——
// 编码漂移会让同一 cwd 落到两个不同目录。

import * as path from "node:path";

/**
 * cwd → 安全目录名。复用 Pi SDK getDefaultSessionDir 的编码逻辑：
 * 去开头单个分隔符，全量替换剩余分隔符/冒号为 `-`，首尾补 `--`。
 * 例：`/Users/x/proj` → `--Users-x-proj--`。
 */
export function encodeCwd(cwd: string): string {
  return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}

/**
 * 获取 subagent session 持久化目录路径。
 *
 * C-ext-21（跨包隐式契约）：本函数产出的 `subagents/<enc>/sessions` 路径形态被
 * extensions/universal/rename-session/src/llm.ts 的 isSubagentSession 嗅探
 * （路径含 `<sep>subagents<sep>` 段 → 判为 subagent 会话并跳过重命名）——改本布局
 * （移动/改名 subagents 段）必须同步该嗅探逻辑，反之亦然；约束登记见
 * docs/constraints.json C-ext-21。
 *
 * D-004: 用主 cwd 编码——保证同一主 cwd 下所有 subagent 的 session 文件
 * 存放在同一目录（enc 段不变量：磁盘重建扫描与删会话级联枚举都依赖它）。
 * [MF-3] worktree 模式下调用方必须传树根 cwd（ROOT mainCwd，经 PI_SUBAGENT_ROOT_CWD
 * 贯穿），不能传子进程自身的 checkout 路径——否则深层 record 落盘到 enc(worktree) 段，
 * ROOT 磁盘重建扫不到（全树可见性断裂）。根进程传自身 cwd（行为不变）。
 *
 * @param agentDir agent 配置目录（如 ~/.pi/agent）
 * @param mainCwd 树根主 agent 的工作目录（非 subagent 的 effectiveCwd；worktree 模式下
 *   是 ROOT 的 cwd，不是 checkout 路径）
 * @returns session 持久化目录绝对路径
 */
export function getSubagentSessionDir(agentDir: string, mainCwd: string): string {
  // [MF#1] 保持既有布局 subagents/<enc>/sessions/——曾改为 subagents/sessions/<enc>/ 会让
  // 升级用户的既有 session 文件全部落到扫描目录外（历史记录消失 + GC 扫不到，双重 orphan）。
  // 本分支未发布，回退到既有布局即无需迁移、无数据丢失。
  return path.join(agentDir, "subagents", encodeCwd(mainCwd), "sessions");
}

/**
 * 获取 subagent records（manifest）持久化目录路径。
 *
 * 与 getSubagentSessionDir 同用 encodeCwd(mainCwd)，保证 records 与 sessions 在同一
 * <enc> 段下物理相邻。
 * [MF-3] 调用方必须与 getSubagentSessionDir 传同一编码键（进程内 init.cwd /
 * buildSessionRunnerContext.mainCwd / record.worktreeHandle.mainCwd 恒等；worktree 模式
 * 跨进程时统一用贯穿的 ROOT cwd）——sessions 与 records 两套目录同段，GC/重建才不会
 * 互相找不到（enc 段不变量）。
 *
 * D-004 同源：用主 cwd 编码做物理隔离，使删主会话级联（runtime
 * session-content-cascade）按 <enc>/records/ 子目录匹配 manifest .json 时天然限定在
 * 当前 cwd 范围内，不会越界删除其他 cwd 的 manifest。
 *
 * @param agentDir agent 配置目录（如 ~/.pi/agent）
 * @param mainCwd 树根主 agent 的工作目录（非 subagent 的 effectiveCwd；worktree 模式下
 *   是 ROOT 的 cwd，不是 checkout 路径）
 * @returns records 持久化目录绝对路径
 */
export function getSubagentRecordsDir(agentDir: string, mainCwd: string): string {
  return path.join(agentDir, "subagents", encodeCwd(mainCwd), "records");
}

/**
 * 获取 subagent 模型切换请求结果目录（subagent-model-switch §7.1.1 通道回执载体）。
 *
 * 布局 = `<subagent 数据根>/model-switch/`——数据根与 getSubagentRecordsDir 同族
 * （同 (agentDir, mainCwd) 入参、同 enc 段），extension（/subagent-model 命令写入侧）
 * 与 runtime（SubagentModelSwitchGateway 读取侧）两侧 import 本单源，路径同源性由
 * 结构保证（与 records 通道同款理由）。文件形态 = `<requestId>.json`，请求作用域
 * 生命周期（写后读、读后即删，§7.1.1 要素 4）。
 *
 * @param agentDir agent 配置目录（如 ~/.pi/agent）
 * @param mainCwd 树根主 agent 的工作目录（与 getSubagentRecordsDir 同一编码键）
 * @returns 模型切换结果目录绝对路径
 */
export function getSubagentModelSwitchResultsDir(agentDir: string, mainCwd: string): string {
  return path.join(agentDir, "subagents", encodeCwd(mainCwd), "model-switch");
}

/**
 * 获取 subagent 定向消息请求结果目录（subagent-composer 2026-10-18，通道回执载体——
 * /subagent-model 结果文件同款机制：client.prompt 对命令 handler 异常不拒绝（真机实测），
 * 失败必须经请求作用域结果文件传回）。布局 = `<subagent 数据根>/message/`，数据根与
 * getSubagentRecordsDir 同族（同 (agentDir, mainCwd) 入参、同 enc 段），extension
 * （/subagents message 写入侧）与 runtime（session-records 读取侧）两侧 import 本单源。
 * 文件形态 = `<requestId>.json`，请求作用域生命周期（写后读、读后即删）。
 *
 * @param agentDir agent 配置目录（如 ~/.pi/agent）
 * @param mainCwd 树根主 agent 的工作目录（与 getSubagentRecordsDir 同一编码键）
 * @returns 定向消息结果目录绝对路径
 */
export function getSubagentMessageResultsDir(agentDir: string, mainCwd: string): string {
  return path.join(agentDir, "subagents", encodeCwd(mainCwd), "message");
}
