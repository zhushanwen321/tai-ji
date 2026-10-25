// [u-sessions] app-runtime 接线段单测（remote-use-mobile-v2 验收条款 1/2/3）：
// ① 双源分组谓词（§6.19）：未订阅 active 会话归「进行中」组、dead 优先「最近」组；
// ② 未读置位（lastActiveAt 推进或 status 翻转且非活跃；首见会话按落盘 lastVisitedAt
//    对照播种——刷新后未读恢复）/ 点入即清（§6.3 客户端半）；
// ③ 删除级联三件：关闭相关 Sheet + localStorage lastVisitedAt 条目摘除 + 草稿条目丢弃。
//
// mock 策略（对齐 shell/__tests__/app-runtime.test.ts）：仅 transport 出口（session 域
// remove RPC）模块级 vi.mock 隔离 WS，app-runtime 组装与 core 链保持全真实；config.sessions
// 广播帧经 dispatchGlobal（core events 层真实现）驱动。存储经 PlatformPort 内存实现注入
// （真实 localStorage 桥接语义不在本层）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { dispatchGlobal } from '@taiji/core/transport/api'
import { providePlatform, __resetPlatformForTesting } from '@taiji/core'
import type { KVStorage } from '@taiji/core'
import type { SessionGroup, SessionSummary, ServerMessage } from '@taiji/shared'
import {
  deleteSessionWithCascade,
  draftOf,
  groupSessions,
  isSessionUnread,
  markSessionVisited,
  mobileRowStatusOf,
  resetSessionsRuntimeForTesting,
  setDraft,
  LAST_VISITED_KEY_PREFIX,
} from '../sessions-runtime'
import { activeSessionId, sessionStore } from '../app-runtime'
import { activeSheet, openSheet, resetSheetManagerForTesting } from '../sheet-manager'

const mockRemove = vi.hoisted(() => vi.fn((_id: string) => Promise.resolve()))

vi.mock('@taiji/core/transport/api/domains/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/session')>()
  return { ...actual, remove: mockRemove }
})

/** 内存 KVStorage（PlatformPort.storage 注入替身，settings-screen.test.ts 同款） */
function memoryStorage(): KVStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    async get(key: string) {
      return map.get(key) ?? null
    },
    async set(key: string, value: string) {
      map.set(key, value)
    },
    async remove(key: string) {
      map.delete(key)
    },
  }
}

let storage: ReturnType<typeof memoryStorage>

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'status' | 'lastActiveAt'>): SessionSummary {
  return { label: `会话-${overrides.id}`, cwd: '/tmp/project', ...overrides }
}

function groupOf(...sessions: SessionSummary[]): SessionGroup[] {
  return sessions.map((s) => ({ cwd: s.cwd, sessions: [s] }))
}

function sessionsFrame(groups: SessionGroup[]): ServerMessage<'config.sessions'> {
  return { type: 'config.sessions', payload: { groups } } as ServerMessage<'config.sessions'>
}

/** DeriveStatusChat 合成实现（判定输入显式注入；派生行为矩阵归 core 既有测试） */
function fakeChat(generating = false) {
  return {
    getMessages: vi.fn(() => []),
    isGenerating: vi.fn(() => generating),
  }
}

/** 分组谓词 deps（除 chat 外默认全 false 的合成输入束） */
function depsOf(overrides: Partial<Parameters<typeof groupSessions>[1]> = {}, generating = false) {
  const flags = overrides
  return {
    chat: overrides.chat ?? fakeChat(generating),
    isSubscribed: (sid: string) => flags.isSubscribed?.(sid) ?? false,
    isActive: (sid: string) => flags.isActive?.(sid) ?? false,
    isCompacting: (sid: string) => flags.isCompacting?.(sid) ?? false,
    hasBackgroundWork: (sid: string) => flags.hasBackgroundWork?.(sid) ?? false,
    hasBlockingOverlay: (sid: string) => flags.hasBlockingOverlay?.(sid) ?? false,
    isUnread: (sid: string) => flags.isUnread?.(sid) ?? false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetPlatformForTesting()
  storage = memoryStorage()
  providePlatform({
    kind: 'mobile',
    storage,
    webSocket: { create: () => {
      throw new Error('not used in sessions runtime tests')
    } },
  })
  resetSessionsRuntimeForTesting()
  resetSheetManagerForTesting()
  activeSessionId.value = null
})

