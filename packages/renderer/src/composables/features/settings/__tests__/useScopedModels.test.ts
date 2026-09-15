/**
 * useScopedModels composable 测试（A4 验收标准）。
 *
 * A3: add/remove/move 调 RPC 且乐观更新 + 失败回滚。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { getSettingsStore, __resetSettingsStoreForTesting } from '@taiji/core'
import { SCOPED_MODEL_RENDERER_TOKEN } from './impl-token'

const configMock = vi.hoisted(() => ({
  setScopedModels: vi.fn(async () => [] as string[]),
}))

vi.mock('@/api', () => ({
  config: configMock,
  default: { config: configMock },
}))

import { useScopedModels } from '../useScopedModels'

const MOCK_PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    apiKeySet: true,
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    apiKeySet: false,
    models: [
      { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
    ],
  },
]

beforeEach(() => {
  setActivePinia(createPinia())
  __resetSettingsStoreForTesting()
  configMock.setScopedModels.mockReset()
})

describe('useScopedModels', () => {
  it('A3: impl-token 存在（红阶段区分力守卫）', () => {
    expect(SCOPED_MODEL_RENDERER_TOKEN).toBe('scoped-model-renderer-v1')
  })

  it('A3: scopedRenderItems 从 settingsStore.scopedModels + providers 派生', () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5', 'deleted/missing']

    const { scopedRenderItems } = useScopedModels()
    const items = scopedRenderItems.value
    expect(items.length).toBe(3)

    expect(items[0].modelName).toBe('GPT-4o')
    expect(items[0].providerName).toBe('OpenAI')
    expect(items[0].apiKeySet).toBe(true)
    expect(items[0].missing).toBe(false)

    expect(items[1].modelName).toBe('Claude Sonnet 4.5')
    expect(items[1].providerName).toBe('Anthropic')
    expect(items[1].apiKeySet).toBe(false)
    expect(items[1].missing).toBe(false)

    expect(items[2].missing).toBe(true)
  })

  it('A3: selectableModels 从 providers 派生全量模型列表', () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any

    const { selectableModels } = useScopedModels()
    const models = selectableModels.value
    expect(models.length).toBe(3)
    expect(models[0].fullId).toBe('openai/gpt-4o')
    expect(models[1].fullId).toBe('openai/gpt-4o-mini')
    expect(models[2].fullId).toBe('anthropic/claude-sonnet-4.5')
  })

  it('A3: addScopedModels 乐观更新 + RPC 成功 → 状态保持', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o']

    configMock.setScopedModels.mockResolvedValueOnce(['openai/gpt-4o', 'openai/gpt-4o-mini'])

    const { addScopedModels } = useScopedModels()
    await addScopedModels(['openai/gpt-4o-mini'])

    expect(configMock.setScopedModels).toHaveBeenCalledWith(['openai/gpt-4o', 'openai/gpt-4o-mini'])
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o', 'openai/gpt-4o-mini'])
  })

  it('A3: addScopedModels RPC 失败 → 回滚到旧值 + rethrow（调用方反馈）', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o']

    configMock.setScopedModels.mockRejectedValueOnce(new Error('network error'))

    const { addScopedModels } = useScopedModels()
    await expect(addScopedModels(['openai/gpt-4o-mini'])).rejects.toThrow('network error')

    // 回滚
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o'])
  })

  it('A3: removeScopedModel 乐观更新 + RPC 成功 → 状态保持', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'openai/gpt-4o-mini']

    configMock.setScopedModels.mockResolvedValueOnce(['openai/gpt-4o-mini'])

    const { removeScopedModel } = useScopedModels()
    await removeScopedModel('openai/gpt-4o')

    expect(configMock.setScopedModels).toHaveBeenCalledWith(['openai/gpt-4o-mini'])
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o-mini'])
  })

  it('A3: removeScopedModel RPC 失败 → 回滚 + rethrow', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'openai/gpt-4o-mini']

    configMock.setScopedModels.mockRejectedValueOnce(new Error('fail'))

    const { removeScopedModel } = useScopedModels()
    await expect(removeScopedModel('openai/gpt-4o')).rejects.toThrow('fail')

    expect(store.scopedModels.value).toEqual(['openai/gpt-4o', 'openai/gpt-4o-mini'])
  })

  it('A3: moveScopedModel 上移 → 顺序变化 + RPC 成功', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5']

    configMock.setScopedModels.mockResolvedValueOnce(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])

    const { moveScopedModel } = useScopedModels()
    await moveScopedModel('anthropic/claude-sonnet-4.5', 'up')

    expect(configMock.setScopedModels).toHaveBeenCalledWith(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
    expect(store.scopedModels.value).toEqual(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
  })

  it('A3: moveScopedModel 下移 → 顺序变化 + RPC 成功', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5']

    configMock.setScopedModels.mockResolvedValueOnce(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])

    const { moveScopedModel } = useScopedModels()
    await moveScopedModel('openai/gpt-4o', 'down')

    expect(configMock.setScopedModels).toHaveBeenCalledWith(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
    expect(store.scopedModels.value).toEqual(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
  })

  it('A3: moveScopedModel RPC 失败 → 回滚顺序 + rethrow', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5']

    configMock.setScopedModels.mockRejectedValueOnce(new Error('fail'))

    const { moveScopedModel } = useScopedModels()
    await expect(moveScopedModel('openai/gpt-4o', 'down')).rejects.toThrow('fail')

    expect(store.scopedModels.value).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4.5'])
  })

  it('A3: move in-flight 时连点第二次触发被忽略（模块级防重入守卫）', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5']

    // 第一次 RPC 挂起（deferred），锁定 in-flight 窗口
    let resolveFirst: (v: string[]) => void = () => {}
    configMock.setScopedModels.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => { resolveFirst = resolve }),
    )

    const { moveScopedModel } = useScopedModels()
    const first = moveScopedModel('openai/gpt-4o', 'down')
    // 连点：第一次乐观交换后 anthropic 位于 idx0，其 down 本有效（无守卫会二次 RPC），
    // 守卫生效 → 直接忽略，不排队、不改快照
    await moveScopedModel('anthropic/claude-sonnet-4.5', 'down')

    // 乐观状态 = 仅第一次交换结果
    expect(store.scopedModels.value).toEqual(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])

    resolveFirst(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
    await first

    expect(configMock.setScopedModels).toHaveBeenCalledTimes(1)
    expect(configMock.setScopedModels).toHaveBeenCalledWith(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
    expect(store.scopedModels.value).toEqual(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'])
  })

  it('A3: addScopedModels 跳过已存在的重复项', async () => {
    const store = getSettingsStore()
    store.providers.value = MOCK_PROVIDERS as any
    store.scopedModels.value = ['openai/gpt-4o']

    const { addScopedModels } = useScopedModels()
    await addScopedModels(['openai/gpt-4o'])

    // 不调 RPC（无新项）
    expect(configMock.setScopedModels).not.toHaveBeenCalled()
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o'])
  })
})
