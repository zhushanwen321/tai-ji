/**
 * Workflow Extension — Engine 共享类型
 *
 * Engine 层全局基础类型。零 infra 依赖——不 import 任何 infra 文件，
 * 可独立编译测试（D-12 三层架构，AC-1）。
 *
 * 核心内容：
 * - 状态机：RunStatus = "running" | "done"（2 态，一次性生命周期，FR-3）
 * + DoneReason（completed/failed/aborted/budget_limited/time_limited）
 * - AgentCallOpts / AgentResult（单次 agent 调用的输入/输出，宿主面 SSOT 留守本地）
 * + AgentUsage / ToolCallEntry / AgentFailureKind（自 SDK re-export，S4 簇 3 收编）
 * - ExecutionTraceNode / TracePatch / ToolCallEntry / WorkerLogEntry（trace 数据）
 *
 * 层归属：Engine（数据结构 + 不变式守卫）。
 */

import type {
  AgentFailureKind,
  AgentOutcomeUsage as AgentUsage,
  ToolCallEntry,
} from "@zhushanwen/subagent-engine-sdk";

import type { WorktreeHandle } from "../../execution/types.ts";

// ── 状态机 ────────────────────────────────────────────────────

/**
 * 状态机：2 态（D-12 / FR-3，一次性生命周期——run 不可挂起）。
 *
 * running → done
 *
 * `done` 是唯一终态，具体原因由 DoneReason 区分。
 */
export type RunStatus = "running" | "done";

/** 终态原因。done 时必有（WorkflowRun 不变式）。 */
export type DoneReason =
  | "completed"
  | "failed"
  | "aborted"
  | "budget_limited"
  | "time_limited"
  // m3：runAndWait 合成返回值专用——参数校验失败（run 从未创建，不进入 run.state.reason）
  | "invalid_args";

/** 合法的状态转换。空数组 = 无出边（done 终态）。 */
export const VALID_RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  running: ["done"] as const,
  done: [] as const,
};

export const ALL_RUN_STATUSES: readonly RunStatus[] = ["running", "done"] as const;

export const ALL_DONE_REASONS: readonly DoneReason[] = [
  "completed",
  "failed",
  "aborted",
  "invalid_args",
  "budget_limited",
  "time_limited",
] as const;

/** done 为终态，无出边。 */
export function isDone(status: RunStatus): boolean {
  return status === "done";
}

export function canRunTransition(from: RunStatus, to: RunStatus): boolean {
  return (VALID_RUN_TRANSITIONS[from] as readonly RunStatus[]).includes(to);
}

// ── Agent 调用 ────────────────────────────────────────────────

/**
 * slug 最大长度（D6 合流迁入本文件，原权威定义在已删除的 execution/execute-options-mapper.ts）。
 * 历史值 20 偏紧——描述性 slug 如 "audit-structured-output"（23）/ "fix-subagent-wf-tools"（21）
 * 会撞上限，放宽到 35 兼顾「短到能塞进 TUI 标题行」与「容纳合理描述性 kebab-case 名」。
 * 放本文件的原因：约束对象是 AgentCallOpts.description（slug 的源字段，见下方 slug 派生说明），
 * 与字段同文件；subagent-actions-core（slug 校验）、subagent-service（record slug 截断）
 * 与壳侧 tool schema maxLength 共享引用。
 */
export const SLUG_MAX_LENGTH = 35;

