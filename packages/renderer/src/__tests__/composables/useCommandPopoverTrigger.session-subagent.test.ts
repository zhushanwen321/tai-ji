// @vitest-environment node

/**
 * useCommandPopoverTrigger session/subagent + useFileSearch + useMessageBusSubscription
 * 合并文件（簇 3-3 B 组，3 源合一，node 环境）：
 * - useCommandPopoverTrigger.session-subagent.test.ts —— # / @ 路径 + + 菜单 attach/image（spy 脚手架）
 * - useFileSearch.test.ts —— U24 debounce 契约（fake timers 在用例内 try/finally 自封闭）
 * - useMessageBusSubscription.test.ts —— re-export shim 引用恒等 + 防御冒烟
 *
 * 两 mock（@/lib/ipc 的 pickFile / @/api 的 composer.getFileCandidates）经核实互不入对方
 * 消费图（useCommandPopoverTrigger 图无 @/api；useFileSearch 图无 @/lib/ipc）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, ref } from 'vue'

// pickFile 可被每测试替换：resolved path / canceled / reject（+ 菜单 attach/image 分支用）
const pickFileMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/ipc', () => ({
  pickFile: pickFileMock,
}))

const mockGetFileCandidates = vi.fn()
vi.mock('@/api', () => ({ composer: { getFileCandidates: (...args: unknown[]) => mockGetFileCandidates(...args) } }))

import { useCommandPopoverTrigger } from '@/composables/panel/useCommandPopoverTrigger'
import { useFileSearch } from '@/composables/features/search/useFileSearch'
import * as core from '@taiji/core'
import {
  subscribeSession,
  getSubscriptionState,
  clearSubscription,
  updateLastSeenSeq,
  resetSubscriptionStates,
} from '@/composables/useMessageBusSubscription'

// ═══ 来源节：useCommandPopoverTrigger.session-subagent.test.ts —— session/subagent 触发 + + 菜单 attach/image ═══
describe('useCommandPopoverTrigger.session-subagent', () => {
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

    it('onCmdSelect(type=subagent) 缺 slug record（顺带发现 2 收尾）→ 显示名回落 subagentId，不吃「新任务」占位', () => {
      const { result, inputMock } = setup()

      result.onCmdSelect({ type: 'subagent', name: 'x', subagentId: 'sa-direct-9', slug: '' })

      // 与候选行显示口径一致（slug || subagentId）——chip 定向语义按 subagentId 引用，
      // 「新任务」占位是新建项专属，不得顶替既有 record 的显示
      expect(inputMock.insertSubagentChip).toHaveBeenCalledWith('sa-direct-9', 'sa-direct-9')
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
})

// ═══ 来源节：useFileSearch.test.ts —— debounce 契约（fake timers 节内 try/finally 自封闭） ═══
describe('useFileSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('useFileSearch debouncedLoad', () => {
    it('U24 debounce 300ms：debouncedLoad 连续 2 次（间隔0）→ api 调 1 次', async () => {
      vi.useFakeTimers()
      try {
        mockGetFileCandidates.mockResolvedValue([{ path: 'a', name: 'a', type: 'file' }])
        const { debouncedLoad } = useFileSearch()

        // 连续 2 次（间隔 0），第二次的 timer 覆盖第一次（debounce 语义）
        debouncedLoad('s1', () => {})
        debouncedLoad('s1', () => {})

        // 未 advance 前 api 未调
        expect(mockGetFileCandidates).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(300)

        expect(mockGetFileCandidates).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('load 失败 → 降级空数组不抛', async () => {
      mockGetFileCandidates.mockRejectedValue(new Error('down'))
      const { load } = useFileSearch()

      await expect(load('s1')).resolves.toEqual([])
    })
  })
})

// ═══ 来源节：useMessageBusSubscription.test.ts —— re-export shim 引用恒等 + 防御冒烟 ═══
describe('useMessageBusSubscription', () => {
  beforeEach(() => {
    resetSubscriptionStates()
    vi.clearAllMocks()
  })

  describe('S3a: 未注入端口防御路径（必须在任何 setSubscriptionPorts 之前执行，core 模块级注入状态泄漏）', () => {
    it('subscribeSession 不抛、console.warn 提示端口未注入', async () => {
      // 不调用 setSubscriptionPorts（保持未注入状态）
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await expect(subscribeSession('s1')).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]![0]).toContain('ports not injected')
      expect(getSubscriptionState('s1')).toBeUndefined()
      warnSpy.mockRestore()
    })
  })

  describe('S1: shim 5 导出 === core 同引用（纯转发，无本地实现）', () => {
    it('subscribeSession / getSubscriptionState / clearSubscription / updateLastSeenSeq / resetSubscriptionStates 均直接转发', () => {
      expect(subscribeSession).toBe(core.subscribeSession)
      expect(getSubscriptionState).toBe(core.getSubscriptionState)
      expect(clearSubscription).toBe(core.clearSubscription)
      expect(updateLastSeenSeq).toBe(core.updateLastSeenSeq)
      expect(resetSubscriptionStates).toBe(core.resetSubscriptionStates)
    })
  })
})
