/**
 * D3 验收资产：§7 验收项 12 的 ①②③④（W4b session.list 功能正确性）gap 测试。
 * （⑤ 的 renderer 抑制行为归真机节点 A8-L4；其 L3 机制面 = 拉取供数机制存在 + 4 读取点
 * 登记 C-data-28 + 机器检查绿，由 A8L3 剧本 spawn check-session-hidden-surface.mjs
 * --selftest 与 u-w4a 随批测试执行，见剧本 summary.jsonl。）
 *
 * 规格原文（设计文档 §7 表项 12）：
 * ① `session.list {surface:'btw', mainSessionId:X}` 只返回 X 名下的 2 条线且 `id` 为
 *    piId——**含负例：传 B 主会话 id 不得返回 A 名下的线**（防过滤参数写反仍全绿）；
 * ② `session.list {surface:'sidebar'}` 与 `config.sessions` 广播过滤后的集合**逐条一致**；
 * ③ §10.2 的两态断言（结论已定 = 「不切」：侧栏维持 config.sessions 广播通道，
 *    session.list 查询入口随侧栏保留，退役条件以 ④ 的机器比对形态执行）；
 * ④ **退役条件执行**：选「不切」→ ② 转为两口径偏差的机器比对（告警形态，§3.3.1）。
 *
 * 与既有覆盖的分工（本文件只补 D3 验收视角的缺口，不重复单元层断言）：
 * - `src/services/session/__tests__/session-list-query.test.ts`（u-w4b）已覆盖 ①（含
 *   负例）与 ② 的纯逻辑面——但用字面量 id（'line-a1' 等），未锁定「id 为 piId 形态」；
 * - `packages/core/src/transport/mock/__tests__/mock-domains.test.ts`（u-w4b）已覆盖
 *   mock 侧 ①② + 抑制类成员判别的数据层等价（session.list {surface:'btw'} id 集合 =
 *   注册表线全集）；
 * - 本文件补的缺口：① 的 id 形态断言（真实 UUID piId、无 `btw:` 前缀形态）+ ② 的
 *   runtime 直调两口径逐条一致（含组序/组内序/条目对象深等）+ ③ 的 transport 接线
 *   （查询入口存活 = 退役条件未执行的正面证据）+ ④ 的机器比对告警形态（含防门失明的
 *   偏差注入对照）。
 *
 * 数据隔离（项目测试红线）：本文件零 IO（纯逻辑 + mock ctx），不触真实数据目录。
 *
 * 运行：cd packages/runtime && npx vitest run test/acceptance/item12-session-list.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { WebSocket as WsType } from 'ws'
import type { SessionGroup, SessionSummary, SessionSurface } from '@taiji/shared'
import { SessionListQueryService } from '../../src/services/session/session-list-query.js'
import type { BtwLineRecord } from '../../src/services/session/btw-service.js'
import { SessionMessageHandler, type SessionHandlerContext } from '../../src/transport/session-message-handler.js'
import type { ISessionService } from '../../src/interfaces.js'
import type { ClientMessage } from '@taiji/shared'

// ── fixture（真实 piId 形态：UUID v4；W4a 键统一后线 id = pi 真实会话 id）──────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** btw 线注册表记录（BtwLineRecord 的验收视图：只列本测试消费字段） */
function lineRecord(piSessionId: string, mainSid: string, createdAt: number, cwd = '/repo/a'): BtwLineRecord {
  return {
    piSessionId,
    mainSid,
    cwd,
    label: 'basename-cwd',
    threadDir: `/root/${mainSid}/btw`,
    sessionFilePath: `/root/${mainSid}/btw/${piSessionId}.jsonl`,
    snapshotKind: 'forked',
    surface: 'btw',
    createdAt,
    pendingInteraction: false,
    contractRounds: 1,
  }
}

