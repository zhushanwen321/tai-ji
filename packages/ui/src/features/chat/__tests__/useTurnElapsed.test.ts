/**
 * useTurnElapsed 可见性停表单测（perf W05 Q1-7）。
 *
 * 覆盖（fake timers + document.hidden mock）：
 * - 可见 + streaming：每秒 tick 正常（基线回归）
 * - 失焦（visibilitychange hidden）：停止每秒 tick——interval 回调不触发，elapsed 不更新
 * - 失焦期间 streaming 开始：同样不挂 interval（startElapsedTimer 的 hidden 分支）
 * - 恢复可见：elapsed 立即以 Date.now() 差值补算失焦期间耗时，并重启每秒 tick
 * - 失焦期间完成定格：恢复可见不误重启 tick（isStreaming 已 false）
 * - 卸载：移除 visibilitychange listener + 清 interval（无泄漏）
 * - listener 生命周期与 streaming 对齐（W05 review）：完成态实例零 listener，
 *   开始计时挂载、完成定格摘除、二次周期幂等不叠加
 *
 * 时间模型：vi.useFakeTimers() 同时接管 Date.now；advanceTimersByTime 同步推进系统时间，
 * elapsed 是 now - firstTs 的绝对差值，停 tick 不丢时间，恢复可见一次重算即补全。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/useTurnElapsed.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, nextTick, ref, type Ref } from 'vue'
import { mount } from '@vue/test-utils'
import type { Message } from '@xyz-agent/shared'
import { useTurnElapsed } from '../composables/useTurnElapsed'

/** 测试起点系统时间（任意固定值） */
const T0 = 1_000_000

function makeAssistant(timestamp: number, content: Message['content'] = 'text', id = 'a-1'): Message {
  return { id, role: 'assistant', content, status: 'streaming', timestamp }
}

/** mock document.hidden / visibilityState（happy-dom 下 spyOn getter 生效） */
function setHidden(hidden: boolean): void {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(hidden ? 'hidden' : 'visible')
}

/** 模拟浏览器可见性变化事件 */
function fireVisibilityChange(): void {
  document.dispatchEvent(new Event('visibilitychange'))
}

/**
 * mount 宿主组件驱动 useTurnElapsed（onUnmounted/watch 需组件实例）。
 * 返回 elapsed refs + 可变的 streaming 驱动源。
 */
