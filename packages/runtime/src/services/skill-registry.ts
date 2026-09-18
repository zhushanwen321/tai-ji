/**
 * SkillRegistry —— skill 缓存 + 文件监听（W1）。
 *
 * 职责：
 * - 启动期扫描全局 skill 目录（piAgentDir/skills、configDir/skills、discovery.skillDirs），
 *   缓存为 globalCache，供 landing 浮层 / 命令源即时读取（不阻塞 UI）。
 * - 项目级 skill 懒加载：首次 getProjectSkills(cwd) 时扫描该 cwd 下 skill，挂 chokidar watcher，
 *   命中缓存后二次调用零开销。不同 cwd 的 projectCache 互不污染。
 * - chokidar 监听目录变动，300ms debounce 后重扫缓存并经 onChange 回调通知上游（renderer 刷新）。
 *
 * 设计取舍：
 * - scanFn 注入：测试用 _scanFn mock 扫描逻辑（U2 验证懒加载 + 缓存命中）；生产用默认实现，
 *   即 ConfigService.loadSkills（已封装优先级合并 / 容器目录遍历 / sources badge 链）。
 * - changeHandler 拿 affectedSessionIds（getActiveSessionIds 返回当前活跃 session 列表），
 *   由调用方按 sessionId 路由刷新。session 级状态隔离（架构约定 #7）的延伸：skill 变更广播
 *   也必须带 sessionId，故 _notifyGlobalChange 传整个活跃列表，上游自行过滤。
 */
import { watch, type FSWatcher } from 'chokidar'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillCacheScope, SkillInfo } from '@taiji/shared'
import { resolveGlobalSkillDirs, resolveProjectSkillDirs } from './skill-dirs.js'
import type { DirScopes } from './skill-dir-config.js'
import type { IConfigStore } from './ports/config.js'

/**
 * skill 扫描函数签名：给定 projectRoot（项目根 / cwd），返回该根下解析出的 skill 列表。
 * 全局扫描时 projectRoot 传空串或配置根目录——默认实现（ConfigService.loadSkills）对
 * projectRoot 只用于解析 discovery.json 相对路径，全局目录均为绝对路径故不受影响。
 */
export type SkillScanFn = (projectRoot: string) => Promise<SkillInfo[]>

/** configStore 的窄接口（与 PiConfigStore 对齐：无参 getSkillPathScopes / getPiAgentDir）。 */
export interface SkillRegistryConfigStore {
  /**
   * discovery.json skill 的 v2 分 scope 结构（projectPaths / globalPaths）。
   * v2：resolveGlobal/ProjectSkillDirs 直接读显式 scope，不再 isAbsolute 推断（方案 §2.5 路径 A 配套）。
   */
  getSkillPathScopes(): DirScopes
  /** pi agent 配置目录（<dataDir>/agent）。 */
  getPiAgentDir(): string
}

/**
 * skill 变更事件（onChange 回调参数）。
 * scope='global' 时 cwd 缺省（全局变动影响所有）；scope='project' 时 cwd 携带变更的项目根。
 * affectedSessionIds：受影响的活跃 session（reloadOrchestrator 用，按 cwd 过滤后的子集）。
 */
export interface SkillChangeEvent {
  scope: SkillCacheScope
  /** scope='project' 时携带，表示哪个 cwd 的 skill 变动。global 变动无 cwd。 */
  cwd?: string
  /** 受影响的活跃 session 列表（reloadOrchestrator 用）。global=全部活跃；project=cwd 匹配的活跃。 */
  affectedSessionIds: string[]
}

/** sessionService 的窄接口：查活跃 session 列表 + 按 sid 查 cwd（项目 skill 变更定位受影响 session）。 */
export interface SkillRegistrySessionService {
  getActiveSessionIds(): string[]
  getSessionCwd?(sessionId: string): string | undefined
}

export interface SkillRegistryOptions {
  configStore: SkillRegistryConfigStore
  /** taiji 配置根目录（~/.taiji/），用于推导全局 skill 目录 configDir/skills。 */
  configDir: string
  sessionService: SkillRegistrySessionService
  /**
   * 测试注入：覆盖默认扫描逻辑。默认实现复用 ConfigService.loadSkills（优先级合并 + 容器遍历）。
   * 注入时单元测试可断言调用次数（U2 懒加载 + 缓存命中）。
   */
  _scanFn?: SkillScanFn
}

/** debounce 间隔（ms）：文件变动密集时合并为一次重扫，避免短时间多次扫描开销。 */
const DEBOUNCE_MS = 300

/** 全局 watcher 的 debounce key（与项目级 cwd key 区分）。 */
const GLOBAL_KEY = '__global__'

/**
 * chokidar ignore 兜底：排除常见构建产物 / 依赖大目录（node_modules / dist / build / .git /
 * .next / coverage / out）。watch 范围已收窄到 skill 子目录，此为防御性兜底（容器目录意外混入
 * 这些目录时不爆 fd）。不忽略点目录——.agents/.pi/.taiji 等是合法 skill 路径，原实现的通用
 * 点文件忽略 `(^|[\/\\])\..` 会连这些一起过滤掉，违背「watch 范围 = scan 范围」原则。
 */
const WATCH_IGNORED = /(^|[\/\\])(node_modules|dist|build|\.git|\.next|coverage|out)([\/\\]|$)/

