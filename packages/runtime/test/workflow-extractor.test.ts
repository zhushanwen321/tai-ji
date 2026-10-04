import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractWorkflowsFromSessionFile } from '../src/services/session/workflow-extractor.js'
import { READ_PRECHECK_MAX_BYTES } from '@taiji/shared'

/**
 * workflow-extractor 测试（[ADR-0095] v1 读面删除后的骨架契约）。
 *
 * 提取器已不再从 entry 派生 WorkflowRunRecord（workflow 列表唯一数据源 =
 * events-projection 的 record 流 fold + v2 注册/终态条目）——本文件锚定
 * session-file-extraction 共享骨架的读失败分级与预检语义，以及「历史格式条目
 * （v1 快照 / v2 条目 / workflow-state-link 指针）恒不产出」的删除回归。
 */
describe('extractWorkflowsFromSessionFile', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'workflow-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('边界：主 session 文件不存在返回空数组', () => {
    const { records: result, oversize } = extractWorkflowsFromSessionFile(join(tempDir, 'no-such-file.jsonl'))
    expect(result).toEqual([])
    // ENOENT 走原读路径（stat 预检失败不引入新抛错/新标记）——非降级形态
    expect(oversize).toBe(false)
  })

  it('[G3] READ_PRECHECK 预检：>32MB 降级返回空列表 + oversize 标记（不读全文）', () => {
    const sessionFile = join(tempDir, 'oversize-main-session.jsonl')
    // 阈值 + 1B 超限（READ_PRECHECK_MAX_BYTES = 32MB，shared SSOT——导入引用而非写死，
    // 阈值调整时本用例跟随）
    writeFileSync(sessionFile, 'x'.repeat(READ_PRECHECK_MAX_BYTES + 1))

    const { records, oversize } = extractWorkflowsFromSessionFile(sessionFile)

    // 降级契约：不读全文 → 记录空列表 + oversize 正交标记（侧栏面板据此显示「会话过大」）
    expect(oversize).toBe(true)
    expect(records).toEqual([])
  })

  it('[G3] 预检阈值内（<32MB）正常读取：oversize=false', () => {
    const sessionFile = join(tempDir, 'normal-main-session.jsonl')
    writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'main-sess', cwd: '/proj' }) + '\n')

    const { records, oversize } = extractWorkflowsFromSessionFile(sessionFile)

    expect(oversize).toBe(false)
    expect(records).toEqual([])
  })

  // [ADR-0095] 删除回归：历史格式条目（workflow-record v1 全量快照 / v2 注册条目 /
  // workflow-state-link 指针）一律不派生 records——v1 读面删除后冷路径恒空，
  // 历史 run 从本提取器数据面退空即预期行为（列表数据源 = events-projection 投影）。
  it('历史格式条目（v1 快照 / v2 条目 / state-link 指针）恒不产出 records', () => {
    const snapshot = {
      v: 'wf-run-v2',
      runId: 'wf-hist',
      spec: { scriptName: 'hist-flow', description: 'test' },
      state: { status: 'running', budget: { usedTokens: 1, usedCost: 0, totalCallCount: 1 }, calls: [], trace: [] },
      meta: { startedAt: '2026-08-19T00:00:00Z' },
    }
    const entries = [
      { type: 'session', version: 3, id: 'main-sess', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      {
        type: 'custom',
        customType: 'workflow-record',
        data: { v: 1, snapshot, updatedAt: '2026-08-19T00:00:01Z' },
      },
      {
        type: 'custom',
        customType: 'workflow-record',
        data: { v: 2, kind: 'registered', runId: 'wf-hist', recordPath: '/abs/wf-hist.record.jsonl' },
      },
      {
        type: 'custom',
        customType: 'workflow-state-link',
        data: { runId: 'wf-hist', path: '/abs/wf-hist.jsonl', updatedAt: '2026-07-10T10:01:00Z' },
      },
    ]
    const sessionFile = join(tempDir, 'main-session.jsonl')
    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')

    const { records } = extractWorkflowsFromSessionFile(sessionFile)
    expect(records).toEqual([])
  })
})
