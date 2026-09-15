/**
 * ProviderTestDiscoverSection 组件测试（D-1 从 ProviderEditBody 抽出的纯展示块）。
 *
 * 组件契约：零内部状态——testing/discovering/testResult/testResults/testError/discoverResult/
 * modelCount/providerKind 全部 props 注入，@test/@discover 事件上抛由父组件（useProviderEdit）
 * 编排。测试锁：
 * - 按钮点击上抛 test / discover
 * - testing / discovering 进行中 → 按钮互斥 disabled（防重复点击）
 * - testResult ok/error 渲染成功/失败反馈行；discoverResult 渲染结果文案
 * - M3b：results 按协议分组渲染（每协议一行 + 代表模型名 + 真实失败原因）；失败类型对应的
 *   恢复指引出现在 DOM；catalog 不渲染「模型发现」按钮、custom 渲染（用户可见 DOM 断言）
 *
 * 测试框架：vitest。i18n 经 ui vitest.setup mock（t 返回 key + 命名参数追加），断言用 key 与参数值。
 * 运行：cd packages/ui && npx vitest run src/features/settings/__tests__/provider-test-discover-section.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ProviderTestDiscoverSection from '../provider/ProviderTestDiscoverSection.vue'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

function mountSection(props: Record<string, unknown> = {}): ReturnType<typeof mount> {
  return mount(ProviderTestDiscoverSection, {
    props: {
      testing: false,
      discovering: false,
      testResult: null,
      discoverResult: '',
      modelCount: 0,
      ...props,
    },
    attachTo: document.body,
  })
}

/** 按 i18n key 文本定位按钮（mock t 返回 key） */
function findButtonByKey(w: ReturnType<typeof mount>, key: string) {
  return w.findAll('button').find((b) => b.text().includes(key))
}

describe('按钮事件上抛（纯展示 + 零内部状态）', () => {
  it('点击「测试连接」上抛 test、点击「模型发现」上抛 discover', async () => {
    wrapper = mountSection()
    await flushPromises()

    const testBtn = findButtonByKey(wrapper, 'settings.providerEdit.testConnection')
    const discoverBtn = findButtonByKey(wrapper, 'settings.providerEdit.autoDiscover')
    expect(testBtn).toBeTruthy()
    expect(discoverBtn).toBeTruthy()

    await testBtn!.trigger('click')
    expect(wrapper.emitted('test')).toHaveLength(1)

    await discoverBtn!.trigger('click')
    expect(wrapper.emitted('discover')).toHaveLength(1)
  })

  it('testing=true → 两按钮 disabled（进行中防重复点击）', async () => {
    wrapper = mountSection({ testing: true })
    await flushPromises()

    const buttons = wrapper.findAll('button')
    expect(buttons.every((b) => b.attributes('disabled') !== undefined)).toBe(true)
    await buttons[0]!.trigger('click')
    expect(wrapper.emitted('test')).toBeUndefined()
  })

  it('discovering=true → 同样互斥 disabled', async () => {
    wrapper = mountSection({ discovering: true })
    await flushPromises()
    expect(wrapper.findAll('button').every((b) => b.attributes('disabled') !== undefined)).toBe(true)
  })
})

describe('结果反馈行', () => {
  it('testResult=ok（无分组结果）→ 成功反馈行（testOk key + 成功色）', async () => {
    wrapper = mountSection({ testResult: 'ok', modelCount: 3 })
    await flushPromises()
    expect(wrapper.text()).toContain('settings.providerEdit.testOk')
  })

  it('testResult=error（无分组结果、无 testError）→ 失败反馈行（testFail key）', async () => {
    wrapper = mountSection({ testResult: 'error' })
    await flushPromises()
    expect(wrapper.text()).toContain('settings.providerEdit.testFail')
  })

  it('testResult=null → 不渲染反馈行；discoverResult 非空 → 渲染结果文案', async () => {
    wrapper = mountSection({ discoverResult: '发现 5 个模型' })
    await flushPromises()
    expect(wrapper.text()).not.toContain('settings.providerEdit.testOk')
    expect(wrapper.text()).not.toContain('settings.providerEdit.testFail')
    expect(wrapper.text()).toContain('发现 5 个模型')
  })
})

