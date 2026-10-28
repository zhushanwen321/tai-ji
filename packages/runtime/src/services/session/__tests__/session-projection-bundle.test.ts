import { logger } from '../../../infra/logger.js';
import { getPiAgentDir } from '../../../infra/pi/pi-paths.js';
import { findBtwLineFileByLayout, findBtwLineFileByPiSessionId, findCachedSessionFileById, findScannedSessionFileById, type MainSessionScanLocateResult } from '../../../infra/pi/session-file-locator.js';
import { _resetSessionMetaCacheForTest, invalidateScanDirCache, readFirstJsonlLine, readSessionEndMeta, scanPiSessions, sessionScanDirCount } from '../../../infra/pi/session-file-utils.js';
import { _resetWarnOnceForTest } from '../../../utils/warn-once.js';
import { MessageBus, type IMessageBus } from '../../message-bus/message-bus.js';
import type { BusClient } from '../../message-bus/types.js';
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js';
import type { ISessionStore } from '../../ports/session.js';
import { BtwService } from '../btw-service.js';
import { resolveSubagentLastRound } from '../events-projection-last-round.js';
import { SessionEventProjection, initialEventProjectionSources, mergeEventProjection, parseWorkflowRunEventFileLine, projectV2Subagent, scanV2RecordEntries } from '../events-projection.js';
import { SessionHistoryReader } from '../history-rebuild-cache.js';
import { createProjectionBusView } from '../projection-bus-view.js';
import type { ReplicatedState } from '../replicated-state.js';
import { ThinkingLevelSnapshot, type ModelIdSnapshot } from '../replicated-states.config.js';
import { getRuntimeCheckpointStore, initRuntimeCheckpointStore } from '../runtime-checkpoint.js';
import { cascadeDeleteSessionContent, type SessionContentCascadeDeps } from '../session-content-cascade.js';
import { createSessionDeliveryRegistry, type SessionDeliveryDeps } from '../session-delivery-registry.js';
import { scanRecordFamilyEntriesFromSessionFile } from '../session-file-extraction.js';
import { setBtwCascadeOps } from '../session-lifecycle.js';
import { SessionStateProjection, type SessionStateProjectionDeps } from '../session-state-projection.js';
import { SessionNotFoundError, SessionStateQuery, _resetSessionStateQueryForTest, getSessionStateQuery, type SessionStateColdReadTrace, type SessionStateLiveStates } from '../session-state-query.js';
import { scanSubagentEntries } from '../subagent-extractor.js';
import { buildTraceSnapshotFromFile } from '../trace-sync.js';
import type { IManagedSessionView } from '../types.js';
import { projectV2Workflow } from '../workflow-record-projection.js';
import { cleanupDir, makeHarness as makeHarness_z2, makeTmpDir, type BtwHarness, useTmpDataDir } from './helpers/btw-harness.js';
import { createSetup } from './helpers/session-service-setup.js';
import { markerLiteral, type Message, type ServerMessage } from '@taiji/shared';
import { getAttachmentsDir } from '@taiji/shared/paths';
import { SubagentJournalEvent, type SubagentJournalReport } from '@zhushanwen/extension-protocol';
import { createDiskDeliveryStore, type DeliveryStore } from '@zhushanwen/session-delivery';
import { INITIAL_RUN_EVENT_FOLD, foldRunEventCheckpoint, type RecordCreatedEvent, type RecordEvent, type RecordSettledEvent, type WorkflowRunEvent } from '@zhushanwen/subagent-core';
import { appendFileSync, appendFileSync as fsAppend, chmodSync, existsSync, existsSync as fsExists, mkdirSync, mkdirSync as fsMkdir, mkdtempSync, readFileSync, readFileSync as fsRead, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src-services-session-__tests__-extra1.test.ts
// ======================================================================

const CWD = '/Users/x/proj'


let checkpointDir: string


let restoreDataDir: () => void


let fx: string


let h: BtwHarness


let svc: BtwService


// ======================================================================
// ← src/services/session/__tests__/history-rebuild-btw-offline.test.ts
// ======================================================================

let dir: string


/** pi session message entry（jsonl 行）：type:'message' + message 体（turn 边界 = role:'user'）。 */
function messageEntry(id: string, role: 'user' | 'assistant', text: string): string {
  return JSON.stringify({
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-09-23T00:00:00.000Z',
    message: { role, content: [{ type: 'text', text }], timestamp: Date.now() },
  })
}


/**
 * fake convertHistory：entry.message 体 → Message（text parts 拼接为 content，供断言
 * 「文件里的内容被回放」）。透传 role，逐条编 id。
 */
function fakeConvertHistory(raw: unknown[]): Message[] {
  return raw.map((m, i) => {
    const body = m as { role?: string; content?: unknown }
    const text = Array.isArray(body.content)
      ? body.content
          .map((c) => (typeof c === 'object' && c !== null && (c as { text?: unknown }).text != null ? String((c as { text: unknown }).text) : ''))
          .join('')
      : String(body.content ?? '')
    return { id: `m-${i}`, role: body.role, content: text, status: 'complete', timestamp: 1 } as Message
  })
}


function makeOfflineReader(resolveBtwThreadFile?: (sessionId: string) => string | undefined) {
  const resolve = vi.fn(resolveBtwThreadFile)
  const sessionStore = {
    // 非 btw 线（主会话）回归路径走通用链 getHistoryTailFromFile → scanSessions
    scanSessions: vi.fn(() => [] as Array<{ id: string; filePath: string }>),
    convertHistory: vi.fn((raw: unknown[]) => fakeConvertHistory(raw)),
  } as unknown as ISessionStore
  const reader = new SessionHistoryReader({
    pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager,
    sessionStore,
    resolveBtwThreadFile: resolve,
  })
  return { reader, resolve, sessionStore }
}


/** 写线会话文件并返回解析器 fake（按线 session id 查注册表 → 文件路径）。 */
function seedThreadFile(name: string, lines: string[]): { registry: (sessionId: string) => string | undefined } {
  const file = join(dir, name)
  writeFileSync(file, lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf-8')
  return { registry: (sessionId) => (sessionId === name ? file : undefined) }
}


// ======================================================================
// ← src/services/session/__tests__/session-content-cascade-archive.test.ts
// ======================================================================

const SID = 'main-purge01'


const SA_ID = 'sa-ref1'


const registeredLine = (id: string): string =>
  JSON.stringify({ type: 'custom', customType: 'subagent-record', data: { v: 2, kind: 'registered', id, rootSessionId: 'root-x', depth: 0, startedAt: 1 } })


const settledLine = (id: string, sessionFile: string): string =>
  JSON.stringify({ type: 'custom', customType: 'subagent-record', data: { v: 2, kind: 'settled', id, status: 'idle', stopReason: 'end_turn', endedAt: 2, turns: 1, totalTokens: 10, sessionFile } })


interface Pool {  // oe-exempt:20261020:wip:归档域测试 fixture 形态类型，单实现为当前形态——30 天窗口内联或等第二变体
  root: string
  storeRoot: string
  agentDir: string
  sessionsRoot: string
  subagentsDir: string
  treeDir: string
  /** 存活会话 B 的主文件（sessions 池——引用并集扫描对象）。 */
  bMain: string
  /** A 的归档明文（引用枚举源）。 */
  aArchivePlain: string
  deps: SessionContentCascadeDeps
  warnings: string[]
}


const cleanupDirs: string[] = []


function makePool(aPlainLines: string[], bLines: string[]): Pool {
  const root = mkdtempSync(join(tmpdir(), 'taiji-cascade-archive-'))
  cleanupDirs.push(root)
  const storeRoot = join(root, 'ext-sessions')
  const agentDir = join(root, 'agent')
  const sessionsRoot = join(agentDir, 'sessions')
  const bucket = join(sessionsRoot, '--proj-cascade-a--')
  const archiveBucket = join(agentDir, 'archive', '--proj-cascade-a--')
  mkdirSync(bucket, { recursive: true })
  mkdirSync(archiveBucket, { recursive: true })
  mkdirSync(storeRoot, { recursive: true })

  const subagentsDir = join(storeRoot, SID, 'subagents', 'sessions')
  mkdirSync(subagentsDir, { recursive: true })
  const saFile = join(subagentsDir, `2026-01-01T00-00-00-000Z_${SA_ID}.jsonl`)
  writeFileSync(saFile, '{"type":"session"}\n')

  const bMain = join(bucket, '2026-10-19T00-00-00-000Z_sess-bbbb.jsonl')
  writeFileSync(bMain, `${bLines.join('\n')}\n`)
  const aArchivePlain = join(archiveBucket, '2026-10-20T00-00-00-000Z_main-purge01.jsonl')
  writeFileSync(aArchivePlain, `${aPlainLines.join('\n')}\n`)

  const warnings: string[] = []
  return {
    root, storeRoot, agentDir, sessionsRoot,
    subagentsDir: join(storeRoot, SID, 'subagents'),
    treeDir: join(storeRoot, SID),
    bMain, aArchivePlain, warnings,
    deps: {
      trash: async () => { void 0 },
      trashSessionTree: async (dir) => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) },
      purgeMainSidecars: () => { void 0 },
      reapBackgroundTasks: async () => { void 0 },
      warn: (m) => { warnings.push(m) },
    },
  }
}


/** purge 形态输入：主文件恒不在 sessions/（scanned 语义）+ 归档目录内枚举源。 */
function purgeInput(p: Pool, enumerationSource?: string) {
  return {
    sessionId: SID,
    sessionFilePath: join(p.sessionsRoot, '--proj-cascade-a--', '2026-10-20T00-00-00-000Z_main-purge01.jsonl'),
    agentDir: p.agentDir,
    sessionsRoot: p.sessionsRoot,
    sessionStoreRoot: p.storeRoot,
    skipIfMainFileMissing: false,
    ...(enumerationSource !== undefined ? { referenceEnumerationSource: enumerationSource } : {}),
  }
}


// ======================================================================
// ← src/services/session/__tests__/delivery-outbox-crash-recovery.test.ts
// ======================================================================

