// src/protocol/methods.ts
//
// 9 正向方法（core → 引擎）params/result 逐方法写死（v1）。设计权威源：
// 设计 §3.3 方法集表 + impl-plan §2.1「10 正向方法」（[H1] 收敛为 9）。
//
// [v1.x 增量（chat-domain 设计 §3.2 D1-A）]：增量以可选参数形态落在 run.params.chat
// （会话形态参数 + 冷续 resume 锚点），major 不 bump。[H1] chat-run 统一后续聊 =
// 新 run + resume 锚点（docs/design/subagent-chat-run-unification.md §3.3 D5/D7），
// 既有 interact 方法已随 U5 删除，方法集收敛为 9 个。
//
// 应答面补充约定（设计 §3.3）：initialize 应答仅诊断（与 manifest 不一致 → warn 留痕，
// 不参与同步成员判据；唯一阻断面 = 被 gate 能力位多声明 → engine_capability_mismatch）；
// listModels / validateModel 为诊断面（宿主侧同步成员读 manifest，不经本方法）；
// dispose 幂等；ping 为健康检查（ADR-0047：静默 ≠ 卡死，不据此杀任务）。

import type {
  AgentCallOpts,
  EngineCapabilities,
  EngineHandleData,
  AgentOutcome,
  ModelCatalogEntry,
  ProbeReport,
  ResumeAnchor,
  SessionView,
} from "./contract-types.ts";

/**
 * 正向方法名联合（恰好 9 个；PROTOCOL_METHODS 常量数组与之同源互证）。
 * [H1] `interact` 成员已随 chat-run 统一退役（docs/design/subagent-chat-run-unification.md
 * §3.3 D5：续聊轮统一为「新 run + resume 锚点」，U5 删除）。
 */
export type ProtocolMethod =
  | "initialize"
  | "probe"
  | "run"
  | "cancel"
  | "read"
  | "listModels"
  | "validateModel"
  | "dispose"
  | "ping";

/** 方法名全集（运行时顺序化枚举；与 ProtocolMethod 的同源关系由测试断言）。 */
export const PROTOCOL_METHODS = [
  "initialize",
  "probe",
  "run",
  "cancel",
  "read",
  "listModels",
  "validateModel",
  "dispose",
  "ping",
] as const satisfies readonly ProtocolMethod[];

// ============================================================
// run 专用载荷
// ============================================================

/**
 * run 上下文（RunContext 字段映射的协议承载，设计 §3.3 RunContext 映射表）。
 */
export interface RunContextParams {
  /** 隔离池归属（journal 归属错 = 缺失后果）。 */
  poolKey: string;
  /** 任务工作目录（worktree 隔离时 = worktree 路径）。 */
  cwd: string;
  /** 请求模型 ref（未传 = 引擎缺省模型）。 */
  model?: string;
  /** 结构化输出 schema 的 env 注入形态（schemaEnv 降级通道）。 */
  schemaEnv?: string;
  /** 上下文模型 ref（与 run 模型分离的 ctx 模型）。 */
  ctxModel?: string;
  /** fallback 留痕（引擎回填 outcome.engineFallback 的种子）。 */
  engineFallback?: { from: string; reason: string };
  /** 事件粒度请求（引擎按 capabilities.eventGranularity 实际能力执行）。 */
  streamMode?: "stream" | "coarse";
  /**
   * [F6] 根 session id——pi 引擎 relay 归属键 SESSION_ID 的权威来源（生产三来源
   * ①本字段 ②宿主 env ③根进程 env 中，宿主派发恒走①）。additive 可选：旧引擎忽略
   * 未知字段，undefined 不上 wire。
   */
  sessionRootId?: string;
  /**
   * [Option C 协议化] 权威 subagent session 目录——宿主以 getSubagentSessionDir
   * (agentDir, rootCwd) 推导（宿主单一权威，Fix Gate B S6：引擎本地推导与宿主布局
   * 三处不等价 → 跨重启续聊链断裂）。引擎用它组装 pi `--session-dir`，不自推导；
   * 缺省（独立运行/测试）走引擎内 [LEGACY] fallback。additive 可选：旧引擎忽略
   * 未知字段，undefined 不上 wire。
   */
  sessionDir?: string;
}

// ============================================================
// [H1] run 的 resume 会话形态参数（chat-run 统一终态；原 v1.x chat 键已退役）
// ============================================================

