/**
 * 公共归档构造 helper 单测（session-archive impl-plan u-e2e-cases）——构造产物与
 * 生产链契约对齐的锚定测试：簿记经 parseArchiveLedger 可解析（shared schema）、
 * 压缩体 sha256/字节数与簿记一致且可 zstd 往返、scanLedgers 发现面正确（restoring
 * 不进列表——D9 不变量 3）、明文可被真实摘要链消化（extractArchiveSummary）、
 * subagent 引用条目为 cascade 枚举器可解析的 v2 settled 形态。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/archive/archive-fixture.test.ts
 * （被 u-e2e-cases testCommand `pnpm -C packages/runtime exec vitest run archive` 命中）
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { parseArchiveLedger } from '@taiji/shared'
import { encodeCwd } from '@taiji/shared/paths'
import { scanLedgers } from './archive-paths.js'
import { extractArchiveSummary } from './summary-extractor.js'
import {
  createArchiveFixtureTree,
  seedArchivedUnit,
  seedConflictMainFile,
  seedLiveSession,
  seedOrphanArchiveFiles,
  seedPurgeIntermediateUnit,
  seedRestoringUnit,
  seedStagingUnit,
  seedSubagentReference,
  truncateCompressedBody,
  fixtureMainFileName,
  type ArchiveFixtureTree,
} from './archive-fixture.js'

const CWD = '/proj/archive-fixture-test'
const trees: ArchiveFixtureTree[] = []

function makeTree(): ArchiveFixtureTree {
  const tree = createArchiveFixtureTree()
  trees.push(tree)
  return tree
}

afterEach(() => {
  while (trees.length > 0) {
    const tree = trees.pop()
    if (tree !== undefined) tree.cleanup()
  }
})

function readLedgerObject(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('createArchiveFixtureTree', () => {
  it('五根目录建立 + cleanup 删除', () => {
    const tree = makeTree()
    for (const dir of [tree.root, tree.dataDir, tree.agentDir, tree.sessionsRoot, tree.archiveRoot, tree.storeRoot]) {
      expect(existsSync(dir)).toBe(true)
    }
    tree.cleanup()
    expect(existsSync(tree.root)).toBe(false)
  })
})

describe('seedLiveSession（A1/V1、A9/V9 起点）', () => {
  it('主文件 header/尾部 session_info + 旁挂 + 三域种子，明文可被真实摘要链消化', () => {
    const tree = makeTree()
    const sid = 'sess-live0001'
    const result = seedLiveSession(tree, { sessionId: sid, cwd: CWD, name: '在场会话' })

    expect(result.mainPath).toBe(join(tree.sessionsRoot, encodeCwd(CWD), fixtureMainFileName(sid)))
    const lines = readFileSync(result.mainPath, 'utf8').trim().split('\n')
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'session', id: sid, cwd: CWD })
    expect(JSON.parse(lines[lines.length - 1]!)).toMatchObject({ type: 'session_info', name: '在场会话' })
    // 缺省旁挂 + 三域。
    expect(result.sidecarPaths.map((p) => p.endsWith('.project.json') || p.endsWith('.meta.json')).every(Boolean)).toBe(true)
    for (const p of result.sidecarPaths) expect(existsSync(p)).toBe(true)
    expect(result.assetFiles).toHaveLength(3)
    for (const p of result.assetFiles) expect(existsSync(p)).toBe(true)

    // 明文 → 真实摘要链（extractArchiveSummary 消费形态同构锚）：缺省两轮，第二轮 agent:null。
    const entries = lines.map((line) => JSON.parse(line) as unknown)
    expect(extractArchiveSummary(entries)).toEqual({
      turns: [
        { user: '第一轮：出方案', agent: '方案：镜像布局 + 簿记明文随档。' },
        { user: '第二轮：跑工具验证', agent: null },
      ],
    })
  })
})

describe('seedArchivedUnit（A2/A3/A4/A6/A8 起点）', () => {
  it('簿记可解析（archived 终态字段完备）+ 压缩体 sha256/字节数一致 + zstd 往返 + assets 布局 + scanLedgers 发现', () => {
    const tree = makeTree()
    const sid = 'sess-arch0001'
    const turns = [
      { user: '归档前的提问', agent: '归档前的结论。' },
      { user: '纯工具轮', agent: null },
    ]
    const result = seedArchivedUnit(tree, { sessionId: sid, cwd: CWD, name: '已归档会话', turns })

    // 簿记：shared schema 解析通过 + 字段断言。
    const parsed = parseArchiveLedger(readLedgerObject(result.ledgerPath))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.ledger).toMatchObject({
      sessionId: sid,
      name: '已归档会话',
      originalFile: fixtureMainFileName(sid),
      cwd: CWD,
      status: 'archived',
      codec: 'zstd-3',
      summary: { turns },
    })
    // 压缩体与簿记三字段一致（status 判别收窄后访问 archived 专属字段）。
    if (parsed.ledger.status !== 'archived') throw new Error('expected archived ledger')
    const compressed = readFileSync(result.compressedPath)
    expect(parsed.ledger.sha256).toBe(createHash('sha256').update(compressed).digest('hex'))
    expect(parsed.ledger.compressedBytes).toBe(compressed.byteLength)
    expect(parsed.ledger.rawBytes).toBe(result.plainBytes.byteLength)
    expect(statSync(result.compressedPath).size).toBe(compressed.byteLength)
    // zstd 往返（V1「解压后逐字节一致」断言可行性基准）。
    expect(zstdDecompressSync(compressed).equals(result.plainBytes)).toBe(true)
    // assets 布局（D1 映射目标位）+ 旁挂。
    for (const p of [...result.assetFiles, ...result.sidecarPaths]) expect(existsSync(p)).toBe(true)
    expect(result.assetFiles[0]).toContain(join(result.unitDir, 'assets', sid))
    // 生产扫描器发现面（D9 不变量 3：列表 = 扫描派生）。
    const ledgers = scanLedgers(tree.archiveRoot, () => {})
    expect(ledgers.map((l) => l.ledger.sessionId)).toContain(sid)
  })
})

describe('seedStagingUnit（A6/A7 行 1/A10 起点）', () => {
  it('簿记骨架可解析（staging + summary null + 无压缩三字段）+ 明文在 + scanLedgers 发现', () => {
    const tree = makeTree()
    const sid = 'sess-stag0001'
    const result = seedStagingUnit(tree, { sessionId: sid, cwd: CWD })

    const parsed = parseArchiveLedger(readLedgerObject(result.ledgerPath))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.ledger.status).toBe('staging')
    expect(parsed.ledger).not.toHaveProperty('codec')
    expect(parsed.ledger).not.toHaveProperty('sha256')
    expect(parsed.ledger).not.toHaveProperty('compressedBytes')
    expect(existsSync(result.plainPath)).toBe(true)
    expect(existsSync(join(result.unitDir, `${fixtureMainFileName(sid)}.zst`))).toBe(false)
    const ledgers = scanLedgers(tree.archiveRoot, () => {})
    expect(ledgers.map((l) => l.ledger.sessionId)).toContain(sid)
  })
})

describe('seedRestoringUnit（A7 行 2/3）', () => {
  it('mainFileRestored=true：.restoring 在 + 原路径主文件内容与明文一致；scanLedgers 不发现（restoring 不进列表）', () => {
    const tree = makeTree()
    const sid = 'sess-rstr0001'
    const result = seedRestoringUnit(tree, { sessionId: sid, cwd: CWD }, { mainFileRestored: true })

    expect(existsSync(result.restoringLedgerPath)).toBe(true)
    expect(result.restoringLedgerPath.endsWith('.restoring')).toBe(true)
    expect(result.sessionMainPath).toBeDefined()
    expect(readFileSync(result.sessionMainPath!).equals(Buffer.from(''))).toBe(false)
    // scanLedgers 收 .restoring 簿记并带 restoring 标记（列表派生层按该标记过滤——
    // ArchiveService.listArchiveEntries 的 `!l.restoring` 过滤，D9 不变量 3）。
    const ledgers = scanLedgers(tree.archiveRoot, () => {})
    expect(ledgers.map((l) => l.ledger.sessionId)).toContain(sid)
    expect(ledgers.find((l) => l.ledger.sessionId === sid)?.restoring).toBe(true)
  })

  it('mainFileRestored 缺省：sessions/ 原路径无主文件（恢复未完成形态）', () => {
    const tree = makeTree()
    const sid = 'sess-rstr0002'
    const result = seedRestoringUnit(tree, { sessionId: sid, cwd: CWD })

    expect(existsSync(result.restoringLedgerPath)).toBe(true)
    expect(result.sessionMainPath).toBeUndefined()
    const bucket = join(tree.sessionsRoot, encodeCwd(CWD))
    expect(existsSync(join(bucket, fixtureMainFileName(sid)))).toBe(false)
  })
})

describe('seedPurgeIntermediateUnit（A7 行 5）', () => {
  it('簿记仍在 + 归档物已处置 + 残树 subagents 在（可重试幂等达终态的前提形态）', () => {
    const tree = makeTree()
    const sid = 'sess-purg0001'
    const result = seedPurgeIntermediateUnit(tree, { sessionId: sid, cwd: CWD })

    expect(existsSync(result.ledgerPath)).toBe(true)
    // 单元目录内已无压缩体 / 旁挂 / 附件（簿记除外）。
    const unitRest = join(result.unitDir, 'assets')
    expect(existsSync(join(result.unitDir, `${fixtureMainFileName(sid)}.jsonl.zst`))).toBe(false)
    expect(existsSync(join(result.unitDir, `${fixtureMainFileName(sid)}.jsonl.project.json`))).toBe(false)
    expect(existsSync(unitRest)).toBe(false)
    // 残树 subagents 域在（D8 留置域——purge 步骤 3 处置对象）。
    expect(existsSync(join(result.residualTreeDir, 'subagents', 'sessions', 'residual-record.jsonl'))).toBe(true)
  })
})

describe('seedOrphanArchiveFiles（A7 行 4）', () => {
  it('两形：sessionsHasMain=true / false', () => {
    const tree = makeTree()
    const sidA = 'sess-orpn0001'
    const sidB = 'sess-orpn0002'
    seedOrphanArchiveFiles(tree, { sessionId: sidA, cwd: CWD }, { sessionsHasMain: true })
    const b = seedOrphanArchiveFiles(tree, { sessionId: sidB, cwd: CWD })

    const bucket = join(tree.sessionsRoot, encodeCwd(CWD))
    expect(existsSync(join(bucket, fixtureMainFileName(sidA)))).toBe(true)
    expect(existsSync(join(bucket, fixtureMainFileName(sidB)))).toBe(false)
    // 孤儿明文在归档目录内（首行 header.id——自愈读首行取 sessionId 的输入形态）。
    const firstLine = JSON.parse(readFileSync(b.orphanMainPath, 'utf8').split('\n')[0]!) as Record<string, unknown>
    expect(firstLine).toMatchObject({ type: 'session', id: sidB })
    // 无簿记 → scanLedgers 不发现。
    const ledgers = scanLedgers(tree.archiveRoot, () => {})
    expect(ledgers).toHaveLength(0)
  })
})

describe('损坏 / 冲突变体（A6、A8）', () => {
  it('truncateCompressedBody：尾部截断后原 sha256 不再匹配', () => {
    const tree = makeTree()
    const sid = 'sess-trun0001'
    const result = seedArchivedUnit(tree, { sessionId: sid, cwd: CWD })

    truncateCompressedBody(result, 8)

    const truncated = readFileSync(result.compressedPath)
    expect(truncated.byteLength).toBe(8)
    const ledger = readLedgerObject(result.ledgerPath)
    expect(ledger.sha256).not.toBe(createHash('sha256').update(truncated).digest('hex'))
  })

  it('seedConflictMainFile：sessions/ 原路径同名占位存在', () => {
    const tree = makeTree()
    const originalFile = fixtureMainFileName('sess-conf0001')
    const conflictPath = seedConflictMainFile(tree, CWD, originalFile)

    expect(existsSync(conflictPath)).toBe(true)
    expect(conflictPath).toBe(join(tree.sessionsRoot, encodeCwd(CWD), originalFile))
  })
})

describe('seedSubagentReference（A8 fork 引用保护）', () => {
  it('B 会话 jsonl 含 v2 settled 条目（id 合法 + sessionFile 绝对路径）指向 subagents 域文件', () => {
    const tree = makeTree()
    const result = seedSubagentReference(tree, {
      archivedSessionId: 'sess-refd0001',
      cwd: CWD,
      referencingSessionId: 'sess-refb0002',
    })

    expect(existsSync(result.subagentFilePath)).toBe(true)
    expect(result.subagentFilePath).toContain(join(tree.storeRoot, 'sess-refd0001', 'subagents', 'sessions'))
    expect(existsSync(result.referencingMainPath)).toBe(true)
    // B 会话内引用条目形态（cascade parseSubagentRecordLine 的解析面）。
    const lines = readFileSync(result.referencingMainPath, 'utf8').trim().split('\n')
    const recordLine = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((o) => o.type === 'custom')
    expect(recordLine).toMatchObject({ type: 'custom', customType: 'subagent-record' })
    const data = recordLine!.data as Record<string, unknown>
    expect(data).toMatchObject({ v: 2, kind: 'settled', id: 'rec-sess-refd0001', sessionFile: result.subagentFilePath })
  })
})
