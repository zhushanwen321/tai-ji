/**
 * 四级恢复阶梯（设计 §3.5 单一规格，全网唯一——其他位置只引用不另立）：
 *
 *   L1 直开（readonly）：-wal 在场时正常工作（实测：写者活跃 + -wal 有内容可开
 *      且读到已提交行）。失败多因 -wal 缺失（静息态 bun 必 CANTOPEN——F22）。
 *   L2 immutable 逃逸（常态恢复，零拷贝）：直开失败 ∧ 开库前确认 -wal 不存在
 *      → file:<db>?immutable=1（免拷贝、数据完整、不创建 -shm——F25）。
 *      ⚠ 门控：immutable 仅在确认 -wal 缺失时用——有内容 -wal 下 immutable 静默丢行。
 *   L3 小库快照兜底（罕见）：immutable 也失败 → db 拷 mkdtemp（固定前缀
 *      taiji-zcode-snap-）+ 自建 0 字节 -wal → 开库后验证 sqlite_master 表集合含
 *      session/message/part（防「开库成功但缺表」半残态）→ 通过才读。
 *      规模门：db 文件 > 256MB 不拷 → 直接错误面。
 *   L4 错误面：SqliteUnreadableError（attempted 记录已尝试的等级、跳过原因并入
 *      message，供上层映射 zcode_db_unreadable——错误码词表属消费侧，本包不私建）。
 *
 *   拷贝集唯一定义：db only + 自建 0 字节 -wal；-wal/-shm 在场绝不自动拷贝
 *   （旧 wal + 新 db 顺序错配会静默回滚到旧数据，实测证实），-shm 永不进拷贝集
 *   （竞态共享索引，副本目录可写即可重建）。
 *
 * 实现注记（node:sqlite 实测，2026-09-21 探针）：DatabaseSync 打开是惰性的——
 * 损坏文件 open 成功、首次查询才报 NOTADB。因此每级「成功」判定 = open 不抛
 * ∧ 探测查询（读 sqlite_master）不抛，否则 bun/node 双端成功语义不可对齐。
 *
 * 崩溃残留显式「不接管」：mkdtemp 固定前缀 taiji-zcode-snap- + 读后 finally 清理；
 * os.tmpdir() 由 OS 回收，前缀可人工识别。不为此新增清理器（新机制新义务，超出
 * 读取链职责——设计 §3.4 CANTOPEN 四要素「恢复路径」节）。
 */

import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'

import { loadSqliteDriver, toSqliteFileUri, type SqliteDb } from './sqlite-driver.ts'

/** 阶梯级别标识（attempted 记录与调用方结构化日志消费）。 */
export type RecoveryLevel = 'L1-direct' | 'L2-immutable' | 'L3-snapshot'

/** L3 快照目录固定前缀（崩溃残留人工识别 + 验收判据断言面）。 */
export const SNAPSHOT_TMP_PREFIX = 'taiji-zcode-snap-'

/** KiB 字节数——SNAPSHOT_MAX_DB_BYTES 的乘数基元。 */
const KIB = 1024

/** L3 规模门上限：256MB（KiB 计）。 */
const SNAPSHOT_MAX_DB_KIB = 256

/** L3 规模门：db 文件超过此大小不拷（直接错误面 + 指引）。 */
export const SNAPSHOT_MAX_DB_BYTES = SNAPSHOT_MAX_DB_KIB * KIB * KIB

/** L3 开库后的表集合验证（防「开库成功但缺表」半残态）。 */
export const REQUIRED_TABLES: readonly string[] = ['session', 'message', 'part']

/** -wal 附属文件路径。 */
function walPathOf(dbPath: string): string {
  return `${dbPath}-wal`
}

/**
 * 阶梯整体失败的错误形态。attempted = 已尝试的级别序列（被门控跳过的级别不入列，
 * 跳过原因并入 message）；上层映射 zcode_db_unreadable 时把 attempted 与 message
 * 一起带进结构化日志/恢复指引（设计 §3.4「可观测性」）。
 */