/** 短轮询等待（谓词命中即返；超时 2s 显式失败，防静默悬挂）。 */
async function until<T>(predicate: () => T | undefined | null, label: string): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = predicate()
    if (value !== undefined && value !== null) return value
    if (Date.now() - start > 2_000) throw new Error(`until timeout: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}


/** 固定 uuid（裸标记判据只认 `u-<uuid>` 形态）；出站文本尾附标记由 registry 构造。 */
const UUID_A = 'u-aaaaaaa1-0000-4000-8000-000000000001'


const UUID_B = 'u-bbbbbbb2-0000-4000-8000-000000000002'


const UUID_C = 'u-ccccccc3-0000-4000-8000-000000000003'


const UUID_D = 'u-ddddddd4-0000-4000-8000-000000000004'


const BARE_A = UUID_A.slice(2)


const BARE_B = UUID_B.slice(2)


const BARE_C = UUID_C.slice(2)


const TEXT_A = 'undelivered crash msg'


const TEXT_B = 'already delivered msg'


const TEXT_C = 'revoke after restart msg'


/** MockPiClient：registry 消费的 IPiEngine 窄接口替身（prompt / onEvent / getEntries / getCommands / clearQueue）。 */
class MockPiClient {
  eventListener: ((event: unknown) => void) | undefined
  transcriptEntries: unknown[] = []
  cleared: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] }
  promptCalls: Array<{ text: string; behavior?: string }> = []

  async prompt(text: string, _images?: unknown, streamingBehavior?: 'steer' | 'followUp'): Promise<unknown> {
    this.promptCalls.push({ text, ...(streamingBehavior !== undefined ? { behavior: streamingBehavior } : {}) })
    return { data: {} }
  }

  async getEntries(): Promise<unknown> {
    return { data: { entries: this.transcriptEntries } }
  }

  async getCommands(): Promise<unknown[]> {
    return []
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.eventListener = listener
    return () => {}
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return this.cleared
  }

  /** 派 user message_end（送达回执：文本命中裸标记 → delivered 终局）。 */
  emitMessageEnd(text: string): void {
    this.eventListener?.({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text }] },
    })
  }
}


/** registry 内存 view（holdReason/lane 判定宿主；occupancy 缺省 = idle）。 */
function makeView(id: string): IManagedSessionView {
  return {
    id,
    cwd: '/tmp/fake-cwd',
    label: id,
    modelId: 'test-model',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    tokenCount: 0,
    inputTokens: 0,
    bashRunToken: undefined,
  }
}


/** 装配套件：mkdtemp outbox 目录 + 可换装的 client 表 + 真 store 工厂。 */
function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-outbox-crash-'))
  const clients = new Map<string, MockPiClient>()
  const views = new Map<string, IManagedSessionView>()
  const deps: SessionDeliveryDeps = {
    getSession: (sid) => views.get(sid),
    ensureActive: async (sid) => {
      const client = clients.get(sid)
      if (!client) throw new Error(`mock client missing for ${sid}`)
      return client as unknown as IPiEngine
    },
    subscribeAgentSettled: () => () => {},
    recordWorkspace: () => {},
    getMessageBus: () => null,
    createDeliveryStore: (sid) =>
      createDiskDeliveryStore({
        fs: { existsSync: fsExists, mkdirSync: fsMkdir, readFileSync: fsRead, appendFileSync: fsAppend },
        dir,
        file: join(dir, `${sid}.jsonl`),
      }),
  }
  const viewOf = (sid: string): IManagedSessionView => {
    let view = views.get(sid)
    if (!view) {
      view = makeView(sid)
      views.set(sid, view)
    }
    return view
  }
  return {
    dir,
    deps,
    clients,
    viewOf,
    /** transcript user entry 构造（已送达证据：文本 + 尾附裸标记，与出站形态同构）。 */
    userEntry(text: string): unknown {
      return { type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } }
    },
    readFile(): string {
      return fsRead(join(dir, 's1.jsonl'), 'utf8')
    },
    /** 独立 store 实例直读磁盘（重启语义：不经 registry）。 */
  }
}


type Harness = ReturnType<typeof makeHarness>


/** 便捷断言：磁盘文件含指定行型 + id。 */
function expectLine(file: string, lineType: string, id: string): void {
  expect(file).toContain(`"t":"${lineType}"`)
  expect(file).toContain(id)
}


// ======================================================================
// ← src/services/session/__tests__/extractor-warn.test.ts
// ======================================================================

let dir_m2: string


let warnSpy: MockInstance<typeof console.warn>

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('src-services-session-__tests__-extra1', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('btw-persist-reload', () => {
beforeAll(() => {
  checkpointDir = mkdtempSync(join(tmpdir(), 'btw-persist-checkpoint-'))
  initRuntimeCheckpointStore({ dir: checkpointDir })
})
afterAll(() => {
  rmSync(checkpointDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
beforeEach(() => {
  restoreDataDir = useTmpDataDir()
  fx = makeTmpDir()
  h = makeHarness_z2()
  svc = new BtwService(h.deps)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  setBtwCascadeOps(null)
  svc.dispose()
  cleanupDir(fx)
  restoreDataDir()
  vi.restoreAllMocks()
})
describe('checkpoint 豁免（P-persist 重启半边：不为 btw 建档 → 重启不误 reattach）', () => {
  it('registerSession(btw 线) 后 checkpoint 无该条目；普通 session 照常入档（订阅者其余保留）', async () => {
    const { service } = createSetup()
    const lineSid = `linepi-ckpt-${Date.now()}`
    const mainSid = `main-ckpt-${Date.now()}`
    // W4a：checkpoint 豁免判别器 = registry 成员查询（btwCascadeOps.getLine，键 = 线
    // session id = piId）——线先经 BtwService.createLine 入册，再走 registerSession。
    setBtwCascadeOps(svc)
    h.deps.resolveMainSessionFile = vi.fn(() => undefined)
    h.state = { sessionId: lineSid, sessionFile: join(fx, `${lineSid}.jsonl`) }
    const line = await svc.createLine({ mainSid: 'main-ckpt-owner', cwd: CWD })

    await service.initializeManagedSession(line.sessionId, {} as IPiEngine, CWD, 'line', undefined, undefined, undefined, undefined, undefined, undefined, 'btw')
    await service.initializeManagedSession(mainSid, {} as IPiEngine, CWD, 'main')

    const ids = getRuntimeCheckpointStore().read()?.sessions.map(s => s.piSessionId) ?? []
    expect(ids).not.toContain(line.sessionId) // 豁免生效：reattach 编排结构上看不见 btw 线
    expect(ids).toContain(mainSid) // 对照：主会话建档不受影响（D3 语义保持）

    // 卸载清理（避免条目跨用例累积噪音）
    getRuntimeCheckpointStore().removeSession(mainSid)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('history-rebuild-btw-offline', () => {
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'btw-offline-tail-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('btw 线离线尾读（btw 面解析路径；W4a 判别器 = 注册表成员查询）', () => {
  it('注册表命中 + 文件在场：entries 经同一尾读链回放（2 turns）', async () => {
    const { registry } = seedThreadFile('line-a', [
      messageEntry('e1', 'user', 'turn 1 q'),
      messageEntry('e2', 'assistant', 'turn 1 a'),
      messageEntry('e3', 'user', 'turn 2 q'),
      messageEntry('e4', 'assistant', 'turn 2 a'),
    ])
    const { reader, resolve } = makeOfflineReader(registry)
    const result = await reader.getHistory('line-a')
    expect(resolve).toHaveBeenCalledWith('line-a') // 判别器即成员查询（W4a）
    expect(result.messages.map((m) => m.content)).toEqual(['turn 1 q', 'turn 1 a', 'turn 2 q', 'turn 2 a'])
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(result.truncated).toBe(false)
    expect(result.loadedTurns).toBe(2)
    expect(result.totalTurnsEstimate).toBe(2)
  })

  it('注册表命中但文件缺失：空页 + warn（含线 session id 与期望路径）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const missing = join(dir, 'never-flushed.jsonl') // 故意不写盘
      const { reader } = makeOfflineReader(() => missing)
      const result = await reader.getHistory('never-flushed')
      expect(result).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
      const btwWarns = warnSpy.mock.calls.map((args) => args.join(' ')).filter((s) => s.includes('btw line session file missing'))
      expect(btwWarns).toHaveLength(1)
      expect(btwWarns[0]).toContain('never-flushed')
      expect(btwWarns[0]).toContain(missing)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('判别器未命中（未注入解析 / 无条目）：走通用链空页，不炸（W4a 后与主会话不可区分）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { reader, resolve, sessionStore } = makeOfflineReader(undefined)
      const result = await reader.getHistory('unknown-line')
      expect(result.messages).toEqual([])
      expect(resolve).toHaveBeenCalledTimes(1) // 判别器即成员查询——调用一次、返 undefined
      expect(sessionStore.scanSessions).toHaveBeenCalledWith({ force: true }) // 落通用链
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('合法空线（文件在场 0 字节）：空页且不触发 btw 文件缺失 warn（与异常态区分）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { registry } = seedThreadFile('empty-line', [])
      const { reader } = makeOfflineReader(registry)
      const result = await reader.getHistory('empty-line')
      expect(result).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
      expect(warnSpy.mock.calls.map((args) => args.join(' ')).some((s) => s.includes('btw line session file missing'))).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('cursor 游标翻页（离线 btw 线）：同一解析路径，返回锚点前最近窗口', async () => {
    const { registry } = seedThreadFile('line-cursor', [
      messageEntry('e1', 'user', 'turn 1'),
      messageEntry('e2', 'assistant', 'reply 1'),
      messageEntry('e3', 'user', 'turn 2'),
      messageEntry('e4', 'assistant', 'reply 2'),
    ])
    const { reader } = makeOfflineReader(registry)
    const page = await reader.getHistory('line-cursor', { cursor: 'e3', limitTurns: 2 })
    // e3 是最新 turn 起点：锚前窗口 = 第 1 个 turn（e1+e2），锚所在 turn 不返回
    expect(page.messages.map((m) => m.content)).toEqual(['turn 1', 'reply 1'])
    expect(page.loadedTurns).toBe(1)
    expect(page.truncated).toBe(false)
  })
})
describe('附着 btw 线 RPC 失败降级的中断判定门禁（U8 tailReadOffline 剥除门禁）', () => {
  /** 附着态 reader：pm.getClient(线 id) 返回 getEntries 恒抛错的 fake client（活跃线 RPC 失败 → getLatestWindow catch → tailReadOffline 缺省关闭判定） */
  function makeAttachedReader(registry: (sessionId: string) => string | undefined) {
    const resolve = vi.fn(registry)
    const sessionStore = {
      scanSessions: vi.fn(() => [] as Array<{ id: string; filePath: string }>),
      convertHistory: vi.fn((raw: unknown[]) => fakeConvertHistory(raw)),
    } as unknown as ISessionStore
    const client = {
      getEntries: vi.fn(() => Promise.reject(new Error('rpc down'))),
    }
    const reader = new SessionHistoryReader({
      pm: { getClient: vi.fn(() => client) } as unknown as IProcessManager,
      sessionStore,
      resolveBtwThreadFile: resolve,
    })
    return { reader, client }
  }

  it('附着 btw 线 RPC 失败降级尾读：interrupted 不出场（判定前提「会话未附着」不成立——线尾 user entry 不得误标活线）', async () => {
    // 线文件尾 = user entry（中断形态）：若降级路径透传 interrupted，附着中的活线被误标
    const { registry } = seedThreadFile('attached-line', [
      messageEntry('e1', 'assistant', 'reply'),
      messageEntry('e2', 'user', 'generating'),
    ])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { reader, client } = makeAttachedReader(registry)
      const result = await reader.getHistory('attached-line')
      expect(client.getEntries).toHaveBeenCalled() // 确认走的是附着 RPC 降级链，非离线分支
      expect(result.messages.map((m) => m.content)).toEqual(['reply', 'generating'])
      // 剥除语义 = 值 undefined（消费方按 !== undefined 判「无判定」），非键删除
      expect(result.interrupted).toBeUndefined()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('对照：未附着（离线）同形态线文件中断判定照常出场（门禁只拦附着降级，不废 btw 判定链）', async () => {
    const { registry } = seedThreadFile('offline-line', [
      messageEntry('e1', 'assistant', 'reply'),
      messageEntry('e2', 'user', 'interrupted tail'),
    ])
    const { reader } = makeOfflineReader(registry)
    const result = await reader.getHistory('offline-line')
    expect(result.interrupted).toBe(true)
  })
})
describe('非 btw 线回归路径（原行为不变）', () => {
  it('普通 sid 离线尾读：判别器未命中即走通用链（scanSessions miss → 静默空）', async () => {
    // 生产注入语义：非线 id 查注册表 miss → undefined → 通用链（判别器调用一次）
    const { reader, resolve, sessionStore } = makeOfflineReader(() => undefined)
    const result = await reader.getHistory('plain-session-id')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(sessionStore.scanSessions).toHaveBeenCalledWith({ force: true })
    expect(result).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
  })

  it('subagent 三段式虚拟 id 同样不走 btw 解析路径（判别器 miss → 通用链）', async () => {
    const { reader, sessionStore } = makeOfflineReader(() => undefined)
    await reader.getHistory('subagent:main-1:sub-1')
    expect(sessionStore.scanSessions).toHaveBeenCalledWith({ force: true })
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-content-cascade-archive', () => {
afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
describe('① 缺省形态：delete scanned 分支现状语义回归锚', () => {
  it('不传 referenceEnumerationSource + 主文件缺失 → 段 2 跳过、referenceScan=skipped（引用保护不进入）', async () => {
    const p = makePool([registeredLine(SA_ID)], [settledLine(SA_ID, '/abs/sa.jsonl')])

    const result = await cascadeDeleteSessionContent(purgeInput(p), p.deps)

    // 现状语义（session-content-cascade.ts:203 guard 原样）：主文件缺失 + 缺省形态 →
    // 段 2 跳过（不枚举、不并集、不 keep-all），树照删。
    expect(result.referenceScan).toBe('skipped')
    expect(result.subagentFamiliesResidual).toBe(0)
    expect(existsSync(p.treeDir)).toBe(false)
  })
})
describe('② 显式枚举源不可读：无条件进段 2 → 读失败 → keep-all 整域保留', () => {
  it('哨兵缺失路径（sha256 校验不过的 purge 形态）→ failed → subagents 整域暂存回迁保留', async () => {
    const p = makePool([registeredLine(SA_ID)], [settledLine(SA_ID, '/abs/sa.jsonl')])
    const sentinel = join(p.agentDir, 'archive', '--proj-cascade-a--', 'nonexistent.missing')

    const result = await cascadeDeleteSessionContent(purgeInput(p, sentinel), p.deps)

    // 显式形态红线：不得因源不存在而预检跳过段 2——枚举器 readFileSync 失败承载
    // failed → keep-all（planKeepWholeSubagentsDir 整域保留 → 树删后回迁）。
    expect(result.referenceScan).toBe('failed')
    expect(result.subagentFamiliesResidual).toBe(1)
    expect(result.failures.length).toBeGreaterThan(0)
    // 整域保留的残树：subagents 目录被暂存回迁重建（树已整树软删 + 族拷回）。
    expect(existsSync(join(p.subagentsDir, 'sessions', `2026-01-01T00-00-00-000Z_${SA_ID}.jsonl`))).toBe(true)
  })

  it('显式源存在且可读 → 正常引用保护：被 B 引用的族保留、未引用族随树回收', async () => {
    const p = makePool(['{"type":"session"}'], ['{"type":"session"}'])
    // 真实绝对路径写入两侧（B 的引用锚与 A 归档明文的锚一致——settled.sessionFile）。
    const absSa = join(p.subagentsDir, 'sessions', `2026-01-01T00-00-00-000Z_${SA_ID}.jsonl`)
    writeFileSync(p.aArchivePlain, `${[registeredLine(SA_ID), settledLine(SA_ID, absSa)].join('\n')}\n`)
    writeFileSync(p.bMain, `${settledLine(SA_ID, absSa)}\n`)

    const result = await cascadeDeleteSessionContent(purgeInput(p, p.aArchivePlain), p.deps)

    expect(result.referenceScan).toBe('ok')
    // 被 B 引用 → 族保留 A 树残留（fork 回退暂存回迁），B 的绝对路径引用保持可解析。
    expect(result.subagentFamiliesResidual).toBe(1)
    expect(existsSync(absSa)).toBe(true)
  })
})
describe('③ purge 重试中间态：幂等零报错 + keep-all 对已删残树为安全 no-op', () => {
  it('显式源缺失 + 残树含被引用族 → 重试幂等达终态（族保留、不抛、树删后回迁）', async () => {
    // 中间态构造：第一次 purge 的 keep-all 已回迁被引用族（残树只剩该族），簿记仍在、
    // 压缩体已移除（重试时枚举源 = 哨兵缺失路径）。
    const p = makePool([registeredLine(SA_ID)], [settledLine(SA_ID, '/abs/sa.jsonl')])
    const sentinel = join(p.agentDir, 'archive', '--proj-cascade-a--', 'nonexistent.missing')

    const first = await cascadeDeleteSessionContent(purgeInput(p, sentinel), p.deps)
    expect(first.referenceScan).toBe('failed')
    expect(existsSync(p.subagentsDir)).toBe(true) // keep-all 回迁残树

    // 重试（同输入——幂等）：再次 keep-all 对「只剩被引用族的残树」照常回迁，零报错不抛。
    const second = await cascadeDeleteSessionContent(purgeInput(p, sentinel), p.deps)
    expect(second.referenceScan).toBe('failed')
    expect(existsSync(join(p.subagentsDir, 'sessions', `2026-01-01T00-00-00-000Z_${SA_ID}.jsonl`))).toBe(true)
  })

  it('keep-all 对不存在的残树为安全 no-op（planKeepWholeSubagentsDir 返回 null = 零动作，不抛）', async () => {
    const p = makePool([registeredLine(SA_ID)], [settledLine(SA_ID, '/abs/sa.jsonl')])
    const sentinel = join(p.agentDir, 'archive', '--proj-cascade-a--', 'nonexistent.missing')
    // 预删残树（第一次 purge 已把树清干净、第二次重试形态）。
    rmSync(p.treeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })

    const result = await cascadeDeleteSessionContent(purgeInput(p, sentinel), p.deps)

    // 树不在 + 枚举失败 → keep-all 计划对不存在目录返回 null = 零动作（无暂存目录
    // 残留、不抛）；sessionTreeTrashed=false（无树可删）。
    expect(result.referenceScan).toBe('failed')
    expect(result.sessionTreeTrashed).toBe(false)
    expect(result.subagentFamiliesResidual).toBe(0)
    expect(existsSync(p.treeDir)).toBe(false)
    // 暂存目录不残留（planKeepWholeSubagentsDir null → stageFamilies 未建目录）。
    const stagingLeftovers = existsSync(p.storeRoot)
      ? readdirSync(p.storeRoot).filter((n) => n.startsWith('.deletion-staging-'))
      : []
    expect(stagingLeftovers).toEqual([])
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('delivery-outbox-crash-recovery', () => {
describe('磁盘 outbox 崩溃恢复（波 4，mock 全链）', () => {
  const harnesses: Harness[] = []
  function harness(): Harness {
    const h = makeHarness()
    harnesses.push(h)
    return h
  }
  afterEach(() => {
    for (const h of harnesses.splice(0)) rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('场景 1 崩溃恢复：受理落盘 → 重启 → 未送达重新入队、已送达只记账不重投', async () => {
    const h = harness()
    h.viewOf('s1')
    const client1 = new MockPiClient()
    h.clients.set('s1', client1)
    const r1 = createSessionDeliveryRegistry(h.deps)

    // 受理即落盘（内核 persistBeforeAccept 在 sendChecked 同步段）
    r1.submit('s1', { content: TEXT_A, clientUuid: UUID_A })
    r1.submit('s1', { content: TEXT_B, clientUuid: UUID_B })
    const persisted = until(() => (h.readFile().match(/"t":"record"/g) ?? []).length >= 2 ? h.readFile() : undefined, 'two record lines')
    await persisted
    // 两条都受理出站（on-accept：mock prompt 立即受理 → in-flight，未送达即「崩溃」）
    // 谓词内每次重取 entries（视图为调用时点快照，闭包持有会冻结旧态）
    await until(
      () => ((r1.entries('s1')?.active.filter((e) => e.state === 'in-flight').length ?? 0) === 2 ? true : undefined),
      'both in-flight',
    )
    expect(client1.promptCalls.length).toBe(2)
    r1.disposeAll()

    // 「重启」：新 registry + 新 pi 进程；transcript：A 未进（未送达）、B 已进（已送达）
    const client2 = new MockPiClient()
    client2.transcriptEntries = [h.userEntry(`${TEXT_B}\n${markerLiteral(BARE_B)}`)]
    h.clients.set('s1', client2)
    const r2 = createSessionDeliveryRegistry(h.deps)
    r2.getOrCreateDelivery('s1') // = reattach 包装的 ensureDeliveryRuntime
    await r2.reconcile('s1', 'pi-restored') // restore 后对账 → outbox 重放

    // A：未送达 → 重新入队（on-accept 立即出站 → in-flight）
    await until(
      () => (r2.entries('s1')?.active.some((e) => e.id === UUID_A && e.state === 'in-flight') ? true : undefined),
      'A requeued',
    )
    // B：已送达 → 不重投（active 无 B、tombstones delivered）
    const r2Full = r2.entries('s1')
    expect(r2Full?.active.some((e) => e.id === UUID_B)).toBe(false)
    expect(r2Full?.tombstones.some((t) => t.id === UUID_B && t.state === 'delivered')).toBe(true)
    // 重投证据：重启后 prompt 恰 1 次且为 A 文本（B 零投递）
    expect(client2.promptCalls.length).toBe(1)
    expect(client2.promptCalls[0]?.text).toContain(TEXT_A)
  })

  it('场景 2 ack 终局行：message_end 送达回执写磁盘终局行，重启后不复活', async () => {
    const h = harness()
    h.viewOf('s1')
    const client1 = new MockPiClient()
    h.clients.set('s1', client1)
    const r1 = createSessionDeliveryRegistry(h.deps)
    r1.submit('s1', { content: TEXT_A, clientUuid: UUID_A })
    await until(
      () => (r1.entries('s1')?.active.some((e) => e.id === UUID_A && e.state === 'in-flight') ? true : undefined),
      'A in-flight',
    )

    // 送达回执：message_end(user) 命中裸标记 → delivered 终局 → store.ack
    client1.emitMessageEnd(`${TEXT_A}\n${markerLiteral(BARE_A)}`)
    await until(
      () => (r1.entries('s1')?.tombstones.some((t) => t.id === UUID_A && t.state === 'delivered') ? true : undefined),
      'A delivered',
    )
    expectLine(h.readFile(), 'ack', UUID_A)

    // 重启语义：独立 store 实例读同一文件——终局行挡复活
    const revived: DeliveryStore = createDiskDeliveryStore({
      fs: { existsSync: fsExists, mkdirSync: fsMkdir, readFileSync: fsRead, appendFileSync: fsAppend },
      dir: h.dir,
      file: join(h.dir, 's1.jsonl'),
    })
    expect(revived.loadUndelivered().map((r) => r.id)).toEqual([])
    expect(revived.hasTerminal(UUID_A)).toBe(true)
  })

  it('场景 3 撤销 cancelled 终局 + segments 回填：重启后撤销返回磁盘回填的原始 segments', async () => {
    const h = harness()
    h.viewOf('s1')
    const client1 = new MockPiClient()
    h.clients.set('s1', client1)
    const r1 = createSessionDeliveryRegistry(h.deps)
    r1.submit('s1', { content: TEXT_C, clientUuid: UUID_C })
    await until(
      () => (r1.entries('s1')?.active.some((e) => e.id === UUID_C && e.state === 'in-flight') ? true : undefined),
      'C in-flight',
    )
    // segments 快照补记（meta 行跨重启存活）
    r1.attachSegments('s1', UUID_C, [
      { type: 'text', text: 'seg-alpha' },
      { type: 'image', id: 'img-1', path: '/tmp/seg.png', fileName: 'seg.png', displayName: 'seg' },
    ])
    expectLine(h.readFile(), 'meta', UUID_C)
    // 不撤销直接「崩溃」（in-flight 留磁盘）
    r1.disposeAll()

    // 重启：transcript 空（未送达）→ 重放重入队
    const client2 = new MockPiClient()
    h.clients.set('s1', client2)
    const r2 = createSessionDeliveryRegistry(h.deps)
    r2.getOrCreateDelivery('s1')
    await r2.reconcile('s1', 'pi-restored')
    await until(
      () => (r2.entries('s1')?.active.some((e) => e.id === UUID_C && e.state === 'in-flight') ? true : undefined),
      'C requeued',
    )

    // 重启后撤销：clear_queue 收回路径 → cancelled 终局 + 磁盘回填的 segments 随全文返回
    const outboundText = `${TEXT_C}\n${markerLiteral(BARE_C)}`
    client2.cleared = { steering: [outboundText], followUp: [] }
    const outcome = await r2.cancel('s1', UUID_C)
    expect(outcome.cancelled).toBe(true)
    expect(outcome.content).toBe(outboundText)
    expect(outcome.segments).toEqual([
      { type: 'text', text: 'seg-alpha' },
      { type: 'image', id: 'img-1', path: '/tmp/seg.png', fileName: 'seg.png', displayName: 'seg' },
    ])
    expectLine(h.readFile(), 'ack', UUID_C)

    // cancelled 终局挡复活：再次重启 → 重放后 active 无 C
    const client3 = new MockPiClient()
    h.clients.set('s1', client3)
    const r3 = createSessionDeliveryRegistry(h.deps)
    r3.getOrCreateDelivery('s1')
    await r3.reconcile('s1', 'pi-restored')
    expect(r3.entries('s1')?.active.some((e) => e.id === UUID_C)).toBe(false)
    expect(client3.promptCalls.length).toBe(0)
  })

  it('场景 4 文件损坏容错：损坏行跳过，不炸内核判重播种与重放', async () => {
    const h = harness()
    // 手写损坏文件：合法 record 行 + 坏 JSON 半行 + 纯垃圾行
    fsAppend(
      join(h.dir, 's1.jsonl'),
      [
        JSON.stringify({
          t: 'record',
          r: {
            id: UUID_D,
            lane: 'direct',
            payload: { kind: 'text', content: `${TEXT_A}\n${markerLiteral(UUID_D.slice(2))}` },
            intent: 'interrupt-at-turn-boundary',
            recordedAt: 1,
            receiptAnchor: 'marker',
          },
        }),
        '{"t":"record","r":{"id":"trunca', // 崩溃写入的中途半行
        'garbage-not-json',
      ].join('\n') + '\n',
    )
    h.viewOf('s1')
    const client1 = new MockPiClient()
    h.clients.set('s1', client1)
    const r1 = createSessionDeliveryRegistry(h.deps)
    // 内核构造（loadTerminalIds 播种）不炸
    expect(() => r1.getOrCreateDelivery('s1')).not.toThrow()
    // 重放只处理合法行（UUID_D 重入队），坏行静默跳过
    await r1.reconcile('s1', 'pi-restored')
    await until(
      () => (r1.entries('s1')?.active.some((e) => e.id === UUID_D) ? true : undefined),
      'D requeued from corrupted file',
    )
    expect(r1.entries('s1')?.active.some((e) => e.id === 'trunca')).toBe(false)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('extractor-warn', () => {
beforeEach(() => {
  dir_m2 = mkdtempSync(join(tmpdir(), 'extractor-warn-rt5-'))
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  _resetWarnOnceForTest()
})
afterEach(() => {
  warnSpy.mockRestore()
  rmSync(dir_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('history-rebuild-cache：segments.json sidecar 降级 warn（RT-5#6）', () => {
  it('sidecar 结构损坏（entries 非数组）→ 全降级占位文本前 warn（含路径）', async () => {
    const sessionId = 'warn-rt5-s1'
    // getAttachmentsDir(sessionId) 落在测试固定为的 tmp dataDir（白名单内），mkdtemp 额外
    // 证据目录由 fixture 语义自持：直接写坏 sidecar
    const sidecarDir = getAttachmentsDir(sessionId)
    mkdirSync(sidecarDir, { recursive: true })
    const sidecarPath = join(sidecarDir, 'segments.json')
    writeFileSync(sidecarPath, JSON.stringify({ entries: 'not-an-array' }), 'utf-8')

    const client = {
      getEntries: vi.fn(async () => ({
        data: { entries: [{ type: 'message', id: 'e1', parentId: null, timestamp: '2026-01-01T00:00:00Z' }], leafId: 'e1' },
      })),
    }
    const sessionStore = {
      scanSessions: vi.fn(() => []),
      rebuildHistoryFromEntries: vi.fn(() => ({ messages: [], orphanToolResults: [] })),
    } as unknown as ISessionStore
    const reader = new SessionHistoryReader({
      pm: { getClient: vi.fn(() => client) } as unknown as IProcessManager,
      sessionStore,
    })

    const result = await reader.getHistory(sessionId)
    expect(result.messages).toEqual([]) // 降级不炸重建
    const msg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('segments.json sidecar'))
    expect(msg).toBeDefined()
    expect(msg).toContain('结构损坏')
    expect(msg).toContain(sidecarPath)
  })
})
describe('subagent-extractor：session 目录读失败 warn（RT-5#6）', () => {
  it('subagent session 目录不可读（EACCES）→ warn 含目录，历史条目仍产出（sessionFile 为 null）', () => {
    const mainCwd = join(dir_m2, 'main-cwd')
    // 预置 <piAgentDir>/subagents/--<encoded>--/sessions 目录并锁权限 → readdirSync EACCES
    const encoded = '--' + mainCwd.replace(/^\//, '').replace(/[/\\:]/g, '-') + '--'
    const sessionsDir = join(getPiAgentDir(), 'subagents', encoded, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    chmodSync(sessionsDir, 0o000)

    // legacy entries 最小链：session(cwd) + assistant(subagent toolCall) + toolResult(bgResponse)
    const entries: Array<Record<string, unknown>> = [
      { type: 'session', cwd: mainCwd },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', name: 'subagent', id: 'tc-1', arguments: { action: 'start', startParam: { task: 't' } } },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'subagent',
          toolCallId: 'tc-1',
          content: [{ type: 'text', text: JSON.stringify({ bgResponse: { status: 'completed' }, subagentId: 'sub-1' }) }],
        },
      },
    ]

    try {
      const records = scanSubagentEntries(entries)
      expect(records).toHaveLength(1) // 降级不炸提取
      expect(records[0]!.sessionFile).toBe(null)
      const msg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('subagent session dir unreadable'))
      expect(msg).toBeDefined()
      expect(msg).toContain(sessionsDir)
    } finally {
      chmodSync(sessionsDir, 0o755) // 恢复权限；目录在测试 dataDir 下由 guard 管辖，恢复后可清理
    }
  })
})
});
});

// ======================================================================
// ← projection-bundle.test.ts
// ======================================================================

/**
 * 事件派生视图直测（W1 [D6] runtime 读侧换源）：双源单点合并仲裁（事件源胜出 /
 * 窗外条目兜底 / v1 冻结定界）+ 会话文件流式扫描（冷启动 entry 源）+ 有状态派生视图
 * （tail 目录 watcher 冷启动/增量/dispose）。
 *
 * fixture 全部落 mkdtemp 临时目录（mkdtempSync 自建自删，rmSync 全参数）；
 * record 事件文件/run journal 形态对齐 u0 契约（record-events.ts 六类词表 +
 * 首行头行 / run-events.ts 七类词表）。测试框架：vitest + fake timers（tailer
 * 周期复查注入短值驱动确定性增量）。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/events-projection.test.ts
 */


// ── fixture 构造（u0 契约形态）────────────────────────────────

function recordEventLine(event: RecordEvent): string {
  return JSON.stringify(event)
}


function recordJournalLines(id: string, events: RecordEvent[]): string[] {
  return [JSON.stringify({ type: 'record-events', id }), ...events.map(recordEventLine)]
}


function createdEvent(id: string, seq = 1, over: Partial<RecordCreatedEvent> = {}): RecordCreatedEvent {
  return {
    type: 'record-created',
    seq,
    ts: 1000 + seq,
    id,
    agent: 'worker',
    task: 'Do work',
    slug: 'work',
    origin: 'workflow',
    parentRunId: 'wf-1',
    stepIndex: 0,
    rootSessionId: 's1',
    depth: 0,
    mode: 'background',
    startedAt: 1000,
    ...over,
  }
}


function settledRecordEvent(over: Partial<RecordSettledEvent> = {}): RecordSettledEvent {
  return {
    type: 'record-settled',
    seq: 3,
    ts: 3000,
    stopReason: 'completed',
    endedAt: 3000,
    turns: 2,
    totalTokens: 500,
    ...over,
  }
}


function runEvent(over: Record<string, unknown>): WorkflowRunEvent {
  return { ts: 1000, ...(over as object) } as unknown as WorkflowRunEvent
}


/** 带 seq 信封的事件（W1 起新格式 事件行形态——seq 检查/重放去重用例的载体）。 */
function runSeqEvent(seq: number, over: Record<string, unknown>): WorkflowRunEvent {
  return { ts: 1000 + seq * 100, seq, ...(over as object) } as unknown as WorkflowRunEvent
}


/** v2 subagent 注册条目 entry（W1 D1 契约形态）。 */
function subagentRegisteredEntry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: 'e-1',
    parentId: null,
    timestamp: '2026-09-26T00:00:00Z',
    data: {
      v: 2,
      kind: 'registered',
      id,
      agent: 'worker',
      task: 'Do work',
      slug: 'work',
      origin: 'workflow',
      parentRunId: 'wf-1',
      stepIndex: 0,
      rootSessionId: 's1',
      depth: 0,
      startedAt: 1000,
      ...over,
    },
  }
}


/** v2 subagent 终态条目 entry。 */
function subagentSettledEntry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: 'e-2',
    parentId: null,
    timestamp: '2026-09-26T00:00:01Z',
    data: {
      v: 2,
      kind: 'settled',
      id,
      status: 'idle',
      stopReason: 'interrupted',
      endedAt: 3000,
      turns: 9,
      totalTokens: 999,
      model: 'p/m',
      thinkingLevel: 'low',
      result: 'full result text',
      ...over,
    },
  }
}


/** v2 workflow 注册条目 entry。 */
function workflowRegisteredEntry(runId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'workflow-record',
    id: 'e-3',
    parentId: null,
    timestamp: '2026-09-26T00:00:00Z',
    data: {
      v: 2,
      kind: 'registered',
      runId,
      workflowName: 'test-flow',
      scriptName: 'test-flow',
      slug: 'tf',
      startedAt: 1000,
      recordPath: '/tmp/wf-state/wf-1.events.jsonl',
      ...over,
    },
  }
}


/** v2 workflow 终态条目 entry。 */
function workflowSettledEntry(runId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'workflow-record',
    id: 'e-4',
    parentId: null,
    timestamp: '2026-09-26T00:00:02Z',
    data: {
      v: 2,
      kind: 'settled',
      runId,
      status: 'done',
      reason: 'completed',
      outcome: 'done',
      settledAt: 3000,
      callCount: 2,
      usedTokens: 800,
      ...over,
    },
  }
}


// ── 有状态派生视图（推送喂入 + 冷读集成）─────────────────────────

/** journal 推送报告构造（event-push-channel 契约形态；emittedAt 诊断范围固定值）。 */
function journalReport(
  domain: 'run' | 'record',
  fileKey: string,
  events: ReadonlyArray<RecordCreatedEvent | RecordEvent | RecordSettledEvent | Record<string, unknown>>,
): { domain: 'run' | 'record'; fileKey: string; events: SubagentJournalEvent[]; sessionId: string; emittedAt: number } {
  return { domain, fileKey, events: events as SubagentJournalEvent[], sessionId: 's1', emittedAt: 42 }
}


// ======================================================================
// ← src/services/session/__tests__/projection-bus-view.test.ts
// ======================================================================

const SID_m2 = 'sess-1'


const MODEL_ID = 'xiaomi-token-plan-cn/mimo-v2.6-flash'


interface FakeBus {  // oe-exempt:20261027:test:
  publish: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  unsubscribe: ReturnType<typeof vi.fn>
  unsubscribeAll: ReturnType<typeof vi.fn>
  clearSession: ReturnType<typeof vi.fn>
}


function makeFakeBus(): FakeBus {
  return {
    publish: vi.fn(),
    subscribe: vi.fn(() => ({ snapshot: [], stateSnapshot: [], lastSeq: 0 })),
    unsubscribe: vi.fn(),
    unsubscribeAll: vi.fn(),
    clearSession: vi.fn(),
  }
}


/** state_changed 合法载荷（对齐 shared protocol ServerMessageMap 契约）。 */
function stateChangedMessage(modelId: string, thinkingLevel?: string): ServerMessage {
  const payload: { sessionId: string; modelId: string; thinkingLevel?: string } = { sessionId: SID_m2, modelId }
  if (thinkingLevel !== undefined) payload.thinkingLevel = thinkingLevel
  return { type: 'session.state_changed', id: 'push_test', payload }
}


/** 运行时脏数据形态构造（检查分支的被测对象；协议类型上不合法，故意 as）。 */
function dirtyMessage(type: string, payload?: unknown): ServerMessage {
  return { type, id: 'push_test', payload } as unknown as ServerMessage
}


// ======================================================================
// ← src/services/session/__tests__/session-state-projection-query-wiring.test.ts
// ======================================================================

function makeDeps(pm: IProcessManager): SessionStateProjectionDeps {
  return {
    pm,
    getSession: () => undefined,
    hasSession: () => false,
    getMessageBus: () => new MessageBus(),
    fetchContext: vi.fn(async () => null),
    persistSessionOutcome: vi.fn(),
    tryPersistProjectBinding: vi.fn(),
  }
}


// ======================================================================
// ← src/services/session/__tests__/session-state-query.test.ts
// ======================================================================

// ── fixture 构造（pi session JSONL 的最小真实形态）──────────────────────────

/** session header 行（pi 落盘首行；trimFileEntriesToActivePath 会剥掉它） */
function headerLine(id: string, cwd: string): string {
  return JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-10-24T00:00:00.000Z', version: 1 })
}


type EntryOpts = {
  id: string
  parentId?: string
}


function entryLine(type: string, opts: EntryOpts, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, id: opts.id, ...(opts.parentId !== undefined ? { parentId: opts.parentId } : {}), ...extra })
}


/** 用户消息 entry（revoke 的定位目标形态：type='message' 且 role='user'） */
function userMessageLine(opts: EntryOpts, text = 'hello'): string {
  return entryLine('message', opts, { message: { role: 'user', content: text }, timestamp: '2026-10-24T00:00:01.000Z' })
}


/** assistant 消息 entry（冷读的模型来源之一：message.provider + message.model） */
function assistantMessageLine(opts: EntryOpts, provider: string, model: string): string {
  return entryLine('message', opts, {
    message: { role: 'assistant', provider, model, content: 'ok' },
    timestamp: '2026-10-24T00:00:02.000Z',
  })
}


/** model_change entry（pi 唯一显式 setModel 写点；provider/modelId 平铺在 entry 顶级） */
function modelChangeLine(opts: EntryOpts, provider: string, modelId: string): string {
  return entryLine('model_change', opts, { provider, modelId, timestamp: '2026-10-24T00:00:03.000Z' })
}


/** thinking_level_change entry（冷读的档位来源） */
function thinkingLevelLine(opts: EntryOpts, thinkingLevel: string): string {
  return entryLine('thinking_level_change', opts, { thinkingLevel, timestamp: '2026-10-24T00:00:04.000Z' })
}


/** label entry（撤回后 appendLabelChange 的产物：parentId = 当前 leafId） */
function labelLine(opts: EntryOpts, targetId: string, label: string): string {
  return entryLine('label', opts, { targetId, label, timestamp: '2026-10-24T00:00:05.000Z' })
}


/** 写 JSONL 文件（父目录自建） */
function writeJsonl(filePath: string, lines: string[]): void {
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8')
}


// ── §10.1 六步序列的离线等价物 ────────────────────────────────────────────

/**
 * 主会话 + btw 线的一对 fixture（§10.1 步骤 1-5 的离线等价构造）。
 *
 * 主会话文件（`<dataDir>/agent/sessions/<cwdGroup>/<mainSid>.jsonl`）：
 *   s1    session_info（根）
 *   mcA   model_change A          ← 步骤 1 前「主会话在模型 A」
 *   tlA   thinking_level_change high（A 侧 trunk）
 *   u1    user message
 *   a1    assistant（provider/model = A）
 *   mcB   model_change B          ← 步骤 2「切到 B」
 *   L     label taiji:revoked     ← 步骤 3 撤回 u1：leaf = u1.parentId = tlA，label 挂成新叶
 *   mcD   model_change D          ← 步骤 5「主会话再切 D」（只在主文件，不进线文件）
 *
 * 线文件（`<dataDir>/ext-sessions/<mainSid>/btw/<fileTimestamp>_<linePiId>.jsonl`）= 步骤 4
 * fork 的**逐字节复制源文件全部非 header entry**（保留 id/parentId，只换 header），故线文件 =
 * 上面 s1..L 七条（不含 mcD）。文件名采 **pi forkFrom 实盘命名**（session-manager.js：
 * `${fileTimestamp}_${newSessionId}.jsonl`，fileTimestamp = ISO 时间戳的 `:`/`.`→`-`）——
 * 布局定位寻址必须命中该形态（精确名 `<linePiId>.jsonl` 是历史形态，同样须命中）。
 *
 * 关键形态（设计 §10.1「为何这步是门的判定器」）：线文件的物理尾是 L，而 L 的 parentId
 * 是 tlA——**活跃路径 = [s1, mcA, tlA, L] 命中 A/high，被撤 B 分支（mcB，parentId=a1）在
 * 物理尾方向但不在活跃路径上**。物理尾逆读会命中 mcB 得 B（错值），活跃路径逆读命中
 * mcA 得 A（对值）——两种读法在此 fixture 上结果不同，门因此有判别力。
 *
 * 为何 A 与 thinking 都要落在 trunk 上（而不是只靠 assistant entry 携带）：撤回的 pi 实装
 * 语义是 `newLeafId = targetEntry.parentId`（agent-session.js:3265-3268）+ label 挂到该
 * leaf（session-manager.js:1034-1046）——**user 消息被撤后，作为它子节点的 assistant 条目
 * 一并离开活跃路径**。若 A/high 只由 assistant / 其子树条目携带，活跃路径上再无任何模型
 * 或档位记录，冷读只能返回显式未知，「打开线显示 A」在该序列下不可满足。trunk 上的
 * `model_change A` + `thinking_level_change high` 是「主会话在模型 A、档位 high」的
 * 文件级记录，也是该断言成立的唯一支撑点。
 */
function seedForkFixture(dataDir: string): { mainSid: string; linePiId: string; mainFile: string; lineFile: string } {
  const mainSid = '11111111-1111-4111-8111-111111111111'
  const linePiId = '22222222-2222-4222-8222-222222222222'
  // W4a 键统一：线 id = pi 真实会话 id（旧 `btw:<piId>` 两段式已退役）
  const cwdGroup = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' // encodeCwd('/tmp/proj')
  const mainFile = join(dataDir, 'agent', 'sessions', cwdGroup, `${mainSid}.jsonl`)
  // pi forkFrom 实盘命名：`<fileTimestamp>_<piSessionId>.jsonl`（fileTimestamp = ISO 时间戳
  // 的 `:`/`.` 替换为 `-`；实证文件名如 2026-10-24T13-00-44-583Z_<uuid>.jsonl）
  const lineFile = join(dataDir, 'ext-sessions', mainSid, 'btw', `2026-10-24T13-00-44-583Z_${linePiId}.jsonl`)

  const trunk = [
    headerLine(mainSid, '/tmp/proj'),
    entryLine('session_info', { id: 's1' }),
    modelChangeLine({ id: 'mcA', parentId: 's1' }, 'prov-a', 'model-a'),
    thinkingLevelLine({ id: 'tlA', parentId: 'mcA' }, 'high'),
    userMessageLine({ id: 'u1', parentId: 'tlA' }),
    assistantMessageLine({ id: 'a1', parentId: 'u1' }, 'prov-a', 'model-a'),
    modelChangeLine({ id: 'mcB', parentId: 'a1' }, 'prov-b', 'model-b'),
    labelLine({ id: 'L', parentId: 'tlA' }, 'u1', 'taiji:revoked'),
  ]
  writeJsonl(mainFile, [...trunk, modelChangeLine({ id: 'mcD', parentId: 'L' }, 'prov-d', 'model-d')])
  // fork：复制全部非 header entry，只换 header
  writeJsonl(lineFile, [headerLine(linePiId, '/tmp/proj'), ...trunk.slice(1)])

  return { mainSid, linePiId, mainFile, lineFile }
}


// ── deps fake（进程表 / 实例快照）────────────────────────────────────────

/** 进程表 fake：任何 spawn 形态调用都炸（零 spawn 断言的载体） */
function makeProcessTable(liveSessionIds: readonly string[] = []): IProcessManager & { spawnCalls: string[]; getClient: ReturnType<typeof vi.fn> } {
  const spawnCalls: string[] = []
  const live = new Set(liveSessionIds)
  const boom = (name: string) => (): never => {
    spawnCalls.push(name)
    throw new Error(`spawn risk point violated: ${name} must not be called by getState`)
  }
  return {
    spawnCalls,
    getClient: vi.fn((sessionId: string) => (live.has(sessionId) ? ({ id: sessionId } as unknown as IPiEngine) : undefined)),
    hasClient: (sessionId: string) => live.has(sessionId),
    createSession: boom('createSession'),
    restoreSession: boom('restoreSession'),
    ensureProcess: boom('ensureProcess'),
    withEphemeralPi: boom('withEphemeralPi'),
    rekey: boom('rekey'),
    destroySession: boom('destroySession'),
  } as unknown as IProcessManager & { spawnCalls: string[]; getClient: ReturnType<typeof vi.fn> }
}


/** 标量实例 fake（ReplicatedState 的只读窄面） */
function scalarStub<T>(value: T | undefined): ReplicatedState<T> {
  return { get: () => value } as unknown as ReplicatedState<T>
}


function liveStatesStub(modelId: string | undefined, thinkingLevel: string | undefined): SessionStateLiveStates {
  return {
    modelId: scalarStub<ModelIdSnapshot>(modelId === undefined ? undefined : { modelId }),
    thinkingLevel: scalarStub<ThinkingLevelSnapshot>(thinkingLevel === undefined ? undefined : { thinkingLevel }),
  }
}


/** 查询服务 deps 组装（默认 = 冷路径：无 client、无实例快照） */
function makeQuery(opts: {
  pm?: IProcessManager
  live?: SessionStateLiveStates | undefined
  now?: () => number
  /** 段 2 定位缝覆盖（默认 = 真实 findScannedSessionFileById） */
  diskLocate?: (sid: string) => MainSessionScanLocateResult
} = {}) {
  const traces: SessionStateColdReadTrace[] = []
  // 布局兜底调用留痕（判别顺序断言：注册表命中时不得枚举存储树）
  const layoutCalls: string[] = []
  const query = new SessionStateQuery({
    getClient: (sid) => opts.pm?.getClient(sid),
    getReplicatedStates: () => opts.live,
    locateMainSessionFileFromCache: (sid) => findCachedSessionFileById(sid),
    locateMainSessionFileFromDisk: opts.diskLocate ?? ((sid) => findScannedSessionFileById(sid)),
    // 生产投影注入的两步：注册表判别（btwRegistry Map 模拟 lifecycle 记录）→ 布局兜底
    locateBtwLineFile: (sessionId) => btwRegistry.get(sessionId),
    locateBtwLineFileByLayout: (sessionId) => {
      layoutCalls.push(sessionId)
      return findBtwLineFileByLayout(sessionId)
    },
    onColdRead: (t) => traces.push(t),
    now: opts.now,
  })
  return { query, traces, layoutCalls }
}


/**
 * btw 线注册表记录 Map（模拟生产投影注入的注册表判别：lifecycle.get(sessionId) 的
 * surface==='btw' 记录）。测试经本 Map 模拟「线已注册」的一路；未填 = 重启后的线
 * （lifecycle.sessions 无记录）→ 走主会话两段后的存储树布局兜底。
 */
const btwRegistry = new Map<string, string>()


// ======================================================================
// ← src/services/session/__tests__/trace-parity.test.ts
// ======================================================================

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')


/** 录制清单（与 scripts/record-get-entries-fixtures.mjs 的 SESSIONS 同步——改清单两处一起改）。 */
const RECORDED_SESSIONS = [
  { name: 'get-entries-1-mixed-kinds', note: '真实 session：custom×44/custom_message/model_change/id-less session_info 侧支' },
  { name: 'get-entries-2-compaction-single', note: 'compaction 语义（firstKeptEntryId + model_change）' },
  { name: 'get-entries-3-fork-header', note: 'fork header parentSession=源 sessionId fallback 形态' },
]


/** 读取层全部走真实 infra（与生产路径 B 同代码），仅发现层指向 fixture 目录。 */
const store: ISessionStore = {
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
  readSessionHeaderLine: (p: string) => readFirstJsonlLine(p),
  readSessionJsonlText: (p: string) => {
    try {
      return readFileSync(p, 'utf-8')
    } catch {
      return null
    }
  },
  readSessionEndMeta: (p: string) => readSessionEndMeta(p),
  persistHandoffSidecar: () => {},
  trash: () => Promise.resolve(),
  // [session-store-layout-inversion D5] 目录级整树软删 port（本测试不触删除路径）
  trashDirectory: () => Promise.resolve(),
}


/** 逐条 diff 结果：完全一致返回空数组，否则返回差异描述（index + 双方摘要）。 */
function diffEntries(rpcEntries: unknown[], fileEntries: unknown[]): string[] {
  const diffs: string[] = []
  const n = Math.max(rpcEntries.length, fileEntries.length)
  for (let i = 0; i < n; i++) {
    const a = rpcEntries[i]
    const b = fileEntries[i]
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffs.push(`entry[${i}] differs:\n  rpc : ${JSON.stringify(a)?.slice(0, 200)}\n  file: ${JSON.stringify(b)?.slice(0, 200)}`)
    }
  }
  return diffs
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('projection-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('events-projection', () => {
// ── run journal 行解析与 fold ─────────────────────────────────

describe('parseWorkflowRunEventFileLine（run 域 tail 行解析器）', () => {
  it('词表内事件解析透传；空行/坏 JSON/词表外 type/坏信封 → undefined', () => {
    const ok = parseWorkflowRunEventFileLine(JSON.stringify({ type: 'agent-started', ts: 1, taskIndex: 0, agentName: 'w', attempt: 1 }))
    expect(ok).toMatchObject({ type: 'agent-started', taskIndex: 0 })
    expect(parseWorkflowRunEventFileLine('')).toBeUndefined()
    expect(parseWorkflowRunEventFileLine('not-json')).toBeUndefined()
    expect(parseWorkflowRunEventFileLine(JSON.stringify({ type: 'unknown-type', ts: 1 }))).toBeUndefined()
    expect(parseWorkflowRunEventFileLine(JSON.stringify({ type: 'armed', ts: 'not-number' }))).toBeUndefined()
    expect(
      parseWorkflowRunEventFileLine(JSON.stringify({ type: 'run-settled', ts: 1, outcome: 'bogus' })),
    ).toBeUndefined()
  })

  it('[W2 D2] 删值成员 ask-executing 的历史 事件行 → undefined（tailer 跳过计日志链路的 parse 面）；保留成员 armed 照常放行', () => {
    // 词表缩窄前写入的历史行（完整载荷形态）——解析层返回 undefined 交 tailer
    // 计数 warn，不卡游标、不炸派生视图
    expect(
      parseWorkflowRunEventFileLine(
        JSON.stringify({ type: 'ask-executing', ts: 1, taskIndex: 0, agentName: 'w', attempt: 1 }),
      ),
    ).toBeUndefined()
    // [D5]/[D6] armed / member-pool 历史行（词表成员删除）→ 词表外坏行 undefined
    expect(
      parseWorkflowRunEventFileLine(
        JSON.stringify({ type: 'member-pool', ts: 1, action: 'clear' }),
      ),
    ).toBeUndefined()
    expect(
      parseWorkflowRunEventFileLine(JSON.stringify({ type: 'armed', ts: 1, frame: {} })),
    ).toBeUndefined()
    // [D2] run-interrupted / run-resumed 新成员照常放行
    expect(
      parseWorkflowRunEventFileLine(JSON.stringify({ type: 'run-interrupted', ts: 1, errorCode: 'crashed' })),
    ).toMatchObject({ type: 'run-interrupted', errorCode: 'crashed' })
  })

  it('[W1 seq 契约] 携带 seq 的行按正安全整数校验：字符串/0/-1/1.5 → undefined；合法 seq 与无 seq 旧行放行（对齐 core isWorkflowRunEventLine）', () => {
    const seqLine = (seq: unknown): string =>
      JSON.stringify({ type: 'agent-started', ts: 1, taskIndex: 0, agentName: 'w', attempt: 1, seq })
    // 坏值：非 number（字符串 "5"）/ 非正整数（0 / -1）/ 非整数（1.5）——坏行交 tailer 计数
    expect(parseWorkflowRunEventFileLine(seqLine('5'))).toBeUndefined()
    expect(parseWorkflowRunEventFileLine(seqLine(0))).toBeUndefined()
    expect(parseWorkflowRunEventFileLine(seqLine(-1))).toBeUndefined()
    expect(parseWorkflowRunEventFileLine(seqLine(1.5))).toBeUndefined()
    // 合法 seq（1 起正安全整数）透传
    expect(parseWorkflowRunEventFileLine(seqLine(1))).toMatchObject({ type: 'agent-started', seq: 1 })
    expect(parseWorkflowRunEventFileLine(seqLine(Number.MAX_SAFE_INTEGER))).toMatchObject({
      seq: Number.MAX_SAFE_INTEGER,
    })
    // W1 前存量 事件行无 seq 字段（D7 惰性兼容读）——放行
    expect(
      parseWorkflowRunEventFileLine(JSON.stringify({ type: 'agent-started', ts: 1, taskIndex: 0, agentName: 'w', attempt: 1 })),
    ).toMatchObject({ type: 'agent-started' })
  })
})
describe('run 域 journal fold（[W2 D7] 单源 core foldRunEventCheckpoint——runtime 派生视图消费骨架半边）', () => {
  const noop = (): void => {}

  /** 合法序列（写入序）：created → 两 ask 派发 → ask-0 终局 → run 终局。 */
  const legalEvents: WorkflowRunEvent[] = [
    runSeqEvent(1, { type: 'run-created', runId: 'wf-1', workflowName: 'flow', argsSummary: '' }),
    runSeqEvent(2, { type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1 }),
    runSeqEvent(3, { type: 'agent-started', taskIndex: 1, agentName: 'w2', attempt: 1 }),
    runSeqEvent(4, { type: 'agent-settled', taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 800 }),
    runSeqEvent(5, { type: 'run-settled', outcome: 'done', artifactsDir: '/tmp/a' }),
  ]

  it('骨架派生视图：created 定首帧、dispatched 成骨架行、settled 定步骤终局、run-settled 定 run 终局', () => {
    const fold = foldRunEventCheckpoint(legalEvents, noop)
    // created 载荷含 argsSummary（[可视化 U1] 扩 fold 骨架字段——写侧恒写的行内小摘要透传）
    expect(fold.created).toEqual({ runId: 'wf-1', workflowName: 'flow', argsSummary: '', ts: 1100 })
    expect(fold.asks.get(0)).toMatchObject({ agentName: 'w1', startedAt: 1200, settled: { outcome: 'done' } })
    expect(fold.asks.get(1)?.settled).toBeUndefined()
    expect(fold.runSettled).toMatchObject({ outcome: 'done', ts: 1500 })
    // 状态半边同源于一次 fold：终帧 terminal + seq 水位 = 末帧
    expect(fold.state).toEqual({ lifecycle: 'terminal', outcome: 'done' })
    expect(fold.lastSeq).toBe(5)
  })

  it('[live≡reload 等价族] 增量批次接续 fold ≡ 一次性全量 fold（checkpoint 逐字段相等）', () => {
    const incremental = foldRunEventCheckpoint(
      legalEvents.slice(3),
      noop,
      foldRunEventCheckpoint(legalEvents.slice(0, 3), noop),
    )
    const full = foldRunEventCheckpoint(legalEvents, noop)
    expect(incremental).toEqual(full)
  })

  it('[live≡reload 等价族] seq 重放幂等：已 fold checkpoint 重放全量流不重复推进（tail 截断重建形态）', () => {
    const once = foldRunEventCheckpoint(legalEvents, noop)
    const replayed = foldRunEventCheckpoint(legalEvents, noop, once)
    expect(replayed).toEqual(once)
  })

  it('[D6] member-pool 历史行进 fold 停帧（词表成员删除后表外转移——骨架停在最近一致态）；[D3] phase 骨架随转移事件产出', () => {
    // member-pool 历史行（[D6] 删除成员）：fold 在该帧撞表外转移 → 保守停帧
    const stopped = foldRunEventCheckpoint(
      [
        runSeqEvent(1, { type: 'run-created', runId: 'wf-mp', workflowName: 'flow', argsSummary: '' }),
        runSeqEvent(2, { type: 'member-pool', action: 'register', name: 'w1', recordId: 'sa-1' }),
      ],
      noop,
    )
    expect(stopped.created).toMatchObject({ runId: 'wf-mp' })
    expect(stopped.lastSeq).toBe(1) // member-pool 帧未应用（水位停在 run-created）
    // [D3] phase 状态机骨架：phase-started/phase-settled 落派生视图半边
    const folded = foldRunEventCheckpoint(
      [
        runSeqEvent(1, { type: 'run-created', runId: 'wf-ph', workflowName: 'flow', argsSummary: '' }),
        runSeqEvent(2, { type: 'phase-started', phase: 'impl' }),
        runSeqEvent(3, { type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, phase: 'impl' }),
        runSeqEvent(4, { type: 'phase-settled', phase: 'impl' }),
        runSeqEvent(5, { type: 'run-settled', outcome: 'done', artifactsDir: '/tmp/a' }),
      ],
      noop,
    )
    expect(folded.phases.get('impl')).toMatchObject({ phase: 'impl' })
    expect(folded.phases.get('impl')?.settledAt).toBeDefined()
    expect(folded.runSettled).toMatchObject({ outcome: 'done' })
  })

  it('被动终局帧透传：收编/回收路径 run-settled（interrupted + errorCode 细分）落骨架与派生视图', () => {
    // 历史回收帧（场景 3 事件帧口径）：outcome=interrupted + errorCode=idle-evicted
    // ——历史写入方 = 已退役的 30 天内存回收机制（见 ADR），词表成员为存量帧解析保留
    const evicted = foldRunEventCheckpoint(
      [
        runSeqEvent(1, { type: 'run-created', runId: 'wf-idle', workflowName: 'flow', argsSummary: '' }),
        runSeqEvent(2, { type: 'run-settled', outcome: 'interrupted', errorCode: 'idle-evicted', artifactsDir: '/tmp/a' }),
      ],
      noop,
    )
    expect(evicted.runSettled).toMatchObject({ outcome: 'interrupted', errorCode: 'idle-evicted' })
    expect(evicted.state).toEqual({ lifecycle: 'terminal', outcome: 'interrupted' })

    // 派生视图合成：注册条目在场 + 事件收编帧 → WorkflowRunRecord 透传 outcome/errorCode
    const registered = {
      v: 2 as const,
      kind: 'registered' as const,
      runId: 'wf-idle',
      workflowName: 'flow',
      scriptName: 'test-flow',
      slug: 'tf',
      startedAt: 1000,
      recordPath: '/tmp/ws/wf-idle.events.jsonl',
    }
    const record = projectV2Workflow(registered, undefined, evicted)!
    expect(record.status).toBe('done')
    expect(record.outcome).toBe('interrupted')
    expect(record.errorCode).toBe('idle-evicted')
  })

  it('收编双帧先到帧为准：terminal 吸收后到 run-settled，骨架 runSettled 停先到帧（TOCTOU 残余口径）', () => {
    const dual = foldRunEventCheckpoint(
      [
        runSeqEvent(1, { type: 'run-created', runId: 'wf-dual', workflowName: 'flow', argsSummary: '' }),
        runSeqEvent(2, { type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1 }),
        runSeqEvent(3, { type: 'run-settled', outcome: 'interrupted', errorCode: 'idle-evicted', artifactsDir: '/tmp/a' }),
        runSeqEvent(4, { type: 'run-settled', outcome: 'failed', artifactsDir: '/tmp/a' }),
      ],
      noop, // onBrokenFrame 出声归消费方注入（applyRunEvents 接 warn）
    )
    expect(dual.runSettled).toMatchObject({ outcome: 'interrupted', errorCode: 'idle-evicted' })
    expect(dual.state).toEqual({ lifecycle: 'terminal', outcome: 'interrupted' })
  })

  it('占位行兜底：合法转移下跨 taskIndex 错位的 agent-settled（agent-started 缺席）成占位行不丢终局', () => {
    // 转移表不校验 taskIndex 归属：running 态下 settled 的 taskIndex 无 agent-started
    // 行 = 残形态——骨架兜底 '(unknown)' 占位行，终局不丢（record overlay 会覆盖）
    const fold = foldRunEventCheckpoint(
      [
        runSeqEvent(1, { type: 'run-created', runId: 'wf-mis', workflowName: 'flow', argsSummary: '' }),
        runSeqEvent(2, { type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1 }),
        runSeqEvent(3, { type: 'agent-settled', taskIndex: 7, attempt: 1, outcome: 'failed', errorCode: 'unknown', durationMs: 5 }),
      ],
      noop,
    )
    expect(fold.asks.get(7)).toMatchObject({ agentName: '(unknown)', settled: { outcome: 'failed' } })
    expect(fold.asks.get(0)?.settled).toBeUndefined()
  })
})
// ── v2 条目扫描 ───────────────────────────────────────────────

describe('scanV2RecordEntries', () => {
  it('两族 registered/settled 分类收集；v1 与 future-v 跳过', () => {
    const scan = scanV2RecordEntries([
      subagentRegisteredEntry('sa-1'),
      subagentSettledEntry('sa-1'),
      workflowRegisteredEntry('wf-1'),
      workflowSettledEntry('wf-1'),
      { type: 'custom', customType: 'subagent-record', data: { v: 1, id: 'x', status: 'running' } },
      { type: 'custom', customType: 'subagent-record', data: { v: 9, kind: 'registered', id: 'y' } },
    ])
    expect([...scan.subagentRegistered.keys()]).toEqual(['sa-1'])
    expect([...scan.subagentSettled.keys()]).toEqual(['sa-1'])
    expect([...scan.workflowRegistered.keys()]).toEqual(['wf-1'])
    expect([...scan.workflowSettled.keys()]).toEqual(['wf-1'])
  })
})
// ── 合并仲裁纯函数 ────────────────────────────────────────────

describe('projectV2Subagent（事件源胜出 / 窗外兜底）', () => {
  const registered = {
    v: 2 as const,
    kind: 'registered' as const,
    id: 'sa-1',
    agent: 'worker',
    task: 'Do work',
    slug: 'work',
    origin: 'workflow' as const,
    parentRunId: 'wf-1',
    stepIndex: 0,
    rootSessionId: 's1',
    depth: 0,
    startedAt: 1000,
  }
  const settledEntry = {
    v: 2 as const,
    kind: 'settled' as const,
    id: 'sa-1',
    status: 'idle' as const,
    stopReason: 'interrupted' as const,
    endedAt: 3000,
    turns: 9,
    totalTokens: 999,
    model: 'p/m',
    thinkingLevel: undefined,
    engine: undefined,
    engineHandle: undefined,
    sessionFile: undefined,
    result: 'full result text',
  }

  it('事件 fold 在场：状态/统计由 fold 裁决（胜出），条目补 model/result 全文', () => {
    // 事件源：created + bound + settled(completed)；条目：settled(interrupted)——冲突下 事件源胜出
    const fold = {
      identity: createdEvent('sa-1'),
      bound: {
        type: 'record-bound' as const,
        seq: 2,
        ts: 1500,
        sessionFile: '/sub/sa-1.jsonl',
        engine: 'pi',
        engineHandle: { sessionRef: {}, poolKey: 'shared' },
        epoch: 0,
      },
      round: undefined,
      epoch: 0,
      roundIdle: undefined,
      settled: settledRecordEvent(),
      reopened: undefined,
      modelOverride: undefined,
      lastSeq: 3,
      lastEvent: undefined,
    }
    const record = projectV2Subagent(registered, settledEntry, fold)!
    expect(record.status).toBe('idle')
    expect(record.stopReason).toBe('completed') // 事件源胜出（条目是 interrupted）
    expect(record.turns).toBe(2)
    expect(record.totalTokens).toBe(500)
    expect(record.model).toBe('p/m') // 条目独有字段仍填充
    expect(record.result).toBe('full result text')
    expect(record.sessionFile).toBe('/sub/sa-1.jsonl') // bound 事件
    expect(record.engineHandle?.poolKey).toBe('shared')
  })

  it('事件 fold 缺席（窗外终态实体）：终态条目兜底成派生视图', () => {
    const record = projectV2Subagent(registered, settledEntry, undefined)!
    expect(record.status).toBe('idle')
    expect(record.stopReason).toBe('interrupted')
    expect(record.turns).toBe(9)
    expect(record.sessionFile).toBeNull()
  })

  it('仅有注册条目：running 派生视图（身份域齐备）', () => {
    const record = projectV2Subagent(registered, undefined, undefined)!
    expect(record.status).toBe('running')
    expect(record.agent).toBe('worker')
    expect(record.parentRunId).toBe('wf-1')
    expect(record.stepIndex).toBe(0)
  })

  it('两源皆缺 → null', () => {
    expect(projectV2Subagent(undefined, undefined, undefined)).toBeNull()
  })

  // ── [subagent-detail-model-info] modelSource 派生视图 + running 期模型（created 帧回落）──

  it('running 期模型回落 created 帧留痕（settled 条目缺席）+ modelSource 随身份域映射', () => {
    const fold = {
      identity: createdEvent('sa-1', 1, { model: 'zai-coding-plan/GLM-5.3', modelSource: 'explicit' }),
      bound: undefined,
      round: undefined,
      epoch: 0,
      roundIdle: undefined,
      settled: undefined,
      reopened: undefined,
      modelOverride: undefined,
      lastSeq: 1,
      lastEvent: undefined,
    }
    const record = projectV2Subagent(registered, undefined, fold)!
    expect(record.status).toBe('running')
    // running 期实际模型可见（不再等 settled 才透传）
    expect(record.model).toBe('zai-coding-plan/GLM-5.3')
    expect(record.modelSource).toBe('explicit')
  })

  it('modelSource 三源取先：settled 条目 > fold 身份域 > registered 条目；全缺 = undefined', () => {
    // settled 条目在场 → 条目值胜出
    const settledWins = projectV2Subagent(
      registered,
      { ...settledEntry, modelSource: 'preference' },
      {
        identity: createdEvent('sa-1', 1, { model: 'p/m', modelSource: 'explicit' }),
        bound: undefined,
        round: undefined,
        epoch: 0,
        roundIdle: undefined,
        settled: undefined,
        reopened: undefined,
        modelOverride: undefined,
        lastSeq: 1,
        lastEvent: undefined,
      },
    )!
    expect(settledWins.modelSource).toBe('preference')

    // settled 缺席 → fold 身份域
    const foldWins = projectV2Subagent(
      registered,
      undefined,
      {
        identity: createdEvent('sa-1', 1, { modelSource: 'frontmatter' }),
        bound: undefined,
        round: undefined,
        epoch: 0,
        roundIdle: undefined,
        settled: undefined,
        reopened: undefined,
        modelOverride: undefined,
        lastSeq: 1,
        lastEvent: undefined,
      },
    )!
    expect(foldWins.modelSource).toBe('frontmatter')

    // fold 缺席（窗外）→ registered 条目兜底
    const registeredWins = projectV2Subagent(
      { ...registered, modelSource: 'preference' },
      undefined,
      undefined,
    )!
    expect(registeredWins.modelSource).toBe('preference')

    // 全缺（存量 record 形态）→ undefined
    const none = projectV2Subagent(registered, settledEntry, undefined)!
    expect(none.modelSource).toBeUndefined()
  })

  // [F1-38 轮终形态] v1 语义：轮终翻边写 idle（写侧 markRoundIdle 落 idle + v1
  // 权威词同源）——v2 派生视图须延续（轮终等待续聊的 record 不得显示 running，否则
  // running + stopReason 矛盾组合且可能被用户误 cancel）。
  it('轮终形态：round-idle 在场、settled 缺席 → idle + roundIdle 统计透传', () => {
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 1,
      epoch: 0,
      roundIdle: {
        type: 'record-round-idle' as const,
        round: 1,
        seq: 3,
        ts: 2500,
        stopReason: 'completed' as const,
        turns: 2,
        totalTokens: 500,
      },
      settled: undefined,
      reopened: undefined,
      modelOverride: undefined,
      lastSeq: 3,
      lastEvent: {
        type: 'record-round-idle' as const,
        round: 1,
        seq: 3,
        ts: 2500,
        stopReason: 'completed' as const,
        turns: 2,
        totalTokens: 500,
      },
    }
    const record = projectV2Subagent(registered, undefined, fold)!
    expect(record.status).toBe('idle')
    expect(record.stopReason).toBe('completed')
    expect(record.turns).toBe(2)
    expect(record.totalTokens).toBe(500)
  })

  it('续跑第二轮：round-started 在 round-idle 后 → running（roundIdle 在场不作 idle 判据）', () => {
    const roundIdle = {
      type: 'record-round-idle' as const,
      round: 2,
      seq: 3,
      ts: 2500,
      stopReason: 'completed' as const,
      turns: 2,
      totalTokens: 500,
    }
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 2,
      epoch: 0,
      roundIdle,
      settled: undefined,
      reopened: undefined,
      modelOverride: undefined,
      lastSeq: 4,
      lastEvent: { type: 'record-round-started' as const, seq: 4, ts: 3000, round: 2, epoch: 0 },
    }
    const record = projectV2Subagent(registered, undefined, fold)!
    expect(record.status).toBe('running')
    // [F2-1] 轮始清点：上轮停因不透传（v1 markRoundStartedImpl 清点对齐——running +
    // 「completed」停因矛盾组合不得出现）
    expect(record.stopReason).toBeUndefined()
  })

  it('在途 + 旧 v2 终态条目在场：stopReason 不透传条目停因（事件源胜出——窗外兜底仅限无 fold）', () => {
    // 场景：已终态（v2 终态条目已写）→ reopened → round-started——在途期 roundIdle
    // 与条目停因都不得泄漏（v1 轮始清点后 stopReason=undefined）
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 1,
      epoch: 1,
      roundIdle: {
        type: 'record-round-idle' as const,
        round: 1,
        seq: 3,
        ts: 2500,
        stopReason: 'completed' as const,
        turns: 2,
        totalTokens: 500,
      },
      settled: undefined,
      reopened: undefined,
      modelOverride: undefined,
      lastSeq: 5,
      lastEvent: { type: 'record-round-started' as const, seq: 5, ts: 3500, round: 1, epoch: 1 },
    }
    const record = projectV2Subagent(registered, settledEntry, fold)!
    expect(record.status).toBe('running')
    expect(record.stopReason).toBeUndefined()
  })

  it('reopened 窗口（重开完成、新轮未始）→ idle（markReopened CAS 只接受 idle、不翻 running）', () => {
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 0,
      epoch: 1,
      roundIdle: {
        type: 'record-round-idle' as const,
        round: 1,
        seq: 3,
        ts: 2500,
        stopReason: 'completed' as const,
        turns: 2,
        totalTokens: 500,
      },
      settled: undefined,
      reopened: { type: 'record-reopened' as const, seq: 4, ts: 3000, epoch: 1, round: 0 },
      modelOverride: undefined,
      lastSeq: 4,
      lastEvent: { type: 'record-reopened' as const, seq: 4, ts: 3000, epoch: 1, round: 0 },
    }
    const record = projectV2Subagent(registered, undefined, fold)!
    expect(record.status).toBe('idle')
    // [F2-1] v1 markReopenedImpl 写 stopReason='reopened'——派生视图同词映射，
    // 不透传更旧轮的轮终停因
    expect(record.stopReason).toBe('reopened')
  })

  // [W1 / F1-46 轮终 result] record-round-idle 携带 result 摘要锚（D3 词表裁决①）：
  // 轮终粒度的 result 断供修复——承接 v1 U8b 轮终 result 显示信号（「轮终等待续聊」
  // 的展示侧），终局全文仍只在 v2 终态条目一次性写（D1）。
  it('轮终摘要透传：round-idle.resultSummary 在场（无终态条目）→ result 取轮终摘要', () => {
    const roundIdle = {
      type: 'record-round-idle' as const,
      round: 1,
      seq: 3,
      ts: 2500,
      stopReason: 'completed' as const,
      turns: 2,
      totalTokens: 500,
      resultSummary: '本轮正文摘要',
    }
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 1,
      epoch: 0,
      roundIdle,
      settled: undefined,
      reopened: undefined,
      modelOverride: undefined,
      lastSeq: 3,
      lastEvent: roundIdle,
    }
    const record = projectV2Subagent(registered, undefined, fold)!
    expect(record.result).toBe('本轮正文摘要')
  })

  it('reopened 续跑后的新轮终摘要胜过旧终局条目全文（fresh round-idle 胜出）', () => {
    const roundIdle = {
      type: 'record-round-idle' as const,
      round: 2,
      seq: 6,
      ts: 6000,
      stopReason: 'completed' as const,
      turns: 4,
      totalTokens: 900,
      resultSummary: 'new round summary',
    }
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 2,
      epoch: 1,
      roundIdle,
      settled: undefined, // reopened / round-started 已清除 settled
      reopened: undefined,
      modelOverride: undefined,
      lastSeq: 6,
      lastEvent: roundIdle,
    }
    const record = projectV2Subagent(registered, settledEntry, fold)!
    expect(record.result).toBe('new round summary')
  })

  it('终局条目优先：settled 在场（晚于 round-idle）→ 条目全文 / 终局摘要锚', () => {
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 1,
      epoch: 0,
      roundIdle: {
        type: 'record-round-idle' as const,
        round: 1,
        seq: 2,
        ts: 2500,
        stopReason: 'completed' as const,
        turns: 2,
        totalTokens: 500,
        resultSummary: 'stale round summary',
      },
      settled: settledRecordEvent({ seq: 3, resultSummary: 'settled summary' }),
      reopened: undefined,
      modelOverride: undefined,
      lastSeq: 3,
      lastEvent: undefined,
    }
    // 无条目：终局摘要锚
    expect(projectV2Subagent(registered, undefined, fold)!.result).toBe('settled summary')
    // 条目全文在场：全文优先（D1 唯一全文落点）
    expect(projectV2Subagent(registered, settledEntry, fold)!.result).toBe('full result text')
  })

  // [W1 / F2-2 轮终 error] record-round-idle.error 失败原因原文供源（词表裁决）：
  // 供源分流与 stopReason 同构——settled 终局优先 → 最新轮终失败收条 → 条目范围兜底；
  // round-started 后旧失败原文随轮始清点语义不透传（对齐 v1 markRoundStartedImpl
  // 清残留死因，F2-1 同族红线）。
  it('轮终失败：round-idle.error 在场（无终局）→ error 取失败原因原文', () => {
    const roundIdle = {
      type: 'record-round-idle' as const,
      round: 1,
      seq: 4,
      ts: 3000,
      stopReason: 'failed' as const,
      turns: 2,
      totalTokens: 600,
      resultSummary: 'round did not complete: engine crashed',
      error: 'engine crashed',
    }
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 1,
      epoch: 0,
      roundIdle,
      settled: undefined,
      reopened: undefined,
      modelOverride: undefined,
      lastSeq: 4,
      lastEvent: roundIdle,
    }
    expect(projectV2Subagent(registered, undefined, fold)!.error).toBe('engine crashed')
  })

  it('第二轮在途：round-started 在 round-idle 后 → 上轮失败原文不透传（轮始清点语义）', () => {
    const roundIdle = {
      type: 'record-round-idle' as const,
      round: 2,
      seq: 4,
      ts: 3000,
      stopReason: 'failed' as const,
      turns: 2,
      totalTokens: 600,
      error: 'engine crashed',
    }
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 2,
      epoch: 0,
      roundIdle,
      settled: undefined,
      reopened: undefined,
      modelOverride: undefined,
      lastSeq: 5,
      lastEvent: { type: 'record-round-started' as const, seq: 5, ts: 4000, round: 2, epoch: 0 },
    }
    expect(projectV2Subagent(registered, undefined, fold)!.error).toBeUndefined()
  })

  it('终局优先：settled 在场 → error 取终局原文（晚于轮终收条时不受 roundIdle 影响）', () => {
    const roundIdle = {
      type: 'record-round-idle' as const,
      round: 1,
      seq: 2,
      ts: 2500,
      stopReason: 'failed' as const,
      turns: 2,
      totalTokens: 500,
      error: 'round-level failure',
    }
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 1,
      epoch: 0,
      roundIdle,
      settled: settledRecordEvent({ seq: 3, resultSummary: 'settled summary', error: 'settled failure' }),
      reopened: undefined,
      modelOverride: undefined,
      lastSeq: 3,
      lastEvent: undefined,
    }
    expect(projectV2Subagent(registered, undefined, fold)!.error).toBe('settled failure')
  })
})
describe('projectV2Workflow（run 域定界 + 事件 fold 骨架）', () => {
  it('注册条目缺席（其他会话的 run）→ null（定界）', () => {
    expect(projectV2Workflow(undefined, undefined, INITIAL_RUN_EVENT_FOLD)).toBeNull()
  })

  /** registered 条目 fixture（v2 run 注册；scriptPath 可选——旧条目形态缺省）。 */
  function registeredEntry(runId: string, scriptPath?: string) {
    return {
      v: 2 as const,
      kind: 'registered' as const,
      runId,
      workflowName: 'flow',
      scriptName: 'test-flow',
      slug: 'tf',
      ...(scriptPath !== undefined ? { scriptPath } : {}),
      startedAt: 1000,
      recordPath: `/tmp/ws/${runId}.events.jsonl`,
    }
  }

  /** created + settled 两事件 fold（scriptPath 透传用例的最小事件范围）。 */
  function createdSettledFold(runId: string) {
    return foldRunEventCheckpoint(
      [
        runEvent({ type: 'run-created', runId, workflowName: 'flow', argsSummary: '', ts: 1000 }),
        runEvent({ type: 'run-settled', outcome: 'done', artifactsDir: '/tmp/a', ts: 3000 }),
      ],
      () => {},
    )
  }

  it('注册条目 scriptPath 透传进 WorkflowRunRecord（GUI 详情层全路径源）', () => {
    const scriptPath = '/Users/x/project/.pi/workflows/test-flow.js'
    const record = projectV2Workflow(registeredEntry('wf-sp', scriptPath), undefined, createdSettledFold('wf-sp'))!
    expect(record.scriptPath).toBe(scriptPath)
  })

  it('旧注册条目（无 scriptPath）→ record.scriptPath 缺省（不回落猜路径）', () => {
    const record = projectV2Workflow(registeredEntry('wf-legacy'), undefined, createdSettledFold('wf-legacy'))!
    // 缺省空串（WorkflowRunRecord.scriptPath 可选；UI 回落 scriptName 短名）
    expect(record.scriptPath).toBe('')
  })

  it('事件 fold 骨架 + 条目摘要合并成 WorkflowRunRecord', () => {
    const registered = {
      v: 2 as const,
      kind: 'registered' as const,
      runId: 'wf-1',
      workflowName: 'flow',
      scriptName: 'test-flow',
      slug: 'tf',
      startedAt: 1000,
      recordPath: '/tmp/ws/wf-1.events.jsonl',
    }
    const settledEntry = {
      v: 2 as const,
      kind: 'settled' as const,
      runId: 'wf-1',
      status: 'done' as const,
      reason: 'completed' as const,
      outcome: 'done' as const,
      settledAt: 3000,
      callCount: 2,
      usedTokens: 800,
    }
    const fold = foldRunEventCheckpoint(
      [
        runEvent({ type: 'run-created', runId: 'wf-1', workflowName: 'flow', argsSummary: '', ts: 1000 }),
        runEvent({ type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, ts: 1100 }),
        runEvent({ type: 'agent-started', taskIndex: 1, agentName: 'w2', attempt: 1, ts: 1200 }),
        runEvent({ type: 'agent-settled', taskIndex: 1, attempt: 1, outcome: 'failed', errorCode: 'engine_crashed', durationMs: 300, ts: 1500 }),
        runEvent({ type: 'run-settled', outcome: 'done', artifactsDir: '/tmp/a', ts: 3000 }),
      ],
      () => {},
    )
    const record = projectV2Workflow(registered, settledEntry, fold)!
    expect(record.status).toBe('done')
    expect(record.reason).toBe('completed')
    expect(record.scriptName).toBe('test-flow')
    expect(record.stateFilePath).toBe('/tmp/ws/wf-1.events.jsonl')
    expect(record.usedTokens).toBe(800)
    expect(record.agentCalls.map((c) => [c.id, c.status])).toEqual([[0, 'running'], [1, 'failed']])
    expect(record.agentCalls[1]!.error).toBe('engine_crashed')
    expect(record.outcome).toBe('done')
  })

  it('agent-settled outcome=cancelled → agentCalls 行 status=cancelled（§3.3.8 取消收尾成员不冒充 failed）', () => {
    const registered = {
      v: 2 as const,
      kind: 'registered' as const,
      runId: 'wf-cancel',
      workflowName: 'flow',
      scriptName: 'test-flow',
      slug: 'tf',
      startedAt: 1000,
      recordPath: '/tmp/ws/wf-cancel.events.jsonl',
    }
    const fold = foldRunEventCheckpoint(
      [
        runEvent({ type: 'run-created', runId: 'wf-cancel', workflowName: 'flow', argsSummary: '', ts: 1000 }),
        runEvent({ type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, ts: 1100 }),
        // run 取消：在途成员被收尾（dispatchAgentSettled 的 aborted 分支）→ outcome=cancelled
        runEvent({ type: 'agent-settled', taskIndex: 0, attempt: 1, outcome: 'cancelled', durationMs: 500, ts: 1500 }),
        runEvent({ type: 'run-settled', outcome: 'cancelled', artifactsDir: '/tmp/a', ts: 3000 }),
      ],
      () => {},
    )
    const record = projectV2Workflow(registered, undefined, fold)!
    expect(record.agentCalls[0]).toMatchObject({ id: 0, status: 'cancelled' })
  })

  it('agent-started 带 phase → fold 骨架与派生视图 call.phase 透传；无 phase 行 undefined（W1 D6 分组供源）', () => {
    const fold = foldRunEventCheckpoint(
      [
        runEvent({ type: 'run-created', runId: 'wf-phase', workflowName: 'flow', argsSummary: '', ts: 1000 }),
        runEvent({ type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, phase: 'Dev-w0(W1)', ts: 1100 }),
        // 无 phase 帧 = 停写期 事件行 / 未标注剧本——fold 不造键
        runEvent({ type: 'agent-started', taskIndex: 1, agentName: 'w2', attempt: 1, ts: 1200 }),
      ],
      () => {},
    )
    expect(fold.asks.get(0)?.phase).toBe('Dev-w0(W1)')
    expect('phase' in fold.asks.get(1)!).toBe(false)

    const registered = {
      v: 2 as const,
      kind: 'registered' as const,
      runId: 'wf-phase',
      workflowName: 'flow',
      scriptName: 'test-flow',
      slug: 'tf',
      startedAt: 1000,
      recordPath: '/tmp/ws/wf-phase.events.jsonl',
    }
    const record = projectV2Workflow(registered, undefined, fold)!
    // renderer hasExplicitPhases（phase !== undefined）的供源：带 phase 步骤进分组，旧行保持平铺
    expect(record.agentCalls[0]!.phase).toBe('Dev-w0(W1)')
    expect(record.agentCalls[1]!.phase).toBeUndefined()
  })

  it('中断形态条目（status=interrupted）在 fold 缺席兜底层 → interrupted（entry-only 降级派生视图不回落 running）', () => {
    const registered = {
      v: 2 as const,
      kind: 'registered' as const,
      runId: 'wf-intr',
      workflowName: 'flow',
      scriptName: 'test-flow',
      slug: 'tf',
      startedAt: 1000,
      recordPath: '/tmp/ws/wf-intr.record.jsonl',
    }
    const interruptedEntry = {
      v: 2 as const,
      kind: 'settled' as const,
      runId: 'wf-intr',
      status: 'interrupted' as const,
      errorCode: 'crashed' as const,
      settledAt: 3000,
      callCount: 1,
      usedTokens: 0,
    }
    // fold 缺席（runJournalDir 缺席的 entry-only 降级派生视图 / record 流被外部清理）
    const record = projectV2Workflow(registered, interruptedEntry, undefined)!
    expect(record.status).toBe('interrupted')
    // 主链路不受影响：record 流在场时 fold 判据仍权威
    const folded = foldRunEventCheckpoint(
      [
        runEvent({ type: 'run-created', runId: 'wf-intr', workflowName: 'flow', argsSummary: '', ts: 1000 }),
        runEvent({ type: 'run-interrupted', errorCode: 'crashed', ts: 2500 }),
      ],
      () => {},
    )
    const record2 = projectV2Workflow(registered, interruptedEntry, folded)!
    expect(record2.status).toBe('interrupted')
    // F2-1：resume 复活窗口——run-resumed 已被 fold（lifecycle 回 running），中断
    // 形态条目留存不被覆盖（resume 只补写 registered 条目，appendResumeRegisteredEntry）。
    // 条目陈旧值不得劫持 fold 权威态：复活 run 整个执行期显示 running 而非「已中断」
    const resumedFold = foldRunEventCheckpoint(
      [
        runEvent({ type: 'run-created', runId: 'wf-intr', workflowName: 'flow', argsSummary: '', ts: 1000 }),
        runEvent({ type: 'run-interrupted', errorCode: 'crashed', ts: 2500 }),
        runEvent({ type: 'run-resumed', ts: 4000 }),
      ],
      () => {},
    )
    expect(resumedFold.state.lifecycle).toBe('running')
    const record3 = projectV2Workflow(registered, interruptedEntry, resumedFold)!
    expect(record3.status).toBe('running')
  })
})
describe('mergeEventProjection（单点合并）', () => {
  it('[§3.3 仲裁反转] 事件 fold 是实体唯一来源：注册条目缺席时按 fold 推算（无 v1 遮蔽通道）', () => {
    const sources = initialEventProjectionSources()
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined, round: undefined, epoch: undefined, roundIdle: undefined,
      settled: undefined, reopened: undefined, modelOverride: undefined, lastSeq: 1, lastEvent: undefined,
    }
    sources.recordFolds.set('sa-1', fold)
    const merged = mergeEventProjection(sources, 's1')
    // fold 的 record-created 身份（agent=worker）直接进派生视图——v1 冻结层删除后不存在
    // 「同 id 快照遮蔽事件流」的方向性缺陷。
    expect(merged.subagents.get('sa-1')?.agent).toBe('worker')
  })

  it('rootSessionId 非本会话的 record fold 被排除（records 目录按 cwd 共享）', () => {
    const sources = initialEventProjectionSources()
    const foreign = createdEvent('sa-foreign')
    foreign.rootSessionId = 's-other'
    sources.recordFolds.set('sa-foreign', {
      identity: foreign, bound: undefined, round: undefined, epoch: undefined,
      roundIdle: undefined, settled: undefined, reopened: undefined, modelOverride: undefined, lastSeq: 1, lastEvent: undefined,
    })
    const merged = mergeEventProjection(sources, 's1')
    expect(merged.subagents.has('sa-foreign')).toBe(false)
  })

  it('步骤视图合并（W0 输入换源）：record 派生视图按 (parentRunId, stepIndex) 覆盖 run 骨架行状态', () => {
    const sources = initialEventProjectionSources()
    const registered = {
      v: 2 as const, kind: 'registered' as const, runId: 'wf-1', workflowName: 'f',
      scriptName: 'f', slug: 'f', startedAt: 1000, recordPath: '/tmp/j',
    }
    sources.v2WorkflowRegistered.set('wf-1', registered)
    sources.runFolds.set(
      'wf-1',
      foldRunEventCheckpoint(
        [
          runEvent({ type: 'run-created', runId: 'wf-1', workflowName: 'f', argsSummary: '', ts: 1000 }),
          runEvent({ type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, ts: 1100 }),
        ],
        () => {},
      ),
    )
    sources.recordFolds.set('sa-1', {
      identity: createdEvent('sa-1'),
      bound: undefined, round: undefined, epoch: undefined, roundIdle: undefined,
      settled: settledRecordEvent(),
      reopened: undefined,
      modelOverride: undefined,
      lastSeq: 3, lastEvent: undefined,
    })
    const merged = mergeEventProjection(sources, 's1')
    // run 骨架行 running 被 record 终态 overlay 为 completed（mergeWorkflowStepRecords 同一纯函数）
    expect(merged.workflows.get('wf-1')?.agentCalls[0]).toMatchObject({ status: 'done', sessionId: 'sa-1' })
  })
})
// ── 会话文件流式扫描 ─────────────────────────────────────────

describe('scanRecordFamilyEntriesFromSessionFile（冷启动流式 entry 源）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jp-scan-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) })

  it('对话行不进结果；v1/v2/legacy/session 行命中收集；跨块长行完整拼接', async () => {
    const { truncateSync, statSync } = await import('node:fs')
    const filePath = join(dir, 'session.jsonl')
    const filler = 'x'.repeat(300 * 1024) // 跨块的填充行（预过滤排除，不进结果）
    const lines = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj' }),
      JSON.stringify({ type: 'message', id: 'm0', message: { role: 'user', content: '聊天内容' } }),
      JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: filler } }),
      JSON.stringify(subagentRegisteredEntry('sa-1')),
      JSON.stringify(subagentSettledEntry('sa-1')),
      JSON.stringify(workflowRegisteredEntry('wf-1')),
      JSON.stringify({ type: 'message', id: 'm2', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'subagent', arguments: { action: 'start', startParam: { task: 't', slug: 's' } } }] } }),
    ]
    writeFileSync(filePath, lines.join('\n') + '\n')
    const entries = scanRecordFamilyEntriesFromSessionFile(filePath)!
    const types = entries.map((e) => (e as { type?: string }).type)
    // 4 条命中：session + 3 个 record 族条目（对话行 m0 不含线索被排除；m1 填充行同）
    expect(types.filter((t) => t === 'message')).toHaveLength(1)
    expect(types.filter((t) => t === 'session')).toHaveLength(1)
    expect(types.filter((t) => t === 'custom')).toHaveLength(3)
    expect(statSync(filePath).size).toBeGreaterThan(300 * 1024) // 填充确实跨块

    void truncateSync
  })

  it('文件缺失 → 空数组（延迟写入合法窗口）；超 32MB → null（回落兼容路径）', async () => {
    expect(scanRecordFamilyEntriesFromSessionFile(join(dir, 'missing.jsonl'))).toEqual([])
    const { truncateSync } = await import('node:fs')
    const big = join(dir, 'big.jsonl')
    writeFileSync(big, '\n')
    truncateSync(big, 33 * 1024 * 1024)
    expect(scanRecordFamilyEntriesFromSessionFile(big)).toBeNull()
  })
})
describe('SessionEventProjection（冷启动 + 推送增量 + dispose）', () => {
  let dir: string
  let recordsDir: string
  let runDir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp-proj-'))
    recordsDir = join(dir, 'records')
    runDir = join(dir, 'workflow-state')
    mkdirSync(recordsDir, { recursive: true })
    mkdirSync(runDir, { recursive: true })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })


  it('冷启动：attach 全量读两域事件流 → 合并快照（entry 批先行喂 v2 条目）', () => {
    writeFileSync(join(recordsDir, 'sa-1.events'), recordJournalLines('sa-1', [createdEvent('sa-1')]).join('\n') + '\n')
    writeFileSync(
      join(runDir, 'wf-1.record.jsonl'),
      [
        JSON.stringify({ type: 'run-created', runId: 'wf-1', workflowName: 'f', argsSummary: '', ts: 1000 }),
        JSON.stringify({ type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, ts: 1100 }),
      ].join('\n') + '\n',
    )
    const projection = new SessionEventProjection({
      sessionId: 's1',
      recordsDir,
      runJournalDir: runDir,
      onProjectionChange: () => {},
    })
    try {
      projection.applyEntryBatch([subagentRegisteredEntry('sa-1'), workflowRegisteredEntry('wf-1')])
      projection.attach()
      expect(projection.subagents.get('sa-1')).toMatchObject({ subagentId: 'sa-1', status: 'running' })
      expect(projection.workflows.get('wf-1')).toMatchObject({ runId: 'wf-1', status: 'running' })
      expect(projection.workflows.get('wf-1')?.agentCalls).toHaveLength(1)
    } finally {
      projection.dispose()
    }
  })

  it('run journal 推送增量：applyJournalReport 喂入追加帧 → [W2 D7] 单源 fold 推进 → run 派生视图到终局', async () => {
    writeFileSync(
      join(runDir, 'wf-1.record.jsonl'),
      [
        JSON.stringify({ type: 'run-created', runId: 'wf-1', workflowName: 'f', argsSummary: '', ts: 1000, seq: 1 }),
        JSON.stringify({ type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, ts: 1100, seq: 2 }),
      ].join('\n') + '\n',
    )
    const projection = new SessionEventProjection({
      sessionId: 's1',
      recordsDir,
      runJournalDir: runDir,
      onProjectionChange: () => {},
    })
    try {
      projection.applyEntryBatch([workflowRegisteredEntry('wf-1')])
      projection.attach()
      expect(projection.workflows.get('wf-1')).toMatchObject({ runId: 'wf-1', status: 'running' })

      // 写侧落盘追加 + 推送报告喂入（event-push-channel 实时路径：报告只带事件本体，
      // seq 水位连续 → 直接 fold，经 core fold 接续）
      const settledFrame = { type: 'agent-settled', taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 700, ts: 1900, seq: 3 }
      const runSettledFrame = { type: 'run-settled', outcome: 'done', artifactsDir: '/tmp/a', ts: 2000, seq: 4 }
      appendFileSync(
        join(runDir, 'wf-1.record.jsonl'),
        [JSON.stringify(settledFrame), JSON.stringify(runSettledFrame)].join('\n') + '\n',
      )
      expect(projection.applyJournalReport(journalReport('run', 'wf-1', [settledFrame, runSettledFrame]))).toBe(true)
      const record = projection.workflows.get('wf-1')!
      expect(record.status).toBe('done')
      expect(record.outcome).toBe('done')
      expect(record.agentCalls[0]).toMatchObject({ status: 'done', durationMs: 700 })
    } finally {
      projection.dispose()
    }
  })

  it('推送增量：applyJournalReport 喂入追加事件 → fold 推进 → onChange 驱动（派生视图变更即信号源）', async () => {
    writeFileSync(join(recordsDir, 'sa-1.events'), recordJournalLines('sa-1', [createdEvent('sa-1')]).join('\n') + '\n')
    const onChange = vi.fn()
    const projection = new SessionEventProjection({
      sessionId: 's1',
      recordsDir,
      runJournalDir: runDir,
      onProjectionChange: onChange,
    })
    try {
      projection.applyEntryBatch([subagentRegisteredEntry('sa-1')])
      projection.attach()
      expect(projection.subagents.get('sa-1')?.status).toBe('running')
      onChange.mockClear()

      // 写侧落盘追加终态事件 + 推送报告喂入
      appendFileSync(join(recordsDir, 'sa-1.events'), `${recordEventLine(settledRecordEvent())}\n`)
      expect(projection.applyJournalReport(journalReport('record', 'sa-1', [settledRecordEvent()]))).toBe(true)
      expect(projection.subagents.get('sa-1')?.status).toBe('idle')
      expect(projection.subagents.get('sa-1')?.stopReason).toBe('completed')
      expect(onChange).toHaveBeenCalled()
    } finally {
      projection.dispose()
    }
  })

  it('坏行宽容 + v2 事件重放幂等（seq 检查）', async () => {
    writeFileSync(
      join(recordsDir, 'sa-1.events'),
      [...recordJournalLines('sa-1', [createdEvent('sa-1')]), '{broken-line', ''].join('\n') + '\n',
    )
    const projection = new SessionEventProjection({
      sessionId: 's1',
      recordsDir,
      runJournalDir: runDir,
      onProjectionChange: () => {},
    })
    try {
      projection.attach()
      expect(projection.subagents.get('sa-1')).toBeDefined() // 坏行跳过不炸派生视图
      // 重放同 seq 事件（重复投递形态）：状态不回退
      appendFileSync(join(recordsDir, 'sa-1.events'), `${recordEventLine(createdEvent('sa-1'))}\n`)
      expect(projection.applyJournalReport(journalReport('record', 'sa-1', [createdEvent('sa-1')]))).toBe(true)
      const record = projection.subagents.get('sa-1')!
      expect(record.status).toBe('running')
      expect(record.subagentId).toBe('sa-1')
    } finally {
      projection.dispose()
    }
  })

  it('dispose 后停增量（推送喂入不复活派生视图）', async () => {
    writeFileSync(join(recordsDir, 'sa-1.events'), recordJournalLines('sa-1', [createdEvent('sa-1')]).join('\n') + '\n')
    const projection = new SessionEventProjection({
      sessionId: 's1',
      recordsDir,
      runJournalDir: runDir,
      onProjectionChange: () => {},
    })
    projection.attach()
    projection.dispose()
    appendFileSync(join(recordsDir, 'sa-1.events'), `${recordEventLine(settledRecordEvent())}\n`)
    expect(projection.applyJournalReport(journalReport('record', 'sa-1', [settledRecordEvent()]))).toBe(false)
    expect(projection.subagents.get('sa-1')?.status).toBe('running')
  })
})
// ── [subagent-observability u3 F4] resolveSubagentLastRound 直测（wire 产出单点）──
// 锚定 roundIdle 收条帧 → SubagentRecord.lastRound 的 8 字段条件展开（投影输入含
// lastRound 变化能否到达 wire 的第一环——展开漏字段/缺字段产键都是红点判据失真）。

describe('resolveSubagentLastRound（roundIdle → lastRound 条件展开）', () => {
  it('roundIdle 缺席 → undefined（从未收尾/存量旧流——wire 不产空对象）', () => {
    expect(resolveSubagentLastRound(undefined)).toBeUndefined()
  })

  it('8 字段条件展开：在场事实字段逐一透出（resultSummary 映射为 result）', () => {
    const lastRound = resolveSubagentLastRound({
      type: 'record-round-idle',
      seq: 4,
      ts: 4000,
      round: 2,
      stopReason: 'stop',
      engineStopReason: 'stop',
      failure: { class: 'provider', kind: 'rate_limited', retryable: 'conditional', retryAfterMs: 1200, raw: '429' },
      promptDisposition: 'handled',
      resultSummary: 'round reply',
      turns: 3,
      totalTokens: 500,
      usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, total: 4 },
      retryAttempts: 2,
      observations: ['structured output was not invoked'],
    })
    expect(lastRound).toEqual({
      engineStopReason: 'stop',
      failure: { class: 'provider', kind: 'rate_limited', retryable: 'conditional', retryAfterMs: 1200, raw: '429' },
      promptDisposition: 'handled',
      result: 'round reply',
      turns: 3,
      usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, total: 4 },
      retryAttempts: 2,
      observations: ['structured output was not invoked'],
    })
  })

  it('缺席字段不产键（条件展开——最小收条帧只透出在场事实，无 undefined 值键）', () => {
    const lastRound = resolveSubagentLastRound({
      type: 'record-round-idle',
      seq: 1,
      ts: 1000,
      round: 1,
      turns: 1,
      totalTokens: 0,
    })
    // turns 是帧必填事实 → 透出；其余 7 字段缺席 → 不产键（含 undefined 值键）。
    expect(lastRound).toEqual({ turns: 1 })
    expect(Object.keys(lastRound!)).toEqual(['turns'])
  })
})
// ════════════════ 来源: events-projection-push-equivalence.test.ts ════════════════

describe('events-projection-push-equivalence', () => {
  // ── fixture ───────────────────────────────────────────────────

  type World = { dir: string; recordsDir: string; runDir: string }

  function makeWorld(tag: string): World {
    const dir = mkdtempSync(join(tmpdir(), `jp-push-${tag}-`))
    const recordsDir = join(dir, 'records')
    const runDir = join(dir, 'workflow-state')
    mkdirSync(recordsDir, { recursive: true })
    mkdirSync(runDir, { recursive: true })
    return { dir, recordsDir, runDir }
  }

  function rmWorld(world: World): void {
    rmSync(world.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }

  /** run 域合法事件序列（写入序，seq 单调）：created → 2 ask → 1 settled → run settled。 */
  function runSequence(): SubagentJournalEvent[] {
    return [
      { type: 'run-created', runId: 'wf-1', workflowName: 'flow', argsSummary: '', ts: 1000, seq: 1 },
      { type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, phase: 'impl', ts: 1100, seq: 2 },
      { type: 'agent-started', taskIndex: 1, agentName: 'w2', attempt: 1, ts: 1200, seq: 3 },
      { type: 'agent-settled', taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 700, ts: 1900, seq: 4 },
      { type: 'phase-settled', phase: 'impl', ts: 1950, seq: 5 },
      { type: 'run-settled', outcome: 'done', artifactsDir: '/tmp/a', ts: 2000, seq: 6 },
    ]
  }

  /** record 域合法事件序列（写入序）：created → bound → round-idle → settled。 */
  function recordSequence(id: string): SubagentJournalEvent[] {
    return [
      { type: 'record-created', seq: 1, ts: 1000, id, agent: 'worker', task: 'Do work', slug: 'work', origin: 'workflow', parentRunId: 'wf-1', stepIndex: 0, rootSessionId: 's1', depth: 0, mode: 'background', startedAt: 1000 },
      { type: 'record-bound', seq: 2, ts: 1500, id, sessionFile: '/sub/sa-1.jsonl', epoch: 0 },
      { type: 'record-round-idle', seq: 3, ts: 2500, id, round: 1, epoch: 0, stopReason: 'completed', turns: 2, totalTokens: 500 },
      { type: 'record-settled', seq: 4, ts: 3000, id, stopReason: 'completed', endedAt: 3000, turns: 2, totalTokens: 500 },
    ]
  }

  const workflowRegisteredEntry = {
    type: 'custom',
    customType: 'workflow-record',
    data: {
      v: 2, kind: 'registered', runId: 'wf-1', workflowName: 'flow', scriptName: 'flow',
      slug: 'flow', startedAt: 1000, recordPath: '/tmp/ws/wf-1.record.jsonl',
    },
  }

  const subagentRegisteredEntry = {
    type: 'custom',
    customType: 'subagent-record',
    data: {
      v: 2, kind: 'registered', id: 'sa-1', agent: 'worker', task: 'Do work', slug: 'work',
      origin: 'workflow', parentRunId: 'wf-1', stepIndex: 0, rootSessionId: 's1', depth: 0, startedAt: 1000,
    },
  }

  const subagentSettledEntry = {
    type: 'custom',
    customType: 'subagent-record',
    data: {
      v: 2, kind: 'settled', id: 'sa-1', status: 'idle', stopReason: 'completed', endedAt: 3000,
      turns: 2, totalTokens: 500,
    },
  }

  function report(domain: 'run' | 'record', fileKey: string, events: readonly SubagentJournalEvent[]): SubagentJournalReport {
    return { domain, fileKey, events: [...events], sessionId: 's1', emittedAt: 42 }
  }

  function makeProjection(world: World, onChange: () => void = () => {}): SessionEventProjection {
    return new SessionEventProjection({
      sessionId: 's1',
      recordsDir: world.recordsDir,
      runJournalDir: world.runDir,
      onProjectionChange: onChange,
    })
  }

  // ── ① 推送-补读等价性 ─────────────────────────────────────────

  describe('推送-补读等价性（喂入源换轨，派生视图终态不变）', () => {
    it('run 域：纯推送 ≡ 推送+缺口补读混合 ≡ 纯文件冷读（合并快照逐字段一致）', () => {
      const events = runSequence()
      const worldPure = makeWorld('run-pure')
      // b. 推送+缺口补读混合：丢帧 1-3（seq 缺口可见）→ 帧 4 的报告触发从字节偏移补读
      const worldGap = makeWorld('run-gap')
      // c. 纯文件冷读（恢复路径）：attach() 从 0 全量读
      const worldCold = makeWorld('run-cold')
      try {
        // a. 纯推送：先落盘（写侧纪律 = 先写后推），再逐帧推送
        writeFileSync(join(worldPure.runDir, 'wf-1.record.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
        const projection = makeProjection(worldPure)
        projection.applyEntryBatch([workflowRegisteredEntry])
        for (const event of events) {
          expect(projection.applyJournalReport(report('run', 'wf-1', [event]))).toBe(true)
        }
        const pure = projection.workflows.get('wf-1')
        projection.dispose()

        writeFileSync(join(worldGap.runDir, 'wf-1.record.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
        const gapProjection = makeProjection(worldGap)
        gapProjection.applyEntryBatch([workflowRegisteredEntry])
        // 冷读 1 条（帧 1 推送成功并推进偏移）后通道断：帧 2-5 丢失
        expect(gapProjection.applyJournalReport(report('run', 'wf-1', [events[0]!]))).toBe(true)
        // 通道恢复：帧 5（seq 5 > 水位 1+1）触发缺口补读——从偏移读到文件尾，覆盖 2-5
        expect(gapProjection.applyJournalReport(report('run', 'wf-1', [events[4]!]))).toBe(true)
        // 帧 6 照常推送（seq 连续性已由补读恢复）
        expect(gapProjection.applyJournalReport(report('run', 'wf-1', [events[5]!]))).toBe(true)
        const gapMixed = gapProjection.workflows.get('wf-1')
        gapProjection.dispose()

        writeFileSync(join(worldCold.runDir, 'wf-1.record.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
        const coldProjection = makeProjection(worldCold)
        coldProjection.applyEntryBatch([workflowRegisteredEntry])
        coldProjection.attach()
        const cold = coldProjection.workflows.get('wf-1')
        coldProjection.dispose()

        expect(pure).not.toBeNull()
        expect(gapMixed).toEqual(pure)
        expect(cold).toEqual(pure)
        // 终态语义锚：事件 fold 定 run 终局与步骤状态（等价性比较的具体锚点）
        expect(pure).toMatchObject({ runId: 'wf-1', status: 'done', outcome: 'done' })
      } finally {
        rmWorld(worldPure)
        rmWorld(worldGap)
        rmWorld(worldCold)
      }
    })

    it('record 域：纯推送 ≡ 推送+缺口补读混合 ≡ 纯文件冷读（合并快照逐字段一致）', () => {
      const events = recordSequence('sa-1')
      const worldPure = makeWorld('rec-pure')
      const worldGap = makeWorld('rec-gap')
      const worldCold = makeWorld('rec-cold')
      try {
        writeFileSync(join(worldPure.recordsDir, 'sa-1.events'), [
          JSON.stringify({ type: 'record-events', id: 'sa-1' }),
          ...events.map((e) => JSON.stringify(e)),
        ].join('\n') + '\n')
        const projection = makeProjection(worldPure)
        projection.applyEntryBatch([subagentRegisteredEntry])
        for (const event of events) {
          expect(projection.applyJournalReport(report('record', 'sa-1', [event]))).toBe(true)
        }
        const pure = projection.subagents.get('sa-1')
        projection.dispose()

        // 混合：帧 2-3 丢失 → 帧 4 报告（seq 4 > 水位 1+1）触发补读覆盖 2-4
        writeFileSync(join(worldGap.recordsDir, 'sa-1.events'), [
          JSON.stringify({ type: 'record-events', id: 'sa-1' }),
          ...events.map((e) => JSON.stringify(e)),
        ].join('\n') + '\n')
        const gapProjection = makeProjection(worldGap)
        gapProjection.applyEntryBatch([subagentRegisteredEntry])
        expect(gapProjection.applyJournalReport(report('record', 'sa-1', [events[0]!]))).toBe(true)
        expect(gapProjection.applyJournalReport(report('record', 'sa-1', [events[3]!]))).toBe(true)
        const gapMixed = gapProjection.subagents.get('sa-1')
        gapProjection.dispose()

        writeFileSync(join(worldCold.recordsDir, 'sa-1.events'), [
          JSON.stringify({ type: 'record-events', id: 'sa-1' }),
          ...events.map((e) => JSON.stringify(e)),
        ].join('\n') + '\n')
        const coldProjection = makeProjection(worldCold)
        coldProjection.applyEntryBatch([subagentRegisteredEntry])
        coldProjection.attach()
        const cold = coldProjection.subagents.get('sa-1')
        coldProjection.dispose()

        expect(pure).not.toBeNull()
        expect(gapMixed).toEqual(pure)
        expect(cold).toEqual(pure)
        expect(pure).toMatchObject({ subagentId: 'sa-1', status: 'idle', stopReason: 'completed' })
      } finally {
        rmWorld(worldPure)
        rmWorld(worldGap)
        rmWorld(worldCold)
      }
    })
  })

  // ── ② 断连收敛 ────────────────────────────────────────────────

  describe('断连收敛（pi 进程死亡 → 重开 session → 冷读收敛）', () => {
    it('推送喂入中断后丢失的增量，由重开派生视图的 attach() 冷读收敛到同一终态', () => {
      const events = runSequence()
      const world = makeWorld('reconnect')
      try {
        // 活体期：推送喂入前 3 帧，pi 进程死亡（后 3 帧已落盘但推送丢失——写侧缓冲即弃）
        writeFileSync(join(world.runDir, 'wf-1.record.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
        const liveProjection = makeProjection(world)
        liveProjection.applyEntryBatch([workflowRegisteredEntry])
        for (const event of events.slice(0, 3)) {
          expect(liveProjection.applyJournalReport(report('run', 'wf-1', [event]))).toBe(true)
        }
        const liveAtDeath = liveProjection.workflows.get('wf-1')
        expect(liveAtDeath).toMatchObject({ status: 'running' }) // 中断窗口：步骤 1 在途
        liveProjection.dispose()

        // 重开 session：新派生视图冷读（既有进程退出链 → 恢复横幅 → 派生视图重建）
        const reopened = makeProjection(world)
        reopened.applyEntryBatch([workflowRegisteredEntry])
        reopened.attach()
        const recovered = reopened.workflows.get('wf-1')
        reopened.dispose()

        // 收敛终态 = 纯冷读终态（journal 是事实源；推送丢失风险被恢复读覆盖）
        const cold = makeProjection(world)
        cold.applyEntryBatch([workflowRegisteredEntry])
        cold.attach()
        const coldState = cold.workflows.get('wf-1')
        cold.dispose()
        expect(recovered).toEqual(coldState)
        expect(recovered).toMatchObject({ status: 'done', outcome: 'done' })
      } finally {
        rmWorld(world)
      }
    })
  })

  // ── ③ 终局条目补读触发 ────────────────────────────────────────

  describe('终局条目补读触发（D6：entry 通道晚于 fold → 一次补读收敛）', () => {
    it('run 域：run-settled 推送丢失且无后续事件 → 终态条目到达触发补读，run 派生视图翻 done', () => {
      const events = runSequence()
      const world = makeWorld('final-run')
      try {
        // 磁盘有完整序列（终局事件已落盘），但推送只送达前 3 帧——run-settled 推送
        // 失败且该文件再无新事件（seq 缺口不会被后续推送暴露的场景）
        writeFileSync(join(world.runDir, 'wf-1.record.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
        const projection = makeProjection(world)
        projection.applyEntryBatch([workflowRegisteredEntry])
        for (const event of events.slice(0, 3)) {
          expect(projection.applyJournalReport(report('run', 'wf-1', [event]))).toBe(true)
        }
        expect(projection.workflows.get('wf-1')).toMatchObject({ status: 'running' })

        // 终态条目经 entry 通道到达（settledAt=2000 晚于 fold 末事件 ts=1200）→
        // recompute 判定「fold 落后于条目通道」→ 一次补读 → fold 收敛 done
        projection.applyEntryBatch([workflowRegisteredEntry, {
          type: 'custom',
          customType: 'workflow-record',
          data: {
            v: 2, kind: 'settled', runId: 'wf-1', status: 'done', reason: 'completed',
            outcome: 'done', settledAt: 2000, callCount: 2, usedTokens: 800,
          },
        }])
        expect(projection.workflows.get('wf-1')).toMatchObject({ status: 'done', outcome: 'done' })

        // 同一条目时点只触发一次（attempted 水位——重复 entry 批不引发重复读放大：
        // 幂等性以终态不变表达）
        projection.applyEntryBatch([workflowRegisteredEntry])
        expect(projection.workflows.get('wf-1')).toMatchObject({ status: 'done', outcome: 'done' })
        projection.dispose()
      } finally {
        rmWorld(world)
      }
    })

    it('record 域：record-settled 推送丢失 → 终态条目到达触发补读，subagent 派生视图翻 idle', () => {
      const events = recordSequence('sa-1')
      const world = makeWorld('final-record')
      try {
        writeFileSync(join(world.recordsDir, 'sa-1.events'), [
          JSON.stringify({ type: 'record-events', id: 'sa-1' }),
          ...events.map((e) => JSON.stringify(e)),
        ].join('\n') + '\n')
        const projection = makeProjection(world)
        projection.applyEntryBatch([subagentRegisteredEntry])
        for (const event of events.slice(0, 2)) {
          expect(projection.applyJournalReport(report('record', 'sa-1', [event]))).toBe(true)
        }
        expect(projection.subagents.get('sa-1')).toMatchObject({ status: 'running' })

        // 终态条目到达（endedAt=3000 晚于 fold 末事件 ts=1500）→ 补读 → idle
        projection.applyEntryBatch([subagentRegisteredEntry, subagentSettledEntry])
        expect(projection.subagents.get('sa-1')).toMatchObject({ status: 'idle', stopReason: 'completed' })
        projection.dispose()
      } finally {
        rmWorld(world)
      }
    })

    it('终局事件行已在 fold（推送正常收敛）时条目到达不触发补读（判据收敛态短路）', () => {
      const events = runSequence()
      const world = makeWorld('final-converged')
      try {
        writeFileSync(join(world.runDir, 'wf-1.record.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
        const projection = makeProjection(world)
        projection.applyEntryBatch([workflowRegisteredEntry])
        for (const event of events) {
          expect(projection.applyJournalReport(report('run', 'wf-1', [event]))).toBe(true)
        }
        expect(projection.workflows.get('wf-1')).toMatchObject({ status: 'done' })

        // 条目晚到（正常时序）：runSettled 已 fold → 判据短路，无补读（终态不变）
        projection.applyEntryBatch([workflowRegisteredEntry, {
          type: 'custom',
          customType: 'workflow-record',
          data: {
            v: 2, kind: 'settled', runId: 'wf-1', status: 'done', reason: 'completed',
            outcome: 'done', settledAt: 2000, callCount: 2, usedTokens: 800,
          },
        }])
        expect(projection.workflows.get('wf-1')).toMatchObject({ status: 'done', outcome: 'done' })
        projection.dispose()
      } finally {
        rmWorld(world)
      }
    })
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('projection-bus-view', () => {
describe('createProjectionBusView：state_changed 拦截 tap（D4 写 2 挂接点）', () => {
  it('state_changed + 合法 modelId：tap 触发 (sessionId, modelId)，帧序先 publish 后 tap（MF9）', () => {
    const bus = makeFakeBus()
    const order: string[] = []
    bus.publish.mockImplementation(() => order.push('publish'))
    const onStateChanged = vi.fn(() => order.push('tap'))
    const view = createProjectionBusView(bus as unknown as IMessageBus, onStateChanged)

    view.publish(SID_m2, stateChangedMessage(MODEL_ID))

    expect(bus.publish).toHaveBeenCalledTimes(1)
    expect(bus.publish).toHaveBeenCalledWith(SID_m2, stateChangedMessage(MODEL_ID))
    expect(onStateChanged).toHaveBeenCalledTimes(1)
    expect(onStateChanged).toHaveBeenCalledWith(SID_m2, MODEL_ID)
    expect(order).toEqual(['publish', 'tap']) // 固定帧序：原序发布先于后置 tap
  })

  it('非 state_changed 类型（session.thinkingLevelSet）：publish 透传但不触发 tap', () => {
    const bus = makeFakeBus()
    const onStateChanged = vi.fn()
    const view = createProjectionBusView(bus as unknown as IMessageBus, onStateChanged)

    const msg = dirtyMessage('session.thinkingLevelSet', { sessionId: SID_m2, level: 'high' })
    view.publish(SID_m2, msg)

    expect(bus.publish).toHaveBeenCalledTimes(1)
    expect(bus.publish).toHaveBeenCalledWith(SID_m2, msg)
    expect(onStateChanged).not.toHaveBeenCalled()
  })

  it('modelId 检查：payload 缺失 / 非 string / 空串 → 不触发 tap（publish 仍透传）', () => {
    const bus = makeFakeBus()
    const onStateChanged = vi.fn()
    const view = createProjectionBusView(bus as unknown as IMessageBus, onStateChanged)

    const dirtyPayloads: unknown[] = [undefined, {}, { modelId: '' }, { modelId: 42 }, { modelId: null }]
    for (const payload of dirtyPayloads) {
      view.publish(SID_m2, dirtyMessage('session.state_changed', payload))
    }

    expect(bus.publish).toHaveBeenCalledTimes(dirtyPayloads.length)
    expect(onStateChanged).not.toHaveBeenCalled()
  })
})
describe('createProjectionBusView：其余 IMessageBus 方法透传', () => {
  it('subscribe/unsubscribe/unsubscribeAll/clearSession 逐项委托底层 bus，subscribe 返回值原样透传', () => {
    const bus = makeFakeBus()
    const view = createProjectionBusView(bus as unknown as IMessageBus, vi.fn())
    const ws: BusClient = { readyState: 1, send: vi.fn() }

    const subResult = view.subscribe(SID_m2, ws)
    view.unsubscribe(SID_m2, ws)
    view.unsubscribeAll(ws)
    view.clearSession(SID_m2)

    expect(bus.subscribe).toHaveBeenCalledWith(SID_m2, ws)
    expect(bus.unsubscribe).toHaveBeenCalledWith(SID_m2, ws)
    expect(bus.unsubscribeAll).toHaveBeenCalledWith(ws)
    expect(bus.clearSession).toHaveBeenCalledWith(SID_m2)
    expect(subResult).toEqual({ snapshot: [], stateSnapshot: [], lastSeq: 0 })
  })

  it('wrapped 对象不依赖 Facade 状态：同参数多次 publish 各自透传（memoize 归 Facade，此处只验视图无状态）', () => {
    const bus = makeFakeBus()
    const onStateChanged = vi.fn()
    const view = createProjectionBusView(bus as unknown as IMessageBus, onStateChanged)

    view.publish(SID_m2, stateChangedMessage(MODEL_ID))
    view.publish(SID_m2, stateChangedMessage('another/model'))

    expect(bus.publish).toHaveBeenCalledTimes(2)
    expect(onStateChanged).toHaveBeenCalledTimes(2)
    expect(onStateChanged).toHaveBeenNthCalledWith(2, SID_m2, 'another/model')
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-state-projection-query-wiring', () => {
afterEach(() => {
  _resetSessionStateQueryForTest()
})
describe('SessionStateProjection 持有 SessionStateQuery（W2 接线）', () => {
  it('构造期创建查询服务并绑定为进程实例（模块槽返回同一实例）', () => {
    const pm = { getClient: vi.fn(() => undefined) } as unknown as IProcessManager
    const projection = new SessionStateProjection(makeDeps(pm))

    expect(projection.stateQuery).toBeDefined()
    expect(getSessionStateQuery()).toBe(projection.stateQuery)
  })

  it('查询的活跃判定走注入的 pm.getClient（spawn 风险点 1：禁 ensureActive）', async () => {
    const client = { id: 'c1' } as unknown as IPiEngine
    const getClient = vi.fn(() => client)
    const ensureActive = vi.fn()
    const pm = { getClient, ensureActive } as unknown as IProcessManager
    const projection = new SessionStateProjection(makeDeps(pm))

    // 有 client 但投影实例表未注册该 session → live 分支的第二条件不满足，落冷读分叉
    await expect(projection.stateQuery.getState('s1')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })

    expect(getClient).toHaveBeenCalledWith('s1')
    expect(ensureActive).not.toHaveBeenCalled()
  })

  it('解绑后 getSessionStateQuery 返回 undefined（handler 走 unsupported 防御分支）', () => {
    const pm = { getClient: vi.fn(() => undefined) } as unknown as IProcessManager
    new SessionStateProjection(makeDeps(pm))
    expect(getSessionStateQuery()).toBeDefined()
    _resetSessionStateQueryForTest()
    expect(getSessionStateQuery()).toBeUndefined()
  })

  it('冷路径埋点接 runtime logger（设计 §3.1「可观测」栏：单次耗时 + 扫描目录数）', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    const pm = { getClient: vi.fn(() => undefined) } as unknown as IProcessManager
    const projection = new SessionStateProjection(makeDeps(pm))

    await expect(projection.stateQuery.getState('no-such-session')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })

    expect(debugSpy).toHaveBeenCalledTimes(1)
    expect(debugSpy).toHaveBeenCalledWith('[session-state-query] cold read', {
      sessionId: 'no-such-session',
      source: 'disk-scan',
      durationMs: expect.any(Number),
      scannedDirCount: expect.any(Number),
      found: false,
    })
    debugSpy.mockRestore()
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-state-query', () => {
// ── 测试体 ─────────────────────────────────────────────────────────────

describe('SessionStateQuery.getState', () => {
  let dataDir: string
  let origDataDir: string | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'u-w2-getstate-'))
    origDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
    btwRegistry.clear()
  })

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = origDataDir
    _resetSessionMetaCacheForTest()
    btwRegistry.clear()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ── §7 验收项 1：fork 混合分支文件冷读 ──

  it('项1-a 打开冷线显示创建时模型 A（活跃路径逆读，非物理尾 B）', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    const pm = makeProcessTable()
    const { query } = makeQuery({ pm })

    const state = await query.getState(fx.linePiId)

    expect(state).toEqual({ sessionId: fx.linePiId, modelId: 'prov-a/model-a', thinkingLevel: 'high' })
    // 判别力自证：物理尾逆序第一条模型记录是 mcB（被撤分支）——本用例读到的不是它
    expect(state.modelId).not.toBe('prov-b/model-b')
    // 零 spawn（进程表断言）
    expect(pm.spawnCalls).toEqual([])
  })

  it('项1-b 重启后（注册表无记录 + 缓存清空 + 全新查询实例）再开线仍显示 A', async () => {
    const fx = seedForkFixture(dataDir)
    // 不填 btwRegistry = 重启后的线：BtwService.rebuildFromDisk() 只重建自己的 registry，
    // 不注册进 lifecycle.sessions，故注册表记录一路结构性缺席，走存储树布局定位。
    const first = makeQuery({ pm: makeProcessTable() })
    expect((await first.query.getState(fx.linePiId)).modelId).toBe('prov-a/model-a')

    // 「重启」的离线等价物：metaCache 清空（缓存不跨进程持久）+ 目录 TTL 缓存清空 +
    // 全新 SessionStateQuery 实例（无任何内存态继承）
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
    const afterRestart = makeQuery({ pm: makeProcessTable() })
    const state = await afterRestart.query.getState(fx.linePiId)

    expect(state).toEqual({ sessionId: fx.linePiId, modelId: 'prov-a/model-a', thinkingLevel: 'high' })
  })

  it('项1-c 主会话再切 D 后线仍显示 A（线读自己的文件，不是主会话当前值）', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    const { query } = makeQuery({ pm: makeProcessTable() })
    expect((await query.getState(fx.linePiId)).modelId).toBe('prov-a/model-a')

    // 主会话之后又换过模型（追加到主文件）——线文件的活跃路径不变
    appendFileSync(fx.mainFile, `${modelChangeLine({ id: 'mcE', parentId: 'mcD' }, 'prov-e', 'model-e')}\n`)
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()

    // 主会话自身冷读反映最新值（对照：证明 fixture 真的在动）
    const mainState = await query.getState(fx.mainSid)
    expect(mainState.modelId).toBe('prov-e/model-e')
    // 线不受影响
    expect((await query.getState(fx.linePiId)).modelId).toBe('prov-a/model-a')
  })

  it('项1-d 门有判别力：fixture 的物理尾方向带 B 记录、末条是挂在 A 侧的 label', async () => {
    const fx = seedForkFixture(dataDir)
    const tail = readFileSync(fx.lineFile, 'utf8')
    // 被撤分支的 model_change B 在文件里（物理尾逆读会命中它 = 错值）
    expect(tail).toContain('model-b')
    // 末条 entry 是 label（父 = tlA，A 侧 trunk）——混合分支形态的结构证据
    const lastLine = tail.trimEnd().split('\n').at(-1) as string
    expect(JSON.parse(lastLine)).toMatchObject({ type: 'label', parentId: 'tlA' })
  })

  // ── §7 验收项 6：零 spawn ──

  it('项6-a 冷读不产生 pi 子进程（进程表断言：spawn 形态调用零次）', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    const pm = makeProcessTable()

    const { query } = makeQuery({ pm })
    const state = await query.getState(fx.linePiId)

    expect(state.modelId).toBe('prov-a/model-a')
    // 进程表：createSession / restoreSession / ensureProcess / withEphemeralPi / rekey 全部零调用
    expect(pm.spawnCalls).toEqual([])
    // 活跃判定走的是 getClient（风险点 1 的唯一合法入口），不是 ensureActive
    expect(pm.getClient).toHaveBeenCalledWith(fx.linePiId)
  })

  it('项6-b 活会话快照未就绪：无 restore/spawn + 应答字段缺省返回', async () => {
    const liveSid = '33333333-3333-4333-8333-333333333333'
    const pm = makeProcessTable([liveSid])
    // 活会话（有 client）但两实例快照都未就绪（.get() = undefined）
    const { query } = makeQuery({ pm, live: liveStatesStub(undefined, undefined) })

    const state = await query.getState(liveSid)

    // 字段缺省 = 未就绪（显式未知），不编码为 0/空串、不回退猜测
    expect(state).toEqual({ sessionId: liveSid })
    expect(state.modelId).toBeUndefined()
    expect(state.thinkingLevel).toBeUndefined()
    // 未就绪不得触发 restore（进程表断言）
    expect(pm.spawnCalls).toEqual([])
    // 未就绪不得回落到冷读（否则会把「活会话暂无快照」误报成文件值）
    expect(pm.getClient).toHaveBeenCalledWith(liveSid)
  })

  it('项6-c 活会话快照就绪：读实例快照，与 state_changed 同一数据源', async () => {
    const liveSid = '33333333-3333-4333-8333-333333333333'
    const pm = makeProcessTable([liveSid])
    const { query } = makeQuery({ pm, live: liveStatesStub('prov-live/model-live', 'medium') })

    const state = await query.getState(liveSid)

    expect(state).toEqual({ sessionId: liveSid, modelId: 'prov-live/model-live', thinkingLevel: 'medium' })
    expect(pm.spawnCalls).toEqual([])
  })

  it('项6-d 活会话只就绪一个维度：另一维缺省（字段级，不打包兜底）', async () => {
    const liveSid = '33333333-3333-4333-8333-333333333333'
    const pm = makeProcessTable([liveSid])
    const { query } = makeQuery({ pm, live: liveStatesStub('prov-live/model-live', undefined) })
    const state = await query.getState(liveSid)
    expect(state).toEqual({ sessionId: liveSid, modelId: 'prov-live/model-live' })
  })

  it('项6-e 已注册但进程已退出（getClient undefined）：回落冷读文件，不 restore', async () => {
    const fx = seedForkFixture(dataDir)
    const pm = makeProcessTable() // liveSids 空 = 进程已退出
    // 实例快照仍在（registered 过），但 client 没了 → 必须走冷读
    const { query } = makeQuery({ pm, live: liveStatesStub('prov-stale/model-stale', 'low') })

    const state = await query.getState(fx.mainSid)

    expect(state).toEqual({ sessionId: fx.mainSid, modelId: 'prov-d/model-d', thinkingLevel: 'high' })
    expect(pm.spawnCalls).toEqual([])
  })

  // ── 会话不存在 / 主会话冷读分叉 ──

  it('会话不存在：两段扫描 + btw 注册表都未命中 → SESSION_NOT_FOUND 结构化错误', async () => {
    const { query } = makeQuery({ pm: makeProcessTable() })
    await expect(query.getState('44444444-4444-4444-8444-444444444444')).rejects.toBeInstanceOf(SessionNotFoundError)
    await expect(query.getState('55555555-5555-4555-8555-555555555555')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  it('主会话冷读：段 1 缓存未命中 → 段 2 全扫命中', async () => {
    const fx = seedForkFixture(dataDir)
    // 预填 sessionMetaCache 后清空，确保段 1 miss（段 2 才被走到）
    expect(scanPiSessions({ force: true }).length).toBe(1)
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()

    const { query, traces } = makeQuery({ pm: makeProcessTable() })
    const state = await query.getState(fx.mainSid)

    expect(state).toEqual({ sessionId: fx.mainSid, modelId: 'prov-d/model-d', thinkingLevel: 'high' })
    expect(traces).toHaveLength(1)
    expect(traces[0]).toMatchObject({ sessionId: fx.mainSid, source: 'disk-scan', found: true })
    // 扫描目录数 = 该轮枚举的 cwd 分组目录数（fixture 只有 1 个 cwd 分组）
    expect(traces[0].scannedDirCount).toBe(1)
    expect(sessionScanDirCount.last).toBe(1)
  })

  it('主会话冷读：段 1 缓存命中 → 不发生磁盘扫描（埋点 source=meta-cache、目录数 0）', async () => {
    const fx = seedForkFixture(dataDir)
    // 段 1 前置：先跑一次全扫把 meta 填进 sessionMetaCache
    expect(scanPiSessions({ force: true }).length).toBe(1)
    expect(findCachedSessionFileById(fx.mainSid)).toBe(fx.mainFile)

    const { query, traces } = makeQuery({ pm: makeProcessTable() })
    const state = await query.getState(fx.mainSid)

    expect(state).toEqual({ sessionId: fx.mainSid, modelId: 'prov-d/model-d', thinkingLevel: 'high' })
    expect(traces[0]).toMatchObject({ source: 'meta-cache', scannedDirCount: 0, found: true })
  })

  it('文件在但无模型记录：显式未知（字段缺省），不猜、不报错', async () => {
    const sid = '66666666-6666-4666-8666-666666666666'
    const cwdGroup = 'b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
    writeJsonl(join(dataDir, 'agent', 'sessions', cwdGroup, `${sid}.jsonl`), [
      headerLine(sid, '/tmp/proj'),
      entryLine('session_info', { id: 's1' }),
    ])
    invalidateScanDirCache()

    const { query } = makeQuery({ pm: makeProcessTable() })
    const state = await query.getState(sid)

    expect(state).toEqual({ sessionId: sid })
    expect(state.modelId).toBeUndefined()
  })

  // ── 冷路径埋点 ──

  it('埋点：单次耗时 + 扫描目录数 + 定位来源三字段齐录', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    let clock = 1000
    const { query, traces } = makeQuery({ pm: makeProcessTable(), now: () => (clock += 7) })

    await query.getState(fx.linePiId)

    expect(traces).toHaveLength(1)
    expect(traces[0]).toMatchObject({ sessionId: fx.linePiId, source: 'btw-registry', scannedDirCount: 0, found: true })
    // 耗时 = 注入时钟的增量（确定性，不依赖真实挂钟）
    expect(traces[0].durationMs).toBe(7)
  })

  it('埋点：未命中也留痕（found=false，供「SESSION_NOT_FOUND 频度」归因）', async () => {
    const { query, traces } = makeQuery({ pm: makeProcessTable() })
    await expect(query.getState('44444444-4444-4444-8444-444444444444')).rejects.toBeInstanceOf(SessionNotFoundError)
    expect(traces).toEqual([expect.objectContaining({ source: 'disk-scan', found: false, scannedDirCount: 0 })])
  })

  it('埋点回调缺省时不抛（生产未注入 logger 的形态）', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    const query = new SessionStateQuery({
      getClient: () => undefined,
      getReplicatedStates: () => undefined,
      locateMainSessionFileFromCache: (sid) => findCachedSessionFileById(sid),
      locateMainSessionFileFromDisk: (sid) => findScannedSessionFileById(sid),
      locateBtwLineFile: (sessionId) => btwRegistry.get(sessionId),
      locateBtwLineFileByLayout: (sessionId) => findBtwLineFileByLayout(sessionId),
    })
    await expect(query.getState(fx.linePiId)).resolves.toMatchObject({ modelId: 'prov-a/model-a' })
  })

  // ── 判别顺序（dmg-r1-3：surface 判别 → 段 1 → 段 2 → btw 布局兜底）──

  it('判别顺序：主会话段 2 命中即止，不枚举 btw 存储树（布局兜底沉到最后）', async () => {
    const fx = seedForkFixture(dataDir)
    // 段 1 miss（缓存空）→ 段 2 全扫命中主会话
    const { query, traces, layoutCalls } = makeQuery({ pm: makeProcessTable() })

    const state = await query.getState(fx.mainSid)

    expect(state.modelId).toBe('prov-d/model-d')
    // 布局兜底只在两段均未命中后调：主会话段 2 已命中，存储树零枚举
    expect(layoutCalls).toEqual([])
    expect(traces[0]).toMatchObject({ source: 'disk-scan', found: true })
    // 埋点只含段 2 全扫的 cwd 分组目录数（fixture 1 个分组）
    expect(traces[0].scannedDirCount).toBe(1)
  })

  it('埋点计数经段 2 注入缝返回值取得（不反向探 infra 模块级 sessionScanDirCount）', async () => {
    const fx = seedForkFixture(dataDir)
    // 段 2 缝注入带计数桩（计数 7 = fixture 不可能出现的值）：埋点 scannedDirCount 来自
    // 注入缝返回值而非 infra 全局——services → infra 只走 deps 注入缝单向流动，与
    // locateBtwLineFileByLayout 的 { filePath, scannedDirCount } 同构
    const globalCountBefore = sessionScanDirCount.last
    const { query, traces, layoutCalls } = makeQuery({
      pm: makeProcessTable(),
      diskLocate: () => ({ filePath: fx.mainFile, scannedDirCount: 7 }),
    })

    const state = await query.getState(fx.mainSid)

    expect(state).toEqual({ sessionId: fx.mainSid, modelId: 'prov-d/model-d', thinkingLevel: 'high' })
    expect(traces[0]).toMatchObject({ source: 'disk-scan', found: true, scannedDirCount: 7 })
    // 本轮未发生真实扫描：infra 全局计数器未被触碰（计数来源 = 注入缝返回值）
    expect(sessionScanDirCount.last).toBe(globalCountBefore)
    expect(layoutCalls).toEqual([])
  })

  it('判别顺序：btw 线重启后（注册表无记录）段 1/段 2 miss 后才走布局兜底，埋点计入布局枚举目录数', async () => {
    const fx = seedForkFixture(dataDir)
    // 不填 btwRegistry = 重启后的线：注册表判别 miss → 段 1 miss → 段 2 全扫 miss
    // （线文件构造性不在 scanPiSessions 范围）→ 布局兜底命中
    const { query, traces, layoutCalls } = makeQuery({ pm: makeProcessTable() })

    const state = await query.getState(fx.linePiId)

    expect(state).toEqual({ sessionId: fx.linePiId, modelId: 'prov-a/model-a', thinkingLevel: 'high' })
    // 布局兜底确实被走到（两段 miss 之后），且只走一次
    expect(layoutCalls).toEqual([fx.linePiId])
    expect(traces[0]).toMatchObject({ sessionId: fx.linePiId, source: 'btw-registry', found: true })
    // 埋点 scannedDirCount = 段 2 全扫的 cwd 分组目录数（1）+ 布局兜底枚举的 mainSid
    // 会话目录数（1）——布局枚举成本必须可观测（设计 §3.1 四要素重审取数来源）
    expect(traces[0].scannedDirCount).toBe(2)
  })

  // ── btw 线定位的两级（注册表记录 / 存储树布局）──

  it('btw 线：注册表记录命中（lifecycle.get(sessionId).sessionFilePath）即用，不碰布局定位', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    const { query, layoutCalls } = makeQuery({ pm: makeProcessTable() })

    expect((await query.getState(fx.linePiId)).modelId).toBe('prov-a/model-a')
    // 注册表判别是冷读第一步（廉价内存读）：命中即止，不得枚举存储树（dmg-r1-3 判别顺序）
    expect(layoutCalls).toEqual([])
    // 布局定位读的是同一个文件（两级寻址等价性的直接证据）
    expect(findBtwLineFileByLayout(fx.linePiId).filePath).toBe(fx.lineFile)
  })

  it('btw 线：注册表无记录（重启后 rebuildFromDisk 不注册进 lifecycle）→ 存储树布局定位兜底', async () => {
    const fx = seedForkFixture(dataDir)
    // 不填 btwRegistry = 重启后的线（BtwService.registry 有、lifecycle.sessions 无）
    const { query } = makeQuery({ pm: makeProcessTable() })

    const state = await query.getState(fx.linePiId)

    expect(state).toEqual({ sessionId: fx.linePiId, modelId: 'prov-a/model-a', thinkingLevel: 'high' })
  })

  it('btw 线：两级都未命中（线文件不在磁盘）→ SESSION_NOT_FOUND，不猜路径', async () => {
    const { query } = makeQuery({ pm: makeProcessTable() })
    await expect(query.getState('55555555-5555-4555-8555-555555555555')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })
})
// ── findBtwLineFileByPiSessionId 命名形态直测（重启后布局兜底寻址）──────────────────
//
// 覆盖 pi forkFrom 实盘命名修复：定位器须同时命中两种文件名形态，防「重启后线寻址
// 结构性失败 → session.getState(线) 恒 SESSION_NOT_FOUND」回归（D3 真机验收 A11 缺陷 1）。

describe('findBtwLineFileByPiSessionId 命名形态', () => {
  let dataDir: string
  let origDataDir: string | undefined

  /** 在 `<dataDir>/ext-sessions/<mainSid>/btw/` 下写一个（可为空的）线文件并返回路径 */
  function writeLineFile(mainSid: string, fileName: string): string {
    const file = join(dataDir, 'ext-sessions', mainSid, 'btw', fileName)
    writeJsonl(file, [headerLine('77777777-7777-4777-8777-777777777777', '/tmp/proj')])
    return file
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'u-w2-btw-locate-'))
    origDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
  })

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = origDataDir
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('时间戳前缀命名（pi forkFrom 实盘形态）命中', () => {
    const linePiId = '22222222-2222-4222-8222-222222222222'
    const file = writeLineFile('11111111-1111-4111-8111-111111111111', `2026-10-24T13-00-44-583Z_${linePiId}.jsonl`)

    expect(findBtwLineFileByPiSessionId(linePiId)).toBe(file)
  })

  it('精确命名（历史形态 <piSessionId>.jsonl）同样命中（双形态兼容）', () => {
    const linePiId = '22222222-2222-4222-8222-222222222222'
    const file = writeLineFile('11111111-1111-4111-8111-111111111111', `${linePiId}.jsonl`)

    expect(findBtwLineFileByPiSessionId(linePiId)).toBe(file)
  })

  it('同 id 多条命中（精确名 + 时间戳前缀）取最新 mtime 的文件', () => {
    const linePiId = '22222222-2222-4222-8222-222222222222'
    const old = writeLineFile('11111111-1111-4111-8111-111111111111', `${linePiId}.jsonl`)
    const fresh = writeLineFile('11111111-1111-4111-8111-111111111111', `2026-10-24T13-00-44-583Z_${linePiId}.jsonl`)
    // mtime 造差：old 置为过去，fresh 保持刚落盘的 now
    const past = new Date(Date.now() - 60_000)
    utimesSync(old, past, past)

    expect(findBtwLineFileByPiSessionId(linePiId)).toBe(fresh)
  })

  it('反向后缀形态（<piSessionId>_其他.jsonl）不命中（只认「前缀_」方向）', () => {
    const linePiId = '22222222-2222-4222-8222-222222222222'
    writeLineFile('11111111-1111-4111-8111-111111111111', `${linePiId}_2026-10-24T13-00-44-583Z.jsonl`)

    expect(findBtwLineFileByPiSessionId(linePiId)).toBeUndefined()
  })

  it('线文件不存在 → undefined（不猜路径、不抛）', () => {
    expect(findBtwLineFileByPiSessionId('22222222-2222-4222-8222-222222222222')).toBeUndefined()
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('trace-parity', () => {
describe('A24 探针 P1：RPC 录制产物 vs 文件直读产物 SessionEntry 序列逐条 diff 为空', () => {
  // [2026-09 测试舰队审查 r2-23] 「录制 fixture 清单完整」恒真用例已删（清单写死 3 断言 3，
  // 不具备防漂移能力——真正的 fixture 漂移防护由 it.each 读文件失败翻红承担）。

  it.each(RECORDED_SESSIONS)('%s —— parity diff 为空（$note）', ({ name }) => {
    const raw = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf-8')) as {
      response: { data: { entries: unknown[]; leafId: string | null } }
    }
    const rpcEntries = raw.response.data.entries
    expect(rpcEntries.length).toBeGreaterThan(0) // 录制产物非空（防静默录到 boot session）

    const snapshot = buildTraceSnapshotFromFile(name, join(FIXTURES, `${name}.jsonl`), store)

    // 1. 核心 parity：entry 序列逐条 deep-equal（顺序 + 内容全等）
    expect(snapshot.entries).toHaveLength(rpcEntries.length)
    const diffs = diffEntries(rpcEntries, snapshot.entries)
    expect(diffs, `parity diff 非空（A1 决策需重审）:\n${diffs.join('\n')}`).toEqual([])

    // 2. 录制文件无坏行（RPC 路径 pi 静默跳过坏行会造成假 parity——文件侧必须确认无坏行）
    expect(snapshot.malformed).toEqual([])

    // 3. header 一致性：文件首行 header 的 id 与 entries 的链根对应（RPC 不含 header，
    //    路径 A 由端口补读——此断言锁定补读来源与 RPC 同一文件）
    expect(snapshot.header?.id).toBeDefined()

    // 4. leafId 不变量：pi 返回的 leafId = 文件末条带 id entry 的 id（线性链语义）
    const lastWithId = [...snapshot.entries].reverse().find((e) => typeof (e as { id?: unknown }).id === 'string') as { id: string } | undefined
    expect(raw.response.data.leafId).toBe(lastWithId?.id)
  })

  it('覆盖范围：三个 session 合计 entry 数 ≥ 100（防 fixture 退化为玩具样本）', () => {
    let total = 0
    for (const { name } of RECORDED_SESSIONS) {
      const raw = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf-8')) as {
        response: { data: { entries: unknown[] } }
      }
      total += raw.response.data.entries.length
    }
    expect(total).toBeGreaterThanOrEqual(100)
  })
})
});
});