/**
 * chokidar 轮询间隔（ms）——仅在显式开启 polling 降级时生效（TAIJI_AGENT_SKILL_WATCH_POLLING=1）。
 *
 * [HISTORICAL] 2026-07-27 起默认 usePolling:true：chokidar v4 移除 fsevents 绑定后 macOS
 * fs.watch 对「已 watch 目录下新建子目录」事件不可靠（nodejs/node#52601 启动竞态 +
 * FSEvents coalescing 丢事件），当时实测（mkdir new-skill && 写 SKILL.md，连跑 5 次）
 * 事件触发率仅 ~40%，landing 浮层长期不刷新。
 * 2026-08-28 复测（Node v24.11.1 / macOS 25，已 watch 根目录下 10 轮「新建子目录+写文件」，
 * 21/21 事件全部到达）：该缺陷在当前运行时不再复现，故默认回到原生事件（事件驱动更快、
 * 零常驻 stat 开销），polling 降级为显式开关。1500ms 沿用当时的折中值（skill 目录条目
 * < 50，单轮 stat 开销可忽略）。若缺陷在未来 Node/macOS 版本复发需重开降级，且 skill
 * discovery 引入大量第三方目录时须重测负载。
 */
const WATCH_POLL_INTERVAL_MS = 1500

/**
 * chokidar watcher 配置（全局 + 项目级共用）。
 *
 * 默认原生事件（usePolling:false）；TAIJI_AGENT_SKILL_WATCH_POLLING=1 回退 stat 轮询
 * （平台缺陷复发时的逃生口，见上）。polling 用 stat 不占 fd，不会重蹈 2026-07-22
 * EMFILE 事故（那是 watch 整个 home 目录十万文件致 fd 耗尽）。
 * 场景1（settings 改路径 → rebuildGlobal → 刷新）不依赖 watcher，不受影响继续工作。
 */
const WATCH_OPTIONS = {
  ignored: WATCH_IGNORED,
  ignoreInitial: true,
  persistent: true,
  usePolling: process.env.TAIJI_AGENT_SKILL_WATCH_POLLING === '1',
  interval: WATCH_POLL_INTERVAL_MS,
  binaryInterval: WATCH_POLL_INTERVAL_MS,
} as const

/**
 * watcher 连续同类错误熔断阈值：达到则 close 该 watcher。背景：chokidar 遇 EMFILE 会自动重试 watch，
 * 但 fd 已耗尽时重试必再失败 → 死循环刷屏（2026-07-22 事故中 10899 次，撑账 2.9MB stderr）。
 * 熔断后停止重试，释放该 watcher 占用的句柄，让 pi spawn 等关键操作能拿到 fd。
 */
const MAX_WATCHER_ERRORS = 5

/**
 * [G4 / 2026-09-14 内存审计] project watcher LRU 容量：最近 MAX_PROJECT_WATCHERS 个 cwd。
 * 背景：worktree 工作方式下 distinct cwd 持续增长，每 cwd 一个常驻 chokidar watcher（OS fd +
 * 内存），无界增长最终撞 EMFILE（2026-07-22 事故同族风险）。超出容量驱逐最久未访问 cwd 的
 * watcher（close 释放 fd）；驱逐只关 watcher 不清 projectCache——缓存条目小（skill 列表），
 * 且缓存命中路径的「应 watch 无 watcher」补挂逻辑（W3 refreshProjectWatcher）让被驱逐 cwd
 * 下次访问自动重挂，不因驱逐永久失明。
 */
const MAX_PROJECT_WATCHERS = 8

/**
 * [U2 / cache-governance 1-4] 兜底周期重扫间隔（ms）：5min。
 *
 * 背景：watcher 存在三种「缓存与磁盘发散且不自愈」的形态——① error 熔断只 close 不恢复
 * （熔断后该 scope 冻结到重启）；② macOS fs.watch 静默丢事件前科（2026-07-27 实测 ~40%
 * 触发率，见 WATCH_POLL_INTERVAL_MS 注释）；③ project watcher LRU 驱逐窗口失明。
 * 兜底语义：固定周期无条件重扫 globalCache + 全部活跃 projectCache cwd 使缓存重新收敛，
 * 一个机制闭合全部三种发散（cache-governance 设计 §3.1 项 1-4，G5「失效机制故障可自愈」：
 * 不允许任何形态的永久发散到重启）。watcher 正常时成本 = 每 5min 一次 readdir 级扫描，
 * 量级与 chokidar 初始扫描相同，可忽略。
 */
const FALLBACK_RESCAN_INTERVAL_MS = 300_000 // 5min（= 5 * 60 * 1000，单值字面量形式对齐 watchdog/npm-installer 惯例）

/**
 * [U2] skill 列表逐项严格相等（兜底重扫的「值变化」收敛判定）。
 * SkillInfo 是扁平 DTO（含可选嵌套 sources），同实现扫描产物键序稳定，序列化比对足够精确；
 * 列表量级小（skill 条目 < 50），成本可忽略。
 */
function sameSkillLists(a: SkillInfo[], b: SkillInfo[]): boolean {
  if (a.length !== b.length) return false
  return a.every((item, i) => JSON.stringify(item) === JSON.stringify(b[i]))
}

/**
 * SkillRegistry：全局 + 项目级 skill 缓存 + chokidar 文件监听。
 *
 * 生命周期：
 * - initGlobal()：组合根在 server.start 后调用，扫描全局目录 + 挂全局 watcher + 武装兜底重扫定时器。
 * - getProjectSkills(cwd)：按需懒扫描 + 挂项目 watcher，命中缓存直接返回。
 * - 兜底重扫（U2）：固定周期无条件重扫全部缓存 scope，值变化才广播（watcher 熔断/丢事件/
 *   LRU 驱逐发散的自愈通道，cache-governance G5）。
 * - dispose()：关闭所有 watcher + 清兜底定时器（测试 / shutdown 时调）。
 */
