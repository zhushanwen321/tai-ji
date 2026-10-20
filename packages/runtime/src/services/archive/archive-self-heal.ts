/**
 * 归档启动自愈（session-archive 设计 D5 自愈七行表）——覆盖全部中间态：
 * archive/unarchive 态自动归位，purge 态保持可见可重试（破坏性动作只经用户显式触发）。
 *
 * | 启动时发现 | 判定 | 归位动作 |
 * |---|---|---|
 * | staging 簿记 + 明文 .jsonl 在归档目录 | 压缩未完成 | 重做后台压缩任务 |
 * | staging 簿记 + 明文已删 + 压缩体 .zst 在场 | 压缩收尾窗口中断（明文删除后、簿记终态写入前崩溃） | 解压回明文位重做后台压缩任务 |
 * | `.restoring` 簿记 + sessions/ 原路径主文件已存在 | 恢复已完成（崩溃在删单元前） | 补删归档单元残余（含簿记） |
 * | `.restoring` 簿记 + 原路径主文件不存在 | 恢复未完成 | 簿记 rename 回 .archive.json，清理 sessions/ 下 .tmp 残留 |
 * | 归档目录内无簿记的孤儿文件 | 归档进行到一半 | 读孤儿明文首行 header 取 sessionId（过 pi 会话 id 同域校验，非法 = 跳过待人工处置）：sessions/ 无主文件 → 补写 staging 簿记；有 → 孤儿搬回原位 |
 * | 簿记在 + 归档物部分缺失 / 残树已删 | purge 进行到一半 | 条目保持可见（簿记在即列表在），不自动补删——重试 purge 幂等达终态 |
 * | sessions/ 与 archive/ 两树内 *.tmp 残留 | 压缩/解压中断 | 直接清理 |
 *
 * 独立模块的原因：七行表是纯磁盘事实驱动的恢复逻辑，与服务编排（三操作）变化原因
 * 不同；经 HealContext 注入压缩任务派发口（服务持有在途任务表），不自持状态。
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { encodeCwd, isPiSessionId } from '@taiji/shared/paths'
import type { ArchiveLedger, ArchiveLedgerStaging } from '@taiji/shared'
import { extractSessionName, parseSessionHeader } from '../../infra/pi/session-file-utils.js'
import {
  ASSET_DOMAINS,
  SESSION_SIDECAR_EXTS,
  type LocatedLedger,
  archiveAssetDomainDir,
  archiveCompressedPath,
  archiveLedgerPath,
  archivePlainMainPath,
  archiveRestoringPath,
  existingSidecars,
  scanLedgers,
  sessionOriginalPath,
  tmpPathOf,
  writeLedgerAtomic,
} from './archive-paths.js'

/** 自愈上下文（服务组装注入——压缩任务经在途任务表派发，归位动作共享 warn 通道）。 */
export interface HealContext {  // oe-exempt:20261020:wip:归档域内部形态类型（fixture/seed/context 描述），单实现为当前形态——30 天窗口内联或等第二变体
  archiveRoot: string
  sessionsRoot: string
  warn(message: string): void
  readLedgerFile(ledgerPath: string): ArchiveLedger | null
  queueCompression(ledger: ArchiveLedgerStaging, unitDir: string): Promise<unknown>
}

/**
 * 启动自愈主入口（组合根启动时调用一次；全部动作幂等——自身崩溃后下次启动重跑安全）。
 * 逐行处置后返回；单条失败不阻断其余条目（warn 出声，下次启动重试）。
 */
