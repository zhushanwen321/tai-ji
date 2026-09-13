/**
 * BackgroundTaskService — 后台任务侧边栏视图的数据服务（runtime 直读 registry SSOT，
 * D1/D2/D6/D7/D8 —— docs/design/background-task-sidebar-view.md §3.3）。
 *
 * 职责（u-runtime-svc）：
 *  - registry 读：`<getPiAgentDir()>/base-tool-enhance/<sid>/registry.json`（损坏 →
 *    corrupt 语义：空表 + 错误标记，不 throw；垃圾 sid ENOENT 静默空表）
 *  - 变更检测（D2，三触发面共享同一 last-seen mtime 判定，单广播源）：
 *      ① 2s mtime 轮询（变化才重读+广播）；
 *      ② pi 事件钩子（event-adapter 旁路转发，u-runtime-rpc 组合根接线到
 *         checkForChanges）触发对 watched 集合的一次完整变更检测；
 *      ③ service 自写自检（kill 的预写/终态写成功后自触发，killing 即时广播不占轮询节拍）。
 *    广播回调以注入形式提供（onTasksChanged(sessionId)），本单元不接 message-bus
 *    （u-runtime-rpc 负责把回调接到 session 级 publish + 数据组装）。
 *  - kill 五分支矩阵（D6 表格逐行）+ 身份验证两档 + 锁 `<registry.json>.lock`
 *    proper-lockfile RMW（与 extension/reaper 写侧互斥同一把锁），判活重查置于锁内
 *    重读之后。
 *  - output tail：从文件末尾按字节窗口读（output-tail.ts，默认 32KB）。
 *  - watched 集合生命周期（D8③）：markWatched/unwatch；RPC 接线（list 加入 watched、
 *    session 销毁退订）在 u-runtime-rpc。
 *
 * 测试接缝：pid 探测/处置原语依赖注入（对齐 reaper BackgroundTaskReapDeps 惯例，
 * 零真实进程可测）；piAgentDir 可注入（测试红线：禁触真实数据目录）。
 */

import { statSync } from 'node:fs'
import {
  isTerminalBackgroundTaskState,
  type BackgroundTaskRegistryEntry,
} from '@xyz-agent/extension-protocol'
import {
  isPidAlive,
  killProcessTree,
  pidStartMatchesRegistered,
  type ProcessFallbackLogger,
} from '../../utils/protocol-background-task.js'
import { getPiAgentDir } from '../../infra/pi/pi-paths.js'
import {
  getSessionRegistryPath,
  readRegistryEntriesWithStatus,
  writeOrphanedTerminal,
  writeOrphanedTerminalLocked,
} from '../session/background-task-reaper.js'
import { withFileLockSync } from '../../utils/file-lock.js'
import { writeExitedTransitionalLocked, writeKillingStateLocked } from './registry-write.js'
import { probeProcessStartTimeMs } from './process-probe.js'
import {
  OUTPUT_TAIL_DEFAULT_MAX_BYTES,
  OUTPUT_TAIL_MAX_LINES,
  readOutputTail,
  type OutputTailResult,
} from './output-tail.js'

const LOG_TAG = '[bg-task-service]'

/** 进程原语回退路径诊断的 console 适配（protocol onFallback → runtime console 通道；对齐 reaper 同款注入形态）。 */
const processFallbackLog: ProcessFallbackLogger = (step, err) =>
  console.debug(`${LOG_TAG} ${step}:`, err instanceof Error ? err.message : err)

/** 默认 mtime 轮询周期（D2：2s，与 extension poller tick 同节奏）。 */
const DEFAULT_POLL_INTERVAL_MS = 2_000

/** kill 结果（D3 killResult reason 枚举；killed=true 恒 reason=killed）。 */
export interface BackgroundTaskKillResult {
  killed: boolean
  reason: 'killed' | 'already-exited' | 'identity-unverifiable' | 'registry-write-failed'
}

/** registry 读结果（D1 corrupt 语义：损坏 → 空表 + 错误标记，不 throw）。 */
export interface BackgroundTaskListResult {
  entries: BackgroundTaskRegistryEntry[]
  /** 解析失败被 .corrupt 隔离（UI 显示「任务数据损坏」错误条的依据）。 */
  corrupted: boolean
}

/** 毫秒 → 秒（epoch 秒换算；勿与 startedAt 的毫秒混用，对齐 reaper 同款常量）。 */
const MS_PER_SECOND = 1_000

