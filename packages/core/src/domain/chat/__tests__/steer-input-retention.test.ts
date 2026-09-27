/**
 * form-hang-fix U2：steer 早退契约收窄 + send B 策略返回信号 + P-fh6 兜底（设计 D2/D3）。
 *
 * 被测对象：domain/chat/useChat.ts 的 steer / send。
 * - [D2 契约收窄] steer 三早退（空段 / 空白文本 / isActive）从「return true（无事发生）」
 *   改「return false（输入未被消费）」+ 各早退一行常驻 warn（显症状类埋点，§5 裁决）。
 * - [D2/B 策略返回信号] send 的 isActive 分支接住 steer false → send 返回 false
 *   （不 throw，W2 契约）；false 仅属 B 策略语义（直发 RPC 失败已 toast 消化仍 true）。
 * - [P-fh6] 30s pendingSend timeout 兜底可观测：send 后无 message_start 帧 →
 *   fake timers 推进 30s → finalizeSession('timeout') + warn 含 sid + isActive 回落。
 *
 * dispatch 层调用方（routeSteer/onSteer/sendActiveMessage 快照分流与短路）的 P-fh4
 * 矩阵见 domain/composer/dispatch/__tests__/steer-snapshot-short-circuit.test.ts。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/steer-input-retention.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { textToSegments } from '@taiji/shared'
import type { ServerMessage } from '@taiji/shared'
import { createChatStore } from '../store'
import { createUseChat, resetChatModuleStateForTest } from '../useChat'
import { provideDevMode, __resetDevModeForTesting } from '../../../platform/dev-mode'
import type { UseChatDeps } from '../useChat'
import { msg } from './helpers/fixtures'

/** 装配同 useChat.test.ts makeFixture（真实 store + mock deps + handler 捕获） */
function makeFixture(): {
  useChat: ReturnType<typeof createUseChat>
  chatApi: { send: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; streamSubscribe: ReturnType<typeof vi.fn> }
  chatStore: ReturnType<typeof createChatStore>
  toast: { error: ReturnType<typeof vi.fn> }
  emit: (sid: string, m: ServerMessage) => void
  dispose: () => void
} {
  const scope = effectScope(true)
  const streamHandlers = new Map<string, (m: ServerMessage) => void>()
  const chatStore = scope.run(() => createChatStore())!
  const chatApi = {
    send: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    streamSubscribe: vi.fn((sid: string, h: (m: ServerMessage) => void) => {
      streamHandlers.set(sid, h)
      return () => {
        streamHandlers.delete(sid)
      }
    }),
  }
  const toast = { error: vi.fn(), warning: vi.fn() }
  const deps: UseChatDeps = {
    chatApi: {
      ...chatApi,
      subagentAction: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      compact: vi.fn().mockResolvedValue(undefined),
      bash: vi.fn().mockResolvedValue(undefined),
      abortBash: vi.fn().mockResolvedValue(undefined),
      getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
    },
    writeSegments: vi.fn().mockResolvedValue(undefined),
    getChatStore: () => chatStore,
    getSessionStore: () => ({ applySnapshot: vi.fn(), revive: vi.fn() }),
    toast,
    t: (k: string) => k,
    getCompactQueue: () => ({
      flush: vi.fn().mockResolvedValue(true),
      enqueue: vi.fn(),
      peek: vi.fn(() => []),
      hasPending: vi.fn(() => false),
      confirmDelivery: vi.fn(() => false),
    }),
  }
  return {
    useChat: createUseChat(deps),
    chatApi,
    chatStore,
    toast,
    emit: (sid, m) => {
      streamHandlers.get(sid)?.(m)
    },
    dispose: () => scope.stop(),
  }
}

/** 构造活跃 session（send + message_start → isGenerating=true，isActive=true） */
async function makeActiveSession(f: ReturnType<typeof makeFixture>, sid: string): Promise<void> {
  await f.useChat.send(sid, textToSegments('hi'))
  f.emit(sid, msg(sid, 'message.message_start', { messageId: 'a1' }))
  expect(f.chatStore.isActive(sid)).toBe(true)
}

/** console.warn 首参字符串列表（spy 类型宽化后 calls 元组参数为 any，此处显式收窄为 unknown[]） */
function warnLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((c: unknown[]) => String(c[0]))
}

