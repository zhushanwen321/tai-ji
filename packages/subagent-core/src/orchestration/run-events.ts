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
// 无对应物）。[U4 pi-workflow-run-resource-model] additive 扩容：member-pool（成员
// 复用池登记/清空，决策 9）。[W2 D2] 死形态清退：ask-executing 事件（无生产写入
// 方）随词表缩窄删除——词表 7 个。
//
// 层归属：Engine。状态机核心（词表 + 转移表 + transition）零 IO / 零时钟依赖，
// 可独立编译测试；journal 实装是本模块唯一 IO 边（node:fs + core logger facade）。

// ── 终局证据读序（权威声明）──────────────────────────────────
//
// 「这个 run 终局了吗、怎么死的」在磁盘上有三个通道。各消费方（注册表投影
// run-registry / retention pruneTerminalRunFiles）此前在各自注释里局部论述
// 「谁在何时信哪个」，现单点收口于 journal 帧的定义处（本文件）。三通道角色
// 与采信顺序（降序）：
//
// 1. journal run-settled 帧（<runId>.events.jsonl，本文件词表）——最权威。一个
//    run 恰好一帧、单写者（worker-message-pump 终局 coda）同步落账；活体状态
//    查询、注册表投影一律首选。保留期内恒可信；被 retention 裁剪后通道消失。
// 2. state 文件终态快照（<runId>.jsonl 末行 status/reason）——恢复投影。与
//    journal 双写、天然可能过时（快照必漂移，见 EventEnvelope.ts 注释），仅当
//    journal 通道缺席（已裁剪）时作降级终局证据（读方 = runtime session 投影 /
//    session-reader 家族链的 state 文件读取）。
// 3. terminal manifest（<runId>.json 的 outcome/errorCode）——终局持久投影，
//    不承载「怎么死的」的运行时判定。仅两个用途：retention 资格（outcome 非空
//    = 已终局，pruneTerminalRunFiles 的单源锚定）与 abandon 终局化（run-registry
//    对 interrupted 超放弃窗写 manifest 才算终局）。journal/state 均被裁剪后，
//    它是终局事实的最后落点（清理后投影回落 manifest 终局面）。
//
// 何时允许信哪个：run 生命周期内（journal 在盘）信 1；1 被裁剪后降级信 2，
// 再缺席才信 3；retention / abandon 资格判定只信 3（宁保留不误裁——误裁活跃
// run 是不可恢复事故方向）。

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 引擎协议码运行时 guard（SDK 权威词表，RunErrorCode engine 家族收窄用——自造匹配
// 逻辑会与 SDK 词表演进漂移）。
import {
  isEngineErrorPassthroughCode,
  isEngineProtocolErrorCode,
  type EngineProtocolErrorCode,
} from "@zhushanwen/subagent-engine-sdk";

import { getLogger } from "../core/logger.ts";
import type { AgentFailureKind, DoneReason } from "./models/types.ts";
import type { WorkflowRun } from "./models/workflow-run.ts";

// ── 终态双维度（D5-1）────────────────────────────────────────

/**
 * run 终局形态词表（四值正交，[W2 D2/D5] interrupted 入词表后的单源）。
 *
 * 与 DoneReason（completed/failed/aborted/invalid_args/budget_limited/
 * time_limited，六因单维度）的关系：outcome 是终态正交化后的「run 自身怎么死的」维度（harness
 * 系统层）——脚本判定失败（review-failure）= outcome:completed + 脚本返回失败
 * 结论（业务层），两者处置路径不同（前者人工聚合报告，后者修环境重跑），必须
 * 分维度表达。aborted 在本词表命名为 cancelled（对齐 D5 词表；DoneReason 存量
 * 词表不动，映射归 journal 写入方实现）。
 *
 * interrupted = 被动终局的唯一权威表达（「崩溃 ≠ 失败」的用户可感区分）：
 * 崩溃收编 / abandon 7 天窗 / idle-gc 30 天回收三条路径写入，细分语境由
 * errorCode 承载（interrupted_abandoned / idle-evicted）。它不出自任何执行侧
 * 判定——只有收编/回收原语写入（record 轮终与 ask 终局构造性不可达，消费方
 * 按 `Exclude<RunOutcome, "interrupted">` 收窄，见 execution/assembly/types.ts
 * 的 ExecutionOutcome 派生别名）。
 *
 * 值域跟随锚：shared `WorkflowRunOutcome`（投影派生输出口径的第三份字面量，
 * core↔shared 依赖方向不允许物理单源）经 runtime 侧双包值级等价断言钉住
 * （core ALL_RUN_OUTCOMES ≡ extractor 集合 ≡ shared 词表成员，runtime 单测）。
 */
export const ALL_RUN_OUTCOMES = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

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
 * （abandon 收编路径 run-settled 帧的 errorCode——[W2 D3] 超放弃窗经
 * adoptInterruptedRun → settleRunAccounting 原语落账 outcome='interrupted'；
 * 旧「转移表 interrupted × abandon-elapsed 行写 terminal(failed)」的形态已随
 * [W2 D2] 死形态清退退役）——不描述进程怎么死的，描述「为什么此刻
 * 被判终局」，故为独立字面量成员而非复用任一既有族。
 *
 * budget_limited / time_limited 是 run 级终局码（dispatchFinalRunSettle 生产：
 * DoneReason 同名字面量恒等映射）——与 interrupted_abandoned 同族：不描述引擎
 * /agent 怎么失败，描述「为什么此刻被判终局」（harness 系统层裁决）。不复用
 * 既有族的依据：engine_ 前缀有「引擎自报」契约（SDK error-codes.ts 透传面，
 * 预算/时限耗尽是宿主侧裁决非引擎上报，借用即伪造自报）；AgentFailureKind
 * 是 ask 级失败分诊三态（预算耗尽不是 ask 失败形态）；"unknown" 语义 = 分类
 * 不出来，而这两族死因是确定已知的。
 *
 * idle-evicted 同族第三成员（[W2 D3/D5]）：idle-gc 30 天回收的终局码——
 * outcome='interrupted' 帧的细分语境（管理性回收，非用户主动非证实失败）。
 * 写入方 = idle-gc 改走终局记录原语的路径；词表先于接线入单源（V0），
 * 与 interrupted_abandoned 同款登记。
 */
