/**
 * use-provider-edit 迁移测试（W2 核心测试 2）。
 *
 * 覆盖：provider 变化重置编辑态 + 快照捕获；isDirty 全字段对比（快照 null 返 false）；
 * runDiscover test/discover 成功失败分支（discoverModels 调用参数、合并去重、文案）；
 * M3b 协议分流（discover 带 mode=discover 全参 / test 带 mode=test 只带 providerId +
 * 消费 results → testResults/testError）；save 校验/成功/失败 + apiKey 哨兵语义 +
 * headers/authHeader/models 透传；防线① provider 级字段分体系（catalog 无 type 键 +
 * baseUrl 恒带键含空串、custom 空串不带键）；D8 过期快照 watch（未 dirty 刷新 +
 * captureSnapshot，dirty 不刷新）；模型 CRUD（空名/重名抛错等）。
 *
 * watch 类用例用 effectScope 包裹 + flushPromises 驱动（node 环境无组件渲染）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Ref } from 'vue';
import type { ProviderId } from '@taiji/shared'
import { ref, effectScope, nextTick } from 'vue'
import { providePlatform, __resetPlatformForTesting } from '../../../platform/port'
import {
  provideSettingsTransport,
  __resetSettingsTransportForTesting,
  type SettingsTransport,
} from '../transport'
import { __resetSettingsStoreForTesting, getSettingsStore } from '../settings-store'
import {
  useProviderEdit,
  API_KEY_CLEAR_SENTINEL,
  type LocalModel,
} from '../use-provider-edit'
import { InMemoryStorage } from './helpers/in-memory-storage'
import type { ProviderInfo } from '@taiji/shared'
// D9 档位断言用 pi 实装同源函数（唯一权威）——从根 node_modules 解析 pi-ai 0.84.4 dist
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'

/**
 * 经 pi 同源 getSupportedThinkingLevels 算可用档位。
 * 入参只需 reasoning + thinkingLevelMap 子集（pi 实装只读这两个字段，见
 * pi-ai dist/models.js:548-558），其余 Model 必填字段经 unknown 收窄——
 * 与 runtime model-capability.ts 的 computeSupportedLevels 同款调用方式。
 */
function supportedLevelsOf(
  map: Record<string, string | null> | undefined,
  reasoning = true,
): string[] {
  const model = { reasoning, ...(map ? { thinkingLevelMap: map } : {}) }
  return getSupportedThinkingLevels(model as unknown as Parameters<typeof getSupportedThinkingLevels>[0])
}

/** i18n stub：返回 key 本身（校验调用参数而非翻译）。 */
const tStub = vi.fn((key: string) => key)

function makeFakeTransport(): SettingsTransport {
  return {
    listProviders: vi.fn(async () => ({ providers: [] })),
    listModels: vi.fn(async () => []),
    setScopedModels: vi.fn(async (_models: string[]): Promise<string[]> => []),
    setProvider: vi.fn(async () => {}),
    discoverModels: vi.fn(async () => ({ success: true, models: [] })),
    setSkillDirs: vi.fn(async () => {}),
    setAgentDirs: vi.fn(async () => {}),
    setExtensionDirs: vi.fn(async () => {}),
    onProviders: vi.fn(() => () => {}),
    onModels: vi.fn(() => () => {}),
    onSkills: vi.fn(() => () => {}),
    onAgents: vi.fn(() => () => {}),
    onExtensions: vi.fn(() => () => {}),
    onSkillDirs: vi.fn(() => () => {}),
    onAgentDirs: vi.fn(() => () => {}),
    onExtensionDirs: vi.fn(() => () => {}),
    onDefaults: vi.fn(() => () => {}),
    onSystemPrompt: vi.fn(() => () => {}),
    onTerminalConfig: vi.fn(() => () => {}),
  }
}

beforeEach(() => {
  __resetSettingsStoreForTesting()
  __resetSettingsTransportForTesting()
  __resetPlatformForTesting()
  providePlatform({ kind: 'mock', storage: new InMemoryStorage(), webSocket: { create: () => ({}) as never } })
  currentTransport = makeFakeTransport()
  provideSettingsTransport(currentTransport)
  tStub.mockClear()
  tStub.mockImplementation((key: string) => key)
})

let scope: ReturnType<typeof effectScope> | null = null

/** 当前注入的 fake transport（模块级，供断言用；避免 ESM 下 require 不可用）。 */
let currentTransport: SettingsTransport

function getTransport(): SettingsTransport {
  return currentTransport
}

afterEach(() => {
  scope?.stop()
  scope = null
})

function mount(providerRef: Ref<ProviderInfo | null>) {
  scope = effectScope()
  // effectScope.run 类型签名 T | undefined——活动 scope 内同步返回值恒非空
  return scope!.run(() => useProviderEdit(providerRef, { t: tStub }))!
}

