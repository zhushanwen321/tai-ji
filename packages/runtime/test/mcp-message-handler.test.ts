/**
 * McpMessageHandler 七操作分发与 reply 形状测试（pi-mcp-management 设计）。
 *
 * 锁定（验收条款① handler 层：分发契约与 codemode-message-handler 同风格——命中返回
 * true、未命中返回 false）：
 * - 七 case 分发命中：mcp.list / mcp.add / mcp.update / mcp.setEnabled / mcp.remove /
 *   mcp.test / mcp.testCancel 查 handler 委托 McpServersService 并 reply 对应 :result 帧
 *  （payload 形状 = shared mcp.ts 协议类型）；
 * - 损坏错误态与拒入：list 损坏错误态 payload 透传（S6）；add 拒入信封经 reply 返回，
 *   不 sendError 不广播（协议信封语义，非 D10 error envelope；§3.1 拉取一次无广播帧）；
 * - test 异步任务形态：fake probe（fake port.test）被触发，reply McpTestHandle 句柄；
 *   testCancel 回 { cancelled }（D3「取消」按钮）；setEnabled reply 写后落盘终态信封；
 * - 未知 type → false（unknown_type 兜底不变）。
 *
 * 组合：真 McpServersService + fake IMcpServers（fake store/probe）——handler + service
 * 两层组合路径一次覆盖；SettingsMessageHandler 路由表挂载归 u2b 装配波。
 *
 * 运行：pnpm -C packages/runtime test mcp-message-handler
 */
import { describe, it, expect, vi } from 'vitest'
import { McpMessageHandler, type McpHandlerContext } from '../src/transport/mcp-message-handler.js'
import { McpServersService } from '../src/services/mcp-servers-service.js'
import type { IMcpServers } from '../src/services/ports/mcp-servers.js'
import type { ClientMessage, ServerMessage } from '@taiji/shared'

const ENTRY = {
  name: 'filesystem',
  value: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
}
const CORRUPTION = { filePath: '/data/agent/mcp.json', corruptCopyPath: null }

/** fake port（fake store/probe）：默认全部正常路径形状，按用例覆写单方法。 */
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

function makeHandler(portOverrides: Partial<IMcpServers> = {}) {
  const replies: { id: string | undefined; type: string; payload: unknown }[] = []
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) =>
      replies.push({ id, type, payload })),
    sendError: vi.fn(),
    mcpServersService: new McpServersService(makeFakePort(portOverrides)),
  }
  const handler = new McpMessageHandler(ctx as unknown as McpHandlerContext)
  return { handler, replies, sendError: ctx.sendError }
}

/** 构造 mcp 域请求消息（ClientMessageMap 已登记 payload 形状，构造即类型校验）。 */
function msg<K extends ClientMessage['type']>(type: K, payload: Extract<ClientMessage, { type: K }>['payload'], id = 'm1'): ClientMessage {
  return { type, id, payload } as ClientMessage
}
const WS = {} as never

