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
 * message.send marker 通道废弃 — 边界 / 敌意 payload 回归（composer 四符号设计 D2）。
 *
 * Supplements server-subagent.test.ts which covers normal paths.
 * [HISTORICAL] 本文件曾断言 subagent 字段的 marker 编码边界（XML 注入/空字段/超长字段）。
 * marker 通道删除后，边界职责反转：验证各种残缺 / 敌意形态的 legacy `subagent` 键
 * 在 WS 入口被安全忽略——不崩溃、sendMessage 收到原文（全文相等，强于「不含 marker」）。
 */

// ── Mock SessionService ───────────────────────────────────────────
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
  mockPiProviderStoreModule(await importOriginal<Record<string, unknown>>()),
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
const TEST_WS_TOKEN = 'test-ws-token-subagent-boundary'

describe('RuntimeServer message.send marker 通道废弃 — boundary & hostile payloads', () => {
  let server: RuntimeServer
  let port: number
  let ws: WebSocket

  beforeEach(async () => {
  sendMessageMock.mockClear()
  // EADDRINUSE 韧性：端口在 RuntimeServer 构造函数绑定，重试需整体重建（startOnFreePort 语义）
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
      setTimeout(() => resolve(ws), 100)
    }
    })
    ws.on('error', reject)
  })
  }

  function sendAndCollect(ws: WebSocket, msg: object): Promise<void> {
  return new Promise((resolve) => {
    ws.send(JSON.stringify(msg))
    setTimeout(() => resolve(), 200)
  })
  }

  // ── Boundary: legacy subagent 键的各种残缺形态都被安全忽略 ──────

  it('subagent 为 null → 不崩溃，原文直发（全文相等，无任何包装）', async () => {
  const client = await connectClient()

  await sendAndCollect(client, {
    type: 'message.send',
    id: 'test-null-subagent',
    payload: {
    sessionId: 'sess-null',
    content: 'raw body',
    subagent: null,
    },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sent = sendMessageMock.mock.calls[0][1] as string
  expect(sent).toBe('raw body')
  expect(sent).not.toContain('<!--')
  })

  it('subagent 为非对象标量 → 同样被忽略，原文直发', async () => {
  const client = await connectClient()

  await sendAndCollect(client, {
    type: 'message.send',
    id: 'test-scalar-subagent',
    payload: {
    sessionId: 'sess-scalar',
    content: 'raw body',
    subagent: 'do-the-thing',
    },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sent = sendMessageMock.mock.calls[0][1] as string
  expect(sent).toBe('raw body')
  expect(sent).not.toContain('<!--')
  })

  it('subagent 字段含 XML 危险字符 / 超长值 → 忽略后不产生任何注入面（值不进发送文本）', async () => {
  const client = await connectClient()
  const longTask = 'y'.repeat(1000)

  await sendAndCollect(client, {
    type: 'message.send',
    id: 'test-hostile-subagent',
    payload: {
    sessionId: 'sess-hostile',
    content: 'raw body',
    subagent: { agent: 'a<b>c"d&e', task: `<script>alert(1)</script>${longTask}` },
    },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sent = sendMessageMock.mock.calls[0][1] as string
  // 通道已删：subagent 的值完全不进发送文本，无 marker / 无 XML 包装 / 无超长注入
  expect(sent).toBe('raw body')
  expect(sent).not.toContain('<script>')
  expect(sent).not.toContain(longTask)
  })

  it('多行 content（真实换行）原样透传——多行属于主 agent 正常文本，无需转义', async () => {
  const client = await connectClient()

  const multiline = 'step 1: read code\nstep 2: find bugs\nstep 3: report'
  await sendAndCollect(client, {
    type: 'message.send',
    id: 'test-multiline-content',
    payload: {
    sessionId: 'sess-newlines',
    content: multiline,
    },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sent = sendMessageMock.mock.calls[0][1] as string
  expect(sent).toBe(multiline)
  })
})
