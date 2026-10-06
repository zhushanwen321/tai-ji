/**
 * AsyncErrorFallback + 内部自动重试链路测试（D-8 §3.5 错误规格 · D6 交付后修复改版）。
 *
 * 2026-10-03 用户裁决：界面无重试按钮——装载失败由 createLazyChunkRetry 内部有界自动重试
 * 承接（3 次 × 300ms 递增退避 + 失败 URL 提取 ?t=N cache-busting 绕过 module map 记忆化），
 * 穷尽后才呈现错误态（文案给「关闭重开恢复」指引）。本文件覆盖：
 *
 * 1. AsyncErrorFallback 两态渲染：error 态 = 加载失败文案 + 穷尽指引文案 + **无重试按钮**；
 *    loading 态 spinner 占位（不变）；overlay / 默认形态断言（不变）。
 * 2. helper 纯函数：extractFailedModuleUrl（Chromium 错误格式 → URL）/ withCacheBust。
 * 3. createLazyChunkRetry 状态机（bustedImport 注入 spy）：退避调度次数/间隔、?t=N 递增、
 *    穷尽 userFail、fresh mount 重置、scope 卸载清 timer。
 * 4. defineAsyncComponent 全链路（vi.mock 工厂错误无 URL → 回落同 URL 机械重试路径）：
 *    失败一次 → 自动重试 → 内容渲染，全程无按钮。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/ui/__tests__/AsyncErrorFallback.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { defineAsyncComponent, defineComponent, effectScope, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import AsyncErrorFallback from '@/components/ui/AsyncErrorFallback.vue'
import {
  createLazyChunkRetry,
  extractFailedModuleUrl,
  withCacheBust,
  LAZY_RETRY_LIMIT,
  LAZY_RETRY_BACKOFF_BASE_MS,
} from '@/components/ui/lazy-chunk-retry'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AsyncErrorFallback loading/error 两态渲染（D6：无重试按钮）', () => {
  it('无 error prop → loading 态（spinner 占位）', () => {
    const wrapper = mount(AsyncErrorFallback)
    expect(wrapper.find('[data-testid="async-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(false)
  })

  it('error prop → error 态：加载失败文案 + 自动重试穷尽指引 + 无重试按钮', () => {
    const wrapper = mount(AsyncErrorFallback, {
      props: { error: new Error('chunk 404') },
    })
    expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(true)
    // [D6 用户裁决] 界面不出现重试按钮——重试由系统内部自动执行
    expect(wrapper.find('[data-testid="async-retry-btn"]').exists()).toBe(false)
    // 文案给恢复指引：穷尽次数 + 关闭重开 + Esc/⌘W 退出
    expect(wrapper.text()).toContain('加载失败')
    expect(wrapper.text()).toContain(`已自动重试 ${LAZY_RETRY_LIMIT} 次`)
    expect(wrapper.text()).toContain('关闭后重新打开可恢复')
    expect(wrapper.text()).toContain('Esc / ⌘W')
  })

  it('overlay=true + error → 占位 fixed 全屏遮罩（不参与宿主布局流），指引文案随形态保留', () => {
    const wrapper = mount(AsyncErrorFallback, {
      props: { error: new Error('chunk 404'), overlay: true },
    })
    const el = wrapper.find('[data-testid="async-error-fallback"]')
    expect(el.exists()).toBe(true)
    expect(el.classes()).toContain('fixed')
    expect(el.classes()).not.toContain('h-full')
    expect(wrapper.find('[data-testid="async-retry-btn"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('关闭后重新打开可恢复')
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

describe('helper 纯函数', () => {
  it('extractFailedModuleUrl：Chromium 装载失败错误格式提取 URL；非 URL 形错误返回 null', () => {
    // 探针实测的 Chromium 错误格式（file:// 与 asar 同形）
    expect(
      extractFailedModuleUrl(new Error('Failed to fetch dynamically imported module: file:///app/renderer/assets/DetailPane-abc123.js')),
    ).toBe('file:///app/renderer/assets/DetailPane-abc123.js')
    expect(
      extractFailedModuleUrl(new Error('Failed to fetch dynamically imported module: http://localhost:1420/src/components/panel/DetailPane.vue')),
    ).toBe('http://localhost:1420/src/components/panel/DetailPane.vue')
    // vi.mock 工厂抛错 / 非装载类错误：无 URL 可提取 → null（重试回落同 URL 机械路径）
    expect(extractFailedModuleUrl(new Error('Failed to fetch dynamically imported module'))).toBeNull()
    expect(extractFailedModuleUrl(new Error('boom'))).toBeNull()
    expect(extractFailedModuleUrl(undefined)).toBeNull()
    // 回归防护（D6 实测）：vitest 包装错误消息内嵌文档 URL，前缀不匹配必须不误提取，
    // 否则 busting 分支会 import 无关 URL 永远失败
    expect(
      extractFailedModuleUrl(
        new Error('[vitest] There was an error when mocking a module. If you are using "vi.mock" factory … https://vitest.dev/api/vi.html#vi-mock'),
      ),
    ).toBeNull()
  })

  it('withCacheBust：无 query 追加 ?t=N；已有 t= 替换；已有其他 query 用 & 连接', () => {
    expect(withCacheBust('file:///assets/DetailPane-abc123.js', 1)).toBe('file:///assets/DetailPane-abc123.js?t=1')
    expect(withCacheBust('http://localhost:5173/src/X.vue?t=1759', 3)).toBe('http://localhost:5173/src/X.vue?t=3')
    expect(withCacheBust('http://localhost:5173/src/X.vue?a=1', 2)).toBe('http://localhost:5173/src/X.vue?a=1&t=2')
  })
})

/** 带 URL 的装载失败错误（busting 路径的注入形态） */
function fetchFail(url: string): Error {
  return new Error(`Failed to fetch dynamically imported module: ${url}`)
}

