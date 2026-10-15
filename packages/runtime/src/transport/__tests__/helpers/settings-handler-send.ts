/**
 * SettingsMessageHandler 测试共用发送骨架（transport 域 settings-message-handler-* 测试）。
 *
 * 同族测试文件（llm-retry / rename-mode / …）的 config.get 型用例共用同一段
 * 「构造 handler → 发 payload:{} 消息 → 断言 handled + 恰好一条 reply」骨架，此前
 * 各文件逐字复制（fallow 重复块告警）——按 bracket-call-window.ts 先例收敛为共享
 * helper（仅服务测试，不入生产 bundle）。
 */
import { expect } from 'vitest'
import type { ClientMessage, ServerMessage } from '@taiji/shared'
import { SettingsMessageHandler, type SettingsHandlerContext } from '../../settings-message-handler.js'

/** 测试用 WS 占位（reply mock 不消费 ws 实体，仅作 handleSettingsMessage 形参）。 */
export const TEST_WS = {} as never

/**
 * 发一条 config.get 型消息（payload:{}、id:'m1'），断言 handled=true 且 replies
 * 恰好一条，返回该 reply（调用方继续断言 type/payload/sendError）。
 */
export async function sendConfigGet(
  ctx: SettingsHandlerContext,
  replies: ServerMessage[],
  type: ClientMessage['type'],
): Promise<ServerMessage> {
  const handler = new SettingsMessageHandler(ctx)
  const handled = await handler.handleSettingsMessage(
    { type, payload: {}, id: 'm1' } as unknown as ClientMessage,
    TEST_WS,
  )
  expect(handled).toBe(true)
  expect(replies).toHaveLength(1)
  return replies[0]
}
