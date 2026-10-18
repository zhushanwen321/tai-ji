/**
 * 磁盘 outbox —— DeliveryStore 的 runtime 半区实现（统一消息投递设计 §3.5.1 / §3.8
 * 文本行，波 4；关闭 ADR-0074「outbox 不落盘」代价）。
 *
 * 形态：JSONL 追加文件，每行一个 JSON 对象（`t` 字段判别行型），单调累积——
 * - `{"t":"record","r":<DeliveryStoreRecord>}`：受理前写入记录（耐久承诺先于投递尝试）；
 * - `{"t":"ack","id":...}`：终局（delivered / cancelled 同形，判重只看 id）——终局行
 *   保留是判重依据（已撤销消息的防复活凭据同样在此），**单调累积、不实现清理通道**；
 * - `{"t":"discard","id":...}`：forget 失败条目的记录移除（无终局无判重语义，区别于
 *   ack——loadUndelivered 跳过、hasTerminal 为假，防重启后被当未投递复活）；
 * - `{"t":"meta","id":...,"segments":...}`：segments 快照补记（runtime 侧撤销编排的
 *   回填通道——重启重放后撤销仍返回原始 segments）。
 *
 * 读取 = 全量行序重放（后行覆盖前行）：record 建记录 / ack 进终局集 / discard 进弃置
 * 集 / meta 并入记录 meta。同 id 先 discard 后 record = 记录复活（新承诺覆盖弃置）；
 * 同 id 先 ack 后 record = 判重保持（终局集不撤销——宁可误吞不误重投，与内核
 * store.hasTerminal 注释口径一致）。
 *
 * 本文件零 node:fs 依赖：全部 fs 操作经 DiskStoreFs 窄接口注入（内核包零 fs 知识纪律，
 * 设计 §3.5.1「两个实现在两半区适配层」）；目录与文件路径由装配方（runtime 侧）动态
 * 推导后以字符串传入。崩溃写入的中途半行由读取容错覆盖（JSON.parse 失败 warn 跳过）
 * ——最坏丢一行 = 最坏多投一次，与「必达优先于去重」语义一致，不需要原子替换协议。
 */
import type { DeliveryStore, DeliveryStoreRecord } from './types.js'

/** fs 窄接口（注入面；生产 = node:fs 适配，测试 = 内存替身）。 */
export interface DiskStoreFs { // oe-exempt:20261017:framework:磁盘 outbox 的 fs 注入端口（runtime 侧注入实现，内核零 fs 知识）
  existsSync(path: string): boolean
  mkdirSync(path: string, opts: { recursive: true }): unknown
  readFileSync(path: string, encoding: 'utf8'): string
  appendFileSync(path: string, data: string): void
}

/** 行型判别字段与记录行负载（文件格式契约，版本演进只加行型不改行义）。 */
interface RecordLine { // oe-exempt:20261017:framework:outbox JSONL record 行形态（版本化行族，坏行容错读）
  t: 'record'
  r: DeliveryStoreRecord
}
interface AckLine { // oe-exempt:20261017:framework:outbox JSONL ack 行形态（终局行，单调累积判重依据）
  t: 'ack'
  id: string
  /** 终局落定时间（epoch ms；诊断信息，判重不读）。 */
  at: number
}
interface DiscardLine { // oe-exempt:20261017:framework:outbox JSONL discard 行形态（forget 失败即弃终局）
  t: 'discard'
  id: string
  at: number
}
interface MetaLine { // oe-exempt:20261017:framework:outbox JSONL meta 行形态（撤销 segments 跨重启回填载体）
  t: 'meta'
  id: string
  segments: unknown[]
}
type OutboxLine = RecordLine | AckLine | DiscardLine | MetaLine

export interface DiskDeliveryStoreDeps { // oe-exempt:20261017:framework:磁盘 store 装配契约（DeliveryStore 端口的 runtime 半区实现）
  /** fs 操作面（注入；内核零 node:fs import）。 */
  fs: DiskStoreFs
  /** outbox 目录（绝对路径，装配方动态推导；首次写入前惰性创建）。 */
  dir: string
  /** outbox 文件（`<dir>/<sessionId 编码>.jsonl`，装配方拼装）。 */
  file: string
  /** 读取容错与写失败的留痕出口；缺省 console.warn。 */
  log?: (message: string, err?: unknown) => void
}

