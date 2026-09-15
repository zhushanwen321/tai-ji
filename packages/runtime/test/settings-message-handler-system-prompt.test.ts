/**
 * SettingsMessageHandler system-prompt 路由单测（TDD 红灯）。
 *
 * 覆盖 2 个 WS case：
 * - config.getSystemPrompt
 * - config.setSystemPrompt（成功/失败两种回复路径）
 */
import { describe, it, expect, vi } from 'vitest'
import { SettingsMessageHandler } from '../src/transport/settings-message-handler.js'
import type { SettingsHandlerContext } from '../src/transport/settings-message-handler.js'
import { ModelConnectionTester } from '../src/infra/model-connection-tester.js'
import type { ClientMessage, ServerMessage } from '@taiji/shared'
import type { IConfigService, IModelService, ISessionService } from '../src/interfaces.js'

interface SystemPromptConfig {
  version: number
  replace: { enabled: boolean; prompt: string }
  append: { enabled: boolean; prompt: string }
}

const DEFAULT_CONFIG: SystemPromptConfig = {
  version: 1,
  replace: { enabled: false, prompt: '' },
  append: { enabled: false, prompt: '' },
}

function makeHandler() {
  const broadcasts: ServerMessage[] = []
  const replies: { id: string | undefined; type: string; payload: unknown }[] = []
  const sendErrorCalls: { code: string; message: string; id?: string }[] = []

  const configService = {
    listProviders: vi.fn().mockReturnValue([]),
    setProvider: vi.fn().mockReturnValue({}),
    deleteProvider: vi.fn().mockResolvedValue({ removed: false }),
    setDefaultModel: vi.fn(),
    getProvider: vi.fn().mockReturnValue(undefined),
    updateToolPermissions: vi.fn(),
    loadSkills: vi.fn().mockReturnValue([]),
    scanSkills: vi.fn().mockReturnValue([]),
    upsertSkill: vi.fn(),
    deleteSkill: vi.fn(),
    setSkillDirs: vi.fn(),
    getSkillDirs: vi.fn().mockReturnValue([]),
    migrateSettingsSkillsToDiscovery: vi.fn(),
    loadAgents: vi.fn().mockReturnValue([]),
    scanAgents: vi.fn().mockReturnValue([]),
    upsertAgent: vi.fn(),
    deleteAgent: vi.fn(),
    setAgentDirs: vi.fn(),
    getAgentDirs: vi.fn().mockReturnValue([]),
    getSystemPromptConfig: vi.fn().mockReturnValue({ config: DEFAULT_CONFIG, corrupted: false }),
    setSystemPromptConfig: vi.fn().mockReturnValue({ ok: true }),
  }

  const modelService: IModelService = {
    aggregateModels: vi.fn().mockReturnValue([]),
    aggregateModelsWithScoped: vi.fn().mockReturnValue([]),
    switchModel: vi.fn().mockResolvedValue('provider/model'),
    setThinkingLevel: vi.fn().mockResolvedValue('high'),
    discoverModelsFromApi: vi.fn().mockResolvedValue([]),
    attachSupportedLevels: vi.fn((providers) => providers),
    reconcileModelCapabilities: vi.fn().mockResolvedValue([]),
    setCapabilityDriftSink: vi.fn(),
  }

  const ctx = {
    send: vi.fn(),
    // payload 用 unknown（非 Record<string, unknown>）：reply<T> 泛型让 payload 收窄为
    // ServerMessageMap[T] union，组 A 把无 index signature 的 SkillCacheInvalidatedPayload 加进 union 后，
    // 该 union 不再可赋值给 Record<string, unknown>（tsc 报 index signature 缺失）。unknown 类型安全
    // （不假装知道 payload 形状），replies.push 不受影响（数组元素类型含 unknown）。
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
      sendErrorCalls.push({ code, message, id })
    }),
    configService: configService as unknown as IConfigService,
    sessionService: {} as unknown as ISessionService,
    modelService,
    authService: { login: vi.fn(), cancel: vi.fn(), hasOAuth: vi.fn(), getCredential: vi.fn(), saveCredential: vi.fn(), logout: vi.fn() },
    // D3 链 2（M2fg 恒注入形态）：ctx resolver 构造必需，本文件用例不涉凭据——miss 替身
    providerCredentialResolver: {
      hasProviderCredential: vi.fn().mockReturnValue(false),
      listCredentialBackedProviderIds: vi.fn().mockReturnValue(new Set<string>()),
      resolveProviderCredential: vi.fn().mockResolvedValue(undefined),
    },
    skillRegistry: { getGlobalSkills: () => [], getProjectSkills: vi.fn().mockResolvedValue([]) } as unknown as SettingsHandlerContext['skillRegistry'],
    // D-21 端口化：ctx connectionTester 构造必需（本文件直接传 ctx 无 cast，缺字段 tsc 红）
    connectionTester: new ModelConnectionTester(),
    projectRoot: '/proj',
    nextPushId: vi.fn().mockReturnValue('push-1'),
    broadcast: vi.fn((m: ServerMessage) => broadcasts.push(m)),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
  }

  const handler = new SettingsMessageHandler(ctx)
  return { handler, ctx, configService, replies, broadcasts, sendErrorCalls }
}

