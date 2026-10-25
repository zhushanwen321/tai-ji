// src/execution/domain/record-model.ts
//
// [§2.4 类型归位 第二批] record 域的**聚合与单次调用结果**（原定义在
// `execution/assembly/types.ts`）。
//
// 本批迁入：`ExecutionRecord`（record 聚合根）、`AgentResult`（record 内嵌的单次
// agent 调用结果值对象）、判定谓词 `isValidStopReason`、两个判别联合检查
// （`isPiTranscriptRef` / `isZcodeTranscriptRef`）、`DEFAULT_AGENT_NAME`。
// [⑥ 清理] `isReconnectableFinalReason` 随 manifest 重物化族（rematerialize*）退场删除
// ——唯一消费点已消失，失效的检查不留。
//
// 依赖方向：只依赖 `./record-types.ts`（同层词汇）与 SDK 契约类型（`Turn` /
// `ToolCall` / `WorktreeHandle` / `AgentFailureKind` / `AgentUsageTotal`）——**不 import
// assembly / orchestration**，领域层在下由构造保证（值依赖环检查 C-data-27 同批覆盖）。
//
// 刻意**不迁** `SubagentRecord`：字段证据（`eventLog: AgentEventLogEntry[]` +
// `displayItems: DisplayItem[]`）表明它是**应用层读模型**（同时携带领域字段与展示
// 载荷），不属领域实体；强行迁入会逼出「领域层 import 展示 DTO」的反向依赖。登记
// §2.4 已按此证据更正早先的「只读视图归领域」判断。
//
// 过渡形态：`execution/assembly/types.ts` 仍 re-export 本文件全部导出（消费方零改动）。

import type {
  AgentFailureKind,
  AgentOutcome,
  AgentOutcomeUsage,
  AgentUsageTotal,
  ErrorFact,
  FailureCause,
  EngineStopReason,
  ModelRef,
  ToolCall,
  Turn,
  WorktreeHandle,
} from "@zhushanwen/subagent-engine-sdk";

import { ROUND_TERMINAL_STOP_REASONS, STOP_REASONS } from "./record-types.ts";
import type {
  AbandonedRoundMark,
  ClosedReason,
  Epoch,
  ExecutionMode,
  ExecutionOutcome,
  ExecutionStatus,
  PiTranscriptRef,
  RecordOrigin,
  StopReason,
  TranscriptRef,
  ZcodeTranscriptRef,
} from "./record-types.ts";

/**
 * 派发期模型来源（本地副本——shared SubagentRecord.modelSource 同语义锚 = 
 * packages/shared/src/subagent.ts 的 SubagentModelSource，core 不依赖 @taiji/shared；
 * 双侧值域修改须同步）。同步的机器检查 = 双侧对拍单测
 * （src/execution/__tests__/subagent-model-source-parity.test.ts：编译期双向类型
 * 兼容断言 + 运行时清单逐项比对，任一侧增删值即红）。
 */
export type SubagentModelSource = "explicit" | "frontmatter" | "preference" | "default";

/**
 * SubagentModelSource 值全集（对拍清单锚点，NEW_STOP_REASONS 同款形态）：与 shared 侧
 * SUBAGENT_MODEL_SOURCE_ALL（packages/shared/src/subagent.ts）对拍——类型联合无运行时
 * 表示，值域漂移的运行时判据锚在本元组与 shared 元组上。联合扩值漏改本元组由对拍
 * 单测（shared 侧经 _SubagentModelSourceCoversAll 编译锁先行拦截）+ 本元组 satisfies
 * 正向锁共同拦截；core 侧不经 barrel 导出（测试相对路径消费，不扩公共 API 面）。
 */
export const SUBAGENT_MODEL_SOURCES = [
  "explicit",
  "frontmatter",
  "preference",
  "default",
] as const satisfies readonly SubagentModelSource[];

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

/** 窄化检查：值是否为合法 StopReason 字面量（外部输入防御性解析用）。 */
export function isValidStopReason(value: string | undefined): value is StopReason {
  return (STOP_REASONS as readonly string[]).includes(value ?? "");
}