function makeProvider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'p1' as ProviderId,
    name: 'P1',
    api: 'anthropic-messages',
    baseUrl: 'https://api.example.com',
    apiKeySet: true,
    status: 'connected',
    headers: { 'X-Test': 'v1' },
    authHeader: false,
    models: [
      { id: 'm1', name: 'M1', contextWindow: 200_000, enabled: true },
    ],
    enabled: true,
    ...overrides,
  }
}

describe('provider 变化重置编辑态 + 快照', () => {
  it('null → provider：表单填充 + localModels 映射 + isDirty false', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    providerRef.value = makeProvider()
    await nextTick()
    expect(edit.form.name).toBe('P1')
    expect(edit.form.api).toBe('anthropic-messages')
    expect(edit.form.baseUrl).toBe('https://api.example.com')
    expect(edit.form.headers).toEqual({ 'X-Test': 'v1' })
    expect(edit.localModels.value).toHaveLength(1)
    expect(edit.localModels.value[0].id).toBe('m1')
    expect(edit.isDirty.value).toBe(false)
  })

  it('provider → null：编辑态清空 + 快照重置', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    providerRef.value = null
    await nextTick()
    expect(edit.form.name).toBe('')
    expect(edit.form.api).toBe('anthropic-messages')
    expect(edit.localModels.value).toHaveLength(0)
    expect(edit.isDirty.value).toBe(false)
  })
})

describe('isDirty 对比', () => {
  it('快照 null → false', () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    expect(edit.isDirty.value).toBe(false)
  })

  it('改 name/api/baseUrl/apiKey/models/authHeader/headers 各触发 true', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    expect(edit.isDirty.value).toBe(false)

    edit.form.name = 'P2'
    expect(edit.isDirty.value).toBe(true)
    edit.form.name = 'P1'
    expect(edit.isDirty.value).toBe(false)

    edit.form.api = 'openai-completions'
    expect(edit.isDirty.value).toBe(true)
    edit.form.api = 'anthropic-messages'
    expect(edit.isDirty.value).toBe(false)

    edit.form.baseUrl = 'https://other.example.com'
    expect(edit.isDirty.value).toBe(true)
    edit.form.baseUrl = 'https://api.example.com'
    expect(edit.isDirty.value).toBe(false)

    // apiKey：输入值 → dirty
    edit.form.apiKey = 'sk-abc'
    expect(edit.isDirty.value).toBe(true)
    edit.form.apiKey = ''
    expect(edit.isDirty.value).toBe(false)

    // models 整体增删 → dirty
    edit.localModels.value.push({ id: 'm2', name: 'M2' })
    expect(edit.isDirty.value).toBe(true)
    edit.localModels.value.pop()
    expect(edit.isDirty.value).toBe(false)

    // authHeader → dirty
    edit.form.authHeader = true
    expect(edit.isDirty.value).toBe(true)
    edit.form.authHeader = false
    expect(edit.isDirty.value).toBe(false)

    // headers → dirty
    edit.form.headers['X-Test'] = 'v2'
    expect(edit.isDirty.value).toBe(true)
  })
})

