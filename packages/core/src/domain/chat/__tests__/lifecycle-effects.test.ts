/**
 * createLifecycleEffects 单测（remote-use 双壳统一化 D5）。
 *
 * lifecycle-effects factory 是 exited/restored/restoreFailed 的 core 最小语义单一归属
 * （双壳共享：桌面 useMessageEffects 叠壳扩展 / 移动壳 U6 直接接线），本文件锁定全语义
 * 清单（设计 §3.3 D5 采用段）：
 * - markSessionDead：markSessionError（含流式终结）+ markDead + 订阅簿记失效，保序
 * - openRestoreWindow：恢复窗口订阅（restored/restoreFailed live 送达的唯一通路；幂等）
 * - onSessionRestored：revive + 恢复提示条（restored 形态）+ 重订阅
 * - onSessionRestoreFailed：willRetry 中间失败仅 log；熔断写恢复提示条（restoreFailed 形态）
 *
 * 模式：真实 createChatStore / createSessionStore（effectScope 包裹，respawn-notice.test.ts
 * 先例）+ setSubscriptionPorts 捕获 subscribe RPC（invalidate-stream-subscription.test.ts 先例）。
 * 纯内存，不触 fs。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { PI_RESPAWN_NOTICE_CUSTOM_TYPE } from '@taiji/shared'
import type { Message } from '@taiji/shared'
import { createChatStore } from '../store'
import { createSessionStore } from '../../session/store'
import { createLifecycleEffects } from '../lifecycle-effects'
import type { LifecycleEffects, LifecycleEffectsDeps, LifecycleNoticeTexts } from '../lifecycle-effects'
import {
  ensureStreamSubscription,
  resetChatModuleStateForTest,
} from '../useChat'
import type { EnsureStreamSubDeps } from '../useChat'
import {
  setSubscriptionPorts,
  getSubscriptionState,
  resetSubscriptionStates,
} from '../../../coordination/subscription-state'

const NOTICES: LifecycleNoticeTexts = {
  restored: '已恢复（fixture 文案）',
  restoreFailed: '恢复失败（fixture 文案）',
}

type SessionStore = ReturnType<typeof createSessionStore>

/** 等 fire-and-forget 的 subscribeSession（async）收敛（invalidate-stream-subscription.test.ts 同款）。
 *  reject 的 RPC（失败用例注入）同样等待其收敛但不外抛——settle 即续体跑完，失败方向由
 *  subscribed 状态断言承接。 */
const flushSubscribes = async (subscribeRpc: ReturnType<typeof vi.fn>): Promise<void> => {
  for (const r of subscribeRpc.mock.results) {
    await Promise.race([Promise.resolve(r.value).catch(() => {}), Promise.resolve()])
  }
  await Promise.resolve()
  await Promise.resolve()
}

interface Fixture { // oe-exempt:20261003:test:测试 fixture 单实现常态
  chat: ReturnType<typeof createChatStore>
  session: SessionStore
  effects: LifecycleEffects
  markSessionErrorSpy: ReturnType<typeof vi.fn>
  markDeadSpy: ReturnType<typeof vi.fn>
  subscribeRpc: ReturnType<typeof vi.fn>
  /** effectScope.stop */
  dispose: () => void
}

function makeFixture(): Fixture {
  const scope = effectScope(true)
  const chat = scope.run(() => createChatStore())!
  const session = createSessionStore()
  session.applySnapshot({
    groups: [
      {
        cwd: '/fixture',
        sessions: [
          { id: 's1', label: 'fixture session', cwd: '/fixture', status: 'active', lastActiveAt: 1, modelId: 'm', tokenCount: 0 },
        ],
      },
    ],
  })
  const subscribeRpc = vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 })
  setSubscriptionPorts({ subscribe: subscribeRpc, replay: vi.fn() })
  // createChatStore/createSessionStore 产物方法均为闭包函数（不依赖 this），包一层序 spy 透传真实调用
  const markSessionErrorSpy = vi.fn((sid: string, reason: string) => chat.markSessionError(sid, reason))
  const markDeadSpy = vi.fn((sid: string) => session.markDead(sid))
  const deps: LifecycleEffectsDeps = {
    chat: {
      markSessionError: markSessionErrorSpy,
      appendRespawnNotice: (sid, variant, text) => chat.appendRespawnNotice(sid, variant, text),
    },
    session: {
      markDead: markDeadSpy,
      revive: (sid) => session.revive(sid),
    },
  }
  return {
    chat,
    session,
    effects: createLifecycleEffects(deps, NOTICES),
    markSessionErrorSpy,
    markDeadSpy,
    subscribeRpc,
    dispose: () => scope.stop(),
  }
}

