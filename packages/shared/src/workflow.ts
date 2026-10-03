/**
 * Workflow 数据模型 —— runtime 投影链的 shared 消费契约。
 *
 * 数据来源：pi-subagent-workflow 扩展注册的 `workflow` tool。主 agent 调用该 tool
 * (action=run) 时，扩展在独立 worker 线程执行 workflow run。
 *
 * workflow run 的唯一持久化 = record 事件流（`<sessionDir>/workflow-state/
 * <runId>.record.jsonl`，append-only——[D1] record 单源存储收敛，快照文件已删）。
 * 主 session JSONL 里每 run 写 `workflow-record` v2 注册/终态两条小条目（身份 +
 * record 流路径锚点 / 终局摘要，appendEntry 通路）；runtime 投影（journal-
 * projection）以注册条目定界、record 流 fold 为骨架合成 WorkflowRunRecord。
 * v1 全量快照条目与 `workflow-state-link` 指针条目仅作历史 run 的 v1 冻结兼容
 * 读（[D16②]：不再新增事件、不可 resume，跟随裁决点 7 清理消亡）。
 *
 * 扩展源码：extensions/universal/subagent-workflow/src/jsonl-run-store.ts（record
 * store 单模式）。
 */

/**
 * workflow run 状态投影三态（[D2] workflow-run-resume-revision）：running（进行中）/
 * interrupted（已中断、可续跑——暂停态，非终局）/ done（终局）。中断 run 在 GUI
 * 显示「已中断（可续跑）」而非「运行中」；[D2] dispatched 并入 running 后快照层
 * 无预备段区分。'paused' legacy 值已随 Pause/Resume 按钮链路退役删除。
 */
export type WorkflowRunStatus = 'running' | 'interrupted' | 'done'

/** done 终态原因（WorkflowRun 不变式 I2：done 时必有 reason）。 */
export type WorkflowDoneReason =
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'budget_limited'
  | 'time_limited'

/**
 * workflow 内的单个 agent call（从 record 事件流 fold 的 ask 步骤行映射，
 * taskIndex 升序——runtime workflow-record-projection）。
 *
 * ask 步骤行是 workflow run 的执行追踪——每个节点代表一次 agent 调用，
 * 含 agent 名/phase/model/sessionId/用量/耗时/状态。下方 WorkflowAgentCall
 * 与 WorkflowRunRecord 行内的 trace.* / state.* / meta.* / budget.* 括注沿用
 * 历史快照形态的字段路径（快照类型已随 v1 兼容读删除，ADR-0095），仅作
 * 字段语义参考；spec.* 括注指向现役 core RunSpec，非历史形态。
 */
export interface WorkflowAgentCall {
  /** call 序号（trace.stepIndex） */
  id: number
  /** agent 名称（trace.agent，如 "dev-W1" / "reviewer"） */
  agent: string
  /** phase 分组名（trace.phase，如 "Dev-w0(W1)"） */
  phase?: string
  /** call 状态（trace.status） */
  status: 'pending' | 'running' | 'done' | 'failed'
  /** 执行所用 model（trace.model，'default' 表示 pi 默认 model） */
  model?: string
  /** pi session ID（trace.sessionId，uuidv7，定位 agent call 对话流 JSONL） */
  sessionId?: string
  /** 启动时间 ISO（trace.startedAt） */
  startedAt?: string
  /** 完成时间 ISO（trace.completedAt） */
  completedAt?: string
  /** 执行耗时 ms（trace.result.durationMs） */
  durationMs?: number
  /** 输入 token（trace.result.usage.input） */
  inputTokens?: number
  /** 输出 token（trace.result.usage.output） */
  outputTokens?: number
  /** 对话轮数（trace.result.usage.turns） */
  turns?: number
  /** failed 状态的错误文本（trace.error 或 trace.result.error） */
  error?: string
  /**
   * [P3/D6] 该 ask 最近一次事件边沿的墙钟时间（epoch ms；fold ask 步骤行透出，
   * 事件 journal fold 投影）。可缺省——旧投影无此字段，消费侧缺省渲染
   * （时长槽/停滞判定省略）。
   */
  lastProgressAt?: number
  /**
   * [可视化 U2] 重试计数（fold 透出，runtime 投影消费 fold 行 attempts——该 call
   * 至今的失败尝试次数，无重试 undefined，值域与 core fold 对齐——fold attempts 仅
   * 由 agent-retrying 帧写入）。供 retrying 派生态与 trace attempt 列；缺省 = 旧
   * 投影无此字段（消费侧展示按 1 处理，判定语义按无重试）。
   */
  attempts?: number
  /**
   * [可视化 U2] 最近一次重试信息（fold 透出单值——只够最近一次，多轮 attempt
   * 起止只有事件流各帧可重构，workflow-visualization 设计 §3.1-2）。供 retrying
   * 派生态展示；缺省 = 无重试记录。
   */
  lastRetry?: { attempt: number; backoffMs: number; reason: string }
}