describe('runDiscover test 分支', () => {
  it('成功 → testResult ok；discoverModels 调用参数带 mode=test 且只需 providerId（协议占位 baseUrl=""）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    edit.form.baseUrl = 'https://api.example.com'
    edit.form.apiKey = 'sk-abc'
    await edit.testConnection()
    const transport = getTransport()
    // M3b（设计 D4）：test 模式代表模型选择归 runtime——前端不发 baseUrl/apiKey/providerType
    // （快照 artifact 不参战）；baseUrl 是协议形状必填键（shared/protocol.ts），传 '' 占位。
    expect(transport.discoverModels).toHaveBeenCalledWith({
      mode: 'test',
      baseUrl: '',
      providerId: 'p1',
    })
    expect(edit.testResult.value).toBe('ok')
    expect(edit.testing.value).toBe(false)
  })

  it('M3b：成功返回 results → testResults 按协议分组消费（每协议 api/modelId/ok/error）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    // error 语法 = M3a runtime 实装（model-connection-tester.ts 头注「错误编码」）
    getTransport().discoverModels = vi.fn(async () => ({
      success: true,
      models: [],
      results: [
        { api: 'anthropic-messages', modelId: 'minimax-m3', ok: true },
        { api: 'openai-completions', modelId: 'qwen3.8-flash', ok: false, error: 'http_error|401|invalid api key' },
      ],
    }))
    await edit.testConnection()
    expect(edit.testResults.value).toEqual([
      { api: 'anthropic-messages', modelId: 'minimax-m3', ok: true },
      { api: 'openai-completions', modelId: 'qwen3.8-flash', ok: false, error: 'http_error|401|invalid api key' },
    ])
    // 行级失败不改变顶层 success（M3a 语义）——行内失败由行文案承载
    expect(edit.testResult.value).toBe('ok')
    expect(edit.testError.value).toBe('')
  })

  it('M3b：success=false 整体性失败 → results 空 + testError 携带原因（可展示状态，不抛全局）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    getTransport().discoverModels = vi.fn(async () => ({ success: false, error: 'no_api_key', results: [] }))
    await edit.testConnection()
    expect(edit.testResults.value).toEqual([])
    expect(edit.testError.value).toBe('no_api_key')
    expect(edit.testResult.value).toBe('error')
    expect(edit.actionError.value).toBe('no_api_key')
  })

  it('M3b：runtime 未回 results（旧 runtime）→ testResults 空数组（UI 走整体反馈兜底）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    getTransport().discoverModels = vi.fn(async () => ({ success: true, models: [] }))
    await edit.testConnection()
    expect(edit.testResults.value).toEqual([])
    expect(edit.testResult.value).toBe('ok')
  })

  it('success:false → testResult error + actionError', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    getTransport().discoverModels = vi.fn(async () => ({ success: false, error: 'bad key' }))
    await edit.testConnection()
    expect(edit.testResult.value).toBe('error')
    expect(edit.actionError.value).toBe('bad key')
  })

  it('reject → testResult error + actionError 消息', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    getTransport().discoverModels = vi.fn(async () => { throw new Error('net down') })
    await edit.testConnection()
    expect(edit.testResult.value).toBe('error')
    expect(edit.actionError.value).toBe('net down')
  })
})

describe('runDiscover discover 分支', () => {
  it('M3b：discover 调用参数带 mode=discover + baseUrl/apiKey/providerType/providerId', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    edit.form.baseUrl = 'https://api.example.com'
    edit.form.apiKey = 'sk-abc'
    await edit.autoDiscover()
    expect(getTransport().discoverModels).toHaveBeenCalledWith({
      mode: 'discover',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-abc',
      providerType: 'anthropic-messages',
      providerId: 'p1',
    })
  })

  it('成功：合并去重 + discoverResult 文案（newMerged）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    // localModels 已有 m1；返回 [m1, m2] → 只合并 m2
    getTransport().discoverModels = vi.fn(async () => ({
      success: true,
      models: [
        { id: 'm1', name: 'M1', contextWindow: 200_000 },
        { id: 'm2', name: 'M2', contextWindow: 128_000 },
      ],
    }))
    await edit.autoDiscover()
    expect(edit.localModels.value.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(edit.localModels.value[1].contextWindow).toBe(128_000)
    expect(tStub).toHaveBeenCalledWith('composable.discoveredModels', expect.anything())
    expect(tStub).toHaveBeenCalledWith('composable.newMerged', { count: 1 })
    expect(edit.discovering.value).toBe(false)
  })

  it('成功：全部已存在 → allExisted 文案', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    getTransport().discoverModels = vi.fn(async () => ({
      success: true,
      models: [{ id: 'm1', name: 'M1' }],
    }))
    await edit.autoDiscover()
    expect(edit.localModels.value).toHaveLength(1)
    expect(tStub).toHaveBeenCalledWith('composable.allExisted')
  })

  it('D9①：合并发现的模型 reasoning 显式 true（不 undefined，对齐 addModel 出厂语义）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    getTransport().discoverModels = vi.fn(async () => ({
      success: true,
      models: [{ id: 'm2', name: 'M2', contextWindow: 128_000 }],
    }))
    await edit.autoDiscover()
    const merged = edit.localModels.value.find((m) => m.id === 'm2')
    // pi 两级门控把 reasoning 缺失判「关」——合并入口必须出厂显式 boolean
    expect(merged?.reasoning).toBe(true)
    expect(merged?.reasoning).not.toBeUndefined()
  })

  it('失败：success:false → actionError', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    getTransport().discoverModels = vi.fn(async () => ({ success: false, error: 'fail' }))
    await edit.autoDiscover()
    expect(edit.actionError.value).toBe('fail')
  })

  it('reject → actionError 消息', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    getTransport().discoverModels = vi.fn(async () => { throw new Error('boom') })
    await edit.autoDiscover()
    expect(edit.actionError.value).toBe('boom')
  })
})

