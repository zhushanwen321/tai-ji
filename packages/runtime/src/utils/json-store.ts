/**
 * JSON 文件存储抽象（P0-1）。
 *
 * 收口 runtime 6 类 JSON 存储（models / settings / disabled-packages /
 * permissions / plugin-KV / session-data）的读写样板：read→parse→ENOENT 容错→
 * 默认值、atomicWrite、revision 指纹校验（JsonStore）、write-back（dirty +
 * 定时 flush + size 跟踪，WriteBackCache）。
 *
 * 设计依据：6 个 store 的文件均为 KB 级、读带缓存、写低频，同步 IO 对 event loop
 * 无感（评审证据见 git 历史 runtime-similar-code-review.md P0-A，该文档已删除）。统一同步，
 * 不拆 sync/async 双子类。
 *
 * 归属：跨层共享叶子层 utils/（ADR 0035），是 fs-utils（atomicWrite）与 errors
 * （isEnoent）的直接组合，无业务语义。
 */

import { copyFileSync, readFileSync, renameSync, rmSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWrite } from './fs-utils.js'
import { isEnoent } from './errors.js'

// ── JsonStore：read-through + revision 指纹校验 + 原子写 ────────────────

const DEFAULT_INDENT = 2

export interface JsonStoreOptions<T> {
  /** JSON 序列化缩进。默认 2（统一既有 JSON_INDENT / INDENT_SPACES 两套常量）。 */
  indent?: number
  /**
   * 解析校验/塑形。对原始 parsed 值做 schema guard 或默认值补全后返回。
   * 默认直接 `as T`。如 models.json 用它做 `providers` 字段缺失回退。
   */
  deserialize?: (raw: unknown) => T
  /**
   * 可选：判断值是否「空」，空则删文件而非写盘（disabled-packages.json 的
   * 「空数组则删」语义）。返回 true 时 write 删除文件。默认永远返回 false（总写盘）。
   * 不同 store 的「空」定义不同（空对象 vs 空数组字段），由调用方决定。
   */
  shouldDeleteWhen?: (value: T) => boolean
}

interface CacheEntry<T> {
  value: T
  /** 加载时的文件指纹（statFingerprint 五元组）。文件不存在 / stat 失败时为 undefined。 */
  revision: string | undefined
}

/**
 * 文件指纹（cache-governance §3.2.2，形态对齐 pi getFileRevision）：
 * `dev:ino:size:mtimeNs:ctimeNs` 五元组。含 inode 与 ctimeNs，严于仓内惯用的
 * `(mtimeMs,size)` 双键——atomicWrite 的 tmp+rename 会换 inode，双键在极端时序下
 * 可能漏检，五元组不漏。bigint stat 保证 mtimeNs 纳秒精度（ms 精度下同毫秒内的
 * 连续写会漏检）。
 */
function statFingerprint(path: string): string {
  const st = statSync(path, { bigint: true })
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
}

/**
 * Read-through JSON 文件存储：read 带 revision 指纹校验（外部改动下一次 read 立即可见）
 * 与 ENOENT 容错，write 走 atomicWrite。
 *
 * 读判定：有缓存时先 stat 比对指纹——一致返缓存（热路径成本 = 一次 stat syscall）；
 * 指纹变 / 文件被删（ENOENT）→ 重读盘；stat 抛非 ENOENT → warn + 返缓存值
 * （探针失败 ≠ 文件变更，不否定缓存）。指纹校验保证任何外部写方（pi 子进程写
 * settings.json、用户手改）的下一次 read 立即可见（cache-governance §2.1 场景 A）。
 *
 * 替代散落在 pi-provider-store / pi-settings-store / pi-extension-settings /
 * plugin-permission-storage 的 read→parse→catch→default 与 write→mkdir→atomicWrite 样板。
 */
export class JsonStore<T> {
  private readonly path: string
  private readonly defaultValue: T
  private readonly indent: number
  private readonly deserialize: (raw: unknown) => T
  private readonly shouldDeleteWhen: (value: T) => boolean
  private cache: CacheEntry<T> | null = null

