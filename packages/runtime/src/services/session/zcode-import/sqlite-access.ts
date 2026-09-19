/**
 * zcode 会话库只读访问层（session-import-unified 设计 §3.3「sqlite 访问约定」/§3.7/§3.8）。
 *
 * 访问模式复用 packages/zcode-subagent-cli/src/reader.ts 先例（§2.3「既有读取实现」）：
 * - node:sqlite DatabaseSync readOnly 连接（WAL 只读不阻塞 zcode 宿主写入，§3.8）；
 * - 转换/查询全程不写宿主库（G4 严格只读）；
 * - close 失败吞错（WAL 并发读下只读连接 close 失败不影响已读结果）。
 *
 * 本模块不 import 引擎包（zcode-subagent-cli 不是 runtime 依赖，runtime 内自建访问）；
 * 宿主库路径常量与引擎包 db-path.ts 的 ZCODE_HOST_DB_SUFFIX 同语义、在此重声明
 * （见下方 HOST_DB_SUFFIX 注释）。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 宿主 HOME 下 zcode 会话库相对段（`~/.zcode/cli/db/db.sqlite`）。
 * 与 packages/zcode-subagent-cli/src/db-path.ts 的 ZCODE_HOST_DB_SUFFIX 同源同语义
 * （该常量 = `['.zcode', 'cli', 'db', 'db.sqlite']`）；不 import 引擎包故在此重声明
 * ——两侧漂移由 zcode 安装布局变更时共同暴露，引擎侧 allowlist 与本路径推导语义一致。
 */
const HOST_DB_SUFFIX = ['.zcode', 'cli', 'db', 'db.sqlite'] as const

/** 宿主库默认路径（运行时动态推导，禁硬编码绝对路径——组合根注入给 source 的默认值）。 */
export function hostZcodeDbPath(): string {
  return join(homedir(), ...HOST_DB_SUFFIX)
}

/** 候选/会话行的最小消费列（camelCase，source 层不再触 sqlite 原始 snake_case）。 */
export interface ZcodeSessionRow {
  id: string
  title: string
  directory: string
  taskType: string
  /** 毫秒时间戳（session.time_created/time_updated，schema integer） */
  timeCreated: number
  timeUpdated: number
}

/**
 * 单会话全量转换行集的 message 行（U4 转换器输入）。parts 元素 = part.data 已解析
 * JSON 对象本体（不包 {sequence, data} 行壳——转换器把 parts 元素直接当 part 消费，
 * 包装壳会让 part.type 全体读成 undefined；part 序即数组序 = 联合序，sequence 冗余不导出）。
 */
export interface ZcodeTranscriptMessageRow {
  id: string
  sequence: number
  data: Record<string, unknown>
  parts: Array<Record<string, unknown>>
}

/** node:sqlite 驱动的最小消费面（结构类型，禁 any；与 reader.ts 的 SqliteDb 同手法）。 */
interface SqliteStatement {
  all: (...args: unknown[]) => unknown[]
  get: (...args: unknown[]) => unknown
}

interface SqliteDb {
  prepare: (sql: string) => SqliteStatement
  close: () => void
}

/** 只读查询面：候选行 / 单会话行 / 字节聚合 / schema 版本诊断。 */
export interface ZcodeReadonlyDb {
  /**
   * 候选会话行（D8：排除 subagent_child；time_updated 降序）。
   * limit 可选：SQL 级截断。调用方需要全量语义（query 过滤 / total / dirs 聚合与
   * pi 源同构）时不传——全表 4k 行毫秒级（§3.8），JS 侧再过滤后截断。
   */
  listCandidateSessions(opts?: { limit?: number }): ZcodeSessionRow[]
  /** 按原始 id 取单行（prepareImport 校验用）；不存在返回 undefined。 */
  getSessionRow(id: string): ZcodeSessionRow | undefined
  /**
   * 单会话全量转换行集（U4 转换器输入）：message 按 sequence 升序，每条 message 的
   * parts 按 (message.sequence, part.sequence) 联合序排好。LEFT JOIN 保留无 part 的
   * message（parts 空数组）。data 列 JSON 解析失败抛 Error（调用方按 §3.6 ② schema
   * 漂移映射 import_invalid_session）。
   */
  getSessionTranscript(sessionId: string): ZcodeTranscriptMessageRow[]
  /**
   * 真字节口径的会话体量（§3.7）：SUM(length(CAST(part.data AS BLOB)))——TEXT 直接
   * length() 返回字符数，CJK 内容会低估；GROUP BY session_id 走 part_session_idx。
   * 无 part 的会话不在返回 Map 中（调用方按 0 处理）。
   */
  candidatesByteSize(sessionIds: readonly string[]): Map<string, number>
  /** best-effort 读 schema_migration 版本（查询失败的错误诊断用，失败返回 undefined）。 */
  readSchemaVersion(): string | undefined
  /** 关闭连接（吞错语义见模块头注；幂等无害——重复 close 由驱动抛错吞掉）。 */
  close(): void
}

