/**
 * notify-summary 单测 — managed-session-notify 提取分支（notify-once D9 接入点②）。
 *
 * 背景：extractNotifyRecords 此前仅认 workflow-result 与 subagent-bg-notify 两形态，
 * 未知 customType 走 null 降级 → unparsed:1 → 通知送达但 Turn 渲染层静默吞掉。
 * 本分支口径：key = details.notifyId（去重键）、outcome = reason/status 映射
 * completed→success / failed→failed / 其余→neutral。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/notify-summary.test.ts
 */
import { describe, it, expect } from 'vitest'

import type { Message } from '@taiji/shared'

import { deriveNotifySummary } from '../notify-summary'

function managedMsg(details: unknown, id = 'm1'): Message {
  return {
    id,
    role: 'system',
    content: 'Managed session "L" (s1) finished with status "completed".',
    status: 'complete',
    timestamp: 0,
    customType: 'managed-session-notify',
    ...(details !== undefined ? { details } : {}),
  } as Message
}

describe('deriveNotifySummary · managed-session-notify 分支', () => {
  it('completed → success（count 1 / outcomes 单点）', () => {
    const summary = deriveNotifySummary([
      managedMsg({ notifyId: 'sm-1', reason: 'completed', sessionId: 's1', fulfills: 2, label: 'L' }),
    ])
    expect(summary).toMatchObject({ count: 1, failedCount: 0, neutralCount: 0, outcomes: ['success'] })
  })

  it('failed → failed', () => {
    const summary = deriveNotifySummary([managedMsg({ notifyId: 'sm-2', reason: 'failed' })])
    expect(summary).toMatchObject({ count: 1, failedCount: 1, neutralCount: 0, outcomes: ['failed'] })
  })

  it('stopped（及其他 reason，如 exited/deleted/cancelled）→ neutral（不冒充成功）', () => {
    const summary = deriveNotifySummary([
      managedMsg({ notifyId: 'sm-3', reason: 'stopped' }),
      managedMsg({ notifyId: 'sm-4', reason: 'exited' }, 'm4'),
      managedMsg({ notifyId: 'sm-5', reason: 'deleted' }, 'm5'),
      managedMsg({ notifyId: 'sm-6', reason: 'cancelled' }, 'm6'),
    ])
    expect(summary).toMatchObject({
      count: 4,
      failedCount: 0,
      neutralCount: 4,
      outcomes: ['neutral', 'neutral', 'neutral', 'neutral'],
    })
  })

  it('reason 缺席时回退 status 字段（D9「reason/status 映射」双源口径）', () => {
    const summary = deriveNotifySummary([managedMsg({ notifyId: 'sm-7', status: 'completed' })])
    expect(summary).toMatchObject({ count: 1, outcomes: ['success'] })
  })

  it('details.notifyId 缺失 / 空串 / reason 与 status 双缺席 → unparsed 降级（neutralCount+1，零 record）', () => {
    const summary = deriveNotifySummary([
      managedMsg({ reason: 'completed' }, 'm-a'), // 无 notifyId
      managedMsg({ notifyId: '', reason: 'completed' }, 'm-b'), // 空串
      managedMsg({ notifyId: 'sm-8' }, 'm-c'), // 无 reason/status
      managedMsg(null, 'm-d'), // details 非对象
    ])
    expect(summary).toMatchObject({ count: 0, failedCount: 0, neutralCount: 4, outcomes: [] })
  })

  it('同 notifyId 多条（重放/重复投递）→ 按 details.notifyId 去重计 1', () => {
    const summary = deriveNotifySummary([
      managedMsg({ notifyId: 'sm-9', reason: 'completed' }, 'm-x'),
      managedMsg({ notifyId: 'sm-9', reason: 'completed' }, 'm-y'),
    ])
    expect(summary).toMatchObject({ count: 1, outcomes: ['success'] })
  })

  it('与其他完成通知形态混合聚合（workflow-result + managed-session-notify 共存）', () => {
    const summary = deriveNotifySummary([
      {
        id: 'w1',
        role: 'system',
        content: 'workflow done',
        status: 'complete',
        timestamp: 0,
        customType: 'workflow-result',
        details: { runId: 'run-1', reason: 'completed' },
      } as Message,
      managedMsg({ notifyId: 'sm-10', reason: 'failed' }, 'm-z'),
    ])
    expect(summary).toMatchObject({ count: 2, failedCount: 1, outcomes: ['success', 'failed'] })
  })
})

// ── deriveFoldedNoticeRows · 收纳明细行
// settle 后 TurnMeta 展开区逐条明细行的数据派生：三通道 + 托管会话的载荷 → 行视图单点。

import { deriveFoldedNoticeRows } from '../notify-summary'

function systemMsg(over: Partial<Message> & { id: string }): Message {
  return {
    role: 'system',
    content: '',
    status: 'complete',
    timestamp: 0,
    ...over,
  } as Message
}

