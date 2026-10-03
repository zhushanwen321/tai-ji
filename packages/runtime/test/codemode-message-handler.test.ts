/**
 * CodemodeMessageHandler + SettingsMessageHandler 路由注册测试
 * （codemode 设计 D1：config.getCodemodeEnabled / config.setCodemodeEnabled 命令对）。
 *
 * 锁定（验收条款① handler 层 + ② 路由注册）：
 * - 路由注册：两命令经 handleSettingsMessage 查表命中（handled=true）并委托
 *   CodemodeMessageHandler（settings-message-handler.ts routes 表断言）。
 * - get：reply config.codemodeEnabled payload 透传（含损坏错误态形状透传）。
 * - set 成功：reply config.codemodeSetEnabled 终态信封，不广播——设计 D3 的开关协议
 *   只有 get 读取 + set 切换（+ 前端乐观写），config.codemodeEnabled 广播零订阅消费方，
 *   已删（协议类型保留作 get reply）。
 * - set 损坏拒入：ok:false 信封经 reply 返回，不广播不 sendError（shared codemode.ts
 *   协议定死错误数据在信封内，与 retry 的 D10 error envelope 语义不同）。
 *
 * 运行：pnpm -C packages/runtime test codemode
 */
import { describe, it, expect, vi } from 'vitest'
import { SettingsMessageHandler, type SettingsHandlerContext } from '../src/transport/settings-message-handler.js'
import { ModelConnectionTester } from '../src/infra/model-connection-tester.js'
import type { ClientMessage, ServerMessage } from '@taiji/shared'

const CORRUPTION = { filePath: '/data/agent/settings.json', corruptCopyPath: null }

function makeHandler(codemodeOverrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const broadcasts: ServerMessage[] = []
  const replies: { id: string; type: string; payload: Record<string, unknown> }[] = []
  const sendErrorCalls: { id: string | undefined; code: string; message: string }[] = []
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string, type: string, payload: Record<string, unknown>) => replies.push({ id, type, payload })),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => sendErrorCalls.push({ id, code, message })),
    configService: {
      getCodemodeEnabled: vi.fn().mockReturnValue({ enabled: true, corruption: null }),
      setCodemodeEnabled: vi.fn().mockReturnValue({ ok: true, enabled: false }),
      ...codemodeOverrides,
    },
    sessionService: {},
    modelService: {},
    authService: {},
    skillRegistry: {},
    projectRoot: '/proj',
    nextPushId: vi.fn().mockReturnValue('push-1'),
    broadcast: vi.fn((m: ServerMessage) => broadcasts.push(m)),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
    connectionTester: new ModelConnectionTester(),
  }
  const handler = new SettingsMessageHandler(ctx as unknown as SettingsHandlerContext)
  return { ctx, replies, broadcasts, sendErrorCalls, handler }
}

function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}
const WS = {} as never

describe('config.getCodemodeEnabled / config.setCodemodeEnabled（路由注册 + handler）', () => {
  it('路由注册：get 命令查表命中 → 委托 configService.getCodemodeEnabled + reply config.codemodeEnabled 透传', async () => {
    const getCodemodeEnabled = vi.fn().mockReturnValue({ enabled: true, corruption: null })
    const { ctx, replies, handler } = makeHandler({ getCodemodeEnabled })
    const handled = await handler.handleSettingsMessage(msg('config.getCodemodeEnabled', {}), WS)
    expect(handled).toBe(true)
    expect(ctx.configService.getCodemodeEnabled).toHaveBeenCalledOnce()
    expect(replies[0]).toEqual({ id: 'm1', type: 'config.codemodeEnabled', payload: { enabled: true, corruption: null } })
  })

  it('get 损坏错误态透传：reply payload = { enabled: false, corruption }', async () => {
    const getCodemodeEnabled = vi.fn().mockReturnValue({ enabled: false, corruption: { ...CORRUPTION, corruptCopyPath: '/data/agent/settings.json.corrupt-x' } })
    const { replies, handler } = makeHandler({ getCodemodeEnabled })
    const handled = await handler.handleSettingsMessage(msg('config.getCodemodeEnabled', {}, 'm2'), WS)
    expect(handled).toBe(true)
    expect(replies[0]).toEqual({
      id: 'm2',
      type: 'config.codemodeEnabled',
      payload: { enabled: false, corruption: { ...CORRUPTION, corruptCopyPath: '/data/agent/settings.json.corrupt-x' } },
    })
  })

  it('路由注册 + set 成功：委托 setCodemodeEnabled(true) + reply 终态信封 + 不广播', async () => {
    const setCodemodeEnabled = vi.fn().mockReturnValue({ ok: true, enabled: true })
    const { ctx, replies, broadcasts, handler } = makeHandler({ setCodemodeEnabled })
    const handled = await handler.handleSettingsMessage(msg('config.setCodemodeEnabled', { enabled: true }), WS)
    expect(handled).toBe(true)
    expect(ctx.configService.setCodemodeEnabled).toHaveBeenCalledWith(true)
    expect(replies[0]).toEqual({ id: 'm1', type: 'config.codemodeSetEnabled', payload: { ok: true, enabled: true } })
    // 设计 D3 未要求多窗口同步：config.codemodeEnabled 广播零订阅消费方，set 成功不发射。
    expect(broadcasts).toHaveLength(0)
  })

  it('set 损坏拒入：ok:false 信封经 reply 返回，不广播不 sendError（协议信封语义，非 D10 error envelope）', async () => {
    const setCodemodeEnabled = vi.fn().mockReturnValue({ ok: false, error: `settings.json 已损坏，拒绝写入。文件: ${CORRUPTION.filePath}`, corruption: { ...CORRUPTION } })
    const { replies, broadcasts, sendErrorCalls, handler } = makeHandler({ setCodemodeEnabled })
    const handled = await handler.handleSettingsMessage(msg('config.setCodemodeEnabled', { enabled: false }), WS)
    expect(handled).toBe(true)
    expect(replies[0]).toMatchObject({ id: 'm1', type: 'config.codemodeSetEnabled', payload: { ok: false, error: expect.stringContaining(CORRUPTION.filePath), corruption: CORRUPTION } })
    expect(broadcasts).toHaveLength(0)
    expect(sendErrorCalls).toHaveLength(0)
  })

  it('未知 type → 查表落空返回 false（unknown_type 兜底不变）', async () => {
    const { handler } = makeHandler()
    const handled = await handler.handleSettingsMessage(msg('config.getCodemodeState', {}), WS)
    expect(handled).toBe(false)
  })
})
