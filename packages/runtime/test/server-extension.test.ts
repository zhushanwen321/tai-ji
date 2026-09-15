import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'
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
import { startOnFreePort } from './helpers/free-port.js'

// IGitInfoReader 桩：SessionService 被 vi.mock 整体替换（构造参数不被使用），仅满足构造签名。
const noopGitInfoReader: IGitInfoReader = { readGitInfo: () => undefined, pruneStaleCache: () => {} }

/**
 * Task 3 tests: Server extension UI response routing.
 *
 * Test strategy:
 * - Basic routing (ui_response, list, toggle) uses real timers via WS
 * - Timeout mechanism tested directly via registerExtensionTimeout + cleanupExtensionTimeout
 * - Session cleanup tested via clearExtensionTimeoutsForSession
 */

// ── Mocks ────────────────────────────────────────────────────────

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

vi.mock('../src/infra/pi/event-adapter.js', () => ({
  EventAdapter: createMockEventAdapterClass(),
}))

vi.mock('../src/services/scanners/skill-scanner.js', () => createMockSkillScannerModule())
vi.mock('../src/services/scanners/agent-scanner.js', () => createMockAgentScannerModule())

// pi-config-bridge 已拆分：model/settings → pi-provider-store，session 扫描 → session-file-utils，
// 路径 → pi-paths。按实际 import 来源 mock 各符号（其余实现保留原模块）。
// 注意：vi.mock 第二参数必须是内联箭头（不能直接传导入的函数引用或其调用结果——
// hoist 时 imports 尚未初始化会触发 TDZ）。箭头 body 在模块首次 import 时执行，此时安全。
// 本文件 pi-paths 有额外 getConfigDir / getPiAgentDir 覆盖（保留）。
vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) =>
  mockPiProviderStoreModule(await importOriginal<Record<string, unknown>>()),
)
vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) =>
  mockSessionFileUtilsModule(await importOriginal<Record<string, unknown>>()),
)
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => ({
  ...mockPiPathsModule(await importOriginal<Record<string, unknown>>()),
  getConfigDir: () => '/mock/config',
  getPiAgentDir: () => '/mock/agent',
}))

const mockInstallLocalDirectory = vi.fn().mockResolvedValue({
  tempDir: '/tmp/ext-scan-test',
  candidates: [
    { name: 'pi-test-ext', version: '1.0.0', description: 'Test', path: '/tmp/test', enabled: true, source: 'user-installed' as const },
  ],
})
const mockInstallGitRepository = vi.fn().mockResolvedValue({
  tempDir: '/tmp/ext-scan-git',
  candidates: [
    { name: 'pi-git-ext', version: '0.5.0', description: 'Git', path: '/tmp/git', enabled: true, source: 'user-installed' as const },
  ],
})
const mockFinishInstall = vi.fn().mockResolvedValue(undefined)
const mockInstallExtension = vi.fn().mockResolvedValue(undefined)
const mockCancelInstall = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/services/extension-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/extension-service.js')>()
  return {
    ...actual,
    ExtensionService: class MockExtensionService {
      scanExtensions = vi.fn().mockResolvedValue([])
      getEnabledExtensions = vi.fn().mockResolvedValue([])
      toggleExtension = vi.fn().mockResolvedValue(undefined)
      getExtensionPaths = vi.fn().mockResolvedValue([])
      installLocalDirectory = mockInstallLocalDirectory
      installGitRepository = mockInstallGitRepository
      finishInstall = mockFinishInstall
      installExtension = mockInstallExtension
      cancelInstall = mockCancelInstall
    },
  }
})

vi.mock('../src/infra/system/trash.js', () => createMockTrashModule())

import { RuntimeServer } from '../src/transport/server.js'
import { SessionService } from '../src/services/session/session-service.js'
import { ConfigService } from '../src/services/config-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { ModelApiDiscoverer } from '../src/infra/model-api-discoverer.js'
import { ModelService } from '../src/services/model-service.js'
import { ExtensionService } from '../src/services/extension-service.js'
import { NpmGitInstaller } from '../src/infra/installers/npm-git-installer.js'
import { ExtensionResolver } from '../src/infra/installers/extension-resolver.js'
import { PiExtensionSettings } from '../src/infra/pi/pi-extension-settings.js'