/**
 * 单次 agent 调用的任务声明（D6 任务形状合流后的单一形状）。
 *
 * [D6 合流裁决] 本类型 = 原 AgentCallOpts（workflow 调用方声明，18 字段）与原
 * AgentTaskSpec（engine 中立任务声明，已删除）的合流形态，从模型脚本 agent() API
 * 到 EnginePort.run 直达 pi 边界一次映射——SAR 链路上的 ExecuteOptions/AgentTaskSpec
 * 中间态消除（设计 docs/design/subagent-dual-track-convergence.md §3.3 D6 / 终态四）。
 *
 * 终态命名按变化轴裁定为 AgentCallOpts，理由：
 *   - 字段演进的首要驱动轴是「调用方要表达的任务语义」（agent() API 是唯一生产写入方，
 *     合流字段中 prompt/description/skill/skillPath/schemaEnv/thinkingLevel 等多数派
 *     已是调用方命名）；
 *   - 原 AgentTaskSpec 的中立重命名层（task/slug/effort/persona）与调用方命名是
 *     形式同构、语义同构的假差异（prompt≡task、slug=description 截断、effort≡thinkingLevel、
 *     persona≡skillPath+appendSystemPrompt 平铺），按「消假差异」原则并入调用方命名；
 *   - 持久化兼容反向锁定 prompt 形态：jsonl run 快照的 AgentCall.opts 与 worker 消息
 *     opts 均以 prompt 字段落盘，改名会破坏旧快照重水合。
 *
 * 引擎中立字段的并入方式（可选字段，原 AgentTaskSpec 独有字段去向）：
 *   - graceTurns / conversation / idleTimeoutMs / denyTools / permissionMode：可选并入；
 *   - persona.agentRef：裁撤（无生产写入方、无消费者——pi 走 agent 字段解析身份）；
 *   - requires：裁撤（P4 形状预留、无生产写入方；且并入需 import EngineCapabilities
 *     形成 orchestration↔engine 类型环）。将来能力依赖声明下钻时在本形状上加回。
 *
 * D-12 仅重组执行编排，AgentCallOpts 形状保持兼容。
 */
