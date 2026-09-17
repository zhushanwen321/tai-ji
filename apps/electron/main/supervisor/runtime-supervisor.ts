/**
 * RuntimeSupervisor Facade（implements IRuntimeSupervisor）。
 *
 * 对应 spec §4.2 M2「Process Supervisor」。组合 5 个子职责模块：
 *   port-discoverer（端口探测 + stale kill）
 *   process-control（spawn / kill 进程树）
 *   health-checker（TCP 健康检查）
 *   port-file（端口文件持久化）
 *   restart-policy（崩溃重启策略，纯逻辑可单测）
 *
 * 这是「门面 + 协调者」模式：各子模块是纯函数/单一职责，Facade 负责串联
 * start/stop/restart 的完整时序，并持有 child/port 状态。
 *
 * [HISTORICAL] 不变量：
 * - start() 幂等：已有活进程则复用，不重复 spawn
 *   （实现时若 child 非空且未退出 exitCode===null，直接返回 this._port）
 * - start 完整时序：findAvailablePort → spawn → waitForHealth → writePortFile
 * - startAndNotify 消除 main.ts whenReady/activate 重复：spawn 成功发 'runtime-port'，失败发 'runtime-error'
 * - **崩溃自动重启**：onExit 回调检查 stopping 标志 → restart-policy 判定 → 退避后 start()
 *   - 主动 stop() 设 stopping=true，onExit 短路不重启
 *   - 重启用尽（MAX_RESTARTS）→ 广播 'runtime-failed'，等待用户手动重试
 *   - 重启成功 → 广播 'runtime-port'（所有窗口重连新端口）
 *   - 重启在途幂等：restartTimer 存在时不叠加（exit 事件可能重入）
 *
 * start 时序：
 * ```
 *   start():
 *     1. 若 child 活着 → return this._port（幂等）
 *     2. await stop()（先清旧的）
 *     3. port = await findAvailablePort()
 *     4. child = spawnRuntimeProcess(port, onExit)
 *     5. await waitForHealth(port)
 *     6. writePortFile(port)
 *     7. this._port = port; restartPolicy.recordSuccess(); return port
 * ```
 *
 * 依赖方向：runtime-supervisor → interfaces + 5 个子模块 + electron(BrowserWindow)
 */
import { BrowserWindow } from 'electron'
import type { ChildProcess } from 'node:child_process'
import type { IRuntimeSupervisor } from '../interfaces.js'
import { findAvailablePort, getPortOffset } from './port-discoverer.js'
import { spawnRuntimeProcess, stopRuntimeProcess } from './process-control.js'
import { waitForHealth } from './health-checker.js'
import { writePortFile } from './port-file.js'
import { RestartPolicy, MAX_RESTARTS } from './restart-policy.js'
import { LivenessMonitor, LIVENESS_FAIL_THRESHOLD } from './liveness-probe.js'
import { mainLogger } from '../logs/main-logger.js'
import { crashJournal } from '../logs/crash-journal.js'
// u7c（crash-forensics D5 ④）：planned 退出码 SSOT 在 shared（RUNTIME_PLANNED_EXIT_CODE）
// ——runtime 执行链（rolling-restart.ts）与 main 判别式双端消费；两进程依赖方向单向
// （main → runtime），runtime 无法 import 本侧符号，故 SSOT 落 shared。本模块导出面
// 不变（PLANNED_EXIT_CODE 转发，u1f 既有测试与消费方 import 点不受影响）。
import { RUNTIME_PLANNED_EXIT_CODE } from '@taiji/shared'

/**
 * 重启决策的触发源（杀链决策日志 D6-⑥ 的 trigger 字段）：
 * - process_exit：runtime 意外退出（onRuntimeExit 崩溃路径）
 * - liveness_unhealthy：存活探针判死半活进程（forceRestartForLiveness）
 * - restart_failure：上一次重启尝试未达健康态（handleRestartFailure 递归）
 */
