import { FsExecutor } from '../src/infra/fs-executor.js';
import { ExtensionResolver } from '../src/infra/installers/extension-resolver.js';
import { NpmGitInstaller } from '../src/infra/installers/npm-git-installer.js';
import { NpmInstallError, installDependencies, installPackage, uninstallPackage } from '../src/infra/installers/npm-installer.js';
import { ModelConnectionTester } from '../src/infra/model-connection-tester.js';
import { PiCodemodeSettings } from '../src/infra/pi/pi-codemode-settings.js';
import { PiExtensionSettings } from '../src/infra/pi/pi-extension-settings.js';
import { invalidateSettingsCache, readSettings, setSettingsPath } from '../src/infra/pi/pi-settings-store.js';
import { ISessionService, type IMessageBroker } from '../src/interfaces.js';
import { ConfigService } from '../src/services/config-service.js';
import { ExtensionInstallError, ExtensionService } from '../src/services/extension-service.js';
import { ExtensionTimeoutManager } from '../src/services/extension-timeout-manager.js';
import { wrapWithXmlTag } from '../src/services/handoff-formatter.js';
import { McpServersService } from '../src/services/mcp-servers-service.js';
import { MessageBus } from '../src/services/message-bus/message-bus.js';
import type { ICodemodeSettings } from '../src/services/ports/codemode-settings.js';
import type { IConfigStore } from '../src/services/ports/config.js';
import type { IMcpServers } from '../src/services/ports/mcp-servers.js';
import { IProcessManager, type IPiEngine } from '../src/services/ports/pi-engine.js';
import { applySessionOccupancyTransition } from '../src/services/session/event-interpreter.js';
import { createSessionDeliveryRegistry, type SessionDeliveryDeps } from '../src/services/session/session-delivery-registry.js';
import { SessionService } from '../src/services/session/session-service.js';
import { ConnectionManager } from '../src/transport/connection-manager.js';
import { McpMessageHandler, type McpHandlerContext } from '../src/transport/mcp-message-handler.js';
import { RuntimeServer } from '../src/transport/server.js';
import { SettingsMessageHandler, type SettingsHandlerContext } from '../src/transport/settings-message-handler.js';
import { flushDelivery } from './helpers/flush-delivery.js';
import { startOnFreePort } from './helpers/free-port.js';
import { createMockSessionServiceClass } from './helpers/service-mocks.js';
import { MAX_WS_PAYLOAD_BYTES, ServerMessage, type ClientMessage, type McpListResult, type McpMutationResult, type McpServerEntry, type McpServerEntryValue, type McpTestHandle, type SessionSummary } from '@taiji/shared';
import type { NonSharedBuffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { Stats, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, type Dirent, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


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


// ======================================================================
// ← test/mcp-servers-service.test.ts
// ======================================================================

const ENTRY_m2: McpServerEntry = {
  name: 'filesystem',
  value: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
}


/** 损坏错误态样例（S6：filePath 定位与修复入口 + 隔离副本提示）。 */
const CORRUPTION_m2 = { filePath: '/data/agent/mcp.json', corruptCopyPath: null }


/** fake port（fake store/probe）：默认返回正常路径形状，按用例覆写单方法。 */
function makeFakePort_m2(overrides: Partial<IMcpServers> = {}) {
  return {
    list: vi.fn((): McpListResult => ({ servers: [ENTRY_m2], corruption: null, agentDir: '/data/agent' })),
    add: vi.fn((_name: string, _entry: McpServerEntryValue): McpMutationResult => ({ ok: true, entry: ENTRY_m2 })),
    update: vi.fn((_name: string, _entry: McpServerEntryValue): McpMutationResult => ({ ok: true, entry: ENTRY_m2 })),
    setEnabled: vi.fn((_name: string, _enabled: boolean): McpMutationResult => ({ ok: true, entry: ENTRY_m2 })),
    remove: vi.fn((_name: string): McpMutationResult => ({ ok: true, entry: ENTRY_m2 })),
    test: vi.fn((_name: string): McpTestHandle => ({ testId: 'test-1' })),
    testCancel: vi.fn((_testId: string): boolean => true),
    ...overrides,
  }
}


// ======================================================================
// ← test/codemode-message-handler.test.ts
// ======================================================================

const CORRUPTION_m3 = { filePath: '/data/agent/settings.json', corruptCopyPath: null }


function makeHandler_m2(codemodeOverrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
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


function msg_m2(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}


const WS_m2 = {} as never


// ======================================================================
// ← test/codemode-settings-service.test.ts
// ======================================================================

let dir: string


let settingsPath: string


const service = new PiCodemodeSettings()


/** 隔离副本完整文件名（json-store quarantineCorruptFile 形态：<原文件名>.corrupt-<ISO 压缩时间戳>）。 */
const corruptCopyName = (iso: string): string => `settings.json.corrupt-${iso.replace(/[:.]/g, '')}`


/** 摆盘原始文本（绕过 JsonStore——损坏用例需要非法 JSON 落盘）。 */
function seedRaw(raw: string): void {
  writeFileSync(settingsPath, raw, 'utf-8')
  invalidateSettingsCache()
}


/** 摆盘合法对象并失效缓存。 */
function seed(obj: Record<string, unknown>): void {
  seedRaw(JSON.stringify(obj, null, 2))
}


// ======================================================================
// ← test/retry-rules-config-message-handler.test.ts
// ======================================================================

const serviceMocks = vi.hoisted(() => ({
  getBuiltinRetryRules: vi.fn(),
  readRetryRulesExtConfig: vi.fn(),
  setRetryRulesCustom: vi.fn(),
}))


vi.mock('../src/services/remote-config/remote-retry-rules.js', () => serviceMocks)


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


function msg_m3(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}


const WS_m3 = {} as never


const BUILTIN = [{ id: 'builtin-1', name: 'b', verdict: 'retryable' as const, class: 'provider' as const, source: 'builtin' as const, match: [{ kind: 'pattern' as const, pattern: 'x' }] }]


const CUSTOM = [{ id: 'c1', name: 'c', verdict: 'non_retryable' as const, class: 'provider' as const, source: 'custom' as const, match: [{ kind: 'pattern' as const, pattern: 'y' }] }]

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('mcp-codemode-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('mcp-message-handler', () => {
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
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('mcp-servers-service', () => {
describe('McpServersService（IMcpServers 组合层）', () => {
  it('list 正常路径：无参调用 + 返回值原样透传', () => {
    const port = makeFakePort_m2()
    const svc = new McpServersService(port)
    const result = svc.list()
    expect(port.list).toHaveBeenCalledOnce()
    expect(result).toEqual({ servers: [ENTRY_m2], corruption: null, agentDir: '/data/agent' })
  })

  it('list 损坏错误态透传：servers 空数组 + corruption 有值（S6 形状，不 throw）', () => {
    const port = makeFakePort_m2({
      list: vi.fn((): McpListResult => ({ servers: [], corruption: CORRUPTION_m2, agentDir: '/data/agent' })),
    })
    const svc = new McpServersService(port)
    const result = svc.list()
    expect(result).toEqual({ servers: [], corruption: CORRUPTION_m2, agentDir: '/data/agent' })
    expect(result.corruption?.filePath).toBe('/data/agent/mcp.json')
  })

  it('add 正常路径：name 与 entry 原样传递给 port + 终态信封透传', () => {
    const port = makeFakePort_m2()
    const svc = new McpServersService(port)
    const entryValue: McpServerEntryValue = { url: 'https://example.com/mcp' }
    const result = svc.add('remote', entryValue)
    expect(port.add).toHaveBeenCalledOnce()
    expect(port.add).toHaveBeenCalledWith('remote', entryValue)
    expect(result).toEqual({ ok: true, entry: ENTRY_m2 })
  })

  it('add 损坏拒入信封透传：ok:false + error 含路径与修复动作 + corruption 携带（S6 fail-fast，不 throw）', () => {
    const rejected: McpMutationResult = {
      ok: false,
      error: `mcp.json 已损坏，拒绝写入。文件: ${CORRUPTION.filePath}。请修复或删除该文件后重试。`,
      corruption: CORRUPTION_m2,
    }
    const port = makeFakePort_m2({ add: vi.fn((): McpMutationResult => rejected) })
    const svc = new McpServersService(port)
    const result = svc.add('x', { command: 'npx' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain(CORRUPTION_m2.filePath)
    expect(result.corruption).toEqual(CORRUPTION_m2)
  })

  it('校验错误信封透传：ok:false 且 corruption 缺省（D4 校验类失败形状，与损坏拒入区分）', () => {
    const invalid: McpMutationResult = {
      ok: false,
      error: '服务器名只能包含字母、数字、下划线、连字符。请修改名称后重试。',
    }
    const port = makeFakePort_m2({ add: vi.fn((): McpMutationResult => invalid) })
    const svc = new McpServersService(port)
    const result = svc.add('my server', { command: 'npx' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.corruption).toBeUndefined()
  })

  it('update 正常路径：参数原样传递 + reply 终态条目透传（D7 合并后生效值由 port 产出）', () => {
    const port = makeFakePort_m2()
    const svc = new McpServersService(port)
    const entryValue: McpServerEntryValue = { command: 'node', args: ['server.js'] }
    svc.update('filesystem', entryValue)
    expect(port.update).toHaveBeenCalledWith('filesystem', entryValue)
  })

  it('remove 正常路径：name 传递 + entry 为被删条目回显（port 契约）', () => {
    const port = makeFakePort_m2()
    const svc = new McpServersService(port)
    const result = svc.remove('filesystem')
    expect(port.remove).toHaveBeenCalledWith('filesystem')
    expect(result).toEqual({ ok: true, entry: ENTRY_m2 })
  })

  it('test 异步任务形态：句柄立即返回（testId 非空）+ 触发携带目标名（D3/前提 A4）', () => {
    const port = makeFakePort_m2({ test: vi.fn((_name: string): McpTestHandle => ({ testId: 'probe-run-7' })) })
    const svc = new McpServersService(port)
    const handle = svc.test('filesystem')
    expect(port.test).toHaveBeenCalledOnce()
    expect(port.test).toHaveBeenCalledWith('filesystem')
    expect(handle.testId).toBe('probe-run-7')
  })

  it('setEnabled：参数原样传递给 port + 终态信封透传（§3.1 启停专用操作）', () => {
    const port = makeFakePort_m2()
    const svc = new McpServersService(port)
    const result = svc.setEnabled('filesystem', false)
    expect(port.setEnabled).toHaveBeenCalledOnce()
    expect(port.setEnabled).toHaveBeenCalledWith('filesystem', false)
    expect(result).toEqual({ ok: true, entry: ENTRY_m2 })
  })

  it('testCancel：testId 传递 + 布尔结果原样透传（D3「取消」按钮）', () => {
    const port = makeFakePort_m2({ testCancel: vi.fn((_testId: string): boolean => false) })
    const svc = new McpServersService(port)
    expect(svc.testCancel('probe-run-7')).toBe(false)
    expect(port.testCancel).toHaveBeenCalledOnce()
    expect(port.testCancel).toHaveBeenCalledWith('probe-run-7')
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('codemode-message-handler', () => {
describe('config.getCodemodeEnabled / config.setCodemodeEnabled（路由注册 + handler）', () => {
  it('路由注册：get 命令查表命中 → 委托 configService.getCodemodeEnabled + reply config.codemodeEnabled 透传', async () => {
    const getCodemodeEnabled = vi.fn().mockReturnValue({ enabled: true, corruption: null })
    const { ctx, replies, handler } = makeHandler_m2({ getCodemodeEnabled })
    const handled = await handler.handleSettingsMessage(msg_m2('config.getCodemodeEnabled', {}), WS_m2)
    expect(handled).toBe(true)
    expect(ctx.configService.getCodemodeEnabled).toHaveBeenCalledOnce()
    expect(replies[0]).toEqual({ id: 'm1', type: 'config.codemodeEnabled', payload: { enabled: true, corruption: null } })
  })

  it('get 损坏错误态透传：reply payload = { enabled: false, corruption }', async () => {
    const getCodemodeEnabled = vi.fn().mockReturnValue({ enabled: false, corruption: { ...CORRUPTION_m3, corruptCopyPath: '/data/agent/settings.json.corrupt-x' } })
    const { replies, handler } = makeHandler_m2({ getCodemodeEnabled })
    const handled = await handler.handleSettingsMessage(msg_m2('config.getCodemodeEnabled', {}, 'm2'), WS_m2)
    expect(handled).toBe(true)
    expect(replies[0]).toEqual({
      id: 'm2',
      type: 'config.codemodeEnabled',
      payload: { enabled: false, corruption: { ...CORRUPTION_m3, corruptCopyPath: '/data/agent/settings.json.corrupt-x' } },
    })
  })

  it('路由注册 + set 成功：委托 setCodemodeEnabled(true) + reply 终态信封 + 不广播', async () => {
    const setCodemodeEnabled = vi.fn().mockReturnValue({ ok: true, enabled: true })
    const { ctx, replies, broadcasts, handler } = makeHandler_m2({ setCodemodeEnabled })
    const handled = await handler.handleSettingsMessage(msg_m2('config.setCodemodeEnabled', { enabled: true }), WS_m2)
    expect(handled).toBe(true)
    expect(ctx.configService.setCodemodeEnabled).toHaveBeenCalledWith(true)
    expect(replies[0]).toEqual({ id: 'm1', type: 'config.codemodeSetEnabled', payload: { ok: true, enabled: true } })
    // 设计 D3 未要求多窗口同步：config.codemodeEnabled 广播零订阅消费方，set 成功不发射。
    expect(broadcasts).toHaveLength(0)
  })

  it('set 损坏拒入：ok:false 信封经 reply 返回，不广播不 sendError（协议信封语义，非 D10 error envelope）', async () => {
    const setCodemodeEnabled = vi.fn().mockReturnValue({ ok: false, error: `settings.json 已损坏，拒绝写入。文件: ${CORRUPTION_m3.filePath}`, corruption: { ...CORRUPTION_m3 } })
    const { replies, broadcasts, sendErrorCalls, handler } = makeHandler_m2({ setCodemodeEnabled })
    const handled = await handler.handleSettingsMessage(msg_m2('config.setCodemodeEnabled', { enabled: false }), WS_m2)
    expect(handled).toBe(true)
    expect(replies[0]).toMatchObject({ id: 'm1', type: 'config.codemodeSetEnabled', payload: { ok: false, error: expect.stringContaining(CORRUPTION_m3.filePath), corruption: CORRUPTION_m3 } })
    expect(broadcasts).toHaveLength(0)
    expect(sendErrorCalls).toHaveLength(0)
  })

  it('未知 type → 查表落空返回 false（unknown_type 兜底不变）', async () => {
    const { handler } = makeHandler_m2()
    const handled = await handler.handleSettingsMessage(msg_m2('config.getCodemodeState', {}), WS_m2)
    expect(handled).toBe(false)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('codemode-settings-service', () => {
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codemode-settings-service-'))
  settingsPath = join(dir, 'settings.json')
  setSettingsPath(settingsPath)
})
afterEach(() => {
  vi.restoreAllMocks()
  invalidateSettingsCache()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('PiCodemodeSettings.getEnabled（A1 读侧）', () => {
  it('文件不存在（全新安装正常态）→ enabled=false 且 corruption=null', () => {
    expect(service.getEnabled()).toEqual({ enabled: false, corruption: null })
  })

  it('pi 解析语义激活判定：+codemode 开 / -codemode 关 / 混合条目开 / 非数组坏值关', () => {
    seed({ defaultTools: ['+codemode'] })
    expect(service.getEnabled().enabled).toBe(true)
    seed({ defaultTools: ['-codemode'] })
    expect(service.getEnabled().enabled).toBe(false)
    seed({ defaultTools: ['-read', '+codemode'] })
    expect(service.getEnabled().enabled).toBe(true)
    seed({ defaultTools: 'junk' })
    expect(service.getEnabled().enabled).toBe(false)
  })

  it('损坏 → 错误态 { enabled: false, corruption: { filePath, corruptCopyPath: null } }', () => {
    seedRaw('{ invalid json')
    const result = service.getEnabled()
    expect(result.enabled).toBe(false)
    expect(result.corruption).not.toBeNull()
    expect(result.corruption?.filePath).toBe(settingsPath)
    expect(result.corruption?.corruptCopyPath).toBeNull()
  })

  it('损坏时 get 自身不触发隔离改名（不走默认读路径的行为断言，A1 核心约束）', () => {
    const raw = '{ broken'
    seedRaw(raw)
    service.getEnabled()
    // 若误走 readSettings()：JsonStore 会把坏文件 rename 为 .corrupt-* 并重建默认文件——
    // 两者都不得发生（codemode 承诺自己的读写路径绝不触发或加速隔离）
    expect(existsSync(settingsPath)).toBe(true)
    expect(readFileSync(settingsPath, 'utf-8')).toBe(raw)
    expect(readdirSync(dir).filter(name => name.startsWith('.corrupt-'))).toEqual([])
  })

  it('隔离副本形态：原路径不存在 + .corrupt-<ts> 副本 → corruptCopyPath 命中副本', () => {
    mkdirSync(dir, { recursive: true })
    const copyPath = join(dir, corruptCopyName(new Date().toISOString()))
    writeFileSync(copyPath, '{ quarantined', 'utf-8')
    const result = service.getEnabled()
    expect(result.enabled).toBe(false)
    expect(result.corruption?.filePath).toBe(settingsPath)
    expect(result.corruption?.corruptCopyPath).toBe(copyPath)
  })
})
describe('PiCodemodeSettings.setEnabled（D2 语义表 + A1 写点拒入）', () => {
  it('开：空 settings → 落盘 ["+codemode"]，返回 ok:true + 写后终态 enabled=true', () => {
    seed({ model: 'p/m' })
    expect(service.setEnabled(true)).toEqual({ ok: true, enabled: true })
    expect(readSettings().defaultTools).toEqual(['+codemode'])
    // 用户其他字段零触碰（字段域 merge）
    expect(readSettings().model).toBe('p/m')
  })

  it('开幂等：已激活时重复开不重复追加', () => {
    seed({ defaultTools: ['+codemode'] })
    expect(service.setEnabled(true)).toEqual({ ok: true, enabled: true })
    expect(readSettings().defaultTools).toEqual(['+codemode'])
  })

  it('关：移除正条目后数组空 → 负条目占位（关闭跨重启持久），返回终态 enabled=false', () => {
    seed({ defaultTools: ['+codemode'] })
    expect(service.setEnabled(false)).toEqual({ ok: true, enabled: false })
    expect(readSettings().defaultTools).toEqual(['-codemode'])
    // 占位幂等：重复关不重复追加
    service.setEnabled(false)
    expect(readSettings().defaultTools).toEqual(['-codemode'])
  })

  it('用户条目保留：[-read] 开 → ["-read","+codemode"]（不整组覆盖）', () => {
    seed({ defaultTools: ['-read'] })
    expect(service.setEnabled(true)).toEqual({ ok: true, enabled: true })
    expect(readSettings().defaultTools).toEqual(['-read', '+codemode'])
  })

  it('损坏拒入：ok:false 信封（error 含路径与恢复指引）+ 文件原样未动 + 结构化告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = '{ broken'
    seedRaw(raw)
    const result = service.setEnabled(true)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain(settingsPath)
    // error 信封含修复指引（D3 定死文案语义：修复动作 + 无需重启）；「恢复指引」完整句在结构化告警日志（下方断言）
    expect(result.error).toContain('修复或删除该文件后重试')
    expect(result.error).toContain('无需重启')
    expect(result.corruption.filePath).toBe(settingsPath)
    expect(result.corruption.corruptCopyPath).toBeNull()
    // 写点拒入行为断言：坏文件既未被写改也未被隔离（A1 要堵死的「隔离后空基线覆盖」路径）
    expect(readFileSync(settingsPath, 'utf-8')).toBe(raw)
    expect(readdirSync(dir).filter(name => name.startsWith('.corrupt-'))).toEqual([])
    // 结构化告警：含路径与恢复指引（与启动迁移告警同文案结构，统一日志检索）
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0][0])).toContain(settingsPath)
    expect(String(warn.mock.calls[0][0])).toContain('恢复指引')
  })

  it('修复即恢复（每次现查语义）：拒入后修复文件，重试开关成功', () => {
    seedRaw('{ broken')
    expect(service.setEnabled(true).ok).toBe(false)
    seed({ defaultTools: ['-codemode'] })
    const result = service.setEnabled(true)
    expect(result).toEqual({ ok: true, enabled: true })
    expect(readSettings().defaultTools).toEqual(['+codemode'])
  })

  it('副本形态损坏同样拒入，error 含隔离副本路径提示', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const copyPath = join(dir, corruptCopyName(new Date().toISOString()))
    writeFileSync(copyPath, '{ quarantined', 'utf-8')
    const result = service.setEnabled(false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.corruption.corruptCopyPath).toBe(copyPath)
    expect(result.error).toContain(copyPath)
    expect(warn).toHaveBeenCalledOnce()
  })
})
describe('ConfigService 挂载（retry 域同形态）', () => {
  it('port 未注入：get/set 抛错且错误消息指向恢复动作', () => {
    const svc = new ConfigService('/tmp/project', {} as unknown as IConfigStore)
    expect(() => svc.getCodemodeEnabled()).toThrow(/\[config-service\] codemodeSettings not available \(getCodemodeEnabled\)/)
    expect(() => svc.setCodemodeEnabled(true)).toThrow(/\[config-service\] codemodeSettings not available \(setCodemodeEnabled\)/)
  })

  it('port 注入后单行委托（get 与 set 均透传返回值）', () => {
    const port: ICodemodeSettings = {
      getEnabled: () => ({ enabled: false, corruption: { filePath: '/x/settings.json', corruptCopyPath: null } }),
      setEnabled: enabled => (enabled ? { ok: true, enabled: true } : { ok: false, error: 'e', corruption: { filePath: '/x', corruptCopyPath: null } }),
    }
    const svc = new ConfigService('/tmp/project', {} as unknown as IConfigStore, undefined, undefined, undefined, undefined, undefined, port)
    expect(svc.getCodemodeEnabled()).toEqual({ enabled: false, corruption: { filePath: '/x/settings.json', corruptCopyPath: null } })
    expect(svc.setCodemodeEnabled(true)).toEqual({ ok: true, enabled: true })
    expect(svc.setCodemodeEnabled(false).ok).toBe(false)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('retry-rules-config-message-handler', () => {
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
    const handled = await handler.handleSettingsMessage(msg_m3('config.getRetryRules', {}), WS_m3)
    expect(handled).toBe(true)
    expect(replies[0]).toMatchObject({ id: 'm1', type: 'config.retryRules', payload: { builtinRules: BUILTIN, customRules: CUSTOM } })
  })

  it('config.setRetryRules 成功 → 写侧 + reply 读回终态 + broadcast 同帧广播', async () => {
    serviceMocks.readRetryRulesExtConfig.mockReturnValue({ version: 1, customRules: CUSTOM, effectiveRules: [] })
    const { handler, replies, broadcasts } = makeHarness()
    const handled = await handler.handleSettingsMessage(msg_m3('config.setRetryRules', { customRules: CUSTOM }), WS_m3)
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
    const handled = await handler.handleSettingsMessage(msg_m3('config.setRetryRules', { customRules: [] }), WS_m3)
    expect(handled).toBe(true)
    expect(sendErrorCalls[0]).toMatchObject({ id: 'm1', code: 'set_retry_rules_failed', message: '规则 ID 重复；正则为空' })
    expect(replies).toHaveLength(0)
    expect(broadcasts).toHaveLength(0)
  })

  it('不匹配 type 返回 false（路由继续，settings-message-handler 落 unknown_type 兜底）', async () => {
    const { handler } = makeHarness()
    await expect(handler.handleSettingsMessage(msg_m3('retryRules.notAType', {}), WS_m3)).resolves.toBe(false)
  })
})
});
});

// ======================================================================
// ← test-extra2.test.ts
// ======================================================================

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← test/extension-service.test.ts
// ======================================================================

vi.mock('../src/infra/installers/npm-installer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/installers/npm-installer.js')>()
  return { ...actual, installPackage: vi.fn(),
  uninstallPackage: vi.fn(),
  // RT-8#4：installDeps 返回 { failed } 失败聚合，默认无失败（用例可 override）
  installDependencies: vi.fn(async () => ({ failed: [] })),
  NpmInstallError: class extends Error {
    code: 'not_found' | 'network' | 'extract' | 'integrity'
    constructor(code: 'not_found' | 'network' | 'extract' | 'integrity', message: string) {
      super(message)
      this.code = code
      this.name = 'NpmInstallError'
    }
  }, }
})


// git clone still uses execFileSync
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''), }
})


// RT-6#1 失败路径注入（测试作用域开关，vi.hoisted 使 mock 工厂可引用）：
// - cpSync：源路径含 fail-cp 标记时抛错（仅 cp 失败用例的 fixture 用该目录名）；
// - renameSync：仅当 failRenameMarker 非空且 from 路径命中「marker + .tmp-」（原子
//   换代「顶上」一步）时抛错，其余委托原实现——换代中断后的备份恢复
//   （.old- → destDir）走原实现，才能断言恢复真实发生；
// - renameSync failRestoreRenameMarker：from 路径命中「marker + .old-」（恢复一步）
//   时抛错，与 failRenameMarker 组合触发「顶上 + 恢复双失败」深防御分支；
// - rmSync failRmBackupMarker：路径命中「marker + .old-」（备份清理）时抛错，
//   触发「删备份失败 best-effort 告警」深防御分支（rename 全走原实现，换代成功）。
const fsFailState = vi.hoisted(() => ({
  failRenameMarker: '',
  failRestoreRenameMarker: '',
  failRmBackupMarker: '',
}))


vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const cpSyncMock: typeof actual.cpSync = (src, dest, opts) => {
    if (String(src).includes('fail-cp')) {
      throw new Error('simulated copy failure (disk full)')
    }
    return actual.cpSync(src, dest, opts)
  }
  const renameSyncMock: typeof actual.renameSync = (fromPath, toPath) => {
    const from = String(fromPath)
    if (fsFailState.failRenameMarker !== ''
      && from.includes(fsFailState.failRenameMarker)
      && from.includes('.tmp-')) {
      throw Object.assign(new Error('ENOTEMPTY: simulated rename failure'), { code: 'ENOTEMPTY' })
    }
    if (fsFailState.failRestoreRenameMarker !== ''
      && from.includes(fsFailState.failRestoreRenameMarker)
      && from.includes('.old-')) {
      throw Object.assign(new Error('EPERM: simulated restore rename failure'), { code: 'EPERM' })
    }
    return actual.renameSync(fromPath, toPath)
  }
  const rmSyncMock: typeof actual.rmSync = (targetPath, opts) => {
    if (fsFailState.failRmBackupMarker !== ''
      && String(targetPath).includes(fsFailState.failRmBackupMarker)
      && String(targetPath).includes('.old-')) {
      throw Object.assign(new Error('EPERM: simulated backup cleanup failure'), { code: 'EPERM' })
    }
    return actual.rmSync(targetPath, opts)
  }
  return { ...actual, cpSync: vi.fn(cpSyncMock), renameSync: vi.fn(renameSyncMock), rmSync: vi.fn(rmSyncMock) }
})


const mockedInstallPackage = vi.mocked(installPackage)


const mockedUninstallPackage = vi.mocked(uninstallPackage)


const mockedInstallDependencies = vi.mocked(installDependencies)


const mockedExecFileSync = vi.mocked(execFileSync)


// ======================================================================
// ← test/ws-listen-hardening.test.ts
// ======================================================================

const TEST_TOKEN = 'sec-u2-token-0123456789abcdef'


/** 起一个最小 ConnectionManager（onMessage/onConnect 全 mock，只测传输层行为）。
 * EADDRINUSE 韧性：经 startOnFreePort 撞端口自动换号重试（helpers/free-port.ts）。 */
async function startManager(token: string | null): Promise<{ conn: ConnectionManager; port: number; onMessage: ReturnType<typeof vi.fn>; onConnect: ReturnType<typeof vi.fn> }> {
  const onMessage = vi.fn().mockResolvedValue(undefined)
  const onConnect = vi.fn()
  const { instance: conn, port } = await startOnFreePort(
    (p) => new ConnectionManager(p, {
      onConnect,
      onMessage,
      sendError: vi.fn(),
    }, token),
  )
  return { conn, port, onMessage, onConnect }
}


/** 连接 + 发 auth + 等 auth.result，resolve 携带 { ws, authResult }。 */
function connectAndAuth(port: number, token: string): Promise<{ ws: WebSocket; authResult: { ok: boolean; reason?: string } }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const timeout = setTimeout(() => reject(new Error('auth flow timeout')), 4000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', payload: { token } }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data))
      if (msg.type === 'auth.result') {
        clearTimeout(timeout)
        resolve({ ws, authResult: msg.payload })
      }
    })
    ws.on('error', reject)
  })
}


/** 等连接关闭，resolve 携带 close code。 */
function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }))
  })
}