export interface AgentCallOpts {
 /** The task prompt to send to the agent. */
  prompt: string;
 /**
 * Optional JSON schema for structured output.
 * When provided, the schema is passed via PI_WORKFLOW_SCHEMA env to the subprocess,
 * which activates the structured-output tool + turn_end hook.
 * The tool's execute validates model output against the schema.
 * On success, `parsedOutput` on the result is set to `tool_execution_end.result.details`
 * (the validated, parsed data object — not the raw tool call args).
 */
  schema?: Record<string, unknown>;
 /**
 * Model to use (e.g. "router-openai/glm-5.1").
 * When omitted, pi's default model is used.
 */
  model?: string;
 /**
 * Thinking level override (e.g. "high", "medium", "low").
 * M2: Added to align with subagent path's ExecuteOptions.thinkingLevel.
 * When omitted, agent .md frontmatter thinkingLevel is used (via resolveIdentity/getAgentConfig).
 */
  thinkingLevel?: string;
 /** Scene name passed through to the worker for model-selection hints. */
  scene?: string;
 /**
 * Wall-clock timeout in milliseconds. When > 0, aborts the subprocess
 * if it runs longer than this, regardless of external signal.
 * Per-call，归 AgentCall 实体（G-027）。
 */
  timeoutMs?: number;
 /**
  * Turn 上限（turn limiter 用）。
  *
  * [预算语义对齐] 未传或 <=0 = 不限 turn；此时也不按 turns 估算 spawn watchdog——
  * 仅当 env XYZ_SUBAGENT_SPAWN_WATCHDOG_MS 设置时才按绝对时限挂 watchdog（见
  * session-runner.resolveSpawnWatchdogMs）。pi 边界直出为 ExecuteOptions.maxTurns
  * → runSpawn（D6 合流后无中间映射层）。
  */
  maxTurns?: number;
 /**
  * Turn limiter 的宽限轮数（原 AgentTaskSpec.graceTurns 并入）：超 maxTurns 后
  * 允许继续的轮数（等待在途工具收尾）。pi 引擎消费；workflow agent() 无写入方，
  * chat 域（ExecuteOptions.graceTurns 同名透传）经 host-task-spec 填充。
  */
  graceTurns?: number;
 /**
 * Skill name to load (e.g. "code-review"). Resolved to SKILL.md path
 * and injected via --skill flag in the subprocess.
 */
  skill?: string;
 /**
 * Resolved absolute path to the skill directory or SKILL.md file.
 * Set by agent-opts-resolver when opts.skill is present.
 */
  skillPath?: string;
 /** Human-readable description for logging and debugging. */
  description?: string;
 /**
 * Agent ref (absolute .md path). Resolved by resolveIdentity via getAgentConfig,
 * which injects the agent's systemPrompt/model/tools/thinkingLevel. Not handled by
 * resolveAgentOpts (single-responsibility: agent ref ownership belongs to resolveIdentity,
 * M2 fix — previously overlapped causing double-injection + model-tier confusion).
 */
  agent?: string;
 /**
  * System prompt injection CONTENT (not file paths).
  * Set by agent-opts-resolver: schema structured-output instruction string.
  * Agent systemPrompt is NOT included here (handled by resolveIdentity/agentConfig).
  * pi 边界直出为 ExecuteOptions.appendSystemPrompt（同名同义透传，D6 合流后无中间映射层）。
  */
  appendSystemPrompt?: string[];
 /**
  * Schema JSON for PI_WORKFLOW_SCHEMA env var.
  * Set by agent-opts-resolver when opts.schema is present (值 = stringifySchemaCached
  * compact，与 schema 派生等值); passed as env var to activate the structured-output
  * tool + hook. pi 边界直出时 schema 派生优先、本字段兜底（解耦形态通道，生产不可达）。
  */
  schemaEnv?: string;
 /**
 * Per-call 工作目录（ADR-029 决策 1）。传给 child_process.spawn 的 cwd option。
 *
 * 用于 worktree 隔离：传入 worktree 绝对路径，spawn 的 pi 子进程绑定到该目录，
 * 其内部的 createAgentSession/ResourceLoader/bash 工具都在该目录运行。
 * undefined 时 spawn 继承 workflow 进程的 cwd（向后兼容）。
 */
  cwd?: string;
  /** Inherit parent session context (fork mode). Independent of worktree (file isolation). */
  fork?: boolean;
  /**
   * fork-from 显式分叉源 session 文件（fork-from 断联恢复通道的唯一 lossless 载体）。
   * 来源 = ExecuteOptions.forkFromSessionFile（host-task-spec 映射时的唯一改名点——
   * 本形状起与 SDK 协议字段、引擎侧 SpawnRunParams.forkSource 三层同名，降低跨层
   * 双名漂移面）。区别于 fork:true（主 session 作分叉源）：本字段点名任意已有
   * session 文件。chat 域唯一写入方 = fork-from action。
   */
  forkSource?: string;
  /**
   * 执行引擎 id（P4 D9 三层优先级的第一层：调用参数级，workflow step 显式指定）。
   * 仅限「必须某引擎独有能力」的场景使用并注释原因（D9③ workflow 脚本不写死
   * engine——环境差异由 frontmatter/全局默认承载）；透传链 worker-script-builder
   * agent() → execute-agent-call → SAR 路由层。
   */
  engine?: string;
  /** Filesystem isolation: when true, creates a new git worktree for the agent. Independent of fork.
   * [D6 合流] 类型扩展为 boolean | WorktreeHandle（原 AgentTaskSpec.worktree 的超集）——
   * WorktreeHandle 形态仅在 chat 域（复用外部已创建的 worktree）出现，workflow agent()
   * 恒传 boolean。 */
  worktree?: boolean | WorktreeHandle;
  /** When true, agent() resolves {value, sessionFile, worktreePath, error} instead of a bare value.
   * Worker-layer flag only — not consumed by any engine (dropped at the pi boundary). */
  returnMeta?: boolean;
 /**
  * 可持续对话模式（原 AgentTaskSpec.conversation 并入）：true = record 标记 chatMode，
  * 轮次完成进 idle 态等待 message 续聊。chat 域（ExecuteOptions.conversation 同名）经
  * host-task-spec 填充；workflow agent() 无写入方。
  */
  conversation?: boolean;
 /**
  * 空闲超时毫秒数（原 AgentTaskSpec.idleTimeoutMs 并入，仅 conversation 模式有意义）。
  * 优先级：参数 > env XYZ_SUBAGENT_IDLE_TIMEOUT_MS > 默认 300000ms；显式 0/负 = 禁用
  * idle GC。chat 域经 host-task-spec 填充。
  */
  idleTimeoutMs?: number;
 /**
  * 工具 denylist（原 AgentTaskSpec.denyTools 并入，中立新增面）：各引擎做语法映射
  * （zcode buildZcodeArgv 消费；pi 链路暂无对应面）。无 workflow 写入方，预留形状。
  */
  denyTools?: string[];
 /**
  * 中立权限模式（原 AgentTaskSpec.permissionMode 并入，预留形状）：映射按各引擎
  * capabilities.permissionMode。无生产写入方/消费者。
  */
  permissionMode?: string;
}

