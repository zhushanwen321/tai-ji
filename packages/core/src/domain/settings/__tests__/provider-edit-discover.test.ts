/**
 * provider-edit-discover（test / discover 探活 module）interface 级测试（[C4] 拆分后按
 * module 打点，原 use-provider-edit.test.ts 的 runDiscover 两组用例迁移至此）。
 *
 * 覆盖：M3b 协议分流（test 只发 providerId + mode / discover 全参）/ test 结果消费
 * （results 分组与整体性失败互斥、旧 runtime 无 results 兜底）/ discover 合并与结果文案
 * / reject 收尾（testResult error + actionError，不静默吞）/ resetTransient。
 *
 * 合并规则本体（去重 + D9①）归 provider-edit-models.test.ts；本文件只断言编排接线。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { reactive, ref, effectScope } from 'vue'
import type { ProviderInfo, ProviderId } from '@taiji/shared'
import {
  provideSettingsTransport,
  __resetSettingsTransportForTesting,
  type SettingsTransport,
} from '../transport'
import type { DiscoverModelsResponse } from '../transport'
import type { ProviderEditFormDraft } from '../provider-edit-form'
import { createProviderEditModels, type ProviderEditModelsModule } from '../provider-edit-models'
import { createProviderEditDiscover, type ProviderEditDiscoverModule } from '../provider-edit-discover'

/** i18n stub：返回 key 本身（校验调用参数而非翻译）。 */
const tStub = vi.fn((key: string) => key)

function makeFakeTransport(): SettingsTransport {
  return {
    listProviders: vi.fn(async () => ({ providers: [] })),
    listModels: vi.fn(async () => []),
    setScopedModels: vi.fn(async (_models: string[]): Promise<string[]> => []),
    setProvider: vi.fn(async () => ({})),
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

/** 当前注入的 fake transport（模块级，供断言用）。 */
let currentTransport: SettingsTransport

function getTransport(): SettingsTransport {
  return currentTransport
}

beforeEach(() => {
  __resetSettingsTransportForTesting()
  currentTransport = makeFakeTransport()
  provideSettingsTransport(currentTransport)
  tStub.mockClear()
  tStub.mockImplementation((key: string) => key)
})

let scope: ReturnType<typeof effectScope> | null = null

afterEach(() => {
  scope?.stop()
  scope = null
})

function makeDraft(overrides: Partial<ProviderEditFormDraft> = {}): ProviderEditFormDraft {
  return {
    name: 'P1',
    api: 'anthropic-messages',
    baseUrl: 'https://api.example.com',
    apiKey: '',
    headers: {},
    authHeader: false,
    authMethod: undefined,
    ...overrides,
  }
}

function makeProvider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'p1' as ProviderId,
    name: 'P1',
    api: 'anthropic-messages',
    baseUrl: 'https://api.example.com',
    apiKeySet: true,
    status: 'connected',
    models: [{ id: 'm1', name: 'M1', contextWindow: 200_000, enabled: true }],
    enabled: true,
    ...overrides,
  }
}

interface MountedDiscover {
  discover: ProviderEditDiscoverModule
  models: ProviderEditModelsModule
  actionError: ReturnType<typeof ref<string>>
}

/** 挂 discover module（models module 同场装配：合并目标 + 计数来源） */
function mountDiscover(options: {
  provider?: ProviderInfo | null
  draft?: ProviderEditFormDraft
} = {}): MountedDiscover {
  const providerRef = ref<ProviderInfo | null>(options.provider ?? makeProvider())
  const draft = reactive<ProviderEditFormDraft>(options.draft ?? makeDraft())
  const actionError = ref('')
  scope = effectScope()
  // effectScope.run 类型签名 T | undefined——活动 scope 内同步返回值恒非空
  return scope!.run(() => {
    const models = createProviderEditModels({ t: tStub })
    models.applyProvider(providerRef.value)
    const discover = createProviderEditDiscover({ providerRef, draft, actionError, models, t: tStub })
    return { discover, models, actionError }
  })!
}

