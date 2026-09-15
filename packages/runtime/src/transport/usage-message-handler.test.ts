/**
 * UsageMessageHandler 测试 — S6 handler 集成级测试。
 *
 * 覆盖：
 * - 正常 payload → reply 'usage.getStats:result' 带 UsageStatsResult 形状
 * - service 抛错 → sendError('usage_scan_failed') 带 id 和 hint
 *
 * mock/注入方式：参照 quota-message-handler.test.ts 惯例。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/usage-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { UsageMessageHandler, type UsageHandlerContext } from './usage-message-handler.js'
import type { ClientMessage } from '@taiji/shared'
import type { UsageStatsService } from '../services/usage/usage-stats-service.js'

function mockContext(usageStatsService: Partial<UsageStatsService>): UsageHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    usageStatsService: usageStatsService as UsageStatsService,
  }
}

function msg(type: string, id = 'm1'): ClientMessage {
  return { type, payload: {}, id } as unknown as ClientMessage
}
const WS = {} as never

describe('UsageMessageHandler · usage.getStats', () => {
  it('正常 payload → reply 带 UsageStatsResult 形状', async () => {
    const mockResult = {
      rows: [
        { date: '2026-08-25', provider: 'kimi-coding', model: 'k3-256k', project: 'test', input: 1000, output: 200, cacheRead: 50, cacheWrite: 10, costUSD: 0.005, messages: 1 },
      ],
      scannedAt: Date.now(),
      sessionCount: 1,
      skippedLines: 0,
    }
    const ctx = mockContext({ getStats: vi.fn().mockResolvedValue(mockResult) })
    const handler = new UsageMessageHandler(ctx)

    await handler.handleUsageMessage(msg('usage.getStats'), WS)

    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(WS, 'm1', 'usage.getStats:result', mockResult)
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('service 抛错 → sendError usage_scan_failed 带 id 和 hint', async () => {
    const ctx = mockContext({
      getStats: vi.fn().mockRejectedValue(new Error('ENOENT: directory not found')),
    })
    const handler = new UsageMessageHandler(ctx)

    await handler.handleUsageMessage(msg('usage.getStats'), WS)

    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      WS,
      'usage_scan_failed',
      'ENOENT: directory not found',
      'm1',
      { hint: '扫描失败，可重试；详情见 runtime 日志' },
    )
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  it('service 抛非 Error 对象 → sendError 用 String(e)', async () => {
    const ctx = mockContext({
      getStats: vi.fn().mockRejectedValue('string error'),
    })
    const handler = new UsageMessageHandler(ctx)

    await handler.handleUsageMessage(msg('usage.getStats', 'req-99'), WS)

    expect(ctx.sendError).toHaveBeenCalledWith(
      WS,
      'usage_scan_failed',
      'string error',
      'req-99',
      { hint: '扫描失败，可重试；详情见 runtime 日志' },
    )
  })

  it('正常结果带空 rows → reply 正常发出', async () => {
    const emptyResult = { rows: [], scannedAt: Date.now(), sessionCount: 0, skippedLines: 0 }
    const ctx = mockContext({ getStats: vi.fn().mockResolvedValue(emptyResult) })
    const handler = new UsageMessageHandler(ctx)

    await handler.handleUsageMessage(msg('usage.getStats'), WS)

    expect(ctx.reply).toHaveBeenCalledWith(WS, 'm1', 'usage.getStats:result', emptyResult)
    expect(ctx.sendError).not.toHaveBeenCalled()
  })
})
