import { createDialogRequestQueue, type DialogRequest, type DialogRequestQueue, type DialogRequestSource, type UiResponseTransport } from '../../extension-host/dialog-request-queue';
import { OTHER_VALUE, draftToScheduleFormResult, encodeFormAnswers, formQuestionsOf, initialQuestionState, isPlanReviewFrame, isQuestionAnswered, isRichInteractionFrame, questionKey, scheduleDraftOf, type QuestionState } from '../../extension-host/form-protocol';
import { createFormRequestChannel, type FormChannelPartitions, type FormRequestChannel, type FormRequestChannelOptions } from '../../extension-host/form-request-channel';
import { createPermissionRequestController, type PermissionRequestController } from '../../extension-host/permission-request-controller';
import ComposerInput from '../../features/composer/ComposerInput.vue';
import { ComposerInputDepsKey, type ComposerInputDeps } from '../../features/composer/composer-input-deps';
import { rebuildSegmentsWithEditedText } from '../../lib/segment-rebuild';
import { type DialogRequest as DialogRequest_m2, type InternalEvent, InternalEventBus } from '@taiji/core';
import { triggerSessionCleanups } from '@taiji/core/foundation/use-session-scoped-state';
import { dispatchGlobal } from '@taiji/core/transport/api';
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension';
import type { HandleImagePasteResult } from '@taiji/dom-core/composer/input';
import { type ToolCall, subagentVirtualId, buildSkillMarker, normalizeContent, segmentsToPrompt, segmentsToText, type Segment } from '@taiji/shared';
import { SubagentRow } from '@taiji/ui';
import { mount } from '@vue/test-utils';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { effectScope, ref, type Ref } from 'vue';

// wave3 簇 [ui/happy-dom] 5 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - extension-host/__tests__/dialog-request-queue.test.ts
 * - extension-host/__tests__/form-permission.test.ts
 * - features/chat/__tests__/SubagentRow.test.ts
 * - features/composer/__tests__/ComposerInput.test.ts
 * - lib/__tests__/segment-rebuild.test.ts
 */

// ======================================================================
// ← extension-host/__tests__/dialog-request-queue.test.ts
// ======================================================================

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
      // 检查生效：清理动作未制造常驻空分区（照搬 updateFor 会经 getOrCreatePartition 惰性 init）
      expect(initCounter.count).toBe(0)
      // 检查是「不存在才跳过」而非恒 no-op：对已存在的 A resetFor 正常清空
      q.resetFor('A')
      expect(q.pendingCount.value).toBe(0)
      expect(initCounter.count).toBe(0) // 已有分区的清空不触发 init
    } finally {
      scope.stop()
    }
  })

  // ── pendingCountBySession 跨分区计数（remote-use-mobile-v2 §6.18 待办聚合半）────
  // currentRequest/pendingCount 只读当前活跃分区；「需要你处理」聚合要全部会话的 dialog
  // 待答数——本组锁定计数登记与分区写点的同步（入队/出队/dedup/resetFor 四路径）。

  it('TC-15 跨分区聚合：非活跃分区的请求计入 pendingCountBySession（活跃分区读口不可见的面）', () => {
    const sid = ref<string | null>('A')
    const { source, scope, getQueue } = createHarness(sid)
    try {
      const q = getQueue()
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1' })
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r2' })
      source.triggerUiRequest({ sessionId: 'B', requestId: 'b1' }) // 非活跃分区
      expect(q.pendingCountBySession.value.get('A')).toBe(2)
      expect(q.pendingCountBySession.value.get('B')).toBe(1)
    } finally {
      scope.stop()
    }
  })

  it('TC-16 出队递减与键消失：逐条 respond 后计数递减，最后一条出队后键从 Map 摘除', () => {
    const sid = ref<string | null>('A')
    const { source, scope, getQueue } = createHarness(sid)
    try {
      const q = getQueue()
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1' })
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r2' })
      expect(q.pendingCountBySession.value.get('A')).toBe(2)
      q.respond('r1', true)
      expect(q.pendingCountBySession.value.get('A')).toBe(1)
      q.respond('r2', true)
      expect(q.pendingCountBySession.value.has('A')).toBe(false)
      expect(q.pendingCountBySession.value.size).toBe(0)
    } finally {
      scope.stop()
    }
  })

  it('TC-17 dedup 不加计：同 requestId 双源重复入队计数仍为 1（与 TC-3 分区行为对齐）', () => {
    const sid = ref<string | null>('A')
    const { source, scope, getQueue } = createHarness(sid)
    try {
      const q = getQueue()
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1' })
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1' })
      expect(q.pendingCountBySession.value.get('A')).toBe(1)
    } finally {
      scope.stop()
    }
  })

  it('TC-18 resetFor 计数归零 + 不存在分区 resetFor 不误登记：与分区写点同语义', () => {
    const sid = ref<string | null>('A')
    const { source, scope, getQueue } = createHarness(sid)
    try {
      const q = getQueue()
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1' })
      source.triggerUiRequest({ sessionId: 'B', requestId: 'b1' })
      q.resetFor('A')
      expect(q.pendingCountBySession.value.has('A')).toBe(false)
      expect(q.pendingCountBySession.value.get('B')).toBe(1) // 他分区不受影响
      q.resetFor('never-existed') // no-op 不误建登记（与 TC-14 分区侧同语义）
      expect(q.pendingCountBySession.value.size).toBe(1)
    } finally {
      scope.stop()
    }
  })

  it('TC-19 session 删除清理计数：triggerSessionCleanups 后 pendingCountBySession 不再含该 sid（他分区不受影响）', () => {
    const sid = ref<string | null>('A')
    const { source, scope, getQueue } = createHarness(sid)
    try {
      const q = getQueue()
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r1' })
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r2' })
      source.triggerUiRequest({ sessionId: 'B', requestId: 'b1' })
      expect(q.pendingCountBySession.value.get('A')).toBe(2)
      // 会话删除路径（triggerSessionCleanups）：分区由工厂自动注册的 cleanup 删除，
      // 计数登记表须同口径清条目——否则删除后三点全部不可达（resetFor 被 hasPartition
      // 早退、dequeueByRequestId 被 deletedSids 拦截），残留计数永久无法清除
      triggerSessionCleanups('A')
      expect(q.pendingCountBySession.value.has('A')).toBe(false)
      expect(q.pendingCountBySession.value.get('B')).toBe(1) // 他分区不受影响
      // 删除后迟到入队不复活计数（updateFor 对已删 sid no-op，计数写点在 updater 内不触）
      source.triggerUiRequest({ sessionId: 'A', requestId: 'r3' })
      expect(q.pendingCountBySession.value.has('A')).toBe(false)
    } finally {
      scope.stop()
    }
  })
})

// ======================================================================
// ← extension-host/__tests__/form-permission.test.ts
// ======================================================================

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← form-protocol.test.ts
// ======================================================================

function choiceReq(overrides: Partial<ExtensionUIRequest> = {}): ExtensionUIRequest {
  return {
    sessionId: 'sid-a',
    requestId: 'req-1',
    dialogKind: 'select',
    form: true,
    formQuestions: [
      { type: 'choice', question: '用哪个数据库？', options: [{ label: 'pg' }, { label: 'mysql' }] },
    ],
    ...overrides,
  }
}

function stateOf(selectedValues: string[], otherText = ''): QuestionState {
  return { selectedValues, otherText }
}

describe('问题 key 与已答判定', () => {
  it('questionKey：header 缺省回落 question 全文（协议 fallback 规则）', () => {
    expect(questionKey({ type: 'text', question: 'q1' })).toBe('q1')
    expect(questionKey({ type: 'text', header: 'h', question: 'q1' })).toBe('h')
  })

  it('choice：普通选项选中 ≥1 即已答；Other 选中无文本不算（另有其他选中则算）', () => {
    const q = { type: 'choice' as const, question: 'q', options: [{ label: 'a' }, { label: 'b' }] }
    expect(isQuestionAnswered(q, stateOf([]), true)).toBe(false)
    expect(isQuestionAnswered(q, stateOf(['a']), true)).toBe(true)
    expect(isQuestionAnswered(q, stateOf([OTHER_VALUE]), true)).toBe(false)
    expect(isQuestionAnswered(q, stateOf([OTHER_VALUE, 'a']), true)).toBe(true)
  })

  it('text / 空 options 退化 choice：非空文本即已答；schedule 委托 ready 入参', () => {
    const text = { type: 'text' as const, question: 'q' }
    expect(isQuestionAnswered(text, initialQuestionState(), true)).toBe(false)
    expect(isQuestionAnswered(text, stateOf([], '答案'), true)).toBe(true)
    const degenerate = { type: 'choice' as const, question: 'q', options: [] }
    expect(isQuestionAnswered(degenerate, stateOf([], '自由文本'), true)).toBe(true)
    const schedule = { type: 'schedule' as const, question: 'q' }
    expect(isQuestionAnswered(schedule, undefined, false)).toBe(false)
    expect(isQuestionAnswered(schedule, undefined, true)).toBe(true)
  })
})

describe('FormAnswers envelope 编码（桌面 FormOverlay.onSubmit 同契约）', () => {
  const single = { type: 'choice' as const, header: 'db', question: '用哪个数据库？', options: [{ label: 'pg' }, { label: 'mysql' }] }
  const multi = { type: 'choice' as const, header: 'feat', question: '要哪些功能？', multi: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }
  const text = { type: 'text' as const, header: 'note', question: '补充说明？' }

  it('单选 = label；多选 = JSON.stringify(label[])；Other 过滤占位符', () => {
    const answers = encodeFormAnswers(
      [single, multi],
      { db: stateOf(['pg']), feat: stateOf(['a', OTHER_VALUE, 'c']) },
      () => null,
    )
    expect(answers).toEqual({ db: 'pg', feat: JSON.stringify(['a', 'c']) })
  })

  it('Other 自由文本写 `${key}__other` 独立键；text 题答案只写 __other 不写主 key', () => {
    expect(encodeFormAnswers(
      [single, text],
      { db: stateOf([OTHER_VALUE], '自定义'), note: stateOf([], '备注内容') },
      () => null,
    )).toEqual({ db__other: '自定义', note__other: '备注内容' })
  })

  it('schedule 题经 scheduleValue 取回显 JSON 写主 key；不可构造返回 null 中止整表', () => {
    const schedule = { type: 'schedule' as const, question: '什么时候跑？', initial: undefined }
    expect(encodeFormAnswers([schedule], {}, () => null)).toBeNull()
    expect(encodeFormAnswers([schedule], {}, () => '{"action":"create"}')).toEqual({
      [schedule.question]: '{"action":"create"}',
    })
  })

  it('无状态的问题跳过（不伪造空答案键）', () => {
    expect(encodeFormAnswers([single], {}, () => null)).toEqual({})
  })
})

describe('schedule 草稿回显（桌面 ScheduleForm 打开即确认路径等价）', () => {
  const baseDraft = {
    kind: 'once' as const,
    schedule: '30 14 2 10 *',
    prompt: '跑每日备份',
    models: ['m1', 'm2'],
  }

  it('once：草稿 cron 经 onceCronToDate 还原再 dateToOnceCron 折叠（往返稳定）', () => {
    const result = draftToScheduleFormResult(baseDraft)
    expect(result).not.toBeNull()
    expect(result!.action).toBe('create')
    expect(result!.kind).toBe('once')
    expect(result!.schedule).toBe(baseDraft.schedule) // 未过时刻往返字节稳定
    expect(result!.prompt).toBe('跑每日备份')
    expect(result!.name).toBeUndefined()
    expect(result!.expires).toBeUndefined() // once 不携带 expires
  })

  it('recurring：schedule 原样（trim）；expires 缺省 7d、显式 30d/never 保留；model 缺省剔除', () => {
    const result = draftToScheduleFormResult({
      ...baseDraft,
      kind: 'recurring',
      schedule: '  */5 * * * *  ',
      expires: '7d',
      model: '不在候选列表的模型',
    })
    expect(result).toEqual({
      action: 'create',
      kind: 'recurring',
      schedule: '*/5 * * * *',
      model: 'm1', // 预选回落候选首项（桌面 initModelSelection 同式）
      prompt: '跑每日备份',
      expires: '7d',
    })
    expect(draftToScheduleFormResult({ ...baseDraft, kind: 'recurring', expires: 'never' })!.expires).toBe('never')
    expect(draftToScheduleFormResult({ ...baseDraft, kind: 'recurring', expires: '30d' })!.expires).toBe('30d')
  })

  it('model 预选：draft.model 优先 → 会话当前模型 → 候选首项；空候选缺省', () => {
    expect(draftToScheduleFormResult({ ...baseDraft, model: 'm2' })!.model).toBe('m2')
    expect(draftToScheduleFormResult({ ...baseDraft, currentModel: 'm2' })!.model).toBe('m2')
    expect(draftToScheduleFormResult({ ...baseDraft, models: [] })!.model).toBeUndefined()
  })

  it('prompt 空 → null（桌面 canSubmit 同判）；once cron 非 5 段一次性形态 → null；name trim 空剔除', () => {
    expect(draftToScheduleFormResult({ ...baseDraft, prompt: '   ' })).toBeNull()
    expect(draftToScheduleFormResult({ ...baseDraft, schedule: '*/5 * * * *' })).toBeNull()
    expect(draftToScheduleFormResult({ ...baseDraft, name: '  ' })!.name).toBeUndefined()
  })
})

