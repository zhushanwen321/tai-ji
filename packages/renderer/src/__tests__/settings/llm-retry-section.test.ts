/**
 * SystemLlmRetrySection 测试（llm-retry-settings u3，三视角）。
 *
 * 覆盖：
 *  - 首屏渲染：mock getRetryConfig 全量 → 基础区三控件显示存量值 + 预览行含「3 次」与时长；
 *  - 预览行实时性：改 maxRetries=10 / baseDelay=5 → 预览实时重算（85.25 分钟量级 → fmtDur 渲染为 1.4 小时）；
 *    小数秒可达：baseDelay=59.999 + maxRetries=1 → 59999ms 档位边界进位渲染「1 分钟」；
 *    关闭开关 → 预览行变「自动重试已关闭」；
 *  - 高级折叠区：默认收起 → 点 toggle 后 provider 三输入可见；
 *  - 保存成功：秒转 ms 组装（baseDelay 5 秒 → baseDelayMs 5000）+ 成功 toast 含「新会话生效」；
 *  - 保存越界：baseDelay=99999 → setRetryConfig 不被调 + 错误 toast 含「超出范围」+ 输入框标红 class；
 *  - configured 徽标：false 无 / true 有「已自定义」；
 *  - 存量超域：maxRetries=50 → 行内警示 llm-retry-warn-maxRetries；
 *  - provider 存量超域：maxRetries=15 原样回填 → 保存被拒，错误 toast 指向 provider.maxRetries
 *    （D8：超域不得因显示为空而静默丢失）；
 *  - provider 存量非整秒域内值：timeoutMs/maxRetryDelayMs=1500 → 回填 "1.5"/"1.5"，保存 Math.round
 *    回存 1500（小数秒输入合法化，修复前被拒「请输入合法数字」）；
 *  - provider 全未设：三输入留空 = 未设 → 保存成功，载荷 provider 键值为 undefined（留空路径回归）；
 *  - 小数秒组装：baseDelay=1.005 → baseDelayMs 1005（Math.round 消浮点尾差，校验通过）。
 *
 * mock 策略：vi.mock core transport config 域（dev-merge 后组件直引 @taiji/core/transport/api/domains/config）替换读写 RPC；toast 走 useToast mock 捕获。
 *
 * 运行：npx vitest run src/__tests__/settings/llm-retry-section.test.ts（packages/renderer 目录）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

const configApiMock = vi.hoisted(() => ({
  getRetryConfig: vi.fn(),
  setRetryConfig: vi.fn(),
  onRetryConfig: vi.fn(() => () => {}),
}))
const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@taiji/core/transport/api/domains/config', () => configApiMock)
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ info: toastMock.info, error: toastMock.error, warning: vi.fn() }),
}))

import SystemLlmRetrySection from '@/components/settings/system/SystemLlmRetrySection.vue'
import zhCN from '@/i18n/locales/zh-CN/settings'
import type { LlmRetryConfig } from '@taiji/shared'

function makeI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: { 'zh-CN': { settings: zhCN.default ?? zhCN } },
  })
}

function defaultFixture(): { configured: boolean; config: LlmRetryConfig } {
  return {
    configured: false,
    config: {
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
      provider: { maxRetries: 0, maxRetryDelayMs: 60000 },
    },
  }
}

function mountSection() {
  return mount(SystemLlmRetrySection, {
    global: { plugins: [makeI18n()] },
  })
}

/** 改 Input 值（v-model.number 经 input 事件同步）。 */
async function setInput(wrapper: ReturnType<typeof mount>, testid: string, value: string) {
  const input = wrapper.find(`[data-testid="${testid}"]`)
  ;(input.element as HTMLInputElement).value = value
  await input.trigger('input')
  await input.trigger('change')
}

beforeEach(() => {
  vi.clearAllMocks()
  configApiMock.getRetryConfig.mockResolvedValue(defaultFixture())
  configApiMock.setRetryConfig.mockResolvedValue({ ok: true })
})

