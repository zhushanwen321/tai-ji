// src/types.ts
//
// 跨层共享的核心类型契约。Core/Runtime/TUI 三层均可 import 本文件。
//
// 分层铁律：
//   - Core 不 import Runtime/TUI（零 Pi 依赖，可单测）
//   - Runtime 编排 Core，产出 Details/Record 给 TUI
//   - TUI 只读 Record/Details 快照，永不持有可变引用

import type { GuiRenderResult } from "@xyz-agent/extension-protocol";
import type {
  AgentUsage,
  AgentUsageTotal,
  ToolCall,
  ToolCallResult,
  Turn,
  WorktreeHandle,
} from "@zhushanwen/subagent-engine-sdk";

import type { AgentFailureKind } from "../orchestration/models/types.ts";
import type { ModelInfo, ModelRegistryLike } from "./model-resolver.ts";

// ============================================================
// 全局常量
// ============================================================

/**
 * 未显式指定 agent 时的兜底名。
 *
 * 必须是真实存在、可被 agentRegistry 发现的 agent（用户 agentDir 内置的通用 agent）。
 * Service 层（resolveIdentity）与 TUI 层（extractAgentName）共用此常量，保证
 * 「调用时显示的名」与「实际加载的 agent.md」一致。
 *
 * [HISTORICAL] 旧实现两处各硬编码：service 用 "default"（虚构名），format 用
 * "worker"（真实但不是兜底语义，worker agent 已在 2026-08 agent 重构中删除）。
 * 导致不传 agent 时，block 标题显示 worker，但实际执行兜底逻辑不一致。统一为
 * general-purpose 后名实相符。
 */
export const DEFAULT_AGENT_NAME = "general-purpose";

// ============================================================
// 执行状态机
// ============================================================

/**
 * 唯一执行状态。所有路径共用。v4 B-1 两态收敛：旧 idle 折入 running、
 * 旧 cancelled 折入 closed（closedReason='cancelled' 区分）。
 *
 * running = 活跃态。含两种子态（由派生谓词区分，见 lifecycle-predicates.ts）：
 *   - 对话模式等待续聊（旧 idle）：进程已回收，待冷路径 resume
 *     （isResumable=running && 无活进程句柄）。旧「进程保活待热路径」形态随
 *     H1 U6 长驻退役消亡，isIdle（hasIdleTimer）生产恒 false。
 *   - 正在执行（有活进程句柄）。
 *
 * closed = 统一终态（done/failed/crashed/cancelled 合并）。具体关闭原因由
 * {@link ClosedReason} 子枚举表达（如 user-close / gc / cancelled / parent-shutdown）。
 * ExecutionRecord.closedReason 携带 L2 原因，投影层按需派生对外语义（error / ended）。
 */
export type ExecutionStatus = "running" | "closed";

/**
 * record 来源身份（H2 W1，设计 subagent-workflow-record-unification §3.3 D1 建议新增）：
 *   "tool"     — 主 agent 经 subagent 工具手动派发（现状全部 record）；
 *   "workflow" — workflow 脚本内 agent() 调用派发（生产写入方 W2 executeWorkflowAgent 接线）。
 * 缺省语义 = "tool"：存量 record / 未传字段的 entry 反序列化产物一律视为手动派发，
 * 四个投影消费面（subagents tool list / renderer 侧栏计数 / renderer 后台工作指示 /
 * TUI /subagents）对缺省 record 的可见性与历史行为完全一致（零迁移）。
 */
export type RecordOrigin = "tool" | "workflow";

/**
 * closed 终态的 L2 关闭原因子枚举。
 *
 * 与 ExecutionStatus="closed" 配合使用，表达「为什么关闭」：
 *   parent-shutdown  — 父进程 session_shutdown 时回收子进程
 *   parent-fork     — 父进程 fork 新 session 时清理旧子进程
 *   parent-new      — 父进程创建新 subagent 时清理旧子进程
 *   user-close      — 用户手动 close action（含对话模式 close）
 *   cancelled       — 用户取消（close(force:true) / cancelBackground）
 *   gc              — 通用完成/失败（一次执行自然结束、超时、错误等无专属 reason 的终态）
 *   disconnected    — .finalized sidecar 存在但无 reason 内容（磁盘重建兜底）：
 *                     正常结束但死因不可考——旧格式 sidecar（v8.5 前写入的是空文件）、
 *                     或外部工具手工创建。替代旧的误导性 "gc" 兜底（自然完成 vs 断联
 *                     不分），message/fork-from 据此给出可行动指引。
 */
export type ClosedReason = 'parent-shutdown' | 'parent-fork' | 'parent-new' | 'user-close' | 'cancelled' | 'gc' | 'disconnected';

/**
 * [v8.5 D] 可透明重生的终态原因集：message action 对这些 closed 记录同 id 续写原
 * sessionFile（resurrectClosed 回边），不再要求 fork-from 换新 id。
 *
 * 取值以 `.finalized` sidecar 实际写入的 ClosedReason 字面量为准：
 *   disconnected    — 断联（sidecar 空/损坏兜底；in-proc 时代写点已随 engine-CLI 化消失）
 *   parent-shutdown — 父进程 session_shutdown 回收
 * 其余 reason 刻意排除：user-close/cancelled 是用户主动告别（close 语义不可旁路）；
 * gc 是自然完成（追问走 fork-from 或新 start）；parent-fork/parent-new 同理是编排性
 * 清理，历史分支语义已由 fork-from 承接。
 */
export const RECONNECTABLE_FINAL_REASONS = ["disconnected", "parent-shutdown"] as const satisfies readonly ClosedReason[];

export type ReconnectableFinalReason = (typeof RECONNECTABLE_FINAL_REASONS)[number];

/** 窄化守卫：closedReason 是否落在可重生集内。 */
export function isReconnectableFinalReason(reason: string | undefined): reason is ReconnectableFinalReason {
  return (RECONNECTABLE_FINAL_REASONS as readonly string[]).includes(reason ?? "");
}

/**
 * [v8.5 D] 透明重生守卫拒绝专用错误：messageHandler 的 endedMessageGuard 必须原样
 * 透传本类错误（自带完整行动语言），不得按 A1 分流规则改写——否则 worktree/异进程
 * 占用文案会被「fork-from 指引」覆盖，误导 agent 走已被判死的通道。
 */
export class ResurrectDeniedError extends Error {}

