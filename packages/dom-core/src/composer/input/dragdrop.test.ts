/**
 * dragdrop.ts composable 单测 —— composer composer-box 拖拽落位处理（W2 TC）。
 *
 * 覆盖：onDragOver（置 isDragOver=true）、onDragLeave（relatedTarget contains 防冒泡：在内不复位 /
 * 在外复位 / null 复位）、onDrop（非 image 忽略不 preventDefault / image 占位 badge + pasteImage 回填 /
 * 多文件 async 循环 + onChanged 收尾）。
 *
 * 运行：cd packages/dom-core && npx vitest run src/composer/input/dragdrop.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { useComposerDragDrop } from './dragdrop'
import type { ComposerInputInstance, DragDropDeps, HandleImagePasteResult } from './types'

/** mock ComposerInputInstance（dragdrop 只用 insertImageBadge） */
function makeInputInstance(overrides: Partial<ComposerInputInstance> = {}): ComposerInputInstance {
  return {
    insertImageBadge: vi.fn(),
    setText: vi.fn(),
    clear: vi.fn(),
    insertSlashChip: vi.fn(),
    insertFileChip: vi.fn(),
    focus: vi.fn(),
    insertTextAtCursor: vi.fn(),
    ...overrides,
  } as unknown as ComposerInputInstance
}

/** setup：inputRef + composerBox（挂 body，使 contains() 生效）+ sessionId + pasteImage 注入 */
function setup(pasteImageImpl?: DragDropDeps['pasteImage']) {
  const inputRef = ref<ComposerInputInstance | null>(makeInputInstance())
  const composerBox = document.createElement('div')
  document.body.appendChild(composerBox)
  const composerBoxRef = ref<HTMLElement | null>(composerBox)
  const onChanged = vi.fn()
  const sessionId = ref<string | null>('s1')
  const deps: DragDropDeps = {
    pasteImage: pasteImageImpl ?? vi.fn(),
  }
  const api = useComposerDragDrop(inputRef, composerBoxRef, onChanged, sessionId, deps)
  return {
    inputRef,
    composerBox,
    composerBoxRef,
    onChanged,
    sessionId,
    deps,
    ...api,
    cleanup: () => document.body.removeChild(composerBox),
  }
}

/** 构造 drop DragEvent mock（携带 files） */
function makeDropEvent(files: File[]): DragEvent {
  return {
    preventDefault: vi.fn(),
    dataTransfer: { files } as unknown as DataTransfer,
  } as unknown as DragEvent
}

/** 构造 dragleave DragEvent mock（携带 relatedTarget） */
function makeDragLeaveEvent(related: Node | null): DragEvent {
  return { relatedTarget: related } as unknown as DragEvent
}

describe('useComposerDragDrop onDragOver', () => {
  let cleanup: () => void
  afterEach(() => {
    cleanup?.()
  })

  it('dragover：置 isDragOver=true', () => {
    const c = setup()
    expect(c.isDragOver.value).toBe(false)
    c.onDragOver({} as DragEvent)
    expect(c.isDragOver.value).toBe(true)
    cleanup = c.cleanup
  })
})

describe('useComposerDragDrop onDragLeave（relatedTarget contains 防冒泡）', () => {
  let cleanup: () => void
  afterEach(() => {
    cleanup?.()
  })

  it('relatedTarget 在 box 内（子元素）：不复位（防子元素冒泡误触发）', () => {
    const c = setup()
    c.isDragOver.value = true
    // 子元素仍在 box 内
    const child = document.createElement('span')
    c.composerBox.appendChild(child)
    c.onDragLeave(makeDragLeaveEvent(child))
    expect(c.isDragOver.value).toBe(true)
    cleanup = c.cleanup
  })

  it('relatedTarget 在 box 外：复位 isDragOver=false', () => {
    const c = setup()
    c.isDragOver.value = true
    const outside = document.createElement('span')
    document.body.appendChild(outside) // box 外的兄弟元素
    c.onDragLeave(makeDragLeaveEvent(outside))
    expect(c.isDragOver.value).toBe(false)
    document.body.removeChild(outside)
    cleanup = c.cleanup
  })

  it('relatedTarget 为 null（拖出窗口）：复位 isDragOver=false', () => {
    const c = setup()
    c.isDragOver.value = true
    c.onDragLeave(makeDragLeaveEvent(null))
    expect(c.isDragOver.value).toBe(false)
    cleanup = c.cleanup
  })
})

