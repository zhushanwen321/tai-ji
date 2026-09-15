/**
 * useTailScroll composable 单测（2026-08 抖动修复重写：settled/sliding 状态机）。
 *
 * 覆盖：
 * - 初始化：首行瞬切 settled（无动画）
 * - 同行横向追加：只更新文本，无纵向动作（不进 sliding）
 * - 换行：进入 sliding（双行渲染 + 双 rAF 后 translateY(-50%) 过渡）
 * - settle：slideDuration 后无过渡重置单行（transform 0、无 transition，显示内容不变）
 * - 滑入中尾行追加：目标行原地更新，动画继续（仍 sliding）
 * - 滑入中又换行：瞬切 settle 到最新
 * - disableScroll 降级：恒 settled 瞬切
 * - 卸载清理：unmount 后 pending timer/rAF 不再改状态
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/composables/__tests__/useTailScroll.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref, computed, nextTick } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import { useTailScroll } from '../useTailScroll'

const SLIDE_DURATION = 120

// ── rAF 手动队列（同 MarkdownRenderer.test.ts 模式）──
const rafQueue: FrameRequestCallback[] = []
const originalRAF = globalThis.requestAnimationFrame
const originalCAF = globalThis.cancelAnimationFrame
beforeEach(() => {
  rafQueue.length = 0
  // toFake 不含 requestAnimationFrame：rAF 走下方手动队列（驱动 sliding 双拍切相），
  // setTimeout 走 fake timers（驱动 settle 定时）
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
})
afterEach(() => {
  globalThis.requestAnimationFrame = originalRAF
  globalThis.cancelAnimationFrame = originalCAF
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function flushRaf(): Promise<void> {
  // Drain all queued rAF callbacks（双 rAF 嵌套会再入队）
  while (rafQueue.length > 0) {
    const cbs = [...rafQueue]
    rafQueue.length = 0
    for (const cb of cbs) cb(0)
  }
  await nextTick()
}

/** 推进一帧（执行已入队的 rAF 但不产生新帧） */
async function advanceOneFrame(): Promise<void> {
  const cbs = [...rafQueue]
  rafQueue.length = 0
  for (const cb of cbs) cb(0)
  await nextTick()
}

/**
 * 创建测试组件：props.lines 驱动 useTailScroll，暴露状态供断言。
 */
function createTestComponent(disableScroll = false) {
  return defineComponent({
    props: {
      lines: { type: Array as () => string[], required: true },
    },
    setup(props) {
      const rawLines = computed(() => props.lines) as unknown as ComputedRef<string[]>
      const result = useTailScroll(rawLines, {
        disableScroll,
        slideDuration: SLIDE_DURATION,
      })
      return {
        displayLines: result.displayLines,
        contentStyle: result.contentStyle,
      }
    },
    render() {
      return h('div', { style: this.contentStyle }, this.displayLines.map((l) => h('span', { key: l }, l)))
    },
  })
}

