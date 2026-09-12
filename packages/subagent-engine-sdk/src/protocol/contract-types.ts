// src/protocol/contract-types.ts
//
// 引擎面契约类型 SSOT（协议两侧不许各写一份；core 反向 re-export 保上层消费面）。
// 设计权威源：docs/design/subagent-engine-protocolization.md §3.5.1 D7 类型闭包表 +
// impl-plan §2.1「类型闭包处置」。
//
// 搬运口径（逐字对照，结构等价、零 core import）：
//   - AgentEvent / AgentUsage / AgentUsageTotal / ToolCallResult / ToolCall /
//     InternalToolCall / Turn ← core execution/types.ts（2026-09-09 实测 :164-:313）
//   - ReplayedTurn / SessionView / EngineHandleData / EngineCapabilities / ProbeReport /
//     AgentOutcome ← core execution/engine/types.ts
//   - AgentFailureKind / AgentOutcomeUsage（core 名 AgentUsage，orchestration 版）/
//     ToolCallEntry / AgentCallOpts 子集 ← core orchestration/models/types.ts
//   - WorktreeHandle ← core execution/types.ts:349（SDK 结构等价副本——设计 §3.5.1
//     点名「AgentCallOpts.worktree 的 WorktreeHandle 即这类副本」）
//
// [H1] InteractAction / InteractResult 已随 chat-run 统一退役（U5 删除；
// docs/design/subagent-chat-run-unification.md §3.3 D5——续聊统一为新 run + resume）。
//
// core 域类型（ExecutionRecord / Turn 的宿主内部态消费）留 core；SDK 侧一切类型为
// 结构等价形态，漂移由双向可赋值断言（AssertMutuallyAssignable）在 typecheck 期抓出
// ——core 侧断言挂靠归 W2（本文件导出该类型助手供其复用），SDK 侧样板见
// src/__tests__/contract-closure.test.ts。

// ============================================================
// 断言助手（W2 core 侧双向可赋值断言复用）
// ============================================================

/**
 * 双向可赋值断言：`type _A = AssertMutuallyAssignable<CoreX, SdkX>` 结果必须为 true。
 * 任一方向不可赋值（字段缺失 / 可选性漂移 / 联合分支不齐）结果为 never → 编译失败。
 * 用法（core 侧 W2 挂靠）：
 *   import type { AssertMutuallyAssignable } from "@zhushanwen/subagent-engine-sdk";
 *   type _CoreSdkAgentEvent = AssertMutuallyAssignable<CoreAgentEvent, SdkAgentEvent>;
 *   const _assert: _CoreSdkAgentEvent = true;
 */
export type AssertMutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

// ============================================================
// 事件面（AgentEvent 及其字段型）
// ============================================================

/** token 用量（message_end 单条消息增量）。← core execution/types.ts AgentUsage。 */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 本 message 的成本（USD）。无成本数据时缺省。 */
  cost?: number;
}

export interface AgentUsageTotal extends AgentUsage {
  /** 四项之和。投影时不再手工求和。 */
  total: number;
  /** 累计成本（USD）。无成本数据时为 0。 */
  cost: number;
}

/** tool 调用结果（tool_end 携带，含 structured-output 的 details）。 */
export interface ToolCallResult {
  content?: unknown[];
  details?: unknown;
}

/** tool 调用（导出的纯净数据形状，不含内部状态机）。 */
export interface ToolCall {
  toolName: string;
  args?: unknown;
  result?: ToolCallResult;
  isError?: boolean;
}

/** 内部 ToolCall：追加 _status 进行中标记与 startedTs（reducer 内部态，跨边界导出前 strip）。 */
export interface InternalToolCall extends ToolCall {
  _status: "running" | "done" | "failed";
  /** tool_start 到达时的墙钟时间戳（Date.now()，ms）。 */
  startedTs: number;
}

/** 一个 turn 的完整内容（reducer turns[] 的元素）。 */
export interface Turn {
  /** 本 turn assistant 正文（text_delta 流式累积，完整）。 */
  text: string;
  /** 本 turn 推理（thinking_delta 流式累积，完整）。 */
  thinking: string;
  /** 本 turn 工具调用（InternalToolCall：含完整 result + _status 进行中标记）。 */
  toolCalls: InternalToolCall[];
  /** 本 turn message_end 的 token 增量（聚合得 usage 总量）。 */
  usageDelta?: AgentUsage;
  /** turn_end 是否已到达。false=正在进行；true=已闭合。 */
  closed: boolean;
  /** turn_end 到达时的墙钟时间戳（Date.now()，ms）。 */
  closedTs?: number;
}

