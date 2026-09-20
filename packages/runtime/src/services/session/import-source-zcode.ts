/**
 * ZcodeImportSource —— zcode 源（kind='zcode'）：宿主库 sqlite 只读的候选列表 +
 * 导入定位（session-import-unified 设计 §3.3/§3.7）。sqlite 访问机制全部下沉
 * zcode-import/sqlite-access.ts，本文件只做源行为（字段映射/匹配域/错误映射）。
 *
 * 候选列表语义（§3.7 全表）：sessionId = 原始 session.id（源系统主键，`sess_` 前缀
 * 形态）；alreadyImported 打标先把原始 id 经 T1 归一化再与扫描集（header.id 域）比对；
 * query 匹配 = name ∪ sessionId ∪ directory ∪ dirLabel（sourcePath 是 db 路径结构占位，
 * 不参与匹配）；size = part.data 真字节聚合（仅返回页 ≤limit 逐条，§3.8）；dirs 按
 * dirLabel（basename(directory)）聚合自过滤前全集（与 pi 源同构）。
 *
 * 错误映射（§3.6）：db 不存在/不可打开 → import_source_missing；查询失败（schema
 * 漂移）→ import_invalid_session（message 带 schema_migration 版本，best-effort）；
 * sessionId 不存在 / 归一化后置条件不满足 → import_invalid_session。
 */

import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ImportCandidate, ImportCandidatesReply, ImportCandidatesRequest, ImportRequest } from '@taiji/shared'
import { toErrorMessage } from '../../utils/errors.js'
import { scanPiSessions } from '../../infra/pi/session-file-utils.js'
import { ImportServiceError, type ImportArtifact, type SessionImportSource } from './import-source.js'
import { normalizeZcodeSessionId, zcodeCandidateKey } from './zcode-import/normalize.js'
import {
  openZcodeReadonlyDb,
  type ZcodeReadonlyDb,
  type ZcodeSessionRow,
} from './zcode-import/sqlite-access.js'
import { convertZcodeSession, type ZcodeConversionOutput } from './zcode-import/converter.js'

/** items 截断默认值（与 pi 源一致，D5：limit 缺省 100）。 */
const DEFAULT_CANDIDATE_LIMIT = 100

/** source 构造依赖（与 pi 源的 getRootDir 同注入模式）：宿主库默认路径动态推导。 */
export interface ZcodeImportSourceDeps {
  /** listCandidates/prepareImport 的 dbPath 参数缺省时每次调用惰性求值（组合根注入 hostZcodeDbPath）。 */
  getHostDbPath: () => string
}

/** query 匹配语义（§3.7 zcode 行为）：name ∪ sessionId ∪ directory ∪ dirLabel，case-insensitive includes。 */
function matchesQuery(item: Pick<ImportCandidate, 'name' | 'sessionId' | 'cwd' | 'dirLabel'>, query: string): boolean {
  return [item.name ?? '', item.sessionId, item.cwd, item.dirLabel].some((field) => field.toLowerCase().includes(query))
}

/** 查询失败 → import_invalid_session（§3.6 ②：schema 漂移，错误信息携带 schema 版本如可得）。 */
function queryFailed(db: ZcodeReadonlyDb, e: unknown): ImportServiceError {
  const version = db.readSchemaVersion()
  return new ImportServiceError(
    'import_invalid_session',
    `读取 zcode 会话库失败${version ? `（zcode schema 版本 ${version}）` : ''}：${toErrorMessage(e)}。疑似 zcode 升级导致库结构变化，请升级太极后重试`,
  )
}

/** zcode 源：宿主库（或 dbPath 注入的 fixture 库）只读候选列表 + 导入定位。 */
export class ZcodeImportSource implements SessionImportSource {
  readonly kind = 'zcode' as const

  constructor(private deps: ZcodeImportSourceDeps) {}

