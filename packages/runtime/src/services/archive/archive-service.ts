/**
 * ArchiveService — 归档/恢复/彻底删除三操作核心（session-archive 设计 §7 D5/D8/D9/D13）。
 *
 * 单元构成（本文件 = 服务编排层）：
 * - 路径派生与簿记扫描：archive-paths.ts（D1 镜像布局 + D3 目录即事实源）
 * - 摘要提取：summary-extractor.ts（D4 纯函数，后台压缩任务消费）
 * - 状态机声明：archive-entry-machine.ts（D9 表；本服务消费其 transition 判定做
 *   表外 fail-fast——状态判定唯一权威 = 读磁盘，机器只承载数据/事件合法性判定）
 *
 * 串行化（D5 在途任务表）：同一 session 的归档域操作（后台压缩任务 / unarchive /
 * purgeArchive）按到达顺序串行执行——后到者先 await 在途操作终态再执行；先到者完成
 * 后，后到者对已消失的归档单元按簿记存在性门 fail-fast（archive_not_found）。
 *
 * 失败语义：领域错误抛 ArchiveError（code ∈ ARCHIVE_ERROR_CODES，u-rpc-wiring 转
 * error envelope）；IO 失败映射 archive_io_error；操作中途崩溃由启动自愈归位
 * （archive-self-heal.ts，七行表覆盖全部中间态）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { zstdCompressSync, zstdDecompressSync, constants as zlibConstants } from 'node:zlib'
import { basename, join } from 'node:path'
import type { ArchiveErrorCode, ArchiveLedger, ArchiveLedgerStaging, ArchiveSummary, SessionSummary } from '@taiji/shared'
import { getSessionStoreDir } from '@taiji/shared/paths'
import { cascadeDeleteSessionContent } from '../session/session-content-cascade.js'
import { parseJsonl } from '../../utils/jsonl.js'
import { extractSessionName, readProjectBinding } from '../../infra/pi/session-file-utils.js'
import { getSessionsDir, getPiAgentDir } from '../../infra/pi/pi-paths.js'
import { archiveEntryMachine } from './archive-entry-machine.js'
import { extractArchiveSummary } from './summary-extractor.js'
import { healArchiveOnStartup } from './archive-self-heal.js'
import {
  ASSET_DOMAINS,
  archiveAssetDomainDir,
  archiveCompressedPath,
  archiveLedgerPath,
  archivePlainMainPath,
  archiveRestoringPath,
  archiveUnitDir,
  assetDomainSourceDir,
  defaultArchiveRoot,
  defaultSessionStoreRoot,
  existingSidecars,
  findLedgerBySessionId,
  readLedgerFile,
  scanLedgers,
  sessionOriginalPath,
  tmpPathOf,
  writeLedgerAtomic,
} from './archive-paths.js'

/** 归档域领域错误（code 词表 = shared ARCHIVE_ERROR_CODES；u-rpc-wiring 按 code 转 envelope）。 */
export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode
  constructor(code: ArchiveErrorCode, message: string) {
    super(message)
    this.name = 'ArchiveError'
    this.code = code
  }
}

/** 活跃 session 的定位视图（archive 前置编排所需的最小字段）。 */
export interface ActiveSessionRef {  // oe-exempt:20261020:wip:归档域内部形态类型（fixture/seed/context 描述），单实现为当前形态——30 天窗口内联或等第二变体
  cwd: string
  /** 活跃 session 的主文件路径（首 flush 前可能未落盘 = undefined，规则 #6）。 */
  sessionFilePath?: string
}

/** 扫描态 session 的定位视图。 */
export interface ScannedSessionRef {  // oe-exempt:20261020:wip:归档域内部形态类型（fixture/seed/context 描述），单实现为当前形态——30 天窗口内联或等第二变体
  cwd: string
  filePath: string
}

/**
 * 依赖注入面（全部可注入——测试 zero mock-module、零真实数据目录；组装根接线，
 * 对齐 SessionContentCascadeDeps 先例）。delete 活跃分支原语的逐项复刻（D5 步骤 2）
 * 经本面进入，不在本服务内 import session-lifecycle 实例方法。
 */