// ======================================================================
// ← test/fs-executor-listdir.test.ts
// ======================================================================

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(), }
})

const readdirMock = vi.mocked(readdir)


const statMock = vi.mocked(stat)


/**
 * Dirent 鸭子形状 mock（FsExecutor 只用 name/isDirectory/isSymbolicLink）。
 * as unknown as Dirent<NonSharedBuffer>：mock 形状缺 Dirent 其余方法（isFile/isBlockDevice
 * 等），类型断言到 readdir({ withFileTypes:true }) 的精确返回元素类型——运行时只消费
 * 上述三个成员，行为与真 Dirent 等价。
 */
function dirent(name: string, type: 'dir' | 'file', symlink = false): Dirent<NonSharedBuffer> {
  return {
    name,
    isDirectory: () => type === 'dir',
    isSymbolicLink: () => symlink,
  } as unknown as Dirent<NonSharedBuffer>
}


/** stat 结果鸭子形状（FsExecutor 只用 size）。 */
function statResult(size: number): Stats {
  return { size } as unknown as Stats
}


// ======================================================================
// ← test/handoff-formatter.test.ts
// ======================================================================

const ACTION_SUFFIX =
  'Immediately execute the next incomplete item in the document. If you encounter a blocker or blocked item, stop and ask me. After completing each step, proceed to the next one.'


// ======================================================================
// ← test/server-destroyed-converged-cleanup.test.ts
// ======================================================================

// ── 分层 2/3：真实 SessionService 两条销毁路径都触发回调列表 ──────────────────

/**
 * 真实 SessionService 环境（对齐 session-service-w07-bus.test.ts 的 makeEnv）。
 * pm.onSessionExit 捕获 handler 供测试显式触发（模拟 pi 进程意外退出）。
 */
function makeRealServiceEnv() {
  const broadcasts: ServerMessage[] = []
  const broker = { broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBroker

  let exitHandler: ((sessionId: string, code: number | null, stderr: string) => void) | null = null
  const client = {
    getCommands: vi.fn(async () => []),
    getState: vi.fn(async () => ({ sessionName: 'd6a', thinkingLevel: 'low', model: { id: 'm', provider: 'p' } })),
    getSessionStats: vi.fn(async () => ({ contextUsage: { tokens: 1, contextWindow: 100, percent: 1 } })),
  } as unknown as IPiEngine
  const pm = {
    onSessionExit: vi.fn((h: (sessionId: string, code: number | null, stderr: string) => void) => {
      exitHandler = h
    }),
    getClient: vi.fn(() => client),
    // 主动删除路径（lifecycle.delete → pm.destroySession）
    destroySession: vi.fn(async () => undefined),
  } as unknown as IProcessManager

  const bus = new MessageBus()
  const svc = new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never, // extensionService：被测路径未消费
    { getDefaultModel: () => ({ provider: 'p', modelId: 'm' }) } as never, // configStore
    {
      scanSessions: vi.fn(() => []),
      extractSessionOutcome: vi.fn(() => null),
      persistSessionEnd: vi.fn(),
      invalidateScanCache: vi.fn(),
      refreshAll: vi.fn(),
    } as never, // sessionStore（delete 尾部两个失效调用）
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService：SessionLifecycle 构造存引用，被测路径未触发
    bus,
  )
  svc.setMessageBus(bus)
  return {
    svc,
    bus,
    triggerExit: (sid: string, code: number | null, stderr: string) => {
      if (!exitHandler) throw new Error('onSessionExit handler not registered')
      exitHandler(sid, code, stderr)
    },
  }
}


/** 模拟组合根注册：PluginService 风格 handler + server 汇聚清理 handler 共存。 */
function registerHandlers(svc: SessionService): { plugin: ReturnType<typeof vi.fn>; cleanup: ReturnType<typeof vi.fn> } {
  const plugin = vi.fn()
  const cleanup = vi.fn()
  svc.setOnSessionDestroyed((summary) => { plugin(summary.id) })
  svc.setOnSessionDestroyed((summary) => { cleanup(summary.id) })
  return { plugin, cleanup }
}


