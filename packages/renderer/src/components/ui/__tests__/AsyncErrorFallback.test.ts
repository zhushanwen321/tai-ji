/**
 * components/ui 家族 colocated 合并产物（round5-f C3）。
 *
 * 来源（本目录同源四件，环境均为 vitest 默认）：
 *   - AsyncErrorFallback.test.ts（主文件：错误占位两态 + 重试状态机 + 全链路，零 mock）
 *   - InboundFrameDroppedNotice.test.ts（入站丢帧终止阀静态提示）
 *   - RollingRestartBanner.test.ts（滚动重启四态横幅）
 *   - ToastContainer.test.ts（session 定位行 + 排版 + hover 暂停 + 溢出摘要）
 *
 * mock 说明：三条 vi.mock 互异且经 grep 复筛各自只进本节组件链——
 *   - useInboundFrameGuard 仅 InboundFrameDroppedNotice.vue 消费
 *   - useRollingRestartStatus 仅 RollingRestartBanner.vue 消费
 *   - features/sidebar/useSidebar 仅 ToastContainer.vue 消费（只出 selectSession spy）
 * 均为纯派生视图的状态源替换形态，无需保留式改造。
 *
 * 合并纪律：describe/it 名零改动；AsyncErrorFallback / ToastContainer 两节的
 * 原文件级 beforeEach/afterEach 下沉包裹层 describe（作用域与原单文件等价）；
 * 两处 vi.hoisted 的 stateMock 分别改名 inboundStateMock / rollingStateMock 消冲突。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { defineAsyncComponent, defineComponent, effectScope, h, nextTick } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import AsyncErrorFallback from '@/components/ui/AsyncErrorFallback.vue'
import {
  createLazyChunkRetry,
  extractFailedModuleUrl,
  withCacheBust,
  LAZY_RETRY_LIMIT,
  LAZY_RETRY_BACKOFF_BASE_MS,
} from '@/components/ui/lazy-chunk-retry'
import InboundFrameDroppedNotice from '../InboundFrameDroppedNotice.vue'
import type { RollingRestartBannerPhase } from '@/composables/useRollingRestartStatus'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import { useToast, setToastLimiter } from '@/composables/useToast'

/* ════════ 来源：InboundFrameDroppedNotice.test.ts 的状态源 mock ════════ */

const inboundStateMock = vi.hoisted(() => ({
  trippedSessionIds: { value: new Set<string>() },
}))

vi.mock('@/composables/useInboundFrameGuard', () => ({
  useInboundFrameGuardState: () => ({ trippedSessionIds: inboundStateMock.trippedSessionIds }),
}))

/* ════════ 来源：RollingRestartBanner.test.ts 的状态源 mock ════════ */

const rollingStateMock = vi.hoisted(() => ({
  phase: null as unknown as Ref<RollingRestartBannerPhase>,
}))

vi.mock('@/composables/useRollingRestartStatus', async () => {
  const { shallowRef } = await import('vue')
  rollingStateMock.phase = shallowRef({ kind: 'idle' } as RollingRestartBannerPhase)
  return {
    RECOVERED_AUTO_CLEAR_MS: 30_000,
    useRollingRestartStatus: () => ({
      phase: rollingStateMock.phase,
      dismiss: () => { rollingStateMock.phase.value = { kind: 'idle' } },
    }),
  }
})

const RollingRestartBanner = (await import('../RollingRestartBanner.vue')).default

/* ════════ 来源：ToastContainer.test.ts 的状态源 mock ════════ */

const selectSessionSpy = vi.fn()
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ selectSession: selectSessionSpy }),
}))

/* ════════ 来源：AsyncErrorFallback.test.ts（主文件） ════════ */

describe('AsyncErrorFallback', () => {
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
})

/* ════════ 来源：InboundFrameDroppedNotice.test.ts ════════ */