describe('帧标记守卫与字段收窄', () => {
  it('isRichInteractionFrame：form/planReview 放行；普通 dialog 帧拒绝；非对象安全 false', () => {
    expect(isRichInteractionFrame({ form: true })).toBe(true)
    expect(isRichInteractionFrame({ planReview: true })).toBe(true)
    expect(isRichInteractionFrame({ kind: 'select', options: ['a'] })).toBe(false)
    expect(isRichInteractionFrame(null)).toBe(false)
    expect(isRichInteractionFrame('form')).toBe(false)
  })

  it('isPlanReviewFrame 窄化 + selfReview 搬运；formQuestionsOf 过滤非法项；scheduleDraftOf 收窄', () => {
    const planFrame = { ...choiceReq(), planReview: true, selfReview: '自审结论' } as unknown as ExtensionUIRequest
    expect(isPlanReviewFrame(planFrame)).toBe(true)

    const mixed = choiceReq({
      formQuestions: [
        { type: 'choice', question: 'q1', options: [{ label: 'a' }] },
        { type: 'alien' },
        'not-an-object',
      ],
    })
    const qs = formQuestionsOf(mixed)
    expect(qs).toHaveLength(1)
    expect(formQuestionsOf({ ...choiceReq(), form: undefined })).toEqual([])

    const draft = { kind: 'once' as const, schedule: '30 14 2 10 *', prompt: 'p', models: ['m1'] }
    const draftReq = choiceReq({ scheduleCreate: true, scheduleDraft: draft })
    expect(scheduleDraftOf(draftReq)).not.toBeNull()
    expect(scheduleDraftOf(choiceReq({ scheduleCreate: true, scheduleDraft: { broken: true } }))).toBeNull()
    expect(scheduleDraftOf(choiceReq())).toBeNull()
  })
})

// ======================================================================
// ← form-request-channel.test.ts
// ======================================================================

const { mockGetPending, mockSendResponse } = vi.hoisted(() => ({
  mockGetPending: vi.fn(),
  mockSendResponse: vi.fn(),
}))

vi.mock('@taiji/core/transport/api/domains/extension', () => ({
  getPendingRequests: mockGetPending,
  sendExtensionUIResponse: mockSendResponse,
}))

/** fake 分区容器（内存 Map + requestId dedup + 幂等 remove；retainOnly 按用例挂载） */
function fakePartitions(): FormChannelPartitions & { map: Map<string, ExtensionUIRequest[]> } {
  const map = new Map<string, ExtensionUIRequest[]>()
  return {
    map,
    get: (sid) => map.get(sid) ?? [],
    add: (sid, req) => {
      const list = map.get(sid) ?? []
      if (list.some((r) => r.requestId === req.requestId)) return
      map.set(sid, [...list, req])
    },
    remove: (sid, ids) => {
      const list = map.get(sid)
      if (!list) return
      const set = new Set(ids)
      const next = list.filter((r) => !set.has(r.requestId))
      if (next.length === list.length) return
      if (next.length === 0) map.delete(sid)
      else map.set(sid, next)
    },
  }
}

function formReq(requestId: string, overrides: Partial<ExtensionUIRequest> = {}): ExtensionUIRequest {
  return { sessionId: 'sid-a', requestId, dialogKind: 'select', form: true, ...overrides } as ExtensionUIRequest
}

function planReq(requestId: string, overrides: Partial<ExtensionUIRequest> = {}): ExtensionUIRequest {
  return { sessionId: 'sid-a', requestId, dialogKind: 'select', planReview: true, ...overrides } as ExtensionUIRequest
}

/** bus 热帧形状（core DialogRequest_m2：marker 键由索引签名承载，同 useExtensionUI 测试族） */
function dialogFrame(requestId: string): DialogRequest_m2 {
  return { requestId, pluginId: '', kind: 'select' } as DialogRequest_m2
}

function formFrame(requestId: string): DialogRequest_m2 {
  return { requestId, pluginId: '', kind: 'select', form: true } as DialogRequest_m2
}

let partitions: ReturnType<typeof fakePartitions>
let channel: ReturnType<typeof createFormRequestChannel>

/** 装配测试通道（公共 adapt 双源 + 可选钩子/partitions 覆盖；各用例只声明自己观测的面） */
function makeChannel(
  hooks: Partial<FormRequestChannelOptions> = {},
  adaptFrame?: FormRequestChannelOptions['adaptFrame'],
): FormRequestChannel {
  return createFormRequestChannel({
    partitions,
    adaptFrame: adaptFrame ?? ((sid, req) => formReq(req.requestId, { sessionId: sid })),
    adaptSnapshot: (sid, req) => ({ ...req, sessionId: sid }),
    ...hooks,
  })
}

beforeEach(() => {
  partitions = fakePartitions()
  channel = makeChannel()
  mockGetPending.mockReset().mockResolvedValue([])
  mockSendResponse.mockReset().mockReturnValue(true)
})

describe('ingest：C4 门 + 适配 + filter 第二道闸', () => {
  it('form/planReview 帧放行入分区（adaptFrame 适配）；普通 dialog 帧拒绝', () => {
    channel.ingest('sid-a', formFrame('r1'))
    channel.ingest('sid-a', dialogFrame('r2'))
    expect(partitions.get('sid-a').map((r) => r.requestId)).toEqual(['r1'])

    const planChannel = makeChannel({}, (sid, req) => planReq(req.requestId, { sessionId: sid }))
    planChannel.ingest('sid-a', { ...dialogFrame('r3'), planReview: true } as DialogRequest_m2)
    expect(partitions.get('sid-a').map((r) => r.requestId)).toEqual(['r1', 'r3'])
  })

  it('filter 第二道闸：不放行的适配帧不入分区（实例分型，dedup 归分区实现）', () => {
    channel.ingest('sid-a', formFrame('r1'), () => false)
    expect(partitions.get('sid-a')).toHaveLength(0)
    channel.ingest('sid-a', formFrame('r1'), () => true)
    expect(partitions.get('sid-a')).toHaveLength(1)
  })

  it('onIngested 钩子在写入后收到适配帧', () => {
    const seen: string[] = []
    const c = makeChannel({ onIngested: (_sid, req) => seen.push(req.requestId) })
    c.ingest('sid-a', formFrame('r1'))
    c.ingest('sid-a', dialogFrame('r2')) // C4 拒绝，不触发钩子
    expect(seen).toEqual(['r1'])
  })
})

describe('invalidate：removed 捕获 + 摘除', () => {
  it('按 requestId 摘除；onInvalidated 收到摘除前条目；无命中不触发钩子', () => {
    partitions.add('sid-a', formReq('r1'))
    partitions.add('sid-a', formReq('r2'))
    const seen: Array<{ ids: readonly string[]; removed: readonly string[] }> = []
    const c = makeChannel({
      onInvalidated: (_sid, ids, removed) => seen.push({ ids, removed: removed.map((r) => r.requestId) }),
    })

    c.invalidate('sid-a', ['r1', 'r-miss'])
    expect(partitions.get('sid-a').map((r) => r.requestId)).toEqual(['r2'])
    expect(seen).toEqual([{ ids: ['r1', 'r-miss'], removed: ['r1'] }])

    seen.length = 0
    c.invalidate('sid-a', ['r-miss']) // 无命中：分区不动、钩子不触发
    expect(seen).toEqual([])
  })
})

describe('reconcile：快照差集剔除 + 富交互补入', () => {
  it('空快照也剔除（僵尸请求修剪主算法）；removedIds 随 onSnapshotReconciled 外发', async () => {
    partitions.add('sid-a', formReq('stale'))
    const removedSeen: string[][] = []
    const c = makeChannel({
      onSnapshotReconciled: (_sid, removedIds) => removedSeen.push([...removedIds]),
    })

    mockGetPending.mockResolvedValue([])
    c.reconcile('sid-a')
    await vi.waitFor(() => expect(removedSeen).toHaveLength(1), { interval: 1 })

    expect(partitions.get('sid-a')).toHaveLength(0) // 空快照剔除
    expect(removedSeen[0]).toEqual(['stale'])
  })

  it('补入只入富交互帧（普通 dialog 帧不进分区）；快照富交互帧保留（keepIds 权威）', async () => {
    partitions.add('sid-a', formReq('kept'))
    mockGetPending.mockResolvedValue([
      formReq('kept'),
      formReq('fresh'),
      { sessionId: 'sid-a', requestId: 'plain', dialogKind: 'select' },
    ])
    channel.reconcile('sid-a')
    await vi.waitFor(() => expect(partitions.get('sid-a').map((r) => r.requestId)).toContain('fresh'), { interval: 1 })

    expect(partitions.get('sid-a').map((r) => r.requestId).sort()).toEqual(['fresh', 'kept'])
  })

  it('提供 retainOnly 时走批量路径（不逐条 remove）；RPC 失败 warn 静默不抛', async () => {
    const retainCalls: Array<ReadonlySet<string>> = []
    const withRetain = makeChannel({
      partitions: {
        ...partitions,
        retainOnly: (_sid, keepIds) => retainCalls.push(keepIds),
      },
    })
    withRetain.reconcile('sid-a')
    await vi.waitFor(() => expect(retainCalls).toHaveLength(1), { interval: 1 })
    expect([...retainCalls[0]]).toEqual([])

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockGetPending.mockRejectedValue(new Error('rpc down'))
    expect(() => channel.reconcile('sid-a')).not.toThrow()
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled(), { interval: 1 })
    warnSpy.mockRestore()
  })
})

describe('respond：未送达保留 / 送达摘除 / 已终结丢弃', () => {
  it('定位失败 → onRespondExpired + false（分区不动）', () => {
    const expired: string[] = []
    const c = makeChannel({ onRespondExpired: (_sid, rid) => expired.push(rid) })
    expect(c.respond('sid-a', 'ghost', 'answer')).toBe(false)
    expect(expired).toEqual(['ghost'])
    expect(mockSendResponse).not.toHaveBeenCalled()
  })

  it('未送达 → 分区条目保留（M1/RD-3#1 可重试）+ onRespondUndelivered + false', () => {
    partitions.add('sid-a', formReq('r1'))
    const undelivered: string[] = []
    const c = makeChannel({ onRespondUndelivered: (_sid, rid) => undelivered.push(rid) })
    mockSendResponse.mockReturnValueOnce(false)
    expect(c.respond('sid-a', 'r1', 'answer')).toBe(false)
    expect(undelivered).toEqual(['r1'])
    expect(partitions.get('sid-a').map((r) => r.requestId)).toEqual(['r1'])
  })

  it('送达 → 摘除 + onRespondDelivered（条目与 result 外发）+ true；cancel = respond null', () => {
    partitions.add('sid-a', formReq('r1'))
    const delivered: Array<{ rid: string; result: boolean | string | null }> = []
    const c = makeChannel({
      onRespondDelivered: (_sid, req, result) => delivered.push({ rid: req.requestId, result }),
    })
    expect(c.respond('sid-a', 'r1', 'answer')).toBe(true)
    expect(mockSendResponse).toHaveBeenCalledWith('sid-a', 'r1', 'select', 'answer')
    expect(partitions.get('sid-a')).toHaveLength(0)
    expect(delivered).toEqual([{ rid: 'r1', result: 'answer' }])

    partitions.add('sid-a', formReq('r2'))
    c.cancel('sid-a', 'r2')
    expect(mockSendResponse).toHaveBeenLastCalledWith('sid-a', 'r2', 'select', null)
    expect(partitions.get('sid-a')).toHaveLength(0)
  })
})

