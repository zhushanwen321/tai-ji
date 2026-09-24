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
