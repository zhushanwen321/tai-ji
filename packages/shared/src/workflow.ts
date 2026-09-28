/**
 * Workflow 数据模型 —— 从主 session JSONL 的 workflow-state-link entry 提取。
 *
 * 数据来源：pi-subagent-workflow 扩展注册的 `workflow` tool。主 agent 调用该 tool
 * (action=run) 时，扩展在独立 worker 线程执行 workflow run。
 *
 * workflow run 的状态持久化在 `<sessionDir>/workflow-state/<runId>.jsonl`（单行
 * RunSnapshot，rewrite mode）。主 session JSONL 里通过 pi.appendEntry 写入
 * `workflow-state-link` custom entry 指向 state 文件路径。
 *
 * runtime 的 workflow-extractor 从主 session JSONL 提取 workflow-state-link，
 * 读 path 指向的 state 文件，映射 RunSnapshot → WorkflowRunRecord[]。
 *
 * RunSnapshot 格式版本：`wf-run-v2`（D-5 版本守卫，v1 旧格式跳过——extension 侧
 * 声明的接受边界，旧 run 历史价值低，不做兼容迁移）。
 * 扩展源码：extensions/universal/subagent-workflow/src/jsonl-run-store.ts
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
 * workflow 内的单个 agent call（从 RunSnapshot.state.trace[] 映射）。
 *
 * trace 节点是 workflow run 的执行追踪——每个节点代表一次 agent 调用，
 * 含 agent 名/phase/model/sessionId/用量/耗时/状态。
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
   * [P3/D6] 该 ask 最近一次事件边沿的墙钟时间（epoch ms；RunSnapshot.state.calls[]
   * 按 id 关联合并，事件 journal fold 投影）。可缺省——旧快照无此字段，消费侧缺省
   * 渲染（时长槽/停滞判定省略）。
   */
  lastProgressAt?: number
}

/**
 * [P3/D6] run 终局形态（RunSnapshot.state.outcome，事件 journal fold 投影）。
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
 * 字段来源对应关系（RunSnapshot → WorkflowRunRecord）：
 * - runId：RunSnapshot.runId（如 "wf-1783679279983-hlpc46"）
 * - scriptName/slug/description：RunSnapshot.spec（spec.scriptName / spec.slug / spec.description）
 * - status/reason：RunSnapshot.state（state.status / state.reason）
 * - startedAt/completedAt：RunSnapshot.meta
 * - usedTokens/totalCallCount：RunSnapshot.state.budget
 * - agentCalls：RunSnapshot.state.trace[] 逐项映射（[P3/D6] 并按 id 合并 state.calls[]
 *   的 lastProgressAt 投影字段）
 * - stateFilePath：v2 = 注册条目 journalPath（run 事件 journal 锚——详情面板「run
 *   关联持久化文件」展示位）；v1 快照路径恒 ''（workflow-extractor 对空串隐藏）
 */
export interface WorkflowRunRecord {
  /** run 唯一标识（RunSnapshot.runId） */
  runId: string
  /** 脚本名（spec.scriptName） */
  scriptName: string
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
  /** state 路径：v2 = 注册条目 journalPath（详情面板「run 关联持久化文件」展示位）；v1 快照恒 ''（对空串隐藏） */
  stateFilePath: string
  /**
   * [P3/D6] run 级 health（RunSnapshot.state.health，事件 journal fold 投影）。
   * 仅 lastProgressAt 单字段；stalledSince 由消费侧 lastProgressAt + 阈值推导。
   * 可缺省——旧快照无此字段，消费侧按 unknown 处理（不判定停滞）。
   */
  health?: { lastProgressAt: number }
  /** [P3/D6] 终局形态（state.outcome；仅终局后快照携带）。 */
  outcome?: WorkflowRunOutcome
  /** [P3/D6] 终局结构化错误码（state.errorCode，failed 终局携带）。 */
  errorCode?: string
}