describe('读口：firstFormRequest / planReviewRequests', () => {
  it('队首 form 帧命中；无 sid 分区恒 undefined；planReview 列表窄化 selfReview', () => {
    expect(channel.firstFormRequest('sid-a')).toBeUndefined()
    partitions.add('sid-a', formReq('r1'))
    partitions.add('sid-a', formReq('r2'))
    partitions.add('sid-a', planReq('p1', { selfReview: '自审' } as Partial<ExtensionUIRequest>))

    expect(channel.firstFormRequest('sid-a')?.requestId).toBe('r1')
    const plans = channel.planReviewRequests('sid-a')
    expect(plans).toHaveLength(1)
    expect(plans[0].requestId).toBe('p1')
    expect(plans[0].selfReview).toBe('自审')
  })
})

// ======================================================================
// ← permission-request-controller.test.ts
// ======================================================================

// mock RPC 回传域（approve/deny 走 command → ws-client，测试环境不连 WS）
const approvePermissions = vi.fn()
const denyPermissions = vi.fn()
vi.mock('@taiji/core/transport/api/domains/plugin', () => ({
  approvePermissions: (...args: unknown[]) => approvePermissions(...args),
  denyPermissions: (...args: unknown[]) => denyPermissions(...args),
}))

/** 通过 bus.emit 模拟 bridge 归一后的 permission 事件（requestId 默认合成形态） */
function emitPermissionRequest(
  bus: InternalEventBus,
  pluginId = 'p1',
  permissions: string[] = ['shell'],
  requestId = `perm_${pluginId}`,
): void {
  bus.emit({
    kind: 'plugin-permission-request',
    request: { pluginId, permissions, requestId },
  } as InternalEvent)
}

/** 通过 global 通道模拟 runtime 撤窗广播（payload { pluginId }，无 sessionId） */
function emitExpired(pluginId: string, requestId?: string): void {
  dispatchGlobal({
    type: 'plugin:permissionRequestExpired',
    payload: { pluginId, ...(requestId !== undefined ? { requestId } : {}) },
  })
}

/** 通过 bus.emit 模拟 bridge 归一后的 resolved 终局事件（S5-V3；requestId 空串 = 旧版广播窄化形态） */
function emitResolved(
  bus: InternalEventBus,
  pluginId: string,
  requestId: string,
  approved = true,
): void {
  bus.emit({
    kind: 'plugin-permission-request-resolved',
    resolved: { pluginId, requestId, approved },
  } as InternalEvent)
}

describe('createPermissionRequestController 状态机（双壳共享）', () => {
  let bus: InternalEventBus
  let controller: PermissionRequestController

  beforeEach(() => {
    approvePermissions.mockReset()
    denyPermissions.mockReset()
    bus = new InternalEventBus()
    controller = createPermissionRequestController(bus)
  })

  afterEach(() => {
    controller.dispose()
  })

  it('TC1: 正常事件 → state 弹窗（pluginId/permissions/pending=true/error=false）；permissions 拷贝防串改', () => {
    const shared: string[] = ['fs.read', 'net.http']
    emitPermissionRequest(bus, 'tasks', shared)

    expect(controller.state.pluginId).toBe('tasks')
    expect(controller.state.permissions).toEqual(['fs.read', 'net.http'])
    expect(controller.state.pending).toBe(true)
    expect(controller.state.error).toBe(false)

    // 拷贝防串扰：emit 后外部数组变更不串入 state
    shared.push('later-mutation')
    expect(controller.state.permissions).toEqual(['fs.read', 'net.http'])
  })

  it('TC2: 畸形事件检查 warn+skip：空 pluginId / permissions 非数组 / 非字符串项 均不写 state，后续合法事件照常', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 空 pluginId
      emitPermissionRequest(bus, '', ['fs.read'])
      expect(controller.state.pending).toBe(false)

      // permissions 非数组（测试注入坏形状，受控 cast）
      bus.emit({
        kind: 'plugin-permission-request',
        request: { pluginId: 'p1', permissions: 'fs.read' as unknown as string[], requestId: 'r' },
      } as InternalEvent)
      expect(controller.state.pending).toBe(false)

      // permissions 含非字符串项
      bus.emit({
        kind: 'plugin-permission-request',
        request: { pluginId: 'p1', permissions: ['ok', 42 as unknown as string], requestId: 'r' },
      } as InternalEvent)
      expect(controller.state.pending).toBe(false)
      expect(controller.state.pluginId).toBe('')

      expect(warnSpy).toHaveBeenCalledTimes(3)

      // 检查只 skip 不毒害状态：合法事件照常弹出
      emitPermissionRequest(bus, 'p2', ['fs.read'])
      expect(controller.state.pending).toBe(true)
      expect(controller.state.pluginId).toBe('p2')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('TC3: 新请求覆盖旧弹窗：error 清零 + pluginId/permissions 全量重置（上一单失败错误态不残留）', async () => {
    // 先制造失败错误态（BM3）
    emitPermissionRequest(bus, 'p1', ['shell'])
    denyPermissions.mockRejectedValue(new Error('rpc boom'))
    controller.transport.deny('p1')
    await vi.waitFor(() => expect(controller.state.error).toBe(true), { interval: 1 })
    expect(controller.state.pending).toBe(true)

    // 新请求覆盖：error 清零，pluginId/permissions 换新
    emitPermissionRequest(bus, 'p2', ['fs.read', 'net.http'])
    expect(controller.state.error).toBe(false)
    expect(controller.state.pending).toBe(true)
    expect(controller.state.pluginId).toBe('p2')
    expect(controller.state.permissions).toEqual(['fs.read', 'net.http'])
  })

  it('TC4: approve 成功 → pending=false + error=false；失败 → pending 保持 true + error=true（BM3），重试成功收尾', async () => {
    emitPermissionRequest(bus)
    approvePermissions.mockResolvedValue(undefined)
    controller.transport.approve('p1', ['shell'])
    await vi.waitFor(() => expect(controller.state.pending).toBe(false), { interval: 1 })
    expect(controller.state.error).toBe(false)
    expect(approvePermissions).toHaveBeenCalledWith('p1', ['shell'])

    // 失败路径（BM3 假成功红线）：弹窗保持打开 + 错误显形
    emitPermissionRequest(bus)
    approvePermissions.mockRejectedValue(new Error('rpc boom'))
    controller.transport.approve('p1', ['shell'])
    await vi.waitFor(() => expect(controller.state.error).toBe(true), { interval: 1 })
    expect(controller.state.pending).toBe(true)

    // 重试成功 → 正常收尾
    approvePermissions.mockResolvedValue(undefined)
    controller.transport.approve('p1', ['shell'])
    await vi.waitFor(() => expect(controller.state.pending).toBe(false), { interval: 1 })
    expect(controller.state.error).toBe(false)
  })

  it('TC5: deny 走 denyPermissions（拒绝本次申请）：成功 pending=false；失败 pending 保持 true + error=true（BM3）', async () => {
    emitPermissionRequest(bus)
    denyPermissions.mockResolvedValue(undefined)
    controller.transport.deny('p1')
    await vi.waitFor(() => expect(controller.state.pending).toBe(false), { interval: 1 })
    expect(denyPermissions).toHaveBeenCalledWith('p1')
    expect(controller.state.error).toBe(false)

    // 失败路径：弹窗保持打开 + 错误显形
    emitPermissionRequest(bus)
    denyPermissions.mockRejectedValue(new Error('rpc boom'))
    controller.transport.deny('p1')
    await vi.waitFor(() => expect(controller.state.error).toBe(true), { interval: 1 })
    expect(controller.state.pending).toBe(true)
  })

  it('TC6: expired 命中当前弹窗（pluginId 匹配）→ pending=false + error=false（超时撤窗连错误行一起清）', async () => {
    emitPermissionRequest(bus, 'p1')
    // 先制造失败错误态，再撤窗——弹窗都撤了，错误无载体
    denyPermissions.mockRejectedValue(new Error('rpc boom'))
    controller.transport.deny('p1')
    await vi.waitFor(() => expect(controller.state.error).toBe(true), { interval: 1 })

    emitExpired('p1')
    expect(controller.state.pending).toBe(false)
    expect(controller.state.error).toBe(false)
  })

  it('TC7: expired pluginId 不匹配 → noop（陈旧广播不误撤新插件弹窗）；无挂起 → noop 幂等', () => {
    emitPermissionRequest(bus, 'p2')

    // 旧插件 p1 的迟到 expired 广播：当前弹窗属于 p2，不应被撤
    emitExpired('p1')
    expect(controller.state.pending).toBe(true)
    expect(controller.state.pluginId).toBe('p2')

    // p2 自己的 expired 才撤
    emitExpired('p2')
    expect(controller.state.pending).toBe(false)

    // 无挂起弹窗时再收 → noop 幂等
    emitExpired('p2')
    expect(controller.state.pending).toBe(false)
  })

  it('TC8: dispose 退订：bus 事件与 expired 广播均不再驱动 state', () => {
    // 先置 pending=true（弹窗在场）再 dispose——终局态（pending=false）下 expired 泄漏是恒 noop，测不出退订
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    expect(controller.state.pending).toBe(true)

    controller.dispose()

    // offRequest 退订锚：泄漏时新请求会覆盖 state（pluginId/requestId 被改写）
    emitPermissionRequest(bus, 'p2', ['fs.read'], 'req-b')
    expect(controller.state.pending).toBe(true)
    expect(controller.state.pluginId).toBe('p1')
    expect(controller.state.requestId).toBe('req-a')

    // offExpired 退订锚：泄漏时命中形态（同 pluginId 同 requestId）的 expired 广播会误撤窗
    emitExpired('p1', 'req-a')
    expect(controller.state.pending).toBe(true)
  })

  it('TC9: 同 pluginId 先后两单，expired 按 requestId 精确撤回——前单陈旧广播不误撤后到弹窗', () => {
    // 同插件 p1 的两次审批请求先后到达（弹窗全局单例，后者覆盖前者）
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    expect(controller.state.pending).toBe(true)
    expect(controller.state.requestId).toBe('req-a')
    emitPermissionRequest(bus, 'p1', ['net.http'], 'req-b')
    expect(controller.state.requestId).toBe('req-b')

    // 前单 req-a 的陈旧 expired 广播迟到：requestId 不匹配当前弹窗 → noop 不误撤
    emitExpired('p1', 'req-a')
    expect(controller.state.pending).toBe(true)
    expect(controller.state.requestId).toBe('req-b')

    // 当前单 req-b 的 expired 才撤
    emitExpired('p1', 'req-b')
    expect(controller.state.pending).toBe(false)

    // 撤回后同 pluginId 再收 expired → noop 幂等
    emitExpired('p1', 'req-b')
    expect(controller.state.pending).toBe(false)
  })

  it('TC10: expired payload 缺 requestId（旧版广播）→ 回退按 pluginId 匹配撤回', () => {
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    emitExpired('p1')
    expect(controller.state.pending).toBe(false)
  })

  it('TC11: resolved 按 requestId 精确撤回——同 pluginId 先后两单，前单陈旧 resolved 不误撤后到弹窗；命中时连错误行一起清', async () => {
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    emitPermissionRequest(bus, 'p1', ['net.http'], 'req-b')

    // 前单 req-a 的陈旧 resolved（A 端对旧弹窗的批准广播迟到）：requestId 不匹配 → noop
    emitResolved(bus, 'p1', 'req-a', true)
    expect(controller.state.pending).toBe(true)
    expect(controller.state.requestId).toBe('req-b')

    // 当前单 req-b 的 resolved 命中撤回；先制造错误态再撤（弹窗都撤了，错误无载体）
    denyPermissions.mockRejectedValue(new Error('rpc boom'))
    controller.transport.deny('p1')
    await vi.waitFor(() => expect(controller.state.error).toBe(true), { interval: 1 })
    emitResolved(bus, 'p1', 'req-b', true)
    expect(controller.state.pending).toBe(false)
    expect(controller.state.error).toBe(false)
  })

  it('TC12: resolved requestId 空串（bridge 对旧版广播的宽容窄化产物）→ 回退按 pluginId 匹配撤回', () => {
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    emitResolved(bus, 'p1', '', false)
    expect(controller.state.pending).toBe(false)
  })

  it('TC13: dispose 退订 resolved 订阅：dispose 后 resolved 命中形态不再撤窗', () => {
    // 先置 pending=true（弹窗在场）再 dispose——终局态（pending=false）下 resolved 泄漏是恒 noop，测不出退订
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    expect(controller.state.pending).toBe(true)

    controller.dispose()

    // offResolved 泄漏时：requestId 命中形态的 resolved 广播会误撤窗（pending 翻 false）
    emitResolved(bus, 'p1', 'req-a', true)
    expect(controller.state.pending).toBe(true)
  })
})

// ======================================================================
// ← features/chat/__tests__/SubagentRow.test.ts
// ======================================================================

// mock drawer 协同层：断言点击整行时 openSubagent 以 virtualId 被调（enteredFrom 已随 workflow tab 删除移除）
const { openSubagentMock } = vi.hoisted(() => ({ openSubagentMock: vi.fn() }))
vi.mock('@taiji/core/domain/drawer', () => ({
  openSubagent: openSubagentMock,
}))

// prefix 走 i18n（覆盖包级「t 返回 key」默认 mock）：断言渲染的是 zh 文案而非裸 key 透出
vi.mock('vue-i18n', async () => {
  const { i18nMock } = await import('../helpers/i18n-mock')
  return i18nMock({ 'panel.message.subagent': '子代理' })
})

/** 构造真实形态的 subagent ToolCall（顶层拍平 input） */
function makeSubagent(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-sub-1',
    toolName: 'subagent',
    input: {
      action: 'start',
      agent: 'researcher',
      slug: 'research-trace-ui',
      task: '调研 trace UI 渲染方案',
    },
    status: 'completed',
    startTime: 1000,
    endTime: 2000,
    ...over,
  }
}