describe('steer 三早退契约（D2 收窄：false = 输入未被消费 + 常驻 warn）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetChatModuleStateForTest()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
    __resetDevModeForTesting()
  })

  it('早退①空 segments → return false + warn(含 sid/reason) + 不调 chatApi.steer', async () => {
    const f = makeFixture()
    await makeActiveSession(f, 'e1')
    await expect(f.useChat.steer('e1', [])).resolves.toBe(false)
    expect(f.chatApi.steer).not.toHaveBeenCalled()
    const line = warnLines(warnSpy).find((s) => s.includes('steer input not consumed'))
    expect(line).toBeDefined()
    expect(line).toContain('sid=e1')
    expect(line).toContain('reason=empty segments')
    f.dispose()
  })

  it('早退②纯空白文本 → return false + warn + 不调 chatApi.steer', async () => {
    const f = makeFixture()
    await makeActiveSession(f, 'e2')
    await expect(f.useChat.steer('e2', textToSegments('   '))).resolves.toBe(false)
    expect(f.chatApi.steer).not.toHaveBeenCalled()
    const line = warnLines(warnSpy).find((s) => s.includes('steer input not consumed'))
    expect(line).toContain('sid=e2')
    expect(line).toContain('reason=blank prompt text')
    f.dispose()
  })

  it('早退③isActive=false（投影滞后/非活跃）→ return false + warn，文本前缀入日志', async () => {
    const f = makeFixture()
    // 非活跃 session（无 pendingSend / isGenerating）直达早退③
    await expect(f.useChat.steer('e3', textToSegments('窗口期补充内容'))).resolves.toBe(false)
    expect(f.chatApi.steer).not.toHaveBeenCalled()
    const line = warnLines(warnSpy).find((s) => s.includes('steer input not consumed'))
    expect(line).toContain('sid=e3')
    expect(line).toContain('reason=session inactive')
    expect(line).toContain('窗口期补充内容')
    f.dispose()
  })

  it('成功路径回归：活跃 + 正常文本 → return true + chatApi.steer 投递', async () => {
    const f = makeFixture()
    await makeActiveSession(f, 'e4')
    await expect(f.useChat.steer('e4', textToSegments('正常补充'))).resolves.toBe(true)
    expect(f.chatApi.steer).toHaveBeenCalledWith('e4', '正常补充')
    f.dispose()
  })
})

describe('send B 策略返回信号（isActive → steer，D 条）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
  })

  it('B 策略 RPC 失败 → send 返回 false（不 throw），toast 已消化', async () => {
    const f = makeFixture()
    await makeActiveSession(f, 'b1')
    f.chatApi.steer.mockRejectedValueOnce(new Error('WS断'))
    await expect(f.useChat.send('b1', textToSegments('busy 期补充'))).resolves.toBe(false)
    expect(f.toast.error).toHaveBeenCalled()
    f.dispose()
  })

  it('B 策略成功 → send 返回 true（真投递）', async () => {
    const f = makeFixture()
    await makeActiveSession(f, 'b2')
    await expect(f.useChat.send('b2', textToSegments('busy 期补充'))).resolves.toBe(true)
    expect(f.chatApi.steer).toHaveBeenCalledWith('b2', 'busy 期补充')
    f.dispose()
  })

  it('B 策略同栈早退不可达（send 空文本先退 true）：空白输入不经 steer', async () => {
    const f = makeFixture()
    await makeActiveSession(f, 'b3')
    // 空文本在 send 上行早退（return true——输入为空无丢失面），steer 不被调
    await expect(f.useChat.send('b3', textToSegments('   '))).resolves.toBe(true)
    expect(f.chatApi.steer).not.toHaveBeenCalled()
    f.dispose()
  })

  it('直发 RPC 失败 → send 仍返回 true（false 仅属 B 策略语义；toast 消化）', async () => {
    const f = makeFixture()
    f.chatApi.send.mockRejectedValueOnce(new Error('WS断'))
    // 非活跃 session 走直发（非 B 策略），RPC 失败被 catch 吞错 toast
    await expect(f.useChat.send('b4', textToSegments('直发内容'))).resolves.toBe(true)
    expect(f.toast.error).toHaveBeenCalled()
    f.dispose()
  })
})

describe('P-fh6 兜底：send 后无 message_start → 30s timeout finalize + warn 含 sid', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetChatModuleStateForTest()
    vi.useFakeTimers()
    provideDevMode(true)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
    vi.useRealTimers()
    __resetDevModeForTesting()
  })

  it('未锚极端场景（无 message_start、无 respond）：30s 触发 finalize(timeout)，isActive 回落 + warn 留痕', async () => {
    const f = makeFixture()
    // send 置 pendingSend（等 message_start 清除）——注入「帧永不到来」序列
    await f.useChat.send('t30', textToSegments('命令消息'))
    expect(f.chatStore.isActive('t30')).toBe(true)
    // 29.999s：未到阈值，pendingSend 仍挂（边界——恰好 30s 才 finalize）
    vi.advanceTimersByTime(29_999)
    expect(f.chatStore.isActive('t30')).toBe(true)
    // 越过 30s：finalizeSession('timeout') 收口 + warn 可观测（D3 兜底三档之「触发可观测」）
    vi.advanceTimersByTime(1)
    expect(f.chatStore.isActive('t30')).toBe(false)
    const line = warnLines(warnSpy).find((s) => s.includes('finalizeSession'))
    expect(line).toBeDefined()
    expect(line).toContain('sid=t30')
    expect(line).toContain('reason=timeout')
    f.dispose()
  })

  it('对照组：message_start 到达 → timer 被清，30s 后无 timeout finalize', async () => {
    const f = makeFixture()
    await f.useChat.send('t31', textToSegments('普通消息'))
    f.emit('t31', msg('t31', 'message.message_start', { messageId: 'm1' }))
    vi.advanceTimersByTime(30_001)
    // message_start 后 isActive 由 isGenerating 维持（turn 进行中），非 timeout 收口
    expect(f.chatStore.isActive('t31')).toBe(true)
    const line = warnLines(warnSpy).find((s) => s.includes('reason=timeout'))
    expect(line).toBeUndefined()
    f.dispose()
  })
})
