import builtinData from '../../generated/builtin-providers.json';
import { logger } from '../../infra/logger.js';
import { ModelConnectionTester } from '../../infra/model-connection-tester.js';
import { RpcClient, type AvailableModelSnapshot, type PiMessage } from '../../infra/pi/rpc-client.js';
import type { ISessionService, IConfigService, IMessageBroker } from '../../interfaces.js';
import { attachSupportedLevels, computeSupportedLevels, detectCapabilityDrift, runCapabilityReconcile } from '../model-capability.js';
import { ModelService, PROVIDER_CONNECTION_TEST_ERRORS, planConnectionTests } from '../model-service.js';
import type { IModelSource } from '../ports/model.js';
import { isCatalogProvider, getMergedCatalogModels } from '../provider-catalog.js';
import type { ProviderExtras } from '../provider-extras-store.js';
import { autoEnableQuotaDisplayOnCreate, matchAutoEnablePreset } from '../quota-auto-enable.js';
import { DEFAULT_WOOL_MANIFEST_URL, VERSION_PAIR_MISMATCH, WoolExtensionInstallError, WoolExtensionInstaller, type WoolAssetManifest, type WoolExtensionInstallerDeps } from '../wool-extension-installer.js';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { type ProviderInfo, type ProviderId, QUOTA_PRESETS, type QuotaPreset } from '@taiji/shared';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/__tests__/model-capability.test.ts
// ======================================================================

/** pi 权威直调（与 scripts/diff-probe-thinking.mjs 同款最小形状；入参形状经函数签名派生，不引入 Pi 命名类型）。 */
function piDirect(m: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> | null }): string[] {
  return getSupportedThinkingLevels(m as unknown as Parameters<typeof getSupportedThinkingLevels>[0])
}


/**
 * builtin fixture 快照：JSON import 的推断类型（各对象字面量形状的联合，含 off?: undefined 变体）
 * 经 unknown 收窄到消费形状——同 provider-config-helper 的 `as unknown as BuiltinProviderTemplate` 范式。
 */
const builtinSnapshot = builtinData.providers as unknown as Array<{
  id: string
  models?: Array<{ id: string; reasoning: boolean; thinkingLevelMap?: Record<string, string | null> | null }>
}>


type ConfigModel = ProviderInfo['models'][number]


function model(id: string, extra: Partial<ConfigModel> = {}): ConfigModel {
  return { id, ...extra }
}


function provider(id: string, models: ConfigModel[], extra: Partial<ProviderInfo> = {}): ProviderInfo {
  // id 经参数进入 = 反序列化边界，as ProviderId 提升同 provider-config-helper 范式
  return { id: id as ProviderId, name: id, apiKeySet: true, status: 'connected', models, ...extra }
}


