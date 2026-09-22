/**
 * ZcodeImportSource —— zcode 源（kind='zcode'）薄包装：宿主库 sqlite 只读的候选列表 +
 * 导入定位（session-import-unified 设计 §3.3/§3.7；session-reader-shared-core 设计 §5
 * Phase 3 单元四 runtime 侧——读取/转换/驱动/恢复阶梯全部消费
 * @zhushanwen/zcode-session-source 基座，本文件只做源行为（字段映射/匹配域/错误映射/
 * 序列化装配）。编排层（import-service 的互斥/去重/原子落盘/sidecar/摘碑）零改动。
 *
 * 读取组合形态（openZcodeSessionDb + convertZcodeTranscript，非 readZcodeSession 单函数），
 * 三个理由：① 错误映射需要相位分离（§3.6：开库失败 → import_source_missing、查询/转换
 * 失败 → import_invalid_session——readZcodeSession 把两相位折叠成一个普通 Error 面）；
 * ② header.cwd 来源是库行 directory（readZcodeSession 返回的 canonical header 无 cwd——
 * zcode 会话无 cwd 概念不伪造，D1；导入落地的 cwd 决定子目录，必须真值）；③ 恢复阶梯
 * 命中级别（handle.via）按契约记结构化日志（恢复成功非静默事件）。
 *
 * 候选列表语义（§3.7 全表）：sessionId = 原始 session.id（源系统主键，`sess_` 前缀
 * 形态）；alreadyImported 打标先把原始 id 经 T1 归一化再与扫描集（header.id 域）比对；
 * query 匹配 = name ∪ sessionId ∪ directory ∪ dirLabel（sourcePath 是 db 路径结构占位，
 * 不参与匹配）；size = part.data 真字节聚合（仅返回页 ≤limit 逐条，§3.8）；dirs 按
 * dirLabel（basename(directory)）聚合自过滤前全集（与 pi 源同构）。
 *
 * 错误映射（§3.6，source 包错误面归消费侧——§1.5 契约④，本侧用既有 import_* 词表）：
 * db 不存在/不可打开 → import_source_missing；schema 版本超出已知集（ZcodeSchemaDriftError，
 * observedVersion 带观测版本）→ import_invalid_session（message 带版本诊断）；查询失败
 * （schema 已知域内的驱动/JSON 错误）→ import_invalid_session；sessionId 不存在 / 归一化
 * 后置条件不满足 → import_invalid_session。
 */

import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ImportCandidate, ImportCandidatesReply, ImportCandidatesRequest, ImportDegradation, ImportRequest } from '@taiji/shared'
import { serializeSession, type NormalizedSession } from '@zhushanwen/session-core'
import {
  convertZcodeTranscript,
  normalizeZcodeSessionId,
  openZcodeSessionDb,
  zcodeCandidateKey,
  ZcodeSchemaDriftError,
  type RecoveryLevel,
  type ZcodeReadonlyDb,
  type ZcodeSessionRow,
} from '@zhushanwen/zcode-session-source'
import { toErrorMessage } from '../../utils/errors.js'
import { scanPiSessions } from '../../infra/pi/session-file-utils.js'
import { ImportServiceError, type ImportArtifact, type SessionImportSource } from './import-source.js'

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

/**
 * 恢复阶梯命中非直开级别时记结构化日志（恢复成功非静默事件——ZcodeSessionDbHandle.via
 * 契约；node 宿主直开恒 L1-direct（runtime 侧 F24），L2/L3 命中即异常信号，必须留痕）。
 */
function logRecoveryLevel(via: RecoveryLevel, dbPath: string): void {
  if (via !== 'L1-direct') {
    console.warn(`[runtime] zcode 会话库经恢复阶梯打开（level=${via}）：${dbPath}`)
  }
}

/**
 * schema 版本超出已知集 → import_invalid_session（§3.6 ②：schema 漂移域，错误信息携带
 * 观测版本如可得——ZcodeSchemaDriftError.observedVersion，表不可读时为 undefined）。
 */
function schemaDrifted(e: ZcodeSchemaDriftError): ImportServiceError {
  return new ImportServiceError(
    'import_invalid_session',
    `读取 zcode 会话库失败${e.observedVersion ? `（zcode schema 版本 ${e.observedVersion}）` : ''}：${toErrorMessage(e)}。疑似 zcode 升级导致库结构变化，请升级太极后重试`,
  )
}

/**
 * 开库相位失败映射（§3.6 行 1）：schema 漂移 → import_invalid_session；其余（db 不存在/
 * 权限/锁/驱动不可用/恢复阶梯耗尽）→ import_source_missing（恢复指引：确认已安装）。
 */
function openFailed(e: unknown, dbPath: string): ImportServiceError {
  if (e instanceof ZcodeSchemaDriftError) return schemaDrifted(e)
  return new ImportServiceError(
    'import_source_missing',
    `未找到或无法打开 zcode 会话库（${dbPath}，${toErrorMessage(e)}）。请确认已安装 zcode 并至少运行过一次会话`,
  )
}

/** 查询相位失败 → import_invalid_session（§3.6 ②：schema 已知域内的驱动/JSON 解析失败即漂移域）。 */
function queryFailed(e: unknown): ImportServiceError {
  if (e instanceof ZcodeSchemaDriftError) return schemaDrifted(e)
  return new ImportServiceError(
    'import_invalid_session',
    `读取 zcode 会话库失败：${toErrorMessage(e)}。疑似 zcode 升级导致库结构变化，请升级太极后重试`,
  )
}

