/**
 * catalog-bridge 单元测试（设计 §4.2「单元（extension）」的投喂分支断言）。
 *
 * 被测面 = `src/catalog-bridge.ts` 的投喂分支：env 检测（R1）→ 两份缓存新者胜合并 →
 * 三态判定与并集（D2）→ `registerProvider` + `refreshModels` 钩子（D1/D5）→ mtime 短路
 * → R2/R3/R4/R5/R6/R7 的 fail-safe 降级。判据本体（解析/合并/三态/并集）的单测在
 * llm-shared 包，本文件只测「IO + 日志 + 注册」这一层的接线与降级。
 *
 * 与 model-sync.test.ts 的分工：那份测既有 models.json/auth.json 同步的 per-file 比较
 * 语义（本文件一行不改它）；本文件测新增的目录投喂，直接调 `injectCatalogOverlay`，
 * 不经 tick。
 *
 * 隔离方式：
 * - env：`TAIJI_AGENT_DATA_DIR` / `PI_CODING_AGENT_DIR` 各指一个 mkdtemp 真实目录
 *   （vitest 防线的 global-setup 恒把前者钉到 tmp，故每个用例显式覆盖并还原）；
 * - logger：mock `@zhushanwen/pi-extension-logger` 的 `getLogger` 返回 spy 三元组——
 *   debug/warn/error 的分级正是 R2/R3/R5/R7 的断言对象，而真实 logger 的 debug 只落
 *   文件日志（无 appendEntry 出口），不 mock 就断言不了级别；
 * - pi：fake `{ registerProvider, on, appendEntry }`，`registerProvider` 是 spy——
 *   R4 的「抛错不扩散」靠它按 provider 选择性抛错来驱动。
 *
 * mtime 控制用真实临时文件 + `utimesSync` 钉死时刻戳（不用 fake timers——被测的是
 * 文件系统的 mtime 比较，fake 时钟碰不到它）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBuiltinModelDataGeneratedAt, getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from '@earendil-works/pi-coding-agent'

import { createOverlayCacheWatcher, injectCatalogOverlay, type OverlayCacheWatcher } from '../catalog-bridge.ts'
import { startWithRegistryCtx, tickOnce } from './tick-harness.ts'

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))

/** mock pi 宿主的 getAgentDir 指向真实 tmp fixture（与 model-sync.test.ts 同手法）。
 *  全部用例都需要它：catalog-bridge 的 pi store 路径经 llm-shared 的 getPiStorePath
 *  委托 pi getAgentDir 推导（不读 env），mock 不指向 tmp 会落到相对路径。 */
const piMocks = vi.hoisted(() => ({ agentDir: '' }))

vi.mock('@zhushanwen/pi-extension-logger', () => ({
  getLogger: () => loggerMocks,
  setPiHandle: () => {},
  createLogger: () => loggerMocks,
  clearRateLimiterState: () => {},
}))

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => piMocks.agentDir,
}))

// ── 夹具常量 ──────────────────────────────────────────────

/** staleness 基准时刻（pi-ai 官方导出）；fresh 条目必须严格晚于它。 */
const GENERATED_AT = getBuiltinModelDataGeneratedAt() ?? 0
const FRESH_AT = GENERATED_AT + 60_000
/** 远端 404/501 落盘的否定信号（lastModified:0 恒判 expired）。 */
const NEGATIVE_SIGNAL_AT = 0

/** 有内置基线的真实 catalog provider（3 个 chat 模型）——并集断言要用真基线。 */
const REAL_PROVIDER = 'minimax-cn'
/** 无内置基线的合成 provider id——R3 的「同 id 无可继承定义」分支要靠空基线构造。 */
const SYNTHETIC_PROVIDER = 'overlay-test-provider'

/** mtime 钉死用的两个固定时刻（相差足够大，避免文件系统时间粒度吞掉差异）。 */
const MTIME_T0 = new Date('2024-01-02T03:04:05.000Z')
const MTIME_T1 = new Date('2024-06-07T08:09:10.000Z')

type RefreshModelsFn = NonNullable<ProviderConfig['refreshModels']>
type RefreshModelsContext = Parameters<RefreshModelsFn>[0]

/** 钩子的 context 入参（被测钩子不读它，只按签名形状造一个可传值）。 */
function fakeRefreshContext(): RefreshModelsContext {
  return {
    allowNetwork: false,
    signal: new AbortController().signal,
    publish: async () => true,
  } as unknown as RefreshModelsContext
}