function waitForMessage(ws: WebSocket, type: string, timeout = 2000): Promise<Record<string, unknown>> {
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

// ── Tests with real timers (basic routing) ────────────────────────

/** S1-W1：真实 WS 测试统一 token（ConnectionManager auth 握手，见 ws-listen-hardening.test.ts） */
const TEST_WS_TOKEN = 'test-ws-token-extension'

describe('RuntimeServer: extension message routing', () => {
  let server: RuntimeServer
  let port: number
  let ws: WebSocket
  let sessionService: SessionService

  beforeEach(async () => {
    mockSendCommand.mockClear()
    mockSendExtensionUiResponse.mockClear()
    mockSendRaw.mockClear()
    mockInstallLocalDirectory.mockClear()
    mockInstallGitRepository.mockClear()
    mockFinishInstall.mockClear()
    // EADDRINUSE 韧性：端口在 RuntimeServer 构造函数绑定，重试需整体重建（startOnFreePort 语义）。
    // sessionService 经闭包赋值到外层变量，重试重建时同步替换。
    const started = await startOnFreePort((p) => {
      const s = new RuntimeServer(p, '/tmp/test-project', TEST_WS_TOKEN)
      sessionService = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, noopGitInfoReader, {} as never)
      s.setServices(
        sessionService,
        new ConfigService('/tmp', new PiConfigStore()),
        new ModelService(new ModelApiDiscoverer()),
        {
          extension: new ExtensionService({
            settingsDir: new PiConfigStore().getPiAgentDir(),
            installer: new NpmGitInstaller(),
            resolver: new ExtensionResolver({ settingsDir: new PiConfigStore().getPiAgentDir() }),
            extensionSettings: new PiExtensionSettings(new PiConfigStore().getPiAgentDir()),
          }),
        },
      )
      return s
    })
    server = started.instance
    port = started.port
  })

  afterEach(async () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close()
    }
    await server.stop()
  })

  function connectClient(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(`ws://localhost:${port}`)
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

  // ── extension.ui_response ────────────────────────────────────────

  describe('extension.ui_response', () => {
    it('forwards ui_response to pi via sendExtensionUiResponse with confirm format', async () => {
      const client = await connectClient()

      ws.send(JSON.stringify({
        type: 'extension.ui_response',
        id: 'resp-1',
        payload: {
          sessionId: 'sess-1',
          requestId: 'req-1',
          method: 'confirm',
          result: true,
        },
      }))

      // Wait for server to process the message
      await vi.waitFor(() => {
        expect(sessionService.getRpcClient).toHaveBeenCalledWith('sess-1')
      })

      expect(sessionService.getRpcClient).toHaveBeenCalledWith('sess-1')
      // W2 收口后转发走 sendExtensionUiResponse(id, result, method)
      // confirm + true → pi 鸭子类型字段 {id, confirmed:true}
      expect(mockSendExtensionUiResponse).toHaveBeenCalledWith('req-1', true, 'confirm')
    })

    it('handles string result as value format (select/input/editor)', async () => {
      await connectClient()

      ws.send(JSON.stringify({
        type: 'extension.ui_response',
        id: 'resp-2',
        payload: {
          sessionId: 'sess-1',
          requestId: 'req-2',
          method: 'select',
          result: 'selected-value',
        },
      }))

      // Wait for server to process the message
      await vi.waitFor(() => {
        expect(mockSendExtensionUiResponse).toHaveBeenCalledWith('req-2', 'selected-value', 'select')
      })

      // select + string → pi 鸭子类型字段 {id, value:'selected-value'}
      expect(mockSendExtensionUiResponse).toHaveBeenCalledWith('req-2', 'selected-value', 'select')
    })

    it('handles null result as cancelled format', async () => {
      await connectClient()

      ws.send(JSON.stringify({
        type: 'extension.ui_response',
        id: 'resp-3',
        payload: {
          sessionId: 'sess-1',
          requestId: 'req-3',
          method: 'select',
          result: null,
        },
      }))

      // Wait for server to process the message
      await vi.waitFor(() => {
        expect(mockSendExtensionUiResponse).toHaveBeenCalledWith('req-3', null, 'select')
      })

      // null → pi 鸭子类型字段 {id, cancelled:true}（sendExtensionUiResponse 收到 null 走取消分支）
      expect(mockSendExtensionUiResponse).toHaveBeenCalledWith('req-3', null, 'select')
    })

    it('sends error when RpcClient not found', async () => {
      vi.mocked(sessionService.getRpcClient).mockReturnValueOnce(undefined)
      await connectClient()

      const errorPromise = waitForMessage(ws, 'error')

      ws.send(JSON.stringify({
        type: 'extension.ui_response',
        id: 'resp-err',
        payload: {
          sessionId: 'unknown-session',
          requestId: 'req-err',
          result: true,
        },
      }))

      const errMsg = await errorPromise
      expect(errMsg.payload).toMatchObject({
        code: 'handler_error',
        sessionId: 'unknown-session',
      })
    })
  })

  // ── sendInitialState → config.extensions ─────────────────────────

  describe('sendInitialState pushes config.extensions', () => {
    it('client receives config.extensions on connect (已安装列表初始数据源)', async () => {
      // sendInitialState 在 ws.onConnect（S1-W1 后 = auth 通过）时推，config.extensions 段
      // 是 fire-and-forget（scanExtensions async，.then 后 send）。必须在 ws 'open' 之前
      // attach 'message' handler，否则会漏掉 auth 后触发的 initial state 推送。
      const collected: Record<string, unknown>[] = []
      await new Promise<void>((resolve, reject) => {
        ws = new WebSocket(`ws://localhost:${port}`)
        ws.on('message', (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString()) as Record<string, unknown>
            collected.push(msg)
            if (msg.type === 'auth.result' && (msg.payload as { ok?: boolean } | undefined)?.ok === true) {
              // auth 通过后再等一拍收 initial state
              setTimeout(() => resolve(), 100)
            }
          } catch { /* skip */ }
        })
        ws.on('open', () => {
          // S1-W1：首条消息 auth
          ws.send(JSON.stringify({ type: 'auth', payload: { token: TEST_WS_TOKEN } }))
        })
        ws.on('error', reject)
      })

      // scanExtensions 是 async fire-and-forget，config.extensions 可能晚于同步段到达。
      // 用 vi.waitFor 轮询，等 collected 里出现 config.extensions。
      await vi.waitFor(() => {
        const hasExt = collected.some(m => m.type === 'config.extensions')
        expect(hasExt).toBe(true)
      }, { timeout: 2000, interval: 50 })

      const extMsg = collected.find(m => m.type === 'config.extensions')!
      expect(extMsg.payload).toHaveProperty('extensions')
      expect(Array.isArray((extMsg.payload as { extensions: unknown[] }).extensions)).toBe(true)
    })
  })

  // ── extension.list ───────────────────────────────────────────────

  describe('extension.list', () => {
    it('returns extension list from ExtensionService', async () => {
      await connectClient()

      const responsePromise = waitForMessage(ws, 'config.extensions')

      ws.send(JSON.stringify({
        type: 'extension.list',
        id: 'ext-list-1',
        payload: {},
      }))

      const msg = await responsePromise
      expect(msg.id).toBe('ext-list-1')
      expect(msg.payload).toMatchObject({ extensions: [] })
    })
  })

  // ── extension.toggle ─────────────────────────────────────────────

  describe('extension.toggle', () => {
    it('calls toggleExtension and returns updated list', async () => {
      await connectClient()

      const responsePromise = waitForMessage(ws, 'config.extensions')

      ws.send(JSON.stringify({
        type: 'extension.toggle',
        id: 'ext-toggle-1',
        payload: { name: 'my-ext', enabled: true },
      }))

      const msg = await responsePromise
      expect(msg.id).toBe('ext-toggle-1')
      expect(msg.payload).toMatchObject({ extensions: [] })
    })
  })

  // ── extension.installDir (Task 5) ───────────────────────────────

  describe('extension.installDir', () => {
    it('calls installLocalDirectory and returns discovered extensions', async () => {
      await connectClient()

      const responsePromise = waitForMessage(ws, 'extension.discovered')

      ws.send(JSON.stringify({
        type: 'extension.installDir',
        id: 'ext-dir-1',
        payload: { path: '/path/to/local/dir' },
      }))

      const msg = await responsePromise
      expect(msg.id).toBe('ext-dir-1')
      expect(mockInstallLocalDirectory).toHaveBeenCalledWith('/path/to/local/dir')
      expect(msg.payload).toMatchObject({
        tempDir: '/tmp/ext-scan-test',
        candidates: expect.arrayContaining([
          expect.objectContaining({ name: 'pi-test-ext' }),
        ]),
      })
    })

    it('sends installError when installLocalDirectory throws', async () => {
      mockInstallLocalDirectory.mockRejectedValueOnce(new Error('Source path does not exist'))
      await connectClient()

      const responsePromise = waitForMessage(ws, 'error')

      ws.send(JSON.stringify({
        type: 'extension.installDir',
        id: 'ext-dir-err',
        payload: { path: '/nonexistent' },
      }))

      const msg = await responsePromise
      expect(msg.id).toBe('ext-dir-err')
      expect(msg.payload).toMatchObject({
        code: 'install_failed',
        message: expect.stringContaining('Source path does not exist'),
      })
    })
  })

  // ── extension.installGit (Task 5) ───────────────────────────────

  describe('extension.installGit', () => {
    it('calls installGitRepository and returns discovered extensions', async () => {
      await connectClient()

      const responsePromise = waitForMessage(ws, 'extension.discovered')

      ws.send(JSON.stringify({
        type: 'extension.installGit',
        id: 'ext-git-1',
        payload: { url: 'https://github.com/user/repo.git' },
      }))

      const msg = await responsePromise
      expect(msg.id).toBe('ext-git-1')
      expect(mockInstallGitRepository).toHaveBeenCalledWith('https://github.com/user/repo.git')
      expect(msg.payload).toMatchObject({
        tempDir: '/tmp/ext-scan-git',
        candidates: expect.arrayContaining([
          expect.objectContaining({ name: 'pi-git-ext' }),
        ]),
      })
    })

    it('sends installError when installGitRepository throws', async () => {
      mockInstallGitRepository.mockRejectedValueOnce(new Error('git clone failed: not found'))
      await connectClient()

      const responsePromise = waitForMessage(ws, 'error')

      ws.send(JSON.stringify({
        type: 'extension.installGit',
        id: 'ext-git-err',
        payload: { url: 'https://github.com/bad/repo.git' },
      }))

      const msg = await responsePromise
      expect(msg.payload).toMatchObject({
        code: 'install_failed',
        message: expect.stringContaining('git clone failed'),
      })
    })
  })

  // ── extension.install ─────────────────────────────────────────

  describe('extension.install', () => {
    it('calls installExtension with source and returns extension list', async () => {
      await connectClient()

      const responsePromise = waitForMessage(ws, 'config.extensions')

      ws.send(JSON.stringify({
        type: 'extension.install',
        id: 'ext-install-1',
        payload: { source: 'npm:pi-test-pkg' },
      }))

      const msg = await responsePromise
      expect(msg.id).toBe('ext-install-1')
      expect(mockInstallExtension).toHaveBeenCalledWith('npm:pi-test-pkg')
      expect(msg.payload).toMatchObject({ extensions: [] })
    })

    it('sends installError when installExtension throws', async () => {
      mockInstallExtension.mockRejectedValueOnce(new Error('npm install failed: 404'))
      await connectClient()

      const responsePromise = waitForMessage(ws, 'error')

      ws.send(JSON.stringify({
        type: 'extension.install',
        id: 'ext-install-err',
        payload: { source: 'npm:nonexistent-pkg' },
      }))

      const msg = await responsePromise
      expect(msg.payload).toMatchObject({
        code: 'install_failed',
        message: expect.stringContaining('npm install failed'),
      })
    })
  })

  // ── extension.cancelInstall ─────────────────────────────────────

  describe('extension.cancelInstall', () => {
    it('calls cancelInstall with tempDir and returns installCancelled', async () => {
      await connectClient()

      const responsePromise = waitForMessage(ws, 'extension.installCancelled')

      ws.send(JSON.stringify({
        type: 'extension.cancelInstall',
        id: 'ext-cancel-1',
        payload: { tempDir: '/tmp/ext-cancel-test' },
      }))

      const msg = await responsePromise
      expect(msg.id).toBe('ext-cancel-1')
      expect(mockCancelInstall).toHaveBeenCalledWith('/tmp/ext-cancel-test')
    })

    it('sends error when cancelInstall throws', async () => {
      mockCancelInstall.mockRejectedValueOnce(new Error('invalid temp directory'))
      await connectClient()

      const responsePromise = waitForMessage(ws, 'error')

      ws.send(JSON.stringify({
        type: 'extension.cancelInstall',
        id: 'ext-cancel-err',
        payload: { tempDir: '/etc/malicious' },
      }))

      const msg = await responsePromise
      expect(msg.type).toBe('error')
      expect((msg.payload as { message?: string }).message).toContain('invalid temp directory')
    })
  })

  // ── extension.finishInstall (Task 5) ────────────────────────────

  describe('extension.finishInstall', () => {
    it('calls finishInstall and returns updated extension list', async () => {
      await connectClient()

      const responsePromise = waitForMessage(ws, 'config.extensions')

      ws.send(JSON.stringify({
        type: 'extension.finishInstall',
        id: 'ext-finish-1',
        payload: { tempDir: '/tmp/ext-scan-test', selected: ['pi-test-ext'] },
      }))

      const msg = await responsePromise
      expect(msg.id).toBe('ext-finish-1')
      expect(mockFinishInstall).toHaveBeenCalledWith('/tmp/ext-scan-test', ['pi-test-ext'])
      expect(msg.payload).toMatchObject({ extensions: [] })
    })

    it('sends error when finishInstall throws', async () => {
      mockFinishInstall.mockRejectedValueOnce(new Error('not found in temp directory'))
      await connectClient()

      const responsePromise = waitForMessage(ws, 'error')

      ws.send(JSON.stringify({
        type: 'extension.finishInstall',
        id: 'ext-finish-err',
        payload: { tempDir: '/tmp/nonexistent', selected: ['missing'] },
      }))

      const msg = await responsePromise
      expect(msg.payload).toMatchObject({
        code: 'install_failed',
        message: expect.stringContaining('not found in temp directory'),
      })
    })
  })
})