function piModel(id: string, providerId: string, reasoning?: boolean): AvailableModelSnapshot {
  return { id, provider: providerId, reasoning }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('model-capability', () => {
describe('离线计算（pi-ai 同源）', () => {
  it('reasoning 缺失 / false → ["off"]（pi 两级门控第一关），与 pi 直调逐字节一致', () => {
    const map = { off: null, high: 'high', max: 'max' } as Record<string, string | null>
    for (const reasoning of [undefined, false]) {
      const input = { reasoning, thinkingLevelMap: map }
      expect(computeSupportedLevels(input)).toEqual(['off'])
      expect(computeSupportedLevels(input)).toEqual(piDirect(input))
    }
  })

  it('正常模型：与 pi-ai getSupportedThinkingLevels 同源值一致（builtin fixture 全量直调比对）', () => {
    let total = 0
    for (const p of builtinSnapshot) {
      for (const m of p.models ?? []) {
        total++
        const input = {
          reasoning: m.reasoning,
          thinkingLevelMap: m.thinkingLevelMap === null ? undefined : m.thinkingLevelMap,
        }
        expect(computeSupportedLevels(input), `${p.id}/${m.id}`).toEqual(piDirect(input))
      }
    }
    expect(total).toBeGreaterThan(1000) // fixture 覆盖范围不缩水（当前 1220）
  })

  it('档位过滤语义锚点：off=null 剔除、xhigh/max 仅显式映射才含、未映射档默认含', () => {
    expect(computeSupportedLevels({ reasoning: true, thinkingLevelMap: { off: null, high: 'high', max: 'max' } }))
      .toEqual(['minimal', 'low', 'medium', 'high', 'max'])
    expect(computeSupportedLevels({ reasoning: true, thinkingLevelMap: undefined }))
      .toEqual(['off', 'minimal', 'low', 'medium', 'high'])
    expect(computeSupportedLevels({ reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } }))
      .toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
  })
})
describe('attachSupportedLevels 下发标注', () => {
  it('逐模型标注 supportedLevels；reasoning 缺失 → ["off"]（事故 B 形态：UI 不再可选高档）', () => {
    const providers = [provider('p1', [
      model('hand-added-no-reasoning', { thinkingLevelMap: { off: 'off', high: 'high', max: 'max' } }),
      model('reasoning-true', { reasoning: true, thinkingLevelMap: { high: 'high', max: 'max' } }),
    ])]
    const decorated = attachSupportedLevels(providers)
    expect(decorated[0].models.map(m => m.supportedLevels))
      .toEqual([['off'], ['off', 'minimal', 'low', 'medium', 'high', 'max']])
  })

  it('builtin fixture 模型标注值与 pi 直调一致', () => {
    const p = builtinSnapshot[0]
    const source = (p.models ?? []).slice(0, 5)
    const decorated = attachSupportedLevels([provider(p.id, source.map(m => ({
      id: m.id,
      reasoning: m.reasoning,
      thinkingLevelMap: m.thinkingLevelMap === null ? undefined : m.thinkingLevelMap,
    })))])
    for (let i = 0; i < source.length; i++) {
      expect(decorated[0].models[i].supportedLevels, `${p.id}/${source[i].id}`).toEqual(piDirect({
        reasoning: source[i].reasoning,
        thinkingLevelMap: source[i].thinkingLevelMap === null ? undefined : source[i].thinkingLevelMap,
      }))
    }
  })

  it('不改入参：返回新引用，原 ProviderInfo.models 元素无 supportedLevels', () => {
    const m0 = model('m1')
    const providers = [provider('p', [m0])]
    const decorated = attachSupportedLevels(providers)
    expect(decorated).not.toBe(providers)
    expect(decorated[0].models[0]).not.toBe(m0)
    expect(m0.supportedLevels).toBeUndefined()
  })
})
describe('对账 drift 检测（纯比对）', () => {
  it('配置有而 pi 无 → config_only', () => {
    const drifts = detectCapabilityDrift(
      [provider('zai-coding-cn', [model('glm-5.3')])],
      [piModel('glm-5.2', 'zai-coding-cn', true)],
    )
    expect(drifts).toEqual([{ kind: 'config_only', providerId: 'zai-coding-cn', modelId: 'glm-5.3' }])
  })

  it('reasoning 不一致 → reasoning_mismatch（含 config undefined vs pi true 的归一比较）', () => {
    const drifts = detectCapabilityDrift(
      [provider('p', [model('m1', { reasoning: true }), model('m2')])],
      [piModel('m1', 'p', false), piModel('m2', 'p', true)],
    )
    expect(drifts).toEqual([
      { kind: 'reasoning_mismatch', providerId: 'p', modelId: 'm1', configReasoning: true, piReasoning: false },
      { kind: 'reasoning_mismatch', providerId: 'p', modelId: 'm2', configReasoning: undefined, piReasoning: true },
    ])
  })

  it('大小写孪生 → case_twin（pi 侧仅大小写不同的 id，事故 A 形态）', () => {
    const drifts = detectCapabilityDrift(
      [provider('p', [model('GLM-5.3')])],
      [piModel('glm-5.3', 'p', true)],
    )
    expect(drifts).toEqual([{ kind: 'case_twin', providerId: 'p', modelId: 'GLM-5.3', piModelId: 'glm-5.3' }])
  })

  it('disabled provider 不参与比对（pi 白名单本就不加载，比对只造噪音）；一致清单零 drift', () => {
    const drifts = detectCapabilityDrift(
      [
        provider('disabled-p', [model('gone')], { enabled: false }),
        provider('p', [model('m1', { reasoning: true })]),
      ],
      [piModel('m1', 'p', true)],
    )
    expect(drifts).toEqual([])
  })
})
describe('对账编排（日志 + 事件上报路径）', () => {
  it('drift 非空：logger.warn 记录 + onDrift 事件上报 + 返回 drift 项', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const onDrift = vi.fn()
    const drifts = await runCapabilityReconcile({
      sessionId: 's1',
      getEngine: () => ({ getAvailableModels: async () => [piModel('glm-5.2', 'p', true)] }),
      getConfigProviders: () => [provider('p', [model('GLM-5.2', { reasoning: false }), model('missing')])],
      onDrift,
    })
    expect(drifts.map(d => d.kind)).toEqual(['case_twin', 'config_only'])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('漂移')
    expect(warnSpy.mock.calls[0][1]).toMatchObject({ sessionId: 's1', drifts })
    expect(onDrift).toHaveBeenCalledTimes(1)
    expect(onDrift).toHaveBeenCalledWith(drifts)
    warnSpy.mockRestore()
  })

  it('对账通过：logger.info 且不上报', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const onDrift = vi.fn()
    const drifts = await runCapabilityReconcile({
      sessionId: 's2',
      getEngine: () => ({ getAvailableModels: async () => [piModel('m1', 'p', true)] }),
      getConfigProviders: () => [provider('p', [model('m1', { reasoning: true })])],
      onDrift,
    })
    expect(drifts).toEqual([])
    expect(onDrift).not.toHaveBeenCalled()
    expect(infoSpy).toHaveBeenCalledTimes(1)
    infoSpy.mockRestore()
  })

  it('引擎不可用或不支持 getAvailableModels → 跳过（info 日志，零 drift，不崩）', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const drifts = await runCapabilityReconcile({
      sessionId: 's3',
      getEngine: () => ({}),
      getConfigProviders: () => [],
    })
    expect(drifts).toEqual([])
    expect(infoSpy).toHaveBeenCalledTimes(1)
    infoSpy.mockRestore()
  })

  it('RPC 异常 → 降级 warn + 返回 []（不反噬 session 附着主链路）', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const drifts = await runCapabilityReconcile({
      sessionId: 's4',
      getEngine: () => ({
        getAvailableModels: async () => {
          throw new Error('pi half-dead')
        },
      }),
      getConfigProviders: () => [],
    })
    expect(drifts).toEqual([])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][1]).toMatchObject({ sessionId: 's4', error: 'pi half-dead' })
    warnSpy.mockRestore()
  })
})
describe('ModelService 服务侧挂载', () => {
  function makeService(engine: unknown, providers: ProviderInfo[]): ModelService {
    const svc = new ModelService({ discoverFromApi: vi.fn() } as unknown as IModelSource)
    svc.setServices(
      { getRpcClient: () => engine } as unknown as ISessionService,
      { listProviders: () => providers } as unknown as IConfigService,
      { broadcast: vi.fn(), send: vi.fn(), sendError: vi.fn() } as unknown as IMessageBroker,
    )
    return svc
  }

  it('reconcileModelCapabilities：经 sessionService.getRpcClient 取引擎，drift 走 sink 事件上报', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const svc = makeService(
      { getAvailableModels: async () => [piModel('glm-5.3', 'p', true)] },
      [provider('p', [model('GLM-5.3')])],
    )
    const sink = vi.fn()
    svc.setCapabilityDriftSink(sink)
    const drifts = await svc.reconcileModelCapabilities('sess-1')
    expect(drifts.map(d => d.kind)).toEqual(['case_twin'])
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith(drifts)
    warnSpy.mockRestore()
  })

  it('attachSupportedLevels 透传能力侧：下发模型信息含 supportedLevels 字段', () => {
    const svc = makeService(undefined, [])
    const decorated = svc.attachSupportedLevels([provider('p', [model('m')])])
    expect(decorated[0].models[0].supportedLevels).toEqual(['off'])
  })
})
describe('RpcClient.getAvailableModels 封装', () => {
  it('发 get_available_models 命令并解包 data.models', async () => {
    const client = new RpcClient()
    const models = [piModel('m1', 'p', true)]
    const spy = vi.spyOn(client, 'sendCommand')
      .mockResolvedValue({ type: 'response', data: { models } } as PiMessage)
    await expect(client.getAvailableModels()).resolves.toEqual(models)
    expect(spy).toHaveBeenCalledWith('get_available_models', {})
  })

  it('malformed 响应（无 models 数组）→ 抛错（由对账层降级捕获，不误判全量漂移）', async () => {
    const client = new RpcClient()
    vi.spyOn(client, 'sendCommand').mockResolvedValue({ type: 'response', data: {} } as PiMessage)
    await expect(client.getAvailableModels()).rejects.toThrow('malformed')
  })
})
});

// ======================================================================
// ← src/services/__tests__/model-service-connection-test.test.ts
// ======================================================================

/** 只实现 supports 的测试替身（plan 阶段不发请求）。 */
function stubTester(supported: string[] = ['anthropic-messages', 'openai-completions', 'openai-responses']) {
  return {
    supports: (api: string) => supported.includes(api),
    test: vi.fn().mockResolvedValue({ api: '', modelId: '', ok: true }),
  }
}


function makeProvider(id: string, models: ProviderInfo['models'], extra: Partial<ProviderInfo> = {}): ProviderInfo {
  // ProviderId 是品牌类型（编译期擦除），测试构造点经索引访问提升（反序列化边界同款做法）
  const base: ProviderInfo = { id: id as ProviderInfo['id'], name: id, apiKeySet: true, status: 'connected', models }
  return Object.assign(base, extra)
}


/** 计划里唯一的发包目标（断言便捷；无目标即失败，让断言错误指向根因）。 */
function onlyTarget(entries: ReturnType<typeof planConnectionTests>) {
  const targets = entries.flatMap(e => ('target' in e && e.target ? [e.target] : []))
  expect(targets).toHaveLength(1)
  return targets[0]
}


/** 计划里唯一的已定论错误行。 */
function onlySettled(entries: ReturnType<typeof planConnectionTests>) {
  const rows = entries.flatMap(e => ('settled' in e && e.settled ? [e.settled] : []))
  expect(rows).toHaveLength(1)
  return rows[0]
}


/** 装配 ModelService（configService 只需 listProviders / getProvider）。 */
function makeService(configService: { listProviders: () => ProviderInfo[]; getProvider: (id: string) => { baseUrl?: string } | undefined }) {
  const service = new ModelService({ discoverFromApi: vi.fn() } as never)
  service.setServices({} as never, configService as never, {} as never)
  return service
}


