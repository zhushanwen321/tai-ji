/**
 * useMessageStreamFollowTriggers 单测（U5→V6 修复：RO 回调双 rAF）。
 *
 * 覆盖（P-timing 降级预案「RO 回调内改为双 rAF
 * （再让一帧）」+ V6 shrink 方向间歇 113px 残留）：
 * - 双 rAF 核心行为：scrollEl RO 触发后 follow 不立即执行（外层 rAF pending），flush 一帧后才调
 *   followIfStuck——scrollToIndex 落在 virtua 内部 RO 更新测量缓存之后（V6 残留从根源修复验收范围）
 * - 连续触发 cancel 合并：同帧两次 RO 触发只产生一次 followIfStuck（外层句柄 cancel-reschedule，
 *   同 U1 followIfStuck 的 pendingRafId 模式）
 * - notifyRoActivity 时机：首次 RO 回调即喂信号（D7② 收敛抑制窗静默计时不因双 rAF 拖延）
 * - 语义不变面：store watch 通路保持直调（不套外层 rAF）、dispose 取消 pending 外层 rAF
 * - [决策 12] 旧 markUnread sticky / tail-spacer 二分 / isPrepend 前插抑制窗用例随标记分档
 *   退役删除（「回到最新」胶囊改距底几何判定，触发源不再区分标记/静默；同帧 tail 增高 +
 *   视口 resize 的 cancel 合并行为保留用例验证只调一次）
 *
 * mock 策略：@vue/test-utils 挂载 harness 组件（composable 的 onMounted 需要组件实例）；
 * ManualResizeObserverStub（_virtua-mock-helper U1 定稿）确定性派发 RO 回调——组件内创建顺序
 * wrap RO 先、scroll RO 后（created()[0]/[1]）；wrap RO 派发必须带 contentRect（回调读取
 * contentRect.height，真实浏览器 RO 恒提供）。followIfStuck / notifyRoActivity 为 vi.fn() 注入。
 * rAF 由 vi.useFakeTimers() 接管，advanceTimersByTimeAsync(16) flush 一帧（与
 * use-virtua-follow.test.ts 同款）。happy-dom offsetHeight 恒 0 → tail 增高用实例 getter
 * defineProperty 覆盖模拟。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Message } from '@taiji/shared'
import { useMessageStreamFollowTriggers } from '@/composables/panel/useMessageStreamFollowTriggers'
import { ManualResizeObserverStub } from './_virtua-mock-helper'

function msg(id: string, content: string, role: Message['role'] = 'user'): Message {
  return { id, role, content, status: 'complete' }
}

describe('useMessageStreamFollowTriggers（RO 回调双 rAF，P-timing 降级预案）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ManualResizeObserverStub.install()
  })

  afterEach(() => {
    vi.useRealTimers()
    ManualResizeObserverStub.uninstall()
  })

  /** 挂载 harness：composable 依赖全部可断言注入，返回 wrapper + 依赖句柄 */
  function mountTriggers() {
    const messages = ref<Message[]>([])
    const lastRenderTurn = ref<{ isStreaming: boolean } | null>(null)
    const scrollEl = ref<HTMLElement | null>(document.createElement('div'))
    const followIfStuck = vi.fn()
    const followToBottomForce = vi.fn()
    const notifyRoActivity = vi.fn()
    const refreshDistanceSnapshot = vi.fn()
    const submitSeq = ref(0)

    let api!: ReturnType<typeof useMessageStreamFollowTriggers>
    const Harness = defineComponent({
      setup() {
        api = useMessageStreamFollowTriggers({
          messages: computed(() => messages.value),
          submitSeq: () => submitSeq.value,
          lastRenderTurn: computed(() => lastRenderTurn.value),
          scrollEl,
          followIfStuck,
          followToBottomForce,
          notifyRoActivity,
          refreshDistanceSnapshot,
        })
        return () => h('div', { ref: api.contentWrapEl }, [h('div', { ref: api.tailEl })])
      },
    })
    const wrapper: VueWrapper = mount(Harness)

    // onMounted 创建顺序：wrap RO 先、scroll RO 后
    const [wrapRo, scrollRo] = ManualResizeObserverStub.created()
    if (!wrapRo || !scrollRo) throw new Error('RO stub 未按预期创建（wrap 先、scroll 后）')
    return {
      wrapper,
      api,
      messages,
      lastRenderTurn,
      followIfStuck,
      followToBottomForce,
      refreshDistanceSnapshot,
      submitSeq,
      notifyRoActivity,
      wrapRo,
      scrollRo,
    }
  }

  /** 覆盖 tailEl 实例 offsetHeight getter（happy-dom 恒 0，无法表达真实增高） */
  function stubTailHeight(api: ReturnType<typeof useMessageStreamFollowTriggers>, height: number): void {
    const el = api.tailEl.value
    if (!el) throw new Error('tailEl 未挂载')
    Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true })
  }

  it('双 rAF 核心：scrollEl RO 触发后 follow 不立即执行，flush 一帧后才调 followIfStuck()', async () => {
    const { scrollRo, followIfStuck, notifyRoActivity } = mountTriggers()

    scrollRo.dispatch()

    // 外层 rAF pending 期间：follow 未触发（RO 回调 → 外层 rAF → followIfStuck 内层 rAF）
    expect(followIfStuck).not.toHaveBeenCalled()
    // notifyRoActivity 在首次 RO 回调即喂信号（不因双 rAF 拖延）
    expect(notifyRoActivity).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(16) // flush 外层 rAF
    expect(followIfStuck).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledWith()
    expect(notifyRoActivity).toHaveBeenCalledTimes(1) // 外层 rAF 执行不补喂
  })

  it('连续触发 cancel 合并：同帧两次 scrollEl RO 只产生一次 followIfStuck', async () => {
    const { scrollRo, followIfStuck } = mountTriggers()

    scrollRo.dispatch()
    scrollRo.dispatch() // 同帧第二次：cancel 旧外层 rAF 重排

    await vi.advanceTimersByTimeAsync(16)
    expect(followIfStuck).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledWith()
  })

  it('同帧 wrap RO（tail 增高）后跟视口 resize → cancel 合并只调一次 followIfStuck', async () => {
    const { api, wrapRo, scrollRo, followIfStuck } = mountTriggers()

    stubTailHeight(api, 30) // 基线 0 → 30：tail 高度变化
    wrapRo.dispatch([{ contentRect: { height: 0 } as DOMRectReadOnly }]) // wrap 高度未变，纯 tail 分量
    scrollRo.dispatch() // 后到：cancel 合并

    await vi.advanceTimersByTimeAsync(16)
    expect(followIfStuck).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledWith()
  })

  it('wrap RO spacer 变化（tail 高度不变）→ 跟随一次', async () => {
    const { api, wrapRo, followIfStuck } = mountTriggers()

    wrapRo.dispatch([{ contentRect: { height: 500 } as DOMRectReadOnly }]) // wrap 高度变、tail 未变

    await vi.advanceTimersByTimeAsync(16)
    expect(followIfStuck).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledWith()
  })

  it('store watch 通路保持直调（不套外层 rAF）：messages.length 变化 nextTick 内即触发', async () => {
    const { messages, followIfStuck } = mountTriggers()

    messages.value.push(msg('m1', '你好'))
    await nextTick()

    // 未 flush 任何 rAF：watch 通路不经外层 rAF（D3 矩阵前两行时序语义不变）。
    // 无参调用形态：脱离态不滚的 guard 语义在 useVirtuaFollow 原语内部。
    expect(followIfStuck).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledWith()
  })

  it('dispose 取消 pending 外层 rAF：dispatch 后卸载，flush 后不产生幽灵 follow', async () => {
    const { wrapper, scrollRo, followIfStuck } = mountTriggers()

    scrollRo.dispatch()
    expect(followIfStuck).not.toHaveBeenCalled()

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(32)
    expect(followIfStuck).not.toHaveBeenCalled()
  })

  // ── 用户主动发送 → 强制回底重锚定（feat-new-message-to-bottom，触发矩阵末行）──
  // [chat-flow-consistency F1] 语义分层：本文件只验「触发判定」（提交序号递增 →
  // followToBottomForce）；force 原语本身的完整重置面（无视 stickToBottom / NaN 快照 / 开收敛
  // 抑制窗）已在 use-virtua-follow.test.ts W1TC8 覆盖。旧「尾部新增 user 消息」watch 已删除：
  // morph 回执重建复用 user 消息身份尾插命中旧 watch 强拉回底——序号判据结构性排除。
  it('提交序号递增（用户主动发送，submitNewMessage 单点 +1）→ followToBottomForce', async () => {
    const { submitSeq, followToBottomForce } = mountTriggers()

    await nextTick()
    expect(followToBottomForce).not.toHaveBeenCalled() // 基线：无提交

    submitSeq.value += 1
    await nextTick()
    expect(followToBottomForce).toHaveBeenCalledTimes(1)
  })

  it('morph 回执重建（user 消息尾插但提交序号不动）→ 不 force（旧 watch 的误拉回底形态已消除）', async () => {
    const { messages, submitSeq, followToBottomForce } = mountTriggers()

    // 验收形态（impl-plan U4「morph 回执不再强拉回底」）：用户上翻阅读中，steer 插话
    // 注入回执到达——user-delivery 复用原 clientUuid 尾插 user 消息，submitSeq 不变。
    messages.value = [msg('u1', '第一问'), msg('a1', '回答中', 'assistant')]
    await nextTick()
    messages.value = [...messages.value, msg('u2', '插话回执重建', 'user')] // 尾插 user 消息
    await nextTick()

    expect(submitSeq.value).toBe(0)
    expect(followToBottomForce).not.toHaveBeenCalled()
  })

  it('提交序号递减（session 切换读到另一分区更小值）→ 不 force', async () => {
    const { submitSeq, followToBottomForce } = mountTriggers()

    submitSeq.value = 5
    await nextTick()
    expect(followToBottomForce).toHaveBeenCalledTimes(1) // 前置递增正常触发（对照）
    followToBottomForce.mockClear()

    submitSeq.value = 2 // 切 session 后 watch 源读到新分区值（更小）
    await nextTick()

    expect(followToBottomForce).not.toHaveBeenCalled()
  })

  // ── [chat-flow-consistency F2] 脱离态几何快照刷新调用点接线 ──
  it('F2: wrap RO 高度变化 → refreshDistanceSnapshot 与 follow 同点触发', async () => {
    const { api, wrapRo, followIfStuck, refreshDistanceSnapshot } = mountTriggers()

    stubTailHeight(api, 30)
    wrapRo.dispatch([{ contentRect: { height: 0 } as DOMRectReadOnly }]) // tail 分量高度变化
    await vi.advanceTimersByTimeAsync(16)

    expect(refreshDistanceSnapshot).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledTimes(1)
  })

  it('F2: 纯宽度变化（高度未变）→ 不喂快照刷新（与跟随 no-op 同门）', async () => {
    const { wrapRo, refreshDistanceSnapshot } = mountTriggers()

    wrapRo.dispatch([{ contentRect: { height: 0 } as DOMRectReadOnly }])
    await vi.advanceTimersByTimeAsync(16)

    expect(refreshDistanceSnapshot).not.toHaveBeenCalled()
  })

  it('F2: messages.length watch → refreshDistanceSnapshot 与 followIfStuck 同点触发', async () => {
    const { messages, followIfStuck, refreshDistanceSnapshot } = mountTriggers()

    messages.value.push(msg('m1', '你好'))
    await nextTick()

    expect(refreshDistanceSnapshot).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledTimes(1)
  })
})