beforeEach(() => {
  openSubagentMock.mockReset()
})

describe('SubagentRow: 标题行渲染（顶层 input 拍平字段）', () => {
  it('渲染 subagent prefix + agent（--name 暖驼）+ · + slug（层级灰）', () => {
    const wrapper = mount(SubagentRow, {
      props: { tool: makeSubagent(), sessionId: 's1' },
    })
    const text = wrapper.text()
    // subagent prefix 文案来自 i18n 键（t('panel.message.subagent') → zh「子代理」）
    expect(text).toContain('子代理')
    // agent 名（顶层 input.agent，非默认值）
    expect(text).toContain('researcher')
    // slug（顶层 input.slug）
    expect(text).toContain('research-trace-ui')
    // agent 名染对话流专属名称色 var(--name)（用户裁决 2026-10-06，原 accent）
    expect(wrapper.findAll('span').some((s) => s.classes().includes('text-[color:var(--name)]'))).toBe(true)
    // slug 降行层级灰 --neutral-mid（与「子代理」标签同色；用户裁决 2026-10-06，原 accent）
    expect(wrapper.findAll('span').some((s) => s.classes().includes('text-neutral-mid'))).toBe(true)
  })

  it('无 input.agent 时回退默认 general-purpose', () => {
    const wrapper = mount(SubagentRow, {
      props: {
        tool: makeSubagent({ input: { action: 'start', task: 'do something' } }),
      },
    })
    expect(wrapper.text()).toContain('general-purpose')
  })

  it('有 model + thinkingLevel 时渲染括号（model 层级灰，括号/· thinking dim）', () => {
    const wrapper = mount(SubagentRow, {
      props: {
        tool: makeSubagent({
          input: {
            action: 'start',
            agent: 'researcher',
            slug: 'rs',
            model: 'anthropic/claude-sonnet-4',
            thinkingLevel: 'high',
            task: 'task',
          },
        }),
      },
    })
    const text = wrapper.text()
    expect(text).toContain('anthropic/claude-sonnet-4')
    expect(text).toContain('thinking high')
  })

  it('有 model 无 thinkingLevel 时只渲染括号 + model', () => {
    const wrapper = mount(SubagentRow, {
      props: {
        tool: makeSubagent({
          input: {
            action: 'start',
            agent: 'researcher',
            model: 'openai/gpt-4o',
            task: 'task',
          },
        }),
      },
    })
    const text = wrapper.text()
    expect(text).toContain('openai/gpt-4o')
    expect(text).not.toContain('thinking')
  })
})

