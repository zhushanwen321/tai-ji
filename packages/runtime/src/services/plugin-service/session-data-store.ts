/**
 * SessionData 内存缓存 + 持久化编排
 *
 * 封装 sessionData 的 per-session KV 缓存、dirty 跟踪、定时 flush、磁盘恢复、
 * clear 等生命周期。底层用 WriteBackCache（与 PluginStorage 同一抽象，P0-1 C6）。
 *
 * 消费者（PluginService、session-data-api、plugin-rpc-setup）通过本类的公共方法
 * 操作 sessionData，不再直接持有散落的 Map。
 *
 * size 口径统一为 Buffer.byteLength（修复原 JSON.stringify().length 的 UTF-16 偏差）。
 */

import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { readdirSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { atomicWrite } from '../../utils/fs-utils.js'
import { WriteBackCache } from '../../utils/json-store.js'
import { errorWithCode } from '../../utils/errors.js'
import { PluginRpcErrorCodes } from './plugin-types.js'
// B5 port 化（C-comm-03）：services 层不得 value import infra/system/trash——经 ITrash
// port 类型注入，实现（infra trash 函数）由组合根 index.ts 装配（见构造参数 trashFile）。
import type { ITrash } from '../ports/trash.js'

// eslint-disable-next-line no-magic-numbers
const MB = 1024 * 1024
// eslint-disable-next-line no-magic-numbers
const DEFAULT_MAX_SESSION_DATA_BYTES = 10 * MB
const FLUSH_DEBOUNCE_MS = 500
/** H1: session-data 持久化子目录名（configDir 下）。提常量消除 4 处魔法串重复。 */
const SESSION_DATA_DIRNAME = 'session-data'
/** [SEC-A5] 防御拒绝 message 中 sessionId 的回显截断长度（防超长输入撑爆日志） */
const SESSION_ID_PREVIEW_CHARS = 64

// ── B5 tombstone（memory-leak-remediation §3.2-B5，2026-09-14）────────────────

/**
 * 已删 session 的 tombstone 集（模块级，有意无界、重启清零——登记不治裁决见设计 §2.5
 * clearedSessions 行：per-delete ~百字节，防迟到写无时间上界）。
 *
 * 为什么需要：didDestroy 投递是 rpcServer.notify fire-and-forget（无完成屏障），插件
 * worker 迟到的 sessionData.set/delete RPC 无 session 存活校验（session-data-api 入口零
 * 生命周期检查）——「先投递后清理」只防同步写，防不住异步迟到写。
 *
 * 为什么只守 set 与 delete 两写入口、不守 get/keys（源码依据，R4 源码自核裁决）：
 * **迟到 set 是唯一文件复活入口**——WriteBackCache.set 的 getPartition(k) 会 lazy 重建
 * 分区（trash 后 loadPartitionSync 读不到文件返回空 Map），随后 dirty.add + scheduleFlush
 * 在 flushMs 后把新文件写盘，文件复活；而迟到 delete 虽同样 lazy 重建空内存分区（驻留），
 * 但 oldValue === undefined 短路使其不 dirty、不落盘（文件不复活，只浪费一个空分区槽位）；
 * clearSession 侧 dropPartition（onExternalChange）已清该分区的 flushTimer——clear 前已
 * 排定的 flush 定时器被 clearTimeout，不再有待写盘的定时器路径。故 guard 必须覆盖
 * set（文件复活主通道）+ delete（空分区驻留），get/keys 只读不守。
 */
const clearedSessions = new Set<string>()

/** B5 摘碑：session 同 id 复活（create/restore/fork 收敛点、import 落地）后恢复写通道。 */
export function clearSessionDataTombstone(sessionId: string): void {
  clearedSessions.delete(sessionId)
}

/** tombstone 只读探针（A3 验收 / 单测断言用；生产无写副作用）。 */
export function isSessionDataCleared(sessionId: string): boolean {
  return clearedSessions.has(sessionId)
}

/** B5 尾段直调的活跃 store 实例登记（生产恒单实例；测试可多实例各自 dispose 摘除）。 */
const activeStores = new Set<SessionDataStore>()

/**
 * B5：removeSessionEntry 尾段直调入口——对全部已注册 store 实例执行 clearSession
 * （tombstone 登记 + 分区摘除 + trash 软删除）。
 *
 * 为什么是模块级分发而不是 SessionService 直挂 pluginService：SessionService 与
 * PluginService 互为依赖（plugin-service 经 setSessionService 反向持有 sessionService，
 * 构造注入成环），组合根 wiring 又不在本单元领地——模块级单例分发与 crash-journal
 * （getCrashJournal）/ inflightMirror / userStoppedGate 同款既有模式。
 *
 * best-effort：单实例清理失败（trash 抛结构化错误等）只 warn 留痕，不阻断销毁收敛链，
 * 也不影响其余实例。
 */
export function clearRemovedSessionData(sessionId: string): void {
  for (const store of activeStores) {
    void store.clearSession(sessionId).catch((e: unknown) => {
      console.warn(`[session-data-store] clearSessionData best-effort failed (sessionId=${sessionId}):`, e)
    })
  }
}

export class SessionDataStore {
  /** write-back 缓存：分区键 = sessionId，内键 = key，值 = unknown */
  private readonly cache: WriteBackCache<string, string, unknown>
  /** 配置根目录（session-data 持久化用），由组合根注入，不再直连 infra。 */
  private readonly configDir: string
  /** B5 软删除 port（结构匹配 infra/system/trash 的 trash 函数；组合根注入）。 */
  private readonly trashFile: ITrash['trashFile'] | undefined

  /**
   * @param configDir xyz-agent 配置根（~/.xyz-agent/），session-data 持久化目录的父。
   * @param maxSizeBytes 单 session 最大字节数，默认 10MB。
   * @param storageFullCode 容量超限时抛出错误的 code（由调用方注入，避免叶子层硬编码 RPC 码）。
   * @param trashFile B5 软删除 port（ITrash.trashFile）：磁盘删除走 mac 废纸篓语义，
   *   实现由组合根注入（index.ts 经 PluginService deps → infra/system/trash 的 trash
   *   函数，结构匹配）。仅当 clearSession 遇到真实存在的文件且未注入时才 fail-fast
   *   （TRASH_PORT_NOT_WIRED）——组合根装配遗漏在第一次删带数据的 session 即暴露，
   *   不静默降级为「文件永久驻留」。
   */
  constructor(
    configDir: string,
    maxSizeBytes: number = DEFAULT_MAX_SESSION_DATA_BYTES,
    storageFullCode: number = PluginRpcErrorCodes.STORAGE_FULL,
    trashFile?: ITrash['trashFile'],
  ) {
    this.configDir = configDir
    this.trashFile = trashFile
    this.cache = new WriteBackCache<string, string, unknown>(
      {
        loadPartition: (sessionId) => this.loadPartitionSync(sessionId),
        persistPartition: (sessionId, data) => this.persistPartition(sessionId, data),
      },
      { flushMs: FLUSH_DEBOUNCE_MS },
      // 容量检查：单 session 总量超限抛错（错误码由调用方经 storageFullCode 注入，避免叶子层硬编码 RPC 码）
      (_sessionId, _key, _value, partitionSize) => {
        if (partitionSize > maxSizeBytes) {
          throw errorWithCode(`Session data storage full (${partitionSize} > ${maxSizeBytes} bytes)`, storageFullCode)
        }
      },
    )
    // B5：自注册进模块级活跃实例表（removeSessionEntry 尾段经 clearRemovedSessionData
    // 分发；见该函数注释的模式论证）。dispose 摘除。
    activeStores.add(this)
  }

  // ── KV 操作（供 session-data-api RPC 调用） ──────────────────

  get(sessionId: string, key: string): unknown | undefined {
    return this.cache.get(sessionId, key)
  }

  /**
   * B5 写守卫①：迟到 set 丢弃 + warn——set 是唯一文件复活入口（见模块级 tombstone 注释
   * 的源码依据），已删 session 的迟到 set 不得 lazy 重建分区并把新文件写回盘。
   */
  set(sessionId: string, key: string, value: unknown): void {
    if (clearedSessions.has(sessionId)) {
      console.warn(
        `[session-data-store] dropped late sessionData.set for cleared session ${JSON.stringify(sessionId.slice(0, SESSION_ID_PREVIEW_CHARS))}`,
      )
      return
    }
    this.cache.set(sessionId, key, value)
  }

  /** B5 写守卫②：迟到 delete 丢弃——delete 不复活文件但会 lazy 重建空内存分区（驻留）。 */
  delete(sessionId: string, key: string): void {
    if (clearedSessions.has(sessionId)) {
      console.warn(
        `[session-data-store] dropped late sessionData.delete for cleared session ${JSON.stringify(sessionId.slice(0, SESSION_ID_PREVIEW_CHARS))}`,
      )
      return
    }
    this.cache.delete(sessionId, key)
  }

  keys(sessionId: string): string[] {
    return this.cache.keys(sessionId)
  }

  /** B5 探针：分区是否已加载进内存（单测/A3 验证「不重建分区」断言用）。 */
  hasPartition(sessionId: string): boolean {
    return this.cache.partitionKeys().includes(sessionId)
  }

  // ── 生命周期 ─────────────────────────────────────────────

  /** 将所有 dirty 数据批量 flush */
  flushAll(): void {
    this.cache.flushAll()
  }

  /** flush 指定 session 的 dirty 数据 */
  flushSession(sessionId: string): void {
    this.cache.flush(sessionId)
  }

  /** 从磁盘恢复所有 sessionData（initialize 时调用） */
  restoreFromDisk(): void {
    try {
      const sessionDataDir = join(this.configDir, SESSION_DATA_DIRNAME)
      if (!existsSync(sessionDataDir)) return
      const files = readdirSync(sessionDataDir)
      for (const file of files) {
        if (file.endsWith('.json')) {
          const sessionId = file.replace('.json', '')
          // 触发 WriteBackCache lazy load（loadPartition 会读盘）
          const data = this.cache.keys(sessionId)
          if (data.length === 0) continue
        }
      }
    // eslint-disable-next-line taste/no-silent-catch -- sessionData restore: directory may not exist initially
    } catch {
      // Directory doesn't exist yet, that's fine
    }
  }

  /**
   * B5：清理指定 session 的内存缓存 + 磁盘文件（软删除）。
   *
   * 顺序：①tombstone 登记（先于 trash——trash 失败降级时迟到写也必须被丢弃，见设计
   * §3.2-B5 降级登记）；②dropPartition（清 flushTimer + 摘内存分区——封死 clear 前已
   * 排定的定时器写盘路径，使迟到 set 成为唯一文件复活入口，由写守卫拦截）；③trash
   * 软删除（mac 废纸篓 / 非 mac unlink，与 session 本体持久性对齐）。
   *
   * trash 失败（文件保留原地 + 拋结构化错误，trash.ts G4 语义）：本方法向上传播 rejection，
   * 调用方 best-effort 消费（clearRemovedSessionData / pluginService.clearSessionData 均
   * void…catch(warn)）；此时文件原地保留，重启后 restoreFromDisk 仍会预载该分量（B5 对它
   * 不生效）——接受为 best-effort 降级（设计登记）。
   *
   * 文件不存在（大多数 session 无插件数据）：跳过 trash，避免对不存在路径误报结构化错误
   * （旧 rmSync({force:true}) 同为 no-op 语义）。
   */
  async clearSession(sessionId: string): Promise<void> {
    // 先做路径防御校验再动状态：拒绝时缓存分区保持原样（fail fast，不留半更新状态）
    const filePath = this.resolveSessionFilePath(sessionId)
    clearedSessions.add(sessionId)
    this.cache.onExternalChange(sessionId)
    if (!existsSync(filePath)) return
    if (!this.trashFile) {
      // 组合根装配遗漏（生产 index.ts 必注入；单测须注入 mock）——fail fast 而非静默
      // 跳过（跳过 = 文件永久驻留 + tombstone 已登记的「假删除」，比报错更糟）。
      throw errorWithCode(
        `trash port not injected: SessionDataStore requires ITrash.trashFile (wired by composition root index.ts via PluginService deps) to soft-delete ${filePath}`,
        'TRASH_PORT_NOT_WIRED',
      )
    }
    await this.trashFile(filePath)
  }

  /**
   * B5 摘碑（摘碑双路径①的实例侧入口，plugin-service 的 setOnSessionCreated 回调链式
   * 追加调用）：session 同 id 复活后恢复写通道。import 复活路径②直接用模块级
   * clearSessionDataTombstone（import-service 无 store 实例可达性）。
   */
  reviveSession(sessionId: string): void {
    clearSessionDataTombstone(sessionId)
  }

  /** shutdown 清理（落盘保障 = per-write debounce 500ms + 退出前 flushAll）。 */
  dispose(): void {
    this.cache.dispose()
    activeStores.delete(this)
  }

  // ── Private（WriteBackCache backing 回调） ──────────────────

  /**
   * [SEC-A5 深度防御] 解析 sessionId 对应的持久化文件绝对路径，并确保结果
   * 仍落在 session-data 目录内。入口层（session-data-api 的 asSafeKey 白名单）
   * 已拒绝非法标识符，这里用 path.resolve/relative 兜底拦「上游漏网」的
   * `..` 遍历与跨盘绝对路径，保证任何调用路径都无法把读/写/删引到数据
   * 目录之外。合法输入（白名单内的 sessionId）行为与 resolve 前完全一致。
   */
  private resolveSessionFilePath(sessionId: string): string {
    const dir = resolve(this.configDir, SESSION_DATA_DIRNAME)
    const filePath = resolve(dir, `${sessionId}.json`)
    const rel = relative(dir, filePath)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw errorWithCode(
        `Invalid sessionId ${JSON.stringify(sessionId.slice(0, SESSION_ID_PREVIEW_CHARS))}: resolved path escapes `
        + `the session-data directory (${dir}). sessionId must match /^[A-Za-z0-9._-]{1,128}$/ `
        + `(no path separators or '..'). This defense-in-depth rejection means the RPC entry `
        + `layer validation was bypassed — report it as a bug if reached via plugin RPC.`,
        'INVALID_SESSION_ID',
      )
    }
    return filePath
  }

  private loadPartitionSync(sessionId: string): Map<string, unknown> {
    // [SEC-A5] 校验必须在 try 外：防御性拒绝要向上冒，不能被下方 ENOENT
    // 容错 catch 吞掉（否则恶意 sessionId 会静默退化为「空分区可写入」）
    const filePath = this.resolveSessionFilePath(sessionId)
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return new Map(Object.entries(parsed))
    } catch {
      return new Map()
    }
  }

  private persistPartition(sessionId: string, data: Map<string, unknown>): void {
    // sync atomicWrite（与 PluginStorage 一致）。容量检查在 onSet 已拦截，
    // 此处不再重复校验。flush 前会 clearTimeout，同一分区无并发写，固定 .tmp 名安全。
    // [SEC-A5] 写盘前过同款 resolve 防御；若被上游漏网触发，WriteBackCache.flush
    // 会捕获并保留 dirty 重试（不 crash），但文件绝不会被写到目录外。
    const filePath = this.resolveSessionFilePath(sessionId)
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const content = JSON.stringify(Object.fromEntries(data))
    atomicWrite(filePath, content)
  }
}
