/**
 * SettingsMessageHandler 单测 — 覆盖 config/model 分支路由 + 副作用广播（report #5）。
 *
 * 重点：
 * - setProvider/deleteProvider 带 newDefault 时广播 config.defaults（有副作用分支，最该补）
 * - discoverModels 三种错误翻译（ByteString / fetch failed / 原始）
 * - 基础路由：getProviders / model.list / model.switch / scanSkills / tool.approve
 *
 * 运行：pnpm --filter @xyz-agent/runtime run test -- test/settings-message-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { SettingsMessageHandler } from '../src/transport/settings-message-handler.js'
import { RuntimeServer } from '../src/transport/server.js'
import { ModelConnectionTester } from '../src/infra/model-connection-tester.js'
import { createMockSessionServiceClass } from './helpers/service-mocks.js'
import type { ISessionService } from '../src/interfaces.js'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import {
  writeModels,
  refreshModels,
  setModelsPath,
  getDefaultModel as piProviderGetDefaultModel,
} from '../src/infra/pi/pi-provider-store.js'
import { setSettingsPath, readSettings } from '../src/infra/pi/pi-settings-store.js'

const mkdtempP = promisify(mkdtemp)
const rmP = promisify(rm)

function makeHandler(overrides: { setProvider?: ReturnType<typeof vi.fn>; deleteProvider?: ReturnType<typeof vi.fn>; toggleProviderEnabled?: ReturnType<typeof vi.fn>; removeProviderByKind?: ReturnType<typeof vi.fn>; getDefaultModel?: ReturnType<typeof vi.fn>; setDefaultModel?: ReturnType<typeof vi.fn>; listProviders?: ReturnType<typeof vi.fn>; applyImportProviders?: ReturnType<typeof vi.fn>; discover?: ReturnType<typeof vi.fn>; aggregate?: ReturnType<typeof vi.fn>; oauthLogin?: ReturnType<typeof vi.fn>; oauthCancel?: ReturnType<typeof vi.fn>; oauthLogout?: ReturnType<typeof vi.fn>; modifyScopedModels?: ReturnType<typeof vi.fn>; resolver?: unknown; testProviderConnections?: ReturnType<typeof vi.fn> } = {}) {
  const broadcasts: ServerMessage[] = []
  const replies: { id: string; type: string; payload: Record<string, unknown> }[] = []
  const sendErrorCalls: { code: string; message: string }[] = []
  const configService = {
    listProviders: overrides.listProviders ?? vi.fn().mockReturnValue([{ id: 'p1' }]),
    checkEnvVars: vi.fn().mockReturnValue({}),
    setProvider: overrides.setProvider ?? vi.fn().mockReturnValue({}),
    deleteProvider: overrides.deleteProvider ?? vi.fn().mockResolvedValue({}),
    toggleProviderEnabled: overrides.toggleProviderEnabled ?? vi.fn().mockReturnValue({}),
    removeProviderByKind: overrides.removeProviderByKind ?? vi.fn().mockResolvedValue({}),
    setDefaultModel: overrides.setDefaultModel ?? vi.fn(),
    getDefaultModel: overrides.getDefaultModel ?? vi.fn().mockReturnValue(null),
    getScopedModels: vi.fn(() => []),
    // config.setScopedModels 写入口（scoped-model design）：默认执行 handler 传入的写入函数
    modifyScopedModels: overrides.modifyScopedModels ?? vi.fn(async (fn: (current: string[]) => string[]) => fn([])),
    applyImportProviders: overrides.applyImportProviders ?? vi.fn().mockResolvedValue({ result: {} }),
    // D9：applyImportProviders 成功路径 fire-and-forget 调 refreshProviderCatalogs（完成后二次
    // 广播 provider 列表）。mock 缺失会在成功分支同步 TypeError 中断 handler（Gate A 曾 3 failed）。
    // 返回形态对齐真实 configService.refreshProviderCatalogs（CatalogRefreshResult）。
    refreshProviderCatalogs: vi.fn().mockResolvedValue({ refreshed: [], failed: [] }),
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
  }
  const modelService = {
    aggregateModels: overrides.aggregate ?? vi.fn().mockReturnValue([{ id: 'm1' }]),
    switchModel: vi.fn().mockResolvedValue('p1/m1'),
    setThinkingLevel: vi.fn().mockResolvedValue(undefined),
    discoverModelsFromApi: overrides.discover ?? vi.fn().mockResolvedValue([{ id: 'm1' }]),
    // M3a test 模式编排面（可选交集）：缺省不装配——未注入时 handler 走 test_unavailable 防御分支
    ...(overrides.testProviderConnections ? { testProviderConnections: overrides.testProviderConnections } : {}),
  }
  const skillRegistry = {
    getGlobalSkills: vi.fn().mockReturnValue([]),
    getProjectSkills: vi.fn().mockResolvedValue([]),
    rebuildGlobal: vi.fn().mockResolvedValue(undefined),
    invalidateAllProjects: vi.fn(),
  }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string, type: string, payload: Record<string, unknown>) => replies.push({ id, type, payload })),
    sendError: vi.fn((_ws: unknown, code: string, message: string) => sendErrorCalls.push({ code, message })),
    configService,
    sessionService: {},
    modelService,
    authService: {
      login: overrides.oauthLogin ?? vi.fn().mockReturnValue({ started: true }),
      cancel: overrides.oauthCancel ?? vi.fn().mockReturnValue({ cancelled: false }),
      hasOAuth: vi.fn().mockResolvedValue(false),
      logout: overrides.oauthLogout ?? vi.fn().mockResolvedValue(undefined),
      getCredential: vi.fn().mockResolvedValue(undefined),
      saveCredential: vi.fn().mockResolvedValue(undefined),
    },
    // D3 链 2（M2fg 恒注入形态）：ctx resolver 构造必需——缺省注入 miss 形态替身
    // （resolve 返回 undefined = 「无凭据」），需要命中场景的用例经 overrides.resolver 传入。
    providerCredentialResolver: overrides.resolver ?? {
      resolveProviderCredential: vi.fn().mockResolvedValue(undefined),
    },
    // D-21 端口化：ctx connectionTester 构造必需（恒注入形态，原 handler 自建实例迁组合根）——
    // 注入真实例保持 M3a mode=test 用例对第 3 参 tester（.test 为函数）的断言等价。
    connectionTester: new ModelConnectionTester(),
    skillRegistry,
    projectRoot: '/proj',
    nextPushId: vi.fn().mockReturnValue('p1'),
    broadcast: vi.fn((m: ServerMessage) => broadcasts.push(m)),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
  }
  const handler = new SettingsMessageHandler(ctx as unknown as ConstructorParameters<typeof SettingsMessageHandler>[0])
  return { ctx, replies, broadcasts, handler, sendErrorCalls }
}

function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}
const WS = {} as never

describe('SettingsMessageHandler', () => {
  describe('provider 副作用广播（最该补）', () => {
    it('setProvider 无 newDefault → 仅 reply + broadcastProviderList，不广播 config.defaults', async () => {
      const { ctx, broadcasts, handler } = makeHandler({ setProvider: vi.fn().mockReturnValue({}) })
      await handler.handleSettingsMessage(msg('config.setProvider', { providerId: 'p1', name: 'x' }), WS)
      expect(ctx.broadcastProviderList).toHaveBeenCalledOnce()
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
    })

    it('setProvider 有 newDefault → 广播 config.defaults (source=provider-updated)', async () => {
      const { broadcasts, handler } = makeHandler({
        setProvider: vi.fn().mockReturnValue({ newDefault: { provider: 'p1', modelId: 'm1' } }),
      })
      await handler.handleSettingsMessage(msg('config.setProvider', { providerId: 'p1', name: 'x' }), WS)
      const d = broadcasts.find(b => b.type === 'config.defaults')
      expect(d).toBeDefined()
      expect(d?.payload).toMatchObject({ defaultModel: 'p1/m1', source: 'provider-updated' })
    })

    it('deleteProvider 有 newDefault → 广播 config.defaults (source=provider-deleted)', async () => {
      const { broadcasts, handler } = makeHandler({
        deleteProvider: vi.fn().mockResolvedValue({ newDefault: { provider: 'p2', modelId: 'm2' } }),
      })
      await handler.handleSettingsMessage(msg('config.deleteProvider', { providerId: 'p1' }), WS)
      const d = broadcasts.find(b => b.type === 'config.defaults')
      expect(d?.payload).toMatchObject({ defaultModel: 'p2/m2', source: 'provider-deleted' })
    })
  })

  describe('config.setDefaultModel（W3 默认模型持久化）', () => {
    it('调 configService.setDefaultModel(provider, modelId) + reply config.defaults + 广播给所有 panel', async () => {
      // W3：前端设置默认模型。handler 路由到 configService.setDefaultModel（已存在，写 settings.json），
      // 回发起端 reply config.defaults，并广播给所有 panel（与 setProvider/deleteProvider 的
      // newDefault 广播同构），让其它打开的设置面板同步默认模型下拉。
      const { ctx, replies, broadcasts, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('config.setDefaultModel', { provider: 'p1', modelId: 'm1' }), WS)
      expect(ctx.configService.setDefaultModel).toHaveBeenCalledWith('p1', 'm1')
      // reply：回发起端，defaultModel 形如 "provider/modelId"
      expect(replies[0]).toMatchObject({ type: 'config.defaults', payload: { defaultModel: 'p1/m1' } })
      // 广播：推给所有 panel
      const d = broadcasts.find(b => b.type === 'config.defaults')
      expect(d).toBeDefined()
      expect(d?.payload).toMatchObject({ defaultModel: 'p1/m1' })
    })
  })

  describe('基础路由', () => {
    it('config.getProviders → reply config.providers（含 scopedModels 透传，design §3.3 D7）', async () => {
      const { ctx, replies, handler } = makeHandler()
      // mock 非空数组验证透传（默认 mock 返回 []，空值断言无区分力）
      ;(ctx.configService.getScopedModels as ReturnType<typeof vi.fn>).mockReturnValue(['p1/m1', 'p2/m2'])
      await handler.handleSettingsMessage(msg('config.getProviders', {}), WS)
      expect(replies[0]).toMatchObject({ type: 'config.providers', payload: { providers: [{ id: 'p1' }], scopedModels: ['p1/m1', 'p2/m2'] } })
    })
    it('model.list → aggregateModels + reply', async () => {
      const { replies, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('model.list', {}), WS)
      expect(replies[0]).toMatchObject({ type: 'model.list', payload: { models: [{ id: 'm1' }] } })
    })
    it('model.switch → switchModel 调用 + reply model.switched', async () => {
      const { ctx, replies, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('model.switch', { sessionId: 's1', provider: 'p1', modelId: 'm1' }), WS)
      expect(ctx.modelService.switchModel).toHaveBeenCalledWith('s1', 'p1', 'm1')
      expect(replies[0]).toMatchObject({ type: 'model.switched' })
    })
    it('config.scanSkills → reply scannedSkills + 广播 config.skills（修裂缝①）', async () => {
      const { replies, ctx, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('config.scanSkills', { sources: ['/x'] }), WS)
      expect(replies[0]).toMatchObject({ type: 'config.scannedSkills', payload: { success: true } })
      // 裂缝①核心修复：扫描后必须广播，让前端 onSkills 订阅推回
      expect(ctx.broadcastSkillList).toHaveBeenCalledOnce()
    })

    // ── W2（cw-2026-07-21-scan-project-agents-skills）：config.scanSessionSkills RPC ──
    // 按 session cwd 拉 project skill（.agents/skills + .xyz-agent/skills 扫描结果）。
    // 与 config.scanSkills 区分：scanSkills 扫 sources 数组候选加入 discovery + 广播；
    // scanSessionSkills 扫某 cwd 的已生效目录 + 不广播（按需 RPC）。
    it('W2: config.scanSessionSkills → loadSkills(cwd) + reply config.sessionSkills，不广播', async () => {
      const { replies, ctx, handler } = makeHandler()
      // mock loadSkills 返回项目 skill
      ;(ctx.configService.loadSkills as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: 's1', name: 'proj-skill', description: 'proj', enabled: true, source: 'agents', effective: true },
      ])

      await handler.handleSettingsMessage(msg('config.scanSessionSkills', { cwd: '/user-project' }), WS)

      // 关键：loadSkills 用传入的 cwd 调用（非全局 projectRoot）
      expect(ctx.configService.loadSkills).toHaveBeenCalledWith('/user-project')
      // reply 类型 config.sessionSkills（与 config.skills 区分，后者是全局广播）
      expect(replies[0]).toMatchObject({ type: 'config.sessionSkills', payload: { skills: expect.any(Array) } })
      // 不广播（按需 RPC，不污染全局 config.skills）
      expect(ctx.broadcastSkillList).not.toHaveBeenCalled()
    })
    it('config.scanAgents → 广播 config.agents（修裂缝①）', async () => {
      const { ctx, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('config.scanAgents', { sources: ['/x'] }), WS)
      expect(ctx.broadcastAgentList).toHaveBeenCalledOnce()
    })
    it('config.setSkillDirs → 写 discovery + 广播 skill 列表 + 目录配置', async () => {
      const { replies, ctx, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('config.setSkillDirs', { dirs: ['~/.pi/agent/skills', '~/.claude/skills'] }), WS)
      expect(ctx.configService.setSkillDirs).toHaveBeenCalledWith(['~/.pi/agent/skills', '~/.claude/skills'])
      expect(replies[0]).toMatchObject({ type: 'config.skillDirs' })
      expect(ctx.broadcastSkillList).toHaveBeenCalledOnce()
      expect(ctx.broadcastSkillDirs).toHaveBeenCalledOnce()
    })
    it('config.setAgentDirs → 写 discovery + 广播 agent 列表 + 目录配置', async () => {
      const { ctx, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('config.setAgentDirs', { dirs: ['~/.agents/agents'] }), WS)
      expect(ctx.configService.setAgentDirs).toHaveBeenCalledWith(['~/.agents/agents'])
      expect(ctx.broadcastAgentList).toHaveBeenCalledOnce()
      expect(ctx.broadcastAgentDirs).toHaveBeenCalledOnce()
    })
    it('tool.approve/deny/always_allow → 落入 default return false（no-op 已移除，由 server unknown_type 兜底）', async () => {
      // 工具审批实际走 pi extension_ui_request (confirm) 流 + config.setToolPermissions，
      // 这些 type 无真实 handler，故 return false → server 发 unknown_type（对未知 type 的正确兜底）。
      const { handler } = makeHandler()
      const okApprove = await handler.handleSettingsMessage(msg('tool.approve', {}), WS)
      const okDeny = await handler.handleSettingsMessage(msg('tool.deny', {}), WS)
      const okAlways = await handler.handleSettingsMessage(msg('tool.always_allow', {}), WS)
      expect(okApprove).toBe(false)
      expect(okDeny).toBe(false)
      expect(okAlways).toBe(false)
    })
  })

  describe('discoverModels（handler 只 reply，错误翻译已下沉 model-service）', () => {
    it('成功 → reply discoveredModels success:true', async () => {
      const { replies, handler } = makeHandler({ discover: vi.fn().mockResolvedValue([{ id: 'm1' }]) })
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: 'http://x', apiKey: 'k' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
      expect(replies[0].payload).toMatchObject({ success: true, models: [{ id: 'm1' }] })
    })
    it('service 抛错 → handler 透传 error.message（不再做翻译）', async () => {
      // model-service 已把 ByteString/fetch failed 翻译成中文文案（见 model-service.test.ts）；
      // handler 只 reply service 给的 message，不硬编码中文。
      const { replies, handler } = makeHandler({ discover: vi.fn().mockRejectedValue(new Error('请求失败：Base URL 或 API Key 包含 HTTP 不支持的字符')) })
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: 'http://x' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
      expect(replies[0].payload.success).toBe(false)
      expect(replies[0].payload.error).toContain('不支持的字符')
    })
    it('其他错误 → 原始消息透传', async () => {
      const { replies, handler } = makeHandler({ discover: vi.fn().mockRejectedValue(new Error('rate limited')) })
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: 'http://x' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
      expect(replies[0].payload.error).toBe('rate limited')
    })
    it('providerId 解析 apiKey（resolvedApiKey 传给 service）', async () => {
      // M2fg 恒注入形态：凭据回查经 ctx 构造必需的 resolver（models.json 直查回退已删除）
      const { ctx, replies, handler } = makeHandler({
        resolver: { resolveProviderCredential: vi.fn().mockResolvedValue({ key: 'resolved-key', source: 'models.json' }) },
      })
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: 'http://x', providerId: 'p1' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
      expect(ctx.modelService.discoverModelsFromApi).toHaveBeenCalledWith('http://x', 'resolved-key', undefined)
    })
    it('注入 resolver：凭据只在 auth.json（models.json 无 apiKey）时命中（链 2 断链修复）', async () => {
      // 旧实现只查 configService.getProvider(providerId)?.apiKey（models.json），对 catalog
      // provider 恒 miss；resolver 命中 auth.json → discover 能拿到凭据
      const resolver = {
        resolveProviderCredential: vi.fn().mockResolvedValue({ key: 'auth-json-key', source: 'auth.json' }),
      }
      const { ctx, replies, handler } = makeHandler({ resolver })
      // models.json 无该 provider（旧路径必 miss 的可证伪信号）
      ctx.configService.getProvider = vi.fn().mockReturnValue(undefined) as never
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: 'http://x', providerId: 'anthropic' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
      expect(resolver.resolveProviderCredential).toHaveBeenCalledWith('anthropic')
      expect(ctx.modelService.discoverModelsFromApi).toHaveBeenCalledWith('http://x', 'auth-json-key', undefined)
    })
    it('payload 自带 apiKey → 不走 resolver（表单值优先）', async () => {
      const resolver = { resolveProviderCredential: vi.fn().mockResolvedValue({ key: 'ignored', source: 'auth.json' }) }
      const { ctx, replies, handler } = makeHandler({ resolver })
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: 'http://x', apiKey: 'form-key', providerId: 'p1' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
      expect(resolver.resolveProviderCredential).not.toHaveBeenCalled()
      expect(ctx.modelService.discoverModelsFromApi).toHaveBeenCalledWith('http://x', 'form-key', undefined)
    })
    it('resolver 未命中（auth.json/models.json 两段全 miss）→ 凭据 undefined', async () => {
      // M2fg：默认 miss 形态 resolver → resolvedApiKey undefined（降级链已删除，恒注入可证伪）
      const { ctx, replies, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: 'http://x', providerId: 'anthropic' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
      expect(ctx.configService.getProvider).not.toHaveBeenCalled()
      expect(ctx.modelService.discoverModelsFromApi).toHaveBeenCalledWith('http://x', undefined, undefined)
    })
  })

  // ── M3a：mode === 'test' 分支（per-协议真实最小请求；缺省 discover 向后兼容）──
  describe('discoverModels mode=test（per-协议真实连接测试）', () => {
    it('mode=test → 走 testProviderConnections（不再走 GET /v1/models），reply results 原样', async () => {
      const testProviderConnections = vi.fn().mockResolvedValue({
        success: true,
        results: [
          { api: 'anthropic-messages', modelId: 'k3', ok: true },
          { api: 'openai-completions', modelId: 'qwen3.8-flash', ok: false, error: 'http_error|401|unauthorized' },
        ],
      })
      const { ctx, replies, handler } = makeHandler({ testProviderConnections })
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: '', providerId: 'opencode-go', mode: 'test' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
      expect(ctx.modelService.discoverModelsFromApi).not.toHaveBeenCalled()
      expect(replies[0].type).toBe('config.discoveredModels')
      expect(replies[0].payload).toEqual({
        models: [],
        success: true,
        results: [
          { api: 'anthropic-messages', modelId: 'k3', ok: true },
          { api: 'openai-completions', modelId: 'qwen3.8-flash', ok: false, error: 'http_error|401|unauthorized' },
        ],
      })
    })

    it('mode=test + providerId → 凭据经 resolver 唯一通道取（payload apiKey 被忽略）', async () => {
      const resolver = { resolveProviderCredential: vi.fn().mockResolvedValue({ key: 'auth-key', source: 'auth.json' }) }
      const testProviderConnections = vi.fn().mockResolvedValue({ success: true, results: [] })
      const { ctx, handler } = makeHandler({ resolver, testProviderConnections })
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: '', providerId: 'anthropic', apiKey: 'form-key', mode: 'test' }), WS)
      await vi.waitFor(() => expect(testProviderConnections).toHaveBeenCalled())
      expect(resolver.resolveProviderCredential).toHaveBeenCalledWith('anthropic')
      // 第 1 参 providerId、第 2 参 = resolver 明文、第 3 参 = infra tester（组合点）
      expect(testProviderConnections.mock.calls[0][0]).toBe('anthropic')
      expect(testProviderConnections.mock.calls[0][1]).toBe('auth-key')
      expect(typeof (testProviderConnections.mock.calls[0][2] as { test?: unknown }).test).toBe('function')
      expect(ctx.modelService.discoverModelsFromApi).not.toHaveBeenCalled()
    })

    it('mode=test 缺 providerId → provider_not_found（不发任何请求）', async () => {
      const testProviderConnections = vi.fn()
      const { replies, handler } = makeHandler({ testProviderConnections })
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: '', mode: 'test' }), WS)
      expect(replies[0].payload).toEqual({ models: [], success: false, error: 'provider_not_found', results: [] })
      expect(testProviderConnections).not.toHaveBeenCalled()
    })

    it('modelService 未装配 testProviderConnections → test_unavailable 防御分支', async () => {
      const { replies, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: '', providerId: 'p1', mode: 'test' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
      expect(replies[0].payload).toMatchObject({ success: false, error: 'test_unavailable' })
    })

    it('以 ctx.modelService 为 this 调用编排面（真实实现方法体依赖 this.configService）', async () => {
      let seenThis: unknown
      const testProviderConnections = vi.fn(function (this: unknown) {
        seenThis = this
        return Promise.resolve({ success: true, results: [] })
      })
      const { ctx, replies, handler } = makeHandler({ testProviderConnections })
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: '', providerId: 'p1', mode: 'test' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
      expect(seenThis).toBe(ctx.modelService)
    })

    it('mode 缺省 → 走既有 discover 路径（向后兼容：CLI / 旧调用方零改动）', async () => {
      const testProviderConnections = vi.fn()
      const discover = vi.fn().mockResolvedValue([{ id: 'm1' }])
      const { ctx, replies, handler } = makeHandler({ discover, testProviderConnections })
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: 'http://x', apiKey: 'k' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
      expect(testProviderConnections).not.toHaveBeenCalled()
      expect(ctx.modelService.discoverModelsFromApi).toHaveBeenCalledWith('http://x', 'k', undefined)
      expect(replies[0].payload).toMatchObject({ success: true, models: [{ id: 'm1' }] })
    })

    it("mode='discover' 显式传入 → 同缺省（走 GET /v1/models）", async () => {
      const testProviderConnections = vi.fn()
      const { ctx, replies, handler } = makeHandler({ testProviderConnections })
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: 'http://x', apiKey: 'k', mode: 'discover' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
      expect(testProviderConnections).not.toHaveBeenCalled()
      expect(ctx.modelService.discoverModelsFromApi).toHaveBeenCalledOnce()
    })
  })

  // ── W2：config.setSkillDirs 触发 SkillRegistry 重建链 + 广播失效信号 ──
  // TC5 等效渲染 gate：断言广播消息被构造（broadcastSkillCacheInvalidated('project') 被调用）
  //   + rebuildGlobal/invalidateAllProjects 被调（重建链触发）+ broadcastSkillDirs/SkillList 仍服务 settings 弹窗。
  describe('config.setSkillDirs（W2 重建链 + 广播失效信号）', () => {
    it('TC5: 触发 rebuildGlobal → invalidateAllProjects → broadcastSkillCacheInvalidated("project")，并保留 broadcastSkillDirs/SkillList', async () => {
      const { ctx, replies, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('config.setSkillDirs', { dirs: ['~/.pi/agent/skills', '~/.claude/skills'] }), WS)
      // rebuildGlobal 是 fire-and-forget（.then 微任务），用 waitFor 等链路完成
      await vi.waitFor(() => expect(ctx.skillRegistry.invalidateAllProjects).toHaveBeenCalled())

      // 写 discovery.skillDirs
      expect(ctx.configService.setSkillDirs).toHaveBeenCalledWith(['~/.pi/agent/skills', '~/.claude/skills'])
      // reply 配置回执
      expect(replies[0]).toMatchObject({ type: 'config.skillDirs' })
      // 重建链：rebuildGlobal（重扫 globalCache + 重挂 watcher）+ invalidateAllProjects（清 projectCache）
      expect(ctx.skillRegistry.rebuildGlobal).toHaveBeenCalledOnce()
      expect(ctx.skillRegistry.invalidateAllProjects).toHaveBeenCalledOnce()
      // 渲染 gate：广播失效信号（'project' scope，让前端 useProjectSkills 失效重拉）
      expect(ctx.broadcastSkillCacheInvalidated).toHaveBeenCalledWith('project')
      // settings 弹窗链路保留：broadcastSkillDirs + broadcastSkillList（服务 settingsStore）
      expect(ctx.broadcastSkillDirs).toHaveBeenCalledOnce()
      expect(ctx.broadcastSkillList).toHaveBeenCalledOnce()
    })
  })

  // ── OAuth Login（路径 B，T6）：config.oauthLogin / config.oauthCancel 路由 ──
  describe('config.oauthLogin / config.oauthCancel（OAuth 路径 B RPC）', () => {    it('oauthLogin 成功 → reply config.oauthLoginReply { started: true }', async () => {
      const { replies, handler } = makeHandler()
      const handled = await handler.handleSettingsMessage(msg('config.oauthLogin', { providerId: 'anthropic' }), WS)
      expect(handled).toBe(true)
      expect(replies[0]).toMatchObject({ type: 'config.oauthLoginReply', payload: { started: true } })
    })

    it('oauthLogin 失败（无 oauthConfig / 已有 flow）→ reply { started: false, error }', async () => {
      const { replies, handler } = makeHandler({ oauthLogin: vi.fn().mockReturnValue({ started: false, error: 'provider "openai" 不支持 OAuth' }) })
      await handler.handleSettingsMessage(msg('config.oauthLogin', { providerId: 'openai' }), WS)
      expect(replies[0]).toMatchObject({ type: 'config.oauthLoginReply', payload: { started: false, error: 'provider "openai" 不支持 OAuth' } })
    })

    it('oauthCancel → reply config.oauthCancelReply，幂等（无 flow 返回 cancelled:false 不报错）', async () => {
      const { replies, handler } = makeHandler({ oauthCancel: vi.fn().mockReturnValue({ cancelled: false }) })
      const handled = await handler.handleSettingsMessage(msg('config.oauthCancel', { providerId: 'xai' }), WS)
      expect(handled).toBe(true)
      expect(replies[0]).toMatchObject({ type: 'config.oauthCancelReply', payload: { cancelled: false } })
    })
  })

  // ── B-1 场景 C：config.oauthLogout 路由（try/catch 双分支）──
  describe('config.oauthLogout（B-1 场景 C RPC）', () => {
    it('oauthLogout 成功 → reply config.oauthLogoutReply { ok: true }，logout 以 providerId 调用一次', async () => {
      const oauthLogout = vi.fn().mockResolvedValue(undefined)
      const { replies, handler } = makeHandler({ oauthLogout })
      const handled = await handler.handleSettingsMessage(msg('config.oauthLogout', { providerId: 'anthropic' }), WS)
      expect(handled).toBe(true)
      expect(oauthLogout).toHaveBeenCalledTimes(1)
      expect(oauthLogout).toHaveBeenCalledWith('anthropic')
      expect(replies[0]).toMatchObject({ id: 'm1', type: 'config.oauthLogoutReply', payload: { ok: true } })
    })

    it('oauthLogout reject → reply { ok: false, error 含「退出登录失败」与底层原因 }，不上抛', async () => {
      const oauthLogout = vi.fn().mockRejectedValue(new Error('EACCES: permission denied, open auth.json'))
      const { replies, handler } = makeHandler({ oauthLogout })
      const handled = await handler.handleSettingsMessage(msg('config.oauthLogout', { providerId: 'anthropic' }), WS)
      expect(handled).toBe(true)
      expect(replies[0]).toMatchObject({ type: 'config.oauthLogoutReply', payload: { ok: false } })
      // 错误文案可操作：含失败语义 + 底层原因 + 重试指引
      expect(replies[0].payload.error).toEqual(expect.stringContaining('退出登录失败'))
      expect(replies[0].payload.error).toEqual(expect.stringContaining('EACCES: permission denied'))
      expect(replies[0].payload.error).toEqual(expect.stringContaining('请重试'))
    })
  })

  // ── 环境变量检测（I3，wave-env-check TC3）：config.checkEnvVars 路由 ──
  describe('config.checkEnvVars（I3 RPC）', () => {
    it('合法 payload → reply config.envVarsChecked { results }', async () => {
      const { replies, ctx, handler } = makeHandler()
      ctx.configService.checkEnvVars = vi.fn().mockReturnValue({ OPENAI_API_KEY: true, AWS_PROFILE: false })
      const handled = await handler.handleSettingsMessage(msg('config.checkEnvVars', { names: ['OPENAI_API_KEY', 'AWS_PROFILE'] }), WS)
      expect(handled).toBe(true)
      expect(ctx.configService.checkEnvVars).toHaveBeenCalledWith(['OPENAI_API_KEY', 'AWS_PROFILE'])
      expect(replies[0]).toMatchObject({ type: 'config.envVarsChecked', payload: { results: { OPENAI_API_KEY: true, AWS_PROFILE: false } } })
    })

    it('非法 payload（names 非字符串数组）→ sendError invalid_payload，不调 configService', async () => {
      const { ctx, handler, sendErrorCalls } = makeHandler()
      const handled = await handler.handleSettingsMessage(msg('config.checkEnvVars', { names: ['ok', 42] }), WS)
      expect(handled).toBe(true)
      expect(ctx.configService.checkEnvVars).not.toHaveBeenCalled()
      expect(sendErrorCalls[0]).toMatchObject({ code: 'invalid_payload' })
    })
  })

  // ── Phase 3 reconcile：defaultModel 维护统一收口（P1 无双重广播 + source 统一）──
  // 设计 provider-arch-hardening §3.3 D3 / §5 Phase 3：5 handler 的 config.defaults 广播
  // 收口到 reconcileDefaultModelAfterProviderChange，消除分散编排的遗漏根因。
  describe('Phase 3 reconcile：defaultModel 维护统一收口（P1 无双重广播）', () => {
    it('setProvider 有 newDefault → 广播恰好 1 次，有 newDefault 时 ?? 短路不调 getDefaultModel', async () => {
      const { ctx, broadcasts, handler } = makeHandler({
        setProvider: vi.fn().mockReturnValue({ newDefault: { provider: 'p1', modelId: 'm1' } }),
      })
      await handler.handleSettingsMessage(msg('config.setProvider', { providerId: 'p1', name: 'x' }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
      // 有 newDefault 时 ?? 短路，不读盘 getDefaultModel（避免二次写回）
      expect(ctx.configService.getDefaultModel).not.toHaveBeenCalled()
    })

    it('setProvider 无 newDefault + getDefaultModel 有值 → 兜底广播 1 次', async () => {
      const { ctx, broadcasts, handler } = makeHandler({
        setProvider: vi.fn().mockReturnValue({}),
        getDefaultModel: vi.fn().mockReturnValue({ provider: 'p1', modelId: 'm1' }),
      })
      await handler.handleSettingsMessage(msg('config.setProvider', { providerId: 'p1', name: 'x' }), WS)
      expect(ctx.configService.getDefaultModel).toHaveBeenCalledOnce()
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
    })

    it('setProvider 无 newDefault + getDefaultModel 无值 → 不广播', async () => {
      const { broadcasts, handler } = makeHandler({
        setProvider: vi.fn().mockReturnValue({}),
        getDefaultModel: vi.fn().mockReturnValue(null),
      })
      await handler.handleSettingsMessage(msg('config.setProvider', { providerId: 'p1', name: 'x' }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
    })

    it('deleteProvider 有 newDefault → 广播 1 次', async () => {
      const { broadcasts, handler } = makeHandler({
        deleteProvider: vi.fn().mockResolvedValue({ removed: true, newDefault: { provider: 'p2', modelId: 'm2' } }),
      })
      await handler.handleSettingsMessage(msg('config.deleteProvider', { providerId: 'p1' }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
    })

    it('deleteProvider 无 newDefault + getDefaultModel 无值 → 不广播', async () => {
      const { broadcasts, handler } = makeHandler({
        deleteProvider: vi.fn().mockResolvedValue({ removed: true }),
        getDefaultModel: vi.fn().mockReturnValue(null),
      })
      await handler.handleSettingsMessage(msg('config.deleteProvider', { providerId: 'p1' }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
    })

    it('toggleProviderEnabled 有 newDefault → 广播 1 次', async () => {
      const { broadcasts, handler } = makeHandler({
        toggleProviderEnabled: vi.fn().mockReturnValue({ newDefault: { provider: 'p1', modelId: 'm1' } }),
      })
      await handler.handleSettingsMessage(msg('config.toggleProviderEnabled', { providerId: 'p1', enabled: true }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
    })

    it('toggleProviderEnabled 无 newDefault + getDefaultModel 兜底 → 广播 1 次', async () => {
      const { broadcasts, handler } = makeHandler({
        toggleProviderEnabled: vi.fn().mockReturnValue({}),
        getDefaultModel: vi.fn().mockReturnValue({ provider: 'p2', modelId: 'm2' }),
      })
      await handler.handleSettingsMessage(msg('config.toggleProviderEnabled', { providerId: 'p1', enabled: false }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
    })

    it('removeProviderByKind 有 newDefault → 广播 1 次', async () => {
      const { broadcasts, handler } = makeHandler({
        removeProviderByKind: vi.fn().mockResolvedValue({ removed: true, newDefault: { provider: 'p2', modelId: 'm2' } }),
      })
      await handler.handleSettingsMessage(msg('config.removeProviderByKind', { providerId: 'p1', kind: 'custom' }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
    })

    it('removeProviderByKind 无 newDefault + getDefaultModel 无值 → 不广播', async () => {
      const { broadcasts, handler } = makeHandler({
        removeProviderByKind: vi.fn().mockResolvedValue({ removed: true }),
        getDefaultModel: vi.fn().mockReturnValue(null),
      })
      await handler.handleSettingsMessage(msg('config.removeProviderByKind', { providerId: 'p1', kind: 'custom' }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
    })

    it('applyImportProviders 成功 → 不传 newDefault，getDefaultModel 兜底广播 1 次', async () => {
      const { ctx, broadcasts, handler } = makeHandler({
        applyImportProviders: vi.fn().mockResolvedValue({ result: { imported: ['p1'] } }),
        getDefaultModel: vi.fn().mockReturnValue({ provider: 'p1', modelId: 'm1' }),
      })
      await handler.handleSettingsMessage(msg('config.applyImportProviders', { importId: 'imp1', selectedIds: ['p1'] }), WS)
      expect(ctx.configService.getDefaultModel).toHaveBeenCalledOnce()
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
    })

    it('applyImportProviders 成功 + getDefaultModel 无值 → 不广播', async () => {
      const { broadcasts, handler } = makeHandler({
        applyImportProviders: vi.fn().mockResolvedValue({ result: {} }),
        getDefaultModel: vi.fn().mockReturnValue(null),
      })
      await handler.handleSettingsMessage(msg('config.applyImportProviders', { importId: 'imp1', selectedIds: ['p1'] }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
    })

    it('applyImportProviders 失败（error）→ 不广播 provider 列表也不 reconcile', async () => {
      const { ctx, broadcasts, handler } = makeHandler({
        applyImportProviders: vi.fn().mockResolvedValue({ error: { code: 'PREVIEW_EXPIRED', message: 'expired' } }),
      })
      await handler.handleSettingsMessage(msg('config.applyImportProviders', { importId: 'imp1', selectedIds: ['p1'] }), WS)
      expect(ctx.broadcastProviderList).not.toHaveBeenCalled()
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
    })

    it('广播内容：source 用合法枚举（setProvider → provider-updated），defaultModel 复合串 provider/modelId', async () => {
      const { broadcasts, handler } = makeHandler({
        setProvider: vi.fn().mockReturnValue({ newDefault: { provider: 'anthropic', modelId: 'claude-opus' } }),
      })
      await handler.handleSettingsMessage(msg('config.setProvider', { providerId: 'anthropic', name: 'x' }), WS)
      const d = broadcasts.find(b => b.type === 'config.defaults')
      expect(d?.payload).toMatchObject({ defaultModel: 'anthropic/claude-opus', source: 'provider-updated' })
    })
  })

  // ── Phase 3 P4：applyImportProviders 后 defaultModel 写盘 ──
  // reconcile 兜底分支调 getDefaultModel，后者 wasFixed:true 时写回 settings.json。
  // 用真实 pi-provider-store.getDefaultModel（tmpdir 隔离）验证端到端写盘。
  describe('Phase 3 P4：applyImportProviders 后 defaultModel 写盘（reconcile 兜底 + getDefaultModel wasFixed）', () => {
    let p4TmpDir: string
    beforeEach(async () => {
      p4TmpDir = await mkdtempP(join(tmpdir(), 'p4-reconcile-'))
      mkdirSync(join(p4TmpDir, 'agent'), { recursive: true })
      setSettingsPath(join(p4TmpDir, 'agent', 'settings.json'))
      setModelsPath(join(p4TmpDir, 'agent', 'models.json'))
      refreshModels()
    })
    afterEach(async () => {
      await rmP(p4TmpDir, { recursive: true, force: true })
    })

    it('applyImportProviders 成功 → reconcile 调 getDefaultModel → wasFixed 写回 settings.json.defaultProvider', async () => {
      // 场景：models.json 有 provider，settings.json 无 defaultProvider
      // → findValidDefaultModel 走 pickFirstModelProvider fallback，wasFixed:true
      // → getDefaultModel 写回 settings.json（设 defaultProvider/defaultModel）
      writeModels({
        providers: {
          'p1': { apiKey: 'sk-x', enabled: true, models: [{ id: 'm1', name: 'M1' }] },
        },
      })
      refreshModels()

      // getDefaultModel 走真实 pi-provider-store.getDefaultModel（tmpdir 隔离）
      const { broadcasts, handler } = makeHandler({
        applyImportProviders: vi.fn().mockResolvedValue({ result: { imported: ['p1'] } }),
        getDefaultModel: vi.fn(() => piProviderGetDefaultModel()),
      })
      await handler.handleSettingsMessage(
        msg('config.applyImportProviders', { importId: 'imp1', selectedIds: ['p1'] }),
        WS,
      )

      // P4 核心：settings.json.defaultProvider 被写入（getDefaultModel wasFixed 写回生效）
      const settings = readSettings()
      expect(settings.defaultProvider).toBe('p1')
      expect(settings.defaultModel).toBe('m1')
      // 且 reconcile 广播了 config.defaults（收口后统一入口）
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
    })
  })

  // ── scoped model（design §4.1 A5/A7/A9）：config.setScopedModels 路由 ──
  // 校验（非法整单拒绝）→ 去重保序写入 → defaultModel 同步 scoped[0] → 广播 + reply。
  describe('A5: config.setScopedModels 默认模型联动（scoped[0] 写 default）', () => {
    it('A5 setScopedModels 后 defaultModel 同步写为 scoped[0] + 广播 config.defaults (source=default-set)', async () => {
      const { ctx, replies, broadcasts, handler } = makeHandler({
        // R3-2：default 同步前置校验 scoped[0] 的 provider 可用（存在且 enabled）
        listProviders: vi.fn().mockReturnValue([{ id: 'p', enabled: true }]),
        modifyScopedModels: vi.fn(async () => ['p/m1', 'p/m2']),
        getDefaultModel: vi.fn().mockReturnValue(null),
      })

      await handler.handleSettingsMessage(msg('config.setScopedModels', { models: ['p/m1', 'p/m2'] }), WS)

      // 列表非空且 scoped[0] ≠ 当前 default → 写 default 为 scoped[0]
      expect(ctx.configService.setDefaultModel).toHaveBeenCalledWith('p', 'm1')
      const d = broadcasts.find(b => b.type === 'config.defaults')
      expect(d?.payload).toMatchObject({ defaultModel: 'p/m1', source: 'default-set' })
      expect(replies[0]).toMatchObject({ type: 'config.scopedModels', payload: { scopedModels: ['p/m1', 'p/m2'] } })
    })

    it('scoped[0] 已是当前 default 时不重写 setDefaultModel（config.defaults 幂等广播仍触发）', async () => {
      const { ctx, broadcasts, handler } = makeHandler({
        listProviders: vi.fn().mockReturnValue([{ id: 'p', enabled: true }]),
        modifyScopedModels: vi.fn(async () => ['p/m1']),
        getDefaultModel: vi.fn().mockReturnValue({ provider: 'p', modelId: 'm1' }),
      })

      await handler.handleSettingsMessage(msg('config.setScopedModels', { models: ['p/m1'] }), WS)

      expect(ctx.configService.setDefaultModel).not.toHaveBeenCalled()
      // 已是 default → defaultSynced=true，广播幂等值（与旧行为一致）
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
    })

    it('S7 空列表 → default 不变（不调 setDefaultModel、不广播 config.defaults），reply scopedModels:[]，broadcastProviderList 仍触发', async () => {
      // 设计 §4.1 S7：清空白名单不动默认模型。实现依据 handler 的 `if (result.length > 0)` 守卫
      //（settings-message-handler.ts）——空列表两段（写 default / 广播 defaults）都跳过，
      // provider 列表广播仍触发（前端需刷新 scopedModels 视图）。
      const { ctx, replies, broadcasts, handler } = makeHandler({
        modifyScopedModels: vi.fn(async () => []),
      })

      await handler.handleSettingsMessage(msg('config.setScopedModels', { models: [] }), WS)

      // ① 不调 setDefaultModel（连带 getDefaultModel 也不读——守卫短路）
      expect(ctx.configService.setDefaultModel).not.toHaveBeenCalled()
      expect(ctx.configService.getDefaultModel).not.toHaveBeenCalled()
      // ② 不广播 config.defaults
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
      // ③ reply 含写入结果 scopedModels: []
      expect(replies[0]).toMatchObject({ type: 'config.scopedModels', payload: { scopedModels: [] } })
      // ④ broadcastProviderList 仍触发
      expect(ctx.broadcastProviderList).toHaveBeenCalledOnce()
    })

    it('R3-1 setDefaultModel 抛错 → warn 降级不阻断主语义：reply 仍返回新 scopedModels，broadcastProviderList 仍触发', async () => {
      // 三方撕裂修复：providers.json 已写入（modifyScopedModels 成功）但 setDefaultModel
      // 抛错时，广播与 reply 必须继续（scoped 写入是主语义，default 同步是附带操作）。
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { ctx, replies, broadcasts, handler } = makeHandler({
        listProviders: vi.fn().mockReturnValue([{ id: 'p', enabled: true }]),
        modifyScopedModels: vi.fn(async () => ['p/m1', 'p/m2']),
        getDefaultModel: vi.fn().mockReturnValue(null),
        setDefaultModel: vi.fn(() => { throw new Error('settings.json 写入失败') }),
      })

      const handled = await handler.handleSettingsMessage(msg('config.setScopedModels', { models: ['p/m1', 'p/m2'] }), WS)

      expect(handled).toBe(true)
      // reply 仍返回写入结果（renderer 不回滚 UI）
      expect(replies[0]).toMatchObject({ type: 'config.scopedModels', payload: { scopedModels: ['p/m1', 'p/m2'] } })
      // provider 列表广播仍触发（model.list 白名单刷新依赖它）
      expect(ctx.broadcastProviderList).toHaveBeenCalledOnce()
      // 降级可定位：warn 带 scoped[0] 与「已写入」上下文；default 未同步成功 → 不广播假默认
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('p/m1'), expect.anything())
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
      warnSpy.mockRestore()
    })

    it('R3-2 scoped[0] 属 disabled provider → 跳过 default 同步（不调 setDefaultModel/getDefaultModel，不广播假默认），reply/广播不受影响', async () => {
      // 用户把已 toggle OFF 的 provider 模型置首：无条件同步会被 findValidDefaultModel
      // 随后冲掉（静默破坏「第一位即默认」），前置校验后跳过同步、保留现有 default。
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { ctx, replies, broadcasts, handler } = makeHandler({
        listProviders: vi.fn().mockReturnValue([{ id: 'p', enabled: false }]),
        modifyScopedModels: vi.fn(async () => ['p/m1', 'p/m2']),
        getDefaultModel: vi.fn().mockReturnValue({ provider: 'other', modelId: 'keep' }),
      })

      await handler.handleSettingsMessage(msg('config.setScopedModels', { models: ['p/m1', 'p/m2'] }), WS)

      // 不调 setDefaultModel（provider 检查失败短路，连 getDefaultModel 也不读）
      expect(ctx.configService.setDefaultModel).not.toHaveBeenCalled()
      expect(ctx.configService.getDefaultModel).not.toHaveBeenCalled()
      // 不广播 config.defaults（现有 default 保留，不广播未落盘的 scoped[0]）
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
      // scoped 主语义不受影响：广播 + reply 正常
      expect(ctx.broadcastProviderList).toHaveBeenCalledOnce()
      expect(replies[0]).toMatchObject({ type: 'config.scopedModels', payload: { scopedModels: ['p/m1', 'p/m2'] } })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('p/m1'))
      warnSpy.mockRestore()
    })
  })

  describe('A7: setScopedModels 广播后模型列表只含 scoped 且有序', () => {
    it('A7 setScopedModels 触发 broadcastProviderList + reply 按写入序；随后 model.list reply aggregateModels 结果', async () => {
      // aggregateModels 的 scoped 过滤/排序在 model-service.test.ts（A1/A3）覆盖，
      // 此处验证 handler 链路：setScopedModels 后广播 provider 列表（含 scopedModels），
      // model.list 的 reply 透传 aggregateModels（scoped 过滤后）结果。
      const aggregate = vi.fn().mockReturnValue([{ id: 'C' }, { id: 'A' }])
      const { ctx, replies, handler } = makeHandler({
        // R3-2：provider 可用性校验需要列表含 provider 'p'（enabled），否则 default 同步被跳过
        listProviders: vi.fn().mockReturnValue([{ id: 'p', enabled: true }]),
        modifyScopedModels: vi.fn(async () => ['p/C', 'p/A']),
        aggregate,
      })

      await handler.handleSettingsMessage(msg('config.setScopedModels', { models: ['p/C', 'p/A'] }), WS)
      expect(ctx.broadcastProviderList).toHaveBeenCalledOnce()
      expect(replies[0]).toMatchObject({ type: 'config.scopedModels', payload: { scopedModels: ['p/C', 'p/A'] } })

      await handler.handleSettingsMessage(msg('model.list', {}), WS)
      expect(aggregate).toHaveBeenCalledOnce()
      expect(replies[1]).toMatchObject({ type: 'model.list', payload: { models: [{ id: 'C' }, { id: 'A' }] } })
    })
  })

  describe('A9: config.setScopedModels 格式校验与去重', () => {
    it('A9 非法条目（无斜杠）→ sendError invalid_scoped_models，整单拒绝（不写入不广播不 reply）', async () => {
      const modifyScopedModels = vi.fn(async (fn: (c: string[]) => string[]) => fn([]))
      const { ctx, replies, broadcasts, sendErrorCalls, handler } = makeHandler({ modifyScopedModels })

      await handler.handleSettingsMessage(msg('config.setScopedModels', { models: ['p/m1', 'gpt-4'] }), WS)

      expect(sendErrorCalls[0]).toMatchObject({ code: 'invalid_scoped_models' })
      expect(modifyScopedModels).not.toHaveBeenCalled()
      expect(ctx.broadcastProviderList).not.toHaveBeenCalled()
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
      expect(replies).toHaveLength(0)
    })

    it('A9 空 provider 前缀（/gpt-4）同样整单拒绝', async () => {
      const { sendErrorCalls, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('config.setScopedModels', { models: ['/gpt-4'] }), WS)
      expect(sendErrorCalls[0]).toMatchObject({ code: 'invalid_scoped_models' })
    })

    it('A9 models 非数组 / 元素非字符串 → sendError invalid_payload', async () => {
      const { sendErrorCalls, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('config.setScopedModels', { models: 'not-array' }), WS)
      expect(sendErrorCalls[0]).toMatchObject({ code: 'invalid_payload' })
    })

    it('A9 合法条目去重保序写入（写入函数整单替换为去重序，reply 同步返回）', async () => {
      // handler 传 () => deduped：忽略 current（整单替换），写入值为去重保序结果
      const written: string[][] = []
      const modifyScopedModels = vi.fn(async (fn: (c: string[]) => string[]) => {
        const out = fn(['old/x'])
        written.push(out)
        return out
      })
      const { replies, handler } = makeHandler({
        listProviders: vi.fn().mockReturnValue([{ id: 'p', enabled: true }]),
        modifyScopedModels,
      })

      await handler.handleSettingsMessage(
        msg('config.setScopedModels', { models: ['p/m1', 'p/m2', 'p/m1', 'p/m3', 'p/m2'] }),
        WS,
      )

      expect(written[0]).toEqual(['p/m1', 'p/m2', 'p/m3'])
      expect(replies[0]).toMatchObject({ type: 'config.scopedModels', payload: { scopedModels: ['p/m1', 'p/m2', 'p/m3'] } })
    })
  })
})

// ── M2c：D3 链 2 接线（RuntimeServer.setServices → handler ctx → resolver）────────────
// 「装配点真的传了」的落点 = RuntimeServer.setServices 的 optional 对象（组合根 index.ts
// 经此传入）与 assembleCoreHandlers 的 ctx 透传。本组不用手搓 ctx，而是经真实 RuntimeServer
// 装配后取真实 handler——证明 resolver 沿 server 装配链路到达消费点，且 discover 真的用它
// 取凭据（不再降级回 configService.getProvider 的 models.json 单源）。
describe('M2c: RuntimeServer.setServices 透传 providerCredentialResolver（D3 链 2 装配点）', () => {
  function assembleWithResolver() {
    const MockSvc = createMockSessionServiceClass()
    const sessionService = new MockSvc() as unknown as ISessionService
    const resolveProviderCredential = vi.fn(async () => ({ key: 'resolved-by-resolver', source: 'auth.json' as const }))
    const resolver = {
      hasProviderCredential: vi.fn(() => true),
      listCredentialBackedProviderIds: vi.fn(() => new Set<string>()),
      resolveProviderCredential,
    }
    const discoverModelsFromApi = vi.fn(async () => [{ id: 'm1' }])
    // 降级回查的诱饵：resolver 生效时不得被触碰
    const getProvider = vi.fn(() => ({ apiKey: 'models-json-key' }))
    const server = new RuntimeServer(0, '/tmp/m2c-server-wiring')
    server.setServices(sessionService, { getProvider } as never, { discoverModelsFromApi } as never, {
      providerCredentialResolver: resolver,
    })
    return { server, resolver, resolveProviderCredential, discoverModelsFromApi, getProvider }
  }

  it('server 装配的 handler ctx 持有同一 resolver 实例', () => {
    const { server, resolver } = assembleWithResolver()
    const handler = (server as unknown as { settingsHandler: SettingsMessageHandler }).settingsHandler
    const ctx = (handler as unknown as { ctx: { providerCredentialResolver?: unknown } }).ctx

    expect(ctx.providerCredentialResolver).toBe(resolver)
  })

  it('config.discoverModels 经该 resolver 取凭据（不落 models.json 降级回查），reply 走真实 broker', async () => {
    const { server, resolveProviderCredential, discoverModelsFromApi, getProvider } = assembleWithResolver()
    const handler = (server as unknown as { settingsHandler: SettingsMessageHandler }).settingsHandler
    const ws = { readyState: 1, send: vi.fn() }

    await handler.handleSettingsMessage(
      msg('config.discoverModels', { baseUrl: 'https://api.example', providerId: 'p1' }),
      ws as never,
    )

    await vi.waitFor(() => expect(discoverModelsFromApi).toHaveBeenCalledTimes(1))
    expect(resolveProviderCredential).toHaveBeenCalledWith('p1')
    expect(discoverModelsFromApi).toHaveBeenCalledWith('https://api.example', 'resolved-by-resolver', undefined)
    expect(getProvider).not.toHaveBeenCalled()
    expect(ws.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(ws.send.mock.calls[0]![0] as string)).toMatchObject({
      type: 'config.discoveredModels',
      payload: { success: true },
    })
  })
})
