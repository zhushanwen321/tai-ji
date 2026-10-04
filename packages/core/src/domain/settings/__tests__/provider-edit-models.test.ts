/**
 * provider-edit-models（模型清单 CRUD module）interface 级测试（[C4] 拆分后按 module 打点）。
 *
 * 覆盖：清单载入（B-2 builtin 过滤 + B-4b 透传位 spread）/ addModel 校验与出厂（D15a / D4）/
 * 行级 CRUD（输入类型 / 上下文 / 思考策略 D9②③）/ D4 思考策略联动推导 / discover 合并
 * （去重 + D9① 出厂显式 reasoning）/ save 回传规则（buildModelsPayload：B-4b 条件键）。
 *
 * D9 档位断言用 pi 实装同源函数（唯一权威）——从根 node_modules 解析 pi-ai dist。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import type { ProviderInfo, ProviderId } from '@taiji/shared'
import {
  createProviderEditModels,
  toEditableModels,
  buildModelsPayload,
  mergeDiscoveredModels,
  resolveThinkingMap,
  type LocalModel,
  type ProviderEditModelsModule,
} from '../provider-edit-models'
// D9 档位断言用 pi 实装同源函数（唯一权威）——从根 node_modules 解析 pi-ai 0.84.4 dist
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
// tStub / effectScope 生命周期迁 ./helpers/provider-edit-testbed（本文件 fixture 是短版，保留本地实现）
import { createTStub, resetTStub, createEffectScopeTracker } from './helpers/provider-edit-testbed'

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
const tStub = createTStub()

beforeEach(() => {
  resetTStub(tStub)
})

/** effectScope 生命周期（mountModels 挂载 / afterEach 回收）。 */
const scopes = createEffectScopeTracker()

afterEach(() => {
  scopes.stopScope()
})

/** 挂 module（effectScope 包裹：thinking 联动 watch 随 scope 回收） */
function mountModels(): ProviderEditModelsModule {
  return scopes.runInScope(() => createProviderEditModels({ t: tStub }))
}

function makeProvider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'p1' as ProviderId,
    name: 'P1',
    api: 'anthropic-messages',
    apiKeySet: true,
    status: 'connected',
    models: [{ id: 'm1', name: 'M1', contextWindow: 200_000, enabled: true }],
    enabled: true,
    ...overrides,
  }
}

describe('清单载入 / 重置（applyProvider / resetTransient）', () => {
  it('catalog provider：只含 override 条目（builtin 只读展示由组件层直读 provider.models）', () => {
    const m = mountModels()
    m.applyProvider(makeProvider({
      kind: 'catalog',
      models: [
        { id: 'b1', name: 'B1', source: 'builtin' },
        { id: 'b2', name: 'B2', source: 'builtin' },
        { id: 'o1', name: 'O1', source: 'override' },
        { id: 'legacy', name: 'Legacy' }, // 无 source 标注（旧数据）→ 按 override 保留
      ],
    }))
    expect(m.localModels.value.map((x) => x.id)).toEqual(['o1', 'legacy'])
  })

  it('custom provider（kind 缺失同）：全量保留不过滤', () => {
    const m = mountModels()
    m.applyProvider(makeProvider({
      models: [
        { id: 'm1', name: 'M1', contextWindow: 200_000, enabled: true },
        { id: 'm2', name: 'M2', source: 'builtin' },
      ],
    }))
    // custom 的 source 标注不存在（聚合层不标），全量保留
    expect(m.localModels.value.map((x) => x.id)).toEqual(['m1', 'm2'])
  })

  it('B-4b load：ProviderInfo.models 的透传字段进编辑副本（spread 透传）', () => {
    const m = mountModels()
    m.applyProvider(makeProvider({
      models: [
        {
          id: 'm-rich', name: 'Rich',
          reasoning: true, maxTokens: 8192,
          cost: { input: 3, output: 15, cacheRead: 0.6, cacheWrite: 3.75 },
          headers: { 'X-Model': 'v1' },
          contextWindow: 200_000,
        },
        { id: 'm-plain', name: 'Plain' },
      ],
    }))
    const rich = m.localModels.value[0]
    expect(rich.reasoning).toBe(true)
    expect(rich.maxTokens).toBe(8192)
    expect(rich.cost).toEqual({ input: 3, output: 15, cacheRead: 0.6, cacheWrite: 3.75 })
    expect(rich.headers).toEqual({ 'X-Model': 'v1' })
  })

  it('applyProvider(null) 清空清单；resetTransient 收起面板展开态', () => {
    const m = mountModels()
    m.applyProvider(makeProvider())
    m.showAddModel.value = true
    m.toggleCompatExpand('m1')
    m.resetTransient()
    expect(m.showAddModel.value).toBe(false)
    expect(m.expandedCompat.size).toBe(0)
    m.applyProvider(null)
    expect(m.localModels.value).toHaveLength(0)
  })
})

