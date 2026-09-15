/**
 * session push → store 同步测试（renamed / state_changed / thinkingLevelSet 三类推送；
 * 原 session-state-changed-sync.test.ts 已并入本文件——同 SUT ensureStreamSubscription
 * switch 分支、逐字相同 mock 脚手架）。
 *
 * session.renamed（CLAUDE.md 规则 #7 Session 隔离）：
 * 锁定 pi 改写 session 名（session_info_changed）经 runtime event-adapter 映射为
 * session.renamed 推送（payload { sessionId, name }），useChat 的 switch 消费后经
 * sessionStore.applySnapshot 同步侧栏 label。事故背景：tui-to-gui-mapping-audit.md:62
 * 标记 session_info_changed 未处理，useChat 的 switch 落到 default:break 丢弃。
 *
 * session.state_changed / session.thinkingLevelSet（W3）：
 * model.switch 后 runtime 广播 state_changed（modelId + thinkingLevel + 重算用量），
 * Composer 工具条跟随；thinkingLevelSet 为独立窄更新通道。
 *
 * mock 策略：vi.hoisted + vi.mock('@/api')（chat.streamSubscribe 捕获回调，手动触发），
 * 真用 useSessionStore（验证 applySnapshot 落点）+ useChat（被测入口）。
 * 注：useChat streamSubscriptions 是模块级单例，同文件各用例 sid 必须唯一。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/session-renamed-sync.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'
import { textToSegments } from '@xyz-agent/shared'

type StreamCb = (msg: { type: string; payload: Record<string, unknown> }) => void

// vi.mock factory 是 hoisted 的，不能引用外部变量；用 vi.hoisted 提升共享状态
const { streamCbHolder, streamSubscribeMock } = vi.hoisted(() => ({
  streamCbHolder: { current: null as StreamCb | null },
  streamSubscribeMock: vi.fn((_sid: string, cb: StreamCb) => {
    streamCbHolder.current = cb
    return () => {
      streamCbHolder.current = null
    }
  }),
}))

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: { send: vi.fn(), streamSubscribe: streamSubscribeMock },
  // w5：useChat 薄包装 import session.writeSegments（写 segments sidecar），mock 补全
  session: {
    writeSegments: vi.fn(() => Promise.resolve()),
  },
}))

import { useChat } from '@/composables/features/chat/useChat'
import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
  streamCbHolder.current = null
  streamSubscribeMock.mockClear()
})

/** 往 session store 填一个 session（按 cwd 归组） */
function seedSession(s: SessionSummary): void {
  const store = useSessionStore()
  const group: SessionGroup = { cwd: s.cwd, sessions: [s] }
  store.applySnapshot({ groups: [group] })
}

describe('session.renamed 事件 → store label 同步', () => {
  it('正常 session.renamed（sessionId+name）→ store 对应 session label 更新', async () => {
    seedSession({
      id: 's1',
      label: '旧名字',
      cwd: '/repo',
      status: 'idle',
      lastActiveAt: 100,
      modelId: 'm',
      tokenCount: 0,
    })
    const chat = useChat()
    // send 触发 ensureStreamSubscription，注册回调（mock 捕获）
    await chat.send('s1', textToSegments('触发订阅'))
    expect(streamCbHolder.current).not.toBeNull()

    // 模拟 runtime 推送 session.renamed
    streamCbHolder.current!({ type: 'session.renamed', payload: { sessionId: 's1', name: 'pi 生成的新名字' } })

    const updated = useSessionStore().list.find((s) => s.id === 's1')
    expect(updated?.label).toBe('pi 生成的新名字')
  })

  it('payload.name 为空字符串 → 跳过，label 不被覆盖（防 pi 推空名覆盖用户 rename）', async () => {
    seedSession({
      id: 's2',
      label: '用户手动起的名',
      cwd: '/repo',
      status: 'idle',
      lastActiveAt: 100,
      modelId: 'm',
      tokenCount: 0,
    })
    const chat = useChat()
    await chat.send('s2', textToSegments('触发订阅'))

    streamCbHolder.current!({ type: 'session.renamed', payload: { sessionId: 's2', name: '' } })

    const updated = useSessionStore().list.find((s) => s.id === 's2')
    expect(updated?.label).toBe('用户手动起的名') // 保持原值，未被空名覆盖
  })

  it('payload.name 为 undefined → 跳过', async () => {
    seedSession({
      id: 's3',
      label: '原名',
      cwd: '/repo',
      status: 'idle',
      lastActiveAt: 100,
      modelId: 'm',
      tokenCount: 0,
    })
    const chat = useChat()
    await chat.send('s3', textToSegments('触发订阅'))

    // event-adapter 对 event.name 为 undefined 时 payload.name 也为 undefined
    streamCbHolder.current!({ type: 'session.renamed', payload: { sessionId: 's3' } })

    const updated = useSessionStore().list.find((s) => s.id === 's3')
    expect(updated?.label).toBe('原名')
  })
})

