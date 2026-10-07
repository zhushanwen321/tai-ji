// src/types.ts
//
// 跨层共享的核心类型契约。Core/Runtime/TUI 三层均可 import 本文件。
//
// 分层铁律：
//   - Core 不 import Runtime/TUI（零 Pi 依赖，可单测）
//   - Runtime 编排 Core，产出 Details/Record 给 TUI
//   - TUI 只读 Record/Details 快照，永不持有可变引用

import type { GuiRenderResult } from "@zhushanwen/extension-protocol";
// [§2.3/§2.4] SDK 契约类型：本文件仍直接使用的只有 WorktreeHandle（SubagentRecord 等
// 剩余族的字段）；Turn / ToolCall / AgentUsageTotal / AgentFailureKind 随 record 聚合与
// AgentResult 迁入 execution/domain/record-model.ts，由那里直接从 SDK 取——本文件对它们
// 仅保留 re-export（见下方 SDK re-export 块）。
// [subagent-model-switch] ModelRef / SetModelErrorCode 供模型切换聚合应答三组件消费。
import type { ModelRef, SetModelErrorCode, WorktreeHandle } from "@zhushanwen/subagent-engine-sdk";
import type { ModelInfo } from "./model-resolver.ts";

// [§2.4/D2] 领域词汇与聚合的权威路径 = execution/domain/（本文件不再 re-export）
import type { ExecutionStatus, RecordOrigin, ClosedReason, ExecutionOutcome, ProjectedOutcome, ExternalState, ExecutionMode, StopReason } from "../domain/record-types.ts";
// [subagent-model-switch §6.2] SubagentRecord.modelOverride 的载荷类型（与
// ExecutionRecord.modelOverride 同源——领域词汇权威在 domain/record-model.ts）。
import type { ModelOverride } from "../domain/record-model.ts";




// ============================================================
// 全局常量
// ============================================================


// ============================================================
// 执行状态机
// ============================================================












// ============================================================
// 永久会话模型领域词汇（设计 subagent-permanent-session-model.md §3.2.1；
// u-foundation 类型骨架先行，U2 实装状态机）
// ============================================================













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
//   ACP 词汇对照（D11 注记级校准，零行为变更；新引擎实现者按本表对齐语义）：
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


// ============================================================
// ExecutionRecord —— 唯一状态对象（Core 拥有，Runtime 引用）
// ============================================================

// 本 section 先声明 ExecutionRecord 的组成值对象（WorktreeHandle / AliveMarker /
// PatchResult 等），ExecutionRecord 本体及其文档注释在 section 末尾。

// [S4 簇 3 收编] WorktreeHandle 本地定义已删除，自 SDK re-export（原为结构等价
// 副本，单源化后 SDK contract-types 是唯一定义点；「仅 worktree:true 时持有、
// Object.freeze 守卫不可变」的语义注释见消费方 worktree-manager）。
export type { WorktreeHandle } from "@zhushanwen/subagent-engine-sdk";


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


// ============================================================
// 模型切换 run 级聚合契约（设计 subagent-model-switch §7.1/§7.4；
// u-foundation 定形，U5 实装——实装 = service/run-model-switch-aggregate.ts
// runModelSwitchAggregate，签名 = RunModelSwitchAggregateCall = 契约 input
// RunModelSwitchAggregateInput + resolveMemberPort 依赖注入面）
// ============================================================

/**
 * run 级全切聚合的入参（U5 聚合函数签名面；形状为本单元定形契约）。
 *
 * - `model` / `thinkingLevel`：本次切换的目标意图（已过 U2 宿主编排的公共校验步骤①
 *   ——canonical ref + 目录 + 凭据 + 档位预检；聚合层只做转发与分派，不重复校验）。
 * - `memberRunIds`：该 run 已受理成员的 runId 全量清单（不做宿主侧存活预判——进程
 *   存活事实的权威在引擎侧，宿主 record 状态只是投影，§7.4）。
 */