/** ClosedReason 全枚举值（运行时守卫用——防御性解析外部输入时校验成员资格）。 */
export const CLOSED_REASONS: readonly ClosedReason[] = [
  'parent-shutdown',
  'parent-fork',
  'parent-new',
  'user-close',
  'cancelled',
  'gc',
];

/**
 * 终态三态对外语义（U3 C-outcome 一等披露）。
 *
 * 由 completeRecord 唯一写入点按 deriveOutcome 一次计算（判定顺序：cancelled 优先
 * → error 非空 → completed），消费方（project/list/notify 文案/渲染器）只读本字段，
 * 不再各自手写成败推导 switch（三处同构 switch 已随 U3 收敛删除）。
 *
 * [D6 显式取舍] parent-shutdown/parent-fork/parent-new 合成关闭（subagent-service
 * disposeAllRecords 合成 result 恒写 error:"closed due to ..."）落 "failed"——语义为
 * 「父进程关闭时子 agent 未完成即失败」，选定行为而非疏漏，勿当 bug 改回 cancelled。
 */
export type ExecutionOutcome = "completed" | "failed" | "cancelled";

/**
 * 对外投影的 outcome 联合：含历史 record（outcome 字段诞生前的存量数据）兼容态。
 * 投影层（projectOutcome 唯一出口）对无 outcome 字段的 closed record 按
 * deriveOutcome(closedReason, error) 兜底派生；"closed-legacy" 预留给连派生输入都
 * 不足以判读的存量形态，消费方必须处理该成员（不得因未知值崩溃）。
 */
export type ProjectedOutcome = ExecutionOutcome | "closed-legacy";

/**
 * 对外两态（设计决策 10 细则 3）：内部 ExecutionStatus（v4 B-1 两态）收敛为 agent
 * 可理解的状态语义。真实映射只有两条：
 *   running → active / closed → ended（closed 统一终态，含 cancelled）。
 * mapExternalState 不消费 ClosedReason——closed 恒映射 ended。
 *
 * 原始 ExecutionStatus 进 list item 的 status 字段供调试；state 是对外主字段。
 * 映射实现见 subagent-actions-core.ts mapExternalState——未来内部加态必须扩展该处，
 * 漏加会在 default 分支编译报错，不影响对外契约。
 */
export type ExternalState = "active" | "ended";

/** 执行模式。background = 调用方立即拿 handle 返回，子 agent 在 detached promise 里跑。 */
export type ExecutionMode = "background";

// ============================================================
// Agent 事件流（Core → Record 的唯一更新驱动）
// ============================================================

// [S4 簇 3 收编] 事件面契约类型单源化（type-only）：AgentEvent / AgentUsage /
// AgentUsageTotal / ToolCallResult / ToolCall / InternalToolCall / Turn 的本地定义
// 已删除，自 @zhushanwen/subagent-engine-sdk re-export（SDK protocol/contract-types.ts
// 是类型闭包 SSOT，core 反向 re-export 保上层消费面——import 方路径零改动；
// shared/agent-event.ts 转发层链条保持）。结构等价由 protocol-closure.test.ts
// 断言族守卫。
//
// AgentEvent 语义锚定（SDK 侧注释指向本处的对照权威源，勿删）：
//   - Pi session.subscribe 上报的事件。Runtime 把它喂给 updateFromEvent。
//   - 设计：AgentEvent 携带 updateFromEvent 收口进 record 所需的**全部数据**——
//     tool_end 带 result（供 turn.toolCalls 存完整 ToolCall），无需翻译层旁路累积。
//
//   ACP 词汇对照（D11 注记级校准，零行为变更；新引擎实现者按本表对齐语义，
//   详见 docs/architecture/subagent-engine-gui-visibility.md §3.3 D11）：
//     text_delta / thinking_delta ↔ ACP content blocks（text / thinking）
//     tool_start / tool_end      ↔ ACP tool_call / tool_call_update
//     turn_end / message_end     ↔ ACP prompt turn 终态（stop_reason + usage）
//     compaction                 ↔ ACP session/compaction
//     activity                   ↔ 无 ACP 对应（协议内生活性信号：reducer no-op、
//                                 不落 journal，仅供无进展守护刷新判活）
//   本协议以 pi 为语义锚点（D3）——命名不迁移，对照表仅保证未来 AcpEngine 适配器
//   与跨引擎 trace 映射的翻译成本最低。
export type {
  AgentEvent,
  AgentUsage,
  AgentUsageTotal,
  InternalToolCall,
  ToolCall,
  ToolCallResult,
  Turn,
} from "@zhushanwen/subagent-engine-sdk";

/**
 * eventLog 条目（getEventLog 派生产出的元素）。所有字段 readonly。
 *
 * text_output / thinking 类型已移除——它们是 100 字切片的碎片副产物，
 * 现在完整内容收口在 record.turns[] 里，eventLog 只承载离散语义事件
 * （tool 调用 / turn 边界 / error）。
 */
export interface AgentEventLogEntry {
  readonly type: "tool_start" | "tool_end" | "turn_end" | "error";
  readonly label: string;
  /** 事件发生的墙钟时间戳（Date.now()，ms）。由 getEventLog 从 turns[] 派生时记录。 */
  readonly ts: number;
  readonly status?: "running" | "done" | "failed";
}

/**
 * [STEP3] displayItem：从 turns[] 派生的展示项（对齐 nicobailon getDisplayItems）。
 *
 * 与 eventLog 的区别：eventLog 承载离散语义事件（tool_start/tool_end/turn_end），
 * displayItem 承载「可渲染单元」（toolCall 含完整 name+args 供 formatToolCall 格式化；
 * text 含 assistant 正文）。renderResult compact 分支改用 displayItems 后，
 * 行格式与 nicobailon 完全一致（→ formatToolCall）。
 */
export interface DisplayItem {
  readonly type: "toolCall" | "text";
  /** toolCall：tool 名称（bash/read/edit...）；text：无。 */
  readonly name?: string;
  /** toolCall：tool 原始 args（供 formatToolCall 提取路径/命令）；text：无。 */
  readonly args?: Record<string, unknown>;
  /** toolCall：执行状态（running 时无✓/✗标记）；text：正文文本。 */
  readonly status?: "running" | "done" | "failed";
  /** text：assistant 正文（compact 时取首行/截断）。 */
  readonly text?: string;
}

// ============================================================
// Agent 结果（一次执行的 outcome）
// ============================================================

/**
 * SDK AgentSessionEvent 的最小可用子集（duck-typed，避免强耦合 SDK 类型）。
 * 由 session-runner 内部消费，驱动累积器和事件翻译。
 */
