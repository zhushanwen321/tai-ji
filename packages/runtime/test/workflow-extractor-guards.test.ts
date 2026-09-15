/**
 * workflow-extractor 自描述 entry 守卫定向测试（CRAP 靶子：parseSelfDescribedWorkflowSnapshot）。
 *
 * 已有 workflow-extractor.test.ts 覆盖正常映射 / 版本守卫 / legacy 兜底与坏 state 文件
 * 边界；本文件专测 workflow-record entry 层的 snapshot 形态守卫（PR #185 type-safety
 * review 加的逐层 shape 守卫族）——data.snapshot 非 object / runId 非字符串 / runId 空串
 * 均视为坏 entry 跳过，畸形值不得以谎报类型直达 WorkflowRunRecord（runId 是消费方
 * （详情面板 / W18 缓存 Map）的索引键）。每条守卫用例在「裸 as 透传」的未修复形态下
 * 会红（后续 mapValidatedSnapshot 对非对象 snapshot 访问 .state 抛 TypeError）。
 *
 * 运行：cd packages/runtime && npx vitest run test/workflow-extractor-guards.test.ts
 */
import { describe, expect, it } from 'vitest'
import { scanWorkflowEntries } from '../src/services/session/workflow-extractor.js'
import { WORKFLOW_RECORD_CUSTOM_TYPE } from '@taiji/shared'

/** 最小合法快照（过 snapshot 层守卫 + deserializeRun + mapValidatedSnapshot）。 */
function validSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 'wf-run-v2',
    runId: 'run-ok',
    spec: { scriptName: 's' },
    state: { status: 'done', reason: 'completed', budget: { usedTokens: 0, usedCost: 0 }, calls: [], trace: [] },
    meta: { startedAt: new Date().toISOString() },
    ...overrides,
  }
}

/** workflow-record entry 构造（type:'custom' 是 pi JSONL 持久化层形态）。 */
function recordEntry(data: unknown): Record<string, unknown> {
  return { type: 'custom', customType: WORKFLOW_RECORD_CUSTOM_TYPE, data }
}

describe('workflow-record entry 层 snapshot 形态守卫（parseSelfDescribedWorkflowSnapshot）', () => {
  it('合法 v1 entry + wf-run-v2 快照 → 正常投影（对照组，锚定守卫不误伤正常路径）', () => {
    const records = scanWorkflowEntries([recordEntry({ v: 1, snapshot: validSnapshot() })])
    expect(records).toHaveLength(1)
    expect(records[0].runId).toBe('run-ok')
    expect(records[0].status).toBe('done')
  })

  it('data.snapshot 非对象（string / number / null / 缺失）→ 坏 entry 跳过，同批合法 entry 照常产出', () => {
    for (const bad of ['string-snapshot', 42, null, undefined]) {
      const records = scanWorkflowEntries([
        recordEntry({ v: 1, snapshot: bad }),
        recordEntry({ v: 1, snapshot: validSnapshot({ runId: 'run-b' }) }),
      ])
      expect(records.map((r) => r.runId)).toEqual(['run-b'])
    }
  })

  it('snapshot.runId 非字符串（number / object）→ 坏 entry 跳过', () => {
    const records = scanWorkflowEntries([
      recordEntry({ v: 1, snapshot: validSnapshot({ runId: 123 }) }),
      recordEntry({ v: 1, snapshot: validSnapshot({ runId: { nested: true } }) }),
      recordEntry({ v: 1, snapshot: validSnapshot({ runId: 'run-c' }) }),
    ])
    expect(records.map((r) => r.runId)).toEqual(['run-c'])
  })

  it('snapshot.runId 空串 → 坏 entry 跳过（空 id 不可作缓存 Map 索引键）', () => {
    const records = scanWorkflowEntries([
      recordEntry({ v: 1, snapshot: validSnapshot({ runId: '' }) }),
    ])
    expect(records).toEqual([])
  })

  it('entry.data 非对象（v 守卫前的形态守卫）→ 跳过不产出', () => {
    for (const bad of ['string-data', 7, null]) {
      expect(scanWorkflowEntries([recordEntry(bad)])).toEqual([])
    }
  })

  it('非 custom / 非 workflow-record 的 entry 完全忽略（混合噪声不误读）', () => {
    const records = scanWorkflowEntries([
      { type: 'message', message: { role: 'assistant' } },
      { type: 'custom', customType: 'workflow-state-link', data: { runId: 'r', path: '/x' } },
      { type: 'custom', customType: 'subagent-record', data: { v: 1 } },
      recordEntry({ v: 1, snapshot: validSnapshot() }),
    ])
    // workflow-state-link 是 legacy 通道：文件不存在 → null 跳过；自描述 entry 是唯一产出
    expect(records.map((r) => r.runId)).toEqual(['run-ok'])
  })
})
