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
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'
import type { SessionRecordsDeps } from '../session-records.js'
import { SessionRecords, encodeDirectiveText } from '../session-records.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../replicated-states.config.js'
import type { SkillInjector, SkillInjectionResult } from '../skill-injector.js'
import { extractSubagentsFromSessionFile } from '../subagent-extractor.js'
import { extractWorkflowsFromSessionFile } from '../workflow-extractor.js'
import { encodeCwd } from '../../../infra/pi/pi-paths.js'

const extractSubagentsMock = vi.mocked(extractSubagentsFromSessionFile)
const extractWorkflowsMock = vi.mocked(extractWorkflowsFromSessionFile)

/** 引擎配置组的 getPiAgentDir 重定向目标（hoisted：vi.mock 工厂内引用）。 */
const piAgentDirRef = vi.hoisted(() => ({ dir: '' }))

vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => piAgentDirRef.dir }
})

// [W1 / D6] 全文读路径 call-through spy（验收③「getWorkflows/getSubagents 不再调全文
// 读路径」的代码断言载体）：行为保持真实实现（既有测试零影响），仅计数调用——
// 正常体量会话走 journal 投影不触达；oversize 分流（旧格式兼容路径）触达。
vi.mock('../subagent-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../subagent-extractor.js')>()
  return {
    ...actual,
    extractSubagentsFromSessionFile: vi.fn((filePath: string) =>
      actual.extractSubagentsFromSessionFile(filePath),
    ),
  }
})
vi.mock('../workflow-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workflow-extractor.js')>()
  return {
    ...actual,
    extractWorkflowsFromSessionFile: vi.fn((filePath: string) =>
      actual.extractWorkflowsFromSessionFile(filePath),
    ),
  }
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

  it('轮终翻转维度（result 写入 / resumable 桥接→idle）触发 publish；legacy chatMode 键容忍不触发（modeless 去比对维度）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(1)

    // 逐维度翻转：去重层若缺比对会把「轮终」的显示信号静默吞掉（不 publish）
    // resumable 翻转经第五归一（running+resumable → idle）由 status 位天然触发
    for (const extra of [
      { result: 'round output' },
      { resumable: true },
    ] as Array<Record<string, unknown>>) {
      client.getEntries.mockResolvedValue({
        data: { entries: [subagentRecordEntry('sa-1', 'running', `e-${Object.keys(extra)[0]}`, extra)], leafId: 'e-x' },
      })
      records.invalidateRecordEntries('s1', 'subagent-record')
      await flushDebounce()
    }
    expect(publish).toHaveBeenCalledTimes(3)

    // [modeless 波4] chatMode 已从 record 消亡：旧 entry 残留该键被投影层忽略，
    // 不再构成 publish 信号（去重维度去 chatMode 化——同键重复到达不重发）。
    // 叠加在前一形态（resumable 在场）之上：仅新增 chatMode 键，其余字段全同
    client.getEntries.mockResolvedValue({
      data: { entries: [subagentRecordEntry('sa-1', 'running', 'e-chatmode-legacy', { resumable: true, chatMode: false })], leafId: 'e-x' },
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(3)
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

describe('[RT-4#9] invalidateRecordEntries 未知 customType 早退门 warn 显形', () => {
  it('非白名单 customType 早退 + warn（按类型去重一次），白名单不受影响', async () => {
    vi.useFakeTimers()
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 同一未知类型两次：warn 只落一次（去重）
      records.invalidateRecordEntries('s1', 'future-record-kind')
      records.invalidateRecordEntries('s1', 'future-record-kind')
      const warns = warnSpy.mock.calls.filter((c) => String(c[0]).includes("unknown customType 'future-record-kind'"))
      expect(warns).toHaveLength(1)

      // 白名单类型不受影响：正常调度防抖拉取
      records.invalidateRecordEntries('s1', 'subagent-record')
      await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS)
      expect(client.getEntries).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
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
    expect(result.records).toHaveLength(1)
    // [RT-4#8] oversize 标志随结果透传（正常路径 false）
    expect(result.oversize).toBe(false)
    expect(result.records[0]).toEqual(expect.objectContaining({ subagentId: 'sa-1', status: 'running' }))
  })

  it('getSubagents：session 不在扫描结果返回 []', async () => {
    const { records } = makeRecords()
    // [RT-4#8] 结构化返回（records + oversize）：无扫描命中 = 空列表且非 oversize
    expect(await records.getSubagents('s-none')).toEqual({ records: [], oversize: false })
  })

  it('getWorkflows：定位 session 文件后提取 workflow 列表', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-test-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, JSON.stringify(workflowRecordEntry('run-1', 'done', 'e1')))
    const { records } = makeRecords({
      sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath }]) } as unknown as ISessionStore,
    })
    const result = await records.getWorkflows('s1')
    expect(result.records).toHaveLength(1)
    expect(result.oversize).toBe(false)
    expect(result.records[0]).toEqual(expect.objectContaining({ runId: 'run-1', status: 'done' }))
  })

  it('[RT-4#8] oversize（文件 >32MB 预检阈值）：records 恒空 + oversize=true 透传 + 每会话一次 warn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-oversize-'))
    const filePath = join(dir, 'huge-session.jsonl')
    // 稀疏文件：写一字节后 truncate 到超阈值——stat.size 超限触发 extractor 预检降级，
    // 磁盘实际占用极小（fixture 自建自删）
    writeFileSync(filePath, '\n')
    truncateSync(filePath, 33 * 1024 * 1024)
    const { records } = makeRecords({
      sessionStore: { scanSessions: vi.fn(() => [{ id: 's-big', filePath }]) } as unknown as ISessionStore,
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 反复拉取（面板 retry 场景）：oversize 分形稳定 + warn 每会话只落一次
      const first = await records.getSubagents('s-big')
      const second = await records.getWorkflows('s-big')
      await records.getSubagents('s-big')
      expect(first).toEqual({ records: [], oversize: true })
      expect(second).toEqual({ records: [], oversize: true })
      // 每会话 + 每类别一次（去重 key = sid:kind）：3 次调用 2 条 warn（subagents 一次 + workflows 一次）
      const dedupeWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('list unavailable'))
      expect(dedupeWarns).toHaveLength(2)
    } finally {
      warnSpy.mockRestore()
      // teardown 递归删除补 maxRetries/retryDelay：与在途异步写竞争时 ENOTEMPTY 瞬态失败可重试
      // （同文件 :962 范式；rm/rmSync 默认 maxRetries=0，一次瞬态失败即抛 → 满载 flake）
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
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
    await records.workflowAction('s1', 'abort', 'run-1')
    expect(client.prompt).toHaveBeenCalledWith('/workflows abort run-1')
  })

  it('workflowAction：session 不活跃 throw', async () => {
    const { records } = makeRecords({ pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager })
    await expect(records.workflowAction('s1', 'abort', 'run-1')).rejects.toThrow('Session s1 not active')
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
    await records.workflowAction('s1', 'abort', 'run-1')
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

// ── plan-state 投影（plan 模式重设计 D1③④）─────────────────────────────

/** plan-state entry fixture（data 平铺四必填 + 三 optional，无 v 字段——D4 否决版本轴）。 */
function planStateEntry(data: Record<string, unknown>, entryId: string): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'plan-state',
    id: entryId,
    parentId: null,
    timestamp: '2026-09-18T00:00:00Z',
    data,
  }
}

