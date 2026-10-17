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
 * 4. transport 装配契约（ADR-0138 write-through）：RuntimeServer.setServices 可选服务
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
      credentials: { stepfun: { key: 'pi-key', source: 'models.json' } },
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
