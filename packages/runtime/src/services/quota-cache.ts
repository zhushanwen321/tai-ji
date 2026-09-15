/**
 * QuotaCache — 额度查询缓存持久化层。
 *
 * 职责：
 * - 读写 `<dataDir>/quota-cache.json`（原子写：.tmp → rename）
 * - 失败不删除旧缓存（只 log）
 * - 除 fetcher 变更 / provider 删除的定点删除（removeEntry）外不主动删除——只有用户
 *   手动清除数据目录时才会丢失其余条目
 *
 * 架构约定 #2：路径用 getDataDir() 动态推导。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { NormalizedQuotaRow } from '@taiji/shared'
import { logger } from '../infra/logger.js'

const CACHE_FILENAME = 'quota-cache.json'
const CACHE_INDENT = 2

export interface QuotaCacheEntry {
  data: NormalizedQuotaRow
  lastFetchAt: number
}

export interface QuotaCacheFile {
  /** providerId → 缓存条目 */
  providers: Record<string, QuotaCacheEntry>
}

export class QuotaCache {
  private filePath: string
  /**
   * 内存镜像（微项 11 quota 缓存内存层，00 §5 微项表「quota 缓存加内存层」）。
   *
   * getEntry 命中内存零磁盘读（hover 浮层反复 getCached 不再每次 readFileSync 整个
   * quota-cache.json）；null = 未加载。镜像与磁盘的一致性维护：
   *   - 首次 getEntry / 内存 miss → 从磁盘 read() 加载
   *   - doUpdate 读磁盘（保持跨实例「读-改-写」合并语义不变）写盘成功后同步为合并结果
   * 内存 miss 回退磁盘重载（可见性口径：仅 miss 时重载磁盘——外部写入对已缓存 provider
   * 不可见，直到 update() 同步内存镜像或进程重启；改造前每次读磁盘，缓存命中零读为收益）。
   */
  private memoryCache: QuotaCacheFile | null = null

  constructor(dataDir: string) {
    this.filePath = join(dataDir, CACHE_FILENAME)
  }

  /** 读取缓存（文件不存在返回空对象）。 */
  read(): QuotaCacheFile {
    try {
      if (!existsSync(this.filePath)) return { providers: {} }
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as QuotaCacheFile
      if (!parsed || typeof parsed !== 'object' || !parsed.providers) {
        return { providers: {} }
      }
      return parsed
    } catch (err) {
      // 读取失败不阻断流程（返回空缓存），但必须 log（架构约定 #4 落盘，禁止静默 catch）
      const msg = err instanceof Error ? err.message : String(err)
      logger.debug('[quota-cache] failed to read cache file', { error: msg })
      return { providers: {} }
    }
  }

  /** 读取单个 provider 的缓存（内存层优先，命中零磁盘读）。 */
  getEntry(providerId: string): QuotaCacheEntry | null {
    let cache = this.memoryCache
    if (!cache) {
      cache = this.read()
      this.memoryCache = cache
    }
    const entry = cache.providers[providerId]
    if (entry) return entry
    // 内存 miss：重载一次内存镜像（读失败返回空对象不抛）。
    // 可见性口径（审查修正）：仅内存 miss 时重载磁盘——外部写入对已缓存 provider 不可见，
    // 直到 update() 同步内存镜像或进程重启；未缓存 provider 的 miss 重载可见磁盘最新。
    // 单次重载后仍 miss = provider 确实无缓存，下次查询重复此路径；存在的 provider 恒命中
    // 内存零读（微项 11 收益点）。
    this.memoryCache = this.read()
    return this.memoryCache.providers[providerId] ?? null
  }

  /**
   * 写入串行化链（基于 Promise 的简单 mutex）。
   *
   * [W6] 不同 providerId 的并发 update 是 read(整文件)→modify(内存合并)→write(rename)，
   * 不串行化会丢数据（A 读 → B 读 → A 写 → B 写覆盖 A）。所有 update 串到同一条链上，
   * 保证「读-改-写」原子性。read 不需要锁（并发读无副作用）。
   */
  private writeChain: Promise<void> = Promise.resolve()

  /**
   * 更新单个 provider 的缓存（原子写 + 串行化）。
   * 读取现有缓存 → 合并 → .tmp → rename。
   */
  update(providerId: string, data: NormalizedQuotaRow): void {
    // doUpdate 是同步方法（内部 try/catch 已吞掉所有错误，不会 throw），
    // 把每次调用串到同一条 writeChain 上（then(run, run)：前序链 settle 后必执行 run，
    // 既不丢写也不因前序失败断链），保证「读-改-写」互不交错。
    const run = () => {
      try {
        this.doUpdate(providerId, data)
      } catch (err) {
        // doUpdate 内部已 log 具体写入错误，此处仅防链中断（同步 doUpdate 理论不抛，
        // 但若 throw 需吞掉避免 unhandled rejection 中断 writeChain）
        const msg = err instanceof Error ? err.message : String(err)
        logger.debug('[quota-cache] writeChain caught unexpected error', { providerId, error: msg })
      }
    }
    this.writeChain = this.writeChain.then(run, run)
  }