/**
 * [P3/D6] run 终局形态（record 事件流 run-settled 终帧 outcome，事件 journal fold 投影）。
 * 与 status/reason（DoneReason）正交——「run 自身怎么死的」维度（harness 系统层）。
 *
 * [W2 D5 → D2] 四值终态词表（done/failed/cancelled/time_limited），归类为**投影派生输出**（单一生产者 = runtime extractor
 * 投影构建点，renderer 消费投影载荷字段、不自行翻译）：core↔shared 依赖方向
 * （@taiji/shared 为 private 包、subagent-core 为 npm 发布包）不允许物理单源，
 * 值域跟随由两道锚承载——① runtime extractor 值级判定集合 WORKFLOW_RUN_OUTCOMES
 * （漏升 = interrupted 经提取链被静默丢弃）；② runtime 双包值级等价断言
 * （core ALL_RUN_OUTCOMES ≡ extractor 集合 ≡ 本词表成员，runtime 单测）。
 *
 * 值语义（[D2] 后四值）：done=成功 / failed=失败 / cancelled=已取消（用户主动）/
 * time_limited=已超时（活体墙钟预算超时，升格独立 outcome——错误处理分级双路
 * 判定的超时通道）。中断语义已移出 outcome（入 status 三态 'interrupted'——
 * 暂停态显示「已中断（可续跑）」，非终局），显示名见 WORKFLOW_RUN_OUTCOME_LABELS。
 */
export type WorkflowRunOutcome = 'done' | 'failed' | 'cancelled' | 'time_limited'

/**
 * WorkflowRunOutcome 值全集（[W2 D5] 值级跟随锚的 shared 侧载体；形态对齐
 * SUBAGENT_STATUS_ALL 先例）。
 *
 * 用途：跨包值级等价断言的成员集合（runtime 单测逐成员比对 core
 * ALL_RUN_OUTCOMES / extractor 集合）+ 消费方全集遍历数据源。扩枚举守卫：
 * 上方联合与本元组须同步改——正向（元组含非联合值）由 satisfies 编译期拦截；
 * 反向（联合扩值漏改元组）由下方覆盖编译锁拦截。
 */
export const WORKFLOW_RUN_OUTCOME_ALL = [
  'done',
  'failed',
  'cancelled',
  'time_limited',
] as const satisfies readonly WorkflowRunOutcome[]

/**
 * 反向完备编译锁：WorkflowRunOutcome 联合 ⊆ WORKFLOW_RUN_OUTCOME_ALL 值域。
 * 联合扩值漏改元组时该类型退化为错误信息元组，下行赋值 tsc 编译错。
 */
type _WorkflowRunOutcomeCoversAll = [WorkflowRunOutcome] extends [
  (typeof WORKFLOW_RUN_OUTCOME_ALL)[number],
]
  ? true
  : ['WorkflowRunOutcome 扩值须同步 WORKFLOW_RUN_OUTCOME_ALL 元组（w2-state-machine-convergence D5 值级跟随锚）']

/**
 * 编译锁消费点（导出以通过 noUnusedLocals）：值恒 true 无运行期语义——类型才
 * 承重，联合漏扩元组时本赋值 tsc 红。
 */
export const WORKFLOW_RUN_OUTCOME_COVERAGE_LOCK: _WorkflowRunOutcomeCoversAll = true

/**
 * [W2 D8] outcome 状态中文显示名单源词表（成功/失败/已取消/已中断——章程 D2
 * 中文词表）。
 *
 * 消费方 = 通知渲染与 tray 文案（显示接线归 UI 单元）；「已取消」（用户主动）
 * 与「已中断」（被动终局）禁混用。Record 键型 = 词表全集——词表扩值漏配显示名
 * 即编译红（编译期穷尽锁）。
 */
export const WORKFLOW_RUN_OUTCOME_LABELS: Record<WorkflowRunOutcome, string> = {
  done: '成功',
  failed: '失败',
  cancelled: '已取消',
  time_limited: '已超时',
}

/**
 * 单条 workflow run 记录（列表项 + 详情数据）。
 *
 * 字段来源对应关系（v2 双源投影：注册/终态条目 + record 事件流 fold——runtime
 * events-projection / workflow-record-projection）：
 * - runId：注册条目 runId（缺注册时终态条目兜底；如 "wf-1783679279983-hlpc46"）
 * - scriptName/slug/startedAt：注册条目（缺注册时 fold created 帧兜底）
 * - description：投影不产出，恒缺省
 * - status：fold 三态（run-settled 终帧 → done / 状态机 interrupted →
 *   interrupted / 其余 running）；fold 缺席时终态条目三态自描述
 * - reason：终态条目（core DoneReason 收窄到本词表，词表外归一缺省）
 * - completedAt/usedTokens/totalCallCount：终态条目统计摘要
 * - outcome/errorCode：fold run-settled 终帧优先，终态条目兜底
 * - agentCalls：fold ask 步骤行逐项映射（[P3/D6] lastProgressAt 等投影字段随行透出）
 * - stateFilePath：注册条目 recordPath（run 事件 journal 锚——详情面板「run
 *   关联持久化文件」展示位）；缺注册时 ''，消费侧对空串隐藏
 */