export class SqliteUnreadableError extends Error {
  readonly attempted: RecoveryLevel[]
  constructor(attempted: RecoveryLevel[], message: string) {
    super(message)
    this.name = 'SqliteUnreadableError'
    this.attempted = attempted
  }
}

/** 某一级的开库产物：连接 + 探测出的表名集合。 */
interface OpenAttempt {
  db: SqliteDb
  tableNames: string[]
}

async function tryOpen(dbPath: string, opts: { immutable?: boolean } = {}): Promise<OpenAttempt> {
  const driver = await loadSqliteDriver()
  const target = opts.immutable ? toSqliteFileUri(dbPath, true) : dbPath
  const db = driver.open(target, { readOnly: true })
  try {
    // 探测查询兼作表集合来源：node:sqlite 打开惰性（损坏文件 open 成功、查询才
    // NOTADB），不跑查询则「开库成功」在双端语义不可对齐。
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    const tableNames: string[] = []
    for (const row of rows) {
      if (typeof row === 'object' && row !== null) {
        const name = (row as Record<string, unknown>).name
        if (typeof name === 'string') tableNames.push(name)
      }
    }
    return { db, tableNames }
  } catch (err) {
    // 探测失败 = 该级失败：先关连接防 fd 泄漏，再按失败上抛（close 错误吞掉——
    // 失败归因以探测错误为准）
    try {
      db.close()
    } catch (err) {
      /* 探测已失败，close 错误不参与归因 */
      console.debug('recovery: close after failed probe not attributed (best-effort)', err)
    }
    throw err
  }
}

function tablesPresent(tableNames: readonly string[]): boolean {
  const set = new Set(tableNames)
  return REQUIRED_TABLES.every((t) => set.has(t))
}

function closeQuietly(db: SqliteDb): void {
  try {
    db.close()
  } catch (err) {
    // [HISTORICAL] 只读连接 close 失败（WAL 并发读常见）不影响读取结果——吞掉继续
    console.debug('recovery: readonly connection close failed (best-effort)', err)
  }
}

/**
 * 当前 tmpdir 下已存在的快照目录数（测试断言「零拷贝/读后即清」的计数基线）。
 * 测试支撑件（住生产 src 仅因与恢复阶梯共用 SNAPSHOT_TMP_PREFIX 单一来源，位置不另立）：
 * readdir 失败必须上抛、不得静默返 0——静默 0 会把「零残留」差分断言退化为恒真（假绿），
 * 测试必须显式红而非静默绿。
 */
export function countSnapshotDirs(): number {
  return readdirSync(tmpdir()).filter((n) => n.startsWith(SNAPSHOT_TMP_PREFIX)).length
}

/** 阶梯开库产物：连接 + 实际命中的级别 + 统一 dispose（close + L3 快照清理）。 */
export interface OpenedWithRecovery {
  db: SqliteDb
  /** 实际成功的阶梯级别（恢复成功非静默事件：调用方按 §3.4 记结构化日志）。 */
  via: RecoveryLevel
  /** 幂等收尾：close 连接；L3 时删除快照目录。finally 必调。 */
  dispose: () => void
}

/**
 * 四级恢复阶梯编排（单一规格，全网唯一）。db 文件不存在时同样以
 * SqliteUnreadableError 落 L4（消费方在更早的存在性检查之后才会走到这里，仍以
 * unreadable 语义兜底——错误码映射在消费侧）。
 */
