import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  WORKFLOW_RECORD_CUSTOM_TYPE,
  WORKFLOW_RECORD_ENTRY_VERSION,
  WORKFLOW_STATE_LINK_CUSTOM_TYPE,
} from '@zhushanwen/subagent-core'

import { parseRunSnapshot, renderWorkflowOverview } from '../core/workflow.js'
import {
  extractCallSessionFiles,
  extractRecordStreamSessionFiles,
  readRunSnapshot,
  resolveWorkflows,
  RUN_RECORD_STREAM_SUFFIX,
} from '../discovery/workflows.js'

// ============================================================
// fixture（结构对齐真实 wf-state 探针数据）
// ============================================================

/**
 * NEW 格式 fixture（快照字段形态 = pi-subagent-workflow 写侧落盘契约）。
 * runId 故意写成 'wf-ignore' 验证 parseRunSnapshot 用参数透传不读 snapshot.runId。
 */
const NEW_SNAPSHOT_FIXTURE = {
  v: 'wf-run-v1',
  runId: 'wf-ignore',
  spec: { scriptName: 'thinkinglevel-probe', name: 'Probe Name', scriptSource: '// ...' },
  state: {
    status: 'done',
    reason: 'completed',
    budget: { usedTokens: 11060.24, usedCost: 0, totalCallCount: 1, maxTokens: 100000 },
    calls: [
      {
        id: 0,
        opts: {
          prompt: 'Reply with exactly: PROBE-OK',
          model: 'deepseek-router/ds-pro',
          description: 'step-0',
        },
        status: 'done',
        attempts: 1,
        result: {
          content: 'PROBE-OK',
          durationMs: 1234,
          sessionId: '019xxx',
          sessionFile: '/abs/session.jsonl',
          usage: { input: 10546 },
        },
      },
    ],
  },
  meta: { startedAt: '2026-08-03T13:05:50.111Z', completedAt: '2026-08-03T13:05:55.384Z' },
}

/**
 * v2 格式 fixture（pi-subagent-workflow 8.x 一次性生命周期写入的 wf-run-v2 快照）。
 * 读取面形状与 v1 一致（state.calls[].sessionFile/result 保留），差异仅版本字面量与
 * status 两态（running/done）、meta 无 pausedAt——v2 不该因版本字面量被挡在读之外。
 */
const V2_SNAPSHOT_FIXTURE = {
  v: 'wf-run-v2',
  runId: 'wf-ignore',
  spec: { scriptName: 'one-shot-flow', name: 'Flow Name', scriptSource: '// ...' },
  state: {
    status: 'done',
    reason: 'completed',
    budget: { usedTokens: 22000, usedCost: 0, totalCallCount: 2, maxTokens: 200000 },
    calls: [
      {
        id: 0,
        opts: { prompt: 'task 0', model: 'default', description: 'v2-step-0' },
        status: 'done',
        attempts: 1,
        sessionId: '019v2a',
        sessionFile: '/abs/v2-call0.jsonl',
        traceNode: { stepIndex: 0, agent: 'dev-W1', task: 'task 0', model: 'default', status: 'completed', phase: 'P0' },
      },
      {
        id: 1,
        opts: { prompt: 'task 1', model: 'default' },
        status: 'done',
        attempts: 1,
        result: { content: 'OK', durationMs: 567, sessionId: '019v2b', sessionFile: '/abs/v2-call1.jsonl' },
        traceNode: { stepIndex: 1, agent: 'dev-W2', task: 'task 1', model: 'default', status: 'completed', phase: 'P1' },
      },
    ],
  },
  meta: { startedAt: '2026-08-10T10:00:00.000Z', completedAt: '2026-08-10T10:05:00.000Z' },
}

/** OLD 格式 fixture（对齐 wf-skip-ok.jsonl：无 v，callCache value 无 sessionFile/result）。 */
const OLD_SNAPSHOT_FIXTURE = {
  runId: 'wf-old-ignore',
  name: 'workflow-wf-skip-ok',
  status: 'running',
  callCache: [{ key: 7, value: { content: '', usage: { input: 0 } } }],
  trace: [],
  worker: 'agent-test',
  startedAt: '2026-01-01T00:00:00Z',
  budget: { usedTokens: 0, usedCost: 0 },
}