/** openDb 产物：查询面 + 幂等收尾（close + L3 快照目录清理——finally 必调 dispose）。 */
interface OpenedZcodeDb {
  db: ZcodeReadonlyDb
  dispose: () => void
}

/** 打开只读连接（统一入口：存在性 → 四级恢复阶梯 → schema 已知集闸门）+ 阶梯日志。 */
async function openDb(dbPath: string): Promise<OpenedZcodeDb> {
  const handle = await openZcodeSessionDb(dbPath).catch((e: unknown) => {
    throw openFailed(e, dbPath)
  })
  logRecoveryLevel(handle.via, dbPath)
  // 收尾必须回传 handle.dispose（close + L3 快照目录清理，幂等）——只回传 db 会把
  // 收尾通道丢弃，阶梯落 L3 时每次导入在 tmpdir 泄漏一个 taiji-zcode-snap-* 目录
  return { db: handle.db, dispose: handle.dispose }
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
    const { db, dispose } = await openDb(dbPath)

    // 全量候选行（不 SQL 截断）：query 过滤 / total / dirs 聚合需全集，与 pi 源语义同构
    //（SQL LIMIT 后再过滤会漏掉 N 页之外的搜索命中）；全表 4k 行毫秒级（§3.8）
    let rows: ZcodeSessionRow[]
    try {
      rows = db.listCandidateSessions()
    } catch (e) {
      throw queryFailed(e)
    } finally {
      dispose()
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
    const { db, dispose } = await openDb(dbPath)
    try {
      return db.candidatesByteSize(sessionIds)
    } catch (e) {
      throw queryFailed(e)
    } finally {
      dispose()
    }
  }

  /**
   * 校验源可达 + session 行存在 + 产出 T1 header/fileName + 转换产物（canonical 转换在
   * write 闭包内）。
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

    const { db, dispose } = await openDb(dbPath)
    let row: ZcodeSessionRow | undefined
    try {
      row = db.getSessionRow(sessionId)
    } catch (e) {
      throw queryFailed(e)
    } finally {
      dispose()
    }
    if (!row) {
      // stale 列表/库被清理（§3.6 ①）：刷新列表重选
      throw new ImportServiceError('import_invalid_session', `该会话已不在 zcode 库中（sessionId=${sessionId}），请刷新列表后重选`)
    }

    // T1：归一化 id = 幂等键（后置条件不满足在此 fail-fast，不进 write 阶段）。
    // normalizeZcodeSessionId 错误面归消费侧（§1.5 契约④）：source 包抛普通 Error
    //（message 含原始 id 与恢复动作），本侧映射既有 import_invalid_session 词表。
    let normalizedId: string
    try {
      normalizedId = normalizeZcodeSessionId(sessionId)
    } catch (e) {
      throw new ImportServiceError('import_invalid_session', toErrorMessage(e))
    }
    const timestamp = new Date(row.timeCreated).toISOString()
    const header = { id: normalizedId, timestamp, cwd: row.directory }

    // artifact 级降级明细（转换期 push，编排层 write 后读取聚合 warning）
    const degradations: ImportDegradation[] = []

    return {
      header,
      // 文件名不变量（§3.4 T1）：ISO 段（: → .）与归一化 id 均不含 `_`，文件名唯一 `_`
      // 即分隔符——剥 .jsonl 后尾段 === header.id 严格成立
      fileName: `${timestamp.replaceAll(':', '.')}_${normalizedId}.jsonl`,
      write: async (tmpPath) => {
        // 转换相位：惰性开只读连接（prepareImport 校验连接已关；去重拒绝路径 write 不被
        // 调用，不持有连接），完成/失败都在 finally 内 dispose（含 L3 快照目录清理）
        let out: NormalizedSession
        let writeHandle: OpenedZcodeDb
        try {
          writeHandle = await openDb(dbPath)
        } catch (e) {
          throw e instanceof ImportServiceError ? e : openFailed(e, dbPath)
        }
        try {
          // 行存在性写入阶段复查（prepareImport 校验与会话写入间的竞态窗口，§3.6 ①）
          const writeRow = writeHandle.db.getSessionRow(sessionId)
          if (!writeRow) {
            throw new ImportServiceError(
              'import_invalid_session',
              `该会话已不在 zcode 库中（sessionId=${sessionId}，写入阶段复查不存在），请刷新列表后重选`,
            )
          }
          out = convertZcodeTranscript(writeHandle.db.getSessionTranscript(sessionId), {
            id: sessionId,
            title: writeRow.title,
            timeCreated: writeRow.timeCreated,
          })
        } catch (e) {
          // 语义化错误（会话消失）原样透传；查询/JSON 失败按 schema 漂移映射
          throw e instanceof ImportServiceError ? e : queryFailed(e)
        } finally {
          writeHandle.dispose()
        }
        degradations.push(...out.degradations)
        // 序列化装配（首行 header 行不在 source 包产出——canonical 序列化契约）：
        // 首行 = {type:'session', version:3, ...header}（与 pi CURRENT_SESSION_VERSION
        // 及既有导入产物逐字节同形，键序含在字面量形态内），其后每行一个 canonical
        // entry（serializeSession：JSON.stringify(entry) + '\n'，键序责任在 Entry
        // 构造方——converter emitEntry 按 {type,id,parentId,timestamp,...payload} 构造）。
        const headerLine = JSON.stringify({ type: 'session', version: 3, ...header })
        // 落盘相位（§3.6 import_copy_failed 域）：失败原样上抛给编排层统一映射 + 清理 tmp
        await writeFile(tmpPath, `${headerLine}\n${serializeSession(out.entries)}`, 'utf8')
      },
      degradations,
    }
  }
}
