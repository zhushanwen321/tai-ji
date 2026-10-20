/**
 * 归档单元路径派生（session-archive 设计 D1 镜像布局）——纯路径函数 + 簿记扫描，
 * 无 IO 副作用（扫描只读）。
 *
 * 归档根 `<agentDir>/archive/` 与 sessions/ 平级（getArchiveDir），内部镜像 sessions
 * 布局：`archive/<encodeCwd>/<原主文件名>…`；附件三目录按显式映射（源在 ext-sessions
 * 存储树内，与 sessions 树分属两棵树无法靠镜像推导，D1 映射表）：
 *
 * ```
 * <archiveRoot>/<encodeCwd>/
 *   <原主文件名>                        ← staging 期明文主文件（压缩后删除）
 *   <原主文件名>.zst                    ← 主文件压缩体（后台压缩任务产出）
 *   <原主文件名>.archive.json           ← 簿记（staging|archived 两态，D3）
 *   <原主文件名>.restoring              ← 恢复中簿记（unarchive 态标记，D9 第三态）
 *   <原主文件名>.<suffix>.json          ← 六类旁挂文件原样明文随迁
 *   assets/<sessionId>/attachments|artifacts|image-cache/
 * ```
 *
 * tmp 约定（D5：tmp+rename 原子范式）：一切中间产物 = 目标路径 + '.tmp'（压缩体
 * `.zst.tmp` / 恢复与 purge 解压 `.jsonl.tmp`），自愈表按 `*.tmp` 统一清收。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeCwd, getAttachmentsDir, getImageCacheDir, getSessionArtifactsDir, getSessionStoreDir } from '@taiji/shared/paths'
import type { ArchiveLedger } from '@taiji/shared'
import { parseArchiveLedger } from '@taiji/shared'
import { getArchiveDir } from '../../infra/pi/pi-paths.js'

/**
 * 六类旁挂后缀（与 session-lifecycle purgeSessionSidecars 的 pi 树内 6 段对齐——
 * 归档搬移面 = delete 清理面，两清单漂移即旁挂丢失/残留）。新增 sidecar 后缀时
 * 与该清理点同步。
 */
export const SESSION_SIDECAR_EXTS: readonly string[] = [
  '.meta.json',
  '.preset.json',
  '.project.json',
  '.handoff.json',
  '.agent.json',
  '.model.json',
]

/** 附件三目录映射（归档 assets/ ↔ ext-sessions 存储树原位，D1 显式映射表）。 */
export const ASSET_DOMAINS: readonly string[] = ['attachments', 'artifacts', 'image-cache']

/** 附件域的存储树原位推导（shared paths 公式；dataDir 缺省 getDataDir()）。 */
export function assetDomainSourceDir(sessionId: string, domain: string, dataDir?: string): string {
  if (domain === 'attachments') return getAttachmentsDir(sessionId, dataDir)
  if (domain === 'artifacts') return getSessionArtifactsDir(sessionId, dataDir)
  return getImageCacheDir(sessionId, dataDir)
}

// ── 归档单元路径派生（全部纯 join，无 IO）──────────────────────────────────────

/** 归档单元目录（`<archiveRoot>/<encodeCwd(cwd)>`，镜像 sessions 分桶）。 */
export function archiveUnitDir(archiveRoot: string, cwd: string): string {
  return join(archiveRoot, encodeCwd(cwd))
}

/** sessions 树原位（`<sessionsRoot>/<encodeCwd(cwd)>/<originalFile>`——恢复目标/冲突检测路径）。 */
export function sessionOriginalPath(sessionsRoot: string, cwd: string, originalFile: string): string {
  return join(sessionsRoot, encodeCwd(cwd), originalFile)
}

/** staging 期明文主文件（归档单元内，压缩任务读取源）。 */
export function archivePlainMainPath(unitDir: string, originalFile: string): string {
  return join(unitDir, originalFile)
}

/** 主文件压缩体（后台压缩任务产出）。 */
export function archiveCompressedPath(unitDir: string, originalFile: string): string {
  return join(unitDir, `${originalFile}.zst`)
}

/** 簿记（staging|archived 两态的磁盘事实源，D9 不变量 3 列表派生）。 */
export function archiveLedgerPath(unitDir: string, originalFile: string): string {
  return join(unitDir, `${originalFile}.archive.json`)
}

