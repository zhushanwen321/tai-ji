/**
 * TraceSync 模块直接测试（S4：trace 编排半截从 SessionService 迁出后的直接测试面——
 * 设计明示编排层此前零覆盖，本文件即 G2 形态：stub client 直测，不构造 Facade 全家桶，
 * import 不含 session-service）。
 *
 * 内容三块：
 * - 纯函数：buildTraceSnapshotFromFile 用例（原 session-trace.test.ts 随迁）+
 *   parseTraceHeaderLine fork 血缘透传用例（u-S4 补覆盖）。
 * - 编排层：getTraceEntries（RPC 混合路由）/ syncTraceEntries（增量腿串行链）/
 *   fetchCurrentSystemPrompt（现取轮询）/ onSessionDisposed（销毁清理）——原经 Facade 的
 *   session-trace.test.ts 用例改由本文件直测模块（同一实现代码路径），并补充此前
 *   零覆盖的分支（Entry not found 基线失效、retry 全量重建等）。
 * - EventInterpreter 触发接线（A33 增量腿入口，原 session-trace.test.ts 随迁）：四类
 *   触发事件 → onTraceSync 回调（interpreter 是设计 §5 判定的不动健康样本，此处只守
 *   触发接线，不测 interpreter 内部）。
 *
 * mock 保真度（A31 mockFidelityNote 沿袭）：仅 mock RPC 传输边界——pi 的 get_entries 返回值
 * 来自本地 pi CLI 真实录制 fixture（__fixtures__/get-entries-*.json，录制脚本
 * scripts/record-get-entries-fixtures.mjs），文件读取走真实 infra 实现（readFirstJsonlLine /
 * readSessionEndMeta / readFileSync），不 mock pi 内部解析逻辑。
 *
 * 运行：cd packages/runtime && npx vitest run trace-sync
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { TraceSync, buildTraceSnapshotFromFile, parseTraceHeaderLine } from '../trace-sync.js'
import { EventInterpreter } from '../event-interpreter.js'
import { MessageBus } from '../../message-bus/message-bus.js'
import { readFirstJsonlLine, readSessionEndMeta } from '../../../infra/pi/session-file-utils.js'
import type { IManagedSessionView } from '../types.js'
import type { IPiEngine, IProcessManager } from '../../ports/pi-engine.js'
import type { ISessionStore, ScannedSessionMeta } from '../../ports/session.js'
import type { ServerMessage } from '@taiji/shared'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')

/** 加载 RPC 录制 fixture（pi CLI 真实响应，含 meta 头 + response）。 */
function loadRecorded(name: string): { data: { entries: unknown[]; leafId: string | null } } {
  const raw = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf-8')) as {
    response: { data: { entries: unknown[]; leafId: string | null } }
  }
  return raw.response
}

/** 读 fixture JSONL 首行 header 的 session id（scanSessions 假元数据要用真实 id 对上）。 */
function fixtureSessionId(name: string): string {
  const first = readFirstJsonlLine(join(FIXTURES, `${name}.jsonl`))
  if (!first) throw new Error(`fixture ${name}.jsonl has no first line`)
  return (JSON.parse(first) as { id: string }).id
}

/**
 * 假 ISessionStore：发现层（scanSessions）假，读取层（trace 三读）全部委托真实 infra
 * （readFirstJsonlLine / readFileSync / readSessionEndMeta）——保真度锚点：文件读取代码
 * 路径是生产实现，mock 只替换「在哪个目录找文件」。
 */
function makeSessionStore(metas: ScannedSessionMeta[]): ISessionStore {
  return {
    scanSessions: () => metas,
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
    // u4c（D5⑤）：ISessionStore 新增流式归一化成员（本文件不触达，no-op 满足类型）
    normalizeSessionFileStreaming: () => {},
    persistHandoffSidecar: () => {},
    trash: () => Promise.resolve(),
  }
}

function metaFor(name: string): ScannedSessionMeta {
  return {
    id: fixtureSessionId(name),
    filePath: join(FIXTURES, `${name}.jsonl`),
    cwd: '/tmp/trace-fixture',
    timestamp: '2026-08-20T00:00:00.000Z',
    name: null,
    lastModified: 0,
    size: 0,
    outcome: null,
  }
}