export type SdkEvent = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: ToolCallResult;
  isError?: boolean;
  message?: {
    usage?: AgentUsage & { cost?: { total: number } };
    stopReason?: string;
    errorMessage?: string;
    /** 消息角色（message_start 事件携带，user/assistant/toolResult/custom）。 */
    role?: string;
  };
  assistantMessageEvent?: { type?: string; delta?: string };
  reason?: string;
};

/** 一次 session 执行的完整结果。collectResult 产出，写入 Record.outcome。 */
export interface AgentResult {
  text: string;
  turns: number;
  durationMs: number;
  success: boolean;
  error?: string;
  /**
   * [D5-③] 失败分诊结构化标签（类型 SSOT 在 orchestration/models/types.ts 的
   * AgentFailureKind——消费语义「unknown=可重试」与其文档同源）。collectResult 对
   * 最终 error 分类后写入；缺省 = unknown（可重试）。type-only 引用零运行时依赖。
   */
  failureKind?: AgentFailureKind;
  sessionId: string;
  toolCalls: ToolCall[];
  usage?: AgentUsageTotal;
  /** /resume /fork 可恢复的 session 文件名（不含目录）。 */
  sessionFile?: string;
  /** schema 模式下，structured-output tool 的 result.details（已通过 schema 校验）。 */
  parsedOutput?: unknown;
}

// ============================================================
// ExecutionRecord —— 唯一状态对象（Core 拥有，Runtime 引用）
// ============================================================

// 本 section 先声明 ExecutionRecord 的组成值对象（WorktreeHandle / AliveMarker /
// PatchResult 等），ExecutionRecord 本体及其文档注释在 section 末尾。

// [S4 簇 3 收编] WorktreeHandle 本地定义已删除，自 SDK re-export（原为结构等价
// 副本，单源化后 SDK contract-types 是唯一定义点；「仅 worktree:true 时持有、
// Object.freeze 守卫不可变」的语义注释见消费方 worktree-manager / worktree-git-ops）。
export type { WorktreeHandle } from "@zhushanwen/subagent-engine-sdk";

/** alive marker：跨进程写权声明载体（写者 = 宿主进程；acquire/release 见
 *  alive-store 模块头；startedAt 仅载体字段，判活不消费——pid 单判据）。 */
export interface AliveMarker {
  readonly pid: number;
  readonly id: string;
  readonly startedAt: number;
}

/** git diff patch 结果。 */
export interface PatchResult {
  readonly patchFile: string;
  readonly failed: boolean;
  /** patch 是否实际写入 patchFile。true=diff 非空且写盘成功；false=空 diff 或写失败。
   *  调用方据此回填 record.patchFile，避免悬空路径（`git apply` 不存在的文件）。 */
  readonly written: boolean;
}

/** resolveSessionContext 纯函数的入参（#3 SessionContextResolver）。 */
export interface SessionResolveInput {
  fork?: boolean;
  cwd?: string;
  mainCwd: string;
  mainSessionFile?: string;
  parentForkDepth?: number;
  /** agent 配置目录（getSubagentSessionDir 需要）。 */
  agentDir: string;
  /** worktree checkout 路径（来自 WorktreeHandle.path，作为 effectiveCwd）。 */
  worktreePath?: string;
}

/** resolveSessionContext 纯函数的返回值。 */
export interface ResolvedSessionContext {
  readonly shouldFork: boolean;
  readonly forkSource: string | undefined;
  readonly effectiveCwd: string;
  readonly sessionDir: string;
}

/** fork depth 超限错误。 */
export class ForkDepthExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForkDepthExceededError";
  }
}

/** worktree 有未提交变更错误。 */
export class DirtyWorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirtyWorktreeError";
  }
}

/**
 * 所有执行路径的唯一状态源。
 *
 * 收口设计：一次执行的完整内容（text/thinking/toolCalls/usage）按 turn 收口在
 * `turns: Turn[]` 里。eventLog / currentActivity / result 文本均从 turns[] 派生
 * （getEventLog / getCurrentActivity / getFullText），不再独立存储切片或缓冲。
 *
 * 生命周期：createRecord() 创建 → updateFromEvent() 实时更新（累积进 turns）→
 *           completeRecord() 冻结 → archive 立即移出内存（读时从 session.jsonl 重建）。
 *
 * TUI 永远拿 RecordSnapshot（.slice() 快照），不直接持此可变对象。
 */
export interface ExecutionRecord {
  /** 唯一 ID（sync: "run-N"，bg: "bg-N-xxx"）。 */
  readonly id: string;

