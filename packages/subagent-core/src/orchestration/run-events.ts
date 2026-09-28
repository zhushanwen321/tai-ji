// src/orchestration/run-events.ts
//
// Workflow run 事件词表与 journal 接口类型层（设计 workflow-architecture-redesign §3.3 D5）。
//
// 为什么需要它：纯快照投影只有终态一帧，「怎么死的」无从回答——重试轨迹
// （第一波 21 秒全灭、重试波写完报告）完全不可见，重试能掩盖事故。本模块定义
// run 级事件的词表（判别联合）与 journal 接口形态，为事件 journal（append/scan
// 实装、快照投影、注册表投影）提供类型地基。
//
// 范围边界：词表/类型层 + 状态机（合法转移表数据 + transition 纯函数）+
// journal 实装（createRunEventJournal：JSONL 落 <dir>/<runId>.record.jsonl
// ——[D1] record 单源事件流，runId 即 generateRunId 的 wf- 前缀产物；
// 与 run 既有 store 同目录与否由调用方传 dir 决定）。
// 清理规则（cap + TTL，仅已终局 run）归 Q2 注册表单元，此处不写。
//
// 词表边界（D5）：事件族裁剪自 zcode dwf_event、按 taiji 域命名。taiji workflow
// 脚本 API 面只有 agent/parallel/pipeline/phase/log（worker-script-builder 注入的
// 完整集合），无脚本内子进程调用通道，故不设脚本子进程事件（zcode world-run 族
// 无对应物）。[U4 pi-workflow-run-resource-model] 曾 additive 扩容 member-pool（成员
// 复用池登记/清空，决策 9）——[D6 绑定消解] 随独立池实体取消而删除（绑定改承载于
// agent-started 载荷字段）。[W2 D2] 死形态清退：ask-executing 事件（无生产写入
// 方）删除。[D4 事件词对齐 pi]（workflow-run-resume-revision）：ask-* 自造前缀改为
// agent-started/agent-retrying/agent-settled（pi 原生 agent_start…agent_settled 同构），
// 并新增 phase-started/phase-settled（D3 phase 状态机转移事件）与
// run-interrupted/run-resumed（D2 interrupted 暂停态的转移事件）——词表 9 个。
//
// 层归属：Engine。状态机核心（词表 + 转移表 + transition）零 IO / 零时钟依赖，
// 可独立编译测试；journal 实装是本模块唯一 IO 边（node:fs + core logger facade）。

// ── 终局证据读序（权威声明）──────────────────────────────────
//
// 「这个 run 终局了吗、怎么死的」的判法在 [D1] record 单源收敛后只有一条：
// record 事件流 fold（本文件词表 + 转移表），fold 终帧 terminal 即终局，无第二
// 判据可分叉。manifest（<runId>.json）降格为 run-settled 终局事件的派生缓存/
// 索引（转移表 manifest-write 输出动作同批写出，可随时从 record 重建，损坏即
// 重建，不构成第二份事实）——仅两个用途：retention / 对账清理的加速判定
// （findSettlementEvidenceSync 通道）与终局诊断的独立可寻址落点。record 流被
// 保留期裁剪后，manifest 是终局事实的最后落点。
//
// interrupted 不是终局（[D2] interrupted 入 lifecycle 为暂停态）：run-interrupted
// 转移事件只表达「执行中断、无活体」，fold 停在 interrupted 的 run 可经
// run-resumed 复活（resume 编排，U2）；prune / 对账清理对 interrupted 态天然
// 不获资格（fold 不达 terminal——宁保留不误裁）。

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
import type { AgentFailureKind, AgentResult, DoneReason } from "./models/types.ts";
import type { WorkflowRun } from "./models/workflow-run.ts";

// ── 终态双维度（D5-1 → [D2] 四态重构）────────────────────────

/**
 * run 终局形态词表（四值，[D2] 词表变更登记后的形态——workflow-run-resume-revision）。
 *
 * 与 DoneReason（completed/failed/aborted/budget_limited/time_limited，五因单
 * 维度）的关系：outcome 是终态正交化后的「run 自身怎么死的」维度（harness 系统
 * 层）——脚本判定失败（review-failure）= outcome:done + 脚本返回失败结论（业务
 * 层），两者处置路径不同（前者人工聚合报告，后者修环境重跑），必须分维度表达。
 * aborted 在本词表命名为 cancelled（对齐 D5 词表；DoneReason 存量词表不动，映射
 * 归 journal 写入方实现）。
 *
 * [D2] 词表变更登记（现行四值与重构前四值的差异，逐条显式登记）：
 * 1. **completed → done 改名**：与 shared `WorkflowRunStatus` 终局值 'done' 统一
 *    字面量——status 域与 outcome 域的成功/终局值同词，投影链无需两套叫法；
 * 2. **interrupted 移出 outcome（入 lifecycle 暂停态）**：「终局了却又没死透」的
 *    概念矛盾消除——中断 = run-interrupted 转移事件（running/settling →
 *    interrupted），可经 run-resumed 复活，非终局；
 * 3. **time_limited 从 RunErrorCode 成员升格为 outcome 值**：超时终局从
 *    「failed 终局 + errorCode=time_limited 细分」升为独立 outcome；RunErrorCode
 *    词表中 time_limited 成员保留为历史帧解析（解析词表纪律），新写入方不再
 *    产出该 errorCode；
 * 4. **call 级（agent-settled 载荷）随共用类型重构随改不拆分**：本类型为
 *    run-settled 与 agent-settled 共用——call 级实际值域 = done/failed/cancelled
 *    三值（time_limited 为 run 级终局、interrupted 已移出 outcome——均不出现在
 *    call 帧，沿用「ask 级实装取值 = result.failureKind 映射」的值域边界纪律）。
 *
 * 值域跟随锚：shared `WorkflowRunOutcome`（投影派生输出口径的第三份字面量，
 * core↔shared 依赖方向不允许物理单源）经 runtime 侧双包值级等价断言钉住
 * （core ALL_RUN_OUTCOMES ≡ extractor 集合 ≡ shared 词表成员，runtime 单测）。
 */
