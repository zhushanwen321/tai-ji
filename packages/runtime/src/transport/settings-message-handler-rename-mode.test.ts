/**
 * SettingsMessageHandler config.get/setRenameMode case 测试（设计 rename-session-three-modes u5）。
 *
 * 锁定：get reply 'config.renameMode' { mode } 透传 configService.getRenameMode；
 * set 调 configService.setRenameMode(payload.mode) 且 reply 读回生效值（归一逻辑在
 * helper 层，本测试 mock 层透传存储模拟读回）；两命令查表分派命中（handled=true）。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/settings-message-handler-rename-mode.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SettingsMessageHandler, type SettingsHandlerContext } from './settings-message-handler.js'
import type { ClientMessage, RenameMode, ServerMessage } from '@taiji/shared'

function mockCtx() {
  const replies: ServerMessage[] = []
  // 闭包模拟存储：setRenameMode 记值、getRenameMode 读回——让 reply「读回生效值」可见
  let stored: RenameMode = 'first-stop'
  const configService = {
    getRenameMode: vi.fn(() => stored),
    setRenameMode: vi.fn((mode: RenameMode) => { stored = mode }),
  }
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ type, id, payload } as unknown as ServerMessage)
    }),
    configService,
    sessionService: {},
    modelService: {},
    authService: {},
    skillRegistry: {},
    projectRoot: '/test',
    nextPushId: vi.fn(() => 'push_1'),
    broadcast: vi.fn(),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, configService }
}

const WS = {} as never

describe('SettingsMessageHandler · config.getRenameMode', () => {
  it('reply config.renameMode 透传 { mode }（默认 first-stop）', async () => {
    const { ctx, replies } = mockCtx()
    const handler = new SettingsMessageHandler(ctx)
    const handled = await handler.handleSettingsMessage(
      { type: 'config.getRenameMode', payload: {}, id: 'm1' } as unknown as ClientMessage,
      WS,
    )
    expect(handled).toBe(true)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: 'config.renameMode', id: 'm1' })
    expect(replies[0].payload).toEqual({ mode: 'first-stop' })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })
})

describe('SettingsMessageHandler · config.setRenameMode', () => {
  it('成功：调 setRenameMode(payload.mode) + reply 读回生效值', async () => {
    const { ctx, replies, configService } = mockCtx()
    const handler = new SettingsMessageHandler(ctx)
    const handled = await handler.handleSettingsMessage(
      { type: 'config.setRenameMode', payload: { mode: 'agent-tool' }, id: 'm2' } as unknown as ClientMessage,
      WS,
    )
    expect(handled).toBe(true)
    expect(configService.setRenameMode).toHaveBeenCalledWith('agent-tool')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: 'config.renameMode', id: 'm2' })
    expect(replies[0].payload).toEqual({ mode: 'agent-tool' })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('set 后 get：reply 反映新值（读回生效值语义）', async () => {
    const { ctx, replies } = mockCtx()
    const handler = new SettingsMessageHandler(ctx)
    await handler.handleSettingsMessage(
      { type: 'config.setRenameMode', payload: { mode: 'first-prompt' }, id: 'm3' } as unknown as ClientMessage,
      WS,
    )
    await handler.handleSettingsMessage(
      { type: 'config.getRenameMode', payload: {}, id: 'm4' } as unknown as ClientMessage,
      WS,
    )
    expect(replies).toHaveLength(2)
    expect(replies[0].payload).toEqual({ mode: 'first-prompt' })
    expect(replies[1].payload).toEqual({ mode: 'first-prompt' })
  })
})
