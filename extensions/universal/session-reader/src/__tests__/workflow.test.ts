import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { parseRunSnapshot, renderWorkflowOverview } from '../core/workflow.js'
import { extractCallSessionFiles, readRunSnapshot } from '../discovery/workflows.js'
import { REAL_AGENT_DIR } from './real-data.js'

// ============================================================
// fixture（结构对齐真实 wf-state 探针数据）
// ============================================================

/**
 * NEW 格式 fixture（对齐 ~/.pi/agent/workflow-state/wf-1785762350110-d297tr.jsonl）。
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
// 真实数据守卫（~/.pi/agent/workflow-state，CI 无本机数据时 skipIf 跳过）
// ============================================================

const REAL_WF_NEW = join(REAL_AGENT_DIR, 'workflow-state', 'wf-1785762350110-d297tr.jsonl')
const REAL_WF_OLD = join(REAL_AGENT_DIR, 'workflow-state', 'wf-skip-ok.jsonl')
const HAS_REAL_WF_NEW = existsSync(REAL_WF_NEW)
const HAS_REAL_WF_OLD = existsSync(REAL_WF_OLD)

describe.skipIf(!HAS_REAL_WF_NEW)('真实数据守卫 - NEW wf-state（wf-1785762350110-d297tr）', () => {
  it('TC-w5-real-new-guard：readRunSnapshot+parseRunSnapshot 类型化 NEW 真实快照', async () => {
    const snap = await readRunSnapshot(REAL_WF_NEW)
    expect(snap).not.toBeUndefined()
    const overview = parseRunSnapshot(snap, 'wf-1785762350110-d297tr', REAL_WF_NEW)
    expect(overview).not.toBeNull()
    expect(overview!.version).toBe('wf-run-v1')
    expect(overview!.steps.length).toBeGreaterThanOrEqual(1)
    // call 的 sessionFile 是真实绝对 .jsonl 路径（跳转入口）
    expect(overview!.steps[0].sessionFile).toMatch(/\.jsonl$/)
    expect(overview!.steps[0].sessionFile!.startsWith('/')).toBe(true)
    expect(overview!.steps[0].sessionId).toBeTruthy()
  }, 30000)
})

describe.skipIf(!HAS_REAL_WF_OLD)('真实数据守卫 - OLD wf-state（wf-skip-ok）', () => {
  it('TC-w5-real-old-guard：readRunSnapshot+parseRunSnapshot 尽力解析 OLD 真实快照', async () => {
    const snap = await readRunSnapshot(REAL_WF_OLD)
    expect(snap).not.toBeUndefined()
    const overview = parseRunSnapshot(snap, 'wf-skip-ok', REAL_WF_OLD)
    expect(overview).not.toBeNull()
    expect(overview!.version).toBe('legacy')
    expect(overview!.status).toBe('running')
    expect(overview!.script).toBe('workflow-wf-skip-ok') // name 映射
    // OLD callCache value 无 sessionFile（探针 112 文件 0 sessionFile）
    expect(overview!.steps[0].sessionFile).toBeUndefined()
  }, 30000)
})
