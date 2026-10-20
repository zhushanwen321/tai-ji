/**
 * 归档启动自愈六行表单测（session-archive 设计 D5 自愈清单）。
 *
 * 每行一用例（构造该中间态的磁盘事实 → healArchiveOnStartup → 断言归位动作）；
 * 压缩任务派发口经 HealContext 注入 spy（自愈只负责判定与归位，压缩执行属服务）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/archive/archive-self-heal.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeCwd } from '@taiji/shared/paths'
import type { ArchiveLedgerStaging } from '@taiji/shared'
import { healArchiveOnStartup } from './archive-self-heal.js'
import { readLedgerFile } from './archive-paths.js'

const CWD = '/proj/heal-test'
const ENC = encodeCwd(CWD)
const MAIN = '2026-10-20T00-00-00-000Z_sess-heal01.jsonl'

interface HealFixture {  // oe-exempt:20261020:wip:归档域测试 fixture 形态类型，单实现为当前形态——30 天窗口内联或等第二变体
  root: string
  archiveRoot: string
  sessionsRoot: string
  warnings: string[]
  compressed: string[]
  unitDir: string
  bucketDir: string
  sessionMainPath: string
  writeLedger(name: string, ledger: ArchiveLedgerStaging): string
  heal(): Promise<void>
}

const cleanupDirs: string[] = []

function makeFixture(): HealFixture {
  const root = mkdtempSync(join(tmpdir(), 'taiji-archive-heal-'))
  cleanupDirs.push(root)
  const archiveRoot = join(root, 'agent', 'archive')
  const sessionsRoot = join(root, 'agent', 'sessions')
  const unitDir = join(archiveRoot, ENC)
  const bucketDir = join(sessionsRoot, ENC)
  mkdirSync(unitDir, { recursive: true })
  mkdirSync(bucketDir, { recursive: true })
  const warnings: string[] = []
  const compressed: string[] = []
  const f: HealFixture = {
    root, archiveRoot, sessionsRoot, warnings, compressed, unitDir, bucketDir,
    sessionMainPath: join(bucketDir, MAIN),
    writeLedger: (name, ledger) => {
      const p = join(unitDir, name)
      writeFileSync(p, `${JSON.stringify(ledger, null, 2)}\n`)
      return p
    },
    heal: () =>
      healArchiveOnStartup({
        archiveRoot,
        sessionsRoot,
        warn: (m) => { warnings.push(m) },
        readLedgerFile,
        queueCompression: async (ledger) => { compressed.push(ledger.sessionId) },
      }),
  }
  return f
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

function stagingLedger(): ArchiveLedgerStaging {
  return {
    sessionId: 'sess-heal01',
    name: '自愈测试',
    originalFile: MAIN,
    cwd: CWD,
    archivedAt: '2026-10-20T00:00:00.000Z',
    rawBytes: 100,
    status: 'staging',
    summary: null,
  }
}

function writePlainMain(f: HealFixture, content: string): string {
  const p = join(f.unitDir, MAIN)
  writeFileSync(p, `${JSON.stringify({ type: 'session', id: 'sess-heal01', cwd: CWD })}\n${content}`)
  return p
}

describe('启动自愈六行表（D5）', () => {
  it('行 1：staging 簿记 + 明文在归档目录 → 重做后台压缩任务', async () => {
    const f = makeFixture()
    f.writeLedger(`${MAIN}.archive.json`, stagingLedger())
    writePlainMain(f, '{"type":"session_info","name":"自愈测试"}')

    await f.heal()

    expect(f.compressed).toEqual(['sess-heal01'])
  })

  it('行 2：.restoring 簿记 + sessions/ 原路径主文件已存在 → 补删归档单元残余（含簿记）', async () => {
    const f = makeFixture()
    f.writeLedger(`${MAIN}.restoring`, stagingLedger())
    writePlainMain(f, 'orphan-in-archive')
    writeFileSync(join(f.unitDir, `${MAIN}.zst`), 'compressed')
    writeFileSync(join(f.unitDir, `${MAIN}.project.json`), '{}')
    // 恢复已完成的判据：sessions/ 原路径主文件在场。
    writeFileSync(f.sessionMainPath, '{"type":"session"}')

    await f.heal()

    expect(existsSync(join(f.unitDir, MAIN))).toBe(false)
    expect(existsSync(join(f.unitDir, `${MAIN}.zst`))).toBe(false)
    expect(existsSync(join(f.unitDir, `${MAIN}.project.json`))).toBe(false)
    expect(existsSync(join(f.unitDir, `${MAIN}.restoring`))).toBe(false) // 簿记殿后清除
    expect(existsSync(f.sessionMainPath)).toBe(true) // 已恢复的主文件不动
  })

  it('行 3：.restoring 簿记 + 原路径主文件不存在 → 簿记 rename 回 .archive.json + 清 sessions/ 桶 .tmp', async () => {
    const f = makeFixture()
    f.writeLedger(`${MAIN}.restoring`, stagingLedger())
    writePlainMain(f, 'orphan-in-archive')
    const tmpResidue = join(f.bucketDir, `${MAIN}.tmp`)
    writeFileSync(tmpResidue, 'partial')

    await f.heal()

    expect(existsSync(join(f.unitDir, `${MAIN}.archive.json`))).toBe(true)
    expect(existsSync(join(f.unitDir, `${MAIN}.restoring`))).toBe(false)
    expect(existsSync(tmpResidue)).toBe(false)
    expect(existsSync(join(f.unitDir, MAIN))).toBe(true) // 归档物不动（可重试恢复）
  })

  it('行 4a：无簿记孤儿 + sessions/ 无主文件 → 补写 staging 簿记（按完成归档处理）', async () => {
    const f = makeFixture()
    writePlainMain(f, '{"type":"session_info","name":"孤儿会话"}')

    await f.heal()

    const ledger = readLedgerFile(join(f.unitDir, `${MAIN}.archive.json`))
    expect(ledger).not.toBeNull()
    expect(ledger?.status).toBe('staging')
    expect(ledger?.sessionId).toBe('sess-heal01')
    expect(ledger?.cwd).toBe(CWD)
    expect(ledger?.rawBytes).toBeGreaterThan(0)
  })

  it('行 4b：无簿记孤儿 + sessions/ 仍有主文件 → 孤儿搬回原位（归档未生效）', async () => {
    const f = makeFixture()
    writePlainMain(f, 'orphan-content')
    writeFileSync(join(f.unitDir, `${MAIN}.project.json`), '{}')
    // sessions/ 侧已有同名主文件（同名会话仍在线——归档未生效判定）。
    writeFileSync(f.sessionMainPath, '{"type":"session","id":"sess-heal01"}')

    await f.heal()

    expect(existsSync(f.sessionMainPath)).toBe(true)
    expect(readFileSync(f.sessionMainPath, 'utf8')).toContain('sess-heal01')
    expect(existsSync(join(f.unitDir, MAIN))).toBe(false)
    expect(existsSync(join(f.bucketDir, `${MAIN}.project.json`))).toBe(true) // 旁挂随主文件搬回
    expect(existsSync(join(f.unitDir, `${MAIN}.archive.json`))).toBe(false) // 不补写簿记
  })

  it('行 5：簿记在 + 归档物部分缺失 → 条目保持可见不自动补删（no-op）', async () => {
    const f = makeFixture()
    // archived 簿记 + 压缩体已移除（purge 进行到一半崩溃在簿记删除前）。
    const ledger = join(f.unitDir, `${MAIN}.archive.json`)
    writeFileSync(ledger, `${JSON.stringify({ ...stagingLedger(), status: 'archived', codec: 'zstd-3', compressedBytes: 1, sha256: 'a'.repeat(64), summary: { turns: [] } }, null, 2)}\n`)

    await f.heal()

    // 簿记原样在（条目保持可见可重试），无压缩任务派发、无删除动作。
    expect(existsSync(ledger)).toBe(true)
    expect(f.compressed).toEqual([])
  })

  it('行 6：两树内 *.tmp 残留 → 直接清理', async () => {
    const f = makeFixture()
    const archiveTmp = join(f.unitDir, `${MAIN}.zst.tmp`)
    const sessionTmp = join(f.bucketDir, `${MAIN}.tmp`)
    writeFileSync(archiveTmp, 'partial-compress')
    writeFileSync(sessionTmp, 'partial-decompress')

    await f.heal()

    expect(existsSync(archiveTmp)).toBe(false)
    expect(existsSync(sessionTmp)).toBe(false)
  })

  it('归档根不存在 = 从未归档的合法空态（零动作零报错）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'taiji-archive-heal-empty-'))
    cleanupDirs.push(root)
    await healArchiveOnStartup({
      archiveRoot: join(root, 'agent', 'archive'),
      sessionsRoot: join(root, 'agent', 'sessions'),
      warn: () => { throw new Error('不应有 warn') },
      readLedgerFile,
      queueCompression: async () => { throw new Error('不应派发压缩') },
    })
    expect(readdirSync(root)).toEqual([]) // 零目录创建、零动作
  })
})
