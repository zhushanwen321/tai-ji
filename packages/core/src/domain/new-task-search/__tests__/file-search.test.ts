/**
 * useFileSearch 单测（IF6，core 版）。
 *
 * 覆盖 plan TC-14：load 缓存命中不调端口、load 未命中拉取+store.set、fileCandidates reject
 * 降级空数组不缓存不抛、debouncedLoad 300ms debounce（fake timers + cancel）、
 * setupInvalidation——watchFileChanges(sid, cb) 被调 + cb 内 store.invalidate + unwatch 解绑。
 * 端口 vi.fn() 注入；真实 createFileSearchStore。
 * 环境：vitest node。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { FileNode } from '@taiji/shared'
import { createFileSearchStore } from '../file-search-store'
import { useFileSearch } from '../file-search'
import type { FileCandidatesPort, FileChangeWatchPort } from '../search-ports'

function fileNode(path: string, name?: string): FileNode {
  return { path, name: name ?? path.split('/').pop() ?? path, type: 'file' }
}

/** 构造 useFileSearch 依赖（端口 mock） */
function makeDeps(overrides?: {
  fileCandidates?: FileCandidatesPort['getFileCandidates'] & ReturnType<typeof vi.fn>
  watchFileChanges?: FileChangeWatchPort['watchFileChanges'] & ReturnType<typeof vi.fn>
}) {
  const fileSearchStore = createFileSearchStore()
  const fileCandidates: FileCandidatesPort['getFileCandidates'] =
    overrides?.fileCandidates ?? vi.fn(async (_sessionId: string): Promise<FileNode[]> => [])
  const watchFileChanges: FileChangeWatchPort['watchFileChanges'] =
    overrides?.watchFileChanges ?? vi.fn((_sid: string, _cb: (sid: string) => void) => () => {})
  return {
    fileSearchStore,
    deps: { fileSearchStore, fileCandidates, watchFileChanges },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TC-14a: load 缓存命中不调 fileCandidates', () => {
  it('store 已有缓存 → 直返缓存，端口零调用', async () => {
    const { fileSearchStore, deps } = makeDeps()
    fileSearchStore.set('s1', [fileNode('a.ts')])
    const { load } = useFileSearch(deps)

    const nodes = await load('s1')
    expect(nodes).toHaveLength(1)
    expect(deps.fileCandidates).not.toHaveBeenCalled()
  })

  it('未命中 → fileCandidates 拉取 + store.set + 返回', async () => {
    const { fileSearchStore, deps } = makeDeps()
    ;(deps.fileCandidates as ReturnType<typeof vi.fn>).mockResolvedValue([fileNode('b.ts')])
    const { load } = useFileSearch(deps)

    const nodes = await load('s1')
    expect(deps.fileCandidates).toHaveBeenCalledWith('s1')
    expect(fileSearchStore.get('s1')).toHaveLength(1)
    expect(nodes[0].name).toBe('b.ts')
  })

  it('fileCandidates reject → 降级空数组不缓存不抛', async () => {
    const { fileSearchStore, deps } = makeDeps()
    ;(deps.fileCandidates as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'))
    const { load } = useFileSearch(deps)

    const nodes = await load('s1')
    expect(nodes).toEqual([])
    expect(fileSearchStore.get('s1')).toBeUndefined() // 失败不缓存
  })
})

describe('TC-14b: debouncedLoad 300ms', () => {
  it('连续 2 次（间隔 0）→ fileCandidates 调 1 次（debounce 合并）', async () => {
    vi.useFakeTimers()
    try {
      const { deps } = makeDeps()
      ;(deps.fileCandidates as ReturnType<typeof vi.fn>).mockResolvedValue([fileNode('a.ts')])
      const { debouncedLoad } = useFileSearch(deps)

      debouncedLoad('s1', () => {})
      debouncedLoad('s1', () => {})
      expect(deps.fileCandidates).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(300)
      expect(deps.fileCandidates).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancel 清 timer → 不触发请求', async () => {
    vi.useFakeTimers()
    try {
      const { deps } = makeDeps()
      const { debouncedLoad } = useFileSearch(deps)

      const cancel = debouncedLoad('s1', () => {})
      cancel()
      await vi.advanceTimersByTimeAsync(300)
      expect(deps.fileCandidates).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('TC-14c: setupInvalidation', () => {
  it('watchFileChanges(sid, cb) 被调 + cb 触发 store.invalidate', async () => {
    const { fileSearchStore, deps } = makeDeps()
    let capturedCb: ((sid: string) => void) | undefined
    const watchMock = vi.fn((_sid: string, cb: (sid: string) => void) => {
      capturedCb = cb
      return () => {}
    })
    const { setupInvalidation } = useFileSearch({ ...deps, watchFileChanges: watchMock })

    fileSearchStore.set('s1', [fileNode('a.ts')])
    const sidRef = ref('s1')
    const unwatch = setupInvalidation(sidRef)

    expect(watchMock).toHaveBeenCalledWith('s1', expect.any(Function))
    // 模拟文件变更 → cb 触发 invalidate
    capturedCb!('s1')
    expect(fileSearchStore.get('s1')).toBeUndefined()

    unwatch()
  })

  it('sid 切换重订阅 + 旧 unwatch 被调', async () => {
    const { deps } = makeDeps()
    const unwatch1 = vi.fn()
    const unwatch2 = vi.fn()
    const watchMock = vi
      .fn()
      .mockReturnValueOnce(unwatch1)
      .mockReturnValueOnce(unwatch2)
    const { setupInvalidation } = useFileSearch({ ...deps, watchFileChanges: watchMock })

    const sidRef = ref('s1')
    const unwatch = setupInvalidation(sidRef)
    expect(watchMock).toHaveBeenCalledTimes(1)

    sidRef.value = 's2'
    await Promise.resolve() // flush watch
    expect(watchMock).toHaveBeenCalledTimes(2)
    expect(watchMock).toHaveBeenLastCalledWith('s2', expect.any(Function))

    unwatch()
    expect(unwatch1).toHaveBeenCalled()
  })
})
