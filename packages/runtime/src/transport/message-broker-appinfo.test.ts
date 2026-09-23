/**
 * ServerMessageBroker broadcastAppInfo（D8-2，perf W29，06 §3.3）测试。
 *
 * 锁定：piVersion 惰性探测的补发语义——
 * - sendInitialState 首推 app.info（piVersion 为 'unknown'）；
 * - 组合根 mutate services.appInfo 同对象（piVersion 更新）后调 broadcastAppInfo，
 *   订阅者收到第二次 app.info 广播且 payload 含新 piVersion（V2 验收：
 *   侧栏版本标签先显示应用版本，探测完成后自动补全）。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/message-broker-appinfo.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { ServerMessageBroker } from './message-broker.js'
import type { BrokerServices, ClientPool } from './message-broker.js'
import type { ServerMessage } from '@taiji/shared'

function makeBroker(appInfo: { appVersion: string; piVersion: string }) {
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
      // M4/RT-3#4：buildProviderListMsgs 读降级态标志（config.providers 帧新增字段）
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
    appInfo,
  } as unknown as BrokerServices
  const broker = new ServerMessageBroker(pool, services)
  return { broker, sent, fakeWs }
}

describe('ServerMessageBroker.broadcastAppInfo（D8-2）', () => {
  it('补发：broadcastAppInfo 广播当前 appInfo（含 mutate 后的 piVersion）', () => {
    const appInfo = { appVersion: '1.2.3', piVersion: 'unknown' }
    const { broker, sent } = makeBroker(appInfo)
    // 模拟 D8-2 流程：getPiVersion 完成后 mutate 同对象 + 补发
    appInfo.piVersion = '9.9.9'
    broker.broadcastAppInfo()
    expect(sent).toHaveLength(1)
    const msg = JSON.parse(sent[0]) as ServerMessage<'app.info'>
    expect(msg.type).toBe('app.info')
    expect(msg.payload).toEqual({ appVersion: '1.2.3', piVersion: '9.9.9' })
  })

  it('订阅者收到第二次 app.info 广播（sendInitialState 首推 unknown → mutate → 补发新值）', () => {
    const appInfo = { appVersion: '1.2.3', piVersion: 'unknown' }
    const { broker, sent, fakeWs } = makeBroker(appInfo)
    // 首推：连接时 app.info 为 unknown（listen 后立即连接，探测未完成）
    broker.sendInitialState(fakeWs as unknown as import('ws').WebSocket)
    const first = sent.map((s) => JSON.parse(s) as ServerMessage).find((m) => m.type === 'app.info')
    expect(first?.payload).toEqual({ appVersion: '1.2.3', piVersion: 'unknown' })

    // 探测完成：mutate 同对象 + 补发 → 订阅者收到第二次 app.info，piVersion 已更新
    appInfo.piVersion = '9.9.9'
    broker.broadcastAppInfo()
    const appInfoMsgs = sent.map((s) => JSON.parse(s) as ServerMessage).filter((m) => m.type === 'app.info')
    expect(appInfoMsgs).toHaveLength(2)
    expect(appInfoMsgs[1].payload).toEqual({ appVersion: '1.2.3', piVersion: '9.9.9' })
  })
})
