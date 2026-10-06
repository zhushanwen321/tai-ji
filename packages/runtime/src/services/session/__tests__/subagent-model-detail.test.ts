/**
 * subagent / workflow run 详情载荷模型字段面测试（subagent-model-switch §7.1 入口层，
 * U1 详情载荷透传验收面）。
 *
 * 覆盖（字段面单测四项 + 出口接线）：
 * - 覆盖状态（modelOverride）：查询端口在场且有覆盖 → 载荷携带；无覆盖 / 端口缺席 →
 *   不造键；workflow origin 成员跳过 chat 域查询（覆盖作用域归 run 级）；
 * - 最近生效值（recentEffectiveModel）：pi 成员且有 model_change 尾条目 → 携带尾条目
 *   值；无条目 / 文件不存在 → 不造键；非 pi 成员不参与派生、不携带；
 * - 出口接线：getSubagents（读 RPC）与 publishRecordChanges（live 全量帧）两出口都
 *   增强（renderer store 分区整帧替换语义，单出口增强会被另一出口冲掉）；
 * - run 详情侧逐成员携带：projectSubagentModelDetailIntoRuns（run 级覆盖分发全部
 *   agentCall；成员生效值按 (parentRunId, stepIndex) 圈定透传；聚合面不取单一值）。
 *
 * 测试框架：vitest（从子包目录运行）。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/subagent-model-detail.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'
import type { SessionRecordsDeps } from '../session-records.js'
import type { SubagentModelOverrideStatus, SubagentRecord } from '@taiji/shared'
import { SessionRecords } from '../session-records.js'
import {
  readPiSessionLatestModelChange,
  DEFAULT_SUBAGENT_ENGINE,
} from '../subagent-engine-history.js'
import { projectSubagentModelDetailIntoRuns } from '../workflow-record-projection.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../replicated-states.config.js'

// ── fixture ──────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'subagent-model-detail-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** pi session JSONL 行写入口（model_change 条目形态 = pi appendModelChange 落盘形态）。 */
function modelChangeLine(provider: string, modelId: string, timestamp = '2026-10-06T00:00:00Z'): string {
  return JSON.stringify({ type: 'model_change', id: 'mc-1', parentId: null, timestamp, provider, modelId })
}

/** 主 session JSONL 写入（subagent-record 条目族，与 pi appendCustomEntry 落盘形态同构）。 */
function writeMainSession(sessionId: string, entries: Array<Record<string, unknown>>): string {
  const filePath = join(tmpDir, `${sessionId}.jsonl`)
  writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  return filePath
}

function registeredEntry(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: `${id}-reg`,
    parentId: null,
    timestamp: '2026-08-19T00:00:00Z',
    data: {
      v: 2,
      kind: 'registered',
      id,
      agent: 'worker',
      task: 'Do work',
      slug: 'work',
      origin: 'tool',
      rootSessionId: 'main-1',
      depth: 0,
      startedAt: 1000,
      ...extra,
    },
  }
}

function settledEntry(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: `${id}-set`,
    parentId: null,
    timestamp: '2026-08-19T00:00:01Z',
    data: {
      v: 2,
      kind: 'settled',
      id,
      status: 'idle',
      stopReason: 'completed',
      endedAt: 2000,
      turns: 1,
      totalTokens: 10,
      model: 'p/old',
      thinkingLevel: undefined,
      sessionFile: undefined,
      ...extra,
    },
  }
}

/** 最小装置（与 session-records.test.ts 同手法：deps 全 mock + publish spy 收集）。 */
function makeRecords(depsOverrides: Partial<SessionRecordsDeps> = {}) {
  const publish = vi.fn()
  const client = {
    getEntries: vi.fn(async () => ({ data: { entries: [], leafId: null } })),
    prompt: vi.fn(async () => undefined),
  }
  const deps: SessionRecordsDeps = {
    pm: { getClient: vi.fn(() => client as unknown as IPiEngine) } as unknown as IProcessManager,
    sessionStore: { scanSessions: vi.fn(() => [] as Array<{ id: string; filePath: string }>) } as unknown as ISessionStore,
    hasSession: vi.fn(() => true),
    getMessageBus: () => ({ publish } as unknown as IMessageBus),
    ...depsOverrides,
  }
  const records = new SessionRecords(deps)
  return { records, publish, deps }
}

