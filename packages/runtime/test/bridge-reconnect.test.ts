/**
 * Bridge Reconnect Tests.
 *
 * Tests the bridge connection lifecycle between pi (extension) and runtime.
 * The bridge is the pi RPC connection through which plugin bridge requests
 * (select + BRIDGE_MARKER 通道，协议 v2) are routed——请求的 method 字段沿用
 * 'bridge:sync' 等值，分派逻辑不变；回包契约 = JSON.stringify + 'select'（设计
 * bridge-rewrite-pi-0.84 §3.3-D1）。
 *
 * Test strategy:
 * - Mock SessionService.getRpcClient to simulate connected/disconnected states
 * - Mock PluginService.getBridgeSyncPayload/handleBridgeToolExecute/handleBridgeIntercept
 * - Test handleBridgeRequest under various reconnection scenarios
 * - Bridge 请求不排前端超时 + addBridgeRequest 登记（registerTimeout 误传 bridge: 的
 *   防回归锁在 extension-timeout-manager.test.ts）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

/** Mock RPC client that can be set to null to simulate disconnect */
let mockRpcClient: ReturnType<typeof createMockRpcClient> | null = createMockRpcClient()

function createMockRpcClient() {
  return {
    sendExtensionUiResponse: mockSendExtensionUiResponse,
    onEvent: vi.fn().mockReturnValue(() => {}),
    onExit: vi.fn(),
    exited: false,
    kill: vi.fn(),
    start: vi.fn(),
  }
}

// getRpcClient 在测试中会被重新赋值 mockRpcClient（模拟断连），因此用闭包动态读取当前值。
function getRpcClientImpl() {
  return mockRpcClient
}

const mockGetToolSchemas = vi.fn()
const mockGetBridgeSyncPayload = vi.fn()
const mockHandleBridgeToolExecute = vi.fn()
const mockHandleBridgeIntercept = vi.fn()

