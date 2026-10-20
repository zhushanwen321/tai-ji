/**
 * SDK 契约测试 —— 锁设计 §2.5 前提 7：
 * 「内置基线的 Model 对象放进 `ProviderConfigInput.models` 经 pi 组合后字段等价
 * （Model 对象是定义形状的超集）」。
 *
 * 为什么值得一个独立测试文件：前提 7 是「不成立」列写明「会改 bridge 注入构造」的那条
 * ——若 pi 的组合入口对 Model 对象做字段裁剪/重命名，目录投喂模块（catalog-bridge）
 * 就不能直接把 `getBuiltinModels(providerId)` 的基线对象并进注入集，必须改成显式挑
 * 字段构造。该推断此前只读过 `extensionModelFromDefinition` 的展开逻辑、没跑真进程，
 * 本文件把它变成可重跑的机器断言（pi bump 后由 pi-semantics 门禁强制重验）。
 *
 * 被测面 = pi 官方 SDK 入口 `ModelRuntime`（`registerProvider` 内部走
 * `validateExtensionProvider` → `composeModelProvider` → `applyExtension` →
 * `extensionModelFromDefinition`，即 `dist/core/provider-composer.js` 的组合链）。
 * 不 mock pi 本体：本测试的全部价值就在于「实装版 pi 的真实组合行为」。
 *
 * 隔离方式：`ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, authPath })`
 * —— modelsPath null → 内存 ModelsStore（不落 models-store.json）、refreshOnCreate false
 * → 不发起网络刷新、authPath 指 tmp（凭据读取不触真实 ~/.pi/agent）。
 *
 * 实测结论（pi@1.0.0，2026-10-20，本文件断言即结论）：
 * - **等价成立**：Model 对象的全部字段经组合后保留（含 `thinkingLevelMap` /
 *   `inputLimits` / `compat` / `promptCache` / `samplingParams`，以及定义形状里没有的
 *   `enabled` / `lab` / `providers` —— 超集属性由 `{...definition}` 展开保证）。
 * - **唯一规范化**：组合后 Model 对象的 `headers` 恒为 `undefined`（pi 在
 *   `extensionModelFromDefinition` 里硬置）。对请求头无功能损失——请求期头解析
 *   （`getCompatibilityRequestConfig`）读的是原始定义里的 `models[].headers`，实测仍返回
 *   完整头集合；只是组合对象的 `headers` 字段不再承载它。bridge 侧无需为此改构造。
 * - **缺 `api`/`baseUrl` 不必然抛错**：pi 有四级兜底继承（同 id → 同 api →
 *   openai-completions → 该 provider 首个同类型模型）。仅当四级全空（该 provider 无任何
 *   同类型基线模型）才抛。这正是设计 R3 取保守档（只认同 id 继承）的实据——pi 会从
 *   「任意同 provider 模型」静默继承，语义未经上游目录声明。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ProviderConfigInput } from '@earendil-works/pi-coding-agent'

/** 被测 provider：catalog provider，内置基线 3 个 chat 模型（M2.7 / M2.7-highspeed / M3）。 */
const PROVIDER = 'minimax-cn'

