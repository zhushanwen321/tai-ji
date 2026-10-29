/**
 * pi 语义 guard 探针 —— 登记表 docs/pi-semantics.json 的 PS-82 ~ PS-85 + PS-87 + PS-88 断言。
 *
 * PS-82 ~ PS-85 四条是 provider-catalog-sync 设计（目录投喂）最重的 pi 私有语义依赖集，
 * 方案成立全部系于它们（设计 §2.5 前提 1-4）；PS-87 是 R7 规则的承重语义（refreshModels
 * 钩子 falsy 返回=保留注入集）；PS-88 是 D5 运行中注册对账的承重语义（扩展工厂返回后
 * registerProvider 直连注册表立即生效）。pi 升级时 `scripts/check-pi-semantics.mjs` 的四包
 * 版本门禁会 fail 并列出待重验条目，本文件即重验入口——装配顺序 / 幂等语义 / 映射替换 /
 * 官方导出 / 钩子 falsy 保留 / post-bind 直连任一漂移都在此变红，不依赖人读 ADR 记忆。
 *
 * 断言分两层：
 * - **源码层**：读 pi 实装 dist 文件，断言关键语句的存在与**先后顺序**（装配链的顺序
 *   无法用单次调用观测，只能从实装推演——顺序契约本身是断言对象）。
 * - **运行时层**：对实装版 pi 真实调用（`ModelRuntime` / `createExtensionRuntime` /
 *   `ExtensionRunner` / pi-ai 官方导出），断言返回结构与合并语义。禁 mock pi 本体——mock
 *   掉的正是被测面。
 *
 * 行号锚全部基于 pi@1.0.0 实装实测（2026-10-20）。源码层断言按锚点语句内容定位
 * （lineOf / lineOfAfter）：pi bump 后纯行号漂移不断言也不红；锚点语句被改写/删除或
 * 相对顺序漂移才红——此时按报错重新核对锚点语义是否仍成立，再更新
 * docs/pi-semantics.json 的 note。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  createExtensionRuntime,
  type ExtensionActions,
  type ExtensionContextActions,
} from '@earendil-works/pi-coding-agent'
import {
  getBuiltinProviders,
  getBuiltinModels,
  getBuiltinModelDataGeneratedAt,
} from '@earendil-works/pi-ai/providers/all'

import { expectVisibleIds, fullBaselineConfig, runtimeWithFullBaseline, swapToSingleExpectShrink } from './pi-runtime-testkit.ts'

// ── pi 实装 dist 源码读取（源码层断言的输入）────────────────────────────
// 两包的 exports map 都不暴露 ./package.json，改经主入口解析（`.` → dist/index.js），
// 取 dirname 即包内 dist 根——与硬编码 node_modules 路径等价但不依赖仓库布局假设。
// 用 import.meta.resolve（ESM 解析，认 exports 的 import 条件）；CJS require.resolve
// 不认 import 条件会报 No "exports" main defined。
const PI_AGENT_DIST = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')))
const PI_AI_DIST = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai')))

function readDist(pkgDist: string, relPath: string): string {
  return readFileSync(join(pkgDist, relPath), 'utf-8')
}

/** 关键语句在源码中的行号（1-based）。找不到返回 -1，调用方据此断言存在性。 */
function lineOf(source: string, needle: string): number {
  const idx = source.indexOf(needle)
  if (idx === -1) return -1
  return source.slice(0, idx).split('\n').length
}

/**
 * `needle` 在 `startNeedle` **之后**首次出现的行号（1-based）。
 *
 * 必要性：同一语句在多个函数里重复出现时（如 `void this.refresh({ allowNetwork: false })`
 * 在 registerNativeProvider / registerProvider / unregisterProvider / registerVirtualModel
 * 四处都有；`no "api" specified` 抛错在 modelFromJson 与 extensionModelFromDefinition 两处
 * 都有），全文首次匹配会命中错误的那个函数——顺序断言随即变成假红。限定搜索区间后
 * 「X 在 Y 函数体内」才是可判定的命题。
 */
function lineOfAfter(source: string, startNeedle: string, needle: string): number {
  const start = source.indexOf(startNeedle)
  if (start === -1) return -1
  const offset = source.slice(0, start).split('\n').length - 1
  const idx = source.slice(start).indexOf(needle)
  if (idx === -1) return -1
  return offset + source.slice(start, start + idx).split('\n').length
}