vi.mock('../src/services/session/session-service.js', () => ({
  SessionService: createMockSessionServiceClass({
    sessionId: 'reconnect-test-session',
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
    getToolSchemas = mockGetToolSchemas
    getBridgeSyncPayload = mockGetBridgeSyncPayload
    handleBridgeToolExecute = mockHandleBridgeToolExecute
    handleBridgeIntercept = mockHandleBridgeIntercept
  }
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
import type { IGitInfoReader } from '../src/services/ports/git-info.js'

// IGitInfoReader 桩：这些测试不验证 git 摘要字段，SessionService 经 vi.mock 替换或仅做桩，构造参数不被使用。
const noopGitInfoReader: IGitInfoReader = { readGitInfo: () => undefined, pruneStaleCache: () => {} }

const SESSION_ID = 'reconnect-session'
const RUNTIME_RESTART_TOOLS = [
  { name: 'hello', description: 'Says hello', parameters: { type: 'object', properties: {} } },
]
const NEW_TOOLS_AFTER_RESTART = [
  { name: 'hello', description: 'Says hello', parameters: { type: 'object', properties: {} } },
  { name: 'goodbye', description: 'Says goodbye', parameters: { type: 'object', properties: {} } },
]

/** 构造 getBridgeSyncPayload() 返回值（handler 现在调 getBridgeSyncPayload 而非 getToolSchemas）。 */
function syncPayload(tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = []) {
  return { tools, commands: [], success: true as const }
}

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

// ── Tests ────────────────────────────────────────────────────────

describe('Bridge reconnect lifecycle', () => {
  let server: RuntimeServer

  beforeEach(() => {
    vi.useFakeTimers()
    mockSendExtensionUiResponse.mockClear()
    mockGetToolSchemas.mockClear()
    mockGetBridgeSyncPayload.mockClear()
    mockHandleBridgeToolExecute.mockClear()
    mockHandleBridgeIntercept.mockClear()
    mockRpcClient = createMockRpcClient()
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

  // ── Scenario 1: Disconnected → Syncing → Ready ────────────────

  describe('Disconnected → Syncing → Ready', () => {
    it('fails silently when RPC client is unavailable (disconnected)', async () => {
      mockRpcClient = null

      await server.handleBridgeRequest(SESSION_ID, 'req-1', 'bridge:sync', {})

      // No sendCommand should be called since there's no RPC client
      expect(mockSendExtensionUiResponse).not.toHaveBeenCalled()
    })

    it('succeeds when RPC client becomes available (reconnected)', async () => {
      mockRpcClient = createMockRpcClient()
      mockGetBridgeSyncPayload.mockReturnValue(syncPayload(RUNTIME_RESTART_TOOLS))
      mockSendExtensionUiResponse.mockClear()

      await server.handleBridgeRequest(SESSION_ID, 'req-2', 'bridge:sync', {})

      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)
      expect(mockSendExtensionUiResponse.mock.calls[0][0]).toBe('req-2')
      const response = parseBridgeResponse(mockSendExtensionUiResponse.mock.calls[0])
      expect(response).toMatchObject({
        success: true,
        tools: RUNTIME_RESTART_TOOLS,
      })
    })

    it('complete lifecycle: disconnected → syncing → ready with tools', async () => {
      // Phase 1: Disconnected — bridge sync fails silently
      mockRpcClient = null
      await server.handleBridgeRequest(SESSION_ID, 'req-p1', 'bridge:sync', {})
      expect(mockSendExtensionUiResponse).not.toHaveBeenCalled()

      // Phase 2: RPC client appears, bridge sync starts
      mockRpcClient = createMockRpcClient()
      mockGetBridgeSyncPayload.mockReturnValue(syncPayload([
        { name: 'goal_manager', description: 'Manages goals', parameters: { type: 'object', properties: {} } },
      ]))
      mockSendExtensionUiResponse.mockClear()

      await server.handleBridgeRequest(SESSION_ID, 'req-p2', 'bridge:sync', {})
      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)

      const response = parseBridgeResponse(mockSendExtensionUiResponse.mock.calls[0])
      expect(response.success).toBe(true)
      const tools = response.tools as Array<{ name: string }>
      expect(tools).toHaveLength(1)
      expect(tools[0].name).toBe('goal_manager')
    })
  })

  // ── Scenario 2: Runtime restart → auto-reconnect ─────────────

  describe('Runtime restart → auto-reconnect', () => {
    it('re-registers tools after runtime restart via bridge:sync', async () => {
      // Initial registration
      mockGetBridgeSyncPayload.mockReturnValue(syncPayload(RUNTIME_RESTART_TOOLS))
      await server.handleBridgeRequest(SESSION_ID, 'req-init', 'bridge:sync', {})
      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)

      // Simulate runtime restart: clear tool schemas, then re-register
      mockGetBridgeSyncPayload.mockReturnValue(syncPayload(NEW_TOOLS_AFTER_RESTART))
      mockSendExtensionUiResponse.mockClear()

      await server.handleBridgeRequest(SESSION_ID, 'req-restart', 'bridge:sync', {})

      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)
      const response = parseBridgeResponse(mockSendExtensionUiResponse.mock.calls[0])
      const tools = response.tools as Array<{ name: string }>
      expect(tools).toHaveLength(2)
      expect(tools[0].name).toBe('hello')
      expect(tools[1].name).toBe('goodbye')
    })

    it('sends empty tool list when no plugins are active after restart', async () => {
      mockGetBridgeSyncPayload.mockReturnValue(syncPayload([]))

      await server.handleBridgeRequest(SESSION_ID, 'req-empty', 'bridge:sync', {})

      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)
      const response = parseBridgeResponse(mockSendExtensionUiResponse.mock.calls[0])
      expect(response.tools).toHaveLength(0)
      expect(response.commands).toHaveLength(0)
      expect(response.success).toBe(true)
    })
  })

  // ── Scenario 3: Sync timeout handling ─────────────────────────

  describe('Sync timeout (bridge timeout exclusion)', () => {
    it('does NOT register frontend timeout for bridge:sync', async () => {
      // 生产链路形态（marker 通道）：请求经 handleBridgeRequest → BridgeHandler 入口
      // addBridgeRequest 登记（旧 registerTimeout 的 bridge: 前缀分支已删）
      await server.handleBridgeRequest(SESSION_ID, 'req-bridge-sync', 'bridge:sync', {})
      mockSendExtensionUiResponse.mockClear() // 正常回包已发生，只观察超时窗口

      vi.advanceTimersByTime(300_000)

      // 超时窗口内零新增调用：bridge 请求无前端弹窗超时
      expect(mockSendExtensionUiResponse).not.toHaveBeenCalled()
    })

    it('tracks bridge request IDs for session cleanup', async () => {
      // 到达即登记（B6 语义：应答完成后即删，登记事实经 spy 锁定）
      const mgr = (server as unknown as {
        extensionTimeoutMgr: {
          isBridgeRequest(id: string): boolean
          addBridgeRequest(sessionId: string, requestId: string): void
        }
      }).extensionTimeoutMgr
      const addSpy = vi.spyOn(mgr, 'addBridgeRequest')
      await server.handleBridgeRequest(SESSION_ID, 'req-bridge', 'bridge:sync', {})
      await server.handleBridgeRequest(SESSION_ID, 'req-bridge2', 'bridge:tool_execute', {})

      expect(addSpy).toHaveBeenCalledWith(SESSION_ID, 'req-bridge')
      expect(addSpy).toHaveBeenCalledWith(SESSION_ID, 'req-bridge2')
      // B6 应答即删：完成后不残留（bridgeRequestIds 有界）
      expect(mgr.isBridgeRequest('req-bridge')).toBe(false)
      expect(mgr.isBridgeRequest('req-bridge2')).toBe(false)
    })
  })

  // ── Scenario 4: Tool execute during reconnect ─────────────────

  describe('Bridge tool execute during reconnect', () => {
    it('returns error when no tools registered (during reconnect)', async () => {
      mockHandleBridgeToolExecute.mockResolvedValue({
        content: 'Tool not found: unknown_tool',
        isError: true,
      })

      await server.handleBridgeRequest(SESSION_ID, 'req-exec', 'bridge:tool_execute', {
        toolName: 'unknown_tool',
        params: {},
        toolCallId: 'tc-1',
      })

      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)
      const response = parseBridgeResponse(mockSendExtensionUiResponse.mock.calls[0])
      expect(response.isError).toBe(true)
      expect(response.content).toContain('Tool not found')
    })

    it('executes tool when bridge is ready', async () => {
      mockHandleBridgeToolExecute.mockResolvedValue({
        content: JSON.stringify({ result: 'hello world' }),
        isError: false,
      })

      await server.handleBridgeRequest(SESSION_ID, 'req-exec2', 'bridge:tool_execute', {
        toolName: 'hello',
        params: { name: 'world' },
        toolCallId: 'tc-2',
      })

      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)
      const response = parseBridgeResponse(mockSendExtensionUiResponse.mock.calls[0])
      expect(response.isError).toBeFalsy()
      expect(response.content).toBe(JSON.stringify({ result: 'hello world' }))
    })

    it('returns error when plugin service is not available', async () => {
      const serverWithoutPlugin = new RuntimeServer(0, '/tmp/test-project')
      const sessionService = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, noopGitInfoReader, {} as never)
      // No plugin service set
      serverWithoutPlugin.setServices(sessionService, {} as never, {} as never, { extension: {} as never, plugin: {} as never })

      await serverWithoutPlugin.handleBridgeRequest(SESSION_ID, 'req-exec3', 'bridge:tool_execute', {
        toolName: 'hello',
        params: {},
      })

      // 新契约：not-available 分支回 JSON 字符串 + 'select'
      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)
      expect(mockSendExtensionUiResponse.mock.calls[0][0]).toBe('req-exec3')
      expect(parseBridgeResponse(mockSendExtensionUiResponse.mock.calls[0])).toEqual({
        content: 'Plugin system not available',
        isError: true,
      })
    })
  })

  // ── Scenario 5: Event during reconnect ─────────────────────────

  describe('Bridge event during reconnect', () => {
    it('sends null response for fire-and-forget events even during reconnect', async () => {
      // bridge:event always sends null response regardless of state
      await server.handleBridgeRequest(SESSION_ID, 'req-ev', 'bridge:event', {
        eventName: 'agent_start',
        eventData: { sessionId: SESSION_ID },
      })

      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)
      expect(mockSendExtensionUiResponse).toHaveBeenCalledWith('req-ev', null)
    })

    it('handles multiple events in sequence during reconnect', async () => {
      // Simulate events being fired during reconnection
      for (let i = 0; i < 3; i++) {
        await server.handleBridgeRequest(SESSION_ID, `req-ev-${i}`, 'bridge:event', {
          eventName: 'agent_step',
          eventData: { sessionId: SESSION_ID, step: i },
        })
      }

      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(3)
      for (let i = 0; i < 3; i++) {
        expect(mockSendExtensionUiResponse).toHaveBeenNthCalledWith(i + 1, `req-ev-${i}`, null)
      }
    })
  })

  // ── Scenario 6: Bridge reconnect after pi crash ───────────────

  describe('Bridge reconnect after pi crash', () => {
    it('pi crash: bridge request returns nothing when client gone', async () => {
      mockRpcClient = null

      await server.handleBridgeRequest(SESSION_ID, 'req-crash', 'bridge:sync', {})

      expect(mockSendExtensionUiResponse).not.toHaveBeenCalled()
    })

    it('pi restart: new RPC client re-syncs tools', async () => {
      mockRpcClient = createMockRpcClient()
      mockGetBridgeSyncPayload.mockReturnValue(syncPayload(RUNTIME_RESTART_TOOLS))
      mockSendExtensionUiResponse.mockClear()

      await server.handleBridgeRequest(SESSION_ID, 'req-restore', 'bridge:sync', {})

      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)
      const response = parseBridgeResponse(mockSendExtensionUiResponse.mock.calls[0])
      expect(response.success).toBe(true)
      expect(response.tools).toHaveLength(1)
    })

    it('pi crash + restart: full lifecycle with tool execute after restart', async () => {
      // 1. pi is running, tools synced
      mockGetBridgeSyncPayload.mockReturnValue(syncPayload(RUNTIME_RESTART_TOOLS))
      await server.handleBridgeRequest(SESSION_ID, 'req-s1', 'bridge:sync', {})
      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)

      // 2. pi crashes — RPC client disappears
      mockRpcClient = null

      // 3. Bridge request during crash — silent failure
      mockSendExtensionUiResponse.mockClear()
      await server.handleBridgeRequest(SESSION_ID, 'req-s2', 'bridge:sync', {})
      expect(mockSendExtensionUiResponse).not.toHaveBeenCalled()

      // 4. Tool execute during crash — silent failure
      await server.handleBridgeRequest(SESSION_ID, 'req-s3', 'bridge:tool_execute', {
        toolName: 'hello',
        params: {},
      })
      expect(mockSendExtensionUiResponse).not.toHaveBeenCalled()

      // 5. pi restarts — new RPC client
      mockRpcClient = createMockRpcClient()

      // 6. Tools re-synced
      mockSendExtensionUiResponse.mockClear()
      await server.handleBridgeRequest(SESSION_ID, 'req-s4', 'bridge:sync', {})
      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)
      expect(parseBridgeResponse(mockSendExtensionUiResponse.mock.calls[0]).success).toBe(true)

      // 7. Tool execute works again
      mockHandleBridgeToolExecute.mockResolvedValue({
        content: JSON.stringify({ result: 'post-restart' }),
        isError: false,
      })
      mockSendExtensionUiResponse.mockClear()
      await server.handleBridgeRequest(SESSION_ID, 'req-s5', 'bridge:tool_execute', {
        toolName: 'hello',
        params: {},
        toolCallId: 'tc-restart',
      })
      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)
      expect(parseBridgeResponse(mockSendExtensionUiResponse.mock.calls[0]).content).toContain('post-restart')
    })
  })

  // ── Bridge intercept during reconnect ─────────────────────────

  describe('Bridge intercept during reconnect', () => {
    it('handles bridge:intercept when plugin service is available', async () => {
      mockHandleBridgeIntercept.mockResolvedValue({ injectedMessages: [] })

      await server.handleBridgeRequest(SESSION_ID, 'req-int', 'bridge:intercept', {
        eventName: 'before_agent_start',
        data: { sessionId: SESSION_ID, query: 'hello' },
      })

      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)
      expect(mockSendExtensionUiResponse.mock.calls[0][0]).toBe('req-int')
      expect(parseBridgeResponse(mockSendExtensionUiResponse.mock.calls[0])).toEqual({ injectedMessages: [] })
    })

    it('returns empty intercept when plugin service is not available', async () => {
      const serverWithoutPlugin = new RuntimeServer(0, '/tmp/test-project')
      const sessionService = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, noopGitInfoReader, {} as never)
      serverWithoutPlugin.setServices(sessionService, {} as never, {} as never, { extension: {} as never, plugin: {} as never })

      mockSendExtensionUiResponse.mockClear()
      await serverWithoutPlugin.handleBridgeRequest(SESSION_ID, 'req-int2', 'bridge:intercept', {
        eventName: 'before_agent_start',
        data: { sessionId: SESSION_ID },
      })

      // 新契约：无 pluginService → {} 回包为 JSON 字符串 + 'select'
      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)
      expect(mockSendExtensionUiResponse.mock.calls[0][0]).toBe('req-int2')
      expect(parseBridgeResponse(mockSendExtensionUiResponse.mock.calls[0])).toEqual({})
    })
  })

  // ── Unknown bridge method ──────────────────────────────────────

  describe('Unknown bridge method', () => {
    it('returns error for unknown bridge method', async () => {
      await server.handleBridgeRequest(SESSION_ID, 'req-unk', 'bridge:unknown', {})

      expect(mockSendExtensionUiResponse).toHaveBeenCalledTimes(1)
      const response = parseBridgeResponse(mockSendExtensionUiResponse.mock.calls[0])
      expect(response.error).toEqual(expect.stringContaining('Unknown bridge method'))
    })
  })
})
