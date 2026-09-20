/**
 * MessageDispatcher requireCommand 原子校验 + 回执 reason 分类单测
 * （plugin-header-action-modal-points D6/AP-4，u5a 验收①②）。
 *
 * 锁定：
 * - 校验顺序：hook → restore(ensureActive) → requireCommand → busy 预检（mock 调用序断言；
 *   D6「命令缺失是确定性失败，先于瞬时忙态回报」，校验直连 client.getCommands()，不走
 *   sessionService.getCommands 的 markDirty 查询语义）
 * - 未命中：500ms × 6 次重试（P9 定案）耗尽后拒发，回执 reason:'command-missing'，
 *   prompt 未调用（E14 结构性防线：命令串永不漏进模型）；不广播 send.rejected /
 *   message.error（回执机制是唯一反馈面——send.rejected 会触发前端 defer 队列重投，
 *   插件写命令绝不能入用户队列）
 * - 命中（首次 / 重试窗口内恢复）：prompt 正常调用
 * - 无 requireCommand 且非 `/` 开头：行为不变（getCommands 零触达，既有路径回归）
 * - [u5a 收口扩展 / #12] 无 requireCommand 但 `/` 开头且命令表命中（source==='extension'）：
 *   prompt 后主动收口（occupancy idle + isGenerating=false）——pi 扩展命令无 turn 回流，
 *   不收口则 dispatching 永久卡死（手敲 /schedule list 实证：pi 已执行、零 LLM 调用，
 *   前端「思考中」永不复位被误判为「漏进模型」）
 * - [u5a 收口扩展 / #12] 未命中（进模型）/ 探测 RPC 失败 / source!=='extension'（skill:
 *   等 pi 展开形态）：不收口，等 turn 回流正常管理
 * - reason 分类：hook 拦截 → 'hook-blocked'；非 busy prompt 失败 → 'error'
 *   （busy/compacting/bash 三态由 send-rejection 与 dispatcher 主单测覆盖）
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/message-dispatcher-require-command.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MessageDispatcher } from '../services/session/message-dispatcher.js'
import type { SkillInjector } from '../services/session/skill-injector.js'
import type { IDispatcherSessionOps } from '../services/session/session-internal.js'
import type { IManagedSessionView } from '../services/session/types.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { IMessageBus } from '../services/message-bus/message-bus.js'
import type { ServerMessage } from '@taiji/shared'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'

// ── fakes ──

interface HarnessOptions {
  /** client.getCommands 的逐次返回队列（queue.shift()，耗尽后重复末项）。 */
  commandQueue?: Array<Array<{ name: string; source: string }> | Error>
  /** busy 预检输入：session 视图的 occupancy（缺省 idle 放行）。 */
  occupancy?: { turn: string; compacting: boolean; bash: boolean }
  promptError?: Error
}

function makeHarness(opts: HarnessOptions = {}) {
  const calls: string[] = []
  const getCommands = vi.fn(async () => {
    calls.push('getCommands')
    const next = opts.commandQueue?.shift()
    if (next instanceof Error) throw next
    if (next !== undefined) return next
    return opts.commandQueue?.length === 0 ? [] : (opts.commandQueue?.[opts.commandQueue!.length - 1] ?? [])
  })
  const client = {
    prompt: vi.fn(async () => {
      calls.push('prompt')
      if (opts.promptError) throw opts.promptError
      return {}
    }),
    touchActivity: vi.fn(),
    getCommands,
  }
  const session = {
    id: 's1',
    cwd: '/test',
    occupancy: opts.occupancy ?? { turn: 'idle', compacting: false, bash: false },
  } as unknown as IManagedSessionView
  const svc: IDispatcherSessionOps = {
    ensureActive: vi.fn(async () => {
      calls.push('ensureActive')
      return client as unknown as IPiEngine
    }),
    getSessionByClient: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
    getSession: vi.fn(),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  }
  const pm = { getClient: vi.fn(() => client as unknown as IPiEngine) } as unknown as IProcessManager
  const broadcasts: ServerMessage[] = []
  const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus
  const hookMock = vi.fn(async (): Promise<{ blocked: boolean; reason?: string; modifiedContent?: string } | null> => {
    calls.push('hook')
    return { blocked: false }
  })
  // 注入器透传文本（D9 骨架：sendPrompt 消费 injection.text —— 缺省实现会让 prompt 收 undefined）
  const injector = { inject: vi.fn(async (_c: unknown, text: string) => ({ text, notices: [] })) } as unknown as SkillInjector
  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus, injector)
  dispatcher.setSendMessageHook(hookMock)
  return { dispatcher, calls, client, getCommands, broadcasts, hookMock, session }
}