export class SkillRegistry {
  private globalCache: SkillInfo[] = []
  private readonly projectCache = new Map<string, SkillInfo[]>()
  private readonly projectWatchers = new Map<string, FSWatcher>()
  /**
   * [G4] projectWatcher 的 LRU 序（尾 = 最近访问），只收录挂了 watcher 的 cwd（无 skill 目录的
   * cwd 不占 watcher 槽位）。touch 于 setupProjectWatcher 挂载 + getProjectSkills 缓存命中
   * （有 watcher 时）；驱逐在 touch 内联触发（超容量即 close 最旧）。
   */
  private readonly projectWatcherLru: string[] = []
  /**
   * 进行中的 getProjectSkills Promise，按 cwd 去重（防 TOCTOU 竞态导致重复挂 watcher）。
   * 背景：缓存守卫在 await 之前，并发同 cwd 请求会各自走 scanFn + watch()，第二个 set 覆盖丢掉
   * 第一个 watcher（永不 close → fd 泄漏，正是本 PR 要消除的故障类别）。in-flight Promise 让并发
   * 调用共享同一次 scan + watch。
   */
  private readonly projectInFlight = new Map<string, Promise<SkillInfo[]>>()
  private globalWatcher: FSWatcher | null = null
  private readonly changeHandlers = new Set<(event: SkillChangeEvent) => void>()
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>()
  /**
   * [skill-reload D8-a] debounce 窗口内累计的 watcher 事件类型（按 debounceKey 分区，
   * 与 debounceTimers 同生命周期）。watcher 'all' 事件到达时登记，debounce 批触发时
   * 取出落归因日志——高频编辑合并为一行，不逐事件刷屏（对齐 reap-orphan-pi kill
   * decision 的 console.log 归因先例）。
   */
  private readonly pendingWatcherEvents = new Map<string, Set<string>>()
  private readonly scanFn: SkillScanFn
  /**
   * 进行中的 rebuildGlobal Promise，并发去重（用户快速连触 setSkillDirs 时共享同一个 Promise）。
   * 避免交错执行产生冗余 scanFn + 被 close 的 watcher + 双重广播。
   */
  private rebuildInFlight: Promise<void> | null = null
  /** 是否已 dispose。置 true 后 getProjectSkills/rebuildGlobal 直接 return，防止 dispose 后 in-flight 写回。 */
  private disposed = false
  /** [U2] 兜底周期重扫定时器（initGlobal 武装 / dispose 清理；unref 不持有事件循环）。 */
  private fallbackTimer: NodeJS.Timeout | null = null
  /** [U2] 兜底重扫防重入：上一轮未完成（scanFn 慢于周期）时跳过本轮 tick，防扫描堆叠。 */
  private fallbackRescanRunning = false

  constructor(private readonly options: SkillRegistryOptions) {
    this.scanFn = options._scanFn ?? this.defaultScanFn.bind(this)
  }

  /**
   * 启动期扫描全局 skill 目录并缓存 + 挂全局 watcher + 武装兜底周期重扫定时器（U2）。
   * 必须在 server.start 后调用（组合根 index.ts 编排）。
   */
  async initGlobal(): Promise<void> {
    try {
      this.globalCache = await this.scanFn('')
      this.setupGlobalWatcher()
    } finally {
      // finally 武装：启动扫描失败时（globalCache 空 + watcher 未挂，组合根对该失败只降级
      // 不阻塞启动）兜底重扫是唯一自愈通道，下个周期自动补上缓存——G5 自愈语义覆盖
      // 「启动即故障」形态。
      this.armFallbackRescan()
    }
  }

  // ── [U2] 周期兜底重扫（watcher 熔断 / 静默丢事件 / LRU 驱逐发散的自愈通道）──────

  /**
   * 武装兜底重扫定时器（幂等，防重复 init 堆叠定时器）。
   * 触发无条件（不判断 watcher 健康状态——静默丢事件形态下 watcher 看起来健康，判断不可靠）；
   * 广播有条件（值变化才经 onChange 通知链，见 fallbackRescanGlobal/Project）。
   * 不重挂 watcher：watch 恢复是批 4 观测器的职责，本兜底只保证缓存收敛。
   */
  private armFallbackRescan(): void {
    if (this.fallbackTimer) return
    const timer = setInterval(() => {
      void this.runFallbackRescan()
    }, FALLBACK_RESCAN_INTERVAL_MS)
    // 纯兜底周期任务：unref 不持有事件循环（不阻进程退出）；shutdown 由 dispose 显式清理
    timer.unref()
    this.fallbackTimer = timer
  }

  /**
   * 兜底重扫一轮：globalCache + 全部活跃 projectCache cwd，逐 scope 独立容错
   * （单 scope scanFn 失败保留该 scope 旧值，不拖垮其他 scope 的收敛）。
   * 串行执行：readdir 级成本，量级可忽略，串行避免多 cwd 并发扫描的 IO 尖峰。
   */
  private async runFallbackRescan(): Promise<void> {
    if (this.disposed || this.fallbackRescanRunning) return
    this.fallbackRescanRunning = true
    try {
      await this.fallbackRescanGlobal()
      for (const cwd of this.projectCache.keys()) {
        await this.fallbackRescanProject(cwd)
      }
    } finally {
      this.fallbackRescanRunning = false
    }
  }