/** 侧栏分组（scanner.listPersistedSessions 产物形态：cwd 分组 + 组内 lastActiveAt 降序） */
function sidebarSummary(id: string, cwd: string, lastActiveAt: number): SessionSummary {
  return { id, label: id, cwd, status: 'idle', lastActiveAt, surface: 'sidebar' }
}

/** SessionGroup[] → 扁平 id 清单（保序） */
function ids(groups: SessionGroup[]): string[] {
  return groups.flatMap((g) => g.sessions.map((s) => s.id))
}

// ── ④ 两口径偏差机器比对（告警形态）───────────────────────────────────────────

/**
 * 两口径偏差机器比对（§3.3.1「不切」分支的退役条件执行形态）：
 * 侧栏广播口径（config.sessions 过滤后 = scanner.listPersistedSessions 分组）与
 * session.list {surface:'sidebar'} 查询口径逐条比对。返回偏差描述清单；空 = 两口径一致。
 *
 * 比对三层（任一层的偏差都报——组序 / 组内序 / 条目对象逐字段）：
 * 1. 扁平 id 序列（保序）不同；
 * 2. 分组 cwd 序列不同；
 * 3. 扁平条目对象深等不同（逐字段，含 label/status/lastActiveAt/surface）。
 */
function twoCaliberDeviation(broadcastGroups: SessionGroup[], listGroups: SessionGroup[]): string[] {
  const deviations: string[] = []
  const broadcastIds = ids(broadcastGroups)
  const listIds = ids(listGroups)
  if (broadcastIds.length !== listIds.length || broadcastIds.some((id, i) => id !== listIds[i])) {
    deviations.push(`id-sequence differs: broadcast=[${broadcastIds.join(',')}] list=[${listIds.join(',')}]`)
  }
  const broadcastCwds = broadcastGroups.map((g) => g.cwd)
  const listCwds = listGroups.map((g) => g.cwd)
  if (broadcastCwds.length !== listCwds.length || broadcastCwds.some((c, i) => c !== listCwds[i])) {
    deviations.push(`cwd-sequence differs: broadcast=[${broadcastCwds.join(',')}] list=[${listCwds.join(',')}]`)
  }
  const broadcastFlat = broadcastGroups.flatMap((g) => g.sessions)
  const listFlat = listGroups.flatMap((g) => g.sessions)
  if (JSON.stringify(broadcastFlat) !== JSON.stringify(listFlat)) {
    deviations.push('entry objects differ (deep)')
  }
  return deviations
}

// ── ③ transport 接线 mock（对齐 session-message-handler-get-state.test.ts 形态）────

function mockWs(): WsType {
  return { send: vi.fn(), readyState: 1 } as unknown as WsType
}

function mockContext(sessionService: unknown): SessionHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    sessionService: sessionService as ISessionService,
    nextPushId: vi.fn(() => 'push-1'),
    broadcastSessionList: vi.fn(),
    broadcast: vi.fn(),
    invalidatePendingUiRequests: vi.fn(),
  }
}

