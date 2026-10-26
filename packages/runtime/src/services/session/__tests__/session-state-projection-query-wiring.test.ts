/**
 * SessionStateProjection → SessionStateQuery 接线测试（W2 权威拉取与冷读）。
 *
 * 锁定「查询服务由投影构造并绑为进程实例」这条装配路径（行为级，不探私有字段）：
 * - 投影构造期创建 SessionStateQuery，`stateQuery` 字段可达，且模块槽
 *   `getSessionStateQuery()` 返回**同一实例**（transport handler 的取用入口）；
 * - 查询的活跃判定走注入的 pm.getClient（spawn 风险点 1：禁 ensureActive）；
 * - 未注册会话（投影 replicatedStates 表无条目）且无 client → 走冷读分叉
 *   （无 fixture 时 SESSION_NOT_FOUND），证明 live 分支的门是「client + 实例快照」双条件。
 *
 * 直测环境仿 session-state-projection.test.ts（stub pm/client + 真实 MessageBus），
 * 不构造 Facade 全家桶、不起真实 pi、不触真实数据目录。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { SessionStateProjection, type SessionStateProjectionDeps } from '../session-state-projection.js'
import {
  getSessionStateQuery,
  _resetSessionStateQueryForTest,
} from '../session-state-query.js'
import { MessageBus } from '../../message-bus/message-bus.js'
import { logger } from '../../../infra/logger.js'
import type { IPiEngine, IProcessManager } from '../../ports/pi-engine.js'

function makeDeps(pm: IProcessManager): SessionStateProjectionDeps {
  return {
    pm,
    getSession: () => undefined,
    hasSession: () => false,
    getMessageBus: () => new MessageBus(),
    fetchContext: vi.fn(async () => null),
    persistSessionOutcome: vi.fn(),
    tryPersistProjectBinding: vi.fn(),
  }
}

afterEach(() => {
  _resetSessionStateQueryForTest()
})

describe('SessionStateProjection 持有 SessionStateQuery（W2 接线）', () => {
  it('构造期创建查询服务并绑定为进程实例（模块槽返回同一实例）', () => {
    const pm = { getClient: vi.fn(() => undefined) } as unknown as IProcessManager
    const projection = new SessionStateProjection(makeDeps(pm))

    expect(projection.stateQuery).toBeDefined()
    expect(getSessionStateQuery()).toBe(projection.stateQuery)
  })

  it('查询的活跃判定走注入的 pm.getClient（spawn 风险点 1：禁 ensureActive）', async () => {
    const client = { id: 'c1' } as unknown as IPiEngine
    const getClient = vi.fn(() => client)
    const ensureActive = vi.fn()
    const pm = { getClient, ensureActive } as unknown as IProcessManager
    const projection = new SessionStateProjection(makeDeps(pm))

    // 有 client 但投影实例表未注册该 session → live 分支的第二条件不满足，落冷读分叉
    await expect(projection.stateQuery.getState('s1')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })

    expect(getClient).toHaveBeenCalledWith('s1')
    expect(ensureActive).not.toHaveBeenCalled()
  })

  it('解绑后 getSessionStateQuery 返回 undefined（handler 走 unsupported 防御分支）', () => {
    const pm = { getClient: vi.fn(() => undefined) } as unknown as IProcessManager
    new SessionStateProjection(makeDeps(pm))
    expect(getSessionStateQuery()).toBeDefined()
    _resetSessionStateQueryForTest()
    expect(getSessionStateQuery()).toBeUndefined()
  })

  it('冷路径埋点接 runtime logger（设计 §3.1「可观测」栏：单次耗时 + 扫描目录数）', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    const pm = { getClient: vi.fn(() => undefined) } as unknown as IProcessManager
    const projection = new SessionStateProjection(makeDeps(pm))

    await expect(projection.stateQuery.getState('no-such-session')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })

    expect(debugSpy).toHaveBeenCalledTimes(1)
    expect(debugSpy).toHaveBeenCalledWith('[session-state-query] cold read', {
      sessionId: 'no-such-session',
      source: 'disk-scan',
      durationMs: expect.any(Number),
      scannedDirCount: expect.any(Number),
      found: false,
    })
    debugSpy.mockRestore()
  })
})