let tmpDir: string
/** 每个用例一个独立 runtime：`registerProvider` 的合并语义跨用例不串味。 */
async function newRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    authPath: join(tmpDir, 'auth.json'),
  })
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sdk-contract-'))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('① 完整 Model 对象入注 → 组合结果字段等价（前提 7 主体）', () => {
  it('内置基线全量入注：每个模型的全部字段与源对象一致', async () => {
    const baseline = getBuiltinModels(PROVIDER)
    expect(baseline.length).toBeGreaterThan(0)

    const rt = await newRuntime()
    rt.registerProvider(PROVIDER, { models: baseline.map((m) => ({ ...m })) })

    const composed = rt.getModels(PROVIDER)
    expect(composed.map((m) => m.id)).toEqual(baseline.map((m) => m.id))
    for (const source of baseline) {
      const got = rt.getModel(PROVIDER, source.id)
      expect(got, `模型 ${source.id} 应在组合结果中`).toBeDefined()
      // toEqual 忽略 undefined 属性——pi 硬置的 headers:undefined 由下一个用例单独断言
      expect(got).toEqual(source)
    }
  })

  it('超集属性：定义形状未声明的字段（enabled / lab / providers）同样保留', async () => {
    // radius/balanced 是内置目录里可选字段最全的模型之一：thinkingLevelMap /
    // inputLimits / enabled / lab / providers 俱全，其中后三者不在 ProviderChatModelConfig
    // 的声明形状里——它们能存活即证明「Model 对象是定义形状的超集」。
    const source = getBuiltinModels('radius').find((m) => m.id === 'balanced')
    expect(source).toBeDefined()

    const rt = await newRuntime()
    rt.registerProvider('radius', { models: [{ ...source! }] })

    const got = rt.getModel('radius', 'balanced')
    expect(got).toEqual(source)
    expect(got!.thinkingLevelMap).toEqual(source!.thinkingLevelMap)
    expect(got!.inputLimits).toEqual(source!.inputLimits)
    // 定义形状外的字段：靠 {...definition} 展开透传
    expect((got as Record<string, unknown>).enabled).toBe((source as Record<string, unknown>).enabled)
    expect((got as Record<string, unknown>).lab).toBe((source as Record<string, unknown>).lab)
    expect((got as Record<string, unknown>).providers).toEqual((source as Record<string, unknown>).providers)
  })

  it('规范化登记：组合对象的 headers 恒为 undefined，但请求期头解析仍读原始定义', async () => {
    // github-copilot/claude-fable-5 是内置目录里少数自带 headers 的模型——用它才能观测到
    // pi 对 headers 的硬置行为（无 headers 的模型上该字段本来就是 undefined，测不出差异）。
    const source = getBuiltinModels('github-copilot').find((m) => m.id === 'claude-fable-5')
    expect(source?.headers).toBeDefined()

    const rt = await newRuntime()
    rt.registerProvider('github-copilot', { models: [{ ...source! }] })

    const got = rt.getModel('github-copilot', 'claude-fable-5')!
    // 组合对象上 headers 被清空（pi 硬置）——这是唯一与源对象不一致的字段
    expect(Object.prototype.hasOwnProperty.call(got, 'headers')).toBe(true)
    expect(got.headers).toBeUndefined()
    // 但请求期头解析读原始定义，功能无损失：bridge 侧无需为 headers 改注入构造
    expect(rt.getCompatibilityRequestConfig(got).headers).toEqual(source!.headers)
  })

  it('models 数组即最终可见集合（映射替换，非与内置层合并）——注入策略的直接依据', async () => {
    const baseline = getBuiltinModels(PROVIDER)
    const rt = await newRuntime()
    rt.registerProvider(PROVIDER, { models: baseline.map((m) => ({ ...m })) })
    expect(rt.getModels(PROVIDER).map((m) => m.id)).toEqual(baseline.map((m) => m.id))

    // 只注一个模型 → 该 provider 的可见集合收缩为这一个（内置层未被保留）
    rt.registerProvider(PROVIDER, {
      models: [{ ...baseline[0] }],
    })
    expect(rt.getModels(PROVIDER).map((m) => m.id)).toEqual([baseline[0].id])
  })
})