  /**
   * 重扫全局缓存：值有变化才刷新广播。广播链下游 = reloadOrchestrator（global 通知 =
   * 全部活跃 idle session 的 pi reload）+ renderer 失效重拉，无差别周期广播违背设计
   * 「watcher 正常时兜底成本可忽略」的成本口径——值比对即收敛判定：相等 = 缓存与磁盘
   * 已一致，无信息需要传播。scanFn 失败保留旧值（与 rebuildGlobal 同款容错），下周期重试。
   */
  private async fallbackRescanGlobal(): Promise<void> {
    return this.rescanScope({
      scan: () => this.scanFn(''),
      tag: 'global',
      read: () => this.globalCache,
      write: (v) => { this.globalCache = v },
      notify: () => this.notifyGlobalChange(),
    })
  }

  /**
   * 兜底重扫单 scope 的共用收敛骨架（global / project 两腿同款，收敛口径单点）：scanFn
   * 失败保留该 scope 旧值；读取时分区已不存在（project 腿被 invalidateAllProjects 清掉
   * → read() 返回 undefined）则不复活已清分区；值变化才落缓存 + 广播（相等 = 缓存与磁盘
   * 已一致，无信息需传播）。
   */
  private async rescanScope(opts: {
    scan: () => Promise<SkillInfo[]>
    tag: string
    read: () => SkillInfo[] | undefined
    write: (v: SkillInfo[]) => void
    notify: () => Promise<void>
  }): Promise<void> {
    let fresh: SkillInfo[]
    try {
      fresh = await opts.scan()
    } catch (e) {
      console.warn(`[skill-registry] fallback rescan: ${opts.tag} scan failed, keeping stale cache:`, e)
      return
    }
    const current = opts.read()
    if (current === undefined) return
    const changed = !sameSkillLists(current, fresh)
    opts.write(fresh)
    if (!changed) return
    console.warn(`[skill-registry] fallback rescan: ${opts.tag} cache diverged from disk, refreshed via onChange (frequent = watcher event path unhealthy, check circuit-break / lost events)`)
    await opts.notify()
  }

  /**
   * 重扫单个项目缓存：同 fallbackRescanGlobal 的值变化收敛语义（scope='project' + cwd 广播）。
   * 扫描期间分区被 invalidateAllProjects 清掉时不复活已清分区（重建交由下次 getProjectSkills）。
   */
  private async fallbackRescanProject(cwd: string): Promise<void> {
    return this.rescanScope({
      scan: () => this.scanFn(cwd),
      tag: `project:${cwd}`,
      read: () => this.projectCache.get(cwd),
      write: (v) => { this.projectCache.set(cwd, v) },
      notify: () => this.notifyProjectChange(cwd),
    })
  }

  /**
   * 挂全局 watcher（initGlobal 启动期 + rebuildGlobal 重建共用）。
   * watch 范围 = scan 范围（SSOT）：只 watch 实际存在的全局 skill 目录。
   */
  private setupGlobalWatcher(): void {
    const dirs = resolveGlobalSkillDirs(this.options.configStore, this.options.configDir).filter(d => existsSync(d))
    if (dirs.length === 0) return
    // 幂等防护：若已存在 globalWatcher（重试/重建），先 close 旧的避免泄漏。
    this.globalWatcher?.close().catch(() => {})
    this.globalWatcher = watch(dirs, WATCH_OPTIONS)
    this.setupWatcher(this.globalWatcher, 'global', GLOBAL_KEY, async () => {
      this.globalCache = await this.scanFn('')
      await this.notifyGlobalChange()
    })
  }

  /**
   * 重建全局 watcher + 重扫 globalCache（settings 改 skill 扫描路径后调用）。
   * close 旧 watcher → 重扫缓存 → 用新目录列表重挂 watcher（新路径纳入视野）→ 通知上游。
   *
   * 并发去重：用户快速连触 setSkillDirs 时，多个 rebuildGlobal 共享同一个 in-flight Promise，
   * 避免交错执行产生冗余 scanFn + 被 close 的 watcher + 双重广播。
   */
  async rebuildGlobal(): Promise<void> {
    if (this.disposed) return
    // 并发去重：复用进行中的 rebuild（快速连触 setSkillDirs 时共享同一个 Promise）
    if (this.rebuildInFlight) return this.rebuildInFlight
    // 清掉 GLOBAL_KEY pending debounce（避免 rebuild 后又被旧 timer 触发冗余重扫）：
    // 全局 skill 文件变动会排队 GLOBAL_KEY timer，rebuildGlobal 立即重扫+通知后，原 timer 到点
    // 会再触发一次 scanFn + notify（冗余），故此处先清掉。pending 事件随 timer 一并丢弃
    // （其通知义务已由 rebuild 的 notifyGlobalChange 兑现，留下会被下一个批误记归因）。
    const globalTimer = this.debounceTimers.get(GLOBAL_KEY)
    if (globalTimer) {
      clearTimeout(globalTimer)
      this.debounceTimers.delete(GLOBAL_KEY)
      this.pendingWatcherEvents.delete(GLOBAL_KEY)
    }
    this.rebuildInFlight = (async () => {
      try {
        // close 旧 watcher（await 避免 fd 抖动，新旧 watcher 短暂并发）
        await this.globalWatcher?.close().catch(() => {})
        this.globalWatcher = null
        try {
          // 重扫缓存（可能抛错——scanFn 失败时保留旧 globalCache，不让缓存变空）
          this.globalCache = await this.scanFn('')
        } catch (e) {
          // scanFn 失败：不刷新缓存（保留旧值），但要保证 watcher 仍挂上（否则文件变动监不到，
          // 整个全局监听链断开，只有再次改 settings 或重启才能恢复）。
          console.error('[skill-registry] rebuildGlobal scanFn failed, keeping stale globalCache and reattaching watcher:', e)
        } finally {
          // 无论 scanFn 成败，重挂 watcher（读最新 configStore，新路径纳入视野）——
          // 兜底重建监听，避免 scanFn 异常导致全局 watcher 永久断链。
          this.setupGlobalWatcher()
        }
        // 通知上游（触发 onChange → 广播 config.skillCacheInvalidated + reloadOrchestrator）
        await this.notifyGlobalChange()
      } finally {
        this.rebuildInFlight = null
      }
    })()
    return this.rebuildInFlight
  }

