/**
 * DialogRequestQueue 单测（IF2 契约全行为面 + D2 超时撤窗 + M1 未送达保留 + U6 resetFor
 * 三用例）。
 *
 * 运行：cd packages/ui && npx vitest run src/extension-host/
 *
 * 契约来源：S4 slice plan IF1/IF2/DM1/DM2/ERR1/ERR2 + clarify Q1-Q4；
 * resetFor 契约来源：remote-use D5 exited 分区清理段（exited 分通道重置，重置语义非销毁）。
 * Mock 策略：MockDialogRequestSource（vi.fn 返回 unsubscribe 间谍）+ MockTransport（双通道 vi.fn）；
 * 不 mock useSessionScopedState（Map 分区是验收对象）——唯一的例外是文件级 init 计数透明包装
 * （TC-14「不建分区」的可观测锚点：真实工厂语义零变化，仅对 init 加计数，见下方 vi.mock 块）；
 * effectScope.run 包裹 + scope.stop() 隔离订阅状态。
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

// TC-14 观测锚点：init 调用计数（「分区是否被建立」的唯一可区分信号——分区建立与否在
// 队列公开 API 上行为同形，内存常驻差异只能经 init 计数观测）。vi.hoisted 供 mock 工厂
// （hoist 到 import 前）与用例体共享同一引用。
const initCounter = vi.hoisted(() => ({ count: 0 }))

// 透明包装：其余导出原样透传，仅对工厂的 init 参数加计数——真实 Map 分区语义仍是验收对象
vi.mock('@taiji/core/foundation/use-session-scoped-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/foundation/use-session-scoped-state')>()
  return {
    ...actual,
    useSessionScopedState: <T>(sid: Ref<string | null>, init: () => T) =>
      actual.useSessionScopedState<T>(sid, () => {
        initCounter.count += 1
        return init()
      }),
  }
})

// ── Mocks ────────────────────────────────────────────────────────────

class MockDialogRequestSource implements DialogRequestSource {
  onUiRequest = vi.fn((handler: (req: DialogRequest) => void): (() => void) => {
    this.requestHandler = handler
    const spy = vi.fn()
    return spy as unknown as () => void
  })
  onUiRequestExpired = vi.fn((handler: (e: { sessionId: string; requestId: string }) => void): (() => void) => {
    this.expiredHandler = handler
    const spy = vi.fn()
    return spy as unknown as () => void
  })

  requestHandler: ((req: DialogRequest) => void) | null = null
  expiredHandler: ((e: { sessionId: string; requestId: string }) => void) | null = null

  triggerUiRequest(req: Partial<DialogRequest> & { requestId: string; sessionId: string }): void {
    this.requestHandler?.(makeRequest(req))
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
    // 返 true = 送达（M1 环 3 后 respond 消费 boolean；未送达保留请求用例单独改返值）
    sendPiResponse: vi.fn((): boolean => true),
    sendPluginResponse: vi.fn((): boolean => true),
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
    initCounter.count = 0
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

  it('TC-8 订阅清理：scope.stop() 后事件不入队，unsubscribe 被调用（listener 防翻倍）', () => {
    const sid = ref<string | null>('A')
    const { source, scope, getQueue } = createHarness(sid)
    const q = getQueue()
    scope.stop()
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r1' })
    source.triggerExpired('A', 'r1')
    // stop 后 emit 不入队
    expect(q.pendingCount.value).toBe(0)
    // onUiRequest/onUiRequestExpired 返回的 unsubscribe 均被调用
    expect(source.onUiRequest).toHaveBeenCalledTimes(1)
    expect(source.onUiRequestExpired).toHaveBeenCalledTimes(1)
    const unsubUiRequest = source.onUiRequest.mock.results[0]?.value as () => void
    const unsubUiRequestExpired = source.onUiRequestExpired.mock.results[0]?.value as () => void
    expect(unsubUiRequest).toHaveBeenCalledTimes(1)
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

  // ── M1 环 3（RD-3#1）：回传未送达保留请求 ──

  it('TC-11 回传未送达（transport 返 false）→ 请求保留不出队；恢复后重投（返 true）出队（断连期应答不丢失）', () => {
    const sid = ref<string | null>('A')
    const { source, transport, scope, getQueue } = createHarness(sid)
    try {
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1' })
      const q = getQueue()
      expect(q.pendingCount.value).toBe(1)

      // 断连期用户作答：transport 返 false（WS 非 OPEN）→ 不出队，弹窗保留供重发
      vi.mocked(transport.sendPiResponse).mockReturnValueOnce(false)
      q.respond('r1', true)
      expect(transport.sendPiResponse).toHaveBeenCalledTimes(1)
      expect(q.pendingCount.value).toBe(1)
      expect(q.currentRequest.value?.requestId).toBe('r1')

      // 连接恢复后再次 respond：同 requestId 重投送达 → 出队（重发幂等由 runtime/pi 侧 miss 忽略保证）
      q.respond('r1', true)
      expect(transport.sendPiResponse).toHaveBeenCalledTimes(2)
      expect(q.pendingCount.value).toBe(0)
      expect(q.currentRequest.value).toBeUndefined()
    } finally {
      scope.stop()
    }
  })

  it('TC-11b plugin 源未送达同样保留（sendPluginResponse 返 false）', () => {
    const sid = ref<string | null>('A')
    const { source, transport, scope, getQueue } = createHarness(sid)
    try {
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r-p', source: 'plugin' })
      const q = getQueue()
      vi.mocked(transport.sendPluginResponse).mockReturnValueOnce(false)
      q.respond('r-p', 'opt')
      expect(q.pendingCount.value).toBe(1)

      q.respond('r-p', 'opt')
      expect(q.pendingCount.value).toBe(0)
      expect(transport.sendPluginResponse).toHaveBeenCalledTimes(2)
    } finally {
      scope.stop()
    }
  })

  // ── U6 resetFor：exited 分通道重置（remote-use D5 exited 分区清理段，重置语义非销毁） ──

  it('TC-12 resetFor 清空分区内容：pending/responding 写入空态，迟到 respond 无回传（ERR1）', () => {
    const sid = ref<string | null>('A')
    const { source, transport, scope, getQueue } = createHarness(sid)
    try {
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1' })
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r2' })
      const q = getQueue()
      expect(q.pendingCount.value).toBe(2)

      q.resetFor('A')
      // 空态：队首无请求、计数归零；残留 requestId 的 respond 走 ERR1 静默忽略（无回传）
      expect(q.pendingCount.value).toBe(0)
      expect(q.currentRequest.value).toBeUndefined()
      q.respond('r1', true)
      expect(transport.sendPiResponse).not.toHaveBeenCalled()
    } finally {
      scope.stop()
    }
  })

  it('TC-13 重置语义非销毁：resetFor 后同 sid 新请求照常入队（不进 deletedSids，无迟到写拦截）', () => {
    const sid = ref<string | null>('A')
    const { source, scope, getQueue } = createHarness(sid)
    try {
      source.triggerUiRequest({ sessionId: 'A', requestId: 'old' })
      const q = getQueue()
      q.resetFor('A')
      expect(q.pendingCount.value).toBe(0)

      // exited ≠ 删除（会话继续存在并恢复）：恢复期新请求（新 requestId）必须可达——
      // 若误用销毁语义（cleanup → deletedSids），此处 updateFor 首行拦截，入队静默丢弃
      source.triggerUiRequest({ sessionId: 'A', requestId: 'post-reset' })
      expect(q.pendingCount.value).toBe(1)
      expect(q.currentRequest.value?.requestId).toBe('post-reset')
    } finally {
      scope.stop()
    }
  })

  it('TC-14 resetFor 对不存在分区 no-op：不建分区（init 不被触发，前置存在性检查）', () => {
    const sid = ref<string | null>('A')
    const { source, scope, getQueue } = createHarness(sid)
    try {
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1' })
      expect(initCounter.count).toBe(1) // A 分区建立

      initCounter.count = 0
      const q = getQueue()
      expect(q.resetFor('never-existed')).toBeUndefined()
      // 守卫生效：清理动作未制造常驻空分区（照搬 updateFor 会经 getOrCreatePartition 惰性 init）
      expect(initCounter.count).toBe(0)
      // 守卫是「不存在才跳过」而非恒 no-op：对已存在的 A resetFor 正常清空
      q.resetFor('A')
      expect(q.pendingCount.value).toBe(0)
      expect(initCounter.count).toBe(0) // 已有分区的清空不触发 init
    } finally {
      scope.stop()
    }
  })
})