/** 恢复中簿记（unarchive 态标记——移出列表扫描范围，崩溃后可识别，D5 unarchive 步骤 2）。 */
export function archiveRestoringPath(unitDir: string, originalFile: string): string {
  return join(unitDir, `${originalFile}.restoring`)
}

/** 归档单元内附件域目录（`<unitDir>/assets/<sessionId>/<domain>`）。 */
export function archiveAssetDomainDir(unitDir: string, sessionId: string, domain: string): string {
  return join(unitDir, 'assets', sessionId, domain)
}

/** tmp 中间产物（目标路径 + '.tmp'——压缩/解压原子范式的统一后缀约定）。 */
export function tmpPathOf(targetPath: string): string {
  return `${targetPath}.tmp`
}

// ── 簿记扫描（只读；列表 = 扫描派生，不建独立索引，D3）─────────────────────────

/** 定位到的一个归档单元（簿记 + 所在目录；restoring 态簿记的 ledger 从 .restoring 文件读回）。 */
export interface LocatedLedger {  // oe-exempt:20261020:wip:归档域内部形态类型（fixture/seed/context 描述），单实现为当前形态——30 天窗口内联或等第二变体
  /** 簿记文件绝对路径（.archive.json 或 .restoring 形态）。 */
  ledgerPath: string
  /** 归档单元目录（encodeCwd 桶）。 */
  unitDir: string
  ledger: ArchiveLedger
  /** 恢复中标记（.restoring 后缀形态，D9 第三态）。 */
  restoring: boolean
}

/** 归档根缺省值（构造注入缺省参数用；测试注入 tmp 目录）。 */
export function defaultArchiveRoot(): string {
  return getArchiveDir()
}

/** 存储树根缺省值（同上）。 */
export function defaultSessionStoreRoot(): string {
  return getSessionStoreDir()
}

/**
 * 扫描归档根的全部簿记（`archive/<encodeCwd>/*.archive.json` 与 `*.restoring`）。
 *
 * 损坏簿记（parse 失败）跳过并 warn——扫描是列表与查找的唯一数据源，单条损坏不得
 * 毒死整表（同 SessionScanner「目录即事实源」哲学）；损坏条目保持磁盘事实待人工处置。
 */
export function scanLedgers(archiveRoot: string, warn: (message: string) => void): LocatedLedger[] {
  const located: LocatedLedger[] = []
  let buckets: string[]
  try {
    buckets = readdirSync(archiveRoot, { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => join(archiveRoot, ent.name))
  } catch {
    return located // 归档根不存在 = 从未归档的合法空态
  }
  for (const unitDir of buckets) {
    let files: string[]
    try {
      files = readdirSync(unitDir)
    } catch (e: unknown) {
      warn(`[archive] 归档桶目录不可读，跳过: ${unitDir} (${e instanceof Error ? e.message : String(e)})`)
      continue
    }
    for (const file of files) {
      const restoring = file.endsWith('.restoring')
      if (!file.endsWith('.archive.json') && !restoring) continue
      const ledgerPath = join(unitDir, file)
      const parsed = readLedgerFile(ledgerPath)
      if (parsed === null) {
        warn(`[archive] 簿记损坏或不可读，跳过（磁盘事实保留，待人工处置）: ${ledgerPath}`)
        continue
      }
      located.push({ ledgerPath, unitDir, ledger: parsed, restoring })
    }
  }
  return located
}

/** 按 sessionId 查找簿记（三操作与自愈的定位入口；返回第一条匹配——同一 sessionId 簿记唯一）。 */
export function findLedgerBySessionId(archiveRoot: string, sessionId: string, warn: (message: string) => void): LocatedLedger | null {
  return scanLedgers(archiveRoot, warn).find((l) => l.ledger.sessionId === sessionId) ?? null
}

/** 读单个簿记文件（损坏/不可读返回 null，不抛——调用方决定跳过或按损坏上报）。 */
export function readLedgerFile(ledgerPath: string): ArchiveLedger | null {
  let raw: string
  try {
    raw = readFileSync(ledgerPath, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const result = parseArchiveLedger(parsed)
  return result.ok ? result.ledger : null
}

/** 旁挂文件存在清单（归档单元内按六类后缀探测；搬移/恢复/清理共用）。 */
export function existingSidecars(mainPath: string): string[] {
  return SESSION_SIDECAR_EXTS.map((ext) => mainPath + ext).filter((p) => existsSync(p))
}