describe('InboundFrameDroppedNotice 入站丢帧终止阀静态提示（D8 / A6）', () => {
  beforeEach(() => {
    inboundStateMock.trippedSessionIds.value = new Set<string>()
  })

  it('终止阀生效 session：提示可见（role=alert + 标题 + 恢复指引）且标题含会话暂停语义', () => {
    inboundStateMock.trippedSessionIds.value = new Set(['s1'])
    const wrapper = mount(InboundFrameDroppedNotice, { props: { sessionId: 's1' } })

    const notice = wrapper.find('[data-testid="inbound-frame-dropped-notice"]')
    expect(notice.exists()).toBe(true)
    expect(notice.attributes('role')).toBe('alert') // 静态错误页形态：响亮降级
    expect(wrapper.find('[data-testid="inbound-frame-dropped-title"]').text()).toBe('本会话数据流已暂停')
    // 恢复指引必须指向唯一恢复动作（切走再切回），不得给「对端自行恢复」的隐性承诺
    expect(wrapper.find('[data-testid="inbound-frame-dropped-hint"]').text()).toContain('切换')
    expect(wrapper.text()).toContain('再切回')
  })

  it('单 session 作用域：tripped 集合含别的 session → 本 session 不渲染（不连坐）', () => {
    inboundStateMock.trippedSessionIds.value = new Set(['other'])
    const wrapper = mount(InboundFrameDroppedNotice, { props: { sessionId: 's1' } })
    expect(wrapper.find('[data-testid="inbound-frame-dropped-notice"]').exists()).toBe(false)
  })

  it('终止阀未生效（集合为空）→ 不渲染', () => {
    const wrapper = mount(InboundFrameDroppedNotice, { props: { sessionId: 's1' } })
    expect(wrapper.find('[data-testid="inbound-frame-dropped-notice"]').exists()).toBe(false)
  })
})

/* ════════ 来源：RollingRestartBanner.test.ts ════════ */

function setPhase(phase: RollingRestartBannerPhase): void {
  rollingStateMock.phase.value = phase
}