/**
 * 用户覆盖记账（设计 subagent-model-switch §3.4 统一语言 / §6.2 记账形状）——
 * 用户实时下达的模型意图，作用域为一个 subagent 会话（同一 session 文件锚点串联的
 * 执行记录链）；优先级高于 agent frontmatter 与调用参数显式指定的模型（用户覆盖赢）。
 *
 * 语义约束（消费方 U2 setModel 编排与解析链第 0 层按此实现）：
 * - **不叠加**：同一会话至多一个覆盖值，再次换模型 = 覆盖旧覆盖值（§3.4 不变量 2）；
 *   不另设清除操作，覆盖只能被下一次切换替换（§2 Out of scope）。
 * - **意图而非生效值**：`ref` 恒为用户目标 ref（pi 部分模型族静默替换成同族模型时
 *   生效模型 ≠ 本字段——生效值只进切换应答回执与前端展示，不回写记账，§6.4）；
 *   `thinkingLevel` 仅在用户切换时显式选择档位才记录，pi 联动重设的瞬态档位不进记账
 *   （跨轮档位以解析链现役候选链裁决为准）。
 * - **传播**：解析命中覆盖的那一轮，新建执行记录时把当前覆盖原值写入新记录的
 *   {@link ExecutionRecord.modelOverride}——覆盖随记录链传播。
 * - **持久化只写意图**：切换操作永不改写 `record.model` 等历史事实类字段（不变量 5），
 *   本字段是 chat 域覆盖意图的持久化载体（workflow 域载体 = run 事件流覆盖事件，归 U4a）。
 */
export interface ModelOverride {
  /** 用户目标模型 ref（结构单源 = SDK ModelRef；宿主编排层负责 canonical ref 校验）。 */
  ref: ModelRef;
  /** 用户显式选择的 thinking 档位；缺省 = 未选择（下一轮按解析链候选链对新模型裁决）。 */
  thinkingLevel?: string;
  /** 覆盖下达时刻（epoch ms，Date.now()）——审计与「最近一次切换」判据。 */
  setAt: number;
}

/** 判别联合收窄检查：pi 锚分支。 */
export function isPiTranscriptRef(ref: TranscriptRef): ref is PiTranscriptRef {
  return ref.engine === "pi";
}

/**
 * 协议 usage → 轮收条 usage 快照（AgentOutcomeUsage → AgentUsageTotal 单点适配）。
 * 两域形状差异：协议终态带 contextTokens/turns、无 total；轮收条快照（AgentResult.usage
 * / RoundSettlementOutcome.usage / RoundFacts.usage 同一词表）按 {@link AgentUsageTotal}
 * 字段口径派生 total = 四项之和。contextTokens/turns 不进快照（轮收条轮数由轮终帧
 * turns 字段承载）。settle 两调用点（one-shot / chat 轮）共用，防两处手写漂移。
 */
export function roundUsageSnapshot(usage: AgentOutcomeUsage): AgentUsageTotal {
  const { input, output, cacheRead, cacheWrite, cost } = usage;
  return { input, output, cacheRead, cacheWrite, cost, total: input + output + cacheRead + cacheWrite };
}

/**
 * settle 站点事实载荷形状（全可选，缺省字段不落键）——{@link settlementFactsOf} 的
 * 返回型，settleRoundFailed 的 facts 入参同型复用。
 */
export type SettlementFacts = Partial<{
  failure: FailureCause;
  engineStopReason: EngineStopReason;
  retryAttempts: number;
  promptDisposition: "started" | "queued" | "handled";
  usage: AgentUsageTotal;
  observations: string[];
  stderrTeePath: string;
}>;

/**
 * 协议 AgentOutcome → settle 站点事实载荷单点（收尾边沿七字段条件收集；usage 经
 * {@link roundUsageSnapshot} 适配轮收条词形）。消费站点：one-shot 域 outcomeToAgentResult
 * 同构段与 chat 域 onRunSettled 失败分流 / settleRoundSuccess——多站点共用单构造器，
 * 防逐字段手写漂移（漏字段 = 轮收条事实静默缺失）。
 */
export function settlementFactsOf(outcome: AgentOutcome): SettlementFacts {
  return {
    ...(outcome.failure !== undefined ? { failure: outcome.failure } : {}),
    ...(outcome.engineStopReason !== undefined ? { engineStopReason: outcome.engineStopReason } : {}),
    ...(outcome.retryAttempts !== undefined ? { retryAttempts: outcome.retryAttempts } : {}),
    ...(outcome.promptDisposition !== undefined ? { promptDisposition: outcome.promptDisposition } : {}),
    ...(outcome.usage !== undefined ? { usage: roundUsageSnapshot(outcome.usage) } : {}),
    ...(outcome.observations !== undefined ? { observations: outcome.observations } : {}),
    // [§3.3.6 evidence 取证指针] 失败轮的引擎诊断 tee 路径透传（AgentOutcome.stderrTeePath
    // ——轮收条事实 → evidence 装配供源；仅诊断引用，读侧不假设文件永存）。
    ...(outcome.stderrTeePath !== undefined ? { stderrTeePath: outcome.stderrTeePath } : {}),
  };
}

