/**
 * SettingsMessageHandler 分发路由特征锚定测试（复杂度债务偿还 W1 回归保护）。
 *
 * 背景：handleSettingsMessage 从 ~50 分支 switch 重构为表驱动分发（routes map + case 体
 * 提取为私有 helper）。本文件锁定此前无测试覆盖的分支（terminal / thinking level /
 * auto-rename / smart-context / deprecated agent 路径 / builtin providers 等），
 * 重构若漂移路由键或 reply 形态，此处先红。
 *
 * 运行：cd packages/runtime && npx vitest run test/settings-message-handler-dispatch.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SettingsMessageHandler, type SettingsHandlerContext } from '../src/transport/settings-message-handler.js'
import { ModelConnectionTester } from '../src/infra/model-connection-tester.js'
import type { ClientMessage, ServerMessage } from '@taiji/shared'

function makeHandler(configOverrides: Record<string, ReturnType<typeof vi.fn>> = {}, modelOverrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const broadcasts: ServerMessage[] = []
  const replies: { id: string; type: string; payload: Record<string, unknown> }[] = []
  const sendErrorCalls: { id: string | undefined; code: string; message: string }[] = []
  const configService = {
    listProviders: vi.fn().mockReturnValue([{ id: 'p1' }]),
    getScopedModels: vi.fn().mockReturnValue([]),
    modifyScopedModels: vi.fn(async (fn: (current: string[]) => string[]) => fn([])),
    applyImportProviders: vi.fn().mockResolvedValue({ result: {} }),
    refreshProviderCatalogs: vi.fn().mockResolvedValue({ refreshed: [], failed: [] }),
    getProvider: vi.fn().mockReturnValue(undefined),
    updateToolPermissions: vi.fn(),
    loadSkills: vi.fn().mockReturnValue([]),
    scanSkills: vi.fn().mockReturnValue([]),
    upsertSkill: vi.fn(),
    deleteSkill: vi.fn(),
    setSkillDirs: vi.fn(),
    loadAgents: vi.fn().mockReturnValue([]),
    scanAgents: vi.fn().mockReturnValue([]),
    upsertAgent: vi.fn(),
    deleteAgent: vi.fn(),
    setAgentDirs: vi.fn(),
    setExtensionDirs: vi.fn(),
    listBuiltinProviders: vi.fn().mockReturnValue([]),
    setDefaultModel: vi.fn(),
    getDefaultModel: vi.fn().mockReturnValue(null),
    getSystemPromptConfig: vi.fn().mockReturnValue({ config: {}, corrupted: false }),
    setSystemPromptConfig: vi.fn().mockReturnValue({ ok: true }),
    getTerminalConfig: vi.fn().mockReturnValue({ config: {}, corrupted: false }),
    setTerminalConfig: vi.fn().mockReturnValue({ ok: true }),
    getAutoRenameEnabled: vi.fn().mockReturnValue(false),
    setAutoRenameEnabled: vi.fn(),
    getRenameModel: vi.fn().mockReturnValue('p/m'),
    setRenameModel: vi.fn(),
    getSmartContextConfig: vi.fn().mockReturnValue({ enabled: false, compactModel: '', reminderThresholds: {}, excludedModels: [] }),
    setSmartContextEnabled: vi.fn(),
    setSmartContextThresholds: vi.fn(),
    ...configOverrides,
  }
  const modelService = {
    aggregateModels: vi.fn().mockReturnValue([]),
    switchModel: vi.fn().mockResolvedValue('p1/m1'),
    setThinkingLevel: vi.fn().mockResolvedValue(undefined),
    discoverModelsFromApi: vi.fn().mockResolvedValue([]),
    ...modelOverrides,
  }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string, type: string, payload: Record<string, unknown>) => replies.push({ id, type, payload })),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => sendErrorCalls.push({ id, code, message })),
    configService,
    sessionService: {},
    modelService,
    authService: {
      login: vi.fn().mockReturnValue({ started: true }),
      cancel: vi.fn().mockReturnValue({ cancelled: false }),
      hasOAuth: vi.fn().mockResolvedValue(false),
      logout: vi.fn().mockResolvedValue(undefined),
    },
    skillRegistry: {
      getGlobalSkills: vi.fn().mockReturnValue([]),
      getProjectSkills: vi.fn().mockResolvedValue([]),
      rebuildGlobal: vi.fn().mockResolvedValue(undefined),
      invalidateAllProjects: vi.fn(),
    },
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
    connectionTester: new ModelConnectionTester(),
  }
  const handler = new SettingsMessageHandler(ctx as unknown as SettingsHandlerContext)
  return { ctx, replies, broadcasts, sendErrorCalls, handler }
}

function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}
const WS = {} as never

describe('SettingsMessageHandler 分发路由（W1 表驱动重构回归锚定）', () => {
  it('session.setThinkingLevel → reply session.thinkingLevelSet 回传生效值（P3：非请求值）', async () => {
    const setThinkingLevel = vi.fn().mockResolvedValue('high')
    const { ctx, replies, handler } = makeHandler({}, { setThinkingLevel })
    const handled = await handler.handleSettingsMessage(msg('session.setThinkingLevel', { sessionId: 's1', level: 'max' }), WS)
    expect(handled).toBe(true)
    expect(ctx.modelService.setThinkingLevel).toHaveBeenCalledWith('s1', 'max')
    // 生效值（钳制后）而非请求值
    expect(replies[0]).toMatchObject({ id: 'm1', type: 'session.thinkingLevelSet', payload: { sessionId: 's1', level: 'high' } })
  })

  describe('config.getTerminalConfig / setTerminalConfig（system-prompt 同构，此前无 handler 层测试）', () => {
    it('getTerminalConfig → reply config.terminalConfig { config, corrupted } 透传', async () => {
      const getTerminalConfig = vi.fn().mockReturnValue({ config: { fontSize: 12 }, corrupted: true })
      const { ctx, replies, handler } = makeHandler({ getTerminalConfig })
      const handled = await handler.handleSettingsMessage(msg('config.getTerminalConfig', {}), WS)
      expect(handled).toBe(true)
      expect(ctx.configService.getTerminalConfig).toHaveBeenCalledOnce()
      expect(replies[0]).toMatchObject({ id: 'm1', type: 'config.terminalConfig', payload: { config: { fontSize: 12 }, corrupted: true } })
    })

    it('setTerminalConfig 成功 → reply + broadcast config.terminalConfig（corrupted=false）', async () => {
      const { ctx, replies, broadcasts, handler } = makeHandler()
      const handled = await handler.handleSettingsMessage(msg('config.setTerminalConfig', { config: { fontSize: 14 } }), WS)
      expect(handled).toBe(true)
      expect(ctx.configService.setTerminalConfig).toHaveBeenCalledWith({ fontSize: 14 })
      expect(replies[0]).toMatchObject({ type: 'config.terminalConfig', payload: { config: { fontSize: 14 }, corrupted: false } })
      const b = broadcasts.find(m => m.type === 'config.terminalConfig')
      expect(b).toBeDefined()
      expect(b?.payload).toMatchObject({ config: { fontSize: 14 }, corrupted: false })
    })

    it('setTerminalConfig 失败 → sendError(set_terminal_config_failed)，不 reply 不广播', async () => {
      const { ctx, replies, broadcasts, sendErrorCalls, handler } = makeHandler({
        setTerminalConfig: vi.fn().mockReturnValue({ ok: false, error: 'timeout out of range' }),
      })
      const handled = await handler.handleSettingsMessage(msg('config.setTerminalConfig', { config: {} }), WS)
      expect(handled).toBe(true)
      expect(sendErrorCalls[0]).toMatchObject({ id: 'm1', code: 'set_terminal_config_failed', message: 'timeout out of range' })
      expect(replies).toHaveLength(0)
      expect(broadcasts.filter(b => b.type === 'config.terminalConfig')).toHaveLength(0)
    })
  })

  describe('auto-rename / rename-model 简单读写转发', () => {
    it('config.setAutoRenameEnabled → 写 + reply 回读值', async () => {
      const setAutoRenameEnabled = vi.fn()
      const { ctx, replies, handler } = makeHandler({ setAutoRenameEnabled, getAutoRenameEnabled: vi.fn().mockReturnValue(true) })
      const handled = await handler.handleSettingsMessage(msg('config.setAutoRenameEnabled', { enabled: true }), WS)
      expect(handled).toBe(true)
      expect(ctx.configService.setAutoRenameEnabled).toHaveBeenCalledWith(true)
      expect(replies[0]).toMatchObject({ type: 'config.autoRenameEnabled', payload: { enabled: true } })
    })

    it('config.setRenameModel → 写 + reply 回读值', async () => {
      const setRenameModel = vi.fn()
      const { ctx, replies, handler } = makeHandler({ setRenameModel, getRenameModel: vi.fn().mockReturnValue('p/new') })
      const handled = await handler.handleSettingsMessage(msg('config.setRenameModel', { model: 'p/new' }), WS)
      expect(handled).toBe(true)
      expect(ctx.configService.setRenameModel).toHaveBeenCalledWith('p/new')
      expect(replies[0]).toMatchObject({ type: 'config.renameModel', payload: { model: 'p/new' } })
    })
  })

  describe('smart-context 配置组抽样', () => {
    it('config.setSmartContextEnabled → 写 + reply smartContextEnabled 回读 enabled', async () => {
      const { ctx, replies, handler } = makeHandler({
        setSmartContextEnabled: vi.fn(),
        getSmartContextConfig: vi.fn().mockReturnValue({ enabled: true, compactModel: 'p/m', reminderThresholds: {}, excludedModels: [] }),
      })
      const handled = await handler.handleSettingsMessage(msg('config.setSmartContextEnabled', { enabled: true }), WS)
      expect(handled).toBe(true)
      expect(ctx.configService.setSmartContextEnabled).toHaveBeenCalledWith(true)
      expect(replies[0]).toMatchObject({ type: 'config.smartContextEnabled', payload: { enabled: true } })
    })

    it('config.setSmartContextThresholds → reply smartContextThresholds 回读 reminderThresholds', async () => {
      const thresholds = { warn: 0.7 }
      const { ctx, replies, handler } = makeHandler({
        getSmartContextConfig: vi.fn().mockReturnValue({ enabled: true, compactModel: '', reminderThresholds: thresholds, excludedModels: [] }),
      })
      const handled = await handler.handleSettingsMessage(msg('config.setSmartContextThresholds', { thresholds }), WS)
      expect(handled).toBe(true)
      expect(ctx.configService.setSmartContextThresholds).toHaveBeenCalledWith(thresholds)
      expect(replies[0]).toMatchObject({ type: 'config.smartContextThresholds', payload: { thresholds } })
    })
  })

  it('config.setExtensionDirs → 写 + reply config.extensionDirs + broadcastExtensionDirs', async () => {
    const { ctx, replies, handler } = makeHandler()
    const handled = await handler.handleSettingsMessage(msg('config.setExtensionDirs', { dirs: ['/a', '/b'] }), WS)
    expect(handled).toBe(true)
    expect(ctx.configService.setExtensionDirs).toHaveBeenCalledWith(['/a', '/b'])
    expect(replies[0]).toMatchObject({ id: 'm1', type: 'config.extensionDirs', payload: { dirs: ['/a', '/b'] } })
    expect(ctx.broadcastExtensionDirs).toHaveBeenCalledOnce()
  })

  describe('@deprecated agent 兼容路径（ADR-0021 §5 兼容期，仍须活）', () => {
    it('config.setAgent → upsertAgent + reply config.agentUpdated + broadcastAgentList', async () => {
      const agent = { id: 'a1', name: 'A' }
      const { ctx, replies, handler } = makeHandler()
      const handled = await handler.handleSettingsMessage(msg('config.setAgent', { agent }), WS)
      expect(handled).toBe(true)
      expect(ctx.configService.upsertAgent).toHaveBeenCalledWith(agent)
      expect(replies[0]).toMatchObject({ type: 'config.agentUpdated', payload: { agent, success: true } })
      expect(ctx.broadcastAgentList).toHaveBeenCalledOnce()
    })

    it('config.deleteAgent → deleteAgent + reply config.agentDeleted + broadcastAgentList', async () => {
      const { ctx, replies, handler } = makeHandler()
      const handled = await handler.handleSettingsMessage(msg('config.deleteAgent', { agentId: 'a1' }), WS)
      expect(handled).toBe(true)
      expect(ctx.configService.deleteAgent).toHaveBeenCalledWith('a1')
      expect(replies[0]).toMatchObject({ type: 'config.agentDeleted', payload: { agentId: 'a1', success: true } })
      expect(ctx.broadcastAgentList).toHaveBeenCalledOnce()
    })
  })

  it('config.listBuiltinProviders → reply config.builtinProviders（只读无广播）', async () => {
    const listBuiltinProviders = vi.fn().mockReturnValue([{ id: 'b1' }])
    const { ctx, replies, broadcasts, handler } = makeHandler({ listBuiltinProviders })
    const handled = await handler.handleSettingsMessage(msg('config.listBuiltinProviders', {}), WS)
    expect(handled).toBe(true)
    expect(replies[0]).toMatchObject({ type: 'config.builtinProviders', payload: { providers: [{ id: 'b1' }] } })
    expect(ctx.broadcastProviderList).not.toHaveBeenCalled()
    expect(broadcasts).toHaveLength(0)
  })

  it('config.setToolPermissions → updateToolPermissions + reply config.providerUpdated { saved: true }', async () => {
    const { ctx, replies, handler } = makeHandler()
    const handled = await handler.handleSettingsMessage(msg('config.setToolPermissions', { permissions: { bash: 'allow' } }), WS)
    expect(handled).toBe(true)
    expect(ctx.configService.updateToolPermissions).toHaveBeenCalledWith({ bash: 'allow' })
    expect(replies[0]).toMatchObject({ type: 'config.providerUpdated', payload: { saved: true } })
  })

  it('未知 type（非 tool.* 占位）→ 查表落空返回 false（server 发 unknown_type 兜底）', async () => {
    const { handler } = makeHandler()
    const handled = await handler.handleSettingsMessage(msg('config.nonexistent', {}), WS)
    expect(handled).toBe(false)
  })
})