/** 凭据 miss 断言共用装配：带 openai-completions 模型 m1 的 custom-1（原始 provider 定义缺省）。 */
function makeServiceWithM1() {
  return makeService({
    listProviders: () => [makeProvider('custom-1', [{ id: 'm1', api: 'openai-completions', baseUrl: 'https://api.example' }])],
    getProvider: () => undefined,
  })
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('model-service-connection-test', () => {
describe('planConnectionTests：代表模型双过滤', () => {
  const tester = stubTester()

  it('组内第一个模型 enabled=false → 跳过，选下一个启用的模型', () => {
    const provider = makeProvider('custom-1', [
      { id: 'm-disabled', api: 'openai-completions', baseUrl: 'https://api.example', enabled: false },
      { id: 'm-enabled', api: 'openai-completions', baseUrl: 'https://api.example' },
    ])
    const target = onlyTarget(planConnectionTests('custom-1', provider, undefined, tester))
    expect(target.modelId).toBe('m-enabled')
    expect(target.baseUrl).toBe('https://api.example')
  })

  it('组内第一个模型 baseUrl 为空（且无 provider 级回落）→ 跳过，选下一个有 baseUrl 的模型', () => {
    const provider = makeProvider('custom-1', [
      { id: 'm-no-baseurl', api: 'openai-completions' },
      { id: 'm-with-baseurl', api: 'openai-completions', baseUrl: 'https://api.example' },
    ])
    const target = onlyTarget(planConnectionTests('custom-1', provider, undefined, tester))
    expect(target.modelId).toBe('m-with-baseurl')
  })

  it('该协议组全部模型被禁用 → no_enabled_model（不发包）', () => {
    const provider = makeProvider('custom-1', [
      { id: 'm1', api: 'openai-completions', baseUrl: 'https://api.example', enabled: false },
      { id: 'm2', api: 'openai-completions', baseUrl: 'https://api.example', enabled: false },
    ])
    const entries = planConnectionTests('custom-1', provider, undefined, tester)
    expect(onlySettled(entries).error).toBe('no_enabled_model')
    expect(entries.some(e => 'target' in e)).toBe(false)
    expect(tester.test).not.toHaveBeenCalled()
  })

  it('协议不在支持集 → unsupported（优先于 baseUrl 判定）', () => {
    const provider = makeProvider('custom-1', [{ id: 'm1', api: 'google-generative-ai' }])
    const entries = planConnectionTests('custom-1', provider, undefined, tester)
    expect(onlySettled(entries)).toMatchObject({ api: 'google-generative-ai', error: 'unsupported' })
    expect(entries.some(e => 'target' in e)).toBe(false)
  })

  it('按协议分组：多协议各取各的代表（组序 = 模型首现序）', () => {
    const provider = makeProvider('opencode-go', [
      { id: 'a1', api: 'anthropic-messages', baseUrl: 'https://api.example/anthropic' },
      { id: 'o1', api: 'openai-completions', baseUrl: 'https://api.example/v1' },
      { id: 'a2', api: 'anthropic-messages', baseUrl: 'https://api.example/anthropic' },
    ])
    const entries = planConnectionTests('opencode-go', provider, undefined, tester)
    expect(entries).toHaveLength(2)
    const targets = entries.flatMap(e => ('target' in e && e.target ? [e.target] : []))
    expect(targets.map(t => `${t.api}/${t.modelId}`)).toEqual([
      'anthropic-messages/a1',
      'openai-completions/o1',
    ])
  })

  it('模型级 api 缺省 → 回落 provider 级 api 分组（pi modelFromJson `definition.api ?? providerConfig.api`）', () => {
    const provider = makeProvider(
      'custom-1',
      [
        { id: 'm1', baseUrl: 'https://api.example' },
        { id: 'm2', baseUrl: 'https://api.example' },
      ],
      { api: 'openai-completions' },
    )
    const entries = planConnectionTests('custom-1', provider, undefined, tester)
    const targets = entries.flatMap(e => ('target' in e && e.target ? [e.target] : []))
    expect(targets.map(t => `${t.api}/${t.modelId}`)).toEqual(['openai-completions/m1'])
  })
})
describe('planConnectionTests：baseUrl 四级回落链', () => {
  const tester = stubTester()
  const models: ProviderInfo['models'] = [{ id: 'm1', api: 'openai-completions', baseUrl: 'https://model.example/v1' }]

  it('第 1 级：custom 模型级 baseUrl', () => {
    const provider = makeProvider('custom-1', models)
    const target = onlyTarget(planConnectionTests('custom-1', provider, undefined, tester))
    expect(target.baseUrl).toBe('https://model.example/v1')
  })

  it('第 2 级：custom provider 级 baseUrl（模型级缺省时回落，pi `definition.baseUrl ?? providerConfig.baseUrl`）', () => {
    const provider = makeProvider('custom-1', [{ id: 'm1', api: 'openai-completions' }])
    const target = onlyTarget(planConnectionTests('custom-1', provider, 'https://provider.example', tester))
    expect(target.baseUrl).toBe('https://provider.example')
  })

  it('custom 模型级优先于 provider 级', () => {
    const provider = makeProvider('custom-1', models)
    const target = onlyTarget(planConnectionTests('custom-1', provider, 'https://provider.example', tester))
    expect(target.baseUrl).toBe('https://model.example/v1')
  })

  it('第 3 级：catalog 网关 override（覆盖生效语义，优先于模型级——pi applyModelsJson `config.baseUrl ?? model.baseUrl`）', () => {
    // 'anthropic' 在快照内（isCatalogProvider=true）；m1 自带模型级 baseUrl，网关 override 必须赢
    const provider = makeProvider('anthropic', [{ id: 'claude-fable-5', api: 'anthropic-messages', baseUrl: 'https://model.example' }])
    const target = onlyTarget(planConnectionTests('anthropic', provider, 'https://gw.corp.example/anthropic', tester))
    expect(target.baseUrl).toBe('https://gw.corp.example/anthropic')
  })

  it('第 4 级：全缺 → no_base_url（如实归类，不冒充网络错误；不发包）', () => {
    const provider = makeProvider('custom-1', [{ id: 'm1', api: 'openai-completions' }])
    const entries = planConnectionTests('custom-1', provider, undefined, tester)
    expect(onlySettled(entries)).toMatchObject({ api: 'openai-completions', error: 'no_base_url' })
    expect(entries.some(e => 'target' in e)).toBe(false)
  })

  it('空白串视同缺省（trim 后空串不当作 baseUrl）', () => {
    const provider = makeProvider('custom-1', [{ id: 'm1', api: 'openai-completions', baseUrl: '   ' }])
    const entries = planConnectionTests('custom-1', provider, '', tester)
    expect(onlySettled(entries).error).toBe('no_base_url')
  })
})
describe('ModelConnectionTester：3 协议最小请求（本地 stub server）', () => {
  let server: Server | undefined
  let captured: Array<{ url: string; headers: Record<string, string | string[] | undefined>; body: string }> = []

  /** 启动 stub：记录请求并回固定响应（默认 200）。 */
  async function startStub(status = 200, responseBody = '{}'): Promise<string> {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        captured.push({ url: req.url ?? '', headers: req.headers, body: raw })
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(responseBody)
      })
    })
    await new Promise<void>(resolve => { server!.listen(0, '127.0.0.1', resolve) })
    const { port } = server.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  afterEach(async () => {
    captured = []
    vi.unstubAllGlobals()
    if (server) {
      await new Promise<void>(resolve => { server!.close(() => resolve()) })
      server = undefined
    }
  })

  it('anthropic-messages → POST {baseUrl}/v1/messages，x-api-key + anthropic-version + max_tokens:1', async () => {
    const baseUrl = await startStub()
    const result = await new ModelConnectionTester().test({ api: 'anthropic-messages', modelId: 'k3', baseUrl, apiKey: 'sk-a' })
    expect(result.api).toBe('anthropic-messages')
    expect(result.modelId).toBe('k3')
    expect(result.ok).toBe(true)
    expect(result.durationMs).toBeTypeOf('number')
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('/v1/messages')
    expect(captured[0].headers['x-api-key']).toBe('sk-a')
    expect(captured[0].headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(captured[0].body) as Record<string, unknown>
    expect(body.model).toBe('k3')
    expect(body.max_tokens).toBe(1)
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }])
  })

  it('openai-completions → POST {baseUrl}/chat/completions，Bearer + max_tokens:1', async () => {
    const baseUrl = await startStub()
    const result = await new ModelConnectionTester().test({ api: 'openai-completions', modelId: 'deepseek-chat', baseUrl: `${baseUrl}/v1`, apiKey: 'sk-b' })
    expect(result.ok).toBe(true)
    expect(captured[0].url).toBe('/v1/chat/completions')
    expect(captured[0].headers.authorization).toBe('Bearer sk-b')
    const body = JSON.parse(captured[0].body) as Record<string, unknown>
    expect(body.model).toBe('deepseek-chat')
    expect(body.max_tokens).toBe(1)
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }])
  })

  it('openai-responses → POST {baseUrl}/responses，Bearer + max_output_tokens:16（协议下限，P-test-req）', async () => {
    const baseUrl = await startStub()
    const result = await new ModelConnectionTester().test({ api: 'openai-responses', modelId: 'gpt-5.6-luna', baseUrl: `${baseUrl}/v1`, apiKey: 'sk-c' })
    expect(result.ok).toBe(true)
    expect(captured[0].url).toBe('/v1/responses')
    expect(captured[0].headers.authorization).toBe('Bearer sk-c')
    const body = JSON.parse(captured[0].body) as Record<string, unknown>
    expect(body.model).toBe('gpt-5.6-luna')
    // 16 = OpenAI Responses 硬下限（pi-ai api/openai-responses.js:16-17）；用 1 会被 400 拒绝
    expect(body.max_output_tokens).toBe(16)
    expect(body.input).toBe('ping')
  })

  it('baseUrl 末尾斜杠不产生双斜杠（归一化）', async () => {
    const baseUrl = await startStub()
    await new ModelConnectionTester().test({ api: 'openai-completions', modelId: 'm', baseUrl: `${baseUrl}/v1///`, apiKey: 'k' })
    expect(captured[0].url).toBe('/v1/chat/completions')
  })

  it('非 2xx → http_error|<status>|<响应体截断>（如实带回状态码与真实原因）', async () => {
    const baseUrl = await startStub(401, JSON.stringify({ error: { message: 'The API Key appears to be invalid' } }))
    const result = await new ModelConnectionTester().test({ api: 'anthropic-messages', modelId: 'k3', baseUrl, apiKey: 'bad' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/^http_error\|401\|/)
    expect(result.error).toContain('The API Key appears to be invalid')
  })

  it('不可达端点 → network_error|<message>（不冒充 HTTP 错误）', async () => {
    const result = await new ModelConnectionTester().test({ api: 'openai-completions', modelId: 'm', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/^network_error\|/)
  })

  it('未知协议 → unsupported（防御：调用方未按 supports 过滤时也不发包）', async () => {
    const result = await new ModelConnectionTester().test({ api: 'google-generative-ai', modelId: 'm', baseUrl: 'http://127.0.0.1:1' })
    expect(result).toEqual({ api: 'google-generative-ai', modelId: 'm', ok: false, error: 'unsupported' })
  })

  // ── x-opencode-session / x-opencode-client 注入（2026-10-21，与 pi 真实聊天请求同源）──
  // 判定口径与 pi getSessionHeaders 同源（@earendil-works/pi-coding-agent@1.0.0
  // provider-attribution.js:50-59）：provider id ∈ {opencode, opencode-go} 或 hostname
  // 严格 = opencode.ai，双分支。fetch 经 vi.stubGlobal 拦截（不真发外网），断言
  // init.headers 的注入行为。

  /** fetch stub：捕获 (url, init) 后回 200 空体，不产生真实网络请求。 */
  function stubFetch(): Array<{ url: string; headers: Record<string, string> }> {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(_url), headers: init?.headers ?? {} })
      return new Response('{}', { status: 200 })
    }))
    return calls
  }

  it('opencode 端点（hostname=opencode.ai）→ 注入一次性 x-opencode-session（test- 前缀，两次调用值不同）+ x-opencode-client=pi', async () => {
    const calls = stubFetch()
    const tester = new ModelConnectionTester()
    const req = { api: 'openai-completions' as const, modelId: 'deepseek-v4-flash', apiKey: 'k' }
    await tester.test({ ...req, baseUrl: 'https://opencode.ai/zen/go/v1' })
    await tester.test({ ...req, baseUrl: 'https://opencode.ai/zen/go/v1/' })
    expect(calls).toHaveLength(2)
    const first = calls[0]!.headers['x-opencode-session']
    expect(first).toMatch(/^test-/)
    expect(calls[1]!.headers['x-opencode-session']).toMatch(/^test-/)
    expect(calls[1]!.headers['x-opencode-session']).not.toBe(first)
    // client 头与 pi attribution 层同构（真实聊天同批注入，测试请求等价）
    expect(calls[0]!.headers['x-opencode-client']).toBe('pi')
    expect(calls[0]!.url).toBe('https://opencode.ai/zen/go/v1/chat/completions')
  })

  it('provider-id 命中分支（opencode / opencode-go + 自定义网关 baseUrl）→ 同样注入（与 pi 双分支判定一致）', async () => {
    // 内置 opencode provider 配自定义网关/镜像的形态：真实聊天按 provider id 注入，
    // 测试请求只判 baseUrl 会漏注入 → 测试 400 而聊天可用（脱节）
    const calls = stubFetch()
    const tester = new ModelConnectionTester()
    const req = { api: 'openai-completions' as const, modelId: 'm1', apiKey: 'k', baseUrl: 'https://gw.internal.example.com/v1' }
    await tester.test({ ...req, providerId: 'opencode' })
    await tester.test({ ...req, providerId: 'opencode-go' })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.headers['x-opencode-session']).toMatch(/^test-/)
    expect(calls[0]!.headers['x-opencode-client']).toBe('pi')
    expect(calls[1]!.headers['x-opencode-session']).toMatch(/^test-/)
  })

  it('非 opencode 端点 / 子域（api.opencode.ai）/ 非 opencode 系 providerId → 不注入', async () => {
    const calls = stubFetch()
    const tester = new ModelConnectionTester()
    await tester.test({ api: 'openai-completions', modelId: 'm1', baseUrl: 'https://api.deepseek.com', apiKey: 'k', providerId: 'deepseek' })
    await tester.test({ api: 'openai-completions', modelId: 'm2', baseUrl: 'https://api.opencode.ai/v1', apiKey: 'k' })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.headers['x-opencode-session']).toBeUndefined()
    expect(calls[0]!.headers['x-opencode-client']).toBeUndefined()
    expect(calls[1]!.headers['x-opencode-session']).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('supports()：三协议 true、其他 false', () => {
    const tester = new ModelConnectionTester()
    expect(tester.supports('anthropic-messages')).toBe(true)
    expect(tester.supports('openai-completions')).toBe(true)
    expect(tester.supports('openai-responses')).toBe(true)
    expect(tester.supports('google-vertex')).toBe(false)
  })
})
describe('ModelService.testProviderConnections：provider 级错误分支与行序', () => {
  it('providerId 不在聚合列表 → provider_not_found', async () => {
    const service = makeService({ listProviders: () => [], getProvider: () => undefined })
    const outcome = await service.testProviderConnections('nope', 'key', stubTester())
    expect(outcome).toEqual({ success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.providerNotFound })
  })

  it('provider 无模型 → no_models', async () => {
    const service = makeService({
      listProviders: () => [makeProvider('custom-1', [])],
      getProvider: () => undefined,
    })
    const outcome = await service.testProviderConnections('custom-1', 'key', stubTester())
    expect(outcome).toEqual({ success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.noModels })
  })

  it('凭据 resolver 全源 miss（apiKey undefined）→ no_api_key（不发任何请求）', async () => {
    const tester = stubTester()
    const outcome = await makeServiceWithM1().testProviderConnections('custom-1', undefined, tester)
    expect(outcome).toEqual({ success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.noApiKey })
    expect(tester.test).not.toHaveBeenCalled()
  })

  it('全部模型无协议信息（模型级与 provider 级 api 皆缺）→ no_models', async () => {
    const service = makeService({
      listProviders: () => [makeProvider('custom-1', [{ id: 'm1', baseUrl: 'https://api.example' }])],
      getProvider: () => undefined,
    })
    const outcome = await service.testProviderConnections('custom-1', 'key', stubTester())
    expect(outcome).toEqual({ success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.noModels })
  })

  it('成功：错误行与发包行按协议组序合并，发包带回落后的 baseUrl 与凭据', async () => {
    const tester = {
      supports: (api: string) => ['anthropic-messages', 'openai-completions', 'openai-responses'].includes(api),
      test: vi.fn().mockImplementation(async (req: { api: string; modelId: string }) => ({ api: req.api, modelId: req.modelId, ok: true })),
    }
    const provider = makeProvider('opencode-go', [
      { id: 'a1', api: 'anthropic-messages', baseUrl: 'https://api.example/anthropic' },
      { id: 'g1', api: 'google-generative-ai', baseUrl: 'https://api.example/google' },
      { id: 'o1', api: 'openai-completions' },
      { id: 'd1', api: 'openai-completions', enabled: false },
    ])
    const service = makeService({
      listProviders: () => [provider],
      getProvider: () => ({ baseUrl: 'https://provider.example' }),
    })
    const outcome = await service.testProviderConnections('opencode-go', 'sk-key', tester as never)
    expect(outcome.success).toBe(true)
    if (!outcome.success) return
    expect(outcome.results).toEqual([
      { api: 'anthropic-messages', modelId: 'a1', ok: true },
      { api: 'google-generative-ai', modelId: '', ok: false, error: 'unsupported' },
      { api: 'openai-completions', modelId: 'o1', ok: true },
    ])
    // custom provider：模型级缺省时回落 provider 级 baseUrl（第 2 级）
    expect(tester.test).toHaveBeenCalledWith({
      api: 'openai-completions',
      modelId: 'o1',
      baseUrl: 'https://provider.example',
      apiKey: 'sk-key',
      providerId: 'opencode-go',
    })
  })
})
describe('ModelService.testProviderModel：单模型测试（per-model 行内入口）', () => {
  it('模型不在 provider.models → 行级 model_not_found（顶层仍 success:true，与已定论行同形）', async () => {
    const service = makeService({
      listProviders: () => [makeProvider('custom-1', [{ id: 'm1', api: 'openai-completions', baseUrl: 'https://api.example' }])],
      getProvider: () => undefined,
    })
    const outcome = await service.testProviderModel('custom-1', 'ghost', 'key', stubTester())
    expect(outcome.success).toBe(true)
    if (outcome.success) {
      expect(outcome.results).toEqual([{ api: '', modelId: 'ghost', ok: false, error: 'model_not_found' }])
    }
  })

  it('凭据 miss → 顶层 no_api_key（与 provider 级测试同一硬停语义，不发请求）', async () => {
    const tester = stubTester()
    const outcome = await makeServiceWithM1().testProviderModel('custom-1', 'm1', undefined, tester)
    expect(outcome).toEqual({ success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.noApiKey })
    expect(tester.test).not.toHaveBeenCalled()
  })

  it('协议缺省回落 provider 级；不支持协议 → unsupported 行；全缺端点 → no_base_url 行', async () => {
    const service = makeService({
      listProviders: () => [
        makeProvider('custom-1', [
          { id: 'm-noapi', baseUrl: 'https://api.example' },
          { id: 'm-badapi', api: 'google-generative-ai', baseUrl: 'https://api.example' },
          { id: 'm-nourl', api: 'openai-completions' },
        ]),
      ],
      getProvider: () => ({ baseUrl: 'https://provider.example' }),
    })
    // m-noapi：模型级 api 缺省 → 回落 provider 级（本 provider 未声明 api）→ unsupported
    const noApi = await service.testProviderModel('custom-1', 'm-noapi', 'key', stubTester())
    if (noApi.success) expect(noApi.results[0]).toMatchObject({ modelId: 'm-noapi', ok: false, error: 'unsupported' })
    // m-badapi：协议不在支持集 → unsupported
    const badApi = await service.testProviderModel('custom-1', 'm-badapi', 'key', stubTester())
    if (badApi.success) expect(badApi.results[0]).toMatchObject({ modelId: 'm-badapi', ok: false, error: 'unsupported' })
    // m-nourl：custom 模型级缺省 → 回落 provider 级 https://provider.example（有值）→ 正常发包。
    // 此处 provider 级有值，故改走「全缺」：用空 provider baseUrl 的独立 service。
    const noUrlService = makeService({
      listProviders: () => [makeProvider('custom-1', [{ id: 'm-nourl', api: 'openai-completions' }])],
      getProvider: () => undefined,
    })
    const noUrl = await noUrlService.testProviderModel('custom-1', 'm-nourl', 'key', stubTester())
    if (noUrl.success) expect(noUrl.results[0]).toMatchObject({ modelId: 'm-nourl', ok: false, error: 'no_base_url' })
  })

  it('正常路径：catalog 网关 override 优先于模型级 baseUrl（与 provider 级测试同一回落链），tester 收到凭据', async () => {
    const tester = {
      supports: (api: string) => api === 'anthropic-messages',
      test: vi.fn().mockImplementation(async (req: { api: string; modelId: string }) => ({ api: req.api, modelId: req.modelId, ok: true, durationMs: 5 })),
    }
    const service = makeService({
      // 'anthropic' 在快照内（isCatalogProvider=true），网关 override 必须赢过模型级 baseUrl
      listProviders: () => [makeProvider('anthropic', [{ id: 'claude-fable-5', api: 'anthropic-messages', baseUrl: 'https://model.example' }])],
      getProvider: () => ({ baseUrl: 'https://gw.corp.example' }),
    })
    const outcome = await service.testProviderModel('anthropic', 'claude-fable-5', 'sk-key', tester as never)
    expect(outcome.success).toBe(true)
    expect(tester.test).toHaveBeenCalledWith({
      api: 'anthropic-messages',
      modelId: 'claude-fable-5',
      baseUrl: 'https://gw.corp.example',
      apiKey: 'sk-key',
      providerId: 'anthropic',
    })
  })

  it('禁用态模型照样可测（per-model 显式指定即测，不做 enabled 过滤——测试不改配置）', async () => {
    const tester = {
      supports: (api: string) => api === 'openai-completions',
      test: vi.fn().mockResolvedValue({ api: 'openai-completions', modelId: 'm-off', ok: true }),
    }
    const service = makeService({
      listProviders: () => [makeProvider('custom-1', [{ id: 'm-off', api: 'openai-completions', baseUrl: 'https://api.example', enabled: false }])],
      getProvider: () => undefined,
    })
    const outcome = await service.testProviderModel('custom-1', 'm-off', 'key', tester as never)
    expect(outcome.success).toBe(true)
    expect(tester.test).toHaveBeenCalledTimes(1)
  })
})
});

