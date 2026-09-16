/**
 * MessageDispatcher 入口同步 touch 测试（idle-pi-reclamation 设计 D6-1；u2 内核化后更新）。
 *
 * 锁定：
 * - 入口 touch 在**任何 await 之前**同步执行：sendMessage 调用返回后（微任务/宏任务
 *   推进前）client 的空闲时钟已刷新——出站交接（ensureActive（restore 600ms-3s）→
 *   inject → prompt）在投递内核适配层异步发生，「hook 执行中 + 交接在途」窗口靠本
 *   touch 关闭（reaper 判定刚 touch 过 → 不满足空闲阈值）
 * - 调用序（u2：出站交接异步化后经 flush 观察完整链）：touch 先于 hook 先于
 *   restore（ensureActive）先于 prompt——与迁移前逐字一致
 * - client 未附着（pm.getClient → undefined，已回收态）不 touch 也不炸：restore 路径
 *   spawn 的新 client lastActivityAt 初值 = spawn 时刻，天然不满足回收阈值
 *
 * 红性：把入口 touch 移到任一 await 之后（复刻 markSessionActive 的位置），同步断言
 * order === ['touch'] 必红；删掉 undefined 守卫直接调用，未附着用例必红。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/services/message-dispatcher-entry-touch.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { MessageDispatcher } from '../../services/session/message-dispatcher.js'
import {
  createSessionDeliveryRegistry,
  resetActiveDeliveryRegistryForTest,
  type SessionDeliveryDeps,
} from '../../services/session/session-delivery-registry.js'
import type { IDispatcherSessionOps } from '../../services/session/session-internal.js'
import type { IPiEngine, IProcessManager } from '../../services/ports/pi-engine.js'
import type { IMessageBus } from '../../services/message-bus/message-bus.js'
import type { WorkspaceService } from '../../services/workspace/workspace-service.js'

interface Fixture {
  dispatcher: MessageDispatcher
  /** 调用序记录：touch / hook / restore / prompt 按实际发生顺序 push。 */
  order: string[]
  touchActivity: ReturnType<typeof vi.fn>
  promptFn: ReturnType<typeof vi.fn>
  ensureActive: ReturnType<typeof vi.fn>
  hook: ReturnType<typeof vi.fn>
}

/** 构造最小 dispatcher fixture。attached=false 模拟 session 已回收（无附着 client）。 */
function makeFixture(attached = true): Fixture {
  const order: string[] = []
  const touchActivity = vi.fn(() => { order.push('touch') })
  const promptFn = vi.fn(async () => { order.push('prompt'); return {} })
  const client = { prompt: promptFn, touchActivity } as unknown as IPiEngine

  const hook = vi.fn(async () => { order.push('hook'); return null })
  const ensureActive = vi.fn(async () => { order.push('restore'); return client })

  const svc: IDispatcherSessionOps = {
    // getSessionByClient → undefined：跳过 busy 预检与 markSessionActive，链路聚焦
    // 入口 touch 的时序（预检/标记是 send-rejection 等既有测试的覆盖域）
    ensureActive,
    getSessionByClient: vi.fn(() => undefined),
    persistSessionOutcome: vi.fn(),
    getSession: vi.fn(),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  }

  const pm = {
    getClient: vi.fn(() => (attached ? client : undefined)),
  } as unknown as IProcessManager

  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const bus = { publish: vi.fn() } as unknown as IMessageBus

  // u2：出站交接经投递内核适配层（dispatcher 只提交，交接异步）——fixture 按真实装配接内核
  const deps: SessionDeliveryDeps = {
    getSession: (sid) => svc.getSession(sid),
    ensureActive,
    subscribeAgentSettled: () => () => {},
    recordWorkspace: (cwd) => workspace.record(cwd),
    getMessageBus: () => bus,
  }
  createSessionDeliveryRegistry(deps)
  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  dispatcher.setSendMessageHook(hook)
  return { dispatcher, order, touchActivity, promptFn, ensureActive, hook }
}

/** flush 投递交接异步链（ensureActive → inject → prompt）。 */
async function flushDelivery(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve()
}

afterEach(() => {
  resetActiveDeliveryRegistryForTest()
})

describe('MessageDispatcher 入口同步 touch（idle-pi-reclamation D6-1）', () => {
  it('入口 touch 同步执行：sendMessage 调用后（任何 await 推进前）已刷新，先于 hook/restore', async () => {
    const fx = makeFixture(true)
    const p = fx.dispatcher.sendMessage('s1', 'hello')

    // 同步时刻断言（微任务/宏任务均未推进）：touch 已发生且是调用链第一个动作。
    // hook 是 async 函数，其同步段（push('hook') 前无 await）随 sendMessage 调用栈
    // 同步执行——touch 排在 hook 前即证明入口 touch 先于任何 hook 副作用；restore
    // （ensureActive，位于 sendPrompt 首个 await 之后）尚未执行。
    expect(fx.order).toEqual(['touch', 'hook'])
    expect(fx.touchActivity).toHaveBeenCalledTimes(1)

    await p
    await flushDelivery()
    // 完整调用序：touch（入口）→ hook（BeforeSend）→ restore（ensureActive）→ prompt
    expect(fx.order).toEqual(['touch', 'hook', 'restore', 'prompt'])
  })

  it('client 未附着（已回收态）：不 touch 不炸，hook/restore 照常——restore spawn 的新 client 初值即 spawn 时刻', async () => {
    const fx = makeFixture(false)
    const p = fx.dispatcher.sendMessage('s1', 'hello')

    // 无附着 client：入口零动作（不抛 TypeError），后续链路照常推进
    expect(fx.order).toEqual(['hook'])
    await p
    await flushDelivery()

    expect(fx.order).toEqual(['hook', 'restore', 'prompt'])
    expect(fx.touchActivity).not.toHaveBeenCalled()
  })
})