describe('SubagentRow: collapsed only（§10：task 预览 / 展开体 / bg 状态行已移除）', () => {
  it('task 不在对话流内展示（task 预览已移除，全文看 drawer subagent tab）', () => {
    const wrapper = mount(SubagentRow, {
      props: {
        tool: makeSubagent({ input: { action: 'start', task: '单行短任务' } }),
      },
    })
    expect(wrapper.text()).not.toContain('单行短任务')
  })

  it('无展开体：点击整行不出现 task 完整内容区', async () => {
    const wrapper = mount(SubagentRow, {
      props: {
        tool: makeSubagent({ input: { action: 'start', task: '完整 task 内容' } }),
      },
    })
    // 默认无展开体
    expect(wrapper.find('.subagent-task-full').exists()).toBe(false)
    // 点击后依然无展开体（collapsed only，点击行为是开 drawer 而非展开）
    await wrapper.find('[data-testid="subagent-block"] > div').trigger('click')
    expect(wrapper.find('.subagent-task-full').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('完整 task 内容')
  })

  it('output 有 bgResponse 也不渲染 bg 状态行（完成通知走 §10.5 BgNotifyCard）', () => {
    const wrapper = mount(SubagentRow, {
      props: {
        tool: makeSubagent({
          input: { action: 'start', task: 'task' },
          output: JSON.stringify({
            action: 'start',
            subagentId: '1338dda5',
            sessionFile: null,
            slug: 'rs',
            bgResponse: {
              status: 'running',
              mode: 'background',
              message: 'detached, will notify on completion (auto-injected message, do not poll)',
            },
          }),
        }),
      },
    })
    const text = wrapper.text()
    expect(text).not.toContain('background ·')
    expect(text).not.toContain('detached, will notify on completion')
    // 无状态点 blink 动画
    expect(wrapper.find('.animate-blink').exists()).toBe(false)
  })
})

describe('SubagentRow: 点击行为（开 drawer subagent tab）', () => {
  it('output 含 subagentId + sessionId → openSubagent(virtualId)', async () => {
    const wrapper = mount(SubagentRow, {
      props: {
        tool: makeSubagent({
          output: JSON.stringify({
            action: 'start',
            subagentId: '1338dda5',
            sessionFile: null,
            slug: 'rs',
          }),
        }),
        sessionId: 's1',
      },
    })
    await wrapper.find('[data-testid="subagent-block"] > div').trigger('click')
    expect(openSubagentMock).toHaveBeenCalledTimes(1)
    expect(openSubagentMock).toHaveBeenCalledWith({
      virtualId: subagentVirtualId('s1', '1338dda5'),
    })
  })

  it('缺 sessionId 时 no-op（不抛错、不调 openSubagent）', async () => {
    const wrapper = mount(SubagentRow, {
      props: {
        tool: makeSubagent({
          output: JSON.stringify({ action: 'start', subagentId: '1338dda5' }),
        }),
      },
    })
    await wrapper.find('[data-testid="subagent-block"] > div').trigger('click')
    expect(openSubagentMock).not.toHaveBeenCalled()
  })

  it('output 非合法 JSON 时 no-op（running 早期 output 未就绪）', async () => {
    const wrapper = mount(SubagentRow, {
      props: {
        tool: makeSubagent({ output: 'plain text not json' }),
        sessionId: 's1',
      },
    })
    await wrapper.find('[data-testid="subagent-block"] > div').trigger('click')
    expect(openSubagentMock).not.toHaveBeenCalled()
  })

  it('output JSON 无 subagentId 字段时 no-op', async () => {
    const wrapper = mount(SubagentRow, {
      props: {
        tool: makeSubagent({ output: JSON.stringify({ action: 'start', slug: 'rs' }) }),
        sessionId: 's1',
      },
    })
    await wrapper.find('[data-testid="subagent-block"] > div').trigger('click')
    expect(openSubagentMock).not.toHaveBeenCalled()
  })
})

describe('SubagentRow: running / failed / unfinished 态', () => {
  it('running 态渲染专属动效图标（subagent 在线脉冲，RunningBlockIcon）', () => {
    const wrapper = mount(SubagentRow, {
      props: { tool: makeSubagent({ status: 'running' }) },
    })
    expect(wrapper.find('[data-running-icon="subagent"]').exists()).toBe(true)
    // 不再有旧的同质 loader / 脉冲点 / reasoning 紫
    expect(wrapper.find('.animate-loader-spin').exists()).toBe(false)
    expect(wrapper.find('.animate-working-pulse').exists()).toBe(false)
    expect(wrapper.find('.bg-reasoning').exists()).toBe(false)
  })

  it('running 态无 progress 快照字段（detail 永远 undefined，异步 background）', () => {
    const wrapper = mount(SubagentRow, {
      props: { tool: makeSubagent({ status: 'running', detail: undefined }) },
    })
    const text = wrapper.text()
    // 不应渲染旧的进度字段
    expect(text).not.toContain('turn ')
    expect(text).not.toContain('tokens')
    // 专属动效图标仍在（RunningBlockIcon subagent 在线脉冲）
    expect(wrapper.find('[data-running-icon="subagent"]').exists()).toBe(true)
  })

  it('failed 态整行降 neutral-dim（不切 icon，颜色表达）', () => {
    const wrapper = mount(SubagentRow, {
      props: {
        tool: makeSubagent({
          status: 'error',
          input: { action: 'start', agent: 'researcher', task: 'failed task' },
        }),
      },
    })
    // 整行 header 中性灰（feat-chat-flow-dim：恒 dim 置灰）
    expect(wrapper.find('[data-testid="subagent-block"] > div').classes()).toContain('text-neutral-dim')
    // 仍展示 agent（不因 failed 隐藏）
    expect(wrapper.text()).toContain('researcher')
  })

  it('unfinished 态不渲染终态指示（终态 icon 已移除）', () => {
    const wrapper = mount(SubagentRow, {
      props: { tool: makeSubagent({ status: 'end_not_received' }) },
    })
    // 终态指示（Check/CircleDashed/未收到结果文字）已移除，unfinished 态不再显示额外文案
    expect(wrapper.text()).not.toContain('未收到结果')
    expect(wrapper.find('.trace-subagent').exists()).toBe(true)
  })

  it('根 div 是 trace-subagent（纯缩进无边框）', () => {
    const wrapper = mount(SubagentRow, {
      props: { tool: makeSubagent() },
    })
    const root = wrapper.find('.trace-subagent')
    expect(root.exists()).toBe(true)
    expect(root.classes()).not.toContain('border-b')
    expect(root.classes()).not.toContain('border-dashed')
    expect(root.classes()).not.toContain('border-danger')
    expect(root.classes()).not.toContain('bg-danger-soft')
  })
})

// ── [容器扩展点统一 §7.4 U9 层 2] 行内呈现两分支：details.__gui__ 存在 → 内层呈现替换为
//    插件树（GuiComponentRenderer 真渲染），点击仍归本行外壳（openSubagent 需要 virtualId，
//    树内传不出去——三问答案②）；无树 → 保留现有解析（宿主单行摘要）。──────────────

import { guiComponent, guiResult, PROTOCOL_VERSION } from '@zhushanwen/extension-protocol';

/** 构造合法 __gui__ 渲染载荷（版本协商字段必须与协议一致，extractGui 校验 v）。 */
function makeGuiDetails() {
  return {
    __gui__: guiResult(
      guiComponent('card', {
        header: 'research-trace-ui',
        body: [guiComponent('stats-line', { items: [{ label: 'status', value: 'running', severity: 'ok' }] })],
      }),
    ),
  }
}

describe('SubagentRow: 行内呈现两分支（§7.4 层 2 接树）', () => {
  it('有 __gui__ → 渲插件树（插件 card/stats-line 真渲染可见），宿主单行解析不渲染', () => {
    const wrapper = mount(SubagentRow, {
      props: { tool: makeSubagent({ details: makeGuiDetails() }), sessionId: 's1' },
    })
    // 用户可见断言：插件树内容在行内（card header = slug + stats-line 值）
    expect(wrapper.find('[data-testid="gui-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gui-stats-line"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('research-trace-ui')
    expect(wrapper.text()).toContain('running')
    // 宿主解析行不并存（内层呈现已替换为插件树）
    expect(wrapper.text()).not.toContain('researcher')
    expect(wrapper.text()).not.toContain('子代理')
  })

  it('有 __gui__ 时点击仍开抽屉（点击不交给插件树——virtualId 从树内传不出，外壳 @click 保留）', async () => {
    const wrapper = mount(SubagentRow, {
      props: {
        tool: makeSubagent({
          details: makeGuiDetails(),
          output: JSON.stringify({ action: 'start', subagentId: '1338dda5', slug: 'rs' }),
        }),
        sessionId: 's1',
      },
    })
    await wrapper.find('[data-testid="subagent-block"] > div').trigger('click')
    expect(openSubagentMock).toHaveBeenCalledTimes(1)
    expect(openSubagentMock).toHaveBeenCalledWith({
      virtualId: subagentVirtualId('s1', '1338dda5'),
    })
  })

  it('无 __gui__ → 保留现有解析（宿主单行摘要：agent/slug 在场，树节点不存在）', () => {
    const wrapper = mount(SubagentRow, {
      props: { tool: makeSubagent(), sessionId: 's1' },
    })
    expect(wrapper.find('[data-testid="gui-card"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('researcher')
    expect(wrapper.text()).toContain('research-trace-ui')
  })

  it('details.__gui__ 版本不符 → 不渲树（走无树分支，防过期协议组件上屏）', () => {
    const details = makeGuiDetails()
    ;(details.__gui__ as { v: number }).v = PROTOCOL_VERSION + 1
    const wrapper = mount(SubagentRow, {
      props: { tool: makeSubagent({ details }), sessionId: 's1' },
    })
    expect(wrapper.find('[data-testid="gui-card"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('researcher')
  })

  it('running 态 streaming detail.__gui__ 兜底：终态 details 无树时渲 streaming 树', () => {
    const wrapper = mount(SubagentRow, {
      props: {
        tool: makeSubagent({ status: 'running', detail: makeGuiDetails() }),
        sessionId: 's1',
      },
    })
    expect(wrapper.find('[data-testid="gui-card"]').exists()).toBe(true)
  })

  it('终态（非 running）无 details.__gui__ 时 streaming detail 残留不作为渲染源', () => {
    const wrapper = mount(SubagentRow, {
      props: {
        tool: makeSubagent({ status: 'completed', detail: makeGuiDetails() }),
        sessionId: 's1',
      },
    })
    expect(wrapper.find('[data-testid="gui-card"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('researcher')
  })
})

// ======================================================================
// ← features/composer/__tests__/ComposerInput.test.ts
// ======================================================================

describe('composer-input-chip-mousedown', () => {
/**
 * ComposerInput 徽章 mousedown 防光标 + × 原生按钮 单测（demo 方案 C 行为修复 2/3 组件层验证）。
 *
 * 契约：
 * - mousedown target 落在徽章（.slash-chip / .mention-chip；image-chip 挂在 mention-chip 上
 *   被同一选择器覆盖）内 → preventDefault（浏览器不把光标放进徽章边界，徽章行为原子化）
 * - mousedown 落在纯文本区 → 不拦截（正常光标放置）
 * - × 删除路径不受影响：preventDefault 只阻止光标放置，click 事件照常派发——真实
 *   insertSlashChip 插入的 chip 对 .chip-x 先 mousedown 后 click，chip 被删除且 input
 *   emit（removeChipNode → onChanged → onInput 链路）触发
 * - × 是原生 button[type=button]（demo chipHtml 同款，键盘可达），不另设 role 属性
 *
 * mock 策略：happy-dom 下经 dispatchEvent 派发冒泡 MouseEvent（vue-test-utils 的 trigger
 * 只能在被 find 的元素上派发，无法把 e.target 指到 chip 子元素）。deps 经 ComposerInputDeps
 * provide 注入（W4 契约）。
 *
 * 运行：cd packages/ui && npx vitest run src/__tests__/wave3/happy-dom-52-composerinput-dialog-request-queue-form-permission.test.ts（composer-input-chip-mousedown 节）
 */

const deps: ComposerInputDeps = {
  pasteImage: async (): Promise<HandleImagePasteResult> => ({ kind: 'text', text: '[测试环境]' }),
  renderIcon: () => false,
  t: (key: string) => key,
}

beforeEach(() => {
  // 清掉前一个用例残留的 selection range（指向已卸载节点会污染链路判定）
  window.getSelection()?.removeAllRanges()
})

function mountInput(): ReturnType<typeof mount> {
  return mount(ComposerInput, {
    global: { provide: { [ComposerInputDepsKey as symbol]: deps } },
  })
}

/** 在指定元素上派发冒泡 mousedown，返回该事件（断言 defaultPrevented 用） */
function dispatchMousedown(target: Element): MouseEvent {
  const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e
}

describe('ComposerInput 徽章 mousedown 防光标（demo onEdMouseDown 同款）', () => {
  /** mount 后经 innerHTML 构造静态 chip（无事件监听——本组只测 mousedown 拦截，不测删除） */
  function mountWithChipHtml(html: string): { editor: HTMLDivElement } {
    const wrapper = mountInput()
    const editor = wrapper.find('[role="textbox"]').element as HTMLDivElement
    editor.innerHTML = html
    return { editor }
  }

  it('mousedown 落在 slash-chip 内（chip-label 子树）→ preventDefault（不落光标）', () => {
    const { editor } = mountWithChipHtml(
      '<span class="slash-chip" data-chip-type="slash"><span class="chip-label">/commit</span></span>',
    )
    const chipLabel = editor.querySelector('.chip-label') as Element
    expect(dispatchMousedown(chipLabel).defaultPrevented).toBe(true)
  })

  it('mousedown 落在 mention-chip 本体 → preventDefault（image-chip 挂 mention-chip 同覆盖）', () => {
    const { editor } = mountWithChipHtml(
      '<span class="mention-chip mention-file image-chip" data-chip-type="image"><span class="chip-label">a.png</span></span>',
    )
    const chip = editor.querySelector('.image-chip') as Element
    expect(dispatchMousedown(chip).defaultPrevented).toBe(true)
  })

  it('mousedown 落在纯文本区（编辑器本体）→ 不拦截（正常光标放置）', () => {
    const { editor } = mountWithChipHtml('正文文本')
    expect(dispatchMousedown(editor).defaultPrevented).toBe(false)
  })
})

describe('ComposerInput × 删除路径与 mousedown 拦截共存（修复 2/3 联动）', () => {
  it('真实 insertSlashChip → × 为 button[type=button] 无 role → mousedown 被拦后 click 照常删除并 emit input', () => {
    const wrapper = mountInput()
    const vm = wrapper.vm as unknown as { insertSlashChip: (cmd: string) => void }
    vm.insertSlashChip('/commit')

    const editor = wrapper.find('[role="textbox"]').element as HTMLDivElement
    const chip = editor.querySelector('.slash-chip') as HTMLElement
    expect(chip).not.toBeNull()
    const x = chip.querySelector('.chip-x') as HTMLElement
    // 修复 3：原生 button 键盘可达（type=button 防表单提交语义），原生语义自带故不设 role
    expect(x.tagName).toBe('BUTTON')
    expect((x as HTMLButtonElement).type).toBe('button')
    expect(x.getAttribute('role')).toBeNull()

    // 修复 2 与删除路径共存：mousedown 被 handler 拦截（不落光标），随后 click 照常派发——
    // 真实浏览器序列中 preventDefault 只阻止光标放置，删除监听（dom-core makeXButton）独立生效
    expect(dispatchMousedown(x).defaultPrevented).toBe(true)
    // 插入阶段（insertSlashChip 末尾 onChanged）已产生过 input 事件，须以长度增量才能区分删除路径的新 emit
    const emittedCountBeforeClick = wrapper.emitted('input')?.length ?? 0
    x.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    expect(editor.querySelector('.slash-chip')).toBeNull()
    // removeChipNode → onChanged → onInput → emit('input')：draft 同步链路未断
    expect(wrapper.emitted('input')?.length ?? 0).toBe(emittedCountBeforeClick + 1)
  })
})
})

describe('composer-input-get-text', () => {
/**
 * ComposerInput.getText 单测 —— contenteditable 文本提取（换行保留 + chip 过滤）。
 *
 * 重点回归：Shift+Enter 产生的 <br> 必须提取为 \n，否则发送文本丢失软换行，
 * 用户气泡无法保留换行（whitespace-pre-wrap 容器内 <p>...</p> 里的 \n 不再可见）。
 *
 * mock 策略：happy-dom 支持 TreeWalker + createTreeWalker。直接 mount ui ComposerInput，
 * 设 [role="textbox"] 的 innerHTML 构造 contenteditable DOM，调 vm.getText() 断言。
 * deps（pasteImage/renderIcon/t）经 ComposerInputDeps provide 注入（W4 迁移：ui 包
 * 零 renderer import，deps 注入契约见 composer-input-deps.ts）。
 *
 * [W4 迁移] 自 renderer __tests__/panel/composer-input-get-text.test.ts 迁入 ui 包
 * features/composer/__tests__/（ComposerInput 组件新家）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/composer
 */

function provideDeps(wrapper: ReturnType<typeof mount>): void {
  // ui 包测试直接经 global.provide 注入（无需真实 IPC/i18n）
}

beforeEach(() => {
  vi.restoreAllMocks()
})

const deps: ComposerInputDeps = {
  pasteImage: async (): Promise<HandleImagePasteResult> => ({ kind: 'text', text: '[图片粘贴：需桌面环境]' }),
  renderIcon: () => false,
  t: (key: string) => key,
}

describe('ComposerInput.getText（换行保留 + chip × 过滤）', () => {
  /**
   * 构造 contenteditable 内容：直接写 innerHTML 到 [role="textbox"] div。
   * 返回该 div 的 element（调用方需要时可进一步断言 DOM 结构）。
   */
  function setup(html: string): ReturnType<typeof mount> {
    const wrapper = mount(ComposerInput, {
      global: { provide: { [ComposerInputDepsKey as symbol]: deps } },
    })
    const div = wrapper.find('[role="textbox"]')
    ;(div.element as HTMLDivElement).innerHTML = html
    return wrapper
  }

  /** expose 方法在 vm 上运行时可用，TS 类型需断言（defineExpose 不产生公开类型） */
  function getText(wrapper: ReturnType<typeof mount>): string {
    return (wrapper.vm as unknown as { getText: () => string }).getText()
  }

  it('纯文本：原样返回', () => {
    const wrapper = setup('hello world')
    expect(getText(wrapper)).toBe('hello world')
  })

  it('<br> 保留为 \\n（Shift+Enter 产生的换行不丢失）', () => {
    const wrapper = setup('line1<br>line2')
    expect(getText(wrapper)).toBe('line1\nline2')
  })

  it('多个 <br> 保留多个 \\n', () => {
    const wrapper = setup('a<br><br>b')
    expect(getText(wrapper)).toBe('a\n\nb')
  })

  it('末尾 <br> 保留（用户敲 Shift+Enter 后未输文字，发送时换行应可见）', () => {
    const wrapper = setup('text<br>')
    expect(getText(wrapper)).toBe('text\n')
  })

  it('slash-chip 读入（命令段归位为发送文本前缀，D4-b/D4-c）', () => {
    // 命令 chip 产 slash 段（name 走 dataset.chipName），getText 经 segmentsToText 归位
    // 提首——产物以 /goal 开头，与发送时 composer 扁平化一致
    const wrapper = setup('<span class="slash-chip" data-chip-type="slash" data-chip-name="goal"><span class="chip-label">/goal</span></span> do something')
    expect(getText(wrapper)).toBe('/goal do something')
  })

  it('chip × 按钮文本不混入发送内容', () => {
    // × 按钮在 chip 内，其 "×" 文本必须被 TreeWalker 跳过
    const wrapper = setup('<span class="slash-chip" data-chip-type="slash" data-chip-name="goal"><span class="chip-label">/goal</span><span class="chip-x">×</span></span>')
    expect(getText(wrapper)).toBe('/goal')
  })

  it('chip + 后续 <br> 换行：命令名 + 软换行 + 后续文本（slash→text 边界空格规则，偏差 #4）', () => {
    const wrapper = setup('<span class="slash-chip" data-chip-type="slash" data-chip-name="goal"><span class="chip-label">/goal</span><span class="chip-x">×</span></span><br>详细描述')
    // 归位后 slash 段在前，紧跟的 text 段以 \n 开头不属「自带前导空格」→ needsBoundarySpace 补一格
    expect(getText(wrapper)).toBe('/goal \n详细描述')
  })

  it('nbsp 转普通空格，零宽空格过滤', () => {
    // chip 后插的零宽空格（\u200B）作光标锚点，发送时必须过滤
    // nbsp（\u00A0）转普通空格，与 textarea 行为对齐
    const wrapper = setup('a\u00A0b\u200Bc')
    expect(getText(wrapper)).toBe('a bc')
  })
})
})

describe('composer-input-trigger-forward', () => {
/**
 * ComposerInput 四符号触发转发层单测（composer-symbol-system 四符号换绑，PR #191）。
 *
 * 组件层契约（转发映射 + bash 豁免短路 D6）：
 * - dom-core onFileTrigger 回调绑 # 检测 → 转发 emit 'session-trigger'（# session 语义）
 * - dom-core onDollarFileTrigger 绑 $ 检测 → 转发 emit 'file-trigger'（浮层链路复用，只换符号）
 * - dom-core onSubagentTrigger 绑 @ 检测 → 转发 emit 'subagent-trigger'
 * - suppressTriggers=true（bash 态 !/!! 前缀）→ 四路 trigger 统一发 null（关闭浮层语义），
 *   draft 同步（input emit）与 DOM 内容不受影响
 *
 * mock 策略：happy-dom 支持 Selection.addRange 定位光标（触发检测依赖光标位置）。
 * 设 textContent → focus → Range collapse 到 offset → trigger('input')。
 * deps（pasteImage/renderIcon/t）经 ComposerInputDeps provide 注入（W4 迁移契约）。
 * renderer 侧同名场景测试（composer-hash-trigger.test.ts）在 renderer 包跑 coverage，
 * 本文件落 ui 包内，补 ui 包对 ComposerInput.vue 的行覆盖。
 *
 * 运行：cd packages/ui && npx vitest run src/__tests__/wave3/happy-dom-52-composerinput-dialog-request-queue-form-permission.test.ts（composer-input-trigger-forward 节）
 */

const deps: ComposerInputDeps = {
  pasteImage: async (): Promise<HandleImagePasteResult> => ({ kind: 'text', text: '[测试环境]' }),
  renderIcon: () => false,
  t: (key: string) => key,
}

beforeEach(() => {
  // 清掉前一个用例残留的 selection range（指向已卸载节点会污染检测前置判定）
  window.getSelection()?.removeAllRanges()
})

function mountInput(extraProps: Record<string, unknown> = {}): ReturnType<typeof mount> {
  return mount(ComposerInput, {
    props: extraProps,
    global: { provide: { [ComposerInputDepsKey as symbol]: deps } },
  })
}

/**
 * 在 contenteditable div 内键入文本并把光标定位到 offset（触发检测读光标前文本）。
 * @param cursorOffset 光标在文本中的字符偏移，默认文本末尾（真实输入路径）
 */
async function typeWithCursor(
  wrapper: ReturnType<typeof mount>,
  text: string,
  cursorOffset = text.length,
): Promise<void> {
  const div = wrapper.find('[role="textbox"]')
  const el = div.element as HTMLDivElement
  el.textContent = text
  el.focus()
  const sel = window.getSelection()
  if (sel && el.firstChild) {
    const range = document.createRange()
    range.setStart(el.firstChild, Math.min(cursorOffset, text.length))
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  await div.trigger('input')
}

/** 最后一次某事件的 payload（无事件返回 undefined） */
function lastEmit(wrapper: ReturnType<typeof mount>, event: string): unknown {
  const emitted = wrapper.emitted(event)
  return emitted?.at(-1)?.[0]
}

describe('ComposerInput 四符号触发转发（suppressTriggers=false 默认）', () => {
  it('T1 # → emit session-trigger {query}（dom-core onFileTrigger 换绑转发，非 file-trigger 命中）', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '查 #auth', 7)
    expect(lastEmit(wrapper, 'session-trigger')).toEqual({ query: 'auth' })
    // 同轮 $ 检测不命中 → file-trigger 发 null（# 与 $ 路由互斥）
    expect(lastEmit(wrapper, 'file-trigger')).toBeNull()
  })

  it('T2 $ → emit file-trigger {query}（$ 文件语义，emit 名保留 file-trigger）', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '读 $src/to', 10)
    expect(lastEmit(wrapper, 'file-trigger')).toEqual({ query: 'src/to' })
    // # 检测同轮不命中
    expect(lastEmit(wrapper, 'session-trigger')).toBeNull()
  })

  it('T3 @ → emit subagent-trigger {query}（四符号新增）', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '@build', 6)
    expect(lastEmit(wrapper, 'subagent-trigger')).toEqual({ query: 'build' })
    expect(lastEmit(wrapper, 'file-trigger')).toBeNull()
    expect(lastEmit(wrapper, 'session-trigger')).toBeNull()
  })

  it('T4 符号后空格 → 对应 trigger 发 null（终止语义，浮层关闭）', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '#auth ', 6)
    expect(lastEmit(wrapper, 'session-trigger')).toBeNull()
    await typeWithCursor(wrapper, '$auth ', 6)
    expect(lastEmit(wrapper, 'file-trigger')).toBeNull()
    await typeWithCursor(wrapper, '@build ', 7)
    expect(lastEmit(wrapper, 'subagent-trigger')).toBeNull()
  })
})

describe('ComposerInput bash 豁免短路（D6：suppressTriggers=true）', () => {
  it('B1 bash 态输入 !echo $HOME → 三路 trigger 全 null（不出现非 null payload）', async () => {
    const wrapper = mountInput({ suppressTriggers: true })
    // 「!echo $HOME」：$ 前有空格，若未短路会命中 file-trigger {query:'HOME'}
    await typeWithCursor(wrapper, '!echo $HOME', 11)
    for (const event of ['session-trigger', 'file-trigger', 'subagent-trigger', 'slash-trigger']) {
      const emitted = wrapper.emitted(event)
      // 短路 = 检测回调统一发 null（关闭浮层语义）；未发或全 null 均可，绝不非 null
      expect(emitted?.every((args) => args[0] === null) ?? true).toBe(true)
    }
  })

  it('B2 bash 态 draft 同步不受影响：input emit 照常携带全文 + DOM 文本保留', async () => {
    const wrapper = mountInput({ suppressTriggers: true })
    await typeWithCursor(wrapper, '!echo $HOME', 11)
    expect(lastEmit(wrapper, 'input')).toBe('!echo $HOME')
    expect((wrapper.find('[role="textbox"]').element as HTMLDivElement).textContent).toBe('!echo $HOME')
  })

  it('B3 对照：suppressTriggers=false 时同输入 $ 照常触发 file-trigger（短路仅 bash 态生效）', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '!echo $HOME', 11)
    expect(lastEmit(wrapper, 'file-trigger')).toEqual({ query: 'HOME' })
  })

  it('B4 bash 态 # / @ 同样被短路（一致豁免：# 是注释、@ 是语法成分）', async () => {
    const wrapper = mountInput({ suppressTriggers: true })
    await typeWithCursor(wrapper, '!cmd #tag', 9)
    expect(lastEmit(wrapper, 'session-trigger')).toBeNull()
    await typeWithCursor(wrapper, '!run @arg', 9)
    expect(lastEmit(wrapper, 'subagent-trigger')).toBeNull()
  })
})
})

