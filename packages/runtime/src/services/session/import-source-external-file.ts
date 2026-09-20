/**
 * ExternalFileImportSource —— pi 源（kind='pi'）：外部 session JSONL 目录/文件扫描源
 * （session-import-unified 设计 §3.3）。类名取「external」与 scanExternalSessions /
 * ExternalSessionMeta 同命名域（太极 sessions 目录之外的外部会话文件源）；「Pi」前缀
 * 标识符按 C-comm-02 只许 infra/pi 内部，services 层不使用。
 *
 * 现状 import-service（单源期）的 pi 特有逻辑原样搬入（行为零变化）：
 * - listCandidates：scanExternalSessions 默认 TTL 读 + alreadyImported/cwdExists 打标 +
 *   query 过滤（五字段 includes）+ dirLabel 目录聚合 + 「根存在但不可读」复核
 * - prepareImport：首行异步读（r4-S2）+ parseHeaderFromFirstLine 字段清单校验（D1）+
 *   文件名临时标记拒绝（r2-S1）；write = copyFile（字节级复制，大文件不重序列化），
 *   degradations 恒空数组（无转换即无降级）
 *
 * 源无关流程（互斥/去重双检/落盘原子性/sidecar/tombstone/缓存失效）不在此处——
 * 见编排层 import-service.ts。
 */

import { existsSync } from 'node:fs'
import { copyFile, open, readdir } from 'node:fs/promises'
import { basename, dirname, relative } from 'node:path'
import type {
  ImportCandidate,
  ImportCandidatesReply,
  ImportCandidatesRequest,
  ImportRequest,
} from '@taiji/shared'
import { toErrorMessage } from '../../utils/errors.js'
import {
  scanExternalSessions,
  parseHeaderFromFirstLine,
  type ExternalSessionMeta,
} from '../../infra/pi/session-file-external-scan.js'
import { scanPiSessions, TMP_RESIDUE_MARKERS } from '../../infra/pi/session-file-utils.js'
import { ImportServiceError, type ImportArtifact, type ImportSourceDeps, type SessionImportSource } from './import-source.js'

/** items 截断默认值（D5：limit 缺省 100）。 */
const DEFAULT_CANDIDATE_LIMIT = 100

/** uuid 短 ID 匹配长度（D5：uuid 前 6 位短 ID，与 30 字符 UI 惯例无关）。 */
const SHORT_ID_LENGTH = 6

/** header 首行读块大小（与 session-file-utils 的 parseSessionHeader 同策略：4KB 覆盖正常 header）。 */
const HEADER_CHUNK_BYTES = 4096

/**
 * dirLabel：候选文件相对 rootDir 的所属目录（D5：目录 chip 分组用）。顶层文件为 ''（非
 * 「一层子目录」，不入 dirs 聚合）；扫描深度 = 顶层 + 一层子目录（scanExternalSessions
 * 同构假设），故结果只会是 '' 或单层子目录名。
 */
function dirLabelOf(rootDir: string, filePath: string): string {
  return relative(rootDir, dirname(filePath))
}

/** query 匹配语义（D5/S7）：name ∪ 完整 sessionId ∪ 前 6 位短 ID ∪ sourcePath ∪ dirLabel，case-insensitive includes。 */
function matchesQuery(item: ImportCandidate, query: string): boolean {
  return [item.name ?? '', item.sessionId, item.sessionId.slice(0, SHORT_ID_LENGTH), item.sourcePath, item.dirLabel].some(
    (field) => field.toLowerCase().includes(query),
  )
}

/**
 * 异步读 JSONL 首行（r4-S2：不沿用 sync 原语，NFS 源的 sync 读会阻塞事件循环）。
 *
 * 与 parseSessionHeader 同策略：先读 4KB 块取首行；块内无换行且未读满（文件本身小于块）
 * 按无首行终止处理；块读满仍无换行（首行超长）继续续读——等价于回退全量读首行的语义。
 * 空文件返回 null。
 *
 * 跨块解码（r1-S2）：块以 Buffer 累积、检测换行时 Buffer.concat 后整体 toString——
 * 逐块 toString 会在多字节 UTF-8 字符（CJK）跨 4KB 块边界时拆出 U+FFFD，长中文路径的
 * header 首行会被静默损坏。
 */
async function readFirstLineAsync(filePath: string): Promise<string | null> {
  const fh = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(HEADER_CHUNK_BYTES)
    const chunks: Buffer[] = []
    for (;;) {
      const { bytesRead } = await fh.read(buffer, 0, HEADER_CHUNK_BYTES, null)
      if (bytesRead === 0) {
        return chunks.length > 0 ? Buffer.concat(chunks).toString('utf-8') : null
      }
      // 换行先在原始 Buffer 上定位（r5-S4：避免逐块 Buffer.concat 的 O(n²) 复制——超长首行
      // 续读多轮时，每轮 concat 全量重组）；换行前内容才入 chunks，最终一次性 concat 解码。
      const nl = buffer.subarray(0, bytesRead).indexOf('\n'.charCodeAt(0))
      if (nl >= 0) {
        chunks.push(Buffer.from(buffer.subarray(0, nl)))
        return Buffer.concat(chunks).toString('utf-8')
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
      if (bytesRead < HEADER_CHUNK_BYTES) {
        return chunks.length > 0 ? Buffer.concat(chunks).toString('utf-8') : null
      }
    }
  } finally {
    await fh.close()
  }
}