// [S4 簇 3 收编] 以下三个契约类型本地定义已删除，自 @zhushanwen/subagent-engine-sdk
// re-export（type-only，import 方路径零改动，结构等价由 protocol-closure.test.ts
// 断言族守卫）：
//   - AgentUsage ← SDK AgentOutcomeUsage（SDK 改名消歧：core 的两个同名 AgentUsage
//     分属 execution 与 orchestration 域，本处锚定 orchestration 域——AgentResult.usage
//     字段型，FR-7 跨 turn 累积）；
//   - ToolCallEntry（单次 tool 调用记录，FR-7 从 agent JSONL 流采）；
//   - AgentFailureKind（失败分诊结构化标签，D5-③）。
// AgentCallOpts / AgentResult 留守本地（宿主面 SSOT——SDK 版 AgentCallOpts 是引擎面
// 子集，字段裁决见 SDK contract-types 注释）。
//
// AgentFailureKind 语义守恒（最高优先约束，core 侧权威说明——SDK 侧为简版）：
// - stale_context：pi session context 被 compact/cancel/替换——重试无意义（同 call
//   再次失败），不重试。
// - schema_deterministic：确定性 schema 失败（SO tool 从未调用 / gate 终止 /
//   不可满足 schema）——同 schema 重试必同结果，不重试。
// - unknown：其余一切失败（瞬态 provider 错误、spawn 失败等）——**默认可重试**。
//   unknown（含字段缺省）= 可重试；仅 stale_context 与 schema_deterministic 两态
//   维持不重试特判。词表归属（产出侧单点识别）：识别词表保留在产出侧
//   execution/engine/inproc pi 引擎目录/output-collector.ts 包内——词表漂移的失效模式
//   是 failureKind=unknown → 保守重试（安全默认），不再是静默漏诊。
export type {
  AgentFailureKind,
  AgentOutcomeUsage as AgentUsage,
  ToolCallEntry,
} from "@zhushanwen/subagent-engine-sdk";

/**
 * 单次 agent 调用的结果（统一形态）。
 *
 * Engine 直接消费 SubprocessAgentRunner 返回值；callCache replay 时 worker
 * 取 parsedOutput ?? content（见 worker-script-builder.ts 消息处理）。
 */
