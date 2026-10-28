/**
 * server.ts handleMessage 的 vid 兜底守卫 —— renderer 侧 vid 门被绕过时的 runtime 侧防线。
 *
 * 契约（shared vid-rpc-gate 模块头）：vid（subagent:/agentcall:）只做前端路由 key，
 * runtime 全部 RPC 零方法认 vid。renderer 门（core command 入口）正常时 vid 不会到达
 * runtime；本守卫覆盖旁路（直连 ws send 等）——vid 到达即返回专用错误码
 * （与 renderer 门同 code，session_vid_rejected），替代模糊的 session_not_found。
 * 直通边界同 renderer 门：只认合法 vid 结构，真实 id / 带冒号非 vid 形态零干预。
 */
import type { IConfigService, IModelService, ISessionService } from '../../interfaces.js'
import type { IModelConnectionTester } from '../../services/ports/model-connection-tester.js'
import type { IProviderCredentialResolver } from '../../services/ports/provider-credential-resolver.js'
import type { SkillRegistry } from '../../services/skill-registry.js'
import { RuntimeServer } from '../server.js'
import type { ClientMessage } from '@taiji/shared'
import { agentCallVirtualId, subagentVirtualId, VID_RPC_REJECTED_CODE } from '@taiji/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

/** 最小 mock services（services-bundle.test.ts RuntimeServer 装配契约用例同款形态）。 */
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

/** handleMessage 是 private——经 cast 取用（services-bundle 同款测试通道）。 */
function handleMessageOf(server: RuntimeServer) {
  return (server as unknown as {
    handleMessage(msg: ClientMessage, ws: WebSocket): Promise<void>
  }).handleMessage.bind(server)
}

function makeServer(): RuntimeServer {
  const { sessionService, configService, modelService } = makeServerServices()
  const server = new RuntimeServer(0, '/mock-project-root', 'token')
  server.setServices(sessionService, configService, modelService, {
    skillRegistry: {} as SkillRegistry,
    providerCredentialResolver: {} as IProviderCredentialResolver,
    connectionTester: {} as IModelConnectionTester,
  })
  return server
}

function rpcMsg(type: string, payload: Record<string, unknown>, id = 'req-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

function sentFrames(ws: WebSocket): Array<{ type: string; id?: string; payload: Record<string, unknown> }> {
  return vi.mocked(ws.send).mock.calls.map((c) => JSON.parse(c[0] as string))
}

describe('server.handleMessage — vid 兜底守卫（runtime 侧防线）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('subagent 三段式 vid 到达（renderer 门被绕过）→ 专用错误码 envelope，不进路由', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = makeServer()
    const ws = makeWs()
    const vid = subagentVirtualId('main-1', 'sa-04bf')

    await handleMessageOf(server)(rpcMsg('file.search', { sessionId: vid }), ws)

    // runtime 日志是唯一持久取证侧（envelope 只达当前 ws，关闭即丢）；装配期另有
    // degenerate registry warn，故按守卫专属文案断言而非精确计数
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('vid reached runtime unhandled'))).toBe(true)
    // 恰一条 error envelope：无 reply、无其他帧（路由未执行）
    const frames = sentFrames(ws)
    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe('error')
    expect(frames[0].id).toBe('req-1')
    expect(frames[0].payload.code).toBe(VID_RPC_REJECTED_CODE)
    expect(frames[0].payload.code).toBe('session_vid_rejected')
    expect(frames[0].payload.sessionId).toBe(vid)
    expect(String(frames[0].payload.message)).toContain('file.search')
    expect(String(frames[0].payload.message)).toContain(vid)
    expect(String(frames[0].payload.message)).toContain('renderer 侧 vid 门')
  })

  it('agentcall 两段式 vid 同样被拒（两家族前缀全覆盖）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = makeServer()
    const ws = makeWs()
    const vid = agentCallVirtualId('acs-9')

    await handleMessageOf(server)(rpcMsg('session.getCommands', { sessionId: vid }), ws)

    const frames = sentFrames(ws)
    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe('error')
    expect(frames[0].payload.code).toBe(VID_RPC_REJECTED_CODE)
    expect(frames[0].payload.sessionId).toBe(vid)
  })

  it('内联路由（ping，不经 handler handles 清单）同样被守卫覆盖', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = makeServer()
    const ws = makeWs()
    const vid = subagentVirtualId('main-1', 'sa-04bf')

    await handleMessageOf(server)(rpcMsg('ping', { sessionId: vid }), ws)

    // 未回 pong——守卫先于路由表命中
    const frames = sentFrames(ws)
    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe('error')
    expect(frames[0].payload.code).toBe(VID_RPC_REJECTED_CODE)
  })

  it('非 vid 形态零干预：真实 id / 带冒号非 vid（term 实例 id）直通守卫进入正常路由', async () => {
    const server = makeServer()
    const ws = makeWs()

    // 未登记 type：直通守卫后落 unknown_type 兜底（证明未误拦、也未提前 short-circuit）
    await handleMessageOf(server)(rpcMsg('session.unknown', { sessionId: 'term:sess-1:2' }), ws)

    const frames = sentFrames(ws)
    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe('error')
    expect(frames[0].payload.code).toBe('unknown_type')
    expect(frames[0].payload.message).toContain('session.unknown')
  })
})