describe('createLifecycleEffects.markSessionDead（exited core 序列）', () => {
  let f: Fixture

  beforeEach(() => {
    resetChatModuleStateForTest()
    resetSubscriptionStates()
    f = makeFixture()
  })

  afterEach(() => {
    resetChatModuleStateForTest()
    resetSubscriptionStates()
    f.dispose()
  })

  it('markSessionError → markDead 保序（错误消息 / dead 态 UI 反馈先落地），reason 透传', () => {
    f.effects.markSessionDead('s1', 'Session process exited (code: 1)')

    expect(f.markSessionErrorSpy).toHaveBeenCalledWith('s1', 'Session process exited (code: 1)')
    expect(f.markDeadSpy).toHaveBeenCalledWith('s1')
    const errIdx = f.markSessionErrorSpy.mock.invocationCallOrder[0]!
    const deadIdx = f.markDeadSpy.mock.invocationCallOrder[0]!
    expect(errIdx).toBeLessThan(deadIdx)
  })

  it('无 streaming 实体：追加 error assistant 消息（reason 入 error 字段）+ session 置 dead', () => {
    f.effects.markSessionDead('s1', 'Session process exited (code: 1)')

    const messages = f.chat.getMessages('s1')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('assistant')
    expect(messages[0]!.status).toBe('error')
    // createAssistantErrorMessage 形态：reason 落 error 字段（渲染层读 error 展示），content 为空串
    expect(messages[0]!.error).toBe('Session process exited (code: 1)')
    expect(f.session.getList().find((s) => s.id === 's1')?.status).toBe('dead')
  })

  it('流式终结：分区尾 streaming assistant 被 finalize（error 态），不追加第二条错误消息', () => {
    const streaming: Message = {
      id: 'a-stream',
      role: 'assistant',
      content: '生成中',
      status: 'streaming',
      timestamp: 1,
    }
    f.chat.setMessages('s1', [streaming])

    f.effects.markSessionDead('s1', 'killed mid-stream')

    const messages = f.chat.getMessages('s1')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.status).toBe('error')
    expect(messages[0]!.content).toBe('生成中')
    expect(messages.some((m) => m.status === 'streaming')).toBe(false)
  })

  it('订阅簿记失效：已建立订阅的 session exited 后本地两层簿记清空（events unsub 调用 + 订阅状态删除）', async () => {
    const sid = 's1'
    const unsub = vi.fn()
    const streamSubscribe = vi.fn(() => unsub)
    const deps: EnsureStreamSubDeps = {
      chatApi: { streamSubscribe },
      toast: { error: vi.fn(), warning: vi.fn() },
      t: (k: string) => k,
    }
    ensureStreamSubscription(sid, f.chat, f.session, deps)
    await flushSubscribes(f.subscribeRpc)
    expect(getSubscriptionState(sid)?.subscribed).toBe(true)

    f.effects.markSessionDead(sid, 'boom')

    expect(getSubscriptionState(sid)).toBeUndefined()
    expect(unsub).toHaveBeenCalledTimes(1)
  })
})

describe('createLifecycleEffects.openRestoreWindow（恢复窗口订阅）', () => {
  let f: Fixture

  beforeEach(() => {
    resetChatModuleStateForTest()
    resetSubscriptionStates()
    f = makeFixture()
  })

  afterEach(() => {
    resetChatModuleStateForTest()
    resetSubscriptionStates()
    f.dispose()
  })

  it('立即重发 subscribeSession（sid 透传），settle 后 subscribed=true', async () => {
    f.effects.openRestoreWindow('s1')

    expect(f.subscribeRpc).toHaveBeenCalledTimes(1)
    expect(f.subscribeRpc).toHaveBeenCalledWith('s1', undefined)
    await flushSubscribes(f.subscribeRpc)
    expect(getSubscriptionState('s1')?.subscribed).toBe(true)
  })

  it('幂等：已 subscribed 再调不重发 RPC（subscribeSession 内建守卫承接）', async () => {
    f.effects.openRestoreWindow('s1')
    await flushSubscribes(f.subscribeRpc)

    f.effects.openRestoreWindow('s1')

    expect(f.subscribeRpc).toHaveBeenCalledTimes(1)
  })

  it('RPC 失败不抛（fire-and-forget，链路自愈：subscribed 不标记、下次可重试）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.subscribeRpc.mockRejectedValueOnce(new Error('ws gone'))

    expect(() => f.effects.openRestoreWindow('s1')).not.toThrow()
    await flushSubscribes(f.subscribeRpc)

    expect(getSubscriptionState('s1')?.subscribed ?? false).toBe(false)
    warn.mockRestore()
  })
})

