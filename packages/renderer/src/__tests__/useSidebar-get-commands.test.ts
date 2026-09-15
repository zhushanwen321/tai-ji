/**
 * wave:remove-bandaids 测试：selectSession 不再主动拉 commands/context。
 *
 * 历史：原 bandaid 修复 broadcast 与订阅时序竞争（runtime broadcast session.commands 早于
 * renderer 订阅新 sessionId 通道被丢弃），selectSession 在 activeId 更新后主动调 getCommands。
 * 现已删除——commands 由 useChat.ensureStreamSubscription → subscribeSession → applySnapshot 的
 * stateSnapshot dispatch 提供（routeInbound 兜底分支更新 commandStore）。
 *
 * 本测试反转原断言：验证 getCommands 不再被 selectSession 调用（R4：保留 RPC handler，
 * 其他独立场景仍可调用；sessionApi.getCommands RPC 客户端函数保留）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/useSidebar-get-commands.test.ts
 */
import { it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import * as events from '@taiji/core/transport/api'

// mock sessionApi：getCommands/getContext 用 spy 断言「不被调用」。
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  session: {
    list: vi.fn(() => Promise.resolve([])),
    switchSession: vi.fn(() => Promise.resolve()),
    getCommands: vi.fn(() => Promise.resolve({
      sessionId: 's1',
      commands: [
        { name: '/commit', description: '提交', source: 'extension' },
        { name: 'skill:code-review', description: '审查', source: 'skill' },
      ],
    })),
    getContext: vi.fn(() => Promise.resolve({ inputTokens: 0, contextLimit: 0, usagePercent: 0 })),
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    create: vi.fn(() => Promise.resolve({ id: 'mock', label: 'mock', cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 })),
    setThinkingLevel: vi.fn(() => Promise.resolve()),
  },
  chat: { getHistory: vi.fn(() => Promise.resolve([])), streamSubscribe: vi.fn(() => () => {}) },
  // selectSession 触发 loadTree（文件树预加载），补 file/git domain mock 避免 unhandled rejection
  file: { tree: vi.fn(() => Promise.resolve([])), expand: vi.fn(() => Promise.resolve([])) },
  git: { status: vi.fn(() => Promise.resolve({ sessionId: 's1', isRepo: false, files: [] })) },
}))

import { session as sessionMock } from '@/api'

import { useSidebar } from '@/composables/features/sidebar/useSidebar'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

function makeSummary(id: string): SessionSummary {
  return { id, label: id, cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 }
}

function makeGroups(ids: string[]): SessionGroup[] {
  return [{ cwd: '/proj', sessions: ids.map(makeSummary) }]
}

it('U1: selectSession 不再主动调 sessionApi.getCommands（wave:remove-bandaids 删兜底）', async () => {
  const scope = effectScope()
  const sidebar = scope.run(() => useSidebar())!
  events.dispatchGlobal({ type: 'config.sessions', payload: { groups: makeGroups(['s1']) } })

  await sidebar.selectSession('s1')

  expect(sessionMock.switchSession).toHaveBeenCalledWith('s1')
  // 关键断言：getCommands 不再被 selectSession 调用（commands 由 subscribe stateSnapshot 提供）
  expect(sessionMock.getCommands).not.toHaveBeenCalled()
  scope.stop()
})

it('U2: selectSession 不再主动调 sessionApi.getContext（wave:remove-bandaids 删兜底）', async () => {
  const scope = effectScope()
  const sidebar = scope.run(() => useSidebar())!
  events.dispatchGlobal({ type: 'config.sessions', payload: { groups: makeGroups(['s1']) } })

  await sidebar.selectSession('s1')

  // getContext 不再被 selectSession 调用（context 由 subscribe stateSnapshot 提供）
  expect(sessionMock.getContext).not.toHaveBeenCalled()
  scope.stop()
})

it('U3: selectSession 不向 session 通道本地投递 session.commands（由 subscribe stateSnapshot 接管）', async () => {
  const scope = effectScope()
  const sidebar = scope.run(() => useSidebar())!
  events.dispatchGlobal({ type: 'config.sessions', payload: { groups: makeGroups(['s1']) } })

  const received: Array<{ type: string; payload: { commands?: unknown[] } }> = []
  events.on('s1', (msg) => received.push(msg as never))

  await sidebar.selectSession('s1')

  // selectSession 不再本地 dispatch session.commands（subscribe stateSnapshot 接管，
  // 此处 mock 未触发 subscribeSession，故 commands 消息不应出现）
  const cmdMsgs = received.filter((m) => m.type === 'session.commands' && m.payload.commands)
  expect(cmdMsgs).toHaveLength(0)
  scope.stop()
})