// ======================================================================
// ← src/services/__tests__/model-service-wool-aggregation.test.ts
// ======================================================================

/** 最小 modelSource 桩（aggregateModelsWithScoped 纯变换，不触 discover 链）。 */
const stubSource: IModelSource = {
  discoverModels: async () => [],
} as unknown as IModelSource


function provider_m2(id: string, models: Array<{ id: string; name?: string }>, extra: Partial<ProviderInfo> = {}): ProviderInfo {
  return { id: id as ProviderId, name: id, apiKeySet: true, status: 'connected', models, ...extra }
}


/** 羊毛条目的插件化终态形态：持久在 config.providers 的普通 ProviderInfo（D6 单一权威源）。 */
const WOOL_ENTRY_IN_CONFIG: ProviderInfo = {
  id: 'wool-qoder' as ProviderId,
  name: 'Qoder',
  apiKeySet: true,
  status: 'connected',
  enabled: true,
  models: [
    { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash', reasoning: true },
    { id: 'qwen3.8-pro', name: 'Qwen3.8 Pro' },
  ],
}


const PROVIDERS: ProviderInfo[] = [
  provider_m2('openai', [{ id: 'gpt-4o', name: 'GPT-4o' }, { id: 'gpt-4o-mini', name: 'GPT-4o mini' }]),
  WOOL_ENTRY_IN_CONFIG,
  provider_m2('disabled-p', [{ id: 'x1' }], { enabled: false }),
]

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('model-service-wool-aggregation', () => {
describe('羊毛聚合特例移除后：config.providers 直读形态（provider-plugin-access D6）', () => {
  it('羊毛条目按普通 provider 直读聚合（enabled 过滤 + 同管道，无追加/无特例序）', () => {
    const svc = new ModelService(stubSource)
    const out = svc.aggregateModelsWithScoped(PROVIDERS, [])
    expect(out.map((m) => `${m.providerId}/${m.id}`)).toEqual([
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'wool-qoder/qwen3.8-flash',
      'wool-qoder/qwen3.8-pro',
    ])
  })

  it('scopedModels 白名单对羊毛条目同语义（同一 providers 输入决定输出，无隐藏第二源）', () => {
    const svc = new ModelService(stubSource)
    const scoped = svc.aggregateModelsWithScoped(PROVIDERS, ['wool-qoder/qwen3.8-flash', 'openai/gpt-4o'])
    expect(scoped.map((m) => `${m.providerId}/${m.id}`)).toEqual([
      'wool-qoder/qwen3.8-flash',
      'openai/gpt-4o',
    ])
  })

  it('羊毛条目 enabled=false 时其模型不进结果（与既有来源同过滤语义）', () => {
    const svc = new ModelService(stubSource)
    const out = svc.aggregateModelsWithScoped(
      [WOOL_ENTRY_IN_CONFIG, { ...WOOL_ENTRY_IN_CONFIG, id: 'wool-trae' as ProviderId, enabled: false }],
      [],
    )
    expect(out.map((m) => m.providerId)).toEqual(['wool-qoder', 'wool-qoder'])
  })

  it('退役守护：ModelService 不再有 setWoolProviderSource 注入点（特例回潮即红）', () => {
    expect(Object.prototype.hasOwnProperty.call(ModelService.prototype, 'setWoolProviderSource')).toBe(false)
  })
})
});

// ======================================================================
// ← src/services/__tests__/provider-catalog.test.ts
// ======================================================================

// overlay 状态注入（vi.hoisted 供 vi.mock 工厂引用）：绕开真实数据目录 IO，
// 只验证「快照 ⊕ overlay」合并点的归一语义。
const overlayState = vi.hoisted(() => ({
  current: { state: 'fresh' as const, models: [] as Array<Record<string, unknown>> },
}))


vi.mock('../provider-catalog-refresh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../provider-catalog-refresh.js')>()
  return { ...actual, getCatalogOverlayState: () => overlayState.current, }
})


// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('provider-catalog', () => {
describe('isCatalogProvider', () => {
  it('TC1: known catalog provider (anthropic) returns true', () => {
    expect(isCatalogProvider('anthropic')).toBe(true)
  })

  it('TC1b: known catalog provider (zai-coding-cn) returns true', () => {
    expect(isCatalogProvider('zai-coding-cn')).toBe(true)
  })

  it('TC1c: known catalog provider (openai) returns true', () => {
    expect(isCatalogProvider('openai')).toBe(true)
  })

  it('TC2: unknown custom provider returns false', () => {
    expect(isCatalogProvider('ollama')).toBe(false)
    expect(isCatalogProvider('my-custom-router')).toBe(false)
  })

  it('TC3: edge cases (empty string / non-existent) return false', () => {
    expect(isCatalogProvider('')).toBe(false)
    expect(isCatalogProvider('nonexistent-provider-foo')).toBe(false)
  })

  it('TC4: fail-safe — function handles edge case where builtinData is iterable', () => {
    // The fail-safe code path (!Array.isArray) is defensive against JSON
    // corruption, verified by code review. Here we test that known-good data
    // works without throwing.
    expect(() => isCatalogProvider('anthropic')).not.toThrow()
  })
})
/**
 * M4 / D7：overlay 归一化不再产空串（设计 catalog-provider-field-authority §3.3 D7）。
 *
 * pi 的 OverlayModel `api`/`baseUrl` 本就是 optional，空串是归一化捏造——会被合并视图的
 * 消费方（派生展示、写路径）当成真实值，且 provider/模型级空串都是 pi TypeBox
 * minLength:1 违规值（写入即拒载整个 models.json）。
 */