  /** 当前全局 skill 缓存（启动期扫描结果，watcher 变动后自动刷新）。 */
  getGlobalSkills(): SkillInfo[] {
    return this.globalCache
  }

  /**
   * 取指定项目根下的 skill 列表。首次扫描 + 挂 watcher + 缓存；后续命中缓存零开销。
   * 不同 cwd 互不污染（projectCache 按 cwd 分区，架构约定 #7.6 Map 分区范式）。
   *
   * 并发安全：用 in-flight Promise Map 防止 TOCTOU 竞态。若同一 cwd 的多个请求并发到达
   * （多 panel / 多窗口同 cwd），它们共享同一次 scanFn + watch()，不会各自创建 watcher
   * 导致第二个 set 覆盖丢掉第一个 watcher（fd 泄漏）。
   *
   * W3 缓存命中补查：首次扫描时项目 skill 目录可能不存在（被 existsSync 过滤，没挂 watcher），
   * 后来用户创建了该目录——缓存命中路径补一次轻量检查，发现「应 watch 但无 watcher」的目录时
   * 异步补挂 watcher + 重扫刷新缓存（不阻塞当前返回，刷新完经 notifyProjectChange 通知上游）。
   */
  getProjectSkills(cwd: string): Promise<SkillInfo[]> {
    if (this.disposed) return Promise.resolve([])
    const cached = this.projectCache.get(cwd)
    if (cached) {
      // W3：补查首次扫描时不存在、后来用户创建的 skill 目录。检测到则异步补挂 watcher + 重扫缓存，
      // 不阻塞当前返回（返回缓存旧值），重扫完成后 notifyProjectChange 通知上游刷新。
      const dirs = resolveProjectSkillDirs(cwd, this.options.configStore).filter(d => existsSync(d))
      const existingWatcher = this.projectWatchers.get(cwd)
      // [G4] 缓存命中刷新 watcher recency（活跃 cwd 不被后续新 cwd 挤出 LRU）
      if (existingWatcher) this.touchProjectWatcher(cwd)
      if (dirs.length > 0 && !existingWatcher) {
        void this.refreshProjectWatcher(cwd, dirs)
      }
      return Promise.resolve(cached)
    }

    const inFlight = this.projectInFlight.get(cwd)
    if (inFlight) return inFlight

    const p = (async () => {
      const skills = await this.scanFn(cwd)
      // invalidate 后不应由 in-flight 路径写回缓存（缓存重建交由下次 getProjectSkills 触发）。
      // 注意：scanFn 读的是当前 configStore，in-flight 完成的结果本身并不"陈旧"，只是缓存状态由
      // invalidate 流程接管，in-flight 写回会与该流程竞态。
      if (!this.projectInFlight.has(cwd)) return skills
      this.projectCache.set(cwd, skills)
      // 挂项目 watcher：watch 范围 = scan 范围（SSOT），只 watch 实际存在的项目 skill 子目录
      // （.taiji/skills、discovery 相对路径 resolve 后），不递归 watch 整个 cwd。
      // 原实现 watch 整个 cwd → cwd 为 home 目录时 chokidar 递归 watch 几十万文件 → EMFILE fd 耗尽
      // → pi spawn EBADF → 发消息/读历史全挂 + runtime 崩溃（2026-07-22 事故根因）。
      const dirs = resolveProjectSkillDirs(cwd, this.options.configStore).filter(d => existsSync(d))
      if (dirs.length > 0) {
        this.setupProjectWatcher(cwd, dirs)
      }
      // dirs 为空（项目无 skill 目录）时不挂 watcher：无 skill 可监听，缓存已 set（上面 scan 结果），返回即可。

      return skills
    })().finally(() => {
      this.projectInFlight.delete(cwd)
    })

    this.projectInFlight.set(cwd, p)
    return p
  }

  /**
   * 清空所有项目级缓存 + close 所有 project watcher（settings 改 skill 相对路径后调用）。
   * 下次 getProjectSkills(cwd) 会重扫重建。setSkillDirs 改了相对路径配置，所有已缓存 cwd 都可能受影响，
   * 故清整个 projectCache（保守策略，skill 扫描快，O(N) 重扫可接受）。
   * 不发广播——由调用方显式 broadcastSkillCacheInvalidated('project')。
   */
  invalidateAllProjects(): void {
    // close 所有 project watcher（close 失败须留痕——静默吞会掩盖 fd 回收异常，无日志的降级 unreasonable）
    for (const [cwd, watcher] of this.projectWatchers.entries()) {
      watcher.close().catch((e: unknown) => {
        console.warn(`[skill-registry] project:${cwd} invalidateAllProjects close failed:`, e)
      })
    }
    this.projectWatchers.clear()
    this.projectWatcherLru.length = 0 // [G4] watcher 全清，LRU 序随同清空
    this.projectCache.clear()
    // 清 in-flight：避免在途 getProjectSkills Promise resolve 后把旧扫描结果写回已清空的缓存。
    // 竞态：invalidate 后 in-flight 完成会 projectCache.set 旧值 + setupProjectWatcher(新 dirs)，
    // 导致缓存（旧扫描）与 watcher（新目录）发散。清 Map 后 getProjectSkills 的 finally 守卫
    // 检测到 key 已不存在，跳过写回（in-flight 完成时 finally delete 不存在的 key 无副作用）。
    this.projectInFlight.clear()
    // 清 project 级 debounce timer：避免 pending 重扫在 dispose 后写回陈旧缓存。
    // 仅清 project 级（cwd key），保留 GLOBAL_KEY 的 timer（global 由 rebuildGlobal 独立处理）。
    // pending 事件随 timer 一并丢弃（同 rebuildGlobal 的 GLOBAL_KEY 处理）。
    for (const [key, timer] of this.debounceTimers.entries()) {
      if (key !== GLOBAL_KEY) {
        clearTimeout(timer)
        this.debounceTimers.delete(key)
        this.pendingWatcherEvents.delete(key)
      }
    }
  }

