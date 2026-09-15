/**
 * watchFileChangesForInvalidation 单测（W19 / D-9 ready 帧驱动失效 + overlay 回写）。
 *
 * 背景：W11（R-16）已把 watch source 迁到 per-sid 内层 ref；W19（D-9 / R-23）在其上加
 * 业务判定——回调扫尾部消息的 changeSetStatus（存于 chatStore.changeSetStatuses Map，
 * 经 applyFileChanges 写入），仅 ready 转变时执行两职责：
 * - 职责一：ready 清单 paths → onInvalidate（目录/搜索缓存失效）
 * - 职责二：debounce 300ms → git.status RPC → fileTreeStore.setGitOverlay（W15 预聚合联动）
 *
 * 锁定行为：
 * - token 路径（text commit / accumulating 中间帧）零 RPC / 零 onInvalidate 副作用
 *   （watch 回调可触发，P-D9-3 探针口径：零副作用非零回调）
 * - ready 触发失效且清单精确（仅该 ready 变更集的 fileChanges，非全消息重扫）
 * - 同文件二次修改（第二个 ready 含同 path）再次失效（比旧 diff 语义更准）
 * - debounce 窗口内多次 ready 只发一次 git.status RPC
 * - setGitOverlay 回写后 getDirChangeCount 反映新 overlay（W15 联动）
 * - E9-b RPC 失败降级不写 overlay；E9-c 回写落捕获 sid 分桶
 * - W19 review Fix-1：debounce 窗口内 deleteSession（分桶+分区已销毁）后 timer 到点
 *   不重建孤儿 gitOverlay/dirChangeCounts 分桶
 * - 异 sid 分区替换不触发（W11 触发收敛回归）；sid 切换重置快照（切回重失效）
 *
 * mock 策略：vi.mock('@/api')（git.status）+ fake timers（300ms debounce）+ 真实
 * chat/fileTree store（pinia）——失效与 overlay 走真实 store 链路。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useFileChangeInvalidation.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { useFileTreeStore } from '@/stores/fileTree'
import { watchFileChangesForInvalidation } from '@/composables/features/file-tree/useFileChangeInvalidation'
import type { FileChange, GitFileStatus, GitStatusResult, Message } from '@taiji/shared'

const mockGitStatus = vi.fn()
vi.mock('@/api', () => ({
  git: { status: (...args: unknown[]) => mockGitStatus(...args) },
}))

/** 构造 complete 消息（assistant 可带 fileChanges） */
function msg(id: string, role: 'user' | 'assistant', fileChanges?: FileChange[]): Message {
  return { id, role, content: id, status: 'complete', timestamp: 1, ...(fileChanges ? { fileChanges } : {}) }
}

function fc(filePath: string): FileChange {
  return { filePath, status: 'modified' }
}

function gitFile(path: string): GitFileStatus {
  return { path, xyCode: ' M', status: 'modified', additions: 1, deletions: 1 }
}

function gitStatusReply(sid: string, files: GitFileStatus[]): GitStatusResult {
  return { sessionId: sid, isRepo: true, stagedCount: 0, unstagedCount: files.length, stats: { add: 1, del: 1 }, hasConflict: false, files }
}

