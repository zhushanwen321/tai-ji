/**
 * zcode provider 启动同步接线测试（engine-provider-unification u2-wiring）。
 *
 * 覆盖（对齐任务书：同步抛错不中断启动 + 接线契约）：
 * 1. 缺省路径拼装：真实三路径 homedir 段形态 + 副本路径段形态（副本段常量单源 =
 *    SDK zcode-db-paths.ts ZCODE_PI_SYNCED_PROVIDER_CONFIG_SEGMENTS——测试锁 SDK 段
 *    常量字面值 + 断言生产确实由该常量拼装，SDK 常量被误改或 runtime 漂移回自拼
 *    字面量均在此红）；
 * 2. D7 降级：底层依赖抛错 → 不向调用方上抛（启动不中断）+ warn 留痕含恢复语义；
 * 3. 摘要日志三态：written（条目数 + 落盘路径）/ skipped-empty（删旧副本回落真实文件）。
 * 4. transport 装配契约（ADR-0142 write-through）：RuntimeServer.setServices 可选服务
 *    zcodeProviderMirrorSync 的注入分支（assignServices 解构 + providerHandler ctx 三元）
 *    ——注入后 mutation 类 config.* 消息处理成功恰触发一次；缺省 undefined 不调用不炸。
 *    handler 侧 mirrorAfterMutation 触发链细则见 src/transport/provider-message-handler-mirror.test.ts。
 *
 * fixture 经 mkdtempSync 自建（os.tmpdir()），零接触真实 ~/.zcode / ~/.taiji / ~/.pi。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/services/zcode-provider-sync-wiring.test.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { getDataDir } from '@taiji/shared/paths'
import type { ClientMessage } from '@taiji/shared'
import { ZCODE_PI_SYNCED_PROVIDER_CONFIG_SEGMENTS } from '@zhushanwen/subagent-engine-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelsConfigView, ProviderConfigView } from '../../infra/pi/pi-provider-store.js'
import type { ResolvedProviderCredential } from '../../services/ports/provider-credential-resolver.js'
import type { IConfigService, IModelService, ISessionService } from '../../interfaces.js'
import type { IModelConnectionTester } from '../../services/ports/model-connection-tester.js'
import type { IProviderCredentialResolver } from '../../services/ports/provider-credential-resolver.js'
import type { SkillRegistry } from '../../services/skill-registry.js'
import { RuntimeServer } from '../../transport/server.js'
import {
  createZcodeProviderMirrorSync,
  defaultZcodeProviderSyncPaths,
  runZcodeProviderStartupSync,
  type ZcodeProviderStartupSyncDeps,
} from '../../services/zcode-provider-sync-wiring.js'
import type { ZcodeProviderSyncPaths } from '../../services/zcode-provider-sync.js'

// ── fixture 基建 ─────────────────────────────────────────────────────────────

let root: string
let paths: ZcodeProviderSyncPaths
let warns: string[]
let infos: string[]

/** 标准可用 provider fixture（openai 兼容网关，u1 同款形态）。 */
function stdProvider(): ProviderConfigView {
  return {
    name: 'StepFun',
    baseUrl: 'https://api.stepfun.com/v1',
    apiKey: 'pi-key',
    api: 'openai-completions',
    models: [{ id: 'step-2-16k', contextWindow: 16000 }],
  }
}

interface WiringDepsInput { // oe-exempt:20261012:test:测试构造辅助形态
  providers?: Record<string, ProviderConfigView>
  credentials?: Record<string, ResolvedProviderCredential | undefined>
  credentialThrows?: boolean
}