function mountElapsed(assistants: Message[], isStreamingInitial: boolean) {
  const streaming = ref(isStreamingInitial)
  const exposed = {} as { elapsed: Ref<string>; elapsedSecs: Ref<number>; generatedChars: Ref<number> }
  const Host = defineComponent({
    setup() {
      const { elapsed, elapsedSecs, generatedChars } = useTurnElapsed(
        () => assistants,
        () => streaming.value,
      )
      exposed.elapsed = elapsed
      exposed.elapsedSecs = elapsedSecs
      exposed.generatedChars = generatedChars
      return () => null
    },
  })
  const wrapper = mount(Host)
  return { wrapper, exposed, streaming }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  setHidden(false)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useTurnElapsed 可见性停表（Q1-7）', () => {
  it('可见 + streaming：每秒 tick 正常推进 elapsed（基线回归）', () => {
    const { wrapper, exposed } = mountElapsed([makeAssistant(T0)], true)
    // 挂载即算：now-first=0 → max(1, 0)=1s
    expect(exposed.elapsed.value).toBe('1s')

    vi.advanceTimersByTime(3000)
    expect(exposed.elapsed.value).toBe('3s')
    expect(exposed.elapsedSecs.value).toBe(3)
    wrapper.unmount()
  })

  it('失焦停止每秒 tick：hidden 后推进 10s，elapsed 不更新（interval 回调不触发）', () => {
    const { wrapper, exposed } = mountElapsed([makeAssistant(T0)], true)
    expect(exposed.elapsed.value).toBe('1s')

    setHidden(true)
    fireVisibilityChange()
    vi.advanceTimersByTime(10_000)

    // tick 已停：Date.now 已推进 10s，但 elapsed 仍为定格值
    expect(Date.now()).toBe(T0 + 10_000)
    expect(exposed.elapsed.value).toBe('1s')
    expect(exposed.elapsedSecs.value).toBe(1)
    wrapper.unmount()
  })

  it('失焦期间 streaming 开始：不挂 interval（hidden 下 startElapsedTimer 只立即算一次）', async () => {
    const { wrapper, exposed, streaming } = mountElapsed([makeAssistant(T0)], false)
    expect(exposed.elapsed.value).toBe('1s') // completed 定格（无第二条消息，min 1s）

    setHidden(true)
    streaming.value = true
    await nextTick() // watch flush:pre → startElapsedTimer（hidden 分支不挂 interval）

    vi.advanceTimersByTime(10_000)
    // 无 tick：elapsed 停在 hidden 进入时的值
    expect(exposed.elapsed.value).toBe('1s')
    wrapper.unmount()
  })

  it('恢复可见：elapsed 立即以 Date.now() 差值补算失焦期间耗时，并重启每秒 tick', () => {
    const { wrapper, exposed } = mountElapsed([makeAssistant(T0)], true)

    setHidden(true)
    fireVisibilityChange()
    vi.advanceTimersByTime(10_000)
    expect(exposed.elapsed.value).toBe('1s') // 失焦期间未更新

    setHidden(false)
    fireVisibilityChange()
    // 补算：now-first = 10s（Date.now 差值覆盖失焦期间）
    expect(exposed.elapsed.value).toBe('10s')
    expect(exposed.elapsedSecs.value).toBe(10)

    // tick 已重启：继续每秒推进
    vi.advanceTimersByTime(2000)
    expect(exposed.elapsed.value).toBe('12s')
    wrapper.unmount()
  })

  it('失焦期间完成定格：恢复可见不误重启 tick（isStreaming 已 false）', async () => {
    const { wrapper, exposed, streaming } = mountElapsed([makeAssistant(T0)], true)

    setHidden(true)
    fireVisibilityChange()

    // 失焦期间流完成（watch 定格分支）
    streaming.value = false
    await nextTick()
    const frozen = exposed.elapsed.value

    setHidden(false)
    fireVisibilityChange()
    vi.advanceTimersByTime(10_000)

    // 仍定格：无 tick、无补算重启
    expect(exposed.elapsed.value).toBe(frozen)
    wrapper.unmount()
  })

  it('卸载：移除 visibilitychange listener + 清 interval（无泄漏）', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const { wrapper, exposed } = mountElapsed([makeAssistant(T0)], true)
    expect(exposed.elapsed.value).toBe('1s')

    wrapper.unmount()
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

    // 卸载后 interval 已清 + listener 已移除：推进时间不再变更 elapsed，也不抛错
    vi.advanceTimersByTime(10_000)
    expect(exposed.elapsed.value).toBe('1s')
    expect(() => fireVisibilityChange()).not.toThrow()
  })

  it('完成态实例零 listener：未开始计时不挂 visibilitychange（W05 review，N 实例不叠 N listener）', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const { wrapper } = mountElapsed([makeAssistant(T0)], false)
    // 早已完成/未开始的 Turn：不进入 startElapsedTimer → 不挂 document listener
    expect(addSpy).not.toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    wrapper.unmount()
  })

  it('listener 生命周期与 streaming 对齐：开始计时挂载、完成定格摘除、二次周期不叠加', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const addedCount = () => addSpy.mock.calls.filter(([t]) => t === 'visibilitychange').length
    const removedCount = () =>
      removeSpy.mock.calls.filter(([t]) => t === 'visibilitychange').length

    const { wrapper, streaming } = mountElapsed([makeAssistant(T0)], false)
    expect(addedCount()).toBe(0) // 初始完成态：零 listener

    // 完成 → streaming：startElapsedTimer 挂 listener
    streaming.value = true
    await nextTick()
    expect(addedCount()).toBe(1)

    // streaming → 完成：定格停表摘 listener
    streaming.value = false
    await nextTick()
    expect(removedCount()).toBe(1)

    // 二次 streaming 周期：再挂再摘，数量对齐（无叠加残留）
    streaming.value = true
    await nextTick()
    streaming.value = false
    await nextTick()
    expect(addedCount()).toBe(2)
    expect(removedCount()).toBe(2)
    wrapper.unmount()
  })
})