describe('mcp.* 七命令 handler（分发 + reply 形状）', () => {
  it('mcp.list：分发命中 + reply mcp.list:result 清单透传', async () => {
    const { handler, replies } = makeHandler()
    const handled = await handler.handle(msg('mcp.list', {}), WS)
    expect(handled).toBe(true)
    expect(replies[0]).toEqual({ id: 'm1', type: 'mcp.list:result', payload: { servers: [ENTRY], corruption: null, agentDir: '/data/agent' } })
  })

  it('mcp.list 损坏错误态：payload = { servers: [], corruption }（S6 渲染数据源）', async () => {
    const { handler, replies } = makeHandler({
      list: vi.fn(() => ({ servers: [], corruption: CORRUPTION, agentDir: '/data/agent' })),
    })
    const handled = await handler.handle(msg('mcp.list', {}, 'm2'), WS)
    expect(handled).toBe(true)
    expect(replies[0]).toEqual({
      id: 'm2',
      type: 'mcp.list:result',
      payload: { servers: [], corruption: CORRUPTION, agentDir: '/data/agent' },
    })
  })

  it('mcp.add 正常：payload 解构 { name, entry } 传递 + reply 写后落盘终态信封', async () => {
    const { handler, replies } = makeHandler()
    const handled = await handler.handle(msg('mcp.add', { name: 'filesystem', entry: ENTRY.value }), WS)
    expect(handled).toBe(true)
    expect(replies[0]).toEqual({ id: 'm1', type: 'mcp.add:result', payload: { ok: true, entry: ENTRY } })
  })

  it('mcp.add 损坏拒入：ok:false 信封经 reply 返回，不 sendError 不广播（协议信封语义）', async () => {
    const { handler, replies, sendError } = makeHandler({
      add: vi.fn(() => ({
        ok: false as const,
        error: `mcp.json 已损坏，拒绝写入。文件: ${CORRUPTION.filePath}。请修复或删除该文件后重试。`,
        corruption: CORRUPTION,
      })),
    })
    const handled = await handler.handle(msg('mcp.add', { name: 'x', entry: { command: 'npx' } }), WS)
    expect(handled).toBe(true)
    expect(replies[0]).toMatchObject({
      id: 'm1',
      type: 'mcp.add:result',
      payload: { ok: false, error: expect.stringContaining(CORRUPTION.filePath), corruption: CORRUPTION },
    })
    expect(sendError).not.toHaveBeenCalled()
  })

  it('mcp.update：分发命中 + reply mcp.update:result（D7 合并后生效值由 service 透传）', async () => {
    const { handler, replies } = makeHandler()
    const handled = await handler.handle(msg('mcp.update', { name: 'filesystem', entry: { command: 'node' } }), WS)
    expect(handled).toBe(true)
    expect(replies[0]).toEqual({ id: 'm1', type: 'mcp.update:result', payload: { ok: true, entry: ENTRY } })
  })

  it('mcp.remove：分发命中 + reply mcp.remove:result（entry = 被删条目回显）', async () => {
    const { handler, replies } = makeHandler()
    const handled = await handler.handle(msg('mcp.remove', { name: 'filesystem' }), WS)
    expect(handled).toBe(true)
    expect(replies[0]).toEqual({ id: 'm1', type: 'mcp.remove:result', payload: { ok: true, entry: ENTRY } })
  })

  it('mcp.test：fake probe 被触发（携带目标名）+ reply 异步任务句柄（D3/前提 A4）', async () => {
    const testFn = vi.fn((_name: string) => ({ testId: 'probe-run-9' }))
    const { handler, replies } = makeHandler({ test: testFn })
    const handled = await handler.handle(msg('mcp.test', { name: 'filesystem' }), WS)
    expect(handled).toBe(true)
    expect(testFn).toHaveBeenCalledOnce()
    expect(testFn).toHaveBeenCalledWith('filesystem')
    expect(replies[0]).toEqual({ id: 'm1', type: 'mcp.test:result', payload: { testId: 'probe-run-9' } })
  })

  it('mcp.setEnabled：分发命中 + reply 写后落盘终态信封（§3.1 启停最小语义，专用操作）', async () => {
    const setEnabledFn = vi.fn((_name: string, _enabled: boolean) => ({ ok: true, entry: ENTRY }) as const)
    const { handler, replies } = makeHandler({ setEnabled: setEnabledFn })
    const handled = await handler.handle(msg('mcp.setEnabled', { name: 'filesystem', enabled: false }), WS)
    expect(handled).toBe(true)
    expect(setEnabledFn).toHaveBeenCalledOnce()
    expect(setEnabledFn).toHaveBeenCalledWith('filesystem', false)
    expect(replies[0]).toEqual({ id: 'm1', type: 'mcp.setEnabled:result', payload: { ok: true, entry: ENTRY } })
  })

  it('mcp.testCancel：分发命中 + reply { cancelled }（D3「取消」按钮）', async () => {
    const cancelFn = vi.fn((_testId: string) => true)
    const { handler, replies } = makeHandler({ testCancel: cancelFn })
    const handled = await handler.handle(msg('mcp.testCancel', { testId: 'probe-run-9' }), WS)
    expect(handled).toBe(true)
    expect(cancelFn).toHaveBeenCalledOnce()
    expect(cancelFn).toHaveBeenCalledWith('probe-run-9')
    expect(replies[0]).toEqual({ id: 'm1', type: 'mcp.testCancel:result', payload: { cancelled: true } })
  })

  it('未知 type → 返回 false（unknown_type 兜底不变）', async () => {
    const { handler } = makeHandler()
    // 未知 type 本质是协议外字面量，helper 泛型无法承载（codemode 先例同款 unknown 构造）
    const handled = await handler.handle({ type: 'mcp.reload', id: 'mx', payload: {} } as unknown as ClientMessage, WS)
    expect(handled).toBe(false)
  })
})