describe('deriveFoldedNoticeRows · 收纳明细行', () => {
  it('bash：command 摘要 / exit 0 成功 / taskId / durationMs', () => {
    const rows = deriveFoldedNoticeRows([
      systemMsg({
        id: 'b1',
        details: { taskId: 'task-1', command: 'pnpm test', durationMs: 45000, endReason: 'natural', exitCode: 0 },
      }),
    ])
    expect(rows).toEqual([
      expect.objectContaining({
        type: 'bash',
        summary: 'pnpm test',
        fullText: 'pnpm test',
        outcome: 'success',
        exitCode: 0,
        endReason: 'natural',
        durationMs: 45000,
        id: 'task-1',
      }),
    ])
  })

  it('bash 失败：exitCode 2 → failed；timeout → neutral（不冒充成败）', () => {
    const rows = deriveFoldedNoticeRows([
      systemMsg({
        id: 'b1',
        details: { taskId: 't1', command: 'lint', durationMs: 1000, endReason: 'natural', exitCode: 2 },
      }),
      systemMsg({
        id: 'b2',
        details: { taskId: 't2', command: 'build', durationMs: 2000, endReason: 'timeout', exitCode: null },
      }),
    ])
    expect(rows[0]).toMatchObject({ outcome: 'failed', exitCode: 2 })
    expect(rows[1]).toMatchObject({ outcome: 'neutral', endReason: 'timeout', exitCode: null })
  })

  it('subagent：agent 摘要 / result 全文 / done → success / 时长由起止派生', () => {
    const rows = deriveFoldedNoticeRows([
      systemMsg({
        id: 'n1',
        customType: 'subagent-bg-notify',
        display: false,
        details: {
          id: 'sa-1',
          status: 'done',
          agent: 'reviewer',
          result: '复查通过，两处建议',
          startedAt: 1000,
          endedAt: 5000,
        },
      }),
    ])
    expect(rows).toEqual([
      expect.objectContaining({
        type: 'subagent',
        summary: 'reviewer',
        fullText: '复查通过，两处建议',
        outcome: 'success',
        durationMs: 4000,
        id: 'sa-1',
      }),
    ])
  })

  it('subagent batch：按成员展开；error 优先作全文（失败态）', () => {
    const rows = deriveFoldedNoticeRows([
      systemMsg({
        id: 'n1',
        customType: 'subagent-bg-notify',
        display: false,
        details: {
          batch: true,
          items: [
            { id: 'sa-1', status: 'done', agent: 'a1', startedAt: 0, endedAt: 10 },
            { id: 'sa-2', status: 'failed', agent: 'a2', error: 'boom', startedAt: 0 },
          ],
        },
      }),
    ])
    expect(rows.map((r) => r.id)).toEqual(['sa-1', 'sa-2'])
    expect(rows[1]).toMatchObject({ outcome: 'failed', fullText: 'boom' })
    expect(rows[1].durationMs).toBeUndefined()
  })

  it('workflow：name 摘要（旧载荷缺失回退空串，不回退 runId）/ completed → success', () => {
    const rows = deriveFoldedNoticeRows([
      systemMsg({
        id: 'w1',
        customType: 'workflow-result',
        display: false,
        details: { runId: 'run-9', name: 'ui-wave3', status: 'done', reason: 'completed' },
      }),
      systemMsg({
        id: 'w2',
        customType: 'workflow-result',
        display: false,
        details: { runId: 'run-10', status: 'done', reason: 'completed' },
      }),
    ])
    expect(rows[0]).toMatchObject({ type: 'workflow', summary: 'ui-wave3', outcome: 'success', id: 'run-9' })
    expect(rows[0].durationMs).toBeUndefined()
    expect(rows[1]).toMatchObject({ type: 'workflow', summary: '', fullText: 'run-10', id: 'run-10' })
  })

  it('managed-session-notify：notifyId 摘要 / completed → success', () => {
    const rows = deriveFoldedNoticeRows([
      systemMsg({
        id: 'm1',
        customType: 'managed-session-notify',
        display: false,
        details: { notifyId: 'ms-1', reason: 'completed' },
      }),
    ])
    expect(rows).toEqual([
      expect.objectContaining({ type: 'managed', summary: 'ms-1', outcome: 'success', id: 'ms-1' }),
    ])
  })

  it('混合：保持到达序；bash 解析失败（无 details）跳过不产行', () => {
    const rows = deriveFoldedNoticeRows([
      systemMsg({ id: 'b1' }), // 无 details → parseBackgroundBashDetails null → 跳过
      systemMsg({
        id: 'n1',
        customType: 'subagent-bg-notify',
        display: false,
        details: { id: 'sa-1', status: 'done', agent: 'a1', startedAt: 0, endedAt: 1 },
      }),
      systemMsg({
        id: 'b2',
        details: { taskId: 't2', command: 'cmd', durationMs: 5, endReason: 'natural', exitCode: 0 },
      }),
    ])
    expect(rows.map((r) => r.id)).toEqual(['sa-1', 't2'])
  })
})
