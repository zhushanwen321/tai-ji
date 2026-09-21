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
// 范围边界：本文件只有类型与词表常量——append/scan 实装、JSONL 落盘布局
// （run 既有 store 旁的 wf-<id>.events.jsonl）、清理规则（cap + TTL，仅已终局 run）
// 均归 journal 实装单元，此处不写。
//
// 词表边界（D5）：事件族裁剪自 zcode dwf_event、按 taiji 域命名。taiji workflow
// 脚本 API 面只有 agent/parallel/pipeline/phase/log（worker-script-builder 注入的
// 完整集合），无脚本内子进程调用通道，故不设脚本子进程事件（zcode world-run 族
// 无对应物）——词表恰好 7 个。
//
// 层归属：Engine（数据结构层，零 infra 依赖，可独立编译测试）。

import type { EngineProtocolErrorCode } from "@zhushanwen/subagent-engine-sdk";

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
 * 可诊断，不是拒记）。注册表投影的 interrupted_abandoned（interrupted 超放弃窗
 * 终局化）属注册表单元词表，届时按需并入，此处不预铺。
 */
export type RunErrorCode =
  | EngineProtocolErrorCode
  | `engine_${string}`
  | AgentFailureKind;

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
