/**
 * zcode 会话库只读访问层（自 runtime services/session/zcode-import/sqlite-access.ts
 * 迁入改造；runtime 侧旧文件已随共享基座实施收口删除（git 可追溯），本包为其唯一现行承载）。
 *
 * 访问模式（沿用既有先例）：
 * - 只读连接（readonly 语义 = WAL 只读不阻塞宿主写入）；转换/查询全程不写库；
 * - close 失败吞错（WAL 并发读下只读连接 close 失败不影响已读结果）。
 *
 * 相对 runtime 旧版的改造：
 * - 驱动来自本包 sqlite-driver（D3 双驱动），不再固定 node:sqlite；
 * - 开库统一走四级恢复阶梯（recovery.ts，设计 §3.5 单一规格）——runtime（node）
 *   侧直开从来可用（F24），阶梯主要服务 bun 宿主侧的静息态 CANTOPEN；
 * - schema 版本从「best-effort 诊断」升级为已知集闸门（KNOWN_ZCODE_SCHEMA_
 *   VERSIONS，版本超出已知集抛 ZcodeSchemaDriftError——错误码词表属消费侧，
 *   本包不私建 zcode_* 码）。
 *
 * 本模块不 import 引擎包（zcode-subagent-cli 不是依赖）；库路径段常量与引擎侧
 * db-path.ts 同源自 @zhushanwen/subagent-engine-sdk 的 zcode-db-paths.ts（跨侧
 * 契约根，两侧 import 同一常量——非各自重声明）。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ZCODE_HOST_DB_SUFFIX, ZCODE_ISOLATED_DB_SEGMENTS } from '@zhushanwen/subagent-engine-sdk'

import { openWithRecovery, type RecoveryLevel } from './recovery.ts'
import type { SqliteDb } from './sqlite-driver.ts'

/** 宿主库默认路径（运行时动态推导，禁硬编码绝对路径——组合根注入给消费方的默认值）。 */
export function hostZcodeDbPath(): string {
  return join(homedir(), ...ZCODE_HOST_DB_SUFFIX)
}

/**
 * zcode 隔离会话库绝对路径（`<dataDir>/engines/zcode/session-db/db.sqlite`）。
 * 与引擎侧 zcodeSessionDbPath 同布局（引擎 dataDir = TAIJI_AGENT_DATA_DIR =
 * shared getDataDir()，同一目录两侧各自推导），路径段常量同源（ZCODE_ISOLATED_DB_SEGMENTS）。
 * @param dataDir taiji 数据根（getDataDir() 产物，由调用方传入——本包不做宿主路径推导）
 */
export function zcodeIsolatedDbPath(dataDir: string): string {
  return join(dataDir, ...ZCODE_ISOLATED_DB_SEGMENTS)
}

/**
 * zcode 会话库白名单集合（封闭集合）：`[隔离库（现役）, 宿主库（仅存量兼容）]`。
 * 与引擎侧 zcodeDbPathAllowlist 同构——wire 帧 / session 数据里的 dbPath 来自
 * 不可信面，仅放行集合内精确绝对路径。集合形态（而非 `||` 列表）使未来第三个
 * 合法路径只需改本函数。
 * @param dataDir taiji 数据根（getDataDir() 产物，由调用方传入）
 */
export function zcodeImportDbAllowlist(dataDir: string): readonly string[] {
  return [zcodeIsolatedDbPath(dataDir), hostZcodeDbPath()]
}

/** schema 版本已知集（宿主 schema 0.16.5 消费面子集；版本超出即 drift 信号）。 */
export const KNOWN_ZCODE_SCHEMA_VERSIONS: readonly string[] = ['0.16.5']

