/**
 * provider-edit-discover（discover + per-model 测试编排 module）interface 级测试（[C4] 拆分后
 * 按 module 打点，原 use-provider-edit.test.ts 的 runDiscover 两组用例迁移至此）。
 *
 * 覆盖：testModel 请求形状（mode=test + modelId，协议占位 baseUrl=""）/ 行结果消费
 * （成败写 modelTestResults，顶层失败走 actionError 不覆盖行结果）/ discover 合并与结果文案
 * / reject 收尾（testingModelIds 复位 + actionError，不静默吞）/ 重复点击防护 / resetTransient。
 *
 * 合并规则本体（去重 + D9①）归 provider-edit-models.test.ts；本文件只断言编排接线。
 * 2026-10-21：provider 级「测试连接」入口随 per-model 行内入口下沉退役（用户拍板），
 * 原 test 分支用例由 testModel 等价承载；provider 级分组测试 RPC 兼容路径在 runtime 侧。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { reactive, ref, effectScope } from 'vue'
import type { ProviderInfo, ProviderId } from '@taiji/shared'
import {
  provideSettingsTransport,
  type SettingsTransport,
} from '../transport'
import { makeFakeTransport } from './helpers/fake-transport'
import type { DiscoverModelsResponse } from '../transport'
import type { ProviderEditFormDraft } from '../provider-edit-form'
import { API_KEY_CLEAR_SENTINEL, resolveApiKeyForSave } from '../provider-edit-form'
import { createProviderEditModels, type ProviderEditModelsModule } from '../provider-edit-models'
import { createProviderEditDiscover, type ProviderEditDiscoverModule } from '../provider-edit-discover'

/** i18n stub：返回 key 本身（校验调用参数而非翻译）；调用记录在每用例 mount 时复位。 */
const tStub = vi.fn((key: string) => key)

// fake transport 工厂迁 ./helpers/fake-transport（[C3] seam 方法侧全覆盖共享工厂）

/** mountDiscover 挂载的 effectScope（afterEach 统一回收）。 */
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
  /** 本用例注入的 fake transport（discoverModels 打桩与调用参数断言都指向它） */
  transport: SettingsTransport
  discover: ProviderEditDiscoverModule
  models: ProviderEditModelsModule
  actionError: ReturnType<typeof ref<string>>
}

/** 挂 discover module（每用例唯一装配点：fresh transport 注入 + tStub 复位；models module 同场装配：合并目标 + 计数来源） */
function mountDiscover(options: {
  provider?: ProviderInfo | null
  draft?: ProviderEditFormDraft
  /** 真实未保存草稿取值器（默认按 save 同源判据从 draft 推导；MF-1-1 断言注入点用） */
  pendingApiKey?: () => string | undefined
} = {}): MountedDiscover {
  const transport = makeFakeTransport()
  provideSettingsTransport(transport)
  tStub.mockClear()
  tStub.mockImplementation((key: string) => key)
  // provider: null（新增态）是合法显式值，?? 会吞掉——判 undefined 才走默认
  const providerRef = ref<ProviderInfo | null>(options.provider !== undefined ? options.provider : makeProvider())
  const draft = reactive<ProviderEditFormDraft>(options.draft ?? makeDraft())
  // 动作错误派生视图 stub（MF-1-7 写通道协议：report/clear 落到本地 ref 供断言）
  const actionError = ref('')
  scope = effectScope()
  // effectScope.run 类型签名 T | undefined——活动 scope 内同步返回值恒非空
  return scope!.run(() => {
    const models = createProviderEditModels({ t: tStub })
    models.applyProvider(providerRef.value)
    const discover = createProviderEditDiscover({
      providerRef,
      draft,
      pendingApiKey: options.pendingApiKey ?? (() => resolveApiKeyForSave(draft.apiKey)),
      reportActionError: (message) => { actionError.value = message },
      clearActionError: () => { actionError.value = '' },
      models,
      t: tStub,
    })
    return { transport, discover, models, actionError }
  })!
}

/** discoverModels 桩：response 正常回包 / rejectWith 抛错（网络故障路径）。 */
type DiscoverStub = { response: DiscoverModelsResponse } | { rejectWith: Error }

/** testModel / discover 共用用例骨架的参数：桩与装配覆写都可选。 */
interface DiscoverCaseOptions {
  /** 省略 stub = 沿用 fake transport 默认回包 */
  stub?: DiscoverStub
  mount?: Parameters<typeof mountDiscover>[0]
}

