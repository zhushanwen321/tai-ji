/**
 * MessageDispatcher（sendBash busy/并发/正常/错误路径、bash-message 互斥、abortBash、forceQuit、bus integration）合并测试。
 *
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper/mock 随节下沉）：
 * - message-dispatcher-bash.test.ts
 * - message-dispatcher-force-quit.test.ts
 * - dispatcher-bus.test.ts
 *
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/message-dispatcher-bus.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ServerMessage } from '@taiji/shared'
import { flushDelivery } from '../../test/helpers/flush-delivery.js'
import type { IMessageBus } from '../services/message-bus/message-bus.js'
import type { IPiEngine, IProcessManager, PiBashResult } from '../services/ports/pi-engine.js'
import { MessageDispatcher } from '../services/session/message-dispatcher.js'
import { createSessionDeliveryRegistry } from '../services/session/session-delivery-registry.js'
import type { IDispatcherSessionOps } from '../services/session/session-internal.js'
import type { IManagedSessionView } from '../services/session/types.js'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'

describe('message-dispatcher-bash', () => {
/**
 * MessageDispatcher bash 执行链路测试（composer-bash-execute W1 + W2 并发放宽）。
 *
 * 锁定：
 * - T4: sendBash busy 时（isBashRunning=true）→ 广播 send.rejected{reason:'busy'} + 不调 client.bash + 返回回执 rejected
 * - T4c: sendBash isCompacting=true → 同样 reject（bash↔compact 互斥仍保留）
 * - T4b(w2+W1): sendBash isGenerating=true → 允许并发（不 reject）+ 双分支延迟：bashStart 即时，
 *           bashResult 压入 per-session 待落列（镜像 pi _pendingBashMessages），flush 时按序发布。
 *           W2 放宽：bash 与 AI streaming 并发（对齐 pi-tui）；W1 fix-chat-flow-order D2：
 *           live 入流位置对齐 pi 落盘位置（级联末）。仅保留 bash↔bash（T4）/ bash↔compacting（T4c）互斥。
 * - T4b-flush / T4b-flush-noop / T4b-error-immediate：待落列 flush 顺序 / no-op / 错误帧不延迟。
 * - T5: sendBash 正常 → 广播 message.bashStart → client.bash resolve → 广播 message.bashResult（完整字段）+ finally isBashRunning 复位 false
 * - T6: sendBash client.bash reject → 广播 message.error + finally isBashRunning 复位 + 返回回执 settled+error
 * - T7: sendMessage 互斥（isBashRunning=true 时 sendMessage → 广播 send.rejected + 不调 client.prompt）—— G1 修复
 *       注意：sendMessage 预检本期不放宽（spec OQ-1），isGenerating/isBashRunning/isCompacting 三者仍互斥。
 * - T8: abortBash → client.abortBash() 调用 + 广播 message.bashAborted 兜底终态（D4-3 独立帧，
 *       原 bashResult{command:''} 哨兵退役）+ isBashRunning 复位
 *
 * mock 模式参考 test/message-dispatcher-precheck.test.ts（makeMocks/makeMockSession），
 * 扩展：client 加 bash/abortBash，session.isBashRunning 需可设。
 *
 * 运行：npx vitest run src/__tests__/message-dispatcher-bash.test.ts
 */
/** bash 相关广播消息的类型收窄（ServerMessage 是泛型 interface 非 union，find 无法自动收窄 payload） */
type BashStartMsg = ServerMessage<'message.bashStart'>
type BashResultMsg = ServerMessage<'message.bashResult'>
type BashAbortedMsg = ServerMessage<'message.bashAborted'>
function findBashStart(b: ServerMessage[]): BashStartMsg | undefined {
  return b.find((m) => m.type === 'message.bashStart') as BashStartMsg | undefined
}
function findBashResult(b: ServerMessage[]): BashResultMsg | undefined {
  return b.find((m) => m.type === 'message.bashResult') as BashResultMsg | undefined
}
function findBashAborted(b: ServerMessage[]): BashAbortedMsg | undefined {
  return b.find((m) => m.type === 'message.bashAborted') as BashAbortedMsg | undefined
}

function makeMockSession(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
        bashRunToken: undefined,
    ...overrides,
  }
}

interface MockOpts { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
  isBashRunning?: boolean
  isGenerating?: boolean
  isCompacting?: boolean
  bashResult?: PiBashResult
  bashError?: Error
  promptError?: Error
  abortBashError?: Error
}

function makeMocks(opts: MockOpts = {}) {
  const isBashRunning = opts.isBashRunning ?? false
  const isGenerating = opts.isGenerating ?? false
  const isCompacting = opts.isCompacting ?? false
  // [u3b 预检改读 occupancy → D1 全量迁移] 预检读口统一 = occupancy 派生（fixture 直写四维）。
  const session = makeMockSession({
    occupancy: { turn: isGenerating ? 'generating' : 'idle', compacting: isCompacting, bash: isBashRunning, handingOff: false },
  })

  const bashFn = opts.bashResult
    ? vi.fn(async () => opts.bashResult!)
    : opts.bashError
      ? vi.fn(async () => { throw opts.bashError! })
      : vi.fn(async () => ({
          output: 'ok',
          exitCode: 0,
          cancelled: false,
          truncated: false,
        }) as PiBashResult)

  const abortBashFn = opts.abortBashError
    ? vi.fn(async () => { throw opts.abortBashError! })
    : vi.fn(async () => ({}) as Awaited<ReturnType<IPiEngine['abortBash']>>)

  const promptFn = opts.promptError
    ? vi.fn(async () => { throw opts.promptError! })
    : vi.fn(async () => ({}) as unknown as Awaited<ReturnType<IPiEngine['prompt']>>)

  // touchActivity：sendPrompt 入口同步 touch（idle-pi-reclamation D6-1）经 pm.getClient
  // 到达 fake client——fake 须补齐该接口成员
  const client = { prompt: promptFn, bash: bashFn, abortBash: abortBashFn, touchActivity: vi.fn() } as unknown as IPiEngine

  // wave:perf-w09（D1-2）：dispatcher 只依赖 publish 抽象（broker 双写路径已删），mock bus 收集发布消息
  const broadcasts: ServerMessage[] = []
  const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus

  // S2 ISP 化：结构性满足 dispatcher 窄接口（6 方法 = 消费方实际用到的全部），无强转
  const svc: IDispatcherSessionOps = {
    ensureActive: vi.fn(async () => client),
    getSessionByClient: vi.fn(() => session),
    getSession: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
    clearSessionOutcome: vi.fn(),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  }

  const pm = {
    getClient: vi.fn(() => client),
  } as unknown as IProcessManager
  const workspace = { record: vi.fn() } as unknown as WorkspaceService

  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  return { dispatcher, session, bashFn, abortBashFn, promptFn, broadcasts, bus }
}

