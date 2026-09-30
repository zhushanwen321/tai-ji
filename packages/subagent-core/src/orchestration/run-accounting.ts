// src/orchestration/run-accounting.ts
//
// [§2.1b 会计重建] run 计数的**帧推导单源**：从 record 事件流算 budget 会计三值。
//
// 背景：run 的活体预算累计在 `Budget`（`consume` 每次尝试 + `incrementCallCount` 每次
// 派发），但 record 流只承载 `agent-settled` 帧的 `result.usage`——重启/resume 重建面
// 此前一律 `new Budget()` 归零，展示层因此把「重启后」显示成 0 消耗。本函数给重建面
// 一个统一的帧推导口径：
//   - usedTokens / usedCost：对 `agent-settled.result.usage` 走 `Budget.consume` 的
//     **同一加权口径**（input*1 + output*2 + cacheRead*0.02 + cacheWrite*0），避免第二
//     套折算公式；
//   - callCount：`agent-settled` 帧计数（= 派发调用数）。
//
// **精度边界（必须知道）**：这是**下界近似**——中间失败尝试的消耗不进事件流
//（`agent-retrying` 不载 usage），而活体 `consume` 是每次尝试都累加；此外两条
// 「写了 settled 帧但不 incrementCallCount」的路径会让帧计数略大于活体值。要精确只能
// 改介质（给 `agent-retrying` 加 usage 字段），属 ADR 级变更。
//
// 与 v2 终态条目的关系：条目带活体口径的 `usedTokens`/`callCount`（写点取
// `state.budget.usedTokens`），**有真值时优先用条目**，本函数只作条目缺席时的兜底。
//
// errorLogs 已由 worker-log 诊断帧持久化（[ADR-0093]）——重建走 run-events 的
// errorLogsFromEvents，本模块只管会计口径；
// 这是明确接受的已知形态，不是遗漏。
import { Budget } from "./models/budget.ts";
import type { WorkflowRunEvent } from "./run-events.ts";

/**
 * 帧推导会计（下界近似，见文件头「精度边界」）。纯函数，不改任何状态。
 *
 * 返回形状就地声明（不立具名接口）：唯一消费面是本文件与三处重建调用点，无第二实现，
 * 具名接口只会多一层需要维护的间接。
 */
export function runAccountingFromEvents(
  events: readonly WorkflowRunEvent[],
): { usedTokens: number; usedCost: number; callCount: number } {
  const budget = new Budget();
  for (const event of events) {
    if (event.type !== "agent-settled") continue;
    budget.incrementCallCount();
    if (event.result?.usage !== undefined) budget.consume(event.result.usage);
  }
  return { usedTokens: budget.usedTokens, usedCost: budget.usedCost, callCount: budget.totalCallCount };
}

/**
 * 重建面预算构造：条目真值优先，缺席回落帧推导。
 *
 * @param settled v2 终态条目（`usedTokens > 0` 时视为真值；0 = 条目来自旧版本写点或
 *                无消耗 run，此时帧推导同样给出 0，不会劣化）
 * @param events record 事件流
 * @param maxTimeMs 生效墙钟预算（resume 重建面传；fresh 折叠面不传）
 * @param maxTokens 生效 token 预算（resume 重建面传，与 maxTimeMs 同款条件式；
 *                fresh 折叠面不传——壳侧折叠的预算上限挂 spec 不挂 budget）
 */
export function rebuildBudget(
  settled: { usedTokens: number; callCount: number } | undefined,
  events: readonly WorkflowRunEvent[],
  maxTimeMs?: number,
  maxTokens?: number,
): Budget {
  const base = {
    ...(maxTimeMs !== undefined && maxTimeMs > 0 ? { maxTimeMs } : {}),
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
  };
  if (settled !== undefined && settled.usedTokens > 0) {
    // 条目口径是活体真值；usedCost 条目不存 → 明确置 0（不假装精确）
    return new Budget({ ...base, usedTokens: settled.usedTokens, totalCallCount: settled.callCount });
  }
  const accounting = runAccountingFromEvents(events);
  return new Budget({
    ...base,
    usedTokens: accounting.usedTokens,
    usedCost: accounting.usedCost,
    totalCallCount: accounting.callCount,
  });
}
