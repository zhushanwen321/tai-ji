/**
 * W1 / L7: switchModel 对未激活 session 的处理（fail-fast + 无 client 不假装成功）。
 *
 * 背景：
 * - session 不在 sessions Map 时原实现静默 return sessionId（假装成功），前端无感知。
 * - session 在 Map 但无活跃 pi 进程（client 不存在）时，原实现仍写缓存 + 广播
 *   state_changed，导致前端收到「模型已切」的假信号（实际 pi 进程没切）。
 *
 * 修复：
 * - session 不存在 → throw Error('session not active')（fail-fast，调用方据 .code 引导）。
 * - client 不存在 → 跳过缓存写和广播，return sessionId（不假装成功）。
 *
 * 写点单测追加（composer-model-session-isolation 设计 §5 U8 承诺的 model-control 写点覆盖；
 * impl-plan 台账中写点接入属 U1，本组用例是 Gate B 端到端之外的最小单测防线）：
 * switchModel / setThinkingLevel 成功后读回值 == get_state 读回的生效值（生效值胜请求值）。
 *
 * [缓存治理批 3 U7 适配 → U8a/U8b 收口] 读侧 = extractLatestModelFromJsonl 反向读 JSONL
 * 真源，pi mock 在 setModel / setThinkingLevel 成功后 append 对应 JSONL entry（真实 pi
 * 行为：model_change / thinking_level_change 落盘），断言语义 = 「反向读 JSONL 可见」。
 * U8 写点退役（W1/W2/W6）：persistModelBinding 的 sidecar 落盘断言（persistBindingCalls
 * 记录 + 空值守卫负例）与原 readModelBinding 包装随写点删除一并移除——taiji 不再写任何
 * model 持久层，持久层唯一写方 = pi JSONL。
 *
 * 运行：cd packages/runtime && npx vitest run test/switch-model.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMessage, ProviderId } from '@taiji/shared'

import { extractLatestModelFromJsonl } from '../src/infra/pi/session-file-utils.js'

import type {
  IMessageBroker,
  IEventAdapter,
  IExtensionService,
} from '../src/interfaces.js'
import type { IProcessManager, IPiEngine } from '../src/services/ports/pi-engine.js'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'
import { SESSION_NOT_ACTIVE } from '../src/utils/errors.js'

// pi-provider-store: 控制默认 model 配置（测试主路径需要 model 已配置）
const providerMocks = vi.hoisted(() => ({
  defaultModel: {
    value: { provider: 'test-provider', modelId: 'test-model' } as
      { provider: string; modelId: string } | null,
  },
  refreshAll: vi.fn(),
}))
vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    refreshAll: providerMocks.refreshAll,
    getDefaultModel: () => providerMocks.defaultModel.value,
    getSkillPaths: () => [],
    readModels: () => ({ providers: {} }),
    readSettings: () => ({}),
  }
})
// [U8a W1/W2 后] persistModelBinding 记录 mock 已随写点退役删除——taiji 侧不再有
// model 持久层写点可观察；本 mock 仅保留 scanPiSessions 拦截（列表扫描走测试装置）。
vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/session-file-utils.js')>()
  return {
    ...actual,
    scanPiSessions: () => [],
  }
})
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => '/mock/taiji/agent' }
})
vi.mock('../src/infra/system/trash.js', () => ({ trash: vi.fn() }))
vi.mock('../src/infra/pi/message-converter.js', () => ({ convertPiHistory: vi.fn((raw: unknown) => raw) }))
vi.mock('../src/services/session-history.js', () => ({
  getHistoryFromFile: vi.fn().mockResolvedValue([]),
  getHistoryFromFilePath: vi.fn().mockResolvedValue([]),
}))

import { SessionService } from '../src/services/session/session-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { PiSessionStore } from '../src/infra/pi/session-store.js'

/** 一份最小测试装置：service + 各 mock 依赖。 */
function createService() {
  const clientMap = new Map<string, IPiEngine>()

  const pm = {
    createSession: vi.fn(async (id: string) => {
      const client = makeClient()
      clientMap.set(id, client)
      return client
    }),
    destroySession: vi.fn(async (id: string) => { clientMap.delete(id) }),
    getClient: vi.fn((id: string) => clientMap.get(id)),
    getSessionIdByClient: vi.fn(),
    hasClient: vi.fn((id: string) => clientMap.has(id)),
    rekey: vi.fn(),
    onSessionExit: vi.fn(),
    destroyAll: vi.fn(async () => { clientMap.clear() }),
  } as unknown as IProcessManager

  const broker = {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  } as unknown as IMessageBroker

  const extensionService = {
    getExtensionPaths: vi.fn().mockResolvedValue([]),
  } as unknown as IExtensionService

  const adapterFactory = (): IEventAdapter => ({ attach: vi.fn(), detach: vi.fn() })
  const gitInfoReader: IGitInfoReader = {
    readGitInfo: vi.fn(() => undefined),
    pruneStaleCache: vi.fn(),
  }
  const workspaceService = {
    record: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  }

  const service = new SessionService(
    pm,
    broker,
    adapterFactory,
    '/tmp',
    extensionService,
    new PiConfigStore(),
    new PiSessionStore(),
    gitInfoReader,
    workspaceService as unknown as ConstructorParameters<typeof SessionService>[8],
  )

  return { service, pm, broker, clientMap }
}

