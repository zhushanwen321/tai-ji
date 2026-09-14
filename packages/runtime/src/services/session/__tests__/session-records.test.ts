/**
 * SessionRecords 直测（S6 迁出批 1）：subagent/workflow 记录域——派生缓存族（订阅注册/
 * 防抖失效/增量拉取/游标自愈/销毁清理）+ 动作命令转发 + 引擎配置读写。
 *
 * 分层（G2：import 无 session-service，stub 面 = deps 5 方法）：
 * - mock 层 = deps（pm/sessionStore/hasSession/getMessageBus/getExtensionPaths），entry
 *   形态对齐 pi appendCustomEntry 契约（沿用 session-record-entries.test.ts 的 fixture
 *   形态）；scanSubagentEntries/scanWorkflowEntries 等 extractor 生产代码真实执行。
 * - fake timers（项目规范）：SCALAR_STATE_DEBOUNCE_MS 防抖由 advanceTimersByTimeAsync 推进。
 * - 引擎配置组：vi.mock pi-paths 的 getPiAgentDir 指向 per-test 临时目录（其余导出
 *   importOriginal 保留），withFileLockSync/atomicWrite 真实执行。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'
import type { SessionRecordsDeps } from '../session-records.js'
import { SessionRecords, encodeDirectiveText } from '../session-records.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../replicated-states.config.js'
import type { SkillInjector, SkillInjectionResult } from '../skill-injector.js'

/** 引擎配置组的 getPiAgentDir 重定向目标（hoisted：vi.mock 工厂内引用）。 */
const piAgentDirRef = vi.hoisted(() => ({ dir: '' }))

vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => piAgentDirRef.dir }
})

/** get_entries RPC 返回形态（pi GetEntriesResponse：{entries, leafId}）。 */
type GetEntriesResult = { data?: { entries?: unknown[]; leafId?: string | null } }

/** 自描述 subagent-record entry（W16 v1 完整快照）。 */
function subagentRecordEntry(id: string, status: string, entryId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: entryId,
    parentId: null,
    timestamp: '2026-08-19T00:00:00Z',
    data: {
      v: 1,
      id,
      agent: 'worker',
      task: 'Do work',
      slug: 'work',
      status,
      startedAt: 1000,
      ...extra,
    },
  }
}

/** 自描述 workflow-record entry（W17 v1：{v:1, snapshot, updatedAt}）。 */
function workflowRecordEntry(
  runId: string,
  status: 'running' | 'done',
  entryId: string,
  reason?: string,
  trace: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'workflow-record',
    id: entryId,
    parentId: null,
    timestamp: '2026-08-19T00:00:00Z',
    data: {
      v: 1,
      updatedAt: '2026-08-19T00:00:01Z',
      snapshot: {
        v: 'wf-run-v2',
        runId,
        spec: { scriptName: 'test-flow' },
        state: { status, reason, budget: { usedTokens: 1, usedCost: 0 }, calls: [], trace },
        meta: { startedAt: '2026-08-19T00:00:00Z' },
      },
    },
  }
}

/** 最小装置：deps 全 mock（publish spy 收集 bus 发布；client 可编程）。 */
function makeRecords(depsOverrides: Partial<SessionRecordsDeps> = {}, injector?: SkillInjector) {
  const publish = vi.fn()
  const client = {
    getEntries: vi.fn(async (_since?: string) => ({ data: { entries: [], leafId: null } }) as GetEntriesResult),
    prompt: vi.fn(async (_text: string) => undefined),
  }
  const deps: SessionRecordsDeps = {
    pm: { getClient: vi.fn(() => client as unknown as IPiEngine) } as unknown as IProcessManager,
    sessionStore: { scanSessions: vi.fn(() => [] as Array<{ id: string; filePath: string }>) } as unknown as ISessionStore,
    hasSession: vi.fn(() => true),
    getMessageBus: () => ({ publish } as unknown as IMessageBus),
    ...depsOverrides,
  }
  const records = new SessionRecords(deps, injector)
  return { records, publish, client, deps }
}

