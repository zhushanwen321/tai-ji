// src/protocol/methods.ts
//
// 正向方法（core → 引擎）params/result 逐方法写死（v1）。设计权威源：
// 设计 §3.3 方法集表 + impl-plan §2.1「10 正向方法」（[H1] 收敛为 9）。
//
// [subagent-model-switch §7.3 增量]：第 10 个正向方法 setModel（执行中模型热切换；
// RunParams 同级的 run 定向方法——params 以 runId 寻址，对照 cancel）。additive
// 演进不 bump 版本：引擎按 capabilities.setModel 位声明支持与否，位非 'native' 的
// 引擎不会被宿主调用本方法（发送前预检——消费点登记见 contract-types.ts 能力位注释），
// 旧引擎/不支持引擎收到本方法按「未知正向 method 应答义务」回 error 帧。
//
// [v1.x 增量（chat-domain 设计 §3.2 D1-A）]：增量以可选参数形态落在 run.params.chat
// （会话形态参数 + 冷续 resume 锚点），major 不 bump。[H1] chat-run 统一后续聊 =
// 新 run + resume 锚点（docs/architecture/subagent-chat-run-unification.md §3.3 D5/D7），
// 既有 interact 方法已随 U5 删除，方法集收敛为 9 个。
//
// 应答面补充约定（设计 §3.3）：initialize 应答仅诊断（与 manifest 不一致 → warn 留痕，
// 不参与同步成员判据；唯一阻断面 = 被 gate 能力位多声明 → engine_capability_mismatch）；
// listModels / validateModel 为诊断面（宿主侧同步成员读 manifest，不经本方法）；
// dispose 幂等；ping 为健康检查（ADR-0047：静默 ≠ 卡死，不据此杀任务）；
// setModel 应答 = 回读生效值（引擎 set 后经 get_state 同源读回，不信命令应答即真——
// pi 部分模型族静默替换成同族模型，生效值 ≠ 请求值，先例 = 主对话 set→回读范式）；
// 失败经 error 帧，分型值域 = error-codes.ts SET_MODEL_ERROR_CODES 三型。
//
// 未知正向 method 的应答义务（未知成员宽容语义②，条文权威 = ADR-0071）：宿主演进
// 会派出本引擎未知的正向 method（协议 additive 演进的跨代窗口）——引擎必须回 error
// 帧，不得静默挂起/无应答/崩溃。实装码现状：两引擎 server（pi/zcode dispatch 表
// 落空分支）对未知 method 回 `engine_protocol_unknown_method`（engine_ 前缀透传面，
// 不进 core 消费词表，isEngineErrorPassthroughCode 原样透传，旧宿主收到不崩）；
// 条文名码 `engine_method_unsupported` 全仓零消费方（C 型「无消费方不进协议」纪律，
// 登记 = error-codes.ts 头注）——义务成文 =
// docs/extensions/subagents/engine-development-guide.md §2.1/§13。

import type {
  AgentCallOpts,
  EngineCapabilities,
  EngineHandleData,
  AgentOutcome,
  ModelCatalogEntry,
  ModelRef,
  ProbeReport,
  ResumeAnchor,
  SessionView,
} from "./contract-types.ts";

/**
 * 正向方法名联合（恰好 10 个；PROTOCOL_METHODS 常量数组与之同源互证）。
 * [H1] `interact` 成员已随 chat-run 统一退役（docs/architecture/subagent-chat-run-unification.md
 * §3.3 D5：续聊轮统一为「新 run + resume 锚点」，U5 删除）。
 * [subagent-model-switch] `setModel` 为执行中模型热切换方法（capabilities.setModel
 * 位门控；消费点 = 宿主发送前预检，位不支持不发调用）。
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
  | "ping"
  | "setModel";

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
  "setModel",
] as const satisfies readonly ProtocolMethod[];

// ============================================================
// run 专用载荷
// ============================================================

/**
 * run 上下文（RunContext 字段映射的协议承载，设计 §3.3 RunContext 映射表）。
 */
