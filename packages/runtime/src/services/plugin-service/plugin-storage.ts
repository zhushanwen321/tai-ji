import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { errorWithCode, isEnoent, toErrorMessage } from '../../utils/errors.js'
import { atomicWrite } from '../../utils/fs-utils.js'
import { WriteBackCache } from '../../utils/json-store.js'

// eslint-disable-next-line no-magic-numbers
const MB = 1024 * 1024 // 1,048,576 bytes
// eslint-disable-next-line no-magic-numbers
const MAX_TOTAL_SIZE = 10 * MB // 10MB
const MAX_VALUE_SIZE = 1 * MB // 1MB
const FLUSH_DEBOUNCE_MS = 500
const JSON_FORMAT_INDENT = 2
const HASH_SLICE_LENGTH = 12
/** [SEC-A5] 防御拒绝 message 中 pluginId 的回显截断长度（防超长输入撑爆日志） */
const PLUGIN_ID_PREVIEW_CHARS = 64

/** KV 分区键：${pluginId}:${scope} */
type PartitionKey = string

export class PluginStorage {
  private cache: WriteBackCache<PartitionKey, string, unknown> | null = null
  private baseDir = ''
  private projectRoot = ''

  init(baseDir: string, projectRoot: string): void {
    this.baseDir = baseDir
    this.projectRoot = projectRoot
    const pluginsDir = join(baseDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })

    this.cache = new WriteBackCache<PartitionKey, string, unknown>(
      {
        loadPartition: (k) => this.loadPartition(k),
        persistPartition: (k, data) => this.persistPartition(k, data),
      },
      { flushMs: FLUSH_DEBOUNCE_MS },
      // 容量检查：单值 1MB（-32021）+ 分区总量 10MB（-32040）
      (_k, _ik, _v, partitionSize, valueSize) => {
        if (valueSize > MAX_VALUE_SIZE) {
          throw Object.assign(
            new Error(`Value exceeds 1MB limit (${valueSize} bytes)`),
            { code: -32021 },
          )
        }
        if (partitionSize > MAX_TOTAL_SIZE) {
          throw Object.assign(
            new Error('Storage exceeds 10MB limit'),
            { code: -32040 },
          )
        }
      },
    )
  }

  // ── Scoped API (global or workspace) ───────────────────────────

  get(pluginId: string, key: string, scope: 'global' | 'workspace' = 'global'): unknown | undefined {
    return this.cache!.get(this.partitionKey(pluginId, scope), key)
  }

  set(pluginId: string, key: string, value: unknown, scope: 'global' | 'workspace' = 'global'): void {
    this.cache!.set(this.partitionKey(pluginId, scope), key, value)
  }

  delete(pluginId: string, key: string, scope: 'global' | 'workspace' = 'global'): void {
    this.cache!.delete(this.partitionKey(pluginId, scope), key)
  }

  keys(pluginId: string, scope: 'global' | 'workspace' = 'global'): string[] {
    return this.cache!.keys(this.partitionKey(pluginId, scope))
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /** flush 指定 pluginId 的所有 scope（global + workspace）。 */
  flush(pluginId: string): void {
    for (const scope of ['global', 'workspace'] as const) {
      this.cache!.flush(this.partitionKey(pluginId, scope))
    }
  }

  flushAll(): void {
    this.cache!.flushAll()
  }

  onExternalChange(pluginId: string): void {
    this.cache!.onExternalChange(this.partitionKey(pluginId, 'global'))
    this.cache!.onExternalChange(this.partitionKey(pluginId, 'workspace'))
  }

  /** 停掉所有待 flush 定时器（shutdown 用）。 */
  dispose(): void {
    this.cache?.dispose()
  }

  // ── Private ─────────────────────────────────────────────────────

  private partitionKey(pluginId: string, scope: 'global' | 'workspace'): PartitionKey {
    return `${pluginId}:${scope}`
  }

  private parsePartitionKey(k: PartitionKey): { pluginId: string; scope: 'global' | 'workspace' } {
    const parts = k.split(':')
    return { pluginId: parts[0], scope: (parts[1] ?? 'global') as 'global' | 'workspace' }
  }

  private loadPartition(k: PartitionKey): Map<string, unknown> {
    const { pluginId, scope } = this.parsePartitionKey(k)
    const filePath = this.getFilePath(pluginId, scope)
    const data = new Map<string, unknown>()
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const [key, v] of Object.entries(parsed)) {
        data.set(key, v)
      }
    } catch (e: unknown) {
      // 文件不存在（首次访问）或 JSON 解析失败 → 空 Map 是正确回退
      if (!isEnoent(e)) {
        console.warn(`[plugin-storage] failed to load ${filePath}:`, toErrorMessage(e))
      }
    }
    return data
  }

  private persistPartition(k: PartitionKey, data: Map<string, unknown>): void {
    const { pluginId, scope } = this.parsePartitionKey(k)
    const filePath = this.getFilePath(pluginId, scope)
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })
    const obj: Record<string, unknown> = {}
    for (const [key, v] of data) obj[key] = v
    const content = JSON.stringify(obj, null, JSON_FORMAT_INDENT)
    atomicWrite(filePath, content)
  }

  private getFilePath(
    pluginId: string,
    scope: 'global' | 'workspace',
  ): string {
    // [SEC-A5 深度防御] pluginId 是路径段，resolve 后必须仍落在 plugins 目录内。
    // 入口层（storage-api 的 asSafeKey 白名单）已拒绝非法 pluginId，这里兜底
    // 拦「上游漏网」的 `..` 遍历与跨盘绝对路径——load/persist 共用本方法，
    // 一处校验同时覆盖读与写。合法 pluginId 行为与 resolve 前完全一致。
    const pluginsDir = resolve(this.baseDir, 'plugins')
    const pluginDir = resolve(pluginsDir, pluginId)
    const rel = relative(pluginsDir, pluginDir)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw errorWithCode(
        `Invalid pluginId ${JSON.stringify(pluginId.slice(0, PLUGIN_ID_PREVIEW_CHARS))}: resolved path escapes `
        + `the plugins directory (${pluginsDir}). pluginId must match /^[A-Za-z0-9._-]{1,128}$/ `
        + `(no path separators or '..'). This defense-in-depth rejection means the RPC entry `
        + `layer validation was bypassed — report it as a bug if reached via plugin RPC.`,
        'INVALID_PLUGIN_ID',
      )
    }
    if (scope === 'global') {
      return join(pluginDir, 'globalState.json')
    }
    const cwdHash = createHash('sha256')
      .update(this.projectRoot)
      .digest('hex')
      .slice(0, HASH_SLICE_LENGTH)
    return join(pluginDir, `workspace-${cwdHash}.json`)
  }
}