  /**
   * 挂项目 watcher（getProjectSkills 首次挂载与 refreshProjectWatcher 补挂共用，避免重复代码）。
   * watch 范围 = scan 范围（SSOT）：只 watch 传入的实际存在项目 skill 子目录。
   */
  private setupProjectWatcher(cwd: string, dirs: string[]): void {
    const watcher = watch(dirs, WATCH_OPTIONS)
    this.setupWatcher(watcher, `project:${cwd}`, cwd, async () => {
      this.projectCache.set(cwd, await this.scanFn(cwd))
      await this.notifyProjectChange(cwd)
    })
    this.projectWatchers.set(cwd, watcher)
    // [G4] 挂载即 touch（首次挂载 + W3 补挂重挂共用本方法）并按需驱逐最旧
    this.touchProjectWatcher(cwd)
  }

  /**
   * [G4] touch cwd 的 watcher recency 并按需驱逐：超过 MAX_PROJECT_WATCHERS 个时从 LRU 头
   * （最久未访问）驱逐——close 释放 fd。close 异步完成：fire-and-forget + .catch 吞错
   * （与 dispose / invalidateAllProjects 同款惯例）；被驱逐 cwd 的重挂由下次 getProjectSkills
   * 缓存命中的 W3 补挂路径承接。
   */
  private touchProjectWatcher(cwd: string): void {
    const idx = this.projectWatcherLru.indexOf(cwd)
    if (idx >= 0) this.projectWatcherLru.splice(idx, 1)
    this.projectWatcherLru.push(cwd)
    while (this.projectWatcherLru.length > MAX_PROJECT_WATCHERS) {
      const evicted = this.projectWatcherLru.shift()!
      const watcher = this.projectWatchers.get(evicted)
      if (watcher) {
        // close 失败降级本身不致命（watcher 可能已自行销毁），但静默吞会掩盖 fd 回收异常——降级须留痕
        watcher.close().catch((e: unknown) => {
          console.warn(`[skill-registry] project:${evicted} LRU evict close failed:`, e)
        })
        this.projectWatchers.delete(evicted)
      }
    }
  }

  /** [G4] 从 LRU 序摘除 cwd（watcher 已被熔断/清理路径关闭时防幽灵条目残留）。 */
  private dropProjectWatcherLru(cwd: string): void {
    const idx = this.projectWatcherLru.indexOf(cwd)
    if (idx >= 0) this.projectWatcherLru.splice(idx, 1)
  }

  /**
   * 补挂项目 watcher + 重扫缓存 + 通知上游（W3）。
   * 场景：首次扫描时 skill 目录不存在（无 watcher），后来用户创建了该目录——本方法补挂 watcher
   * 让后续变动可监听，并立即重扫一次刷新缓存（新出现的 skill 进缓存），最后 notifyProjectChange
   * 通知上游刷新到最新状态。setupProjectWatcher 同步完成 watcher 注册（防并发补挂重复），重扫异步。
   */
  private async refreshProjectWatcher(cwd: string, dirs: string[]): Promise<void> {
    this.setupProjectWatcher(cwd, dirs)
    this.projectCache.set(cwd, await this.scanFn(cwd))
    await this.notifyProjectChange(cwd)
  }

  /**
   * 注册 skill 变更回调。返回 unsubscribe 函数（组件卸载时调，防泄漏）。
   * 回调参数 SkillChangeEvent：全局变动 scope='global'（cwd 缺省）；项目变动 scope='project'（带 cwd）。
   */
  onChange(handler: (event: SkillChangeEvent) => void): () => void {
    this.changeHandlers.add(handler)
    return () => {
      this.changeHandlers.delete(handler)
    }
  }

  /**
   * 通知上游：全局 skill 变动。affectedSessionIds = 所有活跃 session（全局变动影响所有人）。
   * 前缀 _ 表示测试可直调（U3 模拟全局目录变动触发通知）。
   */
  async notifyGlobalChange(): Promise<void> {
    const ids = this.getAffectedSessionIds()
    for (const handler of this.changeHandlers) {
      handler({ scope: 'global', affectedSessionIds: ids })
    }
  }

  /**
   * 通知上游：指定 cwd 的项目 skill 变动。affectedSessionIds = cwd 匹配的活跃 session。
   */
  async notifyProjectChange(cwd: string): Promise<void> {
    const affected = this.getAffectedSessionIds(cwd)
    for (const handler of this.changeHandlers) {
      handler({ scope: 'project', cwd, affectedSessionIds: affected })
    }
  }

