/**
 * workflow-record 自描述 entry 的 schema 契约单源（W17 [D4]；词表/guard 收敛
 * 二轮复审候选 2；W1 [D1] v 升格 2）。
 *
 * 消费格局（core 写点 / 壳 loadAll v2 定界 / runtime 投影扫描）各自需要
 * customType 字面量与版本判定，独立演化即静默漂移——本模块收敛两件事：
 * 1. customType 与 entry schema 版本常量（版本 bump 单点，写点与读判定同源）；
 * 2. 纯判定函数 classifyWorkflowRecordEntryData——entry data 的 v1/v2 分类。
 *
 * 版本谱系：
 * - v1（W17 起）：全量快照形态 `{v:1, snapshot, updatedAt}`——兼容读面保留
 *   （D7 惰性兼容读，旧会话行为完全不变；写侧停写归 U1）；
 * - v2（W1 起，当前版本）：注册 + 终态两条小条目（kind 判别）——运行态数据
 *   移出主 session JSONL，事实源 = run journal（run-events.ts）。
 *
 * 判定与策略分离：本函数无 IO、无日志。reason 词表是判定结果的结构化输出，
 * 日志策略（何时出声 / 去重键 / 静默）留消费方——壳 per-entry warn 留证与
 * runtime warnOnce 去重是两消费方各自的可观测性选择，收敛判定不收敛日志。
 *
 * 不在本模块的：
 * - snapshot 格式版本（SNAPSHOT_VERSION）——run-snapshot.ts 常量单源；entry 层 v
 *   与 snapshot 层 v 是两级独立版本（entry schema 演化 vs 快照格式演化）；
 * - runtime 投影的 runId 存在性守卫——投影键需求（record 需要 runId 做 Map 键），
 *   非 entry schema 面，runtime 解码链自有等价校验。
 */

import type { DoneReason } from "./models/types.ts";
import type { RunErrorCode, RunOutcome } from "./run-events.ts";

/**
 * 自描述 workflow record entry 的 customType。命名对齐 `subagent-record`
 * （连字符风格）。写点字面量与常量的等值由壳
 * __tests__/jsonl-run-store-session-file.test.ts 断言钉住（消费方引用本常量，
 * 勿用裸字符串）。
 */
export const WORKFLOW_RECORD_CUSTOM_TYPE = "workflow-record";

/**
 * `workflow-record` entry 的 data schema 版本（W1 起 v2）。消费方按 v 判别
 * 解析，不认识的版本跳过而非猜测；与快照层 SNAPSHOT_VERSION（"wf-run-v2"）
 * 是两级独立版本号。v1 全量快照形态随版本门保留为兼容读面（D7）。
 *
 * （const 声明 + 字面量初始化使类型收窄为字面量 2，无需 `as const`。）
 */
export const WORKFLOW_RECORD_ENTRY_VERSION = 2;

/** v2 条目判别键词表（两族同构：subagent-record v2 同款 registered/settled）。 */
export const WORKFLOW_RECORD_ENTRY_KINDS = ["registered", "settled"] as const;

export type WorkflowRecordEntryKind = (typeof WORKFLOW_RECORD_ENTRY_KINDS)[number];

/**
 * v2 注册条目 data（设计 D1 条目契约表 workflow-record 行·注册列）。
 *
 * run 创建时写一条：身份 + journal 锚点。journalPath 是 session-reader workflow
 * 发现链的主源数据基础（v2 注册条目是 run 步骤级详情读面的唯一发现锚点）。
 */
export interface WorkflowRecordRegisteredEntryData {
  v: typeof WORKFLOW_RECORD_ENTRY_VERSION;
  kind: "registered";
  runId: string;
  /** workflow 名（run journal run-created 帧的 workflowName 同源）。 */
  workflowName: string;
  /** 脚本身份名（RunSpec.scriptName——meta.name 或文件名 stem）。 */
  scriptName: string;
  /** run 级短标签（RunSpec.slug，≤20 字符；缺省回落 scriptName）。 */
  slug: string;
  startedAt: number;
  /**
   * record 事件流绝对路径锚点（`<sessionDir>/workflow-state/<runId>.record.jsonl`
   * ——后缀经 core RUN_EVENT_JOURNAL_SUFFIX 单源常量，[D1] record 单源流命名；
   * 写侧锚点与实写面同源见 terminal-actions.runEventJournalPathOf）——v2 条目
   * 的 journalPath 锚点字段（任务书 U0 职责 1）；保留窗口内 record 流在盘即可
   * 按锚点读步骤级家族链，窗口外回落 manifest 摘要级（session-reader 发现链
   * 三档，[D16③] 适配）。
   */
  journalPath: string;
}