/** 新七字段形态（扩展三 optional 齐全）。 */
function fullPlanData(reviewState: 'awaiting' | 'revising'): Record<string, unknown> {
  return {
    isActive: true,
    planFilePath: '/tmp/taiji-plan/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'tech-design',
    skills: ['tech-design', 'dev-flow'],
    docs: [{ fileName: 'design.md', absPath: '/tmp/taiji-plan/auth/design.md', sourceSkill: 'tech-design', version: 1 }],
    reviewState,
  }
}

describe('plan-state 投影（D1③④）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('第二道门扩容：plan-state 不被早退（失效 → 防抖拉取真发生）', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledTimes(1)
  })

  it('派生 publish：payload = { sessionId, planState }（与 shared 协议对齐，docs/skills 透传）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    const planMsgs = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')
    expect(planMsgs).toHaveLength(1)
    expect(planMsgs[0]![0]).toBe('s1')
    const payload = (planMsgs[0]![1] as { payload: { sessionId: string; planState: Record<string, unknown> } }).payload
    expect(payload.sessionId).toBe('s1')
    expect(payload.planState).toEqual(expect.objectContaining({
      isActive: true,
      skills: ['tech-design', 'dev-flow'],
      reviewState: 'awaiting',
      docs: [expect.objectContaining({ fileName: 'design.md', version: 1 })],
    }))
  })

  it('无 plan entry 不 publish（派生 null 且基线 null = 无变化，GUI 缺省即未激活）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [{ type: 'message', id: 'm1' }], leafId: 'm1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')).toHaveLength(0)
  })

  it('同值重复 entry 不重复 publish（planStateEquals diff 基线）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')).toHaveLength(1)

    // 增量窗口返回同值新 entry（仅 entryId 变，快照未变）——不发布
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e9')], leafId: 'e9' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')).toHaveLength(1)
  })

  it('内容变化才 publish：reviewState 翻转 / docs version bump 各触发一次', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    // revise：reviewState awaiting → revising（第二帧）
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('revising'), 'e2')], leafId: 'e2' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    // 修订完成重登记：version bump（第三帧）
    const bumped = fullPlanData('awaiting')
    bumped.docs = [{ fileName: 'design.md', absPath: '/tmp/taiji-plan/auth/design.md', sourceSkill: 'tech-design', version: 2 }]
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(bumped, 'e3')], leafId: 'e3' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    const planMsgs = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')
    expect(planMsgs).toHaveLength(3)
    expect((planMsgs[1]![1] as { payload: { planState: { reviewState: string } } }).payload.planState.reviewState).toBe('revising')
    expect((planMsgs[2]![1] as { payload: { planState: { docs: Array<{ version: number }> } } }).payload.planState.docs[0]!.version).toBe(2)
  })

  // §3.4 四触点第 3 层（发布水位）：仅 reviewStateSource 变化（其余七字段全等）必须
  // publish——漏比对会把 source 变化判「无变化」而抑制 session.planState 广播，
  // renderer live 更新唯一通道是 WS 帧，帧被抑制即恒渲染旧降级文案（第 3 轮审查 P1）。
  it('仅 reviewStateSource 变化（其余七字段全等）→ 恰好 publish 一帧 session.planState', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    // 首拉基线：awaiting 且无 source（旧 entry 形态，undefined 缺省）
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')).toHaveLength(1)

    // 同值新 entry 仅追加 reviewStateSource（resubmit 分支落盘后的重放形态；'explain'
    // 存量值在 extractor 归无值，白名单只认 'resubmit'——plan-state-extractor 裁决）
    const sourced = { ...fullPlanData('awaiting'), reviewStateSource: 'resubmit' }
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(sourced, 'e2')], leafId: 'e2' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    const planMsgs = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')
    expect(planMsgs).toHaveLength(2)
    expect((planMsgs[1]![1] as { payload: { planState: { reviewStateSource?: string } } }).payload.planState.reviewStateSource).toBe('resubmit')
  })

  it('reset entry：isActive=false 且 docs 保留仍 publish（产物 tab 回看驱动，与 isActive 解耦）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    const resetData = {
      isActive: false,
      planFilePath: '/tmp/taiji-plan/auth/plan.md',
      requirement: '',
      templateName: '',
      docs: [{ fileName: 'design.md', absPath: '/tmp/taiji-plan/auth/design.md', sourceSkill: 'tech-design', version: 1 }],
    }
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(resetData, 'e2')], leafId: 'e2' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    const planMsgs = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')
    expect(planMsgs).toHaveLength(2)
    const last = (planMsgs[1]![1] as { payload: { planState: Record<string, unknown> } }).payload.planState
    expect(last.isActive).toBe(false)
    expect(last.docs).toEqual([expect.objectContaining({ fileName: 'design.md' })])
  })

  it('冷路径 getPlanState：定位 session 文件后经 extractor 提取（与热路径同一份派生代码）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-plan-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, [
      JSON.stringify({ type: 'message', id: 'm1' }),
      JSON.stringify(planStateEntry(fullPlanData('awaiting'), 'e1')),
    ].join('\n'))
    try {
      const { records } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath }]) } as unknown as ISessionStore,
      })
      const view = await records.getPlanState('s1')
      expect(view.isActive).toBe(true)
      expect(view.reviewState).toBe('awaiting')
      expect(view.docs).toEqual([expect.objectContaining({ fileName: 'design.md', version: 1 })])
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('冷路径 getPlanState：session 不在扫描结果返回未激活缺省 View（RPC reply 无 null 域）', async () => {
    const { records } = makeRecords()
    const view = await records.getPlanState('s-none')
    expect(view).toEqual({
      isActive: false,
      planFilePath: null,
      requirement: null,
      templateName: null,
    })
  })

  // [MF-1 回归] JSONL append-only 下 entry 不会消失，增量批（cursor delta）的
  // 「无 plan-state entry」= 本批无 plan 新信息，非「entry 被清空」——误判会把活跃 plan
  // 的 GUI（PlanModeBar/产物面板）被无关 subagent/workflow record 增量重拉静默打回未激活。
  it('增量批无 plan-state entry：保持基线不 publish（非全量路径收敛语义不适用）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    // 首拉（全量）：发布 awaiting 基线
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')).toHaveLength(1)

    // 增量 delta 只含 subagent-record（plan 实际仍活跃）——不 publish
    client.getEntries.mockClear()
    client.getEntries.mockResolvedValue({
      data: { entries: [subagentRecordEntry('sa-1', 'running', 'e2')], leafId: 'e2' },
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledWith('e1') // 确认走的是增量路径（非全量重建）
    expect(publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')).toHaveLength(1)

    // 第三拉：同值 plan entry 重现——若基线曾被误清为 null，此处会多 publish 一次；
    // 恰 1 帧 = 基线保持（planStateEquals diff 基线未被增量批破坏的间接证伪）
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e3')], leafId: 'e3' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')).toHaveLength(1)
  })

  it('全量重建 entry 消失：恰发布一次 session.planState 且为未激活缺省 View（收敛语义收归全量路径）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    // 首拉（全量）：发布 awaiting 基线
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    // 游标失效自愈（session 文件被外部改写）：丢 cursor 全量重拉，全集中 plan-state entry 已消失
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since !== undefined) throw new Error('Entry not found: e1')
      return { data: { entries: [subagentRecordEntry('sa-1', 'done', 'e2')], leafId: 'e2' } } as GetEntriesResult
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledWith('e1') // 第 1 轮增量（Entry not found）
    expect(client.getEntries).toHaveBeenCalledWith() // 第 2 轮丢 cursor 全量重建

    const planMsgs = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')
    expect(planMsgs).toHaveLength(2) // awaiting 基线帧 + 收敛帧，恰一次收敛
    expect((planMsgs[1]![1] as { payload: { planState: Record<string, unknown> } }).payload.planState)
      .toEqual({ isActive: false, planFilePath: null, requirement: null, templateName: null })
  })
})