  // ── 身份（创建时确定，不可变）──
  readonly agent: string;
  readonly model: string;
  readonly thinkingLevel: string | undefined;
  readonly mode: ExecutionMode;
  readonly task: string;
  /**
   * 人类可读的短标签（≤35 字符），简述本次 subagent「在做什么」。
   * 区别于 agent（类型名）/ task（完整 prompt）。旧持久化 record 反序列化时缺失兜底空串。
   */
  readonly slug: string;
  readonly startedAt: number;
  /** 根 Pi session ID（session 隔离过滤用）。递归链上所有层 record 同值。 */
  readonly rootSessionId: string | undefined;
  /** 直接父 subagent record ID（层级树构建用）。顶层 record 为 undefined。 */
  readonly parentRecordId: string | undefined;
  /** subagent 递归深度。顶层（主 session 直接创建）=0，每层嵌套 +1。 */
  readonly depth: number;
  /**
   * 来源身份（H2 W1，D1）。缺省（undefined）语义 = "tool"（存量 record 零迁移）；
   * "workflow" = workflow 脚本 agent() 派发（生产写入方 W2 接线）。过滤在投影/查询
   * 消费面（list 默认滤 workflow origin），store 治理面（孤儿恢复/revive）全量可见。
   * 持久化经 subagent-record entry。
   */
  readonly origin?: RecordOrigin;
  /**
   * origin="workflow" 时所属 workflow run 的 id（W2 写入）；tool 来源恒 undefined。
   * W2 run 视图进度 / W3 下钻按本 id 查询本 run 的 record 集（内存 ∪ 磁盘重建口径，
   * collectRecordsByParentRunId）。持久化经 subagent-record entry。
   */
  readonly parentRunId?: string;
  /**
   * 对话模式标志（可持续对话 subagent）。true = 轮次完成进 idle 态（保留 record +
   * worktree）等待续聊，而非一次性终态化。
   * undefined/false = 一次性模式（默认，行为完全不变）。
   * 向后兼容：旧 record / 旧 session 文件无此字段，按一次性模式处理。
   */
  readonly chatMode?: boolean;
  /**
   * 执行态信号（residual-fixes 设计）：true = 该 record 无活进程驱动（轮终 idle /
   * 重建孤儿兜底），处于「可续聊/等续聊」态——不是后台真在跑。轮终迁移
   * （doFinalizeRoundToIdle）置 true，冷路径续轮（进程启动）清除；GUI 侧
   * streaming/waiting 细分与 hasRunning 判据消费。缺省 falsy = 有进程或旧数据。
   */
  resumable?: boolean;
  /**
   * 空闲超时毫秒数（仅 chatMode 有意义）。覆盖默认 5min idle timeout。
   * 优先级：参数 > env XYZ_SUBAGENT_IDLE_TIMEOUT_MS > 默认 300000ms。
   * 向后兼容：旧 record 无此字段，按默认值处理。
   */
  readonly idleTimeoutMs?: number;
  /**
   * 实际执行引擎 id（P4 路由留痕，D9①）。创建时确定不可变；缺省（存量 record）
   * = pi 投影（消费方零迁移）。持久化经 subagent-record entry。
   */
  readonly engine?: string;
  /**
   * 引擎 fallback 留痕（D9①：probe 失败路由回默认引擎）。GUI 警告条数据源；
   * 缺省 = 无 fallback。持久化经 subagent-record entry。
   */
  readonly engineFallback?: { from: string; reason: string };
  /**
   * 引擎自描述定位符（U2：非 pi run resolve 后回填、终态迁移落 entry 前——run 前
   * 缺省不可用）。sessionRef 整体透传（失败终态 sessionId 缺失时仍回填已有部分，
   * 读侧①级降②级的防御形态）；journalPath 为 retarget 后实际落盘路径。pi 分支不
   * 回填（sessionFile 即定位符）。持久化经 subagent-record entry。
   */
  engineHandle?: { sessionRef: Record<string, string>; journalPath?: string; poolKey: string };
  /**
   * 同步收集模式标记（subagent-sync-collect 设计 §3.1.3，U1 foundation 契约）。
   * 创建时确定不可变；undefined = async（缺省语义，旧记录零迁移）。持久化经
   * subagent-record entry（record-entry.ts 序列化白名单，entry 唯一写点）。
   * 消费方：U2 collectCoordinator 路由（sync→批缓冲）、U5 E1 重建投影。
   * U2 接线点：service.createRecordForMode 从 ExecuteOptions.collect 读入 identity。
   */
  readonly collectMode?: "sync";

  // ── 状态（实时更新）──
  status: ExecutionStatus;
  /** L2 关闭原因子枚举（仅 status="closed" 时有意义）。表达「为什么关闭」。
   *  由 tryTransition(record, "closed", reason) 写入；投影层按需派生对外语义。
   *  向后兼容：旧 record 无此字段，按 gc 处理（通用完成/失败）。 */
  closedReason?: ClosedReason;
  /**
   * 终态三态对外语义（U3 C-outcome）。completeRecord 唯一写入点按 deriveOutcome
   * 一次计算，消费方只读本字段不再自行推导。向后兼容：旧 record / 磁盘重建
   * record 无此字段，投影层按 projectOutcome 兜底（closed-legacy 语义）。
   */
  outcome?: ExecutionOutcome;
  /**
   * 离开批的终局标记（subagent-sync-collect 设计 §3.1.3，U1 foundation 契约）。
   * 两出口统一落标：① 批闭合 flush 写账成功后；② E9 dispose 逐条转 async 写账后
   * （均 appendEntry 持久化，U3/U5 写点）。undefined = 未离开批 / 旧记录零迁移。
   * 消费方：U5 E1 重建扫描只收「collectMode=sync 且无本标记」的成员（防双重通知）。
   */
  batchFinalized?: boolean;
  /** 完整执行内容，按 turn 组织。createRecord 初始化为 [空 turn]。 */
  turns: Turn[];
  /** turn 计数（= turns.filter(closed).length，冗余存储供投影直接读）。 */
  turnCount: number;
  totalTokens: number;
  /** 运行期最近一次 error 事件的消息（getEventLog 派生 error 条目用）。 */
  lastError: string | undefined;
  /**
   * 对话轮次计数（仅 chatMode 有意义）。首轮运行时 = 0；每完成一轮（finalizeRoundToIdle
   * 进 idle）+1。undefined 时视为 0。非 chatMode 不自增。
   */
  round?: number;
  // [H1 U6 / D7 ③] roundBaseTurnIndex（增量通知 base 记账）已退役删除——消费函数
  // getFullTextFrom/nextRoundBaseTurnIndex 与唯一写点 settleChatRoundFromResponse 随
  // chat 域载体退役，生产零调用（base 推进 = 死记账）。
  /**
   * record 进入 idle 态的时间戳（ms）。finalizeRoundToIdle 设值；GC 定时器据此计算
   * 剩余 TTL。undefined = 非 idle 态（running/closed/cancelled）或旧 record 缺失字段。
   */
  idleSince?: number;
  /**
   * close 优雅关闭标志（M2-B3）。chatMode record 运行中调 `close {force:false}` 时置 true；
   * runAndFinalize 的 done 分流检查此标志——true 则终态化为 done（而非进 idle），并清标志。
   * undefined/false = 正常 idle 分流（对话模式轮次完成进 idle 等续聊）。
   * 仅 chatMode + running 时有意义；force:true（立即终止）不走此标志。
   */
  closeAfterRound?: boolean;

  // ── 完成 ──
  endedAt: number | undefined;
  result: string | undefined;
  error: string | undefined;
  /** 完整 AgentResult（含 usage/toolCalls，完成时填）。 */
  agentResult: AgentResult | undefined;

  /** session jsonl 文件名。session 创建成功后由 session-runner.run() 回填（窗口期内 undefined）。 */
  sessionFile?: string;

  /**
   * [V2 决策 3] 子进程 pid（spawn 后回填到内存 record，并随 record 持久化落盘）。
   *
   * 诊断字段：排障时对照 record 文件与进程表核实 spawn 事实。原职责 4 孤儿扫描
   * （按持久化 pid 扫收上次崩溃遗留孤儿）自落地起未接线，已随 L2 死代码清扫删除。
   * undefined = 尚未 spawn / 已退出。向后兼容：旧 record 无此字段，按无 pid 处理。
   */
  pid?: number;