describe('MessageDispatcher sendBash —— busy 预检（T4）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('T4: isBashRunning=true → 广播 send.rejected{reason:"busy"} + 不调 client.bash + 返回回执 rejected', async () => {
    const { dispatcher, bashFn, broadcasts } = makeMocks({ isBashRunning: true })
    const result = await dispatcher.sendBash('s1', 'git status', false)

    // 不调 client.bash
    expect(bashFn).not.toHaveBeenCalled()
    // 广播 send.rejected{reason:'busy'}
    const rejected = broadcasts.find((m) => m.type === 'send.rejected')
    expect(rejected).toBeDefined()
    expect(rejected!.payload).toMatchObject({ sessionId: 's1', reason: 'busy' })
    // 返回值
    expect(result).toEqual({ status: 'rejected' }) // 回执 rejected（未执行）
  })

  // 注意：原 T4b（isGenerating → reject）已反转 → 移至下方
  // describe('MessageDispatcher sendBash —— 并发放宽（w2, 对齐 pi-tui）') 块（W2 放宽 bash↔streaming 并发）。

  it('T4c: isCompacting=true → 广播 send.rejected{reason:"busy"} + 不调 client.bash + 返回回执 rejected', async () => {
    const { dispatcher, bashFn, broadcasts } = makeMocks({ isCompacting: true })
    const result = await dispatcher.sendBash('s1', 'echo hi', false)

    expect(bashFn).not.toHaveBeenCalled()
    const rejected = broadcasts.find((m) => m.type === 'send.rejected')
    expect(rejected).toBeDefined()
    expect(rejected!.payload).toMatchObject({ sessionId: 's1', reason: 'busy' })
    expect(result).toEqual({ status: 'rejected' }) // 回执 rejected（未执行）
  })
})

describe('MessageDispatcher sendBash —— 并发放宽 + 双分支延迟（w2 / W1 fix-chat-flow-order）', () => {
  beforeEach(() => vi.clearAllMocks())

  // W2 起放宽 bash↔streaming 并发：sendBash 预检移除 isGenerating。
  // 原因（spec C1）：pi 把 bash RPC 排入 _pendingBashMessages，待当前 turn 结束后按 JSONL 顺序回放，
  // 对 RPC 透明——runtime 侧无需排队等待。对齐 pi-tui（允许 streaming 时发 bash）。
  // [W1 fix-chat-flow-order D2] isGenerating（活跃 run）时结果进 per-session 待落列（镜像 pi
  // _pendingBashMessages），agent_settled 到达（flushPendingBashResults）才按序以帧发布——
  // live 入流位置构造性对齐 pi 落盘位置（级联末）。
  it('T4b(w2+W1): isGenerating=true → 允许并发（不 reject）→ bashStart 即时广播，bashResult 压入待落列（不即时广播），flush 时按序发布', async () => {
    const bashResult: PiBashResult = { output: 'ok', exitCode: 0, cancelled: false, truncated: false }
    const { dispatcher, bashFn, broadcasts, session } = makeMocks({ isGenerating: true, bashResult })

    const result = await dispatcher.sendBash('s1', 'echo hi', false)

    // 不广播 send.rejected（W2 放宽：isGenerating 不再阻塞 bash）
    const rejected = broadcasts.find((m) => m.type === 'send.rejected')
    expect(rejected).toBeUndefined()
    // 调 client.bash（与 T5 正常路径一致）
    expect(bashFn).toHaveBeenCalledWith('echo hi', false)
    // 广播 message.bashStart（执行中反馈即时）
    const start = findBashStart(broadcasts)
    expect(start).toBeDefined()
    expect(start!.payload).toMatchObject({ sessionId: 's1', command: 'echo hi', excludeFromContext: false })
    // [W1 D2] streaming 中：bashResult 不即时广播，压入待落列（timestamp = RPC 完成时刻）
    expect(findBashResult(broadcasts)).toBeUndefined()
    expect(session.pendingBashResults).toHaveLength(1)
    expect(session.pendingBashResults![0]).toMatchObject({
      command: 'echo hi',
      output: 'ok',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: false,
    })
    // finally bash 维复位（[D1] 读口迁移）
    expect(session.occupancy?.bash).toBe(false)
    // 正常返回
    expect(result).toEqual({ status: 'settled' }) // 回执 settled（已执行并收尾）

    // 级联结束（agent_settled → flushPendingBashResults）→ 按序以帧发布 + 清空待落列
    dispatcher.flushPendingBashResults('s1')
    const end = findBashResult(broadcasts)
    expect(end).toBeDefined()
    expect(end!.payload).toMatchObject({
      sessionId: 's1',
      command: 'echo hi',
      output: 'ok',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: false,
    })
    expect(session.pendingBashResults).toHaveLength(0)
  })

  it('T4b-flush: 同级联两条 bash → 待落列按 RPC 完成序，flush 一次按序发布两条', async () => {
    // 顺序两次 sendBash（bash↔bash 互斥天然串行：第一次 finally 复位 isBashRunning 后第二次才可发）
    const mocks = makeMocks({ isGenerating: true })
    mocks.bashFn.mockImplementation(async () => ({ output: 'first-out', exitCode: 0, cancelled: false, truncated: false }) as PiBashResult)
    await mocks.dispatcher.sendBash('s1', 'cmd-1', false)
    mocks.bashFn.mockImplementation(async () => ({ output: 'second-out', exitCode: 0, cancelled: false, truncated: false }) as PiBashResult)
    await mocks.dispatcher.sendBash('s1', 'cmd-2', false)

    // 两条都待落列（按完成序）
    expect(mocks.session.pendingBashResults?.map((d) => d.command)).toEqual(['cmd-1', 'cmd-2'])

    mocks.dispatcher.flushPendingBashResults('s1')
    const results = mocks.broadcasts.filter((m) => m.type === 'message.bashResult')
    expect(results).toHaveLength(2)
    expect(results[0].payload).toMatchObject({ command: 'cmd-1', output: 'first-out' })
    expect(results[1].payload).toMatchObject({ command: 'cmd-2', output: 'second-out' })
    expect(mocks.session.pendingBashResults).toHaveLength(0)
  })

  it('T4b-flush-noop: 无待落列 / session 不存在 → no-op 不抛、不广播', () => {
    const { dispatcher, broadcasts } = makeMocks()
    expect(() => dispatcher.flushPendingBashResults('s1')).not.toThrow()
    expect(broadcasts.filter((m) => m.type === 'message.bashResult')).toHaveLength(0)
  })

  it('T4b-error-immediate: streaming 中 RPC 失败 → 错误兜底帧立即广播（不进待落列）', async () => {
    const { dispatcher, broadcasts, session } = makeMocks({ isGenerating: true, bashError: new Error('pi boom') })
    await dispatcher.sendBash('s1', 'git status')

    // [S2] 错误兜底 bashResult 立即发布（taiji 合成帧无 pi 落盘时序语义，不延迟）
    const end = findBashResult(broadcasts)
    expect(end).toBeDefined()
    expect(end!.payload.output).toContain('pi boom')
    // 不进待落列
    expect(session.pendingBashResults).toBeUndefined()
  })
})