describe('save 校验/成功/失败 + apiKey 哨兵', () => {
  it('空 name → false + providerNameRequired（不经 setProvider）', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    const result = await edit.save()
    expect(result.ok).toBe(false)
    expect(result.wroteApiKey).toBe(false)
    expect(tStub).toHaveBeenCalledWith('composable.providerNameRequired')
    expect(getTransport().setProvider).not.toHaveBeenCalled()
  })

  it('成功：setProvider 参数（apiKey 空 → undefined；models 透传；headers 回写；authHeader）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    edit.form.name = 'P1-renamed'
    edit.form.apiKey = ''
    edit.form.authHeader = true
    const result = await edit.save()
    expect(result.ok).toBe(true)
    expect(result.wroteApiKey).toBe(false)
    expect(getTransport().setProvider).toHaveBeenCalledWith('p1', {
      name: 'P1-renamed',
      type: 'anthropic-messages',
      baseUrl: 'https://api.example.com',
      apiKey: undefined,
      headers: { 'X-Test': 'v1' },
      authHeader: true,
      models: [
        { id: 'm1', name: 'M1', api: undefined, baseUrl: undefined, contextWindow: 200_000, input: undefined, thinkingLevelMap: undefined, compat: undefined, enabled: true },
      ],
    })
  })

  it('apiKey 哨兵 → 发送空串（清空语义 D18），wroteApiKey=false（清除不是配置）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({ kind: 'custom' }))
    const edit = mount(providerRef)
    await nextTick()
    edit.form.apiKey = API_KEY_CLEAR_SENTINEL
    const result = await edit.save()
    expect(result.wroteApiKey).toBe(false)
    const arg = (getTransport().setProvider as ReturnType<typeof vi.fn>).mock.calls[0][1]
    // 显式空串带键（不是不传键）——「清除」与「不变」必须可区分
    expect('apiKey' in arg).toBe(true)
    expect(arg.apiKey).toBe('')
  })

  it('apiKey 非空 → 原值透传，wroteApiKey=true（自动启用信号）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    edit.form.apiKey = 'sk-foo'
    const result = await edit.save()
    expect(result.wroteApiKey).toBe(true)
    const arg = (getTransport().setProvider as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(arg.apiKey).toBe('sk-foo')
  })

  it('headers 空对象 → 不传 headers（undefined，避免覆盖 runtime 既有值）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    edit.form.headers = {}
    await edit.save()
    const arg = (getTransport().setProvider as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(arg.headers).toBeUndefined()
  })

  it('失败：setProvider reject → false + actionError', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    getTransport().setProvider = vi.fn(async () => { throw new Error('save failed') })
    const result = await edit.save()
    expect(result.ok).toBe(false)
    expect(result.wroteApiKey).toBe(false)
    expect(edit.actionError.value).toBe('save failed')
    expect(edit.saving.value).toBe(false)
  })
})

describe('防线① provider 级字段分体系（catalog vs custom，设计 D1）', () => {
  it('catalog：payload 无 type 键（快照 artifact 不回传）+ baseUrl 带键且为 trim 值', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({ kind: 'catalog' }))
    const edit = mount(providerRef)
    await nextTick()
    edit.form.baseUrl = '  https://gateway.example.com/mirror  '
    await edit.save()
    const arg = (getTransport().setProvider as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect('type' in arg).toBe(false)
    expect('baseUrl' in arg).toBe(true)
    expect(arg.baseUrl).toBe('https://gateway.example.com/mirror')
  })

  it('catalog：输入框清空 → baseUrl 为显式空串带键（清除网关；不传键=runtime「不变」会让网关回退不可达）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({ kind: 'catalog', baseUrl: 'https://gateway.example.com' }))
    const edit = mount(providerRef)
    await nextTick()
    expect(edit.form.baseUrl).toBe('https://gateway.example.com')
    edit.form.baseUrl = ''
    await edit.save()
    const arg = (getTransport().setProvider as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect('baseUrl' in arg).toBe(true)
    expect(arg.baseUrl).toBe('')
    expect('type' in arg).toBe(false)
  })

  it('custom：空串 baseUrl 不带键（truthy 守卫；runtime 侧空串同为「不变」语义）', async () => {
    // kind 缺失（旧数据/新建态）= custom 分支
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    edit.form.baseUrl = '   '
    await edit.save()
    const arg = (getTransport().setProvider as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect('baseUrl' in arg).toBe(false)
    // custom 的 provider 级协议（api）必须保留
    expect(arg.type).toBe('anthropic-messages')
  })

  it('custom：空串 name 被 D15b 校验拦截（不调 setProvider → payload 不会带 name 键）', async () => {
    // 空 name 在 save() 入口即被 D15b 拒绝，payload 层的 truthy 守卫是纵深防御（正常路径不可达）
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    edit.form.name = ''
    const result = await edit.save()
    expect(result.ok).toBe(false)
    expect(tStub).toHaveBeenCalledWith('composable.providerNameRequired')
    expect(getTransport().setProvider).not.toHaveBeenCalled()
  })
})