  constructor(path: string, defaultValue: T, opts?: JsonStoreOptions<T>) {
    this.path = path
    this.defaultValue = defaultValue
    this.indent = opts?.indent ?? DEFAULT_INDENT
    this.deserialize = opts?.deserialize ?? ((v): T => v as T)
    this.shouldDeleteWhen = opts?.shouldDeleteWhen ?? (() => false)
  }

  /** 读取：指纹一致返缓存；指纹变 / 文件被删 → 重读盘 + parse + ENOENT→默认值。 */
  read(): T {
    const cached = this.cache
    if (!cached) {
      this.cache = this.readFromDisk()
      return this.cache.value
    }
    let revision: string | undefined
    try {
      revision = statFingerprint(this.path)
    } catch (e: unknown) {
      if (!isEnoent(e)) {
        // stat 抛非 ENOENT：探针失败 ≠ 文件变更，不否定缓存（批 2 错误规格第 2 行）
        console.warn(
          `[json-store] stat 探针失败，返回缓存值。恢复指引：检查文件权限/挂载，` +
          `机制本身下次 read 自动重试。path=${this.path}`,
          e instanceof Error ? e.message : e,
        )
        return cached.value
      }
      // ENOENT：文件被外部删 = 外部写的一种 → 丢缓存重读（readFromDisk 的
      // ENOENT 容错返默认值）；revision 保持 undefined
    }
    if (revision === cached.revision) {
      return cached.value
    }
    this.cache = this.readFromDisk()
    return this.cache.value
  }

  /** 写入：确保父目录 → atomicWrite + 以写入后指纹刷新缓存。若 shouldDeleteWhen 判定为空则删文件。 */
  write(value: T): void {
    if (this.shouldDeleteWhen(value)) {
      this.cache = { value, revision: undefined } // 文件已删 → 无指纹，下次 read 按 ENOENT 容错
      this.deleteFile()
      return
    }
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const json = JSON.stringify(value, null, this.indent)
    atomicWrite(this.path, json)
    this.cache = { value, revision: this.statRevisionSafely() }
  }

  /** 失效缓存（下次 read 重读盘）。替代散落的 invalidateXxxCache。 */
  invalidate(): void {
    this.cache = null
  }

  getPath(): string {
    return this.path
  }

  // ── Private ────────────────────────────────────────────────────────

  private readFromDisk(): CacheEntry<T> {
    // 指纹在读之前取：若读盘窗口内文件又被改，指纹旧于内容 → 下次 read 判失配
    // 重读（安全方向）；反过来（读后取指纹）会把新指纹配旧内容，陈旧值被指纹
    // 命中固化。stat 失败 → undefined 指纹，同样使下次 read 必失配重读。
    const revision = this.statRevisionSafely()
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf-8')
    } catch (e: unknown) {
      // ENOENT 是「尚无文件」的正常态，直接回默认值；其余读错误（EACCES/EISDIR 等）
      // 同样先隔离现场再降级——半截/不可读文件若留在原位，下一次 write 会把默认值
      // 写回去，把可恢复的现场合法化成「全空配置」
      if (!isEnoent(e)) {
        this.quarantine('read failed', e)
      }
      return { value: this.defaultValue, revision }
    }
    try {
      return { value: this.deserialize(JSON.parse(raw)), revision }
    } catch (e: unknown) {
      this.quarantine('parse failed', e)
      return { value: this.defaultValue, revision }
    }
  }

  /** write / 重读路径的指纹采集：任何失败都降级为 undefined（下次 read 必失配重读，安全方向）。 */
  private statRevisionSafely(): string | undefined {
    try {
      return statFingerprint(this.path)
    } catch {
      return undefined
    }
  }

  /**
   * 损坏隔离（D1c）：委托共享工具 quarantineCorruptFile（实现与「为什么」见其注释；
   * session-service 等手写 parse 的落点复用同一实现，避免隔离行为漂移）。
   */
  private quarantine(reason: string, cause: unknown): void {
    quarantineCorruptFile(this.path, { tag: 'json-store', reason, cause })
  }

  private deleteFile(): void {
    try {
      rmSync(this.path, { force: true })
    // eslint-disable-next-line taste/no-silent-catch -- writeEmpty:'delete' 是尽力清理，失败不阻断主流程（同 trash.ts 约定）
    } catch (e) {
      console.debug(`[json-store] delete failed: ${this.path}:`, e instanceof Error ? e.message : e)
    }
  }
}