/** 最小 IManagedSessionView stub（TraceSync 只读 sessionFilePath / isGenerating / isCompacting）。 */
function makeSessionView(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 'stub-sid',
    cwd: '/tmp',
    label: 'stub',
    modelId: 'm',
    createdAt: 0,
    lastActiveAt: 0,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    ...overrides,
  }
}

/**
 * 构造 TraceSync 直测环境（G2：stub pm/client + 真实 MessageBus，不构造 Facade）。
 * active=false 时 pm.getClient 返回 undefined；sessionRecord 控制 getSession 返回的
 * busy 预检 / sessionFilePath 视图（undefined = sessions Map 无条目）。
 */
function makeEnv(opts: {
  metas?: ScannedSessionMeta[]
  active?: boolean
  sessionRecord?: IManagedSessionView
} = {}) {
  const client = {
    getEntries: vi.fn(async () => loadRecorded('get-entries-1-mixed-kinds')),
    prompt: vi.fn(async () => ({})),
  }
  const pm = {
    getClient: vi.fn(() => (opts.active === false ? undefined : (client as unknown as IPiEngine))),
  } as unknown as IProcessManager
  const bus = new MessageBus()
  const publishSpy = vi.spyOn(bus, 'publish')
  const traceSync = new TraceSync({
    pm,
    sessionStore: makeSessionStore(opts.metas ?? []),
    getSession: (sessionId: string) => (opts.sessionRecord ? { ...opts.sessionRecord, id: sessionId } : undefined),
    getMessageBus: () => bus,
  })
  return { traceSync, bus, publishSpy, client, pm }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── 纯函数（原 session-trace.test.ts 随迁）──

describe('纯函数：buildTraceSnapshotFromFile（路径 B 文件直读）', () => {
  it('损坏行容错：占位保留行号与原文，不静默丢失（design §3.1 失败路径）', () => {
    const store = makeSessionStore([metaFor('get-entries-1-mixed-kinds')])
    const snapshot = buildTraceSnapshotFromFile('a32-file-malformed', join(FIXTURES, 'file-path-malformed.jsonl'), store)
    expect(snapshot.malformed).toEqual([
      { lineNumber: 3, raw: 'this line is not json at all' },
      { lineNumber: 5, raw: '{"broken": ' },
    ])
  })

  it('JSONL + sidecar 合并：header 提取、entries 按文件行序、sessionEnd 来自 .meta.json', () => {
    const store = makeSessionStore([])
    const snapshot = buildTraceSnapshotFromFile('a32-file-malformed', join(FIXTURES, 'file-path-malformed.jsonl'), store)
    expect(snapshot.source).toBe('file')
    expect(snapshot.header?.id).toBe('a32-file-malformed')
    // 损坏行不进 entries（占位归 malformed），无 id 的 session_info 保留（真实文件侧支形态）
    expect(snapshot.entries.map((e) => (e as { type: string; id?: string }).type)).toEqual(['message', 'model_change', 'session_info'])
    expect(snapshot.sessionEnd).toEqual({ type: 'session_end', outcome: 'done', timestamp: '2026-08-20T01:00:00.000Z' })
    // 文件路径无 leaf 概念
    expect(snapshot.leafId).toBeUndefined()
  })

  it('路径未知（filePath=null）→ empty 空态，不读文件不抛错', () => {
    const snapshot = buildTraceSnapshotFromFile('sid-no-path', null, makeSessionStore([]))
    expect(snapshot).toEqual({ sessionId: 'sid-no-path', source: 'empty', entries: [], malformed: [] })
  })
})

// ── 纯函数：parseTraceHeaderLine（fork header parentSession 两形态透传，u-S4 补覆盖）──

describe('纯函数：parseTraceHeaderLine（header 首行 → SessionTraceHeaderPayload 纯透传）', () => {
  it('fork header：parentSession / forkEntryId 原样透传（真实录制首行，零改写零筛选）', () => {
    // fixture 首行是 pi 真实录制的 fork 产物 header（含血缘指针 parentSession/forkEntryId）；
    // 透传 = 解析结果与 JSON.parse 逐字段一致——TraceSync 不筛选/不改写 fork 血缘字段
    //（SessionTraceSnapshot.header 契约：parentSession 两形态原样透传）。
    const line = readFirstJsonlLine(join(FIXTURES, 'get-entries-3-fork-header.jsonl'))
    expect(line).toBeDefined()
    const header = parseTraceHeaderLine(line)
    expect(header).toEqual(JSON.parse(line as string))
    expect(header?.parentSession).toBe('s-fork-src')
    expect(header?.forkEntryId).toBe('a1')
  })

  it('普通 header（非 fork 产物）：无 parentSession / forkEntryId → 缺省透传，不注入字段', () => {
    const raw = { type: 'session', version: 3, id: 'plain-sid', timestamp: '2026-08-20T00:00:00.000Z', cwd: '/tmp' }
    const header = parseTraceHeaderLine(JSON.stringify(raw))
    expect(header).toEqual(raw)
    expect(header?.parentSession).toBeUndefined()
    expect('parentSession' in (header ?? {})).toBe(false)
    expect('forkEntryId' in (header ?? {})).toBe(false)
  })
})

// ── getTraceEntries 编排（全量拉取混合路由）──

describe('getTraceEntries 编排（RPC → 文件降级 → empty 混合路由）', () => {
  it('活跃路径 RPC：entries/leafId 来自 pi 录制响应 + header 由文件首行补读（getEntries 不含 header）+ malformed 补齐', async () => {
    const recorded = loadRecorded('get-entries-1-mixed-kinds')
    const { traceSync, client } = makeEnv({ metas: [metaFor('get-entries-1-mixed-kinds')], active: true })
    const sid = fixtureSessionId('get-entries-1-mixed-kinds')

    const snapshot = await traceSync.getTraceEntries(sid)

    expect(client.getEntries).toHaveBeenCalledWith() // 全量拉取（无 since）
    expect(snapshot.source).toBe('rpc')
    expect(snapshot.entries).toEqual(recorded.data.entries)
    expect(snapshot.leafId).toBe(recorded.data.leafId)
    expect(snapshot.header).toBeDefined()
    expect(snapshot.header?.id).toBe(sid)
    // fixture 无坏行 → malformed 空（RPC 路径补齐机制见下例）
    expect(snapshot.malformed).toEqual([])
  })

  it('RPC 路径补齐文件坏行（G1 损坏行占位可见）：pi get_entries 静默跳过的坏行由文件解析占位', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'trace-rpc-malformed-'))
    const sid = 'rpc-tail-malformed-session'
    const okEntries = [
      { type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: 'hello' } },
      { type: 'session_info', name: 'repro' },
    ]
    writeFileSync(
      join(tmp, 's.jsonl'),
      `${JSON.stringify({ type: 'session', version: 3, id: sid, cwd: tmp })}\n${JSON.stringify(okEntries[0])}\n${JSON.stringify(okEntries[1])}\n{invalid json!!!\n`,
    )
    const { traceSync, client } = makeEnv({
      metas: [{ ...metaFor('get-entries-1-mixed-kinds'), id: sid, filePath: join(tmp, 's.jsonl') }],
      active: true,
    })
    client.getEntries.mockResolvedValue({ data: { entries: okEntries, leafId: 'm1' } })

    const snapshot = await traceSync.getTraceEntries(sid)

    expect(snapshot.source).toBe('rpc')
    // entries 仍是 RPC 权威解析（pi 语义：跳坏行）
    expect(snapshot.entries).toEqual(okEntries)
    // 坏行由文件直读补齐（行号锚点供 renderer 归并穿插）
    expect(snapshot.malformed).toEqual([{ lineNumber: 4, raw: '{invalid json!!!' }])
  })

  it('RPC 失败（pi 进程异常）降级路径 B 文件直读（design §3.1 失败路径：source=file）', async () => {
    const { traceSync, client } = makeEnv({ metas: [metaFor('get-entries-1-mixed-kinds')], active: true })
    client.getEntries.mockRejectedValue(new Error('pi process dead'))
    const sid = fixtureSessionId('get-entries-1-mixed-kinds')

    const snapshot = await traceSync.getTraceEntries(sid)
    expect(snapshot.source).toBe('file')
    // 文件直读 entries 与录制 RPC entries 逐条一致（parity 前提，A24 全量断言见 trace-parity.test.ts）
    const recorded = loadRecorded('get-entries-1-mixed-kinds')
    expect(snapshot.entries).toEqual(recorded.data.entries)
  })

  it('非活跃 + 未落盘 → source=empty 空态，不抛不创建文件', async () => {
    // 场景 1：扫描不到该 session（全新 session，文件从未存在）
    const env1 = makeEnv({ metas: [], active: false })
    const s1 = await env1.traceSync.getTraceEntries('never-flushed-sid')
    expect(s1.source).toBe('empty')
    expect(s1.entries).toEqual([])

    // 场景 2：扫描到路径但文件不存在（延迟写入窗口：scanner 元数据 vs 实际落盘竞态）
    const env2 = makeEnv({
      metas: [{ ...metaFor('get-entries-1-mixed-kinds'), id: 'pending-flush', filePath: '/nonexistent/dir/pending.jsonl' }],
      active: false,
    })
    const s2 = await env2.traceSync.getTraceEntries('pending-flush')
    expect(s2.source).toBe('empty')
    expect(s2.entries).toEqual([])
    expect(s2.header).toBeUndefined()
  })

  it('活跃 session 文件路径优先内存 sessionFilePath（getSession 视图，免扫描）', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'trace-mem-path-'))
    const sid = 'mem-path-session'
    writeFileSync(join(tmp, 's.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: sid, cwd: tmp })}\n${JSON.stringify({ type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: 'hi' } })}\n`)
    // metas 为空（scanSessions 扫不到）——路径只能来自 getSession 视图的 sessionFilePath
    const { traceSync, client } = makeEnv({
      metas: [],
      active: true,
      sessionRecord: makeSessionView({ id: sid, sessionFilePath: join(tmp, 's.jsonl') }),
    })
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: null } })

    const snapshot = await traceSync.getTraceEntries(sid)
    expect(snapshot.source).toBe('rpc')
    expect(snapshot.filePath).toBe(join(tmp, 's.jsonl'))
    expect(snapshot.header?.id).toBe(sid)
  })
})

