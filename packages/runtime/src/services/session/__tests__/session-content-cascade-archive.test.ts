/**
 * cascade 引用枚举源入参扩展的分支断言三组（session-archive 设计 D5 purgeArchive
 * 步骤 3 + §8 机器验证补充清单——u-archive-service 验收条款）。
 *
 * 三组（文件名含 archive 使 `vitest run archive` 命中——本组属 u-archive-service
 * testCommand 范围，cascade 本体的删除链测试在 session-content-cascade.test.ts）：
 * - ① 缺省形态 + 主文件缺失 → 段 2 跳过、referenceScan='skipped'（delete scanned
 *   分支现状语义回归锚）；
 * - ② 显式枚举源不可读（哨兵缺失路径/损坏源）→ 无条件进段 2 → 读失败 → failed →
 *   keep-all 整域保留（D5 步骤 3 两分支 guard 契约的正向断言——禁段前存在性预检）；
 * - ③ purge 重试中间态（簿记在 + 压缩体已移除 + 残树含被存活会话引用的 subagent
 *   族）→ 幂等零报错、被引用族保留为残树、keep-all 对已删残树为安全 no-op。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-content-cascade-archive.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cascadeDeleteSessionContent } from '../session-content-cascade.js'
import type { SessionContentCascadeDeps } from '../session-content-cascade.js'

const SID = 'main-purge01'
const SA_ID = 'sa-ref1'

const registeredLine = (id: string): string =>
  JSON.stringify({ type: 'custom', customType: 'subagent-record', data: { v: 2, kind: 'registered', id, rootSessionId: 'root-x', depth: 0, startedAt: 1 } })

const settledLine = (id: string, sessionFile: string): string =>
  JSON.stringify({ type: 'custom', customType: 'subagent-record', data: { v: 2, kind: 'settled', id, status: 'idle', stopReason: 'end_turn', endedAt: 2, turns: 1, totalTokens: 10, sessionFile } })

interface Pool {  // oe-exempt:20261020:wip:归档域测试 fixture 形态类型，单实现为当前形态——30 天窗口内联或等第二变体
  root: string
  storeRoot: string
  agentDir: string
  sessionsRoot: string
  subagentsDir: string
  treeDir: string
  /** 存活会话 B 的主文件（sessions 池——引用并集扫描对象）。 */
  bMain: string
  /** A 的归档明文（引用枚举源）。 */
  aArchivePlain: string
  deps: SessionContentCascadeDeps
  warnings: string[]
}

const cleanupDirs: string[] = []

function makePool(aPlainLines: string[], bLines: string[]): Pool {
  const root = mkdtempSync(join(tmpdir(), 'taiji-cascade-archive-'))
  cleanupDirs.push(root)
  const storeRoot = join(root, 'ext-sessions')
  const agentDir = join(root, 'agent')
  const sessionsRoot = join(agentDir, 'sessions')
  const bucket = join(sessionsRoot, '--proj-cascade-a--')
  const archiveBucket = join(agentDir, 'archive', '--proj-cascade-a--')
  mkdirSync(bucket, { recursive: true })
  mkdirSync(archiveBucket, { recursive: true })
  mkdirSync(storeRoot, { recursive: true })

  const subagentsDir = join(storeRoot, SID, 'subagents', 'sessions')
  mkdirSync(subagentsDir, { recursive: true })
  const saFile = join(subagentsDir, `2026-01-01T00-00-00-000Z_${SA_ID}.jsonl`)
  writeFileSync(saFile, '{"type":"session"}\n')

  const bMain = join(bucket, '2026-10-19T00-00-00-000Z_sess-bbbb.jsonl')
  writeFileSync(bMain, `${bLines.join('\n')}\n`)
  const aArchivePlain = join(archiveBucket, '2026-10-20T00-00-00-000Z_main-purge01.jsonl')
  writeFileSync(aArchivePlain, `${aPlainLines.join('\n')}\n`)

  const warnings: string[] = []
  return {
    root, storeRoot, agentDir, sessionsRoot,
    subagentsDir: join(storeRoot, SID, 'subagents'),
    treeDir: join(storeRoot, SID),
    bMain, aArchivePlain, warnings,
    deps: {
      trash: async () => { void 0 },
      trashSessionTree: async (dir) => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) },
      purgeMainSidecars: () => { void 0 },
      reapBackgroundTasks: async () => { void 0 },
      warn: (m) => { warnings.push(m) },
    },
  }
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

/** purge 形态输入：主文件恒不在 sessions/（scanned 语义）+ 归档目录内枚举源。 */
function purgeInput(p: Pool, enumerationSource?: string) {
  return {
    sessionId: SID,
    sessionFilePath: join(p.sessionsRoot, '--proj-cascade-a--', '2026-10-20T00-00-00-000Z_main-purge01.jsonl'),
    agentDir: p.agentDir,
    sessionsRoot: p.sessionsRoot,
    sessionStoreRoot: p.storeRoot,
    skipIfMainFileMissing: false,
    ...(enumerationSource !== undefined ? { referenceEnumerationSource: enumerationSource } : {}),
  }
}