  /** update 的实际实现（私有）。已串行化，调用方通过 update 入口。 */
  private doUpdate(providerId: string, data: NormalizedQuotaRow): void {
    try {
      const cache = this.read()
      cache.providers[providerId] = {
        data,
        lastFetchAt: Date.now(),
      }

      // [W1] 目录推导用 dirname()，修复 Windows 路径分隔符 bug：
      // 旧 substring(0, lastIndexOf('/')) 在 Windows（\ 分隔）下 lastIndexOf('/') 返回 -1 → 空串 → mkdirSync('') EINVAL
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      // 原子写：先写 .tmp，再 rename
      const tmpPath = `${this.filePath}.tmp`
      writeFileSync(tmpPath, JSON.stringify(cache, null, CACHE_INDENT), 'utf-8')
      renameSync(tmpPath, this.filePath)
      // 写盘成功同步内存镜像：此后 getEntry 命中内存零磁盘读，且与磁盘逐字节一致。
      // （写盘失败时不更新内存——内存仍反映最近一次成功持久化的数据，下次 update 重试。）
      this.memoryCache = cache
    } catch (err) {
      // 失败不删除旧缓存，只 log（架构约定 #4 落盘）
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('[quota-cache] failed to write cache', { error: msg })
      // 清理可能残留的 .tmp 文件
      try {
        const tmpPath = `${this.filePath}.tmp`
        if (existsSync(tmpPath)) unlinkSync(tmpPath)
      } catch (cleanupErr) {
        // 清理失败不阻断主流程，仅 debug 记录
        const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        logger.debug('[quota-cache] failed to cleanup tmp file', { error: cleanupMsg })
      }
    }
  }

  /**
   * 删除单个 provider 的缓存条目（coding-plan-quota-config-ux §7.3 改动 4：configure
   * 检测 fetcher 变更时失效旧类型的行——额度缓存按 provider 存储、不含类型，不清的话
   * 旧行会被 getCached 原样取回并以新类型标签展示）。
   *
   * 三条语义（缺一即失效，设计原文）：
   * ① 磁盘删除走 writeChain 与 update 串行化——remove 的读-删-写与并发 update
   *    （hover fetch 写缓存）的读-改-写互不交错，否则后写者基于陈旧读互相覆盖；
   * ② 同步删除 memoryCache 镜像中该条目——只删磁盘则内存镜像继续供旧值；只删内存
   *    则 getEntry 内存 miss 时 read() 从磁盘把旧行重载回来（两个方向都复现本改动
   *    要消除的现象）；
   * ③ 幂等：条目不存在视为成功，不物化文件。
   */
  removeEntry(providerId: string): void {
    // 同步段：立即从内存镜像删除（若已加载）。链 flush 前的窗口内 getEntry 内存 miss
    // 会从磁盘重载旧行——此刻磁盘删除尚未发生，旧行仍是当时真相，不算异常读；链
    // flush 后 doRemoveEntry 无条件同步镜像，删除对内存/磁盘同时生效、不会被还原。
    if (this.memoryCache) delete this.memoryCache.providers[providerId]
    const run = () => {
      try {
        this.doRemoveEntry(providerId)
      } catch (err) {
        // doRemoveEntry 内部已 log 写入错误，此处仅防链中断（与 update 同款：同步实现
        // 理论不抛，但若 throw 需吞掉避免 unhandled rejection 中断 writeChain）
        const msg = err instanceof Error ? err.message : String(err)
        logger.debug('[quota-cache] writeChain caught unexpected error', { providerId, error: msg })
      }
    }
    this.writeChain = this.writeChain.then(run, run)
  }

  /** removeEntry 的实际实现（私有）。已串行化，调用方通过 removeEntry 入口。 */
  private doRemoveEntry(providerId: string): void {
    try {
      const cache = this.read()
      if (providerId in cache.providers) {
        delete cache.providers[providerId]
        // [W1] 目录推导用 dirname()（Windows 路径分隔符，同 doUpdate）
        const dir = dirname(this.filePath)
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true })
        }
        // 原子写：先写 .tmp，再 rename（与 doUpdate 同款）
        const tmpPath = `${this.filePath}.tmp`
        writeFileSync(tmpPath, JSON.stringify(cache, null, CACHE_INDENT), 'utf-8')
        renameSync(tmpPath, this.filePath)
      }
      // 幂等：条目不存在视为成功（跳过写盘，不物化文件）。成功路径无条件同步镜像——
      // 删除后「内存=磁盘」口径统一，getEntry 的 miss-reload 不会把已删的行取回；
      // 失败路径仅 log（catch 分支不更新镜像）：此时内存镜像已在 removeEntry 同步段被删
      // 而磁盘保留旧行，下一次 getEntry 的 miss-reload 会把旧行取回（等价于删除未生效，
      // 由下次 update/removeEntry 重试）。
      this.memoryCache = cache
    } catch (err) {
      // 失败不删除旧缓存，只 log（架构约定 #4 落盘，与 doUpdate 同款降级）
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('[quota-cache] failed to remove cache entry', { error: msg })
      try {
        const tmpPath = `${this.filePath}.tmp`
        if (existsSync(tmpPath)) unlinkSync(tmpPath)
      } catch (cleanupErr) {
        const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        logger.debug('[quota-cache] failed to cleanup tmp file', { error: cleanupMsg })
      }
    }
  }
}