describe('SystemLlmRetrySection（u3 LLM 调用重试）', () => {
  it('首屏渲染：三控件显示存量值，预览行含「3 次」与时长文本', async () => {
    const wrapper = mountSection()
    await flushPromises()

    expect((wrapper.find('[data-testid="llm-retry-max-retries-input"]').element as HTMLInputElement).value).toBe('3')
    expect((wrapper.find('[data-testid="llm-retry-base-delay-input"]').element as HTMLInputElement).value).toBe('2')
    expect(wrapper.find('[data-testid="llm-retry-enabled-switch"]').attributes('data-state')).toBe('checked')

    const preview = wrapper.find('[data-testid="llm-retry-preview"]').text()
    // n=3 base=2s：最长单次 8 秒、累计 14 秒（用户可见实时后果预览）
    expect(preview).toContain('3 次')
    expect(preview).toContain('8 秒')
    expect(preview).toContain('14 秒')
  })

  it('预览行实时重算：maxRetries=10 / baseDelay=5 → 「10 次」+ 85 分钟量级时长（fmtDur 渲染为 1.4 小时）', async () => {
    const wrapper = mountSection()
    await flushPromises()

    await setInput(wrapper, 'llm-retry-max-retries-input', '10')
    await setInput(wrapper, 'llm-retry-base-delay-input', '5')

    const preview = wrapper.find('[data-testid="llm-retry-preview"]').text()
    expect(preview).toContain('10 次')
    // 5*(2^10-1)=5115s≈85.25 分钟量级，fmtDur ≥60 分钟走小时档（85.25/60 → 渲染 1.4 小时）
    expect(preview).toContain('1.4 小时')
  })

  it('小数秒预览可达：maxRetries=1 / baseDelay=59.999 → 预览行进位为「1 分钟」', async () => {
    const wrapper = mountSection()
    await flushPromises()

    await setInput(wrapper, 'llm-retry-max-retries-input', '1')
    await setInput(wrapper, 'llm-retry-base-delay-input', '59.999')

    const preview = wrapper.find('[data-testid="llm-retry-preview"]').text()
    // 59.999s × 2^0 = 59999ms：显示精度 60.0 秒 → 档位边界进位为 1 分钟（最长单次与累计同值）
    expect(preview).toContain('1 分钟')
  })

  it('关闭开关 → 预览行变为「自动重试已关闭」文案', async () => {
    const wrapper = mountSection()
    await flushPromises()

    await wrapper.find('[data-testid="llm-retry-enabled-switch"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="llm-retry-enabled-switch"]').attributes('data-state')).toBe('unchecked')
    expect(wrapper.find('[data-testid="llm-retry-preview"]').text()).toContain('自动重试已关闭')
  })

  it('高级折叠区：默认收起，点 toggle 后 provider 三输入可见', async () => {
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="llm-retry-provider-max-retries-input"]').exists()).toBe(false)

    await wrapper.find('[data-testid="llm-retry-advanced-toggle"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="llm-retry-provider-max-retries-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="llm-retry-provider-timeout-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="llm-retry-provider-max-delay-input"]').exists()).toBe(true)
    // 存量 provider 值落表单：maxRetries=0；timeout 未设 → 空；maxDelay 60000ms → 60 秒
    expect((wrapper.find('[data-testid="llm-retry-provider-max-retries-input"]').element as HTMLInputElement).value).toBe('0')
    expect((wrapper.find('[data-testid="llm-retry-provider-timeout-input"]').element as HTMLInputElement).value).toBe('')
    expect((wrapper.find('[data-testid="llm-retry-provider-max-delay-input"]').element as HTMLInputElement).value).toBe('60')
  })

  it('保存成功：秒转 ms 组装（baseDelay 5 秒 → baseDelayMs 5000）+ toast 含「新会话生效」', async () => {
    const wrapper = mountSection()
    await flushPromises()

    await setInput(wrapper, 'llm-retry-base-delay-input', '5')
    await wrapper.find('[data-testid="llm-retry-save-btn"]').trigger('click')
    await flushPromises()

    expect(configApiMock.setRetryConfig).toHaveBeenCalledTimes(1)
    expect(configApiMock.setRetryConfig).toHaveBeenCalledWith({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 5000,
      // 高级区存量值（fixture provider.maxRetries=0 / maxRetryDelayMs=60000ms→60 秒）随整体保存回传
      provider: { maxRetries: 0, maxRetryDelayMs: 60000 },
    })
    expect(toastMock.info).toHaveBeenCalledWith('已保存，新会话生效')
  })

  it('小数秒组装：baseDelay=1.005 → baseDelayMs 1005（Math.round 消浮点尾差，校验通过保存成功）', async () => {
    const wrapper = mountSection()
    await flushPromises()

    await setInput(wrapper, 'llm-retry-base-delay-input', '1.005')
    await wrapper.find('[data-testid="llm-retry-save-btn"]').trigger('click')
    await flushPromises()

    expect(configApiMock.setRetryConfig).toHaveBeenCalledTimes(1)
    expect(configApiMock.setRetryConfig).toHaveBeenCalledWith({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 1005,
      provider: { maxRetries: 0, maxRetryDelayMs: 60000 },
    })
    expect(toastMock.error).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('保存越界：baseDelay=99999 → setRetryConfig 不被调 + toast 含「超出范围」+ 输入框标红', async () => {
    const wrapper = mountSection()
    await flushPromises()

    await setInput(wrapper, 'llm-retry-base-delay-input', '99999')
    await wrapper.find('[data-testid="llm-retry-save-btn"]').trigger('click')
    await flushPromises()

    expect(configApiMock.setRetryConfig).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error.mock.calls[0][0]).toContain('超出范围')
    const input = wrapper.find('[data-testid="llm-retry-base-delay-input"]')
    expect(input.classes()).toContain('border-warn')
  })

  it('configured 徽标：false 不出现「已自定义」；true 出现', async () => {
    const wrapper1 = mountSection()
    await flushPromises()
    expect(wrapper1.find('[data-testid="llm-retry-configured-badge"]').exists()).toBe(false)
    expect(wrapper1.text()).not.toContain('已自定义')
    wrapper1.unmount()

    configApiMock.getRetryConfig.mockResolvedValue({ ...defaultFixture(), configured: true })
    const wrapper2 = mountSection()
    await flushPromises()
    expect(wrapper2.find('[data-testid="llm-retry-configured-badge"]').exists()).toBe(true)
    expect(wrapper2.find('[data-testid="llm-retry-configured-badge"]').text()).toContain('已自定义')
    wrapper2.unmount()
  })

  it('存量超域：maxRetries=50 → 对应行出现警示标注（llm-retry-warn-maxRetries）', async () => {
    const fixture = defaultFixture()
    fixture.config.maxRetries = 50
    configApiMock.getRetryConfig.mockResolvedValue(fixture)

    const wrapper = mountSection()
    await flushPromises()

    const warn = wrapper.find('[data-testid="llm-retry-warn-maxRetries"]')
    expect(warn.exists()).toBe(true)
    expect(warn.text()).toContain('50')
    expect(warn.text()).toContain('超出推荐范围')
    // 超域存量原样展示
    expect((wrapper.find('[data-testid="llm-retry-max-retries-input"]').element as HTMLInputElement).value).toBe('50')
    wrapper.unmount()
  })

  it('provider 存量超域：maxRetries=15 原样回填 → 保存被拒，错误 toast 指向 provider.maxRetries', async () => {
    const fixture = defaultFixture()
    fixture.config.provider = { maxRetries: 15 }
    configApiMock.getRetryConfig.mockResolvedValue(fixture)

    const wrapper = mountSection()
    await flushPromises()

    await wrapper.find('[data-testid="llm-retry-advanced-toggle"]').trigger('click')
    await flushPromises()

    // 超域数值原样回填（不再显示为空），且行内标注指向该字段
    expect((wrapper.find('[data-testid="llm-retry-provider-max-retries-input"]').element as HTMLInputElement).value).toBe('15')
    const warn = wrapper.find('[data-testid="llm-retry-warn-provider-maxRetries"]')
    expect(warn.exists()).toBe(true)
    expect(warn.text()).toContain('15')

    await wrapper.find('[data-testid="llm-retry-save-btn"]').trigger('click')
    await flushPromises()

    // 用户未改任何字段直接保存 → 校验拒绝且错误指向超域字段（D8：超域不得静默丢失）
    expect(configApiMock.setRetryConfig).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error.mock.calls[0][0]).toContain('provider.maxRetries')
    expect(toastMock.error.mock.calls[0][0]).toContain('超出范围')
    expect(toastMock.error.mock.calls[0][0]).toContain('15')
    expect(wrapper.find('[data-testid="llm-retry-provider-max-retries-input"]').classes()).toContain('border-warn')
    wrapper.unmount()
  })

  it('存量非整秒域内值回存：timeoutMs=1500 / maxRetryDelayMs=1500 → 回填 "1.5"/"1.5"，保存载荷 1500/1500', async () => {
    const fixture = defaultFixture()
    fixture.config.provider = { timeoutMs: 1500, maxRetryDelayMs: 1500 }
    configApiMock.getRetryConfig.mockResolvedValue(fixture)

    const wrapper = mountSection()
    await flushPromises()

    await wrapper.find('[data-testid="llm-retry-advanced-toggle"]').trigger('click')
    await flushPromises()

    // 秒口径回填保留非整秒精度（1500ms → "1.5"），且按 ms 判域 → 不出超域标注
    expect((wrapper.find('[data-testid="llm-retry-provider-timeout-input"]').element as HTMLInputElement).value).toBe('1.5')
    expect((wrapper.find('[data-testid="llm-retry-provider-max-delay-input"]').element as HTMLInputElement).value).toBe('1.5')
    expect(wrapper.find('[data-testid="llm-retry-warn-provider-timeoutMs"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="llm-retry-warn-provider-maxRetryDelayMs"]').exists()).toBe(false)

    // 不改输入直接保存 → Math.round(1.5×1000)=1500 原样回存，校验通过（修复前被拒「请输入合法数字」）
    await wrapper.find('[data-testid="llm-retry-save-btn"]').trigger('click')
    await flushPromises()

    expect(configApiMock.setRetryConfig).toHaveBeenCalledTimes(1)
    expect(configApiMock.setRetryConfig).toHaveBeenCalledWith({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
      provider: { timeoutMs: 1500, maxRetryDelayMs: 1500 },
    })
    expect(toastMock.error).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('provider 全未设：三输入留空 = 未设 → 保存成功，载荷 provider 为 undefined（留空路径回归）', async () => {
    const fixture = defaultFixture()
    fixture.config.provider = undefined
    configApiMock.getRetryConfig.mockResolvedValue(fixture)

    const wrapper = mountSection()
    await flushPromises()

    await wrapper.find('[data-testid="llm-retry-advanced-toggle"]').trigger('click')
    await flushPromises()
    // 未设 → 三个 provider 输入均为空（不回填超域值）
    expect((wrapper.find('[data-testid="llm-retry-provider-max-retries-input"]').element as HTMLInputElement).value).toBe('')
    expect((wrapper.find('[data-testid="llm-retry-provider-timeout-input"]').element as HTMLInputElement).value).toBe('')
    expect((wrapper.find('[data-testid="llm-retry-provider-max-delay-input"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.find('[data-testid="llm-retry-warn-provider-maxRetries"]').exists()).toBe(false)

    await wrapper.find('[data-testid="llm-retry-save-btn"]').trigger('click')
    await flushPromises()

    expect(configApiMock.setRetryConfig).toHaveBeenCalledTimes(1)
    expect(configApiMock.setRetryConfig).toHaveBeenCalledWith({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
      provider: undefined,
    })
    expect(toastMock.error).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('广播订阅：configured=true 回调刷新表单值；unmount 调用清理函数', async () => {
    const unsub = vi.fn()
    let handler: ((payload: { config: unknown; configured: boolean }) => void) | null = null
    configApiMock.onRetryConfig.mockImplementation((h: typeof handler) => {
      handler = h
      return unsub
    })

    const wrapper = mountSection()
    await flushPromises()
    expect(handler).not.toBeNull()

    // 本地改动（如输入 10）后收到其他窗口保存的广播 → 表单刷新为广播值
    await setInput(wrapper, 'llm-retry-max-retries-input', '10')
    handler!({
      configured: true,
      config: { enabled: false, maxRetries: 5, baseDelayMs: 4000 },
    })
    await flushPromises()

    expect((wrapper.find('[data-testid="llm-retry-max-retries-input"]').element as HTMLInputElement).value).toBe('5')
    expect((wrapper.find('[data-testid="llm-retry-base-delay-input"]').element as HTMLInputElement).value).toBe('4')
    expect(wrapper.find('[data-testid="llm-retry-enabled-switch"]').attributes('data-state')).toBe('unchecked')
    expect(wrapper.find('[data-testid="llm-retry-configured-badge"]').exists()).toBe(true)

    wrapper.unmount()
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  it('带 warnings（超域标注）状态下广播到达 → 合法 config 清除标注（红框与警示文本均消失）', async () => {
    const unsub = vi.fn()
    let handler: ((payload: { config: unknown; configured: boolean }) => void) | null = null
    configApiMock.onRetryConfig.mockImplementation((h: typeof handler) => {
      handler = h
      return unsub
    })
    // 加载超域存量：maxRetries=50 → 出现行内标注
    const fixture = defaultFixture()
    fixture.config.maxRetries = 50
    configApiMock.getRetryConfig.mockResolvedValue(fixture)

    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.find('[data-testid="llm-retry-warn-maxRetries"]').exists()).toBe(true)

    // 其他窗口保存合法值 → 广播到达后标注被清除
    handler!({ configured: true, config: { enabled: true, maxRetries: 5, baseDelayMs: 2000 } })
    await flushPromises()

    expect(wrapper.find('[data-testid="llm-retry-warn-maxRetries"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('超出推荐范围')
    // 保存失败残留的红框也随广播清除
    await setInput(wrapper, 'llm-retry-base-delay-input', '99999')
    await wrapper.find('[data-testid="llm-retry-save-btn"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="llm-retry-base-delay-input"]').classes()).toContain('border-warn')
    handler!({ configured: true, config: { enabled: true, maxRetries: 5, baseDelayMs: 2000 } })
    await flushPromises()
    expect(wrapper.find('[data-testid="llm-retry-base-delay-input"]').classes()).not.toContain('border-warn')
    wrapper.unmount()
  })

  it('自保存回声：保存成功后广播回显同值 → 表单状态保持且无异常（幂等回归保护）', async () => {
    const unsub = vi.fn()
    let handler: ((payload: { config: unknown; configured: boolean }) => void) | null = null
    configApiMock.onRetryConfig.mockImplementation((h: typeof handler) => {
      handler = h
      return unsub
    })

    const wrapper = mountSection()
    await flushPromises()

    await setInput(wrapper, 'llm-retry-base-delay-input', '5')
    await wrapper.find('[data-testid="llm-retry-save-btn"]').trigger('click')
    await flushPromises()
    expect(configApiMock.setRetryConfig).toHaveBeenCalledTimes(1)

    // 回声广播携带刚保存的同值 → 表单保持保存后的值，无异常
    handler!({
      configured: true,
      config: { enabled: true, maxRetries: 3, baseDelayMs: 5000, provider: { maxRetries: 0, maxRetryDelayMs: 60000 } },
    })
    await flushPromises()

    expect((wrapper.find('[data-testid="llm-retry-max-retries-input"]').element as HTMLInputElement).value).toBe('3')
    expect((wrapper.find('[data-testid="llm-retry-base-delay-input"]').element as HTMLInputElement).value).toBe('5')
    expect(wrapper.find('[data-testid="llm-retry-configured-badge"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('超出推荐范围')
    expect(toastMock.error).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('maxRetries 与 baseDelay 同时为空 → 两键各自标红（border-warn）', async () => {
    const wrapper = mountSection()
    await flushPromises()

    await setInput(wrapper, 'llm-retry-max-retries-input', '')
    await setInput(wrapper, 'llm-retry-base-delay-input', '')
    await wrapper.find('[data-testid="llm-retry-save-btn"]').trigger('click')
    await flushPromises()

    expect(configApiMock.setRetryConfig).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="llm-retry-max-retries-input"]').classes()).toContain('border-warn')
    expect(wrapper.find('[data-testid="llm-retry-base-delay-input"]').classes()).toContain('border-warn')
    wrapper.unmount()
  })

  it('provider 输入解析失败 → 错误 toast 指明字段（含「单请求超时」标签）', async () => {
    const wrapper = mountSection()
    await flushPromises()

    await wrapper.find('[data-testid="llm-retry-advanced-toggle"]').trigger('click')
    await flushPromises()
    // timeout 键接受小数秒（1.5 已合法），改用溢出输入 '1e999'（Number → Infinity，
    // number input 原样保留该值）触发解析拒绝路径
    await setInput(wrapper, 'llm-retry-provider-timeout-input', '1e999')
    await wrapper.find('[data-testid="llm-retry-save-btn"]').trigger('click')
    await flushPromises()

    expect(configApiMock.setRetryConfig).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error.mock.calls[0][0]).toContain('单请求超时')
    expect(toastMock.error.mock.calls[0][0]).toContain('合法数字')
    wrapper.unmount()
  })
})