/**
 * 引擎事件（9 种，协议 event.params.event 逐字序列化——「事件与 handle 序列化逐字
 * 兼容」不变量 3 的类型面）。语义锚点 = pi（ACP 词汇对照见 core execution/types.ts 注释）。
 *
 * activity = 纯活性信号：双侧 reducer no-op、不开 turn、不写状态、不落 journal
 * （core journal-wiring 对其豁免 append），只承诺「引擎活跃时周期性出现」——供宿主
 * 无进展守护刷新判活（长工具执行期）。节流属生产者实现细节，不进协议承诺。
 */
export type AgentEvent =
  | { type: "tool_start"; toolName: string; args?: unknown }
  | { type: "tool_end"; toolName: string; args?: unknown; result?: ToolCallResult; isError?: boolean }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "turn_end"; summary?: string }
  | { type: "message_end"; usage?: AgentUsage; error?: string }
  | { type: "compaction" }
  | { type: "activity" }
  | { type: "error"; message: string };

// ============================================================
// handle / read 视图
// ============================================================

/**
 * EngineHandle 的持久化形态（JSON v1）。协议 run 终态应答 / read 的
 * handle 载荷（引擎不持有宿主运行时引用，data 即全部）。
 */
export interface EngineHandleData {
  v: 1;
  /** 引擎 id（'pi' | 'zcode' | ...）。 */
  engineId: string;
  /** 引擎自定义定位键值。pi = { recordId?, sessionFile? }；zcode = { sessionId, dbPath }。 */
  sessionRef: Record<string, string>;
  /** 隔离池定位。pi 无池化恒 'shared'。 */
  poolKey: string;
  /** journal 绝对路径（read 第②级数据源；宿主读前校验前缀白名单）。缺省 = 无 journal。 */
  journalPath?: string;
  /** probe 实测版本（漂移排查锚点）。 */
  engineVersion?: string;
  /** 适配器版本（golden 样本对齐排查）。 */
  adapterVersion: string;
}

/**
 * [v1.x] 冷续 resume 锚点——EngineHandleData 定位键的投影子集（诊断字段
 * v/engineVersion/adapterVersion 不属锚点语义，不随锚点走）。消费点：
 *   - run.params.resume（宿主 → 引擎：冷续重开已 idle 的 session，pi 消费
 *     sessionRef.sessionFile —— 对照 core SpawnResumeOpts.sessionFile 的锚点面）。
 * [H1 U6 已切换] 键切换单批完成（读写端同批），锚点仅经 resume 键携带。
 * 类型层与 EngineHandleData 定位形态的对照由测试断言（Pick 可赋值闭包）锁定。
 */
export interface ResumeAnchor {
  /** 引擎定位键（pi = { recordId?, sessionFile? }；zcode = { sessionId, dbPath }）。 */
  sessionRef: Record<string, string>;
  /** 隔离池定位（锚点补全 handle 重建所需；pi 无池化恒 'shared'）。 */
  poolKey: string;
  /** journal 绝对路径（read 降级链第②级数据源；无 journal 缺省）。 */
  journalPath?: string;
}

/** Turn → ReplayedTurn：剥离内部态（closed 恒 true——重放物无进行时语义）。 */
export interface ReplayedTurn {
  text: string;
  thinking: string;
  /** 导出的纯净形状（ToolCall，无 _status/startedTs）。 */
  toolCalls: ToolCall[];
  closed: true;
}

/**
 * session 历史的引擎中立视图（协议 read 应答）。降级链三级：①引擎原生读取 →
 * ②宿主 event journal 重放 → ③outcome-only。source 字段是 GUI 降级标记数据源。
 */
export interface SessionView {
  engineId: string;
  sessionId?: string;
  /** turns[] 派生数据（重放/重建产物）。 */
  turns: ReplayedTurn[];
  /** 各 turn usageDelta 聚合。 */
  usage?: AgentUsageTotal;
  source: "native" | "journal" | "outcome-only";
}

// ============================================================
// 能力 / 探针 / 交互
// ============================================================

/**
 * 引擎能力声明（11 位）。三级：native / emulated / unsupported。
 * 声明的是本仓 subagent 链路实际接通的能力，不是引擎 RPC 层的理论能力。
 * 同步权威 = manifest（注册期直读）；握手应答仅诊断（§3.3「同步成员清单」）。
 */