/** subscribe 后收集注册 handler，返回手动触发器（模拟 lifecycle 同步直发）。 */
function registerSession(records: SessionRecords): (sessionId: string) => void {
  const handlers: Array<(sessionId: string) => void> = []
  records.subscribe({ onSessionRegistered: (h) => { handlers.push(h) } })
  return (sessionId: string) => { for (const h of handlers) h(sessionId) }
}

/** 推进防抖并等待在途拉取落定。 */
async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS)
}

describe('订阅与缓存注册', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('subscribe 注册 handler：触发后缓存就位，失效可拉取', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledTimes(1)
  })

  it('未注册 session 的失效 no-op（冷启动走磁盘路径）', async () => {
    const { records, client } = makeRecords()
    records.invalidateRecordEntries('s-unknown', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).not.toHaveBeenCalled()
  })
})

describe('invalidateRecordEntries：防抖', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('防抖窗口内多次失效合并为一次拉取', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    records.invalidateRecordEntries('s1', 'workflow-record')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledTimes(1)
  })

  it('非 record customType 忽略（entry_appended 主信号的其他 custom entry）', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    records.invalidateRecordEntries('s1', 'other-custom-type')
    await flushDebounce()
    expect(client.getEntries).not.toHaveBeenCalled()
  })
})

