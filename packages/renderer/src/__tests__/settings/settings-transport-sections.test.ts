import { makeSettingsTransportStub } from '../helpers/settings-transport-stub';
import NetworkPage from '@/components/settings/network/NetworkPage.vue';
import SystemCodemodeSection from '@/components/settings/system/SystemCodemodeSection.vue';
import SystemLlmRetrySection from '@/components/settings/system/SystemLlmRetrySection.vue';
import { provideSettingsTransport } from '@taiji/core';
import type { CodemodeEnabledResult, LlmRetryConfig } from '@taiji/shared';
import enUS from '@taiji/ui/locale/en-US/settings';
import zhCN from '@taiji/ui/locale/zh-CN/settings';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from 'vue-i18n';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← codemode-section.test.ts
// ======================================================================

const transportApiMock = vi.hoisted(() => ({
  getCodemodeEnabled: vi.fn(),
  setCodemodeEnabled: vi.fn(),
}))
const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ info: toastMock.info, error: toastMock.error, warning: vi.fn() }),
}))

function makeI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: { 'zh-CN': { settings: zhCN } },
  })
}

function defaultEnabledFixture(): CodemodeEnabledResult {
  return { enabled: true, corruption: null }
}

function corruptionFixture(corruptCopyPath: string | null): CodemodeEnabledResult {
  return {
    enabled: false,
    corruption: { filePath: '/home/demo/.taiji-dev/agent/settings.json', corruptCopyPath },
  }
}

function mountSection() {
  return mount(SystemCodemodeSection, {
    global: { plugins: [makeI18n()] },
  })
}

/** navigator.clipboard 桩（happy-dom 无实现；configurable 供 afterEach 清除，同 composer-shortcut-actions 先例）。 */
const writeText = vi.fn()
Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