describe('createLifecycleEffects.onSessionRestored（revive + 提示条 + 重订阅）', () => {
  let f: Fixture

  beforeEach(() => {
    resetChatModuleStateForTest()
    resetSubscriptionStates()
    f = makeFixture()
  })

  afterEach(() => {
    resetChatModuleStateForTest()
    resetSubscriptionStates()
    f.dispose()
  })

  it('revive 复位 dead 态 + 写入 restored 形态恢复提示条（注入文案）', () => {
    f.session.markDead('s1')
    expect(f.session.getList().find((s) => s.id === 's1')?.status).toBe('dead')

    f.effects.onSessionRestored('s1', { attempts: 2 })

    expect(f.session.getList().find((s) => s.id === 's1')?.status).toBe('idle')
    const notice = f.chat.getMessages('s1').at(-1)
    expect(notice?.customType).toBe(PI_RESPAWN_NOTICE_CUSTOM_TYPE)
    expect(notice?.details).toEqual({ variant: 'restored' })
    expect(notice?.content).toBe(NOTICES.restored)
    expect(notice?.liveOnly).toBe(true)
  })

  it('重订阅：restored 后重发 subscribe RPC（恢复 live 订阅 + 完整回放）', async () => {
    f.effects.onSessionRestored('s1', { attempts: 1 })

    expect(f.subscribeRpc).toHaveBeenCalledTimes(1)
    expect(f.subscribeRpc).toHaveBeenCalledWith('s1', undefined)
    await flushSubscribes(f.subscribeRpc)
    expect(getSubscriptionState('s1')?.subscribed).toBe(true)
  })

  it('invalidate 后的恢复窗口：markSessionDead 失效簿记 → onSessionRestored 重发不被幂等守卫短路', async () => {
    f.effects.openRestoreWindow('s1')
    await flushSubscribes(f.subscribeRpc)
    expect(f.subscribeRpc).toHaveBeenCalledTimes(1)

    // pi 死亡 → exited 序列失效订阅簿记 → 自动恢复成功
    f.effects.markSessionDead('s1', 'crashed')
    f.effects.onSessionRestored('s1', { attempts: 1 })

    expect(f.subscribeRpc).toHaveBeenCalledTimes(2)
    await flushSubscribes(f.subscribeRpc)
    expect(getSubscriptionState('s1')?.subscribed).toBe(true)
  })
})

describe('createLifecycleEffects.onSessionRestoreFailed（willRetry 分流 + 熔断提示条）', () => {
  let f: Fixture

  beforeEach(() => {
    resetChatModuleStateForTest()
    resetSubscriptionStates()
    f = makeFixture()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetChatModuleStateForTest()
    resetSubscriptionStates()
    f.dispose()
  })

  it('willRetry=true 中间失败：仅 log，不写提示条不触发订阅（重试由 runtime 自动续排）', () => {
    f.effects.onSessionRestoreFailed('s1', { attempts: 1, willRetry: true, reason: 'attach failed' })

    expect(f.chat.getMessages('s1')).toHaveLength(0)
    expect(f.subscribeRpc).not.toHaveBeenCalled()
  })

  it('willRetry=false 熔断：写入 restoreFailed 形态恢复提示条（注入文案）', () => {
    f.effects.onSessionRestoreFailed('s1', { attempts: 2, willRetry: false, reason: 'attach hard-fail' })

    const notice = f.chat.getMessages('s1').at(-1)
    expect(notice?.customType).toBe(PI_RESPAWN_NOTICE_CUSTOM_TYPE)
    expect(notice?.details).toEqual({ variant: 'restoreFailed' })
    expect(notice?.content).toBe(NOTICES.restoreFailed)
  })

  it('恢复提示条两形态齐备：restored 与 restoreFailed 先后写入各一条（连续提示条语义）', () => {
    f.effects.onSessionRestored('s1', { attempts: 1 })
    f.effects.onSessionRestoreFailed('s1', { attempts: 2, willRetry: false, reason: 'again' })

    const messages = f.chat.getMessages('s1')
    expect(messages).toHaveLength(2)
    expect(messages[0]!.details).toEqual({ variant: 'restored' })
    expect(messages[0]!.content).toBe(NOTICES.restored)
    expect(messages[1]!.details).toEqual({ variant: 'restoreFailed' })
    expect(messages[1]!.content).toBe(NOTICES.restoreFailed)
  })
})
