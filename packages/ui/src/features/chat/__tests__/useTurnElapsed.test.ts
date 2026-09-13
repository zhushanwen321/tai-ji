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

function makeAssistant(timestamp: number): Message {
  return { id: 'a-1', role: 'assistant', content: 'text', status: 'streaming', timestamp }
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
  const exposed = {} as { elapsed: Ref<string>; elapsedSecs: Ref<number> }
  const Host = defineComponent({
    setup() {
      const { elapsed, elapsedSecs } = useTurnElapsed(
        () => assistants,
        () => streaming.value,
      )
      exposed.elapsed = elapsed
      exposed.elapsedSecs = elapsedSecs
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
