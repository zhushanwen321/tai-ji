/**
 * AsyncErrorFallback + defineAsyncComponent 错误兜底链路测试（D-8 §3.5 错误规格）。
 *
 * 覆盖两条运行时断言（AGENTS.md 规则 13：运行时行为必须先验证）：
 * 1. loader 失败 → onError fail → errorComponent 渲染（loadFailed 文案 + 重试按钮），
 *    不抛未捕获异常（async 组件错误不会崩掉整个面板容器）。
 * 2. 重试按钮点击 → 宿主经 LAZY_RETRY_KEY 注入的 retry 回调（defineAsyncComponent 的 userRetry）
 *    重跑 loader → 成功后替换渲染真实内容。
 * 3. loading 态（无 error prop）：轻量 spinner 占位渲染。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/ui/__tests__/AsyncErrorFallback.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineAsyncComponent, defineComponent, h, provide, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import AsyncErrorFallback, { LAZY_RETRY_KEY } from '@/components/ui/AsyncErrorFallback.vue'

// 模拟懒加载 chunk 失败：i18n 真实模块即可（common.loadFailed/common.retry 键已存在），
// 无需 mock useI18n。pinia 仅保险（组件不消费 store，但全局 activePinia 缺失可能警告）。
beforeEach(() => {
  setActivePinia(createPinia())
})

/** 失败一次后成功的 loader（模拟 file:// 下首载 404，重试时恢复）。
 *  返回带 Symbol.toStringTag='Module' 的模块命名空间对象——与 vite 动态 import 的真实产物一致
 *  （defineAsyncComponent load() 依此 unwrap .default）。 */
function makeFlakyLoader(failTimes: number) {
  return vi.fn(() => {
    if (failTimes > 0) {
      failTimes -= 1
      return Promise.reject(new Error('Failed to fetch dynamically imported module'))
    }
    return Promise.resolve({
      default: defineComponent({
        name: 'FlakyContent',
        template: '<div data-testid="flaky-content">loaded</div>',
      }),
      [Symbol.toStringTag]: 'Module',
    })
  })
}

describe('AsyncErrorFallback loading/error 两态渲染', () => {
  it('无 error prop → loading 态（spinner 占位）', () => {
    const wrapper = mount(AsyncErrorFallback)
    expect(wrapper.find('[data-testid="async-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(false)
  })

  it('error prop → error 态（loadFailed 文案 + 重试按钮）', () => {
    const wrapper = mount(AsyncErrorFallback, {
      props: { error: new Error('chunk 404') },
    })
    expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="async-retry-btn"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('重试')
  })

  it('error 态点击重试 → 调用宿主注入的 LAZY_RETRY_KEY 回调', async () => {
    const retrySpy = vi.fn()
    const Host = defineComponent({
      setup() {
        provide(LAZY_RETRY_KEY, retrySpy)
        return () => h(AsyncErrorFallback, { error: new Error('chunk 404') })
      },
    })
    const wrapper = mount(Host)
    await wrapper.find('[data-testid="async-retry-btn"]').trigger('click')
    expect(retrySpy).toHaveBeenCalledTimes(1)
  })
})

describe('AsyncErrorFallback overlay 形态（W31 review minor-4：懒加载弹窗占位不参与宿主布局流）', () => {
  it('overlay=true + error → 占位 fixed 全屏遮罩（与正常 modal 同视觉层级）', () => {
    const wrapper = mount(AsyncErrorFallback, {
      props: { error: new Error('chunk 404'), overlay: true },
    })
    const el = wrapper.find('[data-testid="async-error-fallback"]')
    expect(el.exists()).toBe(true)
    // fixed 定位脱离文档流 → 不作为 AppShell 根 flex 容器的子项挤压 MainPanel
    expect(el.classes()).toContain('fixed')
    expect(el.classes()).not.toContain('h-full')
    // 重试按钮在 overlay 形态下仍可交互（存在性 = 用户可见出口）
    expect(wrapper.find('[data-testid="async-retry-btn"]').exists()).toBe(true)
  })

  it('overlay=true 无 error → loading 占位同样 fixed（loading 超 delay 也不挤压布局）', () => {
    const wrapper = mount(AsyncErrorFallback, { props: { overlay: true } })
    const el = wrapper.find('[data-testid="async-loading"]')
    expect(el.exists()).toBe(true)
    expect(el.classes()).toContain('fixed')
    expect(el.classes()).not.toContain('h-full')
  })

  it('默认形态不变（drawer 内面板占位 h-full w-full，回归防护）', () => {
    const wrapper = mount(AsyncErrorFallback, { props: { error: new Error('chunk 404') } })
    const el = wrapper.find('[data-testid="async-error-fallback"]')
    expect(el.classes()).toContain('h-full')
    expect(el.classes()).not.toContain('fixed')
  })
})

describe('defineAsyncComponent onError → retry → resolve 全链路', () => {
  it('loader 失败一次 → error 占位；点重试 → loader 重跑成功 → 渲染真实内容', async () => {
    const loader = makeFlakyLoader(1)
    let capturedRetry: (() => void) | null = null
    const LazyComp = defineAsyncComponent({
      loader,
      loadingComponent: AsyncErrorFallback,
      errorComponent: AsyncErrorFallback,
      delay: 0, // 测试不等待 200ms delay
      onError: (_err, retry, fail) => {
        capturedRetry = retry
        fail()
      },
    })
    // 宿主镜像真实用法（AppShell/PanelContainer）：retry = userRetry 重跑 loader + key 重挂 wrapper
    // （只 userRetry 不重挂：已 settled 的 pendingRequest 使 resolve 失效，loaded 永不变，UI 卡 error）
    const Host = defineComponent({
      setup() {
        const retryKey = ref(0)
        provide(LAZY_RETRY_KEY, () => {
          capturedRetry?.()
          retryKey.value++
        })
        return () => h(LazyComp, { key: retryKey.value })
      },
    })

    const wrapper = mount(Host)
    await flushPromises()

    // 首次加载失败 → error 占位（非崩溃）
    expect(loader).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="flaky-content"]').exists()).toBe(false)

    // 点重试 → userRetry 重跑 loader + key 重挂 → 成功 → 真实内容替换占位
    await wrapper.find('[data-testid="async-retry-btn"]').trigger('click')
    await flushPromises()

    expect(loader).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="flaky-content"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(false)
  })
})