afterEach(() => {
  __resetPlatformForTesting()
})

// ── 验收条款 1：双源分组（§6.19）────────────────────────────────────────────

describe('双源分组谓词（§6.19）', () => {
  it('未订阅 active 会话归「进行中」组，行状态为 active 摘要态（accent 脉冲族）', () => {
    const s = summary({ id: 's-active', status: 'active', lastActiveAt: 100 })
    const { inProgress, recent } = groupSessions([s], depsOf())
    expect(inProgress).toHaveLength(1)
    expect(inProgress[0]!.status).toBe('active')
    expect(recent).toHaveLength(0)
  })

  it('dead 优先归「最近」组（即使对话派生输入指向进行族）', () => {
    const s = summary({ id: 's-dead', status: 'dead', lastActiveAt: 100 })
    // 已订阅 + 流式中仍判 dead：进程态权威于对话派生（v1 SessionListItem 同语义）
    const d = depsOf({ isSubscribed: () => true, isActive: () => true }, true)
    expect(mobileRowStatusOf(s, d)).toBe('dead')
    const { inProgress, recent } = groupSessions([s], d)
    expect(inProgress).toHaveLength(0)
    expect(recent).toHaveLength(1)
    expect(recent[0]!.status).toBe('dead')
  })

  it('未订阅终态（idle/done/error/stopped）归「最近」组（idle/done 摘要映射 done）', () => {
    const idle = summary({ id: 's-idle', status: 'idle', lastActiveAt: 100 })
    const done = summary({ id: 's-done', status: 'done', lastActiveAt: 100 })
    const error = summary({ id: 's-error', status: 'error', lastActiveAt: 100 })
    const stopped = summary({ id: 's-stopped', status: 'stopped', lastActiveAt: 100 })
    const { inProgress, recent } = groupSessions([idle, done, error, stopped], depsOf())
    expect(inProgress).toHaveLength(0)
    expect(recent.map((m) => [m.summary.id, m.status])).toEqual([
      ['s-idle', 'done'],
      ['s-done', 'done'],
      ['s-error', 'error'],
      ['s-stopped', 'stopped'],
    ])
  })

  it('已订阅会话走完整 9 态（流式中 → streaming 归「进行中」组）', () => {
    const s = summary({ id: 's-stream', status: 'active', lastActiveAt: 100 })
    const d = depsOf({ isSubscribed: () => true }, true)
    const { inProgress, recent } = groupSessions([s], d)
    expect(inProgress).toHaveLength(1)
    expect(inProgress[0]!.status).toBe('streaming')
    expect(recent).toHaveLength(0)
  })

  it('hasBlockingOverlay 喂入（已订阅 + 待回答覆盖请求非空）→ waiting 态点亮（§6.19 接线）', () => {
    const s = summary({ id: 's-wait', status: 'active', lastActiveAt: 100 })
    const without = depsOf({ isSubscribed: () => true })
    expect(mobileRowStatusOf(s, without)).not.toBe('waiting')
    const withOverlay = depsOf({ isSubscribed: () => true, hasBlockingOverlay: () => true })
    expect(mobileRowStatusOf(s, withOverlay)).toBe('waiting')
    // waiting 属进行族 → 「进行中」组
    const { inProgress } = groupSessions([s], withOverlay)
    expect(inProgress).toHaveLength(1)
  })

  it('未读标记随行模型透出（model.unread）', () => {
    const s = summary({ id: 's-unread', status: 'done', lastActiveAt: 100 })
    const { recent } = groupSessions([s], depsOf({ isUnread: (sid) => sid === 's-unread' }))
    expect(recent[0]!.unread).toBe(true)
  })
})