type SupervisorRestartTrigger = 'process_exit' | 'liveness_unhealthy' | 'restart_failure' | 'planned_rolling_restart'

/** 重启决策日志的上下文字段（target/exitCode 随触发路径可得性不同，缺省省略）。 */
interface RestartDecisionContext {
  /** 触发本轮重启的 runtime pid（exit/kill 时刻捕获——onRuntimeExit 已清 child，必须提前取） */
  pid?: number
  /** runtime 退出码（process_exit 路径；null=信号杀死） */
  exitCode?: number | null
}

/**
 * 重启决策 reason 句子表（按 trigger 查——决策日志的「为什么」字段，对齐 u5b
 * kill decision 的 reason 判据句形态：可机械回答归因，不写自由文本）。
 */
const RESTART_DECISION_REASONS: Record<SupervisorRestartTrigger, string> = {
  process_exit: 'runtime exited unexpectedly (exitCode in context); exponential backoff restart per policy (1-16s, MAX_RESTARTS=5)',
  liveness_unhealthy: 'half-alive process force-killed by liveness probe; backoff restart per policy',
  restart_failure: 'previous restart attempt failed to reach healthy state; continue backoff sequence',
  planned_rolling_restart: 'runtime exited with planned rolling-restart code (86); immediate restart with zero backoff and no crash count (design D5)',
}

// ── 崩溃台账：runtime 自身死亡判别式（crash-forensics §3.3 D1 shutdown 行第四挂点群）──

/**
 * 滚动重启专用退出码（设计 D5；产生方 = runtime 滚动重启执行链，u7c 交付）。
 * main 侧是唯一在场消费者：runtime 被 SIGKILL 时自己写不了台账，supervisor 按此码
 * 识别 planned 退出。模块级导出供 u7c supervisor 侧接线（86→立即重启零退避）复用。
 *
 * u7c 起本常量是 shared `RUNTIME_PLANNED_EXIT_CODE` 的转发（SSOT 消除双 86 字面量，
 * 导出面不变）。
 */
export const PLANNED_EXIT_CODE = RUNTIME_PLANNED_EXIT_CODE

/** onRuntimeExit 台账分类结果（D1 runtime 自身事件三挂点 + 第四挂点的 exit 侧归宿）。 */
export type RuntimeExitJournalClass = 'planned-shutdown' | 'crash' | 'suppressed'

/**
 * runtime 退出分类判别式（crash-forensics D1 shutdown 行原文显式化，纯函数可单测）：
 *
 * **异常死亡 ⇔ 非 before-quit 上下文 且 退出码≠86 且 stopping=false**；三条件任一
 * 命中即不写 crash。逐条件依据：
 * - 86 优先 → planned-shutdown：专用退出码无论被谁观察到都是滚动重启计划内退出，
 *   识别写入点在此立起（86 的产生方 u7c 后续交付）。
 * - stopping → suppressed：stopping 被 stop() 全部调用方置位（app 退出 / liveness
 *   强杀共用），按 stopping 写 crash 会把每次正常退出记假 crash 污染归因 #3——
 *   app 退出的 exit 落本分支**不写任何行**（shutdown 行由 before-quit 上下文写），
 *   liveness 强杀的行在 forceRestartForLiveness 杀链发起处双写（exit 时无行可写）。
 * - appQuitting（before-quit 上下文）→ suppressed：防御纵深——标记与 stop() 置位
 *   stopping 之间理论存在窗口，任一条件独立兜住「不把正常退出记 crash」。
 */
export function classifyRuntimeExit(input: {
  exitCode: number | null
  stopping: boolean
  appQuitting: boolean
}): RuntimeExitJournalClass {
  if (input.exitCode === PLANNED_EXIT_CODE) return 'planned-shutdown'
  if (input.appQuitting || input.stopping) return 'suppressed'
  return 'crash'
}