/**
 * testModel / discover 共用用例骨架：mount → 打 discoverModels 桩 → 执行分支动作。
 * 分支差异（testModel 目标固定 m1 / autoDiscover）与桩差异（回包 / 抛错）经参数表达。
 */
async function runDiscoverCase(
  mode: 'test' | 'discover',
  options: DiscoverCaseOptions = {},
): Promise<MountedDiscover> {
  const mounted = mountDiscover(options.mount)
  const { stub } = options
  if (stub) {
    if ('rejectWith' in stub) {
      const { rejectWith } = stub
      mounted.transport.discoverModels = vi.fn(async () => { throw rejectWith })
    } else {
      const { response } = stub
      mounted.transport.discoverModels = vi.fn(async () => response)
    }
  }
  if (mode === 'test') {
    await mounted.discover.testModel('m1')
  } else {
    await mounted.discover.autoDiscover()
  }
  return mounted
}

describe('testModel（per-model 行内测试）', () => {
  it('请求形状：mode=test + modelId + providerId（协议占位 baseUrl=""，代表模型选择不参与）', async () => {
    const { transport } = await runDiscoverCase('test', {
      mount: { draft: makeDraft({ baseUrl: 'https://api.example.com', apiKey: 'sk-abc' }) },
    })
    // 端点回落链归 runtime（与 provider 级测试同源）；baseUrl 是协议形状必填键（shared/protocol.ts），传 '' 占位
    expect(transport.discoverModels).toHaveBeenCalledWith({
      mode: 'test',
      baseUrl: '',
      providerId: 'p1',
      modelId: 'm1',
    })
  })

  it('行结果消费：results[0] 写 modelTestResults[modelId]（含 ok 行与 durationMs）', async () => {
    const row = { api: 'anthropic-messages', modelId: 'm1', ok: true, durationMs: 812 }
    const { discover } = await runDiscoverCase('test', {
      stub: { response: { success: true, models: [], results: [row] } },
    })
    expect(discover.modelTestResults.value['m1']).toEqual(row)
    expect(discover.testingModelIds.value).toEqual([])
  })

  it('行级失败如实落行（http_error）：行内展示真实原因，顶层不抛', async () => {
    const row = { api: 'openai-completions', modelId: 'm1', ok: false, error: 'http_error|400|MissingSessionID' }
    const { discover, actionError } = await runDiscoverCase('test', {
      stub: { response: { success: true, models: [], results: [row] } },
    })
    expect(discover.modelTestResults.value['m1']?.ok).toBe(false)
    expect(discover.modelTestResults.value['m1']?.error).toBe('http_error|400|MissingSessionID')
    expect(actionError.value).toBe('')
  })

  it('顶层 provider 级失败（success=false）→ actionError + 不写行结果（无行可报）', async () => {
    const { discover, actionError } = await runDiscoverCase('test', {
      stub: { response: { success: false, error: 'no_api_key', results: [] } },
    })
    expect(actionError.value).toBe('no_api_key')
    expect(discover.modelTestResults.value['m1']).toBeUndefined()
  })

  it('reject → actionError + testingModelIds 复位（网络故障不静默吞、按钮不卡 spinner）', async () => {
    const { discover, actionError } = await runDiscoverCase('test', {
      stub: { rejectWith: new Error('net down') },
    })
    expect(actionError.value).toBe('net down')
    expect(discover.testingModelIds.value).toEqual([])
  })

  it('重复点击防护：同 modelId 测试进行中再次调用直接返回（不并发发包）', async () => {
    const mounted = mountDiscover()
    let release: (value: DiscoverModelsResponse) => void = () => {}
    mounted.transport.discoverModels = vi.fn(async () => new Promise<DiscoverModelsResponse>((resolve) => { release = resolve }))
    const first = mounted.discover.testModel('m1')
    expect(mounted.discover.testingModelIds.value).toEqual(['m1'])
    await mounted.discover.testModel('m1')
    expect(mounted.transport.discoverModels).toHaveBeenCalledTimes(1)
    release({ success: true, models: [], results: [{ api: 'anthropic-messages', modelId: 'm1', ok: true }] })
    await first
    expect(mounted.discover.testingModelIds.value).toEqual([])
  })

  it('canTest：新增态（providerRef=null）为 false——UI 据此禁用按钮并提示先保存；已保存 provider 为 true', () => {
    const newMode = mountDiscover({ provider: null })
    expect(newMode.discover.canTest.value).toBe(false)
    const editMode = mountDiscover()
    expect(editMode.discover.canTest.value).toBe(true)
  })
})