/** 判别联合收窄检查：zcode 锚分支。 */
export function isZcodeTranscriptRef(ref: TranscriptRef): ref is ZcodeTranscriptRef {
  return ref.engine === "zcode";
}

/** 一次 session 执行的完整结果。collectResult 产出，写入 Record.outcome。 */
export interface AgentResult { // oe-exempt:20260930:framework:领域值对象——单次 agent 调用结果（§2.4 归位搬迁，非新增抽象）
  text: string;
  turns: number;
  durationMs: number;
  success: boolean;
  error?: string;
  /**
   * 失败分诊结构化标签（type-only 引用零运行时依赖）。
   * @deprecated [subagent-observability §3.4，ADR-0158] 随 AgentFailureKind 保留为旧
   * record 帧与历史 journal 的解析兼容；新写入方失败分类一律产 {@link FailureCause}
   * （下方 failure 字段）。产出侧残留仅引擎送达错误码前缀确定性分诊
   * （AgentOutcome.failureKind 透传）；缺省 = undefined（字段缺位），不承载重试判定
   * （重试判定在 FailureCause.retryable 三态）。
   */
  failureKind?: AgentFailureKind;
  /**
   * [subagent-observability §3.3.8/§3.3.3] 失败分类（AgentOutcome.failure 透传——
   * 收尾边沿一次产出）。settleOneShotOutcome 消费：随轮收条 rec.lastRound.failure
   * 落盘，list/通知消费方读事实分类；缺省 = 未分类（旧格式 / 合成结果放行）。
   */
  failure?: FailureCause;
  /**
   * [subagent-observability §3.3.3] 轮终停因引擎原值（AgentOutcome.engineStopReason
   * 透传）。settleOneShotOutcome 消费：「正常收尾」派生判据（stop 且无失败分类 =
   * completed）的事实输入；缺省 = 事实缺席，宿主回落派生展示词。
   */
  engineStopReason?: EngineStopReason;
  /** [subagent-observability §3.3.3 P5] 本 run 内 pi 原生重试的失败尝试计数
   *  （AgentOutcome.retryAttempts 透传；缺省 = 无重试/旧格式）。 */
  retryAttempts?: number;
  /**
   * [subagent-observability §3.3.1/§3.3.3] 本轮被接管收尾的标注（AgentOutcome.promptDisposition
   * 透传；handled = 本条 prompt 未启动任何 run）。settleOneShotOutcome 消费：随轮收条
   * rec.lastRound.promptDisposition 落盘——被接管轮结清走 no_result、通知走接管分支；
   * 缺省 = 无接管事实。
   */
  promptDisposition?: "started" | "queued" | "handled";
  /**
   * [subagent-observability §3.3.2/§3.3.10] 观察性事实数组（AgentOutcome.observations
   * 透传——引擎产出侧摘要，不改写 failure）。settleOneShotOutcome 消费：随轮收条
   * rec.lastRound.observations 落盘；缺省 = 无观察项。
   */
  observations?: string[];
  /**
   * [§3.3.6 evidence 取证指针] 引擎子进程 stderr tee 文件绝对路径（AgentOutcome.stderrTeePath
   * 透传，失败轮诊断引用；settleOneShotOutcome 消费：随轮收条 rec.lastRound.stderrTeePath
   * 落盘 → list evidence 装配）。仅诊断引用——文件受引擎侧轮转与过期清理管辖，
   * 读侧不假设其永存；缺省 = 成功轮 / 引擎未上报。
   */
  stderrTeePath?: string;
  sessionId: string;
  toolCalls: ToolCall[];
  usage?: AgentUsageTotal;
  /** /resume /fork 可恢复的 session 文件名（不含目录）。 */
  sessionFile?: string;
  /** schema 模式下，structured-output tool 的 result.details（已通过 schema 校验）。 */
  parsedOutput?: unknown;
}