export interface RunModelSwitchAggregateInput {
  /** 所属 workflow run 的 id（聚合应答 summary 的归属键）。 */
  runId: string;
  /** 目标模型 ref（透传给每个成员的引擎 setModel 转发）。 */
  model: ModelRef;
  /** 目标 thinking 档位（缺省 = 不指定）。 */
  thinkingLevel?: string;
  /** 已受理成员 runId 全量清单（逐成员独立转发，个别失败不回滚其他成员）。 */
  memberRunIds: string[];
}

/**
 * 聚合应答的成员态条目（三态语义权威 = 设计 §7.4）：
 * - `switched`：热切成功，携带该成员生效模型 ref + 生效 thinking 档位（引擎回读值，
 *   非请求值——同族替换时 ≠ 目标意图）；
 * - `not-active`：引擎定位不到该成员活跃子进程（已退出成员），覆盖走记账路径、
 *   重派时生效；
 * - `not-applicable`：该成员引擎 capability 不支持热切（发送前预检不支持），覆盖走
 *   记账路径；不算失败、不虚构生效值（过渡期混合引擎 run 的显式状态）。
 *
 * 生效值字段仅 switched 成员携带；非 switched 成员两字段缺省（无回读源不虚构）。
 */
export interface RunSwitchMemberState {
  /** 成员 runId（与失败名单同维——两数组是同一已受理成员集合的互斥划分，§7.1）。 */
  runId: string;
  state: "switched" | "not-active" | "not-applicable";
  /** 生效模型 ref（仅 state="switched" 携带）。 */
  effectiveModel?: ModelRef;
  /** 生效 thinking 档位（仅 state="switched" 携带）。 */
  effectiveThinkingLevel?: string;
}

/**
 * 聚合应答的失败名单条目——转发失败成员（三态无态可落：非 switched 生效值未回读
 * 到手 / 非 not-active 引擎定位到了活跃子进程 / 非 not-applicable 预检已通过，§7.1）。
 * `reason` **开放值域** = SDK setModel 错误码三型 ∪ 词表外透传码（engine_crashed 等
 * engine_* 面原样上报——实装 failureReasonOf 刻意透传，消费方对未知码按原文兜底
 * 显示），`(string & {})` 放行透传码同时保留三型自动补全。
 * **三处类型同步义务**：本类型 reason ∪ wire 投影 SubagentSetModelMemberFailure.reason
 * （shared protocol.ts，已知字面词表 = SUBAGENT_SET_MODEL_FAILURE_REASON_CODES）∪ 实装
 * failureReasonOf 返回类型（service/run-model-switch-aggregate.ts），值域口径改动三处
 * 同批；对账锚 = packages/runtime/src/infra/subagent-model-gateway.test.ts
 * 「core ↔ shared setModel 对账」段（SDK 词表扩位时已知子集同批跟随）。
 */
export interface RunSwitchMemberFailure {
  /** 成员 runId（与成员态数组同维，§7.1）。 */
  runId: string;
  /** 失败分型（已知三型见 SDK SET_MODEL_ERROR_CODES；词表外 engine_* 透传码原样透传）。 */
  reason: SetModelErrorCode | (string & {});
}

/**
 * run 级全切聚合应答——三组件固定结构（§7.1 定形）：恒保留三组件，退化仅指
 * 无生效值可报（全员非 switched 时成员条目无档位字段），失败名单无失败成员时为
 * 空名单、不省略组件。前端按成员分项呈现，不坍缩为标量消息。
 *
 * 形状 SSOT = 本类型；前端 wire 应答（packages/core transport domains + shared
 * protocol.ts 的 SubagentSetModelAggregateReply）为结构等价投影（依赖方向不允许
 * 物理单源——shared 不依赖 subagent-core），两处漂移由 U1 接线测试对账。
 */