  /** [MF#3] worktree 模式下子 agent 改动的 patch 文件路径（worktree 外，供调用方应用）。 */
  patchFile?: string;

  /** worktree 隔离时的 handle（仅 worktree:true 时存在；fork alone 无此字段）。 */
  worktreeHandle?: WorktreeHandle;

  /**
   * [review round2] 该 record 创建时启用了 worktree 隔离（跨重启磁盘重建时从 session
   * entry 的 worktree 标志恢复）。handle 本体不可序列化——跨重启后 worktreeHandle 恒
   * undefined，续聊（冷路径 resume）须拒绝（防 cwd 静默回落主 repo 破坏隔离）。仅内存
   * record 使用，与持久化无关；execute() 新建 record 不设（有真 handle 时无意义）。
   */
  hadWorktree?: boolean;

  // ── 控制（仅 background 持有）──
  controller: AbortController | undefined;
}

// ============================================================
// Runtime → TUI 的投影契约
// ============================================================

/**
 * Tool 返回的 details（内层扁平结构）。
 * 由 project(record) 唯一产出——sync/bg 两路径字段一致。
 * 含 mode + sessionFile（供外层 SubagentToolResult 分组 + spinner 判断）。
 *
 * 分层（spec FR-3）：此为**内层**，不感知 action/外层分组。
 * 外层 SubagentToolResult 由 adapter 包裹产出（加 action/subagentId/sessionFile + 分组）。
 */
export interface SubagentToolDetails {
  status: ExecutionStatus;
  /**
   * 终态三态对外语义（U3 C-outcome，projectOutcome 唯一出口）。running → undefined；
   * 历史数据无 outcome 字段时兜底派生（见 ProjectedOutcome）。
   */
  outcome?: ProjectedOutcome;
  mode: ExecutionMode;
  agent: string;
  model: string;
  thinkingLevel: string | undefined;
  /** 短标签（≤35 字符），来自 record.slug。旧 record 反序列化时为空串。 */
  slug: string;
  turns: number;
  totalTokens: number;
  elapsedSeconds: number;
  eventLog: AgentEventLogEntry[];
  /** [STEP3] 从 turns[] 派生的展示项（对齐 nicobailon getDisplayItems）。 */
  displayItems: DisplayItem[];
  result?: string;
  error?: string;
  /** running 时的当前活动行（tool/thinking/text 优先级）。 */
  currentActivity?: { type: "tool" | "text" | "thinking"; label: string };
  /** schema 模式下，structured-output tool 的 result.details（对齐 workflow agent-pool）。 */
  parsedOutput?: unknown;
  /** session jsonl 文件名（不含目录）。窗口期内可能 undefined（session 尚未创建成功）。 */
  sessionFile?: string;
  /** [MF#3] worktree 模式下子 agent 改动的 patch 文件路径（worktree 外，供调用方应用）。 */
  patchFile?: string;
}

// ============================================================
// Runtime 公共 API 的入参/出参
// ============================================================

/** Hub.execute 的入参（sync/bg 共用）。mode 由 Hub 内部判定，不暴露给调用方。 */
export interface ExecuteOptions {
  task: string;
  /**
   * 短标签（≤35 字符），简述本次执行用途，展示在 TUI。必填。
   * workflow 内 agent() 调用时从 AgentCallOpts.description 透传而来。
   */
  slug: string;
  agent?: string;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  schema?: Record<string, unknown>;
  /** D-A6 bridge: workflow schemaEnv 经 ExecuteOptions 透传到 runSpawn childEnv。 */
  schemaEnv?: string;
  /**
   * Turn 上限 limiter。显式 0/负 = 显式不限：压过 SPAWN_WATCHDOG_ENV 兑底不挂
   * watchdog（SP-6 参数 > env，U5）；undefined 未传才由 env 兑底。
   */
  maxTurns?: number;
  graceTurns?: number;
  /** sync 模式来自 Pi tool 框架；background 模式 hub 忽略，自建 controller。 */
  signal?: AbortSignal;
  /** 主 agent 当前模型（模型解析第三层兼底）。execute 调用方从 ctx.model 传入。 */
  ctxModel?: ModelInfo;
  /** background 完成回调（sync 不调）。 */
  onComplete?: (record: RecordSnapshot) => void;
  /** 是否继承父会话上下文（fork 模式，只继承上下文）。 */
  fork?: boolean;
  /**
   * [v8.5 B] fork-from 显式指定继承源 session 文件（非主 session）。
   * 与 fork:true 的区别：fork:true 用主 session 作 --fork 源；本字段用任意已有
   * session 文件（断联 subagent 接续场景）作源。优先级高于 fork；传了本字段时
   * fork 取值不影响 spawn 参数。仅 pi 引擎支持（同 fork）。仅 background tool
   * 层 fork-from action 使用；workflow / executeAndAwait 不消费。
   */
  forkFromSessionFile?: string;
  /** 文件系统隔离：true=创建新 git worktree，WorktreeHandle=复用外部已创建的；undefined=不隔离（parent cwd）。 */
  worktree?: boolean | WorktreeHandle;
  /** 覆盖执行 cwd（默认 mainCwd）。 */
  cwd?: string;
  /**
   * 可持续对话模式（决策 8：独立 chatMode 标志，不扩展 ExecutionMode）。
   * true = record 标记 chatMode，轮次完成进 idle 态（保留 record + worktree，等待 message 续聊）；
   * undefined/false = 一次性模式（默认，行为完全不变）。service.execute 透传到 createRecordForMode。
   */
  conversation?: boolean;
  /**
   * 同步收集模式（subagent-sync-collect 设计 §3.1.3，U1 foundation 契约）。
   * undefined = config collectSync.default（缺省 "async"，新 session 生效）。
   * schema 层枚举限 "async"|"sync"；运行时宽收 string 与 engine 字段同风格
   * （非法值 ≠ "sync" 按 async 处理）。
   * "sync" + conversation:true 组合在 startHandler E4 校验即拒
   * （immediate throw，不产生半启动 record）。
   * U2 接线点：service.createRecordForMode 读入 createRecord identity.collectMode
   * （U1 打通类型与 startHandler 透传，record 落点归 U2）。
   */
  collect?: string;
  /**
   * 空闲超时毫秒数（仅 conversation 模式有意义）。覆盖默认 5min idle timeout。
   * 优先级：参数 > env XYZ_SUBAGENT_IDLE_TIMEOUT_MS > 默认 300000ms。
   * 显式传 0/负数 = 禁用 idle GC（不挂 timer；旧实现 0 会落成 setTimeout(0) 立即 kill）。
   */
  idleTimeoutMs?: number;
  /**
   * 实际执行引擎 id（P4 路由留痕）：pi 引擎由 PiEngine.run 在还原 opts 时写入；
   * 缺省（历史调用方不设）= pi 投影。createRecordForMode 读入 record identity。
   */
  engine?: string;
  /**
   * 引擎 fallback 留痕（D9①：probe 失败路由回默认引擎时由路由层写入）。
   * from = 请求引擎 id，reason 恒 'engine_probe_failed'（GUI 警告条数据源）。
   */
  engineFallback?: { from: string; reason: string };
  // 注：fork 深度不从外部传入（曾暴露 parentForkDepth，改用 ALS 后 execute 内部从调用链派生，
  // 公开字段成为死字段误导调用方，已移除）。深度限制检查见 session-runner.ts 内部 RunOptions.parentForkDepth
  // （与历史残留的 types.ts RunOptions 同名不同 interface——后者已删除）。
}

