/**
 * W4a 判别器通道——SessionLifecycle.registerSession 注册后 session.surfaces 广播测试。
 *
 * 锁定（设计 §3.3.6 commit 1，纯增量）：注册汇聚点（create/restore/fork/btw 直注册
 * 四路收敛）在 sessions Map 写入后经 registerDeps.broadcastGlobal 盲广播全量派生视图
 * （全局帧、无 sessionId——rule-7 登记例外，先例 session.forkNotice）；renderer 只读
 * 派生表整表替换。派生公式与 message-broker buildSurfacesMsg（sendInitialState 冷启动
 * 段）同源同表。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-surfaces-broadcast.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ServerMessage } from '@taiji/shared'
import { SessionLifecycle } from '../session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import type { IEventAdapter } from '../../../interfaces.js'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'

const svc: ILifecycleSessionOps = {
  getExtensionPaths: vi.fn(async () => []),
  getSkillPaths: vi.fn(() => []),
  getReplaceSystemPrompt: vi.fn(() => undefined),
  getLaunchPresetOptions: vi.fn(async () => undefined),
  toSummary: vi.fn(),
  notifySessionCreated: vi.fn(),
  findScannedSession: vi.fn(() => undefined),
  fetchAndBroadcastContext: vi.fn(async () => undefined),
  removeSessionEntry: vi.fn(),
  getActiveSummaries: vi.fn(() => []),
}

/** 注册环境：全协作者 mock + 真 registerSession 编排；broadcastGlobal 捕获全局帧。 */
function makeEnv() {
  const globals: ServerMessage[] = []
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: (msg) => { globals.push(msg) },
  }
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore
  const lifecycle = new SessionLifecycle(
    svc, {} as unknown as IProcessManager, configStore,
    {} as unknown as ISessionStore, {} as unknown as WorkspaceService, registerDeps,
  )
  return { lifecycle, globals, client: {} as unknown as IPiEngine }
}

describe('W4a：registerSession 注册后广播 session.surfaces 全量派生视图', () => {
  let env: ReturnType<typeof makeEnv>
  beforeEach(() => { env = makeEnv() })

  it('主会话注册（surface 缺省 sidebar）：广播一帧，entries 含该会话', async () => {
    await env.lifecycle.registerSession('main-a', env.client, '/cwd', 'label')
    const frames = env.globals.filter((m) => m.type === 'session.surfaces')
    expect(frames).toHaveLength(1)
    expect(frames[0].payload).toEqual({ entries: [{ sessionId: 'main-a', surface: 'sidebar' }] })
  })

  it('btw 线注册（显式 btw）：帧内两条条目（主会话 + 线，全量表）', async () => {
    await env.lifecycle.registerSession('main-a', env.client, '/cwd', 'label')
    await env.lifecycle.registerSession('line-b', env.client, '/cwd', 'label', '/f.jsonl', undefined, undefined, undefined, undefined, undefined, 'btw')
    const frames = env.globals.filter((m) => m.type === 'session.surfaces')
    expect(frames).toHaveLength(2) // 每次注册一帧（全量重发）
    expect(frames[1].payload).toEqual({
      entries: [
        { sessionId: 'main-a', surface: 'sidebar' },
        { sessionId: 'line-b', surface: 'btw' },
      ],
    })
  })
})
