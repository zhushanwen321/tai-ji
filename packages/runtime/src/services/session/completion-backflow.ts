/**
 * CompletionBackflow — 子 session（agent-managed）完成/失败后结果自动回流父 session（sd-u6，G2）。
 *
 * 检测点（design.md §5 已核实）：
 * - 完成信号 = agent_settled（run 级联结束；子 session 跑完任务后 pi 进程常驻 idle，「完成」≠进程退出）
 *   ——经组合根 agentSettledListeners 多播订阅（session-delivery-registry 同一注入点的另一订阅者）
 * - 失败信号 = 进程 exit（ProcessManager.onSessionExit，code/stderr 可得）——pi 死了也要通知父 agent
 *
 * 回流条件：session 内存态 spawnSource==='agent' && parentAgentSessionId（session-lifecycle 打标，
 * 本模块只读不写）。无父 id 的 agent session / 非 agent session 完成不回流（跳过）。
 *
 * 投递形态：一期纯 text（design.md D5/D9），复用 sd-u5 的 SessionDeliveryRegistry sessionId 单例
 * 注册表——同一父 session 的 send 排队（U5）与完成回流（U6）必须同一 handle（§3.4 单例约束，
 * 多 handle 并发投递竞态无保护）。父 idle → prompt(streamingBehavior) 主动唤醒开新 turn；
 * 父 streaming → steer 入队 turn 边界注入（由 delivery 内核 gate 处理，本模块只声明投递意图）。
 *
 * 订阅顺序约束（组合根接线必须遵守）：subscribeSessionExit 的注册必须先于 SessionService
 * constructor 内的 exit 清理腿（removeSessionEntry 删 session 内存态）——否则 exit 事件到达时
 * getSession 查不到 spawnSource/parentAgentSessionId，失败回流静默失效。
 */
import type { DeliveryHandle } from '@zhushanwen/session-delivery'
import type { IManagedSessionView } from './types.js'

/** 回流通知的 status 值域（以运行时可得的标志为准，语义在测试中固化）：
 *  - settled 路径：session_end outcome 映射（'error'→failed / 'stopped'→stopped / done|null→completed）
 *  - exit 路径：恒 'exited' */
export type BackflowStatus = 'completed' | 'failed' | 'stopped' | 'exited'

/** session_end outcome（session-store 写入）→ 回流 status 映射 */
function outcomeToStatus(outcome: 'done' | 'error' | 'stopped' | null): BackflowStatus {
  if (outcome === 'error') return 'failed'
  if (outcome === 'stopped') return 'stopped'
  return 'completed'
}

/** stderr 摘要上限（截尾，诊断价值 > 完整性；防 stderr 爆量撑爆通知文案） */
const STDERR_TAIL_LIMIT = 400

export interface CompletionBackflowDeps {
  /** 读 session 运行时内存态（spawnSource/parentAgentSessionId/label/sessionFilePath） */
  getSession(sessionId: string): IManagedSessionView | undefined
  /** agent_settled 多播订阅（组合根 agentSettledListeners；返回退订函数） */
  subscribeAgentSettled(cb: (sessionId: string) => void): () => void
  /** 进程 exit 订阅（ProcessManager.onSessionExit；返回退订函数）。须先于 SessionService 清理腿注册 */
  subscribeSessionExit(cb: (sessionId: string, code: number | null, stderr: string) => void): () => void
  /** 读 session_end 终态（settled 前 turn-end 副作用已写入；无 session_end entry 返回 null） */
  getSessionOutcome(sessionFilePath: string): 'done' | 'error' | 'stopped' | null
  /** 父 session 的 delivery handle（sd-u5 注册表；同父 session 与 send 排队共用单例） */
  getDelivery(parentSessionId: string): DeliveryHandle
}

export interface CompletionBackflow {
  dispose(): void
}