/**
 * RuntimeSupervisor 实现。
 *
 * 使用方法：
 * ```ts
 * const supervisor = new RuntimeSupervisor()
 * const port = await supervisor.start()
 * await supervisor.startAndNotify(mainWindow)
 * await supervisor.stop()
 * ```
 */
export class RuntimeSupervisor implements IRuntimeSupervisor {
  private child: ChildProcess | null = null
  private _port: number | null = null
  /** 当前 runtime 的 WS auth token（S1-W1：spawn 时生成，随进程生命周期存续；stop/exit 清 null） */
  private _token: string | null = null
  /** 重启策略（纯逻辑，可单测） */
  private readonly policy = new RestartPolicy()
  /** 重启定时器（在途幂等：存在时不叠加新重启） */
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  /** 存活探针定时器（start 成功后启动，stop 时关闭） */
  private livenessMonitor: LivenessMonitor | null = null
  /**
   * before-quit 上下文标记（main.ts before-quit handler 置位）——classifyRuntimeExit
   * 判别式输入。stopping 被 stop() 全部调用方置位（app 退出/liveness 强杀共用），
   * 单看 stopping 无法区分「app 级退出」与「强杀」；本标记使两类上下文可区分
   * （crash-forensics D1 v6 第三挂点判别式显式化的配套输入）。
   */
  private appQuitting = false

  /** 当前监听端口（未启动为 null） */
  get port(): number | null {
    return this._port
  }

  /** 当前 runtime 的 WS auth token（未启动为 null）。renderer 经 get-runtime-token IPC 读取 */
  get token(): string | null {
    return this._token
  }

  /**
   * runtime 子进程在场性（main.ts before-quit 的 shutdown 行判据）：child 在且未退出。
   * before-quit 在 stop() 之前触发，此刻 child 大概率在场；runtime 未启动（mock）、
   * 已崩溃（onRuntimeExit 已清 child）、重启用尽等待手动重试等形态均为 false——
   * 这些形态写 runtime shutdown 行是假事件（runtime 并未发生「关闭」）。
   * 判活形态对齐 start()/restartRuntime() 的 exitCode===null 守卫（killed 不可靠的
   * [HISTORICAL] 教训）。
   */
  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  /**
   * 标记进入 app 级退出上下文（main.ts before-quit 调用；app 退出链不可逆，无复位面——
   * start() 的复位仅为防御万一，正常时序不会在标记后再 start）。
   */
  markAppQuitting(): void {
    this.appQuitting = true
  }

  /** 端口偏移量（dev 模式 +DEV_PORT_OFFSET），clamp 到合法范围 */
  get portOffset(): number {
    return getPortOffset()
  }

