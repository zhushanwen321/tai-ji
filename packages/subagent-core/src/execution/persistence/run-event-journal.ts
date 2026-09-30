// src/execution/persistence/run-event-journal.ts
//
// [D1 拆边 Class B2] run 事件 journal 的**落盘实现**（IO 边）——从
// `orchestration/run-events.ts` 迁入持久化层。
//
// 为什么搬到这里：journal 是持久化原语（写/扫/行校验），而消费它的
// `execution/persistence/run-state-evidence.ts` 等本就在本层；实现留在 orchestration
// 会迫使持久化层反向 import 编排层（execution → orchestration 值边）。搬下来后
// 方向反转：orchestration 反过来 import 本模块。
//
// 依赖方向说明：本模块对事件**载荷接口**（`WorkflowRunEvent` 一族）只做 `import type`
// ——类型边在编译期擦除，值依赖环检查（C-data-26）不看它；词表值
// （`RUN_EVENT_TYPES` / `RUN_EVENT_JOURNAL_SUFFIX`）已在 shared，不构成反向值边。
import { join } from "node:path";

import { getLogger } from "../../core/logger.ts";
import { JsonlEventJournal } from "../../shared/jsonl-event-journal.ts";
import { ALL_RUN_OUTCOMES, RUN_EVENT_JOURNAL_SUFFIX, RUN_EVENT_TYPES } from "../../shared/run-vocabulary.ts";
import type { RunEventJournal, WorkflowRunEvent, WorkflowRunEventInput } from "../../orchestration/run-events.ts";

const journalLogger = getLogger("run-event-journal");



/**
 * runId 白名单：字母数字开头 + [A-Za-z0-9_-]，长度 ≤ 128。
 *
 * 为什么白名单而非黑名单：journal 文件名由 runId 直接拼出（join(dir,
 * `<runId><RUN_EVENT_JOURNAL_SUFFIX>`)），黑名单漏一个形态就是一次路径穿越；白名单只放行
 * generateRunId 的产出字符集（wf-<ts>-<base36>），首字符约束同时排除 "."、
 * ".." 与隐藏文件形态，"/" "\" 根本不在字符集内。
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function assertValidRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `非法 runId ${JSON.stringify(runId)}：journal 文件名只接受字母数字开头、字符集 [A-Za-z0-9_-]、长度 ≤128 的 runId（防路径穿越）。runId 应来自 lifecycle.ts 的 generateRunId（wf-<ts>-<rand>）；收到非法值时检查调用方的 runId 传递链。`,
    );
  }
}

const RUN_EVENT_TYPE_SET: ReadonlySet<string> = new Set(RUN_EVENT_TYPES);

/**
 * 坏行判定的最小形状校验：JSON 对象 + type 落在词表内 + ts 有限数值（EventEnvelope
 * 信封全词表必填——fold 投影的 startedAt/lastProgressAt 派生与注册表新鲜度判据都
 * 消费它，坏值防污染投影）+ outcome（agent-settled / run-settled 携带）落词表
 * （其余事件不携带，缺省自然放行）。任一不过 = 坏行。
 *
 * [W1 seq 契约] 携带 seq 的行按正整数校验（新写行信封必填）；seq 缺失放行——
 * W1 前的存量 journal 行无该字段（D7 惰性兼容读，旧 run 的 journal 直接进读源，
 * 行为完全不变）。运行时缺失与类型必填的张力由 foldRunEventFrames 的 typeof
 * 收窄承接（读取面单点声明）。
 */
function isWorkflowRunEventLine(value: unknown): value is WorkflowRunEvent {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as { type?: unknown; ts?: unknown; seq?: unknown; outcome?: unknown };
  if (typeof rec.type !== "string" || !RUN_EVENT_TYPE_SET.has(rec.type)) return false;
  if (typeof rec.ts !== "number" || !Number.isFinite(rec.ts)) return false;
  if (
    rec.seq !== undefined &&
    (typeof rec.seq !== "number" || !Number.isSafeInteger(rec.seq) || rec.seq < 1)
  ) {
    return false;
  }
  if (
    rec.outcome !== undefined &&
    !(ALL_RUN_OUTCOMES as readonly string[]).includes(rec.outcome as string)
  ) {
    return false;
  }
  return true;
}

/**
 * [§3.2 共享坏行判定原语] record 流单行校验的问题分类（**规则**在 core 单源，
 * **文案**由各调用方自持——core 恢复读面出 ResumeRejectionError 英文文案、壳
 * strict 读面出 RecordStreamCorruptionError 中文文案，两者措辞与恢复指引本就不同，
 * 共享的是「什么算坏行」）。
 */
export type RunEventLineIssueKind =
  | "invalid-json"
  | "not-object"
  | "type-envelope"
  | "type-outside-vocabulary"
  | "ts-envelope"
  | "seq-envelope"
  | "outcome-outside-vocabulary"
  | "agent-settled-missing-result";

/** 单行校验失败的结构化结果（含触发值，供调用方拼自己的文案）。 */
export interface RunEventLineIssue { // oe-exempt:20260930:framework:坏行结构化结果（D1 Class B2 搬迁，非新增抽象）
  kind: RunEventLineIssueKind;
  /** 触发值（type / ts / seq / outcome 等；not-object 无值）。 */
  value?: unknown;
}