function asString(v: unknown, col: string): string {
  if (typeof v !== 'string') throw new Error(`session 表 ${col} 列类型异常（期望 string，实际 ${typeof v}）`)
  return v
}

function asNumber(v: unknown, col: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`session 表 ${col} 列类型异常（期望 number，实际 ${typeof v}）`)
  return v
}

/** sqlite 原始行（snake_case）→ ZcodeSessionRow，类型守卫后置（驱动返回 unknown，禁 any）。 */
function rowToSessionRow(row: unknown): ZcodeSessionRow {
  if (typeof row !== 'object' || row === null) throw new Error('session 表返回非对象行')
  const r = row as Record<string, unknown>
  return {
    id: asString(r.id, 'id'),
    title: asString(r.title, 'title'),
    directory: asString(r.directory, 'directory'),
    taskType: asString(r.task_type, 'task_type'),
    timeCreated: asNumber(r.time_created, 'time_created'),
    timeUpdated: asNumber(r.time_updated, 'time_updated'),
  }
}

/**
 * message/part 行的 data 列（JSON 字符串）→ 已解析对象。非法 JSON / 非对象形态抛
 * Error（上下文带表与行标识）——上游（import-source-zcode write 闭包）按 §3.6 ②
 * schema 漂移映射 import_invalid_session，不在本层静默跳过（整行丢失会破坏切段配对）。
 */
function parseRowData(raw: unknown, ctx: string): Record<string, unknown> {
  if (typeof raw !== 'string') {
    throw new Error(`${ctx} 列类型异常（期望 JSON 字符串，实际 ${typeof raw}）`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${ctx} 不是合法 JSON（${err instanceof Error ? err.message : String(err)}）`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${ctx} 解析后非对象（实际 ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}）`)
  }
  return parsed as Record<string, unknown>
}

