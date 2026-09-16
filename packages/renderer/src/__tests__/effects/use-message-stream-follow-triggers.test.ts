/**
 * useMessageStreamFollowTriggers 单测（chat-pin-bottom-fix U5→V6 修复：RO 回调双 rAF）。
 *
 * 覆盖（对照 docs/design/chat-pin-bottom-fix.md §4.5 P-timing 降级预案「RO 回调内改为双 rAF
 * （再让一帧）」+ acceptance.md V6 shrink 方向间歇 113px 残留）：
 * - 双 rAF 核心行为：scrollEl RO 触发后 follow 不立即执行（外层 rAF pending），flush 一帧后才调
 *   followIfStuck——scrollToIndex 落在 virtua 内部 RO 更新测量缓存之后（V6 残留根修验收面）
 * - 连续触发 cancel 合并：同帧两次 RO 触发只产生一次 followIfStuck（外层句柄 cancel-reschedule，
 *   同 U1 followIfStuck 的 pendingRafId 模式）
 * - markUnread sticky：同帧标记型（tail 增高）与静默型（视口 resize）先后触发 → 合并只调一次
 *   且标记不丢失（对齐 U1 pendingMarkUnread 语义）
 * - notifyRoActivity 时机：首次 RO 回调即喂信号（D7② 收敛抑制窗静默计时不因双 rAF 拖延）
 * - 语义不变面：tail/spacer 二分（增高标 unread / spacer 静默）、isPrepend 抑制窗、
 *   store watch 通路保持直调（不套外层 rAF）、dispose 取消 pending 外层 rAF
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
    const isPrepend = ref(false)
    const scrollEl = ref<HTMLElement | null>(document.createElement('div'))
    const followIfStuck = vi.fn()
    const followToBottomForce = vi.fn()
    const notifyRoActivity = vi.fn()

    let api!: ReturnType<typeof useMessageStreamFollowTriggers>
    const Harness = defineComponent({
      setup() {
        api = useMessageStreamFollowTriggers({
          messages: computed(() => messages.value),
          lastRenderTurn: computed(() => lastRenderTurn.value),
          isPrepend,
          scrollEl,
          followIfStuck,
          followToBottomForce,
          notifyRoActivity,
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
      isPrepend,
      followIfStuck,
      followToBottomForce,
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

  it('双 rAF 核心：scrollEl RO 触发后 follow 不立即执行，flush 一帧后才调 followIfStuck({markUnread:false})', async () => {
    const { scrollRo, followIfStuck, notifyRoActivity } = mountTriggers()

    scrollRo.dispatch()

    // 外层 rAF pending 期间：follow 未触发（RO 回调 → 外层 rAF → followIfStuck 内层 rAF）
    expect(followIfStuck).not.toHaveBeenCalled()
    // notifyRoActivity 在首次 RO 回调即喂信号（不因双 rAF 拖延）
    expect(notifyRoActivity).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(16) // flush 外层 rAF
    expect(followIfStuck).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledWith({ markUnread: false })
    expect(notifyRoActivity).toHaveBeenCalledTimes(1) // 外层 rAF 执行不补喂
  })

  it('连续触发 cancel 合并：同帧两次 scrollEl RO 只产生一次 followIfStuck', async () => {
    const { scrollRo, followIfStuck } = mountTriggers()

    scrollRo.dispatch()
    scrollRo.dispatch() // 同帧第二次：cancel 旧外层 rAF 重排

    await vi.advanceTimersByTimeAsync(16)
    expect(followIfStuck).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledWith({ markUnread: false })
  })

  it('markUnread sticky：同帧 tail 增高（标记型）后跟视口 resize（静默型）→ 合并一次且标记不丢', async () => {
    const { api, wrapRo, scrollRo, followIfStuck } = mountTriggers()

    stubTailHeight(api, 30) // 基线 0 → 30：tail 增高分支（标记型）
    wrapRo.dispatch([{ contentRect: { height: 0 } as DOMRectReadOnly }]) // wrap 高度未变，纯 tail 分量
    scrollRo.dispatch() // 静默型后到：cancel 合并不丢标记

    await vi.advanceTimersByTimeAsync(16)
    expect(followIfStuck).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledWith({ markUnread: true })
  })

  it('tail/spacer 二分语义不变：spacer 变化（tail 高度不变）→ 静默跟随 markUnread:false', async () => {
    const { api, wrapRo, followIfStuck } = mountTriggers()

    wrapRo.dispatch([{ contentRect: { height: 500 } as DOMRectReadOnly }]) // wrap 高度变、tail 未变

    await vi.advanceTimersByTimeAsync(16)
    expect(followIfStuck).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledWith({ markUnread: false })
  })

  it('isPrepend 抑制窗语义不变：窗内 tail 增高也跟随但不标 unread', async () => {
    const { api, isPrepend, wrapRo, followIfStuck } = mountTriggers()

    isPrepend.value = true
    stubTailHeight(api, 30)
    wrapRo.dispatch([{ contentRect: { height: 0 } as DOMRectReadOnly }])

    await vi.advanceTimersByTimeAsync(16)
    expect(followIfStuck).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledWith({ markUnread: false })
  })

  it('store watch 通路保持直调（不套外层 rAF）：messages.length 变化 nextTick 内即触发', async () => {
    const { messages, followIfStuck } = mountTriggers()

    messages.value.push(msg('m1', '你好'))
    await nextTick()

    // 未 flush 任何 rAF：watch 通路不经外层 rAF（D3 矩阵前两行时序语义不变）。
    // 无参调用形态：markUnread 缺省=true 的语义在 useVirtuaFollow 原语内部。
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
  // 语义分层：本文件只验「触发判定」（尾部新增 user 消息 → followToBottomForce）；
  // force 原语本身的完整重置面（无视 stickToBottom / NaN 快照 / 开收敛抑制窗）已在
  // use-virtua-follow.test.ts W1TC8 覆盖。
  it('尾部追加 user 消息（直发/steer·followUp 投递共同形态）→ followToBottomForce', async () => {
    const { messages, followToBottomForce } = mountTriggers()

    // 基线：对话进行中（assistant 尾，模拟流式中用户上滑阅读后发送）
    messages.value = [msg('u1', '第一问'), msg('a1', '回答中', 'assistant')]
    await nextTick()
    expect(followToBottomForce).not.toHaveBeenCalled() // assistant 尾不触发

    // 尾部追加 user 消息 = appendUser 唯一共同落点（composer 直发 / drainN 投递同形态）
    messages.value = [...messages.value, msg('u2', '补充一句')]
    await nextTick()
    expect(followToBottomForce).toHaveBeenCalledTimes(1)
  })

  it('尾部追加 assistant / system 消息 → 不 force（仍走 followIfStuck 矩阵）', async () => {
    const { messages, followToBottomForce } = mountTriggers()

    messages.value = [msg('u1', '第一问'), msg('s1', '系统提示', 'system'), msg('a1', '回答', 'assistant')]
    await nextTick()

    expect(followToBottomForce).not.toHaveBeenCalled()
  })

  it('load-more 前插（尾部身份不变）→ 不 force', async () => {
    const { messages, followToBottomForce } = mountTriggers()

    messages.value = [msg('u1', '最近一问')]
    await nextTick()
    expect(followToBottomForce).toHaveBeenCalledTimes(1) // 初始尾 user 建快照即触发（等同向会话打开强滚）

    // 前插更早历史：尾部仍是 u1（role:id 快照不变）→ 不触发
    messages.value = [msg('u0', '更早一问'), ...messages.value]
    await nextTick()
    expect(followToBottomForce).toHaveBeenCalledTimes(1)
  })

  it('末条 user 消息同 id 对象替换（segments 回填）→ 不 force', async () => {
    const { messages, followToBottomForce } = mountTriggers()

    messages.value = [msg('u1', '第一问')]
    await nextTick()
    expect(followToBottomForce).toHaveBeenCalledTimes(1)

    // 同 id 换新对象（回填 badge segments 等场景）→ 快照不变 → 不触发
    messages.value = [{ ...msg('u1', '第一问'), content: [{ type: 'text', text: '第一问' }] }]
    await nextTick()
    expect(followToBottomForce).toHaveBeenCalledTimes(1)
  })
})
