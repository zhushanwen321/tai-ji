/**
 * ws-client.send 壳侧 import 冒烟（W4 fast-fail 契约的壳侧定位）。
 *
 * [已裁剪] 原 4 用例中 OPEN→true / CONNECTING→false / disconnect→false 与 core
 * invariants.test.ts:270 起的 fast-fail 用例逐一重复（布尔契约权威在 core），
 * 「返回值类型为 boolean」是弱断言——均已删。
 *
 * 本文件唯一不可替代价值：壳侧 import 链路解析不断（core 导出改名/拼写错时此处即红）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/ws-client-send-boolean.test.ts
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { ClientMessage } from '@xyz-agent/shared'
import { connect, disconnect, send } from '@xyz-agent/core/transport/ws-client'
import { providePlatform, WS_READY_STATE, type PlatformPort, type WebSocketLike } from '@xyz-agent/core'

describe('ws-client.send 壳侧 import 冒烟（W4 fast-fail 主覆盖在 core invariants）', () => {
  afterEach(() => {
    disconnect()
    vi.restoreAllMocks()
  })

  it('壳侧可解析 connect/disconnect/send 且 send 可执行返回 boolean（import 链路未断）', () => {
    const ws: WebSocketLike = {
      readyState: WS_READY_STATE.CONNECTING,
      send: () => {},
      close: () => {},
      onopen: null,
      onclose: null,
      onmessage: null,
      onerror: null,
    }
    const platform: PlatformPort = {
      kind: 'mock',
      storage: { get: async () => null, set: async () => {}, remove: async () => {} },
      webSocket: { create: () => ws },
      ipc: null,
    }
    providePlatform(platform)
    connect('ws://test')

    const msg: ClientMessage = { type: 'ping', payload: {} }
    expect(typeof send(msg)).toBe('boolean')
  })
})
