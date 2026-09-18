/**
 * useSidebar config.sessions 订阅单测（#7 方案 A；AGENTS.md 规则 #2 防重复注册）。
 *
 * 覆盖：
 * - config.sessions 广播 → session store applySnapshot 整表更新列表（不重载历史）
 * - 多实例 refCount 去重：N 次 useSidebar() 只注册 1 个 handler，一次广播只触发 1 次整表快照应用
 * - 全部 effect scope 释放后监听取消（onScopeDispose 收尾），广播不再更新
 *
 * 注：WS 消息类型原为 session.list，PR #87 D1 重构重命名为 config.sessions（useSidebar 同步订阅 config.sessions）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/useSidebar-session-list.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import type { SessionGroup, SessionSummary } from '@taiji/shared'

// features 层调用 api 域；本测试只验订阅链路，把 api 域全 mock 成 no-op（订阅走真实的 @/api/events）。
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: { getHistory: vi.fn(() => Promise.resolve([])) },
  session: {
    create: vi.fn(() => Promise.resolve(makeSummary('mock'))),
    list: vi.fn(() => Promise.resolve([])),
    switchSession: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
  },
}))

import * as events from '@taiji/core/transport/api'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

function makeSummary(id: string): SessionSummary {
  return { id, label: id, cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 }
}

function makeGroups(): SessionGroup[] {
  return [{ cwd: '/proj', sessions: [makeSummary('s1')] }]
}

/** 模拟 runtime broadcastSessionList：广播一条 config.sessions ServerMessage（PR #87 D1：session.list → config.sessions 重命名） */
function broadcastSessionList(groups: SessionGroup[]): void {
  events.dispatchGlobal({ type: 'config.sessions', payload: { groups } })
}

it('config.sessions 广播经 useSidebar 订阅更新 session store', () => {
  const scope = effectScope()
  scope.run(() => useSidebar())
  // pinia session store（ADR-0059：薄壳 useSessionStore 单例）
  expect(useSessionStore().groups).toEqual([])

  broadcastSessionList(makeGroups())
  expect(useSessionStore().groups).toEqual(makeGroups())

  scope.stop()
})

it('多实例 refCount 去重：N 次 useSidebar() 只注册 1 个 config.sessions handler', () => {
  // 薄壳化后 sessionStore 是 pinia 单例（所有实例共享同一 store），去重的可观测行为变为
  // 「config.sessions handler 只注册 1 次」（core bindSessionListBroadcast 模块级 sessionListSubCount），
  // 而非旧 per-instance raw store 的「不同实例 store 值不同」（ADR-0059 消除双轨）。
  const onGlobalTypeSpy = vi.spyOn(events, 'onGlobalType').mockReturnValue(() => {})

  const a = effectScope()
  a.run(() => useSidebar())!
  const b = effectScope()
  const c = effectScope()
  b.run(() => useSidebar())!
  c.run(() => useSidebar())!

  // 3 个实例只注册 1 个 config.sessions handler（refCount 去重）
  const sessionHandlerCount = onGlobalTypeSpy.mock.calls.filter(
    ([type]) => type === 'config.sessions',
  ).length
  expect(sessionHandlerCount).toBe(1)

  a.stop()
  b.stop()
  c.stop()
})

it('全部 scope 释放后监听取消：广播不再更新 store', () => {
  const scope = effectScope()
  scope.run(() => useSidebar())
  // 先填入一组数据，释放后广播应保持不变
  useSessionStore().applySnapshot({ groups: makeGroups() })
  const before = useSessionStore().groups

  scope.stop() // onScopeDispose → refCount 1→0 → 取消监听
  broadcastSessionList([{ cwd: '/other', sessions: [makeSummary('x')] }])

  expect(useSessionStore().groups).toEqual(before) // 未变 = 监听已取消
})
