/**
 * workflowUpdate 信号发射前可读性门（待裁决项 5 根治 2026-10-04）单测。
 *
 * 两段：
 * - filterReadableWorkflowSignals 直测（纯函数契约）：不可读 run 被过滤（信号不发）、
 *   可读 run 保留、判定不可得（readableRunIds=null）放行、全不可读 → 空集（水位不推进，
 *   下一轮投影变更 / 对账腿重新进入 diff = 推迟到下一轮触发，不给定时器）。
 * - 发射链路构造性锁（端到端）：真实 SessionRecords + fake 依赖，驱动
 *   subscribe → invalidate → 防抖 → get_entries 拉取 → publish，断言 bus 收到
 *   session.workflowUpdate 且 getWorkflows 同刻返回该 run（found=true）——「信号发出时
 *   数据必然可读」由本测试钉死；信号源与读源解耦的实现漂移会打红此测试。
 *
 * 背景：renderer 的 500ms running 信号盲等重试已随本项删除（时间平抑类兜底），其正确性
 * 依据 = 本构造性时序；登记见 stores/workflow.ts triggerWorkflowReload 的
 * [时间平抑红线登记] 与 session-records.ts filterReadableWorkflowSignals JSDoc。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-records-workflow-signal-gate.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionRecords, filterReadableWorkflowSignals } from '../src/services/session/session-records.js'
import { WORKFLOW_RECORD_CUSTOM_TYPE } from '@zhushanwen/subagent-core'
import type { SessionRegisteredSource } from '../src/services/session/session-state-projection.js'
import type { IMessageBus } from '../src/services/message-bus/message-bus.js'
import type { IProcessManager } from '../src/services/ports/pi-engine.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { ServerMessage } from '@taiji/shared'

// ── filterReadableWorkflowSignals 直测（发射前可读性门的纯函数契约）──

describe('filterReadableWorkflowSignals — 发射前可读性门（待裁决项 5）', () => {
  const signals = [
    { runId: 'wf-readable', status: 'running' },
    { runId: 'wf-unreadable', status: 'running' },
  ]

  /** 可读 run id 集（Map 键域形态 = 发布点实参 projection.workflows 的同构）。 */
  function readable(ids: string[]): ReadonlyMap<string, unknown> {
    return new Map(ids.map((id) => [id, true]))
  }

  it('不可读 run 被过滤（信号不发），可读 run 保留', () => {
    const filtered = filterReadableWorkflowSignals(signals, readable(['wf-readable']))
    expect(filtered).toEqual([{ runId: 'wf-readable', status: 'running' }])
  })

  it('全部不可读 → 空集（本轮不发；水位不推进 → 下一轮投影变更 / 对账腿重试 = 推迟语义）', () => {
    expect(filterReadableWorkflowSignals(signals, readable([]))).toEqual([])
  })

  it('全部可读 → 原样通过', () => {
    const all = filterReadableWorkflowSignals(signals, readable(['wf-readable', 'wf-unreadable']))
    expect(all).toEqual(signals)
  })

  it('readableRunIds=null（投影不可得，防御读法）→ 放行（判据缺失不拦截信号）', () => {
    expect(filterReadableWorkflowSignals(signals, null)).toEqual(signals)
  })

  it('空候选信号 → 空集（无可发布内容）', () => {
    expect(filterReadableWorkflowSignals([], readable(['wf-readable']))).toEqual([])
  })
})

// ── 发射链路构造性锁（端到端）：信号发出时 getWorkflows 同刻可读 ──

describe('SessionRecords workflowUpdate 发射链路 — 信号发出时数据必然可读（构造性时序锁）', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wf-signal-gate-'))
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** v2 workflow 注册条目（events-projection scanWorkflowV2Entry 的键守卫最小面 + 常用字段）。 */
  function workflowRegisteredEntry(runId: string): Record<string, unknown> {
    return {
      type: 'custom',
      customType: WORKFLOW_RECORD_CUSTOM_TYPE,
      id: `e-${runId}`,
      parentId: null,
      timestamp: '2026-10-04T10:00:00Z',
      data: {
        v: 2,
        kind: 'registered',
        runId,
        workflowName: 'gate-flow',
        scriptName: 'gate-flow',
        slug: 'gate-flow',
        startedAt: 1756000000000,
        recordPath: join(tempDir, 'workflow-state', `${runId}.record.jsonl`),
      },
    }
  }

  function makeHarness(entries: unknown[]): {
    records: SessionRecords
    published: ServerMessage[]
    register: () => void
  } {
    const published: ServerMessage[] = []
    const bus = {
      publish: vi.fn((_sessionId: string, message: ServerMessage) => {
        published.push(message)
      }),
    } as unknown as IMessageBus
    const sessionFilePath = join(tempDir, 'main.jsonl') // 冷扫描按缺文件空条目处理（pi 延迟写入窗口同形态）
    const sessionStore = {
      scanSessions: () => [
        { id: 'sid-gate', filePath: sessionFilePath, cwd: tempDir, timestamp: new Date().toISOString(), name: null, lastModified: Date.now(), size: 0, outcome: null },
      ],
      invalidateScanCache: () => {},
      refreshAll: () => {},
    } as unknown as ISessionStore
    const pm = {
      getClient: () => ({
        getEntries: vi.fn(async () => ({ data: { entries, leafId: 'e-wf-gate-1' } })),
      }),
    } as unknown as IProcessManager
    let onRegistered: ((sessionId: string) => void) | undefined
    const source = {
      onSessionRegistered: (cb: (sessionId: string) => void) => {
        onRegistered = cb
      },
    } as unknown as SessionRegisteredSource
    const records = new SessionRecords({
      pm,
      sessionStore,
      hasSession: () => true,
      getMessageBus: () => bus,
    })
    records.subscribe(source)
    return { records, published, register: () => onRegistered?.('sid-gate') }
  }

  it('invalidate → 防抖拉取 → bus 收到 workflowUpdate，且同刻 getWorkflows 返回该 run（found=true）', async () => {
    const harness = makeHarness([workflowRegisteredEntry('wf-gate-1')])
    harness.register()

    // entry_appended 失效信号（防抖 SCALAR_STATE_DEBOUNCE_MS=300 后拉取）
    harness.records.invalidateRecordEntries('sid-gate', WORKFLOW_RECORD_CUSTOM_TYPE)
    await vi.advanceTimersByTimeAsync(300)
    await vi.waitFor(() => {
      expect(harness.published.some((m) => m.type === 'session.workflowUpdate')).toBe(true)
    })

    // 信号载荷 = 投影内可读 run；同刻读路径立即返回同一 run（构造性：信号源 = 读源投影）
    const updateFrame = harness.published.find((m) => m.type === 'session.workflowUpdate')
    const update = (updateFrame!.payload as { update: { runId: string; status: string } }).update
    expect(update.runId).toBe('wf-gate-1')

    const workflows = await harness.records.getWorkflows('sid-gate')
    expect(workflows.found).toBe(true)
    expect(workflows.records.map((r) => r.runId)).toContain('wf-gate-1')
  })
})