// ============================================================
// parseRunSnapshot（纯逻辑，TC-w5-parse-new/old/corrupt/malformed）
// ============================================================

describe('parseRunSnapshot', () => {
  it('TC-w5-parse-new：NEW 格式 (v=wf-run-v1) 字段映射，runId/stateFile 参数透传', () => {
    const overview = parseRunSnapshot(NEW_SNAPSHOT_FIXTURE, 'wf-link-runid', '/abs/wf.jsonl')
    expect(overview).not.toBeNull()
    // 参数透传（不读 snapshot.runId）
    expect(overview!.runId).toBe('wf-link-runid')
    expect(overview!.stateFile).toBe('/abs/wf.jsonl')
    // 顶层字段
    expect(overview!.version).toBe('wf-run-v1')
    expect(overview!.status).toBe('done')
    expect(overview!.reason).toBe('completed')
    expect(overview!.script).toBe('thinkinglevel-probe') // spec.scriptName 优先于 name
    expect(overview!.startedAt).toBe('2026-08-03T13:05:50.111Z')
    expect(overview!.completedAt).toBe('2026-08-03T13:05:55.384Z')
    // budget 透传
    expect(overview!.budget.usedTokens).toBe(11060.24)
    expect(overview!.budget.usedCost).toBe(0)
    expect(overview!.budget.totalCallCount).toBe(1)
    expect(overview!.budget.maxTokens).toBe(100000)
    // steps
    expect(overview!.steps).toHaveLength(1)
    const step = overview!.steps[0]
    expect(step.index).toBe(0)
    expect(step.status).toBe('done')
    expect(step.description).toBe('step-0')
    expect(step.model).toBe('deepseek-router/ds-pro')
    expect(step.attempts).toBe(1)
    expect(step.durationMs).toBe(1234)
    expect(step.sessionId).toBe('019xxx')
    expect(step.sessionFile).toBe('/abs/session.jsonl')
  })

  it('TC-w5-parse-new-v2：v2 快照（pi-subagent-workflow 8.x 写入）解析非 null，calls sessionFile 读出', () => {
    const overview = parseRunSnapshot(V2_SNAPSHOT_FIXTURE, 'wf-v2-link-runid', '/abs/wf-v2.jsonl')
    expect(overview).not.toBeNull()
    expect(overview!.version).toBe('wf-run-v2')
    expect(overview!.status).toBe('done')
    expect(overview!.reason).toBe('completed')
    expect(overview!.script).toBe('one-shot-flow')
    // steps：两个 call 的 sessionFile 均读出（顶层优先 / result.sessionFile 回退）
    expect(overview!.steps).toHaveLength(2)
    expect(overview!.steps[0].sessionFile).toBe('/abs/v2-call0.jsonl')
    expect(overview!.steps[0].sessionId).toBe('019v2a')
    expect(overview!.steps[0].description).toBe('v2-step-0')
    expect(overview!.steps[1].sessionFile).toBe('/abs/v2-call1.jsonl')
    expect(overview!.steps[1].sessionId).toBe('019v2b')
  })

  it('TC-w5-parse-new-status-unknown：NEW call.status 非 done/running/pending（如 failed）→ step.status=pending', () => {
    // call.status 出现三态外的值（如上游异常态）时收窄为 pending，其余字段照常提取
    const fixture = {
      ...NEW_SNAPSHOT_FIXTURE,
      state: {
        ...NEW_SNAPSHOT_FIXTURE.state,
        calls: [
          {
            id: 3,
            opts: { description: 'step-3' },
            status: 'failed',
            result: { content: 'partial', durationMs: 9 },
          },
        ],
      },
    }
    const overview = parseRunSnapshot(fixture, 'wf-status-runid', '/abs/wf.jsonl')
    expect(overview).not.toBeNull()
    expect(overview!.steps).toHaveLength(1)
    const step = overview!.steps[0]
    expect(step.index).toBe(3)
    expect(step.status).toBe('pending')
    expect(step.description).toBe('step-3')
    expect(step.durationMs).toBe(9)
  })

  it('TC-w5-parse-old：OLD 格式 (无 v) 尽力解析为 legacy overview，step status 推测', () => {
    const overview = parseRunSnapshot(OLD_SNAPSHOT_FIXTURE, 'wf-old-link', '/abs/wf-old.jsonl')
    expect(overview).not.toBeNull()
    expect(overview!.version).toBe('legacy')
    expect(overview!.status).toBe('running') // 顶层 status
    expect(overview!.script).toBe('workflow-wf-skip-ok') // name 映射
    expect(overview!.startedAt).toBe('2026-01-01T00:00:00Z')
    expect(overview!.budget.usedTokens).toBe(0)
    expect(overview!.budget.usedCost).toBe(0)
    // steps
    expect(overview!.steps).toHaveLength(1)
    const step = overview!.steps[0]
    expect(step.index).toBe(0) // callCache 顺序索引
    expect(step.status).toBe('pending') // content='' 空串不算完成标志 → pending
    expect(step.sessionFile).toBeUndefined() // OLD 未持久化
  })

  it('TC-w5-parse-corrupt-nonobject：非对象输入（null/undefined/string/number/array）返回 null', () => {
    for (const bad of [null, undefined, 'string', 42, [1, 2, 3]] as unknown[]) {
      expect(parseRunSnapshot(bad, 'r', 's')).toBeNull()
    }
  })

  it('TC-w5-parse-malformed：既非 NEW 也非 OLD（缺关键字段）返回 null', () => {
    // (a) 有 v 但 v 非 v1/v2 且无 callCache（未来版本 wf-run-v3 及之后——届时须评估
    // 新版本读取面形状再扩判定，v2 因形状兼容被接受）
    expect(parseRunSnapshot({ v: 'wf-run-v3', state: { calls: [] } }, 'r', 's')).toBeNull()
    // (b) 无 v 无 callCache 无 status（异构对象）
    expect(parseRunSnapshot({ foo: 'bar', baz: 1 }, 'r', 's')).toBeNull()
  })
})

