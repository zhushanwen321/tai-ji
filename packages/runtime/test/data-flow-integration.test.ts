/**
 * Data Flow Integration Tests
 *
 * 跨模块集成测试：验证 5 条 data flow 的完整调用链。
 * 模块间（EventAdapter, Server, ExtensionService）使用真实实例，
 * 只 mock 最外层边界（pi RpcClient、WS 连接）。
 *
 * 覆盖:
 * - DF-1: Extension UI 请求-响应 (confirm/select/cancel/timeout/session-cleanup)
 * - DF-2: Extension 错误转发
 * - DF-3: 工具进度更新
 * - DF-4: Extension 列表管理
 * - DF-5: Extension 启用/禁用
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'

import type { ServerMessage } from '@taiji/shared'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'
import {
  createMockSessionServiceClass,
  createMockConfigServiceClass,
  createMockModelServiceClass,
  createMockProcessManagerClass,
  createMockSkillScannerModule,
  createMockAgentScannerModule,
  mockPiProviderStoreModule,
  mockSessionFileUtilsModule,
  mockPiPathsModule,
  createMockTrashModule,
} from './helpers/service-mocks.js'

// IGitInfoReader 桩：这些集成测试 mock 了整个 SessionService（构造参数不被使用），
// 仅需满足构造签名（port 化后第 10 个参数）。
const noopGitInfoReader: IGitInfoReader = { readGitInfo: () => undefined, pruneStaleCache: () => {} }

// ── Mocks (最外层边界) ────────────────────────────────────────────

const mockSendCommand = vi.fn().mockResolvedValue({ success: true })
const mockSendExtensionUiResponse = vi.fn()
const mockSendRaw = vi.fn()

// getRpcClient 返回的 mock client 引用了文件级 mockSendCommand / mockSendExtensionUiResponse /
// mockSendRaw（测试需断言），因此 getRpcClientImpl 在文件内定义、传给工厂。
function getRpcClientImpl() {
  return {
    sendCommand: mockSendCommand,
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
  SessionService: createMockSessionServiceClass({ getRpcClientImpl }),
}))

vi.mock('../src/services/config-service.js', () => ({
  ConfigService: createMockConfigServiceClass(),
}))

vi.mock('../src/services/model-service.js', () => ({
  ModelService: createMockModelServiceClass(),
}))

vi.mock('../src/infra/pi/process-manager.js', () => ({
  ProcessManager: createMockProcessManagerClass(),
}))

// EventAdapter 使用真实实例 — 不 mock

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

vi.mock('../src/infra/system/trash.js', () => createMockTrashModule())

// ── Imports (mock 之后) ───────────────────────────────────────────

import { RuntimeServer } from '../src/transport/server.js'
import { EventAdapter } from '../src/infra/pi/event-adapter.js'
import { createEventAdapter } from './helpers/event-adapter-test-fixture.js'
import { startOnFreePort } from './helpers/free-port.js'
import { SessionService } from '../src/services/session/session-service.js'
import { ConfigService } from '../src/services/config-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { ModelApiDiscoverer } from '../src/infra/model-api-discoverer.js'
import { ModelService } from '../src/services/model-service.js'

// ── Helpers ────────────────────────────────────────────────────────

function waitForMessage(ws: WebSocket, type: string, timeout = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error(`Timed out waiting for message type "${type}"`))
    }, timeout)
    const handler = (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === type) {
          clearTimeout(timer)
          ws.off('message', handler)
          resolve(msg)
        }
      } catch { /* skip */ }
    }
    ws.on('message', handler)
  })
}

/** Wait for async handleEvent to flush */
const flushAsync = () => new Promise<void>(r => setTimeout(r, 0))

/** Wait for WS message propagation (real I/O needs a few event loop cycles). */
const waitForWs = () => new Promise<void>(r => setTimeout(r, 50))

/** S1-W1：真实 WS 测试统一 token（ConnectionManager auth 握手，见 ws-listen-hardening.test.ts） */
const TEST_WS_TOKEN = 'test-ws-token-data-flow'

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    ws.on('open', () => {
      // S1-W1：首条消息 auth，等 auth.result ok 后连接才可用
      ws.send(JSON.stringify({ type: 'auth', payload: { token: TEST_WS_TOKEN } }))
    })
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data))
        if (msg.type === 'auth.result' && msg.payload?.ok === true) {
          setTimeout(() => resolve(ws), 100)
        }
      } catch { /* skip */ }
    })
    ws.on('error', reject)
  })
}