// ── 验收条款 2：未读置位 / 点入即清（§6.3 客户端半）────────────────────────────

describe('未读 diff（§6.3）', () => {
  const baseGroups = () => groupOf(
    summary({ id: 's1', status: 'active', lastActiveAt: 100 }),
    summary({ id: 's2', status: 'active', lastActiveAt: 100 }),
  )

  it('首帧播种：无落盘 lastVisitedAt 条目不点亮（防新装/清缓存后全表误标未读）', () => {
    dispatchGlobal(sessionsFrame(baseGroups()))
    expect(isSessionUnread('s1')).toBe(false)
    expect(isSessionUnread('s2')).toBe(false)
  })

  it('刷新后未读恢复：首见会话按落盘 lastVisitedAt 对照播种（§6.3 持久对照半）', async () => {
    // 上次访问后有过新投递（lastActiveAt > lastVisitedAt）→ 恢复点亮
    await storage.set(LAST_VISITED_KEY_PREFIX + 's1', '50')
    // 上次访问后无活动（lastActiveAt <= lastVisitedAt）→ 不点亮
    await storage.set(LAST_VISITED_KEY_PREFIX + 's2', '150')
    dispatchGlobal(sessionsFrame(groupOf(
      summary({ id: 's1', status: 'active', lastActiveAt: 100 }),
      summary({ id: 's2', status: 'active', lastActiveAt: 100 }),
    )))
    await flushPromises()
    expect(isSessionUnread('s1')).toBe(true)
    expect(isSessionUnread('s2')).toBe(false)
  })

  it('播种不点亮当前活跃会话；条目损坏（非数字）不点亮', async () => {
    activeSessionId.value = 's1'
    await storage.set(LAST_VISITED_KEY_PREFIX + 's1', '50')
    await storage.set(LAST_VISITED_KEY_PREFIX + 's2', 'corrupt')
    dispatchGlobal(sessionsFrame(groupOf(
      summary({ id: 's1', status: 'active', lastActiveAt: 100 }),
      summary({ id: 's2', status: 'active', lastActiveAt: 100 }),
    )))
    await flushPromises()
    expect(isSessionUnread('s1')).toBe(false)
    expect(isSessionUnread('s2')).toBe(false)
  })

  it('lastActiveAt 推进且非活跃会话 → 置未读（新投递触发）', () => {
    dispatchGlobal(sessionsFrame(baseGroups()))
    dispatchGlobal(sessionsFrame(groupOf(
      summary({ id: 's1', status: 'active', lastActiveAt: 200 }),
      summary({ id: 's2', status: 'active', lastActiveAt: 100 }),
    )))
    expect(isSessionUnread('s1')).toBe(true)
    expect(isSessionUnread('s2')).toBe(false)
  })

  it('status 翻转且非活跃会话 → 置未读（新终态触发，lastActiveAt 不变）', () => {
    dispatchGlobal(sessionsFrame(baseGroups()))
    dispatchGlobal(sessionsFrame(groupOf(
      summary({ id: 's1', status: 'active', lastActiveAt: 100 }),
      summary({ id: 's2', status: 'stopped', lastActiveAt: 100 }),
    )))
    expect(isSessionUnread('s2')).toBe(true)
    expect(isSessionUnread('s1')).toBe(false)
  })

  it('当前活跃会话的变更不置未读（§6.3「不是当前活跃会话」分支）', () => {
    activeSessionId.value = 's1'
    dispatchGlobal(sessionsFrame(baseGroups()))
    dispatchGlobal(sessionsFrame(groupOf(
      summary({ id: 's1', status: 'active', lastActiveAt: 500 }),
      summary({ id: 's2', status: 'active', lastActiveAt: 100 }),
    )))
    expect(isSessionUnread('s1')).toBe(false)
  })

  it('点入即清：markSessionVisited 摘未读点 + lastVisitedAt 落 storage', async () => {
    dispatchGlobal(sessionsFrame(baseGroups()))
    dispatchGlobal(sessionsFrame(groupOf(summary({ id: 's1', status: 'active', lastActiveAt: 200 }))))
    expect(isSessionUnread('s1')).toBe(true)

    markSessionVisited('s1')
    expect(isSessionUnread('s1')).toBe(false)
    await flushPromises()
    expect(storage.map.get(LAST_VISITED_KEY_PREFIX + 's1')).not.toBeUndefined()
  })

  it('会话从快照消失 → 基线与未读同步摘除（删除/批量删除兜底收敛）', () => {
    dispatchGlobal(sessionsFrame(baseGroups()))
    dispatchGlobal(sessionsFrame(groupOf(summary({ id: 's1', status: 'active', lastActiveAt: 200 }))))
    expect(isSessionUnread('s1')).toBe(true)
    dispatchGlobal(sessionsFrame(groupOf(summary({ id: 's2', status: 'active', lastActiveAt: 100 }))))
    expect(isSessionUnread('s1')).toBe(false)
  })
})

