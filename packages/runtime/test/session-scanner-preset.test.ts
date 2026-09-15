/**
 * session-scanner preset 透传单测（wave4）。
 *
 * 覆盖 scannedToSummary 透传 launchPresetId：
 * - tc1：有值时透传
 * - tc2：undefined 时不兜底 builtin:full
 * - tc3：不独立读文件（缓存契约 W3）
 * - tc4：端到端 listPersistedSessions 链路
 *
 * 策略：真实 mkdtemp 临时目录 + 真实 fs 造 session 文件 + .preset.json sidecar，
 * mock gitInfoReader（避免 git 依赖），经 listPersistedSessions 间接测私有 scannedToSummary。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const realFs = createRequire(import.meta.url)('fs') as typeof import('node:fs')

// 计数 readFileSync（验证 scannedToSummary 不独立读 sidecar）
const fsState = vi.hoisted(() => ({ readCount: 0 }))

vi.mock('node:fs', async () => {
  const real = await import('node:fs')
  return {
    openSync: real.openSync,
    readSync: real.readSync,
    closeSync: real.closeSync,
    fstatSync: real.fstatSync,
    readFileSync: vi.fn((...args: Parameters<typeof real.readFileSync>) => {
      fsState.readCount++
      return real.readFileSync(...args)
    }),
    statSync: real.statSync,
    existsSync: real.existsSync,
    readdirSync: real.readdirSync,
    writeSync: real.writeSync,
    writeFileSync: real.writeFileSync,
    renameSync: real.renameSync,
  }
})

const pathsMock = vi.hoisted(() => ({ getSessionsDir: vi.fn(() => '/fake/sessions') }))
vi.mock('../src/infra/pi/pi-paths.js', () => ({
  getSessionsDir: pathsMock.getSessionsDir,
}))

// detectBareWorkspaceCached 经 workspace-detector，mock 避免真实 cwd 探测
vi.mock('../src/services/worktree/workspace-detector.js', () => ({
  detectBareWorkspaceCached: () => false,
  pruneBareCache: () => undefined,
}))

import { SessionScanner } from '../src/services/session/session-scanner.js'
import type { IScannerSessionOps } from '../src/services/session/session-internal.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'
import { scanPiSessions, _resetSessionMetaCacheForTest } from '../src/infra/pi/session-file-utils.js'

/** 构造一个 scanSessions 委托给真实 scanPiSessions 的 sessionStore mock（避免 PiSessionStore 的 provider-store 链） */
function makeSessionStore(): ISessionStore {
  return {
    scanSessions: () => scanPiSessions(),
    refreshAll: () => undefined,
    persistSessionEnd: () => undefined,
    persistPresetBinding: () => undefined,
    extractSessionOutcome: () => null,
    invalidateMetaCache: () => undefined,
    convertHistory: () => [],
    trash: () => Promise.resolve(),
  } as unknown as ISessionStore
}

/** S2 ISP 化：结构性满足 scanner 窄接口（2 方法 = 实际消费面），无强转。 */
function makeSvc(): IScannerSessionOps {
  return {
    getActiveSummaries: vi.fn(() => []),
    getActiveFilePaths: vi.fn(() => new Set<string>()),
  }
}

function makeGitReader(): IGitInfoReader {
  return {
    readGitInfo: vi.fn(() => undefined),
    pruneStaleCache: vi.fn(),
  } as unknown as IGitInfoReader
}

describe('session-scanner preset 透传', () => {
  let tmpSessionsDir: string

  beforeEach(() => {
    tmpSessionsDir = realFs.mkdtempSync(join(tmpdir(), 'scanner-preset-'))
    fsState.readCount = 0
    _resetSessionMetaCacheForTest()
  })

  afterEach(() => {
    realFs.rmSync(tmpSessionsDir, { recursive: true, force: true })
  })

  /** 造 session JSONL 文件（含可选 preset sidecar） */
  function makeSessionFile(id: string, opts: { presetId?: string; mtime?: Date } = {}): string {
    const dir = join(tmpSessionsDir, 'encodedCwd')
    if (!realFs.existsSync(dir)) realFs.mkdirSync(dir)
    const filePath = join(dir, `${id}.jsonl`)
    const lines = [
      JSON.stringify({ type: 'session', id, cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
    ]
    realFs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
    if (opts.presetId) {
      realFs.writeFileSync(
        filePath + '.preset.json',
        JSON.stringify({ presetId: opts.presetId, version: 1 }),
        'utf-8',
      )
    }
    if (opts.mtime) realFs.utimesSync(filePath, opts.mtime, opts.mtime)
    return filePath
  }

  it('tc1: scannedToSummary 透传 launchPresetId（有值）', () => {
    pathsMock.getSessionsDir.mockReturnValue(tmpSessionsDir)
    makeSessionFile('s1', { presetId: 'builtin:readonly' })

    const sessionStore = makeSessionStore()
    const scanner = new SessionScanner(makeSvc(), sessionStore, makeGitReader())

    const groups = scanner.listPersistedSessions()
    expect(groups).toHaveLength(1)
    const summary = groups[0].sessions[0]
    expect(summary.launchPresetId).toBe('builtin:readonly')
  })

  it('tc2: scannedToSummary launchPresetId undefined（历史 session 无 sidecar）→ summary.launchPresetId undefined', () => {
    pathsMock.getSessionsDir.mockReturnValue(tmpSessionsDir)
    makeSessionFile('s1') // 无 .preset.json sidecar

    const sessionStore = makeSessionStore()
    const scanner = new SessionScanner(makeSvc(), sessionStore, makeGitReader())

    const groups = scanner.listPersistedSessions()
    const summary = groups[0].sessions[0]
    // 不兜底 builtin:full
    expect(summary.launchPresetId).toBeUndefined()
  })

  it('tc3: scannedToSummary 不独立读文件（缓存契约 W3 不破）', () => {
    pathsMock.getSessionsDir.mockReturnValue(tmpSessionsDir)
    makeSessionFile('s1', { presetId: 'builtin:full' })

    const sessionStore = makeSessionStore()
    const scanner = new SessionScanner(makeSvc(), sessionStore, makeGitReader())

    // 第一次 listAll：scanSessionMeta miss → 读全部（含 sidecar）
    scanner.listPersistedSessions()
    const readsAfterFirst = fsState.readCount
    expect(readsAfterFirst).toBeGreaterThan(0)

    // 第二次 listAll：缓存命中 → scannedToSummary 不应触发额外 readFileSync
    scanner.listPersistedSessions()
    expect(fsState.readCount).toBe(readsAfterFirst)
  })

  it('tc4: listAll 端到端：scanPiSessions 四读合一 → summary 透传（含 sidecar 场景）', () => {
    pathsMock.getSessionsDir.mockReturnValue(tmpSessionsDir)
    // 两个 session：一个有 preset sidecar，一个无
    makeSessionFile('s1', { presetId: 'builtin:full', mtime: new Date(2000) })
    makeSessionFile('s2', { mtime: new Date(1000) }) // 历史 session 无 sidecar

    const sessionStore = makeSessionStore()
    const scanner = new SessionScanner(makeSvc(), sessionStore, makeGitReader())

    const groups = scanner.listPersistedSessions()
    expect(groups).toHaveLength(1) // 同 cwd 分一组
    const summaries = groups[0].sessions
    expect(summaries).toHaveLength(2)

    // s1（mtime 更新）排在前
    const s1 = summaries.find(s => s.id === 's1')
    const s2 = summaries.find(s => s.id === 's2')
    expect(s1?.launchPresetId).toBe('builtin:full')
    expect(s2?.launchPresetId).toBeUndefined()
  })
})