describe('addModel（D15a 校验抛错 + D4 reasoning 显式 boolean 出厂）', () => {
  it('空名抛错（非静默）', () => {
    const m = mountModels()
    m.newModel.name = '   '
    expect(() => m.addModel()).toThrow()
    expect(tStub).toHaveBeenCalledWith('composable.modelNameRequired')
  })

  it('重名 id 抛错', () => {
    const m = mountModels()
    m.newModel.name = 'm1'
    m.localModels.value = [{ id: 'm1', name: 'M1' }]
    expect(() => m.addModel()).toThrow('composable.modelAlreadyExists')
  })

  it('正常添加 + 清空表单 + reasoning 显式 boolean 落盘（不 undefined 出厂）', () => {
    const m = mountModels()
    m.newModel.name = 'new-model'
    m.newModel.contextWindow = 128_000
    m.addModel()
    expect(m.localModels.value).toHaveLength(1)
    expect(m.localModels.value[0].id).toBe('new-model')
    // D4：reasoning 显式 boolean（事故 B 根因 ②——undefined 被 pi 判 off）
    expect(m.localModels.value[0].reasoning).toBe(true)
    expect(m.localModels.value[0].reasoning).not.toBeUndefined()
    expect(m.newModel.name).toBe('')
  })

  it('用户显式关 reasoning → 落盘 false（显式开关可覆盖推导）', () => {
    const m = mountModels()
    m.newModel.name = 'no-reasoning-model'
    m.newModel.reasoning = false
    m.addModel()
    expect(m.localModels.value[0].reasoning).toBe(false)
  })
})

describe('D4 思考策略联动推导（策略变化 → 推导、用户拨动 → 直接写）', () => {
  it('切非 all-levels → reasoning 自动置 true；显式关后再切策略重新推导；all-levels 不推导', async () => {
    const m = mountModels()
    m.newModel.reasoning = false
    m.newModel.thinking = 'high-max'
    await nextTick()
    expect(m.newModel.reasoning).toBe(true)
    // 用户显式关（覆盖推导）
    m.newModel.reasoning = false
    expect(m.newModel.reasoning).toBe(false)
    // 再切策略 → 重新推导置 true
    m.newModel.thinking = 'on-off'
    await nextTick()
    expect(m.newModel.reasoning).toBe(true)
    // 切回 all-levels → 不推导（保持当前值）
    m.newModel.reasoning = false
    m.newModel.thinking = 'all-levels'
    await nextTick()
    expect(m.newModel.reasoning).toBe(false)
  })
})

describe('行级 CRUD（toggleInput / updateCtx / removeModel / compat 展开）', () => {
  it('toggleInput 切换 text/image（可逆）', () => {
    const m = mountModels()
    const model: LocalModel = { id: 'm', name: 'M', input: ['text'] }
    m.toggleInput(model, 'image')
    expect(model.input).toEqual(['text', 'image'])
    m.toggleInput(model, 'text')
    expect(model.input).toEqual(['image'])
  })

  it('toggleNewInput 切换新增表单的输入类型（与行级 toggleInput 同语义，可逆）', () => {
    const m = mountModels()
    // 出厂 inputTypes = ['text']
    m.toggleNewInput('image')
    expect(m.newModel.inputTypes).toEqual(['text', 'image'])
    m.toggleNewInput('text')
    expect(m.newModel.inputTypes).toEqual(['image'])
    m.toggleNewInput('image')
    expect(m.newModel.inputTypes).toEqual([])
  })

  it('removeModel 移除指定下标；updateCtx 更新上下文', () => {
    const m = mountModels()
    m.localModels.value = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
    m.updateCtx(m.localModels.value[1], 128_000)
    expect(m.localModels.value[1].contextWindow).toBe(128_000)
    m.removeModel(0)
    expect(m.localModels.value.map((x) => x.id)).toEqual(['b'])
  })

  it('toggleCompatExpand 直接 mutate Set（可逆）', () => {
    const m = mountModels()
    m.toggleCompatExpand('m1')
    expect(m.expandedCompat.has('m1')).toBe(true)
    m.toggleCompatExpand('m1')
    expect(m.expandedCompat.has('m1')).toBe(false)
  })
})

