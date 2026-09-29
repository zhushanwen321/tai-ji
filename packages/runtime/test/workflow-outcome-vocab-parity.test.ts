// workflow-outcome-vocab-parity.test.ts —— [W2 D5] outcome 词表双包值级等价断言。
//
// 覆盖（V0 验收条款 2）：
// - 三集合成员一致：core ALL_RUN_OUTCOMES ≡ runtime extractor 值级判定集合
//   （workflow-extractor WORKFLOW_RUN_OUTCOMES）≡ shared WorkflowRunOutcome 词表成员。
//   core↔shared 依赖方向不允许物理单源（private 包 × npm 发布包），值级断言是
//   可得的等价锚。
// - 漏升回归（行为面）：snapshot 携带 state.outcome='interrupted' 时经提取链
//   落到投影 record.outcome（不静默丢弃为 undefined）——正是 extractor 集合漏升
//   时「已中断」显示缺失的失效模式；四成员逐一行为验收。
//
// shared 侧锚定形态：本文件的字面量元组 `satisfies readonly WorkflowRunOutcome[]`
// 编译期钉住 shared 词表（shared 收窄即编译红）；运行期与 core 集合逐成员比对
// （shared 扩值而 core 未跟即时运行红）。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ALL_RUN_OUTCOMES } from '@zhushanwen/subagent-core'
import type { WorkflowRunOutcome } from '@taiji/shared'
import { extractWorkflowsFromSessionFile } from '../src/services/session/workflow-extractor.js'

/** shared WorkflowRunOutcome 词表成员（编译期 satisfies 锚定 shared 类型——词表收窄即此处编译红）。 */
const SHARED_WORKFLOW_RUN_OUTCOMES = [
  'done',
  'failed',
  'cancelled',
  'time_limited',
] as const satisfies readonly WorkflowRunOutcome[]

describe('outcome 词表双包值级等价（[W2 D5] core ≡ extractor ≡ shared）', () => {
  it('core ALL_RUN_OUTCOMES 与 shared 词表成员逐成员一致（[D2] 后四值——done/time_limited）', () => {
    expect([...ALL_RUN_OUTCOMES].sort()).toEqual([...SHARED_WORKFLOW_RUN_OUTCOMES].sort())
    expect(ALL_RUN_OUTCOMES).toContain('time_limited')
    // [D2] interrupted 已移出 outcome（入 status 三态）——词表不含
    expect(ALL_RUN_OUTCOMES).not.toContain('interrupted')
  })

  it('四值全表快照（词表扩缩值时本用例红——三侧同步显式重审）', () => {
    expect([...ALL_RUN_OUTCOMES].sort()).toEqual(['cancelled', 'done', 'failed', 'time_limited'])
    expect([...SHARED_WORKFLOW_RUN_OUTCOMES].sort()).toEqual([
      'cancelled',
      'done',
      'failed',
      'time_limited',
    ])
  })
})

// ── 漏升回归（行为面）：extractor 对每个词表成员的投影放行 ──────

function buildSessionWithOutcome(
  outcome: WorkflowRunOutcome,
  errorCode?: string,
): { dir: string; sessionFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wf-outcome-parity-'))
  const stateFilePath = join(dir, 'wf-parity-001.jsonl')
  const snapshot = {
    v: 'wf-run-v2',
    runId: 'wf-parity-001',
    spec: { scriptName: 'parity-flow', args: {} },
    state: {
      status: 'done',
      reason: 'completed',
      budget: { usedTokens: 1, usedCost: 0, totalCallCount: 1 },
      calls: [],
      trace: [],
      outcome,
      ...(errorCode !== undefined ? { errorCode } : {}),
    },
    meta: { startedAt: '2026-09-27T00:00:00.000Z', completedAt: '2026-09-27T00:01:00.000Z' },
  }
  writeFileSync(stateFilePath, JSON.stringify(snapshot) + '\n')
  const sessionFile = join(dir, 'main-session.jsonl')
  const sessionEntries = [
    { type: 'session', version: 3, id: 'main-sess', cwd: '/proj', timestamp: '2026-09-27T00:00:00Z' },
    {
      type: 'custom',
      customType: 'workflow-state-link',
      data: { runId: 'wf-parity-001', path: stateFilePath, updatedAt: '2026-09-27T00:00:01Z' },
      timestamp: '2026-09-27T00:00:01Z',
    },
  ]
  writeFileSync(sessionFile, sessionEntries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  return { dir, sessionFile }
}

describe('extractor 值级判定集合同步（漏升 = interrupted 被静默丢弃的回归锚）', () => {
  let dir: string

  beforeEach(() => {
    dir = ''
  })

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  for (const outcome of SHARED_WORKFLOW_RUN_OUTCOMES) {
    it(`snapshot state.outcome='${outcome}' 经提取链落到投影（不丢为 undefined）`, () => {
      const built = buildSessionWithOutcome(outcome)
      dir = built.dir
      const { records } = extractWorkflowsFromSessionFile(built.sessionFile)
      expect(records).toHaveLength(1)
      expect(records[0].outcome).toBe(outcome)
    })
  }

  it("time_limited 帧细分语境（errorCode 缺省——[D2] 升格后无码）随投影透传", () => {
    const built = buildSessionWithOutcome('time_limited')
    dir = built.dir
    const { records } = extractWorkflowsFromSessionFile(built.sessionFile)
    expect(records).toHaveLength(1)
    expect(records[0].outcome).toBe('time_limited')
    expect(records[0].errorCode).toBeUndefined()
  })
})
