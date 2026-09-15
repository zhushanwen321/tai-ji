/**
 * RecentWorkspacesStore — 最近工作区持久化 + LRU 淘汰
 *
 * 封装 recent-workspaces.json 的读写，底层用 WriteBackCache 实现 write-back + debounce。
 * 单分区（'global'），内键 = cwd 绝对路径，值 = RecentWorkspaceRecord。
 *
 * 不变量：
 * - INV-1: cwd 非空串守卫（store 层兜底，service 层主守卫）
 * - INV-2: 最多保留 6 条，淘汰 lastUsedAt 最小者
 * - INV-3: 同 cwd 不重复，更新 lastUsedAt
 * - INV-4: 文件损坏返空，不抛
 * - INV-5: 路径从 configDir 动态推导，无硬编码
 */

import { join, dirname } from 'node:path'
import { basename } from 'node:path'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import type { RecentWorkspaceRecord } from '@taiji/shared'
import { WriteBackCache } from '../../utils/json-store.js'
import { atomicWrite } from '../../utils/fs-utils.js'
import { isEnoent } from '../../utils/errors.js'

const MAX_RECORDS = 6
const FILE_NAME = 'recent-workspaces.json'
const JSON_INDENT = 2

/** 分区键常量：全局唯一分区 */
const PARTITION_KEY = 'global' as const

export class RecentWorkspacesStore {
  private readonly cache: WriteBackCache<typeof PARTITION_KEY, string, RecentWorkspaceRecord>
  private readonly filePath: string

  /**
   * @param configDir taiji 配置根（~/.taiji/），由组合根注入，不硬编码。
   */
  constructor(configDir: string) {
    this.filePath = join(configDir, FILE_NAME)

    this.cache = new WriteBackCache<typeof PARTITION_KEY, string, RecentWorkspaceRecord>(
      {
        loadPartition: () => this.loadFromFile(),
        persistPartition: (_k, data) => this.persistToFile(data),
      },
      { flushMs: 500 },
    )
  }

  /**
   * 记录一次工作区使用。INV-1 兜底：空串静默跳过。
   * INV-3：同 cwd 覆盖更新（WriteBackCache.set 语义）。
   */
  record(cwd: string): void {
    if (!cwd || cwd.trim() === '') return

    this.cache.set(PARTITION_KEY, cwd, {
      cwd,
      lastUsedAt: Date.now(),
      label: basename(cwd),
    })

    // INV-2：超过上限淘汰最旧者
    this.trim()
  }

  /**
   * 返回最近工作区列表，按 lastUsedAt 倒序，≤6 条。
   */
  list(): RecentWorkspaceRecord[] {
    const keys = this.cache.keys(PARTITION_KEY)
    const records: RecentWorkspaceRecord[] = []
    for (const key of keys) {
      const record = this.cache.get(PARTITION_KEY, key)
      if (record) records.push(record)
    }
    // 按 lastUsedAt 倒序
    records.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    return records.slice(0, MAX_RECORDS)
  }

  /**
   * 立即持久化所有 dirty 数据（不等 debounce）。shutdown 或测试用。
   * 落盘保障 = per-write debounce 500ms + shutdown flushAll（无周期 flush 定时器）。
   */
  flushAll(): void {
    this.cache.flushAll()
  }

  // ── Private（WriteBackCache backing 回调） ──────────────────

  /**
   * 从文件加载分区数据。INV-4：文件损坏返空 Map，不抛。
   *
   * [W1] ENOENT（首启无文件）静默返空；其它错误（损坏/权限）console.warn 记录原因，
   * 避免 fail-silent（用户无法诊断「最近列表消失」）。两者都返空不抛。
   */
  private loadFromFile(): Map<string, RecentWorkspaceRecord> {
    try {
      if (!existsSync(this.filePath)) return new Map()
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as RecentWorkspaceRecord[]
      if (!Array.isArray(parsed)) return new Map()
      const map = new Map<string, RecentWorkspaceRecord>()
      const home = homedir()
      for (const record of parsed) {
        if (record && typeof record.cwd === 'string' && record.cwd) {
          // [方案A自愈] 跳过 homedir 条目：守卫挡新 record，此处清理存量
          if (record.cwd === home) continue
          map.set(record.cwd, record)
        }
      }
      return map
    } catch (e) {
      // INV-4：文件损坏 / ENOENT 返空（不抛）。ENOENT 是首启正常态静默；
      // 其它错误（损坏/权限）记 warn 便于诊断，避免 fail-silent。
      if (isEnoent(e)) return new Map()
      console.warn('[recent-workspaces] load failed, starting fresh:',
        e instanceof Error ? e.message : e)
      return new Map()
    }
  }

  /**
   * 持久化分区数据到文件。sync atomicWrite（KB 级，event loop 无感）。
   *
   * [W1] 目录推导用 dirname()（与 JsonStore 一致），修复 Windows 路径分隔符 bug：
   * 旧 substring(0, lastIndexOf('/')) 在 Windows（\ 分隔）下得空串 → mkdirSync('') EINVAL。
   */
  private persistToFile(data: Map<string, RecentWorkspaceRecord>): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const records = Array.from(data.values())
    atomicWrite(this.filePath, JSON.stringify(records, null, JSON_INDENT))
  }

  /**
   * INV-2：超过 MAX_RECORDS 时淘汰 lastUsedAt 最小者。
   * 在每次 record 后调用。
   */
  private trim(): void {
    const keys = this.cache.keys(PARTITION_KEY)
    if (keys.length <= MAX_RECORDS) return

    // 找 lastUsedAt 最小的 key
    let oldestKey = ''
    let oldestTime = Infinity
    for (const key of keys) {
      const record = this.cache.get(PARTITION_KEY, key)
      if (record && record.lastUsedAt < oldestTime) {
        oldestTime = record.lastUsedAt
        oldestKey = key
      }
    }
    if (oldestKey) {
      this.cache.delete(PARTITION_KEY, oldestKey)
    }
  }
}