describe('RollingRestartBanner 滚动重启四态横幅（D5 / A1）', () => {
  beforeEach(() => {
    setPhase({ kind: 'idle' })
  })

  it('idle：不渲染', () => {
    const wrapper = mount(RollingRestartBanner)
    expect(wrapper.find('[data-testid="rolling-restart-banner"]').exists()).toBe(false)
  })

  it('预告（countdown）：即将自动重启 + 终端会话终止预告 + 关闭按钮可见', () => {
    setPhase({ kind: 'countdown', executesAt: Date.now() + 30_000, inflight: 0 })
    const wrapper = mount(RollingRestartBanner)
    const banner = wrapper.find('[data-testid="rolling-restart-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.attributes('data-phase')).toBe('countdown')
    expect(banner.attributes('role')).toBe('alert')
    const text = wrapper.find('[data-testid="rolling-restart-text"]').text()
    expect(text).toContain('即将自动重启')
    expect(text).toContain('终端会话将随重启终止')
    expect(wrapper.find('[data-testid="rolling-restart-dismiss"]').exists()).toBe(true)
  })

  it('预告退化形态（status 拉取恢复，executesAt 未知）：不含秒数的「即将自动重启」', () => {
    setPhase({ kind: 'countdown', executesAt: 0, inflight: null })
    const wrapper = mount(RollingRestartBanner)
    const text = wrapper.find('[data-testid="rolling-restart-text"]').text()
    expect(text).toContain('即将自动重启')
    expect(text).not.toContain('秒内')
  })

  it('推迟中（deferred）：30 分钟有界等待语义 + 终端会话预告', () => {
    setPhase({ kind: 'deferred', reason: 'inflight', inflight: 2, deferDeadlineAt: Date.now() + 30 * 60_000 })
    const wrapper = mount(RollingRestartBanner)
    const text = wrapper.find('[data-testid="rolling-restart-text"]').text()
    expect(text).toContain('内存接近上限')
    expect(text).toContain('最长等待 30 分钟')
    expect(text).toContain('终端会话将随重启终止')
  })

  it('推迟中 errs 形态（absent-report）：计数未知文案，不展示误导性任务数', () => {
    setPhase({ kind: 'deferred', reason: 'absent-report', inflight: null, deferDeadlineAt: Date.now() + 30 * 60_000 })
    const wrapper = mount(RollingRestartBanner)
    const text = wrapper.find('[data-testid="rolling-restart-text"]').text()
    expect(text).toContain('正在确认后台任务状态')
  })

  it('红牌（rolling / forced）：danger 色调 + 正在重启 runtime 文案', () => {
    setPhase({ kind: 'rolling', reason: 'hard-threshold', inflight: 1 })
    const wrapper = mount(RollingRestartBanner)
    const banner = wrapper.find('[data-testid="rolling-restart-banner"]')
    expect(banner.attributes('data-phase')).toBe('rolling')
    expect(wrapper.find('[data-testid="rolling-restart-icon"]').classes().join(' ')).toContain('text-danger')
    expect(wrapper.find('[data-testid="rolling-restart-text"]').text()).toContain('正在重启 runtime')
  })

  it('已恢复转绿（recovered）：info 色调 + 重启完成文案', () => {
    setPhase({ kind: 'recovered' })
    const wrapper = mount(RollingRestartBanner)
    const banner = wrapper.find('[data-testid="rolling-restart-banner"]')
    expect(banner.attributes('data-phase')).toBe('recovered')
    expect(wrapper.find('[data-testid="rolling-restart-icon"]').classes().join(' ')).toContain('text-info')
    expect(wrapper.find('[data-testid="rolling-restart-text"]').text()).toContain('重启完成')
  })

  it('#27 轻态（reattach-deferred）：高压延迟文案 + 复查周期 + 手动恢复指引', () => {
    setPhase({ kind: 'reattach-deferred', pollMs: 30_000 })
    const wrapper = mount(RollingRestartBanner)
    const banner = wrapper.find('[data-testid="rolling-restart-banner"]')
    expect(banner.attributes('data-phase')).toBe('reattach-deferred')
    const text = wrapper.find('[data-testid="rolling-restart-text"]').text()
    expect(text).toContain('自动恢复已推迟')
    expect(text).toContain('每 30 秒复查')
    expect(text).toContain('手动打开会话')
  })

  it('关闭按钮 → 条消失（用户主动出口）', async () => {
    setPhase({ kind: 'deferred', reason: 'inflight', inflight: 0, deferDeadlineAt: 0 })
    const wrapper = mount(RollingRestartBanner)
    expect(wrapper.find('[data-testid="rolling-restart-banner"]').exists()).toBe(true)
    await wrapper.find('[data-testid="rolling-restart-dismiss"]').trigger('click')
    expect(wrapper.find('[data-testid="rolling-restart-banner"]').exists()).toBe(false)
  })
})

/* ════════ 来源：ToastContainer.test.ts ════════ */

describe('ToastContainer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    selectSessionSpy.mockReset()
  })

  afterEach(() => {
    // 模块级单例：清空在列 toast + 归零丢弃计数，避免跨用例污染
    const { toasts, remove, resetDropped } = useToast()
    for (const t of [...toasts.value]) remove(t.id)
    resetDropped()
    vi.useRealTimers()
  })

  describe('ToastContainer session 定位行', () => {
    it('有 sessionLabel+sessionId → 渲染定位行，点击跳转并关闭 toast', async () => {
      const { toasts, warning } = useToast()
      warning('Goal blocked. Use /goal resume.', {
        sessionLabel: '修通知组件 · taiji',
        sessionId: 'sid-9',
      })
      const wrapper = mount(ToastContainer)
      const id = toasts.value[0].id

      const locator = wrapper.find(`[data-testid="toast-session-${id}"]`)
      expect(locator.exists()).toBe(true)
      expect(locator.text()).toContain('修通知组件 · taiji')

      await locator.trigger('click')
      expect(selectSessionSpy).toHaveBeenCalledWith('sid-9')
      expect(toasts.value).toHaveLength(0) // 跳转后关闭
    })

    it('无 sessionLabel → 不渲染定位行（纯消息形态）', () => {
      const { toasts, info } = useToast()
      info('plain message')
      const wrapper = mount(ToastContainer)

      expect(wrapper.find(`[data-testid="toast-session-${toasts.value[0].id}"]`).exists()).toBe(false)
      expect(wrapper.find(`[data-testid="toast-message-${toasts.value[0].id}"]`).exists()).toBe(true)
    })
  })

  describe('ToastContainer 尺寸与多行排版', () => {
    it('消息体带 pre-line + line-clamp-5，容器 max-w 收敛', () => {
      const { toasts, info } = useToast()
      info('第一行\n第二行\n第三行')
      const wrapper = mount(ToastContainer)

      const body = wrapper.find(`[data-testid="toast-message-${toasts.value[0].id}"]`)
      expect(body.classes()).toContain('whitespace-pre-line')
      expect(body.classes()).toContain('line-clamp-5')
      expect(body.classes()).toContain('break-words')

      const card = body.element.closest('div.pointer-events-auto') as HTMLElement
      expect(card.className).toContain('max-w-[min(360px,100%)]')
    })

    it('定位契约：absolute 右上角锚定（非视口 fixed），随挂载点（main-area/main）定位', () => {
      const wrapper = mount(ToastContainer)

      // 容器即 TransitionGroup tag 元素（测试环境 VTU 将其 stub，class 透传在 stub 元素上）
      const container = wrapper.find('.absolute')
      expect(container.exists()).toBe(true)
      expect(container.classes()).toContain('top-4')
      expect(container.classes()).toContain('inset-x-4')
      expect(container.classes()).not.toContain('fixed')
      expect(container.classes()).not.toContain('bottom-6')
    })
  })

  describe('ToastContainer hover 暂停自动移除', () => {
    it('mouseenter 冻结计时，mouseleave 按剩余时长续走', async () => {
      vi.useFakeTimers()
      const { toasts, info } = useToast()
      info('hover to read')
      const wrapper = mount(ToastContainer)
      const id = toasts.value[0].id
      const card = wrapper.find('div.pointer-events-auto')

      await card.trigger('mouseenter')
      vi.advanceTimersByTime(10_000) // 暂停期间不消失
      expect(toasts.value).toHaveLength(1)

      await card.trigger('mouseleave')
      vi.advanceTimersByTime(4000) // 恢复后到期移除
      await nextTick() // timer 回调改 toasts 后 DOM 异步重渲染
      expect(toasts.value).toHaveLength(0)
      expect(wrapper.find(`[data-testid="toast-message-${id}"]`).exists()).toBe(false)
    })
  })

  describe('ToastContainer 溢出折叠摘要（RD-3#7：droppedCount 的 UI 消费方）', () => {
    it('droppedCount > 0 → 渲染「还有 N 条」摘要；点击关闭归零（resetDropped）', async () => {
      const { info, droppedCount, resetDropped } = useToast()
      // 恒丢弃限流器强制产生一次丢弃（不依赖逐个入列到 MAX_IN_FLIGHT）
      setToastLimiter(() => true)
      info('dropped-1')
      expect(droppedCount.value).toBeGreaterThan(0)
      setToastLimiter(null) // 恢复默认，避免影响其它用例

      const wrapper = mount(ToastContainer)
      const summary = wrapper.find('[data-testid="toast-overflow-summary"]')
      expect(summary.exists()).toBe(true)
      // 摘要文案含当前 droppedCount（i18n mock 从 zh-CN 取词，{count} 已替换）
      expect(wrapper.find('[data-testid="toast-overflow-text"]').text()).toContain(String(droppedCount.value))

      // 点击关闭 → resetDropped 归零 → 摘要消失（droppedCount 有消费 + 重置出口）
      await summary.find('button').trigger('click')
      expect(droppedCount.value).toBe(0)
      expect(wrapper.find('[data-testid="toast-overflow-summary"]').exists()).toBe(false)

      resetDropped() // 兜底归零（幂等）
    })

    it('droppedCount = 0 → 不渲染摘要（默认态无溢出）', () => {
      const wrapper = mount(ToastContainer)
      expect(wrapper.find('[data-testid="toast-overflow-summary"]').exists()).toBe(false)
    })
  })
})
