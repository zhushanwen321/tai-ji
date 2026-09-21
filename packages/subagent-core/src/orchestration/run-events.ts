// src/orchestration/run-events.ts
//
// Workflow run 事件词表与 journal 接口类型层（设计 workflow-architecture-redesign §3.3 D5）。
//
// 为什么需要它：现状 run 状态是进程自写快照（FileRunStore 的 JSONL 全量投影），
// 无事件流——「怎么死的」只有终态一帧，重试轨迹（第一波 21 秒全灭、重试波写完
// 报告）完全不可见，重试能掩盖事故。本模块定义 run 级事件的词表（判别联合）与
// journal 接口形态，为后续事件 journal 单元（append/scan 实装、快照投影、注册表
// 投影）提供类型地基。
//
// 范围边界：词表/类型层 + 状态机（合法转移表数据 + transition 纯函数）+
// journal 实装（createRunEventJournal：JSONL 落 <dir>/<runId>.events.jsonl，
// runId 即 generateRunId 的 wf- 前缀产物，故渲染名与设计 D5 的
// wf-<id>.events.jsonl 一致；与 run 既有 store 同目录与否由调用方传 dir 决定）。
// 清理规则（cap + TTL，仅已终局 run）归 Q2 注册表单元，此处不写。
//
// 词表边界（D5）：事件族裁剪自 zcode dwf_event、按 taiji 域命名。taiji workflow
// 脚本 API 面只有 agent/parallel/pipeline/phase/log（worker-script-builder 注入的
// 完整集合），无脚本内子进程调用通道，故不设脚本子进程事件（zcode world-run 族
// 无对应物）——词表恰好 7 个。
//
// 层归属：Engine。状态机核心（词表 + 转移表 + transition）零 IO / 零时钟依赖，
// 可独立编译测试；journal 实装是本模块唯一 IO 边（node:fs + core logger facade）。

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { EngineProtocolErrorCode } from "@zhushanwen/subagent-engine-sdk";

import { getLogger } from "../core/logger.ts";
import type { AgentFailureKind } from "./models/types.ts";

// ── 终态双维度（D5-1）────────────────────────────────────────

/**
 * run 终局形态词表（三态）。
 *
 * 与 DoneReason（completed/failed/aborted/budget_limited/time_limited，六因
 * 单维度）的关系：outcome 是终态正交化后的「run 自身怎么死的」维度（harness
 * 系统层）——脚本判定失败（review-failure）= outcome:completed + 脚本返回失败
 * 结论（业务层），两者处置路径不同（前者人工聚合报告，后者修环境重跑），必须
 * 分维度表达。aborted 在本词表命名为 cancelled（对齐 D5 词表；DoneReason 存量
 * 词表不动，映射归 journal 写入方实现）。
 */
export const ALL_RUN_OUTCOMES = ["completed", "failed", "cancelled"] as const;

/** run 终局形态（run-settled 与 ask-settled 共用——ask 粒度的 cancelled = run 中止连带在途 ask 终止）。 */
export type RunOutcome = (typeof ALL_RUN_OUTCOMES)[number];

/**
 * 终局错误码：outcome 为 failed（或 ask 失败）时的「怎么死的」结构化编码。
 *
 * 词表复用两族既有实装，不造新词（D5-1）：
 * - 引擎错误码：SDK 协议固定词表（engine_crashed 等 9 个）+ 引擎自报透传面
 *   （engine_ 前缀、core 不解释文案的 passthrough 契约）。显式并列
 *   EngineProtocolErrorCode 而非只留模板面——固定词表是该 union 的权威枚举源，
 *   SDK 侧词表演进（含非 engine_ 前缀的新码）自动跟进；
 * - 失败分类：AgentFailureKind（stale_context / schema_deterministic / unknown，
 *   产出侧 classifyFailureKind 词表，经 orchestration/models/types.ts re-export）。
 *
 * unknown 是合法成员：分类不出来的失败照记事件（词表漂移的失效模式 = 保守
 * 可诊断，不是拒记）。interrupted_abandoned 是注册表投影单元的终局化编码
 * （interrupted 超放弃窗 → terminal(failed) 的 manifest errorCode，D5 转移表
 * interrupted × abandon-elapsed 行）——不描述进程怎么死的，描述「为什么此刻
 * 被判终局」，故为独立字面量成员而非复用任一既有族。
 */