describe('M4: overlay 归一化 D7（缺省 = 不置键，非空串）', () => {
  beforeEach(() => {
    overlayState.current = { state: 'fresh', models: [] }
  })

  it('overlay 模型缺省 api/baseUrl → 合并后字段为 undefined 且键不存在（不产 ""）', () => {
    overlayState.current = {
      state: 'fresh',
      models: [{ id: 'overlay-only-model', name: 'Overlay Only' }],
    }

    const view = getMergedCatalogModels('opencode-go')

    expect(view?.overlayState.state).toBe('fresh')
    const overlayModel = view?.models.find(m => m.id === 'overlay-only-model')
    expect(overlayModel).toBeDefined()
    expect(overlayModel?.api).toBeUndefined()
    expect(overlayModel?.baseUrl).toBeUndefined()
    // 「缺省」与「显式空串」语义不同（后者是 pi schema 违规毒药）——断言键不存在而非值为 ''
    expect(overlayModel !== undefined && 'api' in overlayModel).toBe(false)
    expect(overlayModel !== undefined && 'baseUrl' in overlayModel).toBe(false)
  })

  it('对照：overlay 显式带值 → 原值透传；快照模型字段不受归一化影响', () => {
    overlayState.current = {
      state: 'fresh',
      models: [{ id: 'overlay-with-values', name: 'OV', api: 'openai-completions', baseUrl: 'https://ov.example/v1' }],
    }

    const view = getMergedCatalogModels('opencode-go')

    const overlayModel = view?.models.find(m => m.id === 'overlay-with-values')
    expect(overlayModel?.api).toBe('openai-completions')
    expect(overlayModel?.baseUrl).toBe('https://ov.example/v1')
    // 快照模型（opencode-go 内置 25 个）仍带各自 api/baseUrl，overlay 归一化不外溢
    const snapshotModel = view?.models.find(m => m.id === 'minimax-m3')
    expect(snapshotModel?.api).toBe('anthropic-messages')
  })
})
});

// ======================================================================
// ← src/services/__tests__/quota-auto-enable.test.ts
// ======================================================================

const remotePresets = vi.hoisted(() => ({ list: [] as unknown[] }))


vi.mock('../quota-providers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../quota-providers/index.js')>()
  return { ...actual, listQuotaPresets: vi.fn(() => remotePresets.list), }
})


/** 仅远程下发的 preset：namePattern 对基线 QUOTA_PRESETS 全表不命中（漏传 presets 的实现必红）。 */
const REMOTE_ONLY_PRESET: QuotaPreset = {
  fetcher: 'remote-only-fetcher',
  label: 'Remote Only Plan',
  auth: ['api-key'],
  match: { namePattern: '\\bremoteonlyplan\\b' },
}