export const ALL_RUN_OUTCOMES = [
  "done",
  "failed",
  "cancelled",
  "time_limited",
] as const;

/** run 终局形态（run-settled 与 agent-settled 共用——agent 粒度的 cancelled = run 中止连带在途 agent 终止；call 级实际值域 = done/failed/cancelled 三值）。 */
export type RunOutcome = (typeof ALL_RUN_OUTCOMES)[number];

/**
 * 终局/中断错误码：「怎么死的」（终局）与「为什么此刻被中断」（中断）的结构化编码。
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
 * 可诊断，不是拒记）。
 *
 * budget_limited 是 run 级终局码（dispatchFinalRunSettle 生产：DoneReason 同名
 * 字面量恒等映射）——不描述引擎/agent 怎么失败，描述「为什么此刻被判终局」
 * （harness 系统层裁决）。不复用既有族的依据：engine_ 前缀有「引擎自报」契约
 * （SDK error-codes.ts 透传面，预算耗尽是宿主侧裁决非引擎上报，借用即伪造自
 * 报）；AgentFailureKind 是 agent 级失败分诊三态（预算耗尽不是 agent 失败形态）。
 *
 * [D2] time_limited 保留为历史帧解析成员：升格为 RunOutcome 独立值后，新写入方
 * 不再产出该 errorCode（超时终局直写 outcome=time_limited、无码），存量帧携带
 * 该值的解析按词表成员纪律放行（解析词表而非「现存写入方」登记，删值破坏历史
 * 帧解析——同 idle-evicted 纪律）。
 *
 * [D2] run-interrupted 帧的细分语境成员（中断来源标记，非终局码——中断是转移
 * 事件非终局帧，errorCode 字段承载来源）：
 * - `crashed`：崩溃收编（recoverCrashedRuns 装配，D15 入口接线）——进程死亡后
 *   壳侧重启对遗留 running run 的中断转移；
 * - `terminated`：terminate 被动失联（session 切换/关闭；D11 对 resume 来源 run
 *   的分叉在 U2 接线，词表成员随本批先行登记——「新增成员先改设计载荷表再动
 *   词表」纪律，设计 §3.1 事件表 run-interrupted 行已登记两成员）；
 * - `startup-sweep`：runtime 启动扫描收编（现行成员复用——设计 §3.1 事件表
 *   明示「startup-sweep 为 RunErrorCode 现行成员复用」；u1b 波改经 D15 入口后
 *   成为 run-interrupted 帧的写入方）。
 *
 * interrupted_abandoned / idle-evicted 同族保留（解析词表纪律）：历史写入方
 * （abandon 7 天窗终局化 / 30 天内存回收机制）已随 [D9] 与 ADR-0081 退役归零，
 * append-only record 流的存量帧携带该值，删值破坏历史帧解析——成员保留，
 * 无新写入方。
 */
export type RunErrorCode =
  | EngineProtocolErrorCode
  | `engine_${string}`
  | AgentFailureKind
  | "budget_limited"
  | "time_limited"
  | "interrupted_abandoned"
  | "startup-sweep"
  | "idle-evicted"
  | "crashed"
  | "terminated";

// ── DoneReason → RunOutcome 映射表定稿（与下方 RunErrorCode 映射同族的姊妹单点）──