/** 读条目 start time 字段（epoch 秒）。运行时 guard：typeof + 有限性，防脏数据混入比较（对齐 reaper 同名防御）。 */
function readRegisteredStartSec(entry: BackgroundTaskRegistryEntry): number | undefined {
  return typeof entry.pidStartTime === 'number' && Number.isFinite(entry.pidStartTime) ? entry.pidStartTime : undefined
}

/** 身份验证判定（D6 两档共用出口；mismatch = pid 复用，原进程视为已死 → 走分支③）。 */
type IdentityVerdict = 'verified' | 'mismatch' | 'unverifiable'

/** 依赖注入（pid 原语可 mock，零真实进程可测）。 */
export interface BackgroundTaskServiceDeps {
  /** pid 判活。默认真实 process.kill(pid, 0)（protocol background-task 子出口原语）。 */
  isPidAlive?: (pid: number) => boolean
  /** 进程树处置。默认真实 kill(-pid)/taskkill（protocol background-task 子出口原语）。 */
  killProcessTree?: (pid: number) => void
  /**
   * 进程 start time 探测（epoch ms；异步 ≤1s 超时不阻塞事件循环，D6 两档规格）。
   * 默认 ps（macOS/Linux）/ Get-Process ISO 8601（Windows）。undefined = 探测不可得。
   */
  probeProcessStartTimeMs?: (pid: number) => Promise<number | undefined>
}

export interface BackgroundTaskServiceOptions {
  /** 变更广播回调（注入形式；u-runtime-rpc 接 message-bus session 级 publish）。 */
  onTasksChanged: (sessionId: string) => void
  /** mtime 轮询周期（默认 2s，D2）。 */
  pollIntervalMs?: number
  /** pi agent 目录（缺省 getPiAgentDir() 动态推导；测试注入 tmp）。 */
  piAgentDir?: string
  /** pid 原语注入。 */
  deps?: BackgroundTaskServiceDeps
}

interface ResolvedDeps {
  isPidAlive: (pid: number) => boolean
  killProcessTree: (pid: number) => void
  probeProcessStartTimeMs: (pid: number) => Promise<number | undefined>
}

/** 锁内校验的分支裁决（killTask 消费；kind 与 D6 表格行号对应见各 return 点）。 */
type InLockOutcome =
  | { kind: 'already-exited' }
  | { kind: 'write-failed' }
  | { kind: 'identity-unverifiable' }
  | { kind: 'signal-killing'; fresh: BackgroundTaskRegistryEntry }
  | { kind: 'signal-orphan'; fresh: BackgroundTaskRegistryEntry }

