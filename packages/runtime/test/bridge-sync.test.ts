import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'

/**
 * 动态装配真实的 EventAdapter + EventInterpreter（绕过本文件顶部的 vi.mock(event-adapter.js)）。
 * 返回的 adapter 与生产装配等价：translate 纯翻译 → interpreter 业务编排。
 */
async function buildRealAdapter(
  sessionId: string,
  send: (msg: unknown) => void,
  options: Record<string, unknown>,
): Promise<{ attach(c: unknown): void; detach(): void }> {
  const [{ EventAdapter }, { EventInterpreter }] = await Promise.all([
    vi.importActual<typeof import('../src/infra/pi/event-adapter.js')>('../src/infra/pi/event-adapter.js'),
    vi.importActual<typeof import('../src/services/session/event-interpreter.js')>('../src/services/session/event-interpreter.js'),
  ])
  const interpreter = new EventInterpreter(sessionId, { send: send as never, ...options } as never)
  return new EventAdapter(sessionId, (events) => interpreter.interpret(events))
}

// IGitInfoReader 桩：SessionService 被 vi.mock 整体替换（构造参数不被使用），仅满足构造签名。
const noopGitInfoReader: IGitInfoReader = { readGitInfo: () => undefined, pruneStaleCache: () => {} }

/**
 * Bridge extension message format tests.
 *
 * Test strategy:
 * - Server bridge routing: test handleBridgeRequest directly with mock IPiEngine
 *   （回包断言按新契约：JSON.stringify + 'select'，设计 bridge-rewrite-pi-0.84 §3.3-D1）
 * - Bridge 请求不排前端超时 + addBridgeRequest 登记（registerTimeout 误传 bridge: 的
 *   防回归锁在 extension-timeout-manager.test.ts）
 *
 * [HISTORICAL] 旧通道的「EventAdapter 对 method='bridge:*' 前缀帧的直接识别」用例已删除
 * （原 'detects bridge: prefix' / 'routes multiple bridge methods'）：该翻译分支随旧通道
 * 清理删除（设计 §3.3-D6），新通道 method 恒为 'select' 经 BRIDGE_MARKER 识别，marker
 * 识别行为由 test/bridge-marker-channel.test.ts 覆盖。
 */

import {
  createMockSessionServiceClass,
  createMockConfigServiceClass,
  createMockModelServiceClass,
  createMockProcessManagerClass,
  createMockEventAdapterClass,
  createMockSkillScannerModule,
  createMockAgentScannerModule,
  mockPiProviderStoreModule,
  mockSessionFileUtilsModule,
  mockPiPathsModule,
  createMockTrashModule,
} from './helpers/service-mocks.js'

// ── Mocks ────────────────────────────────────────────────────────

const mockSendExtensionUiResponse = vi.fn()
const mockSendRaw = vi.fn()

// getRpcClient 返回的 mock client 引用了文件级 mockSendExtensionUiResponse / mockSendRaw
// （测试需断言），因此 getRpcClientImpl 在文件内定义、传给工厂。
function getRpcClientImpl() {
  return {
    sendExtensionUiResponse: mockSendExtensionUiResponse,
    sendRaw: mockSendRaw,
    onEvent: vi.fn().mockReturnValue(() => {}),
    onExit: vi.fn(),
    exited: false,
    kill: vi.fn(),
    start: vi.fn(),
  }
}

vi.mock('../src/services/session/session-service.js', () => ({
  SessionService: createMockSessionServiceClass({
    sessionId: 'bridge-test-session',
    getRpcClientImpl,
  }),
}))

vi.mock('../src/services/config-service.js', () => ({
  ConfigService: createMockConfigServiceClass(),
}))

vi.mock('../src/services/model-service.js', () => ({
  ModelService: createMockModelServiceClass(),
}))

vi.mock('../src/services/plugin-service/plugin-service.js', () => ({
  PluginService: class MockPluginService {
    getDiscoveredPlugins = vi.fn().mockReturnValue([])
    togglePlugin = vi.fn().mockResolvedValue([])
    initialize = vi.fn().mockResolvedValue(undefined)
    shutdown = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('../src/infra/pi/process-manager.js', () => ({
  ProcessManager: createMockProcessManagerClass(),
}))

vi.mock('../src/infra/pi/event-adapter.js', () => ({
  EventAdapter: createMockEventAdapterClass(),
}))

vi.mock('../src/services/scanners/skill-scanner.js', () => createMockSkillScannerModule())
vi.mock('../src/services/scanners/agent-scanner.js', () => createMockAgentScannerModule())

// pi-config-bridge 已拆分：model/settings → pi-provider-store，session 扫描 → session-file-utils，
// 路径 → pi-paths。按实际 import 来源 mock 各符号（其余实现保留原模块）。
// 注意：vi.mock 第二参数必须是内联箭头（不能直接传导入的函数引用或其调用结果——
// hoist 时 imports 尚未初始化会触发 TDZ）。箭头 body 在模块首次 import 时执行，此时安全。
vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) =>
  mockPiProviderStoreModule(await importOriginal<Record<string, unknown>>()),
)
vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) =>
  mockSessionFileUtilsModule(await importOriginal<Record<string, unknown>>()),
)
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) =>
  mockPiPathsModule(await importOriginal<Record<string, unknown>>()),
)

