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
// （findRunSettlementEvidence 通道）与终局诊断的独立可寻址落点。
//
// record 流的磁盘清理归裁决点 7 对账清理（无主 run 五件全删）——pi 壳域 run 域
// 保留期不裁 record 流（prune 候选锚定 state 快照族，run-state-evidence [D1 后
// 射程] 段），故「record 流被保留期裁剪、manifest 成终局事实最后落点」的形态在
// 现行写入面无正常产生通道；findRunSettlementEvidence 的 manifest 兜底分支保留
// 为残局防御（外部删除 / 清理部分失败），非设计内读序。
//
// interrupted 不是终局（[D2] interrupted 入 lifecycle 为暂停态）：run-interrupted
// 转移事件只表达「执行中断、无活体」，fold 停在 interrupted 的 run 可经
// run-resumed 复活（resume 编排，U2）；prune / 对账清理对 interrupted 态天然
// 不获资格（fold 不达 terminal——宁保留不误裁）。

// 引擎协议码运行时 guard（SDK 权威词表，RunErrorCode engine 家族收窄用——自造匹配
// 逻辑会与 SDK 词表演进漂移）。
import {
  isEngineErrorPassthroughCode,
  isEngineProtocolErrorCode,
} from "@zhushanwen/subagent-engine-sdk";

// [D1 Class A] run 域词汇下沉 shared；本文件 re-export 保持 orchestration 消费面与 barrel 不变
import type { RunEventType } from "../shared/run-vocabulary.ts";
import type { RunErrorCode, RunOutcome } from "../shared/run-vocabulary.ts";
export { ALL_RUN_OUTCOMES, RUN_EVENTS_SUFFIX, RUN_EVENT_TYPES } from "../shared/run-vocabulary.ts";
export type { RunErrorCode, RunEventType, RunOutcome } from "../shared/run-vocabulary.ts";
import { MAX_ERROR_LOGS } from "./worker-message-pump-constants.ts";
// [§3.1.3 基座单源] append/scan 实现在 shared/jsonl-event-stream.ts（与 record 事件
// journal 共用同一实现体，差异经策略注入——本文件只提供 run 域策略）。
import type { AgentFailureKind, AgentResult, DoneReason, WorkerLogEntry } from "./models/types.ts";
import type { WorkflowRun } from "./models/workflow-run.ts";

// ── 终态双维度（D5-1 → [D2] 四态重构）────────────────────────







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




