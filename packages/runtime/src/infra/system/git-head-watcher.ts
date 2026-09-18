/**
 * GitHeadWatcher —— git HEAD 的 fs.watch 事件驱动挂载 + 两层恢复链（缓存治理批 4 U11）。
 *
 * 对齐 pi tui 的 fs-watch 形态（@earendil-works/pi-coding-agent 0.84.4 实装锚点：
 * dist/utils/fs-watch.js + dist/core/footer-data-provider.js setupGitWatcher/clearGitWatchers/
 * scheduleGitWatcherRetry）：
 * - **watch HEAD 所在目录而非 HEAD 文件**——git 原子写（tmp + rename 覆盖）会换 inode，对文件
 *   watch 在 rename 后静默失效（tui footer-data-provider.js:287-297 注释已踩平）。
 * - 存在 `<gitDir>/reftable` 目录时加挂该目录（reftable 仓库换分支改写 reftable 而非 HEAD）。
 *   本模块以观测器就近判定的 gitDir 探测 reftable（普通 repo gitDir == commonGitDir）；
 *   worktree + reftable 的边缘形态由 L2 兜底覆盖（见下）。
 * - WSL / Windows 挂载路径等「watch 事件不触发」形态属预期，由 L2 周期兜底覆盖（tui 的
 *   watchFile 轮询降级不移植——兜底已内建，不引入第二套轮询机制）。
 *
 * 两层恢复链（设计 G5，对齐 SkillRegistry 教训）：
 * - L1：watcher error（构造即抛或运行中 error 事件）→ **按失败 dir 收窄拆除**（只拆失败
 *   watcher 自身及其 dir 关联，健康 watcher 不动——单个坏目录不再引发全量重挂 churn）→
 *   5s 定时补挂缺失目标（remountMissing，不拆健康的；tui scheduleGitWatcherRetry 同构）——
 *   绝不允许「熔断后冻结到重启」；重试再失败自然形成 5s 间隔的持续重试循环。失败 dir
 *   缺席的防御形态（不可归因）才回落清全部。
 * - L2：60s 周期兜底，**无条件运行不依赖 watch 存活**，同时覆盖 ①静默丢事件（macOS fs.watch
 *   前科）②watch 持续失败（EMFILE 类）③bareCache 盲区（.bare 建/删无 HEAD 事件）；每次
 *   周期顺带重挂已失效 watcher（吸收原三层方案慢速重试职责，恢复事件驱动的节奏提前到 60s）。
 *
 * 挂载集合的维护（结构性跟随，无独立编排点）：
 * - observe(cwd, obs) 由共享 repo 观测器（services/git/repo-observer.ts）的条目写入回调驱动——
 *   任何读方把 cwd 带进观测器缓存（session 扫描 / toSummary / watch 刷新链重解析），watch 自动跟上。
 * - forget(cwds) 由 pruneCache 收缩回调驱动，防死 cwd 的 watcher 泄漏与「目录已删 → 重试挂载
 *   失败」循环。
 *
 * 🔒 三层架构：infra 实现（fs.watch IO + 定时器恢复策略）；cwd → 观测快照由回调携带
 * （observe 直带 RepoObservation，type-only import services/ports——不 value import services）。
 * 刷新语义（值变化判定 / 节流 / 广播）不属本模块，经 callbacks 上抛组合根装配的触发器。
 */
import { watch, statSync } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RepoObservation } from '../../services/ports/git-info.js'

/** debounce 窗口：首事件起算、窗口内事件合并到到点一次放行（tui WATCH_DEBOUNCE_MS 同构）。 */
const HEAD_DEBOUNCE_MS = 500
/** L1 重试间隔（tui FS_WATCH_RETRY_DELAY_MS = 5000 同构）。 */
const WATCH_RETRY_DELAY_MS = 5000
/** L2 周期兜底间隔（设计 §3.4.3：无条件运行，徽章陈旧上界 60s）。 */
const FALLBACK_RESCAN_INTERVAL_MS = 60_000

