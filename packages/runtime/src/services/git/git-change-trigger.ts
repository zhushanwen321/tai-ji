/**
 * GitChangeTrigger —— git 观测刷新到 UI 送达的「最后一公里」触发器（缓存治理批 4 U11）。
 *
 * 徽章绑定 session.gitBranch，数据管道是既有 `config.sessions` 推送——观测器缓存变新鲜
 * 不等于徽章更新，必须有「刷新 → 值变化判定 → 节流 → 列表重扫 → 广播」的主动消费环节
 * （设计 §3.4.2.1 方案 A：复用 config.sessions 通道，禁止新建独立 git 广播通道）。
 *
 * **统一入口**：refresh() 是 watch 事件链与 L2 兜底重扫两条路径的唯一入口（设计 §3.4.3
 * 触发器挂点规格——触发器挂在「观测器缓存更新」统一入口上，不存在「只挂 watch 回调」
 * 的另一挂法）。因此 L2 兜底修正 branch 后同样经值变化判定 + 节流 + 广播送达前端。
 *
 * 每次刷新对单个 cwd 的动作序列：
 * 1. 读旧值（观测器缓存命中语义）；
 * 2. invalidateByCwd（观测器条目 + GitStateService statusCache 相关键一并失效——数据流图 3
 *    的「通知 statusCache 相关键失效」步骤）；
 * 3. 再读（miss 强制 resolver 重解析并回填观测器）；
 * 4. 值变化判定：branch 无变化不推送（广播频率第一重有界）。
 *
 * 节流（第二重有界）：leading 首变立即放行，2s 窗口只合并后续连发（窗口到点收尾执行一次，
 * 连发不延长窗口）——git switch 后徽章 2s 判据可达（首变不受窗口延迟）。
 * 「重扫 + 广播」由 deps.pushSessionList 一体承载（生产 = server.broadcastSessionList，
 * 内部即 listPersistedSessions——sessionMetaCache 命中态成本 = stat 一轮 + 门面同步内存读）。
 *
 * 🔒 三层架构：services 编排；观测器访问经结构化窄面 GitObservationPort（GitStateService
 * 结构满足），广播经函数注入（组合根闭包），不 import infra / transport。
 */
import type { RepoObservation } from '../ports/git-info.js'

/** 节流窗口（设计 §3.4.2.1：leading 首变立即放行，2s 窗口只合并后续连发）。 */
const BRANCH_PUSH_THROTTLE_MS = 2_000

/**
 * 观测器访问窄面：读观测快照 + 按 cwd 失效（观测器条目与 statusCache 相关键）。
 * GitStateService 结构满足（readObservation / invalidateByCwd 均 public）。
 */
export interface GitObservationPort {
  readObservation(cwd: string): RepoObservation
  invalidateByCwd(cwd: string): void
}

export interface GitChangeTriggerDeps {
  observations: GitObservationPort
  /** 重扫 session 列表并经既有 config.sessions 通道广播（生产 = server.broadcastSessionList）。 */
  pushSessionList(): void
  /** 测试可注入短节流窗口（默认 2s）。 */
  throttleWindowMs?: number
}

/** 刷新来源：watch 事件链 / L2 兜底重扫（兜底修正 branch 时 warn——平台 watch 缺陷复发的可观测信号）。 */
export type GitRefreshSource = 'watch' | 'fallback'

export class GitChangeTrigger {
  private readonly observations: GitObservationPort
  private readonly pushSessionList: () => void
  private readonly throttleWindowMs: number
  /** 上次放行时刻（leading 语义的窗口起点）。 */
  private lastPushAt = Number.NEGATIVE_INFINITY
  /** 窗口收尾合并 timer（窗口内已有连发在等待时非 null；连发不重置、不延长窗口）。 */
  private trailingTimer: NodeJS.Timeout | null = null
  /**
   * 值变化判定的锚：per-cwd 上次判定变化并承诺推送的 branch（= 前端应已知晓的值）。
   * 不能用「观测器缓存态」当锚——readObservation 在 TTL 过期时惰性重解析并回填，
   * 冷缓存（闲置 >TTL 后的首次刷新）下旧值读取本身就解析出**新** branch 并写缓存，
   * before===after 恒成立，变更被静默吞掉且缓存已被刷成新值，之后 L2 兜底同锚判定
   * 也判「无变化」——徽章无限期陈旧（冷缓存吞变更形态）。锚必须是跨缓存生命周期
   * 独立记忆的「上次推送值」。
   */
  private readonly lastPushedBranch = new Map<string, string | undefined>()