// ======================================================================
// ← test/workspace-message-handler.test.ts
// ======================================================================

/**
 * [u2 投递所有权内核] 装配投递内核（dispatcher 只提交，出站交接在适配层）。
 * fixture 的 getSession/ensureActive/workspace.record 与真实装配同源。
 */
function wireDeliveryKernel(deps: {
  getSession: (sid: string) => unknown
  ensureActive: unknown
  record: (cwd: string) => void
  bus: unknown
}): ReturnType<typeof createSessionDeliveryRegistry> {
  // [MF-1-7] 注册表实例返回给调用方，经 dispatcher 构造参数注入（活动槽已退役）
  return createSessionDeliveryRegistry({
    getSession: (sid) => deps.getSession(sid) as ReturnType<SessionDeliveryDeps['getSession']>,
    ensureActive: deps.ensureActive as SessionDeliveryDeps['ensureActive'],
    subscribeAgentSettled: () => () => {},
    recordWorkspace: deps.record,
    getMessageBus: () => deps.bus as ReturnType<SessionDeliveryDeps['getMessageBus']>,
  })
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('test-extra2', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('extension-service', () => {
describe('ExtensionService', () => {
  let service: ExtensionService
  let testSettingsDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    // RT-6#1 注入开关复位（失败用例内显式打开）
    fsFailState.failRenameMarker = ''
    fsFailState.failRestoreRenameMarker = ''
    fsFailState.failRmBackupMarker = ''
    // Create test directory structure
    testSettingsDir = mkdtempSync(join(tmpdir(), 'ext-service-test-'))
    // RT-3#12：PiExtensionSettings 构造不再对齐全局 settings 路径（去全局化），
    // 测试显式注入 setSettingsPath 指向 testSettingsDir（全仓测试惯例）。
    setSettingsPath(join(testSettingsDir, 'settings.json'))
    writeFileSync(join(testSettingsDir, 'settings.json'), JSON.stringify({
      packages: ['npm:pi-ask-user'],
    }), 'utf-8')
    // Create a fake pi-ask-user package
    const npmDir = join(testSettingsDir, 'npm', 'node_modules', 'pi-ask-user')
    mkdirSync(npmDir, { recursive: true })
    writeFileSync(join(npmDir, 'package.json'), JSON.stringify({
      name: 'pi-ask-user',
      version: '0.1.0',
      description: 'Ask user questions',
      keywords: ['pi-package'],
      peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
    }), 'utf-8')
    writeFileSync(join(npmDir, 'index.ts'), '', 'utf-8')

    // Create settings.json in the npm directory for --prefix install
    writeFileSync(join(testSettingsDir, 'npm', 'package.json'), JSON.stringify({ private: true }), 'utf-8')

    service = new ExtensionService({
      settingsDir: testSettingsDir,
      projectRoot: process.cwd(),
      packaged: false, // 环境可能设 TAIJI_AGENT_PACKAGED=1（pi 桌面进程），测试显式覆盖为 dev 模式
      installer: new NpmGitInstaller(),
      resolver: new ExtensionResolver({
        settingsDir: testSettingsDir,
        thirdPartyDir: join(testSettingsDir, 'extensions'),
        // Phase 1 路径迁移：npmDir 已从 settingsDir 子树迁出，注入回 testSettingsDir/npm 让 fixture 继续生效。
        npmDir: join(testSettingsDir, 'npm'),
      }),
      // IExtensionSettings port：经 pi-settings-store 统一读写 settings.json（D17）。
      // 构造时把 store 路径对齐到 testSettingsDir，使 model 域与 extension 域在测试中读写同一文件。
      extensionSettings: new PiExtensionSettings(testSettingsDir),
      // Phase 1 路径迁移：extensions/npm/tmp 已从 settingsDir 子树迁出到 dataDir 根层，
      // 注入回 testSettingsDir 子目录让现有 fixture（settingsDir/npm、settingsDir/extensions、settingsDir/tmp）继续生效。
      extensionsDir: join(testSettingsDir, 'extensions'),
      npmDir: join(testSettingsDir, 'npm'),
      tmpDir: join(testSettingsDir, 'tmp'),
    })
  })

  afterEach(() => {
    // Cleanup test dir
    try {
      rmSync(testSettingsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    } catch { /* ignore */ }
  })

  describe('scanExtensions', () => {
    it('returns extensions from all resolver sources', async () => {
      const extensions = await service.scanExtensions()
      const askUser = extensions.find(e => e.name === 'pi-ask-user')
      expect(askUser).toBeDefined()
      expect(askUser!.source).toBe('user-installed')
      expect(askUser!.enabled).toBe(true)
      expect(askUser!.version).toBe('0.1.0')
      expect(askUser!.dirName).toBe('pi-ask-user')
    })

    it('marks disabled extensions as not enabled', async () => {
      writeFileSync(join(testSettingsDir, 'disabled-packages.json'), JSON.stringify({
        disabled: ['npm:pi-ask-user'],
      }), 'utf-8')

      const extensions = await service.scanExtensions()
      // 无条件断言条目存在：扫描回归致 pi-ask-user 条目消失时必须红，
      // 不能让断言包在 if 检查内静默绿
      const askUser = extensions.find(e => e.name === 'pi-ask-user')
      expect(askUser).toBeDefined()
      expect(askUser!.enabled).toBe(false)
    })

    it('returns empty array when no extensions found', async () => {
      // 独立空环境实例：共享 setup 的 projectRoot=process.cwd() 会让 bundled dev 分支
      // 扫到真实仓库 extensions 树，空环境前提不成立。此处 projectRoot 指向仓库外自建
      // tmpdir（bundled dev 分支的 <root>/../../extensions 与 npm 源的 <root>/package.json
      // 均不存在），settings 源经 setSettingsPath 指向同目录的空 settings.json，
      // bundled/npm/settings/third-party/user/discovery 源全为空。
      const emptyDir = mkdtempSync(join(tmpdir(), 'ext-service-empty-'))
      writeFileSync(join(emptyDir, 'settings.json'), JSON.stringify({ packages: [] }), 'utf-8')
      setSettingsPath(join(emptyDir, 'settings.json'))
      try {
        const emptyService = new ExtensionService({
          settingsDir: emptyDir,
          projectRoot: emptyDir,
          packaged: false,
          installer: new NpmGitInstaller(),
          resolver: new ExtensionResolver({
            settingsDir: emptyDir,
            thirdPartyDir: join(emptyDir, 'extensions'),
            npmDir: join(emptyDir, 'npm'),
          }),
          extensionSettings: new PiExtensionSettings(emptyDir),
          extensionsDir: join(emptyDir, 'extensions'),
          npmDir: join(emptyDir, 'npm'),
          tmpDir: join(emptyDir, 'tmp'),
        })

        const extensions = await emptyService.scanExtensions()
        expect(extensions).toHaveLength(0)
      } finally {
        rmSync(emptyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })
  })

  describe('getRecommendedExtensions', () => {
    it('excludes mandatory packages from recommended list (all 6 recommended are now mandatory)', async () => {
      const recommended = await service.getRecommendedExtensions()
      // recommended-extensions.json 的 6 个条目全部属于 mandatory SSOT，
      // Task 4.3 要求 getRecommendedExtensions 过滤掉 mandatory 项 → 返回空列表。
      // 这是新契约：mandatory 扩展不进推荐列表（它们由 boot 强制安装）。
      expect(recommended.length).toBe(0)
    })
  })

  describe('mandatory extensions', () => {
    it('scanExtensions sets mandatory=true for mandatory packages', async () => {
      // 在 npm/node_modules 下造一个 mandatory 包（@zhushanwen/pi-goal）
      const pkgDir = join(testSettingsDir, 'npm', 'node_modules', '@zhushanwen', 'pi-goal')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: '@zhushanwen/pi-goal',
        version: '0.4.0',
        description: 'goal ext',
        keywords: ['pi-package'],
        peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
      }), 'utf-8')
      const settingsPath = join(testSettingsDir, 'settings.json')
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      settings.packages = [...(settings.packages || []), 'npm:@zhushanwen/pi-goal']
      writeFileSync(settingsPath, JSON.stringify(settings), 'utf-8')

      const extensions = await service.scanExtensions()
      const goal = extensions.find(e => e.name === '@zhushanwen/pi-goal')
      expect(goal).toBeDefined()
      expect(goal!.mandatory).toBe(true)
      // S10：tier 直接从 resolveExtensions 透传（pi-goal 是 feature mandatory）
      expect(goal!.tier).toBe('feature')
      // 非 mandatory 包 mandatory 字段为 false（无条件断言，防条目消失时静默绿）
      const askUser = extensions.find(e => e.name === 'pi-ask-user')
      expect(askUser).toBeDefined()
      expect(askUser!.mandatory).toBe(false)
    })

    it('uninstallExtension rejects builtin packages', async () => {
      // @zhushanwen/pi-goal 是 builtin（feature 子级，仍不可卸）
      // 阶段 2 改名：mandatory_cannot_uninstall → builtin_cannot_uninstall
      await expect(service.uninstallExtension('@zhushanwen/pi-goal'))
        .rejects.toThrow(/Builtin extension cannot be uninstalled/)
    })
    // 非 builtin 包可卸载的 resolves 语义由 uninstallExtension「removes from settings.json」
    // 用例覆盖（test-pkg 非 builtin，uninstall 若 rejects 该用例即红）
  })

  describe('getExtensionPaths', () => {
    it('returns paths of enabled extensions', async () => {
      const paths = await service.getExtensionPaths()
      expect(paths.some(p => p.includes('pi-ask-user'))).toBe(true)
    })

    it('excludes disabled extensions', async () => {
      writeFileSync(join(testSettingsDir, 'disabled-packages.json'), JSON.stringify({
        disabled: ['npm:pi-ask-user'],
      }), 'utf-8')

      const paths = await service.getExtensionPaths()
      expect(paths.some(p => p.includes('pi-ask-user'))).toBe(false)
    })

    it('infrastructure builtin 包无视 disabled 强加载', async () => {
      // pi-pending-notifications 是 infrastructure builtin（被依赖的基础包），仍无视 disabled 强加载
      const pkgDir = join(testSettingsDir, 'npm', 'node_modules', '@zhushanwen', 'pi-pending-notifications')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: '@zhushanwen/pi-pending-notifications',
        version: '1.0.0',
        description: 'infra ext',
        keywords: ['pi-package'],
        peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
      }), 'utf-8')
      const settingsPath = join(testSettingsDir, 'settings.json')
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      settings.packages = [...(settings.packages || []), 'npm:@zhushanwen/pi-pending-notifications']
      writeFileSync(settingsPath, JSON.stringify(settings), 'utf-8')

      // 把 infrastructure 包加入 disabled-packages.json（应当被无视）
      writeFileSync(join(testSettingsDir, 'disabled-packages.json'), JSON.stringify({
        disabled: ['npm:@zhushanwen/pi-pending-notifications'],
      }), 'utf-8')

      const paths = await service.getExtensionPaths()
      // infrastructure 包即使被 disabled 仍出现在路径中（强制加载）
      expect(paths.some(p => p.includes('@zhushanwen') && p.includes('pi-pending-notifications'))).toBe(true)
    })
  })

  describe('TAIJI_EXTENSION_PATHS', () => {
    let userExtDir: string

    beforeEach(() => {
      // 造一个临时 extension 目录，满足 isValidPiExtension（keywords 含 pi-package）
      userExtDir = mkdtempSync(join(tmpdir(), 'ext-user-path-'))
      writeFileSync(join(userExtDir, 'package.json'), JSON.stringify({
        name: 'my-dev-extension',
        version: '0.0.1',
        description: 'local dev extension',
        keywords: ['pi-package'],
      }), 'utf-8')
      writeFileSync(join(userExtDir, 'index.ts'), '', 'utf-8')
      process.env.TAIJI_EXTENSION_PATHS = userExtDir
    })

    afterEach(() => {
      delete process.env.TAIJI_EXTENSION_PATHS
      try { rmSync(userExtDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
    })

    it('scanExtensions 能扫到 TAIJI_EXTENSION_PATHS 指向的 extension', async () => {
      const extensions = await service.scanExtensions()
      const found = extensions.find(e => e.name === 'my-dev-extension')
      expect(found).toBeDefined()
      expect(found!.path).toBe(userExtDir)
    })

    // 「getExtensionPaths 返回的路径包含 user extension 目录」与「无效路径静默跳过」
    // 两条已删：前者是「scan 能扫到」+「get 返回 scan 结果」两个已证契约的组合复测；
    // 后者 owner 层覆盖在 test/extension-resolver.test.ts（skips non-existent paths），
    // 且其断言只验有效项仍在，无独立失败信号。

    it('多个路径用分隔符隔开都能扫到', async () => {
      const userExtDir2 = mkdtempSync(join(tmpdir(), 'ext-user-path2-'))
      writeFileSync(join(userExtDir2, 'package.json'), JSON.stringify({
        name: 'second-dev-extension',
        version: '0.0.1',
        keywords: ['pi-package'],
      }), 'utf-8')
      writeFileSync(join(userExtDir2, 'index.ts'), '', 'utf-8')
      try {
        process.env.TAIJI_EXTENSION_PATHS = `${userExtDir}${delimiter}${userExtDir2}`
        const extensions = await service.scanExtensions()
        expect(extensions.find(e => e.path === userExtDir)).toBeDefined()
        expect(extensions.find(e => e.path === userExtDir2)).toBeDefined()
      } finally {
        rmSync(userExtDir2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })
  })

  describe('installExtension', () => {
    it('throws for non-npm sources', async () => {
      await expect(service.installExtension('git:foo/bar')).rejects.toThrow('Unsupported source')
    })

    it('rejects builtin packages (builtin_already_installed guard, MF-4)', async () => {
      // @zhushanwen/pi-goal 是 builtin（feature 级），installExtension 检查应拒绝用户 npm 安装。
      // 否则与内置副本产生去重冲突，deduplicate 保留用户装的那份，
      // 产生 source(user-installed)/tier(mandatory) 矛盾条目（不可卸载却显示为用户安装）。
      // 与 uninstall/toggle 的 builtin 检查对称（均有测），唯独 install 入口原缺测（MF-4）。
      try {
        await service.installExtension('npm:@zhushanwen/pi-goal')
        expect.unreachable('Should have thrown builtin_already_installed')
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionInstallError)
        expect((e as ExtensionInstallError).code).toBe('builtin_already_installed')
        expect((e as Error).message).toMatch(/already built in/i)
      }
    })
    // 非 pi extension 安装的 message 文案断言已并入 installExtension error classification
    // 「classifies invalid pi extension as not_extension」（code + message 一处断言）
  })

  // ── 钉版本安装源 npm:<pkg>@<version>（羊毛清单安全契约，ADR-0156 D2）──────
  // 核心契约：版本只存在于安装执行时刻（installNpm 收 <纯名>@<版本>），
  // settings.json packages[] 一律登记 npm:<纯名>（既有消费方 deduplicate/enabled/uninstall
  // 全按纯名构造 key）；目录校验/回滚始终按纯名（scoped 纯名 path.join 拼路径天然正确）。
  describe('installExtension pinned version source (npm:<pkg>@<version>)', () => {
    /** 在 npm/node_modules 下造一个有效 pi extension fixture（scoped 纯名路径 node_modules/@scope/name） */
    const seedScopedExtFixture = (scope: string, name: string): string => {
      const pkgDir = join(testSettingsDir, 'npm', 'node_modules', `@${scope}`, name)
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: `@${scope}/${name}`,
        version: '1.2.3',
        description: 'pinned install fixture',
        keywords: ['pi-package'],
        peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
      }), 'utf-8')
      return pkgDir
    }

    const readSettingsPackages = (): string[] => {
      const raw = readFileSync(join(testSettingsDir, 'settings.json'), 'utf-8')
      return (JSON.parse(raw) as { packages: string[] }).packages
    }

    it('npm:@scope/xx@1.2.3 安装成功：installNpm 收带版本串、settings 登记纯名、校验按纯名目录', async () => {
      const fixtureDir = seedScopedExtFixture('scope', 'xx')
      mockedInstallPackage.mockResolvedValue(undefined)

      await service.installExtension('npm:@scope/xx@1.2.3')

      // 安装执行：installNpm → installPackage 第一参数是带版本安装串
      expect(mockedInstallPackage).toHaveBeenCalledTimes(1)
      expect(mockedInstallPackage.mock.calls[0]![0]).toBe('@scope/xx@1.2.3')
      // settings 登记：一律写 npm:<纯名>，无版本形态（带版本入 settings 会令既有消费方 key 全量失配）
      const packages = readSettingsPackages()
      expect(packages).toContain('npm:@scope/xx')
      expect(packages).not.toContain('npm:@scope/xx@1.2.3')
      // isValidPiExtension 按纯名目录校验：fixture（node_modules/@scope/xx）未被回滚删除
      expect(existsSync(fixtureDir)).toBe(true)
    })

    it('npm:@scope/xx（无版本，现状形态）行为完全不变：installNpm 收纯名、settings 登记纯名', async () => {
      seedScopedExtFixture('scope', 'xx')
      mockedInstallPackage.mockResolvedValue(undefined)

      await service.installExtension('npm:@scope/xx')

      expect(mockedInstallPackage).toHaveBeenCalledTimes(1)
      expect(mockedInstallPackage.mock.calls[0]![0]).toBe('@scope/xx')
      expect(readSettingsPackages()).toContain('npm:@scope/xx')
    })

    it('npm:name@1.2.3（unscoped 带版本）同 scoped 契约：installNpm 收 name@1.2.3、settings 登记纯名', async () => {
      const pkgDir = join(testSettingsDir, 'npm', 'node_modules', 'plain-name')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'plain-name',
        version: '1.2.3',
        description: 'unscoped pinned fixture',
        keywords: ['pi-package'],
      }), 'utf-8')
      mockedInstallPackage.mockResolvedValue(undefined)

      await service.installExtension('npm:plain-name@1.2.3')

      expect(mockedInstallPackage).toHaveBeenCalledTimes(1)
      expect(mockedInstallPackage.mock.calls[0]![0]).toBe('plain-name@1.2.3')
      expect(readSettingsPackages()).toContain('npm:plain-name')
    })

    it('npm:@scope/xx@abc（@ 后非数字开头）→ 整体按纯名处理 → isValidNpmPackageName 拒绝且不触发安装', async () => {
      seedScopedExtFixture('scope', 'xx')

      await expect(service.installExtension('npm:@scope/xx@abc'))
        .rejects.toThrow('Invalid npm package name: @scope/xx@abc')

      expect(mockedInstallPackage).not.toHaveBeenCalled()
    })

    it('npm install 成功但非 pi extension → 回滚 uninstall 用纯名（非带版本串）', async () => {
      // 造一个非 extension 目录（package.json 无 pi 标记），install 成功后校验失败触发回滚
      const badDir = join(testSettingsDir, 'npm', 'node_modules', '@scope', 'bad')
      mkdirSync(badDir, { recursive: true })
      writeFileSync(join(badDir, 'package.json'), JSON.stringify({
        name: '@scope/bad',
        version: '1.2.3',
      }), 'utf-8')
      mockedInstallPackage.mockResolvedValue(undefined)
      mockedUninstallPackage.mockResolvedValue(undefined)

      await expect(service.installExtension('npm:@scope/bad@1.2.3'))
        .rejects.toThrow(/not a valid pi extension/)

      // 回滚 uninstallNpm 第一参数必须是纯包名（带版本串拼目录会错位）
      expect(mockedUninstallPackage).toHaveBeenCalledTimes(1)
      expect(mockedUninstallPackage.mock.calls[0]![0]).toBe('@scope/bad')
      // 失败路径不写 settings
      expect(readSettingsPackages()).not.toContain('npm:@scope/bad')
    })
  })

  describe('uninstallExtension', () => {
    it('removes from settings.json', async () => {
      const pkgDir = join(testSettingsDir, 'npm', 'node_modules', 'test-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'test-pkg', version: '0.1.0', description: '',
        keywords: ['pi-package'],
        peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
      }), 'utf-8')

      const settingsPath = join(testSettingsDir, 'settings.json')
      const raw = readFileSync(settingsPath, 'utf-8')
      const settings = JSON.parse(raw)
      settings.packages = [...(settings.packages || []), 'npm:test-pkg']
      writeFileSync(settingsPath, JSON.stringify(settings), 'utf-8')

      mockedUninstallPackage.mockResolvedValue(undefined)
      await service.uninstallExtension('test-pkg')

      const updatedRaw = readFileSync(settingsPath, 'utf-8')
      const updatedSettings = JSON.parse(updatedRaw)
      expect(updatedSettings.packages).not.toContain('npm:test-pkg')
    })
  })

  describe('toggleExtension', () => {
    it('toggles extension to disabled', async () => {
      await service.toggleExtension('pi-ask-user', false)

      const disabledPath = join(testSettingsDir, 'disabled-packages.json')
      expect(existsSync(disabledPath)).toBe(true)
      const raw = readFileSync(disabledPath, 'utf-8')
      const data = JSON.parse(raw)
      expect(data.disabled).toContain('npm:pi-ask-user')
    })

    it('toggles disabled extension back to enabled', async () => {
      await service.toggleExtension('pi-ask-user', false)
      await service.toggleExtension('pi-ask-user', true)

      const disabledPath = join(testSettingsDir, 'disabled-packages.json')
      expect(existsSync(disabledPath)).toBe(false)
    })

    it('rejects disabling infrastructure but allows feature', async () => {
      // 阶段 2：检查只拦截 infrastructure builtin（被依赖的基础包，不可禁）；
      // feature builtin（pi-goal）可禁，禁用走正常 disabled-packages.json 路径。

      // [1] infrastructure builtin（pi-pending-notifications）禁用应抛 infrastructure_cannot_disable
      // （阶段 2 改名：mandatory_cannot_disable → infrastructure_cannot_disable）
      await expect(service.toggleExtension('@zhushanwen/pi-pending-notifications', false))
        .rejects.toThrow(/Infrastructure extension cannot be disabled/)

      // [2] feature builtin（pi-goal）禁用应成功（feature 现在可禁）
      await expect(service.toggleExtension('@zhushanwen/pi-goal', false))
        .resolves.toBeUndefined()
      // 落盘到 disabled-packages.json（用 npm: 前缀，pi-goal 非 discovery 源）
      const disabledPath = join(testSettingsDir, 'disabled-packages.json')
      expect(existsSync(disabledPath)).toBe(true)
      const raw = readFileSync(disabledPath, 'utf-8')
      const data = JSON.parse(raw)
      expect(data.disabled).toContain('npm:@zhushanwen/pi-goal')

      // [3] builtin 可 enable（检查只拦截禁用，开启无害；原「allows enabling builtin packages」并入）
      await expect(service.toggleExtension('@zhushanwen/pi-goal', true))
        .resolves.toBeUndefined()
    })
  })

  // ── Task 3: ExtensionInstallError and error classification ────

  describe('ExtensionInstallError', () => {
    it('has code, message, and optional hint', () => {
      // 带 hint 构造
      const withHint = new ExtensionInstallError('not_found', 'Package not found', 'Check the package name')
      expect(withHint.code).toBe('not_found')
      expect(withHint.message).toBe('Package not found')
      expect(withHint.hint).toBe('Check the package name')
      expect(withHint).toBeInstanceOf(Error)
      expect(withHint).toBeInstanceOf(ExtensionInstallError)

      // 不带 hint 构造（原「works without hint」用例并入）
      const withoutHint = new ExtensionInstallError('network', 'Connection timeout')
      expect(withoutHint.code).toBe('network')
      expect(withoutHint.message).toBe('Connection timeout')
      expect(withoutHint.hint).toBeUndefined()
    })
  })

  describe('installExtension error classification', () => {
    it('classifies 404 errors as not_found', async () => {
      mockedInstallPackage.mockRejectedValue(new NpmInstallError('not_found', 'Package not found (404)'))

      try {
        await service.installExtension('npm:nonexistent-pkg')
        expect.unreachable('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionInstallError)
        expect((e as ExtensionInstallError).code).toBe('not_found')
      }
    })

    it('classifies E404 errors as not_found', async () => {
      mockedInstallPackage.mockRejectedValue(new Error('npm ERR! E404 Package not found'))

      try {
        await service.installExtension('npm:e404-pkg')
        expect.unreachable('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionInstallError)
        expect((e as ExtensionInstallError).code).toBe('not_found')
      }
    })

    it('classifies other npm errors as network', async () => {
      mockedInstallPackage.mockRejectedValue(new NpmInstallError('network', 'Connection timeout'))

      try {
        await service.installExtension('npm:timeout-pkg')
        expect.unreachable('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionInstallError)
        expect((e as ExtensionInstallError).code).toBe('network')
      }
    })

    it('classifies invalid pi extension as not_extension', async () => {
      mockedInstallPackage.mockResolvedValue(undefined)
      mockedUninstallPackage.mockResolvedValue(undefined)
      const pkgDir = join(testSettingsDir, 'npm', 'node_modules', 'lodash')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'lodash',
        version: '4.17.21',
      }), 'utf-8')

      try {
        await service.installExtension('npm:lodash')
        expect.unreachable('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionInstallError)
        expect((e as ExtensionInstallError).code).toBe('not_extension')
        // message 文案（原「throws when package is not a valid pi extension」用例的断言并入）
        expect((e as Error).message).toMatch(/not a valid pi extension/)
      }
    })
  })

  // ── Task 4: installLocalDirectory, installGitRepository, finishInstall ──

  describe('installLocalDirectory', () => {
    it('throws for non-existent path', async () => {
      await expect(service.installLocalDirectory('/nonexistent/path'))
        .rejects.toThrow('does not exist')
    })

    it('throws for non-directory path', async () => {
      const filePath = join(testSettingsDir, 'some-file.txt')
      writeFileSync(filePath, 'hello', 'utf-8')

      await expect(service.installLocalDirectory(filePath))
        .rejects.toThrow('not a directory')
    })

    it('discovers extensions from a local directory with single pi extension', async () => {
      const sourceDir = join(testSettingsDir, 'source-ext')
      const extDir = join(sourceDir, 'my-pi-ext')
      mkdirSync(extDir, { recursive: true })
      writeFileSync(join(extDir, 'package.json'), JSON.stringify({
        name: 'pi-my-ext',
        version: '1.0.0',
        description: 'A test extension',
        keywords: ['pi-package'],
      }), 'utf-8')

      const result = await service.installLocalDirectory(sourceDir)

      try {
        expect(result.tempDir).toContain('ext-scan-')
        expect(result.candidates).toHaveLength(1)
        expect(result.candidates[0].name).toBe('pi-my-ext')
        expect(result.candidates[0].version).toBe('1.0.0')
      } finally {
        try { rmSync(result.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
      }
    })

    it('discovers extensions from a directory that IS a pi extension itself', async () => {
      const sourceDir = join(testSettingsDir, 'source-ext-single')
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
        name: 'pi-direct-ext',
        version: '2.0.0',
        description: 'Direct extension',
        pi: { type: 'extension' },
      }), 'utf-8')

      const result = await service.installLocalDirectory(sourceDir)

      try {
        expect(result.candidates).toHaveLength(1)
        expect(result.candidates[0].name).toBe('pi-direct-ext')
      } finally {
        try { rmSync(result.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
      }
    })

    it('根即 extension：dirName 是源目录名（非 tempDir basename），finishInstall 回路完整', async () => {
      // 回归测试：源目录本身就是单个 pi extension 时，dirName 必须是源目录 basename，
      // 而非 tempDir 的 basename（"ext-scan-xxxx"）。否则 finishInstall 找不到子目录。
      const sourceDir = join(testSettingsDir, 'ask-user')
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
        name: 'pi-ask-user',
        version: '0.1.0',
        description: 'single ext at root',
        keywords: ['pi-package'],
      }), 'utf-8')
      writeFileSync(join(sourceDir, 'index.ts'), '', 'utf-8')

      const result = await service.installLocalDirectory(sourceDir)

      try {
        expect(result.candidates).toHaveLength(1)
        // dirName 是源目录名，不是 tempDir basename（"ext-scan-xxxx"）
        expect(result.candidates[0].dirName).toBe('ask-user')
        expect(result.tempDir).toContain('ext-scan-') // tempDir 名仍带前缀，但 dirName 不等于它

        // finishInstall 回路：用返回的 tempDir + dirName 完成安装
        await service.finishInstall(result.tempDir, [result.candidates[0].dirName])
        const extensionsDir = join(testSettingsDir, 'extensions')
        expect(existsSync(join(extensionsDir, 'ask-user', 'package.json'))).toBe(true)
      } finally {
        try { rmSync(result.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
      }
    })

    it('returns empty candidates when no valid extensions found', async () => {
      const sourceDir = join(testSettingsDir, 'source-empty')
      mkdirSync(sourceDir, { recursive: true })

      const result = await service.installLocalDirectory(sourceDir)

      try {
        expect(result.candidates).toHaveLength(0)
      } finally {
        try { rmSync(result.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
      }
    })
  })

  describe('installGitRepository', () => {
    it('throws when git clone fails', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('git clone failed: repository not found')
      })

      await expect(service.installGitRepository('https://github.com/nonexistent/repo.git'))
        .rejects.toThrow('git clone failed')
    })

    it('RT-8#4: 依赖安装失败（failed 非空）→ 抛 deps_failed（code+hint+清单），tempDir 回收，不进发现/登记', async () => {
      // clone 成功且仓库根有 package.json（触发 installDeps 路径）
      mockedExecFileSync.mockImplementation((_cmd: string, args?: readonly string[]) => {
        if (args?.[0] === 'clone') {
          const targetDir = args[4] ?? ''
          if (targetDir) {
            mkdirSync(targetDir, { recursive: true })
            writeFileSync(join(targetDir, 'package.json'), JSON.stringify({
              name: 'dep-repo',
              dependencies: { 'some-dep': '^1.0.0' },
            }), 'utf-8')
          }
        }
        return ''
      })
      mockedInstallDependencies.mockResolvedValueOnce({
        failed: [{ name: 'some-dep', error: 'network unreachable' }],
      })

      // 此前此处仅 warn 后继续（"Non-fatal"）→ 缺依赖扩展按「已安装」走完发现/登记，
      // 以子进程崩溃形式延后暴露；现抛 deps_failed（ExtensionInstallError 透传范式，
      // 消息层 sendInstallError 转 error envelope code/hint 到前端）
      const err: unknown = await service.installGitRepository('https://github.com/user/dep-repo.git')
        .then(
          () => { throw new Error('expected installGitRepository to reject with deps_failed') },
          (e) => e,
        )
      expect(err).toBeInstanceOf(ExtensionInstallError)
      expect(err).toMatchObject({
        code: 'deps_failed',
        message: expect.stringMatching(/some-dep: network unreachable/),
        hint: expect.stringMatching(/重试|retry/),
      })

      // tempDir 已回收（tmp 下无 ext-scan-* 残留半成品）
      const tmpRoot = join(testSettingsDir, 'tmp')
      expect(existsSync(tmpRoot) ? readdirSync(tmpRoot).filter(n => n.startsWith('ext-scan-')) : []).toEqual([])
    })

    it('discovers extensions from a cloned git repo', async () => {
      // Mock: when git clone is called via execFileSync, create the extension structure in the target dir
      mockedExecFileSync.mockImplementation((_cmd: string, args?: readonly string[]) => {
        if (args?.[0] === 'clone') {
          // git clone args: ['clone', '--depth', '1', url, targetDir]
          const targetDir = args[4] ?? ''
          if (targetDir) {
            mkdirSync(targetDir, { recursive: true })
            const extDir = join(targetDir, 'packages', 'pi-cloned-ext')
            mkdirSync(extDir, { recursive: true })
            writeFileSync(join(extDir, 'package.json'), JSON.stringify({
              name: 'pi-cloned-ext',
              version: '0.5.0',
              description: 'A cloned extension',
              keywords: ['pi-package'],
            }), 'utf-8')
          }
        }
        return ''
      })

      const result = await service.installGitRepository('https://github.com/user/pi-ext-repo.git')

      expect(result.tempDir).toContain('ext-scan-')
      expect(result.candidates.length).toBeGreaterThanOrEqual(1)
      expect(result.candidates.some(c => c.name === 'pi-cloned-ext')).toBe(true)

      // Cleanup
      try { rmSync(result.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
    })

    it('clone 到 tempDir/<repoName>/ 子目录，dirName 是仓库名非 tempDir basename', async () => {
      // 回归：仓库根本身是单个 extension 时，clone 目标是 tempDir/repoName/，
      // discoverExtensions 走子目录扫描，dirName = repoName，finishInstall 回路完整。
      mockedExecFileSync.mockImplementation((_cmd: string, args?: readonly string[]) => {
        if (args?.[0] === 'clone') {
          const targetDir = args[4] ?? ''
          if (targetDir) {
            mkdirSync(targetDir, { recursive: true })
            // 仓库根本身就是 extension（package.json 直接在 targetDir 下）
            writeFileSync(join(targetDir, 'package.json'), JSON.stringify({
              name: 'pi-single-repo',
              version: '1.0.0',
              description: 'repo root IS the extension',
              keywords: ['pi-package'],
            }), 'utf-8')
            writeFileSync(join(targetDir, 'index.ts'), '', 'utf-8')
          }
        }
        return ''
      })

      const result = await service.installGitRepository('https://github.com/user/pi-single-repo.git')

      try {
        expect(result.candidates).toHaveLength(1)
        // repoName = pi-single-repo（URL 末段去 .git）
        expect(result.candidates[0].dirName).toBe('pi-single-repo')
        expect(result.tempDir).toContain('ext-scan-')

        // finishInstall 回路
        await service.finishInstall(result.tempDir, [result.candidates[0].dirName])
        const extensionsDir = join(testSettingsDir, 'extensions')
        expect(existsSync(join(extensionsDir, 'pi-single-repo', 'package.json'))).toBe(true)
      } finally {
        try { rmSync(result.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
      }
    })
  })

  describe('finishInstall', () => {
    it('copies selected extensions to extensions dir and cleans up temp', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-finish')
      const extA = join(tempDir, 'ext-a')
      const extB = join(tempDir, 'ext-b')
      mkdirSync(extA, { recursive: true })
      mkdirSync(extB, { recursive: true })
      writeFileSync(join(extA, 'package.json'), JSON.stringify({
        name: 'pi-ext-a', version: '1.0.0', description: 'A', keywords: ['pi-package'],
      }), 'utf-8')
      writeFileSync(join(extB, 'package.json'), JSON.stringify({
        name: 'pi-ext-b', version: '1.0.0', description: 'B', keywords: ['pi-package'],
      }), 'utf-8')

      // 全新安装（destDir 不存在）走 tmp+rename 直装，返回空失败清单
      // （原「全新安装（destDir 不存在）：tmp+rename 直装成功，返回空失败清单」并入）
      const failures = await service.finishInstall(tempDir, ['ext-a', 'ext-b'])
      expect(failures).toEqual([])

      const extensionsDir = join(testSettingsDir, 'extensions')
      expect(existsSync(join(extensionsDir, 'ext-a', 'package.json'))).toBe(true)
      expect(existsSync(join(extensionsDir, 'ext-b', 'package.json'))).toBe(true)
      expect(existsSync(tempDir)).toBe(false)
    })

    it('only installs selected extensions, not all', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-partial')
      const extA = join(tempDir, 'ext-a')
      const extB = join(tempDir, 'ext-b')
      mkdirSync(extA, { recursive: true })
      mkdirSync(extB, { recursive: true })
      writeFileSync(join(extA, 'package.json'), JSON.stringify({
        name: 'pi-ext-a', version: '1.0.0', description: 'A', keywords: ['pi-package'],
      }), 'utf-8')
      writeFileSync(join(extB, 'package.json'), JSON.stringify({
        name: 'pi-ext-b', version: '1.0.0', description: 'B', keywords: ['pi-package'],
      }), 'utf-8')

      await service.finishInstall(tempDir, ['ext-a'])

      const extensionsDir = join(testSettingsDir, 'extensions')
      expect(existsSync(join(extensionsDir, 'ext-a'))).toBe(true)
      expect(existsSync(join(extensionsDir, 'ext-b'))).toBe(false)
    })

    it('throws when selected extension does not exist in temp dir', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-missing')
      mkdirSync(tempDir, { recursive: true })

      await expect(service.finishInstall(tempDir, ['nonexistent']))
        .rejects.toThrow('not found in')
    })

    it('rejects symlink extension in temp dir', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-symlink')
      mkdirSync(tempDir, { recursive: true })
      // Create a symlink pointing to a real dir outside tempDir
      const targetDir = join(testSettingsDir, 'symlink-target')
      mkdirSync(targetDir, { recursive: true })
      writeFileSync(join(targetDir, 'package.json'), '{}', 'utf-8')
      symlinkSync(targetDir, join(tempDir, 'evil-link'))

      await expect(service.finishInstall(tempDir, ['evil-link']))
        .rejects.toThrow('symlink')
    })

    // ── RT-6#1 原子换代失败路径（cp/rename 抛错 → 旧目录保留 + tmp 清理 + 失败聚合）──
    // node:fs 部分替换：cpSync 对源路径含 fail-cp 标记时抛错；renameSync 对 from
    // 路径含 .tmp- 标记（换代「顶上」一步）时抛错，其余全部委托原实现——
    // 换代中断后的备份恢复（.old- → destDir）走原实现，才能断言恢复真实发生。
    it('cpSync 失败：旧目录内容原样保留、tmp 被清理、单包失败不阻断其余包、失败聚合进返回清单', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-cp-fail')
      for (const name of ['fail-cp', 'ok-ext']) {
        const src = join(tempDir, name)
        mkdirSync(src, { recursive: true })
        writeFileSync(join(src, 'package.json'), JSON.stringify({
          name: `pi-${name}`, version: '1.0.0', description: name, keywords: ['pi-package'],
        }), 'utf-8')
      }
      // 预置旧版本 fail-cp（marker 断言旧内容不被先毁后写吞掉）
      const extensionsDir = join(testSettingsDir, 'extensions')
      const oldDir = join(extensionsDir, 'fail-cp')
      mkdirSync(oldDir, { recursive: true })
      writeFileSync(join(oldDir, 'old-version.txt'), 'v1-old-content', 'utf-8')

      const failures = await service.finishInstall(tempDir, ['fail-cp', 'ok-ext'])

      // 失败聚合进返回清单（仅 fail-cp，错误消息透传 mock 的异常文案）
      expect(failures).toHaveLength(1)
      expect(failures[0]!.dirName).toBe('fail-cp')
      expect(failures[0]!.error).toContain('simulated copy failure')
      // 旧目录内容原样保留（先毁后写缺陷的回归断言）
      expect(readFileSync(join(extensionsDir, 'fail-cp', 'old-version.txt'), 'utf-8')).toBe('v1-old-content')
      // tmp 半成品被清理，无 .tmp- / .old- 残留
      expect(readdirSync(extensionsDir).some((e) => e.includes('.tmp-') || e.includes('.old-'))).toBe(false)
      // 单包失败不阻断其余包：ok-ext 正常装入
      expect(existsSync(join(extensionsDir, 'ok-ext', 'package.json'))).toBe(true)
    })

    it('renameSync 换代失败：备份恢复旧目录、tmp 被清理、失败聚合进返回清单', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-rename-fail')
      const src = join(tempDir, 'ext-a')
      mkdirSync(src, { recursive: true })
      writeFileSync(join(src, 'package.json'), JSON.stringify({
        name: 'pi-ext-a', version: '2.0.0', description: 'A', keywords: ['pi-package'],
      }), 'utf-8')
      // 预置旧版本 ext-a
      const extensionsDir = join(testSettingsDir, 'extensions')
      const oldDir = join(extensionsDir, 'ext-a')
      mkdirSync(oldDir, { recursive: true })
      writeFileSync(join(oldDir, 'old-version.txt'), 'v1-old-content', 'utf-8')
      // 打开 rename 失败注入（仅 ext-a 的 tmp 换代一步抛错）
      fsFailState.failRenameMarker = 'ext-a'

      const failures = await service.finishInstall(tempDir, ['ext-a'])

      expect(failures).toHaveLength(1)
      expect(failures[0]!.dirName).toBe('ext-a')
      expect(failures[0]!.error).toContain('ENOTEMPTY')
      // 换代中断后旧版本经备份恢复（非半目录、非丢失）
      expect(readFileSync(join(extensionsDir, 'ext-a', 'old-version.txt'), 'utf-8')).toBe('v1-old-content')
      // tmp 与备份均被清理（恢复后备份已不在）
      expect(readdirSync(extensionsDir).some((e) => e.includes('.tmp-') || e.includes('.old-'))).toBe(false)
    })

    // 深防御分支 1（RT-6#1）：顶上失败后「恢复也失败」——抛错必须带 destDir 与
    // backupDir 路径（旧内容仍在盘可手工找回的承诺），绝不静默丢弃。
    it('renameSync 顶上与恢复双失败：失败消息带 destDir/backupDir 路径与两侧错误，旧内容仍在备份目录', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-restore-also-fail')
      const src = join(tempDir, 'ext-restore-fail')
      mkdirSync(src, { recursive: true })
      writeFileSync(join(src, 'package.json'), JSON.stringify({
        name: 'pi-ext-restore-fail', version: '2.0.0', description: 'R', keywords: ['pi-package'],
      }), 'utf-8')
      // 预置旧版本 ext-restore-fail
      const extensionsDir = join(testSettingsDir, 'extensions')
      const destDir = join(extensionsDir, 'ext-restore-fail')
      mkdirSync(destDir, { recursive: true })
      writeFileSync(join(destDir, 'old-version.txt'), 'v1-old-content', 'utf-8')
      // 双注入：顶上（.tmp- → destDir）与恢复（.old- → destDir）两步 rename 均抛错
      fsFailState.failRenameMarker = 'ext-restore-fail'
      fsFailState.failRestoreRenameMarker = 'ext-restore-fail'

      const failures = await service.finishInstall(tempDir, ['ext-restore-fail'])

      expect(failures).toHaveLength(1)
      expect(failures[0]!.dirName).toBe('ext-restore-fail')
      const err = failures[0]!.error
      // 错误消息承诺旧版本所在备份路径 + 透传两侧根因（顶上 ENOTEMPTY / 恢复 EPERM）
      expect(err).toContain('restore also failed')
      expect(err).toContain(`destDir=${destDir}`)
      expect(err).toContain('ENOTEMPTY: simulated rename failure')
      expect(err).toContain('EPERM: simulated restore rename failure')
      // 备份目录名含运行期 token（pid-ts），按前缀定位后核对路径承诺与旧内容在盘
      const backupEntry = readdirSync(extensionsDir).find((e) => e.startsWith('ext-restore-fail.old-'))
      expect(backupEntry).toBeDefined()
      const backupDir = join(extensionsDir, backupEntry!)
      expect(err).toContain(`old version preserved at ${backupDir}`)
      expect(readFileSync(join(backupDir, 'old-version.txt'), 'utf-8')).toBe('v1-old-content')
      // 换代未完成且恢复也未完成：destDir 不存在（内容全在备份目录，未静默丢弃）
      expect(existsSync(destDir)).toBe(false)
    })

    // 深防御分支 2（RT-6#1）：删备份失败——换代已成功，仅磁盘残留，best-effort
    // 告警不上报（不进失败清单）。
    it('备份清理 rmSync 失败：换代成功且失败清单为空，best-effort warn 带备份路径、备份残留', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-backup-cleanup-fail')
        const src = join(tempDir, 'ext-cleanup-fail')
        mkdirSync(src, { recursive: true })
        writeFileSync(join(src, 'package.json'), JSON.stringify({
          name: 'pi-ext-cleanup-fail', version: '2.0.0', description: 'C', keywords: ['pi-package'],
        }), 'utf-8')
        // 预置旧版本 ext-cleanup-fail
        const extensionsDir = join(testSettingsDir, 'extensions')
        const destDir = join(extensionsDir, 'ext-cleanup-fail')
        mkdirSync(destDir, { recursive: true })
        writeFileSync(join(destDir, 'old-version.txt'), 'v1-old-content', 'utf-8')
        // 仅注入备份清理失败（路径含 .old- 的 rmSync）；rename 全走原实现 → 换代成功
        fsFailState.failRmBackupMarker = 'ext-cleanup-fail'

        const failures = await service.finishInstall(tempDir, ['ext-cleanup-fail'])

        // 换代已成功：destDir 是新版本内容，且不进失败清单（磁盘残留仅 best-effort）
        expect(failures).toEqual([])
        expect(JSON.parse(readFileSync(join(destDir, 'package.json'), 'utf-8')).version).toBe('2.0.0')
        // 备份目录残留（注入的 rmSync 失败未影响换代）+ warn 告警带备份路径与根因
        const backupEntry = readdirSync(extensionsDir).find((e) => e.startsWith('ext-cleanup-fail.old-'))
        expect(backupEntry).toBeDefined()
        const backupDir = join(extensionsDir, backupEntry!)
        const warned = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n')
        expect(warned).toContain('failed to cleanup backup dir')
        expect(warned).toContain(backupDir)
        expect(warned).toContain('EPERM: simulated backup cleanup failure')
        expect(readFileSync(join(backupDir, 'old-version.txt'), 'utf-8')).toBe('v1-old-content')
      } finally {
        warnSpy.mockRestore()
      }
    })
  })

  describe('cancelInstall', () => {
    it('cleans up valid temp directory', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-cancel')
      mkdirSync(tempDir, { recursive: true })
      writeFileSync(join(tempDir, 'marker.txt'), 'test', 'utf-8')

      await service.cancelInstall(tempDir)

      expect(existsSync(tempDir)).toBe(false)
    })

    it('throws for path outside allowedPrefixes', async () => {
      await expect(service.cancelInstall('/tmp/outside-foo'))
        .rejects.toThrow()
    })

    it('handles non-existent temp dir gracefully', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-nonexistent-cancel')
      // Should not throw — rmSync force:true is idempotent
      await expect(service.cancelInstall(tempDir)).resolves.toBeUndefined()
    })
  })

  describe('installGitRepository URL validation', () => {
    it('rejects http:// URLs (SSRF prevention)', async () => {
      await expect(service.installGitRepository('http://169.254.169.254/latest/meta-data/'))
        .rejects.toThrow('Invalid Git URL')
    })

    it('rejects git:// URLs', async () => {
      await expect(service.installGitRepository('git://github.com/user/repo.git'))
        .rejects.toThrow('Invalid Git URL')
    })

    it('rejects ftp:// URLs', async () => {
      await expect(service.installGitRepository('ftp://example.com/repo'))
        .rejects.toThrow('Invalid Git URL')
    })

    it('accepts https:// URLs', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('git clone failed: test')
      })
      // Should fail with git clone error, not URL validation error
      await expect(service.installGitRepository('https://github.com/user/repo.git'))
        .rejects.toThrow('git clone failed')
    })
  })

  describe('scanExtensions with discovery dirs', () => {
    // discovery.json 中的 extension 目录分两类：绝对路径（全局有效）与相对路径（项目级）。
    // 这组测试验证拆分契约：绝对路径进 scanExtensions 全局视图，相对路径只进 session 启动（getDiscoveredAndDisabled）。
    // 注意 discovery 扩展入口复刻 pi 原生扫描：扫描结果是「入口路径」（单文件 *.ts 或 <ext>/index.ts），
    // 而非扩展目录本身——ExtensionInfo.name 取入口路径 basename，readPkgMeta 也以入口为基准读 package.json。
    // 因此 fixture 用单文件 my-discovery-ext.ts（name = 'my-discovery-ext.ts'），可测 toggleExtension 的 discovery:<name> 串联回路。
    let discoveryService: ExtensionService
    let discoverySettingsDir: string

    beforeEach(() => {
      vi.clearAllMocks()
      discoverySettingsDir = mkdtempSync(join(tmpdir(), 'ext-discovery-test-'))
      writeFileSync(join(discoverySettingsDir, 'settings.json'), JSON.stringify({ packages: [] }), 'utf-8')
      mkdirSync(join(discoverySettingsDir, 'npm'), { recursive: true })
      writeFileSync(join(discoverySettingsDir, 'npm', 'package.json'), JSON.stringify({ private: true }), 'utf-8')
    })

    afterEach(() => {
      try { rmSync(discoverySettingsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
    })

    /**
     * 构造带 configStore 的 service（复刻主 beforeEach 的端口装配，额外注入 configStore）。
     * 只需 getExtensionDirs，其余 IConfigStore 方法测试不触达，按既定 partial-mock 惯例 cast。
     */
    const buildService = (configStore: { getExtensionDirs: () => string[] }): ExtensionService => new ExtensionService({
      settingsDir: discoverySettingsDir,
      // 相对路径 discovery 目录按 projectRoot resolve，测试用 discoverySettingsDir 作 base
      projectRoot: discoverySettingsDir,
      installer: new NpmGitInstaller(),
      resolver: new ExtensionResolver({
        settingsDir: discoverySettingsDir,
        thirdPartyDir: join(discoverySettingsDir, 'extensions'),
        npmDir: join(discoverySettingsDir, 'npm'),
      }),
      extensionSettings: new PiExtensionSettings(discoverySettingsDir),
      extensionsDir: join(discoverySettingsDir, 'extensions'),
      npmDir: join(discoverySettingsDir, 'npm'),
      tmpDir: join(discoverySettingsDir, 'tmp'),
      configStore: configStore as unknown as IConfigStore,
    })

    it('absolute-path discovery dir 中的扩展在 scanExtensions 可见，source=discovery', async () => {
      // 在绝对路径 discovery 目录下放一个单文件 pi extension 入口
      const discDir = join(discoverySettingsDir, 'discovery-exts')
      mkdirSync(discDir, { recursive: true })
      writeFileSync(join(discDir, 'my-discovery-ext.ts'),
        '// discovery ext entry', 'utf-8')

      const configStore = { getExtensionDirs: () => [discDir] } // 绝对路径
      discoveryService = buildService(configStore)

      const extensions = await discoveryService.scanExtensions()
      const discExt = extensions.find(e => e.source === 'discovery')
      expect(discExt).toBeDefined()
      expect(discExt!.source).toBe('discovery')
      expect(discExt!.enabled).toBe(true)
      // 单文件入口：name/dirName = 入口路径 basename，path 指向入口文件
      expect(discExt!.name).toBe('my-discovery-ext.ts')
      expect(discExt!.path).toBe(join(discDir, 'my-discovery-ext.ts'))
    })

    it('toggleExtension(false) 后 discovery 扩展 enabled=false（disabled-packages.json 按 discovery:<name> 隔离）', async () => {
      const discDir = join(discoverySettingsDir, 'discovery-exts')
      mkdirSync(discDir, { recursive: true })
      writeFileSync(join(discDir, 'my-discovery-ext.ts'), '// entry', 'utf-8')

      const configStore = { getExtensionDirs: () => [discDir] }
      discoveryService = buildService(configStore)

      const before = await discoveryService.scanExtensions()
      const discExt = before.find(e => e.source === 'discovery')!
      expect(discExt).toBeDefined()

      // 用扫描出的 name 禁用——discovery 源走 discovery:<name> 机制（#2 与 npm 源隔离）
      await discoveryService.toggleExtension(discExt.name, false)

      const after = await discoveryService.scanExtensions()
      const discExtAfter = after.find(e => e.name === discExt.name)!
      expect(discExtAfter.enabled).toBe(false)

      // disabled-packages.json 落盘 discovery:<name>（#2 源隔离）
      const disabledRaw = readFileSync(join(discoverySettingsDir, 'disabled-packages.json'), 'utf-8')
      const disabledData = JSON.parse(disabledRaw) as { disabled: string[] }
      expect(disabledData.disabled).toContain(`discovery:${discExt.name}`)
      // 不应误写 npm: 前缀（避免与同名 npm 扩展串扰）
      expect(disabledData.disabled).not.toContain(`npm:${discExt.name}`)

      // 再启用，状态恢复 enabled=true
      await discoveryService.toggleExtension(discExt.name, true)
      const reEnabled = await discoveryService.scanExtensions()
      const discExtReEnabled = reEnabled.find(e => e.name === discExt.name)!
      expect(discExtReEnabled.enabled).toBe(true)
    })

    it('relative-path discovery dir 不进 scanExtensions 全局视图（拆分契约）', async () => {
      // 相对路径 discovery 目录：依赖 projectRoot，项目级，只 session 启动按 cwd resolve 加载
      const relDirName = 'relative-exts'
      mkdirSync(join(discoverySettingsDir, relDirName), { recursive: true })
      writeFileSync(join(discoverySettingsDir, relDirName, 'rel-ext.ts'), '// rel entry', 'utf-8')

      // configStore 返回相对路径（projectRoot = discoverySettingsDir，故能 resolve 到上面造的目录）
      const configStore = { getExtensionDirs: () => [relDirName] }
      discoveryService = buildService(configStore)

      // 全局视图不应含相对路径 discovery 扩展
      const scanResult = await discoveryService.scanExtensions()
      expect(scanResult.filter(e => e.source === 'discovery')).toHaveLength(0)

      // 但 session 启动（getDiscoveredAndDisabled）按 cwd resolve 后应含相对路径 discovery 扩展
      const { discovered } = await discoveryService.getDiscoveredAndDisabled(discoverySettingsDir)
      const discoveryEntries = discovered.filter(d => d.source === 'discovery')
      expect(discoveryEntries).toHaveLength(1)
      expect(discoveryEntries[0].path).toBe(join(discoverySettingsDir, relDirName, 'rel-ext.ts'))
    })
  })

  describe('installLocalDirectory path security', () => {
    it('rejects paths outside home and tmp', async () => {
      // 传白名单外的已存在目录（/etc，macOS 上 realpath 为 /private/etc，同样是白名单外
      // 真目录）：先过 exists 与 isDirectory 判定，拒绝真正来自白名单分支。
      // （此前传 /etc/passwd 文件，拒绝来自 not-a-directory 分支，白名单检查从未被触达）
      await expect(service.installLocalDirectory('/etc'))
        .rejects.toThrow(/Source path must be under home directory or \/tmp/)
    })

    it('accepts valid extension directory under $HOME (whitelist passthrough)', async () => {
      // 正向探测白名单检查通过路径：HOME 指向 fakeHome，fakeHome 下的合法 pi 扩展目录
      // 必须通过 exists → isDirectory → 白名单三段检查并成功返回候选。
      // （原「rejects non-directory paths under home」的拒绝实际来自 not-a-directory
      // 分支，白名单判定从未被触达；非目录拒绝语义由「throws for non-directory path」
      // 用例覆盖，此处不再重复。）
      // 边界说明：fakeHome 位于 os.tmpdir() 树内（fs-guard 约束），即使 homedir() 回归为
      // 不读 $HOME，该路径仍在 tmp 白名单内通过——本用例钉住「$HOME 指向目录下的合法扩展
      // 可通过白名单检查」，不区分白名单命中来自 home 分支还是 tmp 分支。
      const realHome = process.env.HOME
      const fakeHome = mkdtempSync(join(tmpdir(), 'extsvc-home-'))
      process.env.HOME = fakeHome
      try {
        const extDir = join(fakeHome, 'my-home-ext')
        mkdirSync(extDir, { recursive: true })
        writeFileSync(join(extDir, 'package.json'), JSON.stringify({
          name: 'pi-home-ext',
          version: '1.0.0',
          description: 'ext under fake home',
          keywords: ['pi-package'],
        }), 'utf-8')

        const result = await service.installLocalDirectory(extDir)
        try {
          expect(result.candidates).toHaveLength(1)
          expect(result.candidates[0]!.name).toBe('pi-home-ext')
        } finally {
          rmSync(result.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
        }
      } finally {
        process.env.HOME = realHome
        rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })
  })

  // ── Phase 4: migrateBuiltinExtensions（清理旧版 mandatory npm install 遗留）──

  describe('migrateBuiltinExtensions', () => {
    /** 9 个 builtin 包名（与 shared/mandatory-extensions.json SSOT 对齐） */
    const builtinNames = [
      '@zhushanwen/pi-ask-user',
      '@zhushanwen/pi-goal',
      '@zhushanwen/pi-todo',
      '@zhushanwen/pi-pending-notifications',
      '@zhushanwen/pi-subagent-workflow',
      '@zhushanwen/pi-structured-output',
      '@zhushanwen/pi-permission',
      '@zhushanwen/pi-scheduler',
      '@zhushanwen/pi-rename-session',
    ]
    /** 一个不属于 builtin 的 user 包（迁移后必须保留） */
    const userPkg = 'npm:user-installed-pkg'
    /** infrastructure 级 builtin（不可禁，disabled 记录属残留，迁移清除） */
    const infraNames = ['@zhushanwen/pi-pending-notifications', '@zhushanwen/pi-structured-output']
    /** feature 级 builtin（可禁，disabled 记录是用户合法状态，迁移必须保留，M6a-02） */
    const featureNames = builtinNames.filter(n => !infraNames.includes(n))

    it('清理 3 个数据文件中的 builtin 包记录，user 记录保留', async () => {
      // settings.json packages[]：builtin + user
      const settingsPath = join(testSettingsDir, 'settings.json')
      writeFileSync(settingsPath, JSON.stringify({
        packages: [...builtinNames.map(n => `npm:${n}`), userPkg],
      }), 'utf-8')

      // auto-upgrade-packages.json：builtin + user
      writeFileSync(join(testSettingsDir, 'auto-upgrade-packages.json'), JSON.stringify({
        autoUpgrade: [...builtinNames.map(n => `npm:${n}`), userPkg],
      }), 'utf-8')

      // disabled-packages.json：builtin（infra + feature）+ user
      writeFileSync(join(testSettingsDir, 'disabled-packages.json'), JSON.stringify({
        disabled: [...builtinNames.map(n => `npm:${n}`), userPkg],
      }), 'utf-8')

      await service.migrateBuiltinExtensions()

      // settings.json：builtin 清除，user 保留
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      for (const n of builtinNames) {
        expect(settings.packages).not.toContain(`npm:${n}`)
      }
      expect(settings.packages).toContain(userPkg)

      // auto-upgrade-packages.json：builtin 清除，user 保留
      const autoRaw = readFileSync(join(testSettingsDir, 'auto-upgrade-packages.json'), 'utf-8')
      const auto = JSON.parse(autoRaw) as { autoUpgrade: string[] }
      for (const n of builtinNames) {
        expect(auto.autoUpgrade).not.toContain(`npm:${n}`)
      }
      expect(auto.autoUpgrade).toContain(userPkg)

      // disabled-packages.json（M6a-02）：infrastructure builtin 清除（残留），
      // feature builtin 保留（用户合法禁用状态），user 保留
      const disabledRaw = readFileSync(join(testSettingsDir, 'disabled-packages.json'), 'utf-8')
      const disabled = JSON.parse(disabledRaw) as { disabled: string[] }
      for (const n of infraNames) {
        expect(disabled.disabled).not.toContain(`npm:${n}`)
      }
      for (const n of featureNames) {
        expect(disabled.disabled).toContain(`npm:${n}`)
      }
      expect(disabled.disabled).toContain(userPkg)
    })

    it('禁用 feature builtin 后迁移保留 disabled（模拟 boot，M6a-02）', async () => {
      // 用户禁用 feature builtin（toggleExtension 落盘 npm:<name>）
      const disabledPath = join(testSettingsDir, 'disabled-packages.json')
      writeFileSync(disabledPath, JSON.stringify({
        disabled: ['npm:@zhushanwen/pi-goal', 'npm:@zhushanwen/pi-subagent-workflow'],
      }), 'utf-8')
      // 旧机制遗留：settings.json packages[] 有同包 npm 记录（迁移应清除）
      writeFileSync(join(testSettingsDir, 'settings.json'), JSON.stringify({
        packages: ['npm:@zhushanwen/pi-goal'],
      }), 'utf-8')

      // 模拟 boot 迁移
      await service.migrateBuiltinExtensions()

      // disabled 保留：feature builtin 禁用状态跨重启持久
      const disabled = JSON.parse(readFileSync(disabledPath, 'utf-8')) as { disabled: string[] }
      expect(disabled.disabled).toContain('npm:@zhushanwen/pi-goal')
      expect(disabled.disabled).toContain('npm:@zhushanwen/pi-subagent-workflow')
      // packages[] 仍清理（builtin 不可安装，该记录永远不该存在）
      const settings = JSON.parse(readFileSync(join(testSettingsDir, 'settings.json'), 'utf-8'))
      expect(settings.packages).not.toContain('npm:@zhushanwen/pi-goal')
    })

    it('迁移清除 infrastructure builtin 的 disabled 残留（M6a-02）', async () => {
      // 旧 mandatory 机制/手动编辑残留的 infrastructure disabled 记录应被清除
      writeFileSync(join(testSettingsDir, 'disabled-packages.json'), JSON.stringify({
        disabled: ['npm:@zhushanwen/pi-pending-notifications', 'npm:@zhushanwen/pi-structured-output'],
      }), 'utf-8')

      await service.migrateBuiltinExtensions()

      // infrastructure disabled 全清后 disabled-packages.json 被 JsonStore 删除（空数组删文件行为）
      expect(existsSync(join(testSettingsDir, 'disabled-packages.json'))).toBe(false)
    })

    it('幂等：无 builtin 记录时不报错且数据不变', async () => {
      // 3 个文件只含 user 记录（无 builtin）
      const settingsPath = join(testSettingsDir, 'settings.json')
      writeFileSync(settingsPath, JSON.stringify({ packages: [userPkg] }), 'utf-8')
      writeFileSync(join(testSettingsDir, 'auto-upgrade-packages.json'), JSON.stringify({
        autoUpgrade: [userPkg],
      }), 'utf-8')
      writeFileSync(join(testSettingsDir, 'disabled-packages.json'), JSON.stringify({
        disabled: [userPkg],
      }), 'utf-8')

      await expect(service.migrateBuiltinExtensions()).resolves.toBeUndefined()

      // user 记录完整保留
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      expect(settings.packages).toEqual([userPkg])
      const auto = JSON.parse(readFileSync(join(testSettingsDir, 'auto-upgrade-packages.json'), 'utf-8')) as { autoUpgrade: string[] }
      expect(auto.autoUpgrade).toEqual([userPkg])
      const disabled = JSON.parse(readFileSync(join(testSettingsDir, 'disabled-packages.json'), 'utf-8')) as { disabled: string[] }
      expect(disabled.disabled).toEqual([userPkg])
    })

    it('幂等：3 个文件均不存在时不报错', async () => {
      // 删除 beforeEach 造的 settings.json，模拟全新安装（无任何历史文件）
      rmSync(join(testSettingsDir, 'settings.json'), { force: true })
      rmSync(join(testSettingsDir, 'disabled-packages.json'), { force: true })
      rmSync(join(testSettingsDir, 'auto-upgrade-packages.json'), { force: true })

      await expect(service.migrateBuiltinExtensions()).resolves.toBeUndefined()
    })
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('ws-listen-hardening', () => {
describe('SEC-U2 WS transport hardening (loopback + maxPayload + auth handshake)', () => {
  let cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const fn of cleanup) await fn()
    cleanup = []
  })

  it('SEC-U2 listen 显式绑 127.0.0.1（不对局域网开放）', async () => {
    const { conn, port } = await startManager(TEST_TOKEN)
    cleanup.push(() => conn.stop())
    // 绑定地址经 OS 视角断言（address() 返回实际绑定的地址族）
    const addr = (conn as unknown as { httpServer: { address(): { address: string; port: number } } }).httpServer.address()
    expect(addr.address).toBe('127.0.0.1')
    expect(addr.port).toBe(port)
  })

  it('SEC-U2 maxPayload 常量生效——超限消息连接被关闭', async () => {
    const { conn, port } = await startManager(TEST_TOKEN)
    cleanup.push(() => conn.stop())
    const { ws, authResult } = await connectAndAuth(port, TEST_TOKEN)
    expect(authResult.ok).toBe(true)

    // 发送超限消息（MAX_WS_PAYLOAD_BYTES + 1 字节的 JSON payload）——ws 库收到超限帧
    // 以 close 1009 (Message Too Big) 关闭连接
    const closed = waitClose(ws)
    const oversized = 'x'.repeat(MAX_WS_PAYLOAD_BYTES + 1024)
    ws.send(JSON.stringify({ type: 'ping', payload: { pad: oversized } }))
    const { code } = await closed
    expect([1009, 1006, 1005]).toContain(code)
  })

  it('SEC-U2 无 auth 的客户端被拒——pre-auth 业务消息被丢弃，auth 超时断开', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { conn, port } = await startManager(TEST_TOKEN)
      cleanup.push(() => conn.stop())
      const onMessage = (conn as unknown as { callbacks: { onMessage: (msg: ClientMessage) => void } }).callbacks.onMessage

      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      await new Promise<void>((resolve) => ws.once('open', () => resolve()))
      // auth 前发业务消息：静默丢弃（不进 handleMessage、不断开——等 auth 超时再断）
      ws.send(JSON.stringify({ type: 'plugin.toggle', id: 'evil-1', payload: { pluginId: 'x', enabled: false } }))
      // 丢弃路径的确定性完成信号 = 首条 pre-auth 必打的 warn（服务端逐条同步处理，
      // warn 已发生即该消息已按丢弃路径处理完毕）——替代固定 300ms 盲等
      await vi.waitFor(() => {
        expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('dropping pre-auth'))).toBe(true)
      }, { interval: 1 })
      expect(onMessage).not.toHaveBeenCalled()
      ws.close()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('SEC-U2 pre-auth 丢弃告警连接级频控——同一连接第二条非 auth 消息不再 warn', async () => {
    // code-harden P2：10s 握手窗口内逐条 warn 可刷屏，改为每连接只 warn 首条。
    // 断言按消息内容过滤计数（free-port helper 撞端口重试会 warn，不计入）。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { conn, port } = await startManager(TEST_TOKEN)
      cleanup.push(() => conn.stop())
      const droppingCalls = () => warnSpy.mock.calls.filter((c) => String(c[0]).includes('dropping pre-auth'))

      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      await new Promise<void>((resolve) => ws.once('open', () => resolve()))
      // 首条非 auth 消息：warn 一次（含消息 type）——warn 是丢弃路径的确定性产物，
      // 等它出现即该消息已处理完毕（替代固定 200ms 盲等）
      ws.send(JSON.stringify({ type: 'plugin.toggle', id: 'evil-1', payload: { pluginId: 'x', enabled: false } }))
      await vi.waitFor(() => {
        expect(droppingCalls().length).toBe(1)
      }, { interval: 1 })
      expect(String(droppingCalls()[0]?.[0])).toContain('type=plugin.toggle')
      // 第二条：静默丢弃，不再 warn。其处理完毕的确定性信号 = 随后的错误 token auth
      // 走完拒绝链（close 1008 到达）——WS 消息按序处理，close 到达即前一条已处理完
      const closed = waitClose(ws)
      ws.send(JSON.stringify({ type: 'plugin.toggle', id: 'evil-2', payload: { pluginId: 'x', enabled: false } }))
      ws.send(JSON.stringify({ type: 'auth', payload: { token: 'forged-after-drop' } }))
      const { code } = await closed
      expect(code).toBe(1008)
      expect(droppingCalls().length).toBe(1)
      ws.close()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('SEC-U2 错误 token 被拒（auth.result ok=false + close 1008）', async () => {
    const { conn, port } = await startManager(TEST_TOKEN)
    cleanup.push(() => conn.stop())

    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const closed = waitClose(ws)
    const authReply = new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data))
        if (msg.type === 'auth.result') resolve(msg.payload)
      })
    })
    await new Promise<void>((resolve) => ws.once('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'auth', payload: { token: 'forged-token-attempt' } }))

    const reply = await authReply
    expect(reply.ok).toBe(false)
    expect(reply.reason).toBe('bad_token')
    const { code } = await closed
    expect(code).toBe(1008)
  })

  it('SEC-U2 正确 token auth 后消息正常受理（onConnect + onMessage 触发）', async () => {
    const { conn, port, onMessage, onConnect } = await startManager(TEST_TOKEN)
    cleanup.push(() => conn.stop())

    const { ws, authResult } = await connectAndAuth(port, TEST_TOKEN)
    expect(authResult.ok).toBe(true)
    // auth 成功 → 连接入池 + initial state 通道打开
    expect(onConnect).toHaveBeenCalledTimes(1)
    expect(conn.clients.size).toBe(1)

    // auth 后业务消息正常路由
    const seen = new Promise<void>((resolve) => {
      const iv = setInterval(() => { if (onMessage.mock.calls.length > 0) { clearInterval(iv); resolve() } }, 20)
    })
    ws.send(JSON.stringify({ type: 'plugin.toggle', id: 'legit-1', payload: { pluginId: 'x', enabled: true } }))
    await seen
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'plugin.toggle', id: 'legit-1' }),
      expect.anything(),
    )
    ws.close()
  })

  it('SEC-U2 fail-closed——token 未配置（null）时拒绝全部连接（close 1008）', async () => {
    const { conn, port } = await startManager(null)
    cleanup.push(() => conn.stop())

    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const closed = waitClose(ws)
    const authReply = new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data))
        if (msg.type === 'auth.result') resolve(msg.payload)
      })
    })
    await new Promise<void>((resolve) => ws.once('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'auth', payload: { token: 'anything' } }))

    const reply = await authReply
    expect(reply.ok).toBe(false)
    expect(reply.reason).toBe('no_token_configured')
    const { code } = await closed
    expect(code).toBe(1008)
  })

  it('SEC-U2 EADDRINUSE → reject（非 process.exit）+ 可操作文案', async () => {
    // 先用真实 http server 占住一个端口，再让 ConnectionManager 对同端口 listen。
    // 旧实现对 EADDRINUSE 直接 process.exit(1)——测试 worker 会被整个杀掉（本用例
    // 以 crash/超时的可观察方式失败）。新语义（对齐 callback-server.ts 先例）：reject
    // 保留 code=EADDRINUSE + 可操作排查文案，进程生死由调用方（组合根）决定。
    const occupied = createServer()
    const port = await new Promise<number>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '127.0.0.1', () => {
        const addr = occupied.address()
        if (addr && typeof addr === 'object') resolve(addr.port)
        else reject(new Error('occupied server address() returned non-object'))
      })
    })
    cleanup.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())))

    const conn = new ConnectionManager(port, {
      onConnect: vi.fn(),
      onMessage: vi.fn().mockResolvedValue(undefined),
      sendError: vi.fn(),
    }, TEST_TOKEN)
    cleanup.push(() => conn.stop())

    await expect(conn.start()).rejects.toMatchObject({
      code: 'EADDRINUSE',
      message: expect.stringMatching(/端口 \d+ 被占用.*lsof -i :\d+/s),
    })
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('fs-executor-listdir', () => {
beforeEach(() => {
  vi.clearAllMocks()
  // 坏 symlink 跳过路径有 console.warn，压掉保持测试输出干净
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
describe('FsExecutor.listDir withSize 参数化 (D7-3)', () => {
  it('默认（无 opts）：file entry 逐个 stat 取 size，dir entry 不 stat（现状行为不变）', async () => {
    readdirMock.mockResolvedValue([dirent('a.txt', 'file'), dirent('src', 'dir'), dirent('b.md', 'file')])
    statMock.mockResolvedValue(statResult(42))

    const entries = await new FsExecutor().listDir('/repo')

    expect(entries).toEqual([
      { name: 'a.txt', type: 'file', size: 42 },
      { name: 'src', type: 'dir' },
      { name: 'b.md', type: 'file', size: 42 },
    ])
    expect(statMock).toHaveBeenCalledTimes(2)
    expect(statMock).toHaveBeenCalledWith('/repo/a.txt')
    expect(statMock).toHaveBeenCalledWith('/repo/b.md')
  })

  it('withSize=false：非 symlink 的 file entry 免 stat（零 stat 调用），size 缺省', async () => {
    readdirMock.mockResolvedValue([dirent('a.txt', 'file'), dirent('src', 'dir'), dirent('b.md', 'file')])

    const entries = await new FsExecutor().listDir('/repo', { withSize: false })

    expect(entries).toEqual([
      { name: 'a.txt', type: 'file' },
      { name: 'src', type: 'dir' },
      { name: 'b.md', type: 'file' },
    ])
    expect(statMock).not.toHaveBeenCalled()
  })

  it('withSize=false：symlink entry 仍 stat——好 symlink 收录（带 size），坏 symlink（ELOOP）跳过', async () => {
    readdirMock.mockResolvedValue([
      dirent('good.lnk', 'file', true),
      dirent('bad.lnk', 'file', true),
      dirent('plain.txt', 'file', false),
    ])
    statMock.mockImplementation(async (p) => {
      if (String(p).endsWith('bad.lnk')) {
        throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' })
      }
      return statResult(7)
    })

    const entries = await new FsExecutor().listDir('/repo', { withSize: false })

    // bad.lnk 被跳过——与 withSize=true 的坏 symlink 跳过语义严格一致（结果集成员不变）
    expect(entries).toEqual([
      { name: 'good.lnk', type: 'file', size: 7 },
      { name: 'plain.txt', type: 'file' },
    ])
    // 仅两个 symlink entry 触发 stat（plain.txt 免）
    expect(statMock).toHaveBeenCalledTimes(2)
    expect(statMock).toHaveBeenCalledWith('/repo/good.lnk')
    expect(statMock).toHaveBeenCalledWith('/repo/bad.lnk')
  })

  it('withSize=true 显式：与默认一致（file entry 带 size）', async () => {
    readdirMock.mockResolvedValue([dirent('a.txt', 'file')])
    statMock.mockResolvedValue(statResult(9))

    const entries = await new FsExecutor().listDir('/repo', { withSize: true })

    expect(entries).toEqual([{ name: 'a.txt', type: 'file', size: 9 }])
    expect(statMock).toHaveBeenCalledTimes(1)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('handoff-formatter', () => {
describe('wrapWithXmlTag (TC1/TC2 纯函数)', () => {
  it('TC1 基本包装：含 handoff_document 开标签 + doc + 结束标签 + action 后缀', () => {
    const doc = '# 交接文档\n\n- 任务A\n- 任务B'
    const out = wrapWithXmlTag(doc, 'src')

    // 开标签含 source + created 属性
    expect(out.startsWith('<handoff_document source="src" created="')).toBe(true)
    // doc 原样嵌入（标签行后紧跟 doc）
    expect(out).toContain(`>\n${doc}\n</handoff_document>`)
    // action 后缀在结束标签之后（空行分隔）
    expect(out.endsWith(`</handoff_document>\n\n${ACTION_SUFFIX}`)).toBe(true)
  })

  it('TC1 filePath undefined 时不出现 file 属性', () => {
    const out = wrapWithXmlTag('doc', 'src')
    // 仅 source + created 两个属性，无 file
    expect(out).toMatch(/^<handoff_document source="src" created="[^"]+">/)
    expect(out).not.toContain(' file=')
  })

  it('TC1 filePath 非空时含 file="..."', () => {
    const out = wrapWithXmlTag('doc', 'src', '/path/to/doc.jsonl')
    // 开标签含 file 属性，位置在 created 之后
    expect(out).toMatch(
      /^<handoff_document source="src" created="[^"]+" file="\/path\/to\/doc\.jsonl">/,
    )
  })

  it('TC2 created 是有效 ISO8601（new Date 解析不为 NaN）', () => {
    const out = wrapWithXmlTag('doc', 'src')
    const match = out.match(/created="([^"]+)"/)
    expect(match).not.toBeNull()
    const created = match![1]
    expect(Number.isNaN(new Date(created).getTime())).toBe(false)
  })

  it('TC2 source 含特殊字符 " & < > 时被转义', () => {
    // escapeXmlAttr：& → &amp; (先)，" → &quot;，< → &lt;，> → &gt;
    const out = wrapWithXmlTag('doc', 'a"b&c<d>e')
    // source 属性整体应为 source="a&quot;b&amp;c&lt;d&gt;e"
    expect(out).toContain('source="a&quot;b&amp;c&lt;d&gt;e"')
    // 原始特殊字符不应在属性值里出现（& 已变成 &amp;，等）
    expect(out).not.toContain('source="a"b&c<d>e"')
  })

  it('TC2 filePath 含特殊字符时也被转义', () => {
    const out = wrapWithXmlTag('doc', 'src', 'pa&th"with<spec>ials')
    expect(out).toContain('file="pa&amp;th&quot;with&lt;spec&gt;ials"')
  })

  it('SUGGESTION 2：source 含换行 \\n \\r 时被转义为 &#10; &#13;（防破坏 xml 属性边界）', () => {
    // session label 含换行时，不转义会让属性值跨行（属性引号边界被切断），且 xml parser
    // 规范化属性 CR/CRLF/LF → LF 致 round-trip 不可逆。
    const out = wrapWithXmlTag('doc', 'multi\nline\rlabel')
    // source 属性应含 &#10;（\n）和 &#13;（\r），原换行不应在属性值里出现
    expect(out).toContain('source="multi&#10;line&#13;label"')
    // 原始换行不应出现在开标签里
    const openTag = out.slice(0, out.indexOf('>'))
    expect(openTag).not.toContain('\n')
    expect(openTag).not.toContain('\r')
  })

  it('SUGGESTION 2：filePath 含换行时也被转义', () => {
    const out = wrapWithXmlTag('doc', 'src', 'path/with\nnewline')
    expect(out).toContain('file="path/with&#10;newline"')
    const openTag = out.slice(0, out.indexOf('>'))
    expect(openTag).not.toContain('\n')
  })

  it('TC2 action 后缀文案精确匹配', () => {
    const out = wrapWithXmlTag('doc', 'src')
    expect(out.endsWith(ACTION_SUFFIX)).toBe(true)
    // 后缀完整文案逐字校验（防止后续改动静默漂移）
    expect(out).toContain(ACTION_SUFFIX)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('server-destroyed-converged-cleanup', () => {
// ── 分层 1：server 装配的汇聚清理（extensionTimeoutMgr 真实例） ──────────────

describe('D6a: server.setServices 注册 onSessionDestroyed 汇聚清理', () => {
  it('回调触发 → extensionTimeoutMgr.clearForSession 生效（pendingRequests 清空，分区隔离）', () => {
    const MockSvc = createMockSessionServiceClass()
    const sessionService = new MockSvc() as unknown as ISessionService
    const server = new RuntimeServer(0, '/tmp/test-project')
    server.setServices(sessionService, {} as never, {} as never)

    // 装配时注册了回调（追加式列表槽，PluginService 后续注册共存）
    const registered = vi.mocked(sessionService.setOnSessionDestroyed)
    expect(registered).toHaveBeenCalledTimes(1)
    const handler = registered.mock.calls[0]![0]

    // 模拟挂起的 ask-user 请求（pending 缓存）。
    // [pi1-disposition-chat-flow D7②] bridge 登记（bridgeRequestIds）随 plugin-bridge 退役删除。
    server.registerExtensionTimeout('s1', 'req-ask', 'ask-user', { question: 'continue?' })
    server.registerExtensionTimeout('s2', 'req-other', 'ask-user', { question: 'other' })
    const mgr = (server as unknown as { extensionTimeoutMgr: ExtensionTimeoutManager }).extensionTimeoutMgr
    expect(mgr.getPendingRequests('s1')).toHaveLength(1)

    // 触发点传 summary（removeSessionEntry 删除前缓存；Map 无条目时是最小形状，id 恒可靠）
    handler({ id: 's1', label: 's1', cwd: '', status: 'dead', lastActiveAt: 0 })

    expect(mgr.getPendingRequests('s1')).toHaveLength(0)
    // per-session 分区：s2 不受 s1 清理影响
    expect(mgr.getPendingRequests('s2')).toHaveLength(1)
  })
})
describe('D6a: 真实 SessionService 两条销毁路径触发 onSessionDestroyed 回调列表', () => {
  it('进程意外退出（onSessionExit → removeSessionEntry）触发全部回调 + occupancy 全复位帧先于 clearSession（A3）', async () => {
    const { svc, bus, triggerExit } = makeRealServiceEnv()
    const { plugin, cleanup } = registerHandlers(svc)
    const session = await svc.initializeManagedSession('s-exit', {} as unknown as IPiEngine, '/tmp', 'test')

    // 构造「占用中 pi 死亡」场景（D3 转移 #10 的主防线语义）：占用中 agent_settled /
    // compaction_end 永不到达，onSessionExit 全复位是唯一兜底——否则重连 renderer 经
    // stateSnapshot 回放恢复的是永久占用派生视图。先置占用派生视图（订阅前，received 只收
    // triggerExit 后的帧），再订阅并触发退出。
    applySessionOccupancyTransition(session, bus, 'generating')
    applySessionOccupancyTransition(session, bus, 'compacting-start')

    // 订阅 bus（BusClient 最小契约 readyState + send）捕获 publish 帧；spy 记录
    // clearSession（removeSessionEntry 内部清订阅者集合）相对顺序
    const received: ServerMessage[] = []
    const ws = { readyState: 1, send: (data: string) => { received.push(JSON.parse(data) as ServerMessage) } }
    bus.subscribe('s-exit', ws as never)
    const clearSessionSpy = vi.spyOn(bus, 'clearSession')
    const publishSpy = vi.spyOn(bus, 'publish')

    triggerExit('s-exit', 1, 'boom')

    expect(plugin).toHaveBeenCalledWith('s-exit')
    expect(cleanup).toHaveBeenCalledWith('s-exit')

    // occupancy 全复位帧：{turn:'idle', compacting:false, bash:false}（D3 转移 #10）
    const occFrames = received.filter((m) => m.type === 'session.occupancy')
    expect(occFrames).toHaveLength(1)
    expect(occFrames[0]!.payload).toMatchObject({ sessionId: 's-exit', turn: 'idle', compacting: false, bash: false })
    // session.exited 同样经 bus publish 到达订阅者（broadcast 路径已删，publish 唯一通道）
    expect(received.some((m) => m.type === 'session.exited')).toBe(true)

    // 帧序约束：occupancy 复位 publish 先于 clearSession 清空——clearSession 之后订阅者
    // 集合为空，届时才 publish 等于送空集合，订阅 renderer 一条也收不到（占用卡死）。
    const occCallIdx = publishSpy.mock.calls.findIndex((c) => (c[1] as ServerMessage).type === 'session.occupancy')
    expect(occCallIdx).toBeGreaterThanOrEqual(0)
    expect(publishSpy.mock.invocationCallOrder[occCallIdx]!).toBeLessThan(clearSessionSpy.mock.invocationCallOrder[0]!)
  })

  it('主动删除（lifecycle.delete → removeSessionEntry）触发全部回调', async () => {
    const { svc } = makeRealServiceEnv()
    const { plugin, cleanup } = registerHandlers(svc)
    await svc.initializeManagedSession('s-del', {} as unknown as IPiEngine, '/tmp', 'test')

    await svc.delete('s-del')

    expect(plugin).toHaveBeenCalledWith('s-del')
    expect(cleanup).toHaveBeenCalledWith('s-del')
  })

  it('回调列表隔离：首个 handler 抛错不阻断后续 handler，也不外抛', async () => {
    const { svc, triggerExit } = makeRealServiceEnv()
    const second = vi.fn()
    svc.setOnSessionDestroyed(() => { throw new Error('plugin didDestroy boom') })
    svc.setOnSessionDestroyed((summary: SessionSummary) => { second(summary.id) })
    await svc.initializeManagedSession('s-iso', {} as unknown as IPiEngine, '/tmp', 'test')

    expect(() => triggerExit('s-iso', 1, '')).not.toThrow()
    expect(second).toHaveBeenCalledWith('s-iso')
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('workspace-message-handler', () => {
// ── T1.9: WorkspaceMessageHandler RPC 贯穿 ─────────────────────

describe('WorkspaceMessageHandler — T1.9 RPC 贯穿', () => {
  it('workspace.listRecent → reply workspace.recentList with records', async () => {
    const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
    const mockRecords = [
      { cwd: '/a', lastUsedAt: 1000, label: 'a' },
      { cwd: '/b', lastUsedAt: 2000, label: 'b' },
    ]
    const cap = { replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }> }
    const ctx = {
      send: vi.fn(),
      sendError: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      workspaceService: { list: vi.fn().mockReturnValue(mockRecords), record: vi.fn() },
    }
    const handler = new WorkspaceMessageHandler(ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0])
    const msg = { type: 'workspace.listRecent', id: 'req1', payload: {} } as unknown as ClientMessage
    const WS = {} as never

    await handler.handleWorkspaceMessage(msg, WS)

    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'req1',
      type: 'workspace.recentList',
      payload: { records: mockRecords },
    })
  })

  it('workspace.listRecent → empty list returns empty array', async () => {
    const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
    const cap = { replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }> }
    const ctx = {
      send: vi.fn(),
      sendError: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      workspaceService: { list: vi.fn().mockReturnValue([]), record: vi.fn() },
    }
    const handler = new WorkspaceMessageHandler(ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0])
    const msg = { type: 'workspace.listRecent', id: 'req2', payload: {} } as unknown as ClientMessage
    const WS = {} as never

    await handler.handleWorkspaceMessage(msg, WS)

    expect(cap.replies[0].payload).toMatchObject({ records: [] })
  })

  it('workspace.record → record(cwd) 被调并 reply 最新 records（热更新）', async () => {
    const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
    const mockRecords = [
      { cwd: '/new', lastUsedAt: 3000, label: 'new' },
      { cwd: '/a', lastUsedAt: 1000, label: 'a' },
    ]
    const cap = { replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }> }
    const workspaceService = {
      record: vi.fn(),
      list: vi.fn().mockReturnValue(mockRecords),
    }
    const ctx = {
      send: vi.fn(),
      sendError: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      workspaceService,
    }
    const handler = new WorkspaceMessageHandler(ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0])
    const msg = { type: 'workspace.record', id: 'req3', payload: { cwd: '/new' } } as unknown as ClientMessage
    const WS = {} as never

    await handler.handleWorkspaceMessage(msg, WS)

    // record 被调传入 cwd
    expect(workspaceService.record).toHaveBeenCalledWith('/new')
    expect(workspaceService.record).toHaveBeenCalledTimes(1)
    // reply 返回刷新后的列表（一次往返完成写入+刷新）
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'req3',
      type: 'workspace.recentList',
      payload: { records: mockRecords },
    })
  })

  it('workspace.record 空 cwd → 仍 reply workspace.recentList（W6：校验失败不破坏 RPC 契约）', async () => {
    const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
    const mockRecords = [{ cwd: '/a', lastUsedAt: 1000, label: 'a' }]
    const cap = { replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }> }
    const workspaceService = {
      record: vi.fn(),
      list: vi.fn().mockReturnValue(mockRecords),
    }
    const ctx = {
      send: vi.fn(),
      sendError: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      workspaceService,
    }
    const handler = new WorkspaceMessageHandler(ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0])
    const msg = { type: 'workspace.record', id: 'req4', payload: { cwd: '   ' } } as unknown as ClientMessage
    const WS = {} as never

    await handler.handleWorkspaceMessage(msg, WS)

    // 空 cwd 不应 record（不污染最近工作区列表）
    expect(workspaceService.record).not.toHaveBeenCalled()
    // 但仍必须 reply，否则前端 pending Promise 永不 resolve（破坏 RPC 契约）
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'req4',
      type: 'workspace.recentList',
      payload: { records: mockRecords },
    })
  })
})
// ── T2.1-T2.5: 写入时机接入 ────────────────────────────────────

// SessionLifecycle 不再 import readPiState（W2 已删，create 改用 client.getState()）。
// pi-engine.js 仅剩类型导出，无需 vi.mock 运行时值。

describe('SessionLifecycle — 写入时机 record', () => {
  it('T2.1: create 成功后 record(sessionCwd) 被调', async () => {
    // client.getState() 返回 pi session 状态（sessionId/sessionFile）
    const { SessionLifecycle } = await import('../src/services/session/session-lifecycle.js')
    const workspaceRecord = vi.fn()
    const workspaceService = { record: workspaceRecord, list: vi.fn().mockReturnValue([]) }
    const mockClient = {
      getState: vi.fn().mockResolvedValue({ sessionId: 's1', sessionFile: '/tmp/s1.jsonl' }),
      onEvent: vi.fn().mockReturnValue(() => {}),
    }
    const svc = {
      getExtensionPaths: vi.fn().mockResolvedValue([]),
      getSkillPaths: vi.fn().mockReturnValue([]),
      getReplaceSystemPrompt: vi.fn(() => undefined),
      initializeManagedSession: vi.fn().mockResolvedValue({ id: 's1', cwd: '/test', label: 'test' }),
      toSummary: vi.fn().mockReturnValue({ id: 's1', cwd: '/test', label: 'test' }),
      // S3-W2：创建入口收敛点
      notifySessionCreated: vi.fn(),
    }
    const pm = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      destroySession: vi.fn().mockResolvedValue(undefined),
      rekey: vi.fn(),
    }
    const configStore = { getDefaultModel: vi.fn().mockReturnValue({ provider: 'p', modelId: 'm' }) }
    const sessionStore = { refreshAll: vi.fn() }

    // 当前 SessionLifecycle 只有 4 个构造参数，workspaceService 是本次 W2 新增的第 5 个。
    // 如果测试因"too many arguments"编译失败，说明实现尚未加参数——这是预期的 TDD 失败。
    // 实现后此行应正常编译。
    // S3 写点归位：新增第 6 参 registerDeps（真 registerSession 的装配依赖，fake adapterFactory）。
    const lifecycle = new SessionLifecycle(
      svc as unknown as ConstructorParameters<typeof SessionLifecycle>[0],
      pm as unknown as ConstructorParameters<typeof SessionLifecycle>[1],
      configStore as unknown as ConstructorParameters<typeof SessionLifecycle>[2],
      sessionStore as unknown as ConstructorParameters<typeof SessionLifecycle>[3],
      workspaceService as unknown as ConstructorParameters<typeof SessionLifecycle>[4],
      {
        adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }),
        getMessageBus: () => null,
        broadcastGlobal: () => {},
      } as ConstructorParameters<typeof SessionLifecycle>[5],
    )

    await lifecycle.create(tmpdir(), 'test')

    expect(workspaceRecord).toHaveBeenCalledWith(tmpdir())
    expect(workspaceRecord).toHaveBeenCalledTimes(1)
  })

  it('T2.3: pi create 失败 → record 未被调', async () => {
    const { SessionLifecycle } = await import('../src/services/session/session-lifecycle.js')
    const workspaceRecord = vi.fn()
    const workspaceService = { record: workspaceRecord, list: vi.fn().mockReturnValue([]) }
    const svc = {
      getExtensionPaths: vi.fn().mockResolvedValue([]),
      getSkillPaths: vi.fn().mockReturnValue([]),
      getReplaceSystemPrompt: vi.fn(() => undefined),
      initializeManagedSession: vi.fn(),
      toSummary: vi.fn(),
    }
    const pm = {
      createSession: vi.fn().mockRejectedValue(new Error('pi spawn failed')),
      destroySession: vi.fn().mockResolvedValue(undefined),
      rekey: vi.fn(),
    }
    const configStore = { getDefaultModel: vi.fn().mockReturnValue({ provider: 'p', modelId: 'm' }) }
    const sessionStore = { refreshAll: vi.fn() }

    const lifecycle = new SessionLifecycle(
      svc as unknown as ConstructorParameters<typeof SessionLifecycle>[0],
      pm as unknown as ConstructorParameters<typeof SessionLifecycle>[1],
      configStore as unknown as ConstructorParameters<typeof SessionLifecycle>[2],
      sessionStore as unknown as ConstructorParameters<typeof SessionLifecycle>[3],
      workspaceService as unknown as ConstructorParameters<typeof SessionLifecycle>[4],
      {
        adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }),
        getMessageBus: () => null,
        broadcastGlobal: () => {},
      } as ConstructorParameters<typeof SessionLifecycle>[5],
    )

    await expect(lifecycle.create('/test')).rejects.toThrow('pi spawn failed')
    expect(workspaceRecord).not.toHaveBeenCalled()
  })
})
describe('MessageDispatcher — 写入时机 record', () => {
  it('T2.2: sendPrompt 成功后 record(activeSession.cwd) 被调', async () => {
    const { MessageDispatcher } = await import('../src/services/session/message-dispatcher.js')
    const workspaceRecord = vi.fn()
    const workspaceService = { record: workspaceRecord, list: vi.fn().mockReturnValue([]) }
    const mockClient = { prompt: vi.fn().mockResolvedValue(undefined), onEvent: vi.fn().mockReturnValue(() => {}) }
    const activeSession = { cwd: '/project', lastActiveAt: 0, isGenerating: false }
    const svc = {
      ensureActive: vi.fn().mockResolvedValue(mockClient),
      getSessionByClient: vi.fn().mockReturnValue(activeSession),
      // runAcceptance 受理成功路径清旧 outcome sidecar（dmg-r1-1）——本测试只关 record
      // 时机，行为断言在 dispatcher 专项测试文件
      clearSessionOutcome: vi.fn(),
    }
    // getClient → undefined：无附着 client 形态（sendPrompt 入口 touch 的空检查分支）
    const pm = { getClient: vi.fn(() => undefined) }
    // wave:perf-w09（D1-2）：dispatcher 4 参（svc/pm/workspace/bus），broker 依赖已删
    const bus = { publish: vi.fn() } as unknown as ConstructorParameters<typeof MessageDispatcher>[3]
    const registry = wireDeliveryKernel({ getSession: () => activeSession, ensureActive: svc.ensureActive, record: workspaceRecord, bus })
    const dispatcher = new MessageDispatcher(
      svc as unknown as ConstructorParameters<typeof MessageDispatcher>[0],
      pm as unknown as ConstructorParameters<typeof MessageDispatcher>[1],
      workspaceService as unknown as ConstructorParameters<typeof MessageDispatcher>[2],
      bus,
    )
    dispatcher.setDeliveryRegistry(registry)

    const result = await dispatcher.sendMessage('s1', 'hello')
    await flushDelivery(30)

    expect(result.blocked).toBe(false)
    expect(workspaceRecord).toHaveBeenCalledWith('/project')
    expect(workspaceRecord).toHaveBeenCalledTimes(1)
  })


  it('T2.4: hook blocked → record 未被调', async () => {
    const { MessageDispatcher } = await import('../src/services/session/message-dispatcher.js')
    const workspaceRecord = vi.fn()
    const workspaceService = { record: workspaceRecord, list: vi.fn().mockReturnValue([]) }
    const svc = {
      ensureActive: vi.fn(),
      getSessionByClient: vi.fn(),
    }
    // getClient → undefined：无附着 client 形态（sendPrompt 入口 touch 的空检查分支）
    const pm = { getClient: vi.fn(() => undefined) }
    // wave:perf-w09（D1-2）：dispatcher 4 参（svc/pm/workspace/bus），broker 依赖已删
    const bus = { publish: vi.fn() } as unknown as ConstructorParameters<typeof MessageDispatcher>[3]
    const registry = wireDeliveryKernel({ getSession: () => undefined, ensureActive: svc.ensureActive, record: workspaceRecord, bus })
    const dispatcher = new MessageDispatcher(
      svc as unknown as ConstructorParameters<typeof MessageDispatcher>[0],
      pm as unknown as ConstructorParameters<typeof MessageDispatcher>[1],
      workspaceService as unknown as ConstructorParameters<typeof MessageDispatcher>[2],
      bus,
    )
    dispatcher.setDeliveryRegistry(registry)

    // 注册一个会 block 的 hook
    dispatcher.setSendMessageHook(vi.fn().mockResolvedValue({ blocked: true, reason: 'blocked by hook' }))

    const result = await dispatcher.sendMessage('s1', 'hello')
    await flushDelivery(30)

    expect(result.blocked).toBe(true)
    expect(workspaceRecord).not.toHaveBeenCalled()
  })

  it('T2.5: ensureActive 失败 → record 未被调', async () => {
    const { MessageDispatcher } = await import('../src/services/session/message-dispatcher.js')
    const workspaceRecord = vi.fn()
    const workspaceService = { record: workspaceRecord, list: vi.fn().mockReturnValue([]) }
    const svc = {
      ensureActive: vi.fn().mockRejectedValue(new Error('restore failed')),
      getSessionByClient: vi.fn(),
      // 同 T2.2：受理面新增的 svc 依赖，mock 补齐（行为断言在 dispatcher 专项测试文件）
      clearSessionOutcome: vi.fn(),
    }
    // getClient → undefined：无附着 client 形态（sendPrompt 入口 touch 的空检查分支）
    const pm = { getClient: vi.fn(() => undefined) }
    // wave:perf-w09（D1-2）：dispatcher 4 参（svc/pm/workspace/bus），broker 依赖已删
    const bus = { publish: vi.fn() } as unknown as ConstructorParameters<typeof MessageDispatcher>[3]
    const registry = wireDeliveryKernel({ getSession: () => undefined, ensureActive: svc.ensureActive, record: workspaceRecord, bus })
    const dispatcher = new MessageDispatcher(
      svc as unknown as ConstructorParameters<typeof MessageDispatcher>[0],
      pm as unknown as ConstructorParameters<typeof MessageDispatcher>[1],
      workspaceService as unknown as ConstructorParameters<typeof MessageDispatcher>[2],
      bus,
    )
    dispatcher.setDeliveryRegistry(registry)

    // [u2 受理口径 D9⑤] ensureActive 失败不再同步 reject：消息已受理入内核，
    // 失败经 message.error 广播可见（投递终态失败路径），record（三副作用）不执行
    const result = await dispatcher.sendMessage('s1', 'hello')
    await flushDelivery(30)
    expect(result.blocked).toBe(false)
    expect(workspaceRecord).not.toHaveBeenCalled()
    const types = (bus as unknown as { publish: { mock: { calls: unknown[][] } } }).publish.mock.calls
      .map((c) => (c[1] as { type: string }).type)
    expect(types).toContain('message.error')
  })
})
});
});