/** watch 目标目录的类型：head 所在目录（事件过滤 filename===HEAD）与 reftable 目录（不过滤）。 */
type WatchDirKind = 'head' | 'reftable'

interface WatchDirEntry {
  dir: string
  kind: WatchDirKind
}

export interface GitHeadWatcherCallbacks {
  /** debounce 收敛后的 git 事件（参数 = 受影响 cwd 集合）。经组合根接观测刷新触发器。 */
  onGitEvent(cwds: Set<string>): void
  /** L2 兜底周期（参数 = watcher 已登记的全部 cwd）。经同一触发器入口，两路统一。 */
  onFallbackTick(cwds: Set<string>): void
}

export interface GitHeadWatcherOptions extends GitHeadWatcherCallbacks {
  /** 测试可注入短 debounce（默认 500ms）。 */
  debounceMs?: number
  /** 测试可注入短 L1 重试间隔（默认 5s）。 */
  retryDelayMs?: number
  /** 测试可注入短 L2 兜底周期（默认 60s）。 */
  fallbackIntervalMs?: number
}

/** 从 error 事件/构造抛出的未知形态中提取 errno（结构化收窄，无断言）；无 code 返回空串。 */
function extractErrno(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    return ` (${err.code})`
  }
  return ''
}

export class GitHeadWatcher {
  private readonly callbacks: GitHeadWatcherCallbacks
  private readonly debounceMs: number
  private readonly retryDelayMs: number
  private readonly fallbackIntervalMs: number

  /** cwd → watch 目标（observe 登记 / forget 移除；observe 幂等重登记覆盖旧值）。 */
  private readonly targets = new Map<string, WatchDirEntry[]>()
  /** dir → 该 dir 受影响的 cwd 集合（多 cwd 共享同一 repo 时事件一次刷新全部）。 */
  private readonly dirCwds = new Map<string, Set<string>>()
  private readonly watchers = new Map<string, FSWatcher>()
  /** debounce 批次：窗口内事件累积的 cwd 集合，到点整体放行。 */
  private pendingCwds = new Set<string>()
  private debounceTimer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private fallbackTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(options: GitHeadWatcherOptions) {
    this.callbacks = options
    this.debounceMs = options.debounceMs ?? HEAD_DEBOUNCE_MS
    this.retryDelayMs = options.retryDelayMs ?? WATCH_RETRY_DELAY_MS
    this.fallbackIntervalMs = options.fallbackIntervalMs ?? FALLBACK_RESCAN_INTERVAL_MS
    this.armFallbackTimer()
  }

  // ── 挂载集合维护（观测器回调驱动）────────────────────────────────────

  /**
   * 登记 cwd 的 watch 目标并按需挂载（幂等；headPath 变化的形态下摘除旧关联）。
   * 非 repo（headPath undefined）→ 清该 cwd 的登记；其后该 cwd 变成 repo（git init）由
   * 观测器刷新链重新走本方法自然补挂。
   */
  observe(cwd: string, obs: RepoObservation): void {
    if (this.disposed) return
    const next: WatchDirEntry[] = []
    if (obs.headPath) next.push({ dir: dirname(obs.headPath), kind: 'head' })
    const reftableDir = obs.gitDir ? this.probeReftableDir(obs.gitDir) : undefined
    if (reftableDir) next.push({ dir: reftableDir, kind: 'reftable' })

    const prev = this.targets.get(cwd)
    this.targets.set(cwd, next)
    if (prev) {
      for (const entry of prev) {
        if (!next.some((n) => n.dir === entry.dir)) this.unlinkDirCwd(entry.dir, cwd)
      }
    }
    for (const entry of next) this.ensureWatch(entry, cwd)
  }

  /** 移除 cwd 的登记并收缩孤儿 dir 的 watcher（pruneCache 收缩回调驱动）。 */
  forget(cwds: ReadonlySet<string>): void {
    if (this.disposed) return
    for (const cwd of cwds) {
      const entries = this.targets.get(cwd)
      if (!entries) continue
      this.targets.delete(cwd)
      for (const entry of entries) this.unlinkDirCwd(entry.dir, cwd)
    }
  }