describe('② 极简定义形状入注 → pi 展开语义（四级兜底继承路径）', () => {
  /** 定义形状的必填最小集：id + name + input + cost + reasoning + contextWindow + maxTokens。 */
  const minimal = (id: string) => ({
    id,
    name: id,
    input: ['text' as const],
    cost: { input: 1, output: 2 },
    reasoning: false,
    contextWindow: 4096,
    maxTokens: 512,
  })

  it('四级兜底第 4 级：无同 id / 同 api / openai-completions 可继承 → 取该 provider 首个同类型模型', async () => {
    const baseline = getBuiltinModels(PROVIDER)
    const rt = await newRuntime()
    rt.registerProvider(PROVIDER, { models: [minimal('Overlay-Only-New')] })

    const got = rt.getModel(PROVIDER, 'Overlay-Only-New')!
    // api / baseUrl 来自 candidates[0]（首个同类型模型），非定义自带
    expect(got.api).toBe(baseline[0].api)
    expect(got.baseUrl).toBe(baseline[0].baseUrl)
    // 定义自带的字段原样保留，未带的走 pi 缺省
    expect(got.id).toBe('Overlay-Only-New')
    expect(got.contextWindow).toBe(4096)
    expect(got.provider).toBe(PROVIDER)
  })

  it('四级兜底第 1 级：同 id 基线存在 → 从该模型继承 api / baseUrl', async () => {
    const baseline = getBuiltinModels(PROVIDER)
    const target = baseline[baseline.length - 1]
    const rt = await newRuntime()
    // 先注入完整基线，再以「同 id 但缺 api/baseUrl」的极简定义覆盖
    rt.registerProvider(PROVIDER, { models: baseline.map((m) => ({ ...m })) })
    rt.registerProvider(PROVIDER, { models: [minimal(target.id)] })

    const got = rt.getModel(PROVIDER, target.id)!
    expect(got.api).toBe(target.api)
    expect(got.baseUrl).toBe(target.baseUrl)
  })

  it('四级兜底第 2 级：provider 级 api 优先于兜底继承', async () => {
    const rt = await newRuntime()
    rt.registerProvider(PROVIDER, {
      api: 'openai-completions',
      models: [minimal('Provider-Api-Case')],
    })
    const got = rt.getModel(PROVIDER, 'Provider-Api-Case')!
    expect(got.api).toBe('openai-completions')
    // baseUrl 无 provider 级值 → 仍走兜底继承
    expect(got.baseUrl).toBe(getBuiltinModels(PROVIDER)[0].baseUrl)
  })

  // 四级兜底第 2/3 级的构造参数从内置目录动态选定（pi bump 目录数据变化时自适应）：
  // 要求基线内 chat 模型 ≥2 种 api，且目标级继承源 ≠ candidates[0]（baseUrl 可区分
  // ——否则断言与第 4 级不可区分）。构造条件不成立 = pi 目录数据形态变化，重验者
  // 须重新核对 findExtensionModelDefaults 语义后重找构造。
  const level23 = (() => {
    for (const providerId of getBuiltinProviders()) {
      const chat = getBuiltinModels(providerId).filter((m) => (m.type ?? 'chat') === 'chat')
      const first = chat[0]
      if (!first) continue
      const openaiCompletions = chat.find((m) => m.api === 'openai-completions')
      const level3 =
        openaiCompletions && first.api !== 'openai-completions' && openaiCompletions.baseUrl !== first.baseUrl
          ? { openaiCompletions }
          : null
      let level2: { api: string; sameApi: (typeof chat)[number] } | null = null
      for (const api of new Set(chat.map((m) => m.api))) {
        const sameApi = chat.find((m) => m.api === api)
        if (sameApi && sameApi.id !== first.id && sameApi.baseUrl !== first.baseUrl) {
          level2 = { api, sameApi }
          break
        }
      }
      if (level2 && level3) return { providerId, first, level2, level3 }
    }
    return null
  })()

  it('四级兜底第 2 级：定义带 api → baseUrl 继承基线首个同 api 模型（非 candidates[0]）', async () => {
    expect(
      level23,
      '内置目录找不到「同 api 继承源 ≠ candidates[0]」的构造——pi 目录数据形态变化后须重核 findExtensionModelDefaults 语义并重找构造',
    ).not.toBeNull()
    const { providerId, first, level2 } = level23!
    const rt = await newRuntime()
    rt.registerProvider(providerId, { models: [{ ...minimal('Overlay-L2-Case'), api: level2.api }] })

    const got = rt.getModel(providerId, 'Overlay-L2-Case')!
    // api 取定义自带值；baseUrl 走第 2 级（基线首个同 api 模型），不是 candidates[0]
    expect(got.api).toBe(level2.api)
    expect(got.baseUrl).toBe(level2.sameApi.baseUrl)
    expect(got.baseUrl).not.toBe(first.baseUrl)
  })

  it('四级兜底第 3 级：定义无 api、基线含 openai-completions → 继承首个 openai-completions 基线（非 candidates[0]）', async () => {
    expect(
      level23,
      '内置目录找不到「openai-completions 继承源 ≠ candidates[0]」的构造——pi 目录数据形态变化后须重核 findExtensionModelDefaults 语义并重找构造',
    ).not.toBeNull()
    const { providerId, first, level3 } = level23!
    expect(first.api).not.toBe('openai-completions') // 前置：candidates[0] 不经第 3 级命中，构造有效
    const rt = await newRuntime()
    rt.registerProvider(providerId, { models: [minimal('Overlay-L3-Case')] })

    const got = rt.getModel(providerId, 'Overlay-L3-Case')!
    // 定义与 provider 级 config 都无 api → api/baseUrl 都取基线首个 openai-completions 模型
    expect(got.api).toBe('openai-completions')
    expect(got.baseUrl).toBe(level3.openaiCompletions.baseUrl)
    expect(got.baseUrl).not.toBe(first.baseUrl)
  })
})

describe('③ 缺 api / baseUrl → validateExtensionProvider 抛错条件（R3 防御的实据）', () => {
  const noApiNoBaseUrl = {
    id: 'No-Api',
    name: 'No-Api',
    input: ['text' as const],
    cost: { input: 0, output: 0 },
    reasoning: false,
    contextWindow: 1,
    maxTokens: 1,
  }

  it('该 provider 无任何同类型基线模型 → 四级兜底全空 → 抛错', async () => {
    const rt = await newRuntime()
    expect(getBuiltinModels('no-such-catalog-provider')).toEqual([])
    expect(() =>
      rt.registerProvider('no-such-catalog-provider', {
        models: [noApiNoBaseUrl],
      } satisfies ProviderConfigInput),
    ).toThrow(/no "api" specified/)
  })

  it('catalog provider 有基线 → 不抛错，静默从任意同 provider 模型继承（R3 保守档的理由）', async () => {
    const rt = await newRuntime()
    // pi 不抛：api/baseUrl 从 candidates[0] 兜底继承。设计 R3 因此不依赖 pi 的兜底——
    // overlay-only 新模型经兜底继承到的 api/baseUrl 语义未经上游目录声明，宁可提前跳闸。
    expect(() => rt.registerProvider(PROVIDER, { models: [noApiNoBaseUrl] })).not.toThrow()
    const got = rt.getModel(PROVIDER, 'No-Api')!
    expect(got.api).toBe(getBuiltinModels(PROVIDER)[0].api)
    expect(got.baseUrl).toBe(getBuiltinModels(PROVIDER)[0].baseUrl)
  })

  it('image 类型定义在无 image 基线的 provider 上 → 同样抛错（兜底按类型过滤）', async () => {
    const rt = await newRuntime()
    expect(() =>
      rt.registerProvider(PROVIDER, {
        models: [
          {
            type: 'image',
            id: 'No-Api-Image',
            name: 'No-Api-Image',
            input: ['text'],
            output: ['image'],
            cost: { input: 0, output: 0 },
            contextWindow: 1,
          },
        ],
      }),
    ).toThrow(/no "api" specified/)
  })
})