  constructor(deps: GitChangeTriggerDeps) {
    this.observations = deps.observations
    this.pushSessionList = deps.pushSessionList
    this.throttleWindowMs = deps.throttleWindowMs ?? BRANCH_PUSH_THROTTLE_MS
  }

  /**
   * 统一入口：刷新 cwd 集合的观测值，任一 branch 值变化经节流触发重扫 + 广播。
   * watch 事件链（source='watch'）与 L2 兜底（source='fallback'）都经此，无旁路。
   */
  refresh(cwds: ReadonlySet<string>, source: GitRefreshSource): void {
    let changed = false
    for (const cwd of cwds) {
      if (this.refreshOne(cwd, source)) changed = true
    }
    if (changed) this.requestPush()
  }

  /** dispose：撤销未放行的窗口收尾 timer（runtime shutdown 收口）。 */
  dispose(): void {
    if (this.trailingTimer) {
      clearTimeout(this.trailingTimer)
      this.trailingTimer = null
    }
  }

  /**
   * 收缩锚记忆（repo-observer onPrune 联动——与 GitHeadWatcher.forget 同一回调接线）：
   * 被驱逐/修剪 cwd 的锚删除，防 Map 随历史 cwd 无界增长。锚删除后该 cwd 若重新进入
   * 观测，refreshOne 走建锚路径（lastPushed === undefined）重新承诺推送，语义与进程
   * 刚启动时一致。
   */
  forget(cwds: ReadonlySet<string>): void {
    for (const cwd of cwds) this.lastPushedBranch.delete(cwd)
  }

  /**
   * 单 cwd 刷新：锚（上次推送值）→ invalidateByCwd → 强制重解析 → 值变化判定。
   * 返回该 cwd 的 branch 是否变化；兜底路径的修正 console.warn（高频出现 = 平台 watch
   * 缺陷复发信号，设计 §3.4.4 错误规格表）。
   */
  private refreshOne(cwd: string, source: GitRefreshSource): boolean {
    const lastPushed = this.lastPushedBranch.get(cwd)
    this.observations.invalidateByCwd(cwd)
    const after = this.observations.readObservation(cwd).branch
    if (lastPushed === after) return false
    this.lastPushedBranch.set(cwd, after)
    // 首刷建锚（lastPushed === undefined）不是「修正」——warn 语义锚定「已知值被
    // 兜底改写」（高频 = watch 缺陷复发的观测信号）；首个 L2 tick 对静默 repo 必
    // 走建锚路径，若 warn 会每个启动周期刷一条噪音，稀释该信号。
    if (source === 'fallback' && lastPushed !== undefined) {
      console.warn(
        `[git-change-trigger] fallback rescan corrected branch: cwd=${cwd} ${formatBranch(lastPushed)} -> ${formatBranch(after)}` +
          '（L2 兜底修正——高频出现说明平台 watch 缺陷复发）',
      )
    }
    return true
  }

  /**
   * leading 节流：窗口外首变立即放行（同步，git switch 徽章 2s 判据的保证）；窗口内的
   * 后续变化只在无 timer 时排一个「剩余窗口时长」的收尾 timer——到点合并执行一次，
   * 后续连发不重置不延长窗口。
   */
  private requestPush(): void {
    const remaining = this.throttleWindowMs - (Date.now() - this.lastPushAt)
    if (remaining <= 0) {
      this.fire()
      return
    }
    if (this.trailingTimer) return
    this.trailingTimer = setTimeout(() => {
      this.trailingTimer = null
      this.fire()
    }, remaining)
    // 节流收尾是正常路径的一部分（窗口内连发的唯一送达机会），unref 仅为不阻进程退出
    this.trailingTimer.unref()
  }

  private fire(): void {
    this.lastPushAt = Date.now()
    this.pushSessionList()
  }
}

function formatBranch(branch: string | undefined): string {
  return branch ?? '(undefined)'
}