/**
 * [H1] run 的 resume 会话形态参数（设计 docs/design/subagent-chat-run-unification.md
 * §3.3 D3 + §5 U1/U6 行）：原 RunChatParams（v1.x chat 会话形态参数）的泛化改名终态，
 * 载荷同形（recordId + resume 锚点，ResumeAnchor 不变），仅键名从「chat 会话形态」
 * 泛化为「resume 续聊」。
 *   - recordId：core 预建 record 的关联键（引擎据此回填 handle.sessionRef、上报
 *     host/childSpawned|childStateChanged 的 record 键形态）；
 *   - resume：冷续锚点（重开已 idle 的 session 续聊；缺省 = 新 session）。对照
 *     core SpawnResumeOpts——sessionFile 经 anchor.sessionRef 携带，model/
 *     thinkingLevel 防漂移覆盖走既有 task/ctx 字段，不双写。
 * [H1 U6 已切换] `chat` 键整体退役（读写端同批切换，无「写新读旧」窗口），本键为
 * 唯一会话形态参数。载荷 schema 权威 = runSessionParamsSchema（schema.ts）。
 */
export interface RunResumeParams {
  recordId: string;
  resume?: ResumeAnchor;
}

// ============================================================
// params / result 逐方法映射（方法名 → 载荷）
// ============================================================

/** initialize 参数（engineConfig = L3 显式配置 engines.<id>.config 透传，不放凭据）。 */
export interface InitializeParams {
  protocolVersion: number;
  hostInfo: { name: string; version: string; dataRoot: string };
  engineConfig: Record<string, string>;
}

/** initialize 应答（仅诊断面：capabilities/models 与 manifest 不一致 → warn，不参与判据）。 */
export interface InitializeResult {
  protocolVersion: number;
  engineId: string;
  engineVersion: string;
  adapterVersion: string;
  capabilities: EngineCapabilities;
  /** 模型目录（诊断面；省略/null = 无枚举面语义）。 */
  models?: ModelCatalogEntry[] | null;
}

export interface ProbeParams {
  force?: boolean;
}

export interface RunParams {
  runId: string;
  task: AgentCallOpts;
  ctx: RunContextParams;
  /**
   * [H1 U6 终态] resume 续聊参数（唯一会话形态键；原 v1.x `chat` 键已随键切换退役，
   * 见 RunResumeParams）。缺省 = 一次性任务形态（向后兼容：旧引擎忽略未知字段，
   * 帧级 schema params 不做深校验）。additive 可选：undefined 不上 wire。
   */
  resume?: RunResumeParams;
}

/** run 终态应答（期间事件经 event 通知；长运行方法，应答到达即终态）。 */
export interface RunResult {
  handle: EngineHandleData;
  outcome: AgentOutcome;
}

export interface CancelParams {
  runId: string;
  reason: string;
}

/**
 * cancel 应答（受理确认）。终态本体由该 run 的 run 终态应答承载（abort 合成终态经
 * event/终态应答到达）；引擎须 CANCEL_SETTLE_GRACE_MS（3s）内收敛，超时 core 走杀链。
 */
export interface CancelResult {
  ok: true;
}

export interface ReadParams {
  handle: EngineHandleData;
  /** 数据根必填：存量池时代引擎自算池/journal 相对 dbPath 的定位需要它（设计钉死）。 */
  dataDir: string;
}

export interface ListModelsParams {
  /** 占位空参（帧形状一致性；未来诊断参数在此扩展）。 */
  _placeholder?: never;
}

export interface ListModelsResult {
  /** 数组 = 有枚举面；null = 无枚举面（buildCoreAlignedHint 语义，与 manifest 省略对齐）。 */
  models: ModelCatalogEntry[] | null;
}

export interface ValidateModelParams {
  modelRef?: string;
}

export interface ValidateModelResult {
  canonicalRef: string;
}

export interface DisposeParams {
  /** 占位空参（帧形状一致性；幂等语义）。 */
  _placeholder?: never;
}

export interface DisposeResult {
  ok: true;
}

export interface PingParams {
  /** 占位空参（帧形状一致性）。 */
  _placeholder?: never;
}

export interface PingResult {
  pong: true;
}

/** 方法 → params 类型映射。 */
export interface ProtocolParamsMap {
  initialize: InitializeParams;
  probe: ProbeParams;
  run: RunParams;
  cancel: CancelParams;
  read: ReadParams;
  listModels: ListModelsParams;
  validateModel: ValidateModelParams;
  dispose: DisposeParams;
  ping: PingParams;
}

/** 方法 → result 类型映射。 */
export interface ProtocolResultMap {
  initialize: InitializeResult;
  probe: ProbeReport;
  run: RunResult;
  cancel: CancelResult;
  read: SessionView;
  listModels: ListModelsResult;
  validateModel: ValidateModelResult;
  dispose: DisposeResult;
  ping: PingResult;
}