/** schema 版本不认识（读 schema_migration 失败或版本超出已知集）。 */
export class ZcodeSchemaDriftError extends Error {
  /** 观测到的版本（表不可读时为 undefined——两种归因经此字段区分，不拆两个错误类）。 */
  readonly observedVersion: string | undefined
  constructor(observedVersion: string | undefined, message: string) {
    super(message)
    this.name = 'ZcodeSchemaDriftError'
    this.observedVersion = observedVersion
  }
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
 * 单会话全量转换行集的 message 行（converter 输入）。parts 元素 = part.data 已解析
 * JSON 对象本体（不包 {sequence, data} 行壳——转换器把 parts 元素直接当 part 消费，
 * 包装壳会让 part.type 全体读成 undefined；part 序即数组序 = 联合序，sequence 冗余不导出）。
 */
export interface ZcodeTranscriptMessageRow {
  id: string
  sequence: number
  data: Record<string, unknown>
  parts: Array<Record<string, unknown>>
}

/** 只读查询面：候选行 / 单会话行 / 字节聚合 / schema 版本诊断。 */
export interface ZcodeReadonlyDb {
  /**
   * 候选会话行（排除 subagent_child；time_updated 降序）。
   * limit 可选：SQL 级截断。调用方需要全量语义（query 过滤 / total / dirs 聚合与
   * pi 源同构）时不传——全表毫秒级，JS 侧再过滤后截断。
   */
  listCandidateSessions(opts?: { limit?: number }): ZcodeSessionRow[]
  /** 按原始 id 取单行（导入定位校验用）；不存在返回 undefined。 */
  getSessionRow(id: string): ZcodeSessionRow | undefined
  /**
   * 单会话全量转换行集（converter 输入）：message 按 sequence 升序，每条 message 的
   * parts 按 (message.sequence, part.sequence) 联合序排好。LEFT JOIN 保留无 part 的
   * message（parts 空数组）。data 列 JSON 解析失败抛 Error（调用方按 schema 漂移
   * 映射消费侧错误码，本层不静默跳过——整行丢失会破坏切段配对）。
   */
  getSessionTranscript(sessionId: string): ZcodeTranscriptMessageRow[]
  /**
   * 真字节口径的会话体量：SUM(length(CAST(part.data AS BLOB)))——TEXT 直接
   * length() 返回字符数，CJK 内容会低估；GROUP BY session_id。无 part 的会话不在
   * 返回 Map 中（调用方按 0 处理）。
   */
  candidatesByteSize(sessionIds: readonly string[]): Map<string, number>
  /** best-effort 读 schema_migration 版本（诊断用，失败返回 undefined）。 */
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
 * Error（上下文带表与行标识）——不在本层静默跳过（整行丢失会破坏切段配对），
 * 上游按 schema 漂移映射消费侧错误。
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
      // subagent_child（内部子任务）不进候选域；task_type 有索引
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
      // 联合序（runtime 2026-09-19 探针实测）：ORDER BY m.sequence, p.sequence
      // 与 part 自身 time.start 时序一致。LEFT JOIN 保留无 part 的 message
      //（pseq/pdata 为 NULL 的行）
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
        if (typeof r.sid !== 'string') continue
        // RT-5#10：bytes 非 number（SUM 对全 NULL part.data 的组返回 NULL 等）不静默
        // 丢弃——warn 留痕；消费端以 null 语义呈现「大小未知」，不回填 0 B 假数据
        if (typeof r.bytes !== 'number') {
          console.warn(
            `[zcode-session-source] candidatesByteSize 行 bytes 非 number（实际 ${typeof r.bytes}），该会话大小未知：sessionId=${r.sid}`,
          )
          continue
        }
        sizes.set(r.sid, r.bytes)
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
        void err
      }
    },
  }
}

/**
 * schema 版本已知集闸门：读 schema_migration 最新版本，超出 KNOWN_ZCODE_SCHEMA_
 * VERSIONS（或表不可读）→ ZcodeSchemaDriftError（observedVersion 区分「有版本但不
 * 认识」与「表不可读」两种归因）。检查通过静默返回。
 */
export function assertKnownSchema(db: SqliteDb): void {
  let observedVersion: string | undefined
  try {
    const row = db.prepare('SELECT app_version FROM schema_migration ORDER BY time_applied DESC LIMIT 1').get()
    if (typeof row === 'object' && row !== null) {
      const v = (row as Record<string, unknown>).app_version
      if (typeof v === 'string' && v.length > 0) observedVersion = v
    }
  } catch {
    throw new ZcodeSchemaDriftError(
      undefined,
      `zcode session db schema_migration unreadable (expected one of: ${KNOWN_ZCODE_SCHEMA_VERSIONS.join('/')})`,
    )
  }
  if (observedVersion === undefined || !KNOWN_ZCODE_SCHEMA_VERSIONS.includes(observedVersion)) {
    throw new ZcodeSchemaDriftError(
      observedVersion,
      `zcode session db schema version unknown: ${observedVersion ?? '(absent)'} ` +
        `(known: ${KNOWN_ZCODE_SCHEMA_VERSIONS.join('/')})`,
    )
  }
}

/** openZcodeSessionDb 产物：查询面 + 实际命中的阶梯级别 + 统一收尾。 */
export interface ZcodeSessionDbHandle {
  db: ZcodeReadonlyDb
  /** 实际命中的四级恢复阶梯级别（恢复成功非静默事件：调用方记结构化日志）。 */
  via: RecoveryLevel
  /** 幂等收尾：close + L3 快照目录清理。finally 必调。 */
  dispose: () => void
}

/**
 * 打开 zcode 会话库只读连接（编排入口：存在性检查 → 四级恢复阶梯 → schema 已知集
 * 闸门）。dbPath 不存在直接抛 Error（调用方映射「库不存在」语义）；阶梯耗尽抛
 * SqliteUnreadableError（attempted 含已尝试级别）；schema 超出已知集抛
 * ZcodeSchemaDriftError。其余查询期错误原样上抛（驱动错误 / data 列 JSON 非法等），
 * 调用方按消费侧错误规格映射。
 */
export async function openZcodeSessionDb(dbPath: string): Promise<ZcodeSessionDbHandle> {
  if (!existsSync(dbPath)) {
    throw new Error(`db 文件不存在：${dbPath}`)
  }
  const opened = await openWithRecovery(dbPath)
  try {
    assertKnownSchema(opened.db)
  } catch (err) {
    opened.dispose()
    throw err
  }
  return { db: wrapDb(opened.db), via: opened.via, dispose: opened.dispose }
}
