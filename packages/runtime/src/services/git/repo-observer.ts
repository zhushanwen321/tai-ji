/**
 * GitRepoObserver —— branch / worktree / bare 判定的单一观测源缓存（缓存治理批 4 U10）。
 *
 * 合并原 gitInfoCache（git-info-reader，branch+worktree）与 bareCache（workspace-detector，
 * .bare 判定）为单一 per-cwd 缓存；解析经注入的 IGitRepoResolver（infra/system/git-repo-resolver，
 * walk-up 一次遍历同时产出 {isBare, gitDir, headPath} + branch）。本单元只做数据合并：
 * 失效机制沿用两套旧缓存的 TTL 语义（5min + oldest-insert 容量驱逐），fs.watch HEAD 事件驱动
 * 与最后一公里触发器是 U11 范围。
 *
 * 唯一实例规则：生产环境 getSharedRepoObserver() 单例是唯一缓存。GitStateService 经组合根显式
 * 注入该单例（观测器的 service 面）；workspace-detector 的 detectBareWorkspaceCached 模块门面直接
 * 读同一单例——两门面共享一份缓存，不存在第二份镜像。
 *
 * 🔒 三层架构：services 持有缓存策略（TTL/容量/prune），IO 经 IGitRepoResolver port 注入
 * （resolver 实例由组合根装配——本模块禁止 value import infra，C-comm-03 分层守卫）。
 */
import type { IGitRepoResolver, IGitRepoObserver, RepoObservation } from '../ports/git-info.js'

// eslint-disable-next-line no-magic-numbers -- 5 minutes = 5 * 60 * 1000ms, self-documenting with comment
const OBSERVE_TTL_MS = 5 * 60 * 1000
const OBSERVE_MAX_SIZE = 500

interface RepoCacheEntry {
  obs: RepoObservation
  ts: number
}

export interface GitRepoObserverOptions {
  resolver: IGitRepoResolver
  /** 测试可注入短 TTL（默认 5min，对齐原 gitInfoCache/bareCache 语义）。 */
  ttlMs?: number
  /** 测试可注入小容量帽（默认 500）。 */
  maxSize?: number
}

export class GitRepoObserver implements IGitRepoObserver {
  private readonly resolver: IGitRepoResolver
  private readonly ttlMs: number
  private readonly maxSize: number
  private readonly cache = new Map<string, RepoCacheEntry>()

  constructor(opts: GitRepoObserverOptions) {
    this.resolver = opts.resolver
    this.ttlMs = opts?.ttlMs ?? OBSERVE_TTL_MS
    this.maxSize = opts?.maxSize ?? OBSERVE_MAX_SIZE
  }

  /**
   * 同步读 cwd 的观测快照：命中直接返回**同一对象引用**（只读契约，消费方不得 mutate——
   * 与 GitStateService.statusCache 同款纪律）；miss 惰性同步解析并回填（热路径永不返回「待定」态）。
   */
  readObservation(cwd: string): RepoObservation {
    const now = Date.now()
    const cached = this.cache.get(cwd)
    if (cached && (now - cached.ts) < this.ttlMs) return cached.obs

    // 容量满时 O(1) 驱逐最老条目：JS Map 迭代序 = 插入序，配合下方「过期重写先 delete 再 set」
    // 维持「迭代序 = 最后写入时间升序」不变量，first key 恒为最旧条目（原 gitInfoCache 微项 10 同款）。
    // 已知边界（W16 审查 Fix-8 同款）：该不变量以 Date.now 单调为前提，时钟回拨下 first-key 驱逐
    // 可能非最旧——5min TTL 窗口内秒级回拨的影响可忽略，不做补偿。
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }

    const obs = this.resolver.resolve(cwd)
    // 过期重写先 delete 再 set：把条目移到 Map 尾部，维持上述不变量（set 对已有 key 不换位）
    this.cache.delete(cwd)
    this.cache.set(cwd, { obs, ts: now })
    return obs
  }

  /**
   * 按现有活跃 cwd 集合收缩缓存：不再被任何 session 引用、或 TTL 已过期的条目删除
   * （原 GitInfoReader.pruneStaleCache 与 pruneBareCache 收缩后的唯一动作，两门面共用本单点）。
   */
  pruneCache(existingCwds: Set<string>): void {
    const now = Date.now()
    for (const [key, entry] of this.cache) {
      if (!existingCwds.has(key) || (now - entry.ts) >= this.ttlMs) {
        this.cache.delete(key)
      }
    }
  }

  /** 按 cwd 精确失效（taiji git 写操作钩子；U11 起 watch 刷新链同打此处）。 */
  invalidateCwd(cwd: string): void {
    this.cache.delete(cwd)
  }

  /** 测试隔离用：清空缓存（@internal，仅供单测 beforeEach 调）。 */
  clearForTests(): void {
    this.cache.clear()
  }
}

/**
 * 生产共享单例（惰性装配）：detectBareWorkspaceCached 模块门面与组合根注入 GitStateService
 * 的同一份缓存。resolver 含 infra IO（walk-up + execSync），本模块在 services 层不得实例化它——
 * 组合根（index.ts）启动时调 initSharedRepoObserver(new GitRepoResolver()) 完成装配，装配前
 * 任何读方即抛错（fail-fast，不静默退化出第二份缓存）。
 * 测试隔离：__resetRepoCacheForTests 清缓存；解析桩经 vi.mock node:child_process 拦截真实
 * resolver 的 execSync（resolver 无状态，模块 mock 即可完全钉住解析行为）。
 */
let sharedInstance: GitRepoObserver | undefined

/** 组合根装配点：以注入的 resolver 创建生产共享单例（幂等重装配以新实例为准）。 */
export function initSharedRepoObserver(resolver: IGitRepoResolver): GitRepoObserver {
  sharedInstance = new GitRepoObserver({ resolver })
  return sharedInstance
}

/** 共享单例读取口：未装配即抛错（装配时序由组合根保证，热路径先于任何 session 消费）。 */
export function getSharedRepoObserver(): GitRepoObserver {
  if (sharedInstance === undefined) {
    throw new Error('sharedRepoObserver 未装配：组合根须先调 initSharedRepoObserver(resolver)')
  }
  return sharedInstance
}

/** 测试隔离用：清空共享单例缓存（@internal；未装配时 no-op）。 */
export function __resetRepoCacheForTests(): void {
  sharedInstance?.clearForTests()
}
