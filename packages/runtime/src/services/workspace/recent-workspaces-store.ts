/**
 * RecentWorkspacesStore — 最近工作区持久化 + LRU 淘汰
 *
 * 封装 recent-workspaces.json 的读写，底层用 WriteBackCache 实现 write-back + debounce。
 * 单分区（'global'），内键 = cwd 绝对路径，值 = RecentWorkspaceRecord。
 *
 * 不变量：
 * - INV-1: cwd 非空串检查（store 层兜底，service 层主检查）
 * - INV-2: 最多保留 6 条，淘汰 lastUsedAt 最小者（pinned 条目豁免淘汰，INV-6）
 * - INV-3: 同 cwd 不重复，更新 lastUsedAt
 * - INV-4: 文件损坏返空，不抛
 * - INV-5: 路径从 configDir 动态推导，无硬编码
 * - INV-6: pinned 条目免 LRU 淘汰（用户固定目录不随最新使用刷走）；pin 上限 MAX_PINNED
 */

import { join, dirname } from 'node:path'
import { basename } from 'node:path'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import type { RecentWorkspaceRecord } from '@taiji/shared'
import { quarantineCorruptFile, WriteBackCache } from '../../utils/json-store.js'
import { atomicWrite } from '../../utils/fs-utils.js'
import { isEnoent } from '../../utils/errors.js'

const MAX_RECORDS = 6
/** pin 上限（用户裁决 2026-10-22）：已达上限的 setPinned(pin) 拒绝（service 层降级返回当前列表） */
const MAX_PINNED = 5
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
        partitionPath: () => this.filePath,
        loadPartition: () => this.loadFromFile(),
        persistPartition: (_k, data) => this.persistToFile(data),
      },
      { flushMs: 500 },
    )
  }

  /**
   * 记录一次工作区使用。INV-1 兜底：空串静默跳过。
   * INV-3：同 cwd 合并更新——WriteBackCache.set 是整值替换，必须 spread 旧值保留既有
   * 字段（pinned），否则已固定目录被再次选用即静默失固定（固定标记被新对象抹掉）；
   * cwd/lastUsedAt/label 三字段由本方法刷新。
   */
  record(cwd: string): void {
    if (!cwd || cwd.trim() === '') return

    const prev = this.cache.get(PARTITION_KEY, cwd)
    this.cache.set(PARTITION_KEY, cwd, {
      ...prev,
      cwd,
      lastUsedAt: Date.now(),
      label: basename(cwd),
    })

    // INV-2：超过上限淘汰最旧者
    this.trim()
  }

  /**
   * 返回最近工作区列表：pinned 条目置前（组内 lastUsedAt 倒序，≤MAX_PINNED），其余按
   * lastUsedAt 倒序（≤MAX_RECORDS）——两区独立上限（淘汰只作用于未 pinned 区），前端据此
   * 分组展示（「已固定」区 + 最近区）。
   */
  list(): RecentWorkspaceRecord[] {
    const keys = this.cache.keys(PARTITION_KEY)
    const pinned: RecentWorkspaceRecord[] = []
    const recent: RecentWorkspaceRecord[] = []
    for (const key of keys) {
      const record = this.cache.get(PARTITION_KEY, key)
      if (!record) continue
      if (record.pinned) pinned.push(record)
      else recent.push(record)
    }
    const byRecency = (a: RecentWorkspaceRecord, b: RecentWorkspaceRecord) => b.lastUsedAt - a.lastUsedAt
    pinned.sort(byRecency)
    recent.sort(byRecency)
    return [...pinned, ...recent.slice(0, MAX_RECORDS)]
  }

  /**
   * pin/unpin 条目（INV-6）。条目不存在（pin 只对列表已有项，UI 保证）no-op 返回当前列表。
   * pin 时超 MAX_PINNED 上限 → 拒绝（返回 false），列表不变。
   *
   * @returns 是否生效（false = 超上限拒绝；调用方降级返回当前列表，RPC 契约恒 resolve）
   */
  setPinned(cwd: string, pinned: boolean): boolean {
    const record = this.cache.get(PARTITION_KEY, cwd)
    if (!record) return true
    if (pinned && !record.pinned && this.pinnedCount() >= MAX_PINNED) return false
    this.cache.set(PARTITION_KEY, cwd, { ...record, pinned })
    return true
  }

  /** 当前 pinned 条目数（上限检查用）。 */
  private pinnedCount(): number {
    let n = 0
    for (const key of this.cache.keys(PARTITION_KEY)) {
      if (this.cache.get(PARTITION_KEY, key)?.pinned) n++
    }
    return n
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
          // [方案A自愈] 跳过 homedir 条目：检查挡新 record，此处清理存量
          if (record.cwd === home) continue
          map.set(record.cwd, record)
        }
      }
      return map
    } catch (e) {
      // INV-4：文件损坏 / ENOENT 返空（不抛）。ENOENT 是首启正常态静默；
      // 损坏必须隔离（对齐 JsonStore D1c 与 session-data-store/plugin-storage 同款）：
      // 静默空 Map 时 loadRevision = 损坏文件指纹，下一次 flush 指纹比对判「未变」→
      // 不触发冲突备份直接覆写，原始列表无痕丢失。quarantine 后 flush 走 ENOENT
      // 放行重建，损坏数据保留 .corrupt-<ts> 副本供人工恢复。
      if (isEnoent(e)) return new Map()
      quarantineCorruptFile(this.filePath, {
        tag: 'recent-workspaces',
        reason: 'store file corrupt/unreadable',
        cause: e,
      })
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
   * INV-2：未 pinned 条目超过 MAX_RECORDS 时淘汰其中 lastUsedAt 最小者（INV-6：pinned
   * 条目豁免淘汰——用户固定目录不随最新使用刷走，两区独立上限）。在每次 record 后调用。
   */
  private trim(): void {
    const keys = this.cache.keys(PARTITION_KEY)
    let unpinnedCount = 0
    let oldestKey = ''
    let oldestTime = Infinity
    for (const key of keys) {
      const record = this.cache.get(PARTITION_KEY, key)
      if (!record || record.pinned) continue
      unpinnedCount++
      if (record.lastUsedAt < oldestTime) {
        oldestTime = record.lastUsedAt
        oldestKey = key
      }
    }
    if (unpinnedCount > MAX_RECORDS && oldestKey) {
      this.cache.delete(PARTITION_KEY, oldestKey)
    }
  }
}