describe('refreshRecordEntries：拉取与发布', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('全量路径：有变化才发布 session.subagents 全量帧与 session.workflowUpdate 增量信号', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({
      data: {
        entries: [
          subagentRecordEntry('sa-1', 'running', 'e1'),
          workflowRecordEntry('run-1', 'running', 'e2'),
        ],
        leafId: 'e2',
      },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()

    const subagentsMsg = publish.mock.calls.find(([, msg]) => (msg as { type: string }).type === 'session.subagents')
    expect(subagentsMsg).toBeDefined()
    expect(subagentsMsg![0]).toBe('s1')
    expect((subagentsMsg![1] as { payload: { subagents: Array<{ subagentId: string; status: string }> } }).payload.subagents)
      .toEqual([expect.objectContaining({ subagentId: 'sa-1', status: 'running' })])

    const workflowMsgs = publish.mock.calls.filter(([, msg]) => (msg as { type: string }).type === 'session.workflowUpdate')
    expect(workflowMsgs).toHaveLength(1)
    expect((workflowMsgs[0][1] as { payload: { update: { runId: string; status: string } } }).payload.update)
      .toEqual({ runId: 'run-1', status: 'running', reason: undefined })
  })

  it('running 态仅 trace 步骤数变化也发布 workflowUpdate（GUI 步骤实时可见，[步骤可见性修复 2026-09-14]）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({
      data: { entries: [workflowRecordEntry('run-1', 'running', 'e1')], leafId: 'e1' },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    // 新增 run：首发一次（status 变化）
    expect(publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.workflowUpdate')).toHaveLength(1)

    // 同 runId 仍 running，仅 trace 多一个 agent 步骤（core 启动即 save 的产物）——
    // status/reason 未变，但步骤数变化也必须发布（否则 GUI 详情整个 run 期间收不到 reload 触发）
    client.getEntries.mockResolvedValue({
      data: {
        entries: [
          workflowRecordEntry('run-1', 'running', 'e2', undefined, [
            { stepIndex: 1, agent: 'reviewer', task: 't', model: 'default', status: 'running', phase: 'R1', startedAt: '2026-08-19T00:00:02Z' },
          ]),
        ],
        leafId: 'e2',
      },
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    const stepMsgs = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.workflowUpdate')
    expect(stepMsgs).toHaveLength(2)
    expect(stepMsgs[1][0]).toBe('s1')
  })

  it('同值重复 entry 不重复发布（diff 基线）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    const entry = subagentRecordEntry('sa-1', 'running', 'e1')
    client.getEntries.mockResolvedValue({ data: { entries: [entry], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(1)

    // 增量窗口返回同值新 entry（快照未变）——不发布
    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e9')], leafId: 'e9' } })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('轮终三字段（result/resumable/chatMode）任一翻转都触发 publish（GUI 快修① diff 基线）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(1)

    // 三字段逐个翻转：去重层若缺比对会把「轮终等待续聊」的显示信号静默吞掉（不 publish）
    for (const extra of [
      { result: 'round output' },
      { resumable: true },
      { chatMode: false },
    ] as Array<Record<string, unknown>>) {
      client.getEntries.mockResolvedValue({
        data: { entries: [subagentRecordEntry('sa-1', 'running', `e-${Object.keys(extra)[0]}`, extra)], leafId: 'e-x' },
      })
      records.invalidateRecordEntries('s1', 'subagent-record')
      await flushDebounce()
    }
    expect(publish).toHaveBeenCalledTimes(4)
  })

  it('engine 域同值新引用不重复发布（字段级浅比较——引用比较会把每轮重解析误判为变化）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    // engine 三字段齐备的 zcode record 形态（sessionRef 键序 = sessionId 在前）
    client.getEntries.mockResolvedValue({
      data: {
        entries: [subagentRecordEntry('sa-1', 'running', 'e1', {
          engine: 'zcode',
          engineFallback: { from: 'zcode-missing', reason: 'engine_probe_failed' },
          engineHandle: {
            sessionRef: { sessionId: 'z-1', dbPath: '/engines/zcode/session-db/db.sqlite' },
            journalPath: '/engines/zcode/shared/journal.jsonl',
            poolKey: 'shared',
          },
        })],
        leafId: 'e1',
      },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(1)

    // 增量窗口返回同值新 entry：extractor 重新解析产生全新对象引用（applyRecordEntries
    // 每轮重扫），且 sessionRef 刻意换键序（dbPath 在前）——字段级浅比较判相等不发布
    client.getEntries.mockResolvedValue({
      data: {
        entries: [subagentRecordEntry('sa-1', 'running', 'e9', {
          engine: 'zcode',
          engineFallback: { from: 'zcode-missing', reason: 'engine_probe_failed' },
          engineHandle: {
            journalPath: '/engines/zcode/shared/journal.jsonl',
            sessionRef: { dbPath: '/engines/zcode/session-db/db.sqlite', sessionId: 'z-1' },
            poolKey: 'shared',
          },
        })],
        leafId: 'e9',
      },
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('zcode 续聊换锚：engineHandle.sessionRef.sessionId 变化是真值变化必须 publish', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({
      data: {
        entries: [subagentRecordEntry('sa-1', 'running', 'e1', {
          engine: 'zcode',
          engineHandle: {
            sessionRef: { sessionId: 'z-1', dbPath: '/engines/zcode/session-db/db.sqlite' },
            poolKey: 'shared',
          },
        })],
        leafId: 'e1',
      },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(1)

    // 续聊后每轮换新 session（record 锚已换新）——sessionRef.sessionId 真变化触发 publish
    client.getEntries.mockResolvedValue({
      data: {
        entries: [subagentRecordEntry('sa-1', 'running', 'e2', {
          engine: 'zcode',
          engineHandle: {
            sessionRef: { sessionId: 'z-2', dbPath: '/engines/zcode/session-db/db.sqlite' },
            poolKey: 'shared',
          },
        })],
        leafId: 'e2',
      },
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('增量路径：cursor 建立后失效走 getEntries(since)', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()

    client.getEntries.mockClear()
    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'done', 'e2')], leafId: 'e2' } })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledWith('e1')
    const subagentsMsgs = publish.mock.calls.filter(([, msg]) => (msg as { type: string }).type === 'session.subagents')
    expect(subagentsMsgs).toHaveLength(2) // 第一轮全量 + 增量变化各一帧
    expect((subagentsMsgs.at(-1)![1] as { payload: { subagents: Array<{ status: string }> } }).payload.subagents[0].status).toBe('idle') // [U6/D5] legacy done 归一 idle
  })

  it('游标失效自愈：Entry not found → 丢 cursor 第二轮全量重建', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()

    // since 拉取报 Entry not found → 同一次 refresh 内丢 cursor 全量重拉
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since !== undefined) throw new Error('Entry not found: e1')
      return { data: { entries: [subagentRecordEntry('sa-1', 'done', 'e5')], leafId: 'e5' } } as GetEntriesResult
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledWith('e1')
    expect(client.getEntries).toHaveBeenCalledWith()
    // 自愈重建后的状态经发布可见（取最后一帧——第一轮全量已发过 running 帧）
    const subagentsMsgs = publish.mock.calls.filter(([, msg]) => (msg as { type: string }).type === 'session.subagents')
    expect((subagentsMsgs.at(-1)![1] as { payload: { subagents: Array<{ status: string }> } }).payload.subagents[0].status).toBe('idle') // [U6/D5] legacy done 归一 idle
  })

  it('其他 RPC 错误：不发布、cursor 保留（下次重试仍走增量）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    publish.mockClear()

    client.getEntries.mockRejectedValue(new Error('rpc timeout'))
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).not.toHaveBeenCalled()

    // 恢复后重试：仍带原 cursor（未被丢弃）
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'e1' } })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledWith('e1')
  })

  it('inflight 共享：拉取在途时的新失效复用同一 promise', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    let release!: (v: GetEntriesResult) => void
    client.getEntries.mockImplementation(async () => new Promise<GetEntriesResult>((resolve) => { release = resolve }))
    records.invalidateRecordEntries('s1', 'subagent-record')
    // 同步推进：防抖到期 → refresh 同步段启动（inflight 已设，getEntries 挂起）
    vi.advanceTimersByTime(SCALAR_STATE_DEBOUNCE_MS)
    // 拉取在途：新失效 → 新防抖 → 到期后 refresh 复用 inflight（不重复 RPC）
    records.invalidateRecordEntries('s1', 'subagent-record')
    vi.advanceTimersByTime(SCALAR_STATE_DEBOUNCE_MS)
    release({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    await Promise.resolve()
    await Promise.resolve()
    expect(client.getEntries).toHaveBeenCalledTimes(1)
  })

  it('session 已销毁守卫：hasSession false 时 merge 但不 publish', async () => {
    const { records, publish, client } = makeRecords({ hasSession: vi.fn(() => false) })
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).not.toHaveBeenCalled()
  })

  it('client 不存在（session 已死）：拉取冻结 no-op', async () => {
    const { records, client } = makeRecords({ pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager })
    const fire = registerSession(records)
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).not.toHaveBeenCalled()
  })
})