export interface WorkflowRunRecord {
  /** run 唯一标识（注册条目 runId，如 "wf-1783679279983-hlpc46"） */
  runId: string
  /** 脚本名（spec.scriptName） */
  scriptName: string
  /**
   * workflow 脚本绝对路径（spec.scriptPath——GUI 详情层 workflow 全路径展示源）。
   * 可缺省：v2 注册条目缺该字段的旧 run / v1 快照投影按缺省处理（空串 = 未记录）。
   */
  scriptPath?: string
  /** run 级短标签（spec.slug，≤20 字符，区分并发 run。旧 run 缺失时为 undefined） */
  slug?: string
  /** 人类可读描述（spec.description） */
  description?: string
  /** 当前状态（state.status） */
  status: WorkflowRunStatus
  /** 终态原因（state.reason，done 时必有） */
  reason?: WorkflowDoneReason
  /** 启动时间 ISO（meta.startedAt） */
  startedAt: string
  /** 完成时间 ISO（meta.completedAt，done 时有值） */
  completedAt?: string
  /** 已消耗 token（state.budget.usedTokens） */
  usedTokens?: number
  /** agent call 总数（state.budget.totalCallCount） */
  totalCallCount?: number
  /** agent call 列表（从 state.trace[] 映射） */
  agentCalls: WorkflowAgentCall[]
  /** state 路径：v2 = 注册条目 recordPath（详情面板「run 关联持久化文件」展示位）；v1 快照恒 ''（对空串隐藏） */
  stateFilePath: string
  /**
   * [P3/D6] run 级 health（run 停滞观测面）。仅 lastProgressAt 单字段；
   * stalledSince 由消费侧 lastProgressAt + 阈值推导。v2 事件 fold 投影不产出
   * 本字段（历史快照形态遗留），消费侧按 unknown 处理（不判定停滞）。
   */
  health?: { lastProgressAt: number }
  /** [P3/D6] 终局形态（state.outcome；仅终局后快照携带）。 */
  outcome?: WorkflowRunOutcome
  /** [P3/D6] 终局结构化错误码（state.errorCode，failed 终局携带）。 */
  errorCode?: string
  /**
   * [可视化 U2] phase 折叠投影（fold 透出）。fold 对同名 phase 是 last-wins 单行
   * 快照——多轮丢旧轮、resume 重放可产逆序区间（引擎 fold 已知取舍），消费位 =
   * 对话流 block chips（只表达 phase 名与最新一轮状态）；Gantt 色带/头卡经事件流
   * RPC 按轮分段，禁消费本字段（workflow-visualization 设计 §3.1-2④）。缺省 =
   * 旧投影无此字段。
   */
  phases?: WorkflowRunPhaseFoldEntry[]
  /**
   * [可视化 U2] run args 摘要（fold created 行透出——引擎写侧恒写的行内小摘要，
   * 体积有界；args 全文查看经事件流 RPC 的 run-created.args 截断形态）。消费位 =
   * overlay header args 摘要。缺省 = 旧投影无此字段。
   */
  argsSummary?: string
}

/**
 * 单个 phase 的折叠投影行（[可视化 U2]，投影 fold 的 RunPhaseFold 行——last-wins
 * 单行快照语义）。settledBy 是 fold 内部翻回裁决标记、协议不透出（消费方只读
 * settledAt 判收束：未收束 = 进行中）。
 */
export interface WorkflowRunPhaseFoldEntry {
  /** phase 名（脚本 `phase(name)` 实参字符串化）。 */
  phase: string
  /** 转移进入时刻（epoch ms；自愈重建形态 = 首 agent-started ts）。 */
  startedAt: number
  /** 收束时刻（epoch ms；未收束缺省——消费方按进行中渲染）。 */
  settledAt?: number
}

// ═══ Workflow 可视化（workflow-visualization 设计 §5-U2）：shared 协议类型冻结 ═══
//
// runtime 投影链与 renderer 可视化组件（overlay DAG / 事件流 / Gantt）的共同契约，
// 纯加法冻结（不动本文件既有字段与类型签名）。
//
// 类型跟随的权威源（@taiji/shared 为 private 包、subagent-core 为 npm 发布包，
// 不允许物理单源——同 WorkflowRunOutcome 值域跟随先例）：
// - record 事件载荷实装 = packages/subagent-core/src/orchestration/run-events.ts
//   （WorkflowRunEvent 判别联合 + EventEnvelope{seq,ts}）；词表漂移由
//   workflow-viz-protocol.test.ts 的锚定集与覆盖编译锁拦截。
// - DAG 形态与 RPC 错误码 = workflow-visualization 设计 §3.1-3/§3.1-4/§3.1-5。
// - Gantt 分段视图模型 = 设计 §3.1-2 语义规则①②③的输出形态（U5 派生函数与
//   U4 展示组件共用契约；派生实装落 renderer gantt-segments.ts，不在本包）。
//
// token 分项（设计 §3.1-4 投影扩展之一）经上方 WorkflowAgentCall 既有
// inputTokens/outputTokens/turns 三字段透出（runtime 投影消费 fold usage 分项填充），
// 不另设嵌套 usage 字段——同一信息禁止双轨。