describe('D9 思考档位修复（reasoning 显式化 + 预设对齐 pi 过滤语义）', () => {
  it('D9②：pickStrategy 对 reasoning === undefined 的模型置 true（存量「从未设策略」形态救回）', () => {
    const m = mountModels()
    const model: LocalModel = { id: 'm', name: 'M' } // reasoning 缺失（用户数据实测形态）
    m.pickStrategy(model, 'high-max')
    expect(model.reasoning).toBe(true)

    // all-levels 分支同规则：存量最常见形态 = all-levels + reasoning 缺失，
    // 救回路径必须闭合在这里（只联动非 all-levels 会让它不闭合）
    const modelAll: LocalModel = { id: 'm2', name: 'M2' }
    m.pickStrategy(modelAll, 'all-levels')
    expect(modelAll.reasoning).toBe(true)
    expect(modelAll.thinkingLevelMap).toBeUndefined()
  })

  it('D9②：pickStrategy 永不覆盖显式 reasoning === false（high-max / all-levels 分支同）', () => {
    const m = mountModels()
    const model: LocalModel = { id: 'm', name: 'M', reasoning: false }
    m.pickStrategy(model, 'high-max')
    expect(model.reasoning).toBe(false)
    // 显式选择优先于联动：pi 语义下 reasoning=false → 弹层只有「关」
    expect(supportedLevelsOf(model.thinkingLevelMap, false)).toEqual(['off'])

    const modelAll: LocalModel = { id: 'm2', name: 'M2', reasoning: false }
    m.pickStrategy(modelAll, 'all-levels')
    expect(modelAll.reasoning).toBe(false)
    expect(modelAll.thinkingLevelMap).toBeUndefined()
  })

  it('D9③：on-off 预设经 pi 同源函数输出 [off, high] 两档 + Select 回显 round-trip', () => {
    const m = mountModels()
    const model: LocalModel = { id: 'm', name: 'M' }
    m.pickStrategy(model, 'on-off')
    expect(supportedLevelsOf(model.thinkingLevelMap)).toEqual(['off', 'high'])
    // Select 回显 round-trip：含 null 剔除项的 map 反推策略仍是 on-off
    expect(m.getStrategyFromMap(model.thinkingLevelMap)).toBe('on-off')
  })

  it('D9③：high-max 预设输出 [off, high, max] 三档（第三档档位名 max、map 值 xhigh）', () => {
    const m = mountModels()
    const model: LocalModel = { id: 'm', name: 'M' }
    m.pickStrategy(model, 'high-max')
    expect(supportedLevelsOf(model.thinkingLevelMap)).toEqual(['off', 'high', 'max'])
    // 展示档位名是 max，发给 pi 的实际 level 是 xhigh
    expect(model.thinkingLevelMap?.max).toBe('xhigh')
    expect(m.getStrategyFromMap(model.thinkingLevelMap)).toBe('high-max')
  })

  it('getStrategyFromMap 反推策略（空/undefined → all-levels）', () => {
    const m = mountModels()
    expect(m.getStrategyFromMap(undefined)).toBe('all-levels')
    expect(m.getStrategyFromMap({ off: 'off', high: 'high' })).toBe('on-off')
    expect(m.getStrategyFromMap({ off: 'off', high: 'high', max: 'xhigh' })).toBe('high-max')
    // 有可用档位但不含 high/max（如只开 minimal）→ 兜底 all-levels
    expect(m.getStrategyFromMap({ off: 'off', minimal: 'minimal' })).toBe('all-levels')
  })

  it('resolveThinkingMap 正向解析（深拷贝副本）且与 getStrategyFromMap round-trip', () => {
    expect(resolveThinkingMap('all-levels')).toBeUndefined()
    // 未启用档 = null（shared PI_THINKING_LEVELS 全集 7 值），启用档显式映射
    expect(resolveThinkingMap('on-off')).toEqual({ off: 'off', high: 'high', minimal: null, low: null, medium: null, xhigh: null, max: null })
    expect(resolveThinkingMap('high-max')).toEqual({ off: 'off', high: 'high', max: 'xhigh', minimal: null, low: null, medium: null, xhigh: null })

    // 深拷贝：两次 resolve 不共享引用，改一份不影响另一份（防多模型共享 map 引用）
    const a = resolveThinkingMap('on-off')!
    const b = resolveThinkingMap('on-off')!
    expect(a).not.toBe(b)
    a.off = 'changed'
    expect(b.off).toBe('off')

    // round-trip：resolve → getStrategyFromMap 反推回原策略（Select 回显链路闭环）
    const m = mountModels()
    expect(m.getStrategyFromMap(resolveThinkingMap('on-off'))).toBe('on-off')
    expect(m.getStrategyFromMap(resolveThinkingMap('high-max'))).toBe('high-max')
  })
})

