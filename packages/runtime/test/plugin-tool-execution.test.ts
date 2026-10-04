/**
 * Tool Execution via RPC — TDD tests for BG1 Task 1（pi1-disposition-chat-flow D7 收窄）
 *
 * [pi1-disposition-chat-flow D7①] PluginService.handleBridgeToolExecute 链路段与工具执行
 * 诚实超时文案段随 plugin-bridge 整体退役删除（断言对象已无生产载体）。
 * 保留：PluginRpcServer.invoke 直测、resolveToolTimeoutMs 分支表（函数迁驻 tool-timeout，
 * commands-executor 命令超时取值链消费）、P-9 迟到回包丢弃路径（改经 rpcServer.invoke 直调
 * 驱动，PendingTracker 行为不变）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import {
  resolveToolTimeoutMs,
  DEFAULT_TOOL_EXECUTE_TIMEOUT_MS,
} from '../src/services/plugin-service/tool-timeout.js'

// ══════════════════════════════════════════════════════════════════
// PluginRpcServer.invoke
// ══════════════════════════════════════════════════════════════════

describe('PluginRpcServer.invoke', () => {
  let rpcServer: PluginRpcServer

  beforeEach(() => {
    rpcServer = new PluginRpcServer()
  })

  it('sends RPC request and resolves on response', async () => {
    // Mock a worker port that captures messages
    const sentMessages: unknown[] = []
    const mockPort = { postMessage: (msg: unknown) => { sentMessages.push(msg) } }
    rpcServer.registerWorker('worker-1', mockPort)

    // Invoke in background
    const invokePromise = rpcServer.invoke('worker-1', 'plugin.tool.execute', { toolName: 'hello' }, 5_000)

    // Should have sent a request message
    expect(sentMessages).toHaveLength(1)
    const sent = sentMessages[0] as { type: string; request: Record<string, unknown> }
    expect(sent.type).toBe('rpc')
    expect(sent.request.method).toBe('plugin.tool.execute')
    expect(sent.request.params).toEqual({ toolName: 'hello' })
    expect(typeof sent.request.id).toBe('number')

    // Simulate response from worker
    const requestId = sent.request.id as number
    rpcServer.handleResponse({ jsonrpc: '2.0', id: requestId, result: { content: 'Hello!', isError: false } })

    const result = await invokePromise
    expect(result).toEqual({ content: 'Hello!', isError: false })
  })

  it('rejects on timeout', async () => {
    vi.useFakeTimers()

    const mockPort = { postMessage: vi.fn() }
    rpcServer.registerWorker('worker-1', mockPort)

    const invokePromise = rpcServer.invoke('worker-1', 'plugin.tool.execute', {}, 5_000)

    // Advance past timeout
    vi.advanceTimersByTime(5_100)

    await expect(invokePromise).rejects.toThrow('RPC timeout')

    vi.useRealTimers()
  })

  it('rejects with error response from worker', async () => {
    const sentMessages: unknown[] = []
    const mockPort = { postMessage: (msg: unknown) => { sentMessages.push(msg) } }
    rpcServer.registerWorker('worker-1', mockPort)

    const invokePromise = rpcServer.invoke('worker-1', 'test.method', {}, 5_000)

    const sent = sentMessages[0] as { request: Record<string, unknown> }
    const requestId = sent.request.id as number

    // Simulate error response
    rpcServer.handleResponse({
      jsonrpc: '2.0',
      id: requestId,
      error: { code: -32603, message: 'Internal error' },
    })

    await expect(invokePromise).rejects.toThrow('Internal error')
  })

  it('throws for unknown worker', async () => {
    await expect(
      rpcServer.invoke('unknown-worker', 'test.method', {}, 5_000),
    ).rejects.toThrow('Worker not found')
  })
})

// ══════════════════════════════════════════════════════════════════
// resolveToolTimeoutMs — D1 取值链全分支
// ══════════════════════════════════════════════════════════════════

/** Node setTimeout 域上界 2^31-1（tool-timeout 内 MAX_TIMER_DELAY_MS 的值；
 * 该常量未导出，测试以字面锚定规格，漂移即红）。 */
const TIMER_DOMAIN_MAX_MS = 2_147_483_647

