/**
 * chat domain send clientUuid 透传单测（session-occupancy-send-closure——已删除，git 可追溯——u3-p1-renderer 验收 4）。
 *
 * 覆盖：
 * - send 带 options.clientUuid → message.send payload 含 clientUuid（RPC 参数透传，
 *   runtime 拒绝时 send.rejected 原样回带的通路）
 * - send 不带 options → payload 不含 clientUuid 键（既有 payload 形态不变，向后兼容）
 * - images 与 clientUuid 并存 → 两键齐全
 *
 * mock 策略：vi.mock core request 模块捕获 command 调用（对齐 chat-send-images.test.ts；
 * u5 re-anchor 删除 @/api/* bridge 后，说明符直指 core 模块文件——跨包相对路径）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/api/chat-send-client-uuid.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const commandMock = vi.fn()
vi.mock('../../../../core/src/transport/api/request', () => ({
  command: (...args: unknown[]) => commandMock(...args),
}))

import { send } from '@xyz-agent/core/transport/api/domains/chat'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../../../../core/src/transport/api/pending'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('chat.send clientUuid 透传（session-occupancy D2）', () => {
  it('带 options.clientUuid → payload 含 clientUuid（api-port → 实现 → ws 参数）', async () => {
    commandMock.mockResolvedValue(undefined)

    await send('s1', 'hi', undefined, { clientUuid: 'u-abc-123' })

    expect(commandMock).toHaveBeenCalledTimes(1)
    expect(commandMock).toHaveBeenCalledWith('message.send', {
      sessionId: 's1',
      content: 'hi',
      clientUuid: 'u-abc-123',
    }, RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('不带 options → payload 不含 clientUuid 键（既有流量形态不变）', async () => {
    commandMock.mockResolvedValue(undefined)

    await send('s1', 'hi')

    const payload = commandMock.mock.calls[0]![1] as Record<string, unknown>
    expect('clientUuid' in payload).toBe(false)
  })

  it('images 与 clientUuid 并存 → 两键齐全（归一展开不互斥）', async () => {
    commandMock.mockResolvedValue(undefined)
    const images = [{ data: 'BASE64', mimeType: 'image/png' }]

    await send('s1', 'hi', images, { clientUuid: 'u-abc-123' })

    expect(commandMock).toHaveBeenCalledWith('message.send', {
      sessionId: 's1',
      content: 'hi',
      images: [{ data: 'BASE64', mimeType: 'image/png' }],
      clientUuid: 'u-abc-123',
    }, RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('options 空对象（clientUuid undefined）→ payload 不含 clientUuid 键', async () => {
    commandMock.mockResolvedValue(undefined)

    await send('s1', 'hi', undefined, {})

    const payload = commandMock.mock.calls[0]![1] as Record<string, unknown>
    expect('clientUuid' in payload).toBe(false)
  })
})
