/**
 * fileTreeStore 单测（#3，D-021 结构 + T2.2/T2.6/T2.7/T2.8/T2.8b/T2.9/T4.6）。
 *
 * 验证 D-021 目标结构（非骨架旧结构）：
 * - nodeStates: Map<sid, Map<path, NodeState>>（对象化 + per-session）
 * - gitOverlay: Map<sid, Map<path, GitFileStatus>>（per-session）
 * - setNodeState 原子入口（status + children merge 同 step）
 *
 * 覆盖用例：
 * - T2.2 loaded 复用缓存（setTree + getTree）
 * - T2.6 overlay 先到后挂载（setGitOverlay 独立于 tree）
 * - T2.7 git.status 失败 → overlay 空（不调 setGitOverlay，树仍在）
 * - T2.8/T2.8b 角标全态（setGitOverlay M/A/D/U/untracked）
 * - T2.9 非 git 仓库（isRepo=false 不设 overlay）
 * - T4.6 invalidated 态过滤 graceful（invalidate 不报错）
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/stores/fileTree.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFileTreeStore } from '@/stores/fileTree'
import type { GitFileStatus } from '@xyz-agent/shared'

beforeEach(() => setActivePinia(createPinia()))

describe('fileTreeStore D-021 结构', () => {
  it('nodeStates 是 Map<sid, Map<path, NodeState>>（对象化 + per-session）', () => {
    const store = useFileTreeStore()
    store.setNodeState('s1', 'src', { status: 'loading' })
    store.setNodeState('s1', 'src', { status: 'loaded' })
    store.setNodeState('s2', 'lib', { status: 'error', reason: 'out_of_cwd' })

    // per-session 分桶
    expect(store.nodeStates.get('s1')?.get('src')).toEqual({ status: 'loaded' })
    expect(store.nodeStates.get('s2')?.get('lib')).toEqual({ status: 'error', reason: 'out_of_cwd' })
    // session 隔离
    expect(store.nodeStates.get('s1')?.get('lib')).toBeUndefined()
    expect(store.nodeStates.get('s2')?.get('src')).toBeUndefined()
  })

  it('getNodeState 无记录默认 unloaded', () => {
    const store = useFileTreeStore()
    expect(store.getNodeState('s1', 'any')).toEqual({ status: 'unloaded' })
  })

  it('setNodeState loaded + children 原子 merge（消除双源不一致）', () => {
    const store = useFileTreeStore()
    // 顶层 setTree 先建树
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    // setNodeState loaded 同 step merge children
    const children = [{ path: 'src/index.ts', name: 'index.ts', type: 'file' }]
    store.setNodeState('s1', 'src', { status: 'loaded' }, children)

    // tree 中 src 的 children 已 merge（不是 undefined）
    const tree = store.getTree('s1')!
    expect(tree[0].children).toEqual(children)
    // nodeStates 同步 loaded
    expect(store.getNodeState('s1', 'src').status).toBe('loaded')
  })

  it('setNodeState error 带 reason（来自 WS error code）', () => {
    const store = useFileTreeStore()
    store.setNodeState('s1', 'secret', { status: 'error', reason: 'permission_denied' })
    expect(store.getNodeState('s1', 'secret')).toEqual({ status: 'error', reason: 'permission_denied' })
  })
})

describe('fileTreeStore T2.2 缓存复用', () => {
  it('setTree 后 getTree 返回缓存', () => {
    const store = useFileTreeStore()
    const nodes = [{ path: 'a.ts', name: 'a.ts', type: 'file' }]
    store.setTree('s1', nodes)
    expect(store.getTree('s1')).toEqual(nodes)
  })

  it('未缓存的 session getTree 返回 undefined', () => {
    const store = useFileTreeStore()
    expect(store.getTree('nope')).toBeUndefined()
  })
})

describe('fileTreeStore T2.6/T2.7/T2.8/T2.9 git overlay', () => {
  it('T2.6 setGitOverlay 独立于 tree（overlay 先到后挂载）', () => {
    const store = useFileTreeStore()
    // overlay 先设，tree 未设
    store.setGitOverlay('s1', [{ path: 'src/x.ts', xyCode: ' M', status: 'modified' }])
    expect(store.getGitStatus('s1', 'src/x.ts')?.status).toBe('modified')
    // tree 后设，overlay 不丢
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    expect(store.getGitStatus('s1', 'src/x.ts')?.status).toBe('modified')
  })

  it('T2.8/T2.8b 角标全态（M/A/D/U/untracked）', () => {
    const store = useFileTreeStore()
    const statuses: GitFileStatus[] = [
      { path: 'm.ts', xyCode: ' M', status: 'modified' },
      { path: 'a.ts', xyCode: 'A ', status: 'added' },
      { path: 'd.ts', xyCode: ' D', status: 'deleted' },
      { path: 'u.ts', xyCode: 'UU', status: 'unmerged' },
      { path: 'untracked.ts', xyCode: '??', status: 'untracked' },
    ]
    store.setGitOverlay('s1', statuses)
    for (const s of statuses) {
      expect(store.getGitStatus('s1', s.path)?.status).toBe(s.status)
    }
  })

  it('T2.7/T2.9 非 git 仓库 → 不调 setGitOverlay，getGitStatus 返回 undefined', () => {
    const store = useFileTreeStore()
    // 模拟 git.status isRepo=false → composable 不调 setGitOverlay
    store.setTree('s1', [{ path: 'x.ts', name: 'x.ts', type: 'file' }])
    expect(store.getGitStatus('s1', 'x.ts')).toBeUndefined()
    // 树仍渲染
    expect(store.getTree('s1')).toHaveLength(1)
  })

  it('gitOverlay per-session 分桶', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [{ path: 'a.ts', xyCode: ' M', status: 'modified' }])
    store.setGitOverlay('s2', [{ path: 'b.ts', xyCode: 'A ', status: 'added' }])
    expect(store.getGitStatus('s1', 'a.ts')?.status).toBe('modified')
    expect(store.getGitStatus('s2', 'a.ts')).toBeUndefined()
  })
})

describe('fileTreeStore T4.6 invalidate graceful', () => {
  it('invalidate loaded → invalidated（不报错）', () => {
    const store = useFileTreeStore()
    store.setNodeState('s1', 'src', { status: 'loaded' })
    store.invalidate('s1', ['src'])
    expect(store.getNodeState('s1', 'src').status).toBe('invalidated')
  })

  it('invalidate 未 loaded 的节点不变（只标 loaded→invalidated）', () => {
    const store = useFileTreeStore()
    store.setNodeState('s1', 'src', { status: 'loading' })
    store.invalidate('s1', ['src'])
    expect(store.getNodeState('s1', 'src').status).toBe('loading')
  })

  it('invalidate 不存在的 session graceful（不报错）', () => {
    const store = useFileTreeStore()
    expect(() => store.invalidate('nope', ['any'])).not.toThrow()
  })
})

describe('fileTreeStore W2 getDirChangeCount（目录改动文件数徽章）', () => {
  it('统计 dirPath 子树内改动文件数（path 以 dirPath/ 开头）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/b.ts', xyCode: 'A ', status: 'added' },
      { path: 'README.md', xyCode: 'M ', status: 'modified' },
    ])
    // dirPath='src' → 'src/a.ts' + 'src/b.ts' = 2
    expect(store.getDirChangeCount('s1', 'src')).toBe(2)
  })

  it('空 overlay / 不存在的 session → 0', () => {
    const store = useFileTreeStore()
    expect(store.getDirChangeCount('s1', 'src')).toBe(0)
  })

  it('嵌套子树也算（前缀匹配 dirPath/，含深层路径）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/utils/c.ts', xyCode: ' M', status: 'modified' },
      { path: 'README.md', xyCode: 'M ', status: 'modified' },
    ])
    // dirPath='src' → 'src/a.ts' + 'src/utils/c.ts' = 2（深层也匹配 'src/' 前缀）
    expect(store.getDirChangeCount('s1', 'src')).toBe(2)
  })

  it('兄弟同名前缀不误算（只算精确 dirPath/ 前缀，不算 src-other/）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src-other/b.ts', xyCode: ' M', status: 'modified' },
    ])
    // 'src-other/b.ts' 不应算进 'src/' 前缀（兄弟目录，非子树）
    expect(store.getDirChangeCount('s1', 'src')).toBe(1)
  })

  it('无改动 → 0（dirPath 子树下无匹配条目）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'README.md', xyCode: 'M ', status: 'modified' },
    ])
    expect(store.getDirChangeCount('s1', 'src')).toBe(0)
  })
})

describe('fileTreeStore W15/D-7.1 徽章预聚合', () => {
  /**
   * reference 实现 = 旧算法（setGitOverlay 前 per-row O(n) 前缀扫描），
   * 用于行为等价断言：预聚合后各目录计数与旧算法一致。
   */
  function legacyDirChangeCount(paths: string[], dirPath: string): number {
    const prefix = `${dirPath}/`
    return paths.filter((p) => p.startsWith(prefix)).length
  }

  it('行为等价：同 overlay 下各目录计数与旧前缀扫描算法一致', () => {
    const store = useFileTreeStore()
    const paths = [
      'src/a.ts',
      'src/b.ts',
      'src/utils/c.ts',
      'src/utils/deep/d.ts',
      'src-other/e.ts',
      'README.md',
      'docs/legacy/x.md',
      // [W15 审查] git status porcelain 默认把 untracked 目录折叠为带尾斜杠一条（'newdir/'），
      // 两种算法都应把目录自身计入 newdir（legacy：startsWith('newdir/') 命中自身；
      // 预聚合：首个 '/' 前缀即 'newdir'），父链无额外影响。
      'newdir/',
    ]
    store.setGitOverlay('s1', paths.map((p) => ({ path: p, xyCode: ' M', status: 'modified' })))

    // 覆盖：命中目录 / 嵌套目录 / 深层链 / 兄弟前缀 / 根（''）/ 无命中目录 / 文件路径入参 / 尾斜杠目录
    const dirs = [
      '',
      'src',
      'src/utils',
      'src/utils/deep',
      'src-other',
      'docs',
      'docs/legacy',
      'nonexistent',
      'README.md',
      'newdir',
    ]
    for (const dir of dirs) {
      expect(store.getDirChangeCount('s1', dir)).toBe(legacyDirChangeCount(paths, dir))
    }
  })

  it('O(1) 读取：getDirChangeCount 不触发 overlay 遍历（keys spy 零调用）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/utils/b.ts', xyCode: ' M', status: 'modified' },
    ])

    // spy 预聚合完成后 overlay Map 的迭代入口——O(1) 路径不应触发任何遍历
    const overlayMap = store.gitOverlay.get('s1')!
    const keysSpy = vi.spyOn(overlayMap, 'keys')
    const valuesSpy = vi.spyOn(overlayMap, 'values')
    const entriesSpy = vi.spyOn(overlayMap, 'entries')
    const forEachSpy = vi.spyOn(overlayMap, 'forEach')

    // 多次行级读取（模拟多个目录行渲染）
    for (let i = 0; i < 10; i++) {
      store.getDirChangeCount('s1', 'src')
      store.getDirChangeCount('s1', 'src/utils')
    }
    expect(store.getDirChangeCount('s1', 'src')).toBe(2)

    expect(keysSpy).not.toHaveBeenCalled()
    expect(valuesSpy).not.toHaveBeenCalled()
    expect(entriesSpy).not.toHaveBeenCalled()
    expect(forEachSpy).not.toHaveBeenCalled()
  })

  it('setGitOverlay 覆盖更新 → 预聚合重建（新计数替换旧计数）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/b.ts', xyCode: ' M', status: 'modified' },
    ])
    expect(store.getDirChangeCount('s1', 'src')).toBe(2)

    // overlay 被新状态覆盖（如 ready 回写 / 重拉），计数跟随重建而非累加
    store.setGitOverlay('s1', [{ path: 'lib/c.ts', xyCode: ' M', status: 'modified' }])
    expect(store.getDirChangeCount('s1', 'src')).toBe(0)
    expect(store.getDirChangeCount('s1', 'lib')).toBe(1)
  })

  it('clearSession 清理预聚合分桶', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [{ path: 'src/a.ts', xyCode: ' M', status: 'modified' }])
    expect(store.getDirChangeCount('s1', 'src')).toBe(1)
    store.clearSession('s1')
    expect(store.getDirChangeCount('s1', 'src')).toBe(0)
  })

  it('预聚合 per-session 分桶互不串扰', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [{ path: 'src/a.ts', xyCode: ' M', status: 'modified' }])
    store.setGitOverlay('s2', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/b.ts', xyCode: ' M', status: 'modified' },
    ])
    expect(store.getDirChangeCount('s1', 'src')).toBe(1)
    expect(store.getDirChangeCount('s2', 'src')).toBe(2)
  })
})

describe('fileTreeStore 展开态 rehydrate', () => {
  it('addExpanded/getExpanded per-session', () => {
    const store = useFileTreeStore()
    store.addExpanded('s1', 'src')
    store.addExpanded('s1', 'lib')
    expect(store.getExpanded('s1')).toEqual(new Set(['src', 'lib']))
    expect(store.getExpanded('s2')).toEqual(new Set())
  })

  it('removeExpanded 折叠', () => {
    const store = useFileTreeStore()
    store.addExpanded('s1', 'src')
    store.removeExpanded('s1', 'src')
    expect(store.getExpanded('s1').has('src')).toBe(false)
  })

  it('clearSession 清理所有状态', () => {
    const store = useFileTreeStore()
    store.setTree('s1', [])
    store.setNodeState('s1', 'x', { status: 'loaded' })
    store.setGitOverlay('s1', [])
    store.addExpanded('s1', 'x')
    store.clearSession('s1')
    expect(store.getTree('s1')).toBeUndefined()
    expect(store.nodeStates.has('s1')).toBe(false)
  })
})