describe('session.state_changed 事件 → store 状态同步', () => {
  it('U14: 正常 state_changed（sessionId + modelId + thinkingLevel）→ store 更新', async () => {
    seedSession({
      id: 'sc-1', label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100, modelId: 'old/model', thinkingLevel: 'medium', tokenCount: 0,
    })
    const chat = useChat()
    await chat.send('sc-1', textToSegments('触发订阅'))
    expect(streamCbHolder.current).not.toBeNull()

    streamCbHolder.current!({
      type: 'session.state_changed',
      payload: {
        sessionId: 'sc-1',
        modelId: 'anthropic/claude-4',
        thinkingLevel: 'high',
      },
    })

    const updated = useSessionStore().list.find((s) => s.id === 'sc-1')
    expect(updated?.modelId).toBe('anthropic/claude-4')
    expect(updated?.thinkingLevel).toBe('high')
  })

  it('thinkingLevel 为 undefined 时只更新 modelId，thinkingLevel 保留旧值', async () => {
    seedSession({
      id: 'sc-2', label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100, modelId: 'old/model', thinkingLevel: 'low', tokenCount: 0,
    })
    const chat = useChat()
    await chat.send('sc-2', textToSegments('触发订阅'))

    streamCbHolder.current!({
      type: 'session.state_changed',
      payload: {
        sessionId: 'sc-2',
        modelId: 'openai/gpt-4',
        thinkingLevel: undefined,
      },
    })

    const updated = useSessionStore().list.find((s) => s.id === 'sc-2')
    expect(updated?.modelId).toBe('openai/gpt-4')
    expect(updated?.thinkingLevel).toBe('low') // undefined 跳过，保留旧值
  })

  it('其他 session 的 state_changed 不影响当前 session', async () => {
    seedSession({
      id: 'sc-3', label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100, modelId: 'original', thinkingLevel: 'max', tokenCount: 0,
    })
    const chat = useChat()
    await chat.send('sc-3', textToSegments('触发订阅'))

    // payload.sessionId 指向另一个 session（streamSubscribe 按 sid 路由，实际不会收到，
    // 但 applySnapshot 内部按 id 查找，不匹配则 no-op）
    streamCbHolder.current!({
      type: 'session.state_changed',
      payload: {
        sessionId: 'other-session',
        modelId: 'should/not/apply',
        thinkingLevel: 'off',
      },
    })

    const updated = useSessionStore().list.find((s) => s.id === 'sc-3')
    expect(updated?.modelId).toBe('original') // 不受影响
    expect(updated?.thinkingLevel).toBe('max')
  })
})

describe('session.thinkingLevelSet 事件 → store thinkingLevel 同步', () => {
  it('U-TLSet-1: payload 含 sessionId + level → applySnapshot 更新 thinkingLevel', async () => {
    // 注：streamSubscriptions 是 useChat 模块级单例，跨用例复用 sid 会跳过订阅，故用唯一 sid。
    const sid = 'tlset-1'
    seedSession({
      id: sid, label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100, modelId: 'm', thinkingLevel: 'low', tokenCount: 0,
    })
    const chat = useChat()
    await chat.send(sid, textToSegments('触发订阅'))
    expect(streamCbHolder.current).not.toBeNull()

    const updateSpy = vi.spyOn(useSessionStore(), 'applySnapshot')
    streamCbHolder.current!({
      type: 'session.thinkingLevelSet',
      payload: { sessionId: sid, level: 'high' },
    })

    expect(updateSpy).toHaveBeenCalledWith(sid, { thinkingLevel: 'high' })
  })

  it('U-TLSet-2: level 缺省时跳过更新', async () => {
    const sid = 'tlset-2'
    seedSession({
      id: sid, label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100, modelId: 'm', thinkingLevel: 'low', tokenCount: 0,
    })
    const chat = useChat()
    await chat.send(sid, textToSegments('触发订阅'))
    expect(streamCbHolder.current).not.toBeNull()

    const updateSpy = vi.spyOn(useSessionStore(), 'applySnapshot')
    streamCbHolder.current!({
      type: 'session.thinkingLevelSet',
      payload: { sessionId: sid, level: undefined },
    })

    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('U-TLSet-3: sessionId 缺省时跳过更新', async () => {
    const sid = 'tlset-3'
    seedSession({
      id: sid, label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100, modelId: 'm', thinkingLevel: 'low', tokenCount: 0,
    })
    const chat = useChat()
    await chat.send(sid, textToSegments('触发订阅'))
    expect(streamCbHolder.current).not.toBeNull()

    const updateSpy = vi.spyOn(useSessionStore(), 'applySnapshot')
    streamCbHolder.current!({
      type: 'session.thinkingLevelSet',
      payload: { sessionId: undefined, level: 'high' },
    })

    expect(updateSpy).not.toHaveBeenCalled()
  })
})
