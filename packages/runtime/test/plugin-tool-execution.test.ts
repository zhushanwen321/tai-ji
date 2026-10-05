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
    const invokePromise = rpcServer.invoke('worker-1', 'plugin.tool.execute', { toolName: 'hello' })

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

  it('rejects with error response from worker', async () => {
    const sentMessages: unknown[] = []
    const mockPort = { postMessage: (msg: unknown) => { sentMessages.push(msg) } }
    rpcServer.registerWorker('worker-1', mockPort)

    const invokePromise = rpcServer.invoke('worker-1', 'test.method', {})

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
      rpcServer.invoke('unknown-worker', 'test.method', {}),
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