/** 组装 wiring deps（fake 组合根三项 + fixture 路径族 + 收集日志通道）。 */
function makeDeps(input: WiringDepsInput = {}): ZcodeProviderStartupSyncDeps {
  const models: ModelsConfigView = { providers: input.providers ?? {} }
  return {
    configStore: {
      readModels: () => models,
      getEnabledModels: () => [],
    },
    credentialResolver: {
      resolveProviderCredential: async id => {
        if (input.credentialThrows) throw new Error('resolver exploded (fixture)')
        return input.credentials?.[id] ?? undefined
      },
      resolveProviderBaseUrl: id => input.providers?.[id]?.baseUrl,
      listCredentialBackedProviderIds: () => new Set(Object.keys(input.providers ?? {})),
    },
    paths,
    isModelsCorrupted: () => false,
    getMergedCatalogModels: () => undefined,
    log: {
      warn: msg => warns.push(msg),
      info: msg => infos.push(msg),
    },
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zcode-provider-sync-wiring-'))
  paths = {
    realProviderConfigPath: join(root, 'real', 'provider_config.json'),
    v2ConfigPath: join(root, 'real', 'v2-config.json'),
    cliConfigPath: join(root, 'real', 'cli-config.json'),
    syncedCopyPath: join(root, 'copy', 'pi-synced-provider-config.json'),
  }
  warns = []
  infos = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ── 缺省路径拼装 ─────────────────────────────────────────────────────────────

describe('defaultZcodeProviderSyncPaths', () => {
  it('真实三路径 homedir 段形态 + 副本路径 getDataDir 段形态（SDK 段常量单源对账）', () => {
    // SDK 段常量字面值锁（真实对账点）：runtime 生产代码与 zcode-subagent-cli 引擎
    // 读侧同源 import 该常量——字面值被误改在此红，两侧消费同步断裂可感知
    expect([...ZCODE_PI_SYNCED_PROVIDER_CONFIG_SEGMENTS]).toEqual([
      'engines',
      'zcode',
      'pi-synced-provider-config.json',
    ])
    const p = defaultZcodeProviderSyncPaths()
    const zcodeRoot = join(homedir(), '.zcode')
    expect(p.realProviderConfigPath).toBe(join(zcodeRoot, 'v2', 'provider_config.json'))
    expect(p.v2ConfigPath).toBe(join(zcodeRoot, 'v2', 'config.json'))
    expect(p.cliConfigPath).toBe(join(zcodeRoot, 'cli', 'config.json'))
    // 生产必须由 SDK 常量拼装（常量字面值已被上行锁死）——漂移回自拼字面量在此红
    expect(p.syncedCopyPath).toBe(join(getDataDir(), ...ZCODE_PI_SYNCED_PROVIDER_CONFIG_SEGMENTS))
  })
})

// ── D7 降级：同步抛错不中断启动 ──────────────────────────────────────────────

describe('runZcodeProviderStartupSync 降级语义', () => {
  it('底层 resolver 抛错：不 reject（启动不中断）+ warn 留痕含恢复语义 + failed 结果', async () => {
    const result = await runZcodeProviderStartupSync(makeDeps({
      providers: { stepfun: stdProvider() },
      credentialThrows: true,
    }))
    expect(result.kind).toBe('failed')
    expect(warns.some(w => w.includes('不阻断 runtime 启动') && w.includes('resolver exploded (fixture)'))).toBe(true)
  })

  it('u1 内部中止（readModels 抛错）同样不上抛：completed + aborted 透传，不重复摘要', async () => {
    const deps = { ...makeDeps(), configStore: { readModels: () => { throw new Error('EACCES') }, getEnabledModels: () => [] } }
    const result = await runZcodeProviderStartupSync(deps)
    expect(result.kind).toBe('completed')
    expect(result.kind === 'completed' && result.outcome.status).toBe('aborted')
    expect(warns.some(w => w.includes('同步中止'))).toBe(true)
    expect(infos).toHaveLength(0)
  })
})

// ── 摘要日志与落盘 ───────────────────────────────────────────────────────────

describe('runZcodeProviderStartupSync 摘要日志', () => {
  it('written：info 摘要含条目数与副本路径，副本真实落盘且条目正确', async () => {
    const result = await runZcodeProviderStartupSync(makeDeps({
      providers: { stepfun: stdProvider() },
      credentials: { stepfun: { key: 'pi-key', source: 'models.json', kind: 'api_key' } },
    }))
    expect(result.kind).toBe('completed')
    expect(result.kind === 'completed' && result.outcome.status).toBe('written')
    const summary = infos.find(w => w.includes('副本落盘'))
    expect(summary).toBeDefined()
    expect(summary).toContain('provider 条目 1')
    expect(summary).toContain(paths.syncedCopyPath)
    const copy = JSON.parse(readFileSync(paths.syncedCopyPath, 'utf-8')) as {
      config: { providerConfigRules: { providerRules: { providerId: string }[] }; providerOrder: string[] }
    }
    expect(copy.config.providerConfigRules.providerRules.map(r => r.providerId)).toEqual(['stepfun'])
    expect(copy.config.providerOrder).toEqual(['stepfun'])
  })

  it('skipped-empty：pi 映射空 → 旧副本被删 + info 摘要含回落语义', async () => {
    mkdirSync(join(root, 'copy'), { recursive: true })
    writeFileSync(paths.syncedCopyPath, '{}')
    const result = await runZcodeProviderStartupSync(makeDeps())
    expect(result.kind).toBe('completed')
    expect(result.kind === 'completed' && result.outcome.status).toBe('skipped-empty')
    expect(infos.some(w => w.includes('无 pi 映射条目') && w.includes('回落真实 zcode 配置'))).toBe(true)
    expect(() => readFileSync(paths.syncedCopyPath, 'utf-8')).toThrow()
  })

  it('trigger=mutation：日志措辞按来源分流（变更镜像，不冒用启动同步文案）', async () => {
    const result = await runZcodeProviderStartupSync({
      ...makeDeps({
        providers: { stepfun: stdProvider() },
        credentials: { stepfun: { key: 'pi-key', source: 'models.json', kind: 'api_key' } },
      }),
      trigger: 'mutation',
    })
    expect(result.kind).toBe('completed')
    expect(infos.some(w => w.includes('变更镜像同步完成') && w.includes('副本落盘'))).toBe(true)
    expect(infos.some(w => w.includes('启动同步完成'))).toBe(false)
  })

  it('trigger=mutation 异常：warn 使用配置写入措辞（不含「不阻断 runtime 启动」）', async () => {
    const result = await runZcodeProviderStartupSync({
      ...makeDeps({ providers: { stepfun: stdProvider() }, credentialThrows: true }),
      trigger: 'mutation',
    })
    expect(result.kind).toBe('failed')
    expect(warns.some(w => w.includes('变更镜像同步意外异常') && w.includes('不阻断配置写入应答'))).toBe(true)
    expect(warns.some(w => w.includes('不阻断 runtime 启动'))).toBe(false)
  })
})

// ── write-through 触发面工厂 ────────────────────────────────────────────────

describe('createZcodeProviderMirrorSync', () => {
  it('返回闭包：触发 mutation 镜像并吞掉结果（日志为变更措辞）', async () => {
    const mirror = createZcodeProviderMirrorSync(makeDeps({
      providers: { stepfun: stdProvider() },
      credentials: { stepfun: { key: 'pi-key', source: 'models.json', kind: 'api_key' } },
    }))
    await expect(mirror()).resolves.toBeUndefined()
    expect(infos.some(w => w.includes('变更镜像同步完成'))).toBe(true)
  })

  it('并发触发串行化：运行中触发不并发启动，结束后按最新状态重跑一次（latest-wins）', async () => {
    let active = 0
    let maxActive = 0
    let resolverCalls = 0
    let releaseFirst!: () => void
    const firstRunGate = new Promise<void>(resolve => { releaseFirst = resolve })

    const providers: Record<string, ProviderConfigView> = { stepfun: stdProvider() }
    const credentials: Record<string, ResolvedProviderCredential | undefined> = {
      stepfun: { key: 'pi-key', source: 'models.json', kind: 'api_key' },
      secondgw: { key: 'second-key', source: 'models.json', kind: 'api_key' },
    }
    const base = makeDeps({ providers, credentials })
    const mirror = createZcodeProviderMirrorSync({
      ...base,
      credentialResolver: {
        ...base.credentialResolver,
        resolveProviderCredential: async id => {
          resolverCalls += 1
          active += 1
          maxActive = Math.max(maxActive, active)
          if (resolverCalls === 1) await firstRunGate
          active -= 1
          return credentials[id]
        },
      },
    })

    const first = mirror()
    const second = mirror()
    // 首轮运行中新增 provider（变异点在第二次触发之后、重跑读取之前）
    providers.secondgw = {
      name: 'Second GW',
      baseUrl: 'https://second.example/v1',
      apiKey: 'pi-second-key',
      api: 'openai-completions',
      models: [{ id: 'second-model', contextWindow: 32000 }],
    }
    const third = mirror()

    // 首轮被 gate 挂起：后续触发不得并发启动（串行契约）
    expect(resolverCalls).toBe(1)
    expect(maxActive).toBe(1)

    releaseFirst()
    await Promise.all([first, second, third])

    expect(maxActive).toBe(1)
    // 运行中的两次触发合并为一次重跑（latest-wins + 不丢触发：两次写盘而非三次）
    expect(infos.filter(i => i.includes('变更镜像同步完成'))).toHaveLength(2)
    // 末轮读到最新配置：第二次落盘的副本含后加入的 provider（旧快照不会后写覆盖）
    const copy = JSON.parse(readFileSync(paths.syncedCopyPath, 'utf-8')) as {
      config: { providerConfigRules: { providerRules: { providerId: string }[] } }
    }
    expect(copy.config.providerConfigRules.providerRules.map(r => r.providerId)).toEqual(
      expect.arrayContaining(['stepfun', 'secondgw']),
    )
  })
})

// ── transport 装配契约：RuntimeServer zcodeProviderMirrorSync 注入分支 ─────────

describe('RuntimeServer zcodeProviderMirrorSync 注入（transport 装配契约）', () => {
  /** 最小 mock services（server-error-envelope.test.ts makeMockServices 同款形态 + provider mutation 所需 stub）。 */
  function makeServerServices() {
    const sessionService = {
      listPersistedSessions: vi.fn().mockReturnValue([]),
      getRpcClient: vi.fn().mockReturnValue(undefined),
      setOnSessionDestroyed: vi.fn(),
      setOnPlanAborted: vi.fn(),
      restoreSession: vi.fn(),
      create: vi.fn(),
    } as unknown as ISessionService
    const configService = {
      listProviders: vi.fn().mockReturnValue([]),
      getScopedModels: vi.fn().mockReturnValue([]),
      isModelsStoreCorrupted: vi.fn().mockReturnValue(false),
      getDefaultModel: vi.fn().mockReturnValue(null),
      setProvider: vi.fn(async () => ({ newDefault: undefined, quotaAutoEnabled: false })),
    } as unknown as IConfigService
    const modelService = {
      attachSupportedLevels: vi.fn((providers: unknown[]) => providers),
      aggregateModelsWithScoped: vi.fn().mockReturnValue([]),
    } as unknown as IModelService
    return { sessionService, configService, modelService }
  }

  function makeWs() {
    return {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket
  }

  function handleMessageOf(server: RuntimeServer) {
    return (server as unknown as {
      handleMessage(msg: ClientMessage, ws: WebSocket): Promise<void>
    }).handleMessage.bind(server)
  }

  function setProviderMsg(): ClientMessage {
    return { type: 'config.setProvider', id: 'req-1', payload: { providerId: 'stepfun', name: 'StepFun' } } as unknown as ClientMessage
  }

  it('注入后 config.setProvider 处理成功 → 镜像同步恰被调用一次 + reply 照常（真分支接线）', async () => {
    const { sessionService, configService, modelService } = makeServerServices()
    const mirrorSync = vi.fn(async () => {})
    const server = new RuntimeServer(0, '/mock-project-root', 'token')
    server.setServices(sessionService, configService, modelService, {
      skillRegistry: {} as SkillRegistry,
      providerCredentialResolver: {} as IProviderCredentialResolver,
      connectionTester: {} as IModelConnectionTester,
      zcodeProviderMirrorSync: mirrorSync,
    })
    const ws = makeWs()

    await handleMessageOf(server)(setProviderMsg(), ws)

    expect(mirrorSync).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(vi.mocked(ws.send).mock.calls[0][0] as string) as { type: string; payload: { providerId: string } }
    expect(sent.type).toBe('config.providerUpdated')
    expect(sent.payload.providerId).toBe('stepfun')
  })

  it('缺省未注入（undefined，存量测试装配形态）→ mutation 照常应答、无镜像调用（假分支不炸）', async () => {
    const { sessionService, configService, modelService } = makeServerServices()
    const server = new RuntimeServer(0, '/mock-project-root', 'token')
    server.setServices(sessionService, configService, modelService, {
      skillRegistry: {} as SkillRegistry,
      providerCredentialResolver: {} as IProviderCredentialResolver,
      connectionTester: {} as IModelConnectionTester,
    })
    const ws = makeWs()

    await handleMessageOf(server)(setProviderMsg(), ws)

    const sent = JSON.parse(vi.mocked(ws.send).mock.calls[0][0] as string) as { type: string; payload: { providerId: string } }
    expect(sent.type).toBe('config.providerUpdated')
    expect(sent.payload.providerId).toBe('stepfun')
  })
})