/** extras 写通道 fake（对齐 provider-importer.test.ts fakeExtrasStore：记录 (id, fn) 可断言写参）。 */
function fakeStore(current: ProviderExtras | undefined = undefined) {
  const modify = vi.fn(async (
    _providerId: string,
    fn: (c: ProviderExtras | undefined) => ProviderExtras,
  ) => fn(current))
  return { modify }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('quota-auto-enable', () => {
beforeEach(() => {
  remotePresets.list = []
})
describe('matchAutoEnablePreset 读 presets 合并视图（与查询/展示链同一权威）', () => {
  it('远程 presets 下发（基线不可见的 namePattern）→ 命中远程 preset（漏传 presets 回落基线的实现必红）', () => {
    remotePresets.list = [REMOTE_ONLY_PRESET]

    const preset = matchAutoEnablePreset(
      { name: 'My RemoteOnlyPlan Service' },
      'plaintext',
      remotePresets.list as readonly QuotaPreset[],
    )

    expect(preset).toEqual(REMOTE_ONLY_PRESET)
  })

  it('同一 provider 在编译期基线下不命中（证明上面的命中来自注入的合并视图，非基线巧合）', () => {
    expect(matchAutoEnablePreset({ name: 'My RemoteOnlyPlan Service' }, 'plaintext', QUOTA_PRESETS)).toBeUndefined()
  })

  it('presets 空数组（远端与基线皆不可用）→ undefined（不自动开启）', () => {
    expect(matchAutoEnablePreset({ name: 'kimi' }, 'plaintext', [])).toBeUndefined()
  })

  it('非 plaintext 凭证形态先行短路（presets 命中也不开启）', () => {
    remotePresets.list = [REMOTE_ONLY_PRESET]
    expect(
      matchAutoEnablePreset({ name: 'My RemoteOnlyPlan Service' }, 'env', remotePresets.list as readonly QuotaPreset[]),
    ).toBeUndefined()
  })
})
describe('autoEnableQuotaDisplayOnCreate 端到端（内部经 listQuotaPresets 取合并视图）', () => {
  it('远程 preset 命中 + 明文凭证 → 落盘 { enabled: true, fetcher: 远程 fetcher }', async () => {
    remotePresets.list = [REMOTE_ONLY_PRESET]
    const store = fakeStore()

    const wrote = await autoEnableQuotaDisplayOnCreate(
      store,
      'my-remote-provider',
      { name: 'My RemoteOnlyPlan Service' },
      true,
    )

    expect(wrote).toBe(true)
    expect(store.modify).toHaveBeenCalledTimes(1)
    const written = store.modify.mock.calls[0][1](undefined)
    expect(written.quota).toEqual({ enabled: true, fetcher: 'remote-only-fetcher' })
  })

  it('合并视图无命中 → 不写 extras（返回 false）', async () => {
    remotePresets.list = [REMOTE_ONLY_PRESET]
    const store = fakeStore()

    const wrote = await autoEnableQuotaDisplayOnCreate(store, 'p1', { baseUrl: 'https://example.com' }, true)

    expect(wrote).toBe(false)
    expect(store.modify).not.toHaveBeenCalled()
  })

  it('无远程覆盖（listQuotaPresets 回落基线 QUOTA_PRESETS）→ 基线命中语义保持（kimi baseUrl）', async () => {
    remotePresets.list = QUOTA_PRESETS
    const store = fakeStore()

    const wrote = await autoEnableQuotaDisplayOnCreate(
      store,
      'kimi-main',
      { baseUrl: 'https://api.kimi.com/coding' },
      true,
    )

    expect(wrote).toBe(true)
    const written = store.modify.mock.calls[0][1](undefined)
    expect(written.quota).toEqual({ enabled: true, fetcher: 'kimi-coding' })
  })
})
});

// ======================================================================
// ← src/services/__tests__/wool-extension-installer.test.ts
// ======================================================================

const MANIFEST: WoolAssetManifest = {
  schemaVersion: 1,
  generatedAt: 1_700_000_000_000,
  families: {
    workbuddy: {
      pkg: '@zhushanwen/pi-wool-workbuddy',
      version: '0.2.0',
      displayName: 'WorkBuddy',
      vendor: '腾讯',
      credentialsSource: 'oauth',
      riskNotice: '非官方接口',
    },
    qoder: {
      pkg: '@zhushanwen/pi-wool-qoder',
      version: '0.1.9',
      displayName: 'Qoder',
      vendor: '阿里',
      credentialsSource: 'ide-extract',
      riskNotice: '非官方接口',
    },
  },
}


function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}


