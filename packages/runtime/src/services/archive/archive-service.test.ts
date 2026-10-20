/**
 * ArchiveService 三操作方法体级单测（session-archive 设计 D5/D8/D9/D13——真实 tmp
 * 目录驱动，fake deps 编排观测）。
 *
 * 覆盖（impl-plan u-archive-service 验收条款）：
 * - 三操作（archive/unarchive/purgeArchive）全链 + 前置三门 + 错误码；
 * - 聚合不变量 1-4（互斥存在 / 压缩体消费前校验 / 列表派生 / 扫描范围互斥）；
 * - per-session 三操作串行化（压缩中 unarchive 等待后正确执行；后到者对已消失
 *   归档单元 fail-fast）；
 * - purge 簿记存在性门（无簿记拒绝 + 零副作用）；
 * - suppress 消费点探针（残留风险 R2）：归档活跃 session 的死亡处置调用序。
 *
 * D9 转移表穷举单测（generateTableTests 18 组合）在 archive-entry-machine.test.ts
 * （基建包 M1 交付，testCommand 同被 `vitest run archive` 命中）；cascade 引用枚举
 * 源入参扩展的分支断言三组在 session-content-cascade-archive.test.ts；自愈六行在
 * archive-self-heal.test.ts。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/archive/archive-service.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { SessionSummary } from '@taiji/shared'
import { encodeCwd } from '@taiji/shared/paths'
import { subscribeSessionDeathDisposition, fireDeathDisposition } from '../session/session-lifecycle.js'
import { ArchiveError, ArchiveService, type ArchiveServiceDeps } from './archive-service.js'

// ── fixture ───────────────────────────────────────────────────────────────────

const CWD_A = '/proj/archive-test-a'
const ENC_A = encodeCwd(CWD_A)

interface Fixture {  // oe-exempt:20261020:wip:归档域测试 fixture 形态类型，单实现为当前形态——30 天窗口内联或等第二变体
  root: string
  dataDir: string
  agentDir: string
  sessionsRoot: string
  archiveRoot: string
  storeRoot: string
  service: ArchiveService
  calls: string[]
  warnings: string[]
  trashed: string[]
  treeTrashed: string[]
  /** scanned 态注册（findScannedSession 返回值）。 */
  registerScanned(sid: string, cwd: string, filePath: string): void
  /** 活跃态注册（getActiveSession 返回值）。 */
  registerActive(sid: string, cwd: string, sessionFilePath: string | undefined): void
  setGenerating(sid: string | null): void
  setSummary(sid: string, summary: SessionSummary): void
  /** 建 sessions 主文件（header + 尾部 session_info）+ 可选旁挂。 */
  writeMainFile(sid: string, cwd: string, opts?: { name?: string; extraLines?: string[]; sidecars?: string[] }): string
  /** 建附件域源目录（ext-sessions 存储树内）。 */
  seedAssetDomain(sid: string, domain: string): string
}