// ── [W1 / D6] journal 投影读侧换源 ────────────────────────────
//
// 验收对照：① 旧会话 v1 路径回归（冻结快照对照——getSubagents/getWorkflows 输出与
// 兼容层 extract*FromSessionFile 全文路径输出逐字段一致）；② v2 会话读投影（journal
// 胜出仲裁 + 条目摘要合并）；③ 全文读路径不调用断言（正常体量走投影，oversize 分流
// 才触达兼容路径）；④ 投影驱动信号（journal 事件 → tail 复查 → 投影变更 → publish）。

/** v2 subagent-record 注册条目 entry（W1 D1 契约）。 */
function subagentRegisteredV2(id: string): Record<string, unknown> {
  return {
    type: 'custom', customType: 'subagent-record', id: 'e-r1', parentId: null,
    timestamp: '2026-09-26T00:00:00Z',
    data: {
      v: 2, kind: 'registered', id, agent: 'worker', task: 'Do work', slug: 'work',
      origin: 'workflow', parentRunId: 'wf-1', stepIndex: 0, rootSessionId: 's1',
      depth: 0, startedAt: 1000,
    },
  }
}

/** v2 subagent-record 终态条目 entry（载荷与 journal 冲突——断言 journal 胜出）。 */
function subagentSettledV2(id: string): Record<string, unknown> {
  return {
    type: 'custom', customType: 'subagent-record', id: 'e-s1', parentId: null,
    timestamp: '2026-09-26T00:00:01Z',
    data: {
      v: 2, kind: 'settled', id, status: 'idle', stopReason: 'interrupted',
      endedAt: 3000, turns: 9, totalTokens: 999, model: 'p/m', thinkingLevel: 'low',
      result: 'full result text',
    },
  }
}

