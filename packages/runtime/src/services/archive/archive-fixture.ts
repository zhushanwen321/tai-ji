/**
 * 公共归档构造 helper（session-archive 设计 impl-plan u-e2e-cases）——归档单元磁盘
 * fixture 一键构造：簿记 / 压缩体 / 旁挂 / 附件树（+ 自愈中间态 / 引用族 / 损坏变体）。
 *
 * 消费方 = archive-fixture.test.ts（生产契约锚）；D3 验收如需独立 L3 剧本可复用本
 * helper。构造产物对齐生产链消费形态：
 * - 簿记字段严格按 @taiji/shared ArchiveLedger schema（parseArchiveLedger 可解析，
 *   archive-fixture.test.ts 锚定）；
 * - 压缩体 = zstdCompressSync(level 3)（D2 现行编码），sha256 为压缩体真实 hash；
 * - 明文 JSONL 行形态与 summary-extractor 消费面同构（header + message entry 对 +
 *   尾部 session_info——extractArchiveSummary 可直接消化，真归档链可重放）；
 * - subagent 引用条目 = subagent-record v2 settled 形态（cascade 枚举器可解析）。
 *
 * 路径形态复用 archive-paths.ts 的既有函数（不重复公式）。写删纪律：树根
 * mkdtempSync 自建，cleanup() 自删（flake 规范：rmSync 带 maxRetries）。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, constants as zlibConstants } from 'node:zlib'
import { encodeCwd } from '@taiji/shared/paths'
import { SUBAGENT_RECORD_CUSTOM_TYPE, SUBAGENT_RECORD_ENTRY_VERSION } from '@zhushanwen/subagent-core'
import {
  ASSET_DOMAINS,
  archiveAssetDomainDir,
  archiveCompressedPath,
  archiveLedgerPath,
  archivePlainMainPath,
  archiveRestoringPath,
  archiveUnitDir,
  sessionOriginalPath,
} from './archive-paths.js'

/** 主文件名 ISO 时间戳段固定值（确定性 fixture：同输入恒同名，D4 可重放同精神）。 */
export const FIXTURE_MAIN_TIMESTAMP = '2026-10-20T00-00-00-000Z'

/** fixture 归档时刻（header timestamp 与簿记 archivedAt 共用——ISO 毫秒形态）。 */
export const FIXTURE_ARCHIVED_AT = '2026-10-20T00:00:00.000Z'

/** 簿记 JSON 缩进（archive-service.ts LEDGER_INDENT 同款口径）。 */
const LEDGER_INDENT = 2

/** 对话 turn 种子（生成明文 user/assistant message entry 对）。 */
export interface ArchiveTurnSeed {  // oe-exempt:20261020:wip:归档域内部形态类型（fixture/seed/context 描述），单实现为当前形态——30 天窗口内联或等第二变体
  /** 用户消息文本（string 形态 message.content）。 */
  user: string
  /** agent 文本（生成 assistant text 块）；null = 构造「以工具调用结束」边界 turn。 */
  agent: string | null
}

/** session 种子公共面（live / archived / staging / restoring 各形态共用）。 */
export interface ArchiveSessionSeed {  // oe-exempt:20261020:wip:归档域内部形态类型（fixture/seed/context 描述），单实现为当前形态——30 天窗口内联或等第二变体
  sessionId: string
  cwd: string
  /** 会话名（明文尾部 session_info 与簿记 name 双写）；缺省 `会话-${sessionId}`。 */
  name?: string
  /** 对话轮次；缺省含一个 agent:null 边界的两轮（摘要占位形态可断言）。 */
  turns?: ArchiveTurnSeed[]
  /** 旁挂后缀清单；缺省 ['.project.json', '.meta.json']。 */
  sidecars?: string[]
  /** 附件域清单；缺省三域全建（每域一个种子文件）。 */
  assetDomains?: readonly string[]
}

/** 缺省 turn 序列：两轮，第二轮为「以工具调用结束」边界（agent:null）。 */
const DEFAULT_TURNS: readonly ArchiveTurnSeed[] = [
  { user: '第一轮：出方案', agent: '方案：镜像布局 + 簿记明文随档。' },
  { user: '第二轮：跑工具验证', agent: null },
]

