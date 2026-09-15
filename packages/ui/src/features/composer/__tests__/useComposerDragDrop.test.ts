/**
 * useComposerDragDrop 单测（TC5/TC6/TC7/TC8，slice5 attach-dragdrop-menu）。
 *
 * 覆盖：
 * - TC5: dragover → isDragOver=true（composer-box accent 边框反馈数据源）
 * - TC6: drop 图片 → insertImageBadge 占位 + 回填真实 path/name（复用 handleImagePaste）
 * - TC7: drop 非图片 / 空文件 → insertImageBadge 未调用，isDragOver 复位
 * - TC8: dragleave relatedTarget 在 box 内不复位；null / box 外复位
 *
 * [W4 迁移] 自 renderer __tests__/composables/useComposerDragDrop.test.ts 迁入 ui 包
 * features/composer/__tests__/——dragdrop 逻辑在 core input 模块，pasteImage 经 deps 注入
 * （原 vi.mock useImageAttachment 改为注入 mock pasteImage，零 renderer import）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/composer
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { useComposerDragDrop } from '@taiji/dom-core/composer/input'

/** pasteImage 可被每测试替换返回值（替代原 vi.mock useImageAttachment） */
const pasteImageMock = vi.fn()

/** sessionId ref（固定 'test-sess'） */
const sessionIdRef = ref<string | null>('test-sess')

/** inputRef mock：spy insertImageBadge */
function createInputMock() {
  return { insertImageBadge: vi.fn() }
}

/**
 * inputRef mock（DOM 感知版）：insertImageBadge 在 box 内插入真实 .image-chip span
 * （含 data-chip-path + data-chip-needs-migrate + .chip-label），模拟 useComposerChipCommands.insertImageBadge
 * 的 DOM 结构，使占位 querySelector 能定位到、验证回填走 dataset（而非重插）路径。
 */
function createDomInputMock(box: HTMLElement) {
  const calls = vi.fn()
  const insertImageBadge = (path: string, fileName: string, displayName: string, needsMigrate?: boolean) => {
    calls(path, fileName, displayName, needsMigrate)
    const chip = document.createElement('span')
    chip.className = 'mention-chip image-chip'
    chip.contentEditable = 'false'
    chip.dataset.chipType = 'image'
    chip.dataset.chipPath = path
    chip.dataset.chipFileName = fileName
    chip.dataset.chipDisplayName = displayName
    chip.dataset.chipNeedsMigrate = needsMigrate ? 'true' : 'false'
    const label = document.createElement('span')
    label.className = 'chip-label'
    label.textContent = displayName
    chip.appendChild(label)
    box.appendChild(chip)
    // 后跟 ZWSP spacer（同 contenteditable 范式，移除占位时一并清）
    box.appendChild(document.createTextNode('\u200B'))
  }
  return { insertImageBadge, __calls: calls }
}

/** 在独立 effectScope 内运行 composable */
function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, dispose: () => scope.stop() }
}

/** 构造最小 drop 事件对象。
 *  happy-dom 的 DragEvent 构造器丢弃 dataTransfer/relatedTarget 选项（实测 undefined），
 *  故用普通对象 + 类型断言直接挂载需要的字段（onDrop 读 e.dataTransfer?.files + e.preventDefault）。 */
function makeDropEvent(files: File[]): DragEvent {
  return {
    dataTransfer: { files },
    preventDefault: vi.fn(),
  } as unknown as DragEvent
}

function makeDragLeaveEvent(relatedTarget: Node | null): DragEvent {
  return { relatedTarget } as unknown as DragEvent
}

function makeDragOverEvent(): DragEvent {
  return { preventDefault: vi.fn() } as unknown as DragEvent
}