export async function openWithRecovery(dbPath: string): Promise<OpenedWithRecovery> {
  const attempted: RecoveryLevel[] = []
  const skipNotes: string[] = []
  let lastError: unknown

  // ---- L1 直开（readonly）----
  try {
    const opened = await tryOpen(dbPath)
    return toResult(opened, 'L1-direct')
  } catch (err) {
    attempted.push('L1-direct')
    lastError = err
  }

  // ---- L2 / L3（共同前置门控：仅当 -wal 不存在）----
  const walPresent = existsSync(walPathOf(dbPath))
  if (walPresent) {
    // -wal 在场：immutable 静默丢行（F25）、快照拷贝会引入「旧 wal + 新 db」的
    // 静默回滚——两级全部门控跳过，响亮落错误面（「-wal 在场绝不自动拷贝」断言面）。
    skipNotes.push('-wal present: L2 immutable and L3 snapshot gated off (silent data loss / rollback guard)')
  } else {
    // ---- L2 immutable 逃逸（常态恢复，零拷贝）----
    try {
      const opened = await tryOpen(dbPath, { immutable: true })
      return toResult(opened, 'L2-immutable')
    } catch (err) {
      attempted.push('L2-immutable')
      lastError = err
    }

    // ---- L3 小库快照兜底（规模门先行）----
    let dbBytes = -1
    try {
      dbBytes = statSync(dbPath).size
    } catch (err) {
      /* stat 失败按未知大小处理，交给快照路径的拷贝失败归因 */
      console.debug('recovery: statSync failed, db size treated as unknown (best-effort)', err)
    }
    if (dbBytes > SNAPSHOT_MAX_DB_BYTES) {
      skipNotes.push(
        `L3 rejected by size gate: db is ${dbBytes} bytes (> ${SNAPSHOT_MAX_DB_BYTES}), copy refused`,
      )
    } else {
      try {
        const snap = await openViaSnapshot(dbPath)
        return {
          db: snap.db,
          via: 'L3-snapshot',
          dispose() {
            closeQuietly(snap.db)
            rmSync(snap.snapshotDir, { recursive: true, force: true })
          },
        }
      } catch (err) {
        attempted.push('L3-snapshot')
        lastError = err
      }
    }
  }

  // ---- L4 错误面 ----
  const parts: string[] = [`zcode session db unreadable (recovery ladder exhausted): ${dbPath}`]
  if (skipNotes.length > 0) parts.push(skipNotes.join('; '))
  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  parts.push(`last failure: ${detail}`)
  throw new SqliteUnreadableError(attempted, parts.join(' — '))
}

function toResult(opened: OpenAttempt, via: RecoveryLevel): OpenedWithRecovery {
  return {
    db: opened.db,
    via,
    dispose() {
      closeQuietly(opened.db)
    },
  }
}

/** L3 单级产物（测试直接消费：W 断言快照目录前缀/读后即清）。 */
export interface SnapshotOpenResult {
  db: SqliteDb
  tableNames: string[]
  snapshotDir: string
}

/**
 * L3 快照兜底（单级）。拷贝集唯一定义 = db only + 自建 0 字节 -wal；-shm 永不进
 * 拷贝集。快照目录固定前缀 taiji-zcode-snap-；失败路径（拷贝/开库/表集合验证）
 * 在上抛前关闭连接并删除快照目录，成功路径由调用方 dispose 收尾。规模门在本函数
 * 同样生效（直接调用面也对齐规格）。
 */
export async function openViaSnapshot(dbPath: string): Promise<SnapshotOpenResult> {
  const dbBytes = statSync(dbPath).size
  if (dbBytes > SNAPSHOT_MAX_DB_BYTES) {
    throw new SqliteUnreadableError(
      [],
      `snapshot refused by size gate: db is ${dbBytes} bytes (> ${SNAPSHOT_MAX_DB_BYTES}), copy refused`,
    )
  }
  const snapshotDir = mkdtempSync(join(tmpdir(), SNAPSHOT_TMP_PREFIX))
  let opened: OpenAttempt | undefined
  try {
    const snapDb = join(snapshotDir, basename(dbPath))
    copyFileSync(dbPath, snapDb)
    writeFileSync(`${snapDb}-wal`, '')
    opened = await tryOpen(snapDb)
    if (!tablesPresent(opened.tableNames)) {
      throw new Error(
        `snapshot db failed table-set validation: expected ${REQUIRED_TABLES.join('/')}, found ` +
          `${opened.tableNames.length > 0 ? [...opened.tableNames].sort().join('/') : '(none)'}`,
      )
    }
    return { db: opened.db, tableNames: opened.tableNames, snapshotDir }
  } catch (err) {
    if (opened) closeQuietly(opened.db)
    rmSync(snapshotDir, { recursive: true, force: true })
    throw err
  }
}