function makeClient(): IPiEngine {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setThinkingLevel: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue({ data: { messages: [] } }),
    sendCommand: vi.fn().mockResolvedValue({ data: {} }),
    switchSession: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue({}),
    getCommands: vi.fn().mockResolvedValue([]),
    getSessionStats: vi.fn().mockResolvedValue({}),
    onEvent: vi.fn(() => () => {}),
    onExit: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
  } as unknown as IPiEngine
}

/** 从 broadcast 调用里找指定 type 的消息。 */
function findBroadcast(broker: IMessageBroker, type: ServerMessage['type']): ServerMessage | undefined {
  for (const call of vi.mocked(broker.broadcast).mock.calls) {
    if (call[0].type === type) return call[0] as ServerMessage
  }
  return undefined
}

describe('W1/L7: switchModel fail-fast & 无 client 不假装成功', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    providerMocks.defaultModel.value = { provider: 'test-provider', modelId: 'test-model' }
  })

  it('U2: session 不在 Map → throw Error（不静默返回 sessionId）', async () => {
    const { service } = createService()
    await expect(service.switchModel('nonexistent', 'provider' as ProviderId, 'model'))
      .rejects.toThrow('session not active')
  })

  it('U3: session 在 Map 但无 client → 拒绝 SESSION_NOT_ACTIVE，不写缓存、不广播', async () => {
    const { service, pm, broker, clientMap } = createService()
    // 1. 建立一个 session（会进 sessions Map 且挂 client）
    const seedState = { sessionId: 's1', sessionFile: '/fake/s1.jsonl' }
    const client = makeClient()
    vi.mocked(client.getState).mockResolvedValue(seedState)
    vi.mocked(pm.createSession).mockResolvedValueOnce(client)
    clientMap.set('s1', client)
    await service.create('/tmp', 'seed')
    expect(service.getSummary('s1')).toBeDefined()

    // 2. 模拟 pi 进程已退出：从 clientMap 移除，getClient 返回 undefined
    clientMap.delete('s1')
    vi.mocked(pm.getClient).mockReturnValue(undefined)
    const beforeModelId = service.getSummary('s1')?.modelId
    expect(beforeModelId).toBeDefined()
    vi.mocked(broker.broadcast).mockClear()

    // 3. RT-4#4 契约：无 client 是真失败，必须以 SESSION_NOT_ACTIVE 显形——
    // 旧契约「fail-skip 返回 sessionId」是被审计点名的假成功（transport 按请求值
    // 回 model.switched，UI 乐观确认而内存档位未生效）
    await expect(service.switchModel('s1', 'new' as ProviderId, 'model'))
      .rejects.toMatchObject({ code: SESSION_NOT_ACTIVE })
    // modelId 未被改写（拒绝路径不落半态）
    expect(service.getSummary('s1')?.modelId).toBe(beforeModelId)
    // 未广播 session.state_changed（失败不产生状态假信号）
    expect(findBroadcast(broker, 'session.state_changed')).toBeUndefined()
  })
})