describe('watchFileChangesForInvalidation（W19/D-9：ready 帧驱动失效 + overlay 回写）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('token 路径零副作用：text commit 与 accumulating 中间帧不触发 onInvalidate / git.status', async () => {
    vi.useFakeTimers()
    try {
      const chatStore = useChatStore()
      mockGitStatus.mockResolvedValue(gitStatusReply('s1', []))
      chatStore.setMessages('s1', [msg('u1', 'user'), msg('a1', 'assistant')])

      const onInvalidate = vi.fn()
      const unwatch = watchFileChangesForInvalidation(ref('s1'), onInvalidate)
      try {
        // token 路径 1：text commit（数组替换，内容变化）
        chatStore.setMessages('s1', [msg('u1', 'user'), { ...msg('a1', 'assistant'), content: 'partial tok' }])
        await nextTick()
        // token 路径 2：accumulating 中间帧（fileChanges 增长但 status 非 ready）
        chatStore.applyFileChanges('s1', 'a1', [fc('src/a.ts')], 'accumulating', false)
        await nextTick()
        chatStore.applyFileChanges('s1', 'a1', [fc('src/a.ts'), fc('src/b.ts')], 'accumulating', false)
        await nextTick()

        // 越过整个 debounce 窗口：零失效回调、零 RPC（watch 回调允许触发，但零副作用）
        await vi.advanceTimersByTimeAsync(1000)
        expect(onInvalidate).not.toHaveBeenCalled()
        expect(mockGitStatus).not.toHaveBeenCalled()
      } finally {
        unwatch()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('ready 转变触发失效且清单精确：仅该 ready 变更集的 fileChanges（非全消息重扫）', async () => {
    vi.useFakeTimers()
    try {
      const chatStore = useChatStore()
      mockGitStatus.mockResolvedValue(gitStatusReply('s1', []))
      // 历史消息带 fileChanges 但无 ready 状态（如 hydrate 回填）：不得混入失效清单
      chatStore.setMessages('s1', [msg('a0', 'assistant', [fc('stale/old.ts')]), msg('u1', 'user'), msg('a1', 'assistant')])
      await vi.advanceTimersByTimeAsync(0)

      const onInvalidate = vi.fn()
      const unwatch = watchFileChangesForInvalidation(ref('s1'), onInvalidate)
      try {
        // accumulating → ready（turn 终态全集）
        chatStore.applyFileChanges('s1', 'a1', [fc('src/a.ts')], 'accumulating', false)
        await nextTick()
        expect(onInvalidate).not.toHaveBeenCalled()

        chatStore.applyFileChanges('s1', 'a1', [fc('src/a.ts'), fc('src/b.ts')], 'ready', true)
        await nextTick()
        expect(onInvalidate).toHaveBeenCalledTimes(1)
        // 清单 = ready 帧的 fileChanges（精确到本变更集），不含 stale/old.ts
        expect(new Set(onInvalidate.mock.calls[0][1])).toEqual(new Set(['src/a.ts', 'src/b.ts']))
        expect(onInvalidate.mock.calls[0][0]).toBe('s1')

        // ready 后重复 commit（无新 ready）不再失效
        chatStore.setMessages('s1', [msg('a0', 'assistant', [fc('stale/old.ts')]), msg('u1', 'user'), { ...msg('a1', 'assistant'), content: 'done' }])
        await nextTick()
        expect(onInvalidate).toHaveBeenCalledTimes(1)
      } finally {
        unwatch()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('同文件二次修改（第二个 ready 含同 path）再次失效（清单语义优于旧 diff 语义）', async () => {
    vi.useFakeTimers()
    try {
      const chatStore = useChatStore()
      mockGitStatus.mockResolvedValue(gitStatusReply('s1', []))
      chatStore.setMessages('s1', [msg('u1', 'user'), msg('a1', 'assistant')])
      const onInvalidate = vi.fn()
      const unwatch = watchFileChangesForInvalidation(ref('s1'), onInvalidate)
      try {
        // turn 1：改 src/a.ts → ready
        chatStore.applyFileChanges('s1', 'a1', [fc('src/a.ts')], 'ready', true)
        await nextTick()
        expect(onInvalidate).toHaveBeenCalledTimes(1)

        // turn 2：新消息再次改 src/a.ts（旧 lastPaths diff 语义会跳过同 path）
        chatStore.setMessages('s1', [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user'), msg('a2', 'assistant')])
        await nextTick()
        chatStore.applyFileChanges('s1', 'a2', [fc('src/a.ts')], 'ready', true)
        await nextTick()
        expect(onInvalidate).toHaveBeenCalledTimes(2)
        expect(onInvalidate).toHaveBeenLastCalledWith('s1', ['src/a.ts'])
      } finally {
        unwatch()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('debounce 300ms：窗口内两次 ready 只发一次 git.status RPC，回写取最后一次', async () => {
    vi.useFakeTimers()
    try {
      const chatStore = useChatStore()
      const fileTreeStore = useFileTreeStore()
      mockGitStatus.mockResolvedValue(gitStatusReply('s1', [gitFile('src/a.ts')]))
      chatStore.setMessages('s1', [msg('u1', 'user'), msg('a1', 'assistant')])
      const onInvalidate = vi.fn()
      const unwatch = watchFileChangesForInvalidation(ref('s1'), onInvalidate)
      try {
        chatStore.applyFileChanges('s1', 'a1', [fc('src/a.ts')], 'ready', true)
        await nextTick()
        // 第二个 ready 进窗口（新 turn）：debounce 重置，只保留最后一次
        chatStore.setMessages('s1', [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user'), msg('a2', 'assistant')])
        await nextTick()
        chatStore.applyFileChanges('s1', 'a2', [fc('src/b.ts')], 'ready', true)
        await nextTick()

        await vi.advanceTimersByTimeAsync(299)
        expect(mockGitStatus).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(mockGitStatus).toHaveBeenCalledTimes(1)
        expect(mockGitStatus).toHaveBeenCalledWith('s1')

        // 回写生效（W15 联动见下一条，此处先断言 overlay 非空）
        expect(fileTreeStore.getGitStatus('s1', 'src/a.ts')).toBeDefined()
      } finally {
        unwatch()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('overlay 回写联动 W15 预聚合：setGitOverlay 后 getDirChangeCount 反映新 overlay', async () => {
    vi.useFakeTimers()
    try {
      const chatStore = useChatStore()
      const fileTreeStore = useFileTreeStore()
      mockGitStatus.mockResolvedValue(gitStatusReply('s1', [gitFile('src/a.ts'), gitFile('src/lib/b.ts')]))
      chatStore.setMessages('s1', [msg('u1', 'user'), msg('a1', 'assistant')])
      const unwatch = watchFileChangesForInvalidation(ref('s1'), vi.fn())
      try {
        // 回写前无计数
        expect(fileTreeStore.getDirChangeCount('s1', 'src')).toBe(0)

        chatStore.applyFileChanges('s1', 'a1', [fc('src/a.ts')], 'ready', true)
        await nextTick()
        await vi.advanceTimersByTimeAsync(300)

        // overlay 回写 + 祖先目录预聚合（W15：随 setGitOverlay 一次构建）
        expect(fileTreeStore.getGitStatus('s1', 'src/a.ts')).toBeDefined()
        expect(fileTreeStore.getDirChangeCount('s1', 'src')).toBe(2)
        expect(fileTreeStore.getDirChangeCount('s1', 'src/lib')).toBe(1)
      } finally {
        unwatch()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('E9-b 降级：git.status reject 时不写 overlay 不抛；职责一（失效）不依赖 RPC 照常执行', async () => {
    vi.useFakeTimers()
    try {
      const chatStore = useChatStore()
      const fileTreeStore = useFileTreeStore()
      mockGitStatus.mockRejectedValue(new Error('not a repo'))
      chatStore.setMessages('s1', [msg('u1', 'user'), msg('a1', 'assistant')])
      const onInvalidate = vi.fn()
      const unwatch = watchFileChangesForInvalidation(ref('s1'), onInvalidate)
      try {
        chatStore.applyFileChanges('s1', 'a1', [fc('src/a.ts')], 'ready', true)
        await nextTick()
        expect(onInvalidate).toHaveBeenCalledTimes(1) // 职责一先行（本地清单，RPC 无关）

        await vi.advanceTimersByTimeAsync(300)
        expect(mockGitStatus).toHaveBeenCalledTimes(1)
        // overlay 保持旧值（未写入）
        expect(fileTreeStore.getGitStatus('s1', 'src/a.ts')).toBeUndefined()
      } finally {
        unwatch()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('E9-c stale 竞态：debounce 到点前切 session，回写仍落原 sid 分桶（不串新 session）', async () => {
    vi.useFakeTimers()
    try {
      const chatStore = useChatStore()
      const fileTreeStore = useFileTreeStore()
      mockGitStatus.mockResolvedValue(gitStatusReply('s1', [gitFile('src/a.ts')]))
      chatStore.setMessages('s1', [msg('u1', 'user'), msg('a1', 'assistant')])
      chatStore.setMessages('s2', [msg('u1', 'user'), msg('a1', 'assistant')])

      const sidRef = ref('s1')
      const unwatch = watchFileChangesForInvalidation(sidRef, vi.fn())
      try {
        chatStore.applyFileChanges('s1', 'a1', [fc('src/a.ts')], 'ready', true)
        await nextTick()
        // RPC 在途前切到 s2
        sidRef.value = 's2'
        await nextTick()
        await vi.advanceTimersByTimeAsync(300)

        // 回写落捕获的 s1 桶，s2 不受影响
        expect(fileTreeStore.getGitStatus('s1', 'src/a.ts')).toBeDefined()
        expect(fileTreeStore.getGitStatus('s2', 'src/a.ts')).toBeUndefined()
      } finally {
        unwatch()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('W11 触发收敛回归：异 sid 分区替换（含 ready 帧）不触发本 watcher', async () => {
    vi.useFakeTimers()
    try {
      const chatStore = useChatStore()
      mockGitStatus.mockResolvedValue(gitStatusReply('s2', []))
      chatStore.setMessages('s1', [msg('u1', 'user'), msg('a1', 'assistant')])
      chatStore.setMessages('s2', [msg('u1', 'user'), msg('a1', 'assistant')])

      const onInvalidate = vi.fn()
      const unwatch = watchFileChangesForInvalidation(ref('s1'), onInvalidate)
      try {
        // s2 的 ready 帧分区替换：不触发 s1 watcher
        chatStore.applyFileChanges('s2', 'a1', [fc('x.ts')], 'ready', true)
        await nextTick()
        await vi.advanceTimersByTimeAsync(0)
        expect(onInvalidate).not.toHaveBeenCalled()

        // s1 自身 ready 仍正常触发（watcher 未被误杀）
        chatStore.applyFileChanges('s1', 'a1', [fc('src/a.ts')], 'ready', true)
        await nextTick()
        expect(onInvalidate).toHaveBeenCalledTimes(1)
        expect(onInvalidate).toHaveBeenCalledWith('s1', ['src/a.ts'])
        await vi.advanceTimersByTimeAsync(300) // flush 挂起 timer，防跨测试泄漏
      } finally {
        unwatch()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('W19 review Fix-1：debounce 窗口内 deleteSession，timer 到点不重建已销毁 sid 的 overlay 分桶', async () => {
    vi.useFakeTimers()
    try {
      const chatStore = useChatStore()
      const fileTreeStore = useFileTreeStore()
      mockGitStatus.mockResolvedValue(gitStatusReply('s1', [gitFile('src/a.ts')]))
      chatStore.setMessages('s1', [msg('u1', 'user'), msg('a1', 'assistant')])
      const unwatch = watchFileChangesForInvalidation(ref('s1'), vi.fn())
      try {
        chatStore.applyFileChanges('s1', 'a1', [fc('src/a.ts')], 'ready', true)
        await nextTick()

        // debounce 窗口内销毁 session（模拟 useSidebar cleanupSessionState 的销毁序列：
        // fileTree clearSession 删分桶 + chat disposeSession 删 messages 分区）
        fileTreeStore.clearSession('s1')
        chatStore.disposeSession('s1')

        await vi.advanceTimersByTimeAsync(300)
        // RPC 正常发出（守卫在其后），但回写被拦：孤儿 gitOverlay/dirChangeCounts 分桶不重建
        expect(mockGitStatus).toHaveBeenCalledTimes(1)
        expect(fileTreeStore.gitOverlay.has('s1')).toBe(false)
        expect(fileTreeStore.getDirChangeCount('s1', 'src')).toBe(0)
      } finally {
        unwatch()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('sid 切换重置快照：切走再切回，尾部 ready 重新失效（对齐切回全量语义）', async () => {
    vi.useFakeTimers()
    try {
      const chatStore = useChatStore()
      mockGitStatus.mockResolvedValue(gitStatusReply('s1', []))
      chatStore.setMessages('s1', [msg('u1', 'user'), msg('a1', 'assistant')])
      chatStore.setMessages('s2', [msg('u1', 'user'), msg('a1', 'assistant')])

      const sidRef = ref('s1')
      const onInvalidate = vi.fn()
      const unwatch = watchFileChangesForInvalidation(sidRef, onInvalidate)
      try {
        chatStore.applyFileChanges('s1', 'a1', [fc('src/a.ts')], 'ready', true)
        await nextTick()
        await vi.advanceTimersByTimeAsync(300) // flush 首次回写
        expect(onInvalidate).toHaveBeenCalledTimes(1)

        // 切到 s2 再切回 s1：无新帧，但快照重置 → 尾部 ready 重新失效
        sidRef.value = 's2'
        await nextTick()
        expect(onInvalidate).toHaveBeenCalledTimes(1) // s2 无 ready
        sidRef.value = 's1'
        await nextTick()
        expect(onInvalidate).toHaveBeenCalledTimes(2)
        expect(onInvalidate).toHaveBeenLastCalledWith('s1', ['src/a.ts'])
        await vi.advanceTimersByTimeAsync(300) // flush 切回触发的回写
        expect(mockGitStatus).toHaveBeenCalledTimes(2)
      } finally {
        unwatch()
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