// header 解析（parseHeaderFromFirstLine）直接消费 session-file-external-scan 导出的同一函数
//（D1 字段清单 SSOT 单副本）：含 null/非 object 运行时守卫，null 首行（TOCTOU 源文件被
// 替换）与畸形 JSON 一律返回 null → import_invalid_session，不逃逸原始 TypeError。
// 本源只消费 id/cwd，timestamp 是外部扫描侧的对齐保留字段。

/** pi 源（外部 session JSONL 目录扫描；行为 = 单源期 import-service 的 pi 分支原样搬运，零变化）。 */
export class ExternalFileImportSource implements SessionImportSource {
  readonly kind = 'pi' as const

  constructor(private deps: ImportSourceDeps) {}

  /**
   * 候选列表（D5）：rootDir 缺省 = deps.getRootDir() 惰性求值（组合根经 getPiGlobalAgentDir
   * 动态推导装配，禁止硬编码字面量——services 层不 import pi-maintenance，C-comm-03）。
   * alreadyImported 用默认 TTL 读打标（D5：列表展示允许秒级 stale；真正的幂等校验在
   * 编排层 importSession 互斥区内 force 双检）。
   */
  async listCandidates(request: ImportCandidatesRequest): Promise<ImportCandidatesReply> {
    const rootDir = request.rootDir ?? this.deps.getRootDir()
    const { items: scanned } = await scanExternalSessions(rootDir)
    // 区分「根存在但不可读」（import_dir_unreadable）与「根不存在/为空」（容忍，返回空列表
    // ——scanExternalSessions 统一容错返回 []，此处仅在根存在且结果为空时做可读性复核）
    if (scanned.length === 0 && existsSync(rootDir)) {
      try {
        await readdir(rootDir)
      } catch (e) {
        throw new ImportServiceError('import_dir_unreadable', `无法读取该目录：${rootDir}（${toErrorMessage(e)}）`)
      }
    }

    const importedIds = new Set(scanPiSessions().map((s) => s.id))
    const all: ImportCandidate[] = scanned.map((m) => this.toCandidate(rootDir, m, importedIds))
    const total = all.length

    const query = (request.query ?? '').trim().toLowerCase()
    const filtered = query ? all.filter((item) => matchesQuery(item, query)) : all
    const limit = request.limit && request.limit > 0 ? request.limit : DEFAULT_CANDIDATE_LIMIT

    // dirs：该根下全部一层子目录（chip 下拉），聚合自过滤前全集（切目录与搜索是两个独立操作）
    const dirCounts = new Map<string, number>()
    for (const m of scanned) {
      const label = dirLabelOf(rootDir, m.filePath)
      if (!label) continue
      dirCounts.set(label, (dirCounts.get(label) ?? 0) + 1)
    }
    const dirs = [...dirCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, count]) => ({ label, count }))

    return { total, items: filtered.slice(0, limit), dirs }
  }

  /** 轻量 meta（D3 二次修订）：字段集 = id/name/cwd/filePath/lastModified/size，与 toCandidate 消费面一致。 */
  private toCandidate(rootDir: string, m: ExternalSessionMeta, importedIds: Set<string>): ImportCandidate {
    return {
      sessionId: m.id,
      name: m.name,
      cwd: m.cwd,
      sourcePath: m.filePath,
      lastModified: m.lastModified,
      size: m.size,
      dirLabel: dirLabelOf(rootDir, m.filePath),
      alreadyImported: importedIds.has(m.id),
      cwdExists: existsSync(m.cwd),
    }
  }

  /**
   * 校验源可达 + 产出 artifact（单源期 doImport 第 1/2 步原样搬入）：首行异步读 +
   * header 字段清单校验 + 文件名临时标记拒绝。失败抛 ImportServiceError（code 见错误
   * 规格表）；成功返回 header/fileName + write=copyFile。
   */
  async prepareImport(request: ImportRequest): Promise<ImportArtifact> {
    const { sourcePath } = request
    const sourceName = basename(sourcePath)

    // 1. 源文件存在校验 + header 异步读（r4-S2）
    let firstLine: string | null
    try {
      firstLine = await readFirstLineAsync(sourcePath)
    } catch (e) {
      throw new ImportServiceError('import_source_missing', `文件不存在或不可读：${sourcePath}（${toErrorMessage(e)}）`)
    }
    if (firstLine === null) {
      throw new ImportServiceError('import_invalid_session', `不是有效的 pi session 文件（首行缺少合法 session header）：${sourcePath}`)
    }
    const header = parseHeaderFromFirstLine(firstLine)
    if (!header) {
      throw new ImportServiceError('import_invalid_session', `不是有效的 pi session 文件（首行缺少合法 session header）：${sourcePath}`)
    }

    // 2. 文件名标记校验（r2-S1）：导入落地后会被自家扫描过滤器挡成 limbo，前置拒绝。
    //    直接消费 session-file-utils 导出的 TMP_RESIDUE_MARKERS 同一常量（扫描器过滤与
    //    导入拒绝覆盖同一集合，双副本漂移面消灭）。
    if (TMP_RESIDUE_MARKERS.some((marker) => sourceName.includes(marker))) {
      throw new ImportServiceError('import_marker_filename', `文件名包含临时标记，疑似迁移残留副本：${sourceName}`)
    }

    return {
      header: { id: header.id, timestamp: header.timestamp, cwd: header.cwd },
      fileName: sourceName,
      // copyFile 保持字节级复制（大文件不重序列化）；失败抛错由编排层转 import_copy_failed
      write: (tmpPath) => copyFile(sourcePath, tmpPath),
      // pi 源无转换（纯复制）即无降级（degradations 是 zcode→pi 转换的知情降级通道）
      degradations: [],
    }
  }
}