function wrapDb(db: SqliteDb): ZcodeReadonlyDb {
  return {
    listCandidateSessions(opts) {
      // D8：subagent_child（内部子任务）不进候选域；task_type 有索引（§2.3）
      const sql =
        'SELECT id, title, directory, task_type, time_created, time_updated FROM session ' +
        "WHERE task_type != 'subagent_child' ORDER BY time_updated DESC" +
        (opts?.limit !== undefined ? ' LIMIT ?' : '')
      const rows = opts?.limit !== undefined ? db.prepare(sql).all(opts.limit) : db.prepare(sql).all()
      return rows.map(rowToSessionRow)
    },
    getSessionRow(id) {
      const row = db
        .prepare('SELECT id, title, directory, task_type, time_created, time_updated FROM session WHERE id = ?')
        .get(id)
      return row === undefined ? undefined : rowToSessionRow(row)
    },
    getSessionTranscript(sessionId) {
      // 联合序（C1 探针 2026-09-19 实测，见 converter.ts 头注）：ORDER BY m.sequence, p.sequence
      // 与 part 自身 time.start 时序一致（3 个 interactive 会话 3415 parts 零逆序）。
      // LEFT JOIN 保留无 part 的 message（pseq/pdata 为 NULL 的行）
      const rows = db
        .prepare(
          'SELECT m.id AS mid, m.sequence AS mseq, m.data AS mdata, p.sequence AS pseq, p.data AS pdata ' +
            'FROM message m LEFT JOIN part p ON p.message_id = m.id ' +
            'WHERE m.session_id = ? ORDER BY m.sequence, p.sequence',
        )
        .all(sessionId)
      const messages: ZcodeTranscriptMessageRow[] = []
      let current: ZcodeTranscriptMessageRow | undefined
      for (const row of rows) {
        if (typeof row !== 'object' || row === null) throw new Error('message/part 联合查询返回非对象行')
        const r = row as Record<string, unknown>
        const mid = asString(r.mid, 'message.id')
        // ORDER BY 保证同一 message 的行连续：id 变化即开新组（message.id 是主键）
        if (current?.id !== mid) {
          current = {
            id: mid,
            sequence: asNumber(r.mseq, 'message.sequence'),
            data: parseRowData(r.mdata, `message(${mid}).data`),
            parts: [],
          }
          messages.push(current)
        }
        if (r.pseq !== null && r.pseq !== undefined && r.pdata !== null && r.pdata !== undefined) {
          current.parts.push(parseRowData(r.pdata, `part(message=${mid}).data`))
        }
      }
      return messages
    },
    candidatesByteSize(sessionIds) {
      if (sessionIds.length === 0) return new Map<string, number>()
      const placeholders = sessionIds.map(() => '?').join(', ')
      const rows = db
        .prepare(
          `SELECT session_id AS sid, SUM(length(CAST(data AS BLOB))) AS bytes FROM part WHERE session_id IN (${placeholders}) GROUP BY session_id`,
        )
        .all(...sessionIds)
      const sizes = new Map<string, number>()
      for (const row of rows) {
        if (typeof row !== 'object' || row === null) continue
        const r = row as Record<string, unknown>
        if (typeof r.sid === 'string' && typeof r.bytes === 'number') sizes.set(r.sid, r.bytes)
      }
      return sizes
    },
    readSchemaVersion() {
      try {
        const row = db.prepare('SELECT app_version FROM schema_migration ORDER BY time_applied DESC LIMIT 1').get()
        if (typeof row === 'object' && row !== null) {
          const v = (row as Record<string, unknown>).app_version
          if (typeof v === 'string' && v.length > 0) return v
        }
        return undefined
      } catch {
        // best-effort 诊断（主查询已失败，schema_migration 可能同样不可读）：吞错不带版本
        return undefined
      }
    },
    close() {
      try {
        db.close()
      } catch (err) {
        // [HISTORICAL] 只读连接 close 失败（WAL 并发读常见）不影响读取结果——吞掉继续
        //（reader.ts 同款语义，§3.8「宿主库并发」）
        void err
      }
    },
  }
}

/**
 * 打开 zcode 会话库只读连接。dbPath 不存在直接抛（调用方映射 import_source_missing）；
 * 打开失败（权限/锁/驱动不可用）抛原始错误（调用方映射错误规格，§3.6）。
 */
export async function openZcodeReadonlyDb(dbPath: string): Promise<ZcodeReadonlyDb> {
  if (!existsSync(dbPath)) {
    throw new Error(`db 文件不存在：${dbPath}`)
  }
  // [HISTORICAL] 动态 import 必须经变量间接：esbuild CJS 输出会把字面量
  // import("node:sqlite") 规约成裸名 import("sqlite")（external 化 node builtin 时的
  // 前缀剥离），而 Node 动态 import 裸名不走内置模块 fallback → ERR_MODULE_NOT_FOUND
  // → taiji runtime bundle（tsup CJS）下恒失败（2026-08-25 P5 实测，reader.ts 同款坑）。
  // 非字面量 specifier esbuild 无法静态分析，保留原样输出，node: 前缀运行时正确解析。
  const sqliteModuleId = 'node:sqlite'
  const sqliteMod = (await import(sqliteModuleId).catch(() => undefined)) as
    | { DatabaseSync?: unknown }
    | undefined
  const DatabaseSyncCtor = sqliteMod?.DatabaseSync
  if (typeof DatabaseSyncCtor !== 'function') {
    throw new Error('当前 node 运行时不支持 node:sqlite（需 >=22.13）')
  }
  type DatabaseSyncLike = new (path: string, opts: { readOnly: boolean }) => SqliteDb
  return wrapDb(new (DatabaseSyncCtor as DatabaseSyncLike)(dbPath, { readOnly: true }))
}
