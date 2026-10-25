// src/shared/run-event-contracts.ts
//
// run 事件载荷契约族（shared 唯一权威）
//
// orchestration ↔ execution 两层共同消费的 workflow run 事件载荷契约，权威定义在本文件
// （D1 反向依赖收编决策一：契约类型归最低层，execution 侧直连本文件，不再反向依赖
// orchestration）。orchestration 侧经 re-export 壳消费（orchestration/run-events.ts），
// barrel 与外部包深导入路径零改动。
//
// 内容：
// - EventEnvelope（seq/ts 公共信封）+ AgentIdentity（身份三元组）
// - 11 个事件成员接口（run-created / phase-started / phase-settled / agent-started /
//   agent-retrying / agent-settled / run-interrupted / run-resumed / run-settled /
//   model-override / worker-log）
// - WorkflowRunEvent 判别联合 + WorkflowRunEventInput（写侧无 seq 形态）
// - RunEventJournal（journal 接口形态；实装在 execution/persistence/run-event-journal.ts）
//
// 词表值（RUN_EVENT_TYPES / RUN_EVENTS_SUFFIX）权威在 shared/run-vocabulary.ts；
// 状态机（RUN_MACHINE / transition）与 fold 族留 orchestration/run-events.ts。
//
// 层归属：shared。零 orchestration/execution 依赖——仅 shared 词表 + shared Agent 调用
// 契约（AgentResult / WorkerLogEntry）。

import type { AgentResult, WorkerLogEntry } from "./agent-call-types.ts";
import type { RunErrorCode, RunOutcome } from "./run-vocabulary.ts";

// ── 事件词表（D5-2 → [D4] 对齐 pi 9 个 + model-override + worker-log，11 个）──

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
 * 快照必然漂移；三通道采信顺序见 orchestration/run-events.ts 头部「终局证据
 * 读序」权威声明），没有 ts 的 journal 无法支撑投影，故信封层统一携带。
 *
 * [W1 存量兼容读，D7] W1 前的 journal 行无 seq 字段——读取面（scan 解析判定与
 * fold 守卫）对「缺失 seq」放行（旧行为完全不变）；携带 seq 的行按正整数契约
 * 校验，坏值 = 坏行。见 isWorkflowRunEventLine 与 foldRunEventFrames 注释。
 */
export interface EventEnvelope { // oe-exempt:20261023:framework:载荷契约接口（自 orchestration/run-events.ts 搬迁，单实现常态）
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
  /**
   * 归属会话锚（根 Pi session id，record-created.rootSessionId 同款语义）。run
   * journal 目录已按 rootSessionId 分区（`<root>/<sid>/workflow/runs/`，同 cwd
   * 共享目录分区随 session-store-layout-inversion 退役），runtime 网关
   * （subagent-model-gateway）在目录级隔离之外仍以本字段做精确归属二次校验——
   * 防串会话：journal 文件存在性不作归属判据，路由以字段比对为准（形态
   * 对齐 recordId 侧 record-created 帧锚）。可选 = 读取面对旧格式行放行（本字段
   * 落地前的流缺失时读侧回落既有存在性判定，存量 run 行为不劣化），写侧契约由
   * 写入方承担（写入点 = terminal-actions dispatchRunCreated，条件式可选项：
   * 宿主会话锚缺席时不落字段——与 scriptPath/model 同款条件式）。
   */
  rootSessionId?: string;
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
  /**
   * 本次复活实际生效的模型 canonical ref（`provider/modelId`，与 run-created.model
   * 同构；subagent-model-switch 决策七：resume 生效模型三档回落的落定值随帧落盘，
   * 观测面 + 跨崩溃存续）。条件式落字段（缺省/空串不落——未指定且无覆盖记账的
   * 复活与现状同形）；写入点 = resume-run.resumeRunLocked 的 run-resumed 派发。
   * 消费边界：观测面为主——派发侧的模型消费走宿主覆盖通道（决策六②，U4b 接线），
   * 本字段不改重建 spec 的 run 级模型（决策七不采用①：改 spec 会击穿回放比对）。
   */
  model?: string;
}

