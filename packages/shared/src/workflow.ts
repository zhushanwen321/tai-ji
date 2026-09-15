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
 * 扩展源码：extensions/universal/subagent-workflow/src/orchestration/jsonl-run-store.ts
 */

/**
 * workflow run 状态机。
 *
 * 'paused' 是 legacy 读侧兼容值：wf-run-v2 快照（随一次性生命周期收窄）只产出
 * running/done 两态，且 runtime workflow-extractor 对 v1 三态快照一律跳过——该值
 * 实际不再出现。保留在联合中是因为 renderer（WorkflowList/WorkflowDetail/Sidebar
 * 的 `status === 'paused'` 分支与 Pause/Resume 按钮链路）仍引用它，移除需连带清理
 * renderer UI，待 renderer 侧 pause/resume 链路退役时一并删除。
 */
export type WorkflowRunStatus = 'running' | 'paused' | 'done'

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
  status: 'pending' | 'running' | 'completed' | 'failed'
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
}

/**
 * 单条 workflow run 记录（列表项 + 详情数据）。
 *
 * 字段来源对应关系（RunSnapshot → WorkflowRunRecord）：
 * - runId：RunSnapshot.runId（如 "wf-1783679279983-hlpc46"）
 * - scriptName/slug/description：RunSnapshot.spec（spec.scriptName / spec.slug / spec.description）
 * - status/reason：RunSnapshot.state（state.status / state.reason）
 * - startedAt/completedAt：RunSnapshot.meta（pausedAt 为 legacy 字段，v2 不产出）
 * - usedTokens/totalCallCount：RunSnapshot.state.budget
 * - agentCalls：RunSnapshot.state.trace[] 逐项映射
 * - stateFilePath：主 session JSONL 的 workflow-state-link.data.path
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
  /** 暂停时间 ISO（legacy：wf-run-v2 快照无 paused 态，此字段不再产出，恒 undefined） */
  pausedAt?: string
  /** 已消耗 token（state.budget.usedTokens） */
  usedTokens?: number
  /** agent call 总数（state.budget.totalCallCount） */
  totalCallCount?: number
  /** agent call 列表（从 state.trace[] 映射） */
  agentCalls: WorkflowAgentCall[]
  /** workflow-state JSONL 绝对路径（workflow-state-link.data.path） */
  stateFilePath: string
}