// ── 损坏隔离（D1c 共享工具，JsonStore 与手写 parse 的模块复用同一实现）─────────

export interface QuarantineOptions {
  /** 日志前缀 tag（定位来源模块，如 'json-store' / 'session-service'）。 */
  tag: string
  /** 失败原因短语（进日志，如 'parse failed' / 'segments.json malformed'）。 */
  reason: string
  /** 原始错误。 */
  cause: unknown
}

/**
 * 损坏隔离（D1c）：把不可读/不可解析的文件 rename 为 `<path>.corrupt-<ts>` 保留
 * 取证，调用方以默认值继续。rename 失败（目录只读等）则原文件保留原位、仅降级，
 * 但日志升级为 error 提示人工介入。
 *
 * 为什么必须把原文件移走：parse 失败若只返回默认值，下一次 write 会以默认值
 * 覆盖原路径——「半截文件」被静默合法化为「全空文件」，用户全部配置丢失且
 * 不可恢复（integrity-hardening.md 失败模式 A 的第二条链）。
 *
 * 为什么是导出函数而非 JsonStore 私有方法：segments.json 等手写 read→parse 的
 * 落点不走 JsonStore，但面临同一条「失败 reset 覆盖」链——共享同一实现避免
 * 两处隔离行为漂移（integrity-hardening.md D1c 明确要求同模式覆盖）。
 */
export function quarantineCorruptFile(filePath: string, opts: QuarantineOptions): void {
  // ISO 时间戳压缩格式（去冒号/点号）：文件名安全且按字典序即按时间排序
  const ts = new Date().toISOString().replace(/[:.]/g, '')
  const quarantinePath = `${filePath}.corrupt-${ts}`
  const causeMsg = opts.cause instanceof Error ? opts.cause.message : opts.cause
  try {
    renameSync(filePath, quarantinePath)
    console.error(
      `[${opts.tag}] ${opts.reason}: ${filePath} — 文件损坏已隔离至 ${quarantinePath}，` +
      `本次以默认值继续。恢复指引：用编辑器对比 .corrupt 副本找回配置。原因: ${causeMsg}`,
    )
  // eslint-disable-next-line taste/no-silent-catch -- 隔离失败不阻断读流程（仍返回默认值），只升级日志
  } catch (renameErr) {
    console.error(
      `[${opts.tag}] ${opts.reason}: ${filePath} — 损坏隔离失败（无法 rename 为 .corrupt 副本），` +
      `原文件保留原位，本次以默认值继续。请人工检查该文件。原因: ${causeMsg}; ` +
      `rename 失败: ${renameErr instanceof Error ? renameErr.message : renameErr}`,
    )
  }
}

// ── WriteBackCache：分区化 write-back（内存改 + dirty + 定时 flush + size） ──

const DEFAULT_FLUSH_MS = 500

export interface WriteBackBacking<K, IK, IV> {
  /**
   * 分区对应的持久化文件路径（stat 指纹校验与冲突备份用，cache-governance §3.2.4）。
   * 实现必须与自身 loadPartition/persistPartition 推导同一路径（复用同一路径方法，
   * 含路径逃逸防御），保证校验/备份对象与实际读写对象一致。
   */
  partitionPath(k: K): string
  /**
   * 首次访问某分区时从盘加载（lazy）。返回该分区的内存 Map。
   * 文件不存在 / 损坏时应返回空 Map（由实现负责 ENOENT 容错）。
   */
  loadPartition(k: K): Map<IK, IV>
  /** flush 单分区到盘（atomicWrite）。 */
  persistPartition(k: K, data: Map<IK, IV>): void
}

export interface WriteBackOptions<IV> {
  /** debounce flush 间隔（ms）。默认 500（沿用 PluginStorage FLUSH_DEBOUNCE_MS）。 */
  flushMs?: number
  /** 可选：单个 value 的字节大小计算。默认 Buffer.byteLength(JSON.stringify(v))。 */
  sizeOf?: (v: IV) => number
}

/**
 * 容量检查回调（set 前调用）。抛异常即拒绝写入，错误码由调用方决定。
 * 独立于 WriteBackOptions 泛型化，因为它需要 K/IK 类型。
 */
