// src/core/path-encoding.ts
//
// cwd → 安全目录名的编码逻辑。Core 叶子原语（零依赖）。
//
// 被 session-runner（subagent session 持久化目录）与 session-file-gc（清理过期
// session 文件）共用——两处需要相同的编码，否则同一 cwd 会落到两个不同目录。

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
 * docs/constraints.json C-ext-21，设计依据 rename-session-three-modes.md §3.3 D7。
 *
 * D-004: 用主 cwd 编码——保证同一主 cwd 下所有 subagent 的 session 文件
 * 存放在同一目录，便于 session-file-gc 统一清理。
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
 * D-004 同源：用主 cwd 编码做物理隔离，使 session-file-gc 按 <enc>/records/ 子目录
 * 匹配 manifest .json 时天然限定在当前 cwd 范围内，不会越界清理其他 cwd 的 manifest。
 *
 * @param agentDir agent 配置目录（如 ~/.pi/agent）
 * @param mainCwd 树根主 agent 的工作目录（非 subagent 的 effectiveCwd；worktree 模式下
 *   是 ROOT 的 cwd，不是 checkout 路径）
 * @returns records 持久化目录绝对路径
 */
export function getSubagentRecordsDir(agentDir: string, mainCwd: string): string {
  return path.join(agentDir, "subagents", encodeCwd(mainCwd), "records");
}