  /**
   * 启动 runtime（幂等）。
   *
   * 时序：if child 活着 → 复用 → stop（清旧）→ findAvailablePort → spawn → waitForHealth → writePortFile。
   * 重置 stopping 标志（从崩溃重启或用户手动重试进入时，清掉上次的 stopping）。
   *
   * @returns 实际监听的端口号
   */
  async start(): Promise<number> {
    // 重置停止标志（start 是新生命周期的开始，无论上次是崩溃还是主动 stop）
    this.policy.reset()
    // 同理复位 before-quit 上下文标记（防御性：正常时序 start 先于 before-quit，
    // 此处覆盖「标记后又有新 start」的非常规编排，防判别式误抑制真崩溃）
    this.appQuitting = false

    // 幂等：已有活进程则复用，不重复 spawn
    // [HISTORICAL] 用 exitCode===null 判活而非 !killed：自然崩溃时 killed 仍为 false，
    // 仅 exitCode 由 null 变为退出码。避免崩溃后守卫误判存活、返回死端口（应用假死）。
    if (this.child && this.child.exitCode === null && this._port !== null) {
      return this._port
    }
    // 先停掉已有的，等待其真正退出
    await this.stop()

    const port = await findAvailablePort()
    console.log(`[runtime] Starting on port ${port}`)
    const spawned = spawnRuntimeProcess(port, (code) => this.onRuntimeExit(code))
    this.child = spawned.child
    // S1-W1：持有本生命周期 token（spawnRuntimeProcess 已注入 env + 写 token 文件）
    this._token = spawned.token

    // [HISTORICAL] W5 改动 4：spawn 成功但 waitForHealth 可能失败（进程半活）。
    // 必须包 try-catch：失败时主动 stop() 清理半活 child，
    // 否则 child 引用残留 → 下次 start 幂等守卫误判存活 → 返回死端口（应用假死）。
    try {
      await waitForHealth(port)
    } catch (e) {
      console.error(`[runtime] waitForHealth failed on port ${port}, cleaning up half-alive child`)
      // 复用 stop()：它会 markStopping + kill 进程树 + 清 child/port
      // markStopping 让 onRuntimeExit 不触发自动重启（这里是 start 路径的清理，由调用方决定下一步）
      await this.stop()
      throw e
    }

    writePortFile(port)
    this._port = port
    // 重启成功 → 记录（稳定窗口后清零计数）
    this.policy.recordSuccess()
    // [HISTORICAL] 复位 stopping：上方 `await this.stop()`（清旧进程）曾 markStopping，
    // 成功启动后若不复位，运行期崩溃的 exit 会被 onRuntimeExit 误判「主动停止」短路
    // 自动重启，只能等 liveness 探针 30s×3 兜底（实测 68-91s 恢复延迟，Gate B AC-3b，
    // 日志特征：exit 137 后紧跟 "during graceful stop — no restart"）。start() 进行中
    // 保持 stopping=true 仍是对的（spawn 后 waitForHealth 期间 exit 由 start 自身失败
    // 路径处理，防双路重启）；此处成功落定即回到「可崩溃重启」态。
    this.policy.reset()

    // [HISTORICAL] W5 改动 3：启动存活探针，监测 runtime「半活」状态。
    // 探针在 stop() 时关闭，不会泄漏 timer。连续失败达阈值调 forceRestartForLiveness。
    this.livenessMonitor = new LivenessMonitor({
      port,
      onUnhealthy: () => { void this.forceRestartForLiveness() },
    })
    this.livenessMonitor.start()

    console.log(`[runtime] Ready on port ${port}`)
    return port
  }

  /**
   * 启动 runtime 并通知渲染进程端口。
   *
   * 成功：win.webContents.send('runtime-port', port)
   * 失败：win.webContents.send('runtime-error', { message })（不抛出）
   *
   * 消除 main.ts whenReady/activate 两处重复的 spawn + 通知逻辑。
   */
  async startAndNotify(win: BrowserWindow): Promise<number> {
    try {
      const port = await this.start()
      win.webContents.send('runtime-port', port)
      return port
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error(`[runtime] startAndNotify failed: ${message}`)
      win.webContents.send('runtime-error', { message })
      return 0
    }
  }

  /**
   * 手动重启 runtime（用户从「runtime 不可用」状态条点击重试时调）。
   *
   * 场景：崩溃后自动重启用尽，前端展示 runtime-failed 状态条 + 重试按钮。
   * 用户点击 → 前端调 restartRuntime IPC → 此方法。
   * - runtime 已存活：幂等，直接广播端口（用户误点）
   * - runtime 已死：重置策略计数，走 start()，成功广播端口，失败广播 failed
   */
  async restartRuntime(): Promise<void> {
    // runtime 存活 → 幂等，直接广播当前端口
    if (this.child && this.child.exitCode === null && this._port !== null) {
      console.log(`[runtime] restartRuntime: already running on ${this._port}, broadcast port`)
      this.broadcastToAllWindows('runtime-port', this._port)
      return
    }
    // 重置策略：手动重试给一个新的 5 次配额（清停止标志 + 计数）
    this.policy.clearForManualRestart()
    this.clearRestartTimer()
    await this.attemptRestart()
  }

