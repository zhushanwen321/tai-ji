import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import {
  createMockSessionServiceInstance,
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

/**
 * message.send 纯转发回归（composer 四符号设计 D2：marker 半成品通道废弃）。
 *
 * [HISTORICAL] 本文件曾断言 `subagent` 字段触发 base64 marker（隐藏注释前缀）拼装——
 * 该通道在 extension 侧零消费方且经主 agent 转发违背「直达 subagent」目标，已删除。
 * 现在守住相反的方向：message.send 永远走 sendMessage 原文转发（断言全文相等，强于
 * 「不含 marker」——相等即不可能有任何前缀/包装）；旧版本 renderer 残留的 `subagent` 键
 * 被忽略（升级窗口内不 resurrect marker 行为）。
 * 定向消息的正路是 session.subagentAction(message/start)（session-service.test.ts 覆盖）。
 */

// ── Mock SessionService to capture sendMessage calls ────────────
//
// 测试需要持有 sendMessageMock ref 断言转发原文，因此在 vi.mock 之外用
// createMockSessionServiceInstance 创建，再把 instance 字段铺到 class 上。

const { instance: sessionServiceInstance, sendMessageMock } =
  createMockSessionServiceInstance()

vi.mock('../src/services/session/session-service.js', () => {
  return {
    SessionService: class MockSessionService {
      sendMessage = sessionServiceInstance.sendMessage
      listPersistedSessions = sessionServiceInstance.listPersistedSessions
      getSummary = sessionServiceInstance.getSummary
      getHistory = sessionServiceInstance.getHistory
      create = sessionServiceInstance.create
      delete = sessionServiceInstance.delete
      destroyAll = sessionServiceInstance.destroyAll
      clear = sessionServiceInstance.clear
      renameSession = sessionServiceInstance.renameSession
      restoreSession = sessionServiceInstance.restoreSession
      hasActiveSession = sessionServiceInstance.hasActiveSession
      compact = sessionServiceInstance.compact
      abort = sessionServiceInstance.abort
      switchModel = sessionServiceInstance.switchModel
      setOnSessionDestroyed = sessionServiceInstance.setOnSessionDestroyed
    },
  }
})

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
vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) =>
  mockPiProviderStoreModule(
    await importOriginal<Record<string, unknown>>(),
  ),
)
vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) =>
  mockSessionFileUtilsModule(await importOriginal<Record<string, unknown>>()),
)
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) =>
  mockPiPathsModule(await importOriginal<Record<string, unknown>>()),
)

vi.mock('../src/infra/system/trash.js', () => createMockTrashModule())

import { RuntimeServer } from '../src/transport/server.js'
import { SessionService } from '../src/services/session/session-service.js'
import { ConfigService } from '../src/services/config-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { ModelApiDiscoverer } from '../src/infra/model-api-discoverer.js'
import { ModelService } from '../src/services/model-service.js'

/** S1-W1：真实 WS 测试统一 token（ConnectionManager auth 握手，见 ws-listen-hardening.test.ts） */
const TEST_WS_TOKEN = 'test-ws-token-subagent'

