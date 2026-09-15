// src/execution/persistence/sync-rebuild.ts
//
// 批闭合 flush（S11 兜底）的 BgNotifyRecord → SubagentRecord 映射，自 subagent-service
// 拆出（D4 按变化轴拆分）。纯映射——零 service/store 依赖，rootSessionId 由调用方注入。
// [modeless 波3] 旧 syncRebuildToNotifyMember（E1 恢复批补发映射）随 E1 恢复面退役删除。

import type { BgNotifyRecord } from "../notify/notifier.ts";
import type { SubagentRecord } from "../assembly/types.ts";

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
    patchFile: m.patchFile,
  };
}