/** 取广播中的唯一 send.rejected / message.error（无则 undefined）。 */
const findRejected = (broadcasts: ServerMessage[]) => broadcasts.find((m) => m.type === 'send.rejected')
const findError = (broadcasts: ServerMessage[]) => broadcasts.find((m) => m.type === 'message.error')

describe('requireCommand 原子校验（D6/u5a：restore 后、busy 预检前）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('校验顺序：hook → ensureActive(restore) → getCommands → busy 预检（未命中重试全程），prompt 未调用', async () => {
    const { dispatcher, calls } = makeHarness({ commandQueue: [[]] })
    const pending = dispatcher.sendMessage('s1', '/schedule off abc', undefined, undefined, 'schedule')
    await vi.advanceTimersByTimeAsync(500 * 6 + 50)
    const result = await pending

    expect(result).toEqual({ blocked: true, rejected: true, reason: 'command-missing' })
    expect(calls[0]).toBe('hook')
    expect(calls[1]).toBe('ensureActive')
    // requireCommand 检查严格落在 restore 之后（D6 唯一无竞态位置）
    expect(calls.indexOf('getCommands')).toBeGreaterThan(calls.indexOf('ensureActive'))
    expect(calls).not.toContain('prompt')
    expect(calls.filter((c) => c === 'getCommands')).toHaveLength(7) // 初始 1 次 + 重试 6 次（P9 定案）
  })

  it('命中：prompt 正常调用（含注入器产物），回执 { blocked: false } 且无广播', async () => {
    const h = makeHarness({ commandQueue: [[{ name: 'schedule', source: 'extension' }]] })
    const result = await h.dispatcher.sendMessage('s1', '/schedule off abc', undefined, undefined, 'schedule')

    expect(result).toEqual({ blocked: false })
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    expect(h.getCommands).toHaveBeenCalledTimes(1)
    expect(findRejected(h.broadcasts)).toBeUndefined()
    expect(findError(h.broadcasts)).toBeUndefined()
  })

  it('重试窗口内恢复（P9 探针：附着→命令注册 gap 毫秒级）：第 2 次探测命中 → prompt 调用', async () => {
    const h = makeHarness({
      commandQueue: [[], [{ name: 'schedule', source: 'extension' }]],
    })
    const pending = h.dispatcher.sendMessage('s1', '/schedule list', undefined, undefined, 'schedule')
    await vi.advanceTimersByTimeAsync(500 * 6 + 50)
    const result = await pending

    expect(result).toEqual({ blocked: false })
    expect(h.getCommands).toHaveBeenCalledTimes(2)
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
  })

  it('busy 预检命中时 requireCommand 已先行（命令缺失先于忙态回报——但本例命令命中，busy 拒绝 reason 透传）', async () => {
    const { dispatcher, calls, client } = makeHarness({
      commandQueue: [[{ name: 'schedule', source: 'extension' }]],
      occupancy: { turn: 'generating', compacting: false, bash: false },
    })
    const result = await dispatcher.sendMessage('s1', '/schedule off abc', undefined, undefined, 'schedule')

    expect(result).toEqual({ blocked: true, rejected: true, reason: 'busy' })
    // 顺序证据：getCommands 在 busy 预检（拒后无 inject/prompt）之前完成
    expect(calls).toContain('getCommands')
    expect(calls).not.toContain('prompt')
    expect(client.prompt).not.toHaveBeenCalled()
  })

  it('无 requireCommand 且非 `/` 开头：行为不变——getCommands 零触达，直发成功', async () => {
    const h = makeHarness()
    const result = await h.dispatcher.sendMessage('s1', '普通消息')

    expect(result).toEqual({ blocked: false })
    expect(h.getCommands).not.toHaveBeenCalled()
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
  })

  // ── [u5a 收口扩展 / #12] 手敲链扩展命令 occupancy 收口 ──

  it('手敲 `/` 开头且命令表命中（source=extension）：prompt 后收口（isGenerating=false + occupancy idle）', async () => {
    const h = makeHarness({ commandQueue: [[{ name: 'schedule', source: 'extension' }]] })
    const result = await h.dispatcher.sendMessage('s1', '/schedule list')

    expect(result).toEqual({ blocked: false })
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    expect(h.getCommands).toHaveBeenCalledTimes(1) // 手敲链单次探测，无重试不拒发
    expect((h.session as unknown as { isGenerating: boolean }).isGenerating).toBe(false)
    expect((h.session as unknown as { occupancy: { turn: string } }).occupancy.turn).toBe('idle')
  })

  it('手敲 `/` 开头但命令表未命中（进模型）：不收口，等 turn 回流', async () => {
    const h = makeHarness({ commandQueue: [[]] })
    const result = await h.dispatcher.sendMessage('s1', '/nonexistent foo')

    expect(result).toEqual({ blocked: false })
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    expect((h.session as unknown as { isGenerating: boolean }).isGenerating).toBe(true) // dispatching flags 保持
    expect((h.session as unknown as { occupancy: { turn: string } }).occupancy.turn).toBe('dispatching')
  })

  it('skill 形态（source=skill）不收口：pi 会展开进模型、有 turn 回流', async () => {
    const h = makeHarness({ commandQueue: [[{ name: 'skill:xxx', source: 'skill' }]] })
    const result = await h.dispatcher.sendMessage('s1', '/skill:xxx 正文')

    expect(result).toEqual({ blocked: false })
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    expect((h.session as unknown as { occupancy: { turn: string } }).occupancy.turn).toBe('dispatching')
  })

  it('手敲链探测 RPC 失败：降级不收口（prompt 照发，turn 回流自愈），不拒发', async () => {
    const h = makeHarness({ commandQueue: [new Error('transport dead')] })
    const result = await h.dispatcher.sendMessage('s1', '/schedule list')

    expect(result).toEqual({ blocked: false })
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    expect((h.session as unknown as { occupancy: { turn: string } }).occupancy.turn).toBe('dispatching')
  })

  it('未命中拒发不广播 send.rejected / message.error（回执机制是唯一反馈面，防 defer 队列误重投）', async () => {
    const { dispatcher, broadcasts } = makeHarness({ commandQueue: [[]] })
    const pending = dispatcher.sendMessage('s1', '/schedule off abc', undefined, undefined, 'schedule')
    await vi.advanceTimersByTimeAsync(500 * 6 + 50)
    await pending

    expect(findRejected(broadcasts)).toBeUndefined()
    expect(findError(broadcasts)).toBeUndefined()
  })

  it('探测 RPC 抛错视同未命中参与重试，预算耗尽后拒发（fail-closed）', async () => {
    const { dispatcher, client } = makeHarness({ commandQueue: [new Error('transport dead')] })
    const pending = dispatcher.sendMessage('s1', '/schedule off abc', undefined, undefined, 'schedule')
    await vi.advanceTimersByTimeAsync(500 * 6 + 50)
    const result = await pending

    expect(result).toEqual({ blocked: true, rejected: true, reason: 'command-missing' })
    expect(client.prompt).not.toHaveBeenCalled()
  })
})

describe('reason 分类（D6/u5a 回执词表增量）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hook 拦截 → reason:"hook-blocked"（且先于 restore/命令校验，getCommands 零触达）', async () => {
    const h = makeHarness()
    // mockImplementation（非 mockResolvedValue）：保留 calls.push('hook') 的调用序记录
    h.hookMock.mockImplementation(async () => {
      h.calls.push('hook')
      return { blocked: true, reason: 'policy' }
    })
    const result = await h.dispatcher.sendMessage('s1', 'x', undefined, undefined, 'schedule')

    expect(result).toEqual({ blocked: true, reason: 'hook-blocked' })
    expect(h.getCommands).not.toHaveBeenCalled()
    expect(h.calls).toEqual(['hook'])
  })

  it('命令命中但 prompt 抛非 busy 错误 → reason:"error"', async () => {
    const { dispatcher } = makeHarness({
      commandQueue: [[{ name: 'schedule', source: 'extension' }]],
      promptError: new Error('No model configured'),
    })
    const result = await dispatcher.sendMessage('s1', '/schedule off abc', undefined, undefined, 'schedule')

    expect(result).toEqual({ blocked: true, reason: 'error' })
  })
})