/** 缺省旁挂（project 归属 + 终态——V4 恢复还原断言的两个权威源）。 */
const DEFAULT_SIDECARS: readonly string[] = ['.project.json', '.meta.json']

// ── fixture 树 ────────────────────────────────────────────────────────────────

/** 归档域 fixture 目录树（dataDir/agentDir/sessions/archive/ext-sessions 五根）。 */
export interface ArchiveFixtureTree {  // oe-exempt:20261020:wip:归档域内部形态类型（fixture/seed/context 描述），单实现为当前形态——30 天窗口内联或等第二变体
  readonly root: string
  readonly dataDir: string
  readonly agentDir: string
  readonly sessionsRoot: string
  readonly archiveRoot: string
  readonly storeRoot: string
  /** 删除整个树（rmSync recursive + maxRetries）。 */
  cleanup(): void
}

/** 建 fixture 树（mkdtemp tmp 根；调用方负责 cleanup）。 */
export function createArchiveFixtureTree(prefix = 'taiji-archive-fx-'): ArchiveFixtureTree {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const agentDir = join(root, 'agent')
  const tree: ArchiveFixtureTree = {
    root,
    dataDir: root,
    agentDir,
    sessionsRoot: join(agentDir, 'sessions'),
    archiveRoot: join(agentDir, 'archive'),
    storeRoot: join(root, 'ext-sessions'),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
  mkdirSync(tree.sessionsRoot, { recursive: true })
  mkdirSync(tree.archiveRoot, { recursive: true })
  mkdirSync(tree.storeRoot, { recursive: true })
  return tree
}

// ── 明文 JSONL 构造（live / staging / orphan 共用）────────────────────────────

/** 主文件名（`<ISO时间戳>_<sessionId>.jsonl`——真实命名形态）。 */
export function fixtureMainFileName(sessionId: string): string {
  return `${FIXTURE_MAIN_TIMESTAMP}_${sessionId}.jsonl`
}

/** turn 种子 → 明文 JSONL 行（header + message 对 + 尾部 session_info）。 */
function buildJsonlLines(seed: ArchiveSessionSeed): string[] {
  const lines: string[] = [JSON.stringify({ type: 'session', id: seed.sessionId, cwd: seed.cwd, timestamp: FIXTURE_ARCHIVED_AT })]
  for (const turn of seed.turns ?? DEFAULT_TURNS) {
    lines.push(JSON.stringify({ type: 'message', message: { role: 'user', content: turn.user } }))
    if (turn.agent !== null) {
      lines.push(JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: turn.agent }] } }))
    }
  }
  lines.push(JSON.stringify({ type: 'session_info', name: seed.name ?? `会话-${seed.sessionId}` }))
  return lines
}

/** 建旁挂文件（mainPath + 后缀，写 `{}` 占位——恢复还原断言只判存在与往返）。 */
function writeSidecars(mainPath: string, sidecars: readonly string[] | undefined): string[] {
  const paths: string[] = []
  for (const ext of sidecars ?? DEFAULT_SIDECARS) {
    const p = `${mainPath}${ext}`
    writeFileSync(p, '{}\n')
    paths.push(p)
  }
  return paths
}

/** 建附件域种子文件（storeRoot/<sessionId>/<domain>/item-<domain>.dat）。 */
function seedStoreAssetDomains(
  storeRoot: string,
  sessionId: string,
  domains: readonly string[] | undefined,
): string[] {
  const files: string[] = []
  for (const domain of domains ?? ASSET_DOMAINS) {
    const dir = join(storeRoot, sessionId, domain)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `item-${domain}.dat`)
    writeFileSync(file, `asset-bytes-${sessionId}-${domain}`)
    files.push(file)
  }
  return files
}