// ── 大字段截断形态（§3.1-4 D4）────────────────────────────────

/**
 * 事件流 RPC 的大字段截断白名单（四个全文载荷字段，逐字对齐设计 §3.1-4 截断清单：
 * agent-started.input / agent-settled.result / run-created.scriptSource / run-created.args）。
 * 扩缩清单须先改设计表，再同步此处与 workflow-viz-protocol.test.ts 锚定集。
 */
export const WORKFLOW_RUN_EVENT_TRUNCATED_FIELDS = [
  'input',
  'result',
  'scriptSource',
  'args',
] as const

/** 截断白名单字段的联合（truncatedFields 数组元素的值域）。 */
export type WorkflowRunEventTruncatedField = (typeof WORKFLOW_RUN_EVENT_TRUNCATED_FIELDS)[number]

/**
 * 单字段截断阈值（字节，2KB——设计 §3.1-4）。截断实装（读 record 流后按字段
 * 序列化并按字节截断）归 U3 runtime 投影单元；实装侧消费本常量，禁止另立第二常量。
 * 消费方 = runtime workflow-run-events-reader 的 truncateUtf8ByBytes（U3 已实装）。
 */
export const WORKFLOW_RUN_EVENT_TRUNCATE_BYTES = 2048

// ── record 事件条目（事件流 RPC 行形态）────────────────────────

/**
 * record 事件类型全集（判别键，跟随 core WorkflowRunEvent 联合成员——权威源见
 * 本段头注释）。扩值同步链：core 词表 → 本元组 → WorkflowRunEventEntry 联合新
 * 成员。正向（元组含联合外值）由 satisfies 拦截；反向（联合加成员漏改元组）由
 * 下方覆盖编译锁拦截——同 WORKFLOW_RUN_OUTCOME_ALL 先例。
 */
export const WORKFLOW_RUN_EVENT_TYPES_ALL = [
  'run-created',
  'phase-started',
  'agent-started',
  'agent-retrying',
  'agent-settled',
  'phase-settled',
  'run-interrupted',
  'run-resumed',
  'run-settled',
  'worker-log',
] as const satisfies readonly string[]

/** record 事件类型联合（WorkflowRunEventEntry['type'] 的值域）。 */
export type WorkflowRunEventType = (typeof WORKFLOW_RUN_EVENT_TYPES_ALL)[number]

/**
 * 事件流条目公共信封（投影 core EventEnvelope）。
 *
 * ts = epoch ms（core 事件信封原样；注意与 WorkflowAgentCall 的 ISO 字符串不同源
 * ——事件流各帧 ts 是 Gantt 反推公式的输入，单位恒 epoch ms）。seq = 行级单调
 * 序号（可选 = W1 前旧格式行无 seq，core 读取面对缺失放行；消费方不得以 seq 存在
 * 性判数据新旧）。truncatedFields = 本行被截断的大字段名清单（缺省 = 无截断）；
 * 截断值仅供展示——任何恢复/重放/对账读面不得以截断载荷为数据源（设计 §3.1-4
 * D12 防误用边界：resume 的 $ARGS 恢复与 args 一致性校验在引擎侧读 record 原文
 * 全文字段，不经本通道）。
 */
export interface WorkflowRunEventEntryBase { // oe-exempt:20261002:framework:workflow-viz 协议契约类型——类型契约先行、单实现常态（shared 跨包消费，同 run-events.ts 先例）
  /** 墙钟时间戳（epoch ms，core 事件信封原样）。 */
  ts: number
  /** 行级单调序号（1 起严格递增；旧格式行缺失）。 */
  seq?: number
  /** 本行被截断的大字段名清单（缺省 = 无截断；值域 = 截断白名单四字段）。 */
  truncatedFields?: WorkflowRunEventTruncatedField[]
}

/**
 * `run-created` 条目（载荷跟随 core RunCreatedEvent；scriptSource/args 两字段为
 * 截断形态）。DAG 解析不经本通道（runtime 直读 record 首帧原文，不受截断影响）。
 */