/**
 * DoneReason 五因 → RunOutcome 的单点映射（[W2 D5] 映射表定稿 + [D2] time_limited
 * 升格改写，dispatch 链语境）。
 *
 * 全表（五值逐行）：
 *
 * | DoneReason      | outcome      | errorCode 承载        | 语义依据 |
 * |-----------------|--------------|----------------------|---------|
 * | completed       | done         | —                    | 成功（[D2] completed→done 同词贯穿） |
 * | failed          | failed       | 因提取（extractFailedRunErrorCode） | 执行失败 |
 * | aborted         | cancelled    | —                    | 用户主动取消（cancel-requested 控制事件合成路径的终局 outcome 同值——转移表 cancelled 行与本映射构造性一致） |
 * | budget_limited  | failed       | 'budget_limited'     | 预算耗尽 = 任务没跑完，failed 是用户视角的诚实归因（维持 failed && errorCode 分级） |
 * | time_limited    | time_limited | —                    | [D2] 活体墙钟预算超时升格为独立 outcome（新写入方无码；错误处理分级改双路判定——outcome=time_limited 直判） |
 *
 * 被动收编语境注记：[D2] 后收编不再落 run-settled(outcome=interrupted)——中断 =
 * run-interrupted 转移事件（非终局帧），由收编写入方（D15 入口 interruptRun）直
 * 写，不经本函数派生。
 *
 * 消费方：core terminal-actions 的 dispatchFinalRunSettle（同构判别，aborted
 * 分支走 cancel-requested 合成不改用本函数——两条路径的 outcome 语义一致）。
 * 壳侧通知载荷的 outcome 字段不经本函数：帧直取（settlement.outcome，与
 * run-settled 帧同源）+ DoneReason 经 runSettledOutcomeToDoneReason 反向派生；
 * 漂移信号 = 通知 outcome ≡ record run-settled 帧 outcome。
 */
export function doneReasonToRunOutcome(reason: DoneReason): RunOutcome {
  switch (reason) {
    case "completed":
      return "done";
    case "aborted":
      return "cancelled";
    case "failed":
    case "budget_limited":
      return "failed";
    case "time_limited":
      return "time_limited";
  }
}

// ── DoneReason → RunErrorCode 映射（词表语义的同位归属：映射的每个分支都引用
// 上方词表收录依据；唯一消费方 = terminal-actions 的 dispatchFinalRunSettle，
// 与本文件上方 doneReasonToRunOutcome 同族——同一个 DoneReason 判别）──

/**
 * DoneReason → RunErrorCode 的单点映射。
 *
 * - completed/aborted：成功与取消（cancel-requested 控制事件合成路径）不带码
 *   （RunSettledEvent.errorCode 字段语义「失败时才有」）；
 * - budget_limited：run 级终局码恒等映射（同名字面量，上方注释载收录依据）；
 * - time_limited：[D2] 无码（超时终局已升格为 outcome 直判，RunErrorCode 的
 *   time_limited 成员保留为历史帧解析，新写入方不产出）；
 * - failed：按因提取。
 */
export function finalRunErrorCodeOf(run: WorkflowRun, doneReason: DoneReason): RunErrorCode | undefined {
  switch (doneReason) {
    case "completed":
    case "aborted":
    case "time_limited":
      return undefined;
    case "budget_limited":
      return "budget_limited";
    case "failed":
      return extractFailedRunErrorCode(run);
  }
}

/**
 * failed 族的因提取：扫描最后一个失败 call 的 result（终局因的时序近似——多 agent
 * run 下脚本可能吞掉早先失败后自身错误终局，与 stderrTeePath 诊断引用「最后一帧」
 * 的取值纪律同一取舍；单 agent 失败即主流终局场景精确）。
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

// ── 事件词表（D5-2 → [D4] 对齐 pi 后 9 个）───────────────────

/**
 * 事件类型全集（判别键）——增删成员须先改设计载荷表再动此词表（D5 纪律；
 * [D4]（workflow-run-resume-revision）词表对齐 pi：ask-* 自造前缀改 agent-*，
 * 新增 phase-started/phase-settled（D3 phase 状态机）与 run-interrupted/run-resumed
 * （D2 interrupted 暂停态转移）；[D5] armed 占位事件删除（协议版落地前无生产
 * 写入方）；[D6] member-pool 删除（绑定消解进 agent-started 载荷字段——词表减
 * 一成员，独立池实体取消）。旧词表历史行经 scan/parse 的词表外坏行路径跳过计
 * 日志，见 isWorkflowRunEventLine（[D1] 历史数据处置：旧词表行不进入任何解析
 * 路径，无兼容读）。
 */
export const RUN_EVENT_TYPES = [
  "run-created",
  "phase-started",
  "agent-started",
  "agent-retrying",
  "agent-settled",
  "phase-settled",
  "run-interrupted",
  "run-resumed",
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
   * run 唯一 id（record 流文件名同源：wf-<id>.record.jsonl）。全词表唯一携带
   * runId 的事件——record 流文件本身即 run 域，其余事件不重复携带。
   */
  runId: string;
  /** 脚本身份名（RunSpec.scriptName，meta.name 或文件名 stem）。 */
  workflowName: string;
  /** 调用参数摘要（截断的序列化形态——事件行要小，全文 args 不进 record）。 */
  argsSummary: string;
  /** run 级 model 引用（RunSpec.model；缺省 = 继承主 agent 模型）。 */
  model?: string;
  /**
   * 脚本源全文（RunSpec.scriptSource 原文，[D1] record 单源存储收敛——设计
   * workflow-run-resume-revision §3.1 载荷表）。record 流是唯一事实源后，脚本
   * 确定性重放（resume 的缓存回放）所需的 scriptSource 只能从本帧恢复——快照
   * 投影文件已删，无第二落点。可选 = 读取面对旧格式行放行（载荷缺失不拒绝），
   * 写侧契约由写入方承担（写入点 = worker-message-pump dispatchRunCreated）。
   */
  scriptSource?: string;
}

