/**
 * NetworkPage 测试（llm-network-proxy U4，三视角）。
 *
 * 覆盖（impl-plan u-settings 验收 ⑤）：
 *  - 挂载 smoke：三卡渲染 + mock transport 数据回填（草稿字段 / chips / 规则行 / 统计行
 *    服务商名反查——provider baseUrl 主机名命中显名称、查不到显裸主机名）；
 *  - 开关关闭降灰：enabled=false → 规则卡降灰 wrapper 挂 opacity-50 + pointer-events-none，
 *    chip 禁用；统计卡不随开关降灰（读侧观测与 enabled 正交），范围 Select/刷新/重置可用；
 *    enabled=true 无降灰类；
 *  - chip toggle 增删规则：点击未添加 chip → 规则行追加主机名条目（aria-pressed 翻转）；
 *    再点 → 移除；baseUrl 缺失 provider 的 chip 禁用；「添加自定义规则」push 空条目；
 *  - 保存：调 setNetworkProxyConfig 全量载荷（port Number 化 / noProxy 拆分）+ 成功 toast；
 *    失败回滚（草稿重置到最近加载基准 + error toast）；校验拒绝（端口空 → 0 越域）不发 RPC。
 *
 * mock 策略：SettingsTransport seam 桩（[C3] 测试打 seam，不 mock 路由链）；toast 走 useToast mock。
 *
 * 运行：pnpm -C packages/renderer exec vitest run src/__tests__/settings/network-page.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub'
import type { NetworkProxyConfig, ProviderInfo } from '@taiji/shared'

const transportApiMock = vi.hoisted(() => ({
  getNetworkProxyConfig: vi.fn(),
  setNetworkProxyConfig: vi.fn(),
  testNetworkProxy: vi.fn(),
  getNetworkProxyStats: vi.fn(),
  resetNetworkProxyStats: vi.fn(),
  onNetworkProxyConfig: vi.fn(() => () => {}),
  listProviders: vi.fn(),
}))
const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ info: toastMock.info, error: toastMock.error, warning: vi.fn() }),
}))

import NetworkPage from '@/components/settings/network/NetworkPage.vue'
import zhCN from '@taiji/ui/locale/zh-CN/settings'

function makeI18n() {
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
    ipv4Only: [],
  }
}

function fixtureProviders(): ProviderInfo[] {
  return [
    { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', apiKeySet: true, status: 'connected', models: [] },
    // model 级 baseUrl 兜底路径：provider 级缺失时取任一 model.baseUrl
    { id: 'openai', name: 'OpenAI', apiKeySet: true, status: 'connected', models: [{ id: 'gpt', baseUrl: 'https://api.openai.com/v1' }] },
    // 双端皆缺：chip 禁用 + title 提示
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
    global: { plugins: [makeI18n()] },
  })
}

/** 改 Input 值（v-model 经 input 事件同步）。 */
async function setInput(wrapper: ReturnType<typeof mount>, testid: string, value: string) {
  const input = wrapper.find(`[data-testid="${testid}"]`)
  ;(input.element as HTMLInputElement).value = value
  await input.trigger('input')
  await input.trigger('change')
}

beforeEach(() => {
  vi.clearAllMocks()
  transportApiMock.getNetworkProxyConfig.mockResolvedValue({ config: fixtureConfig() })
  transportApiMock.setNetworkProxyConfig.mockResolvedValue({ config: fixtureConfig() })
  transportApiMock.testNetworkProxy.mockResolvedValue({ ok: true, stage: 'done', message: '代理连接成功', elapsedMs: 42 })
  transportApiMock.getNetworkProxyStats.mockResolvedValue(fixtureStats())
  transportApiMock.resetNetworkProxyStats.mockResolvedValue({ stats: [] })
  transportApiMock.listProviders.mockResolvedValue({ providers: fixtureProviders() })
  provideSettingsTransport(makeSettingsTransportStub(transportApiMock))
})