  /**
   * 受影响 session 的单一计算口径（通知 payload 与 D8-a 归因日志共用，防两处过滤逻辑漂移）：
   * global（cwd 缺省）= 全部活跃 session；project = getSessionCwd 匹配的活跃 session
   * （getSessionCwd 未注入时降级为全部——与原 notifyProjectChange 行为一致）。
   */
  private getAffectedSessionIds(cwd?: string): string[] {
    const allIds = this.options.sessionService.getActiveSessionIds()
    if (cwd === undefined) return allIds
    // 经宿主对象调用（保 this）：解绑提取（const fn = svc.fn）后调用会因 this=undefined
    // 炸 TypeError，且发生在 watcher debounce 定时器里 = uncaughtException 整机崩。
    // bind 提取而非裸引用：既保 this，又让可选方法的 truthiness narrowing 落到局部
    // 变量上（可选方法二次属性访问不继承 narrowing，TS2722）。
    const sessionService = this.options.sessionService
    const getSessionCwd = sessionService.getSessionCwd?.bind(sessionService)
    return getSessionCwd ? allIds.filter(sid => getSessionCwd(sid) === cwd) : allIds
  }

  // 测试兼容别名（保持测试用 _notifyGlobalChange 不破坏，内部转发到 notifyGlobalChange）
  async _notifyGlobalChange(): Promise<void> {
    return this.notifyGlobalChange()
  }