/** 建归档单元内附件域（assets/<sessionId>/<domain>/item-<domain>.dat，D1 映射目标位）。 */
function seedArchiveAssetDomains(
  unitDir: string,
  sessionId: string,
  domains: readonly string[] | undefined,
): string[] {
  const files: string[] = []
  for (const domain of domains ?? ASSET_DOMAINS) {
    const dir = archiveAssetDomainDir(unitDir, sessionId, domain)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `item-${domain}.dat`)
    writeFileSync(file, `asset-bytes-${sessionId}-${domain}`)
    files.push(file)
  }
  return files
}

// ── 在场 session（A1/V1、A9/V9 起点）──────────────────────────────────────────

/** seedLiveSession 产物。 */
export interface LiveSessionSeedResult {  // oe-exempt:20261020:wip:归档域内部形态类型（fixture/seed/context 描述），单实现为当前形态——30 天窗口内联或等第二变体
  /** sessions/ 主文件全路径。 */
  mainPath: string
  originalFile: string
  sidecarPaths: string[]
  assetFiles: string[]
}

/** 在场 session：sessions/ 主文件 + 旁挂 + ext-sessions 三域种子。 */
export function seedLiveSession(tree: ArchiveFixtureTree, seed: ArchiveSessionSeed): LiveSessionSeedResult {
  const originalFile = fixtureMainFileName(seed.sessionId)
  const mainPath = sessionOriginalPath(tree.sessionsRoot, seed.cwd, originalFile)
  mkdirSync(join(tree.sessionsRoot, encodeCwd(seed.cwd)), { recursive: true })
  writeFileSync(mainPath, `${buildJsonlLines(seed).join('\n')}\n`)
  return {
    mainPath,
    originalFile,
    sidecarPaths: writeSidecars(mainPath, seed.sidecars),
    assetFiles: seedStoreAssetDomains(tree.storeRoot, seed.sessionId, seed.assetDomains),
  }
}

// ── archived 完成态单元（A2/V2、A3/V3、A4/V4、A6/V6、A8/V8 起点）──────────────

/** seedArchivedUnit 产物。 */
export interface ArchivedUnitSeedResult {  // oe-exempt:20261020:wip:归档域内部形态类型（fixture/seed/context 描述），单实现为当前形态——30 天窗口内联或等第二变体
  unitDir: string
  originalFile: string
  /** 归档前明文字节（V1「解压后逐字节一致」断言基准）。 */
  plainBytes: Buffer
  compressedPath: string
  ledgerPath: string
  sidecarPaths: string[]
  assetFiles: string[]
}

/** archived 完成态归档单元：压缩体 + 簿记终态（真实 sha256/codec/compressedBytes）+ 旁挂 + assets 三域。 */
export function seedArchivedUnit(tree: ArchiveFixtureTree, seed: ArchiveSessionSeed): ArchivedUnitSeedResult {
  const originalFile = fixtureMainFileName(seed.sessionId)
  const plainBytes = Buffer.from(`${buildJsonlLines(seed).join('\n')}\n`, 'utf8')
  // D2 level 3；params 显式传 ZSTD_c_compressionLevel（与 archive-service.ts 压缩任务
  // 同形态——@types/node 的 ZstdOptions 无 level 简写）。
  const compressed = zstdCompressSync(plainBytes, {
    params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 },
  })
  const unitDir = archiveUnitDir(tree.archiveRoot, seed.cwd)
  mkdirSync(unitDir, { recursive: true })
  const compressedPath = archiveCompressedPath(unitDir, originalFile)
  writeFileSync(compressedPath, compressed)
  const plainNamePath = archivePlainMainPath(unitDir, originalFile)
  const sidecarPaths = writeSidecars(plainNamePath, seed.sidecars)
  const ledgerPath = archiveLedgerPath(unitDir, originalFile)
  writeFileSync(ledgerPath, `${JSON.stringify(
    {
      sessionId: seed.sessionId,
      name: seed.name ?? `会话-${seed.sessionId}`,
      originalFile,
      cwd: seed.cwd,
      archivedAt: FIXTURE_ARCHIVED_AT,
      rawBytes: plainBytes.byteLength,
      status: 'archived',
      codec: 'zstd-3',
      compressedBytes: compressed.byteLength,
      sha256: createHash('sha256').update(compressed).digest('hex'),
      summary: { turns: [...(seed.turns ?? DEFAULT_TURNS)] },
    },
    null,
    LEDGER_INDENT,
  )}\n`)
  return {
    unitDir,
    originalFile,
    plainBytes,
    compressedPath,
    ledgerPath,
    sidecarPaths,
    assetFiles: seedArchiveAssetDomains(unitDir, seed.sessionId, seed.assetDomains),
  }
}

