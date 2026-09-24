/**
 * use-provider-edit facade（[C4] 3 组 module 装配层）interface 级测试。
 *
 * 本文件只测 facade 的两个职责：① 3 组子 interface 装配齐全、按组可消费 ② provider 变化
 * 时的重置序（表单载入 → 瞬态重置 → 模型清单载入 → 快照捕获）+ D8 广播数据源接线。
 * 各组行为矩阵在 provider-edit-{form,discover,models,reconcile}.test.ts（replace, don't layer：
 * 原 981 行逐成员浅层用例已按 module 归位，伪 watch 时序用例由 reconcile 纯核矩阵替代）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Ref } from 'vue'
import { ref, effectScope, nextTick } from 'vue'
import type { ProviderInfo, ProviderId } from '@taiji/shared'
import { providePlatform, __resetPlatformForTesting } from '../../../platform/port'
import {
  provideSettingsTransport,
  __resetSettingsTransportForTesting,
  type SettingsTransport,
} from '../transport'
import { __resetSettingsStoreForTesting, getSettingsStore } from '../settings-store'
import { useProviderEdit, type ProviderEditSession } from '../use-provider-edit'
import { InMemoryStorage } from './helpers/in-memory-storage'

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

beforeEach(() => {
  __resetSettingsStoreForTesting()
  __resetSettingsTransportForTesting()
  __resetPlatformForTesting()
  providePlatform({ kind: 'mock', storage: new InMemoryStorage(), webSocket: { create: () => ({}) as never } })
  provideSettingsTransport(makeFakeTransport())
  tStub.mockClear()
  tStub.mockImplementation((key: string) => key)
})

let scope: ReturnType<typeof effectScope> | null = null

afterEach(() => {
  scope?.stop()
  scope = null
})

function mount(providerRef: Ref<ProviderInfo | null>): ProviderEditSession {
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

describe('3 组子 interface 装配（form / discover / models）', () => {
  it('按组可消费：form 组（草稿+dirty+save）、discover 组（test/discover）、models 组（清单 CRUD）', () => {
    const edit = mount(ref<ProviderInfo | null>(null))
    // form 组
    expect(edit.form.draft.name).toBe('')
    expect(edit.form.isDirty.value).toBe(false)
    expect(typeof edit.form.save).toBe('function')
    // discover 组
    expect(edit.discover.testResult.value).toBeNull()
    expect(typeof edit.discover.testConnection).toBe('function')
    expect(typeof edit.discover.autoDiscover).toBe('function')
    // models 组
    expect(edit.models.localModels.value).toEqual([])
    expect(typeof edit.models.addModel).toBe('function')
  })
})

describe('provider 变化重置编辑态（facade 重置序）', () => {
  it('null → provider：表单填充 + localModels 映射 + 瞬态重置 + isDirty false', async () => {
    const providerRef = ref<ProviderInfo | null>(null)
    const edit = mount(providerRef)
    await nextTick()
    providerRef.value = makeProvider()
    await nextTick()
    expect(edit.form.draft.name).toBe('P1')
    expect(edit.form.draft.api).toBe('anthropic-messages')
    expect(edit.form.draft.baseUrl).toBe('https://api.example.com')
    expect(edit.form.draft.headers).toEqual({ 'X-Test': 'v1' })
    expect(edit.form.headerRows.value).toEqual([{ key: 'X-Test', value: 'v1' }])
    expect(edit.models.localModels.value).toHaveLength(1)
    expect(edit.models.localModels.value[0].id).toBe('m1')
    expect(edit.form.isDirty.value).toBe(false)
  })

  it('provider → null：编辑态清空 + 瞬态态复位（新增态无残留）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    // 制造瞬态态（下次切换须复位）
    edit.form.draft.name = 'P2'
    edit.discover.testResult.value = 'ok'
    edit.models.showAddModel.value = true
    providerRef.value = null
    await nextTick()
    expect(edit.form.draft.name).toBe('')
    expect(edit.form.draft.api).toBe('anthropic-messages')
    expect(edit.models.localModels.value).toHaveLength(0)
    expect(edit.discover.testResult.value).toBeNull()
    expect(edit.models.showAddModel.value).toBe(false)
    expect(edit.form.isDirty.value).toBe(false)
  })
})

describe('D8 广播数据源接线（settingsStore.providers → form module 的 reconcile 调用点）', () => {
  it('store 广播整体替换 providers → 非 dirty 表单跟随（数据源接线冒烟）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    getSettingsStore().providers.value = [makeProvider({ name: 'P1-broadcast' })]
    await nextTick()
    expect(edit.form.draft.name).toBe('P1-broadcast')
    expect(edit.form.isDirty.value).toBe(false)
  })

  it('新增态（providerRef null）→ 广播不刷新（无 provider 可对齐）', async () => {
    const edit = mount(ref<ProviderInfo | null>(null))
    await nextTick()
    getSettingsStore().providers.value = [makeProvider({ name: 'P1-broadcast' })]
    await nextTick()
    expect(edit.form.draft.name).toBe('') // 保持空
  })
})
