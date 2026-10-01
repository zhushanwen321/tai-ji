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
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MessageDispatcher } from '../services/session/message-dispatcher.js'
import type { IDispatcherSessionOps } from '../services/session/session-internal.js'
import type { IManagedSessionView } from '../services/session/types.js'
import type { IMessageBus } from '../services/message-bus/message-bus.js'
import type { IPiEngine, IProcessManager, PiBashResult } from '../services/ports/pi-engine.js'
import { RpcTimeoutError } from '../utils/errors.js'
import type { ServerMessage } from '@taiji/shared'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'

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
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    orphanBashRunning: false,
    ...overrides,
  }
}

interface MockOpts {
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
  // [u3b 预检改读 occupancy] sendPrompt 预检输入源改为 occupancy 投影（sendBash 预检仍读
  // 三布尔不动）。fixture 镜像真实链路的原子同步（原语「合并 + 派生」双写合一）。
  const session = makeMockSession({
    isBashRunning,
    isGenerating,
    isCompacting,
    occupancy: { turn: isGenerating ? 'generating' : 'idle', compacting: isCompacting, bash: isBashRunning },
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

  // wave:perf-w09（D1-2）：dispatcher 只依赖 publish 抽象（broker 双写腿已删），mock bus 收集发布消息
  const broadcasts: ServerMessage[] = []
  const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus

  // S2 ISP 化：结构性满足 dispatcher 窄接口（6 方法 = 实际消费面），无强转
  const svc: IDispatcherSessionOps = {
    ensureActive: vi.fn(async () => client),
    getSessionByClient: vi.fn(() => session),
    getSession: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
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
    // finally isBashRunning 复位
    expect(session.isBashRunning).toBe(false)
    // 正常返回
    expect(result).toEqual({ status: 'settled' }) // 回执 settled（已执行并收口）

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
    expect(session.isBashRunning).toBe(false)
    // 正常返回
    expect(result).toEqual({ status: 'settled' }) // 回执 settled（已执行并收口）
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
    // [S2] 与 abortBash 对称兜底：前端 message.error handler 只收口 streaming assistant
    // （不收口 role:'system' 的 streaming bash），故补发 bashResult 终态让 bash 收口。
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
    expect(session.isBashRunning).toBe(false)
    // 回执 settled+error（已执行并收口——执行失败非预检拒绝，消费方不得恢复草稿）
    expect(result).toEqual({ status: 'settled', error: 'pi boom' })
  })
})