export type RunErrorCode =
  | EngineProtocolErrorCode
  | `engine_${string}`
  | AgentFailureKind
  | "budget_limited"
  | "time_limited"
  | "interrupted_abandoned"
  | "idle-evicted";

// ── DoneReason → RunOutcome 映射表定稿（与下方 RunErrorCode 映射同族的姊妹单点）──

/**
 * DoneReason 六因 → RunOutcome 的单点映射（[W2 D5] 映射表定稿，dispatch 链语境）。
 *
 * 全表（六值逐行）：
 *
 * | DoneReason      | outcome    | errorCode 承载        | 语义依据 |
 * |-----------------|------------|----------------------|---------|
 * | completed       | completed  | —                    | 成功 |
 * | failed          | failed     | 因提取（extractFailedRunErrorCode） | 执行失败 |
 * | aborted         | cancelled  | —                    | 用户主动取消（cancel-requested 控制事件合成路径的终局 outcome 同值——转移表 cancelled 行与本映射构造性一致） |
 * | budget_limited  | failed     | 'budget_limited'     | 预算耗尽 = 任务没跑完，failed 是用户视角的诚实归因 |
 * | time_limited    | failed     | 'time_limited'       | 活体墙钟预算超时 = 用户显式设置 timeoutMs/budgetTimeMs 到期的主动管理行为 |
 * | invalid_args    | failed     | 因提取               | 参数校验失败——生产不达 finalizeRun（launcher 校验在 run 创建前返回），收录仅为映射穷尽；run 从未创建、不落终局帧（不适用行） |
 *
 * time_limited 双语境注记（[W2 D5 表注]）：上表行只覆盖 dispatch 链语境（活体
 * 预算超时 → failed）。idle-gc 30 天回收语境的同一 DoneReason 字面量落
 * interrupted + errorCode='idle-evicted'（管理性回收 = 被动终局，不稀释
 * cancelled 的「主动」语义）——该行不经本函数派生，映射判据用触发源（场景
 * 语境）而非字面量，由收编/回收写入方（idle-gc 改走终局记录原语的路径）直写。
 *
 * 消费方：core worker-message-pump 的 dispatchFinalRunSettle（同构判别，aborted
 * 分支走 cancel-requested 合成不改用本函数——两条路径的 outcome 语义一致）+ 壳
 * helpers 通知载荷的 outcome 字段（原 extension 侧 mapDoneReasonToOutcome 本地
 * 镜像已删，经 barrel 消费本单源；漂移信号 = 通知 outcome 与 journal
 * run-settled 帧 outcome 不一致）。
 */
export function doneReasonToRunOutcome(reason: DoneReason): RunOutcome {
  switch (reason) {
    case "completed":
      return "completed";
    case "aborted":
      return "cancelled";
    case "failed":
    case "budget_limited":
    case "time_limited":
    case "invalid_args":
      return "failed";
  }
}

// ── DoneReason → RunErrorCode 映射（词表语义的同位归属：映射的每个分支都引用
// 上方词表收录依据；唯一消费方 = worker-message-pump 的 dispatchFinalRunSettle，
// 与本文件上方 doneReasonToRunOutcome 同族——同一个 DoneReason 判别）──

/**
 * DoneReason → RunErrorCode 的单点映射。
 *
 * - completed/aborted：成功与取消（cancel-requested 控制事件合成路径）不带码
 *   （RunSettledEvent.errorCode 字段语义「失败时才有」）；
 * - budget_limited/time_limited：run 级终局码恒等映射（同名字面量，上方注释载
 *   收录依据）；
 * - failed/invalid_args：按因提取——invalid_args 与 failed 同组对齐 extension
 *   mapDoneReasonToOutcome 的既有归类（invalid_args 生产不达 finalizeRun——
 *   launcher 参数校验在 run 创建前返回，防误分组而已）。
 */
export function finalRunErrorCodeOf(run: WorkflowRun, doneReason: DoneReason): RunErrorCode | undefined {
  switch (doneReason) {
    case "completed":
    case "aborted":
      return undefined;
    case "budget_limited":
      return "budget_limited";
    case "time_limited":
      return "time_limited";
    case "failed":
    case "invalid_args":
      return extractFailedRunErrorCode(run);
  }
}

/**
 * failed 族的因提取：扫描最后一个失败 call 的 result（终局因的时序近似——多 ask
 * run 下脚本可能吞掉早先失败后自身错误终局，与 stderrTeePath 诊断引用「最后一帧」
 * 的取值纪律同一取舍；单 ask 失败即主流终局场景精确）。
 *
 * 优先级：① 引擎协议码——AgentResult.error 文本的 `<code>: <detail>` 前缀格式是
 * SDK 跨面契约（EngineSdkError message 恒为该形态，AgentOutcome.error 与协议
 * error 帧共用），前缀命中 SDK 固定词表（engine_crashed 等）或 engine_ 透传面
 * 才落码（guard 收窄防普通错误文案误判）；② failureKind（ask 级分诊标签）；
 * ③ "unknown"（保守可诊断成员，诊断全文仍在 reason/trace 面）。
 */