export interface EngineCapabilities {
  /** native: --json-schema/--output-schema/env 注入。 */
  schemaEnforcement: "native" | "emulated";
  /** 注意区分「引擎 RPC 层有此能力」与「subagent 链路已接通」。 */
  steer: "native" | "emulated" | "unsupported";
  /**
   * [H1 D5 语义收窄] resume 能力位（chat 续聊 = 新 run + resume 锚点的承载前提；
   * 原名字沿用——conversation 位保留、语义从「interact 长驻控制面」收窄为
   * 「resume 续聊能力」，gate 判据与消费方不变）。
   */
  conversation: "native" | "unsupported";
  /** 决定 persona 路由策略（file/flag/prompt 通道）。 */
  personaInjection: "file" | "flag" | "prompt";
  /** 粗粒度引擎：GUI 显示降级为阶段态。 */
  eventGranularity: "stream" | "coarse";
  /** emulated = worktree 隔离（无 OS sandbox 的引擎用文件写维度隔离补齐）。 */
  sandbox: "native" | "emulated" | "none";
  /** 重建历史的能力（read 降级链第①级保真度上限）。 */
  sessionRead: "full" | "partial" | "outcome-only";
  resume: "native" | "cold" | "unsupported";
  /** 优雅中断 or 只能杀进程（公共杀链兜底）。 */
  interrupt: "native" | "kill-only";
  /** kimi headless 固定 auto = ignored；GUI 据此隐藏/提示。 */
  permissionMode: "native" | "fixed" | "ignored";
  /** maxTurns 轮数上限执行能力位（pi=true / zcode=false）。 */
  maxTurns: boolean;
}

/** 引擎探针报告（probe 应答）。ok=false 时 error 必填（恢复指引）。 */
export interface ProbeReport {
  ok: boolean;
  /** 实测版本（探测不到时为空串）。 */
  engineVersion: string;
  /** 二进制存在/版本解析/干跑回归逐项。 */
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  /** engine_probe_failed 的恢复指引（ok=false 时必填）。 */
  error?: { code: string; recovery: string };
}

// ============================================================
// 终态 / 任务声明
// ============================================================

/** 失败分诊结构化标签。unknown（含缺省）= 可重试（语义守恒）。 */
export type AgentFailureKind = "stale_context" | "schema_deterministic" | "unknown";

/**
 * AgentOutcome.usage 字段型（← core orchestration/models/types.ts AgentUsage 结构等价；
 * SDK 改名消歧——core 的两个同名 AgentUsage 分属 execution 与 orchestration 域）。
 */
export interface AgentOutcomeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** 单次 tool 调用记录（workflow trace 形态）。 */
export interface ToolCallEntry {
  /** Tool name. */
  name: string;
  /** Args preview string. */
  input: string;
}

/** worktree 句柄（结构等价副本；core 权威定义在 execution/types.ts:349）。 */
export interface WorktreeHandle {
  /** checkout 目录（子 agent 工作目录）。 */
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
  /** 主仓库根目录（cleanup/scan 需要）。 */
  readonly mainCwd: string;
}

/**
 * 一次引擎执行的终态（协议 run 终态应答的 outcome 载荷）。锚定 core
 * orchestration AgentResult 并追加引擎层字段（engineId / engineFallback / exitCode）。
 */
export interface AgentOutcome {
  content: string;
  /** 失败分诊标签。产出侧 = 引擎；缺省 = unknown = 可重试。 */
  failureKind?: AgentFailureKind;
  /** native 引擎直传 / 仿真层 ajv 产出（D4 硬分流：native 路径宿主不做二次校验）。 */
  parsedOutput?: unknown;
  usage?: AgentOutcomeUsage;
  durationMs?: number;
  /** 错误码前缀格式（`<code>: <detail>`，错误规格见协议 error-codes）。 */
  error?: string;
  /** 引擎语义 session id。 */
  sessionId?: string;
  sessionFile?: string;
  /** 仅诊断——目录可能已被 finalize 清理，不得作为 cwd 复用。 */
  worktreePath?: string;
  toolCalls?: ToolCallEntry[];
  /** 实际执行引擎（fallback 后可能 ≠ 请求值）。 */
  engineId: string;
  /** fallback 留痕（record 同步投影，GUI 警告条数据源）。 */
  engineFallback?: { from: string; reason: string };
  /** null = 被信号杀死（杀链/abort 合成终态的判据）。 */
  exitCode?: number | null;
}

// ============================================================
// AgentCallOpts 引擎面子集（协议 run.params.task）
// ============================================================