describe('MessageDispatcher sendBash —— 正常路径（T5）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('T5: 正常 → 广播 message.bashStart → client.bash resolve → 广播 message.bashResult(完整字段) → finally isBashRunning 复位', async () => {
    const bashResult: PiBashResult = { output: 'out', exitCode: 2, cancelled: false, truncated: true }
    const { dispatcher, bashFn, broadcasts, session } = makeMocks({ bashResult })

    const result = await dispatcher.sendBash('s1', 'ls -la', false)

    // client.bash 被调，参数透传（excludeFromContext=false）
    expect(bashFn).toHaveBeenCalledWith('ls -la', false)

    // bashStart 广播
    const start = findBashStart(broadcasts)
    expect(start).toBeDefined()
    expect(start!.payload).toMatchObject({
      sessionId: 's1',
      command: 'ls -la',
      excludeFromContext: false,
    })
    expect(typeof start!.payload.timestamp).toBe('number')

    // bashResult 广播（完整字段）
    const end = findBashResult(broadcasts)
    expect(end).toBeDefined()
    expect(end!.payload).toMatchObject({
      sessionId: 's1',
      command: 'ls -la',
      output: 'out',
      exitCode: 2,
      cancelled: false,
      truncated: true,
      excludeFromContext: false,
    })
    expect(typeof end!.payload.timestamp).toBe('number')

    // isBashRunning 复位 false（finally 兜底）
    expect(session.occupancy?.bash).toBe(false)
    // 正常返回
    expect(result).toEqual({ status: 'settled' }) // 回执 settled（已执行并收尾）
  })

  it('T5b: excludeFromContext=true 透传到 bashStart/bashResult', async () => {
    const { dispatcher, broadcasts } = makeMocks()
    await dispatcher.sendBash('s1', 'pwd', true)
    const start = findBashStart(broadcasts)
    const end = findBashResult(broadcasts)
    expect(start!.payload.excludeFromContext).toBe(true)
    expect(end!.payload.excludeFromContext).toBe(true)
  })

  it('T5c: pi 返回 exitCode undefined → bashResult.exitCode 归一为 null', async () => {
    const bashResult: PiBashResult = { output: '', exitCode: undefined, cancelled: false, truncated: false }
    const { dispatcher, broadcasts } = makeMocks({ bashResult })
    await dispatcher.sendBash('s1', 'x')
    const end = findBashResult(broadcasts)
    expect(end!.payload.exitCode).toBeNull()
  })
})

describe('MessageDispatcher sendBash —— 错误路径（T6, S2 对称兜底）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('T6: client.bash reject → 广播 message.error{message} + 补发 bashResult 终态（S2 对称兜底）+ finally isBashRunning 复位 + 返回回执 settled+error', async () => {
    const { dispatcher, broadcasts, session } = makeMocks({ bashError: new Error('pi boom') })
    const result = await dispatcher.sendBash('s1', 'git status')

    // 广播了 message.error
    const errMsg = broadcasts.find((m) => m.type === 'message.error')
    expect(errMsg).toBeDefined()
    expect(errMsg!.payload).toMatchObject({ sessionId: 's1', message: 'pi boom' })
    // [S2] 与 abortBash 对称兜底：前端 message.error handler 只收尾 streaming assistant
    // （不收尾 role:'system' 的 streaming bash），故补发 bashResult 终态让 bash 收尾。
    const end = findBashResult(broadcasts)
    expect(end).toBeDefined()
    expect(end!.payload).toMatchObject({
      sessionId: 's1',
      command: 'git status',
      cancelled: false,
      exitCode: null,
      truncated: false,
      excludeFromContext: false,
    })
    expect(typeof end!.payload.output).toBe('string')
    expect(end!.payload.output).toContain('pi boom')
    // finally isBashRunning 复位
    expect(session.occupancy?.bash).toBe(false)
    // 回执 settled+error（已执行并收尾——执行失败非预检拒绝，消费方不得恢复草稿）
    expect(result).toEqual({ status: 'settled', error: 'pi boom' })
  })
})

describe('MessageDispatcher —— bash/message 双向互斥（T7 迁移：内核持有承接，u2）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('T7: isBashRunning=true 时 sendMessage → 零 send.rejected + 不调 client.prompt（内核持有等 bash 结束）', async () => {
    const { dispatcher, promptFn, broadcasts } = makeMocks({ isBashRunning: true })
    const result = await dispatcher.sendMessage('s1', 'hello')

    // client.prompt 未被调用（bash 进行中不允许发消息——语义保持，实现从「拒绝」改为「内核持有」）
    expect(promptFn).not.toHaveBeenCalled()
    // send.rejected 退役（D5 排队取代拒绝）：busy 度不再产生拒绝广播
    expect(broadcasts.find((m) => m.type === 'send.rejected')).toBeUndefined()
    // 受理口径：RPC 不再收到 rejected ack（消息由内核 FIFO 承接，bash 结束后投递）
    expect(result.blocked).toBe(false)
    expect(result.rejected).toBeUndefined()
  })
})

describe('MessageDispatcher abortBash（T8 + P6 断言④孤儿形态）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('T8: abortBash → client.abortBash() 调用 + 广播 message.bashAborted 兜底终态 + isBashRunning 复位 + sent:true', async () => {
    const { dispatcher, abortBashFn, broadcasts, session } = makeMocks({ isBashRunning: true })

    const result = await dispatcher.abortBash('s1')

    // client.abortBash 被调
    expect(abortBashFn).toHaveBeenCalledTimes(1)
    // abort_bash 发出且 pi 确认 → sent:true（回执真实化，调用方可据此回 aborted）
    expect(result).toEqual({ sent: true })
    // 兜底广播 message.bashAborted（wire 形态 = shared ServerMessageMap['message.bashAborted']，
    // 消费侧契约锁在 core bash-effects.test.ts bashAbortedEffect 用例）
    const aborted = findBashAborted(broadcasts)
    expect(aborted).toBeDefined()
    expect(aborted!.payload).toMatchObject({ sessionId: 's1' })
    expect(typeof aborted!.payload.timestamp).toBe('number')
    // isBashRunning 复位（finally 兜底）
    expect(session.occupancy?.bash).toBe(false)
  })

  it('T8b: client.abortBash 抛异常 → 不向上抛 + sent:false（回执真实化：不得据此回 aborted）+ 兜底广播', async () => {
    const { dispatcher, broadcasts, session } = makeMocks({ isBashRunning: true, abortBashError: new Error('rpc dead') })

    // 不该 throw，且 sent=false（abort_bash 未被 pi 确认）
    await expect(dispatcher.abortBash('s1')).resolves.toEqual({ sent: false })

    // 兜底终态仍广播（message.bashAborted 独立帧，与 pi 确认与否无关）
    const aborted = findBashAborted(broadcasts)
    expect(aborted).toBeDefined()
    expect(aborted!.payload.sessionId).toBe('s1')
    // isBashRunning 仍复位
    expect(session.occupancy?.bash).toBe(false)
  })

  it('T8c: 无 bash 在跑 → 检查短路 { sent:false } + 不调 client.abortBash（回执真实化：不得回 aborted）', async () => {
    const { dispatcher, abortBashFn, broadcasts, session } = makeMocks({})

    const result = await dispatcher.abortBash('s1')

    expect(abortBashFn).not.toHaveBeenCalled()
    expect(result).toEqual({ sent: false })
    // 短路不广播 bashAborted 兜底终态（既有行为：无条件广播会污染无 bash 场景）
    expect(findBashAborted(broadcasts)).toBeUndefined()
    expect(session.occupancy?.bash).toBe(false)
  })

})