describe('runDiscover discover 分支（自动发现 + 合并）', () => {
  it('M3b：discover 调用参数带 mode=discover + baseUrl/apiKey/providerType/providerId', async () => {
    const { transport } = await runDiscoverCase('discover', {
      mount: { draft: makeDraft({ baseUrl: 'https://api.example.com', apiKey: 'sk-abc' }) },
    })
    expect(transport.discoverModels).toHaveBeenCalledWith({
      mode: 'discover',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-abc',
      providerType: 'anthropic-messages',
      providerId: 'p1',
    })
  })

  it('MF-1-1：pendingApiKey 为空（draft 是回显值 = 所存值）→ 不带 apiKey（runtime 走 resolver）', async () => {
    const { transport } = await runDiscoverCase('discover', {
      mount: {
        draft: makeDraft({ apiKey: '$OPENAI_API_KEY' }),
        // 模拟 form.apiKeyPendingDraft：草稿 === 回显值 → 非待保存草稿
        pendingApiKey: () => undefined,
      },
    })
    const req = vi.mocked(transport.discoverModels).mock.calls[0]![0]
    expect(req.apiKey).toBeUndefined()
  })

  it('D18 清除哨兵 → pendingApiKey 返回空串（wire = 不带 key，runtime 走 resolver；discover 不删凭据）', async () => {
    const { transport } = await runDiscoverCase('discover', {
      mount: { draft: makeDraft({ apiKey: API_KEY_CLEAR_SENTINEL }) },
    })
    const req = vi.mocked(transport.discoverModels).mock.calls[0]![0]
    expect(req.apiKey).toBe('')
  })

  it('成功：合并入清单 + discoverResult 文案（newMerged；total/addedCount 计数接线）', async () => {
    const { discover, models } = await runDiscoverCase('discover', {
      // localModels 已有 m1
      stub: {
        response: {
          success: true,
          models: [
            { id: 'm1', name: 'M1', contextWindow: 200_000 },
            { id: 'm2', name: 'M2', contextWindow: 128_000 },
          ],
        },
      },
    })
    expect(models.localModels.value.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(tStub).toHaveBeenCalledWith('composable.discoveredModels', expect.anything())
    expect(tStub).toHaveBeenCalledWith('composable.newMerged', { count: 1 })
    expect(discover.discovering.value).toBe(false)
  })

  it('成功：全部已存在 → allExisted 文案（addedCount 0 分支）', async () => {
    const { discover, models } = await runDiscoverCase('discover', {
      stub: { response: { success: true, models: [{ id: 'm1', name: 'M1' }] } },
    })
    expect(models.localModels.value).toHaveLength(1)
    expect(tStub).toHaveBeenCalledWith('composable.allExisted')
  })

  it('失败：success:false → actionError（discoverFailed 兜底文案）', async () => {
    const { actionError } = await runDiscoverCase('discover', {
      stub: { response: { success: false, error: 'fail' } },
    })
    expect(actionError.value).toBe('fail')
  })

  it('success:false 且无 error → actionError 用 t(discoverFailed) 兜底（错误可见不静默）', async () => {
    const { actionError } = await runDiscoverCase('discover', {
      stub: { response: { success: false } },
    })
    expect(actionError.value).toBe('composable.discoverFailed')
  })

  it('reject → actionError 消息 + discovering 收尾', async () => {
    const { discover, actionError } = await runDiscoverCase('discover', {
      stub: { rejectWith: new Error('boom') },
    })
    expect(actionError.value).toBe('boom')
    expect(discover.discovering.value).toBe(false)
  })
})

describe('瞬态重置（resetTransient）', () => {
  it('provider 切换重置 per-model 测试与 discover 结果（不留上一个 provider 的结果）', async () => {
    const { discover } = await runDiscoverCase('test', {
      stub: { response: { success: true, models: [], results: [{ api: 'anthropic-messages', modelId: 'm1', ok: true }] } },
    })
    expect(discover.modelTestResults.value['m1']?.ok).toBe(true)
    discover.resetTransient()
    expect(discover.modelTestResults.value).toEqual({})
    expect(discover.testingModelIds.value).toEqual([])
    expect(discover.discoverResult.value).toBe('')
  })
})