function msg(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

// ── 测试体 ─────────────────────────────────────────────────────────────

describe('§7 验收项 12①：session.list {surface:"btw", mainSessionId}（含负例，id 为 piId）', () => {
  const mainA = randomUUID()
  const mainB = randomUUID()
  const lineA1 = randomUUID()
  const lineA2 = randomUUID()
  const lineB1 = randomUUID()
  const lines = [
    lineRecord(lineA1, mainA, 10),
    lineRecord(lineA2, mainA, 20),
    lineRecord(lineB1, mainB, 15),
  ]

  function makeService(): SessionListQueryService {
    return new SessionListQueryService({
      listSidebarGroups: () => [],
      listBtwLines: () => lines,
      isLineGenerating: () => false,
    })
  }

  it('只返回 X 名下的 2 条线，id 为 pi 真实会话 id（UUID 形态、无 btw: 前缀）', () => {
    const groups = makeService().list({ surface: 'btw', mainSessionId: mainA })
    expect(ids(groups)).toEqual([lineA1, lineA2])
    const entries = groups.flatMap((g) => g.sessions)
    // id 形态 = piId（防「键切换回退成虚拟 id」的回归）
    for (const s of entries) {
      expect(s.id).toMatch(UUID_RE)
      expect(s.id.startsWith('btw:')).toBe(false)
      expect(s.surface).toBe('btw')
    }
    expect(entries.map((s) => s.label)).toEqual(['btw-1', 'btw-2'])
  })

  it('负例：传 B 主会话 id 不得返回 A 名下的线（过滤参数写反仍全绿的兜底）', () => {
    const groups = makeService().list({ surface: 'btw', mainSessionId: mainB })
    expect(ids(groups)).toEqual([lineB1])
    expect(ids(groups)).not.toContain(lineA1)
    expect(ids(groups)).not.toContain(lineA2)
  })

  it('负例：未知 mainSessionId → 空结果（不回落全量）', () => {
    expect(makeService().list({ surface: 'btw', mainSessionId: randomUUID() })).toEqual([])
  })

  it('拉取供数机制存在（⑤ L3 机制面）：{surface:"btw"} 的 id 集合 = 注册表线全集（create/remove 同拍收敛）', () => {
    const registry = [lineRecord(lineA1, mainA, 10), lineRecord(lineA2, mainA, 20), lineRecord(lineB1, mainB, 15)]
    const svc = new SessionListQueryService({
      listSidebarGroups: () => [],
      listBtwLines: () => registry,
      isLineGenerating: () => false,
    })
    // 渲染侧抑制类判别（btw-line-membership）唯一读本查询的拉取缓存——其数据 = 注册表事实
    const pulled = new Set(ids(svc.list({ surface: 'btw' })))
    expect(pulled).toEqual(new Set(registry.map((l) => l.piSessionId)))
    // 关线出册同拍收敛（注册表移除 → 查询不再返回）
    registry.splice(registry.findIndex((l) => l.piSessionId === lineB1), 1)
    expect(new Set(ids(svc.list({ surface: 'btw' })))).toEqual(new Set([lineA1, lineA2]))
  })
})

describe('§7 验收项 12②：{surface:"sidebar"} 与侧栏口径（config.sessions 广播同源）逐条一致', () => {
  const SIDEBAR_GROUPS: SessionGroup[] = [
    { cwd: '/repo/a', sessions: [sidebarSummary(randomUUID(), '/repo/a', 300), sidebarSummary(randomUUID(), '/repo/a', 100)] },
    { cwd: '/repo/b', sessions: [sidebarSummary(randomUUID(), '/repo/b', 200)] },
  ]

  /**
   * 侧栏口径来源（建模 scanner.listPersistedSessions——config.sessions 广播与 session.list
   * 查询两侧的同一 owner；message-broker.ts:261 buildSessionListMsg 广播的 groups 即本来源
   * 的直出产物，未经 surface 过滤与分组重组）。
   */
  const sidebarCaliberSource = (): SessionGroup[] => SIDEBAR_GROUPS.map((g) => ({ cwd: g.cwd, sessions: [...g.sessions] }))

  function makeService(): SessionListQueryService {
    return new SessionListQueryService({
      // 侧栏口径 = scanner.listPersistedSessions（与 config.sessions 广播同源同 owner）
      listSidebarGroups: sidebarCaliberSource,
      listBtwLines: () => [lineRecord(randomUUID(), randomUUID(), 10)],
      isLineGenerating: () => false,
    })
  }

  it('组序/组内序/条目对象与侧栏分组原样一致（同一 owner 派生不允许两个口径）', () => {
    const viaList = makeService().list({ surface: 'sidebar' })
    const viaSidebar = makeService().list({ surface: 'sidebar' })
    expect(viaList).toEqual(SIDEBAR_GROUPS) // 深等（组序 + 组内序 + 条目对象逐字段）
    expect(viaList).toEqual(viaSidebar)
    // 侧栏口径不含任何 btw 线条目（即使注册表有线）
    expect(viaList.flatMap((g) => g.sessions).some((s) => s.surface === 'btw')).toBe(false)
    expect(ids(viaList).some((id) => id.startsWith('btw:'))).toBe(false)
  })

  it('机器比对（④ 告警形态）：真实服务两口径偏差为空', () => {
    const svc = makeService()
    // 广播口径 = owner 直出（message-broker.ts:261 buildSessionListMsg 的 groups 同源：
    // sessionService.listPersistedSessions 产物）——不是查询口径的自调用
    const broadcast = sidebarCaliberSource()
    // 查询口径 = session.list {surface:'sidebar'} 经 SessionListQueryService 的派生结果
    const list = svc.list({ surface: 'sidebar' })
    expect(twoCaliberDeviation(broadcast, list)).toEqual([])
  })

  it('机器比对有区分度（防门失明）：注入偏差可检测（组序颠倒 / 条目缺失 / 字段漂移）', () => {
    const groups = makeService().list({ surface: 'sidebar' })
    // ① 组序颠倒（查询侧分组顺序漂移）
    expect(twoCaliberDeviation(groups, [...groups].reverse())).not.toEqual([])
    // ② 条目缺失（广播口径整批消失——验收项 10 同族：单向负面断言对空集合 vacuously 通过）
    const [g0] = groups
    expect(twoCaliberDeviation(groups, [{ cwd: g0.cwd, sessions: g0.sessions.slice(1) }])).not.toEqual([])
    // ③ 字段漂移（同 id 同序但 lastActiveAt 不同——「逐条一致」必须逐字段）
    const mutated: SessionGroup[] = groups.map((g) => ({
      cwd: g.cwd,
      sessions: g.sessions.map((s, i) => (i === 0 ? { ...s, lastActiveAt: s.lastActiveAt + 1 } : s)),
    }))
    expect(twoCaliberDeviation(groups, mutated)).not.toEqual([])
  })
})

describe('§7 验收项 12③：§10.2 两态断言（结论 = 不切）——查询入口存活即退役条件未执行', () => {
  const groups: SessionGroup[] = [{ cwd: '/repo/a', sessions: [sidebarSummary(randomUUID(), '/repo/a', 1)] }]
  const listSessions = vi.fn((_query: { surface?: SessionSurface; mainSessionId?: string }) => groups)

  it('transport 接线：session.list 经 handler reply {groups}（查询入口在场，未被 W5 退役）', async () => {
    const ctx = mockContext({ listSessions })
    const handler = new SessionMessageHandler(ctx)
    expect(handler.handles).toContain('session.list')

    await handler.handleSessionMessage(msg('session.list', { surface: 'sidebar' }), mockWs())

    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(listSessions).toHaveBeenCalledWith({ surface: 'sidebar' })
    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'session.list', { groups })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('过滤参数原样透传（surface + mainSessionId；缺省字段不作为 undefined 键传入）', async () => {
    const ctx = mockContext({ listSessions })
    const handler = new SessionMessageHandler(ctx)
    const mainSid = randomUUID()

    await handler.handleSessionMessage(msg('session.list', { surface: 'btw', mainSessionId: mainSid }), mockWs())
    expect(listSessions).toHaveBeenLastCalledWith({ surface: 'btw', mainSessionId: mainSid })

    await handler.handleSessionMessage(msg('session.list', {}), mockWs())
    expect(listSessions).toHaveBeenLastCalledWith({})
  })

  it('防御分支：listSessions 未组装（测试最小 mock 形态）→ session_list_unsupported 显式报错', async () => {
    const ctx = mockContext({}) // 无 listSessions 成员
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('session.list', { surface: 'btw' }), mockWs())

    expect(ctx.sendError).toHaveBeenCalledWith(expect.anything(), 'session_list_unsupported', 'session list query not available', 'msg-1')
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