describe('D8 过期快照 watch', () => {
  it('未 dirty + 同 id provider 广播 → 表单刷新 + 快照重捕获（仍 isDirty false）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    // 外部广播替换 providers（新 name）
    const store = getSettingsStore()
    store.providers.value = [makeProvider({ name: 'P1-broadcast' })]
    await nextTick()
    expect(edit.form.name).toBe('P1-broadcast')
    expect(edit.isDirty.value).toBe(false) // 快照已重捕获
  })

  it('dirty 后广播 → 不刷新（用户改动优先）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    edit.form.name = 'P1-user-edit'
    expect(edit.isDirty.value).toBe(true)
    const store = getSettingsStore()
    store.providers.value = [makeProvider({ name: 'P1-broadcast' })]
    await nextTick()
    expect(edit.form.name).toBe('P1-user-edit') // 不刷新
  })

  it('新增态（providerRef null）→ 广播不刷新', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    const store = getSettingsStore()
    store.providers.value = [makeProvider({ name: 'P1-broadcast' })]
    await nextTick()
    expect(edit.form.name).toBe('') // 保持空
  })
})

describe('模型 CRUD', () => {
  it('addModel 空名抛错', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    edit.newModel.name = '   '
    expect(() => edit.addModel()).toThrow()
    expect(tStub).toHaveBeenCalledWith('composable.modelNameRequired')
  })

  it('addModel 重名 id 抛错', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    edit.newModel.name = 'm1'
    edit.localModels.value = [{ id: 'm1', name: 'M1' }]
    expect(() => edit.addModel()).toThrow('composable.modelAlreadyExists')
  })

  it('addModel 正常添加 + 清空表单 + reasoning 显式 boolean 落盘（D4，不 undefined 出厂）', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    edit.newModel.name = 'new-model'
    edit.newModel.contextWindow = 128_000
    edit.addModel()
    expect(edit.localModels.value).toHaveLength(1)
    expect(edit.localModels.value[0].id).toBe('new-model')
    // D4：reasoning 显式 boolean（事故 B 根因 ②——undefined 被 pi 判 off）
    expect(edit.localModels.value[0].reasoning).toBe(true)
    expect(edit.newModel.name).toBe('')
  })

  it('addModel 用户显式关 reasoning → 落盘 false（显式开关可覆盖推导）', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    edit.newModel.name = 'no-reasoning-model'
    edit.newModel.reasoning = false
    edit.addModel()
    expect(edit.localModels.value[0].reasoning).toBe(false)
  })

  it('D4 推导：思考策略切非 all-levels → reasoning 自动置 true（显式关后再切策略重新推导）', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    edit.newModel.reasoning = false
    edit.newModel.thinking = 'high-max'
    await nextTick()
    expect(edit.newModel.reasoning).toBe(true)
    // 用户显式关（覆盖推导）
    edit.newModel.reasoning = false
    expect(edit.newModel.reasoning).toBe(false)
    // 再切策略 → 重新推导置 true
    edit.newModel.thinking = 'on-off'
    await nextTick()
    expect(edit.newModel.reasoning).toBe(true)
    // 切回 all-levels → 不推导（保持当前值）
    edit.newModel.reasoning = false
    edit.newModel.thinking = 'all-levels'
    await nextTick()
    expect(edit.newModel.reasoning).toBe(false)
  })

  it('removeModel 移除指定下标', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    edit.localModels.value = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
    edit.removeModel(0)
    expect(edit.localModels.value.map((m) => m.id)).toEqual(['b'])
  })

  it('toggleInput 切换 text/image', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    const m: LocalModel = { id: 'm', name: 'M', input: ['text'] }
    edit.toggleInput(m, 'image')
    expect(m.input).toEqual(['text', 'image'])
    edit.toggleInput(m, 'text')
    expect(m.input).toEqual(['image'])
  })

  it('pickStrategy 按预设写 map（D9③ 补显式 null 剔除项）+ all-levels 清空 map', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    const m: LocalModel = { id: 'm', name: 'M' }
    edit.pickStrategy(m, 'high-max')
    // pi 黑名单过滤语义：不要的档显式写 null 才能剔除
    expect(m.thinkingLevelMap).toEqual({ off: 'off', high: 'high', max: 'xhigh', minimal: null, low: null, medium: null })
    edit.pickStrategy(m, 'on-off')
    expect(m.thinkingLevelMap).toEqual({ off: 'off', high: 'high', minimal: null, low: null, medium: null })
    edit.pickStrategy(m, 'all-levels')
    expect(m.thinkingLevelMap).toBeUndefined()
  })

  it('getStrategyFromMap 反推策略', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    expect(edit.getStrategyFromMap(undefined)).toBe('all-levels')
    expect(edit.getStrategyFromMap({ off: 'off', high: 'high' })).toBe('on-off')
    expect(edit.getStrategyFromMap({ off: 'off', high: 'high', max: 'xhigh' })).toBe('high-max')
  })
})

