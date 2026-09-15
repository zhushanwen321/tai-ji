// src/execution/persistence/record-entry.ts
//
// W16 [D4]：subagent record 自描述持久化 entry 的形态权威。
//
// pi 文件（session JSONL）是扩展数据持久化权威：record 状态每次迁移都经
// pi.appendEntry 落一条自描述完整快照（字段即 SubagentRecord），读取方无需
// 逆向解析 toolCall/toolResult。内存 record-store 保持运行时权威，entry 是
// 重建源（两者不冲突）。
//
// customType 与既有 `subagent-identity`（session 文件首行身份 entry）同族命名
//（连字符风格）；写点见 record-store.ts 的状态迁移点（register/archive/
// reportRecordTransition），custom entry 由 pi 写进 session JSONL，不进 LLM context。

import type {
  AgentEventLogEntry,
  ClosedReason,
  DisplayItem,
  ExecutionMode,
  ExecutionStatus,
  Intent,
  RecordOrigin,
  StopReason,
  SubagentRecord,
} from "../assembly/types.ts";

/** 自描述 record entry 的 customType。写点字面量与本常量的等值由
 *  __tests__/record-store.test.ts 断言钉住（消费方引用本常量，勿用裸字符串）。
 *
 * @experimental execution 运行时面（U10① D6）：一个 minor 周期内允许签名微调。 */
export const SUBAGENT_RECORD_CUSTOM_TYPE = "subagent-record";

/**
 * `subagent-record` entry 的 data schema（v1）。
 *
 * = 完整 SubagentRecord 快照（GUI 侧列表/详情需要的全部持久化字段）+ 版本号。
 * 显式排除两个非持久化字段（与 SubagentRecord 的差集）：
 *   - currentActivity：running 时的瞬时流态，重开 session 无重建价值；
 *   - worktreeHandle：不可 JSON 序列化的运行时句柄（布尔投影 worktree 保留）。
 *（[U4a / D3b (a)] externalInstance 投影已随字段链删除——探活态由 .alive sidecar
 * 现查探针承担，不再进 record 快照。）
 *
 * undefined 字段经 JSON.stringify 自然缺省（与 SubagentRecord 重建侧语义一致）。
 *
 * @experimental execution 运行时面（U10① D6）：一个 minor 周期内允许签名微调。
 */