function extractFailedRunErrorCode(run: WorkflowRun): RunErrorCode {
  let lastError: string | undefined;
  let lastFailureKind: AgentFailureKind | undefined;
  for (const call of run.state.calls.values()) {
    const result = call.result;
    if (result !== undefined && result.error !== undefined) {
      lastError = result.error;
      lastFailureKind = result.failureKind;
    }
  }
  if (lastError !== undefined) {
    const sep = lastError.indexOf(": ");
    if (sep > 0) {
      const code = lastError.slice(0, sep);
      if (isEngineProtocolErrorCode(code)) return code;
      if (isEngineErrorPassthroughCode(code)) return code as `engine_${string}`;
    }
  }
  return lastFailureKind ?? "unknown";
}

// ── 事件词表（D5-2，[W2 D2] 清退后 7 个）─────────────────────

/**
 * 事件类型全集（判别键）——增删成员须先改设计载荷表再动此词表（D5 纪律；
 * member-pool 为 U4 additive 扩容；ask-executing 随 [W2 D2] 死形态清退删除——
 * 无生产写入方，dispatched 帧已承载 ask 起点语义；历史 journal 行经 scan/parse
 * 的词表外坏行路径跳过计日志，见 isWorkflowRunEventLine）。
 */
export const RUN_EVENT_TYPES = [
  "run-created",
  "ask-dispatched",
  "ask-retrying",
  "ask-settled",
  "member-pool",
  "armed",
  "run-settled",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/**
 * 事件公共信封字段：行级单调序号 + 墙钟时间戳（Date.now() epoch ms）。
 *
 * seq（1 起严格递增，同一 journal 文件内全序；W1 [D1] 起）：同一事件的唯一行
 * 身份——W2 通知去重键（终态事件身份）的载体 + tail 截断重建后全量重读的 fold
 * 去重依据（seq ≤ 已见水位的行按重放跳过，见 foldRunEventFrames）。与 record 侧
 * RecordEventEnvelope（u0）同构——两域 tail 原语（journal-tail.ts）的去重语义
 * 对称落位。
 *
 * ts：D5 载荷表未列，但快照投影（calls[].startedAt / lastProgressAt 派生）与
 * 注册表新鲜度判据都要求事件自带时间——投影只消费事件流（快照与事件流双写时
 * 快照必然漂移；三通道采信顺序见本文件头部「终局证据读序」权威声明），没有
 * ts 的 journal 无法支撑投影，故信封层统一携带。
 *
 * [W1 存量兼容读，D7] W1 前的 journal 行无 seq 字段——读取面（scan 解析判定与
 * fold 守卫）对「缺失 seq」放行（旧行为完全不变）；携带 seq 的行按正整数契约
 * 校验，坏值 = 坏行。见 isWorkflowRunEventLine 与 foldRunEventFrames 注释。
 */
export interface EventEnvelope {
  seq: number;
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
 * ask 身份三元组（D5 载荷表 dispatched 行的载荷）。
 *
 * taskIndex 对齐 AgentCall.id（= trace stepIndex，D-10 单源）——同一 ask 的
 * dispatched/retrying/settled 全链共享同一 taskIndex。D5 载荷表仅在 dispatched
 * 行列出 taskIndex，但快照投影按 calls[].id 关联事件与条目，settled/retrying
 * 缺 taskIndex 则无法定位归属 ask（agentName 不唯一、attempt 单独不足），故
 * 三个 ask 事件统一携带。
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
  /**
   * 剧本 phase 归属（`phase()` 包裹 / `opts.phase` 显式声明——派发时刻由 worker
   * 脚本按 `opts.phase || _currentPhase` 算出，随 agent-call 消息到达壳侧落账）。
   * W1 设计 D6「phase 分组供源承接」：v1 快照 trace 停写后 phase 的唯一落盘通道，
   * 快照 fold 与 runtime 投影经此恢复 calls[].phase（renderer hasExplicitPhases
   * 判据 `phase !== undefined` 的供源）。
   * 可选 = 旧 journal 行（停写期帧）与未标注剧本（无 phase 归属）兼容——缺省即
   * 「无归属」，fold/投影侧保持 undefined 不造键。
   */
  phase?: string;
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
  /** 终局尝试的序号（ask 粒度 attempt=1 即终局，无 ask 级重试波时恒 1）。 */
  attempt: number;
  /** ask 终局形态（复用 RunOutcome 三态）。 */
  outcome: RunOutcome;
  /** 失败时的结构化编码（成功/取消缺省）。ask 级实装取值 = result.failureKind
   *  （AgentFailureKind 三值 + unknown 缺省，dispatchAskSettled 映射）；engine_crashed
   *  等 run 级 RunErrorCode 值属 run-settled 帧，不出现在本帧。 */
  errorCode?: RunErrorCode;
  /** 终局尝试的墙钟耗时毫秒（对齐 AgentResult.durationMs 口径）。 */
  durationMs: number;
  /**
   * 诊断引用（D5-3）：失败时子进程 stderr tee 文件路径（W11 已有落盘）——
   * errorCode 与取证文件指针一起落账，排障不用翻全量日志。
   */
  stderrTeePath?: string;
}

/**
 * `member-pool`——成员复用池登记 / 清空落账（[U4 pi-workflow-run-resource-model]
 * 决策 9，additive）：workflow 成员会话 name 键复用池（run 级 Map<name, recordId>）
 * 的权威落盘通道，action 判别两态——
 * - `register`：同 run 同名 agent() 调用**首次**派发登记（name → recordId 映射唯一
 *   写入；续聊 revive 复用同一映射，不发新事件）。name 与 ask-dispatched 的
 *   agentName 同口径（`opts.description ?? opts.agent`），可作核对锚。
 * - `clear`：run 收尾池清空（有登记才发，每 run 至多一帧；finalizeRun 内**先于**
 *   run-settled 帧投递——terminal × 任意事件是表外转移 fail-fast，清空晚于终局帧
 *   就再也进不了 journal）。
 *
 * 写入序红线（决策 9）：先 append 本事件、后改内存池——进程崩溃落在两条语句之间的
 * 窄窗只会多出一条事件，fold 重放幂等（foldMemberReusePool，member-reuse-pool.ts），
 * 不会缺项。内存池不是第二真相源：run 中断重发后的恢复 = journal fold 重建。
 */
interface MemberPoolEventBase extends EventEnvelope {
  type: "member-pool";
}

export interface MemberPoolRegisterEvent extends MemberPoolEventBase {
  /** 同 run 同名 agent() 首次派发登记。 */
  action: "register";
  /** 成员会话 name（run 内唯一身份键）。 */
  name: string;
  /** 成员 record id（复用路由的命中键）。 */
  recordId: string;
}

export interface MemberPoolClearEvent extends MemberPoolEventBase {
  /** run 收尾池清空。 */
  action: "clear";
}

export type MemberPoolEvent = MemberPoolRegisterEvent | MemberPoolClearEvent;

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

/** run 事件判别联合（D5 词表全集，[W2 D2] 清退后 7 个；判别键 = type）。 */
export type WorkflowRunEvent =
  | RunCreatedEvent
  | AskDispatchedEvent
  | AskRetryingEvent
  | AskSettledEvent
  | MemberPoolEvent
  | RunArmedEvent
  | RunSettledEvent;

/**
 * 写侧入参形态：事件去掉 seq（seq 由 journal 单写者分配——单调性的构造性保证，
 * 调用方无法传错；与 record 侧 RecordJournalEventInput 同构）。DistributiveOmit
 * 使联合逐成员 Omit（保持判别键窄化能力）。
 *
 * 状态机消费面（TransitionTrigger 的事件族）即本形态——seq 是 journal 存储层的
 * 信封字段，不参与转移裁决；scan 产物（WorkflowRunEvent，含 seq）经结构化子类型
 * 天然兼容本形态（多余属性在非字面量赋值下合法）。
 */
export type WorkflowRunEventInput = DistributiveOmit<WorkflowRunEvent, "seq">;

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

// ── journal 接口形态（仅类型签名——实装归 journal 单元）──────

/**
 * run 事件 journal 的接口形态（append / scan）。
 *
 * 单写者约束（D5）：append 的唯一合法调用方 = worker-message-pump
 * （dispatchRunTrigger 唯一投递入口 + appendTransition 单写点——journal 单写者
 * 纪律的物理载体）——引擎侧事件经既有 run 事件通道上报后由写者落账，
 * 引擎不直接写 journal。类型层无法约束调用方，该约束由实装与守卫共同保证。
 */
export interface RunEventJournal {
  /**
   * 追加一条事件（JSONL 单行），返回落盘的完整事件（含分配的 seq）——调用方据
   * 此同步构造 v2 终态条目 / 物化投影（同一事件的单点载荷源；与 record 侧
   * RecordEventJournal.append 契约同构）。入参是无 seq 的 input 形态（seq 分配权
   * 在 journal 实装内，构造性单调）；runId 显式传参而非从事件取——仅 run-created
   * 携带 runId，目标文件定位不依赖事件形态。
   *
   * 单写者约束（W1 起扩容，D4）：合法调用方 = worker-message-pump 的
   * dispatchRunTrigger（活体链）+ run-registry 的收编入口（恢复链幂等追加终态
   * 事件）——「收编入口幂等追加 run-settled」是设计 D4 对 append 面的显式扩容，
   * 除此之外引擎/读侧一律不写。
   */
  append(runId: string, event: WorkflowRunEventInput): Promise<WorkflowRunEvent>;
  /**
   * 顺序扫描某 run 的全部事件（写入序）。消费方：快照投影（startedAt /
   * lastProgressAt 派生）、注册表投影（事件流停止 = 待恢复态判读）、恢复对账。
   * 终局后过保留期的清理（cap + TTL）不改变 scan 语义——清理后返回空流（该
   * run 的 journal 通道消失），消费方按本文件头部「终局证据读序」权威声明降级
   * 采信 state 快照 / manifest。
   */
  scan(runId: string): Promise<readonly WorkflowRunEvent[]>;
}

// ── 状态词表（D5-1 两维正交：lifecycle × outcome）──────────────

/**
 * lifecycle 维全集（五态，[W2 D2] 死形态清退后）。
 *
 * 语义链：created（创建校验通过、run-created 未落账）→ dispatched（脚本已派发，
 * engine 预备段——armed 回执窗口）→ running（首个 ask 派发后）→ settling（全部
 * settled / 重试预算耗尽，终局判定中）→ terminal（吸收态）。与 outcome 维正交：
 * 只有 terminal 行产生 outcome，其余 lifecycle 的 outcome 恒缺省（由 transition
 * 构造性保证）。旧 interrupted 态（无进入事件）与 host-died/abandon-elapsed
 * 控制触发一并清退——「事件流停止的待恢复态」判读归注册表投影相
 * （RunRegistryPhase.interrupted，run-registry「fold 停在非 terminal」判读，
 * 非状态机状态）；被动终局语义由 outcome='interrupted' 承载（收编/abandon/idle
 * 回收经 settleRunAccounting 原语写入，D2/D3）。
 */
export const ALL_RUN_LIFECYCLES = [
  "created",
  "dispatched",
  "running",
  "settling",
  "terminal",
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
 * 控制事件类型全集（[W2 D2] 死形态清退后 1 个）。
 *
 * 为什么独立于 RUN_EVENT_TYPES：控制事件源于用户/宿主/投影判定，不是编排层
 * 事件流的一帧——驱动转移但不直接落 journal。类型层经 TransitionTrigger 并集
 * 区分两个词表；journal.append 的参数类型（WorkflowRunEventInput）构造性排除控制
 * 事件，控制终局路径需要落账时由调用侧合成 run-settled（见输出动作注释）。
 * watchdog-fired 已随 settled-watchdog 本体删除（pi-workflow-run-resource-model
 * 决策 6-D9）；host-died / abandon-elapsed 随 [W2 D2] 死形态清退删除（均无生产
 * 投递点：事件流停止的待恢复判读归注册表投影相，被动终局化走 adoptInterruptedRun
 * → settleRunAccounting 原语，不经状态机控制触发）。
 */
export const CONTROL_TRIGGER_TYPES = [
  "cancel-requested",
] as const;

export type ControlTriggerType = (typeof CONTROL_TRIGGER_TYPES)[number];

/**
 * 控制事件判别联合。载荷只带自由文本 reason（诊断用），不带 ts——ts 信封由
 * 调用侧在合成落账事件 / 终局通知时补（transition 纯函数契约，见函数注释）。
 */
export type ControlTrigger = { type: "cancel-requested"; reason?: string };

/** 转移触发全集 = journal 词表事件（input 形态——seq 是存储信封，不参与裁决）+ 控制事件。 */
export type TransitionTrigger = WorkflowRunEventInput | ControlTrigger;

// ── 输出动作词表（转移的声明性输出，P1b 接线消费）──────────────

/**
 * 输出动作标签全集（3 个）。
 *
 * 状态机核心不执行动作——transition 只裁决「哪些动作应该发生」，执行归调用侧
 * （P1b 接线：workflow-dispatch / settle 编排点）。标签语义：
 * - journal-append：事件落 journal。触发事件属 journal 词表时 = 事件本身；
 *   控制事件触发的终局转移 = 调用侧合成的 run-settled 事件（cancel →
 *   outcome:cancelled；ts 信封由调用侧补）
 * - manifest-write：终局投影——manifest/.state 写 outcome/errorCode（D5-4）
 * - notify：终局通知触发（D7；pending:unregister 随通知闭环）
 *
 * kill-run-topology 已随 D9-2 定点杀链删除（pi-workflow-run-resource-model
 * 决策 6-D1：cancel 收敛窗满 / armed 超时兜底改走「合成终态 + finalizeRun 收尾
 * dispose」，镜像过滤杀链整体被 dispose 替代）。
 */
export const TRANSITION_OUTPUT_TYPES = [
  "journal-append",
  "manifest-write",
  "notify",
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
   * next === "terminal" 时的终局形态来源：固定值（cancel → cancelled）或缺省 =
   * 从 run-settled 事件载荷取（event.outcome）。
   * 非 terminal 行恒缺省。abandon 路径的 errorCode（interrupted_abandoned）
   * 是 manifest 写入内容而非状态——由收编原语消费方附着，不进 RunState
   * （词表边界见 RunErrorCode 注释）。
   */
  terminalOutcome?: RunOutcome;
  /** 该转移应发生的输出动作（声明性标签，执行归调用侧）。 */
  outputs: readonly TransitionOutput[];
}

/**
 * 合法转移表（[W2 D2] 死形态清退后 17 行；沿革：U4 起 27 行 → D9 后 24 行
 * ——watchdog-fired 三声明行随 settled-watchdog 本体删除——→ W2 缩 17 行：
 * host-died 四行、interrupted 两行、ask-executing 一行随死形态删除）。
 *
 * D5 示意表 8 行的落地 + 补全的必要转移：armed 在 dispatched/running 的自环
 * （D3 回执窗口横跨 engine 预备段与执行段）、后续 ask-dispatched/ask-retrying
 * 的 running 自环（parallel/pipeline 多波）、run-settled 自 running/dispatched
 * 的终局行（cancel 路径合成 run-settled 与零 ask 脚本的 journal fold 重放需要
 * ——fold 只见 journal 事件，控制事件不在流中）、dispatched × cancel-requested
 * （脚本预备段可取消）、[U4] member-pool 在 dispatched/running/settling 的自环
 * （复用池登记/清空不迁移 run lifecycle：register 只发生在 running——ask 派发
 * 链内先有 ask-dispatched 行；clear 在 run 收尾，零 ask run 落 dispatched；
 * settling 行服务 fold 重放兼容）。
 */
export const RUN_TRANSITIONS: readonly TransitionRule[] = [
  // ── created：创建落账前 ──
  { from: "created", on: "run-created", next: "dispatched", outputs: ["journal-append"] },

  // ── dispatched：engine 预备段（armed 窗口；零 ask 脚本可直达终局）──
  { from: "dispatched", on: "armed", next: "dispatched", outputs: ["journal-append"] },
  { from: "dispatched", on: "ask-dispatched", next: "running", outputs: ["journal-append"] },
  { from: "dispatched", on: "run-settled", next: "terminal", outputs: ["journal-append", "manifest-write", "notify"] },
  { from: "dispatched", on: "cancel-requested", next: "terminal", terminalOutcome: "cancelled", outputs: ["journal-append", "manifest-write", "notify"] },

  // ── running：ask 执行段（多波自环 + ask-settled 二支）──
  { from: "running", on: "armed", next: "running", outputs: ["journal-append"] },
  { from: "running", on: "ask-dispatched", next: "running", outputs: ["journal-append"] },
  { from: "running", on: "ask-retrying", next: "running", outputs: ["journal-append"] },
  { from: "running", on: "ask-settled", guard: "more-work-expected", next: "running", outputs: ["journal-append"] },
  { from: "running", on: "ask-settled", guard: "adjudicate-now", next: "settling", outputs: ["journal-append"] },
  // [U4 pi-workflow-run-resource-model] member-pool 自环（复用池登记/清空不迁移
  // run lifecycle——池是 run 域的附属投影，非 lifecycle 状态）。created/terminal
  // 无行：member-pool 先于 run-created 落账或晚于终局帧均为接线错误，
  // 表外 fail-fast 即该纪律的守卫（生产写入方：workflow-dispatch 登记与
  // finalizeRun 清空，两处都在 created→dispatched 之后、terminal 之前）。
  { from: "dispatched", on: "member-pool", next: "dispatched", outputs: ["journal-append"] },
  { from: "running", on: "member-pool", next: "running", outputs: ["journal-append"] },
  { from: "settling", on: "member-pool", next: "settling", outputs: ["journal-append"] },
  { from: "running", on: "run-settled", next: "terminal", outputs: ["journal-append", "manifest-write", "notify"] },
  { from: "running", on: "cancel-requested", next: "terminal", terminalOutcome: "cancelled", outputs: ["journal-append", "manifest-write", "notify"] },

  // ── settling：终局判定中（只等 run-settled / cancel）──
  { from: "settling", on: "run-settled", next: "terminal", outputs: ["journal-append", "manifest-write", "notify"] },
  { from: "settling", on: "cancel-requested", next: "terminal", terminalOutcome: "cancelled", outputs: ["journal-append", "manifest-write", "notify"] },

  // ── terminal：吸收态，无表行（任意事件 fail-fast，D5 表末行）──
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

// ── journal fold 循环（投影侧共享单源）──────────────────────

/**
 * 单个 ask（步骤）的 fold 投影行：骨架行 + 终局。
 *
 * [W2 D7] 自 runtime journal-projection.ts 上收（原 RunAskStepFold）——run 域
 * fold 单源后，runtime 投影消费 core fold 的骨架输出，不再自建第二套 fold。
 */
export interface RunAskStepFold {
  taskIndex: number;
  agentName: string;
  /** 剧本 phase 归属（ask-dispatched 携带；旧 journal 行缺省 undefined——不造键）。 */
  phase?: string;
  /** 首个 dispatched ts（步骤起点）。 */
  startedAt: number;
  /** 最近一次该 ask 事件 ts（进度边沿）。 */
  lastProgressAt: number;
  /** 终局（ask-settled；未终态 undefined）。 */
  settled?: { outcome: RunOutcome; durationMs?: number; errorCode?: RunErrorCode; ts: number };
}

/**
 * 单个 run journal 的投影骨架（fold 产物的投影半边：run 首帧 + ask 步骤行 +
 * run 终局）。
 *
 * [W2 D7] 自 runtime journal-projection.ts 上收（原 RunJournalFold）：runtime
 * 投影（projectV2Workflow）读本骨架合成 WorkflowRunRecord，与状态机半边
 * （state/lastSeq）同源于一次 fold 循环。
 */
export interface RunJournalFold {
  /** run-created 帧（journal 首帧；undefined = 首帧未达）。 */
  created: { runId: string; workflowName: string; ts: number } | undefined;
  /** ask 投影（taskIndex → 步骤行）。 */
  asks: Map<number, RunAskStepFold>;
  /** run-settled 终局（未终态 undefined；terminal 吸收性保证先到帧为准）。 */
  runSettled: { outcome: RunOutcome; errorCode?: RunErrorCode; reason?: string; ts: number } | undefined;
}

/**
 * fold 检查点：状态机终帧 + seq 水位 + 投影骨架（RunJournalFold）。
 *
 * lastSeq = 已接受事件的最高 seq（增量续读 / tail 截断重建后全量重读的去重依据
 * ——W2 通知去重键与 fold 幂等共用的行身份载体，D6「重复行的去重归域 fold」的
 * run 域落点）。全量 fold 与增量 fold（以既有 checkpoint 传入）共用本入口；旧
 * 格式行（无 seq，W1 前）不推进水位（见 foldRunEventFrames 注释）。
 *
 * 骨架半边的消费方 = runtime journal 投影（[W2 D7] fold 单源：runtime 的
 * SessionJournalProjection 以本 checkpoint 为 per-run tailer 状态，投影读
 * created/asks/runSettled 合成 WorkflowRunRecord——「只要终帧状态」的 core 内
 * 消费面（file-run-store 清理资格 / 注册表投影 / pump 活体 fold）经
 * foldRunEventFrames 只取 state，骨架半边零成本闲置。
 */
export interface RunEventFoldCheckpoint extends RunJournalFold {
  state: RunState;
  lastSeq: number;
}

/** fold 起点（全量 fold 缺省初值；增量 fold 以既有 checkpoint 传入）。 */
export const INITIAL_RUN_EVENT_FOLD: RunEventFoldCheckpoint = {
  state: INITIAL_RUN_STATE,
  lastSeq: 0,
  created: undefined,
  asks: new Map(),
  runSettled: undefined,
};

/**
 * ask 骨架行推进（纯函数 copy-on-write：命中行克隆改写、写时整表克隆——initial
 * checkpoint 的 Map 不被变异，重放幂等与「以既有 checkpoint 为初值」的调用形态
 * 都不产生别名副作用）。非 ask 事件原表透传。
 *
 * 推进语义（runtime 自建 fold 时代的原语义，[W2 D7] 原样上收）：
 * - ask-dispatched：缺行建骨架行（phase 随帧落投影，无 phase 帧不造键）；有行
 *   只推进进度边沿（重派发不改 agentName/phase）；
 * - ask-retrying：仅推进进度边沿（缺行 no-op——重试帧不造行）；
 * - ask-settled：缺行建占位行（agentName '(unknown)'——ask-dispatched 缺席的残
 *   形态：状态机不校验 taskIndex 归属，跨 ask 错位的合法转移载荷仍可落账；兜底
 *   成行保投影不丢终局）；有行推进边沿 + 落终局（后到覆盖）。
 */
function applyAskFoldEvent(
  asks: Map<number, RunAskStepFold>,
  event: WorkflowRunEvent,
): Map<number, RunAskStepFold> {
  switch (event.type) {
    case "ask-dispatched": {
      const existing = asks.get(event.taskIndex);
      const next = new Map(asks);
      next.set(
        event.taskIndex,
        existing !== undefined
          ? { ...existing, lastProgressAt: Math.max(existing.lastProgressAt, event.ts) }
          : {
            taskIndex: event.taskIndex,
            agentName: event.agentName,
            // 剧本归属随帧落投影（W1 D6）；无 phase 帧不造键（旧 journal 行兼容）
            ...(event.phase !== undefined ? { phase: event.phase } : {}),
            startedAt: event.ts,
            lastProgressAt: event.ts,
          },
      );
      return next;
    }
    case "ask-retrying": {
      const existing = asks.get(event.taskIndex);
      if (existing === undefined) return asks;
      const next = new Map(asks);
      next.set(event.taskIndex, {
        ...existing,
        lastProgressAt: Math.max(existing.lastProgressAt, event.ts),
      });
      return next;
    }
    case "ask-settled": {
      const existing = asks.get(event.taskIndex);
      const settled = { outcome: event.outcome, durationMs: event.durationMs, errorCode: event.errorCode, ts: event.ts };
      const next = new Map(asks);
      next.set(
        event.taskIndex,
        existing !== undefined
          ? {
            ...existing,
            lastProgressAt: Math.max(existing.lastProgressAt, event.ts),
            settled,
          }
          : {
            taskIndex: event.taskIndex,
            // ask-settled 先于 dispatched 的残形态：骨架行缺 agentName，用占位名
            // 成行（状态位仍可投影；record overlay 会覆盖该行）
            agentName: "(unknown)",
            startedAt: event.ts,
            lastProgressAt: event.ts,
            settled,
          },
      );
      return next;
    }
    default:
      return asks;
  }
}

/**
 * fold 检查点入口（事件流 + 既有检查点 → 新检查点）：全量 fold 与增量 fold
 * （tail 续读 / 截断重建后全量重读，以既有 checkpoint 传入）共用本函数——
 * tail 消费方（壳 stall watchdog / runtime 投影）的增量接续面。
 *
 * 产出 = 状态半边（state/lastSeq）+ 投影骨架半边（created/asks/runSettled，
 * [W2 D7] fold 单源：runtime journal 投影消费骨架，不再自建第二套 fold）。骨架
 * 写入点在状态机转移裁决之后——坏帧行整体不写，骨架与状态同停在最近一致态。
 * 纯函数：初值 checkpoint（含 asks Map）不被变异（applyAskFoldEvent 写时克隆）。
 *
 * seq 守卫（幂等语义，与 record 侧 foldRecordJournalEvents 同构）：
 * - seq ≤ 既有水位的事件行按重放跳过——tail 截断/重建后的幂等全量重读（D6
 *   原语）靠它构造性去重，重读不产生重复应用；
 * - seq 跳号（gap）宽容放行——单写者 append-only 下 gap 仅在外部编辑时出现；
 * - [W1 存量兼容读，D7] W1 前的行无 seq 字段：不跳过、不推进水位（重放去重
 *   只对携带 seq 的新格式行生效；旧文件混新 append 时「带 seq 的行」仍严格
 *   递增，去重键语义不受污染）。
 *
 * 坏帧（历史帧与当前转移表不兼容）经 onBrokenFrame 出声后保守停在最近一致态，
 * 不炸投影——与 scan 侧坏行容忍同一精神。warn 文案与 logger 归消费方注入。
 */
export function foldRunEventCheckpoint(
  events: readonly WorkflowRunEvent[],
  onBrokenFrame: (err: unknown, lastType: string) => void,
  initial?: RunEventFoldCheckpoint,
): RunEventFoldCheckpoint {
  let checkpoint = initial ?? INITIAL_RUN_EVENT_FOLD;
  for (const event of events) {
    // 存量行的 seq 运行时缺失（类型必填是写入契约；读取面对缺失放行，见
    // isWorkflowRunEventLine 注释）——typeof 收窄后统一处理两格式。
    const seq = event.seq;
    if (typeof seq === "number" && seq <= checkpoint.lastSeq) {
      continue;
    }
    try {
      const { state } = transition(checkpoint.state, event);
      checkpoint = {
        state,
        lastSeq: typeof seq === "number" ? seq : checkpoint.lastSeq,
        // 骨架半边（[W2 D7]）：状态机转移合法才推进——坏帧行整体不写，骨架与
        // 状态同停在最近一致态。
        created:
          event.type === "run-created"
            ? { runId: event.runId, workflowName: event.workflowName, ts: event.ts }
            : checkpoint.created,
        asks: applyAskFoldEvent(checkpoint.asks, event),
        runSettled:
          event.type === "run-settled"
            ? { outcome: event.outcome, errorCode: event.errorCode, reason: event.reason, ts: event.ts }
            : checkpoint.runSettled,
      };
    } catch (err) {
      onBrokenFrame(err, event.type);
      break;
    }
  }
  return checkpoint;
}

/**
 * journal fold 循环（事件流 → 终帧状态，投影侧共享单源）：逐事件 transition
 * （不传 ctx——fold 契约），坏帧保守停在最近一致态。内部委托
 * foldRunEventCheckpoint（seq 守卫单点），只投影 state——「只要终帧状态」的
 * 消费面（file-run-store 清理资格 / 注册表投影 / pump 活体 fold）。
 *
 * 增量接续（需要水位的 tail 消费方）走 foldRunEventCheckpoint。
 */
export function foldRunEventFrames(
  events: readonly WorkflowRunEvent[],
  onBrokenFrame: (err: unknown, lastType: string) => void,
): RunState {
  return foldRunEventCheckpoint(events, onBrokenFrame).state;
}

// ── journal 实装（createRunEventJournal——本模块唯一 IO 边）────

const journalLogger = getLogger("run-event-journal");

/**
 * run 事件 journal 文件名尾段（`<runId>.events.jsonl` 的 `.events.jsonl`）。
 *
 * 单源导出（barrel 上收）：core 内部全部落/扫点（本文件 journalPath、
 * file-run-store / run-registry 的成对裁剪与扫描）+ 壳侧镜像消费点
 * （stall watchdog 的 journal 路径构造、终局通知的 eventsJournalPath、
 * jsonl-run-store 的 watcher 边沿判定）统一 import 本常量——后缀字面量散布
 * 多处时任何一侧单独改动都是静默漂移（watcher 失配 / 指针失效）。
 */
export const RUN_EVENT_JOURNAL_SUFFIX = ".events.jsonl";

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

/**
 * 坏行判定的最小形状校验：JSON 对象 + type 落在词表内 + ts 有限数值（EventEnvelope
 * 信封全词表必填——fold 投影的 startedAt/lastProgressAt 派生与注册表新鲜度判据都
 * 消费它，坏值防污染投影）+ outcome（ask-settled / run-settled 携带）落词表
 * （其余事件不携带，缺省自然放行）。任一不过 = 坏行。
 *
 * [W1 seq 契约] 携带 seq 的行按正整数校验（新写行信封必填）；seq 缺失放行——
 * W1 前的存量 journal 行无该字段（D7 惰性兼容读，旧 run 的 journal 直接进读源，
 * 行为完全不变）。运行时缺失与类型必填的张力由 foldRunEventFrames 的 typeof
 * 收窄承接（读取面单点声明）。
 */
function isWorkflowRunEventLine(value: unknown): value is WorkflowRunEvent {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as { type?: unknown; ts?: unknown; seq?: unknown; outcome?: unknown };
  if (typeof rec.type !== "string" || !RUN_EVENT_TYPE_SET.has(rec.type)) return false;
  if (typeof rec.ts !== "number" || !Number.isFinite(rec.ts)) return false;
  if (
    rec.seq !== undefined &&
    (typeof rec.seq !== "number" || !Number.isSafeInteger(rec.seq) || rec.seq < 1)
  ) {
    return false;
  }
  if (
    rec.outcome !== undefined &&
    !(ALL_RUN_OUTCOMES as readonly string[]).includes(rec.outcome as string)
  ) {
    return false;
  }
  return true;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}

/** 读文件并宽容解析：坏行跳过计数 + 有效事件最大 seq 探测（scan 与 append 分配共用）。 */
function scanJournalFile(
  filePath: string,
): { events: WorkflowRunEvent[]; malformed: number; maxSeq: number } {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return { events: [], malformed: 0, maxSeq: 0 };
    throw error;
  }
  const events: WorkflowRunEvent[] = [];
  let malformed = 0;
  let maxSeq = 0;
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
      const event = parsed as WorkflowRunEvent;
      events.push(event);
      // 存量行 seq 运行时缺失（兼容读）——typeof 守卫下不参与水位探测
      if (typeof event.seq === "number" && event.seq > maxSeq) maxSeq = event.seq;
    } else {
      // 词表外 type（含合法 JSON 但漂移的形态）同样按坏行跳过——scan 的失效
      // 模式是保守可诊断（跳过 + 计数 + warn），不是炸掉整个投影
      malformed += 1;
    }
  }
  return { events, malformed, maxSeq };
}