  /**
   * 停止 runtime 进程树（SIGTERM → 等 → SIGKILL 残留）。
   *
   * 时序见 process-control.ts 的 [HISTORICAL] 注释。关键：先预记录后代 PID 再 SIGTERM。
   * 幂等：child 为空或已 killed 时直接 resolve。
   *
   * 标记 stopping=true：onExit 回调检查此标志，主动 stop 不触发崩溃重启。
   */
  async stop(timeoutMs?: number): Promise<void> {
    // 标记主动停止，阻止后续 onExit 触发重启
    this.policy.markStopping()
    // 取消在途的重启定时器（正在退避等待的重启不再执行）
    this.clearRestartTimer()
    // 关闭存活探针（避免 stop 后探针继续打无效端口）
    this.stopLivenessMonitor()
    await stopRuntimeProcess(this.child, timeoutMs)
    this.child = null
    this._port = null
    // token 随进程生命周期结束失效（下次 start 重新生成）
    this._token = null
  }

  /**
   * 强制重启「半活」进程（存活探针触发）。
   *
   * [HISTORICAL] W5 改动 3：runtime 进程未退出（exitCode===null）但 HTTP 服务卡死时，
   * 存活探针连续失败达阈值（LIVENESS_FAIL_THRESHOLD）后调用此方法。
   *
   * 关键不变量（避免重启竞态）：
   * 1. 先 markStopping：kill 触发的 exit 事件会被 onRuntimeExit 当崩溃 → 重复重启。
   *    提前 markStopping 让 onRuntimeExit 短路（视为主动停止，不重启）。
   * 2. 再 stop() kill 进程树 + 清状态（child/port=null）。
   * 3. 走 onRuntimeExit 走崩溃重启路径：scheduleRestart('crash') 编排退避重启。
   *    但因 markStopping 已设，onRuntimeExit 会短路——所以此处显式调 scheduleRestart。
   *
   * 注意：markStopping 后 scheduleRestart 的 shouldRestart() 会返回 false（stopping 短路）。
   * 因此 reset() 必须在 scheduleRestart 之前调用，清掉 stopping 标志让重启策略放行。
   * 顺序：markStopping → stop → reset（清 stopping）→ scheduleRestart。
   *
   * @returns Promise（异步 kill + 重启编排）
   */
  async forceRestartForLiveness(): Promise<void> {
    console.warn('[runtime] Liveness probe failed threshold — forcing restart of half-alive process')
    // 杀链决策日志（D6-⑥ 第三处「supervisor 重启决策」，u5b 同形态：
    // action/trigger/target/reason 字段化，经 main-logger 落盘 main-<date>.log）。
    // mainLogger 未 init（单测）时 no-op。pid 必须在 stop() 清 child 前捕获。
    const pid = this.child?.pid
    mainLogger.warn('[supervisor] kill decision', {
      action: 'supervisor_force_kill_halfalive',
      trigger: 'liveness_unhealthy',
      target: { pid },
      reason: 'process alive (exitCode null) but HTTP liveness probe failed threshold '
        + `(${LIVENESS_FAIL_THRESHOLD} consecutive times); killing process tree before backoff restart`,
    })
    // 崩溃台账双写（crash-forensics D1 第四挂点）：必须与 kill decision 同点在杀链
    // 发起处记——下方 markStopping 后，本强杀的 exit 落 onRuntimeExit 的 stopping
    // 早退分支无行可写（D1：按 stopping 写 crash 会把正常退出记假 crash，故该分支
    // 零写入），不在发起处记则 liveness 判死在台账永久缺席。
    crashJournal.append({ layer: 'runtime', event: 'unresponsive', reason: 'liveness-unhealthy' })
    // markStopping 防止 stop 触发的 exit 被 onRuntimeExit 当崩溃重复重启
    this.policy.markStopping()
    // kill 半活进程 + 清 child/port（不触发 onRuntimeExit 的重启逻辑）
    await this.stop()
    // 清 stopping 标志：后续 scheduleRestart 才能放行（shouldRestart 不再短路）
    this.policy.reset()
    // 走与崩溃相同退避/上限/广播编排
    this.scheduleRestart('crash', 'liveness_unhealthy')
  }