describe('MessageDispatcher sendBash 空命令（D4-3 哨兵不变式检查删除）', () => {
  beforeEach(() => vi.clearAllMocks())

  it("D4-3: 空命令不再哨兵早退——sendBash('') 正常走执行链（哨兵帧退役为独立 message.bashAborted 后，空命令检查的「保哨兵形态不变式」职责消灭）", async () => {
    const { dispatcher, bashFn, broadcasts, session } = makeMocks({})

    // 旧检查：console.warn + 拒绝回执早退——它存在的唯一理由是保证 bashResult 帧
    // command 恒非空、与 command:'' 哨兵帧永不混淆。哨兵帧退役为独立帧类型后不变式不再需要。
    const result = await dispatcher.sendBash('s1', '', false)

    expect(bashFn).toHaveBeenCalledWith('', false)
    expect(findBashStart(broadcasts)).toBeDefined()
    expect(findBashResult(broadcasts)).toBeDefined()
    expect(session.occupancy?.bash).toBe(false)
    expect(result).toEqual({ status: 'settled' })
  })
})
})

describe('message-dispatcher-force-quit', () => {
/**
 * MessageDispatcher.forceQuit / 强杀收敛编排测试（sidebar 强制退出入口）。
 *
 * 锁定：
 * - FQ1: forceQuit 活跃 session → 按序 detach → destroy → persist stopped('User forced quit') →
 *        广播 session.exited{code:null, reason:用户指引文案} → removeEntry（与 abort 超时路径同构）
 * - FQ2: forceQuit 不在活跃进程表（pm.getClient 返回 undefined）→ 幂等成功：
 *        不调 destroy/persist/removeEntry、不广播（竞态兜底，菜单渲染后 session 恰好退出）
 * - FQ3: [ADR-0122 退役] abort RPC 超时三级阶梯（W7，含真冻结判据）已随 RPC 墙钟整体
 *        删除，对应用例退役
 * - FQ4（code-harden RT-4#1）: 编排中段抛错 → 终态三步（full-reset / session.exited /
 *        removeEntry）finally 必达，异常不上抛
 * - FQ5/FQ6（code-harden RT-4#1）: 无活跃进程分支按 occupancy 分型——≠idle 继续完整
 *        收敛（不再「幂等成功」假成功）；=idle 保持幂等成功竞态兜底
 *
 * mock 模式参考 message-dispatcher-bash.test.ts 的 makeMocks。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/message-dispatcher-force-quit.test.ts
 */
type SessionExitedMsg = ServerMessage<'session.exited'>
function findSessionExited(b: ServerMessage[]): SessionExitedMsg | undefined {
  return b.find((m) => m.type === 'session.exited') as SessionExitedMsg | undefined
}

function makeMockSession(): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
        bashRunToken: undefined,
  }
}

interface MockOpts { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
  /** pm.getClient 返回值；undefined 模拟 session 不在活跃进程表 */
  active?: boolean
}

interface ForceQuitMocks { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
  dispatcher: MessageDispatcher
  destroySessionFn: ReturnType<typeof vi.fn>
  detachSessionFn: ReturnType<typeof vi.fn>
  persistOutcomeFn: ReturnType<typeof vi.fn>
  removeEntryFn: ReturnType<typeof vi.fn>
  /** svc.getSession（FQ5/FQ6 注入 occupancy 用） */
  svcGetSession: ReturnType<typeof vi.fn>
  broadcasts: ServerMessage[]
  callOrder: string[]
}

function makeMocks(opts: MockOpts = {}): ForceQuitMocks {
  const client = { abort: vi.fn(async () => ({}) as Awaited<ReturnType<IPiEngine['abort']>>) }

  const broadcasts: ServerMessage[] = []
  const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus

  // 编排顺序断言：detach → destroy → persist → removeEntry 必须按此相对顺序
  const callOrder: string[] = []
  const detachSessionFn = vi.fn(() => { callOrder.push('detach') })
  const destroySessionFn = vi.fn(async () => { callOrder.push('destroy') })
  const persistOutcomeFn = vi.fn(() => { callOrder.push('persist') })
  const removeEntryFn = vi.fn(() => { callOrder.push('remove') })

  // S2 ISP 化：结构性满足 dispatcher 窄接口（7 方法 = 消费方实际用到的全部），无强转。
  // ensureActive/getSession 不在 forceQuit/abort 收敛路径上，空 mock 即可。
  const svcGetSession = vi.fn()
  const svc: IDispatcherSessionOps = {
    getSessionByClient: vi.fn(() => makeMockSession()),
    detachSession: detachSessionFn,
    persistSessionOutcome: persistOutcomeFn,
    clearSessionOutcome: vi.fn(),
    removeSessionEntry: removeEntryFn,
    ensureActive: vi.fn(),
    getSession: svcGetSession,
  }

  const pm = {
    getClient: vi.fn(() => (opts.active === false ? undefined : client)),
    destroySession: destroySessionFn,
  } as unknown as IProcessManager

  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  return { dispatcher, destroySessionFn, detachSessionFn, persistOutcomeFn, removeEntryFn, svcGetSession, broadcasts, callOrder }
}