/**
 * 轮收条事实快照（[subagent-observability §3.3.3] markRoundIdle 写点产出，附录在
 * {@link ExecutionRecord.lastRound}）——只承载「派生不出来的事实」：结果正文已在
 * 聚合字段 result 上（正文摘要由读侧 summarize 派生），不重复存储；turns 收进
 * 快照——聚合字段 turnCount 是 live 计数器（下一轮轮始起继续累加），收条自身的
 * 「轮终时点累计轮数」只能随收条定格（markRoundIdle 写点快照）。
 * 结构镜像 shared SubagentLastRound 的事实子集（wire 形状 SSOT = shared；core 读模型
 * 只取事实维度——跨包形状一致由 runtime 投影产出侧 + 对拍测试锚定）。
 */
export interface RoundFacts { // oe-exempt:20260930:framework:领域值对象——轮收条事实快照（subagent-observability §3.3.3）
  /** 引擎停因原值（值域 = ROUND_TERMINAL_STOP_REASONS；undefined = 迁移期回落帧 / 被接管轮）。 */
  engineStopReason?: (typeof ROUND_TERMINAL_STOP_REASONS)[number];
  /** 失败分类（收尾边沿一次产出，只读不可替换——§3.3.2）。undefined = 无失败发生。 */
  failure?: FailureCause;
  /** pi 接管三态（handled = 被接管——引擎未执行，§3.3.1 P6）。undefined = 无 disposition 事实。 */
  promptDisposition?: "started" | "queued" | "handled";
  /** 本轮结束时的累计轮数（markRoundIdle 写点定格——live turnCount 在下一轮会推进，非收条值）。 */
  turns?: number;
  /** 轮收条 usage 快照（最终尝试值，P5 计账）。undefined = 引擎未上报。 */
  usage?: AgentUsageTotal;
  /** 重试尝试计数（auto_retry_start 帧数）。undefined = 无重试事实。 */
  retryAttempts?: number;
  /** 观察性事实（§3.3.10 降级通道，不改写 failure）。undefined = 无观察项。 */
  observations?: string[];
  /**
   * 引擎子进程 stderr tee 文件绝对路径（失败轮的诊断引用，AgentOutcome.stderrTeePath
   * 透传；成功轮引擎不上报）。仅诊断引用——文件受引擎侧轮转与过期清理管辖，读侧
   * 不得假设其永存。
   */
  stderrTeePath?: string;
}

/**
 * 所有执行路径的唯一状态源。
 *
 * 汇总设计：一次执行的完整内容（text/thinking/toolCalls/usage）按 turn 汇总在
 * `turns: Turn[]` 里。eventLog / currentActivity / result 文本均从 turns[] 派生
 * （getEventLog / getCurrentActivity / getFullText），不再独立存储切片或缓冲。
 *
 * 生命周期：createRecord() 创建 → updateFromEvent() 实时更新（累积进 turns）→
 *           completeLegacyClosed() 冻结 → archive 立即移出内存（读时从 session.jsonl 重建）。
 *
 * TUI 永远拿 RecordSnapshot（.slice() 快照），不直接持此可变对象。
 */
export interface ExecutionRecord { // oe-exempt:20260930:framework:领域聚合根——record 聚合（§2.4 归位搬迁，非新增抽象）
  /** 唯一 ID（sync: "run-N"，bg: "bg-N-xxx"）。 */
  readonly id: string;