// ── staging 态单元（A6/V6、A7/V7 行 1、A10/V10）──────────────────────────────

/** seedStagingUnit 产物。 */
export interface StagingUnitSeedResult {  // oe-exempt:20261020:wip:归档域内部形态类型（fixture/seed/context 描述），单实现为当前形态——30 天窗口内联或等第二变体
  unitDir: string
  originalFile: string
  /** 归档目录内明文主文件全路径（后台压缩任务的输入）。 */
  plainPath: string
  ledgerPath: string
  sidecarPaths: string[]
  assetFiles: string[]
}

/** staging 态归档单元：明文 .jsonl 在 + 簿记骨架（status staging、summary null、无压缩三字段）。 */
export function seedStagingUnit(tree: ArchiveFixtureTree, seed: ArchiveSessionSeed): StagingUnitSeedResult {
  const originalFile = fixtureMainFileName(seed.sessionId)
  const unitDir = archiveUnitDir(tree.archiveRoot, seed.cwd)
  mkdirSync(unitDir, { recursive: true })
  const plainPath = archivePlainMainPath(unitDir, originalFile)
  const plainBytes = Buffer.from(`${buildJsonlLines(seed).join('\n')}\n`, 'utf8')
  writeFileSync(plainPath, plainBytes)
  const sidecarPaths = writeSidecars(plainPath, seed.sidecars)
  const ledgerPath = archiveLedgerPath(unitDir, originalFile)
  writeFileSync(ledgerPath, `${JSON.stringify(
    {
      sessionId: seed.sessionId,
      name: seed.name ?? `会话-${seed.sessionId}`,
      originalFile,
      cwd: seed.cwd,
      archivedAt: FIXTURE_ARCHIVED_AT,
      rawBytes: plainBytes.byteLength,
      status: 'staging',
      summary: null,
    },
    null,
    LEDGER_INDENT,
  )}\n`)
  return {
    unitDir,
    originalFile,
    plainPath,
    ledgerPath,
    sidecarPaths,
    assetFiles: seedArchiveAssetDomains(unitDir, seed.sessionId, seed.assetDomains),
  }
}

// ── restoring 态（A7/V7 行 2/3）───────────────────────────────────────────────

/** seedRestoringUnit 产物。 */
export interface RestoringUnitSeedResult {  // oe-exempt:20261020:wip:归档域内部形态类型（fixture/seed/context 描述），单实现为当前形态——30 天窗口内联或等第二变体
  unitDir: string
  originalFile: string
  /** `.restoring` 簿记全路径。 */
  restoringLedgerPath: string
  compressedPath: string
  /** sessions/ 原路径主文件（mainFileRestored=true 时才写）。 */
  sessionMainPath: string | undefined
}

/** restoring 态：簿记 rename 为 `.restoring` + 压缩体保留。mainFileRestored 区分自愈行 2
 *（sessions/ 原路径主文件已存在——恢复已完成、崩溃在删单元前）与行 3（不存在——恢复未完成）。 */
export function seedRestoringUnit(
  tree: ArchiveFixtureTree,
  seed: ArchiveSessionSeed,
  opts: { mainFileRestored?: boolean } = {},
): RestoringUnitSeedResult {
  const archived = seedArchivedUnit(tree, seed)
  const restoringLedgerPath = archiveRestoringPath(archived.unitDir, archived.originalFile)
  renameSync(archived.ledgerPath, restoringLedgerPath)
  let sessionMainPath: string | undefined
  if (opts.mainFileRestored === true) {
    sessionMainPath = sessionOriginalPath(tree.sessionsRoot, seed.cwd, archived.originalFile)
    mkdirSync(join(tree.sessionsRoot, encodeCwd(seed.cwd)), { recursive: true })
    writeFileSync(sessionMainPath, archived.plainBytes)
  }
  return {
    unitDir: archived.unitDir,
    originalFile: archived.originalFile,
    restoringLedgerPath,
    compressedPath: archived.compressedPath,
    sessionMainPath,
  }
}