export type WriteBackOnSet<K extends string, IK extends string, IV> = (
  k: K, ik: IK, v: IV, partitionSize: number, valueSize: number,
) => void

interface Partition<IK, IV> {
  data: Map<IK, IV>
  dirty: Set<IK>
  flushTimer: ReturnType<typeof setTimeout> | null
  totalSize: number
  /** 分区加载时刻的文件指纹（statFingerprint 五元组）。文件不存在 / stat 失败时为 undefined。 */
  loadRevision: string | undefined
}

/**
 * WriteBackCache 的分区指纹采集：任何失败都降级为 undefined（下次读侧校验必失配重载，
 * 安全方向；语义同 JsonStore 的 statRevisionSafely，不跨类共享私有实现）。
 */
function statPartitionRevision(path: string): string | undefined {
  try {
    return statFingerprint(path)
  } catch {
    return undefined
  }
}

/**
 * 分区化 write-back 缓存。每个分区键 K 对应一个
 * `{data, dirty, flushTimer, totalSize, loadRevision}`。
 *
 * 失效机制（cache-governance §3.2.4，分区混合策略「读侧外部优先、写侧内存优先」）：
 * - 非 dirty 分区每次访问先 stat 比对 loadRevision——外部改动/删除在下一次访问即生效
 *   （drop + 重新 loadPartition），与 JsonStore revision 档同构；stat 非 ENOENT 失败
 *   → warn + 按未变更处理（探针失败 ≠ 文件变更）。
 * - dirty 分区跳过读侧校验（drop 会连未落盘写一起丢，onExternalChange 教训）；
 *   flush 前比对指纹，发现外部改动 → 先备份磁盘内容为 `<path>.conflict-<ts>` 再照常
 *   覆写，warn 含原文件与备份双路径 + 恢复指引（消除静默覆盖，G2）。
 *
 * 替代 PluginStorage（分区键 = `${pluginId}:${scope}`）与 SessionDataStore
 * （分区键 = `sessionId`）两套手写 write-back 实现，统一 size 口径（默认
 * Buffer.byteLength，修复 SessionDataStore 的 JSON.stringify().length 偏差）。
 *
 * 全同步：内存操作 + atomicWrite。KB 级文件同步写对 event loop 无感。
 */
export class WriteBackCache<K extends string, IK extends string, IV> {
  private readonly partitions = new Map<K, Partition<IK, IV>>()
  private readonly backing: WriteBackBacking<K, IK, IV>
  private readonly flushMs: number
  private readonly sizeOf: (v: IV) => number
  private readonly onSet?: WriteBackOnSet<K, IK, IV>

  constructor(
    backing: WriteBackBacking<K, IK, IV>,
    opts?: WriteBackOptions<IV>,
    onSet?: WriteBackOnSet<K, IK, IV>,
  ) {
    this.backing = backing
    this.flushMs = opts?.flushMs ?? DEFAULT_FLUSH_MS
    this.sizeOf = opts?.sizeOf ?? ((v: IV): number => Buffer.byteLength(JSON.stringify(v), 'utf-8'))
    this.onSet = onSet
  }

  get(k: K, ik: IK): IV | undefined {
    return this.getPartition(k).data.get(ik)
  }

  set(k: K, ik: IK, v: IV): void {
    const partition = this.getPartition(k)
    const oldValue = partition.data.get(ik)
    const oldSize = oldValue !== undefined ? this.sizeOf(oldValue) : 0
    const valueSize = this.sizeOf(v)
    const newTotal = partition.totalSize - oldSize + valueSize

    if (this.onSet) {
      this.onSet(k, ik, v, newTotal, valueSize)
    }

    partition.data.set(ik, v)
    partition.totalSize = newTotal
    partition.dirty.add(ik)
    this.scheduleFlush(k)
  }

  delete(k: K, ik: IK): void {
    const partition = this.getPartition(k)
    const oldValue = partition.data.get(ik)
    if (oldValue === undefined) return
    partition.totalSize -= this.sizeOf(oldValue)
    partition.data.delete(ik)
    partition.dirty.add(ik)
    this.scheduleFlush(k)
  }

  keys(k: K): IK[] {
    return Array.from(this.getPartition(k).data.keys())
  }