/**
 * v2 终态条目 data（设计 D1 条目契约表 workflow-record 行·终态列）。
 *
 * run 终局时写一条（[D2] 宿主投影裁决②：settled 终态条目仅 terminal 时写——
 * 现状收编补写 settled 条目的行为随 D2 终止）：终局 + 摘要。字段与
 * run-settled record 帧同源（条目是 record 的投影锚，不是第二事实源）。
 */
export interface WorkflowRecordSettledEntryData {
  v: typeof WORKFLOW_RECORD_ENTRY_VERSION;
  kind: "settled";
  runId: string;
  /**
   * 收敛词（[D2] 宿主投影裁决②——schema 契约单源在本字段）：terminal 终局 =
   * 'done'（reason/outcome 必带）；interrupted 暂停态 = 'interrupted'（中断非终局
   * ——reason/outcome 缺省，细分语境由 errorCode 承载中断来源标记，可 resume，
   * runtime 读侧三态投影的消费面）。
   */
  status: "done" | "interrupted";
  /** 终态原因（= DoneReason，run.state.reason 同源；interrupted 形态缺省）。 */
  reason?: DoneReason;
  /** 终局形态（run-settled 帧 outcome 同源，与 reason 正交维度；interrupted 形态缺省——中断非终局）。 */
  outcome?: RunOutcome;
  /** 失败终局的结构化编码（done/cancelled/time_limited 缺省；interrupted 形态 = 中断来源标记）。 */
  errorCode?: RunErrorCode;
  /** 收敛时刻（终局帧 ts / 中断转移帧 ts 同源）。 */
  settledAt: number;
  /** 摘要：call 计数（终局 trace 规模）。 */
  callCount: number;
  /** 摘要：token 消耗终值（state.budget.usedTokens 同源）。 */
  usedTokens: number;
  /** 摘要：脚本结果概要（截断文本——全文不进条目，事件流/manifest 可溯）。 */
  scriptResultSummary?: string;
}

/** v2 条目判别联合（判别键 = kind）。 */
export type WorkflowRecordEntryV2 =
  | WorkflowRecordRegisteredEntryData
  | WorkflowRecordSettledEntryData;

/**
 * 判定结果判别联合。
 *
 * ok = v1 且带 snapshot（snapshot 未经形状校验——truthy 即放行，解码归消费方，
 * 与收敛前壳 `!data.snapshot` / runtime `typeof snapshot !== 'object'` 双实现的
 * 最宽共同判定面一致）。
 *
 * reason:"v2" = v2 合法形态（载荷已过 kind 判定，形状校验归消费方解码层）——
 * **归入 ok:false 是刻意裁决**：ok 的语义是「v1 快照契约可消费」（runtime
 * parseSelfDescribedWorkflowSnapshot 的 `!ok → 跳过` 分支即 v2 的版本门）；
 * v2 消费方（壳 loadAll 定界 / runtime 投影扫描）按 reason === "v2" 取载荷。
 */
export type WorkflowRecordEntryClassification =
  | { ok: true; snapshot: unknown }
  | { ok: false; reason: "v2"; entry: WorkflowRecordEntryV2 }
  | {
      ok: false;
      reason: "wrong-type" | "missing-v" | "future-v" | "no-snapshot" | "unknown-kind";
    };

/**
 * entry data → v1/v2 分类（纯函数，无 IO 无日志）。
 *
 * 分支语义（v1 分支与收敛前壳/runtime 双实现的判定面逐分支对齐；v2 分支为
 * W1 新增）：
 * - wrong-type：data 非对象（截断/半写连对象都不是）；
 * - missing-v：对象但 v 缺失（写点恒定写 v，缺失即形态损坏）；
 * - future-v：v 有值但非 1/2（含类型漂移如 "1" 字符串——升级前旧版读取
 *   属正常降级）；
 * - no-snapshot：v1 但 snapshot falsy（v1 专属分支）；
 * - unknown-kind：v2 但 kind 不在词表内（v2 专属分支）；
 * - v2：v2 且 kind ∈ {registered, settled}；
 * - ok：v1 且 snapshot truthy。
 */
export function classifyWorkflowRecordEntryData(data: unknown): WorkflowRecordEntryClassification {
  if (typeof data !== "object" || data === null) {
    return { ok: false, reason: "wrong-type" };
  }
  const record = data as { v?: unknown; kind?: unknown; snapshot?: unknown };
  if (record.v === undefined) {
    return { ok: false, reason: "missing-v" };
  }
  if (record.v === WORKFLOW_RECORD_ENTRY_VERSION) {
    if (record.kind === "registered" || record.kind === "settled") {
      return { ok: false, reason: "v2", entry: data as WorkflowRecordEntryV2 };
    }
    return { ok: false, reason: "unknown-kind" };
  }
  if (record.v !== 1) {
    return { ok: false, reason: "future-v" };
  }
  if (!record.snapshot) {
    return { ok: false, reason: "no-snapshot" };
  }
  return { ok: true, snapshot: record.snapshot };
}