/**
 * agent 身份三元组（D5 载荷表 dispatched 行的载荷；[D4] 随事件词 agent-* 更名）。
 *
 * taskIndex 对齐 AgentCall.id（= trace stepIndex，D-10 单源）——同一 call 的
 * started/retrying/settled 全链共享同一 taskIndex。D5 载荷表仅在 dispatched
 * 行列出 taskIndex，但快照投影按 calls[].id 关联事件与条目，settled/retrying
 * 缺 taskIndex 则无法定位归属 call（agentName 不唯一、attempt 单独不足），故
 * 三个 agent 事件统一携带。
 */
interface AgentIdentity {
  taskIndex: number;
  /** agent 身份名（ExecutionTraceNode.agent 同源）。 */
  agentName: string;
  /** 尝试序号（1 起，与 AgentCall.attempts 同一计数链）。 */
  attempt: number;
}

/**
 * `agent-started`——脚本 agent() 调用已派发（[D4] 对齐 pi `agent_start` 语义）。
 */
export interface AgentStartedEvent extends AgentIdentity, EventEnvelope {
  type: "agent-started";
  /**
   * 剧本 phase 归属（`phase()` 包裹 / `opts.phase` 显式声明——派发时刻由 worker
   * 脚本按 `opts.phase || _currentPhase` 算出，随 agent-call 消息到达壳侧落账）。
   * [D3] 双通道关系：本字段 = call 归属快照（fold 推导 call 归属无需回溯最近
   * 转移事件），`phase-started` 独立事件 = phase 状态机转移记录——两通道语义
   * 不同，均保留，不是同一信息双写。
   * 可选 = 未标注剧本（无 phase 归属）——缺省即「无归属」，fold/投影侧保持
   * undefined 不造键。
   */
  phase?: string;
  /**
   * [D6 绑定消解] 本 call 绑定的子代理 record id（成员复用池「name→recordId」
   * 路由绑定的字段化承载——同名续写路由按绑定字段查，跨崩溃恢复从 record 折叠
   * 重建；独立 member-pool 词表成员随 [D6] 删除）。首派（新建成员）缺省；
   * 续写（复用既有成员）携带。可选 = 读取面对旧格式行与首派帧放行。
   */
  memberRecordId?: string;
}

/** `agent-retrying`——失败尝试后将退避重试（重试轨迹从脚本内部状态变为 record 事件，重试不再能掩盖事故）。 */
export interface AgentRetryingEvent extends EventEnvelope {
  type: "agent-retrying";
  /** call 关联键（见 AgentIdentity——投影按 calls[].id 关联）。 */
  taskIndex: number;
  /** 触发本次重试的失败尝试序号（1 起——刚失败的 attempt，退避后序号 +1 再执行）。 */
  attempt: number;
  /** 退避等待毫秒（指数退避，executeAgentCall 的 BACKOFF_* 常数同源）。 */
  backoffMs: number;
  /** 重试原因摘要（失败分类或错误文案摘要）。 */
  reason: string;
}

/** `agent-settled`——单次 call 终局（每次尝试各一帧，attempt 区分重试波；pi 原生同名采纳）。 */
export interface AgentSettledEvent extends EventEnvelope {
  type: "agent-settled";
  /** call 关联键（见 AgentIdentity——投影按 calls[].id 关联）。 */
  taskIndex: number;
  /** 终局尝试的序号（agent 粒度 attempt=1 即终局，无 agent 级重试波时恒 1）。 */
  attempt: number;
  /** call 终局形态（复用 RunOutcome；call 级实际值域 = done/failed/cancelled 三值——time_limited 为 run 级、interrupted 已移出 outcome，均不出现在本帧）。 */
  outcome: RunOutcome;
  /** 失败时的结构化编码（成功/取消缺省）。agent 级实装取值 = result.failureKind
   *  （AgentFailureKind 三值 + unknown 缺省，dispatchAgentSettled 映射）；engine_crashed
   *  等 run 级 RunErrorCode 值属 run-settled 帧，不出现在本帧。 */
  errorCode?: RunErrorCode;
  /** 终局尝试的墙钟耗时毫秒（对齐 AgentResult.durationMs 口径）。 */
  durationMs: number;
  /**
   * 诊断引用（D5-3）：失败时子进程 stderr tee 文件路径（W11 已有落盘）——
   * errorCode 与取证文件指针一起落账，排障不用翻全量日志。
   */
  stderrTeePath?: string;
  /**
   * 结果全文（AgentResult 完整序列化形态，[D1] record 单源存储收敛——设计
   * §3.1 载荷表）。record 流是唯一事实源后，resume 的已完成调用缓存回放（零
   * token）所需的 result 只能从本帧恢复——快照投影文件已删，无第二落点。
   * result.sessionFile 同时承载执行树家族链的 sessionFile 数据源（[D16 ③]
   * session-reader 发现链的提取面——无需载荷补字段）。
   *
   * 完整性纪律：record 流内携带本帧而 result 缺失是非法形态（= 流被外部篡改
   * 或写入器 bug）——壳侧 record store 的 loadAll 读原语对该形态拒绝（场景 18；
   * core record scan 维持宽容跳过——活体投影不因单帧全停，拒绝语义归恢复读面）。
   * 可选 = 类型层对读取面放行（拒绝判定在消费方按载荷完整性执行），写侧填充
   * 责任在写入方（worker-message-pump dispatchAgentSettled）。
   */
  result?: AgentResult;
}

