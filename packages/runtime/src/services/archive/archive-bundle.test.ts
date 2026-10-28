import { getArchiveDir, getSessionsDir } from '../../infra/pi/pi-paths.js';
import { extractSessionName, invalidateScanDirCache, parseSessionHeader } from '../../infra/pi/session-file-utils.js';
import { PiSessionStore } from '../../infra/pi/session-store.js';
import type { IGitInfoReader } from '../ports/git-info.js';
import type { IScannerSessionOps } from '../session/session-internal.js';
import { fireDeathDisposition, subscribeSessionDeathDisposition } from '../session/session-lifecycle.js';
import { SessionScanner } from '../session/session-scanner.js';
import { archiveEntryMachine } from './archive-entry-machine.js';
import { createArchiveFixtureTree, fixtureMainFileName, seedArchivedUnit, seedConflictMainFile, seedLiveSession, seedOrphanArchiveFiles, seedPurgeIntermediateUnit, seedRestoringUnit, seedStagingUnit, seedSubagentReference, truncateCompressedBody, type ArchiveFixtureTree } from './archive-fixture.js';
import { archiveAssetDomainDir, readLedgerFile, scanLedgers } from './archive-paths.js';
import { healArchiveOnStartup } from './archive-self-heal.js';
import { ArchiveError, ArchiveService, type ArchiveServiceDeps } from './archive-service.js';
import { extractArchiveSummary } from './summary-extractor.js';
import { SessionSummary, parseArchiveLedger, type ArchiveLedgerStaging } from '@taiji/shared';
import { PI_SESSION_TREE_SEGMENTS, encodeCwd } from '@taiji/shared/paths';
import { generateTableTests } from '@zhushanwen/state-machine/testing';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


/**
 * 归档单元状态机穷举组（session-archive D9 / state-machine-infrastructure V1）：
 * generateTableTests 生成全状态 × 全事件组合——合法行断言次态（含消亡行
 * `state === null`）、表外断言 errorPolicy: 'throw' 抛出（fail-fast）。
 * 声明行的 outputs 本单元未声明（D9 表无 outputs 列——动作编排在
 * u-archive-service 服务层），planned 断言按空名单核。
 */

// 必须在收集阶段（模块顶层）调用——describe/it 不能在测试回调内注册
const cases = generateTableTests(archiveEntryMachine)


// ======================================================================
// ← src/services/archive/archive-invariants.test.ts
// ======================================================================

let dataDir: string


/** child 是否 parent 子树（含相等）；两者均为本测试内派生的绝对路径。 */
function isSubPath(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}


/** 写一个合法 session JSONL（首行 session header），返回文件绝对路径。 */
function writeSessionFile(dir: string, sub: string, id: string, cwd: string, fileName?: string): string {
  const subDir = join(dir, sub)
  mkdirSync(subDir, { recursive: true })
  const filePath = join(subDir, fileName ?? `${id}.jsonl`)
  writeFileSync(
    filePath,
    JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-10-20T00:00:00Z' }) + '\n',
    'utf-8',
  )
  return filePath
}


// ======================================================================
// ← src/services/archive/archive-service.test.ts
// ======================================================================

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


const cleanupDirs_m2: string[] = []


function makeFixture_m2(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'taiji-archive-svc-'))
  cleanupDirs_m2.push(root)
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
    // 生产接线同款（index.ts：fireArchiveDisposition → fireDeathDisposition('archive')）——
    // fake 同时驱动真实登记器，处置通道探针经本 fixture 端到端可达。
    fireArchiveDisposition: (sid, hasDestroySink) => {
      calls.push(`archive-disp:${sid}:${hasDestroySink}`)
      fireDeathDisposition(sid, 'archive', { hasDestroySink })
    },
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
    // 读回链真实化（生产接线语义，index.ts 组装根同构）：活跃 summaries Map 优先
    // （模拟 sessionService.getSummary 的 lifecycle Map 读取），miss 走持久化扫描侧
    // 构造（扫 sessions/ 树按 header.id 定位 + 名称尾读）——恢复态（非活跃）session
    // 的 summary 从磁盘真实读回，禁 canned 注入形态掩盖读回链断裂。
    getSessionSummary: (sid) => summaries.get(sid) ?? scanPersistedSummary(sessionsRoot, sid),
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


function summaryOf(sid: string, cwd: string): SessionSummary {
  return {
    id: sid,
    label: `会话-${sid}`,
    cwd,
    status: 'idle',
    lastActiveAt: 1,
  }
}


/**
 * 持久化扫描侧 summary 构造（fixture 读回链的磁盘腿——镜像 SessionScanner.listAll
 * 持久化路径的最小形态：扫 sessions/ 桶按 header.id 定位 + extractSessionName 尾读
 * 取名 + 主文件 mtime 排序键）。生产接线 = index.ts 组装根 listPersistedSessions 合并链。
 */
function scanPersistedSummary(sessionsRoot: string, sid: string): SessionSummary | undefined {
  if (!existsSync(sessionsRoot)) return undefined
  for (const bucket of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    const dir = join(sessionsRoot, bucket.name)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = join(dir, file)
      const header = parseSessionHeader(filePath)
      if (header === null || header.id !== sid || header.cwd === undefined) continue
      return {
        id: sid,
        label: extractSessionName(filePath) ?? basename(header.cwd),
        cwd: header.cwd,
        status: 'idle',
        lastActiveAt: statSync(filePath).mtimeMs,
        // W3：磁盘扫描条目显式缺省 surface 'sidebar'（与 scannedToSummary 同口径）
        surface: 'sidebar',
        source: 'scan',
        sessionFile: filePath,
      }
    }
  }
  return undefined
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