const AGENT_SERVICES = () => readDist(PI_AGENT_DIST, 'core/agent-session-services.js')
const LOADER = () => readDist(PI_AGENT_DIST, 'core/extensions/loader.js')
const RUNNER = () => readDist(PI_AGENT_DIST, 'core/extensions/runner.js')
const RESOURCE_LOADER = () => readDist(PI_AGENT_DIST, 'core/resource-loader.js')
const MODEL_RUNTIME = () => readDist(PI_AGENT_DIST, 'core/model-runtime.js')
const PROVIDER_COMPOSER = () => readDist(PI_AGENT_DIST, 'core/provider-composer.js')
const PI_AI_ALL = () => readDist(PI_AI_DIST, 'providers/all.js')

/** 被测 catalog provider：内置基线 3 个 chat 模型。 */
const PROVIDER = 'minimax-cn'

let tmpDir: string
async function newRuntime() {
  return ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    authPath: join(tmpDir, 'auth.json'),
  })
}

beforeAll(() => {
  // 与 sdk-contract.test.ts 同形态隔离：内存 ModelsStore + 不发起网络刷新 + tmp 凭据路径
  tmpDir = mkdtempSync(join(tmpdir(), 'pi-semantics-catalog-'))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ─────────────────────────────────────────────────────────────────────
describe('PS-82 —— 装配顺序：工厂期注册先于 --model 解析与 session_start', () => {
  it('源码层：createAgentSessionServices 内六个环节按装配链顺序出现', () => {
    const src = AGENT_SERVICES()
    const anchors = [
      ['ModelRuntime.create', 'ModelRuntime.create({'],
      ['resourceLoader.reload（扩展工厂执行入口）', 'await resourceLoader.reload('],
      ['pending 队列 flush 进注册表', 'modelRuntime.registerProvider(name, config);'],
      ['一次本地 refresh', 'await modelRuntime.refresh({ allowNetwork: false });'],
    ]
    const lines = anchors.map(([label, needle]) => {
      const line = lineOf(src, needle)
      expect(line, `装配链环节缺失: ${label}（${needle}）`).toBeGreaterThan(0)
      return { label, line }
    })
    // 严格递增 = 顺序契约成立
    for (let i = 1; i < lines.length; i += 1) {
      expect(
        lines[i].line,
        `装配顺序颠倒: ${lines[i - 1].label}(${lines[i - 1].line}) 应早于 ${lines[i].label}(${lines[i].line})`,
      ).toBeGreaterThan(lines[i - 1].line)
    }
  })

  it('源码层：--model 解析与 session_start 都在 refresh 之后（工厂期注册覆盖得到它们）', () => {
    const src = AGENT_SERVICES()
    const refreshLine = lineOf(src, 'await modelRuntime.refresh({ allowNetwork: false });')
    const modelLine = lineOf(src, 'model: options.model,')
    const sessionStartLine = lineOf(src, 'sessionStartEvent: options.sessionStartEvent,')
    expect(refreshLine).toBeGreaterThan(0)
    expect(modelLine, 'createAgentSession 的 model 入参（--model 解析的落点）缺失').toBeGreaterThan(refreshLine)
    expect(sessionStartLine, 'sessionStartEvent（session_start 的 emit 载荷）缺失').toBeGreaterThan(refreshLine)
  })

  it('源码层：扩展工厂在 resourceLoader.reload 内执行（工厂期 registerProvider 的时机前提）', () => {
    const loader = RESOURCE_LOADER()
    const reloadLine = lineOf(loader, 'async reload(options) {')
    const loadCachedLine = lineOf(loader, 'const extensionsResult = await loadExtensionsCached(extensionPaths, this.cwd, this.eventBus);')
    expect(reloadLine).toBeGreaterThan(0)
    expect(loadCachedLine, 'reload 内的 loadExtensionsCached 调用缺失').toBeGreaterThan(reloadLine)

    const extLoader = LOADER()
    const factoryLine = lineOf(extLoader, 'await factory(load.api);')
    expect(factoryLine, '扩展工厂调用点（initializeExtension）缺失').toBeGreaterThan(0)
  })

  it('运行时层：工厂期 registerProvider 进 pending 队列而非直写注册表', () => {
    // 扩展工厂体内拿到的 pi.registerProvider 是「排队」语义——队列由装配链在
    // --model 解析之前统一 flush。这是 D1（工厂期注册）能覆盖症状 8 的机制本体。
    const runtime = createExtensionRuntime()
    expect(runtime.pendingProviderRegistrations).toEqual([])

    runtime.registerProvider(PROVIDER, { models: [] })
    expect(runtime.pendingProviderRegistrations).toHaveLength(1)
    expect(runtime.pendingProviderRegistrations[0]).toMatchObject({ name: PROVIDER })

    // 队列可被 unregisterProvider 撤销（工厂期纠错通道）
    runtime.unregisterProvider(PROVIDER)
    expect(runtime.pendingProviderRegistrations).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────
describe('PS-83 —— registerProvider 重复注册幂等 + 尾随零网络本地 refresh', () => {
  it('运行时层：有值字段合并（models 在只注册 refreshModels 时保留）', async () => {
    const { rt, baseline } = await runtimeWithFullBaseline(PROVIDER, tmpDir)

    // 第二次只注册 refreshModels → models 不得被清空（字段级合并，非整体替换 config）
    rt.registerProvider(PROVIDER, { refreshModels: async () => undefined })
    const cfg = rt.getRegisteredProviderConfig(PROVIDER)
    expect(cfg?.models).toHaveLength(baseline.length)
    expect(typeof cfg?.refreshModels).toBe('function')
    expectVisibleIds(rt, PROVIDER, baseline.map((m) => m.id))
  })

  it('运行时层：models 数组整体替换（不是与上一次注册的 models 数组合并）', async () => {
    const { rt, baseline } = await runtimeWithFullBaseline(PROVIDER, tmpDir)

    // 只留一个 = 整体替换；若为合并则仍是 3 个
    swapToSingleExpectShrink(rt, PROVIDER, baseline[0])
  })

  it('运行时层：undefined 值不覆盖已有注册（合并只取有值字段）', async () => {
    const baseline = getBuiltinModels(PROVIDER)
    const rt = await newRuntime()
    rt.registerProvider(PROVIDER, { name: 'Kept Name', ...fullBaselineConfig(PROVIDER) })

    rt.registerProvider(PROVIDER, { name: undefined, models: undefined })
    const cfg = rt.getRegisteredProviderConfig(PROVIDER)
    expect(cfg?.name).toBe('Kept Name')
    expect(cfg?.models).toHaveLength(baseline.length)
  })

  it('源码层：registerProvider 尾随一次 allowNetwork:false 的本地 refresh', () => {
    const src = MODEL_RUNTIME()
    const registerLine = lineOf(src, 'registerProvider(providerId, config) {')
    const unregisterLine = lineOf(src, 'unregisterProvider(providerId) {')
    expect(registerLine).toBeGreaterThan(0)
    expect(unregisterLine, 'unregisterProvider（registerProvider 的函数体下界）缺失').toBeGreaterThan(registerLine)

    // 全部锚点限定在 registerProvider 函数体内——同一语句在四个 register* 方法里重复出现
    const validateLine = lineOfAfter(src, 'registerProvider(providerId, config) {', 'validateExtensionProvider(providerId, this.builtins.get(providerId), this.config.getProvider(providerId), config);')
    const mergeLine = lineOfAfter(src, 'registerProvider(providerId, config) {', 'const previous = this.extensionProviders.get(providerId);')
    const assignLine = lineOfAfter(src, 'registerProvider(providerId, config) {', 'effective[key] = value;')
    const refreshLine = lineOfAfter(src, 'registerProvider(providerId, config) {', 'void this.refresh({ allowNetwork: false });')

    expect(validateLine, '注册前结构校验缺失').toBeGreaterThan(registerLine)
    expect(mergeLine, 'previous 合并读取缺失').toBeGreaterThan(validateLine)
    expect(assignLine, '有值字段合并赋值缺失').toBeGreaterThan(mergeLine)
    expect(refreshLine, 'registerProvider 体内的尾随 refresh 缺失').toBeGreaterThan(assignLine)
    expect(refreshLine, '尾随 refresh 应在 registerProvider 函数体内').toBeLessThan(unregisterLine)
  })
})

// ─────────────────────────────────────────────────────────────────────
describe('PS-84 —— extension 层 models 即最终可见集合 + 注册时逐模型结构校验', () => {
  it('运行时层：models 数组是该 provider 的最终可见集合（映射替换，非与内置层合并）', async () => {
    const baseline = getBuiltinModels(PROVIDER)
    const rt = await newRuntime()
    // 注入集只含 1 个模型 → 可见集合收缩为 1（内置层 3 个未被保留）
    swapToSingleExpectShrink(rt, PROVIDER, baseline[0])
    // 反向：注入全集 → 可见集合 = 全集
    rt.registerProvider(PROVIDER, fullBaselineConfig(PROVIDER))
    expectVisibleIds(rt, PROVIDER, baseline.map((m) => m.id))
  })

  it('运行时层：缺 api/baseUrl 且无同类型基线可继承 → 注册抛错（结构校验生效）', async () => {
    const rt = await newRuntime()
    expect(() =>
      rt.registerProvider('no-such-catalog-provider', {
        models: [
          {
            id: 'No-Api',
            name: 'No-Api',
            input: ['text'],
            cost: { input: 0, output: 0 },
            reasoning: false,
            contextWindow: 1,
            maxTokens: 1,
          },
        ],
      }),
    ).toThrow(/no "api" specified/)
  })

  it('运行时层：provider 级校验——streamSimple 无 api 注册期即抛错，且 broken 注册不污染 stored config', async () => {
    const rt = await newRuntime()
    expect(() =>
      rt.registerProvider('no-such-catalog-provider', {
        streamSimple: () => {
          throw new Error('unused')
        },
      }),
    ).toThrow(/"api" is required when registering streamSimple/)
    // 抛错的注册不落进注册表（broken re-registration 不得污染 stored config）
    expect(rt.getRegisteredProviderConfig('no-such-catalog-provider')).toBeUndefined()
  })

  it('运行时层：compose 期异常落 compositionErrors 并经 getError 可见（R4 运行中归因通道）', async () => {
    // R4 的运行中归因依赖「compose 失败落入 compositionErrors 并经 getError 可见」。
    // 构造 = 注册期合法（全基线过校验），随后落盘写坏的用户配置 models.json 条目使
    // compose 期变坏——配置变更使 compose 抛错而注册期校验已过的窗口正是 R4 语义。
    // 两个构造约束（pi@1.0.0 实测）：坏条目须落在无内置基线的 provider 上（有基线时
    // modelFromJson 的四级兜底静默继承 api/baseUrl 不抛错，sdk-contract.test.ts 第③组
    // 已锁）；条目还须过 models.json 的 config schema（cost.cacheRead/cacheWrite 必填）
    // ——schema 层错误走 configError（getError 首段），不是本用例要锁的
    // compositionErrors 通道。
    const modelsPath = join(tmpDir, 'compose-error-models.json')
    const rt = await ModelRuntime.create({
      modelsPath,
      refreshOnCreate: false,
      authPath: join(tmpDir, 'auth.json'),
    })
    rt.registerProvider(PROVIDER, fullBaselineConfig(PROVIDER))
    await rt.refresh({ allowNetwork: false })
    // 前置：初始态无组合错误（自证后置断言非恒真）
    expect(rt.getError()).toBeUndefined()
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          'no-such-catalog-provider': {
            models: [
              {
                id: 'Broken-Compose',
                name: 'Broken-Compose',
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                reasoning: false,
                contextWindow: 1,
                maxTokens: 1,
              },
            ],
          },
        },
      }),
    )
    await rt.refresh({ allowNetwork: false })
    // composeProvider 捕获组合异常落 compositionErrors，getError 拼 `Provider "<id>": <msg>`
    // （dist/core/model-runtime.js composeProvider catch 分支 + getError 拼接段）——
    // provider-live-sync 运行中 tick 消费 getError() 的正是这个形态（非空即 error 日志）。
    expect(rt.getError()).toMatch(/Provider "/)
    expect(rt.getError()).toMatch(/no "api" specified/)
  })

  it('源码层：applyExtension 对 models 做 map 替换（非 concat / merge）', () => {
    const src = PROVIDER_COMPOSER()
    const applyLine = lineOf(src, 'function applyExtension(providerId, models, config) {')
    const mapLine = lineOf(src, 'return config.models.map((definition) => extensionModelFromDefinition(providerId, models, config, definition));')
    expect(applyLine).toBeGreaterThan(0)
    expect(mapLine, 'applyExtension 的 map 替换分支缺失').toBeGreaterThan(applyLine)
    // 无 models 时走 baseUrl 覆盖或原样返回（不凭空造模型）
    expect(lineOf(src, 'return config.baseUrl ? models.map((model) => ({ ...model, baseUrl: config.baseUrl })) : [...models];')).toBeGreaterThan(applyLine)
  })

  it('源码层：extensionModelFromDefinition 逐个定义校验 api / baseUrl 后抛错', () => {
    const src = PROVIDER_COMPOSER()
    const fnStart = 'function extensionModelFromDefinition(providerId, models, config, definition) {'
    const fnLine = lineOf(src, fnStart)
    // 两个抛错语句在 modelFromJson 里也有一份同款文案，必须限定在 extension 分支内
    const apiThrow = lineOfAfter(src, fnStart, 'throw new Error(`Provider ${providerId}, model ${definition.id}: no "api" specified.')
    const baseUrlThrow = lineOfAfter(src, fnStart, 'throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);')
    expect(fnLine).toBeGreaterThan(0)
    expect(apiThrow, 'extensionModelFromDefinition 内 api 缺失抛错点缺失').toBeGreaterThan(fnLine)
    expect(baseUrlThrow, 'extensionModelFromDefinition 内 baseUrl 缺失抛错点缺失').toBeGreaterThan(fnLine)
    // 四级兜底继承的实装落点（R3 保守档的对照面）
    const defaultsLine = lineOf(src, 'function findExtensionModelDefaults(models, definition) {')
    expect(defaultsLine, 'findExtensionModelDefaults（兜底继承）缺失').toBeGreaterThan(0)
  })

  it('源码层：validateExtensionProvider 是 registerProvider 的前置校验入口', () => {
    const composer = PROVIDER_COMPOSER()
    expect(lineOf(composer, 'export function validateExtensionProvider(providerId, base, modelsConfig, extension) {')).toBeGreaterThan(0)
    const runtime = MODEL_RUNTIME()
    expect(
      lineOf(runtime, 'validateExtensionProvider(providerId, this.builtins.get(providerId), this.config.getProvider(providerId), config);'),
    ).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────
describe('PS-85 —— 扩展进程内可经 pi-ai 官方导出拿到三态判据全部材料', () => {
  it('运行时层：三个导出可调用且返回有效值', () => {
    const providers = getBuiltinProviders()
    expect(Array.isArray(providers)).toBe(true)
    expect(providers.length).toBeGreaterThan(0)
    expect(providers).toContain(PROVIDER)

    const models = getBuiltinModels(PROVIDER)
    expect(Array.isArray(models)).toBe(true)
    expect(models.length).toBeGreaterThan(0)
    // 基线模型须带三态判据与并集计算所需的字段
    for (const m of models) {
      expect(typeof m.id).toBe('string')
      expect(typeof m.api).toBe('string')
      expect(typeof m.baseUrl).toBe('string')
    }

    const generatedAt = getBuiltinModelDataGeneratedAt()
    expect(typeof generatedAt).toBe('number')
    expect(Number.isFinite(generatedAt)).toBe(true)
    expect(generatedAt).toBeGreaterThan(0)
  })

  it('运行时层：staleness 基准时刻与内置基线同源（同一 manifest 的同一字段）', () => {
    // D3 的判定基准 = pi-ai 官方导出，与 pi 执行侧 withRemoteCatalog 用的时刻锚完全同源。
    // 同一进程内两次读取必须稳定（manifest 是编译期常量）。
    expect(getBuiltinModelDataGeneratedAt()).toBe(getBuiltinModelDataGeneratedAt())
  })

  it('运行时层：未知 provider 的基线为空数组（never-seen 判据的输入形态）', () => {
    expect(getBuiltinModels('no-such-catalog-provider')).toEqual([])
  })

  it('源码层：三个导出实装于 pi-ai 的 providers/all.js', () => {
    const src = PI_AI_ALL()
    expect(lineOf(src, 'export function getBuiltinProviders() {')).toBeGreaterThan(0)
    expect(lineOf(src, 'export function getBuiltinModels(provider) {')).toBeGreaterThan(0)
    expect(lineOf(src, 'export function getBuiltinModelDataGeneratedAt() {')).toBeGreaterThan(0)
    // 时刻锚读的是编译期 manifest 的 generatedAt 字段（非运行时时钟）
    expect(lineOf(src, 'const generatedAt = Date.parse(modelDataManifest.generatedAt);')).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────
describe('PS-87 —— refreshModels 钩子 falsy 返回=保留注入集（R7 承重）', () => {
  it('运行时层：钩子返回 undefined → refresh() 后注入集保留（发布分支被跳过）', async () => {
    const { rt, baseline } = await runtimeWithFullBaseline(PROVIDER, tmpDir)

    // R7 形态：钩子按实装语义返回 undefined（「本次不发布新列表」，瞬时读失败不清空）。
    // hookCalled 自证钩子被真实调用——pi-ai ModelsStore.refresh 对 refreshable provider
    // 无论 allowNetwork 都先跑一轮 allowNetwork:false 的 phase（:195 早退 :198 之前），
    // 否则「注入集不变」可能是「钩子根本没被调用」的假绿。
    let hookCalled = false
    rt.registerProvider(PROVIDER, { refreshModels: async () => { hookCalled = true; return undefined } })
    await rt.refresh({ allowNetwork: false })

    expect(hookCalled).toBe(true)
    expectVisibleIds(rt, PROVIDER, baseline.map((m) => m.id))
  })

  it('运行时层：对照——同一链路钩子返回有值列表时发布分支生效（可见集合替换）', async () => {
    const { rt, baseline } = await runtimeWithFullBaseline(PROVIDER, tmpDir)

    rt.registerProvider(PROVIDER, { refreshModels: async () => [{ ...baseline[0] }] })
    await rt.refresh({ allowNetwork: false })

    expectVisibleIds(rt, PROVIDER, [baseline[0].id])
  })

  it('源码层：类型声明不含 undefined + 合成包装的 falsy 发布分支', () => {
    // 声明层锚：pi 声明不收 undefined——catalog-bridge 侧宽一档声明（RefreshModelsFn）
    // + 显式断言挂 ProviderConfig 的依据（类型声明若改收 undefined，断言即多余可清理）
    const types = readDist(PI_AGENT_DIST, 'core/extensions/types.d.ts')
    expect(
      lineOf(types, 'refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;'),
    ).toBeGreaterThan(0)

    const src = PROVIDER_COMPOSER()
    const callLine = lineOf(src, 'refreshed = await extension.refreshModels(context);')
    expect(callLine).toBeGreaterThan(0)
    // falsy 分支：if (refreshed) 才 applyExtension 发布——返回 undefined 即跳过（保留注入）
    const branchLine = lineOfAfter(src, 'refreshed = await extension.refreshModels(context);', 'if (refreshed) {')
    expect(branchLine, '发布分支 if (refreshed) 缺失').toBeGreaterThan(callLine)
    const publishLine = lineOfAfter(
      src,
      'if (refreshed) {',
      'applyExtension(providerId, applyModelsJson(providerId, getAllProviderModels(base), config), {',
    )
    expect(publishLine, '发布分支内的 applyExtension 缺失').toBeGreaterThan(branchLine)
  })
})

// ─────────────────────────────────────────────────────────────────────
describe('PS-88 —— 扩展工厂返回后 registerProvider 直连注册表立即生效（D5 注册对账承重）', () => {
  /** 无内置基线的合成 provider：注册前可见集合恒空，注册后出现即「立即生效」的直接证据。 */
  const SYNTHETIC = 'no-such-catalog-provider'

  /** 合成 provider 的完整模型定义（克隆一条内置模型换 id，api/baseUrl 齐全、过结构校验）。 */
  function syntheticModel(id: string) {
    return { ...getBuiltinModels(PROVIDER)[0], id, name: id }
  }

  /**
   * bindCore 的两组回调桩：bindCore 只是把它们拷进 runtime（runner.js bindCore 开头的逐字段
   * 赋值），本探针不触发任何会话动作，故一律用抛错桩——被意外调用即红，而不是静默假绿。
   */
  const notBound = (): never => {
    throw new Error('probe stub: session action must not be invoked by registerProvider')
  }
  const actions: ExtensionActions = {
    sendMessage: notBound,
    sendUserMessage: notBound,
    appendEntry: notBound,
    setSessionName: notBound,
    getSessionName: notBound,
    setLabel: notBound,
    getActiveTools: notBound,
    getAllTools: notBound,
    getSettings: notBound,
    setActiveTools: notBound,
    refreshTools: notBound,
    getCommands: notBound,
    setModel: notBound,
    getThinkingLevel: notBound,
    setThinkingLevel: notBound,
  }
  const contextActions: ExtensionContextActions = {
    getModel: notBound,
    getScopedModels: notBound,
    isIdle: notBound,
    isProjectTrusted: notBound,
    getSignal: notBound,
    abort: notBound,
    hasPendingMessages: notBound,
    shutdown: notBound,
    getContextUsage: notBound,
    compact: notBound,
    getSystemPrompt: notBound,
  }

  /** 真实装配骨架：扩展 runtime + 真实 ModelRuntime + ExtensionRunner（与 agent-session.js 同形态：ModelRegistry 包装 ModelRuntime）。 */
  async function newRunnerSetup() {
    const runtime = createExtensionRuntime()
    const rt = await newRuntime()
    const runner = new ExtensionRunner([], runtime, tmpDir, SessionManager.inMemory(tmpDir), new ModelRegistry(rt))
    return { runtime, rt, runner }
  }

  it('运行时层：bindCore 前排队不可见；bindCore flush 后可见；bindCore 后再注册立即可见且不再排队', async () => {
    const { runtime, rt, runner } = await newRunnerSetup()

    // 工厂期形态（pre-bind）：只排队，注册表不动——PS-82 的「工厂期进 pending 队列」在此做对照
    runtime.registerProvider(SYNTHETIC, { models: [syntheticModel('Factory-Model')] })
    expect(runtime.pendingProviderRegistrations).toHaveLength(1)
    expectVisibleIds(rt, SYNTHETIC, [])

    // bindCore（无 providerActions → 直连 modelRegistry，runner.js :314 分支）：flush 工厂期队列
    runner.bindCore(actions, contextActions)
    expect(runtime.pendingProviderRegistrations).toEqual([])
    expectVisibleIds(rt, SYNTHETIC, ['Factory-Model'])

    // post-bind 形态（provider-live-sync 运行中注册对账走的路径）：同步调用返回即可见，
    // 不进队列、不等任何 refresh / reload——catalog-bridge reconcile 对「工厂期 never-seen →
    // 运行中变 fresh」补注册依赖的正是这一点
    runtime.registerProvider(SYNTHETIC, { models: [syntheticModel('Factory-Model'), syntheticModel('Post-Bind-Model')] })
    expect(runtime.pendingProviderRegistrations).toEqual([])
    expectVisibleIds(rt, SYNTHETIC, ['Factory-Model', 'Post-Bind-Model'])
  })

  it('运行时层：post-bind 注册一个全新 provider（工厂期从未注册过）同样立即可见', async () => {
    const { runtime, rt, runner } = await newRunnerSetup()
    runner.bindCore(actions, contextActions)
    expectVisibleIds(rt, SYNTHETIC, [])

    runtime.registerProvider(SYNTHETIC, { models: [syntheticModel('Late-Joiner')] })
    expectVisibleIds(rt, SYNTHETIC, ['Late-Joiner'])
    // 与 PS-83 一致：带 refreshModels 钩子的注册同样立即落表（对账注册携带钩子的形态）
    runtime.registerProvider(SYNTHETIC, { refreshModels: async () => undefined })
    expect(typeof rt.getRegisteredProviderConfig(SYNTHETIC)?.refreshModels).toBe('function')
    expectVisibleIds(rt, SYNTHETIC, ['Late-Joiner'])
  })

  it('运行时层：生产形态的 providerActions.registerProvider 分支（agent-session.js 第三参）同步直达同一 ModelRuntime', async () => {
    const { runtime, rt, runner } = await newRunnerSetup()
    let viaProviderActions = 0
    runner.bindCore(actions, contextActions, {
      registerProvider: (name, config) => {
        viaProviderActions += 1
        rt.registerProvider(name, config)
      },
    })

    runtime.registerProvider(SYNTHETIC, { models: [syntheticModel('Via-Actions')] })
    expect(viaProviderActions).toBe(1)
    expectVisibleIds(rt, SYNTHETIC, ['Via-Actions'])
  })

  it('运行时层：post-bind 注册的结构校验同步抛错且不污染注册表（catalog-bridge R4 在运行中对账期可捕获）', async () => {
    const { runtime, rt, runner } = await newRunnerSetup()
    runner.bindCore(actions, contextActions)

    // 工厂期同样的坏入参被 bindCore flush 时只进 emitError 不抛回扩展；post-bind 直连则同步抛——
    // 这正是 reconcile 复用 R4 try/catch 的依据
    expect(() =>
      runtime.registerProvider(SYNTHETIC, {
        models: [
          {
            id: 'No-Api',
            name: 'No-Api',
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            reasoning: false,
            contextWindow: 1,
            maxTokens: 1,
          },
        ],
      }),
    ).toThrow(/no "api" specified/)
    expect(rt.getRegisteredProviderConfig(SYNTHETIC)).toBeUndefined()
    expectVisibleIds(rt, SYNTHETIC, [])
  })

  it('源码层：bindCore 在 flush pending 队列之后把 runtime.registerProvider 替换为直连 modelRegistry', () => {
    const src = RUNNER()
    const bindLine = lineOf(src, 'bindCore(actions, contextActions, providerActions) {')
    expect(bindLine).toBeGreaterThan(0)
    const flushLine = lineOfAfter(src, 'bindCore(actions, contextActions, providerActions) {', 'this.runtime.pendingProviderRegistrations = [];')
    const commentLine = lineOfAfter(
      src,
      'bindCore(actions, contextActions, providerActions) {',
      '// From this point on, provider registration/unregistration takes effect immediately',
    )
    const rebindLine = lineOfAfter(src, 'bindCore(actions, contextActions, providerActions) {', 'this.runtime.registerProvider = (name, config) => {')
    const directLine = lineOfAfter(src, 'this.runtime.registerProvider = (name, config) => {', 'this.modelRegistry.registerProvider(name, config);')
    expect(flushLine, 'bindCore 内 pending 队列清空缺失').toBeGreaterThan(bindLine)
    expect(commentLine, '「takes effect immediately」注释缺失——post-bind 立即生效的契约陈述被改写').toBeGreaterThan(flushLine)
    expect(rebindLine, 'bindCore 内 runtime.registerProvider 的 post-bind 替换缺失').toBeGreaterThan(commentLine)
    expect(directLine, 'post-bind registerProvider 直连 modelRegistry.registerProvider 缺失').toBeGreaterThan(rebindLine)
  })

  it('源码层：loader 的 applyRuntimeChange 非 loading 态直接执行；api.registerProvider 经它转发；commit 置 active', () => {
    const src = LOADER()
    const stateLine = lineOf(src, 'let state = "loading";')
    const applyLine = lineOf(src, 'const applyRuntimeChange = (change) => {')
    const queueLine = lineOfAfter(src, 'const applyRuntimeChange = (change) => {', 'pendingRuntimeChanges.push(change);')
    const directLine = lineOfAfter(src, 'pendingRuntimeChanges.push(change);', 'change();')
    expect(stateLine).toBeGreaterThan(0)
    expect(applyLine, 'applyRuntimeChange 缺失').toBeGreaterThan(stateLine)
    expect(queueLine, 'loading 态排队分支缺失').toBeGreaterThan(applyLine)
    expect(directLine, '非 loading 态直接执行分支缺失').toBeGreaterThan(queueLine)

    const apiLine = lineOf(src, 'registerProvider(providerOrName, config) {')
    const forwardLine = lineOfAfter(
      src,
      'registerProvider(providerOrName, config) {',
      'applyRuntimeChange(() => runtime.registerProvider(providerOrName, config, extension.path));',
    )
    expect(apiLine, 'api.registerProvider 缺失').toBeGreaterThan(applyLine)
    expect(forwardLine, 'api.registerProvider 未经 applyRuntimeChange 转发').toBeGreaterThan(apiLine)

    const commitLine = lineOf(src, 'commit: () => {')
    const replayLine = lineOfAfter(src, 'commit: () => {', 'for (const apply of pendingRuntimeChanges)')
    const activeLine = lineOfAfter(src, 'commit: () => {', 'state = "active";')
    expect(commitLine, 'commit 缺失').toBeGreaterThan(apiLine)
    expect(replayLine, 'commit 内回放 pendingRuntimeChanges 缺失').toBeGreaterThan(commitLine)
    expect(activeLine, 'commit 内 state = "active" 缺失').toBeGreaterThan(replayLine)
  })

  it('源码层：ModelRuntime.registerProvider 体内 recomposeProvider → updateModelSnapshot（注册即进可见快照）', () => {
    const src = MODEL_RUNTIME()
    const start = 'registerProvider(providerId, config) {'
    const registerLine = lineOf(src, start)
    const unregisterLine = lineOf(src, 'unregisterProvider(providerId) {')
    const recomposeLine = lineOfAfter(src, start, 'this.recomposeProvider(providerId);')
    const snapshotLine = lineOfAfter(src, start, 'this.updateModelSnapshot();')
    expect(registerLine).toBeGreaterThan(0)
    expect(recomposeLine, 'registerProvider 体内 recomposeProvider 缺失').toBeGreaterThan(registerLine)
    expect(snapshotLine, 'registerProvider 体内 updateModelSnapshot 缺失').toBeGreaterThan(recomposeLine)
    expect(snapshotLine, '快照更新应在 registerProvider 函数体内').toBeLessThan(unregisterLine)
  })
})