/** 磁盘 outbox store：DeliveryStore 契约 + segments 补记扩展（registry 撤销回填通道）。 */
export interface DiskDeliveryStore extends DeliveryStore { // oe-exempt:20261017:framework:DeliveryStore 端口的文本车道磁盘实现契约
  /**
   * segments 快照补记（实现侧扩展，**非 DeliveryStore 端口成员**——内核不感知）：
   * 把提交侧 attachSegments 登记的原始快照追加为 meta 行，随记录跨重启存活；
   * 重放侧经 loadUndelivered 的 record.meta.segments 取回。同 id 多次补记按行序
   * 后写覆盖先写。
   */
  attachSegments(id: string, segments: readonly unknown[]): void
}

/** 行序列化（单行 JSON + 换行；JSON.stringify 不保字段序稳定性无影响——按 t 判别）。 */
function serializeLine(line: OutboxLine): string {
  return `${JSON.stringify(line)}\n`
}

export function createDiskDeliveryStore(deps: DiskDeliveryStoreDeps): DiskDeliveryStore {
  const { fs, dir, file } = deps
  const log = deps.log ?? ((message: string, err?: unknown): void => { console.warn(message, err ?? '') })

  // 全量行序重放的内存派生数据（懒加载一次；此后运行期直接维护，不重读文件）
  let loaded = false
  const records = new Map<string, DeliveryStoreRecord>()
  const terminalIds = new Set<string>()
  const discardedIds = new Set<string>()
  let dirCreated = false

  function applyLine(line: OutboxLine): void {
    if (line.t === 'record') {
      records.set(line.r.id, line.r)
      discardedIds.delete(line.r.id) // discard 后同 id 新 record 行 = 新承诺，记录复活
      return
    }
    if (line.t === 'ack') {
      terminalIds.add(line.id)
      return
    }
    if (line.t === 'discard') {
      discardedIds.add(line.id)
      records.delete(line.id)
      return
    }
    // meta 行：segments 并入记录 meta（无记录在册的 meta 行为孤儿——保留待 record 行
    // 后到的归并场景按行序自然并入；此处 records.set 前置存在才并入）
    const record = records.get(line.id)
    if (record) {
      record.meta = { ...record.meta, segments: line.segments }
    }
  }

  function ensureLoaded(): void {
    if (loaded) return
    loaded = true
    if (!fs.existsSync(file)) return
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (err) {
      // 读取失败按空文件处理：判重失效（terminalIds 空 → 宁可多投）+ 本轮重放源
      // 不可用（内存派生数据全空，loadUndelivered 返回空不重放）；warn 留痕，重启重读自愈。
      log(`[disk-delivery-store] read failed (treated as empty), file=${file}`, err)
      return
    }
    let lineNumber = 0
    for (const lineText of raw.split('\n')) {
      lineNumber += 1
      const trimmed = lineText.trim()
      if (trimmed === '') continue
      let line: OutboxLine
      try {
        line = JSON.parse(trimmed) as OutboxLine
      } catch {
        // 损坏行（含崩溃写入的中途半行）跳过不炸启动——最坏多投一次，必达优先
        log(`[disk-delivery-store] corrupted line skipped, file=${file}, line=${lineNumber}`)
        continue
      }
      if (!line || typeof line !== 'object' || typeof (line as { t?: unknown }).t !== 'string') {
        log(`[disk-delivery-store] malformed line skipped, file=${file}, line=${lineNumber}`)
        continue
      }
      applyLine(line)
    }
  }

  function appendLine(line: OutboxLine): void {
    if (!dirCreated) {
      fs.mkdirSync(dir, { recursive: true })
      dirCreated = true
    }
    fs.appendFileSync(file, serializeLine(line))
  }

  return {
    persist(record: DeliveryStoreRecord): void {
      ensureLoaded()
      appendLine({ t: 'record', r: record })
      applyLine({ t: 'record', r: record })
    },
    ack(id: string): void {
      ensureLoaded()
      appendLine({ t: 'ack', id, at: Date.now() })
      applyLine({ t: 'ack', id, at: 0 })
    },
    discard(id: string): void {
      ensureLoaded()
      appendLine({ t: 'discard', id, at: Date.now() })
      applyLine({ t: 'discard', id, at: 0 })
    },
    loadUndelivered(): readonly DeliveryStoreRecord[] {
      ensureLoaded()
      const out: DeliveryStoreRecord[] = []
      for (const record of records.values()) {
        if (terminalIds.has(record.id) || discardedIds.has(record.id)) continue
        out.push(record)
      }
      return out
    },
    loadTerminalIds(): readonly string[] {
      ensureLoaded()
      return [...terminalIds]
    },
    hasTerminal(id: string): boolean {
      ensureLoaded()
      return terminalIds.has(id)
    },
    attachSegments(id: string, segments: readonly unknown[]): void {
      ensureLoaded()
      appendLine({ t: 'meta', id, segments: [...segments] })
      applyLine({ t: 'meta', id, segments: [...segments] })
    },
  }
}
