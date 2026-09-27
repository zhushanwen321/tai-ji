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
 * workflow run 状态机（一次性生命周期，subagent-workflow D-2：pause/resume 已移除，
 * 提前停止唯一方式 = abort）。wf-run-v2 快照只产出 running/done 两态。
 * [2026-09-16] 'paused' legacy 值随 renderer 侧 Pause/Resume 按钮链路退役一并删除
 * （composer 任务托盘验收发现死按钮链，修复对齐扩展语义）。
 */
export type WorkflowRunStatus = 'running' | 'done'

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
 */
export type WorkflowRunOutcome = 'completed' | 'failed' | 'cancelled'

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
  /** 已消耗 token（state.budget.usedTokens） */
  usedTokens?: number
  /** agent call 总数（state.budget.totalCallCount） */
  totalCallCount?: number
  /** agent call 列表（从 state.trace[] 映射） */
  agentCalls: WorkflowAgentCall[]
  /** workflow-state JSONL 绝对路径（workflow-state-link.data.path） */
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