// ============================================================
// extractCallSessionFiles（纯逻辑，family/workflows 腿的 sessionFile 提取入口）
// ============================================================

describe('extractCallSessionFiles', () => {
  it('v2 快照（wf-run-v2）state.calls 的 sessionFile 能被读出，不因版本字面量挡读', () => {
    const files = extractCallSessionFiles(V2_SNAPSHOT_FIXTURE)
    // 顶层 sessionFile + result.sessionFile 回退，两个 call 都读出
    expect(files).toEqual(['/abs/v2-call0.jsonl', '/abs/v2-call1.jsonl'])
  })

  it('v1 快照（wf-run-v1）行为不变：state.calls 提取', () => {
    const files = extractCallSessionFiles(NEW_SNAPSHOT_FIXTURE)
    expect(files).toEqual(['/abs/session.jsonl'])
  })

  it('OLD 快照（无 v，callCache）从 value 顶层与 value.result 提取 sessionFile', () => {
    const files = extractCallSessionFiles({
      callCache: [
        { key: 0, value: { sessionFile: '/abs/old-call0.jsonl' } },
        { key: 1, value: { result: { sessionFile: '/abs/old-call1.jsonl' } } },
      ],
    })
    expect(files).toEqual(['/abs/old-call0.jsonl', '/abs/old-call1.jsonl'])
  })

  it('OLD 快照 value 无 sessionFile / value 非对象 → 跳过该 call，不产出路径', () => {
    // 对齐 OLD_SNAPSHOT_FIXTURE 形状（旧 pi 不持久化 sessionFile）+ value 非对象脏数据回退 call 本身
    const files = extractCallSessionFiles({
      callCache: [
        { key: 7, value: { content: '', usage: { input: 0 } } },
        { key: 8, value: 42 },
        { key: 9, sessionFile: '/abs/bare-call.jsonl' },
      ],
    })
    expect(files).toEqual(['/abs/bare-call.jsonl'])
  })

  it('快照非对象 / calls 容器缺失 / call 元素非对象 → 空数组', () => {
    expect(extractCallSessionFiles(null)).toEqual([])
    expect(extractCallSessionFiles('wf-run-v1')).toEqual([])
    expect(extractCallSessionFiles({ v: 'wf-run-v1', state: null })).toEqual([])
    expect(extractCallSessionFiles({ v: 'wf-run-v1', state: {} })).toEqual([])
    expect(extractCallSessionFiles({ callCache: 'not-an-array' })).toEqual([])
    expect(extractCallSessionFiles({ callCache: [null, 7, 'x'] })).toEqual([])
  })
})