describe('① 缺省形态：delete scanned 分支现状语义回归锚', () => {
  it('不传 referenceEnumerationSource + 主文件缺失 → 段 2 跳过、referenceScan=skipped（引用保护不进入）', async () => {
    const p = makePool([registeredLine(SA_ID)], [settledLine(SA_ID, '/abs/sa.jsonl')])

    const result = await cascadeDeleteSessionContent(purgeInput(p), p.deps)

    // 现状语义（session-content-cascade.ts:203 guard 原样）：主文件缺失 + 缺省形态 →
    // 段 2 跳过（不枚举、不并集、不 keep-all），树照删。
    expect(result.referenceScan).toBe('skipped')
    expect(result.subagentFamiliesResidual).toBe(0)
    expect(existsSync(p.treeDir)).toBe(false)
  })
})

describe('② 显式枚举源不可读：无条件进段 2 → 读失败 → keep-all 整域保留', () => {
  it('哨兵缺失路径（sha256 校验不过的 purge 形态）→ failed → subagents 整域暂存回迁保留', async () => {
    const p = makePool([registeredLine(SA_ID)], [settledLine(SA_ID, '/abs/sa.jsonl')])
    const sentinel = join(p.agentDir, 'archive', '--proj-cascade-a--', 'nonexistent.missing')

    const result = await cascadeDeleteSessionContent(purgeInput(p, sentinel), p.deps)

    // 显式形态红线：不得因源不存在而预检跳过段 2——枚举器 readFileSync 失败承载
    // failed → keep-all（planKeepWholeSubagentsDir 整域保留 → 树删后回迁）。
    expect(result.referenceScan).toBe('failed')
    expect(result.subagentFamiliesResidual).toBe(1)
    expect(result.failures.length).toBeGreaterThan(0)
    // 整域保留的残树：subagents 目录被暂存回迁重建（树已整树软删 + 族拷回）。
    expect(existsSync(join(p.subagentsDir, 'sessions', `2026-01-01T00-00-00-000Z_${SA_ID}.jsonl`))).toBe(true)
  })

  it('显式源存在且可读 → 正常引用保护：被 B 引用的族保留、未引用族随树回收', async () => {
    const p = makePool(['{"type":"session"}'], ['{"type":"session"}'])
    // 真实绝对路径写入两侧（B 的引用锚与 A 归档明文的锚一致——settled.sessionFile）。
    const absSa = join(p.subagentsDir, 'sessions', `2026-01-01T00-00-00-000Z_${SA_ID}.jsonl`)
    writeFileSync(p.aArchivePlain, `${[registeredLine(SA_ID), settledLine(SA_ID, absSa)].join('\n')}\n`)
    writeFileSync(p.bMain, `${settledLine(SA_ID, absSa)}\n`)

    const result = await cascadeDeleteSessionContent(purgeInput(p, p.aArchivePlain), p.deps)

    expect(result.referenceScan).toBe('ok')
    // 被 B 引用 → 族保留 A 树残留（fork 回退暂存回迁），B 的绝对路径引用保持可解析。
    expect(result.subagentFamiliesResidual).toBe(1)
    expect(existsSync(absSa)).toBe(true)
  })
})

describe('③ purge 重试中间态：幂等零报错 + keep-all 对已删残树为安全 no-op', () => {
  it('显式源缺失 + 残树含被引用族 → 重试幂等达终态（族保留、不抛、树删后回迁）', async () => {
    // 中间态构造：第一次 purge 的 keep-all 已回迁被引用族（残树只剩该族），簿记仍在、
    // 压缩体已移除（重试时枚举源 = 哨兵缺失路径）。
    const p = makePool([registeredLine(SA_ID)], [settledLine(SA_ID, '/abs/sa.jsonl')])
    const sentinel = join(p.agentDir, 'archive', '--proj-cascade-a--', 'nonexistent.missing')

    const first = await cascadeDeleteSessionContent(purgeInput(p, sentinel), p.deps)
    expect(first.referenceScan).toBe('failed')
    expect(existsSync(p.subagentsDir)).toBe(true) // keep-all 回迁残树

    // 重试（同输入——幂等）：再次 keep-all 对「只剩被引用族的残树」照常回迁，零报错不抛。
    const second = await cascadeDeleteSessionContent(purgeInput(p, sentinel), p.deps)
    expect(second.referenceScan).toBe('failed')
    expect(existsSync(join(p.subagentsDir, 'sessions', `2026-01-01T00-00-00-000Z_${SA_ID}.jsonl`))).toBe(true)
  })

  it('keep-all 对不存在的残树为安全 no-op（planKeepWholeSubagentsDir 返回 null = 零动作，不抛）', async () => {
    const p = makePool([registeredLine(SA_ID)], [settledLine(SA_ID, '/abs/sa.jsonl')])
    const sentinel = join(p.agentDir, 'archive', '--proj-cascade-a--', 'nonexistent.missing')
    // 预删残树（第一次 purge 已把树清干净、第二次重试形态）。
    rmSync(p.treeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })

    const result = await cascadeDeleteSessionContent(purgeInput(p, sentinel), p.deps)

    // 树不在 + 枚举失败 → keep-all 计划对不存在目录返回 null = 零动作（无暂存目录
    // 残留、不抛）；sessionTreeTrashed=false（无树可删）。
    expect(result.referenceScan).toBe('failed')
    expect(result.sessionTreeTrashed).toBe(false)
    expect(result.subagentFamiliesResidual).toBe(0)
    expect(existsSync(p.treeDir)).toBe(false)
    // 暂存目录不残留（planKeepWholeSubagentsDir null → stageFamilies 未建目录）。
    const stagingLeftovers = existsSync(p.storeRoot)
      ? readdirSync(p.storeRoot).filter((n) => n.startsWith('.deletion-staging-'))
      : []
    expect(stagingLeftovers).toEqual([])
  })
})
