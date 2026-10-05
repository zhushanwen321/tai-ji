// A16 safe-area 适配断言（remote-use u19；设计 §2.3 A16：index.html 注释声称用
// env(safe-area-inset-*)，src 全目录零消费——刘海屏/Home Indicator 区被内容顶入）。
//
// 验收条款（impl-plan u19）：样式断言 = env() padding 存在 + 布局类挂载；
// V14 真机项另行验收（无刘海屏设备登记不跑——硬件形态无法仿真）。
//
// 断言形态：happy-dom 不解析样式表（computed padding 断言不可用，同 TC-2 注释），
// 「env() padding 存在」走 CSS/HTML 源码文本断言（TC-8 同形态），「布局类挂载」走
// 组件挂载 DOM classes 断言（TC-1 同形态）。Tailwind 生成能力已实施期探针验证
// （v3.4.19 对 pt-[var(--safe-area-top)] / pb-[env(safe-area-inset-bottom)] 均正确
// 产出工具类，env(safe-area-inset-*, 0px) 变量定义经 postcss 管线原样存活）。
//
// 分治边界（u19 裁决）：顶部 + 横向 inset 由壳根 .mobile-shell 一处覆盖（顶部元素
// 随视图态变化：ErrorBar/token/failed/connecting/chat header——组件级各自处理会漏态，
// 壳根一处覆盖所有视图态）；底部 inset 由贴底 chrome BottomTabBar 自身避让（iOS 形态：
// bar 延伸进 Home Indicator 区，内容 padding 避让，bar 自身背景延伸到屏底）；无底部
// chrome 的全屏态（token-input/failed/connecting）内容居中布局不贴底，底部 inset 不
// 重叠内容。MobileComposer 恒在 BottomTabBar 上方不贴屏底，不叠加（叠加 = 双倍空隙）。
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import App from '../App.vue'
import BottomTabBar from '../shell/BottomTabBar.vue'
import { i18n } from '../i18n'
import { sessionStore } from '../shell/app-runtime'
import { hasConnectedOnce, shellConnectionState } from '../shell/connection-view'

// vitest 运行时 cwd 即包根（vitest.config.ts 所在目录）
const pkgRoot = process.cwd()

describe('A16: safe-area env() 消费存在（样式源断言，TC-8 形态）', () => {
  it('tokens.css 定义四向 --safe-area-* 变量（env(safe-area-inset-*, 0px) 带 0px 回退）', () => {
    const css = readFileSync(resolve(pkgRoot, 'src/styles/tokens.css'), 'utf-8')
    expect(css).toContain('--safe-area-top: env(safe-area-inset-top, 0px)')
    expect(css).toContain('--safe-area-right: env(safe-area-inset-right, 0px)')
    expect(css).toContain('--safe-area-bottom: env(safe-area-inset-bottom, 0px)')
    expect(css).toContain('--safe-area-left: env(safe-area-inset-left, 0px)')
  })

  it('index.html viewport 含 viewport-fit=cover（env() 非零前提，A16 证据锚点）', () => {
    const html = readFileSync(resolve(pkgRoot, 'index.html'), 'utf-8')
    expect(html).toMatch(/name="viewport"[^>]*viewport-fit=cover/)
  })
})

describe('A16: safe-area 布局类挂载（DOM 断言，TC-1 形态）', () => {
  let wrapper: ReturnType<typeof mountApp> | null = null

  function mountApp() {
    return mount(App, { global: { plugins: [i18n] } })
  }

  beforeEach(() => {
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  it('壳根 mobile-shell 挂顶部 + 横向 safe-area 类（顶栏/横向职责，视图态无关）', () => {
    wrapper = mountApp()
    const shell = wrapper.get('[data-testid="mobile-shell"]')
    expect(shell.classes()).toContain('pt-[var(--safe-area-top)]')
    expect(shell.classes()).toContain('pr-[var(--safe-area-right)]')
    expect(shell.classes()).toContain('pl-[var(--safe-area-left)]')
  })

  it('壳根不挂底部 safe-area 类（底部 inset 分治给贴底 chrome，防双倍扣除）', () => {
    wrapper = mountApp()
    const shell = wrapper.get('[data-testid="mobile-shell"]')
    expect(shell.classes()).not.toContain('pb-[var(--safe-area-bottom)]')
  })

  it('connected 态 BottomTabBar 挂底部 safe-area 类（底导航职责）', () => {
    hasConnectedOnce.value = true
    shellConnectionState.value = 'connected'
    wrapper = mountApp()
    const bar = wrapper.get('[data-testid="bottom-tab-bar"]')
    expect(bar.classes()).toContain('pb-[var(--safe-area-bottom)]')
  })

  it('BottomTabBar 独立挂载同样挂底部 safe-area 类（组件自身契约，不依赖 App 接线）', () => {
    const bar = mount(BottomTabBar, {
      global: { plugins: [i18n] },
      props: { modelValue: 'sessions' as const },
    })
    expect(bar.get('[data-testid="bottom-tab-bar"]').classes()).toContain('pb-[var(--safe-area-bottom)]')
    bar.unmount()
  })
})