  // ── 身份（创建时确定，不可变）──
  readonly agent: string;
  /**
   * 模型留痕（R4/D6-① 可选化）：undefined = 用户未指定模型（引擎走自身缺省解析，
   * 如 zcode 的 defaultModelSelection）——如实呈现「未选择」，不伪造成 fallback 已选。
   * 禁空串哨兵：写侧（resolveIdentityForEngine）与读侧水合（record-store-rebuild /
   * state-marker）均把空串归一为 undefined。
   */
  readonly model: string | undefined;
  /**
   * 派发期模型来源（shared SubagentRecord.modelSource 同语义；本地副本——core 不依赖
   * @taiji/shared，双侧值域修改须同步）。'explicit' = task 参数显式指定；'frontmatter'
   * = agent .md 声明；'preference' = settings 偏好补缺；'default' = 引擎/链路自解析
   * （未指定）。与 model 覆盖（modelOverride/热切）正交——只记 spawn 时点来源。
   * additive：undefined（存量 record）= 来源未知。创建期确定，不可变。
   */
  readonly modelSource?: SubagentModelSource;
  readonly thinkingLevel: string | undefined;
  /**
   * 用户覆盖记账（意图类字段，见 {@link ModelOverride} 语义注释）。
   * 可选 + 向后兼容：旧记录无此字段照常读取（undefined = 从未被用户覆盖）。
   * 切换操作永不改写上方 model 盖章值（不变量 5）——本字段是「未来意图」，
   * model 是「该轮启动事实」，两字段并存各司其职（§6.2）。
   */
  readonly modelOverride?: ModelOverride;
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
   * "workflow" = workflow 脚本 agent() 派发（生产写入方 W2 接线）。过滤在派生视图/查询
   * 消费方（list 默认滤 workflow origin），store 治理侧（孤儿恢复/revive）全量可见。
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
   * [W0 / D1] origin="workflow" 时在 run 内的步骤索引（派发单源 = pump dispatch 的
   * callId/taskIndex，创建时随 originFields 写入）。additive：undefined（存量 record /
   * tool 来源）零迁移。持久化经 subagent-record entry 与 binding sidecar（两持久化路径
   * 漏映射则重启后本字段回落 undefined，run 视图关联键缺失）。
   */
  readonly stepIndex?: number;
  /**
   * [modeless 波1·已删除字段] chatMode（对话模式标志）停写删除：万物可续后
   * 「模式」不再是 record 状态——每个 record 轮终落 idle 可续聊（message 即续、
   * fork 可继承）。旧持久化数据（entry / binding / session identity）残留键读侧
   * 自然忽略，legacy 缺省归 chat 语义与 modeless 天然一致，零迁移。
   */
  /**
   * 空闲超时毫秒数（idle GC 回收节奏，全 record 生效）。覆盖默认 5min idle timeout。
   * 优先级：参数 > env TAIJI_SUBAGENT_IDLE_TIMEOUT_MS > 默认 300000ms。
   * 向后兼容：旧 record 无此字段，按默认值处理。
   */
  readonly idleTimeoutMs?: number;
  /**
   * 实际执行引擎 id（P4 路由留痕，D9①）。创建时确定不可变；缺省（存量 record）
   * = pi 派生视图（消费方零迁移）。持久化经 subagent-record entry。
   */
  readonly engine?: string;
  /**
   * 引擎自描述定位符（U2：非 pi run resolve 后回填、终态迁移落 entry 前——run 前
   * 缺省不可用）。sessionRef 整体透传（失败终态 sessionId 缺失时仍回填已有部分，
   * 读侧①级降②级的防御形态）；eventsPath 为 retarget 后实际落盘路径。pi 分支不
   * 回填（sessionFile 即定位符）。持久化经 subagent-record entry。
   */
  engineHandle?: { sessionRef: Record<string, string>; eventsPath?: string; poolKey: string };
  // [modeless 波3·已删除字段] collectMode 随「collect = 派发时路由选项」语义消亡：
  // sync 批成员身份 = collectCoordinator 登记态（executeViaEngine 派发时点注册），
  // 非 record 身份；旧 entry 残留键读侧自然忽略，零迁移。

  // ── 状态（实时更新）──
  status: ExecutionStatus;
  /**
   * 旧 closed 终态的 L2 关闭原因（桥接期兼容位，见 {@link ClosedReason}）。
   * 桥接不变量：本字段非 undefined ⟺ 旧「closed 终态」（配合 status="idle"）；
   * 新 settle 路径（markSettled）不写本字段（不终态化）。新权威展示位 =
   * {@link stopReason}；U3+ 收缩后本字段退役。
   * 向后兼容：旧 record 无此字段，按 gc 处理（通用完成/失败）。
   */
  closedReason?: ClosedReason;
  /**
   * 终态三态对外语义（U3 C-outcome）。completeLegacyClosed 唯一写入点按 deriveOutcome
   * 一次计算，消费方只读本字段不再自行推导。向后兼容：旧 record / 磁盘重建
   * record 无此字段，派生视图层按 projectOutcome 兜底（closed-legacy 语义）。
   */
  outcome?: ExecutionOutcome;
  /**
   * 离开批的终局标记（存量 entry 读侧兼容范围——[collect 退役] 起**只读不写**）。
   * 历史写点（批收尾 flush 落标 / E9 dispose 落标）已随 sync 批机制退役删除；磁盘上
   * 存量 record 的 batchFinalized entry 必须容忍解析（旧 session 文件可读），标记保留
   * 为批域审计/孤儿 merge 透传侧。undefined = 未离开批 / 退役后新记录。
   */
  batchFinalized?: boolean;

