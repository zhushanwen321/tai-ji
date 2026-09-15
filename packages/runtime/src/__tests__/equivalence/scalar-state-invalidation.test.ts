/**
 * W7 等价性 + 失效接线用例（data-source-governance P1.1 / P1.2 第一批）。
 *
 * 验收对照（.xyz-harness/2026-08-19-data-source-governance-p1p4/acceptance/w7-acceptance.md）：
 * - 「switchModel 成功后 modelId 实例 markDirty 被调」→ describe「mock RPC 层」it 1 / it 2
 * - 「thinking_level_changed 到达只 markDirty 不直写」→ describe「mock RPC 层」it 3
 *   （thinkingLevel 实例仍在用；label 实例用例随实例撤销删除——session_info_changed 的
 *   现行编排 = onSessionRenamed 直写，覆盖见 event-interpreter.test.ts TC-RN1/RN2 与
 *   session-service.test.ts U-setLabel-1/2/3，PR #185 MF1）
 *
 * [2026-09 测试舰队审查 r2-26] 「真实 pi 子进程」describe（RPC 频率采样，P0.5② 一次性
 * 验收输入）已删：断言 near-constant、唯一产出 console.log 数字——采样应由 bench 脚本
 * 承担而非回归套件。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProviderId } from '@xyz-agent/shared'
import { EventInterpreter } from '../../services/session/event-interpreter.js'
import { SessionService } from '../../services/session/session-service.js'
import { ReplicatedState } from '../../services/session/replicated-state.js'
import {
  createThinkingLevelStateConfig,
  createModelIdStateConfig,
  SCALAR_STATE_DEBOUNCE_MS,
} from '../../services/session/replicated-states.config.js'
import type { IMessageBroker } from '../../interfaces.js'
import type { IPiEngine, IProcessManager } from '../../services/ports/pi-engine.js'

/** pi get_state 的宽形态 mock（三字段齐全的最小权威快照）。 */
type StateShape = Record<string, unknown>

function makeState(overrides: StateShape = {}): StateShape {
  return {
    // W7 minor 修复（W8 顺手补）：pi Model 形态 = 裸 modelId（id）+ 独立 provider 字段
    //（曾写成 id 内嵌 'provider/model' 且缺 provider——modelId 投影要求两者都是 string，
    // 缺 provider 会丢 key 走 'required' 归一，播种退避）。组合口径 'provider/model' 由投影完成。
    model: { id: 'test-model', provider: 'test-provider' },
    thinkingLevel: 'low',
    sessionName: '旧名',
    ...overrides,
  }
}

/** mock client：initializeManagedSession（getCommands）+ 实例 fetch（getState）+ switchModel（setModel）。 */
function makeClient(state: StateShape) {
  return {
    getCommands: vi.fn(async () => []),
    getState: vi.fn(async () => state),
    setModel: vi.fn(async () => undefined),
  }
}

/** 最小 SessionService 装置（参考 session-service-w07-bus.test.ts 的构造形态）。 */
function makeSessionService(client: ReturnType<typeof makeClient>): SessionService {
  const broker = { broadcast: vi.fn() } as unknown as IMessageBroker
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => client as unknown as IPiEngine),
  } as unknown as IProcessManager
  return new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never, // extensionService：被测路径未消费
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never, // configStore
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never, // sessionStore
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService
  )
}

describe('W7 scalar-state 失效接线（mock RPC 层）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('switchModel 成功响应后 modelId 实例 markDirty 被调（且只调一次）', async () => {
    const client = makeClient(makeState())
    const svc = makeSessionService(client)
    await svc.initializeManagedSession('s-switch', client as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1) // flush 四实例播种 refetch（label/queue 已撤销，PR #185）

    const states = svc.getScalarReplicatedStates('s-switch')
    expect(states).toBeDefined()
    const markDirtySpy = vi.spyOn(states!.modelId, 'markDirty')

    // mock 场景品牌类型无运行时语义，显式收窄到 ProviderId
    const provider = 'test-provider' as ProviderId
    await svc.switchModel('s-switch', provider, 'new-model')
    expect(client.setModel).toHaveBeenCalledWith('test-provider', 'new-model')
    expect(markDirtySpy).toHaveBeenCalledTimes(1)
  })

  it('switchModel RPC 失败（throw）不失效 modelId 实例——pi 侧未生效，实例保持旧快照', async () => {
    const client = makeClient(makeState())
    client.setModel.mockRejectedValue(new Error('rpc down'))
    const svc = makeSessionService(client)
    await svc.initializeManagedSession('s-fail', client as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1)

    const states = svc.getScalarReplicatedStates('s-fail')!
    const markDirtySpy = vi.spyOn(states.modelId, 'markDirty')

    const provider = 'test-provider' as ProviderId
    await expect(svc.switchModel('s-fail', provider, 'new-model')).rejects.toThrow('rpc down')
    expect(markDirtySpy).not.toHaveBeenCalled()
  })

  it('thinking_level_changed 到达只 markDirty 不直写（thinkingLevel 实例失效收敛）', async () => {
    const fetchState = vi.fn(async () => makeState({ thinkingLevel: 'low' }))
    const thinkingLevelState = new ReplicatedState(createThinkingLevelStateConfig(fetchState))
    thinkingLevelState.refetch()
    await vi.advanceTimersByTimeAsync(1)
    expect(thinkingLevelState.get()).toEqual({ thinkingLevel: 'low' })

    fetchState.mockResolvedValue(makeState({ thinkingLevel: 'high' }))
    const markDirtySpy = vi.spyOn(thinkingLevelState, 'markDirty')

    // W9：onThinkingLevelChanged 旧缓存回写回调已删——事件唯一动作是失效，无任何直写。
    const interpreter = new EventInterpreter('s-tl', {
      send: vi.fn(),
      thinkingLevelState: () => thinkingLevelState,
    })
    interpreter.interpret([{ kind: 'thinking-level', level: '事件payload档位' }])

    expect(markDirtySpy).toHaveBeenCalledTimes(1)
    expect(thinkingLevelState.get()).toEqual({ thinkingLevel: 'low' }) // 不直写

    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 1)
    expect(thinkingLevelState.get()).toEqual({ thinkingLevel: 'high' }) // 快照来自 get_state
    thinkingLevelState.dispose()
  })
})

// [2026-09 测试舰队审查 r2-26] 真实 pi describe（含唯一采样用例）已删：`calls > 0` 恒真、
// `latencies.length === calls` 在同一函数体内恒成立——唯一产出是 console.log 采样数字，
// P0.5② 验收流程遗留；mock 层 3 用例（markDirty 语义）保留在上方。