/** subscribe 后收集注册 handler，返回手动触发器（模拟 lifecycle 同步直发，激活派生缓存）。 */
function registerSession(records: SessionRecords): (sessionId: string) => void {
  const handlers: Array<(sessionId: string) => void> = []
  records.subscribe({ onSessionRegistered: (h) => { handlers.push(h) } })
  return (sessionId: string) => { for (const h of handlers) h(sessionId) }
}

// ── readPiSessionLatestModelChange（派生函数直测）────────────────

describe('readPiSessionLatestModelChange — model_change 尾条目派生', () => {
  it('文件不存在（pi 首次 flush 前延迟写入）→ undefined（按无值处理）', () => {
    expect(readPiSessionLatestModelChange(join(tmpDir, 'missing.jsonl'))).toBeUndefined()
  })

  it('无 model_change 条目（未发生热切）→ undefined', () => {
    const file = join(tmpDir, 'no-change.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', id: 's1', cwd: '/w' }),
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: [] } }),
      ].join('\n') + '\n',
    )
    expect(readPiSessionLatestModelChange(file)).toBeUndefined()
  })

  it('多条 model_change → 尾条目胜出（最后生效值）', () => {
    const file = join(tmpDir, 'multi.jsonl')
    writeFileSync(
      file,
      [
        modelChangeLine('p-a', 'model-a', '2026-10-06T00:00:01Z'),
        modelChangeLine('p-b', 'model-b', '2026-10-06T00:00:02Z'),
        modelChangeLine('p-c', 'model-c', '2026-10-06T00:00:03Z'),
      ].join('\n') + '\n',
    )
    expect(readPiSessionLatestModelChange(file)).toEqual({ provider: 'p-c', modelId: 'model-c' })
  })

  it('尾部畸形行（半写行 / 非 JSON）跳过不炸，命中更早的合法条目', () => {
    const file = join(tmpDir, 'torn.jsonl')
    writeFileSync(
      file,
      [modelChangeLine('p', 'm'), '{"type":"model_change","provider":"tor'].join('\n') + '\n',
    )
    expect(readPiSessionLatestModelChange(file)).toEqual({ provider: 'p', modelId: 'm' })
  })

  it('字段畸形条目（provider 非串 / 空串）按无效处理', () => {
    const file = join(tmpDir, 'malformed.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'model_change', provider: 42, modelId: 'm' }),
        JSON.stringify({ type: 'model_change', provider: '', modelId: 'm' }),
      ].join('\n') + '\n',
    )
    expect(readPiSessionLatestModelChange(file)).toBeUndefined()
  })
})

// ── getSubagents / live 帧两出口的字段面 ─────────────────────────

