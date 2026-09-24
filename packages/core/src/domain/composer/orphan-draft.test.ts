/**
 * orphan-draft 单测（robustness ③b / 设计 D4）——孤立草稿暂存槽的 round-trip 语义。
 *
 * 覆盖 TC6：stash→take 同段返回（image needsMigrate 标志保真）/ take 一次性语义 /
 * 覆盖式后写优先 / reset 测试隔离。挂载消费面（composer-shell onMounted take →
 * restoreSegments）由 send.test ⑫b（暂存侧）+ 真机验收 3（消费侧 DOM 形态）闭环。
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/orphan-draft.test.ts
 */
import { describe, expect, it, beforeEach } from 'vitest'
import type { Segment } from '@taiji/shared'
import { stashOrphanedDraft, takeOrphanedDraft, __resetOrphanedDraftForTesting } from './orphan-draft'

const segs: Segment[] = [
  { type: 'text', text: 'hi ' },
  { type: 'image', id: 'img-1', path: '/tmp/a.png', fileName: 'a.png', displayName: 'a.png', needsMigrate: true },
] as unknown as Segment[]

beforeEach(() => {
  __resetOrphanedDraftForTesting()
})

describe('orphan-draft 孤立草稿暂存槽', () => {
  it('TC6-① stash → take 得到同一段集（image needsMigrate 标志保真——重试时重新迁移的依据）', () => {
    stashOrphanedDraft(segs)
    const taken = takeOrphanedDraft()
    expect(taken).toEqual(segs)
    expect((taken![1] as Extract<Segment, { type: 'image' }>).needsMigrate).toBe(true)
  })

  it('TC6-② take 一次性语义：取回后二次 take 为 null（不重复恢复造成双份草稿）', () => {
    stashOrphanedDraft(segs)
    expect(takeOrphanedDraft()).not.toBeNull()
    expect(takeOrphanedDraft()).toBeNull()
  })

  it('TC6-③ 覆盖式后写优先；空槽 take 为 null', () => {
    expect(takeOrphanedDraft()).toBeNull()
    stashOrphanedDraft(segs)
    const later = [{ type: 'text', text: 'later' }] as unknown as Segment[]
    stashOrphanedDraft(later)
    expect(takeOrphanedDraft()).toEqual(later)
    expect(takeOrphanedDraft()).toBeNull()
  })

  it('TC6-④ __resetOrphanedDraftForTesting 回初始态（测试隔离 API）', () => {
    stashOrphanedDraft(segs)
    __resetOrphanedDraftForTesting()
    expect(takeOrphanedDraft()).toBeNull()
  })
})
