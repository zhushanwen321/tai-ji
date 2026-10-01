/**
 * TrafficLight win/linux 交互路径测试（review N2 补充）。
 *
 * 覆盖（shell spec §五方案 X）：
 *  - win/linux：自绘 3 彩色圆点渲染 + 点击 close/min/max 分别触发对应窗口控制 IPC
 *  - mac：模板不渲染圆点（红黄绿由 OS 绘制），IPC 不可达
 *  - 全屏态：isFullscreen=true → 根 div opacity-0 + pointer-events-none 成对
 *    （review MF-1：单独任一都会让隐形圆点组劫持 PanelHeader chrome 点击）
 *  - issue #24 缺陷修复：悬停同色 important 覆盖（缺陷 A：旧 hover:bg-transparent 把圆点
 *    底色一并透明化）、图标锁定 8px（缺陷 B：Button 基础样式 [&_svg]:size-4 压过 lucide :size=8）、
 *    容器 [-webkit-app-region:no-drag]（叠在侧栏顶部拖拽条带之上保住点击命中）
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
import { platformChromeMock, expectFullscreenChromePairing } from '@/__tests__/helpers/platform-chrome-mock'

// usePlatformChrome mock：共享态在 helpers/platform-chrome-mock（isFullscreen 换装真 ref 供测试改值）；
// 本文件默认平台 win（mac 用例逐点覆写 detectPlatform）
vi.mock('@/composables/effects/usePlatformChrome', async () => {
  const { installPlatformChromeMock } = await import('@/__tests__/helpers/platform-chrome-mock')
  return installPlatformChromeMock('win')
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
    await expectFullscreenChromePairing(wrapper.find('.traffic-light'), async (v) => {
      platformChromeMock.isFullscreen.value = v
      await nextTick()
    })
  })
})

describe('TrafficLight issue #24 缺陷修复（悬停同色 / 图标 8px / no-drag）', () => {
  it('缺陷 A 悬停同色覆盖：逐点 hover:!bg-<同色> 在 class 列表，透明化类已移除', async () => {
    const wrapper = mount(TrafficLight)
    const dots = wrapper.findAll('.tl-dot')

    // 旧 hover:bg-transparent 会把圆点自身底色一并透明化（悬停即消失），必须移除
    for (const dot of dots) {
      expect(dot.classes()).not.toContain('hover:bg-transparent')
    }

    // 逐点同色覆盖类与底色类同源同色（红/黄/绿各持 hover:!bg-<色>，压 ghost hover:bg-surface-hover 灰底且保住自身底色）
    const colors = ['#ff5f57', '#febc2e', '#28c840']
    dots.forEach((dot, i) => {
      expect(dot.classes()).toContain(`bg-[${colors[i]}]`)
      expect(dot.classes()).toContain(`hover:!bg-[${colors[i]}]`)
    })

    // 触发 hover：覆盖类保持生效形态（jsdom 不套用 :hover 样式，类列表即确定性证据）
    await dots[0].trigger('mouseenter')
    expect(dots[0].classes()).toContain('hover:!bg-[#ff5f57]')
    expect(dots[0].classes()).not.toContain('hover:bg-transparent')
  })

  it('缺陷 B 图标锁定 8px：圆点 Button 带 [&_svg]:!size-2 覆盖类且 svg 实际渲染', () => {
    const wrapper = mount(TrafficLight)
    const dots = wrapper.findAll('.tl-dot')

    // Button 基础样式 [&_svg]:size-4（16px）压过 lucide :size=8 —— 必须 important 覆盖锁回 8px（size-2）
    dots.forEach((dot) => {
      expect(dot.classes()).toContain('[&_svg]:!size-2')
      // 每个圆点内黑色符号 svg 真实存在（用户可见：hover 整组浮出 ×/−/+ 符号）
      expect(dot.find('svg').exists()).toBe(true)
    })
  })

  it('圆点组容器 no-drag：[-webkit-app-region:no-drag] 保住拖拽条带之上的点击命中', () => {
    const wrapper = mount(TrafficLight)
    const tl = wrapper.find('.traffic-light')
    // 容器叠在侧栏顶部 drag 条带（U2）之上，no-drag 显式声明防点击被拖拽区吞掉
    expect(tl.classes()).toContain('[-webkit-app-region:no-drag]')
  })
})