export interface WorkflowRunCreatedEntry extends WorkflowRunEventEntryBase {
  type: 'run-created'
  /** run 唯一 id（全词表唯一携带 runId 的事件）。 */
  runId: string
  /** 脚本身份名（RunSpec.scriptName 同源）。 */
  workflowName: string
  /** 调用参数摘要（引擎写侧恒写的行内小摘要，原文透传不截断）。 */
  argsSummary: string
  /** 调用参数全文的截断值（record 原文为对象——本值 = JSON 序列化文本的前缀；截断后不完整，禁止 parse 消费）。 */
  args?: string
  /** run 级 model 引用（缺省 = 继承主 agent 模型）。 */
  model?: string
  /** 脚本源全文的截断值（原文为脚本文本——本值为其字节前缀；截断后不完整）。 */
  scriptSource?: string
  /** 脚本文件所在目录路径锚定（原样透传）。 */
  scriptPath?: string
  /** run 级时间预算上界 ms（仅创建时显式设置时携带）。 */
  budgetTimeMs?: number
  /** run 级 token 预算上界（仅创建时显式设置时携带）。 */
  budgetTokens?: number
}

/** `phase-started` 条目（phase 状态机转移记录）。 */
export interface WorkflowRunPhaseStartedEntry extends WorkflowRunEventEntryBase {
  type: 'phase-started'
  /** phase 名（脚本 `phase(name)` 实参字符串化）。 */
  phase: string
}

/** `agent-started` 条目（脚本 agent() 调用已派发）。 */
export interface WorkflowRunAgentStartedEntry extends WorkflowRunEventEntryBase {
  type: 'agent-started'
  /** call 关联键（与 agent-retrying/agent-settled 全链共享；对齐 AgentCall.id）。 */
  taskIndex: number
  /** agent 身份名。 */
  agentName: string
  /** 尝试序号（1 起）。 */
  attempt: number
  /** 剧本 phase 归属（call 归属快照；未标注剧本缺省——缺省即无归属，不造键）。 */
  phase?: string
  /** 绑定的子代理 record id（成员复用续写携带；首派缺省）。 */
  memberRecordId?: string
  /** 入参全文的截断值（record 原文本为 canonical JSON 文本——本值为其前缀；截断后禁止 parse 消费）。 */
  input?: string
}

/** `agent-retrying` 条目（失败尝试后将退避重试——重试轨迹的原始对账出口）。 */
export interface WorkflowRunAgentRetryingEntry extends WorkflowRunEventEntryBase {
  type: 'agent-retrying'
  /** call 关联键。 */
  taskIndex: number
  /** 刚失败的尝试序号（1 起；退避后序号 +1 再执行）。 */
  attempt: number
  /** 退避等待毫秒（指数退避）。 */
  backoffMs: number
  /** 重试原因摘要（失败分类或错误文案摘要）。 */
  reason: string
}

/** `agent-settled` 条目（call 终局）。 */
export interface WorkflowRunAgentSettledEntry extends WorkflowRunEventEntryBase {
  type: 'agent-settled'
  /** call 关联键。 */
  taskIndex: number
  /** 终局尝试的序号（1 起）。 */
  attempt: number
  /** call 终局形态（实际值域 = done/failed/cancelled——time_limited 为 run 级、interrupted 已移出）。 */
  outcome: WorkflowRunOutcome
  /** 失败时的结构化编码（成功/取消缺省；agent 级取值 = failureKind 族）。 */
  errorCode?: string
  /** 终局尝试的墙钟耗时毫秒。 */
  durationMs: number
  /** 失败时子进程 stderr tee 文件路径（诊断引用，与 errorCode 一起落账）。 */
  stderrTeePath?: string
  /** 结果全文的截断值（record 原文为结果对象——本值 = JSON 序列化文本的前缀；截断后禁止 parse 消费）。 */
  result?: string
}

/** `phase-settled` 条目（phase 内全部 call 落定的转移记录）。 */
export interface WorkflowRunPhaseSettledEntry extends WorkflowRunEventEntryBase {
  type: 'phase-settled'
  /** phase 名。 */
  phase: string
}

/** `run-interrupted` 条目（中断转移记录——中断非终局，可经 run-resumed 复活）。 */
export interface WorkflowRunInterruptedEntry extends WorkflowRunEventEntryBase {
  type: 'run-interrupted'
  /** 中断来源标记（承载于 errorCode 字段）。 */
  errorCode?: string
  /** 中断原因摘要（可缺省）。 */
  reason?: string
}

/** `run-resumed` 条目（interrupted → running 的复活转移记录）。 */
export interface WorkflowRunResumedEntry extends WorkflowRunEventEntryBase {
  type: 'run-resumed'
  /** resume 锚点摘要（可缺省）。 */
  reason?: string
  /** 宿主标识（跨进程锁胜出方语境，可缺省）。 */
  host?: string
  /** 本次复活实际生效的时间预算上界 ms（可缺省 = 不限时或旧格式帧）。 */
  budgetTimeMs?: number
  /** 本次复活实际生效的 token 预算上界（可缺省 = 不限制或旧格式帧）。 */
  budgetTokens?: number
}

