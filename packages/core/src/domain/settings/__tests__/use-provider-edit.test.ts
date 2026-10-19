/**
 * use-provider-edit facade（[C4] 3 组 module 装配层）interface 级测试。
 *
 * 本文件只测 facade 的两个职责：① 3 组子 interface 装配齐全、按组可消费 ② provider 变化
 * 时的重置序（表单载入 → 瞬态重置 → 模型清单载入 → 快照捕获）+ D8 广播数据源接线。
 * 各组行为矩阵在 provider-edit-{form,discover,models,reconcile}.test.ts（replace, don't layer：
 * 原 981 行逐成员浅层用例已按 module 归位，伪 watch 时序用例由 reconcile 纯核矩阵替代）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Ref } from 'vue'
import { ref, nextTick } from 'vue'
import type { ProviderInfo } from '@taiji/shared'
import { providePlatform, __resetPlatformForTesting } from '../../../platform/port'
import {
  provideSettingsTransport,
  getSettingsTransport,
} from '../transport'
import { makeFakeTransport } from './helpers/fake-transport'
import {
  makeProvider,
  createTStub,
  resetTStub,
  createEffectScopeTracker,
} from './helpers/provider-edit-testbed'
import { createSettingsStore, getSettingsStore, provideSettingsStore } from '../settings-store'
import { useProviderEdit, type ProviderEditSession } from '../use-provider-edit'
import { InMemoryStorage } from './helpers/in-memory-storage'

/** i18n stub：返回 key 本身（校验调用参数而非翻译）。 */
const tStub = createTStub()

// fake transport 工厂迁 ./helpers/fake-transport（[C3] seam 方法侧全覆盖共享工厂）
// provider fixture 工厂 / tStub / effectScope 生命周期迁 ./helpers/provider-edit-testbed

beforeEach(() => {
  provideSettingsStore(createSettingsStore())
  __resetPlatformForTesting()
  providePlatform({ kind: 'mock', storage: new InMemoryStorage(), webSocket: { create: () => ({}) as never } })
  provideSettingsTransport(makeFakeTransport())
  resetTStub(tStub)
})

/** effectScope 生命周期（mount 挂载 / afterEach 回收）。 */
const scopes = createEffectScopeTracker()

afterEach(() => {
  scopes.stopScope()
})

function mount(providerRef: Ref<ProviderInfo | null>): ProviderEditSession {
  return scopes.runInScope(() => useProviderEdit(providerRef, { t: tStub }))
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

describe('同 id 刷新（广播替换列表元素）不重置编辑态（MF-1-1）', () => {
  it('回显后同 id 新对象进 prop → 回显值/明文开关保留，其余字段仍经 reconcile 重拍且不虚报 dirty', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({ apiKeySet: true }))
    const edit = mount(providerRef)
    await nextTick()
    ;(getSettingsTransport().revealProviderApiKey as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ available: true, apiKey: 'sk-stored', source: 'auth.json' })
    await edit.form.revealApiKey()
    expect(edit.form.draft.apiKey).toBe('sk-stored')
    expect(edit.form.showKey.value).toBe(true)

    // 广播：store 整体替换 providers + v-for 元素新引用作为 provider prop（同一 provider id）
    const refreshed = makeProvider({ name: 'P1-broadcast' })
    getSettingsStore().providers.value = [refreshed]
    providerRef.value = refreshed
    await nextTick()

    // 同 id 刷新不是「切换 provider」：回显态不得被抹掉
    expect(edit.form.draft.apiKey).toBe('sk-stored')
    expect(edit.form.showKey.value).toBe(true)
    // 同 id 刷新仍由 form 的 watch(providers) + applyReconcile 承接（模型清单/字段重拍）
    expect(edit.form.draft.name).toBe('P1-broadcast')
    expect(edit.models.localModels.value).toHaveLength(1)
    // 回显值不是草稿 → 重拍后也不出现「未保存」
    expect(edit.form.isDirty.value).toBe(false)
  })

  it('id 变化 → 仍全量重置（回显值/草稿/明文开关清空，不跨 provider 复用）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({ apiKeySet: true }))
    const edit = mount(providerRef)
    await nextTick()
    ;(getSettingsTransport().revealProviderApiKey as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ available: true, apiKey: 'sk-p1', source: 'auth.json' })
    await edit.form.revealApiKey()
    expect(edit.form.draft.apiKey).toBe('sk-p1')

    const other = makeProvider({ id: 'p2' as ProviderInfo['id'], name: 'P2' })
    getSettingsStore().providers.value = [other]
    providerRef.value = other
    await nextTick()

    expect(edit.form.draft.name).toBe('P2')
    expect(edit.form.draft.apiKey).toBe('')
    expect(edit.form.showKey.value).toBe(false)
  })

  it('同 id 刷新不抹掉用户已输入的 apiKey 草稿（dirty → reconcile 保留用户改动）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider())
    const edit = mount(providerRef)
    await nextTick()
    edit.form.draft.apiKey = 'sk-typed'
    expect(edit.form.isDirty.value).toBe(true)

    const refreshed = makeProvider({ name: 'P1-broadcast' })
    getSettingsStore().providers.value = [refreshed]
    providerRef.value = refreshed
    await nextTick()

    expect(edit.form.draft.apiKey).toBe('sk-typed')
    // dirty → reconcile 分支③不动其余字段（用户改动优先）
    expect(edit.form.draft.name).toBe('P1')
  })
})