describe('useComposerDragDrop（TC5-TC8 slice5）', () => {
  let dispose: () => void

  beforeEach(() => {
    pasteImageMock.mockReset()
  })

  afterEach(() => {
    dispose?.()
  })

  it('TC5: dragover → isDragOver=true', async () => {
    const box = document.createElement('div')
    document.body.appendChild(box)
    const { result, dispose: d } = runWithScope(() =>
      useComposerDragDrop(ref(createInputMock()) as never, ref(box), vi.fn(), sessionIdRef, { pasteImage: pasteImageMock }),
    )
    dispose = d
    expect(result.isDragOver.value).toBe(false)
    result.onDragOver(makeDragOverEvent())
    expect(result.isDragOver.value).toBe(true)
  })

  it('TC6: drop 图片 → insertImageBadge 占位(needsMigrate=false) + 回填真实 path/fileName/displayName/needsMigrate（走 dataset，不重插）；isDragOver 复位', async () => {
    pasteImageMock.mockResolvedValue({ kind: 'badge', path: '/tmp/x.png', fileName: 'x-uuid.png', displayName: 'x.png', needsMigrate: true })
    const box = document.createElement('div')
    document.body.appendChild(box)
    // DOM 感知 insertImageBadge：在 box 内插真实 .image-chip，使占位 query 能定位 → 走 dataset 回填
    const inputMock = createDomInputMock(box)
    const onChanged = vi.fn()
    const { result, dispose: d } = runWithScope(() =>
      useComposerDragDrop(ref(inputMock) as never, ref(box), onChanged, sessionIdRef, { pasteImage: pasteImageMock }),
    )
    dispose = d
    // 先 dragover 置位 isDragOver
    result.onDragOver(makeDragOverEvent())
    expect(result.isDragOver.value).toBe(true)

    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'drag.png', { type: 'image/png' })
    result.onDrop(makeDropEvent([png]))
    // onDrop 立即复位 isDragOver
    expect(result.isDragOver.value).toBe(false)
    // 等异步 pasteImage 完成 + 回填
    await vi.waitFor(() => expect(pasteImageMock).toHaveBeenCalled())
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled())
    // 占位 badge 仅插入 1 次（回填走 dataset，不重插——因占位仍在 DOM）；占位 needsMigrate=false（无迁移语义）
    expect(inputMock.__calls).toHaveBeenCalledTimes(1)
    expect(inputMock.__calls).toHaveBeenCalledWith(expect.stringMatching(/^__drag_pending_/), expect.stringMatching(/^__drag_pending_/), '拖入中…', false)
    // 回填后 chip 的 dataset.chipPath 变为真实 path，fileName/displayName/needsMigrate 变为真实值
    const chip = box.querySelector('.image-chip') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.dataset.chipPath).toBe('/tmp/x.png')
    expect(chip.dataset.chipFileName).toBe('x-uuid.png')
    expect(chip.dataset.chipDisplayName).toBe('x.png')
    expect(chip.dataset.chipNeedsMigrate).toBe('true')
    expect(chip.querySelector('.chip-label')?.textContent).toBe('x.png')
  })

  it('TC6-variant: pasteImage 返回 text 降级 → 移除占位 + insertText', async () => {
    pasteImageMock.mockResolvedValue({ kind: 'text', text: '[图片粘贴失败]' })
    // happy-dom 无 document.execCommand（降级路径调用），直接赋值 mock
    const execCalls: unknown[][] = []
    const origExec = (document as { execCommand?: unknown }).execCommand
    ;(document as { execCommand?: unknown }).execCommand = (...args: unknown[]) => {
      execCalls.push(args)
      return true
    }
    try {
      const box = document.createElement('div')
      document.body.appendChild(box)
      const inputMock = createDomInputMock(box)
      const { result, dispose: d } = runWithScope(() =>
        useComposerDragDrop(ref(inputMock) as never, ref(box), vi.fn(), sessionIdRef, { pasteImage: pasteImageMock }),
      )
      dispose = d
      const png = new File([new Uint8Array([0x89])], 'bad.png', { type: 'image/png' })
      result.onDrop(makeDropEvent([png]))
      await vi.waitFor(() => expect(inputMock.__calls).toHaveBeenCalledTimes(1))
      // 占位回填后 execCommand insertText 被调（降级文本落地）+ 占位被移除
      await vi.waitFor(() => {
        expect(execCalls.some((c) => c[0] === 'insertText' && c[2] === '[图片粘贴失败]')).toBe(true)
      })
      expect(box.querySelector('.image-chip')).toBeNull() // 占位已移除
    } finally {
      ;(document as { execCommand?: unknown }).execCommand = origExec
    }
  })

  it('TC7: drop 非图片文件 → insertImageBadge 未调用，isDragOver 复位', () => {
    const inputMock = createInputMock()
    const box = document.createElement('div')
    document.body.appendChild(box)
    const { result, dispose: d } = runWithScope(() =>
      useComposerDragDrop(ref(inputMock) as never, ref(box), vi.fn(), sessionIdRef, { pasteImage: pasteImageMock }),
    )
    dispose = d
    result.onDragOver(makeDragOverEvent())
    const txt = new File(['hi'], 'a.txt', { type: 'text/plain' })
    result.onDrop(makeDropEvent([txt]))
    expect(inputMock.insertImageBadge).not.toHaveBeenCalled()
    expect(result.isDragOver.value).toBe(false)
  })

  it('TC7-variant: drop 空文件列表 → insertImageBadge 未调用', () => {
    const inputMock = createInputMock()
    const box = document.createElement('div')
    document.body.appendChild(box)
    const { result, dispose: d } = runWithScope(() =>
      useComposerDragDrop(ref(inputMock) as never, ref(box), vi.fn(), sessionIdRef, { pasteImage: pasteImageMock }),
    )
    dispose = d
    result.onDrop(makeDropEvent([]))
    expect(inputMock.insertImageBadge).not.toHaveBeenCalled()
  })

  it('TC8: dragleave relatedTarget 在 box 内 → isDragOver 不复位', () => {
    const box = document.createElement('div')
    const child = document.createElement('span')
    box.appendChild(child)
    document.body.appendChild(box)
    const { result, dispose: d } = runWithScope(() =>
      useComposerDragDrop(ref(createInputMock()) as never, ref(box), vi.fn(), sessionIdRef, { pasteImage: pasteImageMock }),
    )
    dispose = d
    result.onDragOver(makeDragOverEvent())
    expect(result.isDragOver.value).toBe(true)
    // relatedTarget 是 box 内子元素 → 不复位
    result.onDragLeave(makeDragLeaveEvent(child))
    expect(result.isDragOver.value).toBe(true)
  })

  it('TC8: dragleave relatedTarget=null（拖出窗口）→ isDragOver 复位', () => {
    const box = document.createElement('div')
    document.body.appendChild(box)
    const { result, dispose: d } = runWithScope(() =>
      useComposerDragDrop(ref(createInputMock()) as never, ref(box), vi.fn(), sessionIdRef, { pasteImage: pasteImageMock }),
    )
    dispose = d
    result.onDragOver(makeDragOverEvent())
    result.onDragLeave(makeDragLeaveEvent(null))
    expect(result.isDragOver.value).toBe(false)
  })

  it('TC8: dragleave relatedTarget 在 box 外 → isDragOver 复位', () => {
    const box = document.createElement('div')
    const outside = document.createElement('div')
    document.body.append(box, outside)
    const { result, dispose: d } = runWithScope(() =>
      useComposerDragDrop(ref(createInputMock()) as never, ref(box), vi.fn(), sessionIdRef, { pasteImage: pasteImageMock }),
    )
    dispose = d
    result.onDragOver(makeDragOverEvent())
    result.onDragLeave(makeDragLeaveEvent(outside))
    expect(result.isDragOver.value).toBe(false)
  })
})