// ══ M3b：按协议分组结果 + 恢复指引 + 「模型发现」按体系门控 ═══════════════════════════

describe('M3b 按协议分组结果渲染', () => {
  // 行级 error 语法 = M3a runtime 实装（model-connection-tester.ts 头注「错误编码」）
  const MULTI_RESULTS = [
    { api: 'anthropic-messages', modelId: 'minimax-m3', ok: true },
    { api: 'openai-completions', modelId: 'qwen3.8-flash', ok: false, error: 'http_error|401|{"error":{"message":"invalid api key"}}' },
    { api: 'openai-responses', modelId: 'grok-4.6', ok: false, error: 'http_error|401|{"error":{"message":"invalid api key"}}' },
  ]

  it('多协议 results → 每协议一行（协议名 + 代表模型名 + 真实错误文本）', async () => {
    wrapper = mountSection({ testResults: MULTI_RESULTS, testResult: 'ok' })
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-test-results"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('settings.providerEdit.testConnTitle')

    const rows = wrapper.findAll('[data-testid="provider-test-results"] span')
    // 3 条结果 = 3 行（成功行用 testRowSuccess、HTTP 失败行用 testRowHttpError）
    expect(rows).toHaveLength(3)
    const text = wrapper.text()
    expect(text).toContain('settings.providerEdit.testRowSuccess')
    expect(text).toContain('settings.providerEdit.testRowHttpError')
    // 代表模型名与真实错误（HTTP 状态码 + 响应截断）逐条可见
    expect(text).toContain('minimax-m3')
    expect(text).toContain('qwen3.8-flash')
    expect(text).toContain('grok-4.6')
    expect(text).toContain('401')
    expect(text).toContain('invalid api key')
  })

  it('HTTP 失败 → testHintHttpError 恢复指引出现在 DOM（含端点参数）', async () => {
    wrapper = mountSection({
      testResults: [MULTI_RESULTS[1]],
      testResult: 'ok',
      providerBaseUrl: 'https://api.example.com/v1',
    })
    await flushPromises()
    const hints = wrapper.find('[data-testid="provider-test-hints"]')
    expect(hints.exists()).toBe(true)
    expect(hints.text()).toContain('settings.providerEdit.testHintHttpError')
    expect(hints.text()).toContain('https://api.example.com/v1')
  })

  it('network_error 归类 → HTTP 行文案展示真实网络原因 + HTTP/代理指引（无状态码）', async () => {
    wrapper = mountSection({
      testResults: [{ api: 'openai-completions', modelId: 'm1', ok: false, error: 'network_error|TypeError: fetch failed' }],
      testResult: 'ok',
    })
    await flushPromises()
    expect(wrapper.text()).toContain('settings.providerEdit.testRowHttpError')
    expect(wrapper.text()).toContain('TypeError: fetch failed')
    expect(wrapper.text()).toContain('settings.providerEdit.testHintHttpError')
  })

  it('no_base_url 归类 → testRowNoBaseUrl + testHintNoBaseUrl', async () => {
    wrapper = mountSection({
      testResults: [{ api: 'anthropic-messages', modelId: '', ok: false, error: 'no_base_url' }],
      testResult: 'ok',
    })
    await flushPromises()
    expect(wrapper.text()).toContain('settings.providerEdit.testRowNoBaseUrl')
    expect(wrapper.text()).toContain('settings.providerEdit.testHintNoBaseUrl')
    // 不冒充网络错误：HTTP 行文案与 HTTP 指引均不出现
    expect(wrapper.text()).not.toContain('settings.providerEdit.testRowHttpError')
    expect(wrapper.text()).not.toContain('settings.providerEdit.testHintHttpError')
  })

  it('no_enabled_model 归类 → testRowNoEnabledModel + testHintNoEnabledModel', async () => {
    wrapper = mountSection({
      testResults: [{ api: 'openai-completions', modelId: '', ok: false, error: 'no_enabled_model' }],
      testResult: 'ok',
    })
    await flushPromises()
    expect(wrapper.text()).toContain('settings.providerEdit.testRowNoEnabledModel')
    expect(wrapper.text()).toContain('settings.providerEdit.testHintNoEnabledModel')
  })

  it('unsupported 归类 → testRowUnsupported（无对应指引 key，不渲染 hints 块）', async () => {
    wrapper = mountSection({
      testResults: [{ api: 'google-vertex', modelId: '', ok: false, error: 'unsupported' }],
      testResult: 'ok',
    })
    await flushPromises()
    expect(wrapper.text()).toContain('settings.providerEdit.testRowUnsupported')
    expect(wrapper.text()).toContain('google-vertex')
    expect(wrapper.find('[data-testid="provider-test-hints"]').exists()).toBe(false)
  })

  it('失败指引按类型去重：两条同类 HTTP 失败只给一条 HTTP 指引', async () => {
    wrapper = mountSection({
      testResults: [MULTI_RESULTS[1], MULTI_RESULTS[2]],
      testResult: 'ok',
    })
    await flushPromises()
    const hintEls = wrapper.findAll('[data-testid="provider-test-hints"] > div')
    expect(hintEls).toHaveLength(1)
  })
})

