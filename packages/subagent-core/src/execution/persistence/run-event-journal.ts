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
// （`RUN_EVENT_TYPES` / `RUN_EVENTS_SUFFIX`）已在 shared，不构成反向值边。
//
// [D1 拆边 Class C 第 3 步] 本模块同时承接 **journal 目录解析集群 + record 读面**
// （`setRunEventJournalDirForTest` / `resolveRunEventJournal` / `runEventJournalPathOf`
// / `runEventJournalDirOf` / `scanRunEvents`）——自 `orchestration/terminal-actions.ts`
// 迁入，连同其 no-op 测试防线。为什么搬：目录解析是持久化策略（生产推导
// `resolvePiWorkflowStateDir` + 测试注入 + vitest 防线），execution 侧读面
// （`service/workflow-dispatch`）由此直连本模块，不再反向依赖编排层的值。编排侧
// 写者（terminal-actions）反向 import 本节，并对既有消费点保留同名 re-export。
import { join } from "node:path";

import { getLogger } from "../../core/logger.ts";
import { JsonlEventJournal } from "../../shared/jsonl-event-journal.ts";
import { ALL_RUN_OUTCOMES, RUN_EVENTS_SUFFIX, RUN_EVENT_TYPES } from "../../shared/run-vocabulary.ts";
import type { RunEventJournal, WorkflowRunEvent, WorkflowRunEventInput } from "../../orchestration/run-events.ts";
// 【D1 拆边 Class C 第 3 步】默认 journal 目录的模块锚推导（原 terminal-actions 依赖，
// 随目录解析集群一并迁入；assembly 叶子方向，persistence → assembly 既有先例）。
import { resolvePiWorkflowStateDir } from "../assembly/workflow-state-root.ts";

const journalLogger = getLogger("run-event-journal");
/** 目录解析面日志通道：与搬迁前 terminal-actions 同源（"run-event-dispatch"），
 *  日志读者不受搬迁影响。 */
const runEventDispatchLogger = getLogger("run-event-dispatch");



/**
 * runId 白名单：字母数字开头 + [A-Za-z0-9_-]，长度 ≤ 128。
 *
 * 为什么白名单而非黑名单：journal 文件名由 runId 直接拼出（join(dir,
 * `<runId><RUN_EVENTS_SUFFIX>`)），黑名单漏一个形态就是一次路径穿越；白名单只放行
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
      return join(dir, `${runId}${RUN_EVENTS_SUFFIX}`);
    },
    parseLine: (value) => (isWorkflowRunEventLine(value) ? (value as WorkflowRunEvent) : undefined),
    withSeq: (event, seq) => ({ ...event, seq }) as WorkflowRunEvent,
    scanWarn: (filePath, malformed) => `run-event journal scan：跳过 ${malformed} 个坏行（文件=${filePath}）`,
    warn: (message, detail) => journalLogger.warn(message, detail),
  });
}

// ══════════════════════════════════════════════════════════════
// [D1 拆边 Class C 第 3 步] journal 目录解析集群 + record 读面
// ——自 `orchestration/terminal-actions.ts` 原样迁入（行为零变更）。
//
// 归位理由：目录解析（生产推导 / 测试注入 / vitest 防线）是持久化层策略，读面
// （scanRunEvents）与写面 journal 实例同源；留在编排层会迫使 execution 侧消费者
// 反向值导入编排层（`service/workflow-dispatch` 即此形态）。编排侧
// （terminal-actions）反向 import 本节，并对既有消费点保留同名 re-export
// （`setRunEventJournalDirForTest` 由编排侧同名包装转调——包装额外清编排侧两族进程内
// 状态，本模块不反向依赖编排层）。
// ══════════════════════════════════════════════════════════════

/** journal 实例缓存（按目录 keyed）与测试注入点（生产目录 = run store 旁
 *  workflow-state，惰性解析）。keyed 缓存（ADR-0081）：per-call
 *  目录参数化后同进程可并存多个目录的 journal 实例（runtime 启动扫描收编 ≠ pi 壳
 *  模块锚目录），单值缓存会让两目录互相踢缓存——Map 按目录各持一份，单写者纪律
 *  不受影响（同一 run 恒同目录）。 */
const journalCache = new Map<string, RunEventJournal>();
let runEventJournalDirForTest: string | undefined;
let noopJournalWarned = false;

/** 测试钩子（注入面 door；目录解析面随 [D1 拆边 Class C] 迁本模块）：注入 journal
 *  目录 + 清空按目录 keyed 的 journal 缓存（换目录注入即换实例）。
 *
 *  调用面：编排侧（terminal-actions）保留同名包装转调本函数，包装另清编排侧两族
 *  进程内状态（活体态缓存 / 终局记录注册表）——那两族归编排层，本模块不反向依赖。 */
export function setRunEventJournalDirForTest(dir: string | undefined): void {
  runEventJournalDirForTest = dir;
  journalCache.clear();
}

/**
 * 测试防线的 no-op journal：scan 恒空、append 零写（vitest 未显式注入目录时启用）。
 * append 仍返回含 seq 的完整事件（内存计数分配——接口契约「返回值 = 落盘事件」
 * 在零写形态下保持形状，调用链不需要感知防线）。
 */