// ======================================================================
// ← src/services/archive/summary-extractor.test.ts
// ======================================================================

/**
 * 摘要提取器单测（session-archive 设计 §7 D4 验收条款五类用例）：
 * user entry 开新 turn / turn 无 agent 文本 → agent:null / 纯图片 user 空串 /
 * 非 message entry（compaction·usage·model_change 等）跳过 / agent 文本取从后向前
 * 第一个非空块。
 *
 * 输入形态 = parseJsonl 产物（unknown[]），fixture 直接以 pi JSONL entry 字面量
 * 构造（PiSessionEntry 的运行时形态），不引入 pi 类型依赖——被测函数按运行时
 * 收窄消费，测试同口径。
 */

const TS = '2026-10-20T00:00:00.000Z'


function msgEntry(id: string, role: string, content: unknown): unknown {
  return { type: 'message', id, parentId: null, timestamp: TS, message: { role, content } }
}


function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}


function imageBlock(): { type: 'image'; data: string; mimeType: string } {
  return { type: 'image', data: '<base64>', mimeType: 'image/png' }
}


function toolCallBlock(): { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> } {
  return { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'ls' } }
}


function compactionEntry(id: string): unknown {
  return { type: 'compaction', id, parentId: null, timestamp: TS, summary: '压缩摘要', firstKeptEntryId: 'e1', tokensBefore: 100 }
}


function usageEntry(id: string): unknown {
  return { type: 'usage', id, parentId: null, timestamp: TS, kind: 'cache_warm', provider: 'p', model: 'm', usage: {} }
}


/** PiSessionEntry 联合外的未建模 entry 类型（pi 还会写 model_change/session_info 等）。 */
function unmodeledEntry(id: string, type: string): unknown {
  return { type, id, parentId: null, timestamp: TS }
}