// ======================================================================
// ← lib/__tests__/segment-rebuild.test.ts
// ======================================================================

/** live content = DOM 序（命令 chip 就地插在草稿中部，D4-a），非归位序 */
const LIVE: Segment[] = [
  { type: 'text', text: '总结' },
  { type: 'slash', name: 'compact' },
]

const count = (text: string, needle: string) => text.split(needle).length - 1

/** image 段：序列化单元是 `\n<path>\n`（裸路径独占一行） */
const IMG: Segment = {
  type: 'image',
  id: 'img-a',
  path: '/data/a/1.png',
  fileName: '1.png',
  displayName: '截图.png',
}
/** 复刻真实提交链路：编辑框回填 normalizeContent(live)，submitEdit 提交前对草稿 .trim() */
const submittedDraft = (live: Segment[]) => normalizeContent(live).trim()

describe('rebuildSegmentsWithEditedText：slash 段不参与 text 替换（MF-2）', () => {
  it('草稿原样提交 → slash 段保留、前缀命令剥离，prompt 命令仅一次', () => {
    const segments = rebuildSegmentsWithEditedText(LIVE, '/compact 总结')
    // 段序沿用原段序（归位由 segmentsToText/展示侧统一做，本函数不重排）
    expect(segments).toEqual([
      { type: 'text', text: '总结' },
      { type: 'slash', name: 'compact' },
    ])
    const prompt = segmentsToPrompt(segments)
    expect(prompt).toBe('/compact 总结')
    expect(count(prompt, '/compact')).toBe(1)
  })

  it('用户只改正文 → 命令仍只出现一次且正文更新', () => {
    const prompt = segmentsToPrompt(rebuildSegmentsWithEditedText(LIVE, '/compact 总结一下'))
    expect(prompt).toBe('/compact 总结一下')
    expect(count(prompt, '/compact')).toBe(1)
  })

  it('命令-only 消息（landing `/tasks`）原样提交 → prompt `/tasks`（不翻倍、不失命令）', () => {
    const only: Segment[] = [{ type: 'slash', name: 'tasks' }]
    expect(rebuildSegmentsWithEditedText(only, '/tasks')).toEqual([{ type: 'slash', name: 'tasks' }])
    expect(segmentsToPrompt(rebuildSegmentsWithEditedText(only, '/tasks'))).toBe('/tasks')
  })

  it('用户改命令名（/compact → /goal）→ 丢弃 slash 段，prompt 只含新命令', () => {
    const segments = rebuildSegmentsWithEditedText(LIVE, '/goal 总结')
    expect(segments).toEqual([{ type: 'text', text: '/goal 总结' }])
    expect(segmentsToPrompt(segments)).toBe('/goal 总结')
    expect(count(segmentsToPrompt(segments), '/compact')).toBe(0)
  })

  it('用户删掉命令只留正文 → 丢弃 slash 段，命令不再执行', () => {
    const segments = rebuildSegmentsWithEditedText(LIVE, '总结')
    expect(segments).toEqual([{ type: 'text', text: '总结' }])
    expect(segmentsToPrompt(segments)).toBe('总结')
  })

  it('token 边界：`/compactfoo` 不被当作 `/compact` 命令（不剥离、不误判）', () => {
    const segments = rebuildSegmentsWithEditedText(LIVE, '/compactfoo 总结')
    expect(segments).toEqual([{ type: 'text', text: '/compactfoo 总结' }])
    expect(segmentsToPrompt(segments)).toBe('/compactfoo 总结')
  })

  it('多个 slash 段：逐个剥离前缀命令后全部保留（prompt 各出现一次）', () => {
    const many: Segment[] = [
      { type: 'text', text: 'a' },
      { type: 'slash', name: 'compact' },
      { type: 'text', text: 'b' },
      { type: 'slash', name: 'fork' },
      { type: 'text', text: 'c' },
    ]
    const prompt = segmentsToPrompt(rebuildSegmentsWithEditedText(many, '/compact /fork abc'))
    expect(prompt).toBe('/compact /fork abc')
    expect(count(prompt, '/compact')).toBe(1)
    expect(count(prompt, '/fork')).toBe(1)
  })

  it('无 slash 段（纯文本消息）回归：首个 text 段替换、序列化仍在编辑稿中的段原位保留', () => {
    expect(rebuildSegmentsWithEditedText([{ type: 'text', text: '原文' }], '新文')).toEqual([
      { type: 'text', text: '新文' },
    ])
    const withFile: Segment[] = [
      { type: 'file', path: 'src/a.ts' },
      { type: 'text', text: '看看' },
    ]
    // 编辑稿保留 file 的序列化文本（正常「只改正文」路径）→ 段原位保留、文本剥离
    expect(rebuildSegmentsWithEditedText(withFile, 'src/a.ts 看看这个')).toEqual([
      { type: 'file', path: 'src/a.ts' },
      { type: 'text', text: ' 看看这个' },
    ])
    // 编辑稿已无该 file 序列化文本（用户删掉引用）→ 段丢弃，不「复活」回 prompt
    expect(rebuildSegmentsWithEditedText(withFile, '看看这个')).toEqual([
      { type: 'text', text: '看看这个' },
    ])
  })

  it('纯字符串输入（旧接口兼容）：产出单个 text 段', () => {
    expect(rebuildSegmentsWithEditedText('历史纯文本', '新文')).toEqual([{ type: 'text', text: '新文' }])
  })

  it('三视角补充：重建产物经 segmentsToText（展示序列化）与 segmentsToPrompt 同文本', () => {
    const segments = rebuildSegmentsWithEditedText(LIVE, '/compact 总结')
    expect(segmentsToText(segments)).toBe('/compact 总结')
    expect(segmentsToText(segments)).toBe(segmentsToPrompt(segments))
  })
})

