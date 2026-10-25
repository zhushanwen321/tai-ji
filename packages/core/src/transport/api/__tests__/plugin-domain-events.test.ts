/**
 * plugin:event 订阅域单测（provider-plugin-access D9，验收④「renderer 接收」段）：
 * runtime 广播 'plugin:event' 帧（无 sessionId → global 通道）→ core domain
 * onPluginEvent 订阅回调收到 PluginEventPayload（payload 透传，取消函数退订生效）。
 *
 * 注意：core 包不在 u-protocol 的 testCommand（runtime plugin + ui rendering-protocol）
 * 覆盖内——本文件由改动者验证后交付，全量回归归 D2 Gate A。
 *
 * 运行：cd packages/core && npx vitest run src/transport/api/__tests__/plugin-domain-events.test.ts
 */

import { describe, it, expect, vi } from 'vitest'
import * as events from '../events'
import { onPluginEvent, onPluginCrashed } from '../domains/plugin'

describe('onPluginEvent 订阅（D9 renderer 接收段）', () => {
  it("global 帧 'plugin:event' → 订阅回调收到 payload（pluginId/channel/payload 透传）", () => {
    const handler = vi.fn()
    const off = onPluginEvent(handler)

    events.dispatchGlobal({
      type: 'plugin:event',
      payload: { pluginId: 'wool-workbuddy', channel: 'credential-status', payload: { loggedIn: false } },
    } as never)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({
      pluginId: 'wool-workbuddy',
      channel: 'credential-status',
      payload: { loggedIn: false },
    })
    off()
  })

  it('取消订阅后不再接收（off 生效）', () => {
    const handler = vi.fn()
    const off = onPluginEvent(handler)
    off()

    events.dispatchGlobal({
      type: 'plugin:event',
      payload: { pluginId: 'p', channel: 'c', payload: null },
    } as never)

    expect(handler).not.toHaveBeenCalled()
  })
})

describe('onPluginCrashed 订阅（S13 崩溃广播，payload 窄化）', () => {
  it("global 帧 'plugin:crashed' → handler 收到窄化 payload（pluginId 必带，workerId/error 字符串时展开）", () => {
    const handler = vi.fn()
    const off = onPluginCrashed(handler)

    events.dispatchGlobal({
      type: 'plugin:crashed',
      payload: { pluginId: 'wool-workbuddy', workerId: 'worker-1', error: 'oom' },
    } as never)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ pluginId: 'wool-workbuddy', workerId: 'worker-1', error: 'oom' })
    off()
  })

  it('workerId/error 非字符串时不带对应键（wire payload 未契约化的防御窄化）', () => {
    const handler = vi.fn()
    const off = onPluginCrashed(handler)

    events.dispatchGlobal({
      type: 'plugin:crashed',
      payload: { pluginId: 'wool-workbuddy', workerId: 42, error: null },
    } as never)

    expect(handler).toHaveBeenCalledWith({ pluginId: 'wool-workbuddy' })
    off()
  })

  it('pluginId 缺失或空串 → 帧被丢弃（handler 不触发）', () => {
    const handler = vi.fn()
    const off = onPluginCrashed(handler)

    events.dispatchGlobal({ type: 'plugin:crashed', payload: { workerId: 'w' } } as never)
    events.dispatchGlobal({ type: 'plugin:crashed', payload: { pluginId: '' } } as never)

    expect(handler).not.toHaveBeenCalled()
    off()
  })
})