describe('runDiscover test 分支（探活）', () => {
  it('成功 → testResult ok；discoverModels 调用参数带 mode=test 且只需 providerId（协议占位 baseUrl=""）', async () => {
    const { discover } = mountDiscover({ draft: makeDraft({ baseUrl: 'https://api.example.com', apiKey: 'sk-abc' }) })
    await discover.testConnection()
    // M3b（设计 D4）：test 模式代表模型选择归 runtime——前端不发 baseUrl/apiKey/providerType
    // （快照 artifact 不参战）；baseUrl 是协议形状必填键（shared/protocol.ts），传 '' 占位。
    expect(getTransport().discoverModels).toHaveBeenCalledWith({
      mode: 'test',
      baseUrl: '',
      providerId: 'p1',
    })
    expect(discover.testResult.value).toBe('ok')
    expect(discover.testing.value).toBe(false)
  })

  it('M3b：成功返回 results → testResults 按协议分组消费（每协议 api/modelId/ok/error）', async () => {
    const { discover } = mountDiscover()
    // error 语法 = M3a runtime 实装（model-connection-tester.ts 头注「错误编码」）
    getTransport().discoverModels = vi.fn(async (): Promise<DiscoverModelsResponse> => ({
      success: true,
      models: [],
      results: [
        { api: 'anthropic-messages', modelId: 'minimax-m3', ok: true },
        { api: 'openai-completions', modelId: 'qwen3.8-flash', ok: false, error: 'http_error|401|invalid api key' },
      ],
    }))
    await discover.testConnection()
    expect(discover.testResults.value).toEqual([
      { api: 'anthropic-messages', modelId: 'minimax-m3', ok: true },
      { api: 'openai-completions', modelId: 'qwen3.8-flash', ok: false, error: 'http_error|401|invalid api key' },
    ])
    // 行级失败不改变顶层 success（M3a 语义）——行内失败由行文案承载
    expect(discover.testResult.value).toBe('ok')
    expect(discover.testError.value).toBe('')
  })

  it('M3b：success=false 整体性失败 → results 空 + testError 携带原因（可展示状态，不抛全局）', async () => {
    const { discover, actionError } = mountDiscover()
    getTransport().discoverModels = vi.fn(async () => ({ success: false, error: 'no_api_key', results: [] }))
    await discover.testConnection()
    expect(discover.testResults.value).toEqual([])
    expect(discover.testError.value).toBe('no_api_key')
    expect(discover.testResult.value).toBe('error')
    expect(actionError.value).toBe('no_api_key')
  })

  it('M3b：runtime 未回 results（旧 runtime）→ testResults 空数组（UI 走整体反馈兜底）', async () => {
    const { discover } = mountDiscover()
    getTransport().discoverModels = vi.fn(async () => ({ success: true, models: [] }))
    await discover.testConnection()
    expect(discover.testResults.value).toEqual([])
    expect(discover.testResult.value).toBe('ok')
  })

  it('reject → testResult error + actionError 消息（网络故障不静默吞）', async () => {
    const { discover, actionError } = mountDiscover()
    getTransport().discoverModels = vi.fn(async () => { throw new Error('net down') })
    await discover.testConnection()
    expect(discover.testResult.value).toBe('error')
    expect(actionError.value).toBe('net down')
    expect(discover.testing.value).toBe(false)
  })
})

describe('runDiscover discover 分支（自动发现 + 合并）', () => {
  it('M3b：discover 调用参数带 mode=discover + baseUrl/apiKey/providerType/providerId', async () => {
    const { discover } = mountDiscover({ draft: makeDraft({ baseUrl: 'https://api.example.com', apiKey: 'sk-abc' }) })
    await discover.autoDiscover()
    expect(getTransport().discoverModels).toHaveBeenCalledWith({
      mode: 'discover',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-abc',
      providerType: 'anthropic-messages',
      providerId: 'p1',
    })
  })

  it('成功：合并入清单 + discoverResult 文案（newMerged；total/addedCount 计数接线）', async () => {
    const { discover, models } = mountDiscover() // localModels 已有 m1
    getTransport().discoverModels = vi.fn(async () => ({
      success: true,
      models: [
        { id: 'm1', name: 'M1', contextWindow: 200_000 },
        { id: 'm2', name: 'M2', contextWindow: 128_000 },
      ],
    }))
    await discover.autoDiscover()
    expect(models.localModels.value.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(tStub).toHaveBeenCalledWith('composable.discoveredModels', expect.anything())
    expect(tStub).toHaveBeenCalledWith('composable.newMerged', { count: 1 })
    expect(discover.discovering.value).toBe(false)
  })

  it('成功：全部已存在 → allExisted 文案（addedCount 0 分支）', async () => {
    const { discover, models } = mountDiscover()
    getTransport().discoverModels = vi.fn(async () => ({
      success: true,
      models: [{ id: 'm1', name: 'M1' }],
    }))
    await discover.autoDiscover()
    expect(models.localModels.value).toHaveLength(1)
    expect(tStub).toHaveBeenCalledWith('composable.allExisted')
  })

  it('失败：success:false → actionError（discoverFailed 兜底文案）', async () => {
    const { discover, actionError } = mountDiscover()
    getTransport().discoverModels = vi.fn(async () => ({ success: false, error: 'fail' }))
    await discover.autoDiscover()
    expect(actionError.value).toBe('fail')
  })

  it('success:false 且无 error → actionError 用 t(discoverFailed) 兜底（错误可见不静默）', async () => {
    const { discover, actionError } = mountDiscover()
    getTransport().discoverModels = vi.fn(async () => ({ success: false }))
    await discover.autoDiscover()
    expect(actionError.value).toBe('composable.discoverFailed')
  })

  it('reject → actionError 消息 + discovering 收尾', async () => {
    const { discover, actionError } = mountDiscover()
    getTransport().discoverModels = vi.fn(async () => { throw new Error('boom') })
    await discover.autoDiscover()
    expect(actionError.value).toBe('boom')
    expect(discover.discovering.value).toBe(false)
  })
})

describe('瞬态重置（resetTransient）', () => {
  it('provider 切换重置 test/discover 结果（不留上一个 provider 的结果）', async () => {
    const { discover } = mountDiscover()
    getTransport().discoverModels = vi.fn(async () => ({ success: true, models: [] }))
    await discover.testConnection()
    expect(discover.testResult.value).toBe('ok')
    discover.resetTransient()
    expect(discover.testResult.value).toBeNull()
    expect(discover.testResults.value).toEqual([])
    expect(discover.testError.value).toBe('')
    expect(discover.discoverResult.value).toBe('')
  })
})