function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}

const WS = {} as never

describe('SettingsMessageHandler system-prompt routes', () => {
  it('config.getSystemPrompt → reply config.systemPrompt { config, corrupted }', async () => {
    const { handler, ctx, configService, replies } = makeHandler()
    configService.getSystemPromptConfig.mockReturnValue({ config: DEFAULT_CONFIG, corrupted: false })

    const handled = await handler.handleSettingsMessage(msg('config.getSystemPrompt', {}), WS)

    expect(handled).toBe(true)
    expect(configService.getSystemPromptConfig).toHaveBeenCalledTimes(1)
    expect(replies[0]).toMatchObject({
      type: 'config.systemPrompt',
      payload: { config: DEFAULT_CONFIG, corrupted: false },
    })
    // 失败路径不应触发 error envelope
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('config.getSystemPrompt 读取损坏时 corrupted=true 仍正常回复', async () => {
    const { handler, configService, replies } = makeHandler()
    configService.getSystemPromptConfig.mockReturnValue({ config: DEFAULT_CONFIG, corrupted: true })

    await handler.handleSettingsMessage(msg('config.getSystemPrompt', {}), WS)

    expect(replies[0]).toMatchObject({
      type: 'config.systemPrompt',
      payload: { corrupted: true },
    })
  })

  it('config.setSystemPrompt 成功 → 写盘 + reply + broadcast config.systemPrompt', async () => {
    const { handler, configService, replies, broadcasts } = makeHandler()
    const cfg: SystemPromptConfig = {
      version: 1,
      replace: { enabled: true, prompt: 'replace core' },
      append: { enabled: true, prompt: 'append extra' },
    }
    configService.setSystemPromptConfig.mockReturnValue({ ok: true })

    const handled = await handler.handleSettingsMessage(msg('config.setSystemPrompt', { config: cfg }), WS)

    expect(handled).toBe(true)
    expect(configService.setSystemPromptConfig).toHaveBeenCalledExactlyOnceWith(cfg)
    expect(replies[0]).toMatchObject({
      type: 'config.systemPrompt',
      payload: { config: cfg, corrupted: false },
    })
    expect(broadcasts[0]).toMatchObject({
      type: 'config.systemPrompt',
      payload: { config: cfg, corrupted: false },
    })
  })

  it('config.setSystemPrompt 失败 → 按 D10 错误信封回复，不广播', async () => {
    const { handler, configService, replies, broadcasts, sendErrorCalls } = makeHandler()
    const cfg: SystemPromptConfig = {
      version: 1,
      replace: { enabled: true, prompt: 'x'.repeat(16001) },
      append: { enabled: false, prompt: '' },
    }
    configService.setSystemPromptConfig.mockReturnValue({ ok: false, error: 'replace prompt exceeds max length' })

    const handled = await handler.handleSettingsMessage(msg('config.setSystemPrompt', { config: cfg }), WS)

    expect(handled).toBe(true)
    expect(configService.setSystemPromptConfig).toHaveBeenCalledExactlyOnceWith(cfg)
    expect(sendErrorCalls[0]).toMatchObject({
      code: 'set_system_prompt_failed',
      message: 'replace prompt exceeds max length',
      id: 'm1',
    })
    expect(replies).toHaveLength(0)
    expect(broadcasts).toHaveLength(0)
  })
})