export interface RunSwitchAggregateResult {
  /** 成员态数组（三态，恒保留）。 */
  members: RunSwitchMemberState[];
  /** 失败名单（转发失败成员 + 失败分型；无失败时为空数组，恒保留）。 */
  failures: RunSwitchMemberFailure[];
  /** 汇总文案（承载未派发步骤沿用说明；全员非 switched 时退化为「已记录，未派发步骤生效」）。 */
  summary: string;
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
  model: string | undefined;
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
  /**
   * Turn 上限 limiter。显式 0/负 = 显式不限 turn；undefined 未传同样不限。
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
  // [collect 退役] 原 collect 字段（sync 批通知路由选项，U1 foundation）已随批机制
  // 整体删除——批量编排走 `subagents` tool（fan-out 模板），完成通知恒为逐条 async
  // 投递。pi 对未知字段静默放行，存量调用形态的 collect 值不进本选项。
  /**
   * 空闲超时毫秒数（全 record 生效的 idle GC 节奏——原「仅 conversation 模式」
   * 限定随 chatMode 消亡移除）。覆盖默认 5min idle timeout。
   * 优先级：参数 > env TAIJI_SUBAGENT_IDLE_TIMEOUT_MS > 默认 300000ms。
   * 显式传 0/负数 = 禁用 idle GC（不挂 timer；旧实现 0 会落成 setTimeout(0) 立即 kill）。
   */
  idleTimeoutMs?: number;
  /**
   * 实际执行引擎 id（P4 路由留痕）：pi 引擎由 PiEngine.run 在还原 opts 时写入；
   * 缺省（历史调用方不设）= pi 投影。createRecordForMode 读入 record identity。
   */
  engine?: string;
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
  model: string | undefined;
  totalTokens: number;
  /** session jsonl 文件名（窗口期内可能 undefined）。 */
  sessionFile?: string;
  /** 直接父 subagent record ID（顶层 record 为 undefined）。[v4 A-6] 从
   *  record.parentRecordId 派生，配合 A-5 直接父守卫（message/close 仅作用于直接子）。 */
  parent?: string;
  /**
   * 终态三态对外语义（U3 C-outcome 一等披露，projectOutcome 唯一出口）：
   * completed / failed / cancelled，历史 record 无 outcome 字段时兜底派生，
   * 不可判读的存量形态为 "closed-legacy"。GUI pane / agent 据此判读成败，
   * 无需翻 error 字段原文（S5）。
   */
  outcome?: ProjectedOutcome;
  /**
   * 来源身份（H2 W1）：undefined（存量 list 形态 / record 无 origin）= "tool" 语义。
   * includeWorkflow 打开后 list 条目与手动派发 record 靠本字段区分（排查 workflow
   * run's subagents 场景的辨识数据）。
   */
  origin?: RecordOrigin;
  /** origin="workflow" 时所属 workflow run id；tool 来源恒缺省（同 record 侧）。 */
  parentRunId?: string;
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
  // [collect 退役] 原 collect 回显段（sync 登记回显，§3.1.1）已随批机制删除——
  // 完成通知恒为逐条 async 投递，无回显段。
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
  | { action: "start"; subagentId: string; sessionFile: string | null; slug: string; /** registry 全等回显（U1）；undefined = 用户未指定模型（R4 缺席语义，GUI 条件渲染不显示）。 */ model: string | undefined; bgResponse: BgResponse; __gui__?: GuiRenderResult }
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
  /**
   * 旧 closed 终态的 L2 关闭原因（桥接期兼容位，与 {@link ExecutionRecord.closedReason}
   * 同源投影/entry 重建；closed→idle 迁移映射后配合 status="idle" 判读终态遗留）。
   * SP-1 新增；U2 起新权威展示位 = stopReason（随 entry/重建投影 additive）。
   */
  closedReason?: ClosedReason;
  /**
   * 展示维度（永久会话模型 §3.2.1，U2 additive 投影）：上一轮为什么停。内存源经
   * recordToSubagent 投影、entry 重建经 readEntryTerminalFields 映射（存量 entry
   * closed→idle 时同步从 closedReason 迁移）；undefined = 从未收口 / 旧数据。
   */
  stopReason?: StopReason;
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
  /**
   * [W0 / D1] origin="workflow" 时在 run 内的步骤索引（与 ExecutionRecord.stepIndex
   * 同源投影 / entry 与 binding 重建）。additive：undefined（存量磁盘重建源 / tool
   * 来源）零迁移，读侧不参与 run 视图关联（无 stepIndex 的 record 不成行）。
   */
  stepIndex?: number;
  endedAt: number | undefined;
  turns: number;
  totalTokens: number;
  /** 模型留痕（R4/D6-①）：undefined = 用户未指定（引擎自身缺省解析），非空串。 */
  model: string | undefined;
  thinkingLevel: string | undefined;
  /**
   * 用户覆盖记账（[subagent-model-switch §6.2]，与 {@link ExecutionRecord.modelOverride}
   * 同源投影：内存源 recordToSubagent / 事件流折叠 scanFile 补投影）。additive：
   * undefined（存量 / 从未覆盖）零迁移。持久化权威 = record-model-override 事件帧
   * （写点 = store.markModelOverride），本字段是读模型可见面（冷复活水合 + 覆盖
   * 状态查询通道）。
   */
  modelOverride?: ModelOverride;
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
   * 对话轮次计数（modeless 波1 起全 record 语义）。round 仅在内存维护
   * （doFinalizeRoundToIdle 递增），跨重启不恢复（round 无磁盘持久化）；
   * 非 idle record 为 undefined。内存源由 recordToSubagent 从 ExecutionRecord.round 投影。
   */
  round?: number;
  /**
   * [modeless 波1·已删除字段] chatMode 投影随 ExecutionRecord.chatMode 消亡删除
   * （旧 entry/binding 残留键读侧忽略——万物可续后该区分无信息量）。
   */
  /** fork 模式下的 worktree handle。 */
  worktreeHandle?: WorktreeHandle;
  /**
   * 实际执行引擎 id（P4 路由留痕）。缺省 = pi 投影（存量 record 零迁移）；
   * GUI 警告条/引擎标记的数据源之一。
   */
  engine?: string;
  /**
   * 引擎自描述定位符（U1：EngineHandleData 的持久化消费面子集，引擎无关——
   * sessionRef 整体透传不枚举内部键）。read 降级链①②级的数据源（runtime
   * subagent-engine-history）；缺省 = pi（走 JSONL 直读链）。
   */
  engineHandle?: { sessionRef: Record<string, string>; eventsPath?: string; poolKey: string };
  // [modeless 波3·已删除字段] collectMode 快照投影随字段消亡删除（读侧丢弃，
  // 存量 entry 残留键零迁移）。
  /**
   * 离开批终局标记（与 ExecutionRecord.batchFinalized 同源投影/重建——存量 entry
   * 读侧兼容面，[collect 退役] 起只读不写：旧 session 文件反查投影仍携带）。
   * 缺省 = 未离开批 / 退役后新记录。
   */
  batchFinalized?: boolean;
}

