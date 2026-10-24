// @vitest-environment node

/**
 * session push → store 同步测试（renamed / state_changed / thinkingLevelSet 三类推送；
 * 原 session-state-changed-sync.test.ts 已并入本文件——同 SUT ensureStreamSubscription
 * switch 分支、逐字相同 mock 脚手架）。
 *
 * session.renamed（AGENTS.md 规则 #7 Session 隔离）：
 * 锁定 pi 改写 session 名（session_info_changed）经 runtime event-adapter 映射为
 * session.renamed 推送（payload { sessionId, name }），useChat 的 switch 消费后经
 * sessionStore.applySnapshot 同步侧栏 label。事故背景：tui-to-gui-mapping-audit.md:62
 * 标记 session_info_changed 未处理，useChat 的 switch 落到 default:break 丢弃。
 *
 * session.state_changed / session.thinkingLevelSet（W3；[W1 会话架构四层分离] 起写**状态层**）：
 * model.switch 后 runtime 广播 state_changed（modelId + thinkingLevel），Composer 工具条经
 * 状态层跟随；thinkingLevelSet 为独立窄更新通道。两者都不再经 sessionStore.applySnapshot
 * （列表成员资格不得成为状态写入判据——本文件反向锁定该不变量）。
 *
 * mock 策略：vi.hoisted + vi.mock('@/api')（chat.streamSubscribe 捕获回调，手动触发），
 * 真用 useSessionStore（验证 applySnapshot 落点）+ useChat（被测入口）。
 * 注：useChat streamSubscriptions 是模块级单例，同文件各用例 sid 必须唯一。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/session-renamed-sync.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary, SessionGroup } from '@taiji/shared'
import { textToSegments } from '@taiji/shared'
// '@/api' mock 工厂解引用的 helper import 必须先于触发工厂执行的 import（useChat 链）求值
import { apiProjectMock } from './helpers/api-facade-mock'
import { makeStreamSubscribeMock } from './helpers/stream-subscribe-mock'
// mock 实例（工厂内创建）的清除入口：经 mock 后的 '@/api' 取引用（同 settings quota 域范式）
import { chat as apiChatMock } from '@/api'

type StreamCb = (msg: { type: string; payload: Record<string, unknown> }) => void

// vi.hoisted 工厂被 hoist 到 import 之前执行，不能引用 import 绑定（TDZ）；
// streamSubscribe mock 本体经 helper 在 '@/api' 工厂内创建（工厂惰性执行期才解引用 import）
const streamCbHolder = vi.hoisted(() => ({ current: null as StreamCb | null }))

vi.mock('@/api', () => ({
  // project 域空载基座单源在 helpers/api-facade-mock（mount 链 onMounted 消费 project.load）
  project: apiProjectMock(),
  // streamSubscribe 捕获回调脚手架单源在 helpers/stream-subscribe-mock
  chat: { send: vi.fn(), streamSubscribe: makeStreamSubscribeMock(streamCbHolder) },
  // w5：useChat 薄包装 import session.writeSegments（写 segments sidecar），mock 补全
  session: {
    writeSegments: vi.fn(() => Promise.resolve()),
  },
}))

import { useChat } from '@/composables/features/chat/useChat'
import { useSessionStore } from '@/stores/session'
import { useSessionLiveStateStore } from '@/stores/session-live-state'

beforeEach(() => {
  setActivePinia(createPinia())
  streamCbHolder.current = null
  vi.mocked(apiChatMock.streamSubscribe).mockClear()
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

describe('session.state_changed 事件 → 状态层同步（W1：不经导航列表）', () => {
  it('U14: 正常 state_changed（sessionId + modelId + thinkingLevel）→ 状态层更新', async () => {
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

    expect(useSessionLiveStateStore().liveStateOf('sc-1')).toEqual({
      modelId: 'anthropic/claude-4',
      thinkingLevel: 'high',
    })
    // 导航列表不承载状态字段（列表只是种子）
    expect(useSessionStore().list.find((s) => s.id === 'sc-1')?.modelId).toBe('old/model')
  })

  it('thinkingLevel 为 undefined 时只更新 modelId，已缓存档位保留（字段级合并）', async () => {
    seedSession({
      id: 'sc-2', label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100, modelId: 'old/model', thinkingLevel: 'low', tokenCount: 0,
    })
    const liveStore = useSessionLiveStateStore()
    liveStore.applyLiveState('sc-2', { thinkingLevel: 'low' })
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

    expect(liveStore.liveStateOf('sc-2')).toEqual({ modelId: 'openai/gpt-4', thinkingLevel: 'low' })
  })

  it('[W1] 侧栏列表之外的会话 id（btw 线 session id）状态帧同样落地（无列表命中判据）', async () => {
    const vid = 'pi-line-sync' // 线 session id（W4a 后 = pi 真实 id）
    const chat = useChat()
    await chat.send(vid, textToSegments('触发订阅'))

    streamCbHolder.current!({
      type: 'session.state_changed',
      payload: { sessionId: vid, modelId: 'line/model', thinkingLevel: 'low' },
    })

    expect(useSessionLiveStateStore().liveStateOf(vid)).toEqual({
      modelId: 'line/model',
      thinkingLevel: 'low',
    })
    // 列表未新增该 id（导航视图不变）
    expect(useSessionStore().list.some((s) => s.id === vid)).toBe(false)
  })

  it('其他 session 的 state_changed 不影响当前 session（按 id 分区）', async () => {
    seedSession({
      id: 'sc-3', label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100, modelId: 'original', thinkingLevel: 'max', tokenCount: 0,
    })
    const liveStore = useSessionLiveStateStore()
    liveStore.applyLiveState('sc-3', { modelId: 'original', thinkingLevel: 'max' })
    const chat = useChat()
    await chat.send('sc-3', textToSegments('触发订阅'))

    streamCbHolder.current!({
      type: 'session.state_changed',
      payload: {
        sessionId: 'other-session',
        modelId: 'should/not/apply',
        thinkingLevel: 'off',
      },
    })

    expect(liveStore.liveStateOf('sc-3')).toEqual({ modelId: 'original', thinkingLevel: 'max' })
  })
})

describe('session.thinkingLevelSet 事件 → 状态层 thinkingLevel 同步', () => {
  it('U-TLSet-1: payload 含 sessionId + level → 状态层更新 thinkingLevel', async () => {
    // 注：streamSubscriptions 是 useChat 模块级单例，跨用例复用 sid 会跳过订阅，故用唯一 sid。
    const sid = 'tlset-1'
    seedSession({
      id: sid, label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100, modelId: 'm', thinkingLevel: 'low', tokenCount: 0,
    })
    const liveStore = useSessionLiveStateStore()
    liveStore.applyLiveState(sid, { modelId: 'm', thinkingLevel: 'low' })
    const chat = useChat()
    await chat.send(sid, textToSegments('触发订阅'))
    expect(streamCbHolder.current).not.toBeNull()

    streamCbHolder.current!({
      type: 'session.thinkingLevelSet',
      payload: { sessionId: sid, level: 'high' },
    })

    expect(liveStore.liveStateOf(sid)).toEqual({ modelId: 'm', thinkingLevel: 'high' })
    // 导航列表不写（W1）——列表 thinkingLevel 保持种子
    expect(useSessionStore().list.find((s) => s.id === sid)?.thinkingLevel).toBe('low')
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

    streamCbHolder.current!({
      type: 'session.thinkingLevelSet',
      payload: { sessionId: sid, level: undefined },
    })

    expect(useSessionLiveStateStore().liveStateOf(sid)).toBeUndefined()
    expect(useSessionStore().list.find((s) => s.id === sid)?.thinkingLevel).toBe('low')
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

    streamCbHolder.current!({
      type: 'session.thinkingLevelSet',
      payload: { sessionId: undefined, level: 'high' },
    })

    expect(useSessionLiveStateStore().liveStateOf(sid)).toBeUndefined()
    expect(useSessionStore().list.find((s) => s.id === sid)?.thinkingLevel).toBe('low')
  })
})