export async function healArchiveOnStartup(ctx: HealContext): Promise<void> {
  const located = scanLedgers(ctx.archiveRoot, ctx.warn)
  // 行 1/1b：staging 簿记归位——明文在 → 重做压缩任务；明文不在 + 压缩体在（压缩收尾
  // 窗口中断）→ 先解压回明文位再重做压缩任务。
  for (const l of located) {
    if (l.restoring || l.ledger.status !== 'staging') continue
    const plainPath = archivePlainMainPath(l.unitDir, l.ledger.originalFile)
    if (!existsSync(plainPath) && !restorePlainFromCompressed(ctx, l, plainPath)) continue
    try {
      await ctx.queueCompression(l.ledger, l.unitDir)
    } catch (e: unknown) {
      ctx.warn(`[archive-self-heal] 行1 重做压缩任务失败（条目保持 staging，下次启动重试）(sessionId=${l.ledger.sessionId}): ${toMessage(e)}`)
    }
  }
  // 行 2/3：.restoring 簿记按 sessions/ 原路径主文件在场分派。
  for (const l of located) {
    if (!l.restoring) continue
    healRestoringLedger(ctx, l)
  }
  // 行 4：无簿记的孤儿文件（搬移后、簿记写入前崩溃的归档进行到一半形态）。
  healOrphanFiles(ctx, located)
  // 行 5：簿记在 + 归档物部分缺失 → no-op（条目保持可见可重试——重试 purge 幂等达终
  // 态，破坏性补删不经自愈触发；表行登记为语义锚，无动作）。
  // 行 6：两树内 *.tmp 残留 → 直接清理（压缩/解压中断的兜底收口）。
  cleanupTmpResidues(ctx)
}

/** 行 2/3：恢复中簿记的归位（按原路径主文件在场判定恢复是否已完成）。 */
function healRestoringLedger(ctx: HealContext, l: LocatedLedger): void {
  const originalMain = sessionOriginalPath(ctx.sessionsRoot, l.ledger.cwd, l.ledger.originalFile)
  const restoringPath = archiveRestoringPath(l.unitDir, l.ledger.originalFile)
  try {
    if (existsSync(originalMain)) {
      // 行 2：恢复已完成（崩溃在删单元前）——补删归档单元残余（含簿记；簿记殿后）。
      const plain = archivePlainMainPath(l.unitDir, l.ledger.originalFile)
      rmSync(archiveCompressedPath(l.unitDir, l.ledger.originalFile), { force: true })
      rmSync(plain, { force: true })
      for (const sidecar of existingSidecars(plain)) unlinkSync(sidecar)
      for (const domain of ASSET_DOMAINS) {
        rmSync(archiveAssetDomainDir(l.unitDir, l.ledger.sessionId, domain), { recursive: true, force: true })
      }
      unlinkSync(restoringPath)
      ctx.warn(`[archive-self-heal] 行2 恢复已完成形态补删归档单元残余 (sessionId=${l.ledger.sessionId})`)
    } else {
      // 行 3：恢复未完成——簿记归位 + 清理 sessions/ 桶内 .tmp 残留（可重试恢复）。
      renameSync(restoringPath, archiveLedgerPath(l.unitDir, l.ledger.originalFile))
      const bucketDir = join(ctx.sessionsRoot, encodeCwd(l.ledger.cwd))
      for (const file of listDirFiles(bucketDir)) {
        if (file.endsWith('.tmp')) unlinkSync(join(bucketDir, file))
      }
      ctx.warn(`[archive-self-heal] 行3 恢复未完成形态簿记归位，可重试恢复 (sessionId=${l.ledger.sessionId})`)
    }
  } catch (e: unknown) {
    ctx.warn(`[archive-self-heal] .restoring 归位失败（下次启动重试）(sessionId=${l.ledger.sessionId}): ${toMessage(e)}`)
  }
}

/**
 * 行 1b：压缩收尾窗口中间态归位（staging 簿记 + 明文已删 + 压缩体在场）——崩溃落在
 * runCompression 的 unlinkSync(明文) 与簿记终态写入之间。归位 = 解压压缩体回明文位
 * （tmp+rename 原子写：写中途崩溃残留 `.jsonl.tmp` 由行 6 清收、下次启动重跑本行），
 * 成功后由调用方重做压缩任务——摘要与校验值经生产链重算，簿记终态字段不降级。
 *
 * 判定边界：压缩体也不在 = 行 5 形态（归档物部分缺失），返回 false 保持条目可见可重试。
 * staging 簿记无 sha256 可校验，损坏压缩体可能解出部分内容——解压/写盘失败时保持
 * staging 原样（不半途改写簿记），失败显式 warn 出声。
 *
 * 返回 true = 明文已回场（调用方继续重做压缩）；false = 保持原状（条目仍 staging）。
 */
