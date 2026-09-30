// src/execution/domain/record-model.ts
//
// [§2.4 类型归位 第二批] record 域的**聚合与单次调用结果**（原定义在
// `execution/assembly/types.ts`）。
//
// 本批迁入：`ExecutionRecord`（record 聚合根）、`AgentResult`（record 内嵌的单次
// agent 调用结果值对象）、判定谓词 `isValidStopReason`、两个判别联合守卫
// （`isPiTranscriptRef` / `isZcodeTranscriptRef`）、`DEFAULT_AGENT_NAME`。
// [⑥ 清理] `isReconnectableFinalReason` 随 manifest 重物化族（rematerialize*）退场删除
// ——唯一消费点已消失，死守卫不留。
//
// 依赖方向：只依赖 `./record-types.ts`（同层词汇）与 SDK 契约类型（`Turn` /
// `ToolCall` / `WorktreeHandle` / `AgentFailureKind` / `AgentUsageTotal`）——**不 import
// assembly / orchestration**，领域层在下由构造保证（值依赖环守卫 C-data-26 同批覆盖）。
//
// 刻意**不迁** `SubagentRecord`：字段证据（`eventLog: AgentEventLogEntry[]` +
// `displayItems: DisplayItem[]`）表明它是**应用层读模型**（同时携带领域字段与展示
// 载荷），不属领域实体；强行迁入会逼出「领域层 import 展示 DTO」的反向依赖。登记
// §2.4 已按此证据更正早先的「只读视图归领域」判断。
//
// 过渡形态：`execution/assembly/types.ts` 仍 re-export 本文件全部导出（消费面零改动）。

import type {
  AgentFailureKind,
  AgentUsageTotal,
  ToolCall,
  Turn,
  WorktreeHandle,
} from "@zhushanwen/subagent-engine-sdk";

import { STOP_REASONS } from "./record-types.ts";
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

/** 窄化守卫：值是否为合法 StopReason 字面量（外部输入防御性解析用）。 */
export function isValidStopReason(value: string | undefined): value is StopReason {
  return (STOP_REASONS as readonly string[]).includes(value ?? "");
}

/** 判别联合收窄守卫：pi 锚分支。 */
export function isPiTranscriptRef(ref: TranscriptRef): ref is PiTranscriptRef {
  return ref.engine === "pi";
}

/** 判别联合收窄守卫：zcode 锚分支。 */
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

/**
 * 所有执行路径的唯一状态源。
 *
 * 收口设计：一次执行的完整内容（text/thinking/toolCalls/usage）按 turn 收口在
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
   * 如 zcode 的 defaultModelSelection）——如实投影「未选择」，不伪造成 fallback 已选。
   * 禁空串哨兵：写侧（resolveIdentityForEngine）与读侧水合（record-store-rebuild /
   * state-marker）均把空串归一为 undefined。
   */
  readonly model: string | undefined;
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
   * [W0 / D1] origin="workflow" 时在 run 内的步骤索引（派发单源 = pump dispatch 的
   * callId/taskIndex，创建时随 originFields 写入）。additive：undefined（存量 record /
   * tool 来源）零迁移。持久化经 subagent-record entry 与 binding sidecar（两持久化面
   * 漏投影则重启后本字段回落 undefined，run 视图关联键缺失）。
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
   * = pi 投影（消费方零迁移）。持久化经 subagent-record entry。
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
   * record 无此字段，投影层按 projectOutcome 兜底（closed-legacy 语义）。
   */
  outcome?: ExecutionOutcome;
  /**
   * 离开批的终局标记（存量 entry 读侧兼容面——[collect 退役] 起**只读不写**）。
   * 历史写点（批闭合 flush 落标 / E9 dispose 落标）已随 sync 批机制退役删除；磁盘上
   * 存量 record 的 batchFinalized entry 必须容忍解析（旧 session 文件可读），标记保留
   * 为批域审计/孤儿 merge 透传面。undefined = 未离开批 / 退役后新记录。
   */
  batchFinalized?: boolean;

  // ── 永久会话模型新维度（§3.2.1；u-foundation 类型面，U2 实装写点）──
  // 全部可选、缺省 undefined = 旧语义零迁移（现有 record 构造不破坏）。
  /**
   * 展示维度：上一轮为什么停（旧 7 值 + 4 新展示值，见 {@link StopReason}）。
   * undefined = 从未收口 / 旧数据。展示+排障；U6 起参与 isOccupied 占用判定
   * （`running && stopReason === undefined`——W4 死亡纳管态 stopReason=failed 据此
   * 排除，[U5/D4] adoptEngineDeath 写点）。
   */
  stopReason?: StopReason;
  /**
   * 世代计数（reopen 防撞）：undefined 与 0 同义（常态）。reopen 时 +1；
   * 随 `.record-binding` 持久化（跨重启单调是硬要求，见 {@link Epoch}）。
   */
  epoch?: Epoch;
  /**
   * 放弃轮标记（通知 gate ②判据，单槽，随 binding 持久化）：
   * abort 时置在飞轮；reopen 后残留标记自然失效。null 与 undefined 同义
   * （无标记——不存在清空操作，跨 epoch 丢弃由判定第一步承接）。
   */
  lastAbandonedRound?: AbandonedRoundMark | null;
  /**
   * 对话记录指针（引擎中立判别联合）。undefined = 锚尚未回填（spawn 窗口期）/
   * 旧 record（迁移期仍读 sessionFile / engineHandle 投影）。
   */
  transcriptRef?: TranscriptRef;

  /** 完整执行内容，按 turn 组织。createRecord 初始化为 [空 turn]。 */
  turns: Turn[];
  /** turn 计数（= turns.filter(closed).length，冗余存储供投影直接读）。 */
  turnCount: number;
  totalTokens: number;
  /** 运行期最近一次 error 事件的消息（getEventLog 派生 error 条目用）。 */
  lastError: string | undefined;
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
   * 收口轮的轮次通知送达后收口落账消费（Continuation settle 分支 / one-shot 主干尾部，
   * 顺序约束 [写死]——收口落账必须在通知链之后，提前会丢收口轮通知）。
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
