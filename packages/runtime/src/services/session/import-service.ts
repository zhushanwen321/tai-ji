/**
 * ImportService — 外部 pi 会话导入（import-session 设计 docs/design/import-session.md（已删除，git 可追溯）§3.3 U2）。
 *
 * 两个领域动作（D5 契约，类型来自 @xyz-agent/shared 的 import-session 模块）：
 * - listCandidates：外部根候选列表（scanExternalSessions 默认 TTL 读 + alreadyImported/cwdExists
 *   打标 + query 过滤 + dirLabel 目录聚合）
 * - importSession：执行导入（原子复制 + 写 project sidecar）。
 *
 * 导入执行流（D1/D4 权威）：全局单条互斥（模块级 Promise 链）→ 互斥区内依次：源文件存在
 * 校验（header 异步读，r4-S2）→ header 字段清单校验 → 文件名标记校验（r2-S1）→ 去重双检
 *（id-first：force 集合命中 → import_already_imported；仅 target 命中 → import_target_conflict）
 * → projectId 存在性校验 → mkdir(recursive) → tmp+rename 原子复制（失败主动清理临时名，
 * 正式名从未落地 → 重试不被去重拦截）→ persistProjectBinding + readback（吞错 best-effort
 * 语义，不符 → warning 降级不回滚，r2-S2）→ 缓存失效。broadcast 由调用方（u3 handler）负责。
 *
 * 互斥不设超时（r4-S2 显式接受）：copyFile 不可真取消，超时释放会重开本互斥要消灭的并发
 * 窗口；挂起时仅导入功能阻塞，candidates/聊天/扫描不经互斥不受影响。
 */

import { existsSync } from 'node:fs'
import { copyFile, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve as pathResolve } from 'node:path'
import type {
  ImportCandidate,
  ImportCandidatesReply,
  ImportCandidatesRequest,
  ImportErrorCode,
  ImportReply,
  ImportRequest,
} from '@xyz-agent/shared'
import { toErrorMessage } from '../../utils/errors.js'
import { encodeCwd, getSessionsDir } from '../../infra/pi/pi-paths.js'
// B5（memory-leak-remediation §3.2-B5 摘碑双路径②）：import 同 id 复活后摘除 sessionData
// tombstone——doImport 纯文件级不投 didCreate，主线程无创建收敛点可依赖，落地即显式摘碑。
import { clearSessionDataTombstone } from '../plugin-service/session-data-store.js'
import { scanExternalSessions, parseHeaderFromFirstLine, type ExternalSessionMeta } from '../../infra/pi/session-file-external-scan.js'
import {
  invalidateScanDirCache,
  persistProjectBinding,
  readProjectBinding,
  scanPiSessions,
  TMP_RESIDUE_MARKERS,
} from '../../infra/pi/session-file-utils.js'

/** 导入领域错误：handler（u3）按 code 转 error envelope（同 GitError 模式）。 */
export class ImportServiceError extends Error {
  readonly code: ImportErrorCode
  constructor(code: ImportErrorCode, message: string) {
    super(message)
    this.name = 'ImportServiceError'
    this.code = code
  }
}

/** projectId 存在性校验的最小依赖面（结构化接口：组合根传 ProjectStore，测试可注入 stub）。 */
export interface ImportProjectSource {
  load(): { projects: ReadonlyArray<{ id: string }>; activeProjectId: string }
}

export interface ImportServiceDeps {
  projects: ImportProjectSource
  /**
   * 默认外部根求值（C-comm-03 构造注入）：listCandidates 的 rootDir 参数缺省时每次调用
   * 惰性求值。组合根（index.ts 合法 import infra）经 getPiGlobalAgentDir 装配——services
   * 层禁止 value import pi-maintenance，本服务只感知「默认根怎么取」不感知 pi 目录推导。
   */
  getRootDir: () => string
}

/** items 截断默认值（D5：limit 缺省 100）。 */
const DEFAULT_CANDIDATE_LIMIT = 100

/** uuid 短 ID 匹配长度（D5：uuid 前 6 位短 ID，与 30 字符 UI 惯例无关）。 */
const SHORT_ID_LENGTH = 6

/** header 首行读块大小（与 session-file-utils 的 parseSessionHeader 同策略：4KB 覆盖正常 header）。 */
const HEADER_CHUNK_BYTES = 4096

/** 本服务写入的临时名标记（与 session-file-utils 的 TMP_RESIDUE_MARKERS 同族，r2-S1）。 */
const TMP_IMPORT_MARKER = '.tmp-import-'

/**
 * 文件名标记拒绝家族（r2-S1；r1-S5 收敛）：直接消费 session-file-utils 导出的
 * TMP_RESIDUE_MARKERS 同一常量（扫描器过滤与导入拒绝覆盖同一集合，双副本漂移面消灭）。
 */

/**
 * 全局单条导入互斥（D4/r4 修订）：单条 Promise 链一次只执行一条导入，无键选择无回收问题。
 *
 * 异常安全（r4-S1）：then(work, work) 保证前序 rejection（防御性，链体本身已吞错）不阻断
 * 后续；链体另接 then/catch 空转换，rejection 永不泄入链——最后一跳无人 await 也不触发
 * unhandledRejection。错误在 work 内部转 ImportServiceError 抛给调用方，链外不可见。
 */