describe('详情载荷字段面 — getSubagents 出口', () => {
  it('覆盖状态 + 最近生效值在场：载荷携带（chat 域成员）', async () => {
    const subFile = join(tmpDir, 'sub.jsonl')
    writeFileSync(subFile, modelChangeLine('p-new', 'm-new') + '\n')
    writeMainSession('main-1', [
      registeredEntry('sa-1'),
      settledEntry('sa-1', { sessionFile: subFile }),
    ])
    const override: SubagentModelOverrideStatus = { model: 'p-new/m-new', thinkingLevel: 'high' }
    const { records } = makeRecords({
      sessionStore: {
        scanSessions: vi.fn(() => [{ id: 'main-1', filePath: join(tmpDir, 'main-1.jsonl') }]),
      } as unknown as ISessionStore,
      modelOverrideQuery: {
        getRecordOverride: vi.fn((recordId: string) => (recordId === 'sa-1' ? override : undefined)),
        getRunOverride: vi.fn(() => undefined),
      },
    })
    const fire = registerSession(records)
    fire('main-1')

    const { records: subagents } = await records.getSubagents('main-1')
    const record = subagents.find((s) => s.subagentId === 'sa-1')
    expect(record).toBeDefined()
    expect(record?.modelOverride).toEqual(override)
    expect(record?.recentEffectiveModel).toEqual({ provider: 'p-new', modelId: 'm-new' })
  })

  it('无覆盖 / 无 model_change / 查询端口缺席：字段不造键', async () => {
    writeMainSession('main-1', [registeredEntry('sa-1'), settledEntry('sa-1')])
    const { records } = makeRecords({
      sessionStore: {
        scanSessions: vi.fn(() => [{ id: 'main-1', filePath: join(tmpDir, 'main-1.jsonl') }]),
      } as unknown as ISessionStore,
      // 端口在场但查无覆盖 → 不造键
      modelOverrideQuery: {
        getRecordOverride: vi.fn(() => undefined),
        getRunOverride: vi.fn(() => undefined),
      },
    })
    const fire = registerSession(records)
    fire('main-1')

    const { records: subagents } = await records.getSubagents('main-1')
    const record = subagents.find((s) => s.subagentId === 'sa-1')
    expect(record).toBeDefined()
    expect(record?.modelOverride).toBeUndefined()
    expect(record?.recentEffectiveModel).toBeUndefined()
  })

  it('非 pi 引擎成员：不参与派生、不携带 recentEffectiveModel（model_change 只属 pi session）', async () => {
    writeMainSession('main-1', [
      registeredEntry('sa-z'),
      settledEntry('sa-z', { engine: 'zcode', engineHandle: { sessionRef: { sessionId: 'z1', dbPath: '/db.sqlite' }, poolKey: 'shared' } }),
    ])
    const { records } = makeRecords({
      sessionStore: {
        scanSessions: vi.fn(() => [{ id: 'main-1', filePath: join(tmpDir, 'main-1.jsonl') }]),
      } as unknown as ISessionStore,
      modelOverrideQuery: {
        getRecordOverride: vi.fn(() => ({ model: 'p/m' })),
        getRunOverride: vi.fn(() => undefined),
      },
    })
    const fire = registerSession(records)
    fire('main-1')

    const { records: subagents } = await records.getSubagents('main-1')
    const record = subagents.find((s) => s.subagentId === 'sa-z')
    expect(record).toBeDefined()
    expect(record?.engine).toBe('zcode')
    // 非 pi 成员覆盖状态照常携带（覆盖记账引擎无关），但最近生效值不派生
    expect(record?.modelOverride).toEqual({ model: 'p/m' })
    expect(record?.recentEffectiveModel).toBeUndefined()
  })

  it('workflow origin 成员跳过 chat 域覆盖查询（覆盖作用域归 run 级）', async () => {
    writeMainSession('main-1', [
      registeredEntry('sa-wf', { origin: 'workflow', parentRunId: 'wf-1', stepIndex: 0 }),
      settledEntry('sa-wf'),
    ])
    const getRecordOverride = vi.fn(() => ({ model: 'p/should-not-appear' }))
    const { records } = makeRecords({
      sessionStore: {
        scanSessions: vi.fn(() => [{ id: 'main-1', filePath: join(tmpDir, 'main-1.jsonl') }]),
      } as unknown as ISessionStore,
      modelOverrideQuery: { getRecordOverride, getRunOverride: vi.fn(() => undefined) },
    })
    const fire = registerSession(records)
    fire('main-1')

    const { records: subagents } = await records.getSubagents('main-1')
    const record = subagents.find((s) => s.subagentId === 'sa-wf')
    expect(record?.modelOverride).toBeUndefined()
    expect(getRecordOverride).not.toHaveBeenCalled()
  })
})