describe('onSessionDisposed', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('清缓存并停防抖定时器（pending 防抖到期后不拉取）', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    records.onSessionDisposed('s1')
    await flushDebounce()
    expect(client.getEntries).not.toHaveBeenCalled()
    // 缓存条目已删：后续失效 no-op
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).not.toHaveBeenCalled()
  })

  it('未注册 session 的 dispose 幂等 no-op', () => {
    const { records } = makeRecords()
    expect(() => records.onSessionDisposed('s-none')).not.toThrow()
  })
})

describe('磁盘读侧（scanSessions → extractor 真实执行）', () => {
  it('getSubagents：定位 session 文件后经 extractor 提取 record 列表', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-test-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, JSON.stringify(subagentRecordEntry('sa-1', 'running', 'e1')))
    const { records } = makeRecords({
      sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath }]) } as unknown as ISessionStore,
    })
    const result = await records.getSubagents('s1')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(expect.objectContaining({ subagentId: 'sa-1', status: 'running' }))
  })

  it('getSubagents：session 不在扫描结果返回 []', async () => {
    const { records } = makeRecords()
    expect(await records.getSubagents('s-none')).toEqual([])
  })

  it('getWorkflows：定位 session 文件后提取 workflow 列表', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-test-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, JSON.stringify(workflowRecordEntry('run-1', 'done', 'e1')))
    const { records } = makeRecords({
      sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath }]) } as unknown as ISessionStore,
    })
    const result = await records.getWorkflows('s1')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(expect.objectContaining({ runId: 'run-1', status: 'done' }))
  })
})