const cleanupDirs: string[] = []

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'taiji-archive-svc-'))
  cleanupDirs.push(root)
  const dataDir = root
  const agentDir = join(root, 'agent')
  const sessionsRoot = join(agentDir, 'sessions')
  const archiveRoot = join(agentDir, 'archive')
  const storeRoot = join(root, 'ext-sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  mkdirSync(storeRoot, { recursive: true })

  const calls: string[] = []
  const warnings: string[] = []
  const trashed: string[] = []
  const treeTrashed: string[] = []
  const scanned = new Map<string, { cwd: string; filePath: string }>()
  const active = new Map<string, { cwd: string; sessionFilePath?: string }>()
  const summaries = new Map<string, SessionSummary>()
  let generating: string | null = null

  const deps: ArchiveServiceDeps = {
    isGenerating: (sid) => sid === generating,
    getActiveSession: (sid) => active.get(sid),
    findScannedSession: (sid) => scanned.get(sid),
    disposeUserStopped: (sid) => { calls.push(`userStopped:${sid}`) },
    fireSuppressDisposition: (sid, hasDestroySink) => { calls.push(`suppress:${sid}:${hasDestroySink}`) },
    closeAllBtwLines: async (sid) => { calls.push(`btw:${sid}`); return [] },
    detachSession: (sid) => { calls.push(`detach:${sid}`) },
    destroyPiSession: async (sid) => { calls.push(`destroy:${sid}`) },
    removeSessionEntry: (sid) => { calls.push(`removeEntry:${sid}`) },
    reapBackgroundTasks: async (_dir, sid) => { calls.push(`reap:${sid}`) },
    clearRemovedSessionData: (sid) => { calls.push(`tombstone:${sid}`) },
    unbindCanvas: (sid) => { calls.push(`unbind:${sid}`) },
    trash: async (path) => {
      calls.push(`trash:${path}`)
      trashed.push(path)
      // fake 通道语义对齐真实废纸篓：原位置不再存在（供「处置完成」断言）。
      rmSync(path, { force: true, maxRetries: 5, retryDelay: 20 })
    },
    trashDirectory: async (dir) => {
      calls.push(`treeTrash:${dir}`)
      treeTrashed.push(dir)
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
    invalidateScanCache: () => { calls.push('invalidateScan') },
    broadcastSessionList: () => { calls.push('broadcast') },
    getSessionSummary: (sid) => summaries.get(sid),
    warn: (message) => { warnings.push(message) },
  }
  const service = new ArchiveService(deps, { dataDir, archiveRoot, agentDir, sessionsRoot })

  const fixture: Fixture = {
    root, dataDir, agentDir, sessionsRoot, archiveRoot, storeRoot, service, calls, warnings, trashed, treeTrashed,
    registerScanned: (sid, cwd, filePath) => { scanned.set(sid, { cwd, filePath }) },
    registerActive: (sid, cwd, sessionFilePath) => { active.set(sid, { cwd, sessionFilePath }) },
    setGenerating: (sid) => { generating = sid },
    setSummary: (sid, summary) => { summaries.set(sid, summary) },
    writeMainFile: (sid, cwd, opts = {}) => {
      const dir = join(sessionsRoot, encodeCwd(cwd))
      mkdirSync(dir, { recursive: true })
      const fileName = `2026-10-20T00-00-00-000Z_${sid}.jsonl`
      const filePath = join(dir, fileName)
      const lines = [
        JSON.stringify({ type: 'session', id: sid, cwd, timestamp: '2026-10-20T00:00:00.000Z' }),
        ...(opts.extraLines ?? []),
        JSON.stringify({ type: 'session_info', name: opts.name ?? `会话-${sid}` }),
      ]
      writeFileSync(filePath, `${lines.join('\n')}\n`)
      for (const ext of opts.sidecars ?? []) writeFileSync(filePath + ext, '{}')
      return filePath
    },
    seedAssetDomain: (sid, domain) => {
      const dir = join(storeRoot, sid, domain)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `item-${domain}.dat`)
      writeFileSync(file, 'asset-bytes')
      return file
    },
  }
  return fixture
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

function summaryOf(sid: string, cwd: string): SessionSummary {
  return {
    id: sid,
    label: `会话-${sid}`,
    cwd,
    status: 'idle',
    lastActiveAt: 1,
    modelId: '',
    tokenCount: 0,
  }
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** 归档 + 等待后台压缩任务完成（fixture 内便捷口——轮询簿记 status）。 */
async function archiveAndCompress(f: Fixture, sid: string): Promise<string> {
  await f.service.archive(sid)
  const unitDir = join(f.archiveRoot, ENC_A)
  const ledgerPath = join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`)
  for (let i = 0; i < 100; i++) {
    const ledger = readJson(ledgerPath)
    if (ledger.status === 'archived') return ledgerPath
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`压缩任务超时未完成 (sessionId=${sid})`)
}

// ── archive 三操作之归档 ──────────────────────────────────────────────────────

describe('ArchiveService.archive', () => {
  it('非活跃（scanned）session：搬移顺序旁挂→主文件→附件三目录、簿记骨架、广播', async () => {
    const f = makeFixture()
    const sid = 'sess-aaaa11'
    const mainPath = f.writeMainFile(sid, CWD_A, { sidecars: ['.project.json', '.meta.json'] })
    f.seedAssetDomain(sid, 'attachments')
    f.seedAssetDomain(sid, 'artifacts')
    f.registerScanned(sid, CWD_A, mainPath)
    const originalContent = readFileSync(mainPath)

    await f.service.archive(sid)

    // 搬移：sessions/ 侧清空（不变量 1 前半 + 不变量 4——移出扫描范围）。
    expect(existsSync(mainPath)).toBe(false)
    expect(existsSync(`${mainPath}.project.json`)).toBe(false)
    expect(existsSync(join(f.storeRoot, sid, 'attachments'))).toBe(false)
    // 归档单元构成（D1 布局）。
    const unitDir = join(f.archiveRoot, ENC_A)
    const plain = join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl`)
    expect(existsSync(plain)).toBe(true)
    expect(readFileSync(plain).equals(originalContent)).toBe(true)
    expect(existsSync(`${plain}.project.json`)).toBe(true)
    expect(existsSync(`${plain}.meta.json`)).toBe(true)
    expect(existsSync(join(unitDir, 'assets', sid, 'attachments', 'item-attachments.dat'))).toBe(true)
    expect(existsSync(join(unitDir, 'assets', sid, 'artifacts', 'item-artifacts.dat'))).toBe(true)
    // 簿记骨架（D5 步骤 4）。
    const ledger = readJson(join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))
    expect(ledger.status).toBe('staging')
    expect(ledger.summary).toBeNull()
    expect(ledger.name).toBe(`会话-${sid}`)
    expect(ledger.sessionId).toBe(sid)
    expect(ledger.cwd).toBe(CWD_A)
    expect(ledger.originalFile).toBe(`2026-10-20T00-00-00-000Z_${sid}.jsonl`)
    expect(ledger.rawBytes).toBe(originalContent.byteLength)
    // scanned 分支编排：无 suppress/detach；btw 级联停止（活跃/非活跃共用，D8——
    // 不停止则线进程继续写留置域）+ 收殓 + 缓存失效 + 广播。
    expect(f.calls).toEqual([`btw:${sid}`, `reap:${sid}`, 'invalidateScan', 'broadcast'])
  })

  it('活跃 session：杀 pi 前置五步复刻 delete 分支（suppress 登记先于 detach/destroy）', async () => {
    const f = makeFixture()
    const sid = 'sess-bbbb22'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerActive(sid, CWD_A, mainPath)

    await f.service.archive(sid)

    // 活跃编排序（D5 步骤 2 ①-⑤）：userStopped → suppress → btw → detach → destroy
    // → removeEntry → reap，先于 invalidateScan/broadcast。
    const prefix = [
      `userStopped:${sid}`,
      `suppress:${sid}:true`,
      `btw:${sid}`,
      `detach:${sid}`,
      `destroy:${sid}`,
      `removeEntry:${sid}`,
      `reap:${sid}`,
    ]
    expect(f.calls.slice(0, prefix.length)).toEqual(prefix)
    expect(existsSync(mainPath)).toBe(false)
    expect(readJson(join(f.archiveRoot, ENC_A, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`)).status).toBe('staging')
  })

  it('门 1：生成中拒绝 archive_generating（零搬移）', async () => {
    const f = makeFixture()
    const sid = 'sess-cccc33'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    f.setGenerating(sid)

    await expect(f.service.archive(sid)).rejects.toMatchObject({ code: 'archive_generating' })
    expect(existsSync(mainPath)).toBe(true)
    expect(f.calls).toEqual([])
  })

  it('门 2：已存在该 sessionId 的簿记拒绝 archive_already_archived', async () => {
    const f = makeFixture()
    const sid = 'sess-dddd44'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    await f.service.archive(sid) // 第一笔成功

    await expect(f.service.archive(sid)).rejects.toMatchObject({ code: 'archive_already_archived' })
    expect(existsSync(mainPath)).toBe(false) // 第二笔零动作（主文件早已搬走）
  })

  it('门 3：目标桶路径被同名文件占用（mkdir 失败）→ archive_io_error', async () => {
    const f = makeFixture()
    const sid = 'sess-eeee55'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    // 占位文件抢先占据桶目录路径 → mkdirSync recursive 失败（EEXIST/ENOTDIR 形态）。
    mkdirSync(f.archiveRoot, { recursive: true })
    writeFileSync(join(f.archiveRoot, ENC_A), 'occupier')

    await expect(f.service.archive(sid)).rejects.toMatchObject({ code: 'archive_io_error' })
    expect(existsSync(mainPath)).toBe(true)
  })

  it('归档对象不存在（内存无 + 磁盘无）→ not found 普通 Error（零副作用）', async () => {
    const f = makeFixture()
    await expect(f.service.archive('sess-ghost99')).rejects.toThrow(/not found/)
    expect(f.calls).toEqual([])
  })
})

// ── 后台压缩任务（staging → archived）───────────────────────────────────────

describe('后台压缩任务', () => {
  it('压缩体 + 摘要 + sha256 落簿记终态，明文删除', async () => {
    const f = makeFixture()
    const sid = 'sess-ffff66'
    const mainPath = f.writeMainFile(sid, CWD_A, {
      extraLines: [
        JSON.stringify({ type: 'message', message: { role: 'user', content: '帮我看看这个问题' } }),
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '先分析根因。' }] } }),
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '结论：需要修复 X。' }] } }),
      ],
    })
    const original = readFileSync(mainPath)
    f.registerScanned(sid, CWD_A, mainPath)

    const ledgerPath = await archiveAndCompress(f, sid)
    const unitDir = join(f.archiveRoot, ENC_A)
    const plain = join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl`)
    const compressedPath = `${plain}.zst`

    const ledger = readJson(ledgerPath)
    expect(ledger.status).toBe('archived')
    expect(ledger.codec).toBe('zstd-3')
    const compressed = readFileSync(compressedPath)
    expect(ledger.compressedBytes).toBe(compressed.byteLength)
    expect(ledger.sha256).toBe(sha256Hex(compressed))
    // 往返一致（V1 验收的单元级锚点）。
    expect(zstdDecompressSync(compressed).equals(original)).toBe(true)
    // 摘要（D4：agent 文本取从后向前第一个非空块 = 最后一段「结论」）。
    expect(ledger.summary).toEqual({
      turns: [{ user: '帮我看看这个问题', agent: '结论：需要修复 X。' }],
    })
    // 明文已删。
    expect(existsSync(plain)).toBe(false)
    // 压缩完成通知（D11「后台任务完成事件刷新」的事件源）：archive 步骤 5 广播 +
    // 压缩终态写入后广播各一次（staging→archived 的 renderer 刷新由收帧侧拉取承载）。
    expect(f.calls.filter((c) => c === 'broadcast')).toHaveLength(2)
  })
})