/**
 * `phase-started`——phase 状态机转移事件（[D3]）：脚本 `phase(name)` 切换落本
 * 事件（worker 模板经 postMessage 通知壳侧落 record——转移事件入 record，重启
 * 折叠重建）。postMessage 异步通道固有竞态：worker 执行 `phase()` 后、消息送达
 * 壳侧前死亡，本转移事件不落盘——fold 自愈规则见 applyPhaseFoldEvent（按
 * agent-started 载荷的 phase 字段驱动 pending → running，转移事件缺失不判损坏、
 * 不进 D12 拒绝范围）。
 */
export interface PhaseStartedEvent extends EventEnvelope {
  type: "phase-started";
  /** phase 名（脚本 `phase(name)` 的实参字符串化）。 */
  phase: string;
}

/**
 * `phase-settled`——phase 内全部 call 落定的转移事件（[D3]）：壳侧在 agent-settled
 * 链内判定「该 phase 已派发的 call 全部落定」后落账。与展示分组（format.ts
 * phase group）同源——「续聊时算不算完成」的唯一答案：phase 看 call，agent 会话
 * 续聊是另一层。
 */
export interface PhaseSettledEvent extends EventEnvelope {
  type: "phase-settled";
  /** phase 名。 */
  phase: string;
}

/**
 * `run-interrupted`——running/settling → interrupted 的转移事件（[D2]）：崩溃收编
 * / terminate 被动失联（D11 resume 来源 run）经 [D15] 终局编排入口统一写入。
 * 中断不是终局——本事件后 run 停在 interrupted 暂停态，可经 run-resumed 复活。
 */
export interface RunInterruptedEvent extends EventEnvelope {
  type: "run-interrupted";
  /**
   * 中断来源标记（承载于 errorCode 字段——词表成员 crashed / terminated /
   * startup-sweep；历史成员 interrupted_abandoned / idle-evicted 按解析词表
   * 纪律保留不删值，无新写入方）。
   */
  errorCode?: RunErrorCode;
  /** 中断原因摘要（自由文本诊断面；可缺省）。 */
  reason?: string;
}

/**
 * `run-resumed`——interrupted → running 的复活转移事件（[D2]）：resume 编排
 * （U2，resume-run.ts 锁段内自完成——不经 [D15] 终局入口，复活非终局动作）。
 */
export interface RunResumedEvent extends EventEnvelope {
  type: "run-resumed";
  /** resume 锚点摘要（重放/三档恢复的入口语境，自由文本；可缺省）。 */
  reason?: string;
  /** 宿主标识（跨进程锁裁决的胜出方语境，自由文本；可缺省）。 */
  host?: string;
}

/** `run-settled`——run 终局（一个 run 恰好一帧；终局通知的单点判定源，防多处各判漏分支）。 */
export interface RunSettledEvent extends EventEnvelope {
  type: "run-settled";
  outcome: RunOutcome;
  /** 失败时的结构化编码（done/cancelled/time_limited 缺省——[D2] 后 failed 终局的 budget_limited 与因提取码承载）。 */
  errorCode?: RunErrorCode;
  /** 终局原因摘要（自由文本；干净完成可缺省）。 */
  reason?: string;
  /** 产物目录指针：run 持久化产物所在目录绝对路径（终局通知与排障的入口载荷）。 */
  artifactsDir: string;
}

/** run 事件判别联合（D5 词表全集，[D4] 对齐后 9 个；判别键 = type）。 */
export type WorkflowRunEvent =
  | RunCreatedEvent
  | PhaseStartedEvent
  | AgentStartedEvent
  | AgentRetryingEvent
  | AgentSettledEvent
  | PhaseSettledEvent
  | RunInterruptedEvent
  | RunResumedEvent
  | RunSettledEvent;

/**
 * 写侧入参形态：事件去掉 seq（seq 由 journal 单写者分配——单调性的构造性保证，
 * 调用方无法传错；与 record 侧 RecordJournalEventInput（execution/persistence/
 * record-events.ts）同构）。DistributiveOmit
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

// ── 状态词表（D5-1 → [D2] 四态 + interrupted 暂停态）──────────

/**
 * lifecycle 全集（[D2] 四态 + interrupted 暂停态——workflow-run-resume-revision）。
 *
 * 语义链：created（创建校验通过、run-created 未落 record）→ running（脚本已开跑
 * ——原 dispatched 并入：两态对取消/终局/停滞/恢复行为完全相同且无消费方，转移
 * 表实证两态的 cancel-requested 行逐字等价）→ settling（全部 call 落定 / 重试预算
 * 耗尽，终局判定中）→ terminal（吸收态，outcome 四值）。interrupted 为暂停态
 * （running/settling → interrupted：崩溃收编或 terminate 被动失联；interrupted →
 * running：resume 复活）——不是终局，「执行中断、无活体」的可续语义，无特殊
 * 转移行、无 guard（原为续跑设计的 terminal→dispatched 特殊转移行与 guard 收窄
 * 整体取消）。与 outcome 维正交：只有 terminal 行产生 outcome，其余 lifecycle 的
 * outcome 恒缺省（由 transition 构造性保证）。
 */