  async listCandidates(request: ImportCandidatesRequest): Promise<ImportCandidatesReply> {
    // 库定位：候选列表契约（ImportCandidatesRequest）无 dbPath 字段（§3.7——dbPath 只在
    // ImportRequest），默认根 = 构造注入的宿主库路径（组合根传 hostZcodeDbPath，测试传
    // fixture 库路径——与 pi 源 getRootDir 同注入模式）
    const dbPath = this.deps.getHostDbPath()

    // 打开失败（不存在/不可打开）→ import_source_missing（§3.6 行 1 恢复指引：确认已安装）
    let db: ZcodeReadonlyDb
    try {
      db = await openZcodeReadonlyDb(dbPath)
    } catch (e) {
      throw new ImportServiceError(
        'import_source_missing',
        `未找到或无法打开 zcode 会话库（${dbPath}，${toErrorMessage(e)}）。请确认已安装 zcode 并至少运行过一次会话`,
      )
    }

    // 全量候选行（不 SQL 截断）：query 过滤 / total / dirs 聚合需全集，与 pi 源语义同构
    //（SQL LIMIT 后再过滤会漏掉 N 页之外的搜索命中）；全表 4k 行毫秒级（§3.8）
    let rows: ZcodeSessionRow[]
    try {
      rows = db.listCandidateSessions()
    } catch (e) {
      throw queryFailed(db, e)
    } finally {
      db.close()
    }

    // alreadyImported 归一化域（§3.7）：扫描集是 header.id 域 = 归一化域，原始 sess_ 形态
    // 直接比对会失配；默认 TTL 读（列表展示允许秒级 stale，force 双检在编排层互斥区内）
    const importedIds = new Set(scanPiSessions().map((s) => s.id))
    /**
     * 单行打标降级：id 归一化后置条件不满足（形态超出已验证域）时按未导入处理 + warn
     * 留痕，不让单行坏 id 让整表不可用——列表是展示面，幂等真校验在编排层互斥区内
     * force 双检；同条件的 fail-fast 语义保留在 prepareImport 的 T1 校验（导入路径）不动。
     */
    const isAlreadyImported = (row: ZcodeSessionRow): boolean => {
      try {
        return importedIds.has(zcodeCandidateKey(row.id))
      } catch (e) {
        console.warn(`[runtime] zcode 候选 alreadyImported 打标降级（按未导入处理）：sessionId=${row.id}，${toErrorMessage(e)}`)
        return false
      }
    }
    const toCandidate = (row: ZcodeSessionRow): ImportCandidate => ({
      sessionId: row.id,
      name: row.title,
      cwd: row.directory,
      sourcePath: dbPath,
      lastModified: row.timeUpdated,
      size: 0, // 占位，返回页确定后统一回填（§3.8：字节聚合仅对返回页逐条）
      dirLabel: basename(row.directory),
      alreadyImported: isAlreadyImported(row),
      cwdExists: existsSync(row.directory),
    })

    const all = rows.map(toCandidate)
    const total = all.length

    const query = (request.query ?? '').trim().toLowerCase()
    const filtered = query ? all.filter((item) => matchesQuery(item, query)) : all
    const limit = request.limit && request.limit > 0 ? request.limit : DEFAULT_CANDIDATE_LIMIT
    const items = filtered.slice(0, limit)

    // size 真字节口径（§3.7）：仅对返回页（≤limit）逐条聚合，无 part 的会话记 0
    const byteSizes = await this.byteSizesOf(dbPath, items.map((i) => i.sessionId))
    for (const item of items) {
      item.size = byteSizes.get(item.sessionId) ?? 0
    }

    // dirs：按 dirLabel 聚合自过滤前全集（chip 下拉，与搜索是两个独立操作——pi 源同构）
    const dirCounts = new Map<string, number>()
    for (const row of rows) {
      const label = basename(row.directory)
      dirCounts.set(label, (dirCounts.get(label) ?? 0) + 1)
    }
    const dirs = [...dirCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, count]) => ({ label, count }))

    return { total, items, dirs }
  }

  /** 返回页字节聚合（独立连接：候选行查询连接已关，聚合再开短连接；错误按查询失败映射）。 */
  private async byteSizesOf(dbPath: string, sessionIds: string[]): Promise<Map<string, number>> {
    if (sessionIds.length === 0) return new Map()
    let db: ZcodeReadonlyDb
    try {
      db = await openZcodeReadonlyDb(dbPath)
    } catch (e) {
      throw new ImportServiceError(
        'import_source_missing',
        `未找到或无法打开 zcode 会话库（${dbPath}，${toErrorMessage(e)}）。请确认已安装 zcode 并至少运行过一次会话`,
      )
    }
    try {
      return db.candidatesByteSize(sessionIds)
    } catch (e) {
      throw queryFailed(db, e)
    } finally {
      db.close()
    }
  }

  /**
   * 校验源可达 + session 行存在 + 产出 T1 header/fileName + 转换产物（U4）。
   *
   * write 相位分离（§3.6 错误规格）：转换（读库 + 纯转换）失败 → import_source_missing
   * （db 消失）/ import_invalid_session（查询/JSON 解析失败即 schema 漂移域，含版本诊断）；
   * 落盘 writeFile 失败原样上抛 → 编排层统一映射 import_copy_failed（磁盘满等）。
   *
   * degradations 是 artifact 级可变数组：编排层在 write 完成后才读它聚合
   * warning='conversion_degraded'（import-service doImport 步骤 8），故转换明细在
   * write 闭包内 push 进同一数组引用，而非 prepareImport 返回时静态填好。
   */
  async prepareImport(request: ImportRequest): Promise<ImportArtifact> {
    const sessionId = request.sessionId
    if (!sessionId) {
      throw new ImportServiceError('import_invalid_session', 'zcode 源导入必须携带 sessionId（原始 sess_ 前缀形态）')
    }
    const dbPath = request.dbPath ?? this.deps.getHostDbPath()

    let db: ZcodeReadonlyDb
    try {
      db = await openZcodeReadonlyDb(dbPath)
    } catch (e) {
      throw new ImportServiceError(
        'import_source_missing',
        `未找到或无法打开 zcode 会话库（${dbPath}，${toErrorMessage(e)}）。请确认已安装 zcode 并至少运行过一次会话`,
      )
    }
    let row: ZcodeSessionRow | undefined
    try {
      row = db.getSessionRow(sessionId)
    } catch (e) {
      throw queryFailed(db, e)
    } finally {
      db.close()
    }
    if (!row) {
      // stale 列表/库被清理（§3.6 ①）：刷新列表重选
      throw new ImportServiceError('import_invalid_session', `该会话已不在 zcode 库中（sessionId=${sessionId}），请刷新列表后重选`)
    }

    // T1：归一化 id = 幂等键（后置条件不满足在此 fail-fast，不进 write 阶段）
    const normalizedId = normalizeZcodeSessionId(sessionId)
    const timestamp = new Date(row.timeCreated).toISOString()
    const header = { id: normalizedId, timestamp, cwd: row.directory }

    // artifact 级降级明细（转换期 push，编排层 write 后读取聚合 warning）
    const degradations: string[] = []

    return {
      header,
      // 文件名不变量（§3.4 T1）：ISO 段（: → .）与归一化 id 均不含 `_`，文件名唯一 `_`
      // 即分隔符——剥 .jsonl 后尾段 === header.id 严格成立
      fileName: `${timestamp.replaceAll(':', '.')}_${normalizedId}.jsonl`,
      write: async (tmpPath) => {
        // 转换相位：惰性开只读连接（prepareImport 校验连接已关；去重拒绝路径 write 不被
        // 调用，不持有连接），完成/失败都在 finally 内关闭
        let out: ZcodeConversionOutput
        let writeDb: ZcodeReadonlyDb
        try {
          writeDb = await openZcodeReadonlyDb(dbPath)
        } catch (e) {
          throw new ImportServiceError(
            'import_source_missing',
            `未找到或无法打开 zcode 会话库（${dbPath}，${toErrorMessage(e)}）。请确认已安装 zcode 并至少运行过一次会话`,
          )
        }
        try {
          out = convertZcodeSession(writeDb, sessionId, header)
        } catch (e) {
          // converter 语义化错误（会话消失）原样透传；查询/JSON 失败按 schema 漂移映射
          throw e instanceof ImportServiceError ? e : queryFailed(writeDb, e)
        } finally {
          writeDb.close()
        }
        degradations.push(...out.degradations)
        // 落盘相位（§3.6 import_copy_failed 域）：失败原样上抛给编排层统一映射 + 清理 tmp
        await writeFile(tmpPath, out.content, 'utf8')
      },
      degradations,
    }
  }
}