describe('NetworkPage（llm-network-proxy U4 网络代理页）', () => {
  it('挂载 smoke：三卡渲染 + mock transport 数据回填（草稿/chips/规则行/统计行反查）', async () => {
    const wrapper = mountPage()
    await flushPromises()

    // 三卡渲染
    expect(wrapper.find('[data-testid="network-server-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="network-rules-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="network-stats-card"]').exists()).toBe(true)

    // 草稿回填（getNetworkProxyConfig → 表单值）
    expect((wrapper.find('[data-testid="network-host-input"]').element as HTMLInputElement).value).toBe('127.0.0.1')
    expect((wrapper.find('[data-testid="network-port-input"]').element as HTMLInputElement).value).toBe('7890')
    expect(wrapper.find('[data-testid="network-enabled-switch"]').attributes('data-state')).toBe('checked')
    expect((wrapper.find('[data-testid="network-noproxy-input"]').element as HTMLInputElement).value).toBe('localhost, 127.0.0.1')

    // chips：provider baseUrl 主机名投影；双端皆缺 → 禁用 + title 提示
    const anthropicChip = wrapper.find('[data-testid="network-chip-anthropic"]')
    expect(anthropicChip.text()).toContain('Anthropic')
    expect(anthropicChip.text()).toContain('api.anthropic.com')
    expect(anthropicChip.attributes('aria-pressed')).toBe('true') // 规则已含该主机名 → 已添加态
    // model 级 baseUrl 兜底：provider 级缺失时取 model.baseUrl 主机名
    expect(wrapper.find('[data-testid="network-chip-openai"]').text()).toContain('api.openai.com')
    const noHostChip = wrapper.find('[data-testid="network-chip-custom"]')
    expect(noHostChip.attributes('disabled')).toBeDefined()
    expect(noHostChip.attributes('title')).toContain('未配置 baseURL')

    // 规则行回填
    expect((wrapper.find('[data-testid="network-rule-input-0"]').element as HTMLInputElement).value).toBe('api.anthropic.com')

    // 统计行：provider 反查显名称；查不到显裸主机名
    const anthropicRow = wrapper.find('[data-testid="network-stats-row-api.anthropic.com"]')
    expect(anthropicRow.text()).toContain('Anthropic')
    expect(anthropicRow.text()).toContain('12')
    const unknownRow = wrapper.find('[data-testid="network-stats-row-relay.internal.test"]')
    expect(unknownRow.text()).toContain('relay.internal.test')
    expect(unknownRow.text()).toContain('3')
    wrapper.unmount()
  })

  it('开关关闭降灰：enabled=false → 规则卡降灰挂 opacity-50 + pointer-events-none 且 chip 禁用；统计卡不随开关禁用；开启恢复', async () => {
    transportApiMock.getNetworkProxyConfig.mockResolvedValue({
      config: { ...fixtureConfig(), enabled: false },
    })
    const wrapper = mountPage()
    await flushPromises()

    const rulesDim = wrapper.find('[data-testid="network-rules-dim"]')
    expect(rulesDim.classes()).toContain('opacity-50')
    expect(rulesDim.classes()).toContain('pointer-events-none')
    expect(wrapper.find('[data-testid="network-chip-anthropic"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="network-add-rule"]').attributes('disabled')).toBeDefined()

    // 统计卡不随开关降灰（读侧观测与 enabled 正交，设计 §3.1 卡 3）：
    // 无降灰类、范围 Select/刷新/重置可用、数据行照常渲染
    expect(wrapper.find('[data-testid="network-lower-cards"]').classes()).not.toContain('opacity-50')
    expect(wrapper.find('[data-testid="network-stats-range"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="network-stats-refresh"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="network-stats-reset"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="network-stats-row-api.anthropic.com"]').exists()).toBe(true)

    // 开启开关 → 降灰解除（草稿态即时驱动，无需保存）
    await wrapper.find('[data-testid="network-enabled-switch"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="network-rules-dim"]').classes()).not.toContain('opacity-50')
    expect(wrapper.find('[data-testid="network-chip-anthropic"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('chip toggle 增删规则：点击未添加 chip 追加主机名条目，再点移除；「添加自定义规则」push 空条目', async () => {
    const wrapper = mountPage()
    await flushPromises()

    // openai chip 未添加（provider 级 baseUrl 缺失，model 级兜底）→ 点击追加 api.openai.com 条目
    const openaiChip = wrapper.find('[data-testid="network-chip-openai"]')
    expect(openaiChip.attributes('aria-pressed')).toBe('false')
    await openaiChip.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="network-chip-openai"]').attributes('aria-pressed')).toBe('true')
    expect((wrapper.find('[data-testid="network-rule-input-1"]').element as HTMLInputElement).value).toBe('api.openai.com')

    // 再点同一 chip → 移除（已添加态翻转 + 规则行消失）
    await wrapper.find('[data-testid="network-chip-openai"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="network-chip-openai"]').attributes('aria-pressed')).toBe('false')
    expect(wrapper.find('[data-testid="network-rule-input-1"]').exists()).toBe(false)

    // 添加自定义规则：push 空条目行内输入
    await wrapper.find('[data-testid="network-add-rule"]').trigger('click')
    await flushPromises()
    expect((wrapper.find('[data-testid="network-rule-input-1"]').element as HTMLInputElement).value).toBe('')

    // 行内删除：删除自定义规则行
    await wrapper.find('[data-testid="network-rule-del-1"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="network-rule-input-1"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('保存成功：调 setNetworkProxyConfig 全量载荷（port Number 化 / noProxy 拆分）+ 成功 toast', async () => {
    const wrapper = mountPage()
    await flushPromises()

    await setInput(wrapper, 'network-host-input', '10.0.0.1')
    await wrapper.find('[data-testid="network-save-btn"]').trigger('click')
    await flushPromises()

    expect(transportApiMock.setNetworkProxyConfig).toHaveBeenCalledTimes(1)
    expect(transportApiMock.setNetworkProxyConfig).toHaveBeenCalledWith({
      enabled: true,
      proxy: { protocol: 'http', host: '10.0.0.1', port: 7890, username: '', password: '' },
      noProxy: ['localhost', '127.0.0.1'],
      rules: ['api.anthropic.com'],
      ipv4Only: [],
    })
    expect(toastMock.info).toHaveBeenCalledWith('已保存，自下一轮对话起生效')
    expect(toastMock.error).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('保存失败回滚：setNetworkProxyConfig reject → error toast + 草稿重置到最近加载基准', async () => {
    const wrapper = mountPage()
    await flushPromises()

    transportApiMock.setNetworkProxyConfig.mockRejectedValueOnce(new Error('rpc down'))
    await setInput(wrapper, 'network-host-input', '10.0.0.1')
    await wrapper.find('[data-testid="network-save-btn"]').trigger('click')
    await flushPromises()

    expect(transportApiMock.setNetworkProxyConfig).toHaveBeenCalledTimes(1)
    expect(toastMock.error).toHaveBeenCalledWith('保存失败，请重试')
    // 回滚锚点 = 最近加载值（草稿恢复 127.0.0.1，不带失败时的脏值 10.0.0.1）
    expect((wrapper.find('[data-testid="network-host-input"]').element as HTMLInputElement).value).toBe('127.0.0.1')
    wrapper.unmount()
  })

  it('保存校验拒绝：端口清空（Number 化 0 越域）→ set 不被调 + error toast 含修复动作文案', async () => {
    const wrapper = mountPage()
    await flushPromises()

    await setInput(wrapper, 'network-port-input', '')
    await wrapper.find('[data-testid="network-save-btn"]').trigger('click')
    await flushPromises()

    expect(transportApiMock.setNetworkProxyConfig).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error.mock.calls[0][0]).toContain('1-65535')
    wrapper.unmount()
  })

  it('测试连接：调 testNetworkProxy（草稿即被测配置）+ 结果行渲染归因文案与耗时', async () => {
    const wrapper = mountPage()
    await flushPromises()

    await wrapper.find('[data-testid="network-test-btn"]').trigger('click')
    await flushPromises()

    expect(transportApiMock.testNetworkProxy).toHaveBeenCalledTimes(1)
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
    await setInput(wrapper, 'network-port-input', '1')
    await wrapper.find('[data-testid="network-test-btn"]').trigger('click')
    await flushPromises()

    expect(transportApiMock.testNetworkProxy).toHaveBeenCalledTimes(1)
    const result = wrapper.find('[data-testid="network-test-result"]')
    expect(result.exists()).toBe(true)
    expect(result.text()).toContain('代理连接成功')
    wrapper.unmount()
  })

  it('广播订阅：草稿干净时广播刷新表单；unmount 调用清理函数', async () => {
    const unsub = vi.fn()
    let handler: ((config: NetworkProxyConfig) => void) | null = null
    transportApiMock.onNetworkProxyConfig.mockImplementation((h: typeof handler) => {
      handler = h
      return unsub
    })

    const wrapper = mountPage()
    await flushPromises()
    expect(handler).not.toBeNull()

    // 草稿干净（刚加载未编辑）→ 广播值覆盖表单
    handler!({
      enabled: false,
      proxy: { protocol: 'https', host: '10.1.1.1', port: 8443, username: '', password: '' },
      noProxy: [],
      rules: [],
    })
    await flushPromises()
    expect((wrapper.find('[data-testid="network-host-input"]').element as HTMLInputElement).value).toBe('10.1.1.1')
    expect((wrapper.find('[data-testid="network-port-input"]').element as HTMLInputElement).value).toBe('8443')

    // 草稿脏（用户编辑未保存）→ 广播不覆盖用户输入
    await setInput(wrapper, 'network-host-input', '10.9.9.9')
    handler!({
      enabled: false,
      proxy: { protocol: 'https', host: '10.2.2.2', port: 8443, username: '', password: '' },
      noProxy: [],
      rules: [],
    })
    await flushPromises()
    expect((wrapper.find('[data-testid="network-host-input"]').element as HTMLInputElement).value).toBe('10.9.9.9')

    wrapper.unmount()
    expect(unsub).toHaveBeenCalledTimes(1)
  })
})