/** `run-settled` 条目（run 终局，一个 run 恰好一帧）。 */
export interface WorkflowRunSettledEntry extends WorkflowRunEventEntryBase {
  type: 'run-settled'
  /** 终局形态（四值词表 = WorkflowRunOutcome）。 */
  outcome: WorkflowRunOutcome
  /** 失败时的结构化编码（done/cancelled/time_limited 缺省）。 */
  errorCode?: string
  /** 终局原因摘要（干净完成可缺省）。 */
  reason?: string
  /** 产物目录指针（run 持久化产物所在目录绝对路径）。 */
  artifactsDir: string
}

/** `worker-log` 条目（worker 诊断日志帧——不参与生命周期状态机的诊断面）。 */
export interface WorkflowRunWorkerLogEntry extends WorkflowRunEventEntryBase {
  type: 'worker-log'
  /** 诊断条目（与 core WorkerLogEntry 同形：level 词表 log/warn/error/info）。 */
  entry: { level: 'log' | 'warn' | 'error' | 'info'; message: string }
}

/**
 * record 事件流条目判别联合（事件流 RPC 的行形态；判别键 = type，10 成员跟随
 * core WorkflowRunEvent 词表）。大字段截断语义见各成员注释与信封
 * truncatedFields——四个全文载荷字段（input/result/scriptSource/args）在本协议
 * 形态中恒为文本截断值（对象字段 = JSON 序列化文本前缀），被截断者由
 * truncatedFields 逐行标注。
 */
export type WorkflowRunEventEntry =
  | WorkflowRunCreatedEntry
  | WorkflowRunPhaseStartedEntry
  | WorkflowRunAgentStartedEntry
  | WorkflowRunAgentRetryingEntry
  | WorkflowRunAgentSettledEntry
  | WorkflowRunPhaseSettledEntry
  | WorkflowRunInterruptedEntry
  | WorkflowRunResumedEntry
  | WorkflowRunSettledEntry
  | WorkflowRunWorkerLogEntry

/** 联合成员 type 键的提取（覆盖编译锁的输入）。 */
type WorkflowRunEventEntryTypeOf<T> = T extends { type: infer K } ? K : never

/**
 * 反向完备编译锁：WorkflowRunEventEntry 各成员的 type 联合 ⊆ 且 ⊇
 * WORKFLOW_RUN_EVENT_TYPES_ALL 值域。联合加成员漏改元组（或元组含联合外值）
 * 时本类型退化为错误信息元组，下行赋值 tsc 编译红。
 */
type _WorkflowRunEventEntryCoversAll = [
  WorkflowRunEventEntryTypeOf<WorkflowRunEventEntry>,
] extends [(typeof WORKFLOW_RUN_EVENT_TYPES_ALL)[number]]
  ? [(typeof WORKFLOW_RUN_EVENT_TYPES_ALL)[number]] extends [
      WorkflowRunEventEntryTypeOf<WorkflowRunEventEntry>,
    ]
    ? true
    : ['WORKFLOW_RUN_EVENT_TYPES_ALL 扩值须同步 WorkflowRunEventEntry 联合成员（值域跟随锚）']
  : ['WorkflowRunEventEntry 新成员的 type 须同步 WORKFLOW_RUN_EVENT_TYPES_ALL 元组（值域跟随锚）']

/**
 * 编译锁消费点（导出以通过 noUnusedLocals）：值恒 true 无运行期语义——类型才
 * 承重，词表与联合漂移时本赋值 tsc 红。同 WORKFLOW_RUN_OUTCOME_COVERAGE_LOCK 先例。
 */
export const WORKFLOW_RUN_EVENT_ENTRY_COVERAGE_LOCK: _WorkflowRunEventEntryCoversAll = true

// ── Gantt 分段视图模型（§3.1-2 语义规则①②③的输出形态；U5 派生函数与 U4 展示组件共用契约）──

/**
 * attempt 分段收束态。'running' = 未收束（含 run 停止截断的末段——停止着色归
 * 消费方按 run 级 status/outcome 派生，设计 §3.3-D9 单点实现；数据层未 settled
 * 恒投影 running 的现状语义在段级保持一致）。
 */
export type WorkflowGanttSegmentState = 'running' | 'done' | 'failed' | 'cancelled'

/**
 * call 级 attempt 分段（规则①输出形态）：失败 attempt 红段 → 退避空档（相邻段
 * 间隙，数据层不表达）→ 新 attempt 段。同 taskIndex 多帧 agent-started = 多执行
 * 代际（resume 重派以 run 级转移帧为显式边界；worker 崩溃重建重派无转移帧、新
 * started 帧即隐式边界），每代际独立分段、各代际段独立保留不相连（中断/崩溃
 * 空隙可见）。
 *
 * 起止反推（帧序级口径以实装采集 fixture 为准，设计 §3.1-2①）：首段起点 =
 * agent-started.ts；attempt N 失败终点 = retrying_N.ts − backoffMs、attempt N+1
 * 起点 = retrying_N.ts；终局段终点 = settled.ts；未收束段终点 = run 级转移帧 ts
 * （中断 = run-interrupted.ts、终局 = run-settled.ts）或崩溃旧代际 = 该代际最后
 * 一个该 taskIndex 自有的 agent-* 执行事实帧 ts（不锚到其他 call 的帧、不虚构
 * 精确值）。started 帧行缺失的 call 降级为不分段形态（本类型零产出，不判损坏）。
 */