export interface ArchiveServiceDeps { // oe-exempt:20261020:framework:服务依赖注入面（组装根接线 + 测试 fake，DI 端口先立单实现常态）
  /** 生成中判定（前置三门之首，D13——防 RPC 绕过前端禁用后杀 pi 丢尾部未落盘 entry）。 */
  isGenerating(sessionId: string): boolean
  /** 活跃 session 查找（内存 Map 在册判定；undefined = 非活跃）。 */
  getActiveSession(sessionId: string): ActiveSessionRef | undefined
  /** 扫描态 session 查找（磁盘扫描；undefined = 磁盘无主文件）。 */
  findScannedSession(sessionId: string): ScannedSessionRef | undefined
  /** userStopped 标记清理（delete 活跃分支步骤 ①，userStoppedGate.disposeForDelete）。 */
  disposeUserStopped(sessionId: string): void
  /**
   * 死亡处置登记（步骤 ②，fireDeathDisposition(sid, 'archive', …)——先于任何杀进程，
   * 防 pi 的 exit 事件被组合根按崩溃路径响应产生伪造死亡通知；组合根对该值统一
   * speakSessionDeath(sid, 'exit') 收尾 completion-watch 债权——GUI 侧栏归档与 agent
   * 工具 archive_session 两入口同经本登记到达汇聚点。hasDestroySink = 在册判据，同 delete）。
   */
  fireArchiveDisposition(sessionId: string, hasDestroySink: boolean): void
  /** 级联停止名下 btw 线（步骤 ③ + purge 步骤 ④，closeAllForMain——返回关闭的线 sessionId 清单）。 */
  closeAllBtwLines(mainSid: string, cwd: string): Promise<string[]>
  /** detach 活跃 session（步骤 ④）。 */
  detachSession(sessionId: string): void
  /** 终止 pi 进程（步骤 ④，pm.destroySession）。 */
  destroyPiSession(sessionId: string): Promise<void>
  /** 内存 Map 摘除（步骤 ④，removeSessionEntry）。 */
  removeSessionEntry(sessionId: string): void
  /** 收殓在途后台任务（步骤 ⑤，先于一切搬移动作；幂等）。 */
  reapBackgroundTasks(agentDir: string, sessionId: string): Promise<unknown>
  /** 插件 KV tombstone（purge 步骤 ②，先于删树——防插件 worker 迟到写重建孤儿树）。 */
  clearRemovedSessionData(sessionId: string): void
  /** 画布绑定解绑（purge 步骤 ⑤；真删除点，归档刻意不解绑）。 */
  unbindCanvas(sessionId: string): void
  /** 文件级废纸篓（purge 步骤 ⑥ 压缩体处置；sessionStore.trash 同款 G4 语义）。 */
  trash(path: string): Promise<void>
  /** 目录级废纸篓（cascade 段 3 整树软删经 deps 面；mac 废纸篓 / 非 mac 递归删降级）。 */
  trashDirectory(dirPath: string): Promise<void>
  /** 扫描缓存失效（archive/unarchive 步骤末——删除后立即从侧栏消失的同款范式）。 */
  invalidateScanCache(): void
  /** 整表广播（config.sessions 帧全连接送达；archiveCount 携带属 u-rpc-wiring 帧构造）。 */
  broadcastSessionList(): void
  /** 恢复后的 SessionSummary 读回（unarchive reply；组装根经 scanner/lifecycle 构造）。 */
  getSessionSummary(sessionId: string): SessionSummary | undefined
  /** 汇总出声通道（生产 console.warn；测试收集断言）。 */
  warn(message: string): void
}

/** 路径注入面（缺省 = 生产推导；测试注入 tmp 目录——写删目标全部自建自删）。 */
export interface ArchiveServicePaths {  // oe-exempt:20261020:wip:归档域内部形态类型（fixture/seed/context 描述），单实现为当前形态——30 天窗口内联或等第二变体
  archiveRoot?: string
  agentDir?: string
  sessionsRoot?: string
  sessionStoreRoot?: string
  /** 附件三目录推导基址（`<dataDir>/ext-sessions`；提供时 sessionStoreRoot 缺省随之派生）。 */
  dataDir?: string
}

/** 后台压缩任务的产出观测（测试断言用；生产不消费返回值）。 */
export interface CompressionOutcome {  // oe-exempt:20261020:wip:归档域内部形态类型（fixture/seed/context 描述），单实现为当前形态——30 天窗口内联或等第二变体
  sessionId: string
  compressedBytes: number
}

/** 压缩编码标识（D2：zstd level 3；簿记 codec 字段值）。 */
const CODEC_ZSTD_3 = 'zstd-3'

export class ArchiveService {
  private readonly archiveRoot: string
  private readonly agentDir: string
  private readonly sessionsRoot: string
  private readonly sessionStoreRoot: string
  /** 附件三目录推导基址（缺省 undefined = shared getDataDir() 生产推导；测试注入）。 */
  private readonly dataDir: string | undefined
  /** 在途任务表（sessionId → 尾部 promise；三操作两两并发按到达顺序串行，D5）。 */
  private readonly inflight = new Map<string, Promise<void>>()

  constructor(
    private readonly deps: ArchiveServiceDeps,
    paths: ArchiveServicePaths = {},
  ) {
    this.archiveRoot = paths.archiveRoot ?? defaultArchiveRoot()
    this.agentDir = paths.agentDir ?? getPiAgentDir()
    this.sessionsRoot = paths.sessionsRoot ?? getSessionsDir()
    this.dataDir = paths.dataDir
    this.sessionStoreRoot =
      paths.sessionStoreRoot ?? (paths.dataDir !== undefined ? getSessionStoreDir(paths.dataDir) : defaultSessionStoreRoot())
  }

  // ── 在途任务表（per-session 串行化执行点）────────────────────────────────────

