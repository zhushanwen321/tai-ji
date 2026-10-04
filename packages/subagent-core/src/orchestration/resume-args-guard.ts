// src/orchestration/resume-args-guard.ts
//
// [§2.5 D14 下沉] resume 的 args 一致性判定（单源，core 侧）。
//
// 为什么在 core：这段判定是 run 领域规则（「resume 重放同一意图」），原先完整实现在
// 壳（`extensions/universal/subagent-workflow/src/interface/tool-workflow.ts` 的
// readHistoricalArgs / diffResumeArgs / 三套拒绝文案），并自带一份 record 流 JSONL
// 解析——与 core 的严格读面构成第三份平行读实现。落点选 core 的资格段：那里**已经
// 读到 run-created 事件**（`assertResumeEligibility`），判定所需数据在手上，不需要
// 新的端口原语，也不需要壳再读文件（壳只把 args 与 journalDir 传下来）。
//
// 分层：本文件是纯判定（无 IO、无状态）。历史 args 的唯一数据源是 run-created 事件
// 载荷（args 全文优先；旧格式帧回落 argsSummary 截断摘要 → 保守拒绝）。判定结果经
// 调用方注入的 reject 工厂抛出，错误类型归调用方（core 恢复读面用
// ResumeRejectionError，保持错误族单一）。
import type { WorkflowRunEvent } from "./run-events.ts";

/**
 * D14 比对排除键：rfl 仪表向 spec.args 原地注入的稳定 `_runId`（lifecycle
 * runWorkflow 注入面）——run 派发的机器字段，不属用户意图，比对前双侧剔除。
 */
const RESUME_ARGS_EXCLUDED_KEY = "_runId";

/** run-created 帧的 args 读取结果（D14 比对的数据源形态）。 */
export type HistoricalArgs =
  | { kind: "args"; args: Record<string, unknown> }
  | { kind: "absent" }
  | { kind: "truncated" };

/** plain object 判定（数组/null 排除——数组按值比、不递归键差）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 「args 被篡改/流损坏」的拒绝文案（与下方 parsed 分支同构，函数级单源）。 */
function malformedArgsMessage(runId: string): string {
  return (
    `Resume rejected: original args of run ${runId} are malformed in its record stream — ` +
    "the record stream is the sole source of truth. Recovery: inspect the record file for external edits; " +
    "if unrepairable, start a new run."
  );
}

/**
 * run-created 事件 → D14 数据源形态。
 *
 * - args 全文优先（现行写入面 `dispatchRunCreated` 随帧落全文，任意体积的 args 都可
 *   逐字段深度比对）；
 * - 无 run-created 事件 / 帧内既无 args 也无 argsSummary → absent：**不在 D14 层拒绝**
 *   ——资格判据归 resumeRun 自己的权威文案（分层：D14 只管 args 一致性）；
 * - 旧格式帧回落 argsSummary（截断标记「…」尾）→ truncated：截断摘要无法逐字段比对，
 *   保守拒绝（静默放行 = 静默忽略传入 args，D14 不采用该形态）；
 * - 篡改/损坏（args 非 plain object，或未截断摘要解析失败/非对象）→ throw：
 *   argsSummary 是 JSON.stringify 产物，未截断必可解析——不可解析 = 流被篡改或写入
 *   器 bug（对齐 D12 拒绝精神，不透出裸 SyntaxError）。
 */
export function historicalArgsOf(
  runId: string,
  created: Extract<WorkflowRunEvent, { type: "run-created" }> | undefined,
): HistoricalArgs {
  if (created === undefined) return { kind: "absent" };
  const raw = created.args;
  if (raw !== undefined) {
    if (isPlainObject(raw)) return { kind: "args", args: raw };
    throw new Error(malformedArgsMessage(runId));
  }
  const summary = created.argsSummary;
  if (typeof summary !== "string" || summary.length === 0) return { kind: "absent" };
  if (summary.endsWith("…")) return { kind: "truncated" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(summary);
  } catch {
    throw new Error(malformedArgsMessage(runId));
  }
  if (!isPlainObject(parsed)) throw new Error(malformedArgsMessage(runId));
  return { kind: "args", args: parsed };
}

/**
 * 逐字段深度比对（D14）——返回差异字段描述列表（空 = 一致）。
 *
 * 差异三形态：仅 resume 侧有（unexpected）/ 仅原 run 侧有（missing）/ 值不等
 * （mismatch）。嵌套 plain object 递归比对（路径 `a.b` 形态）；数组与原始值按
 * JSON 值比。值展示用 JSON.stringify（函数/undefined 等不可序列化形态按原样）。
 */
export function diffResumeArgs(
  incoming: Record<string, unknown>,
  historical: Record<string, unknown>,
): string[] {
  return diffPlainObject(incoming, historical).map((d) => `args.${d}`);
}

/** diffResumeArgs 的递归体（裸键路径，`a.b` 形态——前缀由公开包装统一添加）。 */
function diffPlainObject(
  incoming: Record<string, unknown>,
  historical: Record<string, unknown>,
): string[] {
  const diffs: string[] = [];
  const keys = new Set([...Object.keys(incoming), ...Object.keys(historical)]);
  keys.delete(RESUME_ARGS_EXCLUDED_KEY);
  for (const key of [...keys].sort()) {
    const hasIn = Object.hasOwn(incoming, key);
    const hasHist = Object.hasOwn(historical, key);
    if (!hasIn || !hasHist) {
      const holder = hasIn
        ? "resume args only (not in original run)"
        : "original run only (missing from resume args)";
      diffs.push(`${key}: ${holder}`);
      continue;
    }
    const a = incoming[key];
    const b = historical[key];
    if (isPlainObject(a) && isPlainObject(b)) {
      diffs.push(...diffPlainObject(a, b).map((d) => `${key}.${d}`));
      continue;
    }
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    if (sa !== sb) diffs.push(`${key}: resume ${sa ?? String(a)} vs original ${sb ?? String(b)}`);
  }
  return diffs;
}

/**
 * D14 判定入口：传入 args 与 run-created 事件的历史 args 一致则返回，否则经 reject
 * 抛出（文案含差异字段与恢复动作）。
 *
 * fail-fast 语义：调用点必须在任何副作用之前（resume 的资格段）；不触 run 状态。
 */
export function assertResumeArgsMatch(
  runId: string,
  incoming: Record<string, unknown>,
  created: Extract<WorkflowRunEvent, { type: "run-created" }> | undefined,
  reject: (message: string) => Error,
): void {
  const historical = historicalArgsOf(runId, created);
  if (historical.kind === "truncated") {
    // 仅旧格式帧（args 全文载荷落地前落盘、截断摘要形态）到达此分支——现行写入面
    // 随帧落 args 全文，任意体积可逐字段比对
    throw reject(
      `Resume rejected: original args of run ${runId} exceed the record's args summary limit ` +
        "(legacy record stream without the full-args payload) — they cannot be verified field-by-field. " +
        "Recovery: start a new run for these arguments, or resume WITHOUT args knowing $ARGS will be empty " +
        "(a truncated summary cannot be reconstructed).",
    );
  }
  if (historical.kind !== "args") return; // absent：D14 层不拒绝，资格判据归 resumeRun
  const diffs = diffResumeArgs(incoming, historical.args);
  if (diffs.length === 0) return;
  throw reject(
    `Resume rejected: args for run ${runId} differ from the original run — resume replays the same intent; ` +
      `changed arguments belong to a new run. Differing fields:\n  - ${diffs.join("\n  - ")}\n` +
      "Recovery: pass the original args exactly, omit args to reuse them, or start a new run.",
  );
}