describe('M3b 整体性失败（success=false）分类', () => {
  it('no_api_key → testNoApiKey + testHintNoApiKey', async () => {
    wrapper = mountSection({ testResult: 'error', testError: 'no_api_key', providerKind: 'custom' })
    await flushPromises()
    expect(wrapper.find('[data-testid="provider-test-overall-error"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('settings.providerEdit.testNoApiKey')
    expect(wrapper.text()).toContain('settings.providerEdit.testHintNoApiKey')
  })

  it('no_models + custom → testNoModels + testHintNoModelsCustom', async () => {
    wrapper = mountSection({ testResult: 'error', testError: 'no_models', providerKind: 'custom' })
    await flushPromises()
    expect(wrapper.text()).toContain('settings.providerEdit.testNoModels')
    expect(wrapper.text()).toContain('settings.providerEdit.testHintNoModelsCustom')
    expect(wrapper.text()).not.toContain('settings.providerEdit.testHintNoModelsCatalog')
  })

  it('no_models + catalog → testHintNoModelsCatalog（指引按体系分叉）', async () => {
    wrapper = mountSection({ testResult: 'error', testError: 'no_models', providerKind: 'catalog' })
    await flushPromises()
    expect(wrapper.text()).toContain('settings.providerEdit.testHintNoModelsCatalog')
    expect(wrapper.text()).not.toContain('settings.providerEdit.testHintNoModelsCustom')
  })

  it('未知 error 文本 → 原样展示（不吞真实原因）且不误报分类文案', async () => {
    wrapper = mountSection({ testResult: 'error', testError: 'unexpected upstream failure' })
    await flushPromises()
    expect(wrapper.text()).toContain('unexpected upstream failure')
    expect(wrapper.text()).not.toContain('settings.providerEdit.testNoApiKey')
    expect(wrapper.text()).not.toContain('settings.providerEdit.testNoModels')
  })
})

describe('M3b「模型发现」按钮按 provider 体系门控', () => {
  it('catalog provider → 不渲染「模型发现」按钮（pi 无 fetchModels）', async () => {
    wrapper = mountSection({ providerKind: 'catalog' })
    await flushPromises()
    expect(findButtonByKey(wrapper, 'settings.providerEdit.autoDiscover')).toBeUndefined()
    // 「测试连接」仍渲染（catalog 恒有内置模型，测试连接有语义）
    expect(findButtonByKey(wrapper, 'settings.providerEdit.testConnection')).toBeTruthy()
  })

  it('custom provider → 渲染「模型发现」按钮（正反两条）', async () => {
    wrapper = mountSection({ providerKind: 'custom' })
    await flushPromises()
    expect(findButtonByKey(wrapper, 'settings.providerEdit.autoDiscover')).toBeTruthy()
  })

  it('providerKind 缺省 → 按 custom 渲染（向后兼容既有调用方）', async () => {
    wrapper = mountSection()
    await flushPromises()
    expect(findButtonByKey(wrapper, 'settings.providerEdit.autoDiscover')).toBeTruthy()
  })
})