type FakePi = {
  registerProvider: ReturnType<typeof vi.fn<(provider: string, config: ProviderConfig) => void>>
  on: ReturnType<typeof vi.fn>
  appendEntry: ReturnType<typeof vi.fn>
}

function makePi(): FakePi {
  return {
    registerProvider: vi.fn<(provider: string, config: ProviderConfig) => void>(),
    on: vi.fn(),
    appendEntry: vi.fn(),
  }
}

function asApi(pi: FakePi): ExtensionAPI {
  return pi as unknown as ExtensionAPI
}

/** 取某 provider 的注册入参（找不到即抛——注册缺失是缺陷形态，不是可断言的降级）。 */
function registeredConfig(pi: FakePi, providerId: string): ProviderConfig {
  const call = pi.registerProvider.mock.calls.find((c) => c[0] === providerId)
  if (call === undefined) throw new Error(`provider ${providerId} 未被 registerProvider 注册`)
  return call[1]
}

function modelIds(config: ProviderConfig): string[] {
  return (config.models ?? []).map((m) => m.id)
}

/** 调某 provider 的 refreshModels 钩子（R6/R7 的 undefined 分支原样返回，不做转换）。 */
async function callHook(pi: FakePi, providerId: string): Promise<ProviderModelConfig[] | undefined> {
  const hook = registeredConfig(pi, providerId).refreshModels
  if (hook === undefined) throw new Error(`provider ${providerId} 的注册未携带 refreshModels 钩子`)
  return hook(fakeRefreshContext())
}

// ── 生命周期（env + 临时目录）──────────────────────────────

let dataDir: string
let agentDir: string
let savedDataDir: string | undefined
let savedAgentDirEnv: string | undefined

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'catalog-bridge-data-'))
  agentDir = mkdtempSync(join(tmpdir(), 'catalog-bridge-agent-'))
  savedDataDir = process.env.TAIJI_AGENT_DATA_DIR
  savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR
  process.env.TAIJI_AGENT_DATA_DIR = dataDir
  process.env.PI_CODING_AGENT_DIR = agentDir
  piMocks.agentDir = agentDir
  loggerMocks.debug.mockClear()
  loggerMocks.warn.mockClear()
  loggerMocks.error.mockClear()
})