// ============================================================
// renderWorkflowOverview（纯逻辑，TC-w5-render-new/old）
// ============================================================

describe('renderWorkflowOverview', () => {
  it('TC-w5-render-new：NEW 概览含 run 头/budget/steps，step 含 call sessionId 截断 + sessionFile 绝对路径', () => {
    const overview = {
      runId: 'wf-run-1',
      stateFile: '/abs/state.jsonl',
      status: 'done',
      version: 'wf-run-v1' as const,
      script: 'probe',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:01:00Z',
      budget: { usedTokens: 11060, usedCost: 0, totalCallCount: 2, maxTokens: 100000 },
      steps: [
        {
          index: 0,
          status: 'done' as const,
          model: 'm1',
          durationMs: 100,
          sessionId: '019aaa',
          sessionFile: '/abs/a.jsonl',
        },
        {
          index: 1,
          status: 'done' as const,
          model: 'm1',
          durationMs: 200,
          sessionId: '019bbb',
          sessionFile: '/abs/b.jsonl',
        },
      ],
    }
    const out = renderWorkflowOverview(overview)
    // 头行
    expect(out).toContain('run: wf-run-1')
    expect(out).toContain('[done]')
    // budget 行
    expect(out).toContain('budget:')
    expect(out).toContain('used=11060tok')
    expect(out).toContain('calls=2')
    expect(out).toContain('max=100000tok')
    // 每个 step 行
    expect(out).toContain('#0')
    expect(out).toContain('#1')
    expect(out).toContain('model=m1')
    expect(out).toContain('100ms')
    expect(out).toContain('call=019aaa') // sessionId 截断（6 字符 <= 12）
    expect(out).toContain('/abs/a.jsonl') // sessionFile 绝对路径（跳转入口）
    expect(out).toContain('/abs/b.jsonl')
  })

  it('TC-w5-render-old：OLD 概览 step sessionFile 缺标「（无 sessionFile，OLD 格式未持久化）」', () => {
    const overview = {
      runId: 'wf-old-1',
      stateFile: '/abs/old.jsonl',
      status: 'running',
      version: 'legacy' as const,
      budget: { usedTokens: 0 },
      steps: [{ index: 0, status: 'pending' as const, sessionFile: undefined }],
    }
    const out = renderWorkflowOverview(overview)
    expect(out).toContain('run:')
    expect(out).toContain('[running]')
    expect(out).toContain('budget:')
    expect(out).toContain('#0')
    expect(out).toContain('[pending]')
    expect(out).toContain('（无 sessionFile，OLD 格式未持久化）')
    // 不输出 'sessionFile=undefined' 字面量
    expect(out).not.toContain('sessionFile=undefined')
  })
})

// ============================================================
// readRunSnapshot（IO，TC-w5-read-tail-fallback/no-file/all-unparseable）
// ============================================================

describe('readRunSnapshot', () => {
  let dir: string
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {})
  })

  it('TC-w5-read-tail-fallback：末行半截 JSON 回退倒数第二行完整快照', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wf-read-tail-'))
    const path = join(dir, 'wf.jsonl')
    // 第 1 行完整 NEW snapshot + 半截第 2 行（模拟 rewrite 中点）
    const fullLine = JSON.stringify(NEW_SNAPSHOT_FIXTURE)
    const halfLine = '{"v":"wf-run-v1","state":{"calls":[{'
    await writeFile(path, fullLine + '\n' + halfLine)

    const snap = await readRunSnapshot(path)
    expect(snap).not.toBeUndefined()
    const s = snap as Record<string, unknown>
    expect(s.v).toBe('wf-run-v1') // 倒数第二行完整 NEW snapshot
    expect(s.state).toBeDefined()
  })

  it('TC-w5-read-no-file：文件不存在返回 undefined（不抛错）', async () => {
    const snap = await readRunSnapshot('/nonexistent/wf-xxx.jsonl')
    expect(snap).toBeUndefined()
  })

  it('TC-w5-read-all-unparseable：全行 JSON.parse 失败返回 undefined', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wf-read-bad-'))
    const path = join(dir, 'wf.jsonl')
    await writeFile(path, '{bad json\n}{also bad')
    const snap = await readRunSnapshot(path)
    expect(snap).toBeUndefined()
  })
})

