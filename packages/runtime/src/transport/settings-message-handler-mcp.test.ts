/**
 * SettingsMessageHandler mcp.* 七命令路由注册测试（pi-mcp-management 装配波 u2b 验收条款①）。
 *
 * 锁定：七 type（mcp.list/add/update/setEnabled/remove/test/testCancel）经路由表查表命中并委托 McpMessageHandler
 * （service 真实例 + fake IMcpServers port——u2a fake 形态复用），reply 对应 :result 帧；
 * mcpServersService 缺省（存量测试的退化装配面）时 mcp.* 落 unknown_type（handled=false，
 * 构造器条件装配语义，tts 批缺省同构）；未知 mcp type → false（unknown_type 兜底不变）。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/settings-message-handler-mcp.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SettingsMessageHandler, type SettingsHandlerContext } from './settings-message-handler.js'
import { McpServersService } from '../services/mcp-servers-service.js'
import type { IMcpServers } from '../services/ports/mcp-servers.js'
import type { ClientMessage, McpServerEntry, ServerMessage } from '@taiji/shared'

const ENTRY: McpServerEntry = {
  name: 'filesystem',
  value: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
}

/** fake IMcpServers（fake store/probe，u2a mcp-message-handler.test 同款形态）。 */
function makeFakePort(overrides: Partial<IMcpServers> = {}): IMcpServers {
  return {
    list: vi.fn(() => ({ servers: [ENTRY], corruption: null, agentDir: '/data/agent' })),
    add: vi.fn(() => ({ ok: true, entry: ENTRY }) as const),
    update: vi.fn(() => ({ ok: true, entry: ENTRY }) as const),
    setEnabled: vi.fn((_name: string, _enabled: boolean) => ({ ok: true, entry: ENTRY }) as const),
    remove: vi.fn(() => ({ ok: true, entry: ENTRY }) as const),
    test: vi.fn((_name: string) => ({ testId: 'test-1' })),
    testCancel: vi.fn((_testId: string) => true),
    ...overrides,
  }
}

function mockCtx(portOverrides: Partial<IMcpServers> = {}) {
  const replies: ServerMessage[] = []
  const mcpServersService = new McpServersService(makeFakePort(portOverrides))
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ type, id, payload } as unknown as ServerMessage)
    }),
    configService: {},
    sessionService: {},
    modelService: {},
    authService: {},
    skillRegistry: {},
    mcpServersService,
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
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, mcpServersService }
}

const WS = {} as never

describe('SettingsMessageHandler · mcp.* 七命令路由（pi-mcp-management）', () => {
  const CASES = [
    { type: 'mcp.list', payload: {}, replyType: 'mcp.list:result', spy: 'list' },
    { type: 'mcp.add', payload: { name: 'fs', entry: ENTRY.value }, replyType: 'mcp.add:result', spy: 'add' },
    { type: 'mcp.update', payload: { name: 'fs', entry: ENTRY.value }, replyType: 'mcp.update:result', spy: 'update' },
    { type: 'mcp.setEnabled', payload: { name: 'fs', enabled: false }, replyType: 'mcp.setEnabled:result', spy: 'setEnabled' },
    { type: 'mcp.remove', payload: { name: 'fs' }, replyType: 'mcp.remove:result', spy: 'remove' },
    { type: 'mcp.test', payload: { name: 'fs' }, replyType: 'mcp.test:result', spy: 'test' },
    { type: 'mcp.testCancel', payload: { testId: 'test-1' }, replyType: 'mcp.testCancel:result', spy: 'testCancel' },
  ] as const

  for (const c of CASES) {
    it(`${c.type}：查表命中 → 委托 McpServersService.${c.spy} + reply ${c.replyType}`, async () => {
      const { ctx, replies, mcpServersService } = mockCtx()
      const handler = new SettingsMessageHandler(ctx)
      const spy = vi.spyOn(mcpServersService, c.spy)
      const handled = await handler.handleSettingsMessage(
        { type: c.type, payload: c.payload, id: 'm1' } as unknown as ClientMessage,
        WS,
      )
      expect(handled).toBe(true)
      expect(spy).toHaveBeenCalledOnce()
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ type: c.replyType, id: 'm1' })
      expect(ctx.sendError).not.toHaveBeenCalled()
    })
  }

  it('mcp.list reply payload = 清单 + 损坏错误态两态形状（透传 service 结果）', async () => {
    const { ctx, replies } = mockCtx({
      list: vi.fn(() => ({ servers: [], corruption: { filePath: '/data/agent/mcp.json', corruptCopyPath: null }, agentDir: '/data/agent' })),
    })
    const handler = new SettingsMessageHandler(ctx)
    await handler.handleSettingsMessage({ type: 'mcp.list', payload: {}, id: 'm2' } as unknown as ClientMessage, WS)
    expect(replies[0].payload).toEqual({
      servers: [],
      corruption: { filePath: '/data/agent/mcp.json', corruptCopyPath: null },
      agentDir: '/data/agent',
    })
  })

  it('mcpServersService 缺省（退化测试装配）：mcp.* 落 unknown_type（handled=false）', async () => {
    const { ctx: full } = mockCtx()
    // 摘除 mcpServersService 模拟存量测试/缺省装配面（optional 通道未注入）
    const ctxWithoutMcp = full as unknown as Record<string, unknown>
    delete ctxWithoutMcp.mcpServersService
    const handler = new SettingsMessageHandler(full)
    const handled = await handler.handleSettingsMessage(
      { type: 'mcp.list', payload: {}, id: 'm3' } as unknown as ClientMessage,
      WS,
    )
    expect(handled).toBe(false)
  })

  it('未知 mcp type → false（unknown_type 兜底不变）', async () => {
    const { ctx } = mockCtx()
    const handler = new SettingsMessageHandler(ctx)
    const handled = await handler.handleSettingsMessage(
      { type: 'mcp.reload', payload: {}, id: 'm4' } as unknown as ClientMessage,
      WS,
    )
    expect(handled).toBe(false)
  })
})