export interface WorkflowGanttAttemptSegment {
  /** call 关联键（agent 事件载荷 taskIndex，全链共享）。 */
  taskIndex: number
  /** 执行代际（同 taskIndex 的第 N 帧 agent-started，1 起）。 */
  generation: number
  /** 尝试序号（段对应尝试的 attempt 载荷值，1 起）。 */
  attempt: number
  /** 段起点（epoch ms，反推公式见类型注释）。 */
  startTs: number
  /** 段终点（epoch ms；未收束段 = 各锚定规则终点）。 */
  endTs: number
  /** 段收束态（'running' = 未收束）。 */
  state: WorkflowGanttSegmentState
}

/**
 * phase 级色带段（规则②输出形态）：每帧 phase-started 各开一段区间、各段独立
 * 绘制不相连。段终点 = 本轮 phase-settled.ts；无 settled 帧 = 本段之后第一个
 * phase 级或 run 级转移帧 ts（含重落 phase-started / run-interrupted /
 * run-settled；run 未终局如实显示进行中）。
 */
export interface WorkflowGanttPhaseBand {
  /** phase 名。 */
  phase: string
  /** 段起点（本段 phase-started 帧 ts）。 */
  startTs: number
  /** 段终点（收束锚定规则见类型注释）。 */
  endTs: number
  /**
   * 重放空段判定结果（判据 = 该 phase 名下事件流历史存在 agent 事件 ∧ 本段区间
   * 零 agent 事件；true = 重放空段——消费方不绘制、不计轮次）。纯脚本 phase
   * （全历史零 agent 事件）不受空段规则约束，本标记恒 false——其全部段为脚本
   * 执行段、按斜纹绘制。有 call 的 phase 的零派发轮与重放段在事件流上不可区分，
   * 统一按空段处理（零派发的用户可见表达由 DAG 节点 skipped 态承载）。
   */
  emptyReplay: boolean
  /** 段收束态（'running' = 无 settled 帧且无转移帧锚定收束；run 未终局如实进行中）。 */
  state: 'running' | 'settled'
}

/**
 * phase tab 头卡视图（规则③输出形态）：跨轮聚合区间 + 轮次计数 + 状态。不展示
 * 单一聚合耗时（聚合区间含轮间中断空隙，与 run header「中断停走」口径分立）。
 */
export interface WorkflowGanttPhaseCard {
  /** phase 名。 */
  phase: string
  /** 跨轮聚合区间起点（首轮 phase-started ts）。 */
  startTs: number
  /** 跨轮聚合区间终点（末轮收束 ts）。 */
  endTs: number
  /** 轮次计数 = 该 phase 的非空段段数（phase-started 帧数 ≠ 轮次数；纯脚本 phase 段数即轮数）。 */
  turnCount: number
  /** 状态（推导源 = ② 的最新非空段收束态：未收束 = 'running'、收束 = 'settled'，不另设推导）。 */
  state: 'running' | 'settled'
  /** 纯脚本 phase（全历史零 agent 事件——色带斜纹标注依据；涵盖「有调用点但全程零派发」的 phase）。 */
  scriptOnly: boolean
}

/**
 * Gantt 分段视图模型容器（gantt-segments 派生函数输出形态）。全部数据源 = 事件流
 * RPC（session.getWorkflowRunEvents）单次拉取结果，不经 getWorkflows（设计 §3.1-2
 * ——事件流子页与 Gantt 子页共享同一次拉取）。
 */
export interface WorkflowGanttSegments {
  /** call 级 attempt 分段（代际间不相连；按 taskIndex/generation/attempt 排序由消费方自定）。 */
  attemptSegments: WorkflowGanttAttemptSegment[]
  /** phase 级色带段（含重放空段——消费方按 emptyReplay 判定结果决定绘制；轮次计数只数非空段）。 */
  phaseBands: WorkflowGanttPhaseBand[]
  /** phase 头卡视图（每 phase 一行）。 */
  phaseCards: WorkflowGanttPhaseCard[]
}

// ── DAG 静态解析产物（§3.1-3；解析器落 subagent-core，经 session.getWorkflowDag 透出）──

/**
 * DAG 节点类型：agent 调用点 | 脚本门禁步骤。'script-step' 为协议预留值——v1 解析器
 * 恒产 'agent'（脚本门禁步骤是普通 JS 语句、无独立调用语法，静态解析无从识别；core
 * 解析器头注释已登记该理由），消费侧按前向兼容枚举值处理。
 */
