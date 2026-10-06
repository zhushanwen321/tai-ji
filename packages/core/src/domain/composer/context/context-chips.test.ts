/**
 * useComposerContextChips 测试 —— refreshAttachedItems 的 segments 快照复用契约（性能 A 档）。
 *
 * 背景：Composer onInputChange 每次击键此前做两次 getSegments 全树 DOM 解析（attachedItems
 * 与 selectedSkillNames 各一次）。改造后 onInputChange 单次 getSegments，同一快照经可选参数
 * 传入 refreshAttachedItems；chip 删除 / drop 等无既有快照的调用点保持无参形态（自行重读 DOM）。
 *
 * 覆盖：
 * - 无参调用（原行为回归）：从 inputRef.getSegments() 读取，image 段派生 chips，非 image 段过滤
 * - 传参调用（复用路径）：不再触碰 inputRef.getSegments（计数 0），派生结果与传入快照一致
 * - onRemoveContextChip：删除后走无参重读（DOM 已变，旧快照不可复用）
 * - inputRef 为 null：attachedItems 归空（两形态都安全）
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/context/context-chips.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { useComposerContextChips } from './context-chips'
import type { Segment } from '@taiji/shared'

type Spy = ReturnType<typeof vi.fn>

function makeSegments(): Segment[] {
  return [
    { type: 'text', text: 'hello ' },
    {
      type: 'image',
      id: 'img-1',
      path: '/tmp/a.png',
      fileName: 'a.png',
      displayName: '截图-a',
      needsMigrate: false,
    },
    { type: 'skill', name: 'review' },
    {
      type: 'image',
      id: 'img-2',
      path: '/tmp/b.png',
      fileName: 'b.png',
      displayName: '截图-b',
      needsMigrate: true,
    },
  ]
}

function setup(domSegments: Segment[] | null = makeSegments()): {
  getSegments: Spy
  removeImageChip: Spy
  api: ReturnType<typeof useComposerContextChips>
} {
  const getSegments = vi.fn(() => domSegments ?? [])
  const removeImageChip = vi.fn()
  const api = useComposerContextChips(ref({ getSegments, removeImageChip }))
  return { getSegments, removeImageChip, api }
}

describe('useComposerContextChips refreshAttachedItems（segments 快照复用契约）', () => {
  it('无参调用（原行为回归）：读 getSegments 派生 image chips，非 image 段过滤', () => {
    const { getSegments, api } = setup()
    api.refreshAttachedItems()
    expect(getSegments).toHaveBeenCalledTimes(1)
    expect(api.attachedItems.value).toEqual([
      { id: 'img-1', name: '截图-a', type: 'image' },
      { id: 'img-2', name: '截图-b', type: 'image' },
    ])
  })

  it('传参调用（复用路径）：不触碰 getSegments（计数 0），派生自传入快照', () => {
    const { getSegments, api } = setup()
    api.refreshAttachedItems(makeSegments())
    expect(getSegments).not.toHaveBeenCalled()
    expect(api.attachedItems.value).toEqual([
      { id: 'img-1', name: '截图-a', type: 'image' },
      { id: 'img-2', name: '截图-b', type: 'image' },
    ])
  })

  it('传参空快照：attachedItems 归空且不读 DOM（onInputChange 无输入形态）', () => {
    const { getSegments, api } = setup()
    api.refreshAttachedItems([])
    expect(getSegments).not.toHaveBeenCalled()
    expect(api.attachedItems.value).toEqual([])
  })

  it('onRemoveContextChip：removeImageChip 后走无参重读（删除后 DOM 已变，旧快照不可复用）', () => {
    const { getSegments, removeImageChip, api } = setup()
    api.onRemoveContextChip('img-1')
    expect(removeImageChip).toHaveBeenCalledWith('img-1')
    expect(getSegments).toHaveBeenCalledTimes(1)
  })

  it('inputRef 为 null：无参形态安全归空；传参形态派生自传入快照（复用不依赖 inputRef）', () => {
    const api = useComposerContextChips(ref(null))
    api.refreshAttachedItems()
    expect(api.attachedItems.value).toEqual([])
    api.refreshAttachedItems(makeSegments())
    expect(api.attachedItems.value).toEqual([
      { id: 'img-1', name: '截图-a', type: 'image' },
      { id: 'img-2', name: '截图-b', type: 'image' },
    ])
  })
})