export const ALL_RUN_LIFECYCLES = [
  "created",
  "running",
  "settling",
  "interrupted",
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
 * 合法转移表（[D2] 四态 + interrupted 重写后 15 行；沿革：[W2 D2] 17 行 →
 * [D2]（workflow-run-resume-revision）重写：dispatched 并入 running（两态行为
 * 相同无消费方）、armed 三行随 [D5] 删、member-pool 三行随 [D6] 删、新增
 * run-interrupted 两行 + run-resumed 一行 + phase-started/phase-settled 三行
 * （[D3]）——原为续跑设计的 terminal→dispatched 特殊转移行与 guard 收窄整体
 * 取消（interrupted 是普通流转，无特例））。
 *
 * D5 示意表的落地 + 补全的必要转移：phase-started/phase-settled 的 running 自环
 * （phase 切换与 phase 收束不迁移 run lifecycle——phase 是 run 聚合内的子状态机，
 * [D3]）、后续 agent-started/agent-retrying 的 running 自环（parallel/pipeline
 * 多波）、run-settled 自 running 的终局行（cancel 路径合成 run-settled 与零 call
 * 脚本的 record fold 重放需要——fold 只见 record 事件，控制事件不在流中）、
 * run-interrupted 自 running/settling（[D2] 崩溃收编 / terminate 被动失联——
 * outputs 仅 journal-append：中断非终局，不写 manifest 派生缓存、不发终局通知）、
 * run-resumed 自 interrupted（[D2] 复活——outputs 仅 journal-append：复活非终局，
 * 通知语义归 resume 编排（U2））。
 */
export const RUN_TRANSITIONS: readonly TransitionRule[] = [
  // ── created：创建落账前 ──
  { from: "created", on: "run-created", next: "running", outputs: ["journal-append"] },

  // ── running：call 执行段（多波自环 + agent-settled 二支 + phase 子状态机自环）──
  { from: "running", on: "phase-started", next: "running", outputs: ["journal-append"] },
  { from: "running", on: "phase-settled", next: "running", outputs: ["journal-append"] },
  { from: "running", on: "agent-started", next: "running", outputs: ["journal-append"] },
  { from: "running", on: "agent-retrying", next: "running", outputs: ["journal-append"] },
  { from: "running", on: "agent-settled", guard: "more-work-expected", next: "running", outputs: ["journal-append"] },
  { from: "running", on: "agent-settled", guard: "adjudicate-now", next: "settling", outputs: ["journal-append"] },
  { from: "running", on: "run-interrupted", next: "interrupted", outputs: ["journal-append"] },
  { from: "running", on: "run-settled", next: "terminal", outputs: ["journal-append", "manifest-write", "notify"] },
  { from: "running", on: "cancel-requested", next: "terminal", terminalOutcome: "cancelled", outputs: ["journal-append", "manifest-write", "notify"] },

  // ── settling：终局判定中（等 run-settled / cancel；崩溃窗内可被中断）──
  { from: "settling", on: "phase-settled", next: "settling", outputs: ["journal-append"] },
  { from: "settling", on: "run-interrupted", next: "interrupted", outputs: ["journal-append"] },
  { from: "settling", on: "run-settled", next: "terminal", outputs: ["journal-append", "manifest-write", "notify"] },
  { from: "settling", on: "cancel-requested", next: "terminal", terminalOutcome: "cancelled", outputs: ["journal-append", "manifest-write", "notify"] },

  // ── interrupted：暂停态（[D2] 非终局——run-resumed 复活是唯一出边）──
  { from: "interrupted", on: "run-resumed", next: "running", outputs: ["journal-append"] },

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
 * 单个 agent call（步骤）的 fold 投影行：骨架行 + 终局。
 *
 * [W2 D7] 自 runtime journal-projection.ts 上收（原 RunAskStepFold）——run 域
 * fold 单源后，runtime 投影消费 core fold 的骨架输出，不再自建第二套 fold。
 * [D4] 随事件词 agent-* 更名（ask → agent）。
 */
export interface RunAskStepFold {
  taskIndex: number;
  agentName: string;
  /** 剧本 phase 归属（agent-started 携带；未标注剧本缺省 undefined——不造键）。 */
  phase?: string;
  /** 首个 started ts（步骤起点）。 */
  startedAt: number;
  /** 最近一次该 call 事件 ts（进度边沿）。 */
  lastProgressAt: number;
  /** 终局（agent-settled；未终态 undefined）。call 级 outcome 实际值域 = done/failed/cancelled。 */
  settled?: { outcome: RunOutcome; durationMs?: number; errorCode?: RunErrorCode; ts: number };
}

/** 单个 phase 的状态机投影行（[D3] pending → running → settled 的 fold 半边）。 */
export interface RunPhaseFold {
  /** phase 名。 */
  phase: string;
  /** 转移进入时刻（phase-started 帧 ts；自愈重建 = 首 agent-started ts）。 */
  startedAt: number;
  /** 收束时刻（phase-settled 帧 ts；未收束 undefined）。 */
  settledAt?: number;
}

/**
 * 单个 run record 流的投影骨架（fold 产物的投影半边：run 首帧 + call 步骤行 +
 * phase 状态机 + 中断/复活 + run 终局）。
 *
 * [W2 D7] 自 runtime journal-projection.ts 上收（原 RunJournalFold）：runtime
 * 投影（projectV2Workflow）读本骨架合成 WorkflowRunRecord，与状态机半边
 * （state/lastSeq）同源于一次 fold 循环。
 */
export interface RunJournalFold {
  /** run-created 帧（record 流首帧；undefined = 首帧未达）。 */
  created: { runId: string; workflowName: string; ts: number } | undefined;
  /** call 投影（taskIndex → 步骤行）。 */
  asks: Map<number, RunAskStepFold>;
  /** phase 状态机投影（[D3]，phase 名 → 状态行；phase-started 缺失时按 agent-started 载荷自愈重建）。 */
  phases: Map<string, RunPhaseFold>;
  /** 最近一次中断（run-interrupted 帧；未中断 undefined——[D2] 暂停态投影）。 */
  interrupted?: { errorCode?: RunErrorCode; reason?: string; ts: number };
  /** 最近一次复活（run-resumed 帧；未复活 undefined——[D2] resume 锚点投影，D10 预算算式的切段边界之一）。 */
  resumed?: { reason?: string; host?: string; ts: number };
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
 * created/asks/phases/runSettled 合成 WorkflowRunRecord——「只要终帧状态」的
 * core 内消费面（run-state-evidence 清理资格 / 注册表投影 / pump 活体 fold）经
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
  phases: new Map(),
  runSettled: undefined,
};

/**
 * call 骨架行与 phase 状态机的投影推进（纯函数 copy-on-write：命中行克隆改写、
 * 写时整表克隆——initial checkpoint 的 Map 不被变异，重放幂等与「以既有
 * checkpoint 为初值」的调用形态都不产生别名副作用）。非 agent/phase 事件原表透传。
 *
 * call 推进语义（runtime 自建 fold 时代的原语义，[W2 D7] 原样上收 + [D4] 改名）：
 * - agent-started：缺行建骨架行（phase 随帧落投影，无 phase 帧不造键）；有行
 *   只推进进度边沿（重派发不改 agentName/phase）；
 * - agent-retrying：仅推进进度边沿（缺行 no-op——重试帧不造行）；
 * - agent-settled：缺行建占位行（agentName '(unknown)'——agent-started 缺席的残
 *   形态：状态机不校验 taskIndex 归属，跨 call 错位的合法转移载荷仍可落账；兜底
 *   成行保投影不丢终局）；有行推进边沿 + 落终局（后到覆盖）。
 *
 * phase 状态机推进语义（[D3]）：
 * - phase-started：登记 phase 行（startedAt；已 settled 的同名 phase 后到 started
 *   = 新一轮同名义转移——覆盖 settledAt 回到 running 投影）；
 * - phase-settled：落 settledAt（缺 started 行 = 转移事件缺失窗口的迟到收束帧，
 *   按 agent-started 自愈面兜底成行）；
 * - agent-started 携带 phase 且 phase 行缺席（postMessage 异步丢失窗口——[D3]
 *   fold 自愈规则）：按 call 归属快照驱动 pending → running（自愈重建 phase 行，
 *   startedAt 取本帧 ts；转移事件缺失不判损坏、不进 D12 拒绝范围——该窗口是
 *   异步通道固有竞态而非写入器 bug）。phase 行已存在时不改写（startedAt 以
 *   phase-started 帧为准）。
 */
function applyAskFoldEvent(
  asks: Map<number, RunAskStepFold>,
  phases: Map<string, RunPhaseFold>,
  event: WorkflowRunEvent,
): { asks: Map<number, RunAskStepFold>; phases: Map<string, RunPhaseFold> } {
  switch (event.type) {
    case "agent-started": {
      const existing = asks.get(event.taskIndex);
      const nextAsks = new Map(asks);
      nextAsks.set(
        event.taskIndex,
        existing !== undefined
          ? { ...existing, lastProgressAt: Math.max(existing.lastProgressAt, event.ts) }
          : {
            taskIndex: event.taskIndex,
            agentName: event.agentName,
            // 剧本归属随帧落投影（W1 D6 / [D3] call 归属快照）；无 phase 帧不造键
            ...(event.phase !== undefined ? { phase: event.phase } : {}),
            startedAt: event.ts,
            lastProgressAt: event.ts,
          },
      );
      // [D3] fold 自愈：phase 行缺席时按 call 归属快照驱动 pending → running
      const nextPhases = phases;
      if (event.phase !== undefined && !nextPhases.has(event.phase)) {
        nextPhases.set(event.phase, { phase: event.phase, startedAt: event.ts });
      }
      return { asks: nextAsks, phases: nextPhases };
    }
    case "agent-retrying": {
      const existing = asks.get(event.taskIndex);
      if (existing === undefined) return { asks, phases };
      const nextAsks = new Map(asks);
      nextAsks.set(event.taskIndex, {
        ...existing,
        lastProgressAt: Math.max(existing.lastProgressAt, event.ts),
      });
      return { asks: nextAsks, phases };
    }
    case "agent-settled": {
      const existing = asks.get(event.taskIndex);
      const settled = { outcome: event.outcome, durationMs: event.durationMs, errorCode: event.errorCode, ts: event.ts };
      const nextAsks = new Map(asks);
      nextAsks.set(
        event.taskIndex,
        existing !== undefined
          ? {
            ...existing,
            lastProgressAt: Math.max(existing.lastProgressAt, event.ts),
            settled,
          }
          : {
            taskIndex: event.taskIndex,
            // agent-settled 先于 started 的残形态：骨架行缺 agentName，用占位名
            // 成行（状态位仍可投影）
            agentName: "(unknown)",
            startedAt: event.ts,
            lastProgressAt: event.ts,
            settled,
          },
      );
      return { asks: nextAsks, phases };
    }
    case "phase-started": {
      const nextPhases = new Map(phases);
      nextPhases.set(event.phase, { phase: event.phase, startedAt: event.ts });
      return { asks, phases: nextPhases };
    }
    case "phase-settled": {
      const existing = phases.get(event.phase);
      const nextPhases = new Map(phases);
      nextPhases.set(
        event.phase,
        existing !== undefined
          ? { ...existing, settledAt: event.ts }
          // 转移事件缺失窗口的迟到收束帧：兜底成行（startedAt 不可考——取收束 ts）
          : { phase: event.phase, startedAt: event.ts, settledAt: event.ts },
      );
      return { asks, phases: nextPhases };
    }
    default:
      return { asks, phases };
  }
}

/**
 * fold 检查点入口（事件流 + 既有检查点 → 新检查点）：全量 fold 与增量 fold
 * （tail 续读 / 截断重建后全量重读，以既有 checkpoint 传入）共用本函数——
 * tail 消费方（壳 stall watchdog / runtime 投影）的增量接续面。
 *
 * 产出 = 状态半边（state/lastSeq）+ 投影骨架半边（created/asks/phases/
 * interrupted/resumed/runSettled，[W2 D7] fold 单源：runtime journal 投影消费
 * 骨架，不再自建第二套 fold）。骨架写入点在状态机转移裁决之后——坏帧行整体
 * 不写，骨架与状态同停在最近一致态。纯函数：初值 checkpoint（含 asks/phases
 * Map）不被变异（applyAskFoldEvent 写时克隆）。
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
      const { asks, phases } = applyAskFoldEvent(checkpoint.asks, checkpoint.phases, event);
      checkpoint = {
        state,
        lastSeq: typeof seq === "number" ? seq : checkpoint.lastSeq,
        // 骨架半边（[W2 D7]）：状态机转移合法才推进——坏帧行整体不写，骨架与
        // 状态同停在最近一致态。
        created:
          event.type === "run-created"
            ? { runId: event.runId, workflowName: event.workflowName, ts: event.ts }
            : checkpoint.created,
        asks,
        phases,
        interrupted:
          event.type === "run-interrupted"
            ? { errorCode: event.errorCode, reason: event.reason, ts: event.ts }
            : checkpoint.interrupted,
        resumed:
          event.type === "run-resumed"
            ? { reason: event.reason, host: event.host, ts: event.ts }
            : checkpoint.resumed,
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
 * 消费面（run-state-evidence 清理资格 / 注册表投影 / pump 活体 fold）。
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
 * run record 事件流文件名尾段（`<runId>.record.jsonl` 的 `.record.jsonl`）。
 *
 * [D1] record 单源存储收敛改名（`.events.jsonl` → `.record.jsonl`）：record 流是
 * run 域唯一事实源（append-only），文件名换新后缀使旧格式两件套（旧 journal
 * `.events.jsonl` + state 快照 `<runId>.jsonl`）与新流在文件名层面天然可分——
 * 全部读取路径只认本后缀（旧两件不读、不写、不主动删，历史 run 从壳侧读取面
 * 消失即 D1 历史数据处置的预期行为）。
 *
 * 单源导出（barrel 上收）：core 内部全部落/扫点（本文件 journalPath、
 * run-state-evidence / run-registry 的成对裁剪与扫描）+ 壳侧镜像消费点
 * （终局通知的 eventsJournalPath、record store 的流路径构造）统一 import 本
 * 常量——后缀字面量散布多处时任何一侧单独改动都是静默漂移（watcher 失配 /
 * 指针失效）。
 *
 * 已知范围外同值副本：session-reader 包（跨包无 core 依赖边，物理单源结构性
 * 不可行——与 D5 core↔shared 同款约束）本地持有旧值常量，其发现链重锚随宿主
 * 读侧适配批（D16 ③）同批落地。
 */
export const RUN_EVENT_JOURNAL_SUFFIX = ".record.jsonl";

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

  /** record 流文件名：<runId>.record.jsonl（runId 自带 wf- 前缀；后缀经 RUN_EVENT_JOURNAL_SUFFIX 单源）。 */
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