// ── [轮 3 收尾] 非 text 段序列化不翻倍（skill 为主用例）──
// 链路：live content → normalizeContent（编辑草稿）→ 用户只改正文 → rebuild → segmentsToPrompt。
// 修复前：草稿整串回灌首个 text 段 + 段原位保留 ⇒ 序列化后同一形态出现两次（skill 标记两遍
// ⇒ runtime 注入器展开两遍，同一 SKILL.md 注入两次）。修复后：标记只出现一次。
describe('[轮 3] 编辑重发 skill 段标记不翻倍', () => {
  const SKILL_SEG = { type: 'skill', name: 'review', location: '/skills/review/SKILL.md' } as const
  const MARKER = buildSkillMarker(SKILL_SEG.name, SKILL_SEG.location)

  it('skill 在段首（正文在后）：只改正文 → 标记仅一次且段保留', () => {
    const live: Segment[] = [SKILL_SEG, { type: 'text', text: '正文' }]
    const draft = normalizeContent(live)
    expect(draft).toBe(`${MARKER} 正文`)
    const segments = rebuildSegmentsWithEditedText(live, `${MARKER} 新正文`)
    expect(segments).toEqual([SKILL_SEG, { type: 'text', text: ' 新正文' }])
    const prompt = segmentsToPrompt(segments)
    expect(count(prompt, '<taiji-skill')).toBe(1)
    expect(prompt).toBe(`${MARKER} 新正文`)
  })

  it('skill 在正文之后（非段首，D4-a 光标处插入的主用例）：只改正文 → 标记仅一次', () => {
    const live: Segment[] = [{ type: 'text', text: '正文' }, SKILL_SEG]
    const draft = normalizeContent(live)
    expect(draft).toBe(`正文${MARKER}`)
    const prompt = segmentsToPrompt(rebuildSegmentsWithEditedText(live, `新正文${MARKER}`))
    expect(count(prompt, '<taiji-skill')).toBe(1)
    expect(prompt).toBe(`新正文${MARKER}`)
  })

  it('两个 skill 段混排：只改正文 → 每个标记各出现一次（不翻倍）', () => {
    const second = { type: 'skill', name: 'simplify', location: '/skills/simplify/SKILL.md' } as const
    const live: Segment[] = [{ type: 'text', text: '正文' }, SKILL_SEG, second]
    const draft = normalizeContent(live)
    const prompt = segmentsToPrompt(rebuildSegmentsWithEditedText(live, draft.replace('正文', '新正文')))
    expect(count(prompt, '<taiji-skill')).toBe(2)
    expect(count(prompt, 'name="review"')).toBe(1)
    expect(count(prompt, 'name="simplify"')).toBe(1)
  })

  it('用户改写 skill 名 → 丢弃旧段，prompt 只含改写后的标记（旧名不残留）', () => {
    const live: Segment[] = [SKILL_SEG, { type: 'text', text: '正文' }]
    const edited = `${buildSkillMarker('goal', SKILL_SEG.location)} 正文`
    const prompt = segmentsToPrompt(rebuildSegmentsWithEditedText(live, edited))
    expect(count(prompt, 'name="review"')).toBe(0)
    expect(count(prompt, 'name="goal"')).toBe(1)
  })

  it('用户删除标记只留正文 → 丢弃 skill 段，prompt 不再注入该 skill', () => {
    const live: Segment[] = [SKILL_SEG, { type: 'text', text: '正文' }]
    const segments = rebuildSegmentsWithEditedText(live, '正文')
    expect(segments).toEqual([{ type: 'text', text: '正文' }])
    expect(count(segmentsToPrompt(segments), '<taiji-skill')).toBe(0)
  })
})

describe('[轮 3] 编辑重发 file/mention/session/handoff 序列化不翻倍', () => {
  const CHIPS: Array<{ label: string; seg: Segment; needle: string }> = [
    { label: 'file', seg: { type: 'file', path: 'src/a.ts', lineRange: [3, 5] }, needle: 'src/a.ts:L3-L5' },
    { label: 'mention', seg: { type: 'mention', name: 'alice' }, needle: '@alice' },
    { label: 'session', seg: { type: 'session', sessionId: 'abc-123', label: '会话A' }, needle: '#abc-123' },
    { label: 'handoff', seg: { type: 'handoff', sourceLabel: 'src-session' }, needle: '[handoff from src-session]' },
  ]

  for (const { label, seg, needle } of CHIPS) {
    it(`${label}：只改正文 → 序列化文本仅一次且段保留`, () => {
      const live: Segment[] = [seg, { type: 'text', text: '正文' }]
      const draft = normalizeContent(live)
      expect(count(draft, needle)).toBe(1)
      const segments = rebuildSegmentsWithEditedText(live, draft.replace('正文', '新正文'))
      expect(segments).toContainEqual(seg)
      expect(count(segmentsToPrompt(segments), needle)).toBe(1)
    })

    it(`${label}：删除该段序列化文本 → 段丢弃（以文本形态进入，不复活）`, () => {
      const live: Segment[] = [seg, { type: 'text', text: '正文' }]
      const segments = rebuildSegmentsWithEditedText(live, '正文')
      expect(segments).toEqual([{ type: 'text', text: '正文' }])
      expect(count(segmentsToPrompt(segments), needle)).toBe(0)
    })
  }

  it('token 边界（mention）：`@alice` 不误配 `@alicex` 前缀 → 段丢弃、文本保留', () => {
    const live: Segment[] = [{ type: 'mention', name: 'alice' }, { type: 'text', text: '正文' }]
    const segments = rebuildSegmentsWithEditedText(live, '@alicex 正文')
    expect(segments).toEqual([{ type: 'text', text: '@alicex 正文' }])
  })

  it('subagent 段（序列化为空串）恒保留，无文本足迹 ⇒ 不翻倍', () => {
    const live: Segment[] = [
      { type: 'subagent', subagentId: 's1', slug: 'oracle' },
      { type: 'text', text: '正文' },
    ]
    const draft = normalizeContent(live)
    expect(draft).toBe(' 正文')
    const segments = rebuildSegmentsWithEditedText(live, draft)
    expect(segments).toContainEqual({ type: 'subagent', subagentId: 's1', slug: 'oracle' })
    expect(count(segmentsToPrompt(segments), 'oracle')).toBe(0)
  })
})

// ── image 段：裸路径 token 双侧边界剥离（编辑重发不翻倍 / 删路径不复活）──
// 背景：image 段序列化为 `\n<path>\n`，但 UserBubble.submitEdit 提交前对草稿 `.trim()`
// （UserBubble.vue:258）会吃掉首尾换行，按序列化串精确匹配在真实链路不可靠。
// 修复前 image 段恒保留、不参与剥离，两个已登记缺陷：
//   ① 编辑稿里路径随序列化再出现一次 ⇒ 同一路径在 prompt 中出现两次；
//   ② 用户把编辑稿里的路径删掉后重发，旧路径仍随段「复活」。
// 修复后：命中（前边界 = 串首/空白 且 后边界 = 串尾/空白）⇒ 剥离路径、段保留（消 ①）；
// 未命中 ⇒ 用户删掉/改写了路径，丢弃段（消 ②）。前边界必须判，否则 `x/data/a/1.png`
// 这类正文里的相对路径片段会被当图片路径剥掉。
// 剥离范围含 token 两侧紧邻换行（即整个 `\n<path>\n` 序列化单元），换行累积的幂等用例
// 见下方 `[轮 3-5]` describe。
describe('[image] 裸路径 token 剥离：编辑重发不翻倍 / 删路径不复活', () => {
  it('① 路径保留（只改正文）→ 编辑重发产物中该路径只出现一次（修复前为两次）', () => {
    const live: Segment[] = [IMG, { type: 'text', text: '正文' }]
    const edited = submittedDraft(live).replace('正文', '新正文')
    const segments = rebuildSegmentsWithEditedText(live, edited)
    expect(segments).toContainEqual(IMG)
    expect(count(segmentsToPrompt(segments), IMG.path)).toBe(1)
  })

  it('② 路径被删（只留正文）→ 段丢弃，产物中不再出现该路径（修复前仍出现）', () => {
    const live: Segment[] = [IMG, { type: 'text', text: '正文' }]
    const segments = rebuildSegmentsWithEditedText(live, '正文')
    expect(segments.some((s) => s.type === 'image')).toBe(false)
    expect(count(segmentsToPrompt(segments), IMG.path)).toBe(0)
  })

  it('③ 路径被改写（/data/a/1.png → /data/b/2.png）→ 新路径以文本形态保留，旧 image 段丢弃', () => {
    const live: Segment[] = [IMG, { type: 'text', text: '正文' }]
    const segments = rebuildSegmentsWithEditedText(live, '/data/b/2.png\n正文')
    expect(segments.some((s) => s.type === 'image')).toBe(false)
    const prompt = segmentsToPrompt(segments)
    expect(count(prompt, '/data/b/2.png')).toBe(1)
    expect(count(prompt, IMG.path)).toBe(0)
  })

  it('④a 后边界检查：正文 `/data/a/1.png2` 不误剥（路径后紧贴数字，属正文）', () => {
    const live: Segment[] = [IMG, { type: 'text', text: '正文' }]
    const edited = '/data/a/1.png2\n正文'
    const segments = rebuildSegmentsWithEditedText(live, edited)
    // 未命中 ⇒ 段丢弃；正文逐字保留（路径片段未被当图片路径剥掉）
    expect(segments.some((s) => s.type === 'image')).toBe(false)
    expect(segmentsToPrompt(segments)).toBe(edited)
  })

  it('④b 前边界检查：正文 `x/data/a/1.png` 不误剥（路径前有字符，属相对路径片段）', () => {
    const live: Segment[] = [IMG, { type: 'text', text: '正文' }]
    const edited = 'x/data/a/1.png\n正文'
    const segments = rebuildSegmentsWithEditedText(live, edited)
    expect(segments.some((s) => s.type === 'image')).toBe(false)
    expect(segmentsToPrompt(segments)).toBe(edited)
  })

  it('正文含同形路径（游标保护）：正文那份不被删，chip 那份剥离且段保留', () => {
    const live: Segment[] = [{ type: 'text', text: `看看 ${IMG.path} 吧` }, IMG]
    const segments = rebuildSegmentsWithEditedText(live, submittedDraft(live))
    const body = segments[0] as { type: 'text'; text: string }
    expect(body.text.startsWith(`看看 ${IMG.path} 吧`)).toBe(true)
    expect(count(body.text, IMG.path)).toBe(1)
    expect(segments).toContainEqual(IMG)
  })
})

