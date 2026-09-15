/**
 * request.command —— send fast-fail 契约单测（V8 runtime 重启悬挂 bug 修复）。
 *
 * 背景：command() 曾忽略 transport.send 的 boolean 返回值。WS 非 OPEN（reconnecting/
 * restarting 窗口）时消息未送出，pending promise 却挂着——use-connection 的 rejectAll
 * 只在「connected → 断开」转变时触发，请求发出时已断开则永不触发，只能等 65s sweep
 * 超时（期间文件树 inFlight/loading 持续拦截用户点击，零反馈）。
 *
 * 覆盖：
 * - send false → 立即 reject（code='disconnected'），不悬挂
 * - send true → promise 保持 pending 直到 reply 回灌（正常链路不被破坏）
 *
 * 运行：cd packages/core && npx vitest run src/transport/api/__tests__/request.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock ws-client 层：send 的返回值是本测试的控制变量（true=已送出 / false=WS 非 OPEN）。
// mock 路径相对测试文件解析（../../ws-client = core/transport/ws-client.ts），与 request.ts
// 内部 import '../ws-client' 解析到同一模块 ID 才能拦截（§11-2 拦截链路实证点）。
const mockSend = vi.fn<(msg: unknown) => boolean>()
vi.mock('../../ws-client', () => ({
  send: (msg: unknown) => mockSend(msg),
}))

import { command } from '../request'
import * as pending from '../pending'

beforeEach(() => {
  mockSend.mockReset()
  // pending 模块级单例：清残留条目，避免跨用例污染（rejectAll 同时 disarm sweep timer）
  pending.rejectAll(new Error('test cleanup'))
})

describe('command — send fast-fail（WS 非 OPEN 时立即失败，不悬挂）', () => {
  it('send false（消息未送出）→ 立即 reject Error(code=disconnected)，promise 不悬挂', async () => {
    mockSend.mockReturnValue(false)

    // 无超时参与（timeoutMs=0 禁用 sweep 兜底）——断言 reject 来自 fast-fail 而非超时
    const p = command('file.tree.expand', { sessionId: 's1', path: 'packages' }, 0)

    await expect(p).rejects.toMatchObject({ code: 'disconnected' })
  })

  it('send false 后 pending 注册表不残留（后续 rejectAll/reply 不受幽灵条目干扰）', async () => {
    mockSend.mockReturnValue(false)

    await expect(
      command('file.tree.expand', { sessionId: 's1', path: 'packages' }, 0),
    ).rejects.toMatchObject({ code: 'disconnected' })

    // 残留检测：注册一个新 pending，再 rejectAll——若上条幽灵条目还在，
    // 其 reject 会在微任务产生未处理 rejection；此处只验证新注册的能正常被清理
    const id = pending.createCommandId()
    const probe = pending.register(id, 0)
    pending.rejectAll(new Error('drain'))
    await expect(probe).rejects.toThrow('drain')
  })

  it('send true → promise 保持 pending，直到 reply 回灌才 resolve（正常链路不破坏）', async () => {
    mockSend.mockReturnValue(true)

    let settleCount = 0
    const p = command('file.tree.expand', { sessionId: 's1', path: 'packages' }, 0)
    const tracked = p.then(
      (v) => {
        settleCount++
        return v
      },
      () => {
        settleCount++
      },
    )

    // 送出后未回灌：不得因 fast-fail 逻辑被提前 reject
    await Promise.resolve()
    await Promise.resolve()
    expect(settleCount).toBe(0)

    // 回灌 reply → resolve（pending.resolveEnvelope 是入站分流出口）
    pending.resolveEnvelope({
      type: 'file.tree.expand:result',
      id: lastSentId(),
      payload: { sessionId: 's1', children: [] },
    } as Parameters<typeof pending.resolveEnvelope>[0])
    await tracked
    expect(settleCount).toBe(1)
  })
})

/** 从 mockSend 调用记录提取最近一次送出消息的 id（reply 回灌需要） */
function lastSentId(): string {
  const last = mockSend.mock.calls.at(-1)?.[0] as { id?: string } | undefined
  if (!last?.id) throw new Error('mockSend 未被调用或消息缺 id')
  return last.id
}