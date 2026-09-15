/**
 * streaming idle 阈值水合链路测试（timeout-streaming-ui-idle §5.3 D3 配置链注水端）。
 *
 * 行为级断言（非 mock store）：hydrateStreamingIdleTimeout 把 RPC 秒值注入真实 chat
 * store（u-s1 的 setStreamingIdleTimeoutMs 挂点）后，新 turn 的 idle timer 按水合值挂载：
 *  - RPC 返回 300s → 零帧 299s 仍 streaming、300s 收口 error（「新 turn 生效」语义）
 *  - RPC 失败 → 保持 core 默认 1800s（best-effort 不阻塞启动）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/streaming-idle-hydration.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const settingsMock = vi.hoisted(() => ({
  getStreamingIdleTimeout: vi.fn(() => Promise.resolve({ timeout: 1800 })),
  setStreamingIdleTimeout: vi.fn((timeout: number) => Promise.resolve({ timeout })),
}))

vi.mock('@taiji/core/transport/api/domains/settings', () => settingsMock)

import { hydrateStreamingIdleTimeout } from '@/composables/features/chat/streaming-idle-hydration'
import { useChatStore } from '@/stores/chat'

const sid = 's-hydrate'

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  settingsMock.getStreamingIdleTimeout.mockReset()
  settingsMock.getStreamingIdleTimeout.mockResolvedValue({ timeout: 1800 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('hydrateStreamingIdleTimeout 水合链路', () => {
  it('RPC 300s → 注水后新 turn idle timer 按 300s 收口（新 turn 生效语义）', async () => {
    settingsMock.getStreamingIdleTimeout.mockResolvedValue({ timeout: 300 })
    await hydrateStreamingIdleTimeout()
    const store = useChatStore()
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a1' } })
    expect(store.isGenerating(sid)).toBe(true)
    // 阈值前零帧不收口
    vi.advanceTimersByTime(299_000)
    expect(store.isGenerating(sid)).toBe(true)
    // 零帧满水合值 300s → 收口
    vi.advanceTimersByTime(1_000)
    expect(store.isGenerating(sid)).toBe(false)
    expect(store.getMessages(sid)[0].status).toBe('error')
  })

  it('水合值只影响之后挂载的 timer：水合前已挂载的 turn 不受影响（进行中 turn 不变）', async () => {
    const store = useChatStore()
    // 水合前 turn 已开始（默认 1800s timer 已挂载）
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a0' } })
    settingsMock.getStreamingIdleTimeout.mockResolvedValue({ timeout: 60 })
    await hydrateStreamingIdleTimeout()
    // 推进 120s：若水合值错误地作用于进行中 timer，此处已收口；实际应仍 streaming
    vi.advanceTimersByTime(120_000)
    expect(store.isGenerating(sid)).toBe(true)
  })

  it('RPC 失败 best-effort：保持 core 默认 1800s（不阻塞、不误注水）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    settingsMock.getStreamingIdleTimeout.mockRejectedValue(new Error('transport unavailable'))
    await hydrateStreamingIdleTimeout()
    const store = useChatStore()
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a1' } })
    vi.advanceTimersByTime(1_799_000)
    expect(store.isGenerating(sid)).toBe(true)
    vi.advanceTimersByTime(1_000)
    expect(store.isGenerating(sid)).toBe(false)
    warnSpy.mockRestore()
  })
})