export type WorkflowDagNodeKind = 'agent' | 'script-step'

/**
 * DAG 节点（调用点）：静态蓝图最小单元。动态模板名保留模板形态（如
 * reviewer-<维度>-a<n>-r<轮>），运行时实例经 agent-started 事件的 agentName/
 * phase/taskIndex 按「先 phase 后模板正则」两级判据挂接（设计 D2）。
 */
export interface WorkflowDagNode { // oe-exempt:20261002:framework:workflow-viz 协议契约类型——类型契约先行、单实现常态（shared 跨包消费，同 run-events.ts 先例）
  /** 节点 id（解析器生成，图内唯一——边/并行组/循环的引用键）。 */
  id: string
  /** 调用点类型。 */
  kind: WorkflowDagNodeKind
  /** 模板名（description 表达式的模板形态：字面段原样、变量段记通配段）。 */
  templateName: string
  /**
   * 实例匹配正则源文本（「字面段精确 + 变量段通配」；字面段按正则字面量转义，
   * 防实例名含 `+`/`(` 等字符时误匹配；description 非静态表达式时整段通配）。
   * new RegExp(matchPattern) 可编译。
   */
  matchPattern: string
  /** 归属 phase 名（未标注 phase 的调用点由解析器归入缺省分区）。 */
  phase: string
  /** 调用点行号（scriptSource 内 1-based）。 */
  line: number
}

/** DAG 边类型：顺序 | 数据流（上游输出注入下游 prompt）| 条件（触发谓词标注）| 循环回边。 */
export type WorkflowDagEdgeKind = 'sequence' | 'dataflow' | 'conditional' | 'loop-back'

/** DAG 边（节点间执行/数据关系）。 */
export interface WorkflowDagEdge { // oe-exempt:20261002:framework:workflow-viz 协议契约类型——类型契约先行、单实现常态（shared 跨包消费，同 run-events.ts 先例）
  /** 边 id（解析器生成，图内唯一）。 */
  id: string
  /** 源节点 id（WorkflowDagNode.id）。 */
  from: string
  /** 目标节点 id。 */
  to: string
  /** 边类型。 */
  kind: WorkflowDagEdgeKind
  /** 条件边触发谓词原文（kind='conditional' 时携带）。 */
  predicate?: string
}

/** phase 分区（DAG 画布背景分区的绘制序）。 */
export interface WorkflowDagPhase { // oe-exempt:20261002:framework:workflow-viz 协议契约类型——类型契约先行、单实现常态（shared 跨包消费，同 run-events.ts 先例）
  /** phase 名。 */
  name: string
  /** 分区序（0-based，绘制从左到右）。 */
  order: number
}

/** 并行组（同组调用点并行派发——parallel() 包裹的成员集合）。 */
export interface WorkflowDagParallelGroup { // oe-exempt:20261002:framework:workflow-viz 协议契约类型——类型契约先行、单实现常态（shared 跨包消费，同 run-events.ts 先例）
  /** 组内节点 id 集合。 */
  nodeIds: string[]
}

/** 循环标注（循环体与回边的关联结构——修复循环类 workflow 的结构表达）。 */
export interface WorkflowDagLoop { // oe-exempt:20261002:framework:workflow-viz 协议契约类型——类型契约先行、单实现常态（shared 跨包消费，同 run-events.ts 先例）
  /** 循环标注 id（解析器生成，图内唯一）。 */
  id: string
  /** 循环体节点 id 集合（按执行序）。 */
  nodeIds: string[]
  /** 循环回边 id（kind='loop-back' 的边——回边闭合循环体）。 */
  backEdgeId: string
  /** 循环条件/标签原文（可缺省）。 */
  label?: string
}

/**
 * Workflow DAG（脚本静态蓝图的解析产物）：节点/边/phase 分区/并行组/循环标注。
 * 零调用点 run（纯门禁脚本无 agent()）= nodes 空数组（渲染层出空画布 + 居中摘要
 * 提示「本脚本无 agent 调用点」，设计 §3.1-3）。解析失败不产半个错误 DAG——
 * fail-fast 返回结构化错误（session.getWorkflowDag 错误臂），本类型恒为完整产物。
 */
export interface WorkflowDag { // oe-exempt:20261002:framework:workflow-viz 协议契约类型——类型契约先行、单实现常态（shared 跨包消费，同 run-events.ts 先例）
  /** 调用点节点集（agent 调用点 + 脚本门禁步骤；零调用点 run 为空数组）。 */
  nodes: WorkflowDagNode[]
  /** 边集（顺序/数据流/条件/循环回边）。 */
  edges: WorkflowDagEdge[]
  /** phase 分区集（按 order 升序绘制）。 */
  phases: WorkflowDagPhase[]
  /** 并行组集。 */
  parallelGroups: WorkflowDagParallelGroup[]
  /** 循环标注集。 */
  loops: WorkflowDagLoop[]
}