export interface SubagentRecordEntryData {
  /** schema 版本（W16 起 v1）。消费方按 v 判别解析，不认识的版本跳过而非猜测。 */
  v: 1;
  id: string;
  agent: string;
  /** 任务提示词（详情面板置顶展示）。 */
  task: string;
  /** 短标签（≤35 字符）。 */
  slug: string;
  status: ExecutionStatus;
  /** L2 关闭原因（仅 status="closed" 时有意义）。 */
  closedReason?: ClosedReason;
  /**
   * [U3 / §3.2.4] 展示停因（上一轮为什么停，值域 StopReason）。additive 字段：
   * undefined（存量 entry）自然缺省零迁移，读侧 readEntryTerminalFields 按回落链
   * （stopReason ?? closedReason）归一。
   */
  stopReason?: StopReason;
  /**
   * [U8 / §3.2.1] 意愿维度（close 收起 / message 寻回的迁移写点携带）。additive
   * 字段：undefined（存量 entry）= "active" 语义零迁移。GUI「已收起」分区（U8b）
   * 与 manifest 下行映射（archived → legacy closed，U5-D10）的持久化载体——
   * 漏本字段则重启后归档意图静默丢失。
   */
  intent?: Intent;
  mode: ExecutionMode;
  startedAt: number;
  /** 根 Pi session ID（session 隔离过滤用）。 */
  rootSessionId: string | undefined;
  /** 直接父 subagent record ID（层级树构建用）。顶层为 undefined。 */
  parentRecordId: string | undefined;
  /** subagent 递归深度。顶层 = 0。 */
  depth: number;
  endedAt: number | undefined;
  /** turn 计数。 */
  turns: number;
  totalTokens: number;
  model: string;
  thinkingLevel: string | undefined;
  /** 详情事件日志（/subagents 详情面板）。 */
  eventLog: AgentEventLogEntry[];
  /** 从 turns[] 派生的展示项。 */
  displayItems: DisplayItem[];
  result?: string;
  error?: string;
  sessionFile?: string;
  /** [MF#3] worktree 模式改动 patch 文件路径。 */
  patchFile?: string;
  /** 创建时是否启用 worktree 隔离。 */
  worktree?: boolean;
  /** 对话轮次计数（每轮轮终迁移写点携带 +1；modeless 波1 起全 record 自增）。 */
  round?: number;
  /**
   * [modeless 波1·已删除字段] 对话模式标志 chatMode 停写删除：万物可续后「模式」
   * 不再是 record 状态。旧 entry 残留键读侧自然忽略（legacy 缺省归 chat 语义与
   * modeless 天然一致，零迁移）。
   */
  /**
   * 实际执行引擎 id（P4 路由留痕，D9①）。缺省（存量 entry）= pi 投影，消费方零迁移。
   */
  engine?: string;
  /** 引擎 fallback 留痕（probe 失败路由回默认引擎）。GUI 警告条数据源。 */
  engineFallback?: { from: string; reason: string };
  /**
   * 引擎自描述定位符（U1：read 降级链①②级数据源）。引擎无关——sessionRef 整体
   * 透传不枚举内部键（zcode = { sessionId, dbPath }）；缺省 = pi（存量 entry 零迁移）。
   */
  engineHandle?: { sessionRef: Record<string, string>; journalPath?: string; poolKey: string };
  // [modeless 波3·已删除字段] collectMode entry 字段停写删除（collect = 派发时路由
  // 选项，成员身份 = 协调器登记态）；旧 entry 残留键读侧自然忽略，零迁移。
  /**
   * 离开批终局标记（subagent-sync-collect 设计 §3.1.3，U1 foundation）。两出口统一
   * 落标（批闭合 flush / E9 dispose 转换，均 appendEntry 持久化）。undefined =
   * 未离开批 / 旧 entry 零迁移。消费方：U5 E1 重建扫描只收无标记成员（防双重通知）。
   */
  batchFinalized?: boolean;
  /**
   * 来源身份（H2 W1，设计 subagent-workflow-record-unification §3.3 D1）。
   * undefined（存量 entry）= "tool" 语义，消费方零迁移。重启后 origin 过滤面
   * （subagents list / renderer / TUI）生效的唯一持久化载体——漏本字段则重启后
   * workflow record 逃过全部投影过滤。
   */
  origin?: RecordOrigin;
  /**
   * origin="workflow" 时所属 workflow run id（W2 写入）；tool 来源恒缺省。
   * W2/W3 run 视图按 collectRecordsByParentRunId 从本字段回查本 run 的 record 集。
   */
  parentRunId?: string;
}

/** SubagentRecord → 自描述 entry data（快照投影，不 mutate 源）。
 *
 * @experimental execution 运行时面（U10① D6）：一个 minor 周期内允许签名微调。 */
export function toSubagentRecordEntry(record: SubagentRecord): SubagentRecordEntryData {
  return {
    v: 1,
    id: record.id,
    agent: record.agent,
    task: record.task,
    slug: record.slug,
    status: record.status,
    closedReason: record.closedReason,
    stopReason: record.stopReason,
    // [U8] 意愿维度随快照持久化（undefined 经 JSON.stringify 自然缺省，旧 entry
    // 序列化字节不变——零迁移）。
    intent: record.intent,
    mode: record.mode,
    startedAt: record.startedAt,
    rootSessionId: record.rootSessionId,
    parentRecordId: record.parentRecordId,
    depth: record.depth,
    endedAt: record.endedAt,
    turns: record.turns,
    totalTokens: record.totalTokens,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    eventLog: record.eventLog,
    displayItems: record.displayItems,
    result: record.result,
    error: record.error,
    sessionFile: record.sessionFile,
    patchFile: record.patchFile,
    worktree: record.worktree,
    round: record.round,
    engine: record.engine,
    engineFallback: record.engineFallback,
    engineHandle: record.engineHandle,
    // [modeless 波3] collectMode 投影随字段消亡删除；batchFinalized（U1 foundation）
    // undefined 经 JSON.stringify 自然缺省，旧 entry 序列化产物字节不变（零迁移）。
    batchFinalized: record.batchFinalized,
    // 来源身份两字段（H2 W1）：undefined 经 JSON.stringify 自然缺省，存量 entry
    // 序列化字节不变（零迁移）。
    origin: record.origin,
    parentRunId: record.parentRunId,
  };
}