  has(k: K, ik: IK): boolean {
    return this.getPartition(k).data.has(ik)
  }

  /** 枚举已加载的分区键。 */
  partitionKeys(): K[] {
    return Array.from(this.partitions.keys())
  }

  /**
   * 同步持久化单分区：清 timer → 冲突检测（备份外部改动）→ persistPartition → 清 dirty。
   *
   * flush 前 stat 比对 loadRevision（cache-governance §3.2.4「写侧内存优先 + 冲突备份
   * 出声」）：磁盘指纹已变（dirty 窗口内外部改/建了文件）→ 先复制磁盘内容为
   * `<path>.conflict-<ts>` 备份再照常覆写，warn 含双路径与恢复指引。
   *
   * [W0 异常隔离] persistPartition 失败（盘满 / 权限 / 只读挂载）时：
   * - 不向上抛（flush 被两处 timer 回调同步调用，抛出会变 uncaughtException → 进程 crash）
   * - console.error 记录原因
   * - 保留 dirty 不清除（下次 flush 重试）
   * - scheduleFlush 安排重试
   */
  flush(k: K): void {
    const partition = this.partitions.get(k)
    if (!partition || partition.dirty.size === 0) return
    if (partition.flushTimer) {
      clearTimeout(partition.flushTimer)
      partition.flushTimer = null
    }
    try {
      if (!this.backupExternalConflict(k, partition)) {
        // 冲突备份失败即中止本次落盘：此时覆写会把外部改动无备份地冲掉（内存写有
        // dirty 重试、外部改动将无所遁形地丢失），保留 dirty 等条件恢复后重试
        this.scheduleFlush(k)
        return
      }
      this.backing.persistPartition(k, partition.data)
      partition.dirty.clear()
      // 以写入后指纹刷新 loadRevision：磁盘已是内存投影，非 dirty 读侧校验应命中；
      // 采集失败降级 undefined → 下次访问失配重载（安全方向，多一次盘读）
      partition.loadRevision = statPartitionRevision(this.backing.partitionPath(k))
    } catch (e) {
      // 保留 dirty，下次 flush 重试；避免 timer 回调抛错导致 uncaughtException crash
      console.error(`[json-store] flush failed for partition "${k}", will retry:`,
        e instanceof Error ? e.message : e)
      this.scheduleFlush(k)
    }
  }

  /** 同步持久化所有 dirty 分区。 */
  flushAll(): void {
    for (const k of this.partitions.keys()) {
      this.flush(k)
    }
  }

  /**
   * 通知某分区（或全部）的外部变更：丢弃内存分区，下次访问重新从盘加载。
   * 替代 PluginStorage.onExternalChange。
   */
  onExternalChange(k?: K): void {
    if (k !== undefined) {
      this.dropPartition(k)
    } else {
      for (const key of Array.from(this.partitions.keys())) {
        this.dropPartition(key)
      }
    }
  }

  /** 清所有 timer（停掉所有待 flush）。不触发 flush。 */
  dispose(): void {
    for (const partition of this.partitions.values()) {
      if (partition.flushTimer) {
        clearTimeout(partition.flushTimer)
        partition.flushTimer = null
      }
    }
  }

  // ── Private ────────────────────────────────────────────────────────

  private getPartition(k: K): Partition<IK, IV> {
    let partition = this.partitions.get(k)
    // 非 dirty 分区读侧校验（cache-governance §3.2.4「外部优先」）：外部改动 / 删除 /
    // 新建在下一次访问即生效。dirty 分区跳过——drop 会连未落盘写一起丢，外部改动由
    // flush 前的冲突检测兜底（备份 + warn）。
    if (partition && partition.dirty.size === 0 && this.partitionStaleOnDisk(k, partition)) {
      this.dropPartition(k)
      partition = undefined
    }
    if (!partition) {
      // 指纹先于加载采集：若加载窗口内文件又被外部改，指纹旧于内容 → 下次校验失配
      // 重载（安全方向，同 JsonStore.readFromDisk；反序会把新指纹配旧内容，陈旧值
      // 被指纹命中固化）
      const loadRevision = statPartitionRevision(this.backing.partitionPath(k))
      const data = this.backing.loadPartition(k)
      let totalSize = 0
      for (const v of data.values()) {
        totalSize += this.sizeOf(v)
      }
      partition = { data, dirty: new Set(), flushTimer: null, totalSize, loadRevision }
      this.partitions.set(k, partition)
    }
    return partition
  }

