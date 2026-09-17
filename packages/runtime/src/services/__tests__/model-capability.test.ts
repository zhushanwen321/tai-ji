/**
 * U5 能力注册表单测（pi-boundary-reliability design §3.3 D2 / §5 U5）。
 *
 * 覆盖：
 * - 离线计算：reasoning 缺失/false → ['off']（pi 两级门控第一关）；正常模型与
 *   pi-ai getSupportedThinkingLevels 同源值一致（builtin-providers.json fixture
 *   全量直调比对——对 passthrough 实现是恒真基线，computeSupportedLevels 一旦被
 *   塞入 taiji 侧改写逻辑即红，同源契约守卫）；档位过滤语义锚点。
 * - 对账：config_only / reasoning_mismatch / case_twin 三类 drift 纯比对 +
 *   编排路径（runtime 日志 + 事件上报出口 + 降级路径）。
 * - 下发标注：attachSupportedLevels 输出含 supportedLevels、不改入参。
 * - RpcClient.getAvailableModels 封装：命令名 / payload 解包 / malformed 抛错。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/model-capability.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import builtinData from '../../generated/builtin-providers.json'
import type { ProviderInfo, ProviderId } from '@taiji/shared'
import {
  computeSupportedLevels,
  detectCapabilityDrift,
  runCapabilityReconcile,
  ModelCapabilityRegistry,
} from '../model-capability.js'
import { ModelService } from '../model-service.js'
import { RpcClient, type PiMessage, type AvailableModelSnapshot } from '../../infra/pi/rpc-client.js'
import { logger } from '../../infra/logger.js'
import type { IModelSource } from '../ports/model.js'
import type { ISessionService, IConfigService, IMessageBroker } from '../../interfaces.js'

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
    expect(total).toBeGreaterThan(1000) // fixture 覆盖面不缩水（当前 1220）
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
    const registry = new ModelCapabilityRegistry()
    const providers = [provider('p1', [
      model('hand-added-no-reasoning', { thinkingLevelMap: { off: 'off', high: 'high', max: 'max' } }),
      model('reasoning-true', { reasoning: true, thinkingLevelMap: { high: 'high', max: 'max' } }),
    ])]
    const decorated = registry.attachSupportedLevels(providers)
    expect(decorated[0].models.map(m => m.supportedLevels))
      .toEqual([['off'], ['off', 'minimal', 'low', 'medium', 'high', 'max']])
  })

  it('builtin fixture 模型标注值与 pi 直调一致', () => {
    const registry = new ModelCapabilityRegistry()
    const p = builtinSnapshot[0]
    const source = (p.models ?? []).slice(0, 5)
    const decorated = registry.attachSupportedLevels([provider(p.id, source.map(m => ({
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
    const registry = new ModelCapabilityRegistry()
    const m0 = model('m1')
    const providers = [provider('p', [m0])]
    const decorated = registry.attachSupportedLevels(providers)
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

describe('ModelService 服务面挂载', () => {
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

  it('attachSupportedLevels 透传能力面：下发模型信息含 supportedLevels 字段', () => {
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
    expect(spy).toHaveBeenCalledWith('get_available_models', {}, expect.any(Number))
  })

  it('malformed 响应（无 models 数组）→ 抛错（由对账层降级捕获，不误判全量漂移）', async () => {
    const client = new RpcClient()
    vi.spyOn(client, 'sendCommand').mockResolvedValue({ type: 'response', data: {} } as PiMessage)
    await expect(client.getAvailableModels()).rejects.toThrow('malformed')
  })
})