  /**
   * 关闭所有 watcher + 清兜底定时器 + 清缓存与 in-flight 状态（全局 + 项目级）。shutdown / 测试清理时调。
   *
   * W-dispose：必须清 projectInFlight——竞态场景下 getProjectSkills 进入 in-flight await scanFn →
   * 期间调 dispose → scanFn resolve → 守卫 projectInFlight.has(cwd) 仍 true → 走 projectCache.set +
   * setupProjectWatcher → 新建 watcher 加入已清空的 projectWatchers，无人 close（泄漏）。清 Map 后
   * in-flight 的 finally 守卫检测到 key 已不存在，跳过写回（与 invalidateAllProjects 对称）。
   * 同时清 changeHandlers（防 stale 引用回调）、projectCache/globalCache（释放内存），并置 disposed
   * 标志——后续 getProjectSkills/rebuildGlobal 入口直接 return，杜绝 dispose 后 in-flight 写回。
   */
  dispose(): void {
    this.disposed = true
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer)
      this.fallbackTimer = null
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
    this.pendingWatcherEvents.clear()
    this.globalWatcher?.close().catch((e: unknown) => {
      console.warn('[skill-registry] global watcher dispose close failed:', e)
    })
    this.globalWatcher = null
    for (const [cwd, watcher] of this.projectWatchers.entries()) {
      watcher.close().catch((e: unknown) => {
        console.warn(`[skill-registry] project:${cwd} dispose close failed:`, e)
      })
    }
    this.projectWatchers.clear()
    this.projectWatcherLru.length = 0 // [G4] watcher 全清，LRU 序随同清空
    this.projectInFlight.clear()
    this.rebuildInFlight = null
    this.changeHandlers.clear()
    this.projectCache.clear()
    this.globalCache = []
  }

  /**
   * 统一设置 watcher 的 error 处理（熔断）+ all 事件（debounce 重扫）。
   *
   * 熔断：watcher 连续同类错误（如 EMFILE）达 MAX_WATCHER_ERRORS 次时主动 close 该 watcher。
   * 背景：chokidar 遇 EMFILE 会自动重试 watch，但 fd 已耗尽时重试必再失败 → 死循环刷屏（事故中
   * 10899 次）。熔断后停止重试，释放该 watcher 占用的句柄，让 pi spawn 等关键操作能拿到 fd。
   *
   * label：日志标识（'global' / 'project:<cwd>'）。debounceKey：debounce 分区 key。rescan：变动时的重扫回调。
   */
  private setupWatcher(
    watcher: FSWatcher,
    label: string,
    debounceKey: string,
    rescan: () => Promise<void>,
  ): void {
    let errorCount = 0
    let lastCode = ''
    watcher.on('error', (e: unknown) => {
      const err = e as NodeJS.ErrnoException
      const code = err?.code ?? 'UNKNOWN'
      if (code === lastCode) {
        errorCount++
      } else {
        errorCount = 1
        lastCode = code
      }
      if (errorCount >= MAX_WATCHER_ERRORS) {
        console.error(
          `[skill-registry] ${label} watcher circuit-break: ${errorCount} consecutive ${code} errors, closing watcher`,
        )
        // 熝断后摘除 listener + 从 watchers Map 删除引用，避免后续同类错误反复调 close()
        // （S2）以及 dispose 时对已关闭 watcher 重复 close。注意：熔断后该 cwd 的 skill
        // 列表将不再自动刷新，需重启 session 才能恢复——这是 fd 耗尽场景下的安全网取舍。
        watcher.removeAllListeners('error')
        watcher.removeAllListeners('all')
        watcher.close().catch(() => {})
        if (debounceKey !== GLOBAL_KEY) {
          this.projectWatchers.delete(debounceKey)
          this.dropProjectWatcherLru(debounceKey) // [G4] 熔断摘除时同步退出 LRU 序
        } else if (this.globalWatcher === watcher) {
          this.globalWatcher = null
        }
        // W4：熔断后推终态通知——让上游（renderer）刷新到当前缓存状态（最后一次已知值），
        // 避免 watcher 已停但 skill 列表与磁盘发散而上游无感知。setupWatcher 同步、notify 异步，
        // 用 void 前缀不阻塞 error 回调。debounceKey === GLOBAL_KEY 走全局通知，否则按 cwd 通知。
        if (debounceKey === GLOBAL_KEY) {
          void this.notifyGlobalChange()
        } else {
          void this.notifyProjectChange(debounceKey)
        }
        lastCode = ''
        errorCount = 0
      } else {
        console.error(`[skill-registry] ${label} watcher error (${errorCount}/${MAX_WATCHER_ERRORS} ${code}):`, err)
      }
    })
    watcher.on('all', (event: string) => {
      // [skill-reload D8-a] 登记事件类型到 debounce 窗口（批触发时随归因日志一并取出，
      // 不逐事件落日志）。事件名透传 chokidar 原生枚举（add/addDir/change/unlink/unlinkDir），
      // 不收敛到设计枚举——目录级 add/unlink 与文件级在归因上是不同因果。
      let events = this.pendingWatcherEvents.get(debounceKey)
      if (!events) {
        events = new Set()
        this.pendingWatcherEvents.set(debounceKey, events)
      }
      events.add(event)
      void this.debounce(debounceKey, rescan)
    })
  }

  // ── 内部工具 ──────────────────────────────────────────────────

  /**
   * 默认扫描实现：复用 ConfigService.loadSkills（封装优先级合并 / 容器目录遍历 / sources badge 链）。
   *
   * W2：configStore 用构造期注入的 options.configStore（scanner↔watcher SSOT 一致——两者都从同一份
   * configStore 读目录发现，不再各自 new PiConfigStore 导致隐式分叉）。动态 import ConfigService
   * 避免顶层硬依赖（循环依赖防护 + 测试隔离）。
   *
   * S5：全局扫描（projectRoot 为空串）时**不**传 process.cwd()——否则 loadSkills 会把 process.cwd()
   * 下的项目 skill（.taiji/skills 等）扫进 globalCache，这些条目进了 globalCache 却不被全局
   * watcher 监听（全局 watch 范围 = resolveGlobalSkillDirs，不含项目目录），导致缓存与磁盘发散。
   * 改用一个 os.tmpdir() 下不存在的子路径作为 root：loadSkills 的全局目录（绝对路径）正常扫，
   * 项目目录（相对该 root resolve）全部不存在 → 不扫。不真创建该临时目录。
   *
   * projectRoot 非空（项目扫描）：传 cwd（解析 discovery.json 相对路径的基准）。
   */
  private async defaultScanFn(projectRoot: string): Promise<SkillInfo[]> {
    const { ConfigService } = await import('./config-service.js')
    // ConfigService 构造函数要求完整 IConfigStore（含 provider/agent CRUD 等），而 options.configStore
    // 是窄接口 SkillRegistryConfigStore（仅 getSkillPaths / getPiAgentDir）。loadSkills 内部实际只
    // 调这两个方法（经 resolveGlobalSkillDirs / resolveProjectSkillDirs），故运行时安全但类型不兼容——
    // 用 unknown 中转 cast，避免 any（架构约定：禁 any）。
    const configStore = this.options.configStore as unknown as IConfigStore
    // S5：全局扫描用不存在的 root，让 loadSkills 只扫全局目录，避免 process.cwd() 项目 skill 混入 globalCache。
    const root = projectRoot || join(tmpdir(), `skill-registry-global-scan-${process.pid}`)
    const configService = new ConfigService(root, configStore)
    return configService.loadSkills(root)
  }

  /**
   * debounce 包装：相同 key 的多次触发合并为一次（DEBOUNCE_MS 后执行）。
   * key 区分全局（GLOBAL_KEY）与各项目 cwd，互不干扰。
   *
   * [skill-reload D8-a] 批触发边界落一行归因日志（`[skill-reload] dir= event=
   * affectedSessions=[...]`）：窗口内累计的事件类型合并为一行，回答「哪个目录的
   * 哪类变动 → 影响哪些 session」，与下游 orchestrator 的 decision= 行串出因果链
   * （G4/S4）。无累计事件（非 watcher 路径的直调）不落日志。
   */
  private debounce(key: string, fn: () => Promise<void>): NodeJS.Timeout {
    const existing = this.debounceTimers.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key)
      // watcher 归因日志是辅助功能：其同步段任何 throw 不得升级为 uncaughtException
      // 整机崩（44beb27cf 事故的类级兜底——实例级修复只保住 getSessionCwd 一处，
      // 后续往该段加任何会 throw 的代码都会复活整机杀链）。降级 = 跳过本批归因。
      // rescan 主链（fn）必须在 try 之外：归因失败不得吞掉重扫通知义务；fn 是
      // async 函数，同步 throw 语义上变成 rejected promise，由全局 unhandledRejection
      // handler 兜底（只记日志不崩）。
      try {
        this.logWatcherBatch(key)
      } catch (err) {
        // 降级：归因是辅助日志，失败只记 stderr 不传播——重扫义务由下方 fn 独立承接（理由见上方注释）
        console.error(
          `[skill-registry] watcher batch attribution failed (degraded, rescan continues): ${
            err instanceof Error ? err.stack ?? err.message : String(err)
          }`,
        )
      }
      void fn()
    }, DEBOUNCE_MS)
    this.debounceTimers.set(key, timer)
    return timer
  }

  /**
   * [skill-reload D8-a] watcher 批归因日志：dir 用 debounceKey 的 label 形态（global /
   * project:<cwd>，与熔断/兜底重扫日志的 tag 一致）；affectedSessions 与通知 payload
   * 共用 getAffectedSessionIds 单一口径。
   */
  private logWatcherBatch(key: string): void {
    const events = this.pendingWatcherEvents.get(key)
    if (!events || events.size === 0) return
    this.pendingWatcherEvents.delete(key)
    const dir = key === GLOBAL_KEY ? 'global' : `project:${key}`
    const affected = this.getAffectedSessionIds(key === GLOBAL_KEY ? undefined : key)
    console.log(
      `[skill-reload] dir=${dir} event=${[...events].join(',')} affectedSessions=[${affected.join(',')}]`,
    )
  }
}