export class BackgroundTaskService {
  private readonly onTasksChanged: (sessionId: string) => void
  private readonly pollIntervalMs: number
  private readonly agentDir: string
  private readonly deps: ResolvedDeps
  /** watched sessionId 集合（D8③：list 加入 / removeSessionEntry 退订——接线在 u-runtime-rpc）。 */
  private readonly watched = new Set<string>()
  /** 共享 last-seen mtime（轮询/事件钩子/自写自检三方共用的唯一变更判定状态，D2）。 */
  private readonly lastSeenMtime = new Map<string, number | undefined>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: BackgroundTaskServiceOptions) {
    this.onTasksChanged = options.onTasksChanged
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.agentDir = options.piAgentDir ?? getPiAgentDir()
    this.deps = {
      isPidAlive: options.deps?.isPidAlive ?? isPidAlive,
      // 默认实现包一层 onFallback 注入：进程组 kill 失败的回退诊断落 console（与原本地实现日志语义等价）
      killProcessTree: options.deps?.killProcessTree ?? ((pid: number) => killProcessTree(pid, processFallbackLog)),
      probeProcessStartTimeMs: options.deps?.probeProcessStartTimeMs ?? probeProcessStartTimeMs,
    }
  }

  // ── watched 集合与生命周期（D8③） ────────────────────────────────

  /** session 加入 watched（语义 = 首次 backgroundTask.list RPC；基线 stat 不触发广播）。 */
  markWatched(sessionId: string): void {
    if (this.watched.has(sessionId)) return
    this.watched.add(sessionId)
    // 基线：调用方刚拉取过全量（list RPC 语义），当前 mtime 即已见状态，不广播
    this.lastSeenMtime.set(sessionId, this.statMtime(sessionId))
  }

  /** session 移出 watched（挂 session-service removeSessionEntry 汇聚点——接线在 u-runtime-rpc）。 */
  unwatch(sessionId: string): void {
    this.watched.delete(sessionId)
    this.lastSeenMtime.delete(sessionId)
  }

  // ── registry 读（D1） ────────────────────────────────────────────

  /** registry.json 路径（布局推导复用 reaper 提炼导出，禁止两处各写拼接）。 */
  registryPathFor(sessionId: string): string {
    return getSessionRegistryPath(this.agentDir, sessionId)
  }

  /**
   * 读指定 session 的 registry 全量条目。目录/文件不存在（含垃圾 sid）→ 静默空表；
   * 损坏 → 空表 + corrupted:true（.corrupt 隔离，D1/S7 语义），不 throw。
   */
  listTasks(sessionId: string): BackgroundTaskListResult {
    return readRegistryEntriesWithStatus(this.registryPathFor(sessionId))
  }

  // ── output tail（D7） ────────────────────────────────────────────

  /**
   * 读任务输出尾部（字节窗口从文件末尾，默认 32KB / 2000 行——output-tail.ts 的
   * runtime 侧口径常量作实参，protocol readOutputTail 无默认值）。条目不存在 /
   * 输出文件不可读 → undefined（u-runtime-rpc 的 output RPC handler 映射 lost 语义）。
   */
  getOutputTail(sessionId: string, taskId: string, maxBytes: number = OUTPUT_TAIL_DEFAULT_MAX_BYTES): OutputTailResult | undefined {
    const entry = this.listTasks(sessionId).entries.find((e) => e.taskId === taskId)
    if (!entry) return undefined
    return readOutputTail(entry.outputFile, { maxBytes, maxLines: OUTPUT_TAIL_MAX_LINES })
  }

  // ── 变更检测（D2：三触发面共享同一 last-seen，单广播源） ───────────

  /** stat registry mtime；ENOENT（垃圾 sid / 从未有任务 / 自愈 rename 走空）静默 undefined。 */
  private statMtime(sessionId: string): number | undefined {
    try {
      return statSync(this.registryPathFor(sessionId)).mtimeMs
    } catch {
      return undefined
    }
  }

  /**
   * 对 watched 集合跑一次完整变更检测：mtime 变化才重读+广播。轮询 tick、pi 事件
   * 钩子（u-runtime-rpc 接线）、service 自写自检三方都收敛到本方法——共享 last-seen
   * 保证同一变化至多广播一次（D2：事件钩子不是第二广播源）。
   */
  checkForChanges(): void {
    for (const sessionId of this.watched) {
      const mtime = this.statMtime(sessionId)
      if (mtime === this.lastSeenMtime.get(sessionId)) continue
      this.lastSeenMtime.set(sessionId, mtime)
      // 广播时点文件已完整落盘（tmp+rename 原子性），消费方读到的即最新值
      this.onTasksChanged(sessionId)
    }
  }

  /** 启动 2s mtime 轮询（幂等；unref 不持进程——fake timers 下无 unref 短路跳过）。 */
  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => this.checkForChanges(), this.pollIntervalMs)
    this.timer.unref?.()
  }

  /** 停止轮询并清空 watched 状态（service 生命周期终点）。 */
  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.watched.clear()
    this.lastSeenMtime.clear()
  }

  // ── kill 五分支矩阵（D6 表格逐行） ────────────────────────────────

  /**
   * 身份验证两档（D6「身份验证两档」）：① 条目有 pidStartTime → 平台 start-time 严格
   * 比对；② 缺省 → 按需现测（异步 ≤1s 探测）后按 startedAt 秒级降级比对。两档统一经
   * pidStartMatchesRegistered（reaper 复用件）；探测不可得 → unverifiable（分支④），
   * mismatch = pid 复用 → 原进程视为已死（走分支③，不误杀）。
   */
  private async verifyIdentity(entry: BackgroundTaskRegistryEntry): Promise<IdentityVerdict> {
    const probeMs = await this.deps.probeProcessStartTimeMs(entry.pid)
    if (probeMs === undefined) return 'unverifiable'
    const actualSec = Math.floor(probeMs / MS_PER_SECOND)
    return pidStartMatchesRegistered(actualSec, readRegisteredStartSec(entry), entry.startedAt) ? 'verified' : 'mismatch'
  }

  /**
   * 分支③收尾（pid 已死 / pid 复用视为死）：不发 kill 信号；锁内 RMW 写终态——属主活：
   * exited 过渡值（poller ≤2s 覆盖为权威值）；属主死：orphaned（对齐 reaper 分支③）。
   * 实现顺序：判活重查置于锁内重读之后（writeMerged 范式，防 stale 覆盖 poller 新鲜终态）。
   */
  private finalizeDeadEntry(registryPath: string, taskId: string): BackgroundTaskKillResult {
    let outcome: InLockOutcome
    try {
      outcome = withFileLockSync<InLockOutcome>(registryPath, () => {
        const fresh = readRegistryEntriesWithStatus(registryPath).entries.find((e) => e.taskId === taskId)
        // 锁内重读：poller 已写权威终态 → 不覆盖
        if (!fresh || isTerminalBackgroundTaskState(fresh.state)) return { kind: 'already-exited' }
        // 判活重查（锁内重读之后）：死而复生 = 判定基础失效（pid 秒级复用等极端竞态），
        // 宁不杀勿误杀 → 拒绝并提示可重试（重试将走 pid 活路径 + 完整身份验证两档）
        if (this.deps.isPidAlive(fresh.pid)) return { kind: 'identity-unverifiable' }
        try {
          if (this.deps.isPidAlive(fresh.ownerPiPid)) {
            // ③ 属主活：过渡终态（poller 覆盖为权威值；runtime 写先于 poller 属设计允许的串行双写）
            writeExitedTransitionalLocked(registryPath, taskId)
          } else {
            // ③ 属主死：orphaned（对齐 reaper 分支③，锁内版防嵌套取锁）
            writeOrphanedTerminalLocked(registryPath, fresh)
          }
          return { kind: 'already-exited' }
        } catch (err) {
          // ⑤ 终态写失败：条目停留原状态（下次 app 启动 reaper 全量扫描兜底 / 属主活由 poller 收尾）
          console.warn(`${LOG_TAG} dead-entry terminal write failed: taskId=${taskId}`, err instanceof Error ? err.message : err)
          return { kind: 'write-failed' }
        }
      })
    } catch (err) {
      // ⑤：锁获取失败（预算耗尽 fail-fast）同归写路径失败，中止 kill
      console.warn(`${LOG_TAG} registry lock failed, aborting dead-entry finalize: taskId=${taskId}`, err instanceof Error ? err.message : err)
      return { killed: false, reason: 'registry-write-failed' }
    }
    return this.settleOutcome(registryPath, outcome, undefined)
  }

  /** 锁外收尾：按锁内裁决执行信号/自检并映射结果（写成功路径自触发变更检测——D2 自写自检）。 */
  private settleOutcome(
    registryPath: string,
    outcome: InLockOutcome,
    killPid: number | undefined,
  ): BackgroundTaskKillResult {
    switch (outcome.kind) {
      case 'already-exited':
        // 锁内可能写了过渡/orphaned 终态（③），自写自检即时广播（条目无变化时 mtime 未变不广播）
        this.checkForChanges()
        return { killed: false, reason: 'already-exited' }
      case 'identity-unverifiable':
        return { killed: false, reason: 'identity-unverifiable' }
      case 'write-failed':
        // ⑤：未发信号则不杀；条目停留原状态
        return { killed: false, reason: 'registry-write-failed' }
      case 'signal-killing':
        // ①：killing 已预写（锁内）→ 发信号 → poller ≤2s 边沿读回 intent 终态化（reason=killed）
        this.deps.killProcessTree(killPid ?? outcome.fresh.pid)
        this.checkForChanges()
        return { killed: true, reason: 'killed' }
      case 'signal-orphan': {
        // ②：属主已死 → 发信号 → 锁内写 orphaned 终态（本分支即终态，无 poller 收尾）
        this.deps.killProcessTree(killPid ?? outcome.fresh.pid)
        const written = writeOrphanedTerminal(registryPath, outcome.fresh)
        if (!written) {
          // ⑤：已发信号——条目按②既有路径收尾（下次 app 启动 reaper 全量扫描兜底）
          return { killed: false, reason: 'registry-write-failed' }
        }
        this.checkForChanges()
        return { killed: true, reason: 'killed' }
      }
    }
  }

  /**
   * 终止后台任务（D6 完整分支矩阵）。前置：读 registry 条目 → 锁外判活 → 身份验证
   * 两档 → 锁内重读校验 + 判活重查 + 预写/终态写 → 锁外发信号。所有写均走
   * `<registry.json>.lock` RMW（与 extension/reaper 写侧互斥同一把锁）。
   */
  async killTask(sessionId: string, taskId: string): Promise<BackgroundTaskKillResult> {
    const registryPath = this.registryPathFor(sessionId)
    const current = this.listTasks(sessionId).entries.find((e) => e.taskId === taskId)
    // 条目不存在 / 已终态（含 registry 损坏被隔离的空表）→ already-exited
    if (!current || isTerminalBackgroundTaskState(current.state)) {
      return { killed: false, reason: 'already-exited' }
    }

    // 锁外初判：任务 pid 已死 → 分支③（不发信号）
    if (!this.deps.isPidAlive(current.pid)) {
      return this.finalizeDeadEntry(registryPath, taskId)
    }

    // 身份验证两档（异步 ≤1s 探测，不阻塞事件循环）
    const identity = await this.verifyIdentity(current)
    if (identity === 'unverifiable') {
      // ④：探测不可得 → 拒绝（宁不杀勿误杀），UI 提示可重试
      return { killed: false, reason: 'identity-unverifiable' }
    }
    if (identity === 'mismatch') {
      // pid 已被复用 = 原进程已死 → 视为分支③（不误杀复用 pid 上的无关进程）
      return this.finalizeDeadEntry(registryPath, taskId)
    }

    // pid 活 + 身份通过 → ①/②：锁内重读校验 + 判活重查 + 预写。属主判活同在锁内对
    // fresh 现测（与③收尾同源，消除锁外判活的 stale 窗口——owner 在锁外判活后、锁内
    // 使用前死亡而沿用旧值走①，killing 条目将无人终态化，须等启动期 reaper 兜底）
    let outcome: InLockOutcome
    try {
      outcome = withFileLockSync<InLockOutcome>(registryPath, () => {
        const fresh = readRegistryEntriesWithStatus(registryPath).entries.find((e) => e.taskId === taskId)
        // 锁内重读：poller 竞争已终态化 → 不覆盖
        if (!fresh || isTerminalBackgroundTaskState(fresh.state)) return { kind: 'already-exited' }
        // 任务 pid 判活重查（置于锁内重读之后）：外层判活可能已 stale
        if (!this.deps.isPidAlive(fresh.pid)) {
          // 锁内按③收尾（owner 按 fresh 现测）
          try {
            if (this.deps.isPidAlive(fresh.ownerPiPid)) {
              writeExitedTransitionalLocked(registryPath, taskId)
            } else {
              writeOrphanedTerminalLocked(registryPath, fresh)
            }
            return { kind: 'already-exited' } as const
          } catch (err) {
            console.warn(`${LOG_TAG} in-lock terminal write failed: taskId=${taskId}`, err instanceof Error ? err.message : err)
            return { kind: 'write-failed' } as const
          }
        }
        try {
          if (this.deps.isPidAlive(fresh.ownerPiPid)) {
            // ①：属主活 → 锁内预写 killing（仅置 state，不写 reason——契约 reason 仅 exited 语义）
            return writeKillingStateLocked(registryPath, taskId)
              ? ({ kind: 'signal-killing', fresh } as const)
              : ({ kind: 'already-exited' } as const)
          }
          // ②：属主已死 → 信号后锁外写 orphaned 终态（settleOutcome 阶段，本分支即终态）
          return { kind: 'signal-orphan', fresh } as const
        } catch (err) {
          // ⑤：intent 预写失败 → 中止 kill（未发信号则不杀）
          console.warn(`${LOG_TAG} killing pre-write failed: taskId=${taskId}`, err instanceof Error ? err.message : err)
          return { kind: 'write-failed' } as const
        }
      })
    } catch (err) {
      // ⑤：锁预算耗尽 fail-fast → 中止 kill，条目停留原状态
      console.warn(`${LOG_TAG} registry lock failed, aborting kill: taskId=${taskId}`, err instanceof Error ? err.message : err)
      return { killed: false, reason: 'registry-write-failed' }
    }
    return this.settleOutcome(registryPath, outcome, current.pid)
  }
}
