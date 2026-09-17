/**
 * useFileSearch 单测（IF6，core 版）。
 *
 * 覆盖：load 直调 fileCandidates 返回、fileCandidates reject 降级空数组不抛、
 * debouncedLoad 300ms debounce（fake timers + cancel）。
 * 无缓存（缓存治理 U1 1-3 退役）：缓存命中/失效语义用例随 fileSearchStore 退役删除。
 * 端口 vi.fn() 注入。
 * 环境：vitest node。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { FileNode } from '@taiji/shared'
import { useFileSearch } from '../file-search'
import type { FileCandidatesPort } from '../search-ports'

function fileNode(path: string, name?: string): FileNode {
  return { path, name: name ?? path.split('/').pop() ?? path, type: 'file' }
}

/** 构造 useFileSearch 依赖（端口 mock） */
function makeDeps(overrides?: {
  fileCandidates?: FileCandidatesPort['getFileCandidates'] & ReturnType<typeof vi.fn>
}) {
  const fileCandidates: FileCandidatesPort['getFileCandidates'] =
    overrides?.fileCandidates ?? vi.fn(async (_sessionId: string): Promise<FileNode[]> => [])
  return {
    fileCandidates,
    deps: { fileCandidates },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('load 直读（无缓存）', () => {
  it('load 调 fileCandidates 并返回结果', async () => {
    const { deps } = makeDeps()
    ;(deps.fileCandidates as ReturnType<typeof vi.fn>).mockResolvedValue([fileNode('b.ts')])
    const { load } = useFileSearch(deps)

    const nodes = await load('s1')
    expect(deps.fileCandidates).toHaveBeenCalledWith('s1')
    expect(nodes[0].name).toBe('b.ts')
  })

  it('fileCandidates reject → 降级空数组不抛', async () => {
    const { deps } = makeDeps()
    ;(deps.fileCandidates as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'))
    const { load } = useFileSearch(deps)

    const nodes = await load('s1')
    expect(nodes).toEqual([])
  })
})

describe('debouncedLoad 300ms', () => {
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
