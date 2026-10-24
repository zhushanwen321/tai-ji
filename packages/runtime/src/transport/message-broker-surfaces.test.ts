/**
 * ServerMessageBroker session.surfaces 冷启动段（W4a 判别器通道，设计 §3.3.6）测试。
 *
 * 锁定：sendInitialState 的 descriptor 段形态——新连接推送 session.surfaces 全量派生
 * 视图，entries 派生来源 = 活跃注册表（getActiveSessionIds × getSession(id).surface，
 * 与 session-lifecycle 注册后广播同公式同源）；surface 缺省记录按 'sidebar' 收敛。
 * 该帧是全局帧（无 sessionId，rule-7 登记例外）——renderer 只读派生表冷启动填充源。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/message-broker-surfaces.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { ServerMessageBroker } from './message-broker.js'
import type { BrokerServices, ClientPool } from './message-broker.js'
import type { ServerMessage } from '@taiji/shared'

function makeBroker(sessions: Array<{ id: string; surface?: 'sidebar' | 'btw' }>) {
  const sent: string[] = []
  const fakeWs = {
    readyState: 1,
    send: (payload: string) => { sent.push(payload) },
  }
  const pool = { clients: new Set([fakeWs]) } as unknown as ClientPool
  const services = {
    sessionService: {
      listPersistedSessions: vi.fn(() => []),
      getActiveSessionIds: vi.fn(() => sessions.map((s) => s.id)),
      getSession: vi.fn((id: string) => sessions.find((s) => s.id === id)),
    },
    configService: {
      listProviders: vi.fn(() => []),
      isModelsStoreCorrupted: vi.fn(() => false),
      loadSkills: vi.fn(() => []),
      loadAgents: vi.fn(() => []),
      getSkillPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
      getAgentPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
      getExtensionPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
      getDefaultModel: vi.fn(() => null),
      getSystemPromptConfig: vi.fn(() => ({ config: null, corrupted: false })),
      getTerminalConfig: vi.fn(() => ({ config: null, corrupted: false })),
    },
    modelService: { aggregateModels: vi.fn(() => []) },
    pluginService: undefined,
    extensionService: undefined,
    projectRoot: '/test',
    appInfo: { appVersion: '1.2.3', piVersion: 'unknown' },
  } as unknown as BrokerServices
  const broker = new ServerMessageBroker(pool, services)
  return { broker, sent, fakeWs }
}

describe('ServerMessageBroker sendInitialState：session.surfaces 冷启动段（W4a）', () => {
  it('新连接首推 session.surfaces 帧，entries = 活跃注册表全量派生（含 btw 线）', () => {
    const { broker, sent, fakeWs } = makeBroker([
      { id: 'main-a', surface: 'sidebar' },
      { id: 'line-b', surface: 'btw' },
      { id: 'main-c' }, // surface 缺省记录 → 'sidebar' 收敛
    ])
    broker.sendInitialState(fakeWs as unknown as import('ws').WebSocket)
    const msgs = sent.map((s) => JSON.parse(s) as ServerMessage)
    const frame = msgs.find((m) => m.type === 'session.surfaces')
    expect(frame).toBeDefined()
    expect(frame!.id).toMatch(/^push_/)
    expect(frame!.payload).toEqual({
      entries: [
        { sessionId: 'main-a', surface: 'sidebar' },
        { sessionId: 'line-b', surface: 'btw' },
        { sessionId: 'main-c', surface: 'sidebar' },
      ],
    })
  })

  it('空注册表：帧仍推送（entries 空表——renderer 派生表整表替换为空即正确）', () => {
    const { broker, sent, fakeWs } = makeBroker([])
    broker.sendInitialState(fakeWs as unknown as import('ws').WebSocket)
    const frame = sent.map((s) => JSON.parse(s) as ServerMessage).find((m) => m.type === 'session.surfaces')
    expect(frame?.payload).toEqual({ entries: [] })
  })
})