/**
 * 模型覆盖记账值（subagent-model-switch §6.2 记账形状 + §7.4 持久化 bullet）。
 *
 * model 形状 = SDK ModelRef（`{ provider, modelId }`，u-foundation 定形的结构化
 * 契约——「拆装只发生在宿主编排层单点」；wire 语义：宿主组帧时拼 canonical ref
 * `provider/modelId`，读取面按同语法拆回）。thinkingLevel 仅在用户切换时显式选择
 * 档位才记账（§6.2：缺席时下一轮档位按现役候选链对新模型完整裁决）。
 *
 * 折叠语义（消费面单点 latestModelOverride）：生效覆盖值 = 最新一条，覆盖旧覆盖
 * 值不叠加（设计不变量 2：至多一个用户覆盖值）。
 */
export interface WorkflowModelOverride { // oe-exempt:20261023:framework:载荷契约接口（自 orchestration/run-events.ts 搬迁，单实现常态）
  /** 目标模型 ref（provider + modelId；SDK ModelRef 同形）。 */
  model: { provider: string; modelId: string };
  /** 显式选择的 thinking 档位（仅用户显式选择时记账；缺席 = 解析链完整裁决）。 */
  thinkingLevel?: string;
  /** 覆盖下达时刻（epoch ms；信封 ts 的载荷侧镜像——挂载值脱离事件信封单独存续）。 */
  ts: number;
}

/**
 * `model-override`——workflow run 级模型覆盖记账事件（subagent-model-switch §6.6
 * 决策六①：run 的事件流追加覆盖记录，事件流是追加式单源、唯一合法持久化形态）。
 *
 * **不参与生命周期状态机**（worker-log 同款——记账面与状态面正交）：fold 显式
 * 跳过（foldRunEventCheckpoint），不占 RUN_MACHINE 表行，水位照常推进。
 * 硬约束（调研 S3）：覆盖记录只做记账持久化与 resume 生效值缺省，不进 worker
 * 的 `$MODEL`、不改重建 spec 的 run 级模型、不碰回放一致性比对——覆盖走宿主
 * 派发侧覆写（决策六②），三者在场时回放哈希不受扰动。
 *
 * 写入面 = 宿主切换编排（U4b）经 journal append 单点直写（seq 由 journal 实装
 * 分配，W1 seq 契约：新写行信封必填正整数 seq）；不经 dispatchRunTrigger——
 * model-override 是非转移记账事件（不占 RUN_MACHINE 表行），
 * appendTransition 首行 transition() 对无转移表行事件必抛 IllegalTransitionError，
 * 结构上进不了转移裁决链（RunDispatchSource = { runId, journalDir? } 对
 * interrupted 态 run 本可达，见 §8 验收场景 3 中断后补切；不可达的是转移通道而非
 * run 本身，同款直写先例 = appendRunDiagnosticEvent 的 worker-log）。写点 =
 * subagent-service.ts persistRunOverride 闭包（journal.append 的第二合法写点，
 * 登记见 RunEventJournal.append 单写者约束）。
 */
export interface ModelOverrideEvent extends EventEnvelope, WorkflowModelOverride { // oe-exempt:20261006:framework:workflow/record 协议契约类型——与既有 run 事件族同款豁免
  type: "model-override";
}

/**
 * worker 诊断日志帧（[§2.1 errorLogs 持久化] ADR-0093）。
 *
 * **不参与生命周期状态机**：诊断面与状态面正交——fold 显式跳过本类事件（见
 * foldRunEventCheckpoint），故不占 RUN_MACHINE 表行，也不受终态吸收约束（run
 * 终局后迟到的诊断日志不会把 fold 判成坏帧）。唯一消费面 = `errorLogsFromEvents`
 * 重建（与活体写入同语义：按序追加 + 尾部上限裁剪）。
 */
export interface WorkerLogEvent extends EventEnvelope { // oe-exempt:20260930:framework:workflow/record 协议契约类型——诊断事件帧（单实现常态，与既有 run 事件族同款豁免）
  type: "worker-log";
  /** 诊断条目（level + message，与活体 errorLogs 条目同形）。 */
  entry: WorkerLogEntry;
}

/** `run-settled`——run 终局（一个 run 恰好一帧；终局通知的单点判定源，防多处各判漏分支）。 */
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