// ── purge 中间态（A7/V7 行 5）─────────────────────────────────────────────────

/** seedPurgeIntermediateUnit 产物。 */
export interface PurgeIntermediateSeedResult {  // oe-exempt:20261020:wip:归档域内部形态类型（fixture/seed/context 描述），单实现为当前形态——30 天窗口内联或等第二变体
  unitDir: string
  ledgerPath: string
  /** 残树目录（`<storeRoot>/<sessionId>/`——D8 留置域所在，purge 步骤 3 的处置对象）。 */
  residualTreeDir: string
}

/** purge 中间态：簿记仍在 + 归档物已部分处置（压缩体/旁挂/附件清空）+ 残树在——
 * 崩溃在簿记删除前（条目保持可见可重试，D9 不变量 3）。 */
export function seedPurgeIntermediateUnit(
  tree: ArchiveFixtureTree,
  seed: ArchiveSessionSeed,
): PurgeIntermediateSeedResult {
  const archived = seedArchivedUnit(tree, seed)
  for (const p of [archived.compressedPath, ...archived.sidecarPaths]) {
    rmSync(p, { force: true, maxRetries: 5, retryDelay: 20 })
  }
  // 附件整删（域目录壳一并清——「归档物已处置」的完整形态）。
  rmSync(join(archived.unitDir, 'assets'), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  const residualTreeDir = join(tree.storeRoot, seed.sessionId)
  mkdirSync(join(residualTreeDir, 'subagents', 'sessions'), { recursive: true })
  writeFileSync(join(residualTreeDir, 'subagents', 'sessions', 'residual-record.jsonl'), '{}\n')
  return { unitDir: archived.unitDir, ledgerPath: archived.ledgerPath, residualTreeDir }
}

// ── 无簿记孤儿（A7/V7 行 4）───────────────────────────────────────────────────

/** seedOrphanArchiveFiles 产物。 */
export interface OrphanSeedResult {  // oe-exempt:20261020:wip:归档域内部形态类型（fixture/seed/context 描述），单实现为当前形态——30 天窗口内联或等第二变体
  /** 归档目录内孤儿明文主文件全路径。 */
  orphanMainPath: string
}

/** 无簿记孤儿（搬移后、簿记写入前崩溃）：归档目录内明文主文件 + 旁挂。
 * sessionsHasMain 区分行 4 两分支：sessions/ 仍有主文件（归档未生效→搬回）与否
 * （按完成归档处理→补写 staging 簿记）。 */
export function seedOrphanArchiveFiles(
  tree: ArchiveFixtureTree,
  seed: ArchiveSessionSeed,
  opts: { sessionsHasMain?: boolean } = {},
): OrphanSeedResult {
  const originalFile = fixtureMainFileName(seed.sessionId)
  const unitDir = archiveUnitDir(tree.archiveRoot, seed.cwd)
  mkdirSync(unitDir, { recursive: true })
  const orphanMainPath = archivePlainMainPath(unitDir, originalFile)
  writeFileSync(orphanMainPath, `${buildJsonlLines(seed).join('\n')}\n`)
  writeSidecars(orphanMainPath, seed.sidecars)
  if (opts.sessionsHasMain === true) {
    const sessionMain = sessionOriginalPath(tree.sessionsRoot, seed.cwd, originalFile)
    mkdirSync(join(tree.sessionsRoot, encodeCwd(seed.cwd)), { recursive: true })
    writeFileSync(sessionMain, `${buildJsonlLines(seed).join('\n')}\n`)
  }
  return { orphanMainPath }
}

// ── 损坏 / 冲突 / 引用族变体（A6、A8）────────────────────────────────────────

/** 截断保留字节数（保留 zstd magic 头段 → 「尾部截断」形态：解压侧静默产出部分
 * 内容而非抛错——设计 §8 V8 变体所锚的最常见损坏形态）。 */
const TRUNCATE_KEEP_BYTES = 8

/** 尾部截断压缩体（V8 keep-all 变体：簿记 sha256 仍指原值 → 消费前校验构造性不过；
 * 任意截断方式均覆盖——sha256 覆盖压缩体全量字节，设计 §8 V8 变体断言判据）。 */
export function truncateCompressedBody(unit: { compressedPath: string }, keepBytes = TRUNCATE_KEEP_BYTES): void {
  truncateSync(unit.compressedPath, keepBytes)
}

/** sessions/ 原路径放同名占位主文件（V6 恢复冲突：archived 与 staging 态统一的前置）。 */
export function seedConflictMainFile(
  tree: ArchiveFixtureTree,
  cwd: string,
  originalFile: string,
): string {
  const conflictPath = sessionOriginalPath(tree.sessionsRoot, cwd, originalFile)
  mkdirSync(join(tree.sessionsRoot, encodeCwd(cwd)), { recursive: true })
  writeFileSync(conflictPath, `${JSON.stringify({ type: 'session', id: 'conflict-placeholder', cwd })}\n`)
  return conflictPath
}

/** seedSubagentReference 产物。 */
export interface SubagentReferenceSeedResult {  // oe-exempt:20261020:wip:归档域内部形态类型（fixture/seed/context 描述），单实现为当前形态——30 天窗口内联或等第二变体
  /** 被归档 session 名下 subagents 域的子代理会话文件（B 引用的目标，绝对路径）。 */
  subagentFilePath: string
  /** B 会话主文件全路径（sessions/ 池内——cascade 引用并集扫描的发现面）。 */
  referencingMainPath: string
}

/** fork 引用族（V8）：被归档 session 残树 subagents/sessions/ 下子代理文件 + 存活
 * B 会话 jsonl 内 subagent-record v2 settled 条目指向该文件绝对路径（cascade
 * collectAliveReferenceUnion 可解析——引用保护断言的构造前提）。 */
export function seedSubagentReference(
  tree: ArchiveFixtureTree,
  seed: {
    archivedSessionId: string
    cwd: string
    referencingSessionId: string
    /** B 会话工作目录；缺省同 cwd（同桶不同 session）。 */
    referencingCwd?: string
  },
): SubagentReferenceSeedResult {
  const subagentFilePath = join(
    tree.storeRoot,
    seed.archivedSessionId,
    'subagents',
    'sessions',
    `${FIXTURE_MAIN_TIMESTAMP}_sub-${seed.archivedSessionId}.jsonl`,
  )
  mkdirSync(join(tree.storeRoot, seed.archivedSessionId, 'subagents', 'sessions'), { recursive: true })
  writeFileSync(subagentFilePath, `${JSON.stringify({ type: 'session', id: `sub-${seed.archivedSessionId}`, cwd: seed.cwd })}\n`)

  const referencingMainPath = sessionOriginalPath(
    tree.sessionsRoot,
    seed.referencingCwd ?? seed.cwd,
    fixtureMainFileName(seed.referencingSessionId),
  )
  mkdirSync(join(tree.sessionsRoot, encodeCwd(seed.referencingCwd ?? seed.cwd)), { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session', id: seed.referencingSessionId, cwd: seed.referencingCwd ?? seed.cwd }),
    JSON.stringify({
      type: 'custom',
      customType: SUBAGENT_RECORD_CUSTOM_TYPE,
      data: {
        v: SUBAGENT_RECORD_ENTRY_VERSION,
        kind: 'settled',
        id: `rec-${seed.archivedSessionId}`,
        status: 'completed',
        sessionFile: subagentFilePath,
      },
    }),
  ]
  writeFileSync(referencingMainPath, `${lines.join('\n')}\n`)
  return { subagentFilePath, referencingMainPath }
}
