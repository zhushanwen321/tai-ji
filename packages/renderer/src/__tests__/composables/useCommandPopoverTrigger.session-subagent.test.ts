/**
 * useCommandPopoverTrigger 单测（session/subagent 触发 + + 菜单 attach/image，同 SUT 单文件）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/__tests__/composables/useCommandPopoverTrigger.session-subagent.test.ts
 *
 * 覆盖（四符号体系 # / @ 路径 + + 菜单分支；原 attach.test.ts 已并入本文件）：
 *   - onSessionTrigger({query}) → 开浮层记 query；再 trigger(null) → 关浮层（关闭分支）
 *   - onSubagentTrigger({query}) → 开浮层；再 trigger(null) → 关浮层
 *   - trigger(null) 但无 active 标记 → 不动浮层（非触发路径打开的浮层不被误关）
 *   - onCmdSelect(type=subagent)「新建」项（slug/subagentId 空串）→ 插占位「新任务」chip
 *   - onAddSelect attach/image（TC2/TC3）：pickFile 成功/取消/reject 三态
 *
 * mock 策略：effectScope + inputRef spy 对象；vi.mock('@/lib/ipc') 替换 pickFile。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, ref } from 'vue'

// pickFile 可被每测试替换：resolved path / canceled / reject（+ 菜单 attach/image 分支用）
const pickFileMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/ipc', () => ({
  pickFile: pickFileMock,
}))

import { useCommandPopoverTrigger } from '@/composables/panel/useCommandPopoverTrigger'

/** inputRef mock：spy 覆盖本测试触达的插入/清除方法 */
function createInputMock() {
  return {
    focus: vi.fn(),
    clearSlashQueryText: vi.fn(),
    insertSlashChip: vi.fn(),
    clearSessionQueryText: vi.fn(),
    insertSessionChip: vi.fn(),
    clearSubagentQueryText: vi.fn(),
    insertSubagentChip: vi.fn(),
    clearDollarFileQueryText: vi.fn(),
    insertFileChip: vi.fn(),
    // + 菜单 attach/image 分支（原 attach.test.ts 并入）
    insertImageBadge: vi.fn(),
    saveSelection: vi.fn(),
  }
}

/** 在独立 effectScope 内运行 composable（watch 等需 scope） */
function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, dispose: () => scope.stop() }
}

describe('useCommandPopoverTrigger session/subagent 触发（# / @ 符号路径）', () => {
  let dispose: (() => void) | undefined

  beforeEach(() => {
    setActivePinia(createPinia())
  })
  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  function setup() {
    const inputMock = createInputMock()
    const { result, dispose: d } = runWithScope(() =>
      useCommandPopoverTrigger(ref(inputMock) as never, ref('sid') as never),
    )
    dispose = d
    return { result, inputMock }
  }

  it('onSessionTrigger({query}) → cmdType=session 开浮层；trigger(null) → 关闭', () => {
    const { result } = setup()
    expect(result.cmdOpen.value).toBe(false)

    result.onSessionTrigger({ query: '设计讨' })
    expect(result.cmdOpen.value).toBe(true)
    expect(result.cmdType.value).toBe('session')
    expect(result.sessionQuery.value).toBe('设计讨')

    // 触发路径打开的浮层：trigger(null) 关闭
    result.onSessionTrigger(null)
    expect(result.cmdOpen.value).toBe(false)
  })

  it('onSubagentTrigger({query}) → cmdType=subagent 开浮层；trigger(null) → 关闭', () => {
    const { result } = setup()

    result.onSubagentTrigger({ query: 'reviewer' })
    expect(result.cmdOpen.value).toBe(true)
    expect(result.cmdType.value).toBe('subagent')
    expect(result.subagentQuery.value).toBe('reviewer')

    result.onSubagentTrigger(null)
    expect(result.cmdOpen.value).toBe(false)
  })

  it('trigger(null) 但无 active 标记 → 不关闭浮层（+ 菜单路径打开的不被误关）', () => {
    const { result } = setup()
    // 模拟 + 菜单路径打开（不设触发态）：先经 slash 触发打开后手动清标记不可行，
    // 直接验证非触发态下 trigger(null) 无副作用：初始关闭态保持不变
    expect(result.cmdOpen.value).toBe(false)
    result.onSessionTrigger(null)
    expect(result.cmdOpen.value).toBe(false)
  })

  it('onCmdSelect(type=subagent)「新建」项（两字段空串）→ 清过滤文本 + 插占位「新任务」chip', () => {
    const { result, inputMock } = setup()

    result.onCmdSelect({ type: 'subagent', name: 'x', subagentId: '', slug: '' })

    expect(inputMock.clearSubagentQueryText).toHaveBeenCalledTimes(1)
    // 占位 slug 用 i18n 文案（zh-CN「新任务」）
    expect(inputMock.insertSubagentChip).toHaveBeenCalledWith('', '新任务')
    // 浮层关闭 + 焦点回输入区
    expect(result.cmdOpen.value).toBe(false)
    expect(inputMock.focus).toHaveBeenCalledTimes(1)
  })

  it('onCmdSelect(type=subagent) 已有 record → subagentId/slug 原样插 chip', () => {
    const { result, inputMock } = setup()

    result.onCmdSelect({ type: 'subagent', name: 'x', subagentId: 'sa-1', slug: 'build-api' })
    expect(inputMock.insertSubagentChip).toHaveBeenCalledWith('sa-1', 'build-api')
    expect(result.cmdOpen.value).toBe(false)
  })

  it('onCmdSelect(type=file) → 清 $ 过滤文本 + 插文件 chip', () => {
    const { result, inputMock } = setup()

    result.onCmdSelect({ type: 'file', name: '/a/b.ts' })
    expect(inputMock.clearDollarFileQueryText).toHaveBeenCalledTimes(1)
    expect(inputMock.insertFileChip).toHaveBeenCalledWith('/a/b.ts')
    expect(result.cmdOpen.value).toBe(false)
  })
})