// ── syncTraceEntries 编排（增量腿）──

describe('syncTraceEntries 编排（触发 → get_entries(since) → traceEntryAppended 广播）', () => {
  it('基线 + delta → 广播 session.traceEntryAppended（含 sessionId + delta + 新 leafId）+ 基线滚动（下次 since 用新 leaf）', async () => {
    const recorded = loadRecorded('get-entries-1-mixed-kinds')
    const { traceSync, publishSpy, client } = makeEnv({ metas: [metaFor('get-entries-1-mixed-kinds')], active: true })
    const sid = fixtureSessionId('get-entries-1-mixed-kinds')

    // 打开 trace 视图（建立 since 基线）
    await traceSync.getTraceEntries(sid)
    publishSpy.mockClear()

    const deltaEntry = { type: 'message', id: 'delta-1', parentId: recorded.data.leafId, message: { role: 'assistant', content: 'new' } }
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since === undefined) return recorded
      if (since === recorded.data.leafId) return { data: { entries: [deltaEntry], leafId: 'delta-1' } }
      return { data: { entries: [], leafId: 'delta-1' } }
    })
    traceSync.syncTraceEntries(sid, 'message_end')

    await vi.waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1))
    const [pubSid, msg] = publishSpy.mock.calls[0] as [string, ServerMessage]
    expect(pubSid).toBe(sid)
    expect(msg.type).toBe('session.traceEntryAppended')
    // 规则 7：增量推送必带 sessionId
    expect((msg.payload as { sessionId?: string }).sessionId).toBe(sid)
    expect((msg.payload as { entries: unknown[] }).entries).toEqual([deltaEntry])
    expect((msg.payload as { leafId: string }).leafId).toBe('delta-1')
    // since 用的是基线 leafId（非 undefined 全量）
    expect(client.getEntries).toHaveBeenLastCalledWith(recorded.data.leafId)

    // 基线滚动：下次触发用新 leafId；空 delta 不广播（追赶式拉取的正常稳态）
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'delta-1' } })
    traceSync.syncTraceEntries(sid, 'agent_settled')
    await vi.waitFor(() => expect(client.getEntries).toHaveBeenLastCalledWith('delta-1'))
    await new Promise((r) => setTimeout(r, 20))
    expect(publishSpy).toHaveBeenCalledTimes(1)
  })

  it('无基线（trace 视图未打开过）→ 增量腿 no-op，不发 RPC 不广播', () => {
    const { traceSync, publishSpy, client } = makeEnv({ metas: [metaFor('get-entries-1-mixed-kinds')], active: true })
    traceSync.syncTraceEntries(fixtureSessionId('get-entries-1-mixed-kinds'), 'message_end')
    expect(client.getEntries).not.toHaveBeenCalled()
    expect(publishSpy).not.toHaveBeenCalled()
  })

  it('空 session 基线哨兵（review round1 MUST_FIX）：leafId=null 也建立基线——sync 无参全量拉不抛错；首条 entry 后 sync 全量拉并广播 + 基线推进真实 leaf', async () => {
    const { traceSync, publishSpy, client } = makeEnv({ active: true })
    const sid = 'empty-baseline-session'

    // 打开 trace 视图：空 session（无落盘文件、无 entry），pi 返回 leafId=null
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: null } })
    const snapshot = await traceSync.getTraceEntries(sid)
    expect(snapshot.source).toBe('rpc')
    expect(snapshot.leafId).toBeNull()

    // 空 session 的 sync：'' 哨兵基线 → 无参全量拉（'' 不下传 pi 当 since），delta 空 =
    // 正常稳态——不抛错、不广播
    client.getEntries.mockClear()
    traceSync.syncTraceEntries(sid, 'message_end')
    await vi.waitFor(() => expect(client.getEntries).toHaveBeenCalledTimes(1))
    expect(client.getEntries).toHaveBeenLastCalledWith()
    await new Promise((r) => setTimeout(r, 20))
    expect(publishSpy).not.toHaveBeenCalled()

    // session 写入首条 entry 后：sync 无参全量拉 → delta 即全部 entry → 广播 + 基线推进
    const firstEntry = { type: 'message', id: 'first-1', parentId: null, message: { role: 'user', content: 'hello' } }
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since === undefined) return { data: { entries: [firstEntry], leafId: 'first-1' } }
      return { data: { entries: [], leafId: 'first-1' } }
    })
    traceSync.syncTraceEntries(sid, 'message_end')
    await vi.waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1))
    const [pubSid, msg] = publishSpy.mock.calls[0] as [string, ServerMessage]
    expect(pubSid).toBe(sid)
    expect(msg.type).toBe('session.traceEntryAppended')
    // 规则 7：增量推送必带 sessionId；delta = 全部 entry（消费端按 entry.id 去重）
    expect((msg.payload as { sessionId?: string }).sessionId).toBe(sid)
    expect((msg.payload as { entries: unknown[] }).entries).toEqual([firstEntry])
    expect((msg.payload as { leafId: string }).leafId).toBe('first-1')

    // 基线已推进为真实 leaf：下次触发走 since 增量（不再无参全量）
    traceSync.syncTraceEntries(sid, 'agent_settled')
    await vi.waitFor(() => expect(client.getEntries).toHaveBeenLastCalledWith('first-1'))
    await new Promise((r) => setTimeout(r, 20))
    expect(publishSpy).toHaveBeenCalledTimes(1) // 空 delta 不重复广播
  })

  it('burst 合并：连发两个触发 → 串行链第二次 since 已是新 leaf → 空 delta 只广播一次', async () => {
    const recorded = loadRecorded('get-entries-1-mixed-kinds')
    const { traceSync, publishSpy, client } = makeEnv({ metas: [metaFor('get-entries-1-mixed-kinds')], active: true })
    const sid = fixtureSessionId('get-entries-1-mixed-kinds')
    await traceSync.getTraceEntries(sid)
    publishSpy.mockClear()

    const deltaEntry = { type: 'message', id: 'd-1', parentId: recorded.data.leafId, message: { role: 'assistant', content: 'x' } }
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since === undefined) return recorded
      if (since === recorded.data.leafId) return { data: { entries: [deltaEntry], leafId: 'd-1' } }
      return { data: { entries: [], leafId: 'd-1' } }
    })
    // message_end 与 agent_settled 几乎同时到达（pi 常态时序）
    traceSync.syncTraceEntries(sid, 'message_end')
    traceSync.syncTraceEntries(sid, 'agent_settled')

    await vi.waitFor(() => expect(client.getEntries).toHaveBeenCalledTimes(3)) // 1 全量 + 2 增量
    await new Promise((r) => setTimeout(r, 20))
    expect(publishSpy).toHaveBeenCalledTimes(1) // 第二次空 delta 不重复广播
  })

  it('基线失效（Entry not found，缓存跨 pi 进程存活）→ 清基线 + 不广播（下次 getTraceEntries 重建）', async () => {
    const { traceSync, publishSpy, client } = makeEnv({ active: true })
    const sid = 'stale-baseline-session'

    // 建立基线
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'leaf-old' } })
    await traceSync.getTraceEntries(sid)
    publishSpy.mockClear()

    // pi 重启后 since 指向的 entry 不在新进程集合 → Entry not found
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since === undefined) return { data: { entries: [], leafId: 'leaf-new' } }
      throw new Error(`Entry not found: ${since}`)
    })
    traceSync.syncTraceEntries(sid, 'message_end')
    await new Promise((r) => setTimeout(r, 20))
    // 不广播错序数据；基线已清 → 后续 sync no-op（无 RPC）
    expect(publishSpy).not.toHaveBeenCalled()
    client.getEntries.mockClear()
    traceSync.syncTraceEntries(sid, 'agent_settled')
    await new Promise((r) => setTimeout(r, 20))
    expect(client.getEntries).not.toHaveBeenCalled()
  })

  it('session 无活跃 client（进程退出窗口）→ no-op 不抛错（文件路径无 leaf 概念）', async () => {
    const { traceSync, client } = makeEnv({ active: false })
    // 先经活跃环境建基线不可行——本用例验证有基线但 client 消失：直接换 pm 状态
    const recorded = loadRecorded('get-entries-1-mixed-kinds')
    const client2 = { getEntries: vi.fn(async () => recorded) }
    const pmLive = { getClient: vi.fn(() => client2 as unknown as IPiEngine) } as unknown as IProcessManager
    const bus = new MessageBus()
    const sync = new TraceSync({
      pm: pmLive,
      sessionStore: makeSessionStore([]),
      getSession: () => undefined,
      getMessageBus: () => bus,
    })
    await sync.getTraceEntries('sid-dying')
    pmLive.getClient = vi.fn(() => undefined)
    sync.syncTraceEntries('sid-dying', 'message_end')
    await new Promise((r) => setTimeout(r, 20))
    expect(client2.getEntries).toHaveBeenCalledTimes(1) // 只有建基线的全量拉
    void client
  })
})