beforeEach(() => {
  vi.clearAllMocks()
  transportApiMock.getCodemodeEnabled.mockResolvedValue(defaultEnabledFixture())
  transportApiMock.setCodemodeEnabled.mockResolvedValue({ ok: true, enabled: false })
  provideUnionTransport()
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

describe('SystemCodemodeSection（codemode u3）', () => {
  it('默认开渲染：Switch checked + 说明文案含生效时机（新启动的会话）', async () => {
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="codemode-enabled-switch"]').attributes('data-state')).toBe('checked')
    // 使用者黑盒：说明文案可见（模型能力 + 生效时机，D3 文案定死语义）
    expect(wrapper.find('[data-testid="codemode-section"]').text()).toContain('配置随新启动的会话读取')
    // 非损坏态无错误块
    expect(wrapper.find('[data-testid="codemode-corruption-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('开关切换调协议：点击 → setCodemodeEnabled(false) 被调，服务端终态校准显示', async () => {
    const wrapper = mountSection()
    await flushPromises()

    await wrapper.find('[data-testid="codemode-enabled-switch"]').trigger('click')
    await flushPromises()

    expect(transportApiMock.setCodemodeEnabled).toHaveBeenCalledTimes(1)
    expect(transportApiMock.setCodemodeEnabled).toHaveBeenCalledWith(false)
    expect(wrapper.find('[data-testid="codemode-enabled-switch"]').attributes('data-state')).toBe('unchecked')
    wrapper.unmount()
  })

  it('乐观写失败回滚：setCodemodeEnabled reject → Switch 回滚 checked + error toast 含错误详情（失败路径 2 的目标文件路径）', async () => {
    const wrapper = mountSection()
    await flushPromises()

    // 权限异常形态（设计 §3.1 失败路径 2）：runtime handler_error 信封 message = Node fs
    // 错误原文（server.ts toErrorMessage 透传），含目标 settings.json 路径
    transportApiMock.setCodemodeEnabled.mockRejectedValueOnce(
      new Error(
        "EACCES: permission denied, rename '/home/demo/.pi/agent/settings.json.tmp-1' -> '/home/demo/.pi/agent/settings.json'",
      ),
    )
    await wrapper.find('[data-testid="codemode-enabled-switch"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="codemode-enabled-switch"]').attributes('data-state')).toBe('checked')
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error.mock.calls[0][0]).toContain('开关操作失败')
    expect(toastMock.error.mock.calls[0][0]).toContain('/home/demo/.pi/agent/settings.json')
    wrapper.unmount()
  })

  it('损坏错误态渲染（D3 定死形态）：Switch 禁用 + 完整路径 + 修复指引含「无需重启」+ 无副本提示', async () => {
    transportApiMock.getCodemodeEnabled.mockResolvedValue(corruptionFixture(null))
    const wrapper = mountSection()
    await flushPromises()

    // Switch 呈禁用态（D3 定死）
    const sw = wrapper.find('[data-testid="codemode-enabled-switch"]')
    expect(sw.attributes('disabled')).toBeDefined()
    expect(sw.attributes('data-state')).toBe('unchecked')

    // 错误文案行：settings.json 完整路径（复制按钮旁）
    expect(wrapper.find('[data-testid="codemode-corruption-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="codemode-corruption-path"]').text()).toBe('/home/demo/.taiji-dev/agent/settings.json')
    expect(wrapper.find('[data-testid="codemode-copy-path-btn"]').exists()).toBe(true)

    // 修复指引含「无需重启」字样（D3 定死文案）
    const guide = wrapper.find('[data-testid="codemode-corruption-guide"]').text()
    expect(guide).toContain('无需重启')
    expect(guide).toContain('修复或删除该文件')

    // corruptCopyPath=null → 无副本提示
    expect(wrapper.find('[data-testid="codemode-corrupt-copy-path"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('隔离副本提示：corruptCopyPath 非空 → 渲染副本路径（原内容找回入口）', async () => {
    transportApiMock.getCodemodeEnabled.mockResolvedValue(
      corruptionFixture('/home/demo/.taiji-dev/agent/settings.json.corrupt-1730000000000'),
    )
    const wrapper = mountSection()
    await flushPromises()

    const hint = wrapper.find('[data-testid="codemode-corrupt-copy-path"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('settings.json.corrupt-1730000000000')
    wrapper.unmount()
  })

  it('复制按钮：点击 → clipboard.writeText(filePath) + info toast', async () => {
    transportApiMock.getCodemodeEnabled.mockResolvedValue(corruptionFixture(null))
    const wrapper = mountSection()
    await flushPromises()

    writeText.mockResolvedValueOnce(undefined)
    await wrapper.find('[data-testid="codemode-copy-path-btn"]').trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith('/home/demo/.taiji-dev/agent/settings.json')
    expect(toastMock.info).toHaveBeenCalledWith('路径已复制')
    wrapper.unmount()
  })

  it('损坏拒入：set 返回 ok:false 信封 → Switch 转禁用 + 错误态驻留 Section + toast 含路径', async () => {
    const wrapper = mountSection()
    await flushPromises()

    transportApiMock.setCodemodeEnabled.mockResolvedValueOnce({
      ok: false,
      error: 'settings.json corrupted',
      corruption: { filePath: '/home/demo/.taiji-dev/agent/settings.json', corruptCopyPath: null },
    })
    await wrapper.find('[data-testid="codemode-enabled-switch"]').trigger('click')
    await flushPromises()

    // 错误态驻留 Section（不止于 toast）：Switch 禁用 + 错误文案行渲染
    const sw = wrapper.find('[data-testid="codemode-enabled-switch"]')
    expect(sw.attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="codemode-corruption-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="codemode-corruption-path"]').text()).toContain('settings.json')
    // toast 同信息（含路径）
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error.mock.calls[0][0]).toContain('/home/demo/.taiji-dev/agent/settings.json')
    wrapper.unmount()
  })

  it('加载失败 best-effort：get reject → 保持默认开不崩溃（开关仍可操作）', async () => {
    transportApiMock.getCodemodeEnabled.mockRejectedValueOnce(new Error('rpc down'))
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="codemode-enabled-switch"]').attributes('data-state')).toBe('checked')
    expect(wrapper.find('[data-testid="codemode-corruption-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('i18n 双语 key 对齐：zh-CN 与 en-US 的 codemode 键集一致', () => {
    const zhKeys = Object.keys((zhCN as Record<string, Record<string, string>>).system)
      .filter((k) => k.startsWith('codemode')).sort()
    const enKeys = Object.keys((enUS as Record<string, Record<string, string>>).system)
      .filter((k) => k.startsWith('codemode')).sort()
    expect(enKeys).toEqual(zhKeys)
    // 键集非空（防对齐断言对空集恒真）
    expect(zhKeys.length).toBeGreaterThan(0)
  })
})

// ======================================================================
// ← llm-retry-section.test.ts
// ======================================================================

const configApiMock = vi.hoisted(() => ({
  getRetryConfig: vi.fn(),
  setRetryConfig: vi.fn(),
  onRetryConfig: vi.fn(() => () => {}),
}))
// [C3] retry 读写经 SettingsTransport seam 桩注入（替换原 core config 域模块 mock）
function makeI18n_m2() {
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

function mountSection_m2() {
  return mount(SystemLlmRetrySection, {
    global: { plugins: [makeI18n_m2()] },
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
  provideUnionTransport()
})

describe('SystemLlmRetrySection（u3 LLM 调用重试）', () => {
  it('首屏渲染：三控件显示存量值，预览行含「3 次」与时长文本', async () => {
    const wrapper = mountSection_m2()
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
    const wrapper = mountSection_m2()
    await flushPromises()

    await setInput(wrapper, 'llm-retry-max-retries-input', '10')
    await setInput(wrapper, 'llm-retry-base-delay-input', '5')

    const preview = wrapper.find('[data-testid="llm-retry-preview"]').text()
    expect(preview).toContain('10 次')
    // 5*(2^10-1)=5115s≈85.25 分钟量级，fmtDur ≥60 分钟走小时档（85.25/60 → 渲染 1.4 小时）
    expect(preview).toContain('1.4 小时')
  })

  it('小数秒预览可达：maxRetries=1 / baseDelay=59.999 → 预览行进位为「1 分钟」', async () => {
    const wrapper = mountSection_m2()
    await flushPromises()

    await setInput(wrapper, 'llm-retry-max-retries-input', '1')
    await setInput(wrapper, 'llm-retry-base-delay-input', '59.999')

    const preview = wrapper.find('[data-testid="llm-retry-preview"]').text()
    // 59.999s × 2^0 = 59999ms：显示精度 60.0 秒 → 档位边界进位为 1 分钟（最长单次与累计同值）
    expect(preview).toContain('1 分钟')
  })

  it('关闭开关 → 预览行变为「自动重试已关闭」文案', async () => {
    const wrapper = mountSection_m2()
    await flushPromises()

    await wrapper.find('[data-testid="llm-retry-enabled-switch"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="llm-retry-enabled-switch"]').attributes('data-state')).toBe('unchecked')
    expect(wrapper.find('[data-testid="llm-retry-preview"]').text()).toContain('自动重试已关闭')
  })

  it('高级折叠区：默认收起，点 toggle 后 provider 三输入可见', async () => {
    const wrapper = mountSection_m2()
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
    const wrapper = mountSection_m2()
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
    const wrapper = mountSection_m2()
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

  it('保存失败：setRetryConfig reject → error toast「保存失败，请重试」（onError 路径，不抛错）', async () => {
    const wrapper = mountSection_m2()
    await flushPromises()

    configApiMock.setRetryConfig.mockRejectedValueOnce(new Error('rpc down'))
    await setInput(wrapper, 'llm-retry-base-delay-input', '5')
    await wrapper.find('[data-testid="llm-retry-save-btn"]').trigger('click')
    await flushPromises()

    expect(configApiMock.setRetryConfig).toHaveBeenCalledTimes(1)
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    // createExplicitSave 的 onError 文案（本域固定 key，不含 RPC 错误原文）
    expect(toastMock.error).toHaveBeenCalledWith('保存失败，请重试')
    wrapper.unmount()
  })

  it('保存越界：baseDelay=99999 → setRetryConfig 不被调 + toast 含「超出范围」+ 输入框标红', async () => {
    const wrapper = mountSection_m2()
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
    const wrapper1 = mountSection_m2()
    await flushPromises()
    expect(wrapper1.find('[data-testid="llm-retry-configured-badge"]').exists()).toBe(false)
    expect(wrapper1.text()).not.toContain('已自定义')
    wrapper1.unmount()

    configApiMock.getRetryConfig.mockResolvedValue({ ...defaultFixture(), configured: true })
    const wrapper2 = mountSection_m2()
    await flushPromises()
    expect(wrapper2.find('[data-testid="llm-retry-configured-badge"]').exists()).toBe(true)
    expect(wrapper2.find('[data-testid="llm-retry-configured-badge"]').text()).toContain('已自定义')
    wrapper2.unmount()
  })

  it('存量超域：maxRetries=50 → 对应行出现警示标注（llm-retry-warn-maxRetries）', async () => {
    const fixture = defaultFixture()
    fixture.config.maxRetries = 50
    configApiMock.getRetryConfig.mockResolvedValue(fixture)

    const wrapper = mountSection_m2()
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

    const wrapper = mountSection_m2()
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

    const wrapper = mountSection_m2()
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

    const wrapper = mountSection_m2()
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

    const wrapper = mountSection_m2()
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

    const wrapper = mountSection_m2()
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

    const wrapper = mountSection_m2()
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
    const wrapper = mountSection_m2()
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
    const wrapper = mountSection_m2()
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

// ======================================================================
// ← network-page.test.ts
// ======================================================================

const transportApiMock_m2 = vi.hoisted(() => ({
  getNetworkProxyConfig: vi.fn(),
  setNetworkProxyConfig: vi.fn(),
  testNetworkProxy: vi.fn(),
  getNetworkProxyStats: vi.fn(),
  resetNetworkProxyStats: vi.fn(),
  onNetworkProxyConfig: vi.fn(() => () => {}),
  listProviders: vi.fn(),
}))
function makeI18n_m3() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: { 'zh-CN': { settings: zhCN.default ?? zhCN } },
  })
}

function fixtureConfig(): NetworkProxyConfig {
  return {
    enabled: true,
    proxy: { protocol: 'http', host: '127.0.0.1', port: 7890, username: '', password: '' },
    noProxy: ['localhost', '127.0.0.1'],
    rules: ['api.anthropic.com'],
    // 非 provider 域名 → 按服务商卡的自定义行回填覆盖
    ipv4Only: ['relay.internal.test'],
  }
}

function fixtureProviders(): ProviderInfo[] {
  return [
    { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', apiKeySet: true, status: 'connected', models: [] },
    // model 级 baseUrl 兜底路径：provider 级缺失时取任一 model.baseUrl
    { id: 'openai', name: 'OpenAI', apiKeySet: true, status: 'connected', models: [{ id: 'gpt', baseUrl: 'https://api.openai.com/v1' }] },
    // 双端皆缺：行开关禁用 + title 提示
    { id: 'custom', name: 'Custom GW', apiKeySet: true, status: 'connected', models: [] },
  ]
}

function fixtureStats() {
  return {
    stats: [
      { host: 'api.anthropic.com', proxied: 12, direct: 0 },
      { host: 'relay.internal.test', proxied: 0, direct: 3 },
    ],
  }
}

function mountPage() {
  return mount(NetworkPage, {
    global: { plugins: [makeI18n_m3()] },
  })
}

/** 改 Input 值（v-model 经 input 事件同步）。 */
async function setInput_m2(wrapper: ReturnType<typeof mount>, testid: string, value: string) {
  const input = wrapper.find(`[data-testid="${testid}"]`)
  ;(input.element as HTMLInputElement).value = value
  await input.trigger('input')
  await input.trigger('change')
}

/** 切 Switch（reka 渲染 role=switch button，click 触发 update:model-value）。 */
async function toggleSwitch(wrapper: ReturnType<typeof mount>, testid: string) {
  await wrapper.find(`[data-testid="${testid}"]`).trigger('click')
  await flushPromises()
}

beforeEach(() => {
  vi.clearAllMocks()
  transportApiMock_m2.getNetworkProxyConfig.mockResolvedValue({ config: fixtureConfig() })
  transportApiMock_m2.setNetworkProxyConfig.mockResolvedValue({ config: fixtureConfig() })
  transportApiMock_m2.testNetworkProxy.mockResolvedValue({ ok: true, stage: 'done', message: '代理连接成功', elapsedMs: 42 })
  transportApiMock_m2.getNetworkProxyStats.mockResolvedValue(fixtureStats())
  transportApiMock_m2.resetNetworkProxyStats.mockResolvedValue({ stats: [] })
  transportApiMock_m2.listProviders.mockResolvedValue({ providers: fixtureProviders() })
  provideUnionTransport()
})

describe('NetworkPage（llm-network-proxy U4 网络代理页）', () => {
  it('挂载 smoke：三卡渲染 + mock transport 数据回填（草稿/服务商行开关/自定义行/统计行反查）', async () => {
    const wrapper = mountPage()
    await flushPromises()

    // 三卡渲染
    expect(wrapper.find('[data-testid="network-server-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="network-provider-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="network-stats-card"]').exists()).toBe(true)

    // 草稿回填（getNetworkProxyConfig → 表单值）
    expect((wrapper.find('[data-testid="network-host-input"]').element as HTMLInputElement).value).toBe('127.0.0.1')
    expect((wrapper.find('[data-testid="network-port-input"]').element as HTMLInputElement).value).toBe('7890')
    expect(wrapper.find('[data-testid="network-enabled-switch"]').attributes('data-state')).toBe('checked')
    expect((wrapper.find('[data-testid="network-noproxy-input"]').element as HTMLInputElement).value).toBe('localhost, 127.0.0.1')

    // 服务商行：provider baseUrl 主机名投影；开关状态 = 清单成员关系
    const anthropicRow = wrapper.find('[data-testid="network-provider-row-anthropic"]')
    expect(anthropicRow.text()).toContain('Anthropic')
    expect(wrapper.find('[data-testid="network-provider-host-anthropic"]').text()).toContain('api.anthropic.com')
    // rules 含 api.anthropic.com → proxy 开关 checked；ipv4Only 不含 → ipv4 开关 unchecked
    expect(wrapper.find('[data-testid="network-provider-proxy-anthropic"]').attributes('data-state')).toBe('checked')
    expect(wrapper.find('[data-testid="network-provider-ipv4-anthropic"]').attributes('data-state')).toBe('unchecked')
    // model 级 baseUrl 兜底：provider 级缺失时取 model.baseUrl 主机名
    expect(wrapper.find('[data-testid="network-provider-host-openai"]').text()).toContain('api.openai.com')
    expect(wrapper.find('[data-testid="network-provider-proxy-openai"]').attributes('data-state')).toBe('unchecked')
    // 双端皆缺：host 显提示文案 + 两开关禁用
    expect(wrapper.find('[data-testid="network-provider-host-custom"]').text()).toContain('未配置 baseURL')
    expect(wrapper.find('[data-testid="network-provider-proxy-custom"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="network-provider-ipv4-custom"]').attributes('disabled')).toBeDefined()

    // 自定义行回填：ipv4Only 的非服务商条目 relay.internal.test（ipv4 开关 checked / proxy 未开）
    expect((wrapper.find('[data-testid="network-custom-input-0"]').element as HTMLInputElement).value).toBe('relay.internal.test')
    expect(wrapper.find('[data-testid="network-custom-ipv4-0"]').attributes('data-state')).toBe('checked')
    expect(wrapper.find('[data-testid="network-custom-proxy-0"]').attributes('data-state')).toBe('unchecked')

    // 统计行：provider 反查显名称；查不到显裸主机名
    const anthropicStatsRow = wrapper.find('[data-testid="network-stats-row-api.anthropic.com"]')
    expect(anthropicStatsRow.text()).toContain('Anthropic')
    expect(anthropicStatsRow.text()).toContain('12')
    const unknownRow = wrapper.find('[data-testid="network-stats-row-relay.internal.test"]')
    expect(unknownRow.text()).toContain('relay.internal.test')
    expect(unknownRow.text()).toContain('3')
    wrapper.unmount()
  })

  it('开关正交：enabled=false → 仅「走代理」开关禁用，「强制 IPv4」开关保持可用；统计卡不随开关禁用；开启恢复', async () => {
    transportApiMock_m2.getNetworkProxyConfig.mockResolvedValue({
      config: { ...fixtureConfig(), enabled: false },
    })
    const wrapper = mountPage()
    await flushPromises()

    // 「走代理」列受 enabled 门控（服务商行 + 自定义行同）
    expect(wrapper.find('[data-testid="network-provider-proxy-anthropic"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="network-custom-proxy-0"]').attributes('disabled')).toBeDefined()
    // 「强制 IPv4」列与 enabled 正交（shared 契约语义：ipv4Only 独立于代理总开关）
    expect(wrapper.find('[data-testid="network-provider-ipv4-anthropic"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="network-custom-ipv4-0"]').attributes('disabled')).toBeUndefined()

    // 统计卡不随开关禁用（读侧观测与 enabled 正交）：范围 Select/刷新/重置可用、数据行照常渲染
    expect(wrapper.find('[data-testid="network-lower-cards"]').classes()).not.toContain('opacity-50')
    expect(wrapper.find('[data-testid="network-stats-range"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="network-stats-refresh"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="network-stats-reset"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="network-stats-row-api.anthropic.com"]').exists()).toBe(true)

    // 开启开关 → proxy 开关恢复可用（草稿态即时驱动，无需保存）
    await toggleSwitch(wrapper, 'network-enabled-switch')
    expect(wrapper.find('[data-testid="network-enabled-switch"]').attributes('data-state')).toBe('checked')
    expect(wrapper.find('[data-testid="network-provider-proxy-anthropic"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="network-custom-proxy-0"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('行内开关增删清单成员：服务商行 proxy/ipv4 toggle → rules/ipv4Only 成员增删（保存载荷验证）', async () => {
    const wrapper = mountPage()
    await flushPromises()

    // openai 行 proxy 开关 off → on：rules 追加 api.openai.com
    await toggleSwitch(wrapper, 'network-provider-proxy-openai')
    expect(wrapper.find('[data-testid="network-provider-proxy-openai"]').attributes('data-state')).toBe('checked')
    await wrapper.find('[data-testid="network-save-btn"]').trigger('click')
    await flushPromises()
    expect(transportApiMock_m2.setNetworkProxyConfig).toHaveBeenCalledWith(
      expect.objectContaining({ rules: ['api.anthropic.com', 'api.openai.com'] }),
    )

    // 再切 off：rules 移除该条目
    await toggleSwitch(wrapper, 'network-provider-proxy-openai')
    expect(wrapper.find('[data-testid="network-provider-proxy-openai"]').attributes('data-state')).toBe('unchecked')
    await wrapper.find('[data-testid="network-save-btn"]').trigger('click')
    await flushPromises()
    expect(transportApiMock_m2.setNetworkProxyConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ rules: ['api.anthropic.com'] }),
    )

    // ipv4 开关 on：ipv4Only 追加 api.anthropic.com（与 proxy 同开合法——优先级 ipv4Only > rules）
    await toggleSwitch(wrapper, 'network-provider-ipv4-anthropic')
    expect(wrapper.find('[data-testid="network-provider-ipv4-anthropic"]').attributes('data-state')).toBe('checked')
    await wrapper.find('[data-testid="network-save-btn"]').trigger('click')
    await flushPromises()
    expect(transportApiMock_m2.setNetworkProxyConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ ipv4Only: ['relay.internal.test', 'api.anthropic.com'] }),
    )
    wrapper.unmount()
  })

  it('自定义行：添加空行（两开关禁用）→ 填主机名 → 开关联动清单 → 改名/删除行', async () => {
    const wrapper = mountPage()
    await flushPromises()

    // 添加自定义行：空 host 行出现（rules 优先排序 → 空行是 index 0）、两开关禁用
    // （未填主机名无成员关系可表达）
    await wrapper.find('[data-testid="network-add-custom-host"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="network-custom-row-0"]').exists()).toBe(true)
    expect((wrapper.find('[data-testid="network-custom-input-0"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.find('[data-testid="network-custom-proxy-0"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="network-custom-ipv4-0"]').attributes('disabled')).toBeDefined()

    // 填主机名后开关可用：行底层条目已在 rules（新增行 push 空串到 rules、改名原位替换），
    // 故 proxy 开关即变为 checked；勾 ipv4 → ipv4Only 追加
    await setInput_m2(wrapper, 'network-custom-input-0', 'relay.new.test')
    expect(wrapper.find('[data-testid="network-custom-proxy-0"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="network-custom-proxy-0"]').attributes('data-state')).toBe('checked')
    await toggleSwitch(wrapper, 'network-custom-ipv4-0')
    await wrapper.find('[data-testid="network-save-btn"]').trigger('click')
    await flushPromises()
    expect(transportApiMock_m2.setNetworkProxyConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rules: ['api.anthropic.com', 'relay.new.test'],
        ipv4Only: ['relay.internal.test', 'relay.new.test'],
      }),
    )

    // 改名：两个数组原位替换（ipv4 开关保持 checked——新值仍在 ipv4Only）
    await setInput_m2(wrapper, 'network-custom-input-0', 'relay.renamed.test')
    expect((wrapper.find('[data-testid="network-custom-input-0"]').element as HTMLInputElement).value).toBe('relay.renamed.test')
    expect(wrapper.find('[data-testid="network-custom-ipv4-0"]').attributes('data-state')).toBe('checked')

    // 删除行：两个数组均移除该条目（relay.internal.test 行仍在，上移为 index 0）
    await wrapper.find('[data-testid="network-custom-del-0"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid^="network-custom-row-"]')).toHaveLength(1)
    expect((wrapper.find('[data-testid="network-custom-input-0"]').element as HTMLInputElement).value).toBe('relay.internal.test')
    await wrapper.find('[data-testid="network-save-btn"]').trigger('click')
    await flushPromises()
    expect(transportApiMock_m2.setNetworkProxyConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rules: ['api.anthropic.com'],
        ipv4Only: ['relay.internal.test'],
      }),
    )
    wrapper.unmount()
  })

  it('自定义行空主机名保存被校验拦截：不调 setNetworkProxyConfig + error toast 含修复动作', async () => {
    const wrapper = mountPage()
    await flushPromises()

    await wrapper.find('[data-testid="network-add-custom-host"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="network-save-btn"]').trigger('click')
    await flushPromises()

    expect(transportApiMock_m2.setNetworkProxyConfig).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error.mock.calls[0][0]).toContain('为空')
    wrapper.unmount()
  })

  it('保存成功：调 setNetworkProxyConfig 全量载荷（port Number 化 / noProxy 拆分 / ipv4Only 数组承载）+ 成功 toast', async () => {
    const wrapper = mountPage()
    await flushPromises()

    await setInput_m2(wrapper, 'network-host-input', '10.0.0.1')
    await wrapper.find('[data-testid="network-save-btn"]').trigger('click')
    await flushPromises()

    expect(transportApiMock_m2.setNetworkProxyConfig).toHaveBeenCalledTimes(1)
    expect(transportApiMock_m2.setNetworkProxyConfig).toHaveBeenCalledWith({
      enabled: true,
      proxy: { protocol: 'http', host: '10.0.0.1', port: 7890, username: '', password: '' },
      noProxy: ['localhost', '127.0.0.1'],
      rules: ['api.anthropic.com'],
      ipv4Only: ['relay.internal.test'],
    })
    expect(toastMock.info).toHaveBeenCalledWith('已保存，自下一轮对话起生效')
    expect(toastMock.error).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('保存失败回滚：setNetworkProxyConfig reject → error toast + 草稿重置到最近加载基准', async () => {
    const wrapper = mountPage()
    await flushPromises()

    transportApiMock_m2.setNetworkProxyConfig.mockRejectedValueOnce(new Error('rpc down'))
    await setInput_m2(wrapper, 'network-host-input', '10.0.0.1')
    await wrapper.find('[data-testid="network-save-btn"]').trigger('click')
    await flushPromises()

    expect(transportApiMock_m2.setNetworkProxyConfig).toHaveBeenCalledTimes(1)
    expect(toastMock.error).toHaveBeenCalledWith('保存失败，请重试')
    // 回滚锚点 = 最近加载值（草稿恢复 127.0.0.1，不带失败时的脏值 10.0.0.1）
    expect((wrapper.find('[data-testid="network-host-input"]').element as HTMLInputElement).value).toBe('127.0.0.1')
    wrapper.unmount()
  })

  it('保存校验拒绝：端口清空（Number 化 0 越域）→ set 不被调 + error toast 含修复动作文案', async () => {
    const wrapper = mountPage()
    await flushPromises()

    await setInput_m2(wrapper, 'network-port-input', '')
    await wrapper.find('[data-testid="network-save-btn"]').trigger('click')
    await flushPromises()

    expect(transportApiMock_m2.setNetworkProxyConfig).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error.mock.calls[0][0]).toContain('1-65535')
    wrapper.unmount()
  })

  it('测试连接：调 testNetworkProxy（草稿即被测配置）+ 结果行渲染归因文案与耗时', async () => {
    const wrapper = mountPage()
    await flushPromises()

    await wrapper.find('[data-testid="network-test-btn"]').trigger('click')
    await flushPromises()

    expect(transportApiMock_m2.testNetworkProxy).toHaveBeenCalledTimes(1)
    const result = wrapper.find('[data-testid="network-test-result"]')
    expect(result.exists()).toBe(true)
    expect(result.text()).toContain('代理连接成功')
    expect(result.text()).toContain('42 ms')
    expect(result.classes()).toContain('text-success')
    wrapper.unmount()
  })

  it('测试连接·改端口后（A14 真机缺陷回归）：number input 的 v-model 经 looseToNumber 产出数字，边界还原字符串承载——测试不炸且归因文案照常渲染', async () => {
    const wrapper = mountPage()
    await flushPromises()

    // type=number 透传原生 input 后 Vue v-model 恒经 looseToNumber：用户编辑端口即得数字
    // 草稿（修复前此处 draft.port.trim is not a function，onTest 同步抛错）
    await setInput_m2(wrapper, 'network-port-input', '1')
    await wrapper.find('[data-testid="network-test-btn"]').trigger('click')
    await flushPromises()

    expect(transportApiMock_m2.testNetworkProxy).toHaveBeenCalledTimes(1)
    const result = wrapper.find('[data-testid="network-test-result"]')
    expect(result.exists()).toBe(true)
    expect(result.text()).toContain('代理连接成功')
    wrapper.unmount()
  })

  it('广播订阅：旧配置（无 ipv4Only 字段）不炸 + 含 ipv4Only 的广播刷新自定义行；脏草稿不被覆盖；unmount 清理', async () => {
    const unsub = vi.fn()
    let handler: ((config: NetworkProxyConfig) => void) | null = null
    transportApiMock_m2.onNetworkProxyConfig.mockImplementation((h: typeof handler) => {
      handler = h
      return unsub
    })

    const wrapper = mountPage()
    await flushPromises()
    expect(handler).not.toBeNull()

    // 旧配置文件形态：无 ipv4Only 字段（schema 演进前的落盘形态；TS 类型必填该字段，
    // 运行时旧盘文件缺它——向后兼容路径，断言构造保留缺字段形态）
    const legacyConfig = {
      enabled: false,
      proxy: { protocol: 'https', host: '10.1.1.1', port: 8443, username: '', password: '' },
      noProxy: [],
      rules: [],
    } as NetworkProxyConfig
    handler!(legacyConfig)
    await flushPromises()
    expect((wrapper.find('[data-testid="network-host-input"]').element as HTMLInputElement).value).toBe('10.1.1.1')
    expect((wrapper.find('[data-testid="network-port-input"]').element as HTMLInputElement).value).toBe('8443')
    // 旧配置无 ipv4Only → 草稿 ipv4Only 为空 → 原自定义行消失（回填为干净态）
    expect(wrapper.find('[data-testid="network-custom-row-0"]').exists()).toBe(false)

    // 含 ipv4Only 的广播 → 自定义行刷新
    handler!({
      enabled: true,
      proxy: { protocol: 'https', host: '10.2.2.2', port: 8443, username: '', password: '' },
      noProxy: [],
      rules: [],
      ipv4Only: ['api.v4.test'],
    })
    await flushPromises()
    expect((wrapper.find('[data-testid="network-custom-input-0"]').element as HTMLInputElement).value).toBe('api.v4.test')

    // 草稿脏（用户编辑未保存）→ 广播不覆盖用户输入
    await setInput_m2(wrapper, 'network-host-input', '10.9.9.9')
    handler!({
      enabled: false,
      proxy: { protocol: 'https', host: '10.3.3.3', port: 8443, username: '', password: '' },
      noProxy: [],
      rules: [],
      ipv4Only: [],
    })
    await flushPromises()
    expect((wrapper.find('[data-testid="network-host-input"]').element as HTMLInputElement).value).toBe('10.9.9.9')

    wrapper.unmount()
    expect(unsub).toHaveBeenCalledTimes(1)
  })
})

/**
 * 合并产物专用：三节 beforeEach 共用同一 SettingsTransport 桩。
 * 各节 beforeEach 逐一覆盖原「provide 自家桩」调用——分开 provide 时后注册者覆盖前者，
 * 跨节用例拿到别节的空桩（合并首跑 18 例红）。union 取三节 mock 并集，每节仍只断言自家键。
 */
function provideUnionTransport() {
  provideSettingsTransport(
    makeSettingsTransportStub({
      ...transportApiMock,
      ...configApiMock,
      ...transportApiMock_m2,
    }),
  )
}
