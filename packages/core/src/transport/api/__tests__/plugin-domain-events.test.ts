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
import { onPluginEvent } from '../domains/plugin'

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