// ═════════════════════════════════════════════════════════════
// u3 remove-turn-progress-bar：generatedChars（设计 §2.1）
//
// 口径 = Σ normalizeContent(turn.assistants[].content).length（跨 assistant 段整段计入）。
// 节拍 = 挂载算一次 / streaming 每秒重算（与 elapsed 同一 interval tick）/ 停表定格一次；
// 性能纪律 = 不随 delta 重算（绝不在内容 watcher 里算）。失焦停 tick / 恢复补算对齐 elapsed。
// ═════════════════════════════════════════════════════════════
describe('useTurnElapsed generatedChars（u3 remove-turn-progress-bar）', () => {
  it('Σ 口径含多 assistant 段：text→tool→text 跨段整段累计，Segment[] content 经 normalizeContent 归一化', () => {
    // 三 assistant：'abc'(3) + Segment[] text 'de'(2) + 'f'(1) = 6（旧观测条同口径：
    // 同函数 normalizeContent，非仅末段）；挂载即算（完成态定格一次）
    const assistants = [
      makeAssistant(T0, 'abc', 'a-1'),
      makeAssistant(T0 + 1000, [{ type: 'text', text: 'de' }], 'a-2'),
      makeAssistant(T0 + 2000, 'f', 'a-3'),
    ]
    const { wrapper, exposed } = mountElapsed(assistants, false)
    expect(exposed.generatedChars.value).toBe(6)
    wrapper.unmount()
  })

  it('streaming 秒级增长：同一 interval tick 后重算，两次 tick 之间内容增长不反映（不随 delta 重算）', () => {
    const assistants = [makeAssistant(T0, 'a')]
    const { wrapper, exposed } = mountElapsed(assistants, true)
    expect(exposed.generatedChars.value).toBe(1)

    // 内容增长（getter 每次拉取最新数组，无需响应式）：下一个 tick 之前不计入
    assistants[0] = { ...assistants[0], content: 'abc' }
    expect(exposed.generatedChars.value).toBe(1) // 未到 tick：性能纪律（不在内容变化点算）

    vi.advanceTimersByTime(1000) // 一次 tick
    expect(exposed.generatedChars.value).toBe(3)
    wrapper.unmount()
  })

  it('停表定格：isStreaming true→false 重算一次读到权威内容，之后内容再变不跟随', async () => {
    const assistants = [makeAssistant(T0, 'abc')]
    const { wrapper, exposed, streaming } = mountElapsed(assistants, true)
    expect(exposed.generatedChars.value).toBe(3)

    streaming.value = false
    await nextTick() // 停表定格重算一次
    expect(exposed.generatedChars.value).toBe(3)

    // 定格后内容再变（完成态权威覆盖等）：无 tick、无 watcher，值不随内容漂移
    assistants[0] = { ...assistants[0], content: 'abcdef' }
    vi.advanceTimersByTime(5000)
    expect(exposed.generatedChars.value).toBe(3)
    wrapper.unmount()
  })

  it('零字符：空 assistants / 空内容均 0（v-if chars>0 不渲染的上游口径）', () => {
    const { wrapper, exposed } = mountElapsed([], true)
    expect(exposed.generatedChars.value).toBe(0)
    wrapper.unmount()

    const assistants = [makeAssistant(T0, '')]
    const { wrapper: w2, exposed: e2 } = mountElapsed(assistants, true)
    expect(e2.generatedChars.value).toBe(0)
    w2.unmount()
  })

  it('失焦停 tick / 恢复补算语义对齐 elapsed：失焦期内容增长不反映，恢复可见立即补算并重启 tick', () => {
    const assistants = [makeAssistant(T0, 'ab')]
    const { wrapper, exposed } = mountElapsed(assistants, true)
    expect(exposed.generatedChars.value).toBe(2)

    setHidden(true)
    fireVisibilityChange()
    assistants[0] = { ...assistants[0], content: 'abcd' }
    vi.advanceTimersByTime(5000)
    expect(exposed.generatedChars.value).toBe(2) // 失焦：tick 已停不重算

    setHidden(false)
    fireVisibilityChange()
    expect(exposed.generatedChars.value).toBe(4) // 恢复：一次补算

    assistants[0] = { ...assistants[0], content: 'abcdef' }
    vi.advanceTimersByTime(1000)
    expect(exposed.generatedChars.value).toBe(6) // tick 已重启：继续每秒跟随
    wrapper.unmount()
  })
})

describe('useTurnElapsed 首末时刻输出', () => {
  it('streaming 态 firstTs/lastTs 有值，isLive=true', async () => {
    const t1 = T0 + 1000
    const t2 = T0 + 5000
    const assistants = [makeAssistant(t1), makeAssistant(t2)]
    const streaming = ref(true)
    const exposed = {} as { firstTs: Ref<number>; lastTs: Ref<number>; isLive: Ref<boolean> }
    const Host = defineComponent({
      setup() {
        const result = useTurnElapsed(() => assistants, () => streaming.value)
        Object.assign(exposed, result)
        return () => null
      },
    })
    const wrapper = mount(Host)
    expect(exposed.firstTs.value).toBe(t1)
    expect(exposed.lastTs.value).toBe(t2)
    expect(exposed.isLive.value).toBe(true)
    wrapper.unmount()
  })

  it('完成态 firstTs/lastTs 有值，isLive=false', () => {
    const t1 = T0 + 1000
    const t2 = T0 + 5000
    const assistants = [makeAssistant(t1), makeAssistant(t2)]
    const streaming = ref(false)
    const exposed = {} as { firstTs: Ref<number>; lastTs: Ref<number>; isLive: Ref<boolean> }
    const Host = defineComponent({
      setup() {
        const result = useTurnElapsed(() => assistants, () => streaming.value)
        Object.assign(exposed, result)
        return () => null
      },
    })
    const wrapper = mount(Host)
    expect(exposed.firstTs.value).toBe(t1)
    expect(exposed.lastTs.value).toBe(t2)
    expect(exposed.isLive.value).toBe(false)
    wrapper.unmount()
  })

  it('空 assistants → firstTs/lastTs=0', () => {
    const streaming = ref(false)
    const exposed = {} as { firstTs: Ref<number>; lastTs: Ref<number> }
    const Host = defineComponent({
      setup() {
        const result = useTurnElapsed(() => [], () => streaming.value)
        Object.assign(exposed, result)
        return () => null
      },
    })
    const wrapper = mount(Host)
    expect(exposed.firstTs.value).toBe(0)
    expect(exposed.lastTs.value).toBe(0)
    wrapper.unmount()
  })
})
