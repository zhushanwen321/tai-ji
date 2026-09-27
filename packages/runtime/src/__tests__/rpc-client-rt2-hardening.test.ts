/**
 * RpcClient RT-2 批次加固测试（code-harden 审计批次 4 Wave 1，RT-2 组 #3b/#4/#6）。
 *
 * 锁定：
 * - #3b listener 隔离：handleMessage 直通路径的 listener 循环 per-listener try/catch
 *   （对齐 replayEarlyFrameBuffer 的 D5 范式）——首个 listener（EventAdapter 翻译链）
 *   抛错不再中断循环，本帧对后续 listener（handoff 的 agent_end 探测）必达，异常不再
 *   被 readline line handler 的 catch 误记「stdout parse error」。
 * - #4 形状守卫（bash 式，对照 getAvailableModels）：getCommands 的 data.commands
 *   缺失/非数组、getSessionStats 的 data 缺失、compact 的 data 缺失/缺 port 契约三必填
 *   字段（summary/firstKeptEntryId/tokensBefore）均 warn + reject，不再 `?? []`
 *   / `?? {}` 折合法空值形态（曾致命令面板静默清空、协议异常被「无值」语义掩盖）。
 *   合法空值（commands=[]）仍照常 resolve——协议异常与合法空值分流。
 * - #6 proc 'error' terminate 出口：error（spawn ENOENT 等无伴随 exit 的形态）补齐
 *   exit 处置链全部收口——_exited 置位 + rejectAll + piSessionLog.end() + exitCallbacks
 *   通知（code=null）；error 后 exit 再到场时通知幂等（恰好一次）。
 *
 * 策略：与 rpc-client-response-guard.test.ts 同构——mock node:child_process + emitPiLine
 * 投递伪造 pi stdout 行；进程级 error/exit 经 helper 的 emitProcError / emitProcExit 驱动。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/rpc-client-rt2-hardening.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RpcClient, PiMessage } from '../infra/pi/rpc-client.js'
import {
  clearExitHandlers,
  emitPiLine,
  emitProcError,
  emitProcExit,
  lastWrittenJson,
  resetRpcClientMock,
} from '../../test/helpers/rpc-client-mock'
const clientOpts = { startupDelayMs: 0 } as const // 测试注入：启动确认窗口归零（窗口语义不变，见 RpcClientOptions.startupDelayMs）

// ── Mocks（工厂单源在 test/helpers/rpc-client-mock.ts，vi.mock 声明留本文件——路径按本文件解析）──

vi.mock('node:child_process', async () =>
  (await import('../../test/helpers/rpc-client-mock')).childProcessModule())

vi.mock('@taiji/shared', async () =>
  (await import('../../test/helpers/rpc-client-mock')).sharedModule())

vi.mock('@taiji/shared/paths', async () =>
  (await import('../../test/helpers/rpc-client-mock')).sharedPathsModule())

vi.mock('node:os', async () =>
  (await import('../../test/helpers/rpc-client-mock')).osModule())

vi.mock('../infra/pi/pi-paths.js', async () =>
  (await import('../../test/helpers/rpc-client-mock')).piPathsModule())

vi.mock('../infra/pi/pi-provider-store.js', async () =>
  (await import('../../test/helpers/rpc-client-mock')).piProviderStoreModule())

// RT-2#6 piSessionLog.end 断言需要拿到 mock 实例：单例 mock 对象（helper 的工厂每次
// 调用新建对象，测试侧拿不到引用）；writePiCrashLog 补 mock 面（error 路径会触发
// writeCrashLogIfNeeded，真实导出被 vi.mock 工厂替换后缺失会 TypeError）。
const piSessionLogMock = vi.hoisted(() => ({ write: vi.fn(), end: vi.fn() }))
vi.mock('../infra/logger.js', () => ({
  createPiSessionLog: () => piSessionLogMock,
  writePiCrashLog: vi.fn(),
  captureMemorySnapshot: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }),
}))

/** 等一个 macrotask，让 promise 的 settle 状态可观测 */
async function nextMacrotask(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

/** 发起 RPC 并伪造 pi 的 response 帧（resolve / reject 都经真实 sendCommand 路径） */
async function respondWith(client: RpcClient, send: () => Promise<unknown>, frame: Record<string, unknown>): Promise<unknown> {
  const p = send()
  await Promise.resolve()
  const sent = lastWrittenJson()
  emitPiLine({ type: 'response', success: true, ...frame, id: sent.id })
  return p
}

// ── Tests ────────────────────────────────────────────────────────

describe('RpcClient RT-2 加固：listener 隔离（#3b）', () => {
  let client: RpcClient

  beforeEach(async () => {
    resetRpcClientMock()
    piSessionLogMock.end.mockClear()
    const { RpcClient } = await import('../infra/pi/rpc-client.js')
    client = new RpcClient({ ...clientOpts, cwd: '/project' })
    await client.start()
  })

  afterEach(async () => {
    try { await client.kill() } catch { /* noop */ }
    clearExitHandlers()
  })

  it('首个 listener 抛错不阻断后续 listener 收到本帧（隔离 + 留痕）', async () => {
    const received: PiMessage[] = []
    const throwing = vi.fn(() => { throw new Error('adapter boom') })
    client.onEvent(throwing)
    client.onEvent((msg) => { received.push(msg) })

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // 修复前：listener 抛错沿 emitPiLine 调用栈同步逃逸（本行直接 throw），后续
      // listener 丢帧且异常被 readline catch 误记「stdout parse error」
      emitPiLine({ type: 'queue_update', steering: ['a'], followUp: [] })
    } finally {
      errSpy.mockRestore()
    }

    expect(throwing).toHaveBeenCalledTimes(1)
    expect(received).toHaveLength(1)
    expect((received[0] as { type?: string }).type).toBe('queue_update')
  })

  it('隔离日志留痕（[rpc] listener threw）', async () => {
    client.onEvent(() => { throw new Error('boom-2') })
    client.onEvent(() => { /* 第二 listener 收帧即返 */ })

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    emitPiLine({ type: 'status', status: 'idle' })
    const logged = errSpy.mock.calls.some((c) => String(c[0]).includes('listener threw'))
    errSpy.mockRestore()

    expect(logged).toBe(true)
  })
})