export type RunErrorCode =
  | EngineProtocolErrorCode
  | `engine_${string}`
  | AgentFailureKind
  | "interrupted_abandoned";

// ── 事件词表（D5-2，恰好 7 个）──────────────────────────────

/** 事件类型全集（判别键）。恰好 7 个——增删成员须先改设计 D5 载荷表再动此词表。 */
export const RUN_EVENT_TYPES = [
  "run-created",
  "ask-dispatched",
  "ask-executing",
  "ask-retrying",
  "ask-settled",
  "armed",
  "run-settled",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/**
 * 事件公共信封字段：墙钟时间戳（Date.now() epoch ms）。
 *
 * D5 载荷表未列 ts，但快照投影（calls[].startedAt / lastProgressAt 派生）与
 * 注册表新鲜度判据都要求事件自带时间——投影只消费事件流（「快照 + 事件流双写
 * 时快照必然漂移、权威必须在事件流」），没有 ts 的 journal 无法支撑投影，故
 * 信封层统一携带。
 */
export interface EventEnvelope {
  ts: number;
}

/** `run-created`——run 创建落账（journal 首帧）。 */
export interface RunCreatedEvent extends EventEnvelope {
  type: "run-created";
  /**
   * run 唯一 id（journal 文件名同源：wf-<id>.events.jsonl）。全词表唯一携带
   * runId 的事件——journal 文件本身即 run 域，其余事件不重复携带。
   */
  runId: string;
  /** 脚本身份名（RunSpec.scriptName，meta.name 或文件名 stem）。 */
  workflowName: string;
  /** 调用参数摘要（截断的序列化形态——事件行要小，全文 args 不进 journal）。 */
  argsSummary: string;
  /** run 级 model 引用（RunSpec.model；缺省 = 继承主 agent 模型）。 */
  model?: string;
}

/**
 * ask 身份三元组（D5 载荷表 dispatched/executing 行的载荷）。
 *
 * taskIndex 对齐 AgentCall.id（= trace stepIndex，D-10 单源）——同一 ask 的
 * dispatched/executing/retrying/settled 全链共享同一 taskIndex。D5 载荷表仅在
 * dispatched/executing 行列出 taskIndex，但快照投影按 calls[].id 关联事件与
 * 条目，settled/retrying 缺 taskIndex 则无法定位归属 ask（agentName 不唯一、
 * attempt 单独不足），故四个 ask 事件统一携带。
 */
interface AskIdentity {
  taskIndex: number;
  /** agent 身份名（ExecutionTraceNode.agent 同源）。 */
  agentName: string;
  /** 尝试序号（1 起，与 AgentCall.attempts 同一计数链）。 */
  attempt: number;
}

/** `ask-dispatched`——脚本 agent() 调用已派发。 */
export interface AskDispatchedEvent extends AskIdentity, EventEnvelope {
  type: "ask-dispatched";
}

/** `ask-executing`——引擎已开始执行该次尝试（派发 → 执行的分界帧）。 */
export interface AskExecutingEvent extends AskIdentity, EventEnvelope {
  type: "ask-executing";
}

/** `ask-retrying`——失败尝试后将退避重试（重试轨迹从脚本内部状态变为 journal 事件，重试不再能掩盖事故）。 */
export interface AskRetryingEvent extends EventEnvelope {
  type: "ask-retrying";
  /** ask 关联键（见 AskIdentity——投影按 calls[].id 关联）。 */
  taskIndex: number;
  /** 触发本次重试的失败尝试序号（1 起——刚失败的 attempt，退避后序号 +1 再执行）。 */
  attempt: number;
  /** 退避等待毫秒（指数退避，executeAgentCall 的 BACKOFF_* 常数同源）。 */
  backoffMs: number;
  /** 重试原因摘要（失败分类或错误文案摘要）。 */
  reason: string;
}

/** `ask-settled`——单次 ask 终局（每次尝试各一帧，attempt 区分重试波）。 */
export interface AskSettledEvent extends EventEnvelope {
  type: "ask-settled";
  /** ask 关联键（见 AskIdentity——投影按 calls[].id 关联）。 */
  taskIndex: number;
  /** 终局尝试的序号（验收形态：ask-settled{outcome:failed, errorCode:engine_crashed, attempt:1}）。 */
  attempt: number;
  /** ask 终局形态（复用 RunOutcome 三态）。 */
  outcome: RunOutcome;
  /** 失败时的结构化编码（成功/取消缺省）。 */
  errorCode?: RunErrorCode;
  /** 终局尝试的墙钟耗时毫秒（对齐 AgentResult.durationMs 口径）。 */
  durationMs: number;
  /**
   * 诊断引用（D5-3）：失败时子进程 stderr tee 文件路径（W11 已有落盘）——
   * errorCode 与取证文件指针一起落账，排障不用翻全量日志。
   */
  stderrTeePath?: string;
}

/** `armed`——schema 强制武装确认回执（D3）。 */
export interface RunArmedEvent extends EventEnvelope {
  type: "armed";
  /**
   * 武装确认帧内容（占位形态）：帧的终态形状由 D3 协议版（host/armed 反向帧）
   * 实施期按帧族语义裁定，本层只锚定「回执进 journal」的语义——仅 native
   * schema 引擎（pi）会发，emulated 引擎豁免（无孙进程 env/扩展依赖，「武装」
   * 概念不适用）。协议帧落地前本事件无生产写入方。
   */
  frame: unknown;
}

/** `run-settled`——run 终局（一个 run 恰好一帧；终局通知的单点判定源，防多处各判漏分支）。 */
export interface RunSettledEvent extends EventEnvelope {
  type: "run-settled";
  outcome: RunOutcome;
  /** 失败时的结构化编码（completed/cancelled 缺省）。 */
  errorCode?: RunErrorCode;
  /** 终局原因摘要（自由文本；干净完成可缺省）。 */
  reason?: string;
  /** 产物目录指针：run 持久化产物所在目录绝对路径（终局通知与排障的入口载荷）。 */
  artifactsDir: string;
}

/** run 事件判别联合（D5 词表全集，恰好 7 个；判别键 = type）。 */
export type WorkflowRunEvent =
  | RunCreatedEvent
  | AskDispatchedEvent
  | AskExecutingEvent
  | AskRetryingEvent
  | AskSettledEvent
  | RunArmedEvent
  | RunSettledEvent;

// ── journal 接口形态（仅类型签名——实装归 journal 单元）──────

/**
 * run 事件 journal 的接口形态（append / scan）。
 *
 * 单写者约束（D5）：append 的唯一合法调用方 = core 进程 workflow-dispatch
 * （宿主侧唯一编排点）——引擎侧事件经既有 run 事件通道上报后由写者落账，
 * 引擎不直接写 journal。类型层无法约束调用方，该约束由实装与守卫共同保证。
 */
export interface RunEventJournal {
  /**
   * 追加一条事件（JSONL 单行）。runId 显式传参而非从事件取——仅 run-created
   * 携带 runId，目标文件定位不依赖事件形态。
   */
  append(runId: string, event: WorkflowRunEvent): Promise<void>;
  /**
   * 顺序扫描某 run 的全部事件（写入序）。消费方：快照投影（startedAt /
   * lastProgressAt 派生）、注册表投影（事件流停止 = 待恢复态判读）、恢复对账。
   * 终局后过保留期的清理（cap + TTL）不改变 scan 语义——清理后返回剩余诊断
   * 证据，终局权威回落 manifest 的 outcome/errorCode（journal 权威性按 run
   * 生命周期分两段，D5）。
   */
  scan(runId: string): Promise<readonly WorkflowRunEvent[]>;
}

// ── 状态词表（D5-1 两维正交：lifecycle × outcome）──────────────

/**
 * lifecycle 维全集（六态）。
 *
 * 语义链：created（创建校验通过、run-created 未落账）→ dispatched（脚本已派发，
 * engine 预备段——armed 回执窗口）→ running（首个 ask 派发后）→ settling（全部
 * settled / 重试预算耗尽，终局判定中）→ terminal（吸收态）；interrupted =
 * 事件流停止的待恢复态（host-died 判读，非 terminal——7 天放弃窗后经
 * abandon-elapsed 终局化，D9-1）。与 outcome 维正交：只有 terminal 行产生
 * outcome，其余 lifecycle 的 outcome 恒缺省（由 transition 构造性保证）。
 */
export const ALL_RUN_LIFECYCLES = [
  "created",
  "dispatched",
  "running",
  "settling",
  "terminal",
  "interrupted",
] as const;

export type RunLifecycle = (typeof ALL_RUN_LIFECYCLES)[number];

/**
 * run 状态机状态（两维正交的扁平形态）。
 *
 * 为什么扁平而非嵌套判别联合（`{ lifecycle: "terminal"; outcome } | 其余`）：
 * 「outcome 仅 terminal 出现」是机器不变量，transition 是 RunState 的唯一构造
 * 点（表行声明 terminalOutcome 或从 run-settled 事件取），消费侧读 outcome 前
 * 只需一处 `lifecycle === "terminal"` 判定；嵌套形态把同一不变量复制进类型系统，
 * 全部消费点多一层 narrow，收益不抵摩擦。
 */
export interface RunState {
  lifecycle: RunLifecycle;
  /** 终局形态——仅 lifecycle === "terminal" 时有值（transition 构造性保证）。 */
  outcome?: RunOutcome;
}

/** 状态机初始态（run 创建点与 journal fold 起点共用）。 */
export const INITIAL_RUN_STATE: RunState = { lifecycle: "created" };

// ── 控制事件词表（驱动转移、不属 journal 词表——D5 第 2 层注记）─

/**
 * 控制事件类型全集（4 个）。
 *
 * 为什么独立于 RUN_EVENT_TYPES：控制事件源于用户/宿主/守护/投影判定，不是编排
 * 层事件流的一帧——驱动转移但不直接落 journal。类型层经 TransitionTrigger 并集
 * 区分两个词表；journal.append 的参数类型（WorkflowRunEvent）构造性排除控制
 * 事件，控制终局路径需要落账时由调用侧合成 run-settled（见输出动作注释）。
 */
export const CONTROL_TRIGGER_TYPES = [
  "cancel-requested",
  "watchdog-fired",
  "host-died",
  "abandon-elapsed",
] as const;

export type ControlTriggerType = (typeof CONTROL_TRIGGER_TYPES)[number];

/**
 * 控制事件判别联合。载荷只带自由文本 reason（诊断用），不带 ts——ts 信封由
 * 调用侧在合成落账事件 / 终局通知时补（transition 纯函数契约，见函数注释）。
 */
export type ControlTrigger =
  | { type: "cancel-requested"; reason?: string }
  | { type: "watchdog-fired"; reason?: string }
  | { type: "host-died" }
  | { type: "abandon-elapsed" };

/** 转移触发全集 = journal 词表事件 + 控制事件。 */
export type TransitionTrigger = WorkflowRunEvent | ControlTrigger;

// ── 输出动作词表（转移的声明性输出，P1b 接线消费）──────────────

/**
 * 输出动作标签全集（6 个）。
 *
 * 状态机核心不执行动作——transition 只裁决「哪些动作应该发生」，执行归调用侧
 * （P1b 接线：workflow-dispatch / settle 编排点 / 注册表投影）。标签语义：
 * - journal-append：事件落 journal。触发事件属 journal 词表时 = 事件本身；
 *   控制事件触发的终局转移 = 调用侧合成的 run-settled 事件（cancel →
 *   outcome:cancelled；ts 信封由调用侧补）
 * - manifest-write：终局投影——manifest/.state 写 outcome/errorCode（D5-4）
 * - notify：终局通知触发（D7；pending:unregister 随通知闭环）
 * - registry-project：注册表投影更新（D9-1，interrupted 判读）
 * - kill-run-topology：watchdog kill 收窄到 run 进程树（D9-2；zcode 引擎
 *   no-progress 降级为 stall 通知，不产生本动作）
 * - journal-cleanup-eligible：journal 获清理资格（已终局 + 过保留期，Q2）
 */
export const TRANSITION_OUTPUT_TYPES = [
  "journal-append",
  "manifest-write",
  "notify",
  "registry-project",
  "kill-run-topology",
  "journal-cleanup-eligible",
] as const;

export type TransitionOutput = (typeof TRANSITION_OUTPUT_TYPES)[number];

// ── 合法转移表（数据 = 唯一权威；表外一律 fail-fast）───────────

/**
 * running × ask-settled 的二支判别（D5 转移表行 3/4 的条件维度）。
 *
 * 为什么这一族需要条件行：「重试预算未尽 → 留在 running」与「预算耗尽 / 全部
 * settled → 进入终局判定」依赖状态机外的事实（在途 ask 数、排定的重试），事件
 * 载荷本身不可判定。裁决输入经 TransitionContext.enterSettling 显式传入，两支
 * 都落表（而非散落 if），穷尽单测照常遍历。
 */
export type AskSettleBranch = "more-work-expected" | "adjudicate-now";

/** 单条转移规则（表行）。 */
export interface TransitionRule {
  from: RunLifecycle;
  on: RunEventType | ControlTriggerType;
  /**
   * 条件行判别标签：同 (from, on) 键二支时区分，undefined = 无条件行。
   * 当前唯一条件族 = running × ask-settled。
   */
  guard?: AskSettleBranch;
  next: RunLifecycle;
  /**
   * next === "terminal" 时的终局形态来源：固定值（cancel → cancelled、
   * abandon → failed）或缺省 = 从 run-settled 事件载荷取（event.outcome）。
   * 非 terminal 行恒缺省。abandon 路径的 errorCode（interrupted_abandoned）
   * 是 manifest 写入内容而非状态——由 Q2 注册表单元在消费 manifest-write
   * 时附着，不进 RunState（词表边界见 RunErrorCode 注释）。
   */
  terminalOutcome?: RunOutcome;
  /** 该转移应发生的输出动作（声明性标签，执行归调用侧）。 */
  outputs: readonly TransitionOutput[];
}

/**
 * 合法转移表（24 行）。
 *
 * D5 示意表 8 行的落地 + 补全的必要转移：armed 在 dispatched/running 的自环
 * （D3 回执窗口横跨 engine 预备段与执行段）、后续 ask-dispatched/ask-executing/
 * ask-retrying 的 running 自环（parallel/pipeline 多波）、run-settled 自
 * running/dispatched 的终局行（cancel 路径合成 run-settled 与零 ask 脚本的
 * journal fold 重放需要——fold 只见 journal 事件，控制事件不在流中）、
 * dispatched × cancel-requested（脚本预备段可取消）、dispatched/settling ×
 * watchdog-fired（kill 目标进程树在这两态仍存活）。interrupted 的恢复转移
 * （重跑/接管）属 D9-2 后续单元裁决，本期不铺——需要时按「先改设计 D5 表
 * 再补表行与穷尽单测」的流程增补。
 */
export const RUN_TRANSITIONS: readonly TransitionRule[] = [
  // ── created：创建落账前 ──
  { from: "created", on: "run-created", next: "dispatched", outputs: ["journal-append"] },
  { from: "created", on: "host-died", next: "interrupted", outputs: ["registry-project"] },

  // ── dispatched：engine 预备段（armed 窗口；零 ask 脚本可直达终局）──
  { from: "dispatched", on: "armed", next: "dispatched", outputs: ["journal-append"] },
  { from: "dispatched", on: "ask-dispatched", next: "running", outputs: ["journal-append"] },
  { from: "dispatched", on: "run-settled", next: "terminal", outputs: ["journal-append", "manifest-write", "notify"] },
  { from: "dispatched", on: "cancel-requested", next: "terminal", terminalOutcome: "cancelled", outputs: ["journal-append", "manifest-write", "notify"] },
  // 声明性行——kill 执行链在 remote-engine D9-2（run-events 层零 IO/零进程依赖，
  // 不投递本事件；本行只裁决「该态下 watchdog 触发应发生什么」）。
  { from: "dispatched", on: "watchdog-fired", next: "dispatched", outputs: ["kill-run-topology"] },
  { from: "dispatched", on: "host-died", next: "interrupted", outputs: ["registry-project"] },

  // ── running：ask 执行段（多波自环 + ask-settled 二支）──
  { from: "running", on: "armed", next: "running", outputs: ["journal-append"] },
  { from: "running", on: "ask-dispatched", next: "running", outputs: ["journal-append"] },
  { from: "running", on: "ask-executing", next: "running", outputs: ["journal-append"] },
  { from: "running", on: "ask-retrying", next: "running", outputs: ["journal-append"] },
  { from: "running", on: "ask-settled", guard: "more-work-expected", next: "running", outputs: ["journal-append"] },
  { from: "running", on: "ask-settled", guard: "adjudicate-now", next: "settling", outputs: ["journal-append"] },
  { from: "running", on: "run-settled", next: "terminal", outputs: ["journal-append", "manifest-write", "notify"] },
  { from: "running", on: "cancel-requested", next: "terminal", terminalOutcome: "cancelled", outputs: ["journal-append", "manifest-write", "notify"] },
  // 声明性行——kill 执行链在 remote-engine D9-2（run-events 层零 IO/零进程依赖，
  // 不投递本事件）。状态语义：watchdog-fired 只输出 kill 动作、不迁态——被 kill
  // 的在途 ask 的事件证据（ask-settled(failed)）随后到达时才驱动转移，状态变化
  // 仍由事件证据驱动（「settling = 无在途 ask」不变量不被 kill 时序破坏：kill 是
  // 外因，收编以终局帧为准）。
  { from: "running", on: "watchdog-fired", next: "running", outputs: ["kill-run-topology"] },
  { from: "running", on: "host-died", next: "interrupted", outputs: ["registry-project"] },

  // ── settling：终局判定中（只等 run-settled / cancel / host-died / 迟到的 kill）──
  { from: "settling", on: "run-settled", next: "terminal", outputs: ["journal-append", "manifest-write", "notify"] },
  { from: "settling", on: "cancel-requested", next: "terminal", terminalOutcome: "cancelled", outputs: ["journal-append", "manifest-write", "notify"] },
  // 声明性行——kill 执行链在 remote-engine D9-2（run-events 层零 IO/零进程依赖，
  // 不投递本事件）。
  { from: "settling", on: "watchdog-fired", next: "settling", outputs: ["kill-run-topology"] },
  { from: "settling", on: "host-died", next: "interrupted", outputs: ["registry-project"] },

  // ── terminal：吸收态，无表行（任意事件 fail-fast，D5 表末行）──

  // ── interrupted：待恢复态（host-died 幂等重判 + 放弃窗终局化）──
  { from: "interrupted", on: "host-died", next: "interrupted", outputs: ["registry-project"] },
  { from: "interrupted", on: "abandon-elapsed", next: "terminal", terminalOutcome: "failed", outputs: ["manifest-write", "journal-cleanup-eligible"] },
];

// ── 唯一入口 transition（纯函数）──────────────────────────────

/**
 * running × ask-settled 二支的裁决输入。
 *
 * enterSettling = 本次 settle 后无在途 ask 且无排定重试（预算耗尽或全部
 * settled），直接进入终局判定。缺省 / false = 留在 running——journal fold
 * 重放无此上下文，保守取 running 支：重放至多把 settling 延后到 run-settled
 * 帧（fold 下 settling 是不可重现的活体内瞬态），终局正确性不受影响。
 */
export interface TransitionContext {
  enterSettling?: boolean;
}

/** 转移结果：次态 + 应发生的输出动作（声明性标签，执行归调用侧）。 */
export interface TransitionResult {
  state: RunState;
  outputs: readonly TransitionOutput[];
}

/** 表外转移（编程错误）——fail-fast 抛出，message 含恢复动作指引。 */
export class IllegalTransitionError extends Error {
  readonly from: string;
  readonly on: string;
  constructor(from: string, on: string, detail: string) {
    super(`非法 run 状态转移：lifecycle=${from} 不接受事件 ${on}。${detail}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.on = on;
  }
}

function guardMatches(rule: TransitionRule, ctx?: TransitionContext): boolean {
  if (rule.guard === undefined) return true;
  return rule.guard === "adjudicate-now" ? ctx?.enterSettling === true : ctx?.enterSettling !== true;
}

/** 从表派生某 lifecycle 的合法事件清单（错误信息用，不手工维护第二份）。 */
function legalTriggerTypesOf(lifecycle: RunLifecycle): string[] {
  const seen = new Set<string>();
  for (const rule of RUN_TRANSITIONS) {
    if (rule.from === lifecycle) seen.add(rule.on);
  }
  return [...seen];
}

function resolveTerminalOutcome(rule: TransitionRule, trigger: TransitionTrigger): RunOutcome {
  if (rule.terminalOutcome !== undefined) return rule.terminalOutcome;
  if (trigger.type === "run-settled") return trigger.outcome;
  // 表不变量：无固定 terminalOutcome 的终局行只能是 run-settled 行（穷尽单测把守）
  throw new Error(
    `转移表不变量破坏：(from=${rule.from}, on=${rule.on}) 终局行既无固定 terminalOutcome 也无法从事件取 outcome——修 RUN_TRANSITIONS 该行。`,
  );
}

/**
 * 状态机唯一入口（纯函数）：(当前态, 触发) → (次态, 输出动作)。
 *
 * 纯函数契约：无 IO、无 Date.now / Math.random——ts 信封由调用侧补（构造事件时
 * 打点，控制事件合成 run-settled 落账时打点）。P1b 接线形态：
 * 1. 活体路径：编排点在每个事件/control 触发处调 transition，按 outputs 执行
 *    动作（journal-append → append 或合成 run-settled 后 append；terminal 后
 *    单写者停止向该 run append——terminal × 任意事件 fail-fast 即该纪律的守卫）；
 * 2. fold 重放：scan(runId) 逐事件 transition（不传 ctx），终帧落 terminal 或
 *    停在 running（= 投影侧 interrupted 判读的输入）；
 * 3. 状态查询走投影（事件流 fold），禁止直写状态字段（D5-4）。
 *
 * 表外转移抛 {@link IllegalTransitionError}（含当前态 / 事件 / 该态合法事件表，
 * 错误信息可操作）。
 */
export function transition(
  state: RunState,
  trigger: TransitionTrigger,
  ctx?: TransitionContext,
): TransitionResult {
  const on = trigger.type;
  const candidates = RUN_TRANSITIONS.filter(
    (rule) => rule.from === state.lifecycle && rule.on === on && guardMatches(rule, ctx),
  );
  if (candidates.length === 0) {
    const legal = legalTriggerTypesOf(state.lifecycle);
    const detail =
      legal.length === 0
        ? "该态无任何合法后续事件——terminal 是吸收态，已终局 run 再投递任何事件均为编程错误（检查单写者是否在 run-settled 后仍向该 run 追加事件）。"
        : `该态合法事件：${legal.join(" / ")}。排查：事件投递是否乱序（journal 重放 / 恢复对账）；若确需新增转移，先改设计 D5 转移表再补 RUN_TRANSITIONS 表行与穷尽单测。`;
    throw new IllegalTransitionError(state.lifecycle, on, detail);
  }
  if (candidates.length > 1) {
    // guard 互斥性破坏 = 表 bug，与表外转移同为编程错误，但指向修表而非修调用方
    throw new Error(
      `转移表不变量破坏：(from=${state.lifecycle}, on=${on}) 命中多条规则——检查 RUN_TRANSITIONS 的 guard 互斥性。`,
    );
  }
  const rule = candidates[0];
  const nextState: RunState = { lifecycle: rule.next };
  if (rule.next === "terminal") {
    nextState.outcome = resolveTerminalOutcome(rule, trigger);
  }
  return { state: nextState, outputs: rule.outputs };
}

// ── journal 实装（createRunEventJournal——本模块唯一 IO 边）────

const journalLogger = getLogger("run-event-journal");

/**
 * runId 白名单：字母数字开头 + [A-Za-z0-9_-]，长度 ≤ 128。
 *
 * 为什么白名单而非黑名单：journal 文件名由 runId 直接拼出（join(dir,
 * `<runId>.events.jsonl`)），黑名单漏一个形态就是一次路径穿越；白名单只放行
 * generateRunId 的产出字符集（wf-<ts>-<base36>），首字符约束同时排除 "."、
 * ".." 与隐藏文件形态，"/" "\" 根本不在字符集内。
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function assertValidRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `非法 runId ${JSON.stringify(runId)}：journal 文件名只接受字母数字开头、字符集 [A-Za-z0-9_-]、长度 ≤128 的 runId（防路径穿越）。runId 应来自 lifecycle.ts 的 generateRunId（wf-<ts>-<rand>）；收到非法值时检查调用方的 runId 传递链。`,
    );
  }
}

const RUN_EVENT_TYPE_SET: ReadonlySet<string> = new Set(RUN_EVENT_TYPES);

/** 坏行判定的最小形状校验：JSON 对象 + type 落在词表内（词表外 = 坏行）。 */
function isWorkflowRunEventLine(value: unknown): value is WorkflowRunEvent {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && RUN_EVENT_TYPE_SET.has(type);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}

class FileRunEventJournal implements RunEventJournal {
  private dirEnsured = false;

  constructor(private readonly dir: string) {}

  /** journal 文件名：<runId>.events.jsonl（runId 自带 wf- 前缀，渲染名即设计的 wf-<id>.events.jsonl）。 */
  private journalPath(runId: string): string {
    return join(this.dir, `${runId}.events.jsonl`);
  }

  async append(runId: string, event: WorkflowRunEvent): Promise<void> {
    assertValidRunId(runId);
    if (!this.dirEnsured) {
      // 惰性一次：目录缺失自建（recursive 幂等），scan 侧不建目录（只读）
      mkdirSync(this.dir, { recursive: true });
      this.dirEnsured = true;
    }
    // 为什么同步 append：journal 是取证证据——D9-1 的 host-died 判据 = 事件流
    // 停止，批写缓冲随进程死亡丢失的恰好是「死前在做什么」的尾部帧；事件频率
    // 200-400/run 跨分钟级（D5 量级推演），同步追加的微秒级成本不构成吞吐压力，
    // 换取「append 返回即达页缓存」的零丢失窗口。接口保持 Promise 形态
    // （RunEventJournal 契约），实装内同步完成——调用方无需感知。
    appendFileSync(this.journalPath(runId), `${JSON.stringify(event)}\n`, "utf8");
  }

  async scan(runId: string): Promise<readonly WorkflowRunEvent[]> {
    assertValidRunId(runId);
    let content: string;
    try {
      content = readFileSync(this.journalPath(runId), "utf8");
    } catch (error) {
      // 文件不存在 = 空 journal（run 未落账 / 已过保留期清理）——与「pi session
      // 文件延迟写入」同族的缺省语义，消费方按空流处理；其余读错误原样抛出。
      if (isNodeErrorCode(error, "ENOENT")) return [];
      throw error;
    }
    const events: WorkflowRunEvent[] = [];
    let malformed = 0;
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformed += 1;
        continue;
      }
      if (isWorkflowRunEventLine(parsed)) {
        events.push(parsed);
      } else {
        // 词表外 type（含合法 JSON 但漂移的形态）同样按坏行跳过——scan 的失效
        // 模式是保守可诊断（跳过 + 计数 + warn），不是炸掉整个投影
        malformed += 1;
      }
    }
    if (malformed > 0) {
      journalLogger.warn(
        `run-event journal scan：跳过 ${malformed} 个坏行（文件=${this.journalPath(runId)}）`,
        { runId, malformed },
      );
    }
    return events;
  }
}

/**
 * 创建文件形态的 run 事件 journal（唯一创建入口）。
 *
 * @param dir journal 目录（布局决策归调用方：taiji 布局传 run store 旁的
 *        workflow-state 目录，测试传 mkdtemp 临时目录）。
 */
export function createRunEventJournal(dir: string): RunEventJournal {
  return new FileRunEventJournal(dir);
}