describe('D9 思考档位修复（reasoning 显式化 + 预设对齐 pi 过滤语义）', () => {
  it('D9②：pickStrategy 对 reasoning === undefined 的模型置 true（存量「从未设策略」形态救回）', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    const m: LocalModel = { id: 'm', name: 'M' } // reasoning 缺失（用户数据实测形态）
    edit.pickStrategy(m, 'high-max')
    expect(m.reasoning).toBe(true)

    // all-levels 分支同规则：存量最常见形态 = all-levels + reasoning 缺失，
    // 救回路径必须闭合在这里（只联动非 all-levels 会让它不闭合）
    const mAll: LocalModel = { id: 'm2', name: 'M2' }
    edit.pickStrategy(mAll, 'all-levels')
    expect(mAll.reasoning).toBe(true)
    expect(mAll.thinkingLevelMap).toBeUndefined()
  })

  it('D9②：pickStrategy 永不覆盖显式 reasoning === false（high-max 分支）', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    const m: LocalModel = { id: 'm', name: 'M', reasoning: false }
    edit.pickStrategy(m, 'high-max')
    expect(m.reasoning).toBe(false)
    // 显式选择优先于联动：pi 语义下 reasoning=false → 弹层只有「关」
    expect(supportedLevelsOf(m.thinkingLevelMap, false)).toEqual(['off'])
  })

  it('D9②：pickStrategy 永不覆盖显式 reasoning === false（all-levels 分支）', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    const m: LocalModel = { id: 'm', name: 'M', reasoning: false }
    edit.pickStrategy(m, 'all-levels')
    expect(m.reasoning).toBe(false)
    expect(m.thinkingLevelMap).toBeUndefined()
  })

  it('D9③：on-off 预设经 pi 同源函数输出 [off, high] 两档（v1 白名单心智下实际 5 档）', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    const m: LocalModel = { id: 'm', name: 'M' }
    edit.pickStrategy(m, 'on-off')
    expect(supportedLevelsOf(m.thinkingLevelMap)).toEqual(['off', 'high'])
    // Select 回显 round-trip：含 null 剔除项的 map 反推策略仍是 on-off
    expect(edit.getStrategyFromMap(m.thinkingLevelMap)).toBe('on-off')
  })

  it('D9③：high-max 预设经 pi 同源函数输出 [off, high, max] 三档（v1 实际 6 档；第三档档位名 max、map 值 xhigh）', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    const m: LocalModel = { id: 'm', name: 'M' }
    edit.pickStrategy(m, 'high-max')
    expect(supportedLevelsOf(m.thinkingLevelMap)).toEqual(['off', 'high', 'max'])
    // 展示档位名是 max，发给 pi 的实际 level 是 xhigh
    expect(m.thinkingLevelMap?.max).toBe('xhigh')
    expect(edit.getStrategyFromMap(m.thinkingLevelMap)).toBe('high-max')
  })
})

describe('headers CRUD', () => {
  it('addHeader 新增空行；removeHeader 移除 + 同步 form.headers', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    edit.addHeader()
    expect(edit.headerRows.value).toHaveLength(2) // 1（回填）+ 1
    edit.headerRows.value[1] = { key: 'X-New', value: 'v2' }
    edit.syncHeadersFromRows()
    expect(edit.form.headers['X-New']).toBe('v2')
    edit.removeHeader(1)
    expect(edit.headerRows.value).toHaveLength(1)
    expect(edit.form.headers['X-New']).toBeUndefined()
  })

  it('重复 key → actionError duplicateHeaderKey', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    edit.headerRows.value = [
      { key: 'X-A', value: '1' },
      { key: 'X-A', value: '2' },
    ]
    edit.syncHeadersFromRows()
    expect(edit.actionError.value).toBe('composable.duplicateHeaderKey')
  })
})

// ══ Phase B：B-1 凭证形态编辑态 + B-2 catalog 混合列表 builtin 过滤 ═════════════════════