// ── unarchive（恢复）─────────────────────────────────────────────────────────

describe('ArchiveService.unarchive', () => {
  it('archived 态恢复：解压回原位逐字节一致、旁挂/附件回位、归档单元清空、返回 summary', async () => {
    const f = makeFixture()
    const sid = 'sess-uuuu77'
    const mainPath = f.writeMainFile(sid, CWD_A, { sidecars: ['.project.json'] })
    const original = readFileSync(mainPath)
    // 原文件 mtime 设旧（锚定置顶排序语义：列表序 = 主文件 mtime 降序，恢复必须让
    // mtime = 恢复时刻，§5.1「原项目组顶部」——否则按旧时间落回旧位置）。
    const stale = new Date('2020-01-01T00:00:00Z')
    utimesSync(mainPath, stale, stale)
    f.seedAssetDomain(sid, 'attachments')
    f.registerScanned(sid, CWD_A, mainPath)
    f.setSummary(sid, summaryOf(sid, CWD_A))
    await archiveAndCompress(f, sid)
    const restoreStartedAt = Date.now()

    const reply = await f.service.unarchive(sid)

    expect(reply.session.id).toBe(sid)
    // 原位恢复（不变量 1 后半：sessions/ 有主文件 + archive 无簿记）。
    expect(readFileSync(mainPath).equals(original)).toBe(true)
    expect(existsSync(`${mainPath}.project.json`)).toBe(true)
    expect(existsSync(join(f.storeRoot, sid, 'attachments', 'item-attachments.dat'))).toBe(true)
    // 恢复置顶排序语义：重建主文件 mtime = 恢复时刻（远新于 2020 锚点）。
    expect(statSync(mainPath).mtimeMs).toBeGreaterThanOrEqual(restoreStartedAt)
    // 归档单元清空（簿记/压缩体/旁挂/assets 全消失——目录壳可留）。
    const unitDir = join(f.archiveRoot, ENC_A)
    expect(existsSync(join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))).toBe(false)
    expect(existsSync(join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.zst`))).toBe(false)
    expect(existsSync(join(unitDir, 'assets', sid, 'attachments'))).toBe(false)
    expect(f.calls.slice(-2)).toEqual(['invalidateScan', 'broadcast'])
  })

  it('staging 态恢复：明文直接回原位（无压缩体可校验）', async () => {
    const f = makeFixture()
    const sid = 'sess-ssss88'
    const mainPath = f.writeMainFile(sid, CWD_A)
    const original = readFileSync(mainPath)
    f.registerScanned(sid, CWD_A, mainPath)
    f.setSummary(sid, summaryOf(sid, CWD_A))
    await f.service.archive(sid) // staging（不等压缩）

    await f.service.unarchive(sid)

    expect(readFileSync(mainPath).equals(original)).toBe(true)
  })

  it('冲突检测前置：原路径已存在同名主文件 → archive_restore_conflict，簿记归位、原件不动', async () => {
    const f = makeFixture()
    const sid = 'sess-cccc99'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    await archiveAndCompress(f, sid)
    // 手工放置同名冲突文件（V6 场景）。
    writeFileSync(mainPath, '{"type":"session","id":"other"}\n')
    const conflicting = readFileSync(mainPath)
    const unitDir = join(f.archiveRoot, ENC_A)

    await expect(f.service.unarchive(sid)).rejects.toMatchObject({ code: 'archive_restore_conflict' })

    // 簿记归位（.archive.json 在 / .restoring 不在），归档物完好，冲突原件未被覆盖。
    expect(existsSync(join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))).toBe(true)
    expect(existsSync(join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.restoring`))).toBe(false)
    expect(existsSync(join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.zst`))).toBe(true)
    expect(readFileSync(mainPath).equals(conflicting)).toBe(true)
  })

  it('不变量 2（压缩体消费前校验）：篡改压缩体 → archive_corrupted，簿记归位原件不动', async () => {
    const f = makeFixture()
    const sid = 'sess-tttt00'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    await archiveAndCompress(f, sid)
    const unitDir = join(f.archiveRoot, ENC_A)
    const compressedPath = join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.zst`)
    writeFileSync(compressedPath, readFileSync(compressedPath).subarray(0, 10)) // 截断损坏

    await expect(f.service.unarchive(sid)).rejects.toMatchObject({ code: 'archive_corrupted' })

    expect(existsSync(join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))).toBe(true)
    expect(existsSync(compressedPath)).toBe(true) // 原件（损坏体）不动
    expect(existsSync(mainPath)).toBe(false) // 未半途恢复
  })

  it('无簿记 → archive_not_found（恢复中条目对用户不可见）', async () => {
    const f = makeFixture()
    await expect(f.service.unarchive('sess-ghost11')).rejects.toMatchObject({ code: 'archive_not_found' })
  })
})

