/**
 * SessionScanner 磁盘扫描产出侧测试（W15 来源标记 + W3 surface 缺省）。
 *
 * 锁定：
 * - scannedToSummary 产出的持久化条目带 source:'scan' 显式标记 + surface 显式缺省
 *   'sidebar'（W3：磁盘路径只见得到主会话；W5 两处过滤点切 surface === 'sidebar' 正向
 *   谓词后，缺该缺省 = 全部冷会话从侧栏消失——验收项 10① 集合等价断言兜底）；
 * - W3 同批删除后 modelId/thinkingLevel/tokenCount 三状态字段不再出现在扫描条目
 *   （状态归 live-state 状态层，列表只承载导航；原 W15 占位值检查随字段删除退役）；
 * - 活跃实例条目（getActiveSummaries 透传）不标 source（缺省 = owner 权威，D1b 正常覆盖）；
 * - 回归：扫描全量后列表条目数与 sessions 目录 .jsonl 文件数一致（扫描不丢条目），
 *   活跃条目按 filePath 去重（活跃真值优先，扫描副本不进列表）。
 *
 * 真实链路：PiSessionStore.scanSessions（真磁盘，TAIJI_AGENT_DATA_DIR 隔离 tmpdir）
 * → SessionScanner.listAll → listPersistedSessions；svc/gitInfoReader 为窄 mock
 * （scanner 只消费 getActiveSummaries/getActiveFilePaths/readGitInfo/pruneStaleCache）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-scanner-source.test.ts
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
    JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-08-19T00:00:00Z' }) + '\n',
    'utf-8',
  )
  return filePath
}

describe('SessionScanner W15 磁盘占位值来源标记', () => {
  let dataDir: string
  let sessionsDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'w15-scanner-'))
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    // 目录列举 TTL 缓存跨测试隔离（缓存键含 dir，但显式重置防同 dir 内旧窗口泄漏）
    invalidateScanDirCache()
    sessionsDir = join(dataDir, 'agent', 'sessions')
  })

  afterEach(() => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    invalidateScanDirCache()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 窄 mock：结构性满足 scanner 窄接口（2 方法 = 消费方实际用到的全部，S2 ISP 化无强转）。 */
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

  it('扫描条目带 source:"scan" 标记 + surface 显式缺省 "sidebar"（W3 磁盘条目缺省）', () => {
    writeSessionFile(sessionsDir, 'proj-a', 'sess-1', '/work/a')

    const groups = makeScanner([], new Set()).listPersistedSessions()

    expect(groups).toHaveLength(1)
    const scanned = groups[0].sessions[0]
    expect(scanned.id).toBe('sess-1')
    // 来源标记：'scan' = 磁盘扫描条目（owner 来源不标）
    expect(scanned.source).toBe('scan')
    // W3 surface 落地：磁盘条目显式缺省 'sidebar'（W5 正向谓词 surface === 'sidebar' 的
    // 取数来源；undefined 会让全部冷会话从侧栏消失）
    expect(scanned.surface).toBe('sidebar')
    // W3 三状态字段删除：扫描条目不再携带 modelId/thinkingLevel/tokenCount
    expect(scanned).not.toHaveProperty('modelId')
    expect(scanned).not.toHaveProperty('thinkingLevel')
    expect(scanned).not.toHaveProperty('tokenCount')
  })

  it('活跃实例条目不标 source（缺省 = owner 权威，D1b 正常覆盖路径）', () => {
    writeSessionFile(sessionsDir, 'proj-a', 'sess-1', '/work/a')
    const active: SessionSummary = {
      id: 'sess-live',
      label: '活跃',
      cwd: '/work/a',
      status: 'idle',
      lastActiveAt: 1,
      // W3：活跃条目透传注册表 surface（buildSessionSummary 透传；registerSession 缺省 'sidebar'）
      surface: 'sidebar',
    }

    const groups = makeScanner([active], new Set()).listPersistedSessions()

    const all = groups.flatMap((g) => g.sessions)
    const live = all.find((s) => s.id === 'sess-live')
    expect(live?.source).toBeUndefined()
    expect(live?.surface).toBe('sidebar')
    const scanned = all.find((s) => s.id === 'sess-1')
    expect(scanned?.source).toBe('scan')
    expect(scanned?.surface).toBe('sidebar')
  })

  it('回归：扫描全量条目数与 sessions 目录 .jsonl 文件数一致（不丢条目；活跃 filePath 去重）', () => {
    writeSessionFile(sessionsDir, 'proj-a', 'f1', '/work/a')
    writeSessionFile(sessionsDir, 'proj-a', 'f2', '/work/a')
    writeSessionFile(sessionsDir, 'proj-b', 'f3', '/work/b')
    writeSessionFile(sessionsDir, 'proj-b', 'f4', '/work/b')
    writeSessionFile(sessionsDir, 'proj-b', 'f5', '/work/b')
    // f5 同文件被活跃实例持有 → 持久化副本去重，活跃真值版本进列表
    const livePath = writeSessionFile(sessionsDir, 'proj-c', 'f6', '/work/c')
    const active: SessionSummary = {
      id: 'f6',
      label: '活跃 f6',
      cwd: '/work/c',
      status: 'active',
      lastActiveAt: 2,
      surface: 'sidebar',
      sessionFile: livePath,
    }

    const groups = makeScanner([active], new Set([livePath])).listPersistedSessions()
    const all = groups.flatMap((g) => g.sessions)

    // 目录 6 个文件；f6 活跃去重后总条目数 = 5 个扫描 + 1 个活跃（不重复计入）
    expect(all).toHaveLength(6)
    expect(all.filter((s) => s.source === 'scan')).toHaveLength(5)
    // 活跃去重的 f6 走实例版本（owner 来源不标 source；surface 透传注册表值）
    const f6 = all.find((s) => s.id === 'f6')
    expect(f6?.surface).toBe('sidebar')
    expect(f6?.source).toBeUndefined()
  })

  // ── W1 F1 修复：.tmp-migrate- 崩溃残留按文件名排除 ─────────────────
  // restore-time 归一化（normalizeSessionFileInPlace）在写临时名与 rename 之间崩溃时，
  // sessions 目录残留 <原名>.tmp-migrate-<ts>.jsonl。scanner 按内容（首行 header）识别
  // session 不按文件名——残留内容是合法 session（同 sessionId），不过滤会产生同 id
  // 双条目且残留 mtime 更新排序在前，findScannedSession 命中残留 → restore 附着错位
  // 文件（verifier F1 实锤探针场景）。isScannableSessionFile 把排除变成机制保证。
  it('W1 F1: .tmp-migrate- 崩溃残留不进扫描列表，findScannedSession 数据源不命中（同 sessionId 唯一指向原文件）', () => {
    // 原文件（cwd 子目录形态）
    const origPath = writeSessionFile(sessionsDir, 'proj-a', 'sess-dup', '/work/a')
    // 残留 1（子目录内）：内容为合法 session 且同 sessionId——模拟 write 完成、rename 前崩溃
    //（残留写入晚于原文件 → mtime 更新，未过滤时排序在前，正是 verifier 探针命中的形态）
    const leftoverSub = join(sessionsDir, 'proj-a', 'sess-dup.jsonl.tmp-migrate-1755561600000.jsonl')
    writeFileSync(
      leftoverSub,
      JSON.stringify({ type: 'session', id: 'sess-dup', cwd: '/work/a', timestamp: '2026-08-19T00:00:01Z' }) + '\n',
      'utf-8',
    )
    // 残留 2（sessions 目录顶层）：覆盖顶层 .jsonl 枚举分支
    const leftoverTop = join(sessionsDir, 'top.jsonl.tmp-migrate-1755561600999.jsonl')
    writeFileSync(
      leftoverTop,
      JSON.stringify({ type: 'session', id: 'sess-top-leftover', cwd: '/work/a', timestamp: '2026-08-19T00:00:02Z' }) + '\n',
      'utf-8',
    )

    // 列表侧：残留不进扫描列表，sess-dup 唯一且指向原文件
    const groups = makeScanner([], new Set()).listPersistedSessions()
    const all = groups.flatMap((g) => g.sessions)
    expect(all.find((s) => s.sessionFile === leftoverSub)).toBeUndefined()
    expect(all.find((s) => s.sessionFile === leftoverTop)).toBeUndefined()
    expect(all.find((s) => s.sessionFile === origPath)).toBeDefined()
    const dupEntries = all.filter((s) => s.id === 'sess-dup')
    expect(dupEntries).toHaveLength(1)
    expect(dupEntries[0].sessionFile).toBe(origPath)

    // findScannedSession 数据源侧（其实现 = sessionStore.scanSessions({force}).find，
    // session-service.ts:1189）：数组不含残留路径 → 按 id 查找只命中原文件
    const scanned = new PiSessionStore().scanSessions({ force: true })
    expect(scanned.find(s => s.filePath === leftoverSub)).toBeUndefined()
    expect(scanned.find(s => s.filePath === leftoverTop)).toBeUndefined()
    const found = scanned.find(s => s.id === 'sess-dup')
    expect(found?.filePath).toBe(origPath)
  })
})