describe('MessageDispatcher forceQuit —— sidebar 强制退出', () => {
  it('FQ1: 活跃 session → detach→destroy→persist(stopped,User forced quit)→广播 session.exited(code:null)→removeEntry，按序执行', async () => {
    const m = makeMocks({ active: true })

    await m.dispatcher.forceQuit('s1')

    // 编排顺序：destroy 是 async 但必须在 detach 之后、persist 之前完成
    expect(m.callOrder).toEqual(['detach', 'destroy', 'persist', 'remove'])
    expect(m.persistOutcomeFn).toHaveBeenCalledWith('s1', 'stopped', 'User forced quit')
    const exited = findSessionExited(m.broadcasts)
    expect(exited).toBeDefined()
    expect(exited!.payload).toMatchObject({ sessionId: 's1', code: null })
    // exitReason 面向用户可操作：含恢复指引（重开/历史完整）
    expect(exited!.payload.reason).toContain('强制退出')
    expect(exited!.payload.reason).toContain('恢复')
  })

  it('FQ2: 不在活跃进程表 → 幂等成功：不 destroy/persist/remove、不广播', async () => {
    const m = makeMocks({ active: false })

    await expect(m.dispatcher.forceQuit('s1')).resolves.toBeUndefined()

    expect(m.destroySessionFn).not.toHaveBeenCalled()
    expect(m.persistOutcomeFn).not.toHaveBeenCalled()
    expect(m.removeEntryFn).not.toHaveBeenCalled()
    expect(m.broadcasts).toHaveLength(0)
  })

  it('FQ4: 编排中段抛错（destroy throw）→ 终态三步仍完成（full-reset + session.exited + removeEntry），不沿调用链上抛', async () => {
    const m = makeMocks({ active: true })
    ;(m.destroySessionFn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('kill exploded'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      // [code-harden RT-4#1] destroy 失败只降级日志：full-reset / session.exited / removeEntry
      // 在 finally 中必达，异常不再上抛成 uncaughtException 连坐全 runtime。
      await expect(m.dispatcher.forceQuit('s1')).resolves.toBeUndefined()

      expect(m.removeEntryFn).toHaveBeenCalledTimes(1)
      const exited = findSessionExited(m.broadcasts)
      expect(exited).toBeDefined()
      expect(exited!.payload).toMatchObject({ sessionId: 's1', code: null })
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('forceQuitSession pre-terminal steps failed'), expect.any(Error))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('FQ5: 无活跃进程但 occupancy≠idle（条目还在、turn 卡 generating）→ 继续完整收敛而非「幂等成功」假成功', async () => {
    // [code-harden RT-4#1] 旧行为：无 client 一律「幂等成功」返回——占用态卡死且事件源
    // 已断（无进程可产生 agent_settled）时，isGenerating/turn 派生视图永久滞留。改为继续收敛。
    const m = makeMocks({ active: false })
    const stuckSession = { ...makeMockSession(), occupancy: { turn: 'generating', compacting: false, bash: false, handingOff: false } }
    ;(m.svcGetSession as ReturnType<typeof vi.fn>).mockReturnValue(stuckSession)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await m.dispatcher.forceQuit('s1')

      // 完整收敛链：stopped 终态 + session.exited 广播 + removeEntry。
      //（destroySession 仍被调用——生产侧对无进程条目幂等 no-op，编排统一走同一条链。）
      expect(m.detachSessionFn).toHaveBeenCalledTimes(1)
      expect(m.persistOutcomeFn).toHaveBeenCalledWith('s1', 'stopped', 'User forced quit')
      expect(m.removeEntryFn).toHaveBeenCalledTimes(1)
      expect(findSessionExited(m.broadcasts)).toBeDefined()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('occupancy not idle'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('FQ6: 无活跃进程且占用已复位（occupancy=idle）→ 保持幂等成功（真实竞态兜底不受影响）', async () => {
    const m = makeMocks({ active: false })
    const idleSession = { ...makeMockSession(), occupancy: { turn: 'idle', compacting: false, bash: false, handingOff: false } }
    ;(m.svcGetSession as ReturnType<typeof vi.fn>).mockReturnValue(idleSession)

    await expect(m.dispatcher.forceQuit('s1')).resolves.toBeUndefined()

    expect(m.persistOutcomeFn).not.toHaveBeenCalled()
    expect(m.removeEntryFn).not.toHaveBeenCalled()
    expect(m.broadcasts).toHaveLength(0)
  })
})
})

describe('dispatcher-bus', () => {
/**
 * MessageDispatcher × MessageBus 单通道集成测试（wave:perf-w09，02 文档 D1-2）。
 *
 * 删双写后 dispatcher 只依赖 publish 抽象（broker 依赖已删除）——锁定全部 session 级
 * 命令编排消息（message.error / send.rejected / message.bashStart / message.bashResult /
 * message.complete）经 bus.publish 定向发布且恰好发布一次（无双发）；compaction 生命周期
 * 消息零发布（M4：归 interpreter 唯一编排）。
 *
 * 覆盖：
 * - sendMessage error path → bus.publish(message.error)
 * - sendMessage busy → bus.publish(send.rejected)
 * - hook blocked → bus.publish(message.error)
 * - hook error → bus.publish(message.error)
 * - abort failure → bus.publish(message.error)
 * - abort success（三分型型1: 有回合可中止）→ bus.publish(message.complete)；
 *   idle 入口（型3）/ 用户压缩取消（型2）→ no-op 零广播
 * - abort convergence（型1）→ 终态 reason 'Convergence abort (auto)'
 * - sendBash ensureActive fail → bus.publish(message.error)
 * - sendBash busy → bus.publish(send.rejected)
 * - sendBash start → bus.publish(message.bashStart)
 * - sendBash success → bus.publish(message.bashResult)
 * - sendBash error → bus.publish(message.bashResult + message.error)
 * - abortBash → bus.publish(message.bashAborted)（D4-3 兜底终态独立帧）
 * - compact（M4 事件驱动）→ 零 compaction 广播（busy/start/fail/summary/success 各路径，生命周期归 interpreter）
 * - messageBus undefined → no crash（null-safety）
 *
 * mock 策略：全部依赖 mock，不 spawn pi。
 *
 * 运行：npx vitest run test/dispatcher-bus.test.ts
 */
function makeMockSession(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
        bashRunToken: undefined,
    ...overrides,
  }
}

function makeMocks(opts: {
  isGenerating?: boolean
  isCompacting?: boolean
  isBashRunning?: boolean
  promptError?: Error
  session?: IManagedSessionView
  messageBus?: { publish: ReturnType<typeof vi.fn> }
} = {}) {
  const isGenerating = opts.isGenerating ?? false
  const isCompacting = opts.isCompacting ?? false
  const isBashRunning = opts.isBashRunning ?? false
  // [u3b 预检改读 occupancy] sendPrompt 预检输入源改为 occupancy 派生视图。fixture 镜像真实
  // 链路的原子同步（原语「合并 + 派生」双写合一）。
  const session = opts.session ?? makeMockSession({
    occupancy: { turn: isGenerating ? 'generating' : 'idle', compacting: isCompacting, bash: isBashRunning, handingOff: false },
  })
  const promptFn = opts.promptError
    ? vi.fn(async () => { throw opts.promptError! })
    : vi.fn(async () => ({}) as unknown as Awaited<ReturnType<IPiEngine['prompt']>>)
  const bashFn = vi.fn(async () => ({ output: 'ok', exitCode: 0, cancelled: false, truncated: false }))
  const abortFn = vi.fn(async () => {})
  const abortBashFn = vi.fn(async () => {})
  const steerFn = vi.fn(async () => {})
  const followUpFn = vi.fn(async () => {})
  const compactFn = vi.fn(async () => ({ summary: 'compacted summary', tokensBefore: 100, estimatedTokensAfter: 50 }))
  const client = {
    prompt: promptFn,
    bash: bashFn,
    abort: abortFn,
    abortBash: abortBashFn,
    steer: steerFn,
    followUp: followUpFn,
    compact: compactFn,
    // touchActivity：sendPrompt 入口同步 touch（idle-pi-reclamation D6-1）经 pm.getClient
    // 到达 fake client——fake 须补齐该接口成员
    touchActivity: vi.fn(),
  } as unknown as IPiEngine

  // S2 ISP 化：结构性满足 dispatcher 窄接口（7 方法 = 消费方实际用到的全部），无强转；
  // applyContextUpdate 不在窄接口（event-interpreter 组合根回调消费），随迁移移除
  const svc: IDispatcherSessionOps = {
    ensureActive: vi.fn(async () => client),
    getSessionByClient: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
    clearSessionOutcome: vi.fn(),
    getSession: vi.fn(),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  }

  const pm = {
    getClient: vi.fn(() => client),
  } as unknown as IProcessManager

  const workspace = { record: vi.fn() } as unknown as WorkspaceService

  const messageBus = opts.messageBus ?? { publish: vi.fn() }

  // [u2 投递所有权内核] 出站交接经内核适配层（dispatcher 只提交；交接异步）——fixture 按真实
  // 装配接内核（recordWorkspace 走 workspace.record，消息总线走同一 messageBus）
  const registry = createSessionDeliveryRegistry({
    getSession: (sid) => svc.getSession(sid),
    ensureActive: svc.ensureActive,
    subscribeAgentSettled: () => () => {},
    recordWorkspace: (cwd) => workspace.record(cwd),
    getMessageBus: () => messageBus as unknown as IMessageBus,
  })

  // wave:perf-w09（D1-2）：broker 双写路径已删，dispatcher 只依赖 publish 抽象（4 参构造）；
  // [MF-1-7] 注册表经 setDeliveryRegistry 后置注入（审计候选 12：构造期注入参已删）
  const dispatcher = new MessageDispatcher(svc, pm, workspace, messageBus as unknown as IMessageBus)
  dispatcher.setDeliveryRegistry(registry)
  return { dispatcher, session, promptFn, bashFn, abortFn, abortBashFn, compactFn, svc, pm, messageBus }
}

describe('message-dispatcher bus integration', () => {
  beforeEach(() => vi.clearAllMocks())

  // ── sendMessage paths ──

  it('sendMessage error path → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus } = makeMocks({
      promptError: new Error('pi crashed'),
    })
    await dispatcher.sendMessage('s1', 'hello')
    await flushDelivery(30)
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'message.error' }))
    // occupancy 帧（u5a-p3）先于 message.error 入列，按 type 定位（原 calls[0] 断言失真同步）
    const errCall = messageBus.publish.mock.calls.map((c: any[]) => c[1]).find((m: ServerMessage) => m.type === 'message.error')
    expect(errCall).toBeDefined()
    expect(errCall!.payload.message).toContain('pi crashed')
  })

  it('sendMessage busy → 零 send.rejected（u2 退役：排队取代拒绝，改由内核按 steer 承接）', async () => {
    const { dispatcher, messageBus } = makeMocks({ isGenerating: true })
    await dispatcher.sendMessage('s1', 'hello')
    await flushDelivery(30)
    // 退役路径显式断言（原 send.rejected 广播）：bus 上不再出现拒绝帧
    const types = messageBus.publish.mock.calls.map((c: unknown[]) => (c[1] as ServerMessage).type)
    expect(types).not.toContain('send.rejected')
  })

  it('hook blocked → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus } = makeMocks()
    dispatcher.setSendMessageHook(vi.fn().mockResolvedValue({ blocked: true, reason: 'blocked by hook' }))
    await dispatcher.sendMessage('s1', 'hello')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.error',
      payload: expect.objectContaining({ message: 'blocked by hook' }),
    }))
  })

  it('hook error → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus } = makeMocks()
    dispatcher.setSendMessageHook(vi.fn().mockRejectedValue(new Error('hook exploded')))
    await dispatcher.sendMessage('s1', 'hello')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.error',
      payload: expect.objectContaining({ message: expect.stringContaining('hook exploded') }),
    }))
  })

  // ── abort paths ──

  it('abort failure → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus, abortFn } = makeMocks()
    abortFn.mockRejectedValue(new Error('abort timeout'))
    await dispatcher.abort('s1')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.error',
      payload: expect.objectContaining({ message: expect.stringContaining('abort timeout') }),
    }))
  })

  it('abort success（型1: turn=generating 有回合可中止）→ bus.publish(message.complete{stopReason:aborted})', async () => {
    // [chat-flow-consistency abort 入口三分型] 成功路径收尾只在型 1（入口快照 turn ∈
    // {dispatching, generating}）发生：stopped 终态 + complete{aborted} 广播。
    // 旧用例在 idle 入口断言广播——三分型后 idle/settling 入口为型 3 no-op（见下一条）。
    const { dispatcher, messageBus, svc } = makeMocks({ isGenerating: true })
    await dispatcher.abort('s1')
    expect(svc.persistSessionOutcome).toHaveBeenCalledWith('s1', 'stopped', 'User aborted')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.complete',
      payload: expect.objectContaining({ sessionId: 's1', stopReason: 'aborted' }),
    }))
  })

  it('abort 已空闲（型3: turn=idle 无回合可中止）→ no-op：零 stopped 终态 + 零 message.complete', async () => {
    // 三分型：idle/settling 入口 pi 侧 abort 幂等 no-op——done 终态已写不覆盖（覆盖即谎报
    // 「回合被中止」）、无流式实体可收尾不广播 complete、occupancy 不动；队列对账照跑。
    const { dispatcher, svc, messageBus } = makeMocks()
    await dispatcher.abort('s1')
    expect(svc.persistSessionOutcome).not.toHaveBeenCalled()
    const types = messageBus.publish.mock.calls.map(([, m]) => (m as { type: string }).type)
    expect(types).not.toContain('message.complete')
    expect(types).not.toContain('message.error')
  })

  // ── [compaction-cancel] 压缩期中止（composer 发送位「终止压缩」钮，2026-10 用户裁决）──

  it('abort 压缩期（isCompacting ∧ ¬isGenerating）→ 压缩取消语义：零 stopped 终态 + 零 message.complete', async () => {
    // 用户中止的是压缩流程而非回合：会话仍存活且空闲，写 stopped 会在重启/重扫后误标 +
    // 骗出 restore 入口；无流式实体可收尾，message.complete{aborted} 帧语义谎报。
    const { dispatcher, svc, messageBus, abortFn } = makeMocks({ isCompacting: true })
    await dispatcher.abort('s1')
    expect(abortFn).toHaveBeenCalled() // pi 侧 abortCompaction 仍经 session.abort 执行
    expect(svc.persistSessionOutcome).not.toHaveBeenCalled()
    const types = messageBus.publish.mock.calls.map(([, m]) => (m as { type: string }).type)
    expect(types).not.toContain('message.complete')
    expect(types).not.toContain('message.error')
  })

  it('abort generating∧compacting（turn 在跑）→ 保持既有 turn abort 语义（stopped + message.complete）', async () => {
    // 阈值自动压缩与 turn 并存时点击停止 = 中止回合（pi compact 自身已 abort 过回合），
    // 终态与收尾帧必须照旧——压缩取消语义只覆盖「无 turn 在跑」形态。
    const { dispatcher, svc, messageBus } = makeMocks({ isGenerating: true, isCompacting: true })
    await dispatcher.abort('s1')
    expect(svc.persistSessionOutcome).toHaveBeenCalledWith('s1', 'stopped', 'User aborted')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.complete',
      payload: expect.objectContaining({ sessionId: 's1', stopReason: 'aborted' }),
    }))
  })

  it('abort source=convergence（型1: turn=generating）→ 终态 reason 写 Convergence abort (auto)', async () => {
    // [U2 + abort 三分型] 收敛环掐的是 runtime 自动收敛的补发 turn，终态 reason 不得谎报
    // 用户操作语义（'Convergence abort (auto)' ≠ 'User aborted'）。压缩取消语义仅限
    // source='user'——收敛环在压缩期（无回合可中止）落型 3 no-op，可观测行为与用户停止
    // 同型（零终态零广播），旧用例锁的「压缩期 convergence 写 stopped」已随三分型退役。
    const { dispatcher, svc } = makeMocks({ isGenerating: true })
    await dispatcher.abort('s1', 'convergence')
    expect(svc.persistSessionOutcome).toHaveBeenCalledWith('s1', 'stopped', 'Convergence abort (auto)')
  })

  // ── sendBash paths ──

  it('sendBash ensureActive fail → bus.publish(message.error) + 回执 rejected（未执行，不 throw）', async () => {
    const { dispatcher, messageBus, svc } = makeMocks()
    svc.ensureActive = vi.fn(async () => { throw new Error('restore failed') })
    // dmg-r1-2：restore 失败 = 未执行 → rejected 回执（不再 throw——throw 走 error envelope
    // 会丢执行状态，消费方只能保守丢草稿）
    const result = await dispatcher.sendBash('s1', 'ls')
    expect(result).toEqual({ status: 'rejected', error: 'Failed to restore session: restore failed' })
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'message.error' }))
  })

  it('sendBash busy → bus.publish(send.rejected)', async () => {
    const { dispatcher, messageBus } = makeMocks({ isBashRunning: true })
    const result = await dispatcher.sendBash('s1', 'ls')
    expect(result.status).toBe('rejected') // 未执行（busy 预检）
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'send.rejected' }))
  })

  it('sendBash start → bus.publish(message.bashStart)', async () => {
    const { dispatcher, messageBus, bashFn } = makeMocks()
    bashFn.mockResolvedValue({ output: 'file.txt', exitCode: 0, cancelled: false, truncated: false })
    await dispatcher.sendBash('s1', 'ls')
    // bashStart should be published
    const bashStartCall = messageBus.publish.mock.calls.find(
      (c: any[]) => c[1].type === 'message.bashStart',
    )
    expect(bashStartCall).toBeDefined()
    expect(bashStartCall![1].payload.command).toBe('ls')
  })

  it('sendBash success → bus.publish(message.bashResult)', async () => {
    const { dispatcher, messageBus, bashFn } = makeMocks()
    bashFn.mockResolvedValue({ output: 'file.txt', exitCode: 0, cancelled: false, truncated: false })
    await dispatcher.sendBash('s1', 'ls')
    const bashResultCall = messageBus.publish.mock.calls.find(
      (c: any[]) => c[1].type === 'message.bashResult',
    )
    expect(bashResultCall).toBeDefined()
    expect(bashResultCall![1].payload.output).toBe('file.txt')
    expect(bashResultCall![1].payload.exitCode).toBe(0)
  })

  it('sendBash error → bus.publish(message.bashResult + message.error)', async () => {
    const { dispatcher, messageBus, bashFn } = makeMocks()
    bashFn.mockRejectedValue(new Error('bash failed'))
    const result = await dispatcher.sendBash('s1', 'bad-cmd')
    expect(result.status).toBe('settled') // 已执行并收尾（失败终态已广播）
    expect(result.error).toContain('bash failed')
    // Should have both bashResult and message.error
    const types = messageBus.publish.mock.calls.map((c: any[]) => c[1].type)
    expect(types).toContain('message.bashResult')
    expect(types).toContain('message.error')
  })

  // ── abortBash path ──

  it('abortBash → bus.publish(message.bashAborted)（D4-3 兜底终态独立帧）', async () => {
    const session = makeMockSession({ bashRunToken: 'bash_123_abc', occupancy: { turn: 'idle', compacting: false, bash: true, handingOff: false } })
    const { dispatcher, messageBus } = makeMocks({ session })
    await dispatcher.abortBash('s1')
    const bashAbortedCall = messageBus.publish.mock.calls.find(
      (c: any[]) => c[1].type === 'message.bashAborted',
    )
    expect(bashAbortedCall).toBeDefined()
    expect(bashAbortedCall![1].payload).toMatchObject({ sessionId: 's1' })
  })

  // ── compact paths ──

  it('compact busy reject → 零 compaction 广播（M4：错误归 interpreter）', async () => {
    const { dispatcher, messageBus } = makeMocks({ isGenerating: true })
    await expect(dispatcher.compact('s1')).rejects.toThrow()
    // 零 compaction bus.publish（dispatcher 退化为预检+RPC+复位，生命周期由 interpreter 唯一编排）
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('compact start → 零 compaction 广播（compacting 由 interpreter 从 compaction_start 驱动）', async () => {
    const { dispatcher, messageBus, compactFn } = makeMocks()
    compactFn.mockResolvedValue({ summary: '', tokensBefore: 0, estimatedTokensAfter: 0 })
    await dispatcher.compact('s1')
    expect(compactFn).toHaveBeenCalled()
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('compact fail → 零 compaction 广播（失败提示归 interpreter 的 compaction_end{errorMessage}）', async () => {
    const { dispatcher, messageBus, compactFn } = makeMocks()
    compactFn.mockRejectedValue(new Error('compact exploded'))
    await expect(dispatcher.compact('s1')).rejects.toThrow('compact exploded')
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('compact summary → 零 compaction 广播（compactionSummary 由 interpreter 从 compaction_end 驱动）', async () => {
    const { dispatcher, messageBus, compactFn } = makeMocks()
    compactFn.mockResolvedValue({ summary: 'Did stuff', tokensBefore: 200, estimatedTokensAfter: 100 })
    await dispatcher.compact('s1')
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('compact success → 零 compaction 广播（compacted 由 interpreter 从 compaction_end 驱动）', async () => {
    const { dispatcher, messageBus, compactFn } = makeMocks()
    compactFn.mockResolvedValue({ summary: 'ok', tokensBefore: 100, estimatedTokensAfter: 50 })
    await dispatcher.compact('s1')
    expect(compactFn).toHaveBeenCalled()
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('[RT-4#10] compact 两连发：预检通过即置位（先于 RPC），第二发在事件回流前已被预检拦截', async () => {
    // 第一发 RPC 挂起（模拟压缩进行中、pi compaction_start 事件未回流的窗口——
    // 旧实现此窗口 isCompacting 恒 false，第二发预检照样通过 → 双 compaction 事件流）
    let releaseFirst!: (v: { summary: string; tokensBefore: number; estimatedTokensAfter: number }) => void
    const firstGate = new Promise<{ summary: string; tokensBefore: number; estimatedTokensAfter: number }>((resolve) => { releaseFirst = resolve })
    const { dispatcher, compactFn, session } = makeMocks()
    compactFn.mockImplementation(() => firstGate)

    const first = dispatcher.compact('s1')
    // async 函数体同步执行到第一个 await（client.compact）：置位（compacting-start）已落 session 视图
    expect(session.occupancy?.compacting).toBe(true)

    // 第二发：预检读 compacting=true → 拒绝（不发出第二个 RPC）
    const second = dispatcher.compact('s1')
    await expect(second).rejects.toThrow('Cannot compact while compaction already running')
    // 锁定 error envelope code 属性（产生点 = message-dispatcher compact 预检的
    // Object.assign(new Error(errMsg), { code: 'compact_busy' })）
    await expect(second).rejects.toMatchObject({ code: 'compact_busy' })
    expect(compactFn).toHaveBeenCalledTimes(1)

    // 第一发完成：finally 复位（compacting-end）
    releaseFirst({ summary: 'ok', tokensBefore: 100, estimatedTokensAfter: 50 })
    await first
    expect(session.occupancy?.compacting).toBe(false)
  })

  it('[RT-4#10] compact RPC 失败：finally 复位置位（transport 级失败不卡 compacting）', async () => {
    const { dispatcher, compactFn, session } = makeMocks()
    compactFn.mockRejectedValue(new Error('transport gone'))
    await expect(dispatcher.compact('s1')).rejects.toThrow('transport gone')
    expect(session.occupancy?.compacting).toBe(false)
  })

  // ── null safety ──

  it('messageBus undefined → no crash on sendMessage', async () => {
    const session = makeMockSession()
    const promptFn = vi.fn(async () => ({}) as unknown as Awaited<ReturnType<IPiEngine['prompt']>>)
    const client = { prompt: promptFn } as unknown as IPiEngine
    const svc: IDispatcherSessionOps = {
      ensureActive: vi.fn(async () => client),
      getSessionByClient: vi.fn(() => session),
      persistSessionOutcome: vi.fn(),
      clearSessionOutcome: vi.fn(),
      getSession: vi.fn(),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    }
    // getClient → undefined：无附着 client 形态（sendPrompt 入口 touch 的空检查分支）
    const pm = { getClient: vi.fn(() => undefined) } as unknown as IProcessManager
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    const dispatcher = new MessageDispatcher(svc, pm, workspace)
    // Should not throw
    const result = await dispatcher.sendMessage('s1', 'hello')
    expect(result.blocked).toBe(false)
  })

  it('messageBus undefined → no crash on abort', async () => {
    const session = makeMockSession()
    const client = { abort: vi.fn(async () => {}) } as unknown as IPiEngine
    const svc: IDispatcherSessionOps = {
      getSessionByClient: vi.fn(() => session),
      persistSessionOutcome: vi.fn(),
      clearSessionOutcome: vi.fn(),
      ensureActive: vi.fn(),
      getSession: vi.fn(),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    }
    const pm = { getClient: vi.fn(() => client) } as unknown as IProcessManager
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    const dispatcher = new MessageDispatcher(svc, pm, workspace)
    await dispatcher.abort('s1')
    // wave:perf-w09：messageBus 未注入时 abort 的 complete 终态静默丢失（旧 broadcast 路径已删），
    // 但不得 throw——组合根恒注入 bus，此处只锁 null-safety
  })

  it('messageBus undefined → no crash on compact（零广播，null-safety）', async () => {
    const session = makeMockSession()
    const compactFn = vi.fn(async () => ({ summary: 'done', tokensBefore: 100, estimatedTokensAfter: 50 }))
    const client = { compact: compactFn } as unknown as IPiEngine
    const messageBus = { publish: vi.fn() }
    const svc: IDispatcherSessionOps = {
      getSessionByClient: vi.fn(() => session),
      ensureActive: vi.fn(),
      persistSessionOutcome: vi.fn(),
      clearSessionOutcome: vi.fn(),
      getSession: vi.fn(),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    }
    const pm = { getClient: vi.fn(() => client) } as unknown as IProcessManager
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    const dispatcher = new MessageDispatcher(svc, pm, workspace, messageBus as unknown as IMessageBus)
    await dispatcher.compact('s1')
    // M4：零 compaction 发布（no crash + 无 compaction 消息）
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  // ── 单通道语义（wave:perf-w09 D1-2）──

  it('sendMessage error path → messageBus.publish 恰好 1 次（单通道，无双发）', async () => {
    const { dispatcher, messageBus } = makeMocks({
      promptError: new Error('test'),
    })
    await dispatcher.sendMessage('s1', 'hello')
    await flushDelivery(30)
    // occupancy 帧（u5a-p3：dispatching + catch 复位 idle）与 message.error 并存，
    // 本用例锁的是 message.error 单通道无双发——按 type 过滤后计数（原全量计数失真同步）。
    const errCalls = messageBus.publish.mock.calls.filter(
      (c: any[]) => c[1].type === 'message.error',
    )
    expect(errCalls).toHaveLength(1)
    expect(errCalls[0][1].type).toBe('message.error')
  })

  // ── sessionId passes through correctly ──

  it('bus.publish receives correct sessionId from sendMessage', async () => {
    const { dispatcher, messageBus } = makeMocks({
      promptError: new Error('test'),
    })
    await dispatcher.sendMessage('my-session-123', 'hello')
    await flushDelivery(30)
    expect(messageBus.publish).toHaveBeenCalledWith('my-session-123', expect.any(Object))
  })
})
})