function restorePlainFromCompressed(ctx: HealContext, l: LocatedLedger, plainPath: string): boolean {
  const compressedPath = archiveCompressedPath(l.unitDir, l.ledger.originalFile)
  if (!existsSync(compressedPath)) return false
  const tmp = tmpPathOf(plainPath)
  try {
    const restored = zstdDecompressSync(readFileSync(compressedPath))
    try {
      writeFileSync(tmp, restored)
      renameSync(tmp, plainPath)
    } catch (e: unknown) {
      try {
        unlinkSync(tmp)
      } catch {
        void 0 // 清理失败不掩盖原错误
      }
      throw e
    }
  } catch (e: unknown) {
    ctx.warn(`[archive-self-heal] 行1b 解压回明文位失败（条目保持 staging，下次启动重试）(sessionId=${l.ledger.sessionId}): ${toMessage(e)}`)
    return false
  }
  ctx.warn(`[archive-self-heal] 行1b 压缩收尾窗口中间态归位：明文已回场，重做压缩任务 (sessionId=${l.ledger.sessionId})`)
  return true
}

/**
 * 行 4：无簿记的孤儿文件归位。识别 = 归档桶内既非簿记（.archive.json/.restoring）也非
 * assets/ 的文件；以其中的明文主文件（.jsonl）为锚——读首行 header 取 sessionId（id
 * 权威来源同扫描侧口径），对照 sessions/ 同名主文件：
 * - 不存在（归档已生效）→ 补写 staging 簿记（assets/ 孤儿随簿记归属该单元）；header.id
 *   非 pi 会话 id 形态先拒绝（穿越形态一经簿记固化即流向 assets/ 分区与 purge 删除
 *   原语）——跳过 + warn、不写簿记；
 * - 存在（归档未生效）→ 孤儿文件（主文件 + 旁挂）搬回 sessions/ 原位。
 * 无 .jsonl 锚的孤儿（纯旁挂/附件且 sessions/ 侧无主文件 = 数据已缺失）跳过并 warn——
 * 无 sessionId 可归属，超出自愈能力面。
 *
 * 结构 = 主循环（识别锚 + 分派）+ 两分支提取（moveOrphanBackToOriginal 搬回 /
 * writeOrphanStagingLedger 补写）——拆分只为单函数分支数受控，判定与 warn 文案不变。
 */
function healOrphanFiles(ctx: HealContext, located: LocatedLedger[]): void {
  const knownLedgers = new Set(located.map((l) => archiveLedgerPath(l.unitDir, l.ledger.originalFile)))
  const knownRestoring = new Set(located.map((l) => archiveRestoringPath(l.unitDir, l.ledger.originalFile)))
  for (const unitDir of listDirs(ctx.archiveRoot)) {
    const orphans = listDirFiles(unitDir).filter(
      (file) =>
        !file.endsWith('.archive.json') &&
        !file.endsWith('.restoring') &&
        !file.endsWith('.tmp') && // tmp 残留归行 6
        file !== 'assets',
    )
    if (orphans.length === 0) continue
    const plainName = orphans.find(
      (f) => f.endsWith('.jsonl') && !SESSION_SIDECAR_EXTS.some((ext) => f.endsWith(ext)),
    )
    if (plainName === undefined) {
      ctx.warn(`[archive-self-heal] 行4 孤儿文件无明文主文件锚，跳过（无 sessionId 可归属）: ${join(unitDir, orphans[0])}`)
      continue
    }
    const plainPath = join(unitDir, plainName)
    const header = parseSessionHeader(plainPath)
    if (header?.id === undefined || header?.cwd === undefined) {
      ctx.warn(`[archive-self-heal] 行4 孤儿主文件 header 不可读，跳过: ${plainPath}`)
      continue
    }
    const originalMain = sessionOriginalPath(ctx.sessionsRoot, header.cwd, plainName)
    if (existsSync(originalMain)) {
      // 归档未生效：孤儿（主文件 + 旁挂）搬回原位。
      moveOrphanBackToOriginal(ctx, plainPath, originalMain, plainName, header.id)
      continue
    }
    // 归档已生效：补写 staging 簿记（已有簿记的桶不进孤儿分支，双保险查重）。
    // header.id 读自磁盘 JSONL 首行（非 pi 来源文件可含任意值），写簿记前过 pi 会话
    // id 同域校验——非法 id 一经簿记固化即流向 assets/ 分区与 purge 的 rmSync 破坏性
    // 原语（防穿越）；不过 = 跳过该孤儿 + warn，不写簿记（同「无 sessionId 可归属，
    // 超出自愈能力面」形态，磁盘事实保留待人工处置）。
    if (!isPiSessionId(header.id)) {
      ctx.warn(`[archive-self-heal] 行4 孤儿主文件 header.id 非 pi 会话 id 形态，跳过（不写簿记，待人工处置）: ${plainPath} (id=${JSON.stringify(header.id)})`)
      continue
    }
    const ledgerPath = archiveLedgerPath(unitDir, plainName)
    if (knownLedgers.has(ledgerPath) || knownRestoring.has(archiveRestoringPath(unitDir, plainName))) continue
    writeOrphanStagingLedger(ctx, unitDir, plainPath, plainName, ledgerPath, header)
  }
}