/** v2 workflow-record 注册条目 entry。 */
function workflowRegisteredV2(runId: string, journalPath: string): Record<string, unknown> {
  return {
    type: 'custom', customType: 'workflow-record', id: 'e-w1', parentId: null,
    timestamp: '2026-09-26T00:00:00Z',
    data: {
      v: 2, kind: 'registered', runId, workflowName: 'test-flow', scriptName: 'test-flow',
      slug: 'tf', startedAt: 1000, journalPath,
    },
  }
}

/** v2 会话世界 fixture：agentDir（records 目录）+ 会话文件（v2 条目）+ run journal 目录。 */
function makeV2World(cwd: string): {
  worldDir: string
  agentDir: string
  sessionFile: string
  recordsDir: string
  runJournalDir: string
} {
  const worldDir = mkdtempSync(join(tmpdir(), 'session-records-w1-'))
  const agentDir = join(worldDir, 'agent')
  const sessionFile = join(worldDir, 's1.jsonl')
  const recordsDir = join(agentDir, 'subagents', encodeCwd(cwd), 'records')
  const runJournalDir = join(worldDir, 'workflow-state')
  mkdirSync(recordsDir, { recursive: true })
  mkdirSync(runJournalDir, { recursive: true })
  return { worldDir, agentDir, sessionFile, recordsDir, runJournalDir }
}