describe('B-1 凭证形态（form.authMethod）', () => {
  it('回填 provider.authMethod；切换 → isDirty；保存 payload 透传 authMethod', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({ authMethod: 'api_key' }))
    const edit = mount(providerRef)
    await nextTick()
    expect(edit.form.authMethod).toBe('api_key')
    expect(edit.isDirty.value).toBe(false)

    edit.form.authMethod = 'oauth'
    expect(edit.isDirty.value).toBe(true)
    edit.form.authMethod = 'api_key'
    expect(edit.isDirty.value).toBe(false)

    edit.form.authMethod = 'oauth'
    await edit.save()
    const arg = (getTransport().setProvider as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(arg.authMethod).toBe('oauth')
  })

  it('oauth→api_key 切换 + 空 key → 守卫拦截（oauthSwitchNeedsKey，不经 setProvider）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({ authMethod: 'oauth' }))
    const edit = mount(providerRef)
    await nextTick()
    edit.form.authMethod = 'api_key'
    edit.form.apiKey = '' // 未填新 key
    const result = await edit.save()
    expect(result.ok).toBe(false)
    expect(tStub).toHaveBeenCalledWith('composable.oauthSwitchNeedsKey')
    expect(getTransport().setProvider).not.toHaveBeenCalled()
  })

  it('oauth→api_key 切换 + 新 key → payload authMethod=api_key + apiKey（catalog 覆写 OAuth 凭证的写路径）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({ authMethod: 'oauth' }))
    const edit = mount(providerRef)
    await nextTick()
    edit.form.authMethod = 'api_key'
    edit.form.apiKey = 'sk-new'
    const result = await edit.save()
    expect(result.ok).toBe(true)
    expect(result.wroteApiKey).toBe(true)
    const arg = (getTransport().setProvider as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(arg.authMethod).toBe('api_key')
    expect(arg.apiKey).toBe('sk-new')
  })

  it('无 authMethod（旧数据/新建）→ payload authMethod=undefined（runtime 跳过不写）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    expect(edit.form.authMethod).toBeUndefined()
    await edit.save()
    const arg = (getTransport().setProvider as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(arg.authMethod).toBeUndefined()
  })
})

describe('B-2 catalog 混合列表（localModels 过滤 builtin）', () => {
  const CATALOG_P = () => makeProvider({
    kind: 'catalog',
    authMethod: 'oauth',
    models: [
      { id: 'b1', name: 'B1', source: 'builtin' },
      { id: 'b2', name: 'B2', source: 'builtin' },
      { id: 'o1', name: 'O1', source: 'override' },
      { id: 'legacy', name: 'Legacy' }, // 无 source 标注（旧数据）→ 按 override 保留
    ],
  })

  it('catalog provider：编辑列表只含 override 条目（builtin 只读展示由组件层直读 provider.models）', async () => {
    const providerRef = ref<ProviderInfo | null>(CATALOG_P())
    const edit = mount(providerRef)
    await nextTick()
    expect(edit.localModels.value.map((m) => m.id)).toEqual(['o1', 'legacy'])
  })

  it('custom provider（kind 缺失同）：全量保留不过滤', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({
      models: [
        { id: 'm1', name: 'M1', contextWindow: 200_000, enabled: true },
        { id: 'm2', name: 'M2', source: 'builtin' },
      ],
    }))
    const edit = mount(providerRef)
    await nextTick()
    // custom 的 source 标注不存在（聚合层不标），全量保留
    expect(edit.localModels.value.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

})

describe('B-2 catalog save payload（builtin 不回传）', () => {
  it('catalog provider save：models 只含 override（新增条目入列，builtin 不出现）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({
      kind: 'catalog',
      models: [
        { id: 'b1', name: 'B1', source: 'builtin' },
        { id: 'o1', name: 'O1', source: 'override' },
      ],
    }))
    const edit = mount(providerRef)
    await nextTick()
    edit.newModel.name = 'new-model'
    edit.addModel()
    await edit.save()
    const arg = (getTransport().setProvider as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect((arg.models as Array<{ id: string }>).map((m) => m.id)).toEqual(['o1', 'new-model'])
  })

  it('D8 广播刷新：catalog provider 未 dirty 时 localModels 同样过滤 builtin', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({
      kind: 'catalog',
      models: [
        { id: 'b1', name: 'B1', source: 'builtin' },
        { id: 'o1', name: 'O1', source: 'override' },
      ],
    }))
    const edit = mount(providerRef)
    await nextTick()
    const store = getSettingsStore()
    store.providers.value = [makeProvider({
      kind: 'catalog',
      name: 'P1-broadcast',
      models: [
        { id: 'b1', name: 'B1', source: 'builtin' },
        { id: 'b2', name: 'B2', source: 'builtin' },
        { id: 'o1', name: 'O1', source: 'override' },
      ],
    })]
    await nextTick()
    expect(edit.form.name).toBe('P1-broadcast')
    expect(edit.localModels.value.map((m) => m.id)).toEqual(['o1'])
  })
})

// ══ B-4b：model 级 reasoning/maxTokens/cost/headers 编辑链路 round-trip（S3' 修复）══════

