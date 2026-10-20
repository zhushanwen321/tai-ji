/**
 * ServerMessageBroker config.sessions 帧 archiveCount 测试（session-archive 设计 D5，
 * u-rpc-wiring 验收条款：archiveCount 进 broadcastSessionList 帧）。
 *
 * 锁定（协议变更点）：
 * - broadcastSessionList 帧 payload 携带 archiveCount = listArchiveEntries 条目数
 *  （归档角标随广播即时；与 config.archives 列表同数据源，角标与「已归档 (N)」头恒一致）
 * - sendInitialState 首推的 config.sessions 段同携带（同一 buildSessionListMsg 构造）
 * - archiveService 未注入（旧装配）→ archiveCount 字段缺省（协议 optional，消费方按 0
 *   隐藏角标）
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/message-broker-archive.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { ServerMessageBroker } from '../message-broker.js'
import type { BrokerServices, ClientPool } from '../message-broker.js'
import type { ArchiveSummary, ServerMessage } from '@taiji/shared'
import type { ArchiveRpcPort } from '../session-message-handler.js'

function makeBroker(archiveService?: Pick<ArchiveRpcPort, 'listArchiveEntries'>) {
  const sent: string[] = []
  const fakeWs = {
    readyState: 1,
    send: (payload: string) => { sent.push(payload) },
  }
  const pool = { clients: new Set([fakeWs]) } as unknown as ClientPool
  const services = {
    sessionService: { listPersistedSessions: vi.fn(() => []) },
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
    appInfo: { appVersion: '0.0.0-test', piVersion: 'unknown' },
    archiveService,
  } as unknown as BrokerServices
  const broker = new ServerMessageBroker(pool, services)
  return { broker, sent, fakeWs }
}

const ARCHIVES = [
  { sessionId: 'a-1', status: 'staging', summary: null },
  { sessionId: 'a-2', status: 'archived', summary: { turns: [] } },
  { sessionId: 'a-3', status: 'archived', summary: { turns: [] } },
] as unknown as ArchiveSummary[]

function archivePort(archives: ArchiveSummary[]): Pick<ArchiveRpcPort, 'listArchiveEntries'> {
  return { listArchiveEntries: () => archives }
}

describe('ServerMessageBroker config.sessions 帧 archiveCount（D5 协议变更点）', () => {
  it('broadcastSessionList 帧 payload 携带 archiveCount = 归档条目数（角标随广播即时）', () => {
    const { broker, sent } = makeBroker(archivePort(ARCHIVES))
    broker.broadcastSessionList()
    expect(sent).toHaveLength(1)
    const msg = JSON.parse(sent[0]) as ServerMessage<'config.sessions'>
    expect(msg.type).toBe('config.sessions')
    expect(msg.payload.archiveCount).toBe(3)
    expect(msg.payload.groups).toEqual([])
  })

  it('空归档目录 → archiveCount: 0（值照发——角标 0 隐藏是消费方呈现裁决，D10）', () => {
    const { broker, sent } = makeBroker(archivePort([]))
    broker.broadcastSessionList()
    const msg = JSON.parse(sent[0]) as ServerMessage<'config.sessions'>
    expect(msg.payload.archiveCount).toBe(0)
  })

  it('sendInitialState 首推的 config.sessions 段同携带（同一 buildSessionListMsg 构造）', () => {
    const { broker, sent, fakeWs } = makeBroker(archivePort(ARCHIVES))
    broker.sendInitialState(fakeWs as unknown as import('ws').WebSocket)
    const sessionMsgs = sent
      .map((s) => JSON.parse(s) as ServerMessage<'config.sessions'>)
      .filter((m) => m.type === 'config.sessions')
    expect(sessionMsgs).toHaveLength(1)
    expect(sessionMsgs[0].payload.archiveCount).toBe(3)
  })

  it('archiveService 未注入 → archiveCount 字段缺省（协议 optional，消费方按 0 隐藏角标）', () => {
    const { broker, sent } = makeBroker(undefined)
    broker.broadcastSessionList()
    const msg = JSON.parse(sent[0]) as ServerMessage<'config.sessions'>
    expect('archiveCount' in msg.payload).toBe(false)
  })
})