describe('discover 合并（mergeDiscovered：去重 + D9① 出厂显式 reasoning）', () => {
  it('按 id 去重合并 + 计数（total=发现总数、addedCount=新增数）', () => {
    const m = mountModels()
    m.applyProvider(makeProvider()) // localModels = [m1]
    const result = m.mergeDiscovered([
      { id: 'm1', name: 'M1', contextWindow: 200_000 },
      { id: 'm2', name: 'M2', contextWindow: 128_000 },
    ])
    expect(result).toEqual({ total: 2, addedCount: 1 })
    expect(m.localModels.value.map((x) => x.id)).toEqual(['m1', 'm2'])
    expect(m.localModels.value[1].contextWindow).toBe(128_000)
  })

  it('D9①：合并进来的模型 reasoning 显式 true（不 undefined，对齐 addModel 出厂语义）', () => {
    const m = mountModels()
    m.mergeDiscovered([{ id: 'm2', name: 'M2', contextWindow: 128_000 }])
    const merged = m.localModels.value.find((x) => x.id === 'm2')
    // pi 两级门控把 reasoning 缺失判「关」——合并入口必须出厂显式 boolean
    expect(merged?.reasoning).toBe(true)
    expect(merged?.reasoning).not.toBeUndefined()
  })

  it('全部已存在 → addedCount 0（纯合并规则 mergeDiscoveredModels 同语义）', () => {
    const existing: LocalModel[] = [{ id: 'm1', name: 'M1' }]
    const { added, total } = mergeDiscoveredModels(existing, [{ id: 'm1', name: 'M1' }])
    expect(added).toEqual([])
    expect(total).toBe(1)
  })
})

describe('save 回传规则（buildModelsPayload：B-2 只回传编辑副本 + B-4b 条件键）', () => {
  it('B-4b：有值时回传四字段（round-trip 接通）', () => {
    const payload = buildModelsPayload([
      {
        id: 'm-rich', name: 'Rich',
        reasoning: true, maxTokens: 8192,
        cost: { input: 3, output: 15, cacheRead: 0.6, cacheWrite: 3.75 },
        headers: { 'X-Model': 'v1' },
        contextWindow: 200_000,
      },
    ])
    expect(payload[0]).toMatchObject({
      reasoning: true,
      maxTokens: 8192,
      cost: { input: 3, output: 15, cacheRead: 0.6, cacheWrite: 3.75 },
      headers: { 'X-Model': 'v1' },
    })
  })

  it('B-4b：无值时不传键（undefined = runtime base spread 保留既有值）', () => {
    const payload = buildModelsPayload([{ id: 'm-plain', name: 'Plain' }])
    expect(payload[0]).not.toHaveProperty('reasoning')
    expect(payload[0]).not.toHaveProperty('maxTokens')
    expect(payload[0]).not.toHaveProperty('cost')
    expect(payload[0]).not.toHaveProperty('headers')
  })

  it('reasoning 显式 false 是合法值须回传（!== undefined 判定，不被 truthy 守卫吞）', () => {
    const payload = buildModelsPayload([{ id: 'm', name: 'M', reasoning: false }])
    // 协议形状 Array<string | object>：元素经运行时收窄后取字段（禁无 guard 断言）
    const first = payload[0]
    if (typeof first !== 'object') throw new Error('unexpected payload element')
    expect(first.reasoning).toBe(false)
  })

  it('B-2：toEditableModels 过滤的构造性结果——builtin 不进编辑副本即不回传', () => {
    const p = makeProvider({
      kind: 'catalog',
      models: [
        { id: 'b1', name: 'B1', source: 'builtin' },
        { id: 'o1', name: 'O1', source: 'override' },
      ],
    })
    const payload = buildModelsPayload(toEditableModels(p))
    expect((payload as Array<{ id: string }>).map((x) => x.id)).toEqual(['o1'])
  })
})