afterEach(() => {
  restoreEnv('TAIJI_AGENT_DATA_DIR', savedDataDir)
  restoreEnv('PI_CODING_AGENT_DIR', savedAgentDirEnv)
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ── 缓存文件写入助手 ──────────────────────────────────────

const TAiji_CACHE_PATH = (): string => join(dataDir, 'provider-catalog-overlay.json')
const PI_STORE_PATH = (): string => join(agentDir, 'models-store.json')

/** 写 taiji 自刷缓存（`{ version, entries }` 包装形态）。 */
function writeTaijiCache(entries: Record<string, unknown>): void {
  writeFileSync(TAiji_CACHE_PATH(), JSON.stringify({ version: 1, entries }))
}

/** 写 pi store（顶层 providerId 分桶形态）。 */
function writePiStore(entries: Record<string, unknown>): void {
  writeFileSync(PI_STORE_PATH(), JSON.stringify(entries))
}

/** 缓存条目（pi.dev 返回形状的宽松子集）。 */
function entry(models: Array<Record<string, unknown>>, lastModified: number) {
  return { models, checkedAt: FRESH_AT, lastModified }
}

/** 自带端点的模型定义（过 R3 过滤的最小完整形状）。 */
function endpointModel(id: string, name = id) {
  return { id, name, api: 'openai-completions', baseUrl: `https://example.invalid/${id}` }
}

/** 写 taiji 缓存条目后注入（单条目注册用例的共同路径：写缓存 → makePi → inject）。 */
function injectWithEntries(entries: Record<string, unknown>): FakePi {
  writeTaijiCache(entries)
  const pi = makePi()
  injectCatalogOverlay(asApi(pi))
  return pi
}

/** 播种单模型（Model-A）缓存并钉 mtime —— hook / mtime 短路 / watcher 用例的共同开场。 */
function seedCatalogPinned(at: Date): void {
  writeTaijiCache({ [SYNTHETIC_PROVIDER]: entry([endpointModel('Model-A')], FRESH_AT) })
  utimesSync(TAiji_CACHE_PATH(), at, at)
}

/** 改写缓存为 A+B 两模型并钉新 mtime（模拟上游目录更新 / 钩子返回新并集）。 */
function rewriteCatalogPinned(at: Date): void {
  writeTaijiCache({
    [SYNTHETIC_PROVIDER]: entry([endpointModel('Model-A'), endpointModel('Model-B')], FRESH_AT),
  })
  utimesSync(TAiji_CACHE_PATH(), at, at)
}

/** 注册一个 fresh 注入并断言 Model-A 落表（缓存已写、mtime 钉 T0）。 */
function injectFresh(): FakePi {
  seedCatalogPinned(MTIME_T0)
  const pi = makePi()
  injectCatalogOverlay(asApi(pi))
  expect(modelIds(registeredConfig(pi, SYNTHETIC_PROVIDER))).toEqual(['Model-A'])
  return pi
}

/** 播种 + 注入并返回监视条目（watcher 用例的共同开场）。 */
function injectWatcherPinned(at: Date): OverlayCacheWatcher | null {
  seedCatalogPinned(at)
  const watcher = injectCatalogOverlay(asApi(makePi()))
  expect(watcher).not.toBeNull()
  return watcher
}

// ─────────────────────────────────────────────────────────
describe('注入全链路（D1 注册时机 + D2 注入集并集）', () => {
  it('env 在位 + fresh → registerProvider 被调，models = 内置基线 ⊕ 缓存条目（同 id 整对象覆盖）', () => {
    const baseline = getBuiltinModels(REAL_PROVIDER)
    expect(baseline.length).toBeGreaterThan(0)
    // 同 id 覆盖：缓存版本整对象替换基线版本（对齐 pi mergeModels 语义）
    const overridden = { ...baseline[0], name: 'Overlay-Version-Of-Builtin' }
    writeTaijiCache({
      [REAL_PROVIDER]: entry([overridden, endpointModel('Overlay-Only-New')], FRESH_AT),
    })

    const pi = makePi()
    const watcher = injectCatalogOverlay(asApi(pi))

    expect(pi.registerProvider).toHaveBeenCalledTimes(1)
    const config = registeredConfig(pi, REAL_PROVIDER)
    // 并集 = 基线全部 id + overlay-only 新 id（只注 diff 会把基线挤出视图，D2 明令禁止）
    expect(modelIds(config)).toEqual([...baseline.map((m) => m.id), 'Overlay-Only-New'])
    // 同 id 那条是缓存版本，不是基线版本
    expect(config.models?.[0]).toMatchObject({ id: baseline[0].id, name: 'Overlay-Version-Of-Builtin' })
    // D5：注册必须携带 refreshModels 钩子（运行中窗口的更新通道）
    expect(config.refreshModels).toBeTypeOf('function')
    // 注入成功记 debug（V2 验收要能在 TAIJI_AGENT_DEBUG 日志里看到）
    expect(loggerMocks.debug).toHaveBeenCalledWith(
      expect.stringContaining(`catalog overlay injected for ${REAL_PROVIDER}`),
    )
    // 监视条目照挂（tick 挂载用），标签 = taiji 自刷缓存文件名
    expect(watcher).not.toBeNull()
    expect(watcher?.label).toBe('provider-catalog-overlay.json')
  })

  it('两份缓存都读：只在 taiji 里的 provider 与只在 store 里的 provider 都被注册', () => {
    // 新者胜合并的粒度是**条目（per provider）**，不是模型——同 provider 的两份条目
    // 二选一，不会把两侧的 models 数组并起来。故「两份都读」用两个互斥 provider 证。
    writePiStore({ 'store-only-provider': entry([endpointModel('Store-Model')], FRESH_AT) })
    const pi = injectWithEntries({ 'taiji-only-provider': entry([endpointModel('Taiji-Model')], FRESH_AT) })

    expect(pi.registerProvider.mock.calls.map((c) => c[0]).sort()).toEqual([
      'store-only-provider',
      'taiji-only-provider',
    ])
  })

  it('条目级新者胜：store 的那份更新 → 用 store 版本；taiji 的那份更晚 → 用 taiji 版本', () => {
    const older = entry([endpointModel('Shared-Model', 'From-Older-Source')], FRESH_AT)
    const newer = entry([endpointModel('Shared-Model', 'From-Newer-Source')], FRESH_AT + 1_000)

    writeTaijiCache({ [SYNTHETIC_PROVIDER]: older })
    writePiStore({ [SYNTHETIC_PROVIDER]: newer })
    let pi = makePi()
    injectCatalogOverlay(asApi(pi))
    expect(registeredConfig(pi, SYNTHETIC_PROVIDER).models?.[0]).toMatchObject({ name: 'From-Newer-Source' })

    // 反向：taiji 的那份更晚（同 id 平局取前者，故 +2_000 才翻得动）
    writeTaijiCache({
      [SYNTHETIC_PROVIDER]: entry([endpointModel('Shared-Model', 'From-Newer-Taiji')], FRESH_AT + 2_000),
    })
    pi = makePi()
    injectCatalogOverlay(asApi(pi))
    expect(registeredConfig(pi, SYNTHETIC_PROVIDER).models?.[0]).toMatchObject({ name: 'From-Newer-Taiji' })
  })
})

// ─────────────────────────────────────────────────────────
describe('R1 —— 非 taiji 环境（env 无数据目录）零注册', () => {
  it('TAIJI_AGENT_DATA_DIR 缺失 → 返回 null、零 registerProvider、零 warn/error', () => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    // 缓存文件在位也读不到——env 是唯一的路径来源，缺失即无从定位
    writeTaijiCache({ [SYNTHETIC_PROVIDER]: entry([endpointModel('Never-Reached')], FRESH_AT) })

    const pi = makePi()
    const watcher = injectCatalogOverlay(asApi(pi))

    expect(watcher).toBeNull()
    expect(pi.registerProvider).not.toHaveBeenCalled()
    expect(loggerMocks.warn).not.toHaveBeenCalled()
    expect(loggerMocks.error).not.toHaveBeenCalled()
  })

  it('env 设成空串等同未设（空串 = 缺失，不是「当前目录」）', () => {
    process.env.TAIJI_AGENT_DATA_DIR = ''
    const pi = makePi()
    expect(injectCatalogOverlay(asApi(pi))).toBeNull()
    expect(pi.registerProvider).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────
describe('R2 / R5 —— 缓存缺失、损坏与三态非 fresh 都不注入', () => {
  it('缓存文件缺失（首装未开过设置页的正常形态）→ 零注册 + debug 记 absent', () => {
    const pi = makePi()
    injectCatalogOverlay(asApi(pi))

    expect(pi.registerProvider).not.toHaveBeenCalled()
    expect(loggerMocks.debug).toHaveBeenCalledWith(expect.stringContaining('catalog cache absent'))
    expect(loggerMocks.warn).not.toHaveBeenCalled()
  })

  it('缓存损坏（JSON 非法）→ 零注册 + warn 记 corrupt（缺失记 debug、损坏记 warn，级别区分常态与异常）', () => {
    writeFileSync(TAiji_CACHE_PATH(), '{ not json')
    const pi = makePi()
    injectCatalogOverlay(asApi(pi))

    expect(pi.registerProvider).not.toHaveBeenCalled()
    expect(loggerMocks.warn).toHaveBeenCalledWith(expect.stringContaining('catalog cache corrupt'))
  })

  it('R5 expired（lastModified 不晚于基准时刻）→ 不注入 + debug 记 state=expired', () => {
    writeTaijiCache({ [SYNTHETIC_PROVIDER]: entry([endpointModel('Stale-Model')], GENERATED_AT) })
    const pi = makePi()
    injectCatalogOverlay(asApi(pi))

    expect(pi.registerProvider).not.toHaveBeenCalled()
    expect(loggerMocks.debug).toHaveBeenCalledWith(
      expect.stringContaining(`catalog overlay not injected for ${SYNTHETIC_PROVIDER}: state=expired`),
    )
  })

  it('R5 否定信号（lastModified:0，远端 404/501 落盘）→ 不注入', () => {
    writeTaijiCache({ [SYNTHETIC_PROVIDER]: entry([endpointModel('Negated-Model')], NEGATIVE_SIGNAL_AT) })
    const pi = makePi()
    injectCatalogOverlay(asApi(pi))

    expect(pi.registerProvider).not.toHaveBeenCalled()
  })

  it('R5 lastModified 字段缺失 → 判 expired（对齐 pi remoteModels 的缺失语义，不注入）', () => {
    writeTaijiCache({
      [SYNTHETIC_PROVIDER]: { models: [endpointModel('No-Stamp-Model')], checkedAt: FRESH_AT },
    })
    const pi = makePi()
    injectCatalogOverlay(asApi(pi))

    expect(pi.registerProvider).not.toHaveBeenCalled()
  })

  it('R5 never-seen（两份缓存都没有该 provider）→ 不进计算集，无注册动作也无日志', () => {
    const pi = injectWithEntries({ 'other-provider': entry([endpointModel('Other')], FRESH_AT) })

    // 计算集 = 缓存里出现过的 provider；未出现的连判定都不做（不是异常，不该有日志）
    expect(pi.registerProvider.mock.calls.map((c) => c[0])).toEqual(['other-provider'])
    expect(loggerMocks.debug).not.toHaveBeenCalledWith(expect.stringContaining('not injected'))
    expect(loggerMocks.warn).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────
describe('R3 —— fresh 条目缺 api/baseUrl 且同 id 无内置定义可继承 → 跳过该模型 + warn', () => {
  it('缺端点的模型被滤掉并 warn 指明 provider/model id；同条目里完整的模型照常注入', () => {
    // 合成 provider 无内置基线 → 四级兜底全空，正是 R3 保守档要拦的形态
    writeTaijiCache({
      [SYNTHETIC_PROVIDER]: entry(
        [{ id: 'No-Endpoint-Model', name: 'No-Endpoint-Model' }, endpointModel('Complete-Model')],
        FRESH_AT,
      ),
    })

    const pi = makePi()
    injectCatalogOverlay(asApi(pi))

    expect(modelIds(registeredConfig(pi, SYNTHETIC_PROVIDER))).toEqual(['Complete-Model'])
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${SYNTHETIC_PROVIDER}/No-Endpoint-Model`),
    )
  })

  it('同 id 有内置定义可继承 → 不跳过（R3 只认同 id 继承这一条路径）', () => {
    const baseline = getBuiltinModels(REAL_PROVIDER)
    // 缺 api/baseUrl，但同 id 在内置基线里 → 判据允许继承，注入集保留它
    writeTaijiCache({
      [REAL_PROVIDER]: entry([{ id: baseline[0].id, name: 'Inherits-Endpoint' }], FRESH_AT),
    })

    const pi = makePi()
    injectCatalogOverlay(asApi(pi))

    expect(modelIds(registeredConfig(pi, REAL_PROVIDER))).toContain(baseline[0].id)
    expect(loggerMocks.warn).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────
describe('R4 —— registerProvider 抛错不扩散', () => {
  it('第一个 provider 抛错 → error 日志含 pi 原文与恢复动作，后续 provider 仍注入', () => {
    writeTaijiCache({
      'broken-provider': entry([endpointModel('Broken-Model')], FRESH_AT),
      [SYNTHETIC_PROVIDER]: entry([endpointModel('Healthy-Model')], FRESH_AT),
    })

    const pi = makePi()
    pi.registerProvider.mockImplementation((provider: string) => {
      if (provider === 'broken-provider') {
        throw new Error('Provider broken-provider: "baseUrl" is required when defining custom models.')
      }
    })
    injectCatalogOverlay(asApi(pi))

    // 两个都尝试过（抛错不是「跳过后续」的理由）
    expect(pi.registerProvider).toHaveBeenCalledTimes(2)
    // 健康的那个落进了注册表
    expect(modelIds(registeredConfig(pi, SYNTHETIC_PROVIDER))).toEqual(['Healthy-Model'])
    // error 日志含 pi 原文 + 恢复动作
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.stringContaining('registerProvider failed for broken-provider'),
    )
    expect(loggerMocks.error).toHaveBeenCalledWith(expect.stringContaining('"baseUrl" is required'))
    expect(loggerMocks.error).toHaveBeenCalledWith(expect.stringContaining('restart the session to retry'))
  })
})

// ─────────────────────────────────────────────────────────
describe('refreshModels 钩子三分支（D5 运行中窗口）', () => {
  it('fresh → 钩子返回新并集（新模型无需重开会话即可见）', async () => {
    const pi = injectFresh()
    rewriteCatalogPinned(MTIME_T1)

    const refreshed = await callHook(pi, SYNTHETIC_PROVIDER)
    expect(refreshed?.map((m) => m.id)).toEqual(['Model-A', 'Model-B'])
  })

  it('R6 expired（fresh → 否定信号）→ 钩子返回纯内置基线，等价撤销注入', async () => {
    const pi = injectFresh()
    writeTaijiCache({ [SYNTHETIC_PROVIDER]: entry([endpointModel('Model-A')], NEGATIVE_SIGNAL_AT) })
    utimesSync(TAiji_CACHE_PATH(), MTIME_T1, MTIME_T1)

    const refreshed = await callHook(pi, SYNTHETIC_PROVIDER)
    // 合成 provider 的内置基线是空数组 → 撤销后可见集合为空
    expect(refreshed).toEqual([])
    expect(loggerMocks.debug).toHaveBeenCalledWith(
      expect.stringContaining(`catalog overlay revoked for ${SYNTHETIC_PROVIDER}: state=expired`),
    )
  })

  it('R6 撤销后仍有内置基线可保（真实 provider：返回的是基线而非空集）', async () => {
    const baseline = getBuiltinModels(REAL_PROVIDER)
    writeTaijiCache({ [REAL_PROVIDER]: entry([endpointModel('Overlay-Only')], FRESH_AT) })
    utimesSync(TAiji_CACHE_PATH(), MTIME_T0, MTIME_T0)
    const pi = makePi()
    injectCatalogOverlay(asApi(pi))
    expect(modelIds(registeredConfig(pi, REAL_PROVIDER))).toContain('Overlay-Only')

    writeTaijiCache({ [REAL_PROVIDER]: entry([endpointModel('Overlay-Only')], NEGATIVE_SIGNAL_AT) })
    utimesSync(TAiji_CACHE_PATH(), MTIME_T1, MTIME_T1)

    const refreshed = await callHook(pi, REAL_PROVIDER)
    expect(refreshed?.map((m) => m.id)).toEqual(baseline.map((m) => m.id))
  })

  it('R7 钩子运行期缓存损坏 → warn + 返回 undefined（pi 语义 = 保留当前注入）', async () => {
    const pi = injectFresh()
    writeFileSync(TAiji_CACHE_PATH(), '{ truncated')
    utimesSync(TAiji_CACHE_PATH(), MTIME_T1, MTIME_T1)

    expect(await callHook(pi, SYNTHETIC_PROVIDER)).toBeUndefined()
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('catalog cache unreadable during refresh'),
    )
  })

  it('R7 钩子运行期读失败（非 ENOENT：缓存路径被目录占位 = EISDIR）→ 同样返回 undefined', async () => {
    const pi = injectFresh()
    // 目录位让 readFileSync 抛 EISDIR（非 ENOENT）——与 model-sync.test.ts 的同款手法
    rmSync(TAiji_CACHE_PATH())
    mkdirSync(TAiji_CACHE_PATH())

    expect(await callHook(pi, SYNTHETIC_PROVIDER)).toBeUndefined()
    expect(loggerMocks.warn).toHaveBeenCalledWith(expect.stringContaining('unreadable'))
  })
})

// ─────────────────────────────────────────────────────────
describe('mtime 短路（D5：文件未变直接返回上次结果，不重算）', () => {
  it('内容变了但 mtime 不变 → 钩子返回旧结果（证明没重读）；mtime 一变 → 立刻重算', async () => {
    const pi = injectFresh()

    // 内容换成 Model-B，但把 mtime 钉回原值——短路成立则钩子看不到这次改写
    writeTaijiCache({ [SYNTHETIC_PROVIDER]: entry([endpointModel('Model-B')], FRESH_AT) })
    utimesSync(TAiji_CACHE_PATH(), MTIME_T0, MTIME_T0)
    expect((await callHook(pi, SYNTHETIC_PROVIDER))?.map((m) => m.id)).toEqual(['Model-A'])

    // mtime 真的变了 → 重算，新内容生效
    utimesSync(TAiji_CACHE_PATH(), MTIME_T1, MTIME_T1)
    expect((await callHook(pi, SYNTHETIC_PROVIDER))?.map((m) => m.id)).toEqual(['Model-B'])
  })

  it('两份缓存分别控 mtime：只改 store 的那一份也能突破短路', async () => {
    // store 的条目更晚 → 新者胜取它（同 provider 的两份条目二选一，不是模型级并集）
    writeTaijiCache({ [SYNTHETIC_PROVIDER]: entry([endpointModel('Model-A')], FRESH_AT) })
    writePiStore({ [SYNTHETIC_PROVIDER]: entry([endpointModel('Model-A')], FRESH_AT + 1_000) })
    utimesSync(TAiji_CACHE_PATH(), MTIME_T0, MTIME_T0)
    utimesSync(PI_STORE_PATH(), MTIME_T0, MTIME_T0)
    const pi = makePi()
    injectCatalogOverlay(asApi(pi))
    expect(modelIds(registeredConfig(pi, SYNTHETIC_PROVIDER))).toEqual(['Model-A'])

    // 只改 store 内容 + mtime；taiji 那份原样不动——短路必须被 store 的 mtime 突破
    writePiStore({
      [SYNTHETIC_PROVIDER]: entry([endpointModel('Model-A'), endpointModel('Model-From-Store')], FRESH_AT + 2_000),
    })
    utimesSync(PI_STORE_PATH(), MTIME_T1, MTIME_T1)

    expect((await callHook(pi, SYNTHETIC_PROVIDER))?.map((m) => m.id)).toEqual([
      'Model-A',
      'Model-From-Store',
    ])
  })
})

// ─────────────────────────────────────────────────────────
describe('第三个监视条目（tick 挂载用的 mtime 观测器）', () => {
  it('首拍建基线报「变化」（由 tick 的 firstBaseline 抑制刷新）；同 mtime 再观测 → false', () => {
    const path = TAiji_CACHE_PATH()
    writeFileSync(path, '{}')
    utimesSync(path, MTIME_T0, MTIME_T0)
    const watcher = createOverlayCacheWatcher(path)

    expect(watcher.observe()).toBe(true)
    expect(watcher.observe()).toBe(false)
  })

  it('工厂期播种基线 + 窗口内 mtime 变更 → observe() 返回 true（运行中窗口 D5 的检出）', () => {
    // 经 injectCatalogOverlay 取观测器——工厂期在 runPass 之前捕获的 mtime 即初始基线
    // （生产接线；直接调 createOverlayCacheWatcher(path, initial) 测不到这层传递）。
    const watcher = injectWatcherPinned(MTIME_T0)

    // 工厂期注入与 tick 1 之间（~2s 窗）缓存被更新（taiji runtime 的 tmp+rename 原子替换写）
    rewriteCatalogPinned(MTIME_T1)
    expect(watcher?.observe()).toBe(true)
  })

  it('工厂期播种基线 + 无变更 → observe() 返回 false（首拍不产生幻觉变化）', () => {
    const watcher = injectWatcherPinned(MTIME_T0)
    expect(watcher?.observe()).toBe(false)
  })

  it('mtime 变化 → true（taiji runtime 原子替换写后的检出）', () => {
    const path = TAiji_CACHE_PATH()
    writeFileSync(path, '{}')
    utimesSync(path, MTIME_T0, MTIME_T0)
    const watcher = createOverlayCacheWatcher(path)
    watcher.observe()

    writeFileSync(path, '{"version":1,"entries":{}}')
    utimesSync(path, MTIME_T1, MTIME_T1)
    expect(watcher.observe()).toBe(true)
    expect(watcher.observe()).toBe(false)
  })

  it('不存在 → 存在 → true（首次物化）；持续不存在 → false（非变化信号）', () => {
    const path = TAiji_CACHE_PATH()
    const watcher = createOverlayCacheWatcher(path)

    expect(watcher.observe()).toBe(true) // 首拍 absent 建基线
    expect(watcher.observe()).toBe(false) // 持续 absent = 非变化信号
    writeFileSync(path, '{}')
    utimesSync(path, MTIME_T0, MTIME_T0)
    expect(watcher.observe()).toBe(true) // absent → present
  })

  it('存在 → 缺失 → true（撤销注入也要有触发点）', () => {
    const path = TAiji_CACHE_PATH()
    writeFileSync(path, '{}')
    utimesSync(path, MTIME_T0, MTIME_T0)
    const watcher = createOverlayCacheWatcher(path)
    watcher.observe()

    rmSync(path)
    expect(watcher.observe()).toBe(true)
    expect(watcher.observe()).toBe(false)
  })

  it('unreadable（父路径是文件 = ENOTDIR）→ 本拍不比较、不推进基线', () => {
    // statSync 对目录是成功的（只有 readFileSync 才 EISDIR），故 unreadable 分支要用
    // 「父路径不是目录」触发 ENOTDIR——确定性、不依赖权限位（root 无视 chmod）。
    const blocker = join(dataDir, 'not-a-dir')
    writeFileSync(blocker, 'x')
    const path = join(blocker, 'cache.json')
    const watcher = createOverlayCacheWatcher(path)

    expect(watcher.observe()).toBe(false)
    // 基线未被推进：父路径变成真目录、文件可读后首拍仍报「变化」
    rmSync(blocker)
    mkdirSync(blocker)
    writeFileSync(path, '{}')
    utimesSync(path, MTIME_T0, MTIME_T0)
    expect(watcher.observe()).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────
/**
 * tick 接线层：第三个监视条目挂进既有 tick 后，「缓存 mtime 变化 → 一次零网络本地
 * 刷新」这条链真的通（设计 D5 运行中窗口 / 验收场景 V6 的单测形态）。
 *
 * 上面那些用例分别证明了钩子与观测器各自正确，但**两者的接线**（index.ts 的 tick 把
 * 观测结果并进刷新决策）只有这一层能覆盖——真机 V6 依赖的正是它。
 *
 * 驱动件与 model-sync.test.ts 的 tick 层共用 `./tick-harness.ts`（fake timers 只替换
 * setTimeout/clearTimeout，tick 链上的 readFile 与 setImmediate 保持真实；拍屏障
 * 说明见该文件头注释）。models.json/auth.json 全程缺席（catalog-only 安装常态），
 * 于是唯一的刷新信号来自目录缓存——隔离得干净。
 */
describe('tick 接线 —— 目录缓存 mtime 变化触发一次零网络本地刷新', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** 「恰一次零网络本地刷新」断言（tick 接线用例共用）。 */
  function expectRefreshedOnce(refresh: ReturnType<typeof vi.fn>): void {
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith({ allowNetwork: false })
  }

  /** 经 harness 启动扩展（pi 宿主面 = appendEntry + registerProvider spy）。 */
  function startWithFakeCtx(): { refresh: ReturnType<typeof vi.fn>; registerProvider: ReturnType<typeof vi.fn> } {
    const registerProvider = vi.fn<(provider: string, config: ProviderConfig) => void>()
    const { refresh } = startWithRegistryCtx({ appendEntry: vi.fn(), registerProvider })
    return { refresh, registerProvider }
  }

  it('首拍只建基线不刷新；缓存 mtime 变化 → refresh({ allowNetwork: false }) 恰一次', async () => {
    seedCatalogPinned(MTIME_T0)
    const { refresh, registerProvider } = startWithFakeCtx()
    // 工厂期已注入（D1）——tick 只是触发方，不是注册方
    expect(registerProvider).toHaveBeenCalledTimes(1)

    await tickOnce() // 首拍：models.json/auth.json 双 absent + 缓存首观测 → 只建基线
    expect(refresh).not.toHaveBeenCalled()

    // 上游目录更新（taiji runtime 的 tmp+rename 原子替换写）→ mtime 变
    rewriteCatalogPinned(MTIME_T1)
    await tickOnce()
    expectRefreshedOnce(refresh)
  })

  it('运行中窗口不断裂：工厂期注入后、首个 tick 触发前改缓存 → 首个 tick 必须 refresh（firstBaseline 不放行 overlay 变化）', async () => {
    seedCatalogPinned(MTIME_T0)
    const { refresh, registerProvider } = startWithFakeCtx()
    // 工厂期已注入（D1）——tick 只是触发方，不是注册方
    expect(registerProvider).toHaveBeenCalledTimes(1)

    // 「工厂期注入 → tick 1」约 2s 窗内的缓存变更（真机实证：spawn 后 ~200ms 变更时
    // 30s 内新模型不出现）——首拍抑制的前提（pi spawn 时已按磁盘建快照）只对既有
    // models.json/auth.json 成立，overlay 条目的变化必须放行，否则运行中窗口断裂。
    rewriteCatalogPinned(MTIME_T1)

    await tickOnce() // 首个 tick：既有两条目双 absent 无变化，唯一信号 = overlay 变化
    expectRefreshedOnce(refresh)
  })

  it('对照不变量：缓存内容变了但 mtime 不变 → 零刷新（mtime 是这一条目的比较基准）', async () => {
    seedCatalogPinned(MTIME_T0)
    const { refresh } = startWithFakeCtx()
    await tickOnce()
    expect(refresh).not.toHaveBeenCalled()

    // 改写内容但把 mtime 钉回原值——该条目判「未变」
    rewriteCatalogPinned(MTIME_T0)
    await tickOnce()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('R1：env 无数据目录 → 工厂期零注册，tick 也不因目录缓存刷新', async () => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    const { refresh, registerProvider } = startWithFakeCtx()
    expect(registerProvider).not.toHaveBeenCalled()

    await tickOnce()
    await tickOnce()
    expect(refresh).not.toHaveBeenCalled()
  })
})
