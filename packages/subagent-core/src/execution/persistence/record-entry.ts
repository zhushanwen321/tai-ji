// src/execution/persistence/record-entry.ts
//
// subagent record 自描述持久化 entry 的形态权威。
//
// v1（W16 [D4]，兼容读面保留）：pi 文件（session JSONL）是扩展数据持久化权威：
// record 状态每次迁移都经 pi.appendEntry 落一条自描述完整快照（字段即
// SubagentRecord），读取方无需逆向解析 toolCall/toolResult。
//
// v2（W1 [D1]，当前版本）：主 session 条目从「全量快照」改为「注册 + 终态两条
// 小条目」——运行态数据移出主 session JSONL（eventLog/displayItems 端到端死字节
// 停写），事实源 = record 事件文件（record-events.ts）。v1 类型与投影函数全保留
//（旧读者按版本跳过 v2 / 新读者兼容读 v1，D7 惰性兼容读）；v1 写点停写归 U2a。
//
// customType 与既有 `subagent-identity`（session 文件首行身份 entry）同族命名
//（连字符风格）；v2 写点（注册条目诞生时 / 终态条目结束时）接线归 U2a，custom
// entry 由 pi 写进 session JSONL，不进 LLM context。

import type {
  AgentEventLogEntry,
  ClosedReason,
  DisplayItem,
  ExecutionMode,
  ExecutionOutcome,
  ExecutionStatus,
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
  /** L2 关闭原因（旧终态兼容位——写侧仅 workflow D7 例外族/监督器放弃产出；读侧回落链见 stopReason）。 */
  closedReason?: ClosedReason;
  /**
   * [U3 / §3.2.4] 展示停因（上一轮为什么停，值域 StopReason）。additive 字段：
   * undefined（存量 entry）自然缺省零迁移，读侧 readEntryTerminalFields 按回落链
   * （stopReason ?? closedReason）归一。
   */
  stopReason?: StopReason;
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
  /**
   * 模型留痕（R4/D6-① 可选化）：undefined = 用户未指定模型（引擎自身缺省解析）。
   * 禁空串哨兵——undefined 经 JSON.stringify 自然缺省；读侧（record-store-rebuild）
   * 对存量 entry 的空串残留归一为 undefined。
   */
  model: string | undefined;
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
   * 离开批终局标记（存量 entry 读侧兼容面——[collect 退役] 起**只读不写**：原写点
   * 批闭合 flush / E9 dispose 转换已随 sync 批机制删除）。undefined = 未离开批 /
   * 退役后新 entry。旧 session 文件的标记 entry 必须容忍解析（读侧守卫：
   * batch-finalized.test.ts / sync-collect-recovery.test.ts）。
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
  /**
   * [W0 / D1] origin="workflow" 时在 run 内的步骤索引（与 origin/parentRunId 同族
   * 身份域，run 视图按 (parentRunId, stepIndex) 关联 record）。additive 字段，
   * v 不 bump（对齐 stopReason 先例）：undefined（存量 entry / tool 来源）经
   * JSON.stringify 自然缺省零迁移，读侧守卫归一。
   */
  stepIndex?: number;
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
    // 来源身份两字段（H2 W1）+ 步骤索引（[W0 / D1] 同族身份域）：undefined 经
    // JSON.stringify 自然缺省，存量 entry 序列化字节不变（零迁移）。
    origin: record.origin,
    parentRunId: record.parentRunId,
    stepIndex: record.stepIndex,
  };
}

// ── v2 条目契约（W1 / D1：注册 + 终态两条小条目）──────────────

/**
 * `subagent-record` entry 的 data schema 版本（W1 起当前版本 = 2）。
 *
 * 消费方按 v 判别解析（classifySubagentRecordEntryData 单源），不认识的版本跳过
 * 而非猜测。v1 全量快照形态见上方 {@link SubagentRecordEntryData}（兼容读面，
 * 随 W4 legacy sunset 统一退役）。
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

/** v2 分类判别联合（与 workflow-record-entry 的同构裁决见 classify 注释）。 */
export type SubagentRecordEntryClassification =
  /** v1 全量快照（兼容读面）——data 未做形状校验透传，解码归消费方。 */
  | { ok: true; data: unknown }
  /** v2 新形态——载荷已过 kind 判定（形状校验归消费方解码层）。 */
  | { ok: false; reason: "v2"; entry: SubagentRecordEntryV2 }
  | {
      ok: false;
      reason: "wrong-type" | "missing-v" | "future-v" | "unknown-kind";
    };

/**
 * entry data → v1/v2 分类（纯函数，无 IO 无日志；判定与策略分离，日志策略留消费方）。
 *
 * 分支语义（对齐 workflow-record-entry.classifyWorkflowRecordEntryData 同构裁决）：
 * - wrong-type：data 非对象（截断/半写）；
 * - missing-v：对象但 v 缺失（写点恒定写 v，缺失即形态损坏）；
 * - future-v：v 有值但非 1/2（含类型漂移——升级前旧版读取属正常降级）；
 * - unknown-kind：v2 但 kind 不在词表内；
 * - reason:"v2"：v2 合法形态——**归入 ok:false 是刻意裁决**：ok 的语义是「v1 快照
 *   契约可消费」，旧消费方（record-store-rebuild 等）的 `!ok → 跳过` 分支即 v2
 *   的版本门（U2b 补门消费本函数），新消费方按 reason === "v2" 取载荷；
 * - ok：v1（v1 无最小载荷检查——id 等字段校验归消费方解码层，与 v1 既有读路径
 *   的宽容面一致）。
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
    if (
      record.kind === "registered" ||
      record.kind === "settled"
    ) {
      return { ok: false, reason: "v2", entry: data as SubagentRecordEntryV2 };
    }
    return { ok: false, reason: "unknown-kind" };
  }
  if (record.v === 1) {
    return { ok: true, data };
  }
  return { ok: false, reason: "future-v" };
}
