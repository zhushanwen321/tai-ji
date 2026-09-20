/**
 * RT-3#1（code-harden 审计批次 2 ④）：单条坏 header 不得毒死会话列表。
 *
 * 修复前链路：parseSessionHeader 条件赋值不设字段 + `as SessionHeader` 收口 →
 * scanSessionMeta 产出缺 cwd/id 的 meta → 消费阶段 scannedToSummary 的
 * basename(undefined) TypeError → listAll/listPersistedSessions 整体抛出，侧栏整列
 * 消失（扫描侧 catch 拦不住，异常发生在消费阶段）。
 * 修复后：scanSessionMeta 出口对 id/cwd 非空字符串 fail-fast → null + warn 带路径 +
 * degraded 计数汇总打点；消费侧 basename(cwd ?? '') 兜底。
 *
 * 策略：真实 mkdtemp 临时目录 + 真实 fs（tmpdir 属 fs-guard 白名单），mock
 * pi-paths.getSessionsDir 指向临时目录、mock workspace-detector 避免真实 cwd 探测，
 * 经 listPersistedSessions（→ listGrouped → listAll）间接覆盖私有链路。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-scanner-bad-header.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const realFs = createRequire(import.meta.url)('fs') as typeof import('node:fs')

const pathsMock = vi.hoisted(() => ({ getSessionsDir: vi.fn(() => '/fake/sessions') }))
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: pathsMock.getSessionsDir,
  }
})

// detectBareWorkspaceCached 经 workspace-detector，mock 避免真实 cwd 探测
vi.mock('../src/services/worktree/workspace-detector.js', () => ({
  detectBareWorkspaceCached: () => false,
}))

import { SessionScanner } from '../src/services/session/session-scanner.js'
import type { IScannerSessionOps } from '../src/services/session/session-internal.js'
import type { ISessionStore, ScannedSessionMeta } from '../src/services/ports/session.js'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'
import { scanPiSessions, invalidateScanDirCache, _resetSessionMetaCacheForTest } from '../src/infra/pi/session-file-utils.js'

/** 构造一个 scanSessions 委托给真实 scanPiSessions 的 sessionStore mock（避免 PiSessionStore 的 provider-store 链）。 */
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

describe('RT-3#1: 坏 header（缺 id/cwd）不毒死会话列表', () => {
  let tmpSessionsDir: string

  beforeEach(() => {
    tmpSessionsDir = realFs.mkdtempSync(join(tmpdir(), 'scanner-bad-header-'))
    pathsMock.getSessionsDir.mockReturnValue(tmpSessionsDir)
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
  })

  afterEach(() => {
    realFs.rmSync(tmpSessionsDir, { recursive: true, force: true })
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
  })

  /** 造 session JSONL 文件（header 字段可缺省，模拟坏数据）。 */
  function makeSessionFile(id: string, opts: { omitCwd?: boolean; omitId?: boolean } = {}): string {
    const dir = join(tmpSessionsDir, 'encodedCwd')
    if (!realFs.existsSync(dir)) realFs.mkdirSync(dir)
    const filePath = join(dir, `${id}.jsonl`)
    const header: Record<string, unknown> = { type: 'session', timestamp: '2025-01-01T00:00:00Z', cwd: '/proj' }
    if (!opts.omitId) header.id = id
    if (opts.omitCwd) delete header.cwd
    realFs.writeFileSync(filePath, `${JSON.stringify(header)}\n`, 'utf-8')
    return filePath
  }

  it('缺 cwd 的坏 header：listPersistedSessions 不抛、其余会话照常返回、warn 带路径 + degraded 计数显形', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const badPath = makeSessionFile('bad-no-cwd', { omitCwd: true })
      makeSessionFile('good-session')
      const scanner = new SessionScanner(makeSvc(), makeSessionStore(), makeGitReader())

      // 修复前：scannedToSummary 的 basename(undefined) TypeError 让整列消失
      const groups = scanner.listPersistedSessions()

      // 其余会话照常返回（坏条目被扫描出口 fail-fast，不进列表）
      const allIds = groups.flatMap((g) => g.sessions.map((s) => s.id))
      expect(allIds).toEqual(['good-session'])
      expect(groups[0].cwd).toBe('/proj')

      // 留痕：per-file warn 带文件路径（恢复动作 = 修/删该文件）
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session header missing/empty id or cwd'))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(badPath))
      // degraded 计数显形：扫描轮末汇总打点
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1 session file(s) dropped due to bad header'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('缺 id 的坏 header：同样 fail-fast 不进列表、不毒列表', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      makeSessionFile('bad-no-id', { omitId: true })
      makeSessionFile('good-session')
      const scanner = new SessionScanner(makeSvc(), makeSessionStore(), makeGitReader())

      const groups = scanner.listPersistedSessions()
      const allIds = groups.flatMap((g) => g.sessions.map((s) => s.id))
      expect(allIds).toEqual(['good-session'])
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1 session file(s) dropped due to bad header'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('消费侧兜底：meta.cwd 类型破约（undefined）时 basename 退化为空串而非 TypeError 毒死列表', () => {
    // 扫描出口已拦缺 cwd 条目，本用例锁纵深第二层（scannedToSummary 的 basename 兜底）：
    // 其它 ScannedSession 生产者破约时列表组装仍不抛。
    const brokenMeta = {
      id: 'broken-cwd',
      filePath: '/fake/broken.jsonl',
      cwd: undefined,
      timestamp: '2025-01-01T00:00:00Z',
      name: null,
      outcome: null,
      lastModified: 1_700_000_000_000,
      size: 10,
    } as unknown as ScannedSessionMeta
    const store = {
      ...makeSessionStore(),
      scanSessions: () => [brokenMeta],
    } as unknown as ISessionStore
    const scanner = new SessionScanner(makeSvc(), store, makeGitReader())

    expect(() => scanner.listPersistedSessions()).not.toThrow()
    const groups = scanner.listPersistedSessions()
    const summary = groups.flatMap((g) => g.sessions).find((s) => s.id === 'broken-cwd')
    expect(summary).toBeDefined()
    // label 兜底：basename('') = ''（优于整列消失）
    expect(summary!.label).toBe('')
  })
})