describe('useTailScroll（settled/sliding 状态机）', () => {
  it('初始化：首行瞬切 settled，无动画', async () => {
    const TestComp = createTestComponent()
    const wrapper = mount(TestComp, { props: { lines: ['first line'] } })
    await nextTick()
    expect(wrapper.vm.displayLines).toEqual(['first line'])
    expect(wrapper.vm.contentStyle).toEqual({ transform: 'translateY(0)' })
  })

  it('首行为空串也能初始化（不误判为未初始化）', async () => {
    const TestComp = createTestComponent()
    const wrapper = mount(TestComp, { props: { lines: [''] } })
    await nextTick()
    expect(wrapper.vm.displayLines).toEqual([''])
    // 空串初始化后再来数据：走正常换行/追加逻辑，不被误判为 init 分支
    await wrapper.setProps({ lines: ['', 'second'] })
    expect(wrapper.vm.displayLines).toEqual(['', 'second'])
  })

  it('同行横向追加：只更新文本，不进 sliding', async () => {
    const TestComp = createTestComponent()
    const wrapper = mount(TestComp, { props: { lines: ['abc'] } })
    await nextTick()
    // 尾行文本追加（窗口 1 行，无倒数第二行）→ settled 文本更新，无纵向动作
    await wrapper.setProps({ lines: ['abcdef'] })
    expect(wrapper.vm.displayLines).toEqual(['abcdef'])
    expect(wrapper.vm.contentStyle).toEqual({ transform: 'translateY(0)' })
  })

  it('换行：进入 sliding，双 rAF 后 translateY(-50%) 过渡', async () => {
    const TestComp = createTestComponent()
    const wrapper = mount(TestComp, { props: { lines: ['abc'] } })
    await nextTick()
    // 换行：窗口变 ['abc', 'new']（倒数第二行 === 旧尾行）
    await wrapper.setProps({ lines: ['abc', 'new line'] })
    // enter 拍：双行渲染、transform 0、无 transition
    expect(wrapper.vm.displayLines).toEqual(['abc', 'new line'])
    expect(wrapper.vm.contentStyle).toEqual({ transform: 'translateY(0)' })
    // 双 rAF 后 slide 拍：-50% + transition
    await advanceOneFrame()
    await advanceOneFrame()
    expect(wrapper.vm.contentStyle.transform).toBe('translateY(-50%)')
    expect(wrapper.vm.contentStyle.transition).toContain('transform')
  })

  it('settle：slideDuration 后重置单行，transform 0 且无过渡（显示内容不变无闪烁）', async () => {
    const TestComp = createTestComponent()
    const wrapper = mount(TestComp, { props: { lines: ['abc'] } })
    await nextTick()
    await wrapper.setProps({ lines: ['abc', 'new line'] })
    await advanceOneFrame()
    await advanceOneFrame()
    expect(wrapper.vm.displayLines).toEqual(['abc', 'new line'])
    // settle 后：单行 = 滑动目标行（显示内容不变），无 transition
    vi.advanceTimersByTime(SLIDE_DURATION)
    await nextTick()
    expect(wrapper.vm.displayLines).toEqual(['new line'])
    expect(wrapper.vm.contentStyle).toEqual({ transform: 'translateY(0)' })
  })

  it('滑入中尾行文本追加：目标行原地更新，动画继续', async () => {
    const TestComp = createTestComponent()
    const wrapper = mount(TestComp, { props: { lines: ['abc'] } })
    await nextTick()
    await wrapper.setProps({ lines: ['abc', 'new'] })
    await advanceOneFrame()
    // 滑入中（未 settle），尾行追加字符：倒数第二行 'abc' ≠ sliding 目标行 'new' → 原地更新
    await wrapper.setProps({ lines: ['abc', 'new continued'] })
    expect(wrapper.vm.displayLines).toEqual(['abc', 'new continued'])
    // 仍是 sliding（settle 前双行），动画未被打断
    vi.advanceTimersByTime(SLIDE_DURATION)
    await nextTick()
    expect(wrapper.vm.displayLines).toEqual(['new continued'])
  })

  it('滑入中又换行：瞬切 settle 到最新（放弃动画）', async () => {
    const TestComp = createTestComponent()
    const wrapper = mount(TestComp, { props: { lines: ['abc'] } })
    await nextTick()
    await wrapper.setProps({ lines: ['abc', 'line2'] })
    await advanceOneFrame()
    // 滑入中再次换行：窗口 ['line2', 'line3']，倒数第二行 'line2' === sliding 目标行 → 瞬切
    await wrapper.setProps({ lines: ['line2', 'line3'] })
    expect(wrapper.vm.displayLines).toEqual(['line3'])
    expect(wrapper.vm.contentStyle).toEqual({ transform: 'translateY(0)' })
  })

  it('disableScroll：恒 settled 瞬切，换行也不进 sliding', async () => {
    const TestComp = createTestComponent(true)
    const wrapper = mount(TestComp, { props: { lines: ['abc'] } })
    await nextTick()
    await wrapper.setProps({ lines: ['abc', 'new line'] })
    await advanceOneFrame()
    await advanceOneFrame()
    expect(wrapper.vm.displayLines).toEqual(['new line'])
    expect(wrapper.vm.contentStyle).toEqual({ transform: 'translateY(0)' })
  })

  it('卸载清理：unmount 后 settle timer 不再改状态（不抛错）', async () => {
    const TestComp = createTestComponent()
    const wrapper = mount(TestComp, { props: { lines: ['abc'] } })
    await nextTick()
    await wrapper.setProps({ lines: ['abc', 'new line'] })
    await advanceOneFrame()
    wrapper.unmount()
    expect(() => {
      vi.advanceTimersByTime(SLIDE_DURATION * 10)
    }).not.toThrow()
  })

  it('直接调用（不挂载组件）不抛错——composable 可脱离 DOM 使用', () => {
    const rawLines = ref<string[]>(['a', 'b'])
    expect(() => {
      useTailScroll(rawLines as unknown as ComputedRef<string[]>)
    }).not.toThrow()
  })
})
