/**
 * useDeferQueueRows 单测（compact-defer-composer-queue u1 拆分配套——自 Composer.vue
 * 原样搬移后的行为锁定；queue 本体的 enqueue/remove/flush 契约见 use-compact-queue.test.ts）。
 *
 * 覆盖：
 * - sessionId 为 null：entries 空 + chip/hint 走 fallback 档（不触 store/queue）
 * - deferEntries 只收未提交条目（mode === undefined），已提交条目不渲染（双数据源归一）
 * - deferChip 分档：compacting > bash > fallback（与 PendingBubble.pendingHint 同优先级）
 * - deferHint 分档：compacting > bash > settling（turn !== 'idle'）> 默认
 * - onRemoveDefer：有 session 时透传 queue.remove；null session no-op
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computed } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const queueMock = vi.hoisted(() => ({
  peek: vi.fn(() => [] as Array<{ id: string; mode?: string }>),
  remove: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/composables/panel/useCompactQueue', () => ({
  useCompactQueue: () => queueMock,
}))

const phaseMock = vi.hoisted(() => vi.fn(() => ({ compacting: false, bash: false, turn: 'idle' })))

vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({ sessionPhase: phaseMock }),
}))

import { useDeferQueueRows } from '@/composables/panel/useDeferQueueRows'

function setup(sessionId: string | null) {
  return useDeferQueueRows(computed(() => sessionId))
}

beforeEach(() => {
  setActivePinia(createPinia())
  queueMock.peek.mockReset().mockReturnValue([])
  queueMock.remove.mockReset()
  phaseMock.mockReset().mockReturnValue({ compacting: false, bash: false, turn: 'idle' })
})

describe('useDeferQueueRows', () => {
  it('sessionId 为 null：entries 空 + chip/hint fallback，不触 queue/store', () => {
    const rows = setup(null)
    expect(rows.deferEntries.value).toEqual([])
    expect(rows.deferChip.value).toBe('panel.deferQueue.deferChipFallback')
    expect(rows.deferHint.value).toBe('panel.deferQueue.pendingHint')
    expect(queueMock.peek).not.toHaveBeenCalled()
    expect(phaseMock).not.toHaveBeenCalled()
  })

  it('deferEntries 只收未提交条目（mode === undefined），已提交条目滤除', () => {
    queueMock.peek.mockReturnValue([
      { id: 'a', mode: undefined },
      { id: 'b', mode: 'send' },
      { id: 'c' },
    ])
    const rows = setup('s1')
    expect(rows.deferEntries.value.map((m) => m.id)).toEqual(['a', 'c'])
  })

  it('deferChip 分档：compacting 优先于 bash，二者皆无走 fallback', () => {
    // 每分支新实例：mock 换返回值不会使已读 computed 失效（无响应式依赖），缓存隔离靠重建
    phaseMock.mockReturnValue({ compacting: true, bash: true, turn: 'idle' })
    expect(setup('s1').deferChip.value).toBe('panel.deferQueue.deferChipCompacting')
    phaseMock.mockReturnValue({ compacting: false, bash: true, turn: 'idle' })
    expect(setup('s1').deferChip.value).toBe('panel.deferQueue.deferChipBash')
    phaseMock.mockReturnValue({ compacting: false, bash: false, turn: 'idle' })
    expect(setup('s1').deferChip.value).toBe('panel.deferQueue.deferChipFallback')
  })

  it('deferHint 分档：compacting > bash > settling（turn 非 idle）> 默认', () => {
    phaseMock.mockReturnValue({ compacting: true, bash: false, turn: 'idle' })
    expect(setup('s1').deferHint.value).toBe('panel.deferQueue.pendingHintCompacting')
    phaseMock.mockReturnValue({ compacting: false, bash: true, turn: 'idle' })
    expect(setup('s1').deferHint.value).toBe('panel.deferQueue.pendingHintBash')
    phaseMock.mockReturnValue({ compacting: false, bash: false, turn: 'streaming' })
    expect(setup('s1').deferHint.value).toBe('panel.deferQueue.pendingHintSettling')
    phaseMock.mockReturnValue({ compacting: false, bash: false, turn: 'idle' })
    expect(setup('s1').deferHint.value).toBe('panel.deferQueue.pendingHint')
  })

  it('onRemoveDefer：有 session 透传 queue.remove(sid, id)；null session no-op', () => {
    const rows = setup('s1')
    rows.onRemoveDefer('a')
    expect(queueMock.remove).toHaveBeenCalledWith('s1', 'a')
    queueMock.remove.mockClear()
    const nullRows = setup(null)
    nullRows.onRemoveDefer('a')
    expect(queueMock.remove).not.toHaveBeenCalled()
  })
})