/** 单行校验结果：合法事件 或 结构化问题（判别键 = ok）。 */
export type RunEventLineResult =
  | { ok: true; event: WorkflowRunEvent }
  | { ok: false; issue: RunEventLineIssue };

/**
 * record 流单行校验原语（[§3.2] core 恢复读面与壳 strict 读面共用单源）。
 *
 * 规则集（两读面原先各写一份，规则漂移即「同一个坏行一边拒绝一边放行」）：
 *   非对象 → type 落词表 → ts 有限数值 → seq（可选要求）→ outcome 落词表（携带时）
 *   → agent-settled 必须携带 result 全文。
 *
 * @param opts.requireSeq true = seq 信封必填且为正整数（core 恢复读面：坏 seq 是截断
 *        证据）；false = 缺省放行（壳兼容档：W1 前存量行无该字段，D7 惰性兼容读）。
 *        seq 断档（逐行 +1）不属单行规则，由需要它的读面自行累计判定。
 */
export function parseRecordStreamLine(
  line: string,
  opts: { requireSeq: boolean },
): RunEventLineResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, issue: { kind: "invalid-json" } };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, issue: { kind: "not-object" } };
  const rec = parsed as { type?: unknown; ts?: unknown; seq?: unknown; outcome?: unknown; result?: unknown };
  // 信封存在性（type 为非空字符串）与词表成员资格分开报：两侧读面对「type 缺失」
  // 的文案不同（core 复原为「词表外」、壳为「缺事件信封」），规则同源、文案各异。
  if (typeof rec.type !== "string" || rec.type === "") {
    return { ok: false, issue: { kind: "type-envelope", value: rec.type } };
  }
  if (!RUN_EVENT_TYPE_SET.has(rec.type)) {
    return { ok: false, issue: { kind: "type-outside-vocabulary", value: rec.type } };
  }
  if (typeof rec.ts !== "number" || !Number.isFinite(rec.ts)) {
    return { ok: false, issue: { kind: "ts-envelope", value: rec.ts } };
  }
  if (opts.requireSeq && (typeof rec.seq !== "number" || !Number.isSafeInteger(rec.seq) || rec.seq < 1)) {
    return { ok: false, issue: { kind: "seq-envelope", value: rec.seq } };
  }
  if (rec.outcome !== undefined && !(ALL_RUN_OUTCOMES as readonly string[]).includes(rec.outcome as string)) {
    return { ok: false, issue: { kind: "outcome-outside-vocabulary", value: rec.outcome } };
  }
  if (rec.type === "agent-settled" && rec.result === undefined) {
    return { ok: false, issue: { kind: "agent-settled-missing-result" } };
  }
  return { ok: true, event: parsed as WorkflowRunEvent };
}

/**
 * [§3.2 共享原语] legacy run-created 事件的 argsSummary 尽力恢复（旧格式帧回落通道）。
 *
 * 现行写入面 run-created 携带 args 全文，本原语只服务旧格式帧（无 args 字段）：
 * 未截断摘要可完整恢复；截断/不可解析/非对象回落空对象。**规则**在此单源，
 * 日志文案由调用方自持（core 恢复链与壳 fold 链各用自己的 logger 与措辞）。
 */
export type LegacyArgsSummaryIssue = "truncated-summary" | "not-parseable" | "not-object";

export interface LegacyArgsSummaryResult { // oe-exempt:20260930:framework:argsSummary 解析结果（D1 Class B2 搬迁，非新增抽象）
  args: Record<string, unknown>;
  /** 非致命问题（恢复结果恒为尽力而为；调用方据此自行 warn 留证）。 */
  issue?: LegacyArgsSummaryIssue;
}

export function parseLegacyArgsSummary(argsSummary: string | undefined): LegacyArgsSummaryResult {
  if (argsSummary === undefined || argsSummary === "") return { args: {} };
  if (argsSummary.endsWith("…")) return { args: {}, issue: "truncated-summary" };
  try {
    const parsed: unknown = JSON.parse(argsSummary);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown> };
    }
    return { args: {}, issue: "not-object" };
  } catch {
    return { args: {}, issue: "not-parseable" };
  }
}

/**
 * 创建文件形态的 run 事件 journal（唯一创建入口）。
 *
 * 实装体 = shared 泛型基座（JsonlEventJournal，与 record 事件 journal 单源）；本函数
 * 只提供 run 域策略：路径（runId 白名单校验 + `.record.jsonl` 后缀）、行校验器
 *（存量无 seq 行容忍）、warn 标签。无首行头行契约（run 侧文件自带后缀，无需自描述行）。
 *
 * @param dir journal 目录（布局决策归调用方：taiji 布局传 run store 旁的
 *        workflow-state 目录，测试传 mkdtemp 临时目录）。
 */
export function createRunEventJournal(dir: string): RunEventJournal {
  return new JsonlEventJournal<WorkflowRunEventInput, WorkflowRunEvent>(dir, {
    pathFor: (runId) => {
      assertValidRunId(runId);
      return join(dir, `${runId}${RUN_EVENT_JOURNAL_SUFFIX}`);
    },
    parseLine: (value) => (isWorkflowRunEventLine(value) ? (value as WorkflowRunEvent) : undefined),
    withSeq: (event, seq) => ({ ...event, seq }) as WorkflowRunEvent,
    scanWarn: (filePath, malformed) => `run-event journal scan：跳过 ${malformed} 个坏行（文件=${filePath}）`,
    warn: (message, detail) => journalLogger.warn(message, detail),
  });
}