/**
 * execute 返回值。
 *   background: { mode:"background", subagentId, sessionFile, details } —— 立即返回。
 *            subagentId 供后续 cancel/list 用；sessionFile 窗口期可能 undefined。
 */
export type ExecutionHandle = {
  mode: "background";
  subagentId: string;
  sessionFile: string | undefined;
  details: SubagentToolDetails;
};

// ============================================================
// tool action 出参（外层分组，adapter 产出）
// ============================================================

/** list 的 item 结构。 */
export interface SubagentListItem {
  subagentId: string;
  agent: string;
  /** 短标签（≤35 字符），来自 record.slug。旧 record 反序列化时为空串。 */
  slug: string;
  /** 对外四态（决策 10 细则 3，主字段）。由 mapExternalState(status) 派生。 */
  state: ExternalState;
  /** 原始内部状态（调试用，供 details 展示）。 */
  status: ExecutionStatus;
  mode: ExecutionMode;
  /** 运行秒数（running 态实时计算，终态 endedAt-startedAt）。 */
  duration: number;
  model: string;
  totalTokens: number;
  /** session jsonl 文件名（窗口期内可能 undefined）。 */
  sessionFile?: string;
  /** 直接父 subagent record ID（顶层 record 为 undefined）。[v4 A-6] 从
   *  record.parentRecordId 派生，配合 A-5 直接父守卫（message/close 仅作用于直接子）。 */
  parent?: string;
  /** 可冷路径 resume（running 且无活进程句柄）。[v4 A-6] B-1「可续聊」对外表达，
   *  agent 据 list 判断哪些 running subagent 实际可续聊（vs 正在忙）。 */
  resumable?: boolean;
  /**
   * 终态三态对外语义（U3 C-outcome 一等披露，projectOutcome 唯一出口）：
   * completed / failed / cancelled，历史 record 无 outcome 字段时兜底派生，
   * 不可判读的存量形态为 "closed-legacy"。GUI pane / agent 据此判读成败，
   * 无需翻 error 字段原文（S5）。
   */
  outcome?: ProjectedOutcome;
}

/** background 启动的内层响应（挂在 SubagentToolResult.bgResponse）。 */
export interface BgResponse {
  status: "running";
  mode: "background";
  /** 启动提示文案（"detached, will notify on completion"）。 */
  message: string;
  /**
   * 终态三态语义（U3 C-outcome 对外 JSON 契约完备位）。start 时点 record 尚未终态，
   * 恒 undefined（JSON.stringify 落键省略）；终态成败语义经 list items[].outcome
   * 披露。旧字段 status/mode/message 原样保留（向后兼容）。
   */
  outcome?: ProjectedOutcome;
  /**
   * 通知投递契约回显位（U1 预置，U2 通知账本的契约声明）。恒值
   * "ledger+at-least-once"：主 agent 在当前 run 结束或有限延迟内收到完成通知，
   * 送达保证为 at-least-once + notifyId 幂等可识别。字段与填充由 U1 负责，
   * 值语义由 U2（execution/notify-ledger.ts）兑现。
   */
  notifyContract: "ledger+at-least-once";
  /**
   * 同步收集登记回显段（subagent-sync-collect 设计 §3.1.1 交互样例，U1 foundation）。
   * 仅 resolved 模式为 sync 时附带（async 响应字节零变化，G3）：mode = 生效模式；
   * pendingSyncCount = 当前未闭合批的 sync 成员总数（含本条；跨轮派发续累不重置，
   * 与 D2 隐式批一致）。
   */
  collect?: { mode: "sync"; pendingSyncCount: number };
}

/** list 的内层响应（挂在 SubagentToolResult.listResponse）。 */
export interface ListResponse {
  /** items 中 status==="running" 的计数（受 limit 截断如实反映，非全局总数）。 */
  running: number;
  items: SubagentListItem[];
}

/** cancel 的内层响应（挂在 SubagentToolResult.cancelResponse）。 */
export interface CancelResponse {
  cancelled: true;
}

/**
 * message 的内层响应（挂在 SubagentToolResult.messageResponse，决策 10 瘦身）。
 *
 * [R1 删除记录] 旧 PendingMessage（在途消息缓存条目，消费确认制，设计决策 6 状态×
 * interrupt 映射）已随 deliverToRunning 一并删除——SP-5 upgrade 后无生产调用方，
 * 配套三段消费链（push / message_start shift / redeliverPending 补投）全部不可达。
 * 详见 subagent-service.ts 的删除记录注释。
 */
export interface MessageResponse {
  delivered: true;
}

/** close 的内层响应（挂在 SubagentToolResult.closeResponse，决策 10 瘦身）。 */
export interface CloseResponse {
  closed: true;
}

/**
 * Tool 外层出参（renderResult + LLM content JSON 同源）。
 * adapter 唯一产出：领域对象（bg/list/cancel/message/close 五选一）+ action/subagentId/sessionFile。
 *
 *   - background 启动 → bgResponse（subagentId 有值；sessionFile 窗口期可能 undefined）
 *   - list → listResponse（最外层 subagentId/sessionFile 为 null，sessionFile 在各 item 内）
 *   - cancel → cancelResponse（subagentId 有值；sessionFile 无意义，可为 null）
 *   - message → messageResponse（subagentId 有值；sessionFile 无意义，可为 null）
 *   - close → closeResponse（subagentId 有值；sessionFile 无意义，可为 null）
 */