  // ── 永久会话模型新维度（§3.2.1；u-foundation 类型范围，U2 实装写点）──
  // 全部可选、缺省 undefined = 旧语义零迁移（现有 record 构造不破坏）。
  /**
   * 展示维度：上一轮为什么停（值域见 {@link StopReason}——引擎原值 + 宿主中断族 +
   * 旧推断值迁移位）。undefined = 从未收尾 / 旧数据 / 被接管轮（引擎未执行无停因）。
   * 展示+排障；参与 isOccupied 占用判定（`running && stopReason === undefined`——
   * 轮收条已写 = 本轮不在途的等价信号）。写入点 = markRoundIdle 轮终簿记（引擎死亡
   * 走正常轮终——退出码非 0 → error 停因，无独立死亡写点）；在途期被轮始清点族清空
   * （markRoundStarted / revive 格）。
   */
  stopReason?: StopReason;
  /**
   * 世代计数（reopen 防撞）：undefined 与 0 同义（常态）。reopen 时 +1；
   * 随 `.record-binding` 持久化（跨重启单调是硬要求，见 {@link Epoch}）。
   */
  epoch?: Epoch;
  /**
   * 放弃轮标记（通知 gate ②判据，单槽，随 binding 持久化）：
   * abort 时置在途轮；reopen 后残留标记自然失效。null 与 undefined 同义
   * （无标记——不存在清空操作，跨 epoch 丢弃由判定第一步承接）。
   */
  lastAbandonedRound?: AbandonedRoundMark | null;
  /**
   * 对话记录指针（引擎中立判别联合）。undefined = 锚尚未回填（spawn 窗口期）/
   * 旧 record（迁移期仍读 sessionFile / engineHandle 派生视图）。
   */
  transcriptRef?: TranscriptRef;

  /** 完整执行内容，按 turn 组织。createRecord 初始化为 [空 turn]。 */
  turns: Turn[];
  /** turn 计数（= turns.filter(closed).length，冗余存储供派生视图直接读）。 */
  turnCount: number;
  totalTokens: number;
  /**
   * 最后一个非空轮失败（§3.3.5 派生展示——权威事实在 {@link errors} 只追加数组，
   * 本字段由 reducer appendErrorFact 单点派生刷新，不因轮终/新轮清空；undefined =
   * 无失败事实）。
   */
  lastError: string | undefined;
  /**
   * 轮失败事实只追加数组（subagent-observability §3.3.5；ErrorFact 权威定义在 SDK
   * journal-replay.ts）。append-only，不因轮终清除；lastError 由「最后一个非空轮
   * 失败」派生刷新（reducer appendErrorFact 单点）。undefined = 旧数据（reducer
   * 侧 `??=` 兜底初始化，读侧按空数组理解）。
   */
  errors?: ErrorFact[];
  /**
   * 最近一轮的轮收条事实快照（[subagent-observability §3.3.3] markRoundIdle 写点
   * 一次写入、下轮轮始不清理——「上一轮怎么收尾」的内存读侧权威源，recordToSubagent
   * 派生视图直读）。停因词表值（rec.stopReason 旧展示位）与事实快照并存（迁移期
   * 双写，§3.4）。undefined = 本进程内尚无轮终（重启后经 fold 重建路径恢复）。
   */
  lastRound?: RoundFacts;
  /**
   * 对话轮次计数（modeless 波1 起全 record 语义）。首轮运行时 = 0；每完成一轮
   * （finalizeRoundToIdle 进 idle）+1。undefined 时视为 0。
   */
  round?: number;
  // [H1 U6 / D7 ③] roundBaseTurnIndex（增量通知 base 记账）已退役删除——消费函数
  // getFullTextFrom/nextRoundBaseTurnIndex 与唯一写点 settleChatRoundFromResponse 随
  // chat 域载体退役，生产零调用（base 推进 = 死记账）。
  // [ADR-0081 空闲回收机制退役] idleSince（GC 定时器 TTL 判据锚）已退役删除——机制删除
  // 后生产零读点（写点 markSettledImpl / markRoundIdle 随删）；磁盘存量字段的读取
  // 按宽容形状处理（多余 JSON 字段无害）。
  /**
   * close 优雅关闭标志（M2-B3）。record 运行中调 `close {force:false}` 时置 true；
   * 收尾轮的轮次通知送达后收尾写入 journal 记录的消费（Continuation settle 分支 / one-shot 主干尾部，
   * 顺序约束 [写死]——收尾写入 journal 记录必须在通知链之后，提前会丢收尾轮通知）。
   * undefined/false = 正常 idle 分流（轮次完成进 idle 等续聊）。
   * 仅 running 时有意义；force:true（立即终止）不走此标志。
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