// ======================================================================
// ← archive-self-heal.test.ts
// ======================================================================

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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('archive-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('archive-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('archive-entry-machine', () => {
describe('archive-entry 机器声明与穷举覆盖对账', () => {
  it('创建行由 initial 承载（D9 首行：archive 动作创建实体，初始态 = staging）', () => {
    expect(archiveEntryMachine.definition.initial).toBe('staging')
  })

  it('全组合 18（3 态 × 6 事件）= 合法 8 + 表外 10 + 不变量破坏 0', () => {
    // 覆盖数对账防生成器静默漏覆盖；期望分布按 D9 表独立数出：
    // staging 3 合法（compress_done/unarchive/purge）、archived 2 合法
    // （unarchive/purge）、restoring 3 合法（restore_done/两回滚行）
    expect(cases).toHaveLength(18)
    expect(cases.filter((c) => c.expectation === 'transition')).toHaveLength(8)
    expect(cases.filter((c) => c.expectation === 'rejected')).toHaveLength(10)
    expect(cases.filter((c) => c.expectation === 'invariant-broken')).toHaveLength(0)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('archive-invariants', () => {
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'taiji-archive-invariants-'))
  process.env.TAIJI_AGENT_DATA_DIR = dataDir
  // 目录列举 TTL 缓存跨测试隔离（同 session-scanner-source.test.ts 先例）。
  invalidateScanDirCache()
})
afterEach(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  invalidateScanDirCache()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('不变量 4（扫描范围互斥）：构造层——两根物理隔离 + 树段 SSOT 登记', () => {
  it('归档根与 sessions 根互不为对方子树（兄弟目录，物理隔离的结构事实）', () => {
    const sessionsRoot = getSessionsDir()
    const archiveRoot = getArchiveDir()
    expect(isSubPath(sessionsRoot, archiveRoot)).toBe(false)
    expect(isSubPath(archiveRoot, sessionsRoot)).toBe(false)
  })

  it('archive 段已登记 PI_SESSION_TREE_SEGMENTS 且树段无重复（staging 期明文可过会话导出路径校验的前提）', () => {
    expect(PI_SESSION_TREE_SEGMENTS).toContain('archive')
    // 段重复 = 树段判定歧义（isInsideSessionTrees 按段匹配），SSOT 不变性对账。
    expect(new Set(PI_SESSION_TREE_SEGMENTS).size).toBe(PI_SESSION_TREE_SEGMENTS.length)
  })
})
describe('不变量 4（扫描范围互斥）：行为层——归档目录内容零收录', () => {
  /** 真实链路 scanner（窄 mock 仅 scanner 窄接口 2 方法，同 session-scanner-source.test.ts）。 */
  function makeScanner(): SessionScanner {
    const svc: IScannerSessionOps = {
      getActiveSummaries: () => [] as SessionSummary[],
      getActiveFilePaths: () => new Set<string>(),
    }
    const gitInfoReader = {
      readGitInfo: () => undefined,
      pruneStaleCache: () => {},
    } as unknown as IGitInfoReader
    return new SessionScanner(svc, new PiSessionStore(), gitInfoReader)
  }

  it('归档目录内 staging 明文 .jsonl / .archive.json 簿记 / .restoring 簿记均不进扫描结果', () => {
    // sessions/ 内一个在场 session（对照项——扫描应收录且仅收录它）。
    writeSessionFile(join(dataDir, 'agent', 'sessions'), 'proj-a', 'sess-alive', '/work/a')
    // archive/ 内镜像布局：staging 态明文主文件 + 簿记 + 恢复中簿记（同一归档目录内的
    // 全部形态）——文件名取合法主文件名形态，内容是完整合法 session header（若扫描
    // 范围覆盖归档根则必然被收录，断言因此可证伪）。
    const archiveBucket = join(dataDir, 'agent', 'archive', 'proj-a')
    mkdirSync(archiveBucket, { recursive: true })
    writeSessionFile(
      dataDir,
      join('agent', 'archive', 'proj-a'),
      'sess-archived',
      '/work/a',
      '20261020T000000_00000000-0000-4000-8000-000000000000.jsonl',
    )
    writeFileSync(
      join(archiveBucket, '20261020T000000_00000000-0000-4000-8000-000000000000.archive.json'),
      JSON.stringify({
        sessionId: 'sess-archived',
        name: '已归档会话',
        originalFile: '20261020T000000_00000000-0000-4000-8000-000000000000.jsonl',
        cwd: '/work/a',
        archivedAt: '2026-10-20T00:00:00.000Z',
        rawBytes: 100,
        status: 'staging',
        summary: null,
      }),
      'utf-8',
    )
    writeFileSync(
      join(archiveBucket, '20261020T000001_00000000-0000-4000-8000-000000000001.restoring'),
      JSON.stringify({ status: 'restoring-marker' }),
      'utf-8',
    )

    const groups = makeScanner().listPersistedSessions()

    const all = groups.flatMap((g) => g.sessions)
    expect(all.map((s) => s.id)).toEqual(['sess-alive'])
  })
})
});
// ======================================================================
// ← src/services/archive/archive-paths.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('archive-paths', () => {
describe('archiveAssetDomainDir sessionId 内联断言（dmg-r2-1）', () => {
  it('合法 pi 会话 id 返回 assets/<sessionId>/<domain> 分区路径', () => {
    expect(archiveAssetDomainDir('/archive/bucket', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', 'attachments')).toBe(
      '/archive/bucket/assets/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/attachments',
    )
  })

  it.each(['../evil', '..', 'sub/sess', 'sub\\sess', 'btw:sess01', 'sess 01', ''])(
    '穿越/非法形态 sessionId throw（path traversal blocked）：%s',
    (sessionId) => {
      expect(() => archiveAssetDomainDir('/archive/bucket', sessionId, 'artifacts')).toThrow('path traversal blocked')
    },
  )
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('archive-service', () => {
afterEach(() => {
  while (cleanupDirs_m2.length > 0) {
    const dir = cleanupDirs_m2.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
// ── archive 三操作之归档 ──────────────────────────────────────────────────────

describe('ArchiveService.archive', () => {
  it('非活跃（scanned）session：搬移顺序旁挂→主文件→附件三目录、簿记骨架、广播', async () => {
    const f = makeFixture_m2()
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

  it('活跃 session：杀 pi 前置五步复刻 delete 分支（archive 处置登记先于 detach/destroy）', async () => {
    const f = makeFixture_m2()
    const sid = 'sess-bbbb22'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerActive(sid, CWD_A, mainPath)

    await f.service.archive(sid)

    // 活跃编排序（D5 步骤 2 ①-⑤）：userStopped → archive 处置登记 → btw → detach →
    // destroy → removeEntry → reap，先于 invalidateScan/broadcast。
    const prefix = [
      `userStopped:${sid}`,
      `archive-disp:${sid}:true`,
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
    const f = makeFixture_m2()
    const sid = 'sess-cccc33'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    f.setGenerating(sid)

    await expect(f.service.archive(sid)).rejects.toMatchObject({ code: 'archive_generating' })
    expect(existsSync(mainPath)).toBe(true)
    expect(f.calls).toEqual([])
  })

  it('门 2：已存在该 sessionId 的簿记拒绝 archive_already_archived', async () => {
    const f = makeFixture_m2()
    const sid = 'sess-dddd44'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    await f.service.archive(sid) // 第一笔成功

    await expect(f.service.archive(sid)).rejects.toMatchObject({ code: 'archive_already_archived' })
    expect(existsSync(mainPath)).toBe(false) // 第二笔零动作（主文件早已搬走）
  })

  it('门 3：目标桶路径被同名文件占用（mkdir 失败）→ archive_io_error', async () => {
    const f = makeFixture_m2()
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
    const f = makeFixture_m2()
    await expect(f.service.archive('sess-ghost99')).rejects.toThrow(/not found/)
    expect(f.calls).toEqual([])
  })

  it('零消息 session（主文件未落盘，条目 26）：空归档成功——name 回退 sessionId、rawBytes 0、旁挂随迁、无压缩任务、幂等重入门 2', async () => {
    const f = makeFixture_m2()
    const sid = 'sess-empty26'
    // 活跃零消息形态：sessionFilePath 有值（pi SessionManager 构造期即派生路径）但文件
    // 不存在（首 flush 前不落盘，规则 #6）；create 期 sidecar 已写在该路径旁。
    const fileName = `2026-10-20T00-00-00-000Z_${sid}.jsonl`
    const mainPath = join(f.sessionsRoot, ENC_A, fileName)
    mkdirSync(join(f.sessionsRoot, ENC_A), { recursive: true })
    writeFileSync(`${mainPath}.preset.json`, '{}')
    f.registerActive(sid, CWD_A, mainPath)

    // 旧形态：rename ENOENT → archive_io_error；现按登记倾向方案直接成功（空归档语义）。
    await f.service.archive(sid)

    // 空归档单元：无主文件；簿记在（name 回退 sessionId、rawBytes 0）；旁挂随迁。
    const unitDir = join(f.archiveRoot, ENC_A)
    expect(existsSync(join(unitDir, fileName))).toBe(false)
    const ledger = readJson(join(unitDir, `${fileName}.archive.json`))
    expect(ledger.status).toBe('staging')
    expect(ledger.name).toBe(sid)
    expect(ledger.rawBytes).toBe(0)
    expect(ledger.cwd).toBe(CWD_A)
    expect(existsSync(join(unitDir, `${fileName}.preset.json`))).toBe(true)
    // 活跃退场照常（teardown 不因空归档跳过）+ 成功侧广播。
    expect(f.calls).toContain(`destroy:${sid}`)
    expect(f.calls).toContain('broadcast')
    // 压缩任务不派发：短暂让渡后无 .zst、无压缩域 warn、簿记保持 staging 稳定态。
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(existsSync(join(unitDir, `${fileName}.zst`))).toBe(false)
    expect(f.warnings.filter((w) => w.includes('压缩'))).toEqual([])
    expect(readJson(join(unitDir, `${fileName}.archive.json`)).status).toBe('staging')
    // 幂等：重复归档走门 2 的明确领域错误（archive_already_archived），非底层 IO 错误。
    await expect(f.service.archive(sid)).rejects.toMatchObject({ code: 'archive_already_archived' })
  })

  it('符号链接 cwd（条目 27）：realpath 归一分桶——主文件重定位自真值分桶、簿记 cwd 存真值、恢复回真值分桶原位', async () => {
    const f = makeFixture_m2()
    const sid = 'sess-sym27'
    // 真实目录 + 指向它的符号链接（macOS /var → /private/var 同款形态，tmp 下自建复现）。
    // realCwd 经 realpathSync 全链解析为 pi 的编码基准（pi spawn 子进程 process.cwd()
    // 返回内核全解析真值——本机实测 spawn cwd=/tmp/symtest-link 子进程 process.cwd()
    // 返回 /private/tmp/symtest-real；macOS tmpdir() 自身即 /var 未解析形态）。
    const realCwd = realpathSync(mkdtempSync(join(tmpdir(), 'taiji-archive-realcwd-')))
    cleanupDirs_m2.push(realCwd)
    const linkCwd = join(f.root, 'link-cwd')
    symlinkSync(realCwd, linkCwd)
    expect(realpathSync(linkCwd)).toBe(realCwd) // 前置锚：链接解析基准成立
    // pi 落盘形态：主文件在 realpath 分桶、header.cwd = 全解析真值（pi SessionManager
    // 以 process.cwd() 落 header）。
    const fileName = `2026-10-20T00-00-00-000Z_${sid}.jsonl`
    const realMainPath = join(f.sessionsRoot, encodeCwd(realCwd), fileName)
    mkdirSync(join(f.sessionsRoot, encodeCwd(realCwd)), { recursive: true })
    writeFileSync(
      realMainPath,
      `${JSON.stringify({ type: 'session', id: sid, cwd: realCwd, timestamp: '2026-10-20T00:00:00.000Z' })}\n`
        + `${JSON.stringify({ type: 'session_info', name: `会话-${sid}` })}\n`,
    )
    // 定位源形态（真机探针复现）：active.cwd = 未解析链接路径，sessionFilePath = 按未解析
    // cwd 派生的分桶路径（磁盘不存在——旧形态 rename 源 ENOENT）。
    f.registerActive(sid, linkCwd, join(f.sessionsRoot, encodeCwd(linkCwd), fileName))

    await f.service.archive(sid)

    // 归档单元按 realpath 真值编码分桶；主文件从真值分桶搬入；未解析编码桶不被创建。
    const unitDir = join(f.archiveRoot, encodeCwd(realCwd))
    expect(existsSync(join(unitDir, fileName))).toBe(true)
    expect(existsSync(join(f.archiveRoot, encodeCwd(linkCwd)))).toBe(false)
    expect(existsSync(realMainPath)).toBe(false)
    // 簿记 cwd 存 realpath 真值（恢复侧按簿记 cwd 原样推导——两侧同编码即往返一致）。
    const ledger = readJson(join(unitDir, `${fileName}.archive.json`))
    expect(ledger.cwd).toBe(realCwd)

    // 恢复路径一致性（条目 27 验收）：sessionOriginalPath 按簿记 cwd 推导 = realpath 分桶
    // 原位（与 pi 落盘位同桶）；summary 读回走磁盘扫描腿（header.id 定位）。
    const reply = await f.service.unarchive(sid)
    expect(reply.session.id).toBe(sid)
    expect(existsSync(realMainPath)).toBe(true)
    expect(existsSync(join(f.archiveRoot, encodeCwd(realCwd), `${fileName}.archive.json`))).toBe(false)
  })
})
// ── 后台压缩任务（staging → archived）───────────────────────────────────────

describe('后台压缩任务', () => {
  it('压缩体 + 摘要 + sha256 落簿记终态，明文删除', async () => {
    const f = makeFixture_m2()
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
    const f = makeFixture_m2()
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
    const f = makeFixture_m2()
    const sid = 'sess-ssss88'
    const mainPath = f.writeMainFile(sid, CWD_A)
    const original = readFileSync(mainPath)
    f.registerScanned(sid, CWD_A, mainPath)
    f.setSummary(sid, summaryOf(sid, CWD_A))
    await f.service.archive(sid) // staging（不等压缩）

    await f.service.unarchive(sid)

    expect(readFileSync(mainPath).equals(original)).toBe(true)
  })

  it('真实读回链：恢复态（非活跃）session 从磁盘扫描侧构造 summary（不注入活跃读回）', async () => {
    // unarchive 不 spawn pi、不进 lifecycle Map（Map 装载唯一入口 = create/restore/fork）——
    // 恢复后的 session 只存在于磁盘。本用例不调 setSummary（活跃 Map 恒空），reply 的
    // SessionSummary 必须经磁盘扫描腿真实读回：sessionFile 指向回场原路径、名称从恢复
    // 文件 session_info 尾读提取（与生产 listPersistedSessions 合并链同语义）。
    const f = makeFixture_m2()
    const sid = 'sess-rrrr11'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    await archiveAndCompress(f, sid)

    const reply = await f.service.unarchive(sid)

    expect(reply.session.id).toBe(sid)
    expect(reply.session.cwd).toBe(CWD_A)
    expect(reply.session.label).toBe(`会话-${sid}`)
    expect(reply.session.source).toBe('scan')
    expect(reply.session.sessionFile).toBe(mainPath)
  })

  it('冲突检测前置：原路径已存在同名主文件 → archive_restore_conflict，簿记归位、原件不动', async () => {
    const f = makeFixture_m2()
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
    const f = makeFixture_m2()
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
    const f = makeFixture_m2()
    await expect(f.service.unarchive('sess-ghost11')).rejects.toMatchObject({ code: 'archive_not_found' })
  })
})
// ── purgeArchive（彻底删除）─────────────────────────────────────────────────

describe('ArchiveService.purgeArchive', () => {
  it('正常链：簿记门过 → tombstone → 残树整树软删 → btw → 解绑 → 压缩体进废纸篓 → 归档单元清空', async () => {
    const f = makeFixture_m2()
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
    const f = makeFixture_m2()
    const sid = 'sess-gggg33'
    const mainPath = f.writeMainFile(sid, CWD_A) // 在场 session（已恢复形态）
    f.registerScanned(sid, CWD_A, mainPath)

    await expect(f.service.purgeArchive(sid)).rejects.toMatchObject({ code: 'archive_not_found' })

    // 零副作用：无任何原语调用、主文件与磁盘原样。
    expect(f.calls).toEqual([])
    expect(existsSync(mainPath)).toBe(true)
  })

  it('staging + 压缩体残留（压缩收尾窗口形态）：purge mainCandidates 补处置压缩体（防永久孤儿）', async () => {
    const f = makeFixture_m2()
    const sid = 'sess-tail66'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    await archiveAndCompress(f, sid)
    // 手工构造压缩收尾窗口磁盘形态（未经自愈）：明文已删 + 压缩体在场 + 簿记改回 staging。
    const unitDir = join(f.archiveRoot, ENC_A)
    const plain = join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl`)
    rmSync(plain, { force: true })
    const archived = readJson(join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))
    const stagingLedger = {
      sessionId: archived.sessionId,
      name: archived.name,
      originalFile: archived.originalFile,
      cwd: archived.cwd,
      archivedAt: archived.archivedAt,
      rawBytes: archived.rawBytes,
      status: 'staging',
      summary: null,
    }
    const ledgerPath = join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`)
    writeFileSync(ledgerPath, `${JSON.stringify(stagingLedger, null, 2)}\n`)

    await f.service.purgeArchive(sid)

    // staging 分支补压缩体候选：明文（已缺，存在性跳过）+ 压缩体都进处置，簿记消失达终态。
    const compressedPath = join(unitDir, `2026-10-20T00-00-00-000Z_${sid}.jsonl.zst`)
    expect(f.trashed).toContain(compressedPath)
    expect(existsSync(ledgerPath)).toBe(false)
  })

  it('keep-all 保守分支：压缩体损坏 → 引用枚举源缺失 → subagents 整域保留 + reply 携带 keptSubagentsDir', async () => {    const f = makeFixture_m2()
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
    const f = makeFixture_m2()
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

  it('压缩中发起 purgeArchive：等待压缩终态后执行，压缩体先生成再进废纸篓', async () => {
    const f = makeFixture_m2()
    const sid = 'sess-wait77'
    const mainPath = f.writeMainFile(sid, CWD_A)
    f.registerScanned(sid, CWD_A, mainPath)
    f.setSummary(sid, summaryOf(sid, CWD_A))
    await f.service.archive(sid) // 压缩任务刚入队（未完成）

    const reply = await f.service.purgeArchive(sid) // 与在途压缩任务并发——串行化等待

    // 压缩先达终态后 purge 才执行：归档态压缩体进废纸篓（staging 明文直读路径不会产生该处置）。
    expect(reply.sessionId).toBe(sid)
    const compressedPath = join(f.archiveRoot, ENC_A, `2026-10-20T00-00-00-000Z_${sid}.jsonl.zst`)
    expect(f.trashed).toContain(compressedPath)
    // 归档单元终态全清（簿记与压缩体均不在）。
    expect(existsSync(join(f.archiveRoot, ENC_A, `2026-10-20T00-00-00-000Z_${sid}.jsonl.archive.json`))).toBe(false)
    expect(existsSync(compressedPath)).toBe(false)
  })

  it('unarchive 与 purgeArchive 并发：后到者对已消失归档单元 fail-fast（archive_not_found）', async () => {
    const f = makeFixture_m2()
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
    const f = makeFixture_m2()
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
// ── 'archive' 处置登记探针（条目 28：归档退场经处置登记到达组合根单一汇聚点）──────

describe("'archive' 处置登记探针（条目 28：GUI 侧栏归档与 agent 工具 archive_session 两入口共用的收尾触发点）", () => {
  it('真实登记通道：archive 活跃 session 触发 disposition=archive、hasDestroySink=true（GUI 入口 handleSessionArchive 的唯一动作 = 调本服务）', async () => {
    const seen: Array<{ sid: string; disposition: string; hasDestroySink: boolean }> = []
    const unsubscribe = subscribeSessionDeathDisposition((sid, disposition, detail) => {
      seen.push({ sid, disposition, hasDestroySink: detail.hasDestroySink })
    })
    try {
      const f = makeFixture_m2()
      const sid = 'sess-probe-1'
      const mainPath = f.writeMainFile(sid, CWD_A)
      f.registerActive(sid, CWD_A, mainPath)

      await f.service.archive(sid)

      // ArchiveService 经 deps.fireArchiveDisposition 接线到真实登记器——组合根订阅同款
      // 形态收到 'archive' 处置（组合根对该值统一 speakSessionDeath(sid, 'exit') 收尾
      // completion-watch 债权，两入口同判）。
      expect(seen).toEqual([{ sid: 'sess-probe-1', disposition: 'archive', hasDestroySink: true }])
    } finally {
      unsubscribe()
    }
  })

  it('归档被前置三门拒绝（生成中）时零登记：债权零损伤（处置登记在门 1/2/3 之后）', async () => {
    const seen: Array<{ sid: string; disposition: string; hasDestroySink: boolean }> = []
    const unsubscribe = subscribeSessionDeathDisposition((sid, disposition, detail) => {
      seen.push({ sid, disposition, hasDestroySink: detail.hasDestroySink })
    })
    try {
      const f = makeFixture_m2()
      const sid = 'sess-probe-2'
      const mainPath = f.writeMainFile(sid, CWD_A)
      f.registerActive(sid, CWD_A, mainPath)
      f.setGenerating(sid)

      await expect(f.service.archive(sid)).rejects.toMatchObject({ code: 'archive_generating' })
      expect(seen).toEqual([])
    } finally {
      unsubscribe()
    }
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('summary-extractor', () => {
describe('extractArchiveSummary（D4 摘要算法）', () => {
  it('空输入与无 user entry 输入 → 空 turns', () => {
    expect(extractArchiveSummary([])).toEqual({ turns: [] })
    expect(extractArchiveSummary([msgEntry('a1', 'assistant', [textBlock('无用户提问的孤儿回复')])])).toEqual({ turns: [] })
  })

  it('user entry 开新 turn：按 user 边界切分，各 turn 携带自己的 agent 文本', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', [textBlock('第一个问题')]),
      msgEntry('a1', 'assistant', [textBlock('第一个回答')]),
      msgEntry('u2', 'user', [textBlock('第二个问题')]),
      msgEntry('a2', 'assistant', [textBlock('第二个回答')]),
    ])
    expect(summary).toEqual({
      turns: [
        { user: '第一个问题', agent: '第一个回答' },
        { user: '第二个问题', agent: '第二个回答' },
      ],
    })
  })

  it('user content 为 string 形态 → 直取；blocks 形态 → text 块拼接（\\n join）', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', '字符串形态的用户消息'),
      msgEntry('u2', 'user', [textBlock('第一段'), imageBlock(), textBlock('第二段')]),
    ])
    expect(summary.turns.map((t) => t.user)).toEqual(['字符串形态的用户消息', '第一段\n第二段'])
  })

  it('纯图片/附件 user 消息 → user 为空串（不产 turn 之外的行为）', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', [imageBlock(), imageBlock()]),
      msgEntry('a1', 'assistant', [textBlock('回答')]),
    ])
    expect(summary.turns).toEqual([{ user: '', agent: '回答' }])
  })

  it('turn 无 agent 文本（user 后直接下一个 user / 只有工具调用）→ agent: null', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', [textBlock('问题一（无回复即被追问）')]),
      msgEntry('u2', 'user', [textBlock('问题二')]),
      msgEntry('a2', 'assistant', [toolCallBlock()]),
      msgEntry('r2', 'toolResult', [textBlock('工具输出不是 agent 发言')]),
      msgEntry('u3', 'user', [textBlock('问题三')]),
    ])
    expect(summary.turns).toEqual([
      { user: '问题一（无回复即被追问）', agent: null },
      { user: '问题二', agent: null },
      { user: '问题三', agent: null },
    ])
  })

  it('非 message entry 跳过：compaction/usage/model_change/custom 穿插不断 turn、不贡献文本', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', [textBlock('问题')]),
      compactionEntry('c1'),
      usageEntry('us1'),
      unmodeledEntry('mc1', 'model_change'),
      unmodeledEntry('cm1', 'custom_message'),
      unmodeledEntry('si1', 'session'),
      msgEntry('a1', 'assistant', [textBlock('压缩点之后的结论')]),
    ])
    // compaction 不作边界（对齐 D4：与 session-reader compaction 断点语义刻意不同）
    expect(summary.turns).toEqual([{ user: '问题', agent: '压缩点之后的结论' }])
  })

  it('agent 文本取从后向前第一个非空块：多 assistant entry 取最终结论段', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', [textBlock('问题')]),
      msgEntry('a1', 'assistant', [textBlock('初步分析')]),
      msgEntry('a2', 'assistant', [toolCallBlock()]),
      msgEntry('a3', 'assistant', [textBlock('最终结论')]),
    ])
    expect(summary.turns[0]?.agent).toBe('最终结论')
  })

  it('从后向前扫描跳过空白块与无 text 块的 assistant：回退取更早的非空结论', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', [textBlock('问题')]),
      msgEntry('a1', 'assistant', [textBlock('早期结论')]),
      msgEntry('a2', 'assistant', [toolCallBlock()]),
      msgEntry('a3', 'assistant', [textBlock('   \n  ')]),
    ])
    expect(summary.turns[0]?.agent).toBe('早期结论')
  })

  it('同一 assistant entry 多 text 块 → 取最后一个非空块（= 从后向前第一个）', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', [textBlock('问题')]),
      msgEntry('a1', 'assistant', [textBlock('块一'), textBlock(''), textBlock('块二')]),
    ])
    expect(summary.turns[0]?.agent).toBe('块二')
  })

  it('role 边界：toolResult 与 system message 不贡献 agent 文本', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', [textBlock('问题')]),
      msgEntry('a1', 'assistant', [toolCallBlock()]),
      msgEntry('r1', 'toolResult', [textBlock('工具结果文本')]),
      msgEntry('s1', 'system', [textBlock('系统消息文本')]),
    ])
    expect(summary.turns[0]?.agent).toBeNull()
  })

  it('首个 user 边界前的孤儿段不属于任何 turn：其 assistant 文本不出现在任何 turn', () => {
    const summary = extractArchiveSummary([
      msgEntry('a0', 'assistant', [textBlock('头部孤儿段')]),
      compactionEntry('c0'),
      msgEntry('u1', 'user', [textBlock('问题')]),
      msgEntry('a1', 'assistant', [textBlock('回答')]),
    ])
    expect(summary.turns).toEqual([{ user: '问题', agent: '回答' }])
  })

  it('非 object 畸形行（parseJsonl 可能产出裸值）与畸形 message 形态跳过', () => {
    const summary = extractArchiveSummary([
      '裸字符串行',
      42,
      null,
      { type: 'message', id: 'x1', parentId: null, timestamp: TS }, // message 字段缺失
      { type: 'message', id: 'x2', parentId: null, timestamp: TS, message: { role: 'user' } }, // content 缺失 → user ''
      msgEntry('a1', 'assistant', [textBlock('回答')]),
    ])
    expect(summary.turns).toEqual([{ user: '', agent: '回答' }])
  })
})
});
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('archive-self-heal', () => {
afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
describe('启动自愈七行表（D5）', () => {
  it('行 1：staging 簿记 + 明文在归档目录 → 重做后台压缩任务', async () => {
    const f = makeFixture()
    f.writeLedger(`${MAIN}.archive.json`, stagingLedger())
    writePlainMain(f, '{"type":"session_info","name":"自愈测试"}')

    await f.heal()

    expect(f.compressed).toEqual(['sess-heal01'])
  })

  it('行 1b：staging 簿记 + 明文已删 + 压缩体在场（压缩收尾窗口中断）→ 解压回明文位重做压缩', async () => {
    const f = makeFixture()
    f.writeLedger(`${MAIN}.archive.json`, stagingLedger())
    // 崩溃形态构造：runCompression 的 unlinkSync(明文) 已执行、簿记终态未写。
    const plainContent = `${JSON.stringify({ type: 'session', id: 'sess-heal01', cwd: CWD })}\n${'{"type":"session_info","name":"自愈测试"}'}`
    writeFileSync(join(f.unitDir, `${MAIN}.zst`), zstdCompressSync(Buffer.from(plainContent)))

    await f.heal()

    // 明文回场（内容与压缩体一致）+ 压缩任务重新派发。
    expect(existsSync(join(f.unitDir, MAIN))).toBe(true)
    expect(readFileSync(join(f.unitDir, MAIN), 'utf8')).toBe(plainContent)
    expect(f.compressed).toEqual(['sess-heal01'])
    // 解压中间 tmp 不残留（行 6 前已 rename 消费）。
    expect(existsSync(join(f.unitDir, `${MAIN}.tmp`))).toBe(false)
  })

  it('行 1b：明文与压缩体都缺（归档物部分缺失）→ 行 5 形态，条目保持可见不派发压缩', async () => {
    const f = makeFixture()
    f.writeLedger(`${MAIN}.archive.json`, stagingLedger())

    await f.heal()

    expect(f.compressed).toEqual([])
    expect(existsSync(join(f.unitDir, `${MAIN}.archive.json`))).toBe(true)
  })

  it('行 1b：压缩体损坏不可解压 → 保持 staging 原样（不半途改写簿记），warn 出声', async () => {
    const f = makeFixture()
    f.writeLedger(`${MAIN}.archive.json`, stagingLedger())
    const ledgerPath = join(f.unitDir, `${MAIN}.archive.json`)
    const ledgerBefore = readFileSync(ledgerPath, 'utf8')
    writeFileSync(join(f.unitDir, `${MAIN}.zst`), Buffer.from('corrupt-not-zstd-body'))

    await f.heal()

    expect(f.compressed).toEqual([])
    expect(readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore)
    expect(f.warnings.some((w) => w.includes('行1b'))).toBe(true)
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

  it('行 4：孤儿主文件 header.id 非 pi 会话 id 形态 → 跳过不写簿记 + warn（防穿越：非法 id 一经簿记固化即流向 assets/ 分区与 purge 删除原语）', async () => {
    const f = makeFixture()
    // 磁盘构造非 pi 来源 .jsonl：首行 header.id 含穿越序列（dmg-r2-1 场景）。
    const p = join(f.unitDir, MAIN)
    writeFileSync(p, `${JSON.stringify({ type: 'session', id: '../evil', cwd: CWD })}\n{"type":"session_info","name":"非法 id 孤儿"}`)

    await f.heal()

    // 不写簿记（条目不入归档列表），孤儿明文保留待人工处置，warn 出声。
    expect(existsSync(join(f.unitDir, `${MAIN}.archive.json`))).toBe(false)
    expect(existsSync(p)).toBe(true)
    expect(f.warnings.some((w) => w.includes('行4') && w.includes('非 pi 会话 id 形态') && w.includes('../evil'))).toBe(true)
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
});
});

// ======================================================================
// ← archive-fixture.test.ts
// ======================================================================

const CWD_m2 = '/proj/archive-fixture-test'

const trees: ArchiveFixtureTree[] = []


function makeTree(): ArchiveFixtureTree {
  const tree = createArchiveFixtureTree()
  trees.push(tree)
  return tree
}


function readLedgerObject(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('archive-fixture', () => {
afterEach(() => {
  while (trees.length > 0) {
    const tree = trees.pop()
    if (tree !== undefined) tree.cleanup()
  }
})
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
    const result = seedLiveSession(tree, { sessionId: sid, cwd: CWD_m2, name: '在场会话' })

    expect(result.mainPath).toBe(join(tree.sessionsRoot, encodeCwd(CWD_m2), fixtureMainFileName(sid)))
    const lines = readFileSync(result.mainPath, 'utf8').trim().split('\n')
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'session', id: sid, cwd: CWD_m2 })
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
    const result = seedArchivedUnit(tree, { sessionId: sid, cwd: CWD_m2, name: '已归档会话', turns })

    // 簿记：shared schema 解析通过 + 字段断言。
    const parsed = parseArchiveLedger(readLedgerObject(result.ledgerPath))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.ledger).toMatchObject({
      sessionId: sid,
      name: '已归档会话',
      originalFile: fixtureMainFileName(sid),
      cwd: CWD_m2,
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
    const result = seedStagingUnit(tree, { sessionId: sid, cwd: CWD_m2 })

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
    const result = seedRestoringUnit(tree, { sessionId: sid, cwd: CWD_m2 }, { mainFileRestored: true })

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
    const result = seedRestoringUnit(tree, { sessionId: sid, cwd: CWD_m2 })

    expect(existsSync(result.restoringLedgerPath)).toBe(true)
    expect(result.sessionMainPath).toBeUndefined()
    const bucket = join(tree.sessionsRoot, encodeCwd(CWD_m2))
    expect(existsSync(join(bucket, fixtureMainFileName(sid)))).toBe(false)
  })
})
describe('seedPurgeIntermediateUnit（A7 行 5）', () => {
  it('簿记仍在 + 归档物已处置 + 残树 subagents 在（可重试幂等达终态的前提形态）', () => {
    const tree = makeTree()
    const sid = 'sess-purg0001'
    const result = seedPurgeIntermediateUnit(tree, { sessionId: sid, cwd: CWD_m2 })

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
    seedOrphanArchiveFiles(tree, { sessionId: sidA, cwd: CWD_m2 }, { sessionsHasMain: true })
    const b = seedOrphanArchiveFiles(tree, { sessionId: sidB, cwd: CWD_m2 })

    const bucket = join(tree.sessionsRoot, encodeCwd(CWD_m2))
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
    const result = seedArchivedUnit(tree, { sessionId: sid, cwd: CWD_m2 })

    truncateCompressedBody(result, 8)

    const truncated = readFileSync(result.compressedPath)
    expect(truncated.byteLength).toBe(8)
    const ledger = readLedgerObject(result.ledgerPath)
    expect(ledger.sha256).not.toBe(createHash('sha256').update(truncated).digest('hex'))
  })

  it('seedConflictMainFile：sessions/ 原路径同名占位存在', () => {
    const tree = makeTree()
    const originalFile = fixtureMainFileName('sess-conf0001')
    const conflictPath = seedConflictMainFile(tree, CWD_m2, originalFile)

    expect(existsSync(conflictPath)).toBe(true)
    expect(conflictPath).toBe(join(tree.sessionsRoot, encodeCwd(CWD_m2), originalFile))
  })
})
describe('seedSubagentReference（A8 fork 引用保护）', () => {
  it('B 会话 jsonl 含 v2 settled 条目（id 合法 + sessionFile 绝对路径）指向 subagents 域文件', () => {
    const tree = makeTree()
    const result = seedSubagentReference(tree, {
      archivedSessionId: 'sess-refd0001',
      cwd: CWD_m2,
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
});