// ============================================================
// resolveWorkflows 三档发现链（W1 D10 断链修复：v2 recordPath 主源 / v1 快照层 /
// 旧指针 fallback——W17 前 / W17~W1 / W1+ 三类 run 全部有发现通道）
// ============================================================

/** v1 快照对象（RunSnapshot 形态：v/runId/state.calls——v1 workflow-record 条目的 snapshot 载荷）。 */
function v1Snapshot(runId: string, sessionFiles: string[]): Record<string, unknown> {
  return {
    v: 'wf-run-v2',
    runId,
    spec: { scriptName: 'mid-window', name: 'Mid' },
    state: {
      status: 'done',
      reason: 'completed',
      budget: { usedTokens: 10, usedCost: 0, totalCallCount: sessionFiles.length, maxTokens: 1000 },
      calls: sessionFiles.map((sf, i) => ({
        id: i,
        opts: { prompt: 'work', model: 'm', description: `step-${i}` },
        status: 'done',
        attempts: 1,
        result: { content: 'ok', durationMs: 1, sessionId: `019v1${i}`, sessionFile: sf },
      })),
    },
    meta: { startedAt: '2026-09-20T00:00:00.000Z', completedAt: '2026-09-20T00:01:00.000Z' },
  }
}

describe('resolveWorkflows 三档发现链（W1 D10）', () => {
  let dir: string
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {})
  })

  /** 写 main session 文件（首行 header + 追加行集）；返回路径与 sessionIdToPath 单条目映射。 */
  async function writeMain(lines: string[]): Promise<{
    path: string
    sessionIdToPath: Map<string, string>
  }> {
    const sessionId = 'main-session-1'
    const path = join(dir, `${sessionId}.jsonl`)
    await writeFile(path, [JSON.stringify({ type: 'session', id: sessionId, cwd: '/proj' }), ...lines].join('\n') + '\n')
    return { path, sessionIdToPath: new Map([[sessionId, path]]) }
  }

  /** 写 wf-state 快照文件（尾行最新快照）。返回绝对路径。 */
  async function writeStateFile(runId: string, snapshot: Record<string, unknown>): Promise<string> {
    const wfDir = join(dir, 'workflow-state')
    await mkdir(wfDir, { recursive: true })
    const path = join(wfDir, `${runId}.jsonl`)
    await writeFile(path, JSON.stringify(snapshot) + '\n')
    return path
  }

  /** 写 record 流文件（[D16③] v2 档数据源——目录自建）。 */
  async function writeRecordStream(runId: string, lines: string[]): Promise<string> {
    const wfDir = join(dir, 'workflow-state')
    await mkdir(wfDir, { recursive: true })
    const p = join(wfDir, `${runId}.record.jsonl`)
    await writeFile(p, lines.join('\n') + '\n')
    return p
  }

  /** workflow-record v2 注册条目行（recordPath 锚点）。 */
  function v2RegisteredLine(runId: string, recordPath: string): string {
    return JSON.stringify({
      type: 'custom',
      customType: 'workflow-record',
      id: `e-${runId}`,
      parentId: null,
      data: {
        v: 2,
        kind: 'registered',
        runId,
        workflowName: 'probe-flow',
        scriptName: 'probe-flow',
        slug: 'probe',
        startedAt: 1,
        recordPath,
      },
    })
  }

  /** workflow-record v1 快照条目行（W17~W1 中间档形态：{v:1, snapshot, updatedAt}）。 */
  function v1SnapshotLine(runId: string, sessionFiles: string[]): string {
    return JSON.stringify({
      type: 'custom',
      customType: 'workflow-record',
      id: `e-${runId}`,
      parentId: null,
      data: { v: 1, snapshot: v1Snapshot(runId, sessionFiles), updatedAt: 2 },
    })
  }

  /** workflow-record v2 终态条目行（不携带 recordPath——非发现链数据源）。 */
  function v2SettledLine(runId: string): string {
    return JSON.stringify({
      type: 'custom',
      customType: 'workflow-record',
      id: `e-settled-${runId}`,
      parentId: null,
      data: {
        v: 2,
        kind: 'settled',
        runId,
        status: 'done',
        reason: 'completed',
        outcome: 'success',
        settledAt: 3,
        callCount: 1,
        usedTokens: 10,
      },
    })
  }

  /** 旧指针条目行（W17 前形态：workflow-state-link）。 */
  function linkLine(runId: string, path: string): string {
    return JSON.stringify({
      type: 'custom',
      customType: 'workflow-state-link',
      id: `e-link-${runId}`,
      parentId: null,
      data: { runId, path, updatedAt: '2026-08-07T16:48:24.933Z' },
    })
  }

  const CALL_A = '/abs/subagents/--proj--/sessions/call-a.jsonl'
  const CALL_B = '/abs/subagents/--proj--/sessions/call-b.jsonl'

  it('v2 recordPath 主源（[D16③] 重锚）：注册条目 → record 流直读提 calls，stateFile = 流路径', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wf-v2-tier-'))
    // record 流内容：run-created + agent-started + agent-settled（result 携带 sessionFile）
    const recordPath = await writeRecordStream('wf-v2-1', [
      JSON.stringify({ type: 'run-created', seq: 1, ts: 1000, runId: 'wf-v2-1', workflowName: 'v2-flow', argsSummary: '{}' }),
      JSON.stringify({ type: 'agent-started', seq: 2, ts: 1100, taskIndex: 0, agentName: 'step-0', attempt: 1 }),
      JSON.stringify({ type: 'agent-settled', seq: 3, ts: 1500, taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 400, result: { content: 'ok', sessionFile: CALL_A } }),
    ])
    const { sessionIdToPath } = await writeMain([v2RegisteredLine('wf-v2-1', recordPath)])

    const workflows = await resolveWorkflows('main-session-1', sessionIdToPath, new Map())

    expect(workflows).toHaveLength(1)
    expect(workflows[0].runId).toBe('wf-v2-1')
    // stateFile = record 流路径（recordPath 锚点语义重定义——[D16③]）
    expect(workflows[0].stateFile).toBe(recordPath)
    expect(workflows[0].calls).toHaveLength(1)
    expect(workflows[0].calls[0].fileName).toBe(CALL_A)
  })

  it('v2 档窗外：record 流已被保留期清理 → calls=[]，runId 存在性兜底（stateFile 仍是流路径）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wf-v2-gc-'))
    const recordPath = join(dir, 'workflow-state', 'wf-gc-1.record.jsonl')
    const { sessionIdToPath } = await writeMain([v2RegisteredLine('wf-gc-1', recordPath)])

    const workflows = await resolveWorkflows('main-session-1', sessionIdToPath, new Map())

    expect(workflows).toHaveLength(1)
    expect(workflows[0].runId).toBe('wf-gc-1')
    expect(workflows[0].calls).toEqual([])
    // 窗外语义 = 锚点路径在、流文件不在（readFile undefined → calls 空）
    expect(workflows[0].stateFile).toBe(recordPath)
  })

  it('v2 档旧后缀锚点（.events.jsonl 形态 = [D1] 历史实体）与形态损坏 → stateFile 原样保留 + calls 空（不读旧两件、不伪造数据）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wf-v2-bad-'))
    // 旧后缀锚点：[D1] 历史数据处置——旧两件不读（calls 退空，run 存在性兜底）
    const legacyPath = join(dir, 'workflow-state', 'wf-legacy-1.events.jsonl')
    await mkdir(join(dir, 'workflow-state'), { recursive: true })
    await writeFile(legacyPath, JSON.stringify({ type: 'ask-settled', ts: 1 }) + '\n')
    const legacyMain = await writeMain([v2RegisteredLine('wf-legacy-1', legacyPath)])
    const legacy = await resolveWorkflows('main-session-1', legacyMain.sessionIdToPath, new Map())
    expect(legacy).toHaveLength(1)
    expect(legacy[0].runId).toBe('wf-legacy-1')
    expect(legacy[0].stateFile).toBe(legacyPath)
    expect(legacy[0].calls).toEqual([])

    // 形态损坏（无已知尾段）：同旧锚点分流
    const oddMain = await writeMain([v2RegisteredLine('wf-bad-1', '/abs/odd/path.txt')])
    const odd = await resolveWorkflows('main-session-1', oddMain.sessionIdToPath, new Map())
    expect(odd).toHaveLength(1)
    expect(odd[0].runId).toBe('wf-bad-1')
    expect(odd[0].stateFile).toBe('/abs/odd/path.txt')
    expect(odd[0].calls).toEqual([])
  })

  it('v1 快照层（W17~W1 中间档恢复）：v1 快照条目直接提 snapshot.calls，无指针条目也可见', async () => {
    // 该档现状发现链恒空（只认指针）——本用例锚定中间档恢复：升级窗口期的旧格式会话
    dir = await mkdtemp(join(tmpdir(), 'wf-v1-tier-'))
    const { sessionIdToPath } = await writeMain([v1SnapshotLine('wf-mid-1', [CALL_A, CALL_B])])

    const workflows = await resolveWorkflows('main-session-1', sessionIdToPath, new Map())

    expect(workflows).toHaveLength(1)
    expect(workflows[0].runId).toBe('wf-mid-1')
    // v1 条目不携带 state 路径 → stateFile 空串（概览消费面自然降级，家族链 calls 完整）
    expect(workflows[0].stateFile).toBe('')
    expect(workflows[0].calls.map((c) => c.fileName)).toEqual([CALL_A, CALL_B])
  })

  it('旧指针 fallback：workflow-state-link 指针条目照旧读 link 指向的快照文件', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wf-link-tier-'))
    const stateFile = await writeStateFile('wf-old-1', v1Snapshot('wf-old-1', [CALL_B]))
    const { sessionIdToPath } = await writeMain([linkLine('wf-old-1', stateFile)])

    const workflows = await resolveWorkflows('main-session-1', sessionIdToPath, new Map())

    expect(workflows).toHaveLength(1)
    expect(workflows[0].runId).toBe('wf-old-1')
    expect(workflows[0].stateFile).toBe(stateFile)
    expect(workflows[0].calls.map((c) => c.fileName)).toEqual([CALL_B])
  })

  it('三档混合会话：三个 run 各处一档 → 各自正确，按条目首见序输出（[D16③] v2 档 = record 流直读）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wf-mixed-'))
    const recordPath = await writeRecordStream('wf-v2-1', [
      JSON.stringify({ type: 'run-created', seq: 1, ts: 1000, runId: 'wf-v2-1', workflowName: 'v2-flow', argsSummary: '{}' }),
      JSON.stringify({ type: 'agent-started', seq: 2, ts: 1100, taskIndex: 0, agentName: 's0', attempt: 1 }),
      JSON.stringify({ type: 'agent-settled', seq: 3, ts: 1500, taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 400, result: { content: 'ok', sessionFile: CALL_A } }),
    ])
    const oldState = await writeStateFile('wf-old-1', v1Snapshot('wf-old-1', [CALL_B]))
    // 首见序：指针（早）→ v1 快照（中）→ v2 注册（晚）
    const { sessionIdToPath } = await writeMain([
      linkLine('wf-old-1', oldState),
      v1SnapshotLine('wf-mid-1', [CALL_A]),
      v2RegisteredLine('wf-v2-1', recordPath),
    ])

    const workflows = await resolveWorkflows('main-session-1', sessionIdToPath, new Map())

    expect(workflows.map((w) => w.runId)).toEqual(['wf-old-1', 'wf-mid-1', 'wf-v2-1'])
    expect(workflows[0].stateFile).toBe(oldState)
    expect(workflows[1].stateFile).toBe('')
    expect(workflows[2].stateFile).toBe(recordPath)
    expect(workflows[2].calls[0].fileName).toBe(CALL_A)
  })

  it('v2 终态条目（settled，无 recordPath）不参与发现链——不产 runId 幻影', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wf-settled-'))
    const { sessionIdToPath } = await writeMain([v2SettledLine('wf-settled-1')])

    const workflows = await resolveWorkflows('main-session-1', sessionIdToPath, new Map())

    expect(workflows).toEqual([])
  })

  it('同 runId 跨档坏数据防御：v2 注册条目在 → 用 v2 档（高档在即用高档；[D16③] v2 档 = record 流）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wf-tier-prio-'))
    const recordPath = await writeRecordStream('wf-both-1', [
      JSON.stringify({ type: 'run-created', seq: 1, ts: 1000, runId: 'wf-both-1', workflowName: 'both', argsSummary: '{}' }),
      JSON.stringify({ type: 'agent-started', seq: 2, ts: 1100, taskIndex: 0, agentName: 's0', attempt: 1 }),
      JSON.stringify({ type: 'agent-settled', seq: 3, ts: 1500, taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 400, result: { content: 'ok', sessionFile: CALL_A } }),
    ])
    const oldState = await writeStateFile('wf-both-1-old', v1Snapshot('wf-both-1', [CALL_B]))
    const { sessionIdToPath } = await writeMain([
      linkLine('wf-both-1', oldState),
      v2RegisteredLine('wf-both-1', recordPath),
    ])

    const workflows = await resolveWorkflows('main-session-1', sessionIdToPath, new Map())

    expect(workflows).toHaveLength(1)
    // v2 档胜出：stateFile 是 record 流路径（非 link 的 oldState），calls 来自流
    expect(workflows[0].stateFile).toBe(recordPath)
    expect(workflows[0].calls.map((c) => c.fileName)).toEqual([CALL_A])
  })

  it('跨包契约守卫：三档判别的本地字面量 === subagent-core 写侧单源（[D1] record 后缀）', () => {
    // 源码本地持有磁盘协议字符串与版本/尾段（生产依赖面不引 subagent-core），锚定两侧同值
    expect(WORKFLOW_RECORD_CUSTOM_TYPE).toBe('workflow-record')
    expect(WORKFLOW_RECORD_ENTRY_VERSION).toBe(2)
    expect(RUN_RECORD_STREAM_SUFFIX).toBe('.record.jsonl')
    // legacy 指针档：collectWorkflowEntryTiers 本地字面量与 core 常量同值
    expect(WORKFLOW_STATE_LINK_CUSTOM_TYPE).toBe('workflow-state-link')
  })
})