describe('discover 凭据取值复用「真实未保存草稿」判据（MF-1-1）', () => {
  it('回显值（= 所存值）不作为 payload apiKey 发出（$ENV 引用仍由 runtime resolver 展开）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({ apiKeySet: true }))
    const edit = mount(providerRef)
    await nextTick()
    ;(getSettingsTransport().revealProviderApiKey as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ available: true, apiKey: '$OPENAI_API_KEY', source: 'models.json' })
    await edit.form.revealApiKey()
    expect(edit.form.draft.apiKey).toBe('$OPENAI_API_KEY')

    await edit.discover.autoDiscover()

    // 回显值不是待保存草稿：discover 不带 apiKey 键，让 runtime resolver 展开 $ENV
    const req = vi.mocked(getSettingsTransport().discoverModels).mock.calls[0]![0]
    expect(req.apiKey).toBeUndefined()
  })

  it('用户真实输入的草稿仍作为 payload apiKey 发出（回显判据不退化手工输入路径）', async () => {
    const providerRef = ref<ProviderInfo | null>(makeProvider({ apiKeySet: true }))
    const edit = mount(providerRef)
    await nextTick()

    edit.form.draft.apiKey = 'sk-typed'
    await edit.discover.autoDiscover()

    const req = vi.mocked(getSettingsTransport().discoverModels).mock.calls[0]![0]
    expect(req.apiKey).toBe('sk-typed')
  })
})

describe('discover 错误通道接线（facade 注入回调 → form.actionError，MF-1-7 source=discover）', () => {
  it('discover 失败 → reportActionError 写 form.actionError；再次探活成功 → clearActionError 清除', async () => {
    provideSettingsTransport(makeFakeTransport({
      discoverModels: async () => ({ success: false, error: 'conn refused' }),
    }))
    const edit = mount(ref<ProviderInfo | null>(makeProvider()))

    await edit.discover.autoDiscover()
    // 错误经 facade 的 reportActionError 回调落 form module（带 source 标签，呈现 message）
    expect(edit.form.actionError.value).toBe('conn refused')

    // 成功探活：runDiscover 开头 clearActionError → 错误派生视图清除
    provideSettingsTransport(makeFakeTransport())
    await edit.discover.testConnection()
    expect(edit.form.actionError.value).toBe('')
  })
})