describe('model-control 生效值链（原 U1 写点覆盖，U8a 写点退役后 = 反向读 JSONL 可见）——switchModel/setThinkingLevel [U7/U8a]', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    providerMocks.defaultModel.value = { provider: 'test-provider', modelId: 'test-model' }
    tmpDir = mkdtempSync(join(tmpdir(), 'switch-model-sidecar-'))
  })

  afterEach(() => {
    // maxRetries：teardown 递归删除与在途异步写竞争致 ENOTEMPTY 满载 flake（教训 d9ad39cb8）
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 建一个带已 materialize 主文件的 seed session（对齐真实 pi：会话文件先于对话存在）。 */
  async function seedSessionWithFile(ctx: ReturnType<typeof createService>, id: string): Promise<string> {
    const sessionFile = join(tmpDir, `${id}.jsonl`)
    writeFileSync(sessionFile, '{"type":"session"}\n', 'utf8')
    const client = makeClient()
    vi.mocked(client.getState).mockResolvedValue({ sessionId: id, sessionFile })
    vi.mocked(ctx.pm.createSession).mockResolvedValueOnce(client)
    ctx.clientMap.set(id, client)
    await ctx.service.create('/tmp', `seed-${id}`)
    return sessionFile
  }

  /** [U7] 模拟 pi 的 JSONL append（真实 pi 在 setModel/setThinkingLevel 成功后写对应 entry）。 */
  function appendJsonl(sessionFile: string, line: object): void {
    appendFileSync(sessionFile, JSON.stringify(line) + '\n', 'utf8')
  }

  it('switchModel 成功后 get_state 读回的生效值反向读 JSONL 可见（生效值胜请求值；持久层唯一写方 = pi）', async () => {
    const ctx = createService()
    const sessionFile = await seedSessionWithFile(ctx, 's1')
    const client = ctx.clientMap.get('s1')!
    // pi pattern 引擎静默换模形态：get_state 读回生效模型 ≠ 请求模型（U6 回执普查）
    vi.mocked(client.getState).mockResolvedValue({
      sessionId: 's1',
      sessionFile,
      model: { provider: 'eff-provider', id: 'eff-model' },
      thinkingLevel: 'high',
    })
    // [U7] pi 侧生效落盘：setModel 成功后 append model_change；thinking 'high' 是 pi 既有状态
    vi.mocked(client.setModel).mockImplementation(async () => {
      appendJsonl(sessionFile, { type: 'model_change', provider: 'eff-provider', modelId: 'eff-model' })
      appendJsonl(sessionFile, { type: 'thinking_level_change', thinkingLevel: 'high' })
    })

    const effective = await ctx.service.switchModel('s1', 'req-provider' as ProviderId, 'req-model')

    expect(effective).toBe('eff-provider/eff-model')
    // 断言目标：读回值 == get_state 读回生效值（非请求值）——持久层唯一写方 = pi JSONL
    //（U8a W1 后 taiji 不再写 .model.json），列表可见性经扫描反向读达成
    expect(extractLatestModelFromJsonl(sessionFile)).toEqual({
      modelId: 'eff-provider/eff-model',
      thinkingLevel: 'high',
    })
  })

  it('setThinkingLevel 成功后钳制生效值反向读 JSONL 可见（get_state 读回胜请求值）', async () => {
    const ctx = createService()
    const sessionFile = await seedSessionWithFile(ctx, 's1')
    const client = ctx.clientMap.get('s1')!
    vi.mocked(client.getState).mockResolvedValue({
      sessionId: 's1',
      sessionFile,
      model: { provider: 'eff-provider', id: 'eff-model' },
      // P3 钳制形态：请求 max，pi 钳到 xhigh
      thinkingLevel: 'xhigh',
    })
    vi.mocked(client.setModel).mockImplementation(async () => {
      appendJsonl(sessionFile, { type: 'model_change', provider: 'eff-provider', modelId: 'eff-model' })
    })
    await ctx.service.switchModel('s1', 'eff-provider' as ProviderId, 'eff-model')

    // [U7] pi 侧生效落盘：setThinkingLevel 成功后 append thinking_level_change（钳制值）
    vi.mocked(client.setThinkingLevel).mockImplementation(async () => {
      appendJsonl(sessionFile, { type: 'thinking_level_change', thinkingLevel: 'xhigh' })
    })
    const effective = await ctx.service.setThinkingLevel('s1', 'max')

    expect(effective).toBe('xhigh')
    expect(extractLatestModelFromJsonl(sessionFile)).toEqual({
      modelId: 'eff-provider/eff-model',
      thinkingLevel: 'xhigh',
    })
  })
})