/**
 * 事件公共信封字段：行级单调序号 + 墙钟时间戳（Date.now() epoch ms）。
 *
 * seq（1 起严格递增，同一 journal 文件内全序；W1 [D1] 起）：同一事件的唯一行
 * 身份——W2 通知去重键（终态事件身份）的载体 + tail 截断重建后全量重读的 fold
 * 去重依据（seq ≤ 已见水位的行按重放跳过，见 foldRunEventFrames）。与 record 侧
 * RecordEventEnvelope（u0）同构——两域 tail 原语（event-tail.ts）的去重语义
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
export interface RunCreatedEvent extends EventEnvelope { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  type: "run-created";
  /**
   * run 唯一 id（record 流文件名同源：wf-<id>.record.jsonl）。全词表唯一携带
   * runId 的事件——record 流文件本身即 run 域，其余事件不重复携带。
   */
  runId: string;
  /** 脚本身份名（RunSpec.scriptName，meta.name 或文件名 stem）。 */
  workflowName: string;
  /** 调用参数摘要（截断的序列化形态——展示/日志用途的行内小摘要；恢复读面优先
   *  消费下方 args 全文字段，摘要仅旧格式帧回落）。 */
  argsSummary: string;
  /**
   * 调用参数全文（RunSpec.args 原文，设计 §3.1 载荷表 run-created 行「args」——
   * D14 逐字段深度比对与 resume 重放的 $ARGS 恢复依赖完整 args，摘要截断形态
   * 使两者退化为「传 args 一律拒绝」/「$ARGS 回落空对象」）。可选 = 读取面对
   * 旧格式行放行（载荷缺失回落 argsSummary 尽力恢复），写侧契约由写入方承担
   * （写入点 = terminal-actions dispatchRunCreated，scriptSource 同款处理）。
   */
  args?: Record<string, unknown>;
  /** run 级 model 引用（RunSpec.model；缺省 = 继承主 agent 模型）。 */
  model?: string;
  /**
   * 脚本源全文（RunSpec.scriptSource 原文，[D1] record 单源存储收敛——设计
   * workflow-run-resume-revision §3.1 载荷表）。record 流是唯一事实源后，脚本
   * 确定性重放（resume 的缓存回放）所需的 scriptSource 只能从本帧恢复——快照
   * 投影文件已删，无第二落点。可选 = 读取面对旧格式行放行（载荷缺失不拒绝），
   * 写侧契约由写入方承担（写入点 = terminal-actions dispatchRunCreated，worker-message-pump 派发链调用）。
   */
  scriptSource?: string;
  /**
   * 脚本文件所在目录的路径锚定（RunSpec.scriptPath 原文——worker 沙箱 eval 模式
   * 无 __dirname，模板脚本靠 workerData.scriptPath 定位 _shared 族共享件）。
   * resume 重建 spec 时从本字段恢复锚定；缺失 = 旧格式行回落空串，旧 run 的模板
   * 脚本 resume 由模板脚本内建 fail-fast 拒绝（已知边界，不走兼容读）。可选 =
   * 读取面对旧格式行放行，写侧契约由写入方承担（写入点 = terminal-actions
   * dispatchRunCreated，与 scriptSource 同款条件式）。
   */
  scriptPath?: string;
  /**
   * run 级时间预算上界（ms，RunSpec.budgetTimeMs 原文——run 创建时的墙钟预算）。
   * record 单源后 resume 无法从别处恢复原预算约束，本字段是唯一数据面：resume
   * 重建 spec 时据此恢复（未显式传 time 即继承），复活 run 在错误重试重建时按
   * 「剩余活跃预算」（搁置时间不计）重排计时器；缺失 = 旧格式行（本载荷落地前的
   * 流）或创建时未设预算，两种形态一律回落不限时（旧格式行为不劣化）。可选 =
   * 读取面对旧格式行放行，写侧契约由写入方承担（写入点 = terminal-actions
   * dispatchRunCreated，仅 > 0 时落字段——与 scriptPath/model 同款条件式）。
   */
  budgetTimeMs?: number;
  /**
   * run 级 token 预算上界（RunSpec.budgetTokens 原文——run 创建时的 token 消耗上限，
   * Budget.isExceeded 的加权口径）。record 单源后 resume 无法从别处恢复原预算约束，
   * 本字段是唯一数据面：resume 重建 spec 时据此恢复（未显式传 tokens 即继承），
   * 复活 run 的引擎侧 maxTokens 投影（lifecycle createRunningRun / worker-host budget
   * 注入）与 fresh run 同形；缺失 = 旧格式行（本载荷落地前的流）或创建时未设预算，
   * 两种形态一律回落不限制（旧格式行为不劣化）。可选 = 读取面对旧格式行放行，
   * 写侧契约由写入方承担（写入点 = terminal-actions dispatchRunCreated，仅 > 0 时
   * 落字段——与 budgetTimeMs 同款条件式）。
   */
  budgetTokens?: number;
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
interface AgentIdentity { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  taskIndex: number;
  /** agent 身份名（ExecutionTraceNode.agent 同源）。 */
  agentName: string;
  /** 尝试序号（1 起，与 AgentCall.attempts 同一计数链）。 */
  attempt: number;
}

/**
 * `agent-started`——脚本 agent() 调用已派发（[D4] 对齐 pi `agent_start` 语义）。
 */
export interface AgentStartedEvent extends AgentIdentity, EventEnvelope { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
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
  /**
   * 入参全文（resolveAgentOpts 规范化后 opts 的 canonical JSON 序列化——设计
   * §3.1 载荷表 agent-started 行「入参」；读放量重审轴「agent-started 入参全文
   * 重复行数」即本字段）。resume 重建回放集 call 以本字段恢复 opts，
   * detectReplayInputMismatch 的输入一致性比对由此可比（[U13]：缺本字段时重建
   * 只能落占位 opts {prompt:""}，比对结构性跳过——回放前缀的非确定性漂移零
   * 检出）。可选 = 读取面对旧格式行放行（旧帧重建回落占位形态，比对跳过维持）；
   * 写侧填充责任在 dispatchAgentStarted（terminal-actions 定义，worker-message-pump 派发链调用）。
   */
  input?: string;
}

