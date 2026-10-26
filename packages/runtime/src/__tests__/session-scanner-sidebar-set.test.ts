/**
 * W3 surface 落地——侧栏条目集合等价（验收项 10①）。
 *
 * 断言形态 = **集合等价**（不用单向负面断言）：
 * - 负面：btw 线（surface:'btw'）不得出现在侧栏列表；
 * - 正面：全部非 btw 会话**必须**在集合内（防「scannedToSummary 漏 surface 缺省 →
 *   磁盘条目整批消失」被单向负面断言 vacuously 放行——对空集合「btw 不在」恒真）。
 *
 * 过滤点（session-scanner.ts listAll）切 `surface === 'sidebar'` 正向谓词随 W3
 * `e57d1ada9` 落地（本测试同批创建；读取点登记于 docs/constraints.json C-data-28，
 * usage=nav-filter，登记随 W5 `b2775435b` 的 hidden 停写同批建立）。本测试锁定切换后
 * 行为等价的集合口径。
 *
 * 真实链路：PiSessionStore.scanSessions（真磁盘，TAIJI_AGENT_DATA_DIR 隔离 tmpdir）
 * → SessionScanner.listAll → listPersistedSessions；svc/gitInfoReader 为窄 mock。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-scanner-sidebar-set.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionSummary } from '@taiji/shared'
import { SessionScanner } from '../services/session/session-scanner.js'
import { PiSessionStore } from '../infra/pi/session-store.js'
import { invalidateScanDirCache } from '../infra/pi/session-file-utils.js'
import type { IScannerSessionOps } from '../services/session/session-internal.js'
import type { IGitInfoReader } from '../services/ports/git-info.js'

/** 写一个合法 session JSONL（首行 session header），返回文件绝对路径。 */
function writeSessionFile(sessionsDir: string, sub: string, id: string, cwd: string): string {
  const subDir = join(sessionsDir, sub)
  mkdirSync(subDir, { recursive: true })
  const filePath = join(subDir, `${id}.jsonl`)
  writeFileSync(
    filePath,
    JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-10-24T00:00:00Z' }) + '\n',
    'utf-8',
  )
  return filePath
}

describe('W3 侧栏条目集合等价（验收项 10①：btw 不得出现且非 btw 会话必须在集合内）', () => {
  let dataDir: string
  let sessionsDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'w3-sidebar-set-'))
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    invalidateScanDirCache()
    sessionsDir = join(dataDir, 'agent', 'sessions')
  })

  afterEach(() => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    invalidateScanDirCache()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function makeScanner(active: SessionSummary[], activeFilePaths: Set<string>): SessionScanner {
    const svc: IScannerSessionOps = {
      getActiveSummaries: () => active,
      getActiveFilePaths: () => activeFilePaths,
    }
    const gitInfoReader = {
      readGitInfo: () => undefined,
      pruneStaleCache: () => {},
    } as unknown as IGitInfoReader
    return new SessionScanner(svc, new PiSessionStore(), gitInfoReader)
  }

  it('活跃 btw 线 + 磁盘主会话：集合 = 全部非 btw 会话（负面 + 正向合取）', () => {
    // 磁盘：两个主会话（冷会话）
    writeSessionFile(sessionsDir, 'proj-a', 'cold-1', '/work/a')
    writeSessionFile(sessionsDir, 'proj-b', 'cold-2', '/work/b')
    // 活跃：一条 btw 线（surface:'btw'）+ 一个主会话
    const btwLine: SessionSummary = {
      id: 'line-live', label: '线', cwd: '/work/a', status: 'active', lastActiveAt: 3,
      surface: 'btw',
    }
    const liveMain: SessionSummary = {
      id: 'live-main', label: '主', cwd: '/work/a', status: 'active', lastActiveAt: 2,
      surface: 'sidebar',
    }

    const groups = makeScanner([btwLine, liveMain], new Set()).listPersistedSessions()
    const ids = groups.flatMap((g) => g.sessions).map((s) => s.id).sort()

    // 集合等价：btw 线不得出现 **且** 全部非 btw 会话必须在集合内
    expect(ids).toEqual(['cold-1', 'cold-2', 'live-main'])
    expect(ids).not.toContain('line-live')
  })

  it('磁盘条目 surface 显式缺省 sidebar（漏缺省 = 冷会话整批从侧栏消失的失效形态）', () => {
    writeSessionFile(sessionsDir, 'proj-a', 'cold-only', '/work/a')

    const groups = makeScanner([], new Set()).listPersistedSessions()
    const all = groups.flatMap((g) => g.sessions)

    // 正向断言：冷会话必须在集合内（surface 缺省值正确才进得了 W5 的正向谓词）
    expect(all.map((s) => s.id)).toEqual(['cold-only'])
    expect(all[0].surface).toBe('sidebar')
  })

  it('btw 线独占列表（无其他会话）→ 集合为空但不 vacuously 通过（磁盘正向锚点兜底）', () => {
    // 无磁盘条目、活跃只有 btw 线 → 列表为空；同文件用磁盘锚点证明「空」是过滤结果
    // 而非集合口径失效（锚点在上一用例；此处断言空集合 + btw 侧 surface 透传）。
    const btwLine: SessionSummary = {
      id: 'only-line', label: '线', cwd: '/work/a', status: 'active', lastActiveAt: 3,
      surface: 'btw',
    }

    const groups = makeScanner([btwLine], new Set()).listPersistedSessions()

    expect(groups.flatMap((g) => g.sessions)).toHaveLength(0)
  })
})