describe('[W1] 读侧换源：v1 旧会话冻结对照 / v2 读投影 / 全文路径不调用 / 投影驱动信号', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    extractSubagentsMock.mockClear()
    extractWorkflowsMock.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    piAgentDirRef.dir = ''
  })

  it('旧会话 v1 路径回归：getSubagents/getWorkflows 输出与兼容层全文路径逐字段一致（冻结快照对照）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-v1frozen-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, [
      JSON.stringify(subagentRecordEntry('sa-1', 'running', 'e1', { origin: 'workflow', parentRunId: 'run-1', stepIndex: 0 })),
      JSON.stringify(workflowRecordEntry('run-1', 'running', 'e2', undefined, [
        { stepIndex: 0, agent: 'reviewer', task: 't', model: 'default', status: 'running', phase: 'R1' },
      ])),
    ].join('\n') + '\n')
    try {
      const { records } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath, cwd: '/tmp/proj' }]) } as unknown as ISessionStore,
      })
      const subagents = await records.getSubagents('s1')
      const workflows = await records.getWorkflows('s1')
      // 冻结参照 = 兼容层全文路径对同一文件的真实输出（行为不变的机器对照）
      expect(subagents).toEqual(extractSubagentsFromSessionFile(filePath))
      expect(workflows).toEqual(extractWorkflowsFromSessionFile(filePath))
      expect(subagents.records).toHaveLength(1)
      expect(workflows.records[0]!.agentCalls[0]).toMatchObject({ agent: 'reviewer', status: 'running' })
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('v2 读投影：journal fold 胜出条目冲突（status/stopReason），条目独有字段（model/result）照常填充', async () => {
    const cwd = '/tmp/w1-proj'
    const world = makeV2World(cwd)
    piAgentDirRef.dir = world.agentDir
    try {
      // journal：created（无 settled）→ running；条目：settled(interrupted) → journal 胜出显示 running
      writeFileSync(join(world.recordsDir, 'sa-1.events'), [
        JSON.stringify({ type: 'record-journal', id: 'sa-1' }),
        JSON.stringify({ type: 'record-created', seq: 1, ts: 1000, id: 'sa-1', agent: 'worker', task: 'Do work', slug: 'work', origin: 'workflow', parentRunId: 'wf-1', stepIndex: 0, rootSessionId: 's1', depth: 0, mode: 'bg', startedAt: 1000 }),
      ].join('\n') + '\n')
      writeFileSync(world.sessionFile, [
        JSON.stringify({ type: 'session', id: 's1', cwd }),
        JSON.stringify(subagentRegisteredV2('sa-1')),
        JSON.stringify(subagentSettledV2('sa-1')),
        JSON.stringify(workflowRegisteredV2('wf-1', join(world.runJournalDir, 'wf-1.record.jsonl'))),
      ].join('\n') + '\n')
      writeFileSync(join(world.runJournalDir, 'wf-1.record.jsonl'), [
        JSON.stringify({ type: 'run-created', runId: 'wf-1', workflowName: 'test-flow', argsSummary: '', ts: 1000 }),
        JSON.stringify({ type: 'agent-started', taskIndex: 0, agentName: 'worker', attempt: 1, ts: 1100 }),
      ].join('\n') + '\n')
      const { records } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath: world.sessionFile, cwd }]) } as unknown as ISessionStore,
      })
      const subagents = await records.getSubagents('s1')
      expect(subagents.records).toHaveLength(1)
      expect(subagents.records[0]).toMatchObject({
        subagentId: 'sa-1',
        status: 'running', // journal 胜出（条目 settled idle 不生效）
        model: 'p/m', // 条目独有字段
        result: 'full result text',
        parentRunId: 'wf-1',
        stepIndex: 0,
      })
      const workflows = await records.getWorkflows('s1')
      expect(workflows.records).toHaveLength(1)
      expect(workflows.records[0]).toMatchObject({ runId: 'wf-1', status: 'running', scriptName: 'test-flow' })
      // 步骤视图合并（W0 输入换源）：record 投影 overlay 到 journal 骨架行
      expect(workflows.records[0]!.agentCalls[0]).toMatchObject({ status: 'running', sessionId: 'sa-1' })
      // 验收③：正常体量会话零调用全文读路径
      expect(extractSubagentsMock).not.toHaveBeenCalled()
      expect(extractWorkflowsMock).not.toHaveBeenCalled()
    } finally {
      rmSync(world.worldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('投影驱动信号：journal 追加终态事件 → tail 复查 → 投影变更 publish（subagents 帧 + workflowUpdate 转态信号）', async () => {
    const cwd = '/tmp/w1-signal'
    const world = makeV2World(cwd)
    piAgentDirRef.dir = world.agentDir
    try {
      writeFileSync(join(world.recordsDir, 'sa-1.events'), [
        JSON.stringify({ type: 'record-journal', id: 'sa-1' }),
        JSON.stringify({ type: 'record-created', seq: 1, ts: 1000, id: 'sa-1', agent: 'worker', task: 'Do work', slug: 'work', origin: 'workflow', parentRunId: 'wf-1', stepIndex: 0, rootSessionId: 's1', depth: 0, mode: 'bg', startedAt: 1000 }),
      ].join('\n') + '\n')
      writeFileSync(world.sessionFile, [
        JSON.stringify(subagentRegisteredV2('sa-1')),
        JSON.stringify(workflowRegisteredV2('wf-1', join(world.runJournalDir, 'wf-1.record.jsonl'))),
      ].join('\n') + '\n')
      writeFileSync(join(world.runJournalDir, 'wf-1.record.jsonl'), [
        JSON.stringify({ type: 'run-created', runId: 'wf-1', workflowName: 'test-flow', argsSummary: '', ts: 1000 }),
        JSON.stringify({ type: 'agent-started', taskIndex: 0, agentName: 'worker', attempt: 1, ts: 1100 }),
      ].join('\n') + '\n')
      const { records, publish } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath: world.sessionFile, cwd }]) } as unknown as ISessionStore,
        journalTailerRecheckMs: 50,
      })
      const fire = registerSession(records)
      fire('s1')

      // 冷启动首帧（attach 折叠 → onChange → publish：subagents 帧恰一）
      await records.getSubagents('s1')
      let subFrames = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.subagents')
      expect(subFrames).toHaveLength(1)
      expect((subFrames[0]![1] as { payload: { subagents: Array<{ status: string }> } }).payload.subagents[0]!.status).toBe('running')

      // journal 追加 record-settled（completed）→ 复查周期拾取 → 投影变更 publish
      publish.mockClear()
      writeFileSync(join(world.recordsDir, 'sa-1.events'), [
        JSON.stringify({ type: 'record-settled', seq: 2, ts: 3000, stopReason: 'completed', endedAt: 3000, turns: 2, totalTokens: 500 }),
      ].join('\n') + '\n', { flag: 'a' })
      await vi.advanceTimersByTimeAsync(150)

      subFrames = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.subagents')
      expect(subFrames).toHaveLength(1)
      expect((subFrames[0]![1] as { payload: { subagents: Array<{ status: string; stopReason: string }> } }).payload.subagents[0])
        .toMatchObject({ status: 'idle', stopReason: 'completed' })
      // 转态信号（stepStatuses running→completed 维度）：record overlay 翻步骤行 → workflowUpdate
      const wfSignals = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.workflowUpdate')
      expect(wfSignals).toHaveLength(1)
      expect((wfSignals[0]![1] as { payload: { update: { runId: string; status: string } } }).payload.update)
        .toEqual({ runId: 'wf-1', status: 'running', reason: undefined })
    } finally {
      rmSync(world.worldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  // [W1 双形态] v2 混沌收敛（原 w18-record-entry-chaos 双形态断言的领地内落点）：
  // entry 通道整体空转（无 entry_appended 信号 + get_entries 恒空——比「信号被拦截」
  // 更强的混沌）下，唯一驱动 = bg-notify 兜底失效链（invalidateRecordEntries 即
  // event-interpreter 经组合根注入的同一入口）→ 投影冷启动 → record 事件文件 fold
  // （事实源）独立重建，收敛值与信号在位时等价。
  it('[W1 双形态] v2 混沌：entry 通道整体空转 → 兜底失效触发投影冷启动，journal fold 独立收敛', async () => {
    const cwd = '/tmp/w1-chaos'
    const world = makeV2World(cwd)
    piAgentDirRef.dir = world.agentDir
    try {
      // journal：created + settled(completed) 已落盘；会话文件仅注册条目（终态条目缺席）
      writeFileSync(join(world.recordsDir, 'sa-1.events'), [
        JSON.stringify({ type: 'record-journal', id: 'sa-1' }),
        JSON.stringify({ type: 'record-created', seq: 1, ts: 1000, id: 'sa-1', agent: 'worker', task: 'Do work', slug: 'work', origin: 'workflow', parentRunId: 'wf-1', stepIndex: 0, rootSessionId: 's1', depth: 0, mode: 'background', startedAt: 1000 }),
        JSON.stringify({ type: 'record-settled', seq: 2, ts: 3000, stopReason: 'completed', endedAt: 3000, turns: 2, totalTokens: 500 }),
      ].join('\n') + '\n')
      writeFileSync(world.sessionFile, `${JSON.stringify(subagentRegisteredV2('sa-1'))}\n`)
      // 混沌注入：get_entries 恒空（entry 源两代都不产出）——投影只能来自 journal 源
      const { records, publish, client } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath: world.sessionFile, cwd }]) } as unknown as ISessionStore,
      })
      client.getEntries.mockResolvedValue({ data: { entries: [], leafId: null } })
      const fire = registerSession(records)
      fire('s1')

      // 唯一驱动：bg-notify 兜底失效信号（interpreter 经组合根到达的同一入口）
      records.invalidateRecordEntries('s1', 'subagent-record')
      await flushDebounce()
      expect(client.getEntries).toHaveBeenCalledTimes(1)

      // 收敛断言：journal fold 独立重建（entry 通道空）——帧内容 = 事件文件的权威值
      const subFrames = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.subagents')
      expect(subFrames).toHaveLength(1)
      expect((subFrames[0]![1] as { payload: { subagents: Array<{ subagentId: string; status: string; stopReason: string }> } }).payload.subagents)
        .toEqual([expect.objectContaining({ subagentId: 'sa-1', status: 'idle', stopReason: 'completed' })])
      // RPC 读面同源：getSubagents 与已发布帧一致（读请求唯一数据源 = 投影）
      const rpc = await records.getSubagents('s1')
      expect(rpc.records[0]).toMatchObject({ subagentId: 'sa-1', status: 'idle', stopReason: 'completed' })
    } finally {
      rmSync(world.worldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