  /**
   * 读侧校验：磁盘指纹相对分区加载时刻已变（外部改写 / 删除 / 新建）返回 true。
   * ENOENT 视为指纹 undefined，与「加载时文件不存在」的 undefined loadRevision 相等
   * （文件持续缺失稳定命中，不抖动重载）。
   */
  private partitionStaleOnDisk(k: K, partition: Partition<IK, IV>): boolean {
    let revision: string | undefined
    try {
      revision = statFingerprint(this.backing.partitionPath(k))
    } catch (e: unknown) {
      if (!isEnoent(e)) {
        // stat 抛非 ENOENT：探针失败 ≠ 文件变更，不 drop（同 JsonStore 读判定）
        console.warn(
          `[json-store] 分区 stat 探针失败，按未变更处理。恢复指引：检查文件权限/挂载，` +
          `机制本身下次访问自动重试。partition="${k}"`,
          e instanceof Error ? e.message : e,
        )
        return false
      }
      // ENOENT：文件被外部删 → 指纹 undefined
    }
    return revision !== partition.loadRevision
  }

  /**
   * flush 前冲突检测（cache-governance §3.2.4）：磁盘指纹相对 loadRevision 已变
   * （dirty 窗口内外部改/建了文件）→ 先复制磁盘当前内容为 `<path>.conflict-<ts>`
   * 备份（与 `.corrupt-<ts>` quarantine 同构留存）再放行覆写，warn 含原文件与备份
   * 双路径 + 恢复指引。返回 false = 备份失败，调用方须中止本次 persist（保留 dirty）。
   */
  private backupExternalConflict(k: K, partition: Partition<IK, IV>): boolean {
    const path = this.backing.partitionPath(k)
    let revision: string | undefined
    try {
      revision = statFingerprint(path)
    } catch (e: unknown) {
      if (isEnoent(e)) {
        // 文件不存在：无内容可覆盖也无可备份（外部删除先于 flush，非 flush 造成），
        // 放行覆写重建
        return true
      }
      // 探针失败：无法判定冲突。落盘是 dirty 写的既定义务，不因探针失败无限搁置，
      // 但必须出声（G2 禁静默覆盖）
      console.warn(
        `[json-store] flush 前 stat 探针失败，冲突检测跳过、照常落盘。` +
        `恢复指引：如怀疑外部改动被覆盖，检查数据目录近期备份。partition="${k}", path=${path}`,
        e instanceof Error ? e.message : e,
      )
      return true
    }
    if (revision === partition.loadRevision) return true
    // ISO 时间戳压缩格式：与 .corrupt-<ts> quarantine 同构（文件名安全，字典序即时间序）
    const ts = new Date().toISOString().replace(/[:.]/g, '')
    const backupPath = `${path}.conflict-${ts}`
    try {
      copyFileSync(path, backupPath)
    } catch (e: unknown) {
      console.error(
        `[json-store] flush 冲突备份失败，本次落盘中止（保留 dirty 自动重试）。` +
        `恢复指引：排查磁盘权限/空间后等待重试。partition="${k}", path=${path}, backup=${backupPath}`,
        e instanceof Error ? e.message : e,
      )
      return false
    }
    console.warn(
      `[json-store] flush 检测到外部改动，已先备份再覆写。` +
      `恢复指引：外部修改从 .conflict 备份找回。原文件=${path}, 备份=${backupPath}, partition="${k}"`,
    )
    return true
  }

  private dropPartition(k: K): void {
    const partition = this.partitions.get(k)
    if (partition?.flushTimer) {
      clearTimeout(partition.flushTimer)
    }
    this.partitions.delete(k)
  }

  private scheduleFlush(k: K): void {
    const partition = this.partitions.get(k)
    if (!partition) return
    if (partition.flushTimer) clearTimeout(partition.flushTimer)
    partition.flushTimer = setTimeout(() => {
      partition.flushTimer = null
      this.flush(k)
    }, this.flushMs)
  }
}