// ============================================================
// 配置（global + session）
// ============================================================

/**
 * 全局配置（~/.pi/agent/subagents/config.json）。
 *
 * 模型解析已退化为「主 agent model 优先，仅 override 时查 registry」——
 * 不再有 category/fallback/yolo 字段。config.json 只保留 maxConcurrent
 * （pool 大小）。旧 config.json 中的 categories/fallback 等字段读取时忽略。
 * [collect 退役] 原 collectSync 节随 sync 批机制删除，残留键读取时忽略（零迁移）。
 */
export interface SubagentsGlobalConfig {
  version: number;
  maxConcurrent: number;
  /**
   * 全局默认执行引擎（D9 三层优先级的最底层：调用参数 > agent frontmatter > 本值）。
   * 缺省 'pi'（P4 路由层 DEFAULT_ENGINE_ID）。加载期只做类型校验，注册表校验归路由层。
   */
  defaultEngine?: string;
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
  readonly model: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly mode: ExecutionMode;
  readonly task: string;
  /** 短标签（≤35 字符）。来自 record.slug。 */
  readonly slug: string;
  readonly status: ExecutionStatus;
  readonly turns: number;
  readonly totalTokens: number;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly result: string | undefined;
  readonly error: string | undefined;
  readonly sessionFile: string | undefined;
}