describe('getSubagentHistory / getAgentCallFilePath：负路径守卫', () => {
  beforeEach(() => { piAgentDirRef.dir = mkdtempSync(join(tmpdir(), 'session-records-piagent-')) })
  afterEach(() => { piAgentDirRef.dir = '' })

  it('record 不存在返回 []', async () => {
    const { records } = makeRecords()
    expect(await records.getSubagentHistory('s1', 'sa-none')).toEqual({ messages: [], truncated: false })
  })

  it('路径穿越守卫：sessionFile 逃出 piAgentDir 的 record 历史返回 []', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-test-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, JSON.stringify(subagentRecordEntry('sa-1', 'running', 'e1', { sessionFile: '/etc/passwd' })))
    const { records } = makeRecords({
      sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath }]) } as unknown as ISessionStore,
    })
    expect(await records.getSubagentHistory('s1', 'sa-1')).toEqual({ messages: [], truncated: false })
    expect(await records.getAgentCallFilePath('s1', 'sa-1')).toBe('')
  })

  it('getAgentCallFilePath：record 无 sessionFile 返回空串（UI 隐藏按钮契约）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-test-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, JSON.stringify(subagentRecordEntry('sa-1', 'running', 'e1')))
    const { records } = makeRecords({
      sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath }]) } as unknown as ISessionStore,
    })
    expect(await records.getAgentCallFilePath('s1', 'sa-1')).toBe('')
  })

  it('getAgentCallHistory：agent call 即 subagent，委托 getSubagentHistory 路径', async () => {
    const { records } = makeRecords()
    expect(await records.getAgentCallHistory('s1', 'sa-none')).toEqual({ messages: [], truncated: false })
  })
})

describe('workflowAction / subagentAction：命令转发', () => {
  it('workflowAction 转发 /workflows <action> <runId> 到活跃 client', async () => {
    const { records, client } = makeRecords()
    await records.workflowAction('s1', 'pause', 'run-1')
    expect(client.prompt).toHaveBeenCalledWith('/workflows pause run-1')
  })

  it('workflowAction：session 不活跃 throw', async () => {
    const { records } = makeRecords({ pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager })
    await expect(records.workflowAction('s1', 'pause', 'run-1')).rejects.toThrow('Session s1 not active')
  })

  it('subagentAction cancel 转发 /subagents cancel <subagentId>', async () => {
    const { records, client } = makeRecords()
    await records.subagentAction('s1', 'cancel', { subagentId: 'sa-1' })
    expect(client.prompt).toHaveBeenCalledWith('/subagents cancel sa-1')
  })

  it('subagentAction message：换行经 encodeDirectiveText 编码保持命令单行', async () => {
    const { records, client } = makeRecords()
    await records.subagentAction('s1', 'message', { subagentId: 'sa-1', text: 'line1\nline2\\end' })
    expect(client.prompt).toHaveBeenCalledWith(`/subagents message sa-1 ${encodeDirectiveText('line1\nline2\\end')}`)
    const sent = (client.prompt as unknown as { mock: { calls: string[][] } }).mock.calls[0][0] as string
    expect(sent.includes('\n')).toBe(false)
  })

  it('subagentAction start 转发 /subagents start <slug> <task>', async () => {
    const { records, client } = makeRecords()
    await records.subagentAction('s1', 'start', { slug: 'worker', task: 'Do work' })
    expect(client.prompt).toHaveBeenCalledWith('/subagents start worker Do work')
  })

  it.each([
    ['cancel 缺 subagentId', 'cancel', {} as Record<string, string>, 'subagentId is required'],
    ['message 缺 text', 'message', { subagentId: 'sa-1' }, 'subagentId and text are required'],
    ['start 缺 slug', 'start', { task: 't' }, 'slug and task are required'],
  ])('协议错误 fail-fast：%s', async (_label, action, params, expected) => {
    const { records } = makeRecords()
    await expect(records.subagentAction('s1', action as 'cancel', params)).rejects.toThrow(expected)
  })

  it('subagentAction：session 不活跃 throw', async () => {
    const { records } = makeRecords({ pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager })
    await expect(records.subagentAction('s1', 'cancel', { subagentId: 'sa-1' })).rejects.toThrow('Session s1 not active')
  })
})