describe('RuntimeServer message.send（marker 通道废弃后的纯转发）', () => {
  let server: RuntimeServer
  let port: number
  let ws: WebSocket

  beforeEach(async () => {
  sendMessageMock.mockClear()
  // EADDRINUSE 韧性：端口在 RuntimeServer 构造函数绑定，重试需整体重建（startOnFreePort 语义）。
  // 注：server.test.ts 是本文件的 symlink（同体设计），本改动同时对两者生效。
  const started = await startOnFreePort((p) => {
    const s = new RuntimeServer(p, '/tmp/test-project', TEST_WS_TOKEN)
    s.setServices(
      new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, { readGitInfo: () => undefined, pruneStaleCache: () => {} } as never, {} as never),
      new ConfigService('/tmp', new PiConfigStore()),
      new ModelService(new ModelApiDiscoverer()),
      { extension: {} as never },
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

  /** Helper: connect a WS client, auth (S1-W1), and wait for initial state to drain */
  function connectClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://localhost:${port}`)
    ws.on('open', () => {
    // S1-W1：首条消息 auth，等 auth.result ok 后连接才可用
    ws.send(JSON.stringify({ type: 'auth', payload: { token: TEST_WS_TOKEN } }))
    })
    ws.on('message', (data) => {
    const msg = JSON.parse(String(data))
    if (msg.type === 'auth.result' && msg.payload?.ok === true) {
      // Wait a tick for initial state messages to be sent
      setTimeout(() => resolve(ws), 100)
    }
    })
    ws.on('error', reject)
  })
  }

  /** Helper: send a message and wait for the response */
  function sendAndCollect(ws: WebSocket, msg: object): Promise<void> {
  return new Promise((resolve) => {
    ws.send(JSON.stringify(msg))
    // Give server time to process
    setTimeout(() => resolve(), 200)
  })
  }

  // ── Test cases ────────────────────────────────────────────────

  it('普通消息 → sendMessage 收到原文，不拼 marker', async () => {
  const client = await connectClient()

  await sendAndCollect(client, {
    type: 'message.send',
    id: 'test-1',
    payload: {
    sessionId: 'sess-789',
    content: 'just a normal message',
    },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  // 第 4 参 clientUuid：payload 未带 → undefined（session-occupancy-send-closure D2 透传）
  expect(sendMessageMock).toHaveBeenCalledWith('sess-789', 'just a normal message', undefined, undefined)
  })

  it('旧 renderer 残留 subagent 键 → 被忽略：sendMessage 收到原文（全文相等，无任何包装）', async () => {
  const client = await connectClient()

  await sendAndCollect(client, {
    type: 'message.send',
    id: 'test-2',
    payload: {
    sessionId: 'sess-123',
    content: 'original content',
    subagent: {
      agent: 'harness-executor',
      task: 'Implement the feature',
    },
    },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sentContent = sendMessageMock.mock.calls[0][1] as string
  // marker 通道已删：内容与原文全文相等（强于「不含 marker」——不可能有任何前缀/注释包装）
  expect(sentContent).toBe('original content')
  expect(sentContent).not.toContain('<!--')
  })

  it('subagent 键的空字段变体（agent/task 空串）同样被忽略，原文直发', async () => {
  const client = await connectClient()

  await sendAndCollect(client, {
    type: 'message.send',
    id: 'test-3',
    payload: {
    sessionId: 'sess-empty-task',
    content: 'fallback body',
    subagent: {
      agent: 'test-agent',
      task: '',
    },
    },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sentContent = sendMessageMock.mock.calls[0][1] as string
  expect(sentContent).toBe('fallback body')
  expect(sentContent).not.toContain('<!--')
  })

  it('特殊字符原文（XML 危险字符 / 引号 / 换行）原样透传，不做任何包装', async () => {
  const client = await connectClient()

  const rawContent = '<script>alert("xss")</script> & "quoted"\nline2'
  await sendAndCollect(client, {
    type: 'message.send',
    id: 'test-4',
    payload: {
    sessionId: 'sess-special',
    content: rawContent,
    },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sentContent = sendMessageMock.mock.calls[0][1] as string
  expect(sentContent).toBe(rawContent)
  })

  it('带 images 的消息照常透传 images（payload 解构不受 subagent 键删除影响）', async () => {
  const client = await connectClient()

  const images = [{ data: 'aGk=', mimeType: 'image/png' }]
  await sendAndCollect(client, {
    type: 'message.send',
    id: 'test-5',
    payload: {
    sessionId: 'sess-img',
    content: 'see image',
    images,
    },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  // 第 4 参 clientUuid：payload 未带 → undefined（session-occupancy-send-closure D2 透传）
  expect(sendMessageMock).toHaveBeenCalledWith('sess-img', 'see image', images, undefined)
  })
})
