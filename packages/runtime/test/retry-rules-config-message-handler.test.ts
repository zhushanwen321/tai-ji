/**
 * RetryRulesConfigMessageHandler 契约 + SettingsMessageHandler 路由接线测试
 *（subagent-observability §3.3.12 runtime 端）。
 *
 * handler 契约（先例 = retry-config / network-proxy 同款 class + handle switch）：
 * - config.getRetryRules → reply config.retryRules { builtinRules, customRules }
 * - config.setRetryRules 成功 → 服务写侧 + reply 读回终态 + broadcast 广播同帧
 * - config.setRetryRules 校验失败 → sendError(set_retry_rules_failed)，不 reply 不广播
 * - 不匹配 type → false（SettingsMessageHandler 继续路由）
 *
 * 服务层（remote-retry-rules.ts）mock——服务函数自身行为归 remote-retry-rules 域测试
 *（remote-retry-rules.test.ts），本文件只锁 handler 装配与消息形态。
 *
 * 运行：cd packages/runtime && npx vitest run test/retry-rules-config-message-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const serviceMocks = vi.hoisted(() => ({
  getBuiltinRetryRules: vi.fn(),
  readRetryRulesExtConfig: vi.fn(),
  setRetryRulesCustom: vi.fn(),
}))
vi.mock('../src/services/remote-config/remote-retry-rules.js', () => serviceMocks)

import { SettingsMessageHandler, type SettingsHandlerContext } from '../src/transport/settings-message-handler.js'
import type { ClientMessage, ServerMessage } from '@taiji/shared'

/** 最小 ctx：本域 handler 只消费 reply / sendError / broadcast / nextPushId（其余 SettingsHandlerContext 成员不触达）。 */
function makeHarness() {
  const replies: { id: string; type: string; payload: Record<string, unknown> }[] = []
  const broadcasts: ServerMessage[] = []
  const sendErrorCalls: { id: string | undefined; code: string; message: string }[] = []
  const ctx = {
    reply: vi.fn((_ws: unknown, id: string, type: string, payload: Record<string, unknown>) =>
      replies.push({ id, type, payload })),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) =>
      sendErrorCalls.push({ id, code, message })),
    broadcast: vi.fn((m: ServerMessage) => broadcasts.push(m)),
    nextPushId: vi.fn().mockReturnValue('push-rr-1'),
  }
  const handler = new SettingsMessageHandler(ctx as unknown as SettingsHandlerContext)
  return { handler, replies, broadcasts, sendErrorCalls }
}

function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}
const WS = {} as never

const BUILTIN = [{ id: 'builtin-1', name: 'b', verdict: 'retryable' as const, class: 'provider' as const, source: 'builtin' as const, match: [{ kind: 'pattern' as const, pattern: 'x' }] }]
const CUSTOM = [{ id: 'c1', name: 'c', verdict: 'non_retryable' as const, class: 'provider' as const, source: 'custom' as const, match: [{ kind: 'pattern' as const, pattern: 'y' }] }]

beforeEach(() => {
  vi.clearAllMocks()
  serviceMocks.getBuiltinRetryRules.mockReturnValue(BUILTIN)
  serviceMocks.readRetryRulesExtConfig.mockReturnValue({ version: 1, customRules: [], effectiveRules: [] })
  serviceMocks.setRetryRulesCustom.mockReturnValue({ ok: true })
})

describe('RetryRulesConfigMessageHandler（§3.3.12 runtime 端）', () => {
  it('config.getRetryRules → reply config.retryRules { builtinRules, customRules }', async () => {
    serviceMocks.readRetryRulesExtConfig.mockReturnValue({ version: 1, customRules: CUSTOM, effectiveRules: [] })
    const { handler, replies } = makeHarness()
    const handled = await handler.handleSettingsMessage(msg('config.getRetryRules', {}), WS)
    expect(handled).toBe(true)
    expect(replies[0]).toMatchObject({ id: 'm1', type: 'config.retryRules', payload: { builtinRules: BUILTIN, customRules: CUSTOM } })
  })

  it('config.setRetryRules 成功 → 写侧 + reply 读回终态 + broadcast 同帧广播', async () => {
    serviceMocks.readRetryRulesExtConfig.mockReturnValue({ version: 1, customRules: CUSTOM, effectiveRules: [] })
    const { handler, replies, broadcasts } = makeHarness()
    const handled = await handler.handleSettingsMessage(msg('config.setRetryRules', { customRules: CUSTOM }), WS)
    expect(handled).toBe(true)
    expect(serviceMocks.setRetryRulesCustom).toHaveBeenCalledWith(CUSTOM)
    expect(replies[0]).toMatchObject({ id: 'm1', type: 'config.retryRules', payload: { builtinRules: BUILTIN, customRules: CUSTOM } })
    const b = broadcasts.find((m) => m.type === 'config.retryRules')
    expect(b).toBeDefined()
    expect(b?.id).toBe('push-rr-1')
    expect(b?.payload).toMatchObject({ builtinRules: BUILTIN, customRules: CUSTOM })
  })

  it('config.setRetryRules 校验失败 → sendError(set_retry_rules_failed)，不 reply 不广播', async () => {
    serviceMocks.setRetryRulesCustom.mockReturnValue({ ok: false, errors: ['规则 ID 重复', '正则为空'] })
    const { handler, replies, broadcasts, sendErrorCalls } = makeHarness()
    const handled = await handler.handleSettingsMessage(msg('config.setRetryRules', { customRules: [] }), WS)
    expect(handled).toBe(true)
    expect(sendErrorCalls[0]).toMatchObject({ id: 'm1', code: 'set_retry_rules_failed', message: '规则 ID 重复；正则为空' })
    expect(replies).toHaveLength(0)
    expect(broadcasts).toHaveLength(0)
  })

  it('不匹配 type 返回 false（路由继续，settings-message-handler 落 unknown_type 兜底）', async () => {
    const { handler } = makeHarness()
    await expect(handler.handleSettingsMessage(msg('retryRules.notAType', {}), WS)).resolves.toBe(false)
  })
})