describe('RpcClient RT-2 加固：响应形状守卫（#4）', () => {
  let client: RpcClient

  beforeEach(async () => {
    resetRpcClientMock()
    const { RpcClient } = await import('../infra/pi/rpc-client.js')
    client = new RpcClient({ ...clientOpts, cwd: '/project' })
    await client.start()
  })

  afterEach(async () => {
    try { await client.kill() } catch { /* noop */ }
    clearExitHandlers()
  })

  it('getCommands：data.commands 缺失 → reject malformed（不再折空数组）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = client.getCommands()
    await expect(respondWith(client, () => p, { command: 'get_commands', data: {} })).rejects.toThrow(
      'getCommands: malformed response from pi (data.commands is not an array)',
    )
    warnSpy.mockRestore()
  })

  it('getCommands：data.commands 非数组 → reject malformed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = client.getCommands()
    await expect(respondWith(client, () => p, { command: 'get_commands', data: { commands: 'nope' } })).rejects.toThrow(
      'getCommands: malformed response',
    )
    warnSpy.mockRestore()
  })

  it('getCommands：commands 合法空数组照常 resolve（协议异常与合法空值分流）', async () => {
    const p = client.getCommands()
    await expect(respondWith(client, () => p, { command: 'get_commands', data: { commands: [] } })).resolves.toEqual([])
  })

  it('getSessionStats：data 缺失 → reject malformed（不再折空对象）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = client.getSessionStats()
    // 不带 data 键的 response（pi 协议异常形态）
    await expect(respondWith(client, () => p, { command: 'get_session_stats' })).rejects.toThrow(
      'getSessionStats: malformed response from pi (data is not an object)',
    )
    warnSpy.mockRestore()
  })

  it('getSessionStats：合法 stats 对象照常 resolve', async () => {
    const stats = { contextUsage: { tokens: null, contextWindow: 128000, percent: 0 } }
    const p = client.getSessionStats()
    await expect(respondWith(client, () => p, { command: 'get_session_stats', data: stats })).resolves.toEqual(stats)
  })

  it('compact：data 缺失 → reject malformed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = client.compact()
    await expect(respondWith(client, () => p, { command: 'compact' })).rejects.toThrow(
      'compact: malformed response from pi (data is not a CompactionResult with summary/firstKeptEntryId/tokensBefore)',
    )
    warnSpy.mockRestore()
  })

  it('compact：对象缺必填字段 → reject malformed（字段级守卫：port 契约三必填缺一即协议异常）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = client.compact()
    // 只有 summary，缺 firstKeptEntryId / tokensBefore——顶层对象守卫放行、字段级守卫拦截的形态
    await expect(respondWith(client, () => p, { command: 'compact', data: { summary: 's' } })).rejects.toThrow(
      'compact: malformed response from pi (data is not a CompactionResult with summary/firstKeptEntryId/tokensBefore)',
    )
    warnSpy.mockRestore()
  })

  it('compact：合法 CompactionResult 对象照常 resolve', async () => {
    const result = { summary: 's', firstKeptEntryId: 'e1', tokensBefore: 100 }
    const p = client.compact()
    await expect(respondWith(client, () => p, { command: 'compact', data: result })).resolves.toEqual(result)
  })
})