export type SubagentToolResult =
  | { action: "start"; subagentId: string; sessionFile: string | null; slug: string; /** registry 全等回显（U1）：放行即与 registry 条目全等，"provider/id" 形态。 */ model: string; bgResponse: BgResponse; __gui__?: GuiRenderResult }
  | { action: "list"; subagentId: null; sessionFile: null; listResponse: ListResponse; __gui__?: GuiRenderResult }
  | { action: "cancel"; subagentId: string; sessionFile: null; cancelResponse: CancelResponse; __gui__?: GuiRenderResult }
  | { action: "message"; subagentId: string; sessionFile: null; messageResponse: MessageResponse; __gui__?: GuiRenderResult }
  | { action: "close"; subagentId: string; sessionFile: null; closeResponse: CloseResponse; __gui__?: GuiRenderResult }
  | { action: "fork-from"; subagentId: string; sessionFile: string | null; forkFromResponse: ForkFromResponse; __gui__?: GuiRenderResult };

/** fork-from 的内层响应：新 subagent id + 作为继承源的旧记录 session 文件。
 *  [v8.5 B] 断联恢复通道——新 subagent 以 --fork 方式继承旧会话历史，源文件只读
 *  不续写（pi fork 建 branched session，copy-on-write）。 */
export interface ForkFromResponse {
  /** 新 subagent record id（接续对话用 action:'message'）。 */
  newSubagentId: string;
  /** 作为继承源的旧 subagent session jsonl 绝对路径。 */
  sourceSessionFile: string;
}

// ============================================================
// TUI list 视图的合并 record（4 源 merge 后的形状）
// ============================================================

/** /subagents list 左列展示单元。来自内存(running) 或 session.jsonl 重建(终态)。 */
export interface SubagentRecord {
  id: string;
  agent: string;
  /** 任务提示词（详情面板置顶展示）。磁盘/内存源均有。 */
  task: string;
  /** 短标签（≤35 字符）。磁盘重建源旧文件可能缺失→兜底空串。 */
  slug: string;
  status: ExecutionStatus;
  /** L2 关闭原因子枚举（仅 status="closed" 时有意义）。SP-1 新增。 */
  closedReason?: ClosedReason;
  /** 终态三态对外语义（U3 C-outcome）。磁盘重建源一等直读；无字段的存量兜底走 projectOutcome。 */
  outcome?: ExecutionOutcome;
  mode: ExecutionMode;
  startedAt: number;
  /** 根 Pi session ID（session 隔离过滤用）。递归链上所有层 record 同值。 */
  rootSessionId: string | undefined;
  /** 直接父 subagent record ID（层级树构建用）。顶层 record 为 undefined。 */
  parentRecordId: string | undefined;
  /** subagent 递归深度。顶层 =0，每层嵌套 +1。 */
  depth: number;
  /**
   * 来源身份（H2 W1，D1，与 ExecutionRecord.origin 同源投影/entry 重建）。
   * 缺省（undefined / 存量磁盘重建源）语义 = "tool"；消费面按 `=== "workflow"`
   * 负向判定，list 查询缺省过滤（includeWorkflow 缺省 false）。
   */
  origin?: RecordOrigin;
  /**
   * origin="workflow" 时所属 workflow run id（与 ExecutionRecord.parentRunId 同源）。
   * W2/W3 run 视图下钻按 collectRecordsByParentRunId 查询；tool 来源恒 undefined。
   */
  parentRunId?: string;
  endedAt: number | undefined;
  turns: number;
  totalTokens: number;
  model: string;
  thinkingLevel: string | undefined;
  eventLog: AgentEventLogEntry[];
  /** [STEP3] 从 turns[] 派生的展示项（对齐 nicobailon getDisplayItems）。 */
  displayItems: DisplayItem[];
  /** running 时的当前活动行（仅内存源；磁盘重建无此数据）。streaming 可观测性用。 */
  currentActivity?: { type: "tool" | "text" | "thinking"; label: string };
  result?: string;
  error?: string;
  sessionFile?: string;
  /** [MF#3] worktree 模式下子 agent 改动的 patch 文件路径（worktree 外，供调用方应用）。 */
  patchFile?: string;
  /**
   * [review round2] 创建时启用 worktree 隔离（磁盘重建源从 session entry 恢复；内存源由
   * recordToSubagent 从 worktreeHandle 投影）。getRecordForAction 跨重启重建时据此拒绝续聊。
   */
  worktree?: boolean;
  /**
   * 对话轮次计数（仅 chatMode idle record 有意义）。round 仅在内存维护（doFinalizeRoundToIdle
   * 递增），跨重启不恢复（round 无磁盘持久化）；非对话模式 / 非 idle record 为 undefined。内存源由 recordToSubagent 从
   * ExecutionRecord.round 投影。
   */
  round?: number;
  /**
   * 对话模式标志（与 ExecutionRecord.chatMode 同义；投影给 GUI 侧 streaming/waiting/done
   * 细分判据——one-shot 轮终（chatMode 非 true + result 有值）显示完成态，chat 轮终显示
   * 等续聊。内存源由 recordToSubagent 投影，磁盘源经 subagent-record entry 重建）。
   */
  chatMode?: boolean;
  /**
   * 执行态信号（与 ExecutionRecord.resumable 同义）：true = 无活进程驱动的 running
   * （轮终 idle / 重建孤儿兜底），GUI 侧据此排除「真在跑」判定。
   */
  resumable?: boolean;
  /** fork 模式下的 worktree handle。 */
  worktreeHandle?: WorktreeHandle;
  /**
   * 实际执行引擎 id（P4 路由留痕）。缺省 = pi 投影（存量 record 零迁移）；
   * GUI 警告条/引擎标记的数据源之一。
   */
  engine?: string;
  /** 引擎 fallback 留痕（D9①：probe 失败路由回默认引擎）。GUI 警告条数据源。 */
  engineFallback?: { from: string; reason: string };
  /**
   * 引擎自描述定位符（U1：EngineHandleData 的持久化消费面子集，引擎无关——
   * sessionRef 整体透传不枚举内部键）。read 降级链①②级的数据源（runtime
   * subagent-engine-history）；缺省 = pi（走 JSONL 直读链）。
   */
  engineHandle?: { sessionRef: Record<string, string>; journalPath?: string; poolKey: string };
  /**
   * 同步收集模式标记（与 ExecutionRecord.collectMode 同源投影/重建，U1 foundation）。
   * 缺省（存量 record）= async 投影，消费方零迁移。
   */
  collectMode?: "sync";
  /**
   * 离开批终局标记（与 ExecutionRecord.batchFinalized 同源投影/重建，U1 foundation）。
   * 缺省 = 未离开批；U5 E1 重建扫描据此排除已离场成员。
   */
  batchFinalized?: boolean;
}

