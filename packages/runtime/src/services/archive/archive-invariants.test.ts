/**
 * 归档域聚合不变量 4 补漏测试（session-archive 设计 D9——u-docs-registration 补漏件）。
 *
 * 不变量 1-3 的行为断言在 archive-service.test.ts（互斥存在 / 压缩体消费前校验 /
 * 列表派生）；不变量 4（扫描范围互斥：归档目录永不进 SessionScanner 的 sessions
 * 扫描范围——物理隔离，构造性保证）此前仅注释级提及（archive-service.test.ts 搬移
 * 断言旁注），本文件补齐两条显式断言：
 * - 构造层：归档根与 sessions 根互不为对方子树（物理隔离的结构事实）+ archive 段
 *   已登记 PI_SESSION_TREE_SEGMENTS（树段 SSOT 对账，shared/paths.ts）；
 * - 行为层：真实 SessionScanner（真磁盘，TAIJI_AGENT_DATA_DIR 隔离 tmpdir）对
 *   归档目录内的明文 .jsonl（staging 态主文件）与 .restoring 簿记零收录——
 *   归档 session 构造性不进侧边栏列表（不变量 4 的用户可见形态）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/archive/archive-invariants.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import type { SessionSummary } from '@taiji/shared'
import { PI_SESSION_TREE_SEGMENTS } from '@taiji/shared/paths'
import { getArchiveDir, getSessionsDir } from '../../infra/pi/pi-paths.js'
import { invalidateScanDirCache } from '../../infra/pi/session-file-utils.js'
import { SessionScanner } from '../session/session-scanner.js'
import { PiSessionStore } from '../../infra/pi/session-store.js'
import type { IScannerSessionOps } from '../session/session-internal.js'
import type { IGitInfoReader } from '../ports/git-info.js'

let dataDir: string

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