vi.mock('../src/services/extension-service.js', () => {
  return {
    ExtensionService: class MockExtensionService {
      scanExtensions = vi.fn().mockResolvedValue([])
      getEnabledExtensions = vi.fn().mockResolvedValue([])
      toggleExtension = vi.fn().mockResolvedValue(undefined)
      getExtensionPaths = vi.fn().mockResolvedValue([])
    },
  }
})

vi.mock('../src/infra/system/trash.js', () => createMockTrashModule())

import { RuntimeServer } from '../src/transport/server.js'
import { SessionService } from '../src/services/session/session-service.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'

// ── EventAdapter unit tests (using vi.importActual to bypass mock) ──

// Helper to create a mock client compatible with EventAdapter.attach
function makeMockClient() {
  return {
    onEvent: vi.fn((listener: (event: Record<string, unknown>) => void) => {
      // store the listener for test invocation
      return () => {}
    }),
  }
}

function attachAndEmit(adapter: any, mockClient: { onEvent: ReturnType<typeof vi.fn> }, event: Record<string, unknown>): void {
  mockClient.onEvent.mockImplementationOnce((listener: (event: Record<string, unknown>) => void) => {
    listener(event)
    return () => {}
  })
  adapter.attach(mockClient as never)
}

describe('EventAdapter: bridge method detection', () => {
  // [HISTORICAL] 'detects bridge: prefix in extension_ui_request' 与
  // 'routes multiple bridge methods without frontend timeout registration' 两用例已删除：
  // 断言的旧通道翻译分支（method.startsWith('bridge:') 直接产 bridge-ui kind）已随
  // bridge 重写清理（设计 §3.3-D6）——新通道 marker 识别行为见 bridge-marker-channel.test.ts。

  it('does not interfere with non-bridge extension_ui_request methods', async () => {
    const extensionCallback = vi.fn()
    const bridgeCallback = vi.fn()
    const wsSender = vi.fn()
    const adapter = await buildRealAdapter('test-session', wsSender, {
      onExtensionUIRequest: extensionCallback,
      onBridgeUIRequest: bridgeCallback,
    })

    const event = {
      type: 'extension_ui_request' as const,
      method: 'confirm',
      id: 'confirm-req-1',
      title: 'Test confirm',
      message: 'Are you sure?',
    }

    const mockClient = makeMockClient()
    attachAndEmit(adapter, mockClient, event)
    await new Promise((r) => setTimeout(r, 50))

    expect(bridgeCallback).not.toHaveBeenCalled()
    expect(extensionCallback).toHaveBeenCalledTimes(1)
  })
})

// ── Server bridge routing tests ──────────────────────────────────

/**
 * 解析 bridge-handler 回包（新契约，设计 bridge-rewrite-pi-0.84 §3.3-D1）：
 * sendExtensionUiResponse(id, JSON.stringify(<对象>), 'select')——rpc-client 对 select
 * 走 `String(response)` value 分支，调用方必须传 JSON 字符串（传对象会变 '[object Object]'）。
 */
function parseBridgeResponse(call: unknown[]): Record<string, unknown> {
  const [, response, method] = call as [string, string, string | undefined]
  expect(method).toBe('select')
  expect(typeof response).toBe('string')
  return JSON.parse(response) as Record<string, unknown>
}

