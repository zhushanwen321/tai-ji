/**
 * TrafficLight win/linux 交互路径测试（review N2 补充）。
 *
 * 覆盖（shell spec §五方案 X）：
 *  - win/linux：自绘 3 彩色圆点渲染 + 点击 close/min/max 分别触发对应窗口控制 IPC
 *  - mac：模板不渲染圆点（红黄绿由 OS 绘制），IPC 不可达
 *  - 全屏态：isFullscreen=true → 根 div opacity-0 + pointer-events-none 成对
 *    （review MF-1：单独任一都会让隐形圆点组劫持 PanelHeader chrome 点击）
 *
 * Mock 策略（对齐 app-shell-topology.test.ts platformChromeMock 范式）：
 *  - usePlatformChrome mock：vi.hoisted 共享 isFullscreen ref（可改值）+ detectPlatform vi.fn（可切平台）
 *  - @/lib/ipc mock：三个窗口控制函数 spy
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/shell/TrafficLight.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

/** usePlatformChrome mock：可控 isFullscreen ref + 可切换的 detectPlatform（win/linux vs mac） */
const platformChromeMock = vi.hoisted(() => ({
  isFullscreen: { value: false } as { value: boolean },
  detectPlatform: vi.fn<() => 'mac' | 'win' | 'linux'>(() => 'win'),
}))
vi.mock('@/composables/effects/usePlatformChrome', async () => {
  const { ref } = await import('vue')
  const isFullscreen = ref(false)
  platformChromeMock.isFullscreen = isFullscreen
  return {
    usePlatformChrome: () => ({ isFullscreen }),
    detectPlatform: platformChromeMock.detectPlatform,
  }
})

/** @/lib/ipc mock：窗口控制 spy（TrafficLight 唯一消费面） */
const ipcMock = vi.hoisted(() => ({
  windowClose: vi.fn(),
  windowMinimize: vi.fn(),
  windowToggleMaximize: vi.fn(),
}))
vi.mock('@/lib/ipc', () => ({
  windowClose: ipcMock.windowClose,
  windowMinimize: ipcMock.windowMinimize,
  windowToggleMaximize: ipcMock.windowToggleMaximize,
}))

import TrafficLight from '@/components/shell/TrafficLight.vue'

beforeEach(() => {
  vi.clearAllMocks()
  platformChromeMock.isFullscreen.value = false
  platformChromeMock.detectPlatform.mockReturnValue('win')
})

describe('TrafficLight win/linux 交互路径', () => {
  it('win 态渲染 3 个自绘圆点（红 close / 黄 minimize / 绿 maximize）', () => {
    const wrapper = mount(TrafficLight)
    const dots = wrapper.findAll('.tl-dot')
    expect(dots).toHaveLength(3)
    // aria-label 映射：close / minimize / maximize（i18n zh-CN：关闭/最小化/最大化）
    const labels = dots.map((d) => d.attributes('aria-label'))
    expect(labels).toEqual(['关闭', '最小化', '最大化'])
  })

  it('点击各圆点分别触发 windowClose / windowMinimize / windowToggleMaximize IPC', async () => {
    const wrapper = mount(TrafficLight)
    const dots = wrapper.findAll('.tl-dot')

    // 红点（close）→ windowClose
    await dots[0].trigger('click')
    expect(ipcMock.windowClose).toHaveBeenCalledTimes(1)
    expect(ipcMock.windowMinimize).not.toHaveBeenCalled()
    expect(ipcMock.windowToggleMaximize).not.toHaveBeenCalled()

    // 黄点（minimize）→ windowMinimize
    await dots[1].trigger('click')
    expect(ipcMock.windowMinimize).toHaveBeenCalledTimes(1)

    // 绿点（maximize）→ windowToggleMaximize
    await dots[2].trigger('click')
    expect(ipcMock.windowToggleMaximize).toHaveBeenCalledTimes(1)
  })

  it('mac 态不渲染自绘圆点（红黄绿由 OS 绘制），IPC 不可达', async () => {
    platformChromeMock.detectPlatform.mockReturnValue('mac')
    const wrapper = mount(TrafficLight)

    // 模板 v-if !isMac：无任何按钮/圆点可点击
    expect(wrapper.findAll('.tl-dot')).toHaveLength(0)
    expect(wrapper.findAll('button')).toHaveLength(0)

    // 空占位 div 上点击不触发任何窗口控制 IPC
    await wrapper.find('.traffic-light').trigger('click')
    expect(ipcMock.windowClose).not.toHaveBeenCalled()
    expect(ipcMock.windowMinimize).not.toHaveBeenCalled()
    expect(ipcMock.windowToggleMaximize).not.toHaveBeenCalled()
  })

  it('全屏态根 div opacity-0 + pointer-events-none 成对（review MF-1 防隐形劫持）', async () => {
    const wrapper = mount(TrafficLight)
    const tl = wrapper.find('.traffic-light')

    // 非全屏：两类均无（圆点可见且可点）
    expect(tl.classes()).not.toContain('opacity-0')
    expect(tl.classes()).not.toContain('pointer-events-none')

    // 全屏：opacity-0 与 pointer-events-none 必须成对（absolute z-10 圆点组在折叠+全屏下
    // 悬浮于 PanelHeader chrome 之上，只隐藏视觉不关命中会静默触发最小化/最大化）
    platformChromeMock.isFullscreen.value = true
    await nextTick()
    expect(tl.classes()).toContain('opacity-0')
    expect(tl.classes()).toContain('pointer-events-none')

    // 退出全屏：成对消失，恢复可交互
    platformChromeMock.isFullscreen.value = false
    await nextTick()
    expect(tl.classes()).not.toContain('opacity-0')
    expect(tl.classes()).not.toContain('pointer-events-none')
  })
})