class NoopRunEventJournal implements RunEventJournal {
  private seqCounter = 0;

  async append(_runId: string, event: WorkflowRunEventInput): Promise<WorkflowRunEvent> {
    this.seqCounter += 1;
    return { ...event, seq: this.seqCounter } as WorkflowRunEvent;
  }

  async scan(): Promise<readonly WorkflowRunEvent[]> {
    return [];
  }
}

/** 按目录取（惰性创建）journal 实例（keyed 缓存单点）。 */
function journalForDir(dir: string): RunEventJournal {
  let journal = journalCache.get(dir);
  if (journal === undefined) {
    journal = createRunEventJournal(dir);
    journalCache.set(dir, journal);
  }
  return journal;
}

/**
 * journal 目录解析（ADR-0081 目录参数化）：显式 `journalDir`
 * 优先（runtime 侧收编链注入——调用进程 cwd/env 与落盘目录不相交的形态，目录
 * 即权威）；缺省 = 模块锚三层解析（测试注入 / vitest 防线 / 生产推导），pi 壳
 * 既有调用点零改动。显式目录不受 VITEST 防线拦截（与 setRunEventJournalDirForTest
 * 同信任级——显式注入即显式落点，红线护的是「未注入却落到真实推导路径」）。
 *
 * [包内] 导出供编排侧写者（terminal-actions 的 appendTransition / journalEventOf /
 * appendRunDiagnosticEvent）复用同源解析；非公共 barrel 面。
 */
export function resolveRunEventJournal(journalDir?: string): { dir: string; journal: RunEventJournal } {
  if (journalDir !== undefined) {
    return { dir: journalDir, journal: journalForDir(journalDir) };
  }
  if (runEventJournalDirForTest !== undefined) {
    return { dir: runEventJournalDirForTest, journal: journalForDir(runEventJournalDirForTest) };
  }
  // 测试防线（「测试禁止触碰真实数据目录」红线）：vitest 环境未显式注入目录时禁写
  // 真实推导路径——落 no-op journal + 一次性 warn 留痕。生产（无 VITEST env）不受
  // 影响；断言 record 流的测试必须显式 setRunEventJournalDirForTest(mkdtemp 目录)。
  if (process.env.VITEST === "true") {
    if (!noopJournalWarned) {
      noopJournalWarned = true;
      runEventDispatchLogger.warn(
        "run-event journal disabled: vitest env without setRunEventJournalDirForTest(dir) — " +
          "no-op journal active (prevents writes to the real workflow-state dir)",
      );
    }
    return { dir: "", journal: new NoopRunEventJournal() };
  }
  const dir = resolvePiWorkflowStateDir();
  return { dir, journal: journalForDir(dir) };
}

/**
 * run record 事件流文件绝对路径（record/manifest 同一解析源：生产推导
 * resolvePiWorkflowStateDir，测试经 setRunEventJournalDirForTest 注入）。
 *
 * [W1 / D1] v2 注册条目的 journalPath 锚点字段经本函数寻址（lifecycle.runWorkflow
 * 写注册条目时消费）——锚点与 record 实写面同源，防条目指向漂移。vitest 无注入
 * 防线（dir=""）下返回 undefined = 锚点不可寻址，调用方据此跳过条目写（禁触真实
 * 数据目录红线，与 no-op journal 同一防线语义）。
 *
 * 消费面：编排侧 terminal-actions 保留同名 re-export（本函数原定义处），既有调用点
 * 与导入路径零改动。
 */
export function runEventJournalPathOf(runId: string): string | undefined {
  const { dir } = resolveRunEventJournal();
  if (dir === "") return undefined;
  return join(dir, `${runId}${RUN_EVENTS_SUFFIX}`);
}

/**
 * run record 事件流 / manifest 同目录锚（[W2/V1] 收编原语的 manifest 证据面读点；
 * `journalDir` = per-call 目录（决策 2 收编链注入，缺省模块锚）；测试防线
 * （NoopJournal 形态 dir=""）返回 undefined——零写域不做真目录读）。
 *
 * 消费面：编排侧 terminal-actions 保留同名 re-export（本函数原定义处）。
 */
export function runEventJournalDirOf(journalDir?: string): string | undefined {
  const { dir } = resolveRunEventJournal(journalDir);
  return dir === "" ? undefined : dir;
}

/** [U4] run record 事件流只读访问器（成员复用绑定 fold 重建的读通道，决策 9 →
 *  [D6] 绑定字段查询辅助）——池侧不自建 journal 实例，读面统一走本模块解析，防绕过
 *  terminal-actions 的单写者纪律（写面唯一）与 no-op 测试防线。`journalDir` = per-call
 *  目录（runtime 侧收编扫描注入，缺省模块锚）。
 *
 *  [D1 拆边 Class C] execution 侧读面（`service/workflow-dispatch` 的成员复用绑定
 *  装配）直连本模块——这是本类搬迁消掉的那条 execution → orchestration 值边。 */
export async function scanRunEvents(runId: string, journalDir?: string): Promise<readonly WorkflowRunEvent[]> {
  const { journal } = resolveRunEventJournal(journalDir);
  return journal.scan(runId);
}
