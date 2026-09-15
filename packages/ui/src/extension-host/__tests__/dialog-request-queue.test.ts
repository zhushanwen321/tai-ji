/**
 * DialogRequestQueue 单测（W1 · 8 用例覆盖 IF2 契约全行为面）。
 *
 * 运行：cd packages/ui && npx vitest run src/extension-host/
 *
 * 契约来源：S4 slice plan IF1/IF2/DM1/DM2/ERR1/ERR2 + clarify Q1-Q4。
 * Mock 策略：MockDialogRequestSource（vi.fn 返回 unsubscribe 间谍）+ MockTransport（双通道 vi.fn）；
 * 不 mock useSessionScopedState（Map 分区是验收对象）；effectScope.run 包裹 + scope.stop() 隔离订阅状态。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { effectScope, ref } from 'vue'
import type { Ref } from 'vue'
import {
  createDialogRequestQueue,
  type DialogRequest,
  type DialogRequestQueue,
  type DialogRequestSource,
  type UiResponseTransport,
} from '../dialog-request-queue'

// ── Mocks ────────────────────────────────────────────────────────────

class MockDialogRequestSource implements DialogRequestSource {
  onUiRequest = vi.fn((handler: (req: DialogRequest) => void): (() => void) => {
    this.requestHandler = handler
    const spy = vi.fn()
    return spy as unknown as () => void
  })
  onUiTimeout = vi.fn((handler: (e: { sessionId: string; requestId: string }) => void): (() => void) => {
    this.timeoutHandler = handler
    const spy = vi.fn()
    return spy as unknown as () => void
  })
  onUiRequestExpired = vi.fn((handler: (e: { sessionId: string; requestId: string }) => void): (() => void) => {
    this.expiredHandler = handler
    const spy = vi.fn()
    return spy as unknown as () => void
  })

  requestHandler: ((req: DialogRequest) => void) | null = null
  timeoutHandler: ((e: { sessionId: string; requestId: string }) => void) | null = null
  expiredHandler: ((e: { sessionId: string; requestId: string }) => void) | null = null

  triggerUiRequest(req: Partial<DialogRequest> & { requestId: string; sessionId: string }): void {
    this.requestHandler?.(makeRequest(req))
  }

  triggerTimeout(sessionId: string, requestId: string): void {
    this.timeoutHandler?.({ sessionId, requestId })
  }

  triggerExpired(sessionId: string, requestId: string): void {
    this.expiredHandler?.({ sessionId, requestId })
  }
}

function makeRequest(overrides: Partial<DialogRequest> & { requestId: string; sessionId: string }): DialogRequest {
  return {
    source: 'pi',
    method: 'confirm',
    receivedAt: Date.now(),
    ...overrides,
  }
}

function createHarness(sessionIdRef?: Ref<string | null>) {
  const source = new MockDialogRequestSource()
  const transport: UiResponseTransport = {
    sendPiResponse: vi.fn(),
    sendPluginResponse: vi.fn(),
  }
  const scope = effectScope()
  let queue!: DialogRequestQueue
  scope.run(() => {
    queue = createDialogRequestQueue(transport, sessionIdRef ?? ref<string | null>(null), source)
  })
  return { source, transport, scope, getQueue: () => queue }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('DialogRequestQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('TC-1 入队串行展示：连续两个 ui-request，队首为第一个；respond 第一个后切换为第二个', () => {
    const sid = ref<string | null>('A')
    const { source, transport, scope, getQueue } = createHarness(sid)
    try {
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1' })
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r2' })
      const q = getQueue()
      expect(q.pendingCount.value).toBe(2)
      expect(q.currentRequest.value?.requestId).toBe('r1')
      q.respond('r1', true)
      expect(q.currentRequest.value?.requestId).toBe('r2')
      expect(q.pendingCount.value).toBe(1)
      expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r1', 'confirm', true)
    } finally {
      scope.stop()
    }
  })

  it('TC-2 切 session 隔离：A 分区不污染 B；切回 A 恢复（Map 保留不丢）', () => {
    const sid = ref<string | null>('A')
    const { source, scope, getQueue } = createHarness(sid)
    try {
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1' })
      const q = getQueue()
      expect(q.currentRequest.value?.requestId).toBe('r1')

      sid.value = 'B'
      expect(q.currentRequest.value).toBeUndefined()
      expect(q.pendingCount.value).toBe(0)

      // B 自己的请求入 B 分区
      source.triggerUiRequest({ sessionId: 'B', requestId: 'b1' })
      expect(q.currentRequest.value?.requestId).toBe('b1')

      // 切回 A：请求仍在（Map 分区保留）
      sid.value = 'A'
      expect(q.currentRequest.value?.requestId).toBe('r1')
      expect(q.pendingCount.value).toBe(1)
    } finally {
      scope.stop()
    }
  })

  it('TC-3 requestId dedup：同 requestId 两帧只保留一份（ERR2）', () => {
    const sid = ref<string | null>('A')
    const { source, scope, getQueue } = createHarness(sid)
    try {
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1' })
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1' })
      const q = getQueue()
      expect(q.pendingCount.value).toBe(1)
      expect(q.hasRequest()).toBe(true)
      // 只保留一份：respond 后队列清空
      q.respond('r1', true)
      expect(q.pendingCount.value).toBe(0)
    } finally {
      scope.stop()
    }
  })

  it('TC-4 respond 按 requestId 精确出队：非队首请求可直接响应（pi 无串行保证）', () => {
    const sid = ref<string | null>('A')
    const { source, transport, scope, getQueue } = createHarness(sid)
    try {
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1' })
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r2', method: 'input' })
      const q = getQueue()
      q.respond('r2', 'some text')
      // r2 出队（非队首），r1 仍在队首展示
      expect(q.currentRequest.value?.requestId).toBe('r1')
      expect(q.pendingCount.value).toBe(1)
      expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r2', 'input', 'some text')
    } finally {
      scope.stop()
    }
  })

  it('TC-5 source 路由：pi 源走 sendPiResponse（method 透传），plugin 源走 sendPluginResponse，互不串通道', () => {
    const sid = ref<string | null>('A')
    const { source, transport, scope, getQueue } = createHarness(sid)
    try {
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1', source: 'pi', method: 'confirm' })
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r2', source: 'plugin', method: 'select' })
      const q = getQueue()
      q.respond('r1', true)
      q.respond('r2', 'opt-b')
      expect(transport.sendPiResponse).toHaveBeenCalledTimes(1)
      expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r1', 'confirm', true)
      expect(transport.sendPluginResponse).toHaveBeenCalledTimes(1)
      expect(transport.sendPluginResponse).toHaveBeenCalledWith('r2', 'opt-b')
    } finally {
      scope.stop()
    }
  })

  it('TC-6 迟到 requestId 静默忽略：空队列 respond/cancel 无副作用（ERR1）', () => {
    const sid = ref<string | null>('A')
    const { transport, scope, getQueue } = createHarness(sid)
    try {
      const q = getQueue()
      q.respond('ghost', true)
      q.cancel('ghost')
      expect(transport.sendPiResponse).not.toHaveBeenCalled()
      expect(transport.sendPluginResponse).not.toHaveBeenCalled()
      expect(q.pendingCount.value).toBe(0)
    } finally {
      scope.stop()
    }
  })

  it('TC-7 超时出队：onUiTimeout 移除对应 requestId，不发回传（runtime 已发默认响应）', () => {
    const sid = ref<string | null>('A')
    const { source, transport, scope, getQueue } = createHarness(sid)
    try {
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1' })
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r2' })
      const q = getQueue()
      source.triggerTimeout('A', 'r1')
      // r1 出队，r2 保留（对照：只移除目标）
      expect(q.pendingCount.value).toBe(1)
      expect(q.currentRequest.value?.requestId).toBe('r2')
      // 超时出队不发回传（runtime 已向 pi 发默认响应）
      expect(transport.sendPiResponse).not.toHaveBeenCalled()
      expect(transport.sendPluginResponse).not.toHaveBeenCalled()
    } finally {
      scope.stop()
    }
  })

  it('TC-8 订阅清理：scope.stop() 后事件不入队，unsubscribe 被调用（listener 防翻倍）', () => {
    const sid = ref<string | null>('A')
    const { source, scope, getQueue } = createHarness(sid)
    const q = getQueue()
    scope.stop()
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r1' })
    source.triggerTimeout('A', 'r1')
    // stop 后 emit 不入队
    expect(q.pendingCount.value).toBe(0)
    // onUiRequest/onUiTimeout/onUiRequestExpired 返回的 unsubscribe 均被调用
    expect(source.onUiRequest).toHaveBeenCalledTimes(1)
    expect(source.onUiTimeout).toHaveBeenCalledTimes(1)
    expect(source.onUiRequestExpired).toHaveBeenCalledTimes(1)
    const unsubUiRequest = source.onUiRequest.mock.results[0]?.value as () => void
    const unsubUiTimeout = source.onUiTimeout.mock.results[0]?.value as () => void
    const unsubUiRequestExpired = source.onUiRequestExpired.mock.results[0]?.value as () => void
    expect(unsubUiRequest).toHaveBeenCalledTimes(1)
    expect(unsubUiTimeout).toHaveBeenCalledTimes(1)
    expect(unsubUiRequestExpired).toHaveBeenCalledTimes(1)
  })

  // ── timeout-plugin-service D2 超时撤窗（plugin:uiRequestExpired 消费） ──

  it('TC-9 expired 撤窗：onUiRequestExpired 按 requestId 出队（含排队中非队首），不发回传（UI_TIMEOUT 无替答）', () => {
    const sid = ref<string | null>('A')
    const { source, transport, scope, getQueue } = createHarness(sid)
    try {
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1', source: 'plugin' })
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r2', source: 'plugin' })
      const q = getQueue()
      // 排队中的非队首请求 r2 到期撤窗（D2：广播无条件发出，含从未展示的排队项）
      source.triggerExpired('A', 'r2')
      expect(q.pendingCount.value).toBe(1)
      expect(q.currentRequest.value?.requestId).toBe('r1')
      // 撤窗不发回传（插件侧已收 UI_TIMEOUT reject；回传会伪装成用户应答）
      expect(transport.sendPiResponse).not.toHaveBeenCalled()
      expect(transport.sendPluginResponse).not.toHaveBeenCalled()

      // 队首 r1 撤窗后队列清空
      source.triggerExpired('A', 'r1')
      expect(q.pendingCount.value).toBe(0)
      expect(q.currentRequest.value).toBeUndefined()
      expect(transport.sendPluginResponse).not.toHaveBeenCalled()
    } finally {
      scope.stop()
    }
  })

  it('TC-10 expired miss noop 幂等：未知/已出队 requestId 无副作用（V4b：广播无条件发出，miss 是正常时序）', () => {
    const sid = ref<string | null>('A')
    const { source, transport, scope, getQueue } = createHarness(sid)
    try {
      const q = getQueue()
      // 空队列收到未知 requestId 的撤窗广播
      source.triggerExpired('A', 'unknown')
      expect(q.pendingCount.value).toBe(0)
      expect(q.currentRequest.value).toBeUndefined()

      // 已展示请求正常 respond 出队后，迟到 expired 广播不再有副作用
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1', source: 'plugin' })
      q.respond('r1', true)
      expect(transport.sendPluginResponse).toHaveBeenCalledTimes(1)
      source.triggerExpired('A', 'r1')
      // 迟到撤窗不产生第二次回传、不改变状态
      expect(transport.sendPluginResponse).toHaveBeenCalledTimes(1)
      expect(q.pendingCount.value).toBe(0)
    } finally {
      scope.stop()
    }
  })
})