// ── fetchCurrentSystemPrompt 编排（现取轮询）──

describe('fetchCurrentSystemPrompt 编排（常驻扩展现取通道）', () => {
  const SID = 'sid-fetch-prompt'

  /** 现取命令产出的 custom entry（常驻扩展 handler 写入形态）。 */
  function currentPromptEntry(fullText: string): { type: string; id: string; customType: string; data: Record<string, unknown> } {
    return {
      type: 'custom',
      id: 'csp1',
      customType: 'taiji:current-system-prompt',
      data: { fullText, charCount: fullText.length, fetchedAt: '2026-08-20T10:00:00.000Z' },
    }
  }

  /** getEntries 按调用序分流：全量（无参，建基线 leaf0），since=leaf0 命中现取 entry。 */
  function mockPromptFlow(client: { getEntries: ReturnType<typeof vi.fn> }) {
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since === undefined) {
        return { data: { entries: [{ type: 'message', id: 'e0', message: { role: 'user', content: 'q' } }], leafId: 'leaf0' } }
      }
      if (since === 'leaf0') {
        return { data: { entries: [currentPromptEntry('PROMPT-BODY')], leafId: 'leaf1' } }
      }
      return { data: { entries: [], leafId: since } }
    })
  }

  it('非活跃 session（无 pi 进程）→ throw code=session_not_active', async () => {
    const { traceSync } = makeEnv({ active: false })
    await expect(traceSync.fetchCurrentSystemPrompt(SID)).rejects.toMatchObject({ code: 'session_not_active' })
  })

  it('busy 预检：isGenerating → throw code=session_busy（命令会排队，预检拒绝更诚实）', async () => {
    const { traceSync } = makeEnv({ active: true, sessionRecord: makeSessionView({ isGenerating: true }) })
    await expect(traceSync.fetchCurrentSystemPrompt(SID)).rejects.toMatchObject({ code: 'session_busy' })
  })

  it('busy 预检：isCompacting → 同拒（sendPrompt 预检互斥口径）', async () => {
    const { traceSync } = makeEnv({ active: true, sessionRecord: makeSessionView({ isCompacting: true }) })
    await expect(traceSync.fetchCurrentSystemPrompt(SID)).rejects.toMatchObject({ code: 'session_busy' })
  })

  it('成功路径：发命令 → ensurePromptBaseline 全量建基线 → 轮询 since 命中 custom entry → 返回值 + 台账增量广播 + 基线滚动', async () => {
    vi.useFakeTimers()
    const { traceSync, client, publishSpy } = makeEnv({ active: true })
    mockPromptFlow(client)

    const pending = traceSync.fetchCurrentSystemPrompt(SID)
    await vi.advanceTimersByTimeAsync(250) // 第一轮轮询 sleep
    const result = await pending

    // 命令发出（双下划线内部命令，不经 LLM）
    expect(client.prompt).toHaveBeenCalledWith('/__taiji_get_system_prompt__')
    // 增量轮询以全量建的基线为 since；基线滚动（后续 trace 增量从 leaf1 起）
    expect(client.getEntries).toHaveBeenCalledWith('leaf0')
    // 返回值 = entry data 提取
    expect(result).toEqual({
      sessionId: SID,
      fullText: 'PROMPT-BODY',
      charCount: 11,
      fetchedAt: '2026-08-20T10:00:00.000Z',
    })
    // 台账增量：traceEntryAppended 广播（含 sessionId，规则 7）带现取 entry
    const push = publishSpy.mock.calls.find(([, m]) => (m as ServerMessage).type === 'session.traceEntryAppended')
    expect(push).toBeDefined()
    const payload = (push?.[1] as { payload: { sessionId: string; entries: unknown[]; leafId: string | null } }).payload
    expect(payload.sessionId).toBe(SID)
    expect(payload.leafId).toBe('leaf1')
    expect((payload.entries[0] as { customType?: string }).customType).toBe('taiji:current-system-prompt')
  })

  it('ensurePromptBaseline 缓存命中：trace 视图已建基线时不再全量拉（现取是用户显式动作，免重复 RPC）', async () => {
    vi.useFakeTimers()
    const { traceSync, client } = makeEnv({ active: true })
    // 打开 trace 视图建基线（leaf0）
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'leaf0' } })
    await traceSync.getTraceEntries(SID)
    client.getEntries.mockClear()
    mockPromptFlow(client)

    const pending = traceSync.fetchCurrentSystemPrompt(SID)
    await vi.advanceTimersByTimeAsync(250)
    await pending

    // 全部 getEntries 调用都带 since=leaf0（无全量拉）——calls 元组形状按运行时实参断言
    const calls = client.getEntries.mock.calls as unknown as [string | undefined][]
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call[0]).toBe('leaf0')
    }
  })

  it('基线跨 pi 进程失效（Entry not found）→ retry：清缓存基线后全量重建继续轮询命中', async () => {
    vi.useFakeTimers()
    const { traceSync, client, publishSpy } = makeEnv({ active: true })
    // 建立旧基线
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'leaf-stale' } })
    await traceSync.getTraceEntries(SID)

    // pi 重启：since=leaf-stale 抛 Entry not found；retry 后全量（无参）返回带现取 entry 的集合
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since === 'leaf-stale') throw new Error('Entry not found: leaf-stale')
      if (since === undefined) {
        return { data: { entries: [currentPromptEntry('RETRY-BODY')], leafId: 'leaf-fresh' } }
      }
      return { data: { entries: [], leafId: 'leaf-fresh' } }
    })

    const pending = traceSync.fetchCurrentSystemPrompt(SID)
    await vi.advanceTimersByTimeAsync(250) // 第一轮：since 失效 → retry
    await vi.advanceTimersByTimeAsync(250) // 第二轮：全量重建命中
    const result = await pending

    expect(result.fullText).toBe('RETRY-BODY')
    expect(client.getEntries).toHaveBeenCalledWith('leaf-stale')
    expect(client.getEntries).toHaveBeenCalledWith()
    // 命中广播（全量 delta 含现取 entry）
    const push = publishSpy.mock.calls.find(([, m]) => (m as ServerMessage).type === 'session.traceEntryAppended')
    expect((push?.[1] as { payload: { leafId: string | null } }).payload.leafId).toBe('leaf-fresh')
  })

  it('轮询超时（命令未产出 entry）→ throw code=fetch_current_prompt_timeout', async () => {
    vi.useFakeTimers()
    const { traceSync, client } = makeEnv({ active: true })
    // 增量恒空（命令未产出）
    client.getEntries.mockImplementation(async (since?: string) =>
      since === undefined
        ? { data: { entries: [], leafId: 'leaf0' } }
        : { data: { entries: [], leafId: 'leaf0' } })
    const pending = traceSync.fetchCurrentSystemPrompt(SID)
    // 先 attach rejection 断言再推进 timer（否则 rejection 发生时无 handler，报 unhandled）
    const expectation = expect(pending).rejects.toMatchObject({ code: 'fetch_current_prompt_timeout' })
    await vi.advanceTimersByTimeAsync(8500)
    await expectation
  })
})

