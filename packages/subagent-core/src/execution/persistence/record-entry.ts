// src/execution/persistence/record-entry.ts
//
// subagent record 自描述持久化 entry 的形态权威（v2 单形态）。
//
// v2（W1 [D1]，当前且唯一版本）：主 session 条目 = 「注册 + 终态两条小条目」——
// 运行态数据移出主 session JSONL（eventLog/displayItems 端到端死字节停写），事实源 =
// record 事件文件（record-events.ts）。
//
// v1 全量快照形态（W16 [D4]）与其写点/读面已随「项目未上线、无 v1 数据」整体删除
// （登记 §3.3，2026-09-30）——本文件不再持有 v1 接口、投影函数与版本分支：读侧按
// v 判别只认当前版本，旧形态一律跳过而非猜测。
//
// customType 与既有 `subagent-identity`（session 文件首行身份 entry）同族命名
//（连字符风格）；custom entry 由 pi 写进 session JSONL，不进 LLM context。

import type { ExecutionOutcome, RecordOrigin, StopReason } from "../assembly/types.ts";

/** 自描述 record entry 的 customType。写点字面量与本常量的等值由
 *  __tests__/record-store.test.ts 断言钉住（消费方引用本常量，勿用裸字符串）。
 *
 * @experimental execution 运行时面（U10① D6）：一个 minor 周期内允许签名微调。 */
export const SUBAGENT_RECORD_CUSTOM_TYPE = "subagent-record";

// ── v2 条目契约（W1 / D1：注册 + 终态两条小条目）──────────────

/**
 * `subagent-record` entry 的 data schema 版本（当前且唯一版本 = 2）。
 *
 * 消费方按 v 判别解析（classifySubagentRecordEntryData 单源），不认识的版本跳过
 * 而非猜测。
 */
export const SUBAGENT_RECORD_ENTRY_VERSION = 2;

/** v2 条目判别键词表（两族同构：workflow-record v2 同款 registered/settled）。 */
export const SUBAGENT_RECORD_ENTRY_KINDS = ["registered", "settled"] as const;

export type SubagentRecordEntryKind = (typeof SUBAGENT_RECORD_ENTRY_KINDS)[number];

/**
 * v2 注册条目 data（设计 D1 条目契约表 subagent-record 行·注册列）。
 *
 * 诞生时写一条：身份 + 家族链锚点。字段集对照三个消费面枚举核对（session-reader
 * 锚链 / runtime 投影构造集 / SubagentTab 展示集）——身份域一次定清。事件文件
 * 寻址不经本条目（D3：注册条目 id 直接定址 `<recordsDir>/<sa-id>.events`，无需
 * journalPath 锚点字段）。
 */
export interface SubagentRecordRegisteredEntryData {
  v: typeof SUBAGENT_RECORD_ENTRY_VERSION;
  kind: "registered";
  id: string;
  agent: string;
  task: string;
  slug: string;
  origin: RecordOrigin;
  /** origin="workflow" 时所属 run id（tool 来源缺省）。 */
  parentRunId?: string;
  /** origin="workflow" 时在 run 内的步骤索引（tool 来源缺省）。 */
  stepIndex?: number;
  /** 根 session id（session 隔离过滤用）。 */
  rootSessionId: string;
  /** 直接父 record id（层级树构建用；顶层缺省）。 */
  parentRecordId?: string;
  /** subagent 递归深度（顶层 = 0）。 */
  depth: number;
  startedAt: number;
}

/**
 * v2 终态条目 data（设计 D1 条目契约表 subagent-record 行·终态列）。
 *
 * 结束时写一条（收编幂等补写同一形态）：终局 + 摘要 + session-reader 锚链载荷。
 * result 完整文本一次性写（SubagentTab 重启视图依赖，D1 增量裁决）；统计终值与
 * record-settled 事件（record-events.ts）同源——条目是 journal 的投影锚，不是
 * 第二事实源。
 */
export interface SubagentRecordSettledEntryData {
  v: typeof SUBAGENT_RECORD_ENTRY_VERSION;
  kind: "settled";
  id: string;
  /** 占用两态（永久会话模型）：终态收敛为 idle + stopReason 表达「为什么停」。 */
  status: "idle";
  stopReason: StopReason;
  outcome?: ExecutionOutcome;
  error?: string;
  endedAt: number;
  /** 统计终值（record-settled 事件同源）。 */
  turns: number;
  totalTokens: number;
  model: string | undefined;
  thinkingLevel: string | undefined;
  engine?: string;
  /**
   * 引擎自描述定位符（session-reader 末条锚定依赖——sessionRef 双键取自本条，
   * 不升级则 zcode 锚链兜底对新记录失效，D1 版本门补齐清单同款义务）。
   */
  engineHandle?: { sessionRef: Record<string, string>; journalPath?: string; poolKey: string };
  sessionFile?: string;
  /** 终局结果全文（一次性写——事件文件只存摘要锚，本条目是全文唯一落点）。 */
  result?: string;
}

/** v2 条目判别联合（判别键 = kind）。 */
export type SubagentRecordEntryV2 =
  | SubagentRecordRegisteredEntryData
  | SubagentRecordSettledEntryData;

/** entry 分类判别联合（判别键 = ok；与 workflow-record-entry 的同构裁决见 classify 注释）。 */
export type SubagentRecordEntryClassification =
  /** 当前版本 v2，kind 已过词表判定（形状校验归消费方解码层）。 */
  | { ok: true; entry: SubagentRecordEntryV2 }
  | { ok: false; reason: "wrong-type" | "missing-v" | "future-v" | "unknown-kind" };

/**
 * entry data → 分类（纯函数，无 IO 无日志；判定与策略分离，日志策略留消费方）。
 *
 * 分支语义（对齐 workflow-record-entry.classifyWorkflowRecordEntryData 同构裁决）：
 * - wrong-type：data 非对象（截断/半写）；
 * - missing-v：对象但 v 缺失（写点恒定写 v，缺失即形态损坏）；
 * - future-v：v 有值但不是当前版本（含类型漂移与已删的 v1 全量快照形态——旧形态
 *   不进解析路径，日志策略归消费方）；
 * - unknown-kind：当前版本但 kind 不在词表内；
 * - ok：合法 v2 条目，entry 已窄化（判别联合按 kind）。
 */
export function classifySubagentRecordEntryData(data: unknown): SubagentRecordEntryClassification {
  if (typeof data !== "object" || data === null) {
    return { ok: false, reason: "wrong-type" };
  }
  const record = data as { v?: unknown; kind?: unknown };
  if (record.v === undefined) {
    return { ok: false, reason: "missing-v" };
  }
  if (record.v === SUBAGENT_RECORD_ENTRY_VERSION) {
    if (record.kind === "registered" || record.kind === "settled") {
      return { ok: true, entry: data as SubagentRecordEntryV2 };
    }
    return { ok: false, reason: "unknown-kind" };
  }
  return { ok: false, reason: "future-v" };
}
