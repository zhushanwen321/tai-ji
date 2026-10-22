/**
 * NetworkPage 测试（llm-network-proxy U4 按服务商卡改造，三视角）。
 *
 * 覆盖（impl-plan u-settings 验收 ⑤ + ipv4Only 独立化改造）：
 *  - 挂载 smoke：三卡渲染 + mock transport 数据回填（草稿字段 / 服务商行开关 /
 *    自定义行回填 / 统计行服务商名反查）；
 *  - 开关正交：enabled=false → 仅「走代理」列开关禁用，「强制 IPv4」列开关与自定义行
 *    的 ipv4 开关保持可用（ipv4Only 与 enabled 正交，shared 契约语义）；统计卡不随
 *    开关禁用；
 *  - 行内开关增删清单成员：服务商行 proxy/ipv4 开关 toggle → rules/ipv4Only 成员增删；
 *    自定义行添加（空 host 两开关禁用）→ 填主机名 → 开关可用 → 保存载荷含条目 → 删除；
 *  - 保存：调 setNetworkProxyConfig 全量载荷（port Number 化 / noProxy 拆分 /
 *    ipv4Only 数组承载）+ 成功 toast；失败回滚；校验拒绝不发 RPC；
 *  - 广播：旧配置（无 ipv4Only 字段）不炸 + 含 ipv4Only 的广播刷新自定义行。
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

/** 切 Switch（reka 渲染 role=switch button，click 触发 update:model-value）。 */
async function toggleSwitch(wrapper: ReturnType<typeof mount>, testid: string) {
  await wrapper.find(`[data-testid="${testid}"]`).trigger('click')
  await flushPromises()
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
    transportApiMock.getNetworkProxyConfig.mockResolvedValue({
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
    expect(transportApiMock.setNetworkProxyConfig).toHaveBeenCalledWith(
      expect.objectContaining({ rules: ['api.anthropic.com', 'api.openai.com'] }),
    )

    // 再切 off：rules 移除该条目
    await toggleSwitch(wrapper, 'network-provider-proxy-openai')
    expect(wrapper.find('[data-testid="network-provider-proxy-openai"]').attributes('data-state')).toBe('unchecked')
    await wrapper.find('[data-testid="network-save-btn"]').trigger('click')
    await flushPromises()
    expect(transportApiMock.setNetworkProxyConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ rules: ['api.anthropic.com'] }),
    )

    // ipv4 开关 on：ipv4Only 追加 api.anthropic.com（与 proxy 同开合法——优先级 ipv4Only > rules）
    await toggleSwitch(wrapper, 'network-provider-ipv4-anthropic')
    expect(wrapper.find('[data-testid="network-provider-ipv4-anthropic"]').attributes('data-state')).toBe('checked')
    await wrapper.find('[data-testid="network-save-btn"]').trigger('click')
    await flushPromises()
    expect(transportApiMock.setNetworkProxyConfig).toHaveBeenLastCalledWith(
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
    await setInput(wrapper, 'network-custom-input-0', 'relay.new.test')
    expect(wrapper.find('[data-testid="network-custom-proxy-0"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="network-custom-proxy-0"]').attributes('data-state')).toBe('checked')
    await toggleSwitch(wrapper, 'network-custom-ipv4-0')
    await wrapper.find('[data-testid="network-save-btn"]').trigger('click')
    await flushPromises()
    expect(transportApiMock.setNetworkProxyConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rules: ['api.anthropic.com', 'relay.new.test'],
        ipv4Only: ['relay.internal.test', 'relay.new.test'],
      }),
    )

    // 改名：两个数组原位替换（ipv4 开关保持 checked——新值仍在 ipv4Only）
    await setInput(wrapper, 'network-custom-input-0', 'relay.renamed.test')
    expect((wrapper.find('[data-testid="network-custom-input-0"]').element as HTMLInputElement).value).toBe('relay.renamed.test')
    expect(wrapper.find('[data-testid="network-custom-ipv4-0"]').attributes('data-state')).toBe('checked')

    // 删除行：两个数组均移除该条目（relay.internal.test 行仍在，上移为 index 0）
    await wrapper.find('[data-testid="network-custom-del-0"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid^="network-custom-row-"]')).toHaveLength(1)
    expect((wrapper.find('[data-testid="network-custom-input-0"]').element as HTMLInputElement).value).toBe('relay.internal.test')
    await wrapper.find('[data-testid="network-save-btn"]').trigger('click')
    await flushPromises()
    expect(transportApiMock.setNetworkProxyConfig).toHaveBeenLastCalledWith(
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

    expect(transportApiMock.setNetworkProxyConfig).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error.mock.calls[0][0]).toContain('为空')
    wrapper.unmount()
  })

  it('保存成功：调 setNetworkProxyConfig 全量载荷（port Number 化 / noProxy 拆分 / ipv4Only 数组承载）+ 成功 toast', async () => {
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
      ipv4Only: ['relay.internal.test'],
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

  it('广播订阅：旧配置（无 ipv4Only 字段）不炸 + 含 ipv4Only 的广播刷新自定义行；脏草稿不被覆盖；unmount 清理', async () => {
    const unsub = vi.fn()
    let handler: ((config: NetworkProxyConfig) => void) | null = null
    transportApiMock.onNetworkProxyConfig.mockImplementation((h: typeof handler) => {
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
    await setInput(wrapper, 'network-host-input', '10.9.9.9')
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