describe('resolveToolTimeoutMs', () => {
  it('uses a valid positive declaration as-is (clamp no-op below the limit)', () => {
    expect(resolveToolTimeoutMs(1)).toBe(1)
    expect(resolveToolTimeoutMs(10_000)).toBe(10_000)
    expect(resolveToolTimeoutMs(600_000)).toBe(600_000)
  })

  it('clamps oversized declarations to the Node timer domain limit', () => {
    expect(resolveToolTimeoutMs(TIMER_DOMAIN_MAX_MS)).toBe(TIMER_DOMAIN_MAX_MS)
    expect(resolveToolTimeoutMs(TIMER_DOMAIN_MAX_MS + 1)).toBe(TIMER_DOMAIN_MAX_MS)
    expect(resolveToolTimeoutMs(5_000_000_000)).toBe(TIMER_DOMAIN_MAX_MS)
    expect(resolveToolTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(TIMER_DOMAIN_MAX_MS)
  })

  it('treats <=0 and ±Infinity as explicit opt-out (clamped upper bound ≈ no limit)', () => {
    expect(resolveToolTimeoutMs(0)).toBe(TIMER_DOMAIN_MAX_MS)
    expect(resolveToolTimeoutMs(-1)).toBe(TIMER_DOMAIN_MAX_MS)
    expect(resolveToolTimeoutMs(-60_000)).toBe(TIMER_DOMAIN_MAX_MS)
    expect(resolveToolTimeoutMs(Number.POSITIVE_INFINITY)).toBe(TIMER_DOMAIN_MAX_MS)
    expect(resolveToolTimeoutMs(Number.NEGATIVE_INFINITY)).toBe(TIMER_DOMAIN_MAX_MS)
  })

  it('falls back to the default for NaN / undefined (dirty values never disarm the watchdog)', () => {
    expect(resolveToolTimeoutMs(Number.NaN)).toBe(DEFAULT_TOOL_EXECUTE_TIMEOUT_MS)
    expect(resolveToolTimeoutMs(undefined)).toBe(DEFAULT_TOOL_EXECUTE_TIMEOUT_MS)
    expect(resolveToolTimeoutMs()).toBe(DEFAULT_TOOL_EXECUTE_TIMEOUT_MS)
  })
})

// ══════════════════════════════════════════════════════════════════
// P-9：迟到回包 miss 不炸（fake timers 驱动真实 invoke 链）
// ══════════════════════════════════════════════════════════════════

describe('late reply after tool timeout (P-9)', () => {
  it('drops the late reply without error and keeps the pending tracker clean', async () => {
    vi.useFakeTimers()
    try {
      const rpcServer = new PluginRpcServer()

      // 真实 PluginRpcServer（不 mock invoke）——PendingTracker timer 由 fake timers 驱动。
      // [pi1-disposition-chat-flow D7①] 原经 service.handleBridgeToolExecute 驱动（通路已
      // 退役），改直调 invoke；超时值按声明值 5s（原 resolveToolTimeoutMs(declared) 结果）。
      const sentMessages: unknown[] = []
      rpcServer.registerWorker('worker-1', {
        postMessage: (msg: unknown) => { sentMessages.push(msg) },
      })

      const execution = rpcServer.invoke('worker-1', 'plugin.tool.execute', { toolName: 'slow' }, 5_000)
      // rejects 期望先挂 handler 再推进 timer——防 reject 落在 await 之前的 unhandled 窗口
      //（原经 handleBridgeToolExecute 的 await 包装天然无此窗口，直调后需显式消掉）
      const rejection = expect(execution).rejects.toThrow('RPC timeout')

      // 推进超过声明超时（5s）→ invoke reject
      await vi.advanceTimersByTimeAsync(5_100)
      await rejection

      // 迟到回包到达：登记项已随超时删除 → miss（返回 false），不得抛异常
      const timedOutId = (sentMessages[0] as { request: { id: number } }).request.id
      let lateHandled: boolean | undefined
      expect(() => {
        lateHandled = rpcServer.handleResponse({
          jsonrpc: '2.0',
          id: timedOutId,
          result: { content: 'late result', isError: false },
        })
      }).not.toThrow()
      expect(lateHandled).toBe(false)

      // 登记表未被污染：后续请求正常收发
      const followUp = rpcServer.invoke('worker-1', 'plugin.tool.execute', {}, 5_000)
      const followUpId = (sentMessages[1] as { request: { id: number } }).request.id
      rpcServer.handleResponse({
        jsonrpc: '2.0',
        id: followUpId,
        result: { content: 'ok', isError: false },
      })
      await expect(followUp).resolves.toEqual({ content: 'ok', isError: false })
    } finally {
      vi.useRealTimers()
    }
  })
})