// ── [轮 3-5] image 段剥离整个序列化单元（`\n<path>\n`）：未编辑草稿重发恒幂等 ──
// 根因（上一轮残余）：image 分支只剥裸路径 token（`text.slice(0, at) + text.slice(at + path.length)`），
// 而 image 的序列化单元是 `\n<path>\n`——草稿里 path 前后的换行留在 text 段内，重建后 image 段
// 又补一遍 padding ⇒ 每轮编辑重发净增换行、无界累积（实测 5 轮：草稿 2 个换行 → 每轮 +2）。
// 修复：命中裸路径后把删除范围向左右各扩一个紧邻换行（存在则吃、不存在则不吃），恰好抵消
// 序列化自带的 padding。生产链路（submitEdit 的 .trim() 吃掉首尾换行）同样幂等：被 trim 的
// 那个换行不得在重建时被累积回来。
describe('[轮 3-5] image 段剥离整个序列化单元（`\\n<path>\\n`）', () => {
  it('image 居首 + 正文：未编辑草稿连发 5 轮，每轮 prompt 与草稿逐字相同（修复前每轮净增换行）', () => {
    const live: Segment[] = [IMG, { type: 'text', text: '正文' }]
    const draft = normalizeContent(live)
    expect(draft).toBe('\n/data/a/1.png\n正文')
    let segments = live
    for (let round = 0; round < 5; round++) {
      segments = rebuildSegmentsWithEditedText(segments, normalizeContent(segments))
      expect(segmentsToPrompt(segments)).toBe(draft)
    }
  })

  it('正文 + image 居末：未编辑草稿连发 3 轮，每轮 prompt 与草稿逐字相同（修复前每轮净增换行）', () => {
    const live: Segment[] = [{ type: 'text', text: '正文' }, IMG]
    const draft = normalizeContent(live)
    expect(draft).toBe('正文\n/data/a/1.png\n')
    let segments = live
    for (let round = 0; round < 3; round++) {
      segments = rebuildSegmentsWithEditedText(segments, normalizeContent(segments))
      expect(segmentsToPrompt(segments)).toBe(draft)
    }
  })

  it('生产链路形态（submitEdit 的 .trim() 吃掉首尾换行）→ prompt === 未 trim 的草稿、路径仅一次', () => {
    const live: Segment[] = [IMG, { type: 'text', text: '正文' }]
    const draft = normalizeContent(live) // '\n/data/a/1.png\n正文'
    const edited = submittedDraft(live) // '/data/a/1.png\n正文'
    expect(edited).toBe('/data/a/1.png\n正文')
    const prompt = segmentsToPrompt(rebuildSegmentsWithEditedText(live, edited))
    expect(prompt).toBe(draft)
    expect(count(prompt, IMG.path)).toBe(1)
    expect(prompt.endsWith('\n\n正文')).toBe(false)
  })

  it('image 居中（[text A, image, text B]）：round0 位置近似（D6 已接受），round1 === round2 不累积', () => {
    // 「round0 ≠ 草稿」是既有「首个 text 段承接全部正文、chip 位置不动」模型的位置近似，
    // 与本轮换行修复无关（D6 已登记为接受项），故不并入上方幂等不变量 CASES。
    // 本用例只锁「不再累积」：round1 起收敛，round1 === round2。
    const live: Segment[] = [{ type: 'text', text: 'A' }, IMG, { type: 'text', text: 'B' }]
    const round1 = rebuildSegmentsWithEditedText(live, normalizeContent(live))
    const round2 = rebuildSegmentsWithEditedText(round1, normalizeContent(round1))
    expect(segmentsToPrompt(round2)).toBe(segmentsToPrompt(round1))
    expect(count(segmentsToPrompt(round1), IMG.path)).toBe(1)
    expect(segmentsToPrompt(round1)).toBe(`AB\n${IMG.path}\n`)
  })
})

// ── [轮 3 第 4 轮 · RC-A-2] 剥离按段序推进游标：正文里的同形字符串不得被当 chip 序列化文本 ──
// 回归形态：`findDelimitedOccurrence(text, serialized, 0)` 恒从 0 找首个合法出现，无法区分
// 「用户正文里的同形字符串」与「chip 序列化文本」。正文的同形串出现在 chip 之前时，
// 被删的是正文那份、chip 那份留在原位 ⇒ 正文损坏且 token 仍出现两次。
// 修复依据：编辑前草稿文本就是 segmentsToText(source)，各段序列化形态的出现顺序与段序一致。
describe('[轮 3-4 · RC-A-2] 正文含 chip 同形文本：正文不被删、段仍保留', () => {
  it('file：正文在前含同形路径 → 正文逐字保留，路径在正文中计数为 1', () => {
    const live: Segment[] = [{ type: 'text', text: '看看 src/a.ts 吧' }, { type: 'file', path: 'src/a.ts' }]
    const draft = normalizeContent(live)
    expect(draft).toBe('看看 src/a.ts 吧src/a.ts')
    const segments = rebuildSegmentsWithEditedText(live, draft)
    // 正文段原样（修复前被删成 `看看  吧src/a.ts`）
    expect(segments[0]).toEqual({ type: 'text', text: '看看 src/a.ts 吧' })
    expect(segments).toContainEqual({ type: 'file', path: 'src/a.ts' })
    // 正文里的同形 token 计数为 1（未被删、也未多出）
    expect(count((segments[0] as { type: 'text'; text: string }).text, 'src/a.ts')).toBe(1)
    // 未编辑草稿重发 ⇒ prompt 与草稿逐字相同
    expect(segmentsToPrompt(segments)).toBe(draft)
  })

  it('mention：正文在前含同形 @name → 正文逐字保留，@name 在正文中计数为 1', () => {
    const live: Segment[] = [{ type: 'text', text: '@alice 你好' }, { type: 'mention', name: 'alice' }]
    const draft = normalizeContent(live)
    expect(draft).toBe('@alice 你好@alice')
    const segments = rebuildSegmentsWithEditedText(live, draft)
    // 修复前正文被删成 ` 你好@alice`（用户的 @alice 消失）
    expect(segments[0]).toEqual({ type: 'text', text: '@alice 你好' })
    expect(segments).toContainEqual({ type: 'mention', name: 'alice' })
    expect(count((segments[0] as { type: 'text'; text: string }).text, '@alice')).toBe(1)
    expect(segmentsToPrompt(segments)).toBe(draft)
  })

  it('同形串在正文中出现两次（正文 2 + chip 1）→ 两处都保留，stripped 只命中 chip 那次', () => {
    const live: Segment[] = [
      { type: 'text', text: 'a.ts 与 a.ts 都看看' },
      { type: 'file', path: 'a.ts' },
    ]
    const draft = normalizeContent(live)
    const segments = rebuildSegmentsWithEditedText(live, draft)
    expect(segments[0]).toEqual({ type: 'text', text: 'a.ts 与 a.ts 都看看' })
    expect(count((segments[0] as { type: 'text'; text: string }).text, 'a.ts')).toBe(2)
    expect(segmentsToPrompt(segments)).toBe(draft)
  })

  it('正文已被改写（原文找不到）时不推进游标：chip 仍按合法出现剥离，不误删新正文', () => {
    const live: Segment[] = [{ type: 'text', text: '原文' }, { type: 'file', path: 'src/a.ts' }]
    const segments = rebuildSegmentsWithEditedText(live, '新正文src/a.ts')
    expect(segments).toEqual([{ type: 'text', text: '新正文' }, { type: 'file', path: 'src/a.ts' }])
  })
})

// ── [轮 3 第 4 轮 · RC-A-6] 剥离后残留的纯空白文本不得物化成段 ──
// `if (text && !textPlaced)` 只判真值、空白串为真值：剥离后若剩余文本只剩空白（典型：
// 两段 chip 之间的分隔空格），会被物化为 text 段并 unshift 到段首，prompt 以空格开头。
describe('[轮 3-4 · RC-A-6] 剥离后只剩空白 → 不物化 text 段（prompt 不以空格开头）', () => {
  it('两个 chip 相邻（中间只有边界空格）→ 无 text 段、prompt 与草稿逐字相同', () => {
    const live: Segment[] = [{ type: 'file', path: 'a.ts' }, { type: 'file', path: 'b.ts' }]
    const draft = normalizeContent(live)
    expect(draft).toBe('a.ts b.ts')
    const segments = rebuildSegmentsWithEditedText(live, draft)
    // 修复前产出 [{text:' '}, file, file] ⇒ prompt ` a.ts b.ts`（首字符空格）
    expect(segments.some((s) => s.type === 'text')).toBe(false)
    expect(segments).toEqual(live)
    expect(segmentsToPrompt(segments)).toBe(draft)
  })

  it('三个 chip 相邻 → 同样不残留空白段', () => {
    const live: Segment[] = [
      { type: 'mention', name: 'alice' },
      { type: 'session', sessionId: 'abc-123', label: '会话A' },
      { type: 'handoff', sourceLabel: 'src-session' },
    ]
    const draft = normalizeContent(live)
    const segments = rebuildSegmentsWithEditedText(live, draft)
    expect(segments.some((s) => s.type === 'text')).toBe(false)
    expect(segmentsToPrompt(segments)).toBe(draft)
  })

  it('正文全为空白（用户清空正文只留 chip）→ 不留空白段', () => {
    const live: Segment[] = [{ type: 'file', path: 'a.ts' }, { type: 'text', text: '正文' }]
    const segments = rebuildSegmentsWithEditedText(live, 'a.ts   ')
    expect(segments).toEqual([{ type: 'file', path: 'a.ts' }])
    expect(segmentsToPrompt(segments)).toBe('a.ts')
  })
})

// ── [轮 3-4] 未编辑草稿的不变量：rebuild(source, segmentsToText(source)) 序列化后逐字不变 ──
// 这条不变量同时覆盖 RC-A-2（同形串被误删会改变正文）与 RC-A-6（残留空白段会加出前导空格）。
// 边界：chip 夹在两段 text 之间时刻意不收（如 `[text('看看'), session, text('的讨论')]`、
// `[text('A'), image, text('B')]`）——「首个 text 段替换 + 其余 text 段丢弃」模型会把尾段
// 正文并入首段、chip 位置不动，序列化后尾段正文移到 chip 之前（`看看 的讨论#sid-1`）。
// 这是既有位置近似（D6 已登记），与本轮修复无关；image 居中那例的「不再累积」收敛断言
// 单列在 `[轮 3-5]` describe（round1 === round2）。
// image 居首 / 居末两种排布已纳入 CASES——此前 CASES 全部 8 例恰好都不含 image，
// 使「未编辑草稿重发 ⇒ prompt 与草稿逐字相同」这条不变量对 image 静默失效
// （换行累积缺陷因此逃过不变量，只在手工探针里暴露）。
describe('[轮 3-4] 未编辑草稿重发 ⇒ prompt 与草稿逐字相同（幂等不变量）', () => {
  const CASES: Array<{ label: string; live: Segment[] }> = [
    { label: 'text + slash（命令归位）', live: [{ type: 'text', text: '总结' }, { type: 'slash', name: 'compact' }] },
    { label: 'slash + text（命令在首）', live: [{ type: 'slash', name: 'compact' }, { type: 'text', text: '清理一下' }] },
    { label: '正文含同形路径 + file', live: [{ type: 'text', text: '看看 src/a.ts 吧' }, { type: 'file', path: 'src/a.ts' }] },
    { label: 'file + file（仅边界空格）', live: [{ type: 'file', path: 'a.ts' }, { type: 'file', path: 'b.ts' }] },
    { label: 'skill + 正文', live: [{ type: 'skill', name: 'review', location: '/skills/review/SKILL.md' }, { type: 'text', text: '正文' }] },
    { label: '正文 + session（chip 收尾）', live: [{ type: 'text', text: '看看' }, { type: 'session', sessionId: 'sid-1', label: '会话 A' }] },
    { label: 'mention + 正文 + handoff', live: [{ type: 'mention', name: 'alice' }, { type: 'text', text: '正文' }, { type: 'handoff', sourceLabel: 'src-session' }] },
    { label: 'subagent（空串序列化）+ 正文', live: [{ type: 'subagent', subagentId: 's1', slug: 'oracle' }, { type: 'text', text: '正文' }] },
    { label: 'image + 正文（图片居首）', live: [IMG, { type: 'text', text: '正文' }] },
    { label: '正文 + image（图片居末）', live: [{ type: 'text', text: '正文' }, IMG] },
  ]

  for (const { label, live } of CASES) {
    it(`${label}：prompt === 草稿`, () => {
      const draft = normalizeContent(live)
      expect(segmentsToPrompt(rebuildSegmentsWithEditedText(live, draft))).toBe(draft)
    })
  }
})
