/**
 * session-list-query 单测（W4b，设计 §3.3.1/§5-W4b + 验收项 12①②）。
 *
 * 覆盖（纯逻辑、零 IO——三档判据①：同步逻辑函数进/返回值出）：
 * - ① `{surface:'btw', mainSessionId:X}` 只返回 X 名下的线且 id 为 piId——**含负例：
 *   传 B 主会话 id 不得返回 A 名下的线**（过滤参数写反仍全绿的兜底）；
 * - ② `{surface:'sidebar'}` 与侧栏分组（config.sessions 广播同源）**逐条一致**——
 *   组序、组内序、条目对象全部原样（同一 owner 派生不允许两个口径）；
 * - 无参 = 全量（侧栏 + 全部线）；`{surface:'btw'}` 无 mainSessionId = 全部主线；
 * - label = `btw-<序号>`（§3.4.3 可区分形态；同主会话按 createdAt 升序编号，跨主独立）；
 * - 组内次序 = 侧栏条目在前 + 线条目按 createdAt 升序（flatten 后最新线在末位，
 *   与旧 btw.list 的 autoSelect 语义一致）；
 * - status 派生：lifecycle 记录 isGenerating → 'active'，否则 'idle'（不伪造）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-list-query.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import { SessionListQueryService } from '../session-list-query.js'
import type { BtwLineRecord } from '../btw-service.js'

function line(piSessionId: string, mainSid: string, createdAt: number, cwd = '/repo/a'): BtwLineRecord {
  return {
    piSessionId,
    mainSid,
    cwd,
    label: 'basename-cwd', // 旧形态：全部同名——label 重定义后不再使用该字段
    threadDir: `/root/${mainSid}/btw`,
    sessionFilePath: `/root/${mainSid}/btw/${piSessionId}.jsonl`,
    snapshotKind: 'forked',
    surface: 'btw',
    createdAt,
    pendingInteraction: false,
    contractRounds: 1,
  }
}

function summary(id: string, cwd: string, lastActiveAt: number): SessionSummary {
  return { id, label: id, cwd, status: 'idle', lastActiveAt, surface: 'sidebar' }
}

/** 侧栏分组（scanner.listPersistedSessions 的产物形态：cwd 分组 + 组内 lastActiveAt 降序） */
const SIDEBAR_GROUPS: SessionGroup[] = [
  { cwd: '/repo/a', sessions: [summary('main-a1', '/repo/a', 300), summary('main-a2', '/repo/a', 100)] },
  { cwd: '/repo/b', sessions: [summary('main-b1', '/repo/b', 200)] },
]

function makeService(lines: BtwLineRecord[], generating: ReadonlySet<string> = new Set()): SessionListQueryService {
  return new SessionListQueryService({
    listSidebarGroups: () => SIDEBAR_GROUPS.map((g) => ({ cwd: g.cwd, sessions: [...g.sessions] })),
    listBtwLines: () => lines,
    isLineGenerating: (id) => generating.has(id),
  })
}

/** SessionGroup[] → 扁平 id 清单（保序） */
function ids(groups: SessionGroup[]): string[] {
  return groups.flatMap((g) => g.sessions.map((s) => s.id))
}

describe('session-list-query：{surface:"btw", mainSessionId} 过滤（验收项 12①，含负例）', () => {
  const lines = [
    line('line-a1', 'main-a1', 10),
    line('line-a2', 'main-a1', 20),
    line('line-b1', 'main-b1', 15),
  ]

  it('只返回该主会话名下的线，id 为线 pi 真实会话 id', () => {
    const groups = makeService(lines).list({ surface: 'btw', mainSessionId: 'main-a1' })
    expect(ids(groups)).toEqual(['line-a1', 'line-a2'])
    // 全部条目 surface 恒 'btw'（侧栏条目不得混入）
    expect(groups.every((g) => g.sessions.every((s) => s.surface === 'btw'))).toBe(true)
  })

  it('负例：传 B 主会话 id 不得返回 A 名下的线', () => {
    const groups = makeService(lines).list({ surface: 'btw', mainSessionId: 'main-b1' })
    expect(ids(groups)).toEqual(['line-b1'])
    expect(ids(groups)).not.toContain('line-a1')
    expect(ids(groups)).not.toContain('line-a2')
  })

  it('未知 mainSessionId → 空结果（不回落全量）', () => {
    expect(makeService(lines).list({ surface: 'btw', mainSessionId: 'ghost-main' })).toEqual([])
  })
})