/** agent-managed 子 session 的回流判定材料（从 IManagedSessionView 的扩展字段读，session-lifecycle 打标） */
interface AgentManagedMarker {
  label: string
  parentAgentSessionId: string
  sessionFilePath: string | undefined
}

/** 读打标；非 agent-managed（无父 id / 非 agent 来源 / session 不存在）返回 undefined */
function readMarker(session: IManagedSessionView | undefined): AgentManagedMarker | undefined {
  if (!session) return undefined
  const { spawnSource, parentAgentSessionId } = session as {
    spawnSource?: 'user' | 'agent'
    parentAgentSessionId?: string
  }
  if (spawnSource !== 'agent' || !parentAgentSessionId) return undefined
  return {
    label: session.label,
    parentAgentSessionId,
    sessionFilePath: session.sessionFilePath,
  }
}

/**
 * 构造回流通知文案（对齐 notifier buildLlmContent 模式：label/status + sessionFile 指针行）。
 *
 * settled：`Managed session "<label>" (<sid>) finished with status "<status>".` + 指针行
 * exit：首行附加 `(exit code: N)`，stderr 非空时追加 `Stderr: <tail>` 行
 * sessionFile 缺失（pi 延迟写入窗口崩溃）时省略整条 `Full transcript:` 行（notifier 同款约定）。
 */
export function buildBackflowContent(params: {
  label: string
  sessionId: string
  status: BackflowStatus
  sessionFilePath?: string
  exitCode?: number | null
  stderrTail?: string
}): string {
  const exitNote = params.exitCode !== undefined
    ? ` (exit code: ${params.exitCode ?? 'null'})`
    : ''
  let content = `Managed session "${params.label}" (${params.sessionId}) finished with status "${params.status}"${exitNote}.`
  if (params.stderrTail && params.stderrTail.trim() !== '') {
    const tail = params.stderrTail.length > STDERR_TAIL_LIMIT
      ? params.stderrTail.slice(-STDERR_TAIL_LIMIT)
      : params.stderrTail
    content += `\nStderr: ${tail.trim()}`
  }
  if (params.sessionFilePath) {
    content += `\nFull transcript: ${params.sessionFilePath}`
  }
  return content
}

export function createCompletionBackflow(deps: CompletionBackflowDeps): CompletionBackflow {
  /** 投递回流通知（send 是内核 never-throw 常规入口：父 busy 由内核排队，port 失败由内核重试消化） */
  const backflow = (
    sessionId: string,
    marker: AgentManagedMarker,
    status: BackflowStatus,
    extra?: { exitCode?: number | null; stderrTail?: string },
  ): void => {
    const content = buildBackflowContent({
      label: marker.label,
      sessionId,
      status,
      sessionFilePath: marker.sessionFilePath,
      ...extra,
    })
    deps.getDelivery(marker.parentAgentSessionId).send({ payload: { kind: 'text', content } })
  }

  // 完成回流：agent_settled（run 级联结束）→ 查打标 → outcome 映射 status → 投父
  const unsubSettled = deps.subscribeAgentSettled((sessionId) => {
    const marker = readMarker(deps.getSession(sessionId))
    if (!marker) return
    const status = marker.sessionFilePath
      ? outcomeToStatus(deps.getSessionOutcome(marker.sessionFilePath))
      : 'completed'
    backflow(sessionId, marker, status)
  })

  // 失败回流：进程 exit → 查打标 → status 'exited'（含退出码/stderr 摘要）→ 投父。
  // 多条 run 多次回流是 settled 腿的语义；exit 腿天然只触发一次（进程随之死亡）。
  const unsubExit = deps.subscribeSessionExit((sessionId, code, stderr) => {
    const marker = readMarker(deps.getSession(sessionId))
    if (!marker) return
    backflow(sessionId, marker, 'exited', { exitCode: code, stderrTail: stderr })
  })

  return {
    dispose() {
      unsubSettled()
      unsubExit()
    },
  }
}
