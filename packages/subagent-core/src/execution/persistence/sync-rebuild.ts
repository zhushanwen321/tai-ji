// src/execution/persistence/sync-rebuild.ts
//
// [E1 恢复批语义修复] sync 批崩溃恢复（E1）与批闭合 flush（S11 兜底）的两条
// BgNotifyRecord/SubagentRecord 映射，从 subagent-service 拆出（D4 按变化轴拆分：
// 改恢复批的通知语义 / 落标数据源形态，只改本文件）。两函数均纯映射——零 service/
// store 依赖，rootSessionId 由调用方注入。

import { deriveOutcome } from "./execution-record.ts";
import type { BgNotifyRecord } from "../notify/notifier.ts";
import type { SubagentRecord } from "../assembly/types.ts";

/**
 * E1 末条 entry 终态快照 → BgNotifyRecord（补发成员；sync 仅 one-shot，round/
 * sessionFile 不透传——与 route() 缓冲快照的 one-shot 形态对齐）。
 *
 * [E1 恢复批语义修复] status/outcome/patchFile 三点对齐 notify-host toNotifyRecord
 * 的映射（正常 flush 路径对同一成员的补发形态），不再直通 rec.status：
 * - status：one-shot 成功成员崩溃时末条 entry 为轮终收口形态（桥接期 running+resumable
 *   / [two-state-convergence U4] 翻边后 idle——E1 判据 isCollectPending 双形态兼容，
 *   两形态均放行入批）——直通会让补发记录仍是收口前形态：
 *   buildBatchLlmContent 批头只统计 closed 成员（全员成功的恢复批显示
 *   「0 finished, 0 failed, 0 cancelled」），条目文案落「finished a round」
 *   （对话轮次语义）。同 toNotifyRecord：closed 或非 chatMode → "closed"（仅
 *   chatMode 轮次形态保持 running——sync 成员恒 one-shot，此分支为防御完整性）。
 * - outcome：closed 状态物化（单一权威 deriveOutcome）——resumable 成员末条未
 *   终态化，closedReason 缺省与正常 flush 路径同形，无 error 即 completed、有
 *   error 即 failed；notifier.notifyBatch 投影边界的 `??` 兜底对此幂等。
 * - patchFile：透传（依赖 rebuildEntryRecord 的同名投影）——worktree one-shot
 *   成员的 git-apply 回收指针只在 closed+completed 分支文案携带（running 分支
 *   不含），正常 flush 路径经 toNotifyRecord 特意携带，恢复批不得缺失。
 */
export function syncRebuildToNotifyMember(rec: SubagentRecord): BgNotifyRecord {
  // [U2 桥接判据] 旧「closed 终态」读形态 ⟺ idle ∧ closedReason 有值（两态迁移不变量）。
  const status: BgNotifyRecord["status"] =
    (rec.status === "idle" && rec.closedReason !== undefined) || !rec.chatMode
      ? "closed"
      : "running";
  return {
    id: rec.id,
    status,
    closedReason: rec.closedReason,
    outcome: status === "closed" ? deriveOutcome(rec.closedReason, rec.error) : undefined,
    agent: rec.agent,
    model: rec.model,
    result: rec.result,
    error: rec.error,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    patchFile: rec.patchFile,
  };
}

/**
 * [S11] getFullRecord miss 成员的缓冲快照兜底 → 最小 SubagentRecord（batchFinalized
 * 落标数据源）。getFullRecord 不可达（子 session 文件缺失/已 GC）时，缓冲的
 * BgNotifyRecord 是该成员唯一残存数据。最小形态只保标记链路必需字段：
 * id/agent/task/startedAt 是 rebuildEntryRecord 的解析门槛（缺 task 的 entry 会被
 * E1 扫描判损坏跳过——标记失效方向，task 占位空串保 entry 可解析）；终态字段
 * （closedReason/result/error/endedAt/model/patchFile）自缓冲快照如实投影；
 * rootSessionId 取当前 session 根（E1 候选过滤的归属口径）。
 */
export function bufferedMemberFallbackRecord(
  m: BgNotifyRecord,
  rootSessionId: string | undefined,
): SubagentRecord {
  return {
    id: m.id,
    agent: m.agent,
    task: "",
    slug: "",
    // [U2 两态桥接] 旧终态形态落 idle + closedReason 兜底 disconnected（桥接不变量：
    // idle ∧ closedReason 有值 ⟺ 旧 closed；BgNotifyRecord 无 closedReason 时兜底
    // disconnected——「已收口但死因不可考」的既有读侧兜底语义）。
    status: "idle",
    closedReason: m.closedReason ?? "disconnected",
    stopReason: m.closedReason ?? "disconnected",
    mode: "background",
    startedAt: m.startedAt,
    rootSessionId,
    parentRecordId: undefined,
    depth: 0,
    endedAt: m.endedAt,
    turns: 0,
    totalTokens: 0,
    model: m.model ?? "",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    result: m.result,
    error: m.error,
    sessionFile: undefined,
    chatMode: false,
    patchFile: m.patchFile,
  };
}
