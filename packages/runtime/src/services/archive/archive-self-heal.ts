/**
 * 归档启动自愈（session-archive 设计 D5 自愈六行表）——覆盖全部中间态：
 * archive/unarchive 态自动归位，purge 态保持可见可重试（破坏性动作只经用户显式触发）。
 *
 * | 启动时发现 | 判定 | 归位动作 |
 * |---|---|---|
 * | staging 簿记 + 明文 .jsonl 在归档目录 | 压缩未完成 | 重做后台压缩任务 |
 * | `.restoring` 簿记 + sessions/ 原路径主文件已存在 | 恢复已完成（崩溃在删单元前） | 补删归档单元残余（含簿记） |
 * | `.restoring` 簿记 + 原路径主文件不存在 | 恢复未完成 | 簿记 rename 回 .archive.json，清理 sessions/ 下 .tmp 残留 |
 * | 归档目录内无簿记的孤儿文件 | 归档进行到一半 | 读孤儿明文首行 header 取 sessionId：sessions/ 无主文件 → 补写 staging 簿记；有 → 孤儿搬回原位 |
 * | 簿记在 + 归档物部分缺失 / 残树已删 | purge 进行到一半 | 条目保持可见（簿记在即列表在），不自动补删——重试 purge 幂等达终态 |
 * | sessions/ 与 archive/ 两树内 *.tmp 残留 | 压缩/解压中断 | 直接清理 |
 *
 * 独立模块的原因：六行表是纯磁盘事实驱动的恢复逻辑，与服务编排（三操作）变化原因
 * 不同；经 HealContext 注入压缩任务派发口（服务持有在途任务表），不自持状态。
 */
import { existsSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeCwd } from '@taiji/shared/paths'
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
  // 行 1：staging 簿记 + 明文在 → 重做压缩任务。
  for (const l of located) {
    if (l.restoring || l.ledger.status !== 'staging') continue
    if (!existsSync(archivePlainMainPath(l.unitDir, l.ledger.originalFile))) continue
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
 * 行 4：无簿记的孤儿文件归位。识别 = 归档桶内既非簿记（.archive.json/.restoring）也非
 * assets/ 的文件；以其中的明文主文件（.jsonl）为锚——读首行 header 取 sessionId（id
 * 权威来源同扫描侧口径），对照 sessions/ 同名主文件：
 * - 不存在（归档已生效）→ 补写 staging 簿记（assets/ 孤儿随簿记归属该单元）；
 * - 存在（归档未生效）→ 孤儿文件（主文件 + 旁挂）搬回 sessions/ 原位。
 * 无 .jsonl 锚的孤儿（纯旁挂/附件且 sessions/ 侧无主文件 = 数据已缺失）跳过并 warn——
 * 无 sessionId 可归属，超出自愈能力面。
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
      try {
        renameSync(plainPath, originalMain)
        for (const ext of SESSION_SIDECAR_EXTS) {
          const sidecar = plainPath + ext
          if (existsSync(sidecar)) renameSync(sidecar, originalMain + ext)
        }
        ctx.warn(`[archive-self-heal] 行4 归档未生效，孤儿文件搬回原位: ${plainName} (sessionId=${header.id})`)
      } catch (e: unknown) {
        ctx.warn(`[archive-self-heal] 行4 孤儿搬回失败（下次启动重试）: ${plainPath}: ${toMessage(e)}`)
      }
      continue
    }
    // 归档已生效：补写 staging 簿记（已有簿记的桶不进孤儿分支，双保险查重）。
    const ledgerPath = archiveLedgerPath(unitDir, plainName)
    if (knownLedgers.has(ledgerPath) || knownRestoring.has(archiveRestoringPath(unitDir, plainName))) continue
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
      // 一次性写（目标不存在，无原子覆盖需求；格式与 writeLedgerAtomic 一致）。
      writeFileSync(ledgerPath, `${JSON.stringify(staging, null, HEAL_LEDGER_INDENT)}\n`)
      ctx.warn(`[archive-self-heal] 行4 补写 staging 簿记（按完成归档处理）(sessionId=${header.id})`)
    } catch (e: unknown) {
      ctx.warn(`[archive-self-heal] 行4 补写簿记失败（下次启动重试）: ${ledgerPath}: ${toMessage(e)}`)
    }
  }
}

/** 行 6：两树内 *.tmp 残留清理（压缩 `.zst.tmp` / 解压 `.jsonl.tmp` 的中断兜底）。 */
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

/** 簿记 JSON 缩进（与 archive-service writeLedgerAtomic 的写入形态一致）。 */
const HEAL_LEDGER_INDENT = 2

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