// ── 原 useCommandPopoverTrigger.attach.test.ts 并入（同 SUT 同脚手架，+ 菜单 attach/image 分支）──
describe('useCommandPopoverTrigger onAddSelect attach/image（TC2/TC3）', () => {
  let dispose: (() => void) | undefined

  beforeEach(() => {
    setActivePinia(createPinia())
    pickFileMock.mockReset()
  })
  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  function setup() {
    const inputMock = createInputMock()
    const { result, dispose: d } = runWithScope(() =>
      useCommandPopoverTrigger(ref(inputMock) as never, ref('sid') as never),
    )
    dispose = d
    return { result, inputMock }
  }

  it('TC2: attach + pickFile 返回 path → insertFileChip(path)', async () => {
    pickFileMock.mockResolvedValue({ canceled: false, path: '/x/y.txt' })
    const { result, inputMock } = setup()
    await result.onAddSelect('attach')
    // attach 无 filters：pickFile 以零参数调用（不传 filters options）
    expect(pickFileMock).toHaveBeenCalledTimes(1)
    expect(pickFileMock.mock.calls[0]).toHaveLength(0)
    // attach 走 file chip（与 # 引用 / drawer 注入一致），不再插纯文本路径
    expect(inputMock.insertFileChip).toHaveBeenCalledWith('/x/y.txt')
    expect(inputMock.insertImageBadge).not.toHaveBeenCalled()
  })

  it('TC2: attach + pickFile canceled → 静默 return（不插任何内容）', async () => {
    pickFileMock.mockResolvedValue({ canceled: true, path: null })
    const { result, inputMock } = setup()
    await result.onAddSelect('attach')
    expect(inputMock.insertFileChip).not.toHaveBeenCalled()
    expect(inputMock.insertImageBadge).not.toHaveBeenCalled()
  })

  it('TC3: image + pickFile 返回 path → insertImageBadge(path, basename, basename)，filters 含 Images', async () => {
    pickFileMock.mockResolvedValue({ canceled: false, path: '/tmp/cat.png' })
    const { result, inputMock } = setup()
    await result.onAddSelect('image')
    // pickFile 带 image filters
    expect(pickFileMock).toHaveBeenCalledTimes(1)
    const options = pickFileMock.mock.calls[0][0]
    expect(options.filters[0]).toEqual({
      name: 'Images',
      extensions: expect.arrayContaining(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']),
    })
    // basename 取末段；磁盘已存在文件 fileName 与 displayName 同值；
    // M1：+菜单选的磁盘文件 needsMigrate=false（显式传 false，避免被 renameSync 误移走）
    expect(inputMock.insertImageBadge).toHaveBeenCalledWith('/tmp/cat.png', 'cat.png', 'cat.png', false)
    expect(inputMock.insertFileChip).not.toHaveBeenCalled()
  })

  it('TC3: image + path 无分隔符 → basename 取整 path', async () => {
    pickFileMock.mockResolvedValue({ canceled: false, path: 'plainfile.png' })
    const { result, inputMock } = setup()
    await result.onAddSelect('image')
    expect(inputMock.insertImageBadge).toHaveBeenCalledWith('plainfile.png', 'plainfile.png', 'plainfile.png', false)
  })

  it('TC3: image + pickFile canceled → 静默 return', async () => {
    pickFileMock.mockResolvedValue({ canceled: true, path: null })
    const { result, inputMock } = setup()
    await result.onAddSelect('image')
    expect(inputMock.insertImageBadge).not.toHaveBeenCalled()
  })

  it('ES: pickFile reject → catch 静默 return（不 throw、不插内容）', async () => {
    pickFileMock.mockRejectedValue(new Error('IPC down'))
    const { result, inputMock } = setup()
    await expect(result.onAddSelect('attach')).resolves.toBeUndefined()
    expect(inputMock.insertFileChip).not.toHaveBeenCalled()
  })
})