export interface RunContextParams {
  /** 任务工作目录（worktree 隔离时 = worktree 路径）。缺省不上 wire——引擎侧
   *  回退自身进程 cwd（spawn 继承语义）。 */
  cwd?: string;
  /** 请求模型 ref（未传 = 引擎缺省模型）。 */
  model?: string;
  /** 上下文模型 ref（与 run 模型分离的 ctx 模型）。 */
  ctxModel?: string;
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
  /**
   * [D2 扩展加载显式化] 孙进程显式加载的扩展路径集（pi 引擎侧逐项拼
   * `--extension` argv）。per-host 常量而非 per-run 变量，故落 ctx。宿主侧来源
   * 双形态：taiji 宿主 = extension-service 下发的白名单收窄集（经 pi-host 注入）；
   * 独立 pi = subagent-workflow 自身 optional peerDep 解析回退。additive 可选：
   * 旧引擎忽略未知字段，undefined 不上 wire。
   */
  extensionPaths?: string[];
  /**
   * [D4 record 身份信封] 本次 run 的 **record 级身份**（引擎把它整封写进任务子进程的
   * 身份 env；见 SDK `identity-env.ts` 的 `SUBAGENT_IDENTITY_ENV`）。
   *
   * 为什么是信封而不是三个平铺键：`slug` 与 task 侧 `description` 是同一语义的两种写法，
   * 平铺进 ctx 会撞 wire 层绝对条款「同一语义不得 task/ctx 双写」（`wire-field-locks.test.ts`
   * 的 `keyof AgentCallOpts & keyof RunContextParams = never`）；信封把「record 身份」立成
   * 一个独立概念（与「怎么执行这次调用」的 task 面正交），也给后续身份字段一个归处。
   *
   * 字段语义（缺省即不写该键，读者按各自回落语义工作）：
   *   - `slug`：record 短标签（宿主侧由 record 的 description 派生的展示标签）；
   *   - `startedAt`：record 起始时刻（epoch ms；宿主派发时刻即权威值，引擎不得改写）；
   *   - `mode`：执行形态（`background` / `chat`，record 级事实）。
   *
   * additive 可选：旧引擎忽略未知字段，undefined 不上 wire。
   */
  identity?: {
    slug?: string;
    startedAt?: number;
    mode?: string;
  };
}

// ============================================================
// [H1] run 的 resume 会话形态参数（chat-run 统一终态；原 v1.x chat 键已退役）
// ============================================================

/**
 * [H1] run 的 resume 会话形态参数（设计 docs/architecture/subagent-chat-run-unification.md
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
  /** 数据根（core 每次 read 都发送——remote-engine 构造注入的数据目录）。两引擎
   *  server 现行均不消费该字段：定位走 handle.data（recordPath 等）或引擎自身
   *  数据目录。保留为协议帧字段（历史：存量池时代引擎自算池/journal 相对 dbPath
   *  的定位需要它）。 */
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

/**
 * [subagent-model-switch §7.3] setModel 参数——RunParams 同级的 run 定向方法
 * （params 以 runId 寻址活跃子进程，对照 cancel）。
 *
 * 语义（引擎侧实装义务，权威 = 设计 §7.3）：定位活跃子进程 → 转发 pi 原生
 * `set_model` → 读应答 → get_state 回读生效值 → 应答。请求 model 是**目标意图**
 * （pi 部分模型族会静默替换成同族模型），生效值以应答 effectiveModel 为准。
 * 失败经 error 帧，分型值域 = SET_MODEL_ERROR_CODES 三型
 * （engine_model_not_in_snapshot / engine_credential_missing / engine_state_readback_failed）；
 * 目标 run 无活跃子进程（定位时 / 命令写入 / 读应答 / 回读四个竞态窗口内退出——
 * 同一处置）按「无活进程」形态应答 = error 帧 `SET_MODEL_NOT_ACTIVE_CODE`
 * （engine_run_not_active，宿主转纯记账路径，§7.5 子进程已退出行）。
 *
 * 无 thinkingLevel 参数（D5 裁决 M1-1）：热切档位由 pi set_model 按新模型档位表
 * 联动重设管辖（生效值以应答 effectiveThinkingLevel 为准）；用户显式档位经覆盖
 * 记账在下一轮 spawn 由解析链裁决（§6.2 跨轮档位以解析链为准）。未来引擎真支持
 * 档位热切时走 additive 演进（新增可选参数）。
 *
 * 消费链：U2 宿主编排经 EnginePort 调用（capabilities.setModel='native' 预检通过后）；
 * U3 pi 引擎实装；U5 run 级聚合逐成员转发复用同一方法。
 */
export interface SetModelParams {
  /** 目标 run 的 id（RunParams.runId 同源——引擎以它定位活跃子进程）。 */
  runId: string;
  /** 目标模型 ref（provider + modelId；宿主编排层负责与 canonical ref 目录互校）。 */
  model: ModelRef;
}

/**
 * [subagent-model-switch §7.3] setModel 应答——**回读生效值**（get_state 同源读回，
 * 非命令应答转述；同族替换时 effectiveModel ≠ 请求 model）。
 */
export interface SetModelResult {
  /** 生效模型 ref（pi 子进程活状态读回）。 */
  effectiveModel: ModelRef;
  /** 生效 thinking 档位（pi set_model 联动重设后的实际档位）。 */
  effectiveThinkingLevel: string;
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
  setModel: SetModelParams;
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
  setModel: SetModelResult;
}