/**
 * 引擎模型目录条目（manifest `modelCatalog.models` 条目形态，设计 §3.4 示例）。
 * 协议面 = initialize 应答 models? 与 listModels 应答 models 的元素型；
 * manifest 解析与生成（gen:model-catalog）归 W4/W5 实装。
 */
export interface ModelCatalogEntry {
  id: string;
  aliases?: string[];
  canonicalRef?: string;
}

/**
 * 单次 agent 调用的任务声明——引擎面子集（协议 run.params.task；core 全量
 * AgentCallOpts 22 字段留 core，core 侧反向 re-export 保消费面）。
 *
 * 字段裁决（对照 core orchestration/models/types.ts AgentCallOpts，2026-09-09）：
 * - 入选 = 引擎消费面：任务语义（prompt/schema/thinkingLevel/skill/skillPath/agent/persona 注入）、
 *   轮次预算（maxTurns/graceTurns/conversation/idleTimeoutMs）、隔离与权限（worktree/
 *   fork/forkSource/denyTools/permissionMode）、诊断（description/scene）；
 * - 排除并改挂 run.params.ctx（协议层已单列，task 内双写会分叉）：model（→ctx.model）、
 *   schemaEnv（→ctx.schemaEnv）、cwd（→ctx.cwd）、engineFallback（→ctx.engineFallback）；
 * - 排除（宿主侧消费，无引擎语义）：engine（路由决策已完成，收到的引擎即选中值）、
 *   timeoutMs（宿主超时链 mergeTimeoutSignal → cancel 帧，非引擎参数）、returnMeta
 *   （core 注释明确「dropped at the pi boundary」，非引擎消费）。
 *
 * W2 实装 EngineClient run 帧时以本类型为 params.task；core 侧全量 → 子集的方向性
 * 收窄（多余字段宿主自持不透传）不构成类型漂移（断言方向见 contract-closure 测试样板）。
 */
export interface AgentCallOpts {
  /** The task prompt to send to the agent. */
  prompt: string;
  /** Optional JSON schema for structured output（引擎按 capabilities.schemaEnforcement 分流）。 */
  schema?: Record<string, unknown>;
  /** Thinking level override（"high" | "medium" | "low" 等引擎自解释词表）。 */
  thinkingLevel?: string;
  /** Scene name passed through for model-selection hints. */
  scene?: string;
  /** Turn 上限（turn limiter）。未传或 <=0 = 不限。 */
  maxTurns?: number;
  /** Turn limiter 宽限轮数：超 maxTurns 后允许继续的轮数。 */
  graceTurns?: number;
  /** Skill name to load（引擎解析为 SKILL.md 注入）。 */
  skill?: string;
  /** Resolved absolute path to the skill directory or SKILL.md file. */
  skillPath?: string;
  /** Human-readable description for logging and debugging（slug 源字段）。 */
  description?: string;
  /** Agent ref (absolute .md path)——身份解析锚点。 */
  agent?: string;
  /** System prompt injection CONTENT（非文件路径）。 */
  appendSystemPrompt?: string[];
  /** Inherit parent session context (fork mode)。与 worktree（文件隔离）独立。 */
  fork?: boolean;
  /**
   * [v1.x 增量] fork-from 显式分叉源 session 文件绝对路径（断联 subagent 接续场景，
   * 宿主点名任意已有 session 文件；fork=true 则由引擎用主 session 作源，两者互斥——
   * 本字段存在时优先）。字段名对齐引擎侧既有 SpawnRunParams.forkSource（pi 引擎经
   * `--fork <path>` 消费）。可选增量、负向兼容：无此概念的引擎（zcode）按未知可选
   * 字段忽略，行为与不传一致；宿主能力门（capability-gate）仍按 steer/conversation
   * 通道族预检，不依赖引擎对本字段的支持声明。
   */
  forkSource?: string;
  /** Filesystem isolation: 新建 worktree | 复用外部已创建 worktree | 不隔离。 */
  worktree?: boolean | WorktreeHandle;
  /** 可持续对话模式：true = 轮次完成进 idle 态等待 message 续聊。 */
  conversation?: boolean;
  /** 空闲超时毫秒数（仅 conversation 模式有意义）。显式 0/负 = 禁用 idle GC。 */
  idleTimeoutMs?: number;
  /** 工具 denylist（各引擎做语法映射）。 */
  denyTools?: string[];
  /** 中立权限模式（映射按各引擎 capabilities.permissionMode）。 */
  permissionMode?: string;
}