// ── purgeArchive（彻底删除）─────────────────────────────────────────────────

describe('ArchiveService.purgeArchive', () => {
  it('正常链：簿记门过 → tombstone → 残树整树软删 → btw → 解绑 → 压缩体进废纸篓 → 归档单元清空', async () => {
    const f = makeFixture()
    const sid = 'sess-pppp22'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    await archiveAndCompress(f, sid)
    // 残树（留置域：subagents/logs 等，D8）。
    mkdirSync(join(f.storeRoot, sid, 'subagents', 'sessions'), { recursive: true })
    writeFileSync(join(f.storeRoot, sid, 'subagents', 'sessions', 'sub-1.jsonl'), '{}')

    await f.service.purgeArchive(sid)

    // 编排序（D5 步骤 1-7）。
    const idxTrash = f.calls.findIndex((c) => c.startsWith('treeTrash:'))
    expect(idxTrash).toBeGreaterThan(f.calls.indexOf(`tombstone:${sid}`))
    expect(f.calls).toContain(`btw:${sid}`)
    expect(f.calls).toContain(`unbind:${sid}`)
    // 残树整树软删 + 压缩体进废纸篓。
    expect(f.treeTrashed).toEqual([join(f.storeRoot, sid)])
    const compressedPath = join(f.archiveRoot, ENC_A, `2026-10-20T00-00-00-000Z_${sid}.jsonl.zst`)
    expect(f.trashed).toEqual([compressedPath])
    // 归档单元清空（簿记消失即 purge 完成，不变量 3 的条目消亡形态）。
    expect(existsSync(join(f.archiveRoot, ENC_A, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))).toBe(false)
    expect(existsSync(compressedPath)).toBe(false)
    // 无 keep-all 说明字段（referenceScan ok）。
    expect(f.warnings.filter((w) => w.includes('keep-all'))).toEqual([])
  })

  it('簿记存在性门：无簿记 → archive_not_found 且零副作用（对在场 session 的真删拦截）', async () => {
    const f = makeFixture()
    const sid = 'sess-gggg33'
    const mainPath = f.writeMainFile(sid, CWD_A) // 在场 session（已恢复形态）
    f.registerScanned(sid, CWD_A, mainPath)

    await expect(f.service.purgeArchive(sid)).rejects.toMatchObject({ code: 'archive_not_found' })

    // 零副作用：无任何原语调用、主文件与磁盘原样。
    expect(f.calls).toEqual([])
    expect(existsSync(mainPath)).toBe(true)
  })

  it('keep-all 保守分支：压缩体损坏 → 引用枚举源缺失 → subagents 整域保留 + reply 携带 keptSubagentsDir', async () => {
    const f = makeFixture()
    const sid = 'sess-kkkk44'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    await archiveAndCompress(f, sid)
    // 残树含 subagents 域（会被 keep-all 保守保留）。
    mkdirSync(join(f.storeRoot, sid, 'subagents', 'sessions'), { recursive: true })
    const keptFile = join(f.storeRoot, sid, 'subagents', 'sessions', 'sub-keep.jsonl')
    writeFileSync(keptFile, '{}')
    // 压缩体截断损坏（sha256 校验不过 → 不解压 → 枚举源哨兵缺失 → cascade 读失败）。
    const compressedPath = join(f.archiveRoot, ENC_A, `2026-10-20T00-00-00-000Z_${sid}.jsonl.zst`)
    writeFileSync(compressedPath, readFileSync(compressedPath).subarray(0, 8))

    const reply = await f.service.purgeArchive(sid)

    // 归档单元照常清除（含损坏压缩体进废纸篓）。
    expect(f.trashed).toEqual([compressedPath])
    expect(existsSync(join(f.archiveRoot, ENC_A, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))).toBe(false)
    // subagents 整域保守保留（宁保留不误删）+ reply 保守保留说明字段（失败显式上报）。
    expect(existsSync(keptFile)).toBe(true)
    expect(reply.keptSubagentsDir).toBe(join(f.storeRoot, sid, 'subagents'))
  })
})

