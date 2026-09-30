/**
 * testing 桩工厂单测 —— settings-transport-stub / quota-module-stub 的行为契约。
 *
 * 桩自身是「测试基建」，但有独立可回归的行为面（下游 core/renderer/ui 三包测试
 * 都建立在这些语义上，改坏会让用例假绿而非显式红）：
 * - 默认值中性形状：读方法返回空值结构、写方法返回 ack——形状错时消费用例拿到
 *   undefined 字段静默通过；
 * - 宽松回显：带实参的 set* 方法把实参原样回显（setWorktreeTimeout(120) →
 *   { timeout: 120 }）——回显断链时「写后读」类用例失真；
 * - 订阅返回 no-op 取消函数（可调用不抛）；
 * - overrides 只覆盖指定成员、其余保持默认（散布式覆盖语义）；
 * - 全量方法可调用：签名漂移（成员缺失/非函数）在遍历调用处即炸，不留死方法。
 *
 * 运行：cd packages/core && npx vitest run src/testing/__tests__/testing-stubs.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { SettingsTransport } from '../../domain/settings/transport'
import {
  makeSettingsTransportStub,
  type SettingsTransportStubOverrides,
} from '../settings-transport-stub'
import { makeQuotaModuleStub } from '../quota-module-stub'

describe('makeSettingsTransportStub', () => {
  it('全量方法可调用：读/写返回中性值不抛、订阅返回可调用的取消函数', async () => {
    const stub = makeSettingsTransportStub()
    const entries = Object.entries(stub) as Array<[string, unknown]>
    const called: string[] = []
    for (const [name, value] of entries) {
      if (typeof value !== 'function') throw new Error(`成员 ${name} 不是函数（契约漂移）`)
      const fn = value as (...args: unknown[]) => unknown
      if (name.startsWith('on')) {
        const unsub = fn(vi.fn())
        expect(typeof unsub).toBe('function')
        ;(unsub as () => void)()
      } else {
        await Promise.resolve(fn())
      }
      called.push(name)
    }
    // 契约面完整性：SettingsTransport 全部成员都在桩上（编译期类型 + 运行时遍历双保险）
    expect(called.length).toBe(Object.keys(stub).length)
    expect(called.length).toBeGreaterThan(60)
  })

  it('读方法中性默认形状：空集合 / null 占位 / corrupted=false', async () => {
    const stub = makeSettingsTransportStub()
    expect(await stub.listProviders()).toEqual({ providers: [] })
    expect(await stub.listModels()).toEqual([])
    expect(await stub.refreshProviderCatalogs()).toEqual({ refreshed: [], failed: [], corrupt: [] })
    expect(await stub.getCachedQuota('p1')).toEqual({ data: null, lastFetchAt: null })
    expect(await stub.getSystemPrompt()).toEqual({
      config: { version: 1, replace: { enabled: false, prompt: '' }, append: { enabled: false, prompt: '' } },
      corrupted: false,
    })
    expect(await stub.getSmartContextConfig()).toEqual({
      enabled: false,
      compactModel: '',
      reminderThresholds: [],
      excludedModels: [],
    })
    // oauth 缺省不可达态（started:false 显式声明桩无真实登录通道）
    expect(await stub.oauthLogin('p1')).toEqual({ started: false, error: 'stub transport' })
  })

  it('宽松回显：set* 实参原样回显（写后读语义的基础）', async () => {
    const stub = makeSettingsTransportStub()
    expect(await stub.setScopedModels(['p/m1', 'p/m2'])).toEqual(['p/m1', 'p/m2'])
    expect(await stub.setWorktreeTimeout(120)).toEqual({ timeout: 120 })
    expect(await stub.setDefaultBaseBranch('develop')).toEqual({ baseBranch: 'develop' })
    expect(await stub.setRenameMode('first-stop')).toEqual({ mode: 'first-stop' })
    const promptCfg = { version: 1, replace: { enabled: true, prompt: 'x' }, append: { enabled: false, prompt: '' } } as const
    expect(await stub.setSystemPrompt(promptCfg)).toEqual({ config: promptCfg, corrupted: false })
    // previewImportProviders 透传 source（导入预览链路的回显源）
    const preview = await stub.previewImportProviders('claude-code' as never)
    expect(preview).toEqual({
      importId: 'stub-import',
      preview: { source: 'claude-code', providers: [] },
    })
  })

  it('overrides 只覆盖指定成员、其余保持默认', async () => {
    const custom = vi.fn(async () => ({ providers: [{ id: 'p1' }] }))
    const overrides: SettingsTransportStubOverrides = { listProviders: custom }
    const stub = makeSettingsTransportStub(overrides)

    await stub.listProviders()
    expect(custom).toHaveBeenCalledTimes(1)
    // 指定覆盖返回注入实现的结果
    expect(await stub.listProviders()).toEqual({ providers: [{ id: 'p1' }] })
    // 其余成员保持中性默认（不受 overrides 牵连）
    expect(await stub.listModels()).toEqual([])
    expect(typeof stub.onProviders).toBe('function')
  })

  it('返回对象满足 SettingsTransport 契约（类型收窄后逐组抽验）', () => {
    const stub: SettingsTransport = makeSettingsTransportStub()
    // 三组通道各抽一个成员：读 / 写 / 订阅
    expect(typeof stub.getWorktreeTimeout).toBe('function')
    expect(typeof stub.setProvider).toBe('function')
    expect(typeof stub.onRetryConfig).toBe('function')
  })
})

describe('makeQuotaModuleStub', () => {
  it("缺省 'empty' 预设：未选类型 / readiness 缺 type / 未配置", () => {
    const stub = makeQuotaModuleStub()
    expect(stub.view.value.type.selected).toBeUndefined()
    expect(stub.view.value.readiness).toEqual({ ready: false, missing: ['type'] })
    expect(stub.view.value.enabled).toBe(false)
    expect(stub.test.value.status).toBe('idle')
    expect(stub.draft.value.credentialSource).toBe('provider')
  })

  it("'ready' 预设：已选 zhipu / 齐备 / 测试空闲", () => {
    const stub = makeQuotaModuleStub({ state: 'ready' })
    expect(stub.view.value.type.selected).toBe('zhipu')
    expect(stub.view.value.readiness).toEqual({ ready: true, missing: [] })
    expect(stub.view.value.enabled).toBe(true)
  })

  it('view/draft 是普通 ref：属性级直写即生效（消费方写法兼容）', () => {
    const stub = makeQuotaModuleStub()
    stub.view.value.configuring = true
    expect(stub.view.value.configuring).toBe(true)
    stub.draft.value.apiKey = 'sk-test'
    expect(stub.draft.value.apiKey).toBe('sk-test')
  })

  it('动作是可调用的 vi.fn（setEnabled/saveAndTest 不抛、调用可被 mock 断言）', async () => {
    const stub = makeQuotaModuleStub({ state: 'ready' })
    stub.selectType('zhipu')
    await stub.setEnabled(true)
    await stub.saveAndTest()
    expect(stub.selectType).toHaveBeenCalledWith('zhipu')
    expect(stub.setEnabled).toHaveBeenCalledWith(true)
    expect(stub.saveAndTest).toHaveBeenCalledTimes(1)
  })

  it('两个 stub 实例状态隔离（预设视图每次构造独立副本）', () => {
    const a = makeQuotaModuleStub({ state: 'ready' })
    const b = makeQuotaModuleStub({ state: 'ready' })
    a.view.value.type.selected = 'other'
    expect(b.view.value.type.selected).toBe('zhipu')
  })
})
