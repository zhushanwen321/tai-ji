/**
 * SessionModelControl 直测（S6 迁出批 4b）：模型/思考等级控制——set RPC +
 * get_state 回执普查（pattern 换模生效值）、三实例 markDirty 失效时序、
 * session.modelId/thinkingLevel 直写双投影、trace 补拉、错误路径。
 *
 * 分层（G2：import 无 session-service，stub 面 = deps 4 方法）：client 的
 * setModel/setThinkingLevel/getState 可编程，markDirty/直写/补拉经 spy 断言。
 */
import { describe, it, expect, vi } from 'vitest'
import type { ProviderId } from '@taiji/shared'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { IManagedSessionView } from '../types.js'
import type { SessionReplicatedStates } from '../session-state-projection.js'
import { SessionModelControl } from '../session-model-control.js'
import { SESSION_NOT_ACTIVE } from '../../../utils/errors.js'

/** 可变 session 视图（断言直写双投影）。 */
function makeSession(): { modelId: string; thinkingLevel: string } & IManagedSessionView {
  return { modelId: 'old/provider-old', thinkingLevel: 'medium' } as unknown as IManagedSessionView & { modelId: string; thinkingLevel: string }
}

function makeFixture(getStateImpl?: () => Promise<unknown>) {
  const session = makeSession()
  const markDirty = { modelId: vi.fn(), usage: vi.fn(), thinkingLevel: vi.fn() }
  const states = { modelId: { markDirty: markDirty.modelId }, usage: { markDirty: markDirty.usage }, thinkingLevel: { markDirty: markDirty.thinkingLevel } } as unknown as SessionReplicatedStates
  const client = {
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ model: { id: 'effective-m', provider: 'p2' }, thinkingLevel: 'high' } as unknown)),
  }
  if (getStateImpl) client.getState.mockImplementation(getStateImpl)
  const syncTraceEntries = vi.fn()
  const control = new SessionModelControl({
    pm: { getClient: vi.fn(() => client as unknown as IPiEngine) } as unknown as IProcessManager,
    getSession: vi.fn(() => session),
    getReplicatedStates: vi.fn(() => states),
    syncTraceEntries,
  })
  return { control, session, markDirty, client, syncTraceEntries }
}

describe('switchModel', () => {
  it('回执普查：pattern 换模时返回/直写 get_state 生效值（≠ 请求值）+ 三实例失效 + trace 补拉', async () => {
    const { control, session, markDirty, syncTraceEntries, client } = makeFixture()
    const result = await control.switchModel('s1', 'p1' as ProviderId, 'requested-m')
    expect(client.setModel).toHaveBeenCalledWith('p1', 'requested-m')
    expect(result).toBe('p2/effective-m')
    expect(session.modelId).toBe('p2/effective-m')
    expect(markDirty.modelId).toHaveBeenCalledTimes(1)
    expect(markDirty.usage).toHaveBeenCalledTimes(1)
    expect(markDirty.thinkingLevel).toHaveBeenCalledTimes(1)
    expect(syncTraceEntries).toHaveBeenCalledWith('s1', 'set_model')
  })

  it('get_state 读回失败：fallback 请求值（不反噬主链路），失效仍发', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { control, session, markDirty } = makeFixture(async () => { throw new Error('state rpc down') })
      const result = await control.switchModel('s1', 'p1' as ProviderId, 'requested-m')
      expect(result).toBe('p1/requested-m')
      expect(session.modelId).toBe('p1/requested-m')
      expect(markDirty.modelId).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('setModel RPC 失败：throw 且不失效不直写（pi 侧未生效，实例保持旧快照）', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture()
      ;(fixture.client.setModel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rpc fail'))
      await expect(fixture.control.switchModel('s1', 'p1' as ProviderId, 'm')).rejects.toThrow('rpc fail')
      expect(fixture.markDirty.modelId).not.toHaveBeenCalled()
      expect(fixture.markDirty.usage).not.toHaveBeenCalled()
      expect(fixture.markDirty.thinkingLevel).not.toHaveBeenCalled()
      expect(fixture.syncTraceEntries).not.toHaveBeenCalled()
      expect(fixture.session.modelId).toBe('old/provider-old')
    } finally {
      error.mockRestore()
    }
  })

  it('无活跃 client：fail-fast 抛 SESSION_NOT_ACTIVE（RT-4#4，不再降级返回 sessionId），零 RPC 零失效', async () => {
    const session = makeSession()
    const client = { setModel: vi.fn(), getState: vi.fn() }
    const markDirty = vi.fn()
    const control = new SessionModelControl({
      pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager,
      getSession: vi.fn(() => session),
      getReplicatedStates: vi.fn(() => ({ modelId: { markDirty } }) as unknown as SessionReplicatedStates),
      syncTraceEntries: vi.fn(),
    })
    // [code-harden RT-4#4] 旧契约 `resolves.toBe('s1')`（降级假成功）已废：切模型落到
    // 回收/崩溃窗口时必须报错而非乐观回显，恢复动作内嵌错误消息。
    await expect(control.switchModel('s1', 'p1' as ProviderId, 'm')).rejects.toMatchObject({
      code: SESSION_NOT_ACTIVE,
      message: expect.stringContaining('重开后可重试'),
    })
    expect(client.setModel).not.toHaveBeenCalled()
    expect(markDirty).not.toHaveBeenCalled()
    expect(session.modelId).toBe('old/provider-old')
  })

  it('session 不存在：throw session not active', async () => {
    const control = new SessionModelControl({
      pm: { getClient: vi.fn(() => ({})) } as unknown as IProcessManager,
      getSession: vi.fn(() => undefined),
      getReplicatedStates: vi.fn(() => undefined),
      syncTraceEntries: vi.fn(),
    })
    await expect(control.switchModel('s1', 'p1' as ProviderId, 'm')).rejects.toThrow('session not active')
  })
})

describe('setThinkingLevel', () => {
  it('钳制读回：返回 get_state 生效值并直写 session.thinkingLevel + trace 补拉', async () => {
    const { control, session, syncTraceEntries } = makeFixture(async () => ({ thinkingLevel: 'high' }))
    const result = await control.setThinkingLevel('s1', 'max')
    expect(result).toBe('high')
    expect(session.thinkingLevel).toBe('high')
    expect(syncTraceEntries).toHaveBeenCalledWith('s1', 'set_thinking_level')
  })

  it('get_state thinkingLevel 非 string：fallback 请求值', async () => {
    const { control, session } = makeFixture(async () => ({ thinkingLevel: undefined }))
    const result = await control.setThinkingLevel('s1', 'low')
    expect(result).toBe('low')
    expect(session.thinkingLevel).toBe('low')
  })

  it('无活跃 client：fail-fast 抛 SESSION_NOT_ACTIVE（RT-4#4），不直写请求值', async () => {
    const session = makeSession()
    const control = new SessionModelControl({
      pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager,
      getSession: vi.fn(() => session),
      getReplicatedStates: vi.fn(() => undefined),
      syncTraceEntries: vi.fn(),
    })
    // [code-harden RT-4#4] 旧契约「请求值兜底 + 直写」（乐观写未生效档位）已废。
    await expect(control.setThinkingLevel('s1', 'medium')).rejects.toMatchObject({
      code: SESSION_NOT_ACTIVE,
    })
    expect(session.thinkingLevel).toBe('medium') // 双写缓存不被未生效档位污染（初值不变）
  })
})
