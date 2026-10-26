/**
 * 队列编辑锚定纯逻辑单测（chat-flow-consistency D6 + design-queue-delivery Q4 补章块 B；
 * core queue-edit-anchor 双壳同源判定——桌面 composer-shell / 移动壳 app-runtime 共用）。
 *
 * 覆盖三裁决与活性派生：
 * - 单锚定不变式：无锚登记 started / 同行再点幂等 no-op（already-editing-same）/
 *   编辑他行拦截（conflict）
 * - 解除单点：clearQueueEdit 归 null（放弃编辑 / 发送完成 / 条目离场共用）
 * - 活性派生（Q3 帧驱动离场信号）：锚定条目在派生队列行中 = alive；离场（delivered 被
 *   谓词滤除 / cancelled 不进帧 / 行消失）= 不 alive → 壳层静默解除
 *
 * 运行：cd packages/renderer && pnpm test -- queue-edit-anchor
 */
import { describe, it, expect } from 'vitest'
import {
  clearQueueEdit,
  isQueueEditAlive,
  startQueueEdit,
  type QueueEditAnchorPartition,
} from '@taiji/core/domain/composer'

function partition(clientUuid: string | null = null): QueueEditAnchorPartition {
  return { clientUuid }
}

describe('startQueueEdit · 单锚定不变式（Q4 三裁决）', () => {
  it('无锚定 → started 且锚定登记', () => {
    const p = partition()
    expect(startQueueEdit(p, 'u-1')).toBe('started')
    expect(p.clientUuid).toBe('u-1')
  })

  it('同一行再点 ✎ → already-editing-same（幂等 no-op：不重新 peek 不覆盖草稿）', () => {
    const p = partition('u-1')
    expect(startQueueEdit(p, 'u-1')).toBe('already-editing-same')
    expect(p.clientUuid).toBe('u-1')
  })

  it('编辑 A 中点 B 行 → conflict（锚定不切换，拦截由壳层提示）', () => {
    const p = partition('u-1')
    expect(startQueueEdit(p, 'u-2')).toBe('conflict')
    expect(p.clientUuid).toBe('u-1') // 原锚定不被覆盖
  })
})

describe('clearQueueEdit · 解除单点', () => {
  it('解除后归 null；重复解除幂等', () => {
    const p = partition('u-1')
    clearQueueEdit(p)
    expect(p.clientUuid).toBeNull()
    clearQueueEdit(p)
    expect(p.clientUuid).toBeNull()
  })
})

describe('isQueueEditAlive · 帧驱动活性（Q3）', () => {
  const rows = [{ clientUuid: 'u-1' }, { clientUuid: 'u-2' }]

  it('锚定条目在派生队列行中（queued/in-flight/failed）→ alive', () => {
    expect(isQueueEditAlive(rows, 'u-2')).toBe(true)
  })

  it('条目离场（delivered 被谓词滤除 / cancelled 不进帧 / 行消失）→ 不 alive', () => {
    expect(isQueueEditAlive(rows, 'u-gone')).toBe(false)
  })

  it('无锚定（null）→ 恒 false（空集调用安全）', () => {
    expect(isQueueEditAlive(rows, null)).toBe(false)
    expect(isQueueEditAlive([], null)).toBe(false)
  })
})