describe('MessageDispatcher sendBash —— bash RPC 超时诚实终态（timeout-slow-flow-wallclock D2）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('D2-1: RpcTimeoutError → 合成终态 output 换诚实文案（三步恢复指引）+ 不自动 abortBash + 置孤儿标记 + 返回回执 started', async () => {
    const { dispatcher, abortBashFn, broadcasts, session } = makeMocks({
      bashError: new RpcTimeoutError('bash', 3_600_000),
    })
    const result = await dispatcher.sendBash('s1', 'sleep 3700', false)

    // 合成终态：诚实文案而非 [bash error] 技术措辞
    const end = findBashResult(broadcasts)
    expect(end).toBeDefined()
    expect(end!.payload).toMatchObject({
      sessionId: 's1',
      command: 'sleep 3700',
      exitCode: null,
      cancelled: false,
      truncated: false,
      excludeFromContext: false,
    })
    expect(end!.payload.output).toContain('已停止等待')
    expect(end!.payload.output).toContain('命令可能仍在后台运行')
    expect(end!.payload.output).toContain('abortBash')
    expect(end!.payload.output).toContain('重开本 session')
    expect(end!.payload.output).toContain('先取消再发送')
    // 旧技术措辞不再出现
    expect(end!.payload.output).not.toContain('[bash error]')
    // D2②：不自动 abort_bash——超时是「停止等待」不是「处决命令」
    expect(abortBashFn).not.toHaveBeenCalled()
    // P6 断言④：pi 侧孤儿 bash 仍在跑（诚实文案第①步承诺的 runtime 承载）
    expect(session.orphanBashRunning).toBe(true)
    // finally isBashRunning 复位（slot 释放，后续 bash 不被 busy 拒绝）
    expect(session.isBashRunning).toBe(false)
    // 回执 started：超时 = 停止等待不是处决，pi 侧孤儿仍在跑（未收口，消费方不得恢复草稿）
    expect(result).toMatchObject({ status: 'started' })
    expect(result.error).toContain('timed out')
  })

  it('D2-2: 文案如实反映 env 自定义超时（90s → 「90 秒」；1h → 「1 小时」）', async () => {
    const custom = makeMocks({ bashError: new RpcTimeoutError('bash', 90_000) })
    await custom.dispatcher.sendBash('s1', 'cmd', false)
    expect(findBashResult(custom.broadcasts)!.payload.output).toContain('命令执行超过 90 秒')

    const hour = makeMocks({ bashError: new RpcTimeoutError('bash', 3_600_000) })
    await hour.dispatcher.sendBash('s1', 'cmd', false)
    expect(findBashResult(hour.broadcasts)!.payload.output).toContain('命令执行超过 1 小时')
  })

  it('D2-3: 超时路径不广播 message.error 技术帧（P6 deviation：诚实气泡是唯一用户可见面，双条目并存已实证）', async () => {
    const { dispatcher, broadcasts } = makeMocks({ bashError: new RpcTimeoutError('bash', 3_600_000) })
    await dispatcher.sendBash('s1', 'cmd', false)
    // 聊天流只有合成诚实终态帧，无 message.error 技术行
    const errMsg = broadcasts.find((m) => m.type === 'message.error')
    expect(errMsg).toBeUndefined()
    // 诊断信息不丢失：诚实终态帧仍在（error envelope + runtime 日志承载技术细节）
    expect(findBashResult(broadcasts)).toBeDefined()
  })

  it('D2-4: 非 RpcTimeoutError 的 transport 错误维持既有 [bash error] 文案（回归守卫）', async () => {
    const { dispatcher, broadcasts } = makeMocks({ bashError: new Error('pi boom') })
    await dispatcher.sendBash('s1', 'git status', false)
    const end = findBashResult(broadcasts)
    expect(end).toBeDefined()
    expect(end!.payload.output).toBe('[bash error] pi boom')
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
    expect(session.isBashRunning).toBe(false)
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
    expect(session.isBashRunning).toBe(false)
  })

  it('D2-6: 超时孤儿形态 abortBash → abort_bash 发出 + 孤儿标记清除 + sent:true（P6 断言④复验）', async () => {
    // 超时链路：sendBash 超时 → isBashRunning 复位 + 孤儿标记置位（pi 侧 sleep 仍在跑）
    const { dispatcher, abortBashFn, broadcasts, session } = makeMocks({
      bashError: new RpcTimeoutError('bash', 3_600_000),
    })
    await dispatcher.sendBash('s1', 'sleep 30', false)
    expect(session.isBashRunning).toBe(false)
    expect(session.orphanBashRunning).toBe(true)

    // 用户点取消：守卫因孤儿标记放行 → abort_bash 真实发出（旧守卫在此短路）
    const result = await dispatcher.abortBash('s1')

    expect(abortBashFn).toHaveBeenCalledTimes(1)
    // pi 确认取消 → 孤儿标记清除 + sent:true（handler 回 aborted 合理）
    expect(session.orphanBashRunning).toBe(false)
    expect(result).toEqual({ sent: true })
    // 兜底 bashAborted 独立帧广播（前端 executingBash 幂等清态，msg-pipeline-debloat D4-3）。
    // broadcasts 含一条 bashResult（超时合成终态 cancelled:false）+ 一条 bashAborted（abort 兜底）。
    expect(findBashResult(broadcasts)!.payload.cancelled).toBe(false)
    const aborted = findBashAborted(broadcasts)
    expect(aborted).toBeDefined()
    expect(aborted!.payload).toMatchObject({ sessionId: 's1' })
  })

  it('D2-7: 无 bash 且无孤儿 → 守卫短路 { sent:false } + 不调 client.abortBash（回执真实化：不得回 aborted）', async () => {
    const { dispatcher, abortBashFn, broadcasts, session } = makeMocks({})

    const result = await dispatcher.abortBash('s1')

    expect(abortBashFn).not.toHaveBeenCalled()
    expect(result).toEqual({ sent: false })
    // 短路不广播 bashAborted 兜底终态（既有行为：无条件广播会污染无 bash 场景）
    expect(findBashAborted(broadcasts)).toBeUndefined()
    expect(session.isBashRunning).toBe(false)
  })

  it('D2-8: 孤儿形态 abort_bash 失败 → sent:false + 孤儿标记保留（bash 状态未知，误清比残留更不诚实）', async () => {
    // 超时置孤儿 → abort_bash RPC 抛错（pi 卡死形态）
    const { dispatcher, session } = makeMocks({
      bashError: new RpcTimeoutError('bash', 3_600_000),
      abortBashError: new Error('pi unresponsive'),
    })
    await dispatcher.sendBash('s1', 'sleep 30', false)
    expect(session.orphanBashRunning).toBe(true)

    await expect(dispatcher.abortBash('s1')).resolves.toEqual({ sent: false })

    // 标记保留：下次 abortBash 再发一次幂等 abort_bash，比误清（谎称无孤儿）更诚实
    expect(session.orphanBashRunning).toBe(true)
  })
})

describe('MessageDispatcher sendBash 空命令（D4-3 哨兵不变式守卫删除）', () => {
  beforeEach(() => vi.clearAllMocks())

  it("D4-3: 空命令不再哨兵早退——sendBash('') 正常走执行链（哨兵帧退役为独立 message.bashAborted 后，空命令守卫的「保哨兵形态不变式」职责消灭）", async () => {
    const { dispatcher, bashFn, broadcasts, session } = makeMocks({})

    // 旧守卫：console.warn + 拒绝回执早退——它存在的唯一理由是保证 bashResult 帧
    // command 恒非空、与 command:'' 哨兵帧永不混淆。哨兵帧退役为独立帧类型后不变式不再需要。
    const result = await dispatcher.sendBash('s1', '', false)

    expect(bashFn).toHaveBeenCalledWith('', false)
    expect(findBashStart(broadcasts)).toBeDefined()
    expect(findBashResult(broadcasts)).toBeDefined()
    expect(session.isBashRunning).toBe(false)
    expect(result).toEqual({ status: 'settled' })
  })
})
