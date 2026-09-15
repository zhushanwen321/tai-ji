// src/execution/engine/common/session-view-types.ts
//
// session-view-service 的窄接口层 + engineHandle 单一守卫（dual-track-convergence D1：
// 双守卫收敛——此前 runtime subagent-extractor.projectEngineHandle 与
// subagent-engine-history.extractRecordEngineHandle 两份 guard 各自演进，收敛为本文件
// 的 parseEngineHandle 唯一实现，读写两侧共用）。
//
// 零相对 import（纯类型 + 纯函数）：本文件与 zcode/reader.ts 同属「双端复用模块」
// （设计 §3.3.7——taiji runtime 可直接 import，不连带 core 内部 .ts 后缀 import 链
// 进 runtime tsc 编译图）。改动本文件时保持该约束。
//
// 为什么不 import @taiji/shared 的 Message/SubagentRecord：shared 是 workspace
// private 包（不发 npm），而本包是 dual-form 发布包（npm 消费面见 package.json
// publishConfig）——import shared 会把 private 依赖拖进发布闭包。输出类型采用
// 结构兼容形状（HistoryMessage 是 shared Message 的结构子集），runtime 侧靠 TS
// 结构类型直接赋值，兼容性由 runtime 消费点类型检查 + 本包投影测试双重守护。

/**
 * record 携带的引擎 handle 消费面（EngineHandleData 的结构子集，双端契约不变）：
 * journalPath 绝对路径；sessionRef 内 dbPath 相对池目录 / 绝对路径均可。
 */
export interface EngineHandleView {
  /** 引擎自定义定位符（zcode = { sessionId, dbPath }）。 */
  sessionRef: Record<string, string>;
  /** journal 绝对路径（②级数据源；读前校验 engines 根前缀白名单）。 */
  journalPath?: string;
  /** 隔离池定位（路径布局 SSOT：resolvePoolDir 消费）。 */
  poolKey: string;
}

/**
 * 历史读取输入的 record 快照（消费字段级子集，不绑定 runtime 的完整
 * SubagentRecord 形状——core 不 import workspace private 类型）。
 * engine / engineHandle 是不可信源（JSONL 文本派生），由 extractEngineId /
 * parseEngineHandle 守卫式消费。
 */
export interface SubagentRecordSnapshot {
  subagentId: string;
  task: string;
  result?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  /** record.engine（'pi' | 'zcode' | ...，缺省 = pi 由 extractEngineId 归一）。 */
  engine?: unknown;
  /** record.engineHandle（parseEngineHandle 守卫消费）。 */
  engineHandle?: unknown;
}

/** 引擎 toolCall 投影到 GUI 消费形状前的最小消费面（core ToolCall 的结构子集）。 */
export interface EngineToolCallSource {
  toolName: string;
  args?: unknown;
  result?: { content?: unknown[]; details?: unknown };
  isError?: boolean;
}

/** GUI 工具调用视图（结构兼容 shared ToolCall 的消费子集；id/时间戳为展示占位）。 */
export interface HistoryToolCallView {
  id: string;
  toolName: string;
  input: unknown;
  output?: string;
  details?: Record<string, unknown>;
  status: "completed" | "error";
  startTime: number;
  endTime: number;
}

/** GUI thinking 块视图（结构兼容 shared ThinkingBlock）。 */
export interface HistoryThinkingView {
  id: string;
  content: string;
  collapsed: boolean;
}

/** GUI usage 视图（结构兼容 shared Usage）。 */
export interface HistoryUsageView {
  inputTokens: number;
  outputTokens: number;
}

/** GUI 消息视图（结构兼容 shared Message 的消费子集——见文件头「为什么不 import shared」）。 */
export interface HistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "error";
  toolCalls?: HistoryToolCallView[];
  thinking?: HistoryThinkingView[];
  usage?: HistoryUsageView;
  timestamp: number;
  error?: string;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * engineHandle 唯一守卫（D1 双守卫收敛点）。
 * 语义取收敛前 extractor 侧的严格版（两份 guard 此前已在「sessionRef 含非 string 值」
 * 维度分叉：extractor 整体拒绝、history 侧逐键过滤——收敛选整体拒绝，坏形状不进
 * record，读侧按缺 handle 降级 outcome-only，两侧行为面等价落点都是降级）：
 * - poolKey 缺失 / 非 string / 空串 → undefined（定位符不完整，读侧降③级）
 * - sessionRef 非 plain object 或含非 string 值 → undefined（整体拒绝）
 * - journalPath 可选 string（空串视为缺省）
 */
export function parseEngineHandle(raw: unknown): EngineHandleView | undefined {
  if (!isPlainRecord(raw)) return undefined;
  if (typeof raw.poolKey !== "string" || raw.poolKey.length === 0) return undefined;
  if (!isPlainRecord(raw.sessionRef)) return undefined;
  const sessionRef: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.sessionRef)) {
    if (typeof value !== "string") return undefined;
    sessionRef[key] = value;
  }
  const journalPath =
    typeof raw.journalPath === "string" && raw.journalPath.length > 0 ? raw.journalPath : undefined;
  return {
    sessionRef,
    ...(journalPath !== undefined ? { journalPath } : {}),
    poolKey: raw.poolKey,
  };
}