// ============================================================
// 配置（global + session）
// ============================================================

/**
 * 同步收集（sync collect）配置节类型（subagent-sync-collect 设计 §3.1.3，U1 foundation）。
 * 权威默认值在 config.ts DEFAULT_COLLECT_SYNC；坏值 sanitize 回默认不炸启动（E5，
 * 与 maxConcurrent 同判）。类型定义于 types.ts（避免 config → types 反向依赖成环），
 * config.ts re-export。
 */
export interface CollectSyncConfig {
  /** start 未显式传 collect 时的缺省模式。新 session 生效（与 engine 配置时机一致）。 */
  default: "async" | "sync";
  /** 批通知单条目结果正文预算（字符）：超出截断并接 session_read 指针行。flush 时热读。 */
  perItemChars: number;
  /** 批通知结果正文总量预算（字符）：Σ 超限时统一收紧 effectivePerItem（U4 算法）。flush 时热读。 */
  totalChars: number;
}

/**
 * 全局配置（~/.pi/agent/subagents/config.json）。
 *
 * 模型解析已退化为「主 agent model 优先，仅 override 时查 registry」——
 * 不再有 category/fallback/yolo 字段。config.json 只保留 maxConcurrent
 * （pool 大小）。旧 config.json 中的 categories/fallback 等字段读取时忽略。
 */
export interface SubagentsGlobalConfig {
  version: number;
  maxConcurrent: number;
  /**
   * 全局默认执行引擎（D9 三层优先级的最底层：调用参数 > agent frontmatter > 本值）。
   * 缺省 'pi'（P4 路由层 DEFAULT_ENGINE_ID）。加载期只做类型校验，注册表校验归路由层。
   */
  defaultEngine?: string;
  /** 引擎路由策略（D9①）：strict=true 时一切 probe 失败直接报错（不 fallback）。 */
  engineRouting?: { strict: boolean };
  /**
   * 同步收集配置节（subagent-sync-collect 设计 §3.1.3，U1 foundation）。
   * 整节缺省 = DEFAULT_COLLECT_SYNC（config.ts）；逐字段 sanitize 回默认（E5）。
   */
  collectSync?: CollectSyncConfig;
}

// ============================================================
// 只读快照（TUI 消费，永不 mutate）
// ============================================================

/**
 * Record 的只读视图。store.snapshot() 返回。
 * TUI 拿到此类型，保证不会回写 Core 状态。
 *
 * 不含 eventLog——snapshot 的消费点（cancel 判 mode/status、hasRunning 判 mode、
 * toNotifyRecord 取 result/error）均不读 eventLog。需要 eventLog 的场景用 project()
 * 投影的 SubagentToolDetails。需要完整内容用 record.turns[]（Core 内部）。
 */
export interface RecordSnapshot {
  readonly id: string;
  readonly agent: string;
  readonly model: string;
  readonly thinkingLevel: string | undefined;
  readonly mode: ExecutionMode;
  readonly task: string;
  /** 短标签（≤35 字符）。来自 record.slug。 */
  readonly slug: string;
  readonly status: ExecutionStatus;
  /** 对话模式标志（与 ExecutionRecord.chatMode 同源）。cancel 别名判定用。 */
  readonly chatMode?: boolean;
  readonly turns: number;
  readonly totalTokens: number;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly result: string | undefined;
  readonly error: string | undefined;
  readonly sessionFile: string | undefined;
}

// Re-export 用于 ExecuteOptions 的 agent/model 契约
// ============================================================
// SDK duck-typed 接口（测试可 mock，session-runner 消费）
// ============================================================

/** AgentSession 的最小可用接口（duck-typed，与 SDK AgentSession 结构兼容）。 */
export interface AgentSessionLike {
  prompt(task: string, options?: unknown): Promise<void>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(fn: (event: unknown) => void): () => void;
  sessionId: string;
  readonly sessionManager: {
    getSessionFile(): string | undefined;
    getSessionId(): string;
    /** 写 custom entry（subagent-identity 持久化用）。SDK SessionManager.appendCustomEntry 的 duck-type。 */
    appendCustomEntry(customType: string, data?: unknown): string;
  };
  messages: ReadonlyArray<{
    role: string;
    content?: ReadonlyArray<{ type: string; text?: string }>;
  }>;
  getAllTools(): Array<{ name: string }>;
  setActiveToolsByName(names: string[]): void;
}

/** DefaultResourceLoader 的最小可用接口（duck-typed）。 */
export interface ResourceLoaderLike {
  reload(): Promise<void>;
}

/** createAgentSession 入参的类型化子集（对应 SDK CreateAgentSessionOptions）。 */
export interface CreateAgentSessionArgs {
  model: unknown;
  thinkingLevel?: string;
  cwd: string;
  resourceLoader: ResourceLoaderLike;
  modelRegistry: ModelRegistryLike;
  sessionManager: unknown;
}

/** DefaultResourceLoader 构造参数的类型化子集。 */
export interface ResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  appendSystemPrompt: string[];
  additionalSkillPaths?: string[];
}

/** SessionManager 实例的最小接口（duck-typed，fork 路径消费 SDK 静态方法的返回值）。 */
export interface SessionManagerLike {
  getLeafId(): string | null;
  createBranchedSession(leafId: string): string | undefined;
  getSessionFile(): string | undefined;
  getSessionId(): string;
}

/** Pi SDK 动态 import 的形状（getSdk() 获取）。 */
export interface SdkLike {
  DefaultResourceLoader: new (opts: ResourceLoaderOptions) => ResourceLoaderLike;
  SessionManager: {
    inMemory(cwd?: string): SessionManagerLike;
    create(cwd: string, sessionDir?: string): SessionManagerLike;
    open(sessionFile: string, sessionDir?: string, cwdOverride?: string): SessionManagerLike;
    /** [MF#1] fork 静态方法：从源 session 文件 fork 到目标 cwd，返回 SessionManager。 */
    forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): SessionManagerLike;
  };
  createAgentSession: (opts: CreateAgentSessionArgs) => Promise<{ session: AgentSessionLike }>;
}