  /** 关闭存活探针（幂等：未启动则无操作） */
  private stopLivenessMonitor(): void {
    if (this.livenessMonitor) {
      this.livenessMonitor.stop()
      this.livenessMonitor = null
    }
  }

  /**
   * runtime 子进程退出处理（自然崩溃路径）。
   *
   * [HISTORICAL] 核心重启编排：
   * 1. 清 child/port（幂等守卫不再误判存活）
   * 2. stopping 检查（主动退出短路）
   * 3. restart-policy 判定（计数上限）
   * 4. 退避后 start()（重启在途幂等）
   * 5. 重启用尽 → 广播 runtime-failed
   *
   * @param code 子进程退出码（null=被信号杀死）
   */
  private onRuntimeExit(code: number | null): void {
    // 先捕获 pid 再清状态：杀链决策日志需要「谁死了」（u5b kill decision 的 target 语义）
    const pid = this.child?.pid
    // 清状态（幂等守卫据此判定无活进程）；token 随进程死亡失效（防旧 token 复用）
    this.child = null
    this._port = null
    this._token = null

    // 崩溃台账（crash-forensics D1：runtime 自身事件由 main 侧写——runtime 被 SIGKILL
    // 时自己写不了，supervisor 是唯一在场者）。分类判别式见 classifyRuntimeExit：
    // - planned-shutdown（exit 86）→ shutdown/planned；reason='planned' 是 schema 已知值
    // - crash → crash/process_exit；reason 用既有 SupervisorRestartTrigger 词（台账
    //   reason 为开放枚举，未登记进 shared KNOWN_REASONS——那是 u1a 领地，开放语义允许携带）
    // - suppressed（stopping / before-quit 上下文）→ 零写入：本分支覆盖 app 级正常退出
    //   与 liveness 强杀两类 exit（后者的行在 forceRestartForLiveness 杀链发起处）
    const verdict = classifyRuntimeExit({
      exitCode: code,
      stopping: this.policy.stopping,
      appQuitting: this.appQuitting,
    })
    if (verdict === 'planned-shutdown') {
      crashJournal.append({ layer: 'runtime', event: 'shutdown', reason: 'planned', exitCode: code })
    } else if (verdict === 'crash') {
      crashJournal.append({ layer: 'runtime', event: 'crash', reason: 'process_exit', exitCode: code })
    }

    // 主动停止：不重启（stop() 已 markStopping）
    if (this.policy.stopping) {
      console.log(`[runtime] Process exited (code ${code}) during graceful stop — no restart`)
      return
    }

    console.log(`[runtime] Process exited unexpectedly (code ${code}) — evaluating restart`)

    // 重启在途幂等：已有定时器则不叠加（exit 事件可能重入）
    if (this.restartTimer) {
      console.log('[runtime] Restart already scheduled — skip')
      return
    }

    // u7c（crash-forensics D5 ④）：planned 边（86）——滚动重启计划内退出走立即重启
    // 零退避零计数：policy.recordPlanned() 不进 counting 状态机、不做 shouldRestart 门
    // 检查（exhausted 态下滚动重启仍须照常重启）、延迟恒 0。重启成功后 start() 的
    // recordSuccess 按既有稳定窗口规则收敛 crash 计数。start() 失败则经 attemptRestart
    // → handleRestartFailure 回到既有退避路径（计划内重启失败 = 需要退避的异常形态）。
    if (verdict === 'planned-shutdown') {
      const delay = this.policy.recordPlanned()
      mainLogger.info('[supervisor] restart decision', {
        action: 'supervisor_restart',
        trigger: 'planned_rolling_restart',
        attempt: this.policy.count,
        delayMs: delay,
        target: { pid },
        exitCode: code,
        reason: RESTART_DECISION_REASONS.planned_rolling_restart,
      })
      this.broadcastToAllWindows('runtime-restarting', { attempt: this.policy.count })
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        void this.attemptRestart()
      }, delay)
      return
    }

    this.scheduleRestart('crash', 'process_exit', { pid, exitCode: code })
  }

  /**
   * 重启失败后处理（start() 抛错路径，不会触发 onExit）。
   * 递归走重启判定逻辑（计数已在上次 recordCrash 递增）。
   */
  private handleRestartFailure(): void {
    this.scheduleRestart('after failure', 'restart_failure')
  }

  /**
   * 统一重启编排：shouldRestart 门 → recordCrashAndGetDelay → 广播 'runtime-restarting'
   * → setTimeout(attemptRestart)。crash 路径（onRuntimeExit）与 after-failure 路径
   * （handleRestartFailure）共用，仅入口 reason 不同（日志区分）。
   *
   * 杀链决策日志（D6-⑥）：每个分支一条结构化行（action/trigger/target/reason 字段化，
   * 对齐 u5b reap-orphan-pi 的 kill decision 形态），经 main-logger 落盘——E2 型事件
   * 归因时可在 main-<date>.log 回答「谁触发、重启/放弃第几次、为什么」。
   *
   * 行为不变量（与重构前逐字一致）：
   * - shouldRestart=false → 广播 'runtime-failed'（attempts + 中文 message）后返回
   * - 延迟由 policy.recordCrashAndGetDelay 给出（指数退避，计数递增）
   * - 广播 'runtime-restarting' { attempt }（前端进 restarting 态）
   * - attemptRestart 成功广播 'runtime-port'，失败递归 handleRestartFailure
   */
  private scheduleRestart(
    reason: 'crash' | 'after failure',
    trigger: SupervisorRestartTrigger,
    context: RestartDecisionContext = {},
  ): void {
    if (!this.policy.shouldRestart()) {
      console.error(`[runtime] Restart attempts exhausted (${this.policy.count}). Broadcasting runtime-failed.`)
      mainLogger.warn('[supervisor] restart decision', {
        action: 'supervisor_restart_abandon',
        trigger,
        attempts: this.policy.count,
        target: { pid: context.pid },
        reason: `restart attempts exhausted (MAX_RESTARTS=${MAX_RESTARTS}); broadcasting runtime-failed, waiting for manual retry`,
      })
      this.broadcastToAllWindows('runtime-failed', {
        attempts: this.policy.count,
        message: `runtime 崩溃后已重试 ${this.policy.count} 次仍失败`,
      })
      return
    }
    const delay = this.policy.recordCrashAndGetDelay()
    const attempt = this.policy.count
    console.log(`[runtime] Restart attempt ${attempt} scheduled in ${delay}ms${reason === 'after failure' ? ' (after failure)' : ''}`)
    mainLogger.info('[supervisor] restart decision', {
      action: 'supervisor_restart',
      trigger,
      attempt,
      delayMs: delay,
      target: { pid: context.pid },
      exitCode: context.exitCode,
      reason: RESTART_DECISION_REASONS[trigger],
    })
    this.broadcastToAllWindows('runtime-restarting', { attempt })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.attemptRestart()
    }, delay)
  }

  /**
   * 执行一次重启尝试（start + 广播端口 / 失败递归 handleRestartFailure）。
   * 从 handleRestartFailure 和手动重试（restartRuntime）共用。
   */
  private async attemptRestart(): Promise<void> {
    try {
      const newPort = await this.start()
      console.log(`[runtime] Restart succeeded on port ${newPort}`)
      this.broadcastToAllWindows('runtime-port', newPort)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error(`[runtime] Restart failed: ${message}`)
      this.handleRestartFailure()
    }
  }

  /** 清除在途重启定时器 */
  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  /**
   * 广播事件到所有存活窗口（复用 broadcastWindowList 模式）。
   * 不存窗口引用（避免悬垂），每次实时 getAllWindows + isDestroyed 守卫。
   */
  private broadcastToAllWindows(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    }
  }
}