describe('B-4b 模型级字段 round-trip（load 编辑副本 + save payload 回传）', () => {
  const RICH_MODELS: ProviderInfo['models'] = [
    {
      id: 'm-rich', name: 'Rich',
      reasoning: true, maxTokens: 8192,
      cost: { input: 3, output: 15, cacheRead: 0.6, cacheWrite: 3.75 },
      headers: { 'X-Model': 'v1' },
      contextWindow: 200_000,
    },
    { id: 'm-plain', name: 'Plain' },
  ]

  it('load：ProviderInfo.models 的 B-4b 字段进 localModels 编辑副本（spread 透传）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({ models: RICH_MODELS }))
    const edit = mount(providerRef)
    await nextTick()
    const rich = edit.localModels.value[0]
    expect(rich.reasoning).toBe(true)
    expect(rich.maxTokens).toBe(8192)
    expect(rich.cost).toEqual({ input: 3, output: 15, cacheRead: 0.6, cacheWrite: 3.75 })
    expect(rich.headers).toEqual({ 'X-Model': 'v1' })
  })

  it('save：有值时回传四字段（B-4b 白名单写入链路接通）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({ models: RICH_MODELS }))
    const edit = mount(providerRef)
    await nextTick()
    const result = await edit.save()
    expect(result.ok).toBe(true)
    const arg = (getTransport().setProvider as ReturnType<typeof vi.fn>).mock.calls[0][1]
    const rich = (arg.models as Array<Record<string, unknown>>).find(m => m.id === 'm-rich')
    expect(rich).toMatchObject({
      reasoning: true,
      maxTokens: 8192,
      cost: { input: 3, output: 15, cacheRead: 0.6, cacheWrite: 3.75 },
      headers: { 'X-Model': 'v1' },
    })
  })

  it('save：无值时不传键（undefined = runtime base spread 保留既有值）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({ models: RICH_MODELS }))
    const edit = mount(providerRef)
    await nextTick()
    await edit.save()
    const arg = (getTransport().setProvider as ReturnType<typeof vi.fn>).mock.calls[0][1]
    const plain = (arg.models as Array<Record<string, unknown>>).find(m => m.id === 'm-plain')
    expect(plain).not.toHaveProperty('reasoning')
    expect(plain).not.toHaveProperty('maxTokens')
    expect(plain).not.toHaveProperty('cost')
    expect(plain).not.toHaveProperty('headers')
  })
})

// ══ S8：OAuth 授权广播 × isDirty 竞态（BL round1 S4）══════════════════════════

describe('S8 OAuth 授权完成广播 × isDirty 竞态（authMethod 单字段强制对齐）', () => {
  it('dirty（其他字段编辑中）+ 广播 authMethod=oauth（父组件授权完成回推）→ form.authMethod 对齐且不覆盖用户其他编辑；save 不回写 api_key 标注', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({ authMethod: 'api_key' }))
    const edit = mount(providerRef)
    await nextTick()
    expect(edit.form.authMethod).toBe('api_key')

    // 用户有其他未保存编辑（如改 name）→ dirty
    edit.form.name = 'P1-user-edit'
    expect(edit.isDirty.value).toBe(true)

    // 父组件完成 OAuth 授权 → setProvider authMethod='oauth' → onProviders 广播回推
    const store = getSettingsStore()
    store.providers.value = [makeProvider({ authMethod: 'oauth' })]
    await nextTick()

    // authMethod 强制对齐（dirty 例外），name 保留用户未保存编辑
    expect(edit.form.authMethod).toBe('oauth')
    expect(edit.form.name).toBe('P1-user-edit')

    // 快照 authMethod 位已重拍：保存 payload authMethod='oauth'，apiKey 空 → undefined
    // （不覆写刚登录的 oauth 凭证）
    const result = await edit.save()
    expect(result.ok).toBe(true)
    expect(result.wroteApiKey).toBe(false)
    const arg = (getTransport().setProvider as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(arg.authMethod).toBe('oauth')
    expect(arg.apiKey).toBeUndefined()
  })

  it('用户已手动切换形态（pending 未保存）→ 广播不覆写本地切换意图', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({ authMethod: 'oauth' }))
    const edit = mount(providerRef)
    await nextTick()
    edit.form.authMethod = 'api_key' // 用户 pending 切换（dirty 由 authMethod 贡献）
    expect(edit.isDirty.value).toBe(true)

    const store = getSettingsStore()
    store.providers.value = [makeProvider({ authMethod: 'oauth' })]
    await nextTick()

    // 广播携带的 oauth 不强制对齐——本地切换意图优先（保存时按用户选择写 api_key）
    expect(edit.form.authMethod).toBe('api_key')
  })
})