// ── per-session 三操作串行化（在途任务表）───────────────────────────────────

describe('per-session 串行化（D5 在途任务表）', () => {
  it('压缩中发起 unarchive：等待压缩终态后执行，恢复内容完整', async () => {
    const f = makeFixture()
    const sid = 'sess-wait55'
    const mainPath = f.writeMainFile(sid, CWD_A, {
      extraLines: [JSON.stringify({ type: 'message', message: { role: 'user', content: '问题 A' } })],
    })
    const original = readFileSync(mainPath)
    f.registerScanned(sid, CWD_A, mainPath)
    f.setSummary(sid, summaryOf(sid, CWD_A))
    await f.service.archive(sid) // 压缩任务刚入队（未完成）

    await f.service.unarchive(sid) // 与在途压缩任务并发——串行化等待

    // 压缩完成后才轮到恢复：恢复的是解压产物，逐字节一致。
    expect(readFileSync(mainPath).equals(original)).toBe(true)
    expect(existsSync(join(f.archiveRoot, ENC_A, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))).toBe(false)
  })

  it('unarchive 与 purgeArchive 并发：后到者对已消失归档单元 fail-fast（archive_not_found）', async () => {
    const f = makeFixture()
    const sid = 'sess-race66'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    f.setSummary(sid, summaryOf(sid, CWD_A))
    await archiveAndCompress(f, sid)

    // 同时发起：恢复先注册（到达顺序），purge 排在其后。
    const unarchivePromise = f.service.unarchive(sid)
    const purgePromise = f.service.purgeArchive(sid)
    const [unarchiveResult, purgeResult] = await Promise.allSettled([unarchivePromise, purgePromise])

    // 先到者成功（恢复完成），后到者对已消失归档单元 fail-fast——不会「恢复完成即被彻底删除」。
    expect(unarchiveResult.status).toBe('fulfilled')
    expect(purgeResult.status).toBe('rejected')
    if (purgeResult.status === 'rejected') {
      expect(purgeResult.reason).toBeInstanceOf(ArchiveError)
      expect((purgeResult.reason as ArchiveError).code).toBe('archive_not_found')
    }
    // 磁盘终态 = 恢复形态（不是删除形态）。
    expect(existsSync(mainPath)).toBe(true)
  })
})