export interface AgentResult {
 /** Raw text output from the agent. */
  content: string;
 /**
 * [D5-③] 失败分诊结构化标签（AgentFailureKind）。产出侧唯一识别点 =
 * execution/engine/inproc pi 引擎目录/output-collector.ts（collectResult 对最终 error
 * 分类后写入，经 agent-result-mapper / AgentOutcome 透传到本形态）；消费侧
 * execute-agent-call 读本字段分诊，不再扫 error 文案子串。
 *
 * 仅在 error !== undefined 时有意义（成功时缺省）；缺省视为 unknown = 可重试
 * （语义守恒，见 AgentFailureKind）。
 */
  failureKind?: AgentFailureKind;
 /**
 * Parsed structured output.
 * Present when `schema` was provided and the output was valid JSON.
 * Source: tool_execution_end.result.details（validated data object）。
 */
  parsedOutput?: unknown;
 /** Token and cost usage accumulated across all assistant turns. */
  usage?: AgentUsage;
 /** Wall-clock duration in milliseconds. */
  durationMs?: number;
 /** True when the pi process exited with code 0. */
  error?: string;
 /**
 * Pi session ID for the subagent process (uuidv7).
 * Present when pi emits a session header (default in --mode json).
 * Can be used to locate the session JSONL file for post-run inspection (G-017)。
 */
  sessionId?: string;
 /**
 * Session JSONL 绝对路径（不含目录的文件名在 subagents 侧 AgentResult.sessionFile）。
 * 由 mapToWorkflowAgentResult 从 subagents AgentResult 透传——让 workflow 编排层
 * 继承 subagent 执行管道产出的 session 文件路径，overlay/GUI 可直接定位。
 * 窗口期内可能 undefined（session 尚未创建成功）。
 */
  sessionFile?: string;
 /**
 * Absolute path of the git worktree used for filesystem isolation (set when
 * worktree isolation is active). Injected by executeAndAwait from record.worktreeHandle.path.
 *
 * ⚠️ Diagnostic only, may not exist: executeAndAwait's finalizeRecord cleans up the
 * worktree (git worktree remove --force) before returning, so by the time this field
 * reaches the caller the directory has typically been deleted. Use it only for log/trace
 * correlation (e.g. attributing a session jsonl to its worktree origin) — never as a cwd
 * for a subsequent agent or filesystem operation (would ENOENT).
 */
  worktreePath?: string;
 /** All tool calls collected from JSONL stream (FR-7). */
  toolCalls?: ToolCallEntry[];
}

// ── Trace ─────────────────────────────────────────────────────

/**
 * 执行追踪节点（事件流 D-10 单一来源）。
 */
export interface ExecutionTraceNode {
  stepIndex: number;
  agent: string;
  task: string;
  model: string;
  status: "pending" | "running" | "completed" | "failed";
 /** Phase name for TUI grouping. Set from explicit opts.phase or global _currentPhase. */
  phase?: string;
  startedAt?: string;
  completedAt?: string;
  result?: AgentResult;
  error?: string;
 /**
 * Pi session ID (uuidv7) for the subagent process.
 * Used to locate the session JSONL for post-run inspection.
 */
  sessionId?: string;
 /**
  * Session JSONL 绝对路径。finalizeCall 从 result.sessionFile 透传。
  * 持久化到快照（serializeRun），跨 session 重水合后保留。
  */
  sessionFile?: string;
}

// [H2 W3] `live?: ExecutionRecord` 字段已删除（设计 subagent-workflow-record-
// unification.md D2：trace node 的 live 字段删除，只保留 result 终态摘要）。运行期
// 实时进度改由 views 经 store 查询 collectRecordsByParentRunId(parentRunId) 订阅
// 真实 record（origin:"workflow"），不再经 pump 旁路 progress record 挂载。

/**
 * Trace.update 用的 patch（字段全可选）。
 *
 * 不变式：只改单个 node 的 status/result/error/completedAt/sessionId。
 * callId 不存在时 update 为 no-op（D-10）。
 */
export interface TracePatch {
  status?: "pending" | "running" | "completed" | "failed";
  result?: AgentResult;
  error?: string;
  completedAt?: string;
  sessionId?: string;
  sessionFile?: string;
}

// ── Worker 诊断 ───────────────────────────────────────────────

/**
 * Worker console.* 捕获条目（run 级诊断，仅展示在 TUI widget，不泄漏到 input area）。
 */
export interface WorkerLogEntry {
  level: "log" | "warn" | "error" | "info";
  message: string;
}