describe('session-list-query：{surface:"sidebar"} 与侧栏口径逐条一致（验收项 12②）', () => {
  it('组序/组内序/条目对象与侧栏分组原样一致（同一 owner 派生）', () => {
    const groups = makeService([line('line-a1', 'main-a1', 10)]).list({ surface: 'sidebar' })
    expect(groups).toEqual(SIDEBAR_GROUPS)
    // 侧栏口径不含任何 btw 线条目
    expect(groups.flatMap((g) => g.sessions).some((s) => s.surface === 'btw')).toBe(false)
  })

  it('无参 = 全量：侧栏条目 + 全部线条目并存（供抽屉/调试用）', () => {
    const groups = makeService([line('line-a1', 'main-a1', 10), line('line-b1', 'main-b1', 15)]).list({})
    expect(ids(groups)).toEqual(['main-a1', 'main-a2', 'line-a1', 'line-b1', 'main-b1'])
  })

  it('{surface:"btw"} 无 mainSessionId = 全部主会话的线（全局按 createdAt 升序）', () => {
    const groups = makeService([
      line('line-a2', 'main-a1', 20),
      line('line-b1', 'main-b1', 15),
      line('line-a1', 'main-a1', 10),
    ]).list({ surface: 'btw' })
    expect(ids(groups)).toEqual(['line-a1', 'line-b1', 'line-a2'])
  })
})

describe('session-list-query：线条目合成规则（§5-W4b 必填字段派生）', () => {
  it('label = btw-<序号>（同主会话按 createdAt 升序编号，跨主会话独立编号）+ cwd/status/lastActiveAt 派生', () => {
    const lines = [
      line('line-a2', 'main-a1', 20),
      line('line-a1', 'main-a1', 10),
      line('line-b1', 'main-b1', 15),
    ]
    const groups = makeService(lines).list({ surface: 'btw' })
    const entries = groups.flatMap((g) => g.sessions)
    // 全局按 createdAt 升序（10 → 15 → 20）；序号按**所属主会话内**创建次序独立编号
    expect(entries.map((s) => [s.id, s.label])).toEqual([
      ['line-a1', 'btw-1'],
      ['line-b1', 'btw-1'],
      ['line-a2', 'btw-2'],
    ])
    // cwd = 线 cwd（= 所属主会话 cwd）；lastActiveAt = 线 createdAt；sessionFile 透传
    const a1 = entries.find((s) => s.id === 'line-a1')
    expect(a1).toMatchObject({
      cwd: '/repo/a',
      status: 'idle',
      lastActiveAt: 10,
      surface: 'btw',
      sessionFile: '/root/main-a1/btw/line-a1.jsonl',
    })
  })

  it('status 派生：lifecycle 记录 isGenerating → active（不伪造、不恒 idle）', () => {
    const groups = makeService(
      [line('line-a1', 'main-a1', 10), line('line-a2', 'main-a1', 20)],
      new Set(['line-a2']),
    ).list({ surface: 'btw', mainSessionId: 'main-a1' })
    expect(groups[0]?.sessions.map((s) => [s.id, s.status])).toEqual([
      ['line-a1', 'idle'],
      ['line-a2', 'active'],
    ])
  })

  it('组内次序：侧栏条目在前 + 线条目按 createdAt 升序追加（flatten 后最新线在末位）', () => {
    const groups = makeService([
      line('line-a2', 'main-a1', 20),
      line('line-a1', 'main-a1', 10),
    ]).list({})
    const groupA = groups.find((g) => g.cwd === '/repo/a')
    expect(groupA?.sessions.map((s) => s.id)).toEqual(['main-a1', 'main-a2', 'line-a1', 'line-a2'])
  })
})