// ── 聚合不变量 3（列表派生）─────────────────────────────────────────────────

describe('不变量 3：归档列表 = 扫描 .archive.json 派生', () => {
  it('列表条目与簿记一一对应；.restoring 不在列表；projectId 从 .project.json 旁挂回填', async () => {
    const f = makeFixture()
    const sid = 'sess-list77'
    const mainPath = f.writeMainFile(sid, CWD_A, { sidecars: ['.project.json'] })
    writeFileSync(`${mainPath}.project.json`, JSON.stringify({ projectId: 'proj-9' }))
    f.registerScanned(sid, CWD_A, mainPath)
    await archiveAndCompress(f, sid)
    const other = 'sess-list88'
    const otherPath = f.writeMainFile(other, '/proj/archive-test-b')
    f.registerScanned(other, '/proj/archive-test-b', otherPath)
    await f.service.archive(other) // staging 态（无 .project 旁挂）

    const entries = f.service.listArchiveEntries()
    expect(entries.map((e) => e.sessionId).sort()).toEqual([other, sid].sort())
    const mine = entries.find((e) => e.sessionId === sid)
    expect(mine?.projectId).toBe('proj-9')
    expect(mine?.status).toBe('archived')

    // .restoring 不在列表：手工构造恢复中形态（rename 簿记），恢复中条目对用户不可见。
    const unitDir = join(f.archiveRoot, ENC_A)
    renameSync(
      join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`),
      join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.restoring`),
    )
    const afterRestore = f.service.listArchiveEntries()
    expect(afterRestore.map((e) => e.sessionId)).toEqual([other])
  })
})