// ── Tests with fake timers (timeout mechanism) ────────────────────

describe('RuntimeServer: extension timeout mechanism', () => {
  let server: RuntimeServer
  let sessionService: SessionService

  beforeEach(() => {
    vi.useFakeTimers()
    mockSendCommand.mockClear()
    mockSendExtensionUiResponse.mockClear()
    mockSendRaw.mockClear()
    server = new RuntimeServer(0, '/tmp/test-project')
    sessionService = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, noopGitInfoReader, {} as never)
    // 超时路径调 getRpcClient(sessionId) → client.sendExtensionUiResponse。
    // SessionService 用 {} 占位构造，getRpcClient 返回 undefined → mock 返回带 sendExtensionUiResponse 的假 client。
    vi.spyOn(sessionService, 'getRpcClient').mockReturnValue({
      sendCommand: mockSendCommand,
      sendExtensionUiResponse: mockSendExtensionUiResponse,
      sendRaw: mockSendRaw,
    } as never)
    server.setServices(
      sessionService,
      new ConfigService('/tmp', new PiConfigStore()),
      new ModelService(new ModelApiDiscoverer()),
      {
        extension: new ExtensionService({
          settingsDir: new PiConfigStore().getPiAgentDir(),
          installer: new NpmGitInstaller(),
          resolver: new ExtensionResolver({ settingsDir: new PiConfigStore().getPiAgentDir() }),
          extensionSettings: new PiExtensionSettings(new PiConfigStore().getPiAgentDir()),
        }),
      },
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // [2026-07-16] extension UI 超时已取消（confirm/select/input/editor/ask-user 统一不超时，
  // block 等待用户决策）。原「triggers default response after timeout」× 3 + 「clears all
  // timeouts for a session」共 4 个用例断言超时触发 sendExtensionUiResponse，行为已移除，
  // 测试随之删除。clearForSession 的 session 级清理由 bridge timeout exclusion 用例覆盖。

  it('does NOT trigger timeout if cleared by ui_response', () => {
    server.registerExtensionTimeout('sess-1', 'req-clear-1', 'confirm', {})

    server.clearExtensionTimeout('req-clear-1')

    vi.advanceTimersByTime(300_000)

    expect(mockSendExtensionUiResponse).not.toHaveBeenCalled()
  })

  it('notify method does not register timeout', () => {
    server.registerExtensionTimeout('sess-1', 'req-notify', 'notify', {})

    vi.advanceTimersByTime(300_000)

    expect(mockSendExtensionUiResponse).not.toHaveBeenCalled()
  })
})