/** 创建一个 mock RpcClient，其 onEvent 会注册 listener 并可通过 getEventListener 取出 */
function createMockRpcClient() {
  let eventListener: ((event: Record<string, unknown>) => void) | null = null
  return {
    sendCommand: mockSendCommand,
    sendExtensionUiResponse: mockSendExtensionUiResponse,
    sendRaw: mockSendRaw,
    onEvent: vi.fn().mockImplementation((listener: (event: Record<string, unknown>) => void) => {
      eventListener = listener
      return () => { eventListener = null }
    }),
    getEventListener: () => eventListener,
    onExit: vi.fn(),
    exited: false,
    kill: vi.fn(),
    start: vi.fn(),
  }
}

/** 创建 WS 连接的完整 server fixture (真实 timers) */
interface WSFixture {
  server: RuntimeServer
  sessionService: SessionService
  ws: WebSocket
  port: number
  rpcClient: ReturnType<typeof createMockRpcClient>
  adapterSent: ServerMessage[]
  /** 触发 pi 事件 (EventAdapter → adapterSent 收集) */
  emitPiEvent: (event: Record<string, unknown>) => void
  cleanup: () => Promise<void>
}

async function createWSFixture(extensionService?: object): Promise<WSFixture> {
  // EADDRINUSE 韧性：端口在 RuntimeServer 构造函数绑定，重试需整体重建（startOnFreePort 语义）。
  // sessionService 经 refs 容器从 factory 带出，保证 fixture 返回的引用 = server 实际持有的实例
  //（后续 vi.mocked(sessionService.getRpcClient) mock 的必须是同一个实例）。
  const refs: { svc?: SessionService } = {}
  const started = await startOnFreePort((p) => {
    const server = new RuntimeServer(p, '/tmp/test-project', TEST_WS_TOKEN)
    const svc = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, noopGitInfoReader, {} as never)
    refs.svc = svc
    server.setServices(
      svc,
      new ConfigService('/tmp', new PiConfigStore()),
      new ModelService(new ModelApiDiscoverer()),
      { extension: extensionService as never | undefined },
    )
    return server
  })
  const { instance: server, port } = started
  const sessionService = refs.svc
  if (!sessionService) throw new Error('unreachable: startOnFreePort factory always assigns refs.svc')

  const ws = await connectClient(port)

  const rpcClient = createMockRpcClient()
  vi.mocked(sessionService.getRpcClient).mockReturnValue(rpcClient as never)

  // 真实 EventAdapter + EventInterpreter，send 输出到收集数组
  const adapterSent: ServerMessage[] = []
  const adapter = createEventAdapter('test-session-1', (msg) => adapterSent.push(msg), {
    onExtensionUIRequest: (requestId, sid, method) => {
      server.registerExtensionTimeout(sid, requestId, method, {})
    },
  })

  // attach adapter 到 mock RpcClient
  adapter.attach({
    onEvent: (listener) => {
      rpcClient.onEvent(listener)
      return () => adapter.detach()
    },
  })

  return {
    server,
    sessionService,
    ws,
    port,
    rpcClient,
    adapterSent,
    emitPiEvent: (event: Record<string, unknown>) => {
      const listener = rpcClient.getEventListener()
      if (listener) listener(event)
    },
    cleanup: async () => {
      ws.close()
      await server.stop()
    },
  }
}

// ══════════════════════════════════════════════════════════════════
// DF-1: Extension UI 请求-响应
// ══════════════════════════════════════════════════════════════════

