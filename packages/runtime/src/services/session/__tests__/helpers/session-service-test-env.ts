/**
 * SessionService 单元测试共享装配（session __tests__ 就近共享）。
 *
 * 从 fetch-current-prompt.test.ts 收敛为单源：最小 ISessionStore 全 no-op mock +
 * 构造 SessionService 测试环境（mock client / process manager / MessageBus）。
 * getEntriesImpl 的「全量建基线 → 增量命中」序列与 prompt 命令记录由本文件的
 * makeSessionServiceEnv 参数化驱动，测试断言留在各用例。
 */
import { vi } from 'vitest'

import { SessionService } from '../../session-service.js'
import { applySessionOccupancyTransition } from '../../event-interpreter.js'
import { MessageBus } from '../../../message-bus/message-bus.js'
import type { IMessageBroker } from '../../../../interfaces.js'
import type { IPiEngine, IProcessManager } from '../../../ports/pi-engine.js'
import type { ISessionStore } from '../../../ports/session.js'
import type { ServerMessage } from '@taiji/shared'

/** 最小 ISessionStore（全 no-op；SessionService 构造签名要求完整形状）。 */
export function makeSessionStore(): ISessionStore {
  return {
    scanSessions: () => [],
    // u4c（D5⑤）：ISessionStore 新增流式归一化成员（本文件不触达，no-op 满足类型）
    normalizeSessionFileStreaming: () => {},
    invalidateScanCache: () => {},
    refreshAll: () => {},
    persistSessionEnd: () => {},
    persistPresetBinding: () => {},
    persistProjectBinding: () => {},
    persistAgentBinding: () => {},
    extractSessionOutcome: () => null,
    invalidateMetaCache: () => {},
    convertHistory: () => [],
    rebuildHistoryFromEntries: () => ({ messages: [], clientUuidMap: new Map(), orphanToolResults: [] }),
    parseSessionHeader: () => null,
    readSessionHeaderLine: () => null,
    readSessionJsonlText: () => null,
    readSessionEndMeta: () => null,
    persistHandoffSidecar: () => {},
    trash: () => Promise.resolve(),
  }
}

/**
 * 构造 SessionService 测试环境。getEntriesImpl 控制 get_entries(since) 的返回序列；
 * promptImpl 可选控制命令行为（默认记录调用）。busy 用例经 initializeManagedSession
 * 委托真注册后置 isGenerating（busy 预检拒绝），须 await busyReady 后再断言。
 */
export function makeSessionServiceEnv(opts: { active?: boolean; busy?: boolean; sid: string }) {
  const broadcasts: ServerMessage[] = []
  const broker = { broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBroker
  let sinceBaseline: string | undefined
  const promptCalls: string[] = []
  const client = {
    getCommands: vi.fn(async () => []),
    getState: vi.fn(async () => ({ thinkingLevel: 'low' })),
    getSessionStats: vi.fn(async () => ({})),
    getEntries: vi.fn(async (since?: string) => {
      if (since === undefined) {
        // 全量（建基线）：一个旧 entry，leafId=leaf0
        return { data: { entries: [{ type: 'message', id: 'e0', message: { role: 'user', content: 'q' } }], leafId: 'leaf0' } }
      }
      sinceBaseline = since
      // 增量（since=leaf0）：命中现取 entry，新 leafId=leaf1
      return { data: { entries: [currentPromptEntry('PROMPT-BODY')], leafId: 'leaf1' } }
    }),
    prompt: vi.fn(async (content: string) => {
      promptCalls.push(content)
      return {}
    }),
  }
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => (opts.active === false ? undefined : (client as unknown as IPiEngine))),
  } as unknown as IProcessManager
  const bus = new MessageBus()
  const publishSpy = vi.spyOn(bus, 'publish')
  const svc = new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never,
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never,
    makeSessionStore(),
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never,
    {} as never,
    bus,
  )
  svc.setMessageBus(bus)
  let busyReady: Promise<void> | undefined
  if (opts.busy) {
    // S3 写点归位：sessions Map 所有权迁 lifecycle（svc.sessions 直戳不再可用）——经
    // initializeManagedSession 委托真注册（构造订阅接线会真跑 registerReplicatedStates
    // 播种，mock client 已覆盖 getState/getCommands/getSessionStats），注册后置 busy 标记
    // （isGenerating=true → busy 预检拒绝）。busy 用例须 await busyReady 后再断言。
    busyReady = svc.initializeManagedSession(opts.sid, client as unknown as IPiEngine, '/tmp', 't').then((session) => {
      // 经原语 'generating' 行置 busy（u3c readonly 收口；publish null 与改前直写一致零广播）——
      // 原语同时派生 isGenerating=true + turn='generating'，布尔与投影不再只写一边
      applySessionOccupancyTransition(session, null, 'generating')
    })
  }
  return { svc, bus, publishSpy, broadcasts, client, pm, promptCalls, sinceBaselineRef: () => sinceBaseline, busyReady }
}

/** 现取命令产出的 custom entry（常驻扩展 handler 写入形态）。 */
export function currentPromptEntry(fullText: string): { type: string; id: string; customType: string; data: Record<string, unknown> } {
  return {
    type: 'custom',
    id: 'csp1',
    customType: 'taiji:current-system-prompt',
    data: { fullText, charCount: fullText.length, fetchedAt: '2026-08-20T10:00:00.000Z' },
  }
}