// ============================================================
// readRunSnapshot + parseRunSnapshot 磁盘回路（fixture）：快照形态已由
// NEW_SNAPSHOT_FIXTURE / OLD_SNAPSHOT_FIXTURE 单源锚定，此处补「wf-state 落盘 →
// 读回 → 解析」的端到端回路断言
// ============================================================

describe('readRunSnapshot + parseRunSnapshot 磁盘回路（fixture）', () => {
  let tmpDir: string | undefined

  afterEach(async () => {
    if (tmpDir !== undefined) {
      await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('TC-w5-disk-new-guard：NEW 快照落盘读回，类型化为 wf-run-v1 overview', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'wf-disk-new-'))
    const wfPath = join(tmpDir, 'wf-new.jsonl')
    await writeFile(wfPath, JSON.stringify(NEW_SNAPSHOT_FIXTURE) + '\n')

    const snap = await readRunSnapshot(wfPath)
    expect(snap).not.toBeUndefined()
    const overview = parseRunSnapshot(snap, 'wf-disk-new', wfPath)
    expect(overview).not.toBeNull()
    expect(overview!.version).toBe('wf-run-v1')
    expect(overview!.steps.length).toBeGreaterThanOrEqual(1)
    // call 的 sessionFile 是绝对 .jsonl 路径（跳转入口）
    expect(overview!.steps[0].sessionFile).toMatch(/\.jsonl$/)
    expect(overview!.steps[0].sessionFile!.startsWith('/')).toBe(true)
    expect(overview!.steps[0].sessionId).toBeTruthy()
  })

  it('TC-w5-disk-old-guard：OLD 快照落盘读回，尽力解析为 legacy overview', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'wf-disk-old-'))
    const wfPath = join(tmpDir, 'wf-old.jsonl')
    await writeFile(wfPath, JSON.stringify(OLD_SNAPSHOT_FIXTURE) + '\n')

    const snap = await readRunSnapshot(wfPath)
    expect(snap).not.toBeUndefined()
    const overview = parseRunSnapshot(snap, 'wf-skip-ok', wfPath)
    expect(overview).not.toBeNull()
    expect(overview!.version).toBe('legacy')
    expect(overview!.status).toBe('running')
    expect(overview!.script).toBe('workflow-wf-skip-ok') // name 映射
    // OLD callCache value 无 sessionFile → step 无跳转入口
    expect(overview!.steps[0].sessionFile).toBeUndefined()
  })
})