class FileRunEventJournal implements RunEventJournal {
  private dirEnsured = false;
  /** runId → 已知末 seq（append 分配基数；跨实例正确性靠首 append 探测文件尾，不靠缓存）。 */
  private readonly lastSeqByRunId = new Map<string, number>();

  constructor(private readonly dir: string) {}

  /** journal 文件名：<runId>.events.jsonl（runId 自带 wf- 前缀，渲染名即设计的 wf-<id>.events.jsonl；后缀经 RUN_EVENT_JOURNAL_SUFFIX 单源）。 */
  private journalPath(runId: string): string {
    return join(this.dir, `${runId}${RUN_EVENT_JOURNAL_SUFFIX}`);
  }

  async append(runId: string, event: WorkflowRunEventInput): Promise<WorkflowRunEvent> {
    assertValidRunId(runId);
    if (!this.dirEnsured) {
      // 惰性一次：目录缺失自建（recursive 幂等），scan 侧不建目录（只读）
      mkdirSync(this.dir, { recursive: true });
      this.dirEnsured = true;
    }
    // seq 分配：末水位 + 1。水位未缓存时探测文件（存在则取有效事件最大 seq）
    // ——同步 readFileSync 与 append 同一取舍（取证证据，append 返回即达页缓存）；
    // 与 record 侧 FileRecordEventJournal 的分配纪律同构（W1 前存量行无 seq →
    // maxSeq=0，新行从 1 起号，「带 seq 的行」保持严格递增）。
    let lastSeq = this.lastSeqByRunId.get(runId);
    if (lastSeq === undefined) {
      lastSeq = scanJournalFile(this.journalPath(runId)).maxSeq;
    }
    const seq = lastSeq + 1;
    const full = { ...event, seq } as WorkflowRunEvent;
    // 为什么同步 append：journal 是取证证据——事件流停止的待恢复判读（run-registry
    // 投影相）依赖「最后一帧是什么」，批写缓冲随进程死亡丢失的恰好是「死前在做什么」
    // 的尾部帧；每 run 事件
    // 数实测 2-20 条（W1 检查点③，2026-09-26，29 个真实 run journal——设计包
    // w1-run-record-journal-authority/checkpoint-3-retention-sizing.md，原 D5 量级
    // 推演 200-400/run 已被实测推翻），同步追加的微秒级成本不构成吞吐压力，
    // 换取「append 返回即达页缓存」的零丢失窗口。接口保持 Promise 形态
    // （RunEventJournal 契约），实装内同步完成——调用方无需感知。
    appendFileSync(this.journalPath(runId), `${JSON.stringify(full)}\n`, "utf8");
    this.lastSeqByRunId.set(runId, seq);
    return full;
  }

  async scan(runId: string): Promise<readonly WorkflowRunEvent[]> {
    assertValidRunId(runId);
    const { events, malformed } = scanJournalFile(this.journalPath(runId));
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
