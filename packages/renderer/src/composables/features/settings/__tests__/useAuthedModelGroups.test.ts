/**
 * useAuthedModelGroups 守卫测试（design scoped-model-extension-candidates T3）。
 *
 * 核心守卫：extension 模型配置候选来自 providers 全量派生，与 scopedModels 白名单无关
 * （scoped 只控制 Composer 切换器显示，见 settings-store models ref 契约注释）。
 * 回归背景：曾错用 settingsStore.models（scoped 过滤后列表）作数据源，导致设置 scoped 后
 * rename/compact 下拉只剩白名单内模型、存量 scoped 外配置被误报「不可用」。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { getSettingsStore, __resetSettingsStoreForTesting } from '@taiji/core'
import { useAuthedModelGroups, staleModelRef } from '../useAuthedModelGroups'
import type { ProviderInfo } from '@taiji/shared'

/** 双 provider fixture：zai 已配凭证（2 模型）、xiaomi 已配凭证（1 模型）。 */
function mockProviders(extra: Partial<ProviderInfo> = {}): ProviderInfo[] {
  return [
    {
      id: 'zai',
      name: '智谱',
      apiKeySet: true,
      status: 'ok',
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2' },
        { id: 'glm-5.2-air', name: 'GLM-5.2-Air' },
      ],
      ...extra,
    },
    {
      id: 'xiaomi',
      name: '小米',
      apiKeySet: true,
      status: 'ok',
      models: [{ id: 'mimo-v2.5-pro', name: 'MiMo v2.5 Pro' }],
      ...extra,
    },
  ] as ProviderInfo[]
}

beforeEach(() => {
  setActivePinia(createPinia())
  __resetSettingsStoreForTesting()
})

describe('useAuthedModelGroups', () => {
  it('守卫：scopedModels 非空时候选仍为全量（不受白名单过滤）', () => {
    const store = getSettingsStore()
    store.providers.value = mockProviders()
    // 模拟旧 bug 场景：settingsStore.models 已被 scoped 过滤为仅 1 项
    store.models.value = [
      { providerId: 'zai', providerName: '智谱', id: 'glm-5.2', name: 'GLM-5.2' },
    ] as never
    store.scopedModels.value = ['zai/glm-5.2']

    const { modelGroups, availableValues } = useAuthedModelGroups()

    // 候选 = providers 全量 3 模型，而非 models 的 1 模型
    expect(availableValues.value).toEqual(
      new Set(['zai/glm-5.2', 'zai/glm-5.2-air', 'xiaomi/mimo-v2.5-pro']),
    )
    expect(modelGroups.value.map((g) => g.providerId)).toEqual(['zai', 'xiaomi'])
    expect(modelGroups.value[1].models[0]).toEqual({
      value: 'xiaomi/mimo-v2.5-pro',
      label: 'MiMo v2.5 Pro',
    })
  })

  it('scopedModels 为空时候选与修复前行为一致（全量）', () => {
    const store = getSettingsStore()
    store.providers.value = mockProviders()
    store.scopedModels.value = []

    const { availableValues } = useAuthedModelGroups()
    expect(availableValues.value.size).toBe(3)
  })

  it('D1 过滤：未配凭证 / 禁用 provider 的模型不列', () => {
    const store = getSettingsStore()
    store.providers.value = [
      ...mockProviders(),
      {
        id: 'nokey',
        name: '无凭证',
        apiKeySet: false,
        status: 'ok',
        models: [{ id: 'm1', name: 'M1' }],
      },
      {
        id: 'disabled-p',
        name: '禁用 Provider',
        apiKeySet: true,
        enabled: false,
        status: 'ok',
        models: [{ id: 'm2', name: 'M2' }],
      },
    ] as ProviderInfo[]

    const { availableValues } = useAuthedModelGroups()
    expect(availableValues.value.has('nokey/m1')).toBe(false)
    expect(availableValues.value.has('disabled-p/m2')).toBe(false)
    expect(availableValues.value.size).toBe(3)
  })

  it('D1 过滤：model.enabled === false 的模型不列（禁用口径与 Composer 一致）', () => {
    const store = getSettingsStore()
    store.providers.value = mockProviders()
    store.providers.value[0] = {
      ...store.providers.value[0],
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2' },
        { id: 'glm-5.2-air', name: 'GLM-5.2-Air', enabled: false },
      ],
    }

    const { availableValues } = useAuthedModelGroups()
    expect(availableValues.value.has('zai/glm-5.2-air')).toBe(false)
    expect(availableValues.value.size).toBe(2)
  })

  it('空分组不渲染：有凭证但全部模型禁用的 provider 不占分组', () => {
    const store = getSettingsStore()
    store.providers.value = [
      {
        id: 'all-disabled',
        name: '全禁用',
        apiKeySet: true,
        status: 'ok',
        models: [{ id: 'm1', name: 'M1', enabled: false }],
      },
    ] as ProviderInfo[]

    const { modelGroups } = useAuthedModelGroups()
    expect(modelGroups.value).toEqual([])
  })

  it('label 回退：model.name 缺省时用 id', () => {
    const store = getSettingsStore()
    store.providers.value = [
      {
        id: 'p1',
        name: 'P1',
        apiKeySet: true,
        status: 'ok',
        models: [{ id: 'bare-id' }],
      },
    ] as ProviderInfo[]

    const { modelGroups } = useAuthedModelGroups()
    expect(modelGroups.value[0].models[0].label).toBe('bare-id')
  })

  it('staleModelRef：scoped 外 ref 在全量候选内不再误报 stale（D2 语义修正）', () => {
    const store = getSettingsStore()
    store.providers.value = mockProviders()
    store.scopedModels.value = ['zai/glm-5.2']
    const { availableValues } = useAuthedModelGroups()

    // 旧实现：xiaomi/mimo-v2.5-pro 不在 scoped 过滤列表 → 误报「不可用」
    expect(staleModelRef('xiaomi/mimo-v2.5-pro', availableValues.value)).toBeNull()
    // 真实不可用（模型被删）仍报 stale
    expect(staleModelRef('zai/deleted', availableValues.value)).toBe('zai/deleted')
    // 空串（未设置语义）恒不 stale
    expect(staleModelRef('', availableValues.value)).toBeNull()
  })
})