describe('createLazyChunkRetry 状态机（bustedImport spy 注入）', () => {
  /** 状态机单测驱动形态：镜像 Vue 实装——userRetry 回调 = retry() = 同步调 loader（清链重跑）；
   *  首载由测试显式调 retry.loader() 模拟 wrapper mount 的 load。 */
  function setup(load: () => Promise<unknown>, busted?: (url: string) => Promise<unknown>) {
    const bustedImport = busted ?? vi.fn()
    const retry = createLazyChunkRetry(load, { bustedImport })
    const onError = (err: unknown) => {
      const failSpy = vi.fn()
      // promise 卫生：重跑链的 rejection 由下一次 onError 断言消费（或故意不消费），
      // 这里必须显式接住——`void` 不阻止 unhandledRejection（Node 语义：无 handler 即报），
      // 否则机械重试/重跑仍败的用例会以「全绿 + exit 1」泄漏（2026-10-03 实测 6 例）。
      retry.onError(err, () => { retry.loader().catch(() => {}) }, failSpy)
      return Promise.resolve(failSpy)
    }
    return { retry, bustedImport, onError }
  }

  it('首载失败（URL 形错误）→ 300ms 退避后 retryKey++ → 重挂 load 走 busted import ?t=1', async () => {
    const chunkUrl = 'file:///app/renderer/assets/DetailPane-abc123.js'
    const moduleShape = { default: {}, [Symbol.toStringTag]: 'Module' }
    const bustedImport = vi.fn(() => Promise.resolve(moduleShape))
    const { retry, onError } = setup(() => Promise.reject(fetchFail(chunkUrl)), bustedImport)
    // 首载（mount 的 load）失败 → loader 内提取失败 URL（busting 目标）
    await expect(retry.loader()).rejects.toThrow()
    // Vue catch → onError → 第 1 轮调度（300ms × 1 退避）
    expect(await onError(fetchFail(chunkUrl))).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(LAZY_RETRY_BACKOFF_BASE_MS - 1)
    expect(bustedImport).not.toHaveBeenCalled()
    expect(retry.retryKey.value).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(retry.retryKey.value).toBe(1)
    // 到点 userRetry 已同步重跑 loader → busted 分支（?t=1 绕过 module map 记忆化）
    expect(bustedImport).toHaveBeenCalledTimes(1)
    expect(bustedImport).toHaveBeenCalledWith(`${chunkUrl}?t=1`)
  })

  it('持续失败 → ?t=1/2/3 三次 busting（300/600/900 递增）→ 穷尽 userFail 且不再调度', async () => {
    const chunkUrl = 'file:///app/renderer/assets/DetailPane-abc123.js'
    const bustedImport = vi.fn(() => Promise.reject(fetchFail(chunkUrl)))
    const { retry, onError } = setup(() => Promise.reject(fetchFail(chunkUrl)), bustedImport)

    // 首载失败 → 第 1 轮（300ms）：到点 userRetry 同步重跑 loader 走 busted ?t=1
    await expect(retry.loader()).rejects.toThrow()
    expect(await onError(fetchFail(chunkUrl))).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(LAZY_RETRY_BACKOFF_BASE_MS)
    expect(bustedImport).toHaveBeenCalledWith(`${chunkUrl}?t=1`)
    // 第 1 轮失败 → 第 2 轮（600ms）
    await onError(fetchFail(`${chunkUrl}?t=1`))
    await vi.advanceTimersByTimeAsync(LAZY_RETRY_BACKOFF_BASE_MS * 2)
    expect(bustedImport).toHaveBeenCalledWith(`${chunkUrl}?t=2`)
    // 第 2 轮失败 → 第 3 轮（900ms）
    await onError(fetchFail(`${chunkUrl}?t=2`))
    await vi.advanceTimersByTimeAsync(LAZY_RETRY_BACKOFF_BASE_MS * 3)
    expect(bustedImport).toHaveBeenCalledWith(`${chunkUrl}?t=3`)
    expect(retry.retryKey.value).toBe(3)
    // 第 3 轮失败 → 穷尽：userFail 被调、不再调度
    const failSpy = vi.fn()
    retry.onError(fetchFail(`${chunkUrl}?t=3`), () => {}, failSpy)
    expect(failSpy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(bustedImport).toHaveBeenCalledTimes(3)
  })

  it('提取不到 URL（非装载类错误）→ 回落同 URL 机械重试（bustedImport 不被调用，loader 重跑）', async () => {
    const load = vi.fn(() => Promise.reject(new Error('boom')))
    const bustedImport = vi.fn()
    const { retry, onError } = setup(load, bustedImport)
    // 首载失败（无 URL 可提取）
    await expect(retry.loader()).rejects.toThrow('boom')
    await onError(new Error('boom'))
    await vi.advanceTimersByTimeAsync(LAZY_RETRY_BACKOFF_BASE_MS)
    expect(retry.retryKey.value).toBe(1)
    // 到点 userRetry 已同步重跑原静态 loader（同 URL 机械路径），bustedImport 不参与
    expect(bustedImport).not.toHaveBeenCalled()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('fresh mount（无重挂标记）重置计数与 bust 目标：重开挂载点 = 全新一轮（300ms 基准、?t 从 1 递增）', async () => {
    const chunkUrl = 'file:///app/renderer/assets/DetailPane-abc123.js'
    const moduleShape = { default: {}, [Symbol.toStringTag]: 'Module' }
    let bustedShouldSucceed = false
    const bustedImport = vi.fn(() =>
      bustedShouldSucceed ? Promise.resolve(moduleShape) : Promise.reject(fetchFail(chunkUrl)),
    )
    const { retry, onError } = setup(() => Promise.reject(fetchFail(chunkUrl)), bustedImport)

    // 造出「第 2 轮调度中」：首载失败 → 第 1 轮（?t=1 失败）→ 第 2 轮调度（attempt=2, 600ms）
    await expect(retry.loader()).rejects.toThrow()
    await onError(fetchFail(chunkUrl))
    await vi.advanceTimersByTimeAsync(LAZY_RETRY_BACKOFF_BASE_MS)
    await onError(fetchFail(`${chunkUrl}?t=1`))
    await vi.advanceTimersByTimeAsync(LAZY_RETRY_BACKOFF_BASE_MS * 2)
    expect(retry.retryKey.value).toBe(2)

    // fresh mount（重开挂载点，无 expectRemount 标记）→ 计数/bust 清零 → 静态分支重跑失败重新提取
    await expect(retry.loader()).rejects.toThrow()
    bustedShouldSucceed = true
    expect(await onError(fetchFail(chunkUrl))).not.toHaveBeenCalled()
    // 若计数未重置（应为 2、600ms），此处 300ms 推进不会触发重试——触发即证重置生效；
    // 新一轮 busting 从 ?t=1 重新递增（真实浏览器里 ?t=1 若上一轮已成功缓存则直接命中零请求）
    await vi.advanceTimersByTimeAsync(LAZY_RETRY_BACKOFF_BASE_MS)
    expect(retry.retryKey.value).toBe(3)
    expect(bustedImport).toHaveBeenLastCalledWith(`${chunkUrl}?t=1`)
  })

  it('busting 成功后计数归零；同轮后续失败从基准重算（bustUrl 同轮复用，?t=1 命中成功缓存）', async () => {
    const chunkUrl = 'file:///app/renderer/assets/DetailPane-abc123.js'
    const moduleShape = { default: {}, [Symbol.toStringTag]: 'Module' }
    let bustedShouldSucceed = true
    const bustedImport = vi.fn(() =>
      bustedShouldSucceed ? Promise.resolve(moduleShape) : Promise.reject(fetchFail(chunkUrl)),
    )
    const { retry, onError } = setup(() => Promise.reject(fetchFail(chunkUrl)), bustedImport)

    // 首载失败 → 第 1 轮 busted ?t=1 成功 → attempt 归零（bust 分支与静态分支同一归零语义）
    await expect(retry.loader()).rejects.toThrow()
    await onError(fetchFail(chunkUrl))
    await vi.advanceTimersByTimeAsync(LAZY_RETRY_BACKOFF_BASE_MS)
    expect(bustedImport).toHaveBeenCalledTimes(1)

    // 同轮再来一次失败（未 fresh）：从基准重算（300ms、?t=1）而非累计（600ms、?t=2）
    await onError(fetchFail(chunkUrl))
    await vi.advanceTimersByTimeAsync(LAZY_RETRY_BACKOFF_BASE_MS)
    expect(retry.retryKey.value).toBe(2)
    expect(bustedImport).toHaveBeenLastCalledWith(`${chunkUrl}?t=1`)
  })

  it('scope 卸载 → 清挂起的重试 timer（卸载后不再驱动重挂）', async () => {
    const chunkUrl = 'file:///app/renderer/assets/DetailPane-abc123.js'
    const bustedImport = vi.fn(() => Promise.resolve({}))
    const scope = effectScope()
    let captured: ReturnType<typeof createLazyChunkRetry> | null = null
    scope.run(() => {
      captured = createLazyChunkRetry(() => Promise.reject(fetchFail(chunkUrl)), { bustedImport })
    })
    const retry = captured!
    const failSpy = vi.fn()
    retry.onError(fetchFail(chunkUrl), () => {}, failSpy)
    expect(failSpy).not.toHaveBeenCalled()
    scope.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(bustedImport).not.toHaveBeenCalled()
    expect(retry.retryKey.value).toBe(0)
  })
})

describe('defineAsyncComponent × createLazyChunkRetry 全链路（vi.mock 无 URL 错误 → 同 URL 机械重试路径）', () => {
  // [HISTORICAL] 用例间 wrapper 必须自动 unmount（原因见 panel-container-drawer-mode.test.ts 同注释）
  enableAutoUnmount(afterEach)

  it('loader 失败一次 → 自动重试（无按钮）→ 内容渲染', async () => {
    let calls = 0
    const retryState = createLazyChunkRetry(() => {
      calls++
      if (calls === 1) return Promise.reject(new Error('Failed to fetch dynamically imported module'))
      return Promise.resolve({
        default: defineComponent({
          name: 'FlakyContent',
          template: '<div data-testid="flaky-content">loaded</div>',
        }),
        [Symbol.toStringTag]: 'Module',
      })
    })
    const LazyComp = defineAsyncComponent({
      loader: retryState.loader,
      loadingComponent: AsyncErrorFallback,
      errorComponent: AsyncErrorFallback,
      delay: 0,
      onError: retryState.onError,
    })
    // 镜像真实消费方（AppShell/PanelContainer）：:key 绑 retryKey——重试由重挂单通道驱动
    const Host = defineComponent({
      setup: () => () => h(LazyComp, { key: retryState.retryKey.value }),
    })

    const wrapper = mount(Host)
    await flushPromises()
    // 首载失败：未穷尽 → onError 只调度不 fail → load promise 恒 pending → wrapper 停在
    // loading 占位（**非错误态**——瞬时失败不闪错误，穷尽才呈现错误态，见 helper 头注）
    expect(calls).toBe(1)
    expect(wrapper.find('[data-testid="async-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="async-retry-btn"]').exists()).toBe(false)

    // 内部自动重试（300ms 退避 → retryKey 重挂 → loader 重跑）→ 内容渲染
    await vi.advanceTimersByTimeAsync(LAZY_RETRY_BACKOFF_BASE_MS)
    await flushPromises()
    expect(calls).toBe(2)
    expect(wrapper.find('[data-testid="flaky-content"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(false)
  })
})