describe('useComposerDragDrop onDrop', () => {
  let cleanup: () => void
  let execSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // jsdom 未实现 document.execCommand（text 降级分支会调），stub spy
    execSpy = vi.fn().mockReturnValue(false)
    Object.defineProperty(document, 'execCommand', {
      value: execSpy,
      configurable: true,
      writable: true,
    })
  })
  afterEach(() => {
    delete (document as { execCommand?: unknown }).execCommand
    cleanup?.()
  })

  it('非 image 文件：不 preventDefault，直接返回（imageFiles 过滤为空）', () => {
    const c = setup()
    c.isDragOver.value = true
    const e = makeDropEvent([new File(['x'], 'a.txt', { type: 'text/plain' })])
    c.onDrop(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(c.inputRef.value?.insertImageBadge).not.toHaveBeenCalled()
    // onDrop 开头即复位 isDragOver（无论是否 image）
    expect(c.isDragOver.value).toBe(false)
    cleanup = c.cleanup
  })

  it('image 文件 + pasteImage resolve badge：插占位 badge + pasteImage(file, sid) + 回填真实 badge', async () => {
    const badge: HandleImagePasteResult = {
      kind: 'badge',
      path: '/real/a.png',
      fileName: 'a-uuid.png',
      displayName: '截图-a.png',
      needsMigrate: true,
    }
    const c = setup(vi.fn().mockResolvedValue(badge))
    const file = new File(['img'], 'a.png', { type: 'image/png' })
    const e = makeDropEvent([file])
    c.onDrop(e)
    expect(e.preventDefault).toHaveBeenCalled()
    // 占位 badge（占位 mark 同时作为 path/fileName + 显示「拖入中…」+ needsMigrate=false）
    expect(c.inputRef.value?.insertImageBadge).toHaveBeenCalledWith(
      expect.stringMatching(/^__drag_pending_[0-9a-f-]+__$/),
      expect.stringMatching(/^__drag_pending_[0-9a-f-]+__$/),
      '拖入中…',
      false,
    )
    // 等待 async 闭包
    await new Promise((r) => setTimeout(r, 0))
    expect(c.deps.pasteImage).toHaveBeenCalledWith(file, 's1')
    // placeholderEl 在 box 中找不到（mock insertImageBadge 未真插 DOM）→ applyImagePersistResult
    // kind=badge + placeholderEl=null → fallback 调 insertImageBadge(真实 path,...)
    expect(c.inputRef.value?.insertImageBadge).toHaveBeenCalledWith('/real/a.png', 'a-uuid.png', '截图-a.png', true)
    expect(c.onChanged).toHaveBeenCalled()
    cleanup = c.cleanup
  })

  it('image 文件 + pasteImage resolve text：占位 + 降级 execCommand(insertText)', async () => {
    const text: HandleImagePasteResult = { kind: 'text', text: '[降级文本]' }
    const c = setup(vi.fn().mockResolvedValue(text))
    const file = new File(['img'], 'b.png', { type: 'image/png' })
    c.onDrop(makeDropEvent([file]))
    await new Promise((r) => setTimeout(r, 0))
    // 占位 badge 插入一次
    expect(c.inputRef.value?.insertImageBadge).toHaveBeenCalledTimes(1)
    // placeholderEl=null + kind=text → 走 execCommand 降级（不二次调 insertImageBadge）
    expect(execSpy).toHaveBeenCalledWith('insertText', false, '[降级文本]')
    expect(c.onChanged).toHaveBeenCalled()
    cleanup = c.cleanup
  })

  it('多 image 文件：循环插占位 + 每文件调一次 pasteImage + onChanged 收尾一次', async () => {
    const badge: HandleImagePasteResult = {
      kind: 'badge',
      path: '/r.png',
      fileName: 'r.png',
      displayName: 'r.png',
      needsMigrate: false,
    }
    const c = setup(vi.fn().mockResolvedValue(badge))
    const files = [
      new File(['1'], 'a.png', { type: 'image/png' }),
      new File(['2'], 'b.jpg', { type: 'image/jpeg' }),
    ]
    c.onDrop(makeDropEvent(files))
    await new Promise((r) => setTimeout(r, 0))
    // 两个占位 + 两次回填 = 4 次 insertImageBadge
    expect(c.inputRef.value?.insertImageBadge).toHaveBeenCalledTimes(4)
    expect(c.deps.pasteImage).toHaveBeenCalledTimes(2)
    expect(c.deps.pasteImage).toHaveBeenNthCalledWith(1, files[0], 's1')
    expect(c.deps.pasteImage).toHaveBeenNthCalledWith(2, files[1], 's1')
    expect(c.onChanged).toHaveBeenCalledTimes(1)
    cleanup = c.cleanup
  })
})