describe('引擎配置（getPiAgentDir 重定向临时目录，锁与原子写真实执行）', () => {
  beforeEach(() => {
    piAgentDirRef.dir = mkdtempSync(join(tmpdir(), 'session-records-engines-'))
    mkdirSync(join(piAgentDirRef.dir, 'subagents'), { recursive: true })
  })
  afterEach(() => { piAgentDirRef.dir = '' })

  it('engines.json + config.json 读取：返回动态清单与默认引擎', async () => {
    writeFileSync(join(piAgentDirRef.dir, 'subagents', 'engines.json'), JSON.stringify({ engines: ['pi', 'codex'] }))
    writeFileSync(join(piAgentDirRef.dir, 'subagents', 'config.json'), JSON.stringify({ defaultEngine: 'codex' }))
    const { records } = makeRecords()
    expect(await records.getSubagentEngineConfig()).toEqual({ engines: ['pi', 'codex'], defaultEngine: 'codex' })
  })

  it('[W4] engines.json 缺失：runtime 自身发现回退（回退源单源化，静态 JSON 兜底已删）', async () => {
    const discoverEngines = vi.fn(() => ['zcode', 'custom'])
    const { records } = makeRecords({ discoverEngines })
    expect(await records.getSubagentEngineConfig()).toEqual({ engines: ['zcode', 'custom'], defaultEngine: 'pi' })
    expect(discoverEngines).toHaveBeenCalledOnce()
  })

  it('[W4] 发现零命中/失败：空清单（不再 [pi] 兜底——静态声明列出的 id 无 bin 可执行）', async () => {
    const zero = makeRecords({ discoverEngines: vi.fn(() => []) })
    expect(await zero.records.getSubagentEngineConfig()).toEqual({ engines: [], defaultEngine: 'pi' })
    const failed = makeRecords({ discoverEngines: vi.fn(() => { throw new Error('discovery down') }) })
    expect(await failed.records.getSubagentEngineConfig()).toEqual({ engines: [], defaultEngine: 'pi' })
  })

  it('setSubagentDefaultEngine：未知引擎 throw（GUI 端防呆）', async () => {
    writeFileSync(join(piAgentDirRef.dir, 'subagents', 'engines.json'), JSON.stringify({ engines: ['pi'] }))
    const { records } = makeRecords()
    await expect(records.setSubagentDefaultEngine('unknown-engine')).rejects.toThrow("unknown subagent engine 'unknown-engine'")
  })

  it('setSubagentDefaultEngine：清单内引擎写入 config.json 且保留其他字段', async () => {
    writeFileSync(join(piAgentDirRef.dir, 'subagents', 'engines.json'), JSON.stringify({ engines: ['pi', 'codex'] }))
    writeFileSync(join(piAgentDirRef.dir, 'subagents', 'config.json'), JSON.stringify({ defaultEngine: 'pi', other: 'kept' }))
    const { records } = makeRecords()
    await records.setSubagentDefaultEngine('codex')
    const written = JSON.parse(readFileSync(join(piAgentDirRef.dir, 'subagents', 'config.json'), 'utf8')) as Record<string, unknown>
    expect(written.defaultEngine).toBe('codex')
    expect(written.other).toBe('kept')
  })
})

// ─── A2（adversarial-review-fixes MF-B）：subagentAction 定向文本挂注入 ───
//
// 锁定三件事：① message/start 分支在 encodeDirectiveText 之前经 injector.inject
// （标记在原始文本上匹配）；② notice 在 client.prompt 成功之后发布（时机契约
// 与 dispatcher 同款）；③ cancel / workflows 内部命令不经注入器。