/** `agent-retrying`——失败尝试后将退避重试（重试轨迹从脚本内部状态变为 record 事件，重试不再能掩盖事故）。 */
export interface AgentRetryingEvent extends EventEnvelope { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
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
export interface AgentSettledEvent extends EventEnvelope { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
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
   * 责任在写入方（terminal-actions dispatchAgentSettled，worker-message-pump 完成链调用）。
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
export interface PhaseStartedEvent extends EventEnvelope { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
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
export interface PhaseSettledEvent extends EventEnvelope { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  type: "phase-settled";
  /** phase 名。 */
  phase: string;
}

/**
 * `run-interrupted`——running/settling → interrupted 的转移事件（[D2]）：崩溃收编
 * / terminate 被动失联（[D11] 统一中断——全部 running run，不分来源）经 [D15]
 * 终局编排入口统一写入。中断不是终局——本事件后 run 停在 interrupted 暂停态，
 * 可经 run-resumed 复活。
 */
export interface RunInterruptedEvent extends EventEnvelope { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
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
export interface RunResumedEvent extends EventEnvelope { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  type: "run-resumed";
  /** resume 锚点摘要（重放/三档恢复的入口语境，自由文本；可缺省）。 */
  reason?: string;
  /** 宿主标识（跨进程锁裁决的胜出方语境，自由文本；可缺省）。 */
  host?: string;
  /**
   * 本次复活实际生效的时间预算上界（ms）——即 resume 生效预算三档回落的落定值，
   * 使「显式传入的覆盖预算」跨崩溃存续（否则下次无参 resume 会退回 run-created 的
   * 创建预算）。读取面三档回落：显式 options > 最近一条 run-resumed 的本字段 >
   * run-created 的创建预算；三处都没有 = 不限时。缺席有两种形态——本次复活不限时
   * （未设/0/负值），或旧格式帧（本载荷落地前的流，一律回落 run-created，不劣化）：
   * 读取面按「最近一条 run-resumed 的本字段 ?? run-created」处理，与 run-created
   * 同款条件式（仅 > 0 落字段；写入点 = resume-run.resumeRunLocked 的 run-resumed
   * 派发）。
   */
  budgetTimeMs?: number;
  /**
   * 本次复活实际生效的 token 预算上界——即 resume 生效预算三档回落的落定值（与
   * budgetTimeMs 同族），使「显式传入的覆盖预算」跨崩溃存续（否则下次无参 resume
   * 会退回 run-created 的创建预算）。读取面三档回落：显式 options > 最近一条
   * run-resumed 的本字段 > run-created 的创建预算；三处都没有 = 不限制。缺席有
   * 两种形态——本次复活不限制（未设/0/负值），或旧格式帧（本载荷落地前的流，
   * 一律回落 run-created，不劣化）：读取面按「最近一条 run-resumed 的本字段 ??
   * run-created」处理，与 run-created 同款条件式（仅 > 0 落字段；写入点 =
   * resume-run.resumeRunLocked 的 run-resumed 派发）。
   */
  budgetTokens?: number;
}

/** `run-settled`——run 终局（一个 run 恰好一帧；终局通知的单点判定源，防多处各判漏分支）。 */
/**
 * worker 诊断日志帧（[§2.1 errorLogs 持久化] ADR-0093）。
 *
 * **不参与生命周期状态机**：诊断面与状态面正交——fold 显式跳过本类事件（见
 * foldRunEventCheckpoint），故不占 RUN_TRANSITIONS 表行，也不受终态吸收约束（run
 * 终局后迟到的诊断日志不会把 fold 判成坏帧）。唯一消费面 = `errorLogsFromEvents`
 * 重建（与活体写入同语义：按序追加 + 尾部上限裁剪）。
 */
export interface WorkerLogEvent extends EventEnvelope { // oe-exempt:20260930:framework:workflow/record 协议契约类型——诊断事件帧（单实现常态，与既有 run 事件族同款豁免）
  type: "worker-log";
  /** 诊断条目（level + message，与活体 errorLogs 条目同形）。 */
  entry: WorkerLogEntry;
}

export interface RunSettledEvent extends EventEnvelope { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
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
  | RunSettledEvent
  | WorkerLogEvent;

/**
 * 写侧入参形态：事件去掉 seq（seq 由 journal 单写者分配——单调性的构造性保证，
 * 调用方无法传错；与 record 侧 RecordEventInput（execution/persistence/
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
 * 单写者约束（D5，[D15] 后落点）：append 的唯一合法调用方 = terminal-actions
 * （dispatchRunTrigger 唯一投递入口 + appendTransition 单写点——journal 单写者
 * 纪律的物理载体）——引擎侧事件经既有 run 事件通道上报后由写者落账，
 * 引擎不直接写 journal。类型层无法约束调用方，该约束由实装与守卫共同保证。
 */
export interface RunEventJournal {
  /**
   * 追加一条事件（JSONL 单行），返回落盘的完整事件（含分配的 seq）——调用方据
   * 此同步构造 v2 终态条目 / 物化投影（同一事件的单点载荷源；与 record 侧
   * RecordEventStream.append 契约同构）。入参是无 seq 的 input 形态（seq 分配权
   * 在 journal 实装内，构造性单调）；runId 显式传参而非从事件取——仅 run-created
   * 携带 runId，目标文件定位不依赖事件形态。
   *
   * 单写者约束（[D15] 终局编排单一入口后）：合法调用方 = terminal-actions 的
   * dispatchRunTrigger（唯一投递入口——活体链与经 interruptRun /
   * settleRunAccounting 的收编冷路径都经它；resume 的复活转移由 resume-run 在锁
   * 段内经同一入口投递）+ terminal-actions.appendTransition 的 journal.append
   * 单写点——除此之外引擎/读侧一律不写。收编链追加的是 run-interrupted 转移
   * 事件（[D2] 中断非终局，不再落 run-settled(outcome=interrupted)）。
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
 * 「outcome 仅 terminal 出现」是机器不变量，transition 是 RunLifecycleState 的唯一构造
 * 点（表行声明 terminalOutcome 或从 run-settled 事件取），消费侧读 outcome 前
 * 只需一处 `lifecycle === "terminal"` 判定；嵌套形态把同一不变量复制进类型系统，
 * 全部消费点多一层 narrow，收益不抵摩擦。
 */
export interface RunLifecycleState { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  lifecycle: RunLifecycle;
  /** 终局形态——仅 lifecycle === "terminal" 时有值（transition 构造性保证）。 */
  outcome?: RunOutcome;
}

/** 状态机初始态（run 创建点与 journal fold 起点共用）。 */
export const INITIAL_RUN_LIFECYCLE_STATE: RunLifecycleState = { lifecycle: "created" };

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
 * running × agent-settled 的二支判别（D5 转移表行 3/4 的条件维度）。
 *
 * 为什么这一族需要条件行：「重试预算未尽 → 留在 running」与「预算耗尽 / 全部
 * settled → 进入终局判定」依赖状态机外的事实（在途 ask 数、排定的重试），事件
 * 载荷本身不可判定。裁决输入经 TransitionContext.enterSettling 显式传入，两支
 * 都落表（而非散落 if），穷尽单测照常遍历。
 */
export type AskSettleBranch = "more-work-expected" | "adjudicate-now";

/** 单条转移规则（表行）。 */
export interface TransitionRule { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  from: RunLifecycle;
  on: RunEventType | ControlTriggerType;
  /**
   * 条件行判别标签：同 (from, on) 键二支时区分，undefined = 无条件行。
   * 当前唯一条件族 = running × agent-settled。
   */
  guard?: AskSettleBranch;
  next: RunLifecycle;
  /**
   * next === "terminal" 时的终局形态来源：固定值（cancel → cancelled）或缺省 =
   * 从 run-settled 事件载荷取（event.outcome）。
   * 非 terminal 行恒缺省。abandon 路径的 errorCode（interrupted_abandoned）
   * 是 manifest 写入内容而非状态——由收编原语消费方附着，不进 RunLifecycleState
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
 * running × agent-settled 二支的裁决输入。
 *
 * enterSettling = 本次 settle 后无在途 ask 且无排定重试（预算耗尽或全部
 * settled），直接进入终局判定。缺省 / false = 留在 running——journal fold
 * 重放无此上下文，保守取 running 支：重放至多把 settling 延后到 run-settled
 * 帧（fold 下 settling 是不可重现的活体内瞬态），终局正确性不受影响。
 */
export interface TransitionContext { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  enterSettling?: boolean;
}

/** 转移结果：次态 + 应发生的输出动作（声明性标签，执行归调用侧）。 */
export interface TransitionResult { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  state: RunLifecycleState;
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
  state: RunLifecycleState,
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
  const nextState: RunLifecycleState = { lifecycle: rule.next };
  if (rule.next === "terminal") {
    nextState.outcome = resolveTerminalOutcome(rule, trigger);
  }
  return { state: nextState, outputs: rule.outputs };
}

// ── journal fold 循环（投影侧共享单源）──────────────────────

/**
 * 单个 agent call（步骤）的 fold 投影行：骨架行 + 终局。
 *
 * [W2 D7] 自 runtime events-projection.ts 上收（原 RunAskStepFold）——run 域
 * fold 单源后，runtime 投影消费 core fold 的骨架输出，不再自建第二套 fold。
 * [D4] 随事件词 agent-* 更名（ask → agent）。
 */
export interface RunAskStepFold { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
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
export interface RunPhaseFold { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /** phase 名。 */
  phase: string;
  /** 转移进入时刻（phase-started 帧 ts；自愈重建 = 首 agent-started ts）。 */
  startedAt: number;
  /** 收束时刻（phase-settled 帧 ts，或 [D3 对称自愈] 按 agent-settled 帧行推导的值；未收束 undefined）。 */
  settledAt?: number;
  /**
   * settledAt 供源标记（[D3 对称自愈] 推导规则的半边）："frame" = phase-settled
   * 转移帧（显式转移记录，后到 agent 事件不翻回 running——新一轮只有再次
   * phase-started 才重置）；"derived" = agent-settled 帧行推导（phase-settled 帧
   * 缺失窗口，含 resume 重放的同名 phase-started 重置后重推导——该 phase 后续
   * 出现未落定 call 行 / 重试帧时翻回 running，推导态不是吸收态）；
   * undefined = 未收束。消费方只读 settledAt 即可（format.ts phase group 的
   * running/settled 判定），本标记服务 fold 自身的翻回裁决。
   */
  settledBy?: "frame" | "derived";
}

/**
 * [D3 对称自愈] phase 终局的 agent-settled 推导（设计 D3：phase-settled 帧缺失时
 * fold 按 agent-settled 帧行推导 phase 终局——行存在即权威，无需转移帧确认）。
 *
 * 判据：该 phase 名下在场 call 行 ≥1 且全部落定 → settledAt = 各 call 落定 ts 的
 * 最大值（推导值）；出现未落定 call 行（或 treatAsRunning 显式标记——重试帧在
 * 途，call 行仍携上一次尝试的旧 settled）且现值为推导值 → 翻回 running。帧值
 * （settledBy "frame"）不参与翻回（显式转移记录以帧为准）。
 *
 * 两个窗口由此封闭：
 * - postMessage 异步丢失 phase-settled 帧（设计明示的固有竞态）：最后一个
 *   agent-settled 到达即推导收束；
 * - resume 重放（设计 D3「持久修复通道 = resume 后脚本确定性重放重新执行
 *   phase() 补落事件」）：重放落新 phase-started 重置 settledAt 后，该 phase 的
 *   call 行已在前段流全部落定（缓存回话零新帧）——phase-started 触发本推导即
 *   恢复收束投影，消灭「崩溃前已完成的 phase 在 resume 后永不收束」。
 *
 * 取舍（同名义真重入与重放在 phase-started 帧不可区分）：真重入先按已落定旧
 * call 行瞬态推导为收束，首个新 agent-started / 重试帧到达即翻回 running——
 * 活体显示的瞬态收束是该取舍的已知代价，终态随最后一个新 call 落定收敛。
 */
function derivePhaseSettlement(
  asks: Map<number, RunAskStepFold>,
  phases: Map<string, RunPhaseFold>,
  phase: string,
  treatAsRunning?: boolean,
): Map<string, RunPhaseFold> {
  const row = phases.get(phase);
  if (row === undefined || row.settledBy === "frame") return phases; // 帧值不参与推导/翻回
  let present = 0;
  let allSettled = !treatAsRunning;
  let lastSettledTs = 0;
  if (allSettled) {
    for (const ask of asks.values()) {
      if (ask.phase !== phase) continue;
      present += 1;
      if (ask.settled === undefined) {
        allSettled = false;
        break;
      }
      if (ask.settled.ts > lastSettledTs) lastSettledTs = ask.settled.ts;
    }
  }
  if (present > 0 && allSettled) {
    const nextPhases = new Map(phases);
    nextPhases.set(phase, { ...row, settledAt: lastSettledTs, settledBy: "derived" });
    return nextPhases;
  }
  if (row.settledBy === "derived" && row.settledAt !== undefined) {
    // 翻回 running：推导态不是吸收态（真重入派发新 call / 重试在途）
    const nextPhases = new Map(phases);
    nextPhases.set(phase, { phase: row.phase, startedAt: row.startedAt });
    return nextPhases;
  }
  return phases;
}

/**
 * 单个 run record 流的投影骨架（fold 产物的投影半边：run 首帧 + call 步骤行 +
 * phase 状态机 + 中断/复活 + run 终局）。
 *
 * [W2 D7] 自 runtime events-projection.ts 上收（原 RunJournalFold）：runtime
 * 投影（projectV2Workflow）读本骨架合成 WorkflowRunRecord，与状态机半边
 * （state/lastSeq）同源于一次 fold 循环。
 */
export interface RunJournalFold { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
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
 * SessionEventProjection 以本 checkpoint 为 per-run tailer 状态，投影读
 * created/asks/phases/runSettled 合成 WorkflowRunRecord——「只要终帧状态」的
 * core 内消费面（run-state-evidence 清理资格 / 注册表投影 / pump 活体 fold）经
 * foldRunEventFrames 只取 state，骨架半边零成本闲置。
 */
export interface RunEventFoldCheckpoint extends RunJournalFold { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  state: RunLifecycleState;
  lastSeq: number;
}

/** fold 起点（全量 fold 缺省初值；增量 fold 以既有 checkpoint 传入）。 */
export const INITIAL_RUN_EVENT_FOLD: RunEventFoldCheckpoint = {
  state: INITIAL_RUN_LIFECYCLE_STATE,
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
 *   = 新一轮同名义转移——覆盖 settledAt 回到 running 投影；[D3 对称自愈] 随后跑
 *   推导（derivePhaseSettlement）：resume 重放形态下该 phase 的 call 行已全部
 *   落定 → 立即恢复收束投影——「崩溃前已完成的 phase 在 resume 后永不收束」
 *   由此封闭，同名义真重入的瞬态收束见推导函数注释的取舍说明）；
 * - phase-settled：落 settledAt（settledBy "frame"——帧值不参与推导翻回；缺
 *   started 行 = 转移事件缺失窗口的迟到收束帧，按 agent-started 自愈面兜底成行）；
 * - agent-started 携带 phase 且 phase 行缺席（postMessage 异步丢失窗口——[D3]
 *   fold 自愈规则）：按 call 归属快照驱动 pending → running（自愈重建 phase 行，
 *   startedAt 取本帧 ts；转移事件缺失不判损坏、不进 D12 拒绝范围——该窗口是
 *   异步通道固有竞态而非写入器 bug）。phase 行已存在时不改写（startedAt 以
 *   phase-started 帧为准）。
 * - agent 事件的 [D3 对称自愈] 推导（derivePhaseSettlement，设计 D3「对称侧」：
 *   phase-settled 帧缺失时按 agent-settled 帧行推导 phase 终局——行存在即权威）：
 *   agent-settled 后该 phase 名下 call 行全部落定 → 推导收束；agent-started /
 *   agent-retrying 出现未落定（或在途重试）的 call 行 → 推导值翻回 running。
 */
/** [applyAskFoldEvent 拆分] agent-started 帧折叠（[D3] fold 自愈 + 对称自愈见各内联注释）。 */
function foldAgentStartedEvent(
  asks: Map<number, RunAskStepFold>,
  phases: Map<string, RunPhaseFold>,
  event: Extract<WorkflowRunEvent, { type: "agent-started" }>,
): { asks: Map<number, RunAskStepFold>; phases: Map<string, RunPhaseFold> } {
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
  // （写时克隆——自愈建行同守 copy-on-write 契约，输入 phases Map 不被变异）
  let nextPhases = phases;
  if (event.phase !== undefined && !nextPhases.has(event.phase)) {
    nextPhases = new Map(phases);
    nextPhases.set(event.phase, { phase: event.phase, startedAt: event.ts });
  }
  // [D3 对称自愈] 新 call 行在场（重派/重入）→ 推导值翻回 running
  if (event.phase !== undefined) {
    nextPhases = derivePhaseSettlement(nextAsks, nextPhases, event.phase);
  }
  return { asks: nextAsks, phases: nextPhases };
}

/** [applyAskFoldEvent 拆分] agent-retrying 帧折叠（重试在途 → phase 推导值翻回 running）。 */
function foldAgentRetryingEvent(
  asks: Map<number, RunAskStepFold>,
  phases: Map<string, RunPhaseFold>,
  event: Extract<WorkflowRunEvent, { type: "agent-retrying" }>,
): { asks: Map<number, RunAskStepFold>; phases: Map<string, RunPhaseFold> } {
  const existing = asks.get(event.taskIndex);
  if (existing === undefined) return { asks, phases };
  const nextAsks = new Map(asks);
  nextAsks.set(event.taskIndex, {
    ...existing,
    lastProgressAt: Math.max(existing.lastProgressAt, event.ts),
  });
  // [D3 对称自愈] 重试在途（call 行仍携上一次尝试的旧 settled）→ 该 phase
  // 推导值翻回 running（treatAsRunning——判据不依赖 call 行 settled 缺席）
  const nextPhases = existing.phase !== undefined
    ? derivePhaseSettlement(nextAsks, phases, existing.phase, true)
    : phases;
  return { asks: nextAsks, phases: nextPhases };
}

/** [applyAskFoldEvent 拆分] agent-settled 帧折叠（骨架行落定 + phase 终局推导）。 */
function foldAgentSettledEvent(
  asks: Map<number, RunAskStepFold>,
  phases: Map<string, RunPhaseFold>,
  event: Extract<WorkflowRunEvent, { type: "agent-settled" }>,
): { asks: Map<number, RunAskStepFold>; phases: Map<string, RunPhaseFold> } {
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
  // [D3 对称自愈] 该 phase 名下 call 行全部落定 → 推导 phase 终局（行存在
  // 即权威，无需 phase-settled 转移帧确认——postMessage 异步丢失窗口封闭）
  const phase = existing?.phase;
  const nextPhases = phase !== undefined
    ? derivePhaseSettlement(nextAsks, phases, phase)
    : phases;
  return { asks: nextAsks, phases: nextPhases };
}

/** [applyAskFoldEvent 拆分] phase-started 帧折叠（登记 phase 行 + resume 重放收束恢复）。 */
function foldPhaseStartedEvent(
  asks: Map<number, RunAskStepFold>,
  phases: Map<string, RunPhaseFold>,
  event: Extract<WorkflowRunEvent, { type: "phase-started" }>,
): { asks: Map<number, RunAskStepFold>; phases: Map<string, RunPhaseFold> } {
  let nextPhases = new Map(phases);
  nextPhases.set(event.phase, { phase: event.phase, startedAt: event.ts });
  // [D3 对称自愈] resume 重放形态：新 phase-started 重置后，该 phase 的 call
  // 行已在前段流全部落定（缓存回话零新帧）→ 立即恢复收束投影
  nextPhases = derivePhaseSettlement(asks, nextPhases, event.phase);
  return { asks, phases: nextPhases };
}

/** [applyAskFoldEvent 拆分] phase-settled 帧折叠（帧值收束，settledBy "frame" 不参与推导翻回）。 */
function foldPhaseSettledEvent(
  phases: Map<string, RunPhaseFold>,
  event: Extract<WorkflowRunEvent, { type: "phase-settled" }>,
): Map<string, RunPhaseFold> {
  const existing = phases.get(event.phase);
  const nextPhases = new Map(phases);
  nextPhases.set(
    event.phase,
    existing !== undefined
      ? { ...existing, settledAt: event.ts, settledBy: "frame" }
      // 转移事件缺失窗口的迟到收束帧：兜底成行（startedAt 不可考——取收束 ts）
      : { phase: event.phase, startedAt: event.ts, settledAt: event.ts, settledBy: "frame" },
  );
  return nextPhases;
}

function applyAskFoldEvent(
  asks: Map<number, RunAskStepFold>,
  phases: Map<string, RunPhaseFold>,
  event: WorkflowRunEvent,
): { asks: Map<number, RunAskStepFold>; phases: Map<string, RunPhaseFold> } {
  switch (event.type) {
    case "agent-started":
      return foldAgentStartedEvent(asks, phases, event);
    case "agent-retrying":
      return foldAgentRetryingEvent(asks, phases, event);
    case "agent-settled":
      return foldAgentSettledEvent(asks, phases, event);
    case "phase-started":
      return foldPhaseStartedEvent(asks, phases, event);
    case "phase-settled":
      return { asks, phases: foldPhaseSettledEvent(phases, event) };
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
 * seq 守卫（幂等语义，与 record 侧 foldRecordEvents 同构）：
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
    // 诊断事件（worker-log）不进状态机：诊断面与状态面正交，且终态是吸收态——若让
    // 它走 transition，run 终局后迟到的诊断日志会把 fold 判成坏帧。水位仍推进，避免
    // tail 消费方每轮重读同一批诊断行。
    if (event.type === "worker-log") {
      checkpoint = { ...checkpoint, lastSeq: typeof seq === "number" ? seq : checkpoint.lastSeq };
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
): RunLifecycleState {
  return foldRunEventCheckpoint(events, onBrokenFrame).state;
}

/**
 * worker-log 帧 → errorLogs 重建（[§2.1 errorLogs 持久化] ADR-0093）。
 *
 * 语义与活体写入单点同构（worker-message-pump 的 appendErrorLogs）：按事件序追加 +
 * 尾部上限裁剪（`MAX_ERROR_LOGS`）。重启后折叠 record 流即可恢复诊断日志——此前
 * errorLogs 无任何持久面，重启即空。
 */
export function errorLogsFromEvents(events: readonly WorkflowRunEvent[]): WorkerLogEntry[] {
  const logs: WorkerLogEntry[] = [];
  for (const event of events) {
    if (event.type === "worker-log") logs.push(event.entry);
  }
  return logs.length > MAX_ERROR_LOGS ? logs.slice(-MAX_ERROR_LOGS) : logs;
}

// ── journal 实装（createRunEventJournal——本模块唯一 IO 边）────

// ── [D1 Class B2] journal 落盘实现已迁 execution/persistence/run-event-journal.ts ──
// 本模块保留 re-export（orchestration 消费面与 barrel 不变）；实现反向 import 本模块
// 的类型（类型边擦除，不构成值依赖环）。
export {
  createRunEventJournal,
  parseLegacyArgsSummary,
  parseRecordStreamLine,
} from "../execution/persistence/run-event-journal.ts";
export type {
  LegacyArgsSummaryIssue,
  LegacyArgsSummaryResult,
  RunEventLineIssue,
  RunEventLineIssueKind,
  RunEventLineResult,
} from "../execution/persistence/run-event-journal.ts";