function makeDeps(overrides: Partial<WoolExtensionInstallerDeps> = {}): WoolExtensionInstallerDeps {
  const extensionService: WoolExtensionInstallerDeps['extensionService'] = {
    scanExtensions: vi.fn(async () => [{ name: '@zhushanwen/pi-wool-workbuddy', version: '0.2.0', enabled: true }]),
    installExtension: vi.fn(async () => {}),
    uninstallExtension: vi.fn(async () => {}),
  }
  return {
    extensionService,
    manifestUrl: 'https://fixture.test/wool-manifest.json',
    fetchFn: vi.fn(async () => jsonOk(MANIFEST)),
    ...overrides,
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('wool-extension-installer', () => {
describe('WoolExtensionInstaller（D6 双产物安装编排·扩展侧）', () => {
  it('installPiExtension：配对一致 → 钉清单版本安装 + 扫描确认', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    const result = await installer.installPiExtension('workbuddy', '0.2.0')

    expect(vi.mocked(deps.extensionService.installExtension)).toHaveBeenCalledWith('npm:@zhushanwen/pi-wool-workbuddy@0.2.0')
    expect(result).toEqual({ installedVersion: '0.2.0' })
  })

  it('版本配对不一致 → VERSION_PAIR_MISMATCH 拒绝，不执行安装（不落半成品）', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    await expect(installer.installPiExtension('workbuddy', '0.3.0')).rejects.toMatchObject({
      code: VERSION_PAIR_MISMATCH,
    })
    expect(vi.mocked(deps.extensionService.installExtension)).not.toHaveBeenCalled()
  })

  it('清单无该家族条目 → family_absent', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    await expect(installer.installPiExtension('trae', '0.1.0')).rejects.toMatchObject({
      code: 'family_absent',
    })
  })

  it('清单不可达（显式单源失败）→ unreachable，错误含恢复指引', async () => {
    const deps = makeDeps({ fetchFn: vi.fn(async () => new Response('boom', { status: 503 })) })
    const installer = new WoolExtensionInstaller(deps)

    await expect(installer.installPiExtension('workbuddy', '0.2.0')).rejects.toMatchObject({
      code: 'unreachable',
    })
  })

  it('缺省双通道双败 → unreachable，message 聚合 github/gitcode 两通道 detail', async () => {
    // 双败聚合分支（fetchManifest 缺省路径 :201-209）：错误信封拼装两通道原因——
    // 排障时用户能看到「哪条通道、各自败因」，单源用例触不到本分支
    const fetchFn = vi.fn(async () => new Response('boom', { status: 503 }))
    const installer = new WoolExtensionInstaller({ extensionService: makeDeps().extensionService, fetchFn })

    const err = await installer.installPiExtension('workbuddy', '0.2.0').then(
      () => { throw new Error('expected rejection') },
      (e: unknown) => e as Error & { code?: string },
    )

    expect(err.code).toBe('unreachable')
    expect(err.message).toContain('github：HTTP 503')
    expect(err.message).toContain('gitcode：HTTP 503')
    // github 直拉 1 次 + gitcode releases 首跳即败 1 次（两跳完整路径只在成功时走满）
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('清单坏形状 → bad_shape', async () => {
    const deps = makeDeps({ fetchFn: vi.fn(async () => jsonOk({ schemaVersion: 2 })) })
    const installer = new WoolExtensionInstaller(deps)

    const result = await installer.fetchManifest()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('bad_shape')
  })

  it('缺省双通道：github 成功恒用 github（gitcode 滞后镜像不消费）', async () => {
    const staleManifest: WoolAssetManifest = {
      ...MANIFEST,
      families: { ...MANIFEST.families, workbuddy: { ...MANIFEST.families.workbuddy!, version: '0.0.1' } },
    }
    const fetchFn = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('github.com')) return jsonOk(MANIFEST)
      return jsonOk([{ prerelease: false, assets: [{ name: 'wool-manifest.json', browser_download_url: 'https://mirror.test/m.json' }] }])
    })
    const installer = new WoolExtensionInstaller({ extensionService: makeDeps().extensionService, fetchFn })

    const result = await installer.fetchManifest()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.manifest.families.workbuddy?.version).toBe('0.2.0')
    // 双通道并发各走完整通道：github 直拉 1 次 + gitcode 两跳 2 次（资产走镜像直链）；结果仍取 github。
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(fetchFn.mock.calls.every((call) => {
      const url = String(call[0])
      return url.includes(DEFAULT_WOOL_MANIFEST_URL) || url.includes('gitcode') || url.includes('mirror.test')
    })).toBe(true)
  })

  it('安装链成功但扫描未见 → install_failed（不假装成功）', async () => {
    const deps = makeDeps()
    vi.mocked(deps.extensionService.scanExtensions).mockResolvedValue([])
    const installer = new WoolExtensionInstaller(deps)

    await expect(installer.installPiExtension('workbuddy', '0.2.0')).rejects.toMatchObject({
      code: 'install_failed',
    })
  })

  it('卸载走既有 uninstallExtension 链；失败转 uninstall_failed', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    await installer.uninstallPiExtension('workbuddy')
    expect(vi.mocked(deps.extensionService.uninstallExtension)).toHaveBeenCalledWith('@zhushanwen/pi-wool-workbuddy')

    vi.mocked(deps.extensionService.uninstallExtension).mockRejectedValue(new Error('npm uninstall failed'))
    await expect(installer.uninstallPiExtension('workbuddy')).rejects.toBeInstanceOf(WoolExtensionInstallError)
  })
})
describe('fetchManifest 缓存与时点差自愈（D6：清单热更新后重试自愈）', () => {
  it('成功结果进内存缓存：第二次 fetchManifest 不发网络', async () => {
    const fetchFn = vi.fn(async () => jsonOk(MANIFEST))
    const installer = new WoolExtensionInstaller({ extensionService: makeDeps().extensionService, manifestUrl: 'https://fixture.test/m.json', fetchFn })

    await installer.fetchManifest()
    await installer.fetchManifest()

    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('force: true 跳过缓存强制重拉，重拉成功后覆盖缓存', async () => {
    const refreshed: WoolAssetManifest = {
      ...MANIFEST,
      families: { ...MANIFEST.families, workbuddy: { ...MANIFEST.families.workbuddy!, version: '0.3.0' } },
    }
    let call = 0
    const fetchFn = vi.fn(async () => jsonOk(call++ === 0 ? MANIFEST : refreshed))
    const installer = new WoolExtensionInstaller({ extensionService: makeDeps().extensionService, manifestUrl: 'https://fixture.test/m.json', fetchFn })

    await installer.fetchManifest()
    const second = await installer.fetchManifest({ force: true })
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.manifest.families.workbuddy?.version).toBe('0.3.0')
    expect(fetchFn).toHaveBeenCalledTimes(2)
    // 重拉后的新清单成为缓存：第三次无 force 读取不再发网络
    await installer.fetchManifest()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('时点差自愈：缓存清单落后 → mismatch 触发强制重拉 → 新清单配对一致 → 安装成功', async () => {
    // 第一跳（缓存填充）回旧清单 0.1.9；mismatch 后 force 重拉回新清单 0.2.0（模拟
    // v2-plugins 配对权威先行热更新、wool-manifest 随后跟上的时点差窗口关闭）。
    const refreshed: WoolAssetManifest = {
      ...MANIFEST,
      families: { ...MANIFEST.families, qoder: { ...MANIFEST.families.qoder!, version: '0.2.0' } },
    }
    let call = 0
    const fetchFn = vi.fn(async () => jsonOk(call++ === 0 ? MANIFEST : refreshed))
    const deps = makeDeps({ fetchFn })
    vi.mocked(deps.extensionService.scanExtensions).mockResolvedValue([
      { name: '@zhushanwen/pi-wool-qoder', version: '0.2.0', enabled: true },
    ])
    const installer = new WoolExtensionInstaller(deps)

    const result = await installer.installPiExtension('qoder', '0.2.0')

    expect(result).toEqual({ installedVersion: '0.2.0' })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.extensionService.installExtension)).toHaveBeenCalledWith('npm:@zhushanwen/pi-wool-qoder@0.2.0')
  })

  it('时点差未收敛：强制重拉后仍不一致 → VERSION_PAIR_MISMATCH（原文案保留）', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    await expect(installer.installPiExtension('workbuddy', '0.3.0')).rejects.toMatchObject({
      code: VERSION_PAIR_MISMATCH,
      message: expect.stringContaining('清单热更新后自愈'),
    })
    // 首拉（缓存填充）+ mismatch 强制重拉 = 2 次网络；安装未执行（不落半成品）
    expect(vi.mocked(deps.fetchFn!)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.extensionService.installExtension)).not.toHaveBeenCalled()
  })
})
describe('installForCatalogEntry（U7 接线：v2-plugins 清单条目 → 家族推导 → 钉版安装）', () => {
  it('plugin-wool-<family> 包名推导家族 → 配对校验 + 安装', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    const result = await installer.installForCatalogEntry({
      packageName: '@zhushanwen/plugin-wool-workbuddy',
      piExtensionVersion: '0.2.0',
    })

    expect(result).toEqual({ installedVersion: '0.2.0' })
    expect(vi.mocked(deps.extensionService.installExtension)).toHaveBeenCalledWith('npm:@zhushanwen/pi-wool-workbuddy@0.2.0')
  })

  it('非 plugin-wool-* 包名（清单指向未知家族）→ family_unknown 结构化拒绝，不安装', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    await expect(installer.installForCatalogEntry({
      packageName: '@acme/some-other-plugin',
      piExtensionVersion: '1.0.0',
    })).rejects.toMatchObject({ code: 'family_unknown' })
    expect(vi.mocked(deps.extensionService.installExtension)).not.toHaveBeenCalled()
  })

  it('plugin-wool- 前缀但家族不在词表 → family_unknown', async () => {
    const installer = new WoolExtensionInstaller(makeDeps())

    await expect(installer.installForCatalogEntry({
      packageName: '@zhushanwen/plugin-wool-nosuch',
      piExtensionVersion: '1.0.0',
    })).rejects.toMatchObject({ code: 'family_unknown' })
  })
})
describe('uninstallForCatalogEntry（U4 接线：包名 → 家族推导 → 卸载；plugin-service.uninstallPlugin 消费）', () => {
  it('plugin-wool-<family> 包名推导家族 → uninstallExtension 以 pi-wool-<family> 包名执行', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    await installer.uninstallForCatalogEntry('@zhushanwen/plugin-wool-workbuddy')

    expect(vi.mocked(deps.extensionService.uninstallExtension)).toHaveBeenCalledWith('@zhushanwen/pi-wool-workbuddy')
  })

  it('非 plugin-wool-* 包名（单产物插件）→ no-op 不触碰扩展目录', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    await installer.uninstallForCatalogEntry('@acme/some-other-plugin')

    expect(vi.mocked(deps.extensionService.uninstallExtension)).not.toHaveBeenCalled()
  })

  it('plugin-wool- 前缀但家族不在词表 → no-op（卸载侧包名事实源 = 磁盘 package.json，非清单，无 guard 契约可违反）', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    await expect(installer.uninstallForCatalogEntry('@zhushanwen/plugin-wool-nosuch')).resolves.toBeUndefined()
    expect(vi.mocked(deps.extensionService.uninstallExtension)).not.toHaveBeenCalled()
  })
})
});