/** 行 4 分支 A：归档未生效——孤儿（主文件 + 旁挂）搬回 sessions/ 原位。 */
function moveOrphanBackToOriginal(
  ctx: HealContext,
  plainPath: string,
  originalMain: string,
  plainName: string,
  sessionId: string,
): void {
  try {
    renameSync(plainPath, originalMain)
    for (const ext of SESSION_SIDECAR_EXTS) {
      const sidecar = plainPath + ext
      if (existsSync(sidecar)) renameSync(sidecar, originalMain + ext)
    }
    ctx.warn(`[archive-self-heal] 行4 归档未生效，孤儿文件搬回原位: ${plainName} (sessionId=${sessionId})`)
  } catch (e: unknown) {
    ctx.warn(`[archive-self-heal] 行4 孤儿搬回失败（下次启动重试）: ${plainPath}: ${toMessage(e)}`)
  }
}

/** 行 4 分支 B：归档已生效——补写 staging 簿记（写侧走 writeLedgerAtomic 单点原语）。 */
function writeOrphanStagingLedger(
  ctx: HealContext,
  unitDir: string,
  plainPath: string,
  plainName: string,
  ledgerPath: string,
  header: { id: string; cwd: string },
): void {
  try {
    const staging: ArchiveLedgerStaging = {
      sessionId: header.id,
      name: extractSessionName(plainPath) ?? '',
      originalFile: plainName,
      cwd: header.cwd,
      archivedAt: new Date().toISOString(),
      rawBytes: statSync(plainPath).size,
      status: 'staging',
      summary: null,
    }
    // 原子写（tmp+rename，archive-paths 单点原语）——补写目标是新文件，但半截簿记
    // 会让 scanLedgers parse 失败跳过、条目不可见需人工处置，原子性照常必要（C-data-11）。
    writeLedgerAtomic(ledgerPath, staging)
    ctx.warn(`[archive-self-heal] 行4 补写 staging 簿记（按完成归档处理）(sessionId=${header.id})`)
  } catch (e: unknown) {
    ctx.warn(`[archive-self-heal] 行4 补写簿记失败（下次启动重试）: ${ledgerPath}: ${toMessage(e)}`)
  }
}

/** 行 6：两树内 *.tmp 残留清理（压缩 `.zst.tmp` / 解压与行 1b `.jsonl.tmp` / 簿记 `.archive.json.tmp` 的中断兜底）。 */
function cleanupTmpResidues(ctx: HealContext): void {
  for (const root of [ctx.archiveRoot, ctx.sessionsRoot]) {
    for (const dir of listDirs(root)) {
      for (const file of listDirFiles(dir)) {
        if (!file.endsWith('.tmp')) continue
        const p = join(dir, file)
        try {
          unlinkSync(p)
          ctx.warn(`[archive-self-heal] 行6 清理 tmp 残留: ${p}`)
        } catch (e: unknown) {
          ctx.warn(`[archive-self-heal] 行6 tmp 清理失败: ${p}: ${toMessage(e)}`)
        }
      }
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** 一级子目录列举（根不存在 = 从未归档/落盘的合法空态）。 */
function listDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => join(root, ent.name))
  } catch {
    return []
  }
}

/** 目录文件名列举（ENOENT = 空态；其余失败上抛由调用方 catch）。 */
function listDirFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