  /** 停止全部 watcher 与定时器（runtime shutdown / 测试 teardown）。幂等。 */
  dispose(): void {
    this.disposed = true
    this.closeAllWatchers()
    this.dirCwds.clear()
    this.pendingCwds.clear()
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer)
      this.fallbackTimer = null
    }
  }

  // ── 测试观测面（@internal，不进生产逻辑）────────────────────────────

  /** @internal 测试观测：真实 fs.watch 事件已入 debounce 批次、尚未放行。 */
  hasPendingGitEventsForTests(): boolean {
    return this.pendingCwds.size > 0
  }

  /** @internal 测试观测：当前挂载的 watch 目录集合。 */
  watchedDirsForTests(): string[] {
    return [...this.watchers.keys()]
  }

  /**
   * @internal 测试观测：dir 对应的底层 FSWatcher（运行中 error 事件注入用）——macOS FSEvents
   * 对「watch 目录被删」不保证派发 error 事件（静默丢事件形态），真实 IO 形态不可靠；
   * 注入 emit 是验收场景 A6「测试钩子注入 error 事件」同款。
   */
  watcherForTests(dir: string): FSWatcher | undefined {
    return this.watchers.get(dir)
  }

  // ── watch 挂载与事件 ────────────────────────────────────────────────

  /** 探测 gitDir 下是否存在 reftable 目录（reftable 仓库换分支改写 reftable 而非 HEAD）。 */
  private probeReftableDir(gitDir: string): string | undefined {
    const reftableDir = join(gitDir, 'reftable')
    try {
      return statSync(reftableDir).isDirectory() ? reftableDir : undefined
    } catch {
      return undefined
    }
  }

  /** 把 cwd 记入 dir 的受影响集合，dir 尚无 watcher 则挂载（watch 构造抛 → L1）。 */
  private ensureWatch(entry: WatchDirEntry, cwd: string): void {
    const { dir } = entry
    let cwds = this.dirCwds.get(dir)
    if (!cwds) {
      cwds = new Set()
      this.dirCwds.set(dir, cwds)
    }
    cwds.add(cwd)
    if (this.watchers.has(dir)) return
    let watcher: FSWatcher
    try {
      watcher = watch(dir, { persistent: false }, (_event, filename) => {
        // head 目录只认 HEAD 事件（filename null = 平台未提供名字，保守放行——tui 同构）；
        // .git 目录在 git 操作期间高频写 index/refs，不过滤会把 HEAD 读取量级的成本放大。
        if (entry.kind === 'head' && filename !== null && filename !== 'HEAD') return
        this.scheduleRefresh(cwds)
      })
    } catch (e) {
      this.handleWatchError(e, dir)
      return
    }
    watcher.on('error', (err: NodeJS.ErrnoException) => this.handleWatchError(err, dir))
    this.watchers.set(dir, watcher)
  }

  /** 事件入 debounce 批次；窗口内（timer 已排）只合并不重置——到点整体放行一次。 */
  private scheduleRefresh(cwds: ReadonlySet<string>): void {
    if (this.disposed) return
    for (const cwd of cwds) this.pendingCwds.add(cwd)
    if (this.debounceTimer) return
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      const batch = this.pendingCwds
      this.pendingCwds = new Set()
      if (batch.size > 0) this.callbacks.onGitEvent(batch)
    }, this.debounceMs)
  }

  // ── L1：error → 按失败 dir 收窄拆除 → 5s 定时补挂缺失 ────────────────

  /**
   * error 处置：failedDir 已知（构造抛/运行中 error 都带 dir）→ 只拆失败 watcher 自身
   * 与其 dir→cwd 关联，健康 watcher 不动（原实现清全部——单个坏目录引发全量重挂
   * churn，且 EMFILE 形态下 5s 周期反复拆健康 watcher）；failedDir 缺席（防御形态，
   * 不可归因）才回落清全部。重试只补挂缺失目标（remountMissing）。
   */
  private handleWatchError(err?: unknown, failedDir?: string): void {
    if (this.disposed) return
    if (failedDir !== undefined) {
      const watcher = this.watchers.get(failedDir)
      if (watcher) {
        this.watchers.delete(failedDir)
        this.closeQuietly(watcher)
      }
      this.dirCwds.delete(failedDir)
    } else {
      this.closeAllWatchers()
      this.dirCwds.clear()
    }
    console.warn(
      `[git-head-watcher] fs.watch error${extractErrno(err)} — cleared ${failedDir !== undefined ? `watcher for ${failedDir}` : 'all git watchers'}, retrying mount in ${this.retryDelayMs}ms` +
        '（EMFILE 类按日志检查进程 fd 上限；重试持续失败期间缓存新鲜度由 L2 周期兜底维持）',
    )
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.remountMissing()
    }, this.retryDelayMs)
  }

  /**
   * 只补挂缺失的 watch 目标（L1 失败重试路径；ensureWatch 幂等——watchers 已有该
   * dir 直接跳过，健康 watcher 不拆不重建）。静默死亡的 watcher（macOS 目录被删无
   * error 事件）不经此路径自愈，由 L2 周期 remountAll 全量重放覆盖，上界不变（60s）。
   */
  private remountMissing(): void {
    if (this.disposed) return
    for (const [cwd, entries] of this.targets) {
      for (const entry of entries) this.ensureWatch(entry, cwd)
    }
  }

  /**
   * 重放登记的全部 watch 目标（L2 顺带重挂专用：先全拆再重放——close-all 是静默死亡
   * watcher 的唯一自愈手段，其代价为每周期一次挂载重建，60s 周期有界）。幂等。
   */
  private remountAll(): void {
    if (this.disposed) return
    this.closeAllWatchers()
    this.dirCwds.clear()
    for (const [cwd, entries] of this.targets) {
      for (const entry of entries) this.ensureWatch(entry, cwd)
    }
  }

  private closeAllWatchers(): void {
    for (const watcher of this.watchers.values()) this.closeQuietly(watcher)
    this.watchers.clear()
  }

  private unlinkDirCwd(dir: string, cwd: string): void {
    const cwds = this.dirCwds.get(dir)
    if (!cwds) return
    cwds.delete(cwd)
    if (cwds.size > 0) return
    this.dirCwds.delete(dir)
    const watcher = this.watchers.get(dir)
    if (watcher) {
      this.watchers.delete(dir)
      this.closeQuietly(watcher)
    }
  }

  private closeQuietly(watcher: FSWatcher): void {
    try {
      watcher.close()
    // eslint-disable-next-line taste/no-silent-catch -- close 竞态失败（watcher 已死/目录已删）无害且不可恢复，tui closeWatcher 同语义
    } catch {
      // Ignore watcher close errors
    }
  }

  // ── L2：60s 周期兜底（无条件运行，不依赖 watch 存活）──────────────────

  /**
   * 武装 L2 兜底定时器（构造即武装——「无条件运行」语义；unref 不持有事件循环，
   * 对齐 skill-registry 兜底定时器先例，shutdown 由 dispose 显式清理）。
   * 每周期：①顺带重挂已失效 watcher；②把已登记 cwd 集合发 onFallbackTick（经触发器
   * 同一「刷新 + 值变化判定 + 节流 + 广播」入口——徽章陈旧上界 60s 的机制保证）。
   */
  private armFallbackTimer(): void {
    if (this.fallbackTimer) return
    const timer = setInterval(() => {
      if (this.disposed) return
      this.remountAll()
      const cwds = new Set(this.targets.keys())
      if (cwds.size > 0) this.callbacks.onFallbackTick(cwds)
    }, this.fallbackIntervalMs)
    // 纯兜底周期任务：unref 不持有事件循环（不阻进程退出）；shutdown 由 dispose 显式清理
    timer.unref()
    this.fallbackTimer = timer
  }
}