// ── onSessionDisposed（销毁清理）──

describe('onSessionDisposed（Facade removeSessionEntry 第 ⑤ 步直调）', () => {
  it('清基线与串行链：dispose 后 sync no-op（不发 RPC）', async () => {
    const { traceSync, client } = makeEnv({ active: true })
    const sid = 'sid-disposed'
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'leaf0' } })
    await traceSync.getTraceEntries(sid) // 建基线

    traceSync.onSessionDisposed(sid)
    client.getEntries.mockClear()

    traceSync.syncTraceEntries(sid, 'message_end')
    await new Promise((r) => setTimeout(r, 20))
    expect(client.getEntries).not.toHaveBeenCalled() // 基线已清 → no-op
  })

  it('其他 session 的基线不受影响（per-session 隔离）', async () => {
    const { traceSync, client, publishSpy } = makeEnv({ active: true })
    const sidA = 'sid-a'
    const sidB = 'sid-b'
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'leaf0' } })
    await traceSync.getTraceEntries(sidA)
    await traceSync.getTraceEntries(sidB)

    traceSync.onSessionDisposed(sidA)
    client.getEntries.mockClear()
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since === undefined) return { data: { entries: [], leafId: 'leaf0' } }
      return { data: { entries: [{ type: 'message', id: 'b-1' }], leafId: 'b-1' } }
    })

    traceSync.syncTraceEntries(sidB, 'message_end')
    await vi.waitFor(() => expect(client.getEntries).toHaveBeenCalledWith('leaf0'))
    await vi.waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1))
  })
})