/** run 事件判别联合（D5 词表全集，[D4] 对齐 9 个 + model-override 记账 + worker-log 诊断；判别键 = type）。 */
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
  | ModelOverrideEvent
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
 * 单写者约束（D5；[F1-17] 裁决后按多写点现实登记）：append 的合法写点共三处，
 * 除此之外引擎/读侧一律不写——
 *   1. terminal-actions：dispatchRunTrigger 唯一投递入口（转移事件经
 *      appendTransition 的 journal.append 落账）+ 同模块 appendRunDiagnosticEvent
 *      的 worker-log 诊断直写（best-effort 非转移诊断事件）；
 *   2. execution 层 subagent-service.ts persistRunOverride 的 model-override
 *      记账直写（非转移事件进不了转移裁决链，登记理由见 append 方法级注释）；
 *   3. orchestration 层 resume-run.ts appendResumeModelOverride 的 model-override
 *      记账直写（resume 显式 model 参数的统一覆盖记账——F1-26 后续项；同款非转移
 *      直写理由，写序 = run-resumed 转移之后、接管之前，失败走接管回滚围栏）。
 * 引擎侧事件经既有 run 事件通道上报后由写点落账，引擎不直接写 journal。类型层
 * 无法约束调用方，该约束由实装与守卫共同保证。写点登记三处保持一致：本接口
 * append 方法级注释 + run-event-journal.ts scanRunEvents 读面注释。
 */
export interface RunEventJournal { // oe-exempt:20261023:framework:载荷契约接口（自 orchestration/run-events.ts 搬迁，单实现常态）
  /**
   * 追加一条事件（JSONL 单行），返回落盘的完整事件（含分配的 seq）——调用方据
   * 此同步构造 v2 终态条目 / 物化投影（同一事件的单点载荷源；与 record 侧
   * RecordEventStream.append 契约同构）。入参是无 seq 的 input 形态（seq 分配权
   * 在 journal 实装内，构造性单调）；runId 显式传参而非从事件取——仅 run-created
   * 携带 runId，目标文件定位不依赖事件形态。
   *
 * 单写者约束（[F1-17] 裁决后形态——合法写点三处，与接口头注 / run-event-journal
 * .ts scanRunEvents 读面注释三处一致）：合法调用方 = terminal-actions 的
 * dispatchRunTrigger（唯一投递入口——活体链与经 interruptRun /
 * settleRunAccounting 的收编冷路径都经它；resume 的复活转移由 resume-run 在锁
 * 段内经同一入口投递）+ terminal-actions.appendTransition 的 journal.append
 * 单写点 + execution 层 model-override 记账直写（subagent-service.ts
 * persistRunOverride，第二合法写点）+ orchestration 层 resume 显式 model 参数的
 * model-override 记账直写（resume-run.ts appendResumeModelOverride，第三合法写点
 * ——F1-26 后续项「补切 + 无参 resume 合一步」的统一记账通道）。直写登记理由：
 * model-override 是非转移
   * 记账事件（不占 RUN_MACHINE 表行），appendTransition 首行 transition()
   * 对无转移表行事件必抛 IllegalTransitionError——结构上进不了转移裁决链
   * （RunDispatchSource = { runId, journalDir? } 对 interrupted 态 run 本可达，
   * 不可达的是转移通道而非 run 本身）；同款直写先例 = appendRunDiagnosticEvent
   * 的 worker-log 诊断直写。除此之外引擎/读侧一律不写。收编链追加的是
   * run-interrupted 转移事件（[D2] 中断非终局，不再落
   * run-settled(outcome=interrupted)）。
   */
  append(runId: string, event: WorkflowRunEventInput): Promise<WorkflowRunEvent>;
  /**
   * 顺序扫描某 run 的全部事件（写入序）。消费方：快照投影（startedAt /
   * lastProgressAt 派生）、注册表投影（事件流停止 = 待恢复态判读）、恢复对账。
   * 终局后过保留期的清理（cap + TTL）不改变 scan 语义——清理后返回空流（该
   * run 的 journal 通道消失），消费方按 orchestration/run-events.ts 头部「终局
   * 证据读序」权威声明降级采信 state 快照 / manifest。
   */
  scan(runId: string): Promise<readonly WorkflowRunEvent[]>;
}