describe('DF-1: Extension UI 请求-响应 (EventAdapter → Server → RpcClient)', () => {
  let fixture: WSFixture

  beforeEach(async () => {
    vi.useRealTimers()
    mockSendCommand.mockClear()
    mockSendRaw.mockClear()
    mockSendExtensionUiResponse.mockClear()
    fixture = await createWSFixture()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  it('confirm 端到端: pi event → adapter translate → onExtensionUIRequest → 前端 response → RpcClient', async () => {
    // 1. pi 发出 extension_ui_request (confirm)
    fixture.emitPiEvent({
      type: 'extension_ui_request',
      method: 'confirm',
      id: 'req-confirm-1',
      title: 'Allow file access?',
      message: 'Extension wants to read /tmp/test.txt',
    })
    await flushAsync()

    // 2. EventAdapter 翻译 + 触发 onExtensionUIRequest
    expect(fixture.adapterSent).toHaveLength(1)
    expect(fixture.adapterSent[0].type).toBe('extension.ui_request')
    expect(fixture.adapterSent[0].payload).toMatchObject({
      sessionId: 'test-session-1',
      requestId: 'req-confirm-1',
      method: 'confirm',
      title: 'Allow file access?',
      message: 'Extension wants to read /tmp/test.txt',
    })

    // 3. 前端通过 WS 发送 extension.ui_response (result=true)
    fixture.ws.send(JSON.stringify({
      type: 'extension.ui_response',
      id: 'resp-1',
      payload: {
        sessionId: 'test-session-1',
        requestId: 'req-confirm-1',
        method: 'confirm',
        result: true,
      },
    }))

    // 4. 验证 server 通过 sendExtensionUiResponse 转发到 pi（confirm+true → {id, confirmed:true}）
    await waitForWs()
    expect(fixture.sessionService.getRpcClient).toHaveBeenCalledWith('test-session-1')
    expect(mockSendExtensionUiResponse).toHaveBeenCalledWith('req-confirm-1', true, 'confirm')
  })

  it('select 端到端: pi event → adapter translate → 前端 response (string)', async () => {
    // 1. pi 发出 extension_ui_request (select)
    // pi select 真实格式：options 是 string[]（不是 {label,value} 对象数组）
    fixture.emitPiEvent({
      type: 'extension_ui_request',
      method: 'select',
      id: 'req-select-1',
      title: 'Pick an option',
      options: ['Option A', 'Option B'],
    })
    await flushAsync()

    // 2. 验证 adapter 翻译 (options 经 .map(String) 透传 string[])
    expect(fixture.adapterSent).toHaveLength(1)
    const payload = fixture.adapterSent[0].payload as Record<string, unknown>
    expect(payload.method).toBe('select')
    expect(payload.options).toEqual(['Option A', 'Option B'])

    // 3. 前端发送 extension.ui_response (result='option1')
    fixture.ws.send(JSON.stringify({
      type: 'extension.ui_response',
      id: 'resp-select-1',
      payload: {
        sessionId: 'test-session-1',
        requestId: 'req-select-1',
        method: 'select',
        result: 'option1',
      },
    }))

    // 4. 验证 server 通过 sendExtensionUiResponse 转发到 pi（select+string → {id, value:'option1'}）
    await waitForWs()
    expect(mockSendExtensionUiResponse).toHaveBeenCalledWith('req-select-1', 'option1', 'select')
  })

  it('cancel 路径: extension.ui_response (result=false) → server 转发 false', async () => {
    // 1. pi 发出 confirm 请求
    fixture.emitPiEvent({
      type: 'extension_ui_request',
      method: 'confirm',
      id: 'req-cancel-1',
      title: 'Allow?',
    })
    await flushAsync()

    expect(fixture.adapterSent).toHaveLength(1)

    // 2. 前端发送 cancel (result=false)
    fixture.ws.send(JSON.stringify({
      type: 'extension.ui_response',
      id: 'resp-cancel-1',
      payload: {
        sessionId: 'test-session-1',
        requestId: 'req-cancel-1',
        method: 'confirm',
        result: false,
      },
    }))

    // 3. 验证 server 通过 sendExtensionUiResponse 转发到 pi（confirm+false → {id, confirmed:false}）
    await waitForWs()
    expect(mockSendExtensionUiResponse).toHaveBeenCalledWith('req-cancel-1', false, 'confirm')
  })

  it('cancel 路径: extension.ui_response (result=null) → server 转发 null', async () => {
    // 1. pi 发出 input 请求
    fixture.emitPiEvent({
      type: 'extension_ui_request',
      method: 'input',
      id: 'req-null-1',
      title: 'Enter value',
    })
    await flushAsync()

    expect(fixture.adapterSent).toHaveLength(1)

    // 2. 前端发送 null
    fixture.ws.send(JSON.stringify({
      type: 'extension.ui_response',
      id: 'resp-null-1',
      payload: {
        sessionId: 'test-session-1',
        requestId: 'req-null-1',
        method: 'input',
        result: null,
      },
    }))

    // 3. 验证 server 通过 sendExtensionUiResponse 转发到 pi（null → {id, cancelled:true}）
    await waitForWs()
    expect(mockSendExtensionUiResponse).toHaveBeenCalledWith('req-null-1', null, 'input')
  })
})

// ── DF-1 超时路径 (fake timers, 不启动 server) ────────────────────

describe('DF-1: Extension UI 超时路径', () => {
  let server: RuntimeServer
  let sessionService: SessionService

  beforeEach(() => {
    vi.useFakeTimers()
    mockSendCommand.mockClear()
    mockSendRaw.mockClear()
    mockSendExtensionUiResponse.mockClear()
    server = new RuntimeServer(0, '/tmp/test-project', TEST_WS_TOKEN)
    sessionService = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, noopGitInfoReader, {} as never)
    server.setServices(
      sessionService,
      new ConfigService('/tmp', new PiConfigStore()),
      new ModelService(new ModelApiDiscoverer()),
    )

    vi.spyOn(sessionService, "getRpcClient").mockReturnValue({
      sendCommand: mockSendCommand,
      sendExtensionUiResponse: mockSendExtensionUiResponse,
      sendRaw: mockSendRaw,
      onEvent: vi.fn().mockReturnValue(() => {}),
      onExit: vi.fn(),
      exited: false,
      kill: vi.fn(),
      start: vi.fn(),
    } as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // [2026-07-16] extension UI 超时已取消（confirm/select/input 等统一不超时）。
  // 原「confirm 超时 → sendExtensionUiResponse」「select 超时 → sendExtensionUiResponse」
  // 2 个用例断言超时触发，行为已移除，测试删除。

  it('超时后 clearExtensionTimeout → 不再触发', () => {
    server.registerExtensionTimeout('sess-1', 'req-clear-timeout', 'confirm', {})
    server.clearExtensionTimeout('req-clear-timeout')

    vi.advanceTimersByTime(300_000)

    expect(mockSendExtensionUiResponse).not.toHaveBeenCalled()
  })

  it('notify 不注册超时 (fire-and-forget)', () => {
    server.registerExtensionTimeout('sess-1', 'req-notify', 'notify', {})

    vi.advanceTimersByTime(300_000)

    expect(mockSendExtensionUiResponse).not.toHaveBeenCalled()
  })
})

// ── DF-1 session 删除清理超时 ─────────────────────────────────────
// [2026-07-16] extension UI 超时已取消，原 describe 的唯一用例断言
// 「clearForSession 后 sess-other 超时仍触发」，超时行为已移除 → 整个 describe 删除。
// clearForSession 的 session 级清理覆盖由 bridge-sync 的 bridge tracking 用例承担。

// ══════════════════════════════════════════════════════════════════
// DF-2: Extension 错误转发 (EventAdapter translate)
// ══════════════════════════════════════════════════════════════════

describe('DF-2: Extension 错误转发 (EventAdapter → server broadcast)', () => {
  let fixture: WSFixture

  beforeEach(async () => {
    mockSendCommand.mockClear()
    fixture = await createWSFixture()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  it('extension_error → EventAdapter 翻译为 extension.error (含 sessionId)', async () => {
    fixture.emitPiEvent({
      type: 'extension_error',
      extensionPath: 'my-extension',
      error: 'Extension crashed unexpectedly',
    })
    await flushAsync()

    expect(fixture.adapterSent).toHaveLength(1)
    expect(fixture.adapterSent[0].type).toBe('extension.error')
    expect(fixture.adapterSent[0].payload).toMatchObject({
      sessionId: 'test-session-1',
      extensionName: 'my-extension',
      error: 'Extension crashed unexpectedly',
    })
  })

  it('extension_error 无显式 sessionId → EventAdapter 注入构造函数的 sessionId', async () => {
    fixture.emitPiEvent({
      type: 'extension_error',
      extensionPath: 'ext-no-sid',
      error: 'some error',
    })
    await flushAsync()

    expect(fixture.adapterSent).toHaveLength(1)
    expect(fixture.adapterSent[0].payload).toMatchObject({
      sessionId: 'test-session-1',
      extensionName: 'ext-no-sid',
      error: 'some error',
    })
  })
})

// ══════════════════════════════════════════════════════════════════
// DF-3: 工具进度更新 (EventAdapter translate)
// ══════════════════════════════════════════════════════════════════

describe('DF-3: 工具进度更新 (EventAdapter → server broadcast)', () => {
  let fixture: WSFixture

  beforeEach(async () => {
    mockSendCommand.mockClear()
    fixture = await createWSFixture()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  it('progress + partialResult → EventAdapter 翻译为 message.tool_call_update', async () => {
    fixture.emitPiEvent({
      type: 'tool_execution_update',
      toolCallId: 'tc-progress-1',
      toolName: 'read_file',
      partialResult: 'processing',
    })
    await flushAsync()

    expect(fixture.adapterSent).toHaveLength(1)
    expect(fixture.adapterSent[0].type).toBe('message.tool_call_update')
    expect(fixture.adapterSent[0].payload).toMatchObject({
      sessionId: 'test-session-1',
      toolCallId: 'tc-progress-1',
      detail: 'processing',
    })
  })

  it('无 partialResult → detail 为 undefined', async () => {
    fixture.emitPiEvent({
      type: 'tool_execution_update',
      toolCallId: 'tc-progress-2',
      toolName: 'search',
    })
    await flushAsync()

    expect(fixture.adapterSent).toHaveLength(1)
    expect(fixture.adapterSent[0].payload).toMatchObject({
      sessionId: 'test-session-1',
      toolCallId: 'tc-progress-2',
    })
    expect((fixture.adapterSent[0].payload as Record<string, unknown>).detail).toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════
// DF-4: Extension 列表管理 (WS → Server → ExtensionService → WS)
// ══════════════════════════════════════════════════════════════════

describe('DF-4: Extension 列表管理', () => {
  let server: RuntimeServer
  let ws: WebSocket
  let mockExtensionService: {
    scanExtensions: ReturnType<typeof vi.fn>
    getEnabledExtensions: ReturnType<typeof vi.fn>
    toggleExtension: ReturnType<typeof vi.fn>
    getExtensionPaths: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    vi.useRealTimers()
    mockSendCommand.mockClear()
    mockSendRaw.mockClear()
    mockSendExtensionUiResponse.mockClear()

    // EADDRINUSE 韧性：端口在 RuntimeServer 构造函数绑定，重试需整体重建（startOnFreePort 语义）
    mockExtensionService = {
      scanExtensions: vi.fn().mockResolvedValue([
        { name: 'ext-a', version: '1.0.0', description: 'Extension A', path: '/path/a', enabled: true },
        { name: 'ext-b', version: '2.0.0', description: 'Extension B', path: '/path/b', enabled: false },
      ]),
      getEnabledExtensions: vi.fn().mockResolvedValue([]),
      toggleExtension: vi.fn().mockResolvedValue(undefined),
      getExtensionPaths: vi.fn().mockResolvedValue([]),
    }

    const started = await startOnFreePort((p) => {
      const s = new RuntimeServer(p, '/tmp/test-project', TEST_WS_TOKEN)
      s.setServices(
        new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, noopGitInfoReader, {} as never),
        new ConfigService('/tmp', new PiConfigStore()),
        new ModelService(new ModelApiDiscoverer()),
        { extension: mockExtensionService as never },
      )
      return s
    })
    server = started.instance
    ws = await connectClient(started.port)
  })

  afterEach(async () => {
    ws.close()
    await server.stop()
  })

  it('ExtensionService 返回 2 个 extension → WS 收到 config.extensions 含完整列表', async () => {
    const responsePromise = waitForMessage(ws, 'config.extensions')

    // 清掉 setup 期间 sendInitialState 触发的 scanExtensions 调用，只数本用例内 extension.list 触发的
    mockExtensionService.scanExtensions.mockClear()

    ws.send(JSON.stringify({
      type: 'extension.list',
      id: 'ext-list-df4',
      payload: {},
    }))

    const msg = await responsePromise
    expect(msg.id).toBe('ext-list-df4')
    const payload = msg.payload as { extensions: Array<Record<string, unknown>> }
    expect(payload.extensions).toHaveLength(2)
    expect(payload.extensions[0]).toMatchObject({
      name: 'ext-a',
      version: '1.0.0',
      enabled: true,
    })
    expect(payload.extensions[1]).toMatchObject({
      name: 'ext-b',
      version: '2.0.0',
      enabled: false,
    })

    expect(mockExtensionService.scanExtensions).toHaveBeenCalledOnce()
  })

  it('ExtensionService 为 null → 返回空列表', async () => {
    const started2 = await startOnFreePort((p) => {
      const s = new RuntimeServer(p, '/tmp/test-project', TEST_WS_TOKEN)
      s.setServices(
        new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, noopGitInfoReader, {} as never),
        new ConfigService('/tmp', new PiConfigStore()),
        new ModelService(new ModelApiDiscoverer()),
      )
      return s
    })
    const server2 = started2.instance
    const ws2 = await connectClient(started2.port)

    const responsePromise = waitForMessage(ws2, 'config.extensions')

    ws2.send(JSON.stringify({
      type: 'extension.list',
      id: 'ext-list-null',
      payload: {},
    }))

    const msg = await responsePromise
    expect(msg.payload).toMatchObject({ extensions: [] })

    ws2.close()
    await server2.stop()
  })
})

// ══════════════════════════════════════════════════════════════════
// DF-5: Extension 启用/禁用 (WS → Server → ExtensionService.toggle → WS)
// ══════════════════════════════════════════════════════════════════

describe('DF-5: Extension 启用/禁用', () => {
  let server: RuntimeServer
  let ws: WebSocket
  let mockExtensionService: {
    scanExtensions: ReturnType<typeof vi.fn>
    getEnabledExtensions: ReturnType<typeof vi.fn>
    toggleExtension: ReturnType<typeof vi.fn>
    getExtensionPaths: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    vi.useRealTimers()
    mockSendCommand.mockClear()
    mockSendRaw.mockClear()
    mockSendExtensionUiResponse.mockClear()

    // EADDRINUSE 韧性：端口在 RuntimeServer 构造函数绑定，重试需整体重建（startOnFreePort 语义）
    mockExtensionService = {
      scanExtensions: vi.fn().mockResolvedValue([
        { name: 'ext-a', version: '1.0.0', description: 'Extension A', path: '/path/a', enabled: false },
      ]),
      getEnabledExtensions: vi.fn().mockResolvedValue([]),
      toggleExtension: vi.fn().mockResolvedValue(undefined),
      getExtensionPaths: vi.fn().mockResolvedValue([]),
    }

    const started = await startOnFreePort((p) => {
      const s = new RuntimeServer(p, '/tmp/test-project', TEST_WS_TOKEN)
      s.setServices(
        new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, noopGitInfoReader, {} as never),
        new ConfigService('/tmp', new PiConfigStore()),
        new ModelService(new ModelApiDiscoverer()),
        { extension: mockExtensionService as never },
      )
      return s
    })
    server = started.instance
    ws = await connectClient(started.port)
  })

  afterEach(async () => {
    ws.close()
    await server.stop()
  })

  it('禁用 extension → toggleExtension(false) → scanExtensions → config.extensions', async () => {
    const responsePromise = waitForMessage(ws, 'config.extensions')

    // 清掉 setup 期间 sendInitialState 触发的 scanExtensions 调用，只数本用例内 toggle 触发的
    mockExtensionService.scanExtensions.mockClear()

    ws.send(JSON.stringify({
      type: 'extension.toggle',
      id: 'ext-toggle-df5',
      payload: { name: 'ext-a', enabled: false },
    }))

    const msg = await responsePromise
    expect(msg.id).toBe('ext-toggle-df5')

    expect(mockExtensionService.toggleExtension).toHaveBeenCalledWith('ext-a', false)
    expect(mockExtensionService.scanExtensions).toHaveBeenCalledOnce()

    const payload = msg.payload as { extensions: Array<Record<string, unknown>> }
    expect(payload.extensions).toHaveLength(1)
    expect(payload.extensions[0]).toMatchObject({
      name: 'ext-a',
      enabled: false,
    })
  })

  it('ExtensionService 为 null → 返回 error', async () => {
    const started2 = await startOnFreePort((p) => {
      const s = new RuntimeServer(p, '/tmp/test-project', TEST_WS_TOKEN)
      s.setServices(
        new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, noopGitInfoReader, {} as never),
        new ConfigService('/tmp', new PiConfigStore()),
        new ModelService(new ModelApiDiscoverer()),
      )
      return s
    })
    const server2 = started2.instance
    const ws2 = await connectClient(started2.port)

    const errorPromise = waitForMessage(ws2, 'error')

    ws2.send(JSON.stringify({
      type: 'extension.toggle',
      id: 'ext-toggle-null',
      payload: { name: 'ext-a', enabled: true },
    }))

    const errMsg = await errorPromise
    expect(errMsg.payload).toMatchObject({
      code: 'handler_error',
      message: expect.stringContaining('Extension service not available'),
    })

    ws2.close()
    await server2.stop()
  })
})