describe('RpcClient RT-2 加固：proc error terminate 出口（#6）', () => {
  let client: RpcClient

  beforeEach(async () => {
    resetRpcClientMock()
    piSessionLogMock.write.mockClear()
    piSessionLogMock.end.mockClear()
    const { RpcClient } = await import('../infra/pi/rpc-client.js')
    client = new RpcClient({ ...clientOpts, cwd: '/project', sessionId: 's-rt2-6' })
    await client.start()
  })

  afterEach(async () => {
    try { await client.kill() } catch { /* noop */ }
    clearExitHandlers()
  })

  it('proc error（spawn ENOENT 形态，无 exit）：_exited + exitCallbacks 通知 + piSessionLog.end', async () => {
    const exits: Array<[number | null, string]> = []
    client.onExit((code, stderr) => { exits.push([code, stderr]) })
    // 先写一帧 stdout，让 piSessionLog 处于「已开启」形态（end 断言有意义）
    emitPiLine({ type: 'status', status: 'idle' })
    expect(piSessionLogMock.write).toHaveBeenCalled()

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    emitProcError(new Error('spawn pi ENOENT'))
    errSpy.mockRestore()

    // 修复前：只 rejectAll——exited 不置位、exitCallbacks 永不触发（spawn 失败无 exit
    // 事件）、piSessionLog fd 悬挂
    expect(client.exited).toBe(true)
    expect(exits).toHaveLength(1)
    expect(exits[0][0]).toBeNull() // process error 路径 code = null
    expect(piSessionLogMock.end).toHaveBeenCalled()
  })

  it('proc error 后 exit 再到场：exitCallbacks 通知恰好一次（幂等防双发）', async () => {
    const exits: Array<[number | null, string]> = []
    client.onExit((code, stderr) => { exits.push([code, stderr]) })

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    emitProcError(new Error('spawn pi ENOENT'))
    // 运行中 error 后进程随后死亡（罕见形态）：exit 事件仍会到场
    emitProcExit(1)
    errSpy.mockRestore()

    expect(exits).toHaveLength(1) // 先到的 error 通知生效，exit 不双发
    expect(client.exited).toBe(true)
  })

  it('proc error 路径 reject pending RPC（不等超时）', async () => {
    const bashPromise = client.bash('echo hi')
    const expectation = expect(bashPromise).rejects.toThrow('pi process error: spawn pi ENOENT')
    await nextMacrotask() // sendCommand 已写 stdin、pending 已注册
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    emitProcError(new Error('spawn pi ENOENT'))
    errSpy.mockRestore()
    await expectation
  })
})