describe('subagentAction：skill 注入挂载（A2 MF-B）', () => {
  /** spy 注入器：记录调用文本，返回可辨识的改写产物 + 可编程 notices。 */
  function makeSpyInjector(result?: Partial<SkillInjectionResult>): {
    injector: SkillInjector
    inject: ReturnType<typeof vi.fn>
  } {
    const inject = vi.fn(async (_client: unknown, text: string): Promise<SkillInjectionResult> => ({
      text: `<<injected:${text}>>`,
      notices: [],
      ...result,
    }))
    return { injector: { inject } as unknown as SkillInjector, inject }
  }

  it('message：encode 之前注入原始 text，prompt 收到 encode(注入产物)，notice 在 prompt 之后', async () => {
    const notices = [{ reason: 'skill_missing' as const, skills: ['ghost'] }]
    const { injector, inject } = makeSpyInjector({ notices })
    const { records, publish, client } = makeRecords({}, injector)
    const calls: string[] = []
    ;(client.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (text: string) => {
      calls.push(`prompt:${text}`)
    })
    publish.mockImplementation((sid: string, msg: { type: string }) => {
      calls.push(`publish:${msg.type}`)
    })

    await records.subagentAction('s1', 'message', { subagentId: 'sa-1', text: '原始文本' })

    // ① 注入收到原始 text（encode 之前）
    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0][1]).toBe('原始文本')
    // ② prompt 收到 encode(注入产物)
    expect(client.prompt).toHaveBeenCalledWith(`/subagents message sa-1 ${encodeDirectiveText('<<injected:原始文本>>')}`)
    // ③ 顺序：prompt 先于 notice（发送成功后才发布）
    expect(calls).toEqual([
      `prompt:/subagents message sa-1 ${encodeDirectiveText('<<injected:原始文本>>')}`,
      'publish:session.skillNotice',
    ])
    const noticeMsg = publish.mock.calls.find(([, msg]) => (msg as { type: string }).type === 'session.skillNotice')
    expect(noticeMsg).toBeDefined()
    expect(noticeMsg![0]).toBe('s1')
    expect((noticeMsg![1] as { payload: { reason: string; skills: string[] } }).payload)
      .toEqual({ sessionId: 's1', reason: 'skill_missing', skills: ['ghost'] })
  })

  it('start：task 同款注入（encode 之前）+ notice', async () => {
    const { injector, inject } = makeSpyInjector()
    const { records, client } = makeRecords({}, injector)
    await records.subagentAction('s1', 'start', { slug: 'worker', task: '干点活' })
    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0][1]).toBe('干点活')
    expect(client.prompt).toHaveBeenCalledWith(`/subagents start worker ${encodeDirectiveText('<<injected:干点活>>')}`)
  })

  it('prompt 失败：notice 不发布（发送成功后时机契约的否定面）', async () => {
    const { injector } = makeSpyInjector({ notices: [{ reason: 'skill_missing', skills: ['ghost'] }] })
    const { records, publish, client } = makeRecords({}, injector)
    ;(client.prompt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('pi reject'))
    await expect(records.subagentAction('s1', 'message', { subagentId: 'sa-1', text: 't' })).rejects.toThrow('pi reject')
    expect(publish).not.toHaveBeenCalled()
  })

  it('notices 为空：不发布任何 bus 消息（no-op 零噪音）', async () => {
    const { injector } = makeSpyInjector()
    const { records, publish } = makeRecords({}, injector)
    await records.subagentAction('s1', 'message', { subagentId: 'sa-1', text: 't' })
    expect(publish).not.toHaveBeenCalled()
  })

  it('cancel 与 workflows：不经注入器（内部命令显式跳过）', async () => {
    const { injector, inject } = makeSpyInjector()
    const { records } = makeRecords({}, injector)
    await records.subagentAction('s1', 'cancel', { subagentId: 'sa-1' })
    await records.workflowAction('s1', 'pause', 'run-1')
    expect(inject).not.toHaveBeenCalled()
  })

  it('真注入器 + 纯文本：no-op 原文通过（mock client 无 getCommands 也不发起 RPC）', async () => {
    // 无标记文本在 parseSkillMarkers 短路返回前不触碰任何 client 方法——
    // mock client 只有 getEntries/prompt 两方法，注入若发起 RPC 即 TypeError 翻红
    const { records, client } = makeRecords()
    await records.subagentAction('s1', 'message', { subagentId: 'sa-1', text: '纯文本' })
    expect(client.prompt).toHaveBeenCalledWith('/subagents message sa-1 纯文本')
  })
})