describe('详情载荷字段面 — publishRecordChanges live 帧出口', () => {
  it('live 全量帧同样增强（整帧替换语义下两出口必须一致）', async () => {
    vi.useFakeTimers()
    try {
      const subFile = join(tmpDir, 'sub-live.jsonl')
      writeFileSync(subFile, modelChangeLine('p-live', 'm-live') + '\n')
      const mainEntries = [
        registeredEntry('sa-1'),
        settledEntry('sa-1', { sessionFile: subFile }),
      ]
      writeMainSession('main-1', mainEntries)
      const { records, publish } = makeRecords({
        sessionStore: {
          scanSessions: vi.fn(() => [{ id: 'main-1', filePath: join(tmpDir, 'main-1.jsonl') }]),
        } as unknown as ISessionStore,
        modelOverrideQuery: {
          getRecordOverride: vi.fn(() => ({ model: 'p-live/m-live' })),
          getRunOverride: vi.fn(() => undefined),
        },
      })
      // get_entries 全量返回条目集（pi 内存 entries 与磁盘 JSONL 行同构；全量拉取
      // fullRebuild 先清投影再应用——entries 空会清掉冷读产物，故必须喂条目）。
      // makeRecords 的默认 client 被 depsOverrides 前置，这里经 deps.pm 直改不可行，
      // 改为构造后替换：refreshRecordEntries 每次经 pm.getClient 取 client。
      const recordsAny = records as unknown as { deps: SessionRecordsDeps }
      const pmGetClient = recordsAny.deps.pm.getClient as unknown as ReturnType<typeof vi.fn>
      pmGetClient.mockImplementation(() => ({
        getEntries: vi.fn(async () => ({ data: { entries: mainEntries, leafId: null } })),
        prompt: vi.fn(async () => undefined),
      }))
      const fire = registerSession(records)
      fire('main-1') // 激活派生缓存（未注册 session 的失效是 no-op）
      records.invalidateRecordEntries('main-1', 'subagent-record')
      await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)

      const subagentFrames = publish.mock.calls.filter(
        (call) => (call[1] as { type?: string }).type === 'session.subagents',
      )
      expect(subagentFrames.length).toBeGreaterThan(0)
      const payload = (subagentFrames[0]?.[1] as { payload: { subagents: SubagentRecord[] } }).payload
      const record = payload.subagents.find((s) => s.subagentId === 'sa-1')
      expect(record?.modelOverride).toEqual({ model: 'p-live/m-live' })
      expect(record?.recentEffectiveModel).toEqual({ provider: 'p-live', modelId: 'm-live' })
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── run 详情侧逐成员携带（projectSubagentModelDetailIntoRuns 直测）──

describe('projectSubagentModelDetailIntoRuns — run 详情逐成员携带', () => {
  const runBase = {
    runId: 'wf-1',
    scriptName: 'flow',
    status: 'running' as const,
    startedAt: '2026-10-06T00:00:00Z',
    stateFilePath: '',
  }

  const memberA: SubagentRecord = {
    subagentId: 'sa-a',
    sessionFile: null,
    agent: 'worker-a',
    slug: 'a',
    task: 't',
    status: 'running',
    origin: 'workflow',
    parentRunId: 'wf-1',
    stepIndex: 0,
    model: 'p/old',
    engine: DEFAULT_SUBAGENT_ENGINE,
    recentEffectiveModel: { provider: 'p', modelId: 'effective-a' },
  }
  const memberB: SubagentRecord = {
    subagentId: 'sa-b',
    sessionFile: null,
    agent: 'worker-b',
    slug: 'b',
    task: 't',
    status: 'running',
    origin: 'workflow',
    parentRunId: 'wf-1',
    stepIndex: 1,
    model: 'p/old',
    engine: 'zcode',
    // 非 pi 成员：无生效值派生（成员增强产物本就不携带）
  }

  it('run 级覆盖分发全部成员 + 成员生效值逐成员透传（聚合面不取单一值）', () => {
    const runs = [
      {
        ...runBase,
        agentCalls: [
          { id: 0, agent: 'worker-a', status: 'running' as const, model: 'p/old' },
          { id: 1, agent: 'worker-b', status: 'running' as const, model: 'p/old' },
        ],
      },
    ]
    const query = {
      getRecordOverride: vi.fn(() => undefined),
      getRunOverride: vi.fn(() => ({ model: 'p/new', thinkingLevel: 'high' }) satisfies SubagentModelOverrideStatus),
    }
    const result = projectSubagentModelDetailIntoRuns(runs, [memberA, memberB], query)

    expect(query.getRunOverride).toHaveBeenCalledWith('wf-1')
    const calls = result[0]?.agentCalls
    expect(calls).toHaveLength(2)
    // run 级覆盖：全成员携带同值（run 作用域意图）
    expect(calls?.[0]?.modelOverride).toEqual({ model: 'p/new', thinkingLevel: 'high' })
    expect(calls?.[1]?.modelOverride).toEqual({ model: 'p/new', thinkingLevel: 'high' })
    // 最近生效值：逐成员独立（同族替换可只发生在部分成员）
    expect(calls?.[0]?.recentEffectiveModel).toEqual({ provider: 'p', modelId: 'effective-a' })
    expect(calls?.[1]?.recentEffectiveModel).toBeUndefined()
  })

  it('无覆盖无成员增强：原引用返回（零拷贝快路径）', () => {
    const runs = [{ ...runBase, agentCalls: [{ id: 0, agent: 'w', status: 'running' as const }] }]
    const plainMember: SubagentRecord = { ...memberA, recentEffectiveModel: undefined }
    const result = projectSubagentModelDetailIntoRuns(runs, [plainMember], undefined)
    expect(result).toBe(runs)
  })

  it('成员圈定按 (parentRunId, stepIndex)：其他 run 的成员不串扰', () => {
    const runs = [{ ...runBase, agentCalls: [{ id: 0, agent: 'w', status: 'running' as const }] }]
    const otherRunMember: SubagentRecord = { ...memberA, parentRunId: 'wf-other' }
    const result = projectSubagentModelDetailIntoRuns(runs, [otherRunMember], undefined)
    expect(result[0]?.agentCalls[0]?.recentEffectiveModel).toBeUndefined()
  })
})