  /**
   * 串行化执行：op 排在前序操作之后（前序失败不阻断后到者——两操作的失败互不串扰，
   * 各自按到达时刻的磁盘事实判定）。完成后清理表项（无新排队者时），有后到者则后到
   * 者已链在尾部 promise 上。
   */
  private serialize<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.inflight.get(sessionId) ?? Promise.resolve()
    const run = prev.then(op, op)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.inflight.set(sessionId, tail)
    void tail.then(() => {
      if (this.inflight.get(sessionId) === tail) this.inflight.delete(sessionId)
    })
    return run
  }

  // ── session.archive（D5 同步段，reply 前完成）────────────────────────────────

  /**
   * 归档：前置三门 → 活跃编排五步复刻 delete 分支 → 搬移（旁挂→主文件→附件三目录）
   * → 簿记骨架 → 广播。后台压缩任务经在途任务表异步派发（reply 后执行）。
   *
   * 结构 = 三门定位 + 三段提取（teardownForArchive 活跃退场五步 / moveAssetsToUnit
   * 搬移 / writeStagingLedger 簿记骨架）——拆分只为单函数分支数受控，步骤顺序与
   * 错误映射逐条不变。
   */
  async archive(sessionId: string): Promise<{ sessionId: string }> {
    // 门 1：生成中拒绝（D13——杀 pi 会丢尾部未落盘 entry）。
    if (this.deps.isGenerating(sessionId)) {
      throw new ArchiveError('archive_generating', `会话正在生成中，无法归档 (sessionId=${sessionId})`)
    }
    // 门 2：归档目录已存在该 sessionId 的簿记（两态与恢复中标记都算在档）。
    const existing = findLedgerBySessionId(this.archiveRoot, sessionId, this.deps.warn)
    if (existing !== null) {
      throw new ArchiveError(
        'archive_already_archived',
        `该会话已有归档记录，请先在归档列表恢复或彻底删除该条 (sessionId=${sessionId})`,
      )
    }
    // 定位：活跃（内存 Map）优先，其次扫描态（磁盘）。
    const active = this.deps.getActiveSession(sessionId)
    const scanned = this.deps.findScannedSession(sessionId)
    const rawCwd = active?.cwd ?? scanned?.cwd
    const locatedMainPath = active?.sessionFilePath ?? scanned?.filePath
    if (rawCwd === undefined || locatedMainPath === undefined) {
      throw new Error(`Session ${sessionId} not found (不在内存 Map 且磁盘无主文件，无归档对象)`)
    }
    // cwd realpath 归一（archive-edge-inputs-failfast 条目 27）：pi 落盘分桶按 spawn 子进程
    // process.cwd() 的内核解析真值编码（macOS /var → /private/var，pi dist 实装
    // getDefaultSessionDirPath 同 encodeCwd 公式），归档入口持有的 cwd 可能是未解析符号
    // 链接路径——归一后归档单元目录与簿记 cwd 才与 pi 的 sessions 分桶同编码；恢复侧
    // sessionOriginalPath 按簿记 cwd 原样推导（realpath 后存），两侧同编码即往返一致。
    // cwd 已被删除（worktree 清理）时 realpath ENOENT——保持原样（无可对齐的分桶真值，
    // 编码维持调用方事实）。
    const cwd = realpathOrSelf(rawCwd)
    const originalFile = basename(locatedMainPath)
    // 主文件在场判定 + 未解析路径修正（条目 26/27）：
    // - locatedMainPath 缺席磁盘且 realpath 分桶存在同名主文件 → 定位源携带的是未解析
    //   cwd 派生路径，改用分桶真值为搬移源；
    // - 两侧都缺席 = 零消息 session（pi 首次 flush 前主文件未落盘，规则 #6）→ 空归档
    //   语义：成功返回，跳过主文件搬移与压缩任务（无内容可压），簿记 name 回退 sessionId。
    let mainPath: string | undefined = locatedMainPath
    if (!existsSync(mainPath)) {
      const resolvedCandidate = sessionOriginalPath(this.sessionsRoot, cwd, originalFile)
      mainPath = existsSync(resolvedCandidate) ? resolvedCandidate : undefined
    }
    const unitDir = archiveUnitDir(this.archiveRoot, cwd)
    // 门 3：目标盘写失败（建桶目录失败即映射 archive_io_error——后续搬移/簿记写入同映射）。
    try {
      mkdirSync(unitDir, { recursive: true })
    } catch (e: unknown) {
      throw new ArchiveError('archive_io_error', `归档目录创建失败: ${unitDir} (${toMessage(e)})`)
    }

    // 活跃/非活跃共用：停止名下 btw 线（D8——不停止则线进程持有 mainSid 上下文继续写
    // 留置的 btw/ 域，与主 session 退场状态矛盾）。活跃分支五步复刻 delete（D5 步骤 2）。
    await this.teardownForArchive(sessionId, cwd, active !== undefined)

    // 搬移（顺序固定，D5 步骤 3）：旁挂六类 → 主文件（零消息形态跳过）→ 附件三目录
    //（源缺失跳过）。旁挂枚举锚定定位路径——sidecar 由 taiji 按 sessionFilePath 写入
    //（persistCreateSidecars 族），零消息形态下主文件虽未落盘、旁挂可在场。
    this.moveAssetsToUnit(sessionId, locatedMainPath, mainPath, unitDir, originalFile)

    // 读归档目录内明文提取名称（尾读有界）+ 写簿记骨架（D5 步骤 4）。
    const stagingLedger = this.writeStagingLedger(sessionId, unitDir, originalFile, cwd)

    // 步骤 5：缓存失效 + 广播（reply 由 u-rpc-wiring 层发；archiveCount 属帧构造）。
    this.deps.invalidateScanCache()
    this.deps.broadcastSessionList()

    // 后台压缩任务（reply 后异步执行；经在途任务表串行化）。零消息空归档不派发——
    // runCompression 对缺席明文的形态是幂等跳过，直接不排队省一次空转与误导性 warn，
    // 条目保持 staging（空单元的稳定态；自愈行 1 对无明文无压缩体的条目不重排）。
    if (mainPath !== undefined) {
      void this.queueCompression(stagingLedger, unitDir).catch((e: unknown) => {
        this.deps.warn(`[archive] 后台压缩任务失败（条目保持 staging 态，启动自愈重试）(sessionId=${sessionId}): ${toMessage(e)}`)
      })
    }
    return { sessionId }
  }

  /**
   * 归档前活跃 session 退场五步（D5 步骤 2，复刻 delete 分支；非活跃 session 只跑
   * btw 级联停止）：
   * ① userStopped 清理（标记与收敛环定时器随退场清理；恢复后是新进程无标记语义）；
   * ② 死亡处置登记 archive——先于任何杀进程（防 exit 事件被组合根按崩溃路径响应）；
   *   disposition = 'archive'（终局退场）：组合根对该值统一 speakSessionDeath(sid,
   *   'exit') 收尾 completion-watch 债权（archive-watch-settlement-gap 条目 28——GUI
   *   侧栏归档与 agent 工具 archive_session 两入口同经本登记到达单一汇聚点），并立
   *   suppressedDeaths 抑制标使随后的销毁回调查过即消（intentional destroy 的 exit
   *   被 process-manager clientToId 反查拦截，双通道不产生伪造死亡通知）；
   * ③ 级联停止名下 btw 线（closeAllForMain 原语；线 jsonl 留置主树 btw/ 域，D8）；
   * ④ detach + 终止 pi 进程 + 内存 Map 摘除（「停止并归档」语义，D13）；
   * ⑤ 收殓在途后台任务（先于一切搬移动作——base-tool-enhance 后台任务在主 turn 结束
   *   后仍可能在途而 isGenerating 已为 false；不收殓 = 后台进程泄漏 + 迟到写重建孤儿）。
   */
  private async teardownForArchive(sessionId: string, cwd: string, isActive: boolean): Promise<void> {
    if (isActive) {
      this.deps.disposeUserStopped(sessionId)
      this.deps.fireArchiveDisposition(sessionId, true)
    }
    await this.closeBtwLinesQuietly(sessionId, cwd)
    if (isActive) {
      this.deps.detachSession(sessionId)
      await this.deps.destroyPiSession(sessionId)
      this.deps.removeSessionEntry(sessionId)
    }
    try {
      await this.deps.reapBackgroundTasks(this.agentDir, sessionId)
    } catch (e: unknown) {
      // 收殓失败不阻断归档（幂等原语，重试路径同 delete 侧 best-effort 语义）；出声。
      this.deps.warn(`[archive] 收殓在途后台任务失败，继续归档 (sessionId=${sessionId}): ${toMessage(e)}`)
    }
  }

  /**
   * 搬移归档物到单元目录（D5 步骤 3，顺序固定）：旁挂六类 → 主文件 → 附件三目录
   * （源缺失跳过；主文件缺席 = 零消息空归档形态，跳过主文件搬移）。任一步失败统一
   * 映射 archive_io_error。旁挂枚举锚定定位路径 sidecarBase（sidecar 写点 = 定位源
   * 路径），主文件搬移源 = mainPath（未解析路径修正后的分桶真值，正常形态两者同一路径）。
   */
  private moveAssetsToUnit(sessionId: string, sidecarBase: string, mainPath: string | undefined, unitDir: string, originalFile: string): void {
    try {
      for (const sidecar of existingSidecars(sidecarBase)) {
        renameSync(sidecar, join(unitDir, basename(sidecar)))
      }
      if (mainPath !== undefined) {
        renameSync(mainPath, join(unitDir, originalFile))
      }
      for (const domain of ASSET_DOMAINS) {
        const source = assetDomainSourceDir(sessionId, domain, this.dataDir)
        if (!existsSync(source)) continue
        const dest = archiveAssetDomainDir(unitDir, sessionId, domain)
        mkdirSync(dest, { recursive: true })
        renameSync(source, dest)
      }
    } catch (e: unknown) {
      throw new ArchiveError('archive_io_error', `归档搬移失败 (sessionId=${sessionId}): ${toMessage(e)}`)
    }
  }

  /**
   * 写 staging 簿记骨架（D5 步骤 4）：读归档目录内明文提取名称（尾读有界）+ 字节数
   * + 原子写入。写入失败映射 archive_io_error。零消息空归档（单元内无明文——主文件
   * 从未落盘）：name 回退 sessionId（登记倾向方案——列表可辨识且幂等重入走门 2 的
   * archive_already_archived），rawBytes 记 0。
   */
  private writeStagingLedger(sessionId: string, unitDir: string, originalFile: string, cwd: string): ArchiveLedgerStaging {
    const plainPath = archivePlainMainPath(unitDir, originalFile)
    const plainExists = existsSync(plainPath)
    const name = plainExists ? (extractSessionName(plainPath) ?? '') : sessionId
    const rawBytes = plainExists ? statSync(plainPath).size : 0
    const stagingLedger: ArchiveLedgerStaging = {
      sessionId,
      name,
      originalFile,
      cwd,
      archivedAt: new Date().toISOString(),
      rawBytes,
      status: 'staging',
      summary: null,
    }
    try {
      writeLedgerAtomic(archiveLedgerPath(unitDir, originalFile), stagingLedger)
    } catch (e: unknown) {
      throw new ArchiveError('archive_io_error', `归档簿记写入失败 (sessionId=${sessionId}): ${toMessage(e)}`)
    }
    return stagingLedger
  }

  /** btw 级联停止的 best-effort 包装（失败不阻断归档主链；对齐 delete 的降级语义）。 */
  private async closeBtwLinesQuietly(sessionId: string, cwd: string): Promise<void> {
    try {
      await this.deps.closeAllBtwLines(sessionId, cwd)
    } catch (e: unknown) {
      this.deps.warn(`[archive] btw 线级联停止失败，继续归档 (sessionId=${sessionId}): ${toMessage(e)}`)
    }
  }

  /**
   * 后台压缩任务（D5）：读明文全量 → 提取摘要（D4）→ zstd 压缩 tmp+rename → 删明文 →
   * 簿记原子重写终态 → 广播完成通知（staging 占位刷新的事件源，见函数体注释）。状态机
   * 判定：staging + compress_done（磁盘 status 非 staging 或明文已失 = 幂等重入，直接
   * 返回——自愈重试与竞态双跑安全）。
   */
  private async queueCompression(ledger: ArchiveLedgerStaging, unitDir: string): Promise<CompressionOutcome> {
    return this.serialize(ledger.sessionId, async () => {
      // 执行体经 setImmediate 让渡到 macrotask（「reply 后异步执行」的调度落实——
      // archive reply 时点的 microtask 恢复先于本任务，磁盘仍为 staging 骨架）；
      // inflight 登记（serialize）同步完成，后到的 unarchive/purge 仍严格排在压缩之后。
      await new Promise<void>((resolve) => setImmediate(resolve))
      return this.runCompression(ledger, unitDir)
    })
  }

  private async runCompression(ledger: ArchiveLedgerStaging, unitDir: string): Promise<CompressionOutcome> {
    const plainPath = archivePlainMainPath(unitDir, ledger.originalFile)
    if (!existsSync(plainPath)) {
      // 幂等重入（压缩已完成/被恢复消费）：非失败，零动作（自愈行 1 的重试安全形态）。
      this.deps.warn(`[archive] 压缩任务重入跳过：明文主文件不存在 (sessionId=${ledger.sessionId})`)
      return { sessionId: ledger.sessionId, compressedBytes: 0 }
    }
    // D9 表内判定：staging + compress_done → archived（表外抛 = 声明与磁盘态矛盾，fail-fast）。
    const state = archiveEntryMachine.coerceState(ledger.status)
    if (state === null) throw new Error(`簿记 status 词表外: ${ledger.status}`)
    archiveEntryMachine.transition(state, 'compress_done')

    const raw = readFileSync(plainPath)
    const summary = extractArchiveSummary(parseJsonl(raw.toString('utf8')))
    // D2：zstd level 3（设计选定档位；@types/node 的 ZstdOptions 无 level 简写，经
    // params 显式传 ZSTD_c_compressionLevel——运行时两形态等价，取类型安全形态）。
    const compressed = zstdCompressSync(raw, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 },
    })
    const compressedPath = archiveCompressedPath(unitDir, ledger.originalFile)
    const tmpPath = tmpPathOf(compressedPath)
    try {
      writeFileSync(tmpPath, compressed)
      renameSync(tmpPath, compressedPath)
      unlinkSync(plainPath)
      writeLedgerAtomic(archiveLedgerPath(unitDir, ledger.originalFile), {
        ...ledger,
        status: 'archived',
        codec: CODEC_ZSTD_3,
        compressedBytes: compressed.byteLength,
        sha256: sha256Hex(compressed),
        summary,
      })
      // 压缩完成的完成通知（D11「后台任务完成事件刷新」的事件源承载）：归档条目不在
      // 会话列表、archiveCount 两态同计（staging/archived 均计数），会话列表帧内容不变——
      // 广播的作用 = 提示帧本身（renderer 收帧时归档视图/摘要视图打开则重拉 config.archives，
      // 「压缩中」标注与「摘要生成中」占位随之刷新）。拉为主：帧丢失或视图关闭时按
      // 既有拉取路径收敛（打开视图/域内操作后刷新），无额外补偿。
      this.deps.broadcastSessionList()
    } catch (e: unknown) {
      // 残留 tmp 不回滚（自愈行 6 清收）；条目保持 staging 态，自愈行 1 重试。
      throw new ArchiveError('archive_io_error', `压缩任务写盘失败 (sessionId=${ledger.sessionId}): ${toMessage(e)}`)
    }
    return { sessionId: ledger.sessionId, compressedBytes: compressed.byteLength }
  }

  // ── session.unarchive（D5 恢复执行）──────────────────────────────────────────

  /**
   * 恢复：簿记 rename .restoring → 冲突检测前置 → sha256 校验（archived）/ 明文在场
   * （staging）→ 解压回 sessions/ 原位 + 旁挂/附件反向搬回 → 删除归档单元（簿记殿后）
   * → 缓存失效 + 广播 + 返回 SessionSummary。
   */
  async unarchive(sessionId: string): Promise<{ sessionId: string; session: SessionSummary }> {
    await this.serialize(sessionId, async () => this.runUnarchive(sessionId))
    const session = this.deps.getSessionSummary(sessionId)
    if (session === undefined) {
      // 物理恢复已成功、summary 读不到 = 扫描侧异常；不回滚（数据已回场），显式上报。
      throw new Error(`恢复完成但 SessionSummary 读回失败 (sessionId=${sessionId})——磁盘事实已回 sessions/ 原位`)
    }
    return { sessionId, session }
  }

  private async runUnarchive(sessionId: string): Promise<void> {
    // 步骤 1（串行化已由 serialize 承载）。定位簿记（restoring 态簿记不在扫描范围 →
    // 恢复中条目对用户不可见，不变量 3；无簿记 = 无归档单元）。
    const located = findLedgerBySessionId(this.archiveRoot, sessionId, this.deps.warn)
    if (located === null) {
      throw new ArchiveError('archive_not_found', `归档记录不存在（已恢复或从未归档）(sessionId=${sessionId})`)
    }
    const { ledger, unitDir } = located
    const state = archiveEntryMachine.coerceState(ledger.status)
    if (state === null) throw new ArchiveError('archive_corrupted', `簿记 status 词表外: ${ledger.status}`)
    const ledgerPath = archiveLedgerPath(unitDir, ledger.originalFile)
    const restoringPath = archiveRestoringPath(unitDir, ledger.originalFile)
    const originalMainPath = sessionOriginalPath(this.sessionsRoot, ledger.cwd, ledger.originalFile)
    const rollback = (): void => {
      renameSync(restoringPath, ledgerPath)
    }

    // 步骤 2：簿记 rename 为 .restoring（标记恢复中，D9 表内 unarchive 行）。
    archiveEntryMachine.transition(state, 'unarchive')
    try {
      renameSync(ledgerPath, restoringPath)
    } catch (e: unknown) {
      throw new ArchiveError('archive_io_error', `簿记标记恢复中失败: ${toMessage(e)}`)
    }

    // 步骤 3：冲突检测前置（fs.rename 对已存在目标静默覆盖——staging 与 archived 统一）。
    if (existsSync(originalMainPath)) {
      rollback()
      archiveEntryMachine.transition('restoring', rollbackEventOf(ledger.status))
      throw new ArchiveError(
        'archive_restore_conflict',
        `原路径已存在同名会话文件，请先处理该同名会话再恢复 (sessionId=${sessionId}, path=${originalMainPath})`,
      )
    }

    // 步骤 4：archived 校验 sha256；staging 校验明文在场。
    const plainPath = archivePlainMainPath(unitDir, ledger.originalFile)
    const compressedPath = archiveCompressedPath(unitDir, ledger.originalFile)
    let restoredContent: Buffer
    if (ledger.status === 'archived') {
      let compressed: Buffer
      try {
        compressed = readFileSync(compressedPath)
      } catch (e: unknown) {
        rollback()
        archiveEntryMachine.transition('restoring', rollbackEventOf(ledger.status))
        throw new ArchiveError('archive_corrupted', `压缩体不可读 (sessionId=${sessionId}): ${toMessage(e)}`)
      }
      if (sha256Hex(compressed) !== ledger.sha256) {
        rollback()
        archiveEntryMachine.transition('restoring', rollbackEventOf(ledger.status))
        throw new ArchiveError('archive_corrupted', `归档数据校验失败（sha256 不匹配），原件保留 (sessionId=${sessionId})`)
      }
      restoredContent = zstdDecompressSync(compressed)
    } else {
      try {
        restoredContent = readFileSync(plainPath)
      } catch (e: unknown) {
        rollback()
        archiveEntryMachine.transition('restoring', rollbackEventOf(ledger.status))
        throw new ArchiveError('archive_corrupted', `staging 明文主文件缺失，归档单元损坏 (sessionId=${sessionId}): ${toMessage(e)}`)
      }
    }

    // 步骤 5：解压到 sessions/ 原位（tmp+rename）+ 旁挂、附件三目录反向搬回。
    // 主文件重建（writeFileSync 全量重写 + rename 回原位）→ mtime = 恢复时刻：列表序
    // = 主文件 mtime 降序（scanner lastActiveAt 派生源），恢复的 session 构造性落组内
    // 顶部（§2 目标 4 / §5.1「原项目组顶部」）——零额外置顶机制，语义由单测锚定。
    try {
      const tmp = tmpPathOf(originalMainPath)
      writeFileSync(tmp, restoredContent)
      renameSync(tmp, originalMainPath)
      for (const sidecar of existingSidecars(plainPath)) {
        renameSync(sidecar, originalMainPath + sidecar.slice(plainPath.length))
      }
      for (const domain of ASSET_DOMAINS) {
        const source = archiveAssetDomainDir(unitDir, sessionId, domain)
        if (!existsSync(source)) continue
        const dest = assetDomainSourceDir(sessionId, domain, this.dataDir)
        mkdirSync(dest, { recursive: true })
        renameSync(source, dest)
      }
    } catch (e: unknown) {
      // 回场中途失败：簿记归位（原件未动——sessions/ 侧残留 tmp 由自愈行 6 清收）。
      rollback()
      archiveEntryMachine.transition('restoring', rollbackEventOf(ledger.status))
      throw new ArchiveError('archive_io_error', `恢复写盘失败 (sessionId=${sessionId}): ${toMessage(e)}`)
    }

    // 步骤 6：删除归档单元（先压缩体/明文/旁挂/附件，簿记殿后——簿记消失即恢复完成）。
    await this.disposeArchiveUnit(unitDir, ledger, {
      trashMain: false, // 恢复路径直接删归档物（内容已回场，压缩体无保留价值）
      mainCandidates: ledger.status === 'archived' ? [compressedPath] : [plainPath],
    })
    archiveEntryMachine.transition('restoring', 'restore_done')

    // 步骤 7：缓存失效 + 广播（reply 的 SessionSummary 由 unarchive 出口构造）。
    this.deps.invalidateScanCache()
    this.deps.broadcastSessionList()
  }

  // ── session.purgeArchive（D5 彻底删除，全部步骤幂等）─────────────────────────

  /**
   * 彻底删除 = delete 的归档态版本：簿记存在性门 → 插件 KV tombstone → 残树处置
   * （cascade + 引用枚举源扩展）→ btw 级联删除 → 画布解绑 → 归档物处置（簿记殿后）
   * → 广播。keep-all 保守分支触发时 reply 携带 keptSubagentsDir（失败显式上报）。
   */
  async purgeArchive(sessionId: string): Promise<{ sessionId: string; keptSubagentsDir?: string }> {
    return this.serialize(sessionId, async () => this.runPurge(sessionId))
  }

  private async runPurge(sessionId: string): Promise<{ sessionId: string; keptSubagentsDir?: string }> {
    // 步骤 1：簿记存在性门（D9 表外转移 fail-fast 的落地承载——无簿记 = 归档单元不
    // 存在或已被恢复，不拒绝则后续步骤会对在场 session 执行完整删除链）。
    const located = findLedgerBySessionId(this.archiveRoot, sessionId, this.deps.warn)
    if (located === null) {
      throw new ArchiveError('archive_not_found', `归档记录不存在（已恢复或已彻底删除）(sessionId=${sessionId})`)
    }
    const { ledger, unitDir } = located
    const state = archiveEntryMachine.coerceState(ledger.status)
    if (state === null) throw new ArchiveError('archive_corrupted', `簿记 status 词表外: ${ledger.status}`)
    archiveEntryMachine.transition(state, 'purge')

    // 步骤 2：插件 KV tombstone（先于删树，防插件 worker 迟到写重建孤儿树；进程内存态，
    // 崩溃即失——重试重新登记，与 delete 同型崩溃窗口对称接受）。
    try {
      this.deps.clearRemovedSessionData(sessionId)
    } catch (e: unknown) {
      this.deps.warn(`[archive] 插件 KV tombstone 失败，继续彻底删除 (sessionId=${sessionId}): ${toMessage(e)}`)
    }

    // 步骤 3：残树处置（先于归档物处置——引用枚举源在归档单元内，须在其被删除前取出
    // 消费）。引用枚举源：staging 明文直读；archived 先过 sha256 校验再解压为临时产物
    // （校验不过/解压失败 = 引用状态不可知 → 枚举源缺失 → cascade 读失败 → keep-all）。
    const enumerationSource = this.prepareReferenceEnumerationSource(ledger, unitDir)
    const cascadeResult = await cascadeDeleteSessionContent(
      {
        sessionId,
        sessionFilePath: sessionOriginalPath(this.sessionsRoot, ledger.cwd, ledger.originalFile),
        agentDir: this.agentDir,
        sessionsRoot: this.sessionsRoot,
        sessionStoreRoot: this.sessionStoreRoot,
        skipIfMainFileMissing: false, // scanned 语义：主文件恒不在 sessions/（在归档目录），仍收殓 + 整树软删 + 清孤儿 sidecar
        referenceEnumerationSource: enumerationSource,
      },
      {
        trash: (path) => this.deps.trash(path),
        trashSessionTree: (dirPath) => this.deps.trashDirectory(dirPath),
        purgeMainSidecars: (filePath) => {
          for (const sidecar of existingSidecars(filePath)) {
            try {
              unlinkSync(sidecar)
            } catch {
              void 0 // best-effort（cascade 段 5 孤儿 sidecar 清理语义）
            }
          }
        },
        reapBackgroundTasks: (dir, sid) => this.deps.reapBackgroundTasks(dir, sid),
        warn: this.deps.warn,
      },
    )
    // 解压临时产物用后即清（崩溃残留由自愈行 6 清收）。
    if (enumerationSource.endsWith('.tmp')) {
      try {
        unlinkSync(enumerationSource)
      } catch {
        void 0
      }
    }

    // 步骤 4：级联删除 btw 线（closeAllForMain + 名下线画布逐线解绑；线 jsonl 随残树
    // 整删已回收，幂等重入安全）。
    try {
      const closedLines = await this.deps.closeAllBtwLines(sessionId, ledger.cwd)
      for (const lineSessionId of closedLines) {
        this.deps.unbindCanvas(lineSessionId)
      }
    } catch (e: unknown) {
      this.deps.warn(`[archive] btw 线级联删除失败，继续彻底删除 (sessionId=${sessionId}): ${toMessage(e)}`)
    }
    // 步骤 5：画布绑定解绑（真删除点；归档期刻意不解绑，此处与 delete 对齐）。
    this.deps.unbindCanvas(sessionId)

    // 步骤 6：归档物处置（最后——簿记殿后；全部前置存在性检查，幂等重试不卡死）。
    const compressedPath = archiveCompressedPath(unitDir, ledger.originalFile)
    const plainPath = archivePlainMainPath(unitDir, ledger.originalFile)
    // staging 分支补压缩体候选：压缩收尾窗口崩溃形态（明文已删 + 压缩体在场 + 簿记仍
    // staging）若未被启动自愈行 1b 归位（如崩溃前条目从未被重扫），purge 重试须能处置
    // 该残留压缩体，防永久孤儿（disposeArchiveUnit 对缺席候选存在性跳过，正常 staging
    // 形态零行为变化）。
    const mainCandidates =
      ledger.status === 'archived' ? [compressedPath] : [plainPath, compressedPath]
    await this.disposeArchiveUnit(unitDir, ledger, { trashMain: true, mainCandidates })

    // 步骤 7：广播 + reply（keep-all 保守保留说明——判据 referenceScan === 'failed'）。
    this.deps.invalidateScanCache()
    this.deps.broadcastSessionList()
    const keptSubagentsDir =
      cascadeResult.referenceScan === 'failed' ? join(this.sessionStoreRoot, sessionId, 'subagents') : undefined
    return { sessionId, ...(keptSubagentsDir !== undefined ? { keptSubagentsDir } : {}) }
  }

  /**
   * purge 引用枚举源准备（D5 步骤 3 判据链）：
   * - staging：归档目录内明文直读（无 hash 可对照——压缩完成前的秒级过渡态，显式接受）。
   * - archived：sha256 校验压缩体（覆盖全量字节，对任意截断/篡改构造性成立——尾部截断
   *   的 zstd 解压不抛错、静默解出部分产物，不能以解压抛错承载损坏）；校验不过不解压，
   *   返回「不存在的路径」承载（cascade 显式形态无条件进段 2 → 枚举器读失败 → keep-all）。
   * - 解压产物 = 归档单元同目录 `<原主文件名>.tmp`（用后即清，不入归档单元构成）。
   *
   * 返回值恒为路径（源缺失时返回不存在的哨兵路径——同走 keep-all 保守保留）。
   */
  private prepareReferenceEnumerationSource(ledger: ArchiveLedger, unitDir: string): string {
    const missingSentinel = join(unitDir, `${ledger.originalFile}.missing`)
    if (ledger.status === 'staging') {
      const plainPath = archivePlainMainPath(unitDir, ledger.originalFile)
      return existsSync(plainPath) ? plainPath : missingSentinel
    }
    const compressedPath = archiveCompressedPath(unitDir, ledger.originalFile)
    try {
      const compressed = readFileSync(compressedPath)
      if (sha256Hex(compressed) !== ledger.sha256) {
        this.deps.warn(`[archive] purge 引用枚举源校验失败（sha256 不匹配），走 keep-all 保守保留 (sessionId=${ledger.sessionId})`)
        return missingSentinel
      }
      const tmp = join(unitDir, `${ledger.originalFile}.tmp`)
      writeFileSync(tmp, zstdDecompressSync(compressed))
      return tmp
    } catch (e: unknown) {
      this.deps.warn(`[archive] purge 引用枚举源读取失败，走 keep-all 保守保留 (sessionId=${ledger.sessionId}): ${toMessage(e)}`)
      return missingSentinel
    }
  }

  /**
   * 归档单元处置（unarchive 步骤 6 / purge 步骤 6 共用）：主文件压缩体（staging 为
   * 明文）先处置（purge 走废纸篓通道留后悔路；unarchive 直接删——内容已回场）→ 其余
   * 归档物（旁挂、附件三目录）删除 → 簿记最后删（簿记消失即操作完成；中途崩溃簿记
   * 仍在 → 条目仍可见可重试，不变量 3）。全部前置存在性检查（幂等；trash 通道对不
   * 存在路径上抛，不检查则崩溃后重试在已处置物上报错卡死）。
   */
  private async disposeArchiveUnit(
    unitDir: string,
    ledger: ArchiveLedger,
    opts: { trashMain: boolean; mainCandidates: string[] },
  ): Promise<void> {
    for (const mainPath of opts.mainCandidates) {
      if (!existsSync(mainPath)) continue
      if (opts.trashMain) {
        await this.deps.trash(mainPath)
      } else {
        rmSync(mainPath, { force: true })
      }
    }
    const plainPath = archivePlainMainPath(unitDir, ledger.originalFile)
    for (const sidecar of existingSidecars(plainPath)) {
      try {
        unlinkSync(sidecar)
      } catch {
        void 0 // best-effort（重试幂等补删）
      }
    }
    for (const domain of ASSET_DOMAINS) {
      const dir = archiveAssetDomainDir(unitDir, ledger.sessionId, domain)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        void 0
      }
    }
    // 簿记殿后（.archive.json 或 .restoring 形态 whichever 在场）。
    for (const ledgerFile of [
      archiveLedgerPath(unitDir, ledger.originalFile),
      archiveRestoringPath(unitDir, ledger.originalFile),
    ]) {
      try {
        unlinkSync(ledgerFile)
      } catch {
        void 0
      }
    }
  }

  // ── 簿记原子写入（tmp+rename 范式）───────────────────────────────────────────

  // 写原语 = archive-paths.writeLedgerAtomic（C-data-11 单点；本文件不再手写 tmp+rename）。

  /**
   * 归档列表（config.archives 响应数据源，D5）：扫描归档根下全部 `.archive.json` 簿记
   * 派生（不变量 3——不存在独立登记渠道；.restoring 不在列表，恢复中条目对用户不可见）。
   * projectId 回填读随迁的 `.project.json` 旁挂（D3——project 归属不冗余进簿记，权威源
   * 是旁挂；同 SessionScanner 第五读 sidecar 模式）。
   */
  listArchiveEntries(): ArchiveSummary[] {
    return scanLedgers(this.archiveRoot, this.deps.warn)
      .filter((l) => !l.restoring)
      .map((l) => {
        const projectId = readProjectBinding(archivePlainMainPath(l.unitDir, l.ledger.originalFile))
        return projectId === undefined ? { ...l.ledger } : { ...l.ledger, projectId }
      })
  }

  /** 自愈入口（启动时组合根调用一次；七行表见 archive-self-heal.ts）。 */
  async healOnStartup(): Promise<void> {
    await healArchiveOnStartup({
      archiveRoot: this.archiveRoot,
      sessionsRoot: this.sessionsRoot,
      warn: this.deps.warn,
      readLedgerFile,
      queueCompression: (ledger, unitDir) =>
        this.serialize(ledger.sessionId, () => this.runCompression(ledger, unitDir)),
    })
  }
}

/** 回滚事件名（D9 双回滚行：restoring → restore_rollback_to_staging | restore_rollback_to_archived）。 */
function rollbackEventOf(state: 'staging' | 'archived'): 'restore_rollback_to_staging' | 'restore_rollback_to_archived' {
  return state === 'staging' ? 'restore_rollback_to_staging' : 'restore_rollback_to_archived'
}

/**
 * cwd 符号链接归一（条目 27）：解析为内核真值路径（与 pi 子进程 process.cwd() 同源
 * 的编码基准）。路径不存在（cwd 已被删除）时返回原串——realpathSync 对缺席路径抛
 * ENOENT，归档对「目录已消失」形态维持调用方事实不另造编码。
 */
function realpathOrSelf(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