// ── EventInterpreter 触发接线（A33 增量腿入口，原 session-trace.test.ts 随迁）──

describe('EventInterpreter 触发接线（A33：四类触发事件 → onTraceSync）', () => {
  it('EventInterpreter：message_end / agent_settled / entry_appended 三类触发事件 → onTraceSync(trigger)', () => {
    const onTraceSync = vi.fn()
    const send = vi.fn()
    const interpreter = new EventInterpreter('s-trig', { send, onTraceSync })

    for (const trigger of ['message_end', 'agent_settled', 'entry_appended'] as const) {
      interpreter.interpret([{ kind: 'trace-trigger', trigger }])
    }
    expect(onTraceSync).toHaveBeenCalledTimes(3)
    expect(onTraceSync).toHaveBeenNthCalledWith(1, 's-trig', 'message_end')
    expect(onTraceSync).toHaveBeenNthCalledWith(2, 's-trig', 'agent_settled')
    expect(onTraceSync).toHaveBeenNthCalledWith(3, 's-trig', 'entry_appended')
  })

  it('EventInterpreter：compaction_end（第四类触发）→ onTraceSync(compaction_end)', () => {
    const onTraceSync = vi.fn()
    const interpreter = new EventInterpreter('s-comp', { send: vi.fn(), onTraceSync })
    interpreter.interpret([{ kind: 'compaction-end', reason: 'manual', aborted: false }])
    expect(onTraceSync).toHaveBeenCalledWith('s-comp', 'compaction_end')
  })
})