// ── 验收条款 3：删除级联三件（§7.1）─────────────────────────────────────────

describe('删除级联三件（§7.1 删除级联补全）', () => {
  it('关闭相关 Sheet + localStorage lastVisitedAt 条目摘除 + 草稿条目丢弃', async () => {
    sessionStore.applySnapshot({ groups: groupOf(summary({ id: 'sid-del', status: 'idle', lastActiveAt: 1 })) })
    setDraft('sid-del', '未发送的草稿')
    markSessionVisited('sid-del')
    openSheet('sessionActions')
    expect(draftOf('sid-del')).toBe('未发送的草稿')
    expect(activeSheet.value).toBe('sessionActions')
    await flushPromises()
    expect(storage.map.get(LAST_VISITED_KEY_PREFIX + 'sid-del')).not.toBeUndefined()

    await deleteSessionWithCascade('sid-del')
    await flushPromises()

    // 三件逐项：① 相关 Sheet 关闭；② lastVisitedAt 条目摘除；③ 草稿条目丢弃
    expect(activeSheet.value).toBeNull()
    expect(storage.map.has(LAST_VISITED_KEY_PREFIX + 'sid-del')).toBe(false)
    expect(draftOf('sid-del')).toBe('')
    expect(isSessionUnread('sid-del')).toBe(false)
    expect(mockRemove).toHaveBeenCalledWith('sid-del')
  })

  it('级联不波及其他会话（单会话作用域）', async () => {
    sessionStore.applySnapshot({ groups: groupOf(
      summary({ id: 'sid-a', status: 'idle', lastActiveAt: 1 }),
      summary({ id: 'sid-b', status: 'idle', lastActiveAt: 2 }),
    ) })
    setDraft('sid-a', 'a 草稿')
    setDraft('sid-b', 'b 草稿')

    await deleteSessionWithCascade('sid-a')
    await flushPromises()

    expect(draftOf('sid-a')).toBe('')
    expect(draftOf('sid-b')).toBe('b 草稿')
  })
})

// ── 草稿分区（§7.1 草稿生命周期表的壳层载体；Composer 消费面）───────────────────

describe('草稿分区（draftOf/setDraft）', () => {
  it('空串写入摘除条目（不存空值）；未知会话读空串', () => {
    setDraft('s-draft', '内容')
    expect(draftOf('s-draft')).toBe('内容')
    setDraft('s-draft', '')
    expect(draftOf('s-draft')).toBe('')
    expect(draftOf('s-never')).toBe('')
  })
})
