/**
 * extension domain upgrade / autoUpgrade 测试。
 *
 * TDD Red phase：验证 upgrade() 和 setAutoUpgrade() 发送正确的 WS 消息。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock core ws-client 和 pending 源文件（vi.mock 会自动提升到文件顶部）。
// request 已下沉 core（tc u1），出站链路 domains → core request → core ws-client/pending，
// mock 目标须与 core 内相对 import 同一模块 ID 才能拦截；断言用的 namespace import
// 同步指向被 mock 的模块（否则拿到真实 re-export 而非 mock 实例）。
// （send 返回 true = 消息已送出，符合 ws-client.send 的 boolean 契约：
// request.command 对 send false 会调 pending.reject 走 fast-fail，mock 需提供 reject）
vi.mock('@xyz-agent/core/transport/ws-client', () => ({
  send: vi.fn((): boolean => true),
}))

vi.mock('../../../core/src/transport/api/pending', () => ({
  RPC_BACKSTOP_TIMEOUT_MS: 65_000,
  createCommandId: vi.fn(() => 'test-id'),
  register: vi.fn(() => Promise.resolve()),
  reject: vi.fn(),
}))

import * as extension from '@xyz-agent/core/transport/api/domains/extension'
import * as transport from '@xyz-agent/core/transport/ws-client'
import * as pending from '../../../core/src/transport/api/pending'

describe('extension domain upgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(pending.createCommandId).mockReturnValue('test-id')
    vi.mocked(pending.register).mockReturnValue(Promise.resolve())
  })

  it('upgrade 发送 extension.upgrade 消息，payload 含 name', () => {
    extension.upgrade('my-extension')
    expect(transport.send).toHaveBeenCalledWith({
      type: 'extension.upgrade',
      id: 'test-id',
      payload: { name: 'my-extension' },
    })
  })

  // （「upgrade 返回 pending promise」恒真用例已删：任何 request 封装都返回 Promise，
  //  不锁任何行为。）
})

describe('extension domain setAutoUpgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(pending.createCommandId).mockReturnValue('test-id')
    vi.mocked(pending.register).mockReturnValue(Promise.resolve())
  })

  it('setAutoUpgrade 发送 extension.setAutoUpgrade 消息，payload 含 name 和 autoUpgrade', () => {
    extension.setAutoUpgrade('my-extension', true)
    expect(transport.send).toHaveBeenCalledWith({
      type: 'extension.setAutoUpgrade',
      id: 'test-id',
      payload: { name: 'my-extension', autoUpgrade: true },
    })
  })

  it('setAutoUpgrade 禁用时发送 autoUpgrade=false', () => {
    extension.setAutoUpgrade('my-extension', false)
    expect(transport.send).toHaveBeenCalledWith({
      type: 'extension.setAutoUpgrade',
      id: 'test-id',
      payload: { name: 'my-extension', autoUpgrade: false },
    })
  })

  // （「setAutoUpgrade 返回 pending promise」恒真用例已删：同上。）
})