let importChain: Promise<unknown> = Promise.resolve()
function enqueueImport<T>(work: () => Promise<T>): Promise<T> {
  const result = importChain.then(work, work)
  importChain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

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
// 本服务只消费 id/cwd，timestamp 是外部扫描侧的对齐保留字段。

export class ImportService {
  constructor(private deps: ImportServiceDeps) {}

  /**
   * 候选列表（D5）：rootDir 缺省 = deps.getRootDir() 惰性求值（组合根经 getPiGlobalAgentDir
   * 动态推导装配，禁止硬编码字面量——services 层不 import pi-maintenance，C-comm-03）。
   * alreadyImported 用默认 TTL 读打标（D5：列表展示允许秒级 stale；真正的幂等校验在
   * importSession 互斥区内 force 双检）。
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
   * 执行导入（D5）：进入全局互斥后串行执行。返回结果给调用方（u3 handler reply + broadcast）。
   * 失败抛 ImportServiceError（code 见 ImportErrorCode），互斥链不受污染（enqueueImport 吞错）。
   */
  importSession(request: ImportRequest): Promise<ImportReply> {
    return enqueueImport(() => this.doImport(request))
  }

  private async doImport(request: ImportRequest): Promise<ImportReply> {
    const { sourcePath, projectId } = request
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

    // 2. 文件名标记校验（r2-S1）：导入落地后会被自家扫描过滤器挡成 limbo，前置拒绝
    if (TMP_RESIDUE_MARKERS.some((marker) => sourceName.includes(marker))) {
      throw new ImportServiceError('import_marker_filename', `文件名包含临时标记，疑似迁移残留副本：${sourceName}`)
    }

    // 3. 去重双检 id-first（D4/r4）：force 读集合防「同 id 任意 target」，existsSync 防「同 target 异 id」
    const targetPath = join(getSessionsDir(), encodeCwd(pathResolve(header.cwd)), sourceName)
    const importedIds = new Set(scanPiSessions({ force: true }).map((s) => s.id))
    if (importedIds.has(header.id)) {
      throw new ImportServiceError('import_already_imported', `该会话已在太极中（sessionId=${header.id}），侧边栏可直接打开`)
    }
    if (existsSync(targetPath)) {
      throw new ImportServiceError('import_target_conflict', `目标路径已被另一个会话占用：${targetPath}`)
    }

    // 4. projectId 存在性校验（r3-INFO：空串是 persistProjectBinding 的「删 sidecar 归默认」语义，readback 会假阳性，不容忍）
    const projects = this.deps.projects.load().projects
    if (!projectId || !projects.some((p) => p.id === projectId)) {
      throw new ImportServiceError('import_project_invalid', projectId ? `目标项目不存在：${projectId}` : '目标项目不存在（空 projectId）')
    }

    // 5. mkdir(recursive) + tmp+rename 原子复制（D1/r2：失败主动清理临时名，正式名从未落地 → 重试不被去重拦截）
    const tmpPath = `${targetPath}${TMP_IMPORT_MARKER}${Date.now()}.jsonl`
    try {
      await mkdir(dirname(targetPath), { recursive: true })
      await copyFile(sourcePath, tmpPath)
      await rename(tmpPath, targetPath)
    } catch (e) {
      try {
        await unlink(tmpPath)
      // eslint-disable-next-line taste/no-silent-catch -- tmp cleanup: best-effort，正确性由「正式名未落地」保证而非本删除
      } catch {
        // tmp 未创建/已被清理：忽略
      }
      throw new ImportServiceError('import_copy_failed', `导入失败（写入目标目录出错）：${toErrorMessage(e)}`)
    }

    // 6. project sidecar + readback（r2-S2）：persistBindingSidecar 吞错 best-effort，
    //    不校验会假成功 + 静默误归组默认项目。不符 → warning 降级，文件已落地不回滚。
    persistProjectBinding(targetPath, projectId)
    const sidecarVerified = readProjectBinding(targetPath) === projectId

    // 7. 缓存失效：太极根列表 TTL 显式失效（D1，broadcast 立即可见）；alreadyImported 的
    //    stale 消除由本行保证（listCandidates 每次调 scanPiSessions() 重算，与外部根缓存
    //    无关）。外部根（u1 未导出失效函数）force 重扫是保守动作，无消费者依赖其效果——
    //    且会把单条目缓存键换成源文件所在子目录、下次根查询 miss（见设计 D3 实现层注记）。
    invalidateScanDirCache()
    await scanExternalSessions(dirname(sourcePath), { force: true })

    // 8. B5 摘碑（双路径②，R4）：import 同 id 复活 session——覆盖「import 后未打开窗口」
    //    的迟到写丢弃风险（路径①的 notifySessionCreated 只在用户点开时触发，此窗口内
    //    插件对新 session 的合法 set 会被 tombstone 误杀）。导入失败路径不至此，碑保留。
    clearSessionDataTombstone(header.id)

    const reply: ImportReply = { sessionId: header.id, targetPath }
    if (!sidecarVerified) reply.warning = 'sidecar_failed'
    return reply
  }
}