describe('RuntimeServer: bridge request routing', () => {
  let server: RuntimeServer

  beforeEach(() => {
    vi.useFakeTimers()
    mockSendExtensionUiResponse.mockClear()
    mockSendRaw.mockClear()
    server = new RuntimeServer(0, '/tmp/test-project')
    const sessionService = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, noopGitInfoReader, {} as never)
    const pluginService = new PluginService({} as never, server)
    server.setServices(
      sessionService,
      {} as never,
      {} as never,
      { extension: {} as never, plugin: pluginService },
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('bridge:sync', () => {
    it('sends tools and commands response via extension_ui_response', async () => {
      await server.handleBridgeRequest('sess-1', 'bridge-req-1', 'bridge:sync', {})

      // 新契约：回包是 JSON 字符串 + 'select'（bridge-handler stringify 序列化）
      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)
      expect(mockSendExtensionUiResponse.mock.calls[0][0]).toBe('bridge-req-1')
      const response = parseBridgeResponse(mockSendExtensionUiResponse.mock.calls[0])
      expect(response).toEqual(expect.objectContaining({
        tools: expect.any(Array),
        commands: expect.any(Array),
        success: true,
      }))
    })

    // [2026-09 测试舰队审查 r2-13] 'aggregates tools from plugin contributions' 用例已删：
    // 聚合点已迁移（tools 经 getBridgeSyncPayload），该用例名不副实地断言恒空数组，
    // 空回包容器形状由上一用例的 tools/commands Array 断言覆盖。
  })

  describe('bridge:tool_execute', () => {
    it('sends tool execution response', async () => {
      await server.handleBridgeRequest('sess-1', 'bridge-req-exec', 'bridge:tool_execute', {
        toolName: 'hello',
        params: { name: 'world' },
      })

      // 新契约：JSON 字符串 + 'select'（bridge-handler stringify 序列化）
      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)
      const response = parseBridgeResponse(mockSendExtensionUiResponse.mock.calls[0])
      expect(response).toEqual(expect.objectContaining({
        content: expect.any(String),
        isError: expect.any(Boolean),
      }))
    })
  })

  describe('bridge:event', () => {
    it('sends null response for fire-and-forget events', async () => {
      await server.handleBridgeRequest('sess-1', 'bridge-req-ev', 'bridge:event', {
        eventName: 'agent_start',
        eventData: { sessionId: 'sess-1' },
      })

      expect(mockSendExtensionUiResponse).toHaveBeenCalledWith('bridge-req-ev', null)
    })
  })

  describe('bridge:intercept', () => {
    it('sends empty response for interception', async () => {
      await server.handleBridgeRequest('sess-1', 'bridge-req-int', 'bridge:intercept', {
        eventName: 'before_agent_start',
        data: { sessionId: 'sess-1', query: 'hello' },
      })

      // 新契约：JSON 字符串 + 'select'（PluginService mock 无 handleBridgeIntercept → {} 回包）
      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)
      const response = parseBridgeResponse(mockSendExtensionUiResponse.mock.calls[0])
      expect(response).toEqual({})
    })
  })

  describe('unknown bridge method', () => {
    it('sends error response for unknown method', async () => {
      await server.handleBridgeRequest('sess-1', 'bridge-req-unk', 'bridge:unknown_method', {})

      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)
      const response = parseBridgeResponse(mockSendExtensionUiResponse.mock.calls[0])
      expect(response.error).toEqual(expect.stringContaining('Unknown bridge method'))
    })
  })
})

// ── Extension timeout: bridge message exclusion ──────────────────

describe('RuntimeServer: bridge timeout exclusion', () => {
  let server: RuntimeServer

  beforeEach(() => {
    vi.useFakeTimers()
    mockSendExtensionUiResponse.mockClear()
    server = new RuntimeServer(0, '/tmp/test-project')
    const ss = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, noopGitInfoReader, {} as never)
    // 超时路径调 getRpcClient → client.sendExtensionUiResponse；mock 返回假 client。
    vi.spyOn(ss, 'getRpcClient').mockReturnValue({ sendExtensionUiResponse: mockSendExtensionUiResponse } as never)
    server.setServices(
      ss,
      {} as never,
      {} as never,
      { extension: {} as never, plugin: {} as never },
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does NOT register frontend timeout for bridge: methods', async () => {
    // 生产链路形态（marker 通道）：请求经 handleBridgeRequest → BridgeHandler 入口
    // addBridgeRequest 登记（旧 registerTimeout 的 bridge: 前缀分支已删）
    await server.handleBridgeRequest('sess-1', 'req-bridge-sync', 'bridge:sync', {})
    await server.handleBridgeRequest('sess-1', 'req-bridge-exec', 'bridge:tool_execute', {})
    await server.handleBridgeRequest('sess-1', 'req-bridge-ev', 'bridge:event', {})
    await server.handleBridgeRequest('sess-1', 'req-bridge-int', 'bridge:intercept', {})
    mockSendExtensionUiResponse.mockClear() // 正常回包已发生，只观察超时窗口

    // Advance time past the normal timeout duration
    vi.advanceTimersByTime(300_000)

    // 超时窗口内零新增调用：bridge 请求无前端弹窗超时（等待终态由跨进程链路保证）
    expect(mockSendExtensionUiResponse).not.toHaveBeenCalled()
  })

  it('tracks bridge requestIds in bridgeRequestIds set', async () => {
    // B6 应答即删（memory-leak-remediation §3.2-B6）：登记事实经 spy 锁定，完成后不残留
    const mgr = (server as unknown as {
      extensionTimeoutMgr: {
        isBridgeRequest(id: string): boolean
        addBridgeRequest(sessionId: string, requestId: string): void
      }
    }).extensionTimeoutMgr
    const addSpy = vi.spyOn(mgr, 'addBridgeRequest')
    await server.handleBridgeRequest('sess-1', 'req-bridge-track', 'bridge:sync', {})

    expect(addSpy).toHaveBeenCalledWith('sess-1', 'req-bridge-track')
    expect(mgr.isBridgeRequest('req-bridge-track')).toBe(false)
  })

  // [2026-07-16] extension UI 超时已取消（confirm/select/input 等统一不超时）。
  // 原「still registers normal timeout for non-bridge methods」断言 confirm 超时触发
  // sendExtensionUiResponse，行为已移除，测试删除。
})

// [2026-09 测试舰队审查 r2-13] 'Bridge extension message format' describe（8 例）已删：
// 全部为「构造字面对象 → 断言自身属性」恒真断言，零 SUT 交互；bridge 请求/回包真实形状
// 由上方 handleBridgeRequest 路由用例（parseBridgeResponse 断言）覆盖。