// ── suppress 消费点探针（残留风险 R2）───────────────────────────────────────

describe('suppress 消费点探针（R2：归档活跃 session 后死亡通知通道零输出）', () => {
  it('fireDeathDisposition(suppress) 直达订阅通道：disposition=suppress、hasDestroySink 按 in-册判定', () => {
    const seen: Array<{ sid: string; disposition: string; hasDestroySink: boolean }> = []
    const unsubscribe = subscribeSessionDeathDisposition((sid, disposition, detail) => {
      seen.push({ sid, disposition, hasDestroySink: detail.hasDestroySink })
    })
    try {
      // 真实登记器直达（ArchiveService 经 deps.fireSuppressDisposition 接线到本函数）。
      fireDeathDisposition('sess-probe-1', 'suppress', { hasDestroySink: true })
      expect(seen).toEqual([{ sid: 'sess-probe-1', disposition: 'suppress', hasDestroySink: true }])
    } finally {
      unsubscribe()
    }
  })

  it('归档活跃 session 的登记时序：suppress 先于 detach/destroy（先于任何杀进程，检查点①语义）', async () => {
    const f = makeFixture()
    const sid = 'sess-probe-2'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerActive(sid, CWD_A, mainPath)

    await f.service.archive(sid)

    const suppressIdx = f.calls.indexOf(`suppress:${sid}:true`)
    const detachIdx = f.calls.indexOf(`detach:${sid}`)
    const destroyIdx = f.calls.indexOf(`destroy:${sid}`)
    expect(suppressIdx).toBeGreaterThanOrEqual(0)
    expect(detachIdx).toBeGreaterThan(suppressIdx)
    expect(destroyIdx).toBeGreaterThan(detachIdx)
  })
})

/**
 * 探针代码级核实结论（R2，2026-10-20 实施期核实，写入 runlog）：
 * - 组合根消费（runtime index.ts:849-856）：suppress 分支只立 suppressedDeaths 标
 *   （hasDestroySink 时）不触发 speakSessionDeath——死亡通知通道零输出；
 * - 销毁回调消费（index.ts:1147）：removeSessionEntry 的销毁回调查标即消、跳过发声；
 * - intentional destroy 的 exit 事件（process-manager.ts:262-264）：destroySession 先清
 *   clientToId/processes 条目，pi 进程随后 exit 反查无条目直接 return——exit 通道结构性
 *   拦截，与「同 id 随即重开」无时序假设。R2 前提成立，无需扩展 disposition 枚举。
 */
