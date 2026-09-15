/**
 * [W28/D-7.2] projectVisibleRows 投影单测（09 文档 §3.3.2 + §5 D-7.2 验收）。
 *
 * 覆盖：
 * - 等价性：展开/折叠/过滤/showIgnored/nodeStates 组合下，投影产出的 VisibleRow 列表
 *   （顺序 + 缩进深度 + 行类型）与旧递归渲染（FileView.visibleNodes + FileTreeRow 递归）
 *   的节点集合完全一致——reference 实现逐行复刻旧代码语义
 * - 字段映射：changeCount（预聚合 Map）/gitStatus/lineStats/expanded/ignored 正确投影
 * - hint 行：loading/error/empty 三类占位行（旧递归的 nodeStates 子区渲染）
 * - 纯函数幂等：同树同过滤同展开 → 同输出（plan 验收「投影纯函数单测」）
 * - 性能量级：万级节点单次投影产出全部可见行；getNodeState 只按需调用（展开目录数），
 *   不做 per-row 派生（替代旧实现每行 12 computed）
 *
 * 运行：npx vitest run src/__tests__/stores/fileTree-projection.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computed } from 'vue'
import {
  useFileTreeStore,
  projectVisibleRows,
  visibleRowKey,
  type VisibleRow,
  type NodeState,
} from '@/stores/fileTree'
import { nodeMatchesFilter } from '@/composables/logic/file-tree-utils'
import type { FileNode, GitFileStatus } from '@taiji/shared'

beforeEach(() => setActivePinia(createPinia()))

/** 树 fixture：覆盖嵌套展开、空目录、ignored 目录/文件、多顶层节点 */
const TREE: FileNode[] = [
  {
    path: 'src',
    name: 'src',
    type: 'dir',
    children: [
      { path: 'src/a.ts', name: 'a.ts', type: 'file' },
      {
        path: 'src/utils',
        name: 'utils',
        type: 'dir',
        children: [
          { path: 'src/utils/b.ts', name: 'b.ts', type: 'file' },
          { path: 'src/utils/ignored.log', name: 'ignored.log', type: 'file', ignored: true },
        ],
      },
      { path: 'src/empty', name: 'empty', type: 'dir', children: [] },
      {
        path: 'src/ignored-dir',
        name: 'ignored-dir',
        type: 'dir',
        ignored: true,
        children: [{ path: 'src/ignored-dir/x.ts', name: 'x.ts', type: 'file' }],
      },
    ],
  },
  { path: 'README.md', name: 'README.md', type: 'file' },
  {
    path: 'node_modules',
    name: 'node_modules',
    type: 'dir',
    ignored: true,
    children: [{ path: 'node_modules/pkg', name: 'pkg', type: 'dir', children: [] }],
  },
]

/** 行简写（等价性比较用）：kind = 节点类型或 hint 类型 */
interface RowBrief {
  path: string
  depth: number
  kind: string
}

/** reference：逐行复刻旧递归渲染（FileView.visibleNodes 顶层裁 + FileTreeRow 递归）语义 */
function legacyVisibleRows(
  nodes: FileNode[],
  expanded: Set<string>,
  showIgnored: boolean,
  q: string,
  nodeStates: Map<string, NodeState>,
): RowBrief[] {
  const out: RowBrief[] = []
  function walk(list: FileNode[], depth: number): void {
    for (const node of list) {
      out.push({ path: node.path, depth, kind: node.type })
      if (node.type === 'dir' && expanded.has(node.path)) {
        const status = nodeStates.get(node.path)?.status ?? 'unloaded'
        if (status === 'loading') {
          out.push({ path: node.path, depth: depth + 1, kind: 'loading' })
          continue
        }
        if (status === 'error') {
          out.push({ path: node.path, depth: depth + 1, kind: 'error' })
          continue
        }
        if (node.children) {
          const vc = showIgnored ? node.children : node.children.filter((c) => !c.ignored)
          if (vc.length === 0) {
            out.push({ path: node.path, depth: depth + 1, kind: 'empty' })
            continue
          }
          walk(vc, depth + 1)
        }
      }
    }
  }
  let top = showIgnored ? nodes : nodes.filter((n) => !n.ignored)
  if (q) top = top.filter((n) => nodeMatchesFilter(n, q.toLowerCase())) // 旧 FileView 先 trim().toLowerCase()
  walk(top, 0)
  return out
}

/** 用 store 状态驱动投影（与 FileView computed 相同的调用形态：per-session getter 传参） */
function project(store: ReturnType<typeof useFileTreeStore>, sid = 's1'): VisibleRow[] {
  return projectVisibleRows(
    (s) => store.getTree(s),
    (s) => store.getExpanded(s),
    (s) => store.getGitOverlay(s),
    (s) => store.getDirChangeCounts(s),
    store.filterText,
    store.showIgnored,
    sid,
    (s, path) => store.getNodeState(s, path),
  )
}

function briefs(rows: VisibleRow[]): RowBrief[] {
  return rows.map((r) => ({ path: r.path, depth: r.depth, kind: r.hint ?? r.type }))
}

/** 预置树 + 各种展开组合 */
function setupTree(store: ReturnType<typeof useFileTreeStore>, expandedPaths: string[]): void {
  store.setTree('s1', TREE)
  for (const p of expandedPaths) store.addExpanded('s1', p)
}

describe('projectVisibleRows 等价性（旧递归渲染节点集合，顺序 + 缩进深度）', () => {
  const expandedCombos: string[][] = [
    [],
    ['src'],
    ['src', 'src/utils'],
    ['src/utils'], // 父未展开、子展开（rehydrate 边缘态）
    ['src', 'src/empty'],
    ['src', 'src/ignored-dir'],
    ['node_modules'],
    ['src', 'src/utils', 'node_modules', 'src/empty', 'nonexistent'], // 含已删路径（graceful）
  ]
  const filters = ['', 'b', 'README', 'utils', 'zzz_no_match']
  const showIgnoreds = [false, true]
  const nodeStateCombos: Array<Map<string, NodeState>> = [
    new Map(),
    new Map([['src', { status: 'loading' }]]),
    new Map([['src', { status: 'error' }]]),
    new Map([['src/utils', { status: 'loading' }]]),
    new Map([['src', { status: 'invalidated' }]]), // invalidated 展开 → 仍渲旧 children（旧 v-else 分支）
    new Map([['src', { status: 'loading' }], ['src/utils', { status: 'error' }]]),
  ]

  for (const expanded of expandedCombos) {
    for (const q of filters) {
      for (const showIgnored of showIgnoreds) {
        for (const states of nodeStateCombos) {
          it(`等价：expanded=[${expanded.join(',') || '-'}] q='${q}' showIgnored=${showIgnored} states=[${[...states.keys()].join(',') || '-'}]`, () => {
            const store = useFileTreeStore()
            setupTree(store, expanded)
            store.setFilter(q)
            if (showIgnored) store.toggleShowIgnored()
            for (const [path, state] of states) {
              store.setNodeState('s1', path, state)
            }

            const rows = project(store)
            expect(briefs(rows)).toEqual(
              legacyVisibleRows(TREE, new Set(expanded), showIgnored, q, states),
            )
          })
        }
      }
    }
  }
})

describe('projectVisibleRows 字段映射（徽章/角标/行数从分桶投影）', () => {
  it('changeCount 来自预聚合 Map（与 getDirChangeCount 同值），文件行恒 0', () => {
    const store = useFileTreeStore()
    setupTree(store, [])
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/utils/b.ts', xyCode: 'A ', status: 'added' },
      { path: 'README.md', xyCode: 'M ', status: 'modified' },
    ])
    const rows = project(store)
    const src = rows.find((r) => r.path === 'src')!
    expect(src.changeCount).toBe(2) // src/a.ts + src/utils/b.ts
    expect(src.changeCount).toBe(store.getDirChangeCount('s1', 'src'))
    const readme = rows.find((r) => r.path === 'README.md')!
    expect(readme.changeCount).toBe(0) // 文件行不投影目录计数
  })

  it('gitStatus 整对象 + lineStats 映射（tracked → add/del；untracked+size → size；无标注 → undefined）', () => {
    const store = useFileTreeStore()
    store.setTree('s1', [
      { path: 'm.ts', name: 'm.ts', type: 'file' },
      { path: 'u.log', name: 'u.log', type: 'file', size: 30 },
      { path: 'clean.ts', name: 'clean.ts', type: 'file' },
    ])
    store.setGitOverlay('s1', [
      { path: 'm.ts', xyCode: ' M', status: 'modified', additions: 12, deletions: 3 },
      { path: 'u.log', xyCode: '??', status: 'untracked' },
    ])
    const rows = project(store)
    const m = rows.find((r) => r.path === 'm.ts')!
    expect(m.gitStatus?.status).toBe('modified')
    expect(m.lineStats).toEqual({ add: 12, del: 3 })
    const u = rows.find((r) => r.path === 'u.log')!
    expect(u.gitStatus?.status).toBe('untracked')
    expect(u.lineStats).toEqual({ size: 30 })
    const clean = rows.find((r) => r.path === 'clean.ts')!
    expect(clean.gitStatus).toBeUndefined()
    expect(clean.lineStats).toBeUndefined()
  })

  it('expanded/ignored/type/depth 投影正确（含 hint 行 depth = 目录 depth+1）', () => {
    const store = useFileTreeStore()
    setupTree(store, ['src', 'src/utils'])
    store.toggleShowIgnored() // ignored 子项可见，才能断言 ignored 标记投影
    const rows = project(store)
    const src = rows.find((r) => r.path === 'src')!
    expect(src.expanded).toBe(true)
    expect(src.depth).toBe(0)
    const utils = rows.find((r) => r.path === 'src/utils')!
    expect(utils.expanded).toBe(true)
    expect(utils.depth).toBe(1)
    const ignoredDir = rows.find((r) => r.path === 'src/ignored-dir')!
    expect(ignoredDir.ignored).toBe(true)
  })

  it('hint 行：loading/error/empty 三类占位（nodeStates 驱动，depth 为目录 depth+1）', () => {
    const store = useFileTreeStore()
    setupTree(store, ['src', 'src/utils', 'src/empty'])
    store.setNodeState('s1', 'src/utils', { status: 'loading' })
    const rows = project(store)

    const loading = rows.find((r) => r.hint === 'loading')!
    expect(loading.path).toBe('src/utils')
    expect(loading.depth).toBe(2) // src(0) → utils(1) → hint(2)
    expect(loading.type).toBe('dir')

    // src/empty：loaded（默认 unloaded → 无 children 判定？——empty 目录有 children=[] 但需 loaded）
    store.setNodeState('s1', 'src/empty', { status: 'loaded' })
    const rows2 = project(store)
    const empty = rows2.find((r) => r.hint === 'empty')!
    expect(empty.path).toBe('src/empty')
    expect(empty.depth).toBe(2)
  })

  it('hint 行 key 与节点行不冲突（visibleRowKey：hint 加前缀）', () => {
    const store = useFileTreeStore()
    setupTree(store, ['src', 'src/empty'])
    store.setNodeState('s1', 'src/empty', { status: 'loaded' })
    const rows = project(store)
    const keys = rows.map((r) => visibleRowKey(r))
    expect(new Set(keys).size).toBe(keys.length) // 无重复 key（目录行 'src/empty' vs hint 行同 path）
  })

  it('[W28 审查 Fix-1] error hint 行 expanded=true（目录已展开才渲染 hint；点击 = 折叠非重试）', () => {
    const store = useFileTreeStore()
    setupTree(store, ['src'])
    store.setNodeState('s1', 'src', { status: 'error', reason: 'timeout' })
    const rows = project(store)

    const errorHint = rows.find((r) => r.hint === 'error')!
    // 旧递归语义：error hint 只在已展开目录渲染，点击 = 折叠父目录。
    // expanded 恒 true → FileView.onToggleRow 走 collapseNode（expanded:false 会走
    // expandNode → error 态重新发请求，变重试——行为回归）
    expect(errorHint.expanded).toBe(true)
    // 目录行自身展开态不受 hint 影响
    const srcRow = rows.find((r) => r.path === 'src' && !r.hint)!
    expect(srcRow.expanded).toBe(true)
  })
})

describe('projectVisibleRows 纯函数幂等（同树同过滤同展开 → 同输出）', () => {
  it('相同入参两次调用 → 深等输出（零副作用）', () => {
    const store = useFileTreeStore()
    setupTree(store, ['src', 'src/utils'])
    store.setFilter('utils')
    const a = project(store)
    const b = project(store)
    expect(a).toEqual(b)
    // 输出为独立数组（非共享引用——调用方改行不影响下次投影）
    expect(a).not.toBe(b)
    expect(a[0]).not.toBe(b[0])
  })
})

describe('projectVisibleRows 性能量级（万级节点，替代旧 per-row 12 computed）', () => {
  function buildBigTree(fileCount: number): FileNode[] {
    return [
      {
        path: 'big',
        name: 'big',
        type: 'dir',
        children: [
          ...Array.from({ length: fileCount }, (_, i) => ({
            path: `big/f${i}.ts`,
            name: `f${i}.ts`,
            type: 'file' as const,
          })),
          {
            path: 'big/nested',
            name: 'nested',
            type: 'dir',
            children: Array.from({ length: fileCount }, (_, i) => ({
              path: `big/nested/g${i}.ts`,
              name: `g${i}.ts`,
              type: 'file' as const,
            })),
          },
        ],
      },
    ]
  }

  /** 计数版 Map：overlay.get 调用次数（行级 O(1) 的线性性证据，替代墙钟断言） */
  class CountingGetMap<V> extends Map<string, V> {
    getCalls = 0
    override get(key: string): V | undefined {
      this.getCalls += 1
      return super.get(key)
    }
  }

  it('万级可见行单次投影全量产出（10002 行），overlay.get/getNodeState 调用次数线性上界（替代墙钟）', () => {
    const store = useFileTreeStore()
    store.setTree('s1', buildBigTree(10000))
    store.setNodeState('s1', 'big', { status: 'loaded' })
    store.addExpanded('s1', 'big')
    store.setGitOverlay('s1', [
      { path: 'big/f1.ts', xyCode: ' M', status: 'modified' },
      { path: 'big/nested/g2.ts', xyCode: '??', status: 'untracked' },
    ])

    // 操作计数（不做墙钟断言——CI 慢机墙钟不可靠）：
    // - getNodeState 只按已展开目录数调用（loading/error hint 判定），非 per-row
    // - overlay.get 每行至多 2 次（gitStatus 投影 + lineStats），总次数 ≤ 2×行数（线性上界）
    const countingOverlay = new CountingGetMap(store.getGitOverlay('s1'))
    const nodeStateSpy = vi.fn((s: string, p: string) => store.getNodeState(s, p))
    const rows = projectVisibleRows(
      (s) => store.getTree(s),
      (s) => store.getExpanded(s),
      (s) => (s === 's1' ? countingOverlay : store.getGitOverlay(s)),
      (s) => store.getDirChangeCounts(s),
      store.filterText,
      store.showIgnored,
      's1',
      nodeStateSpy,
    )

    expect(rows).toHaveLength(10002) // big + 10000 files + nested 行（nested 未展开仅目录行）
    // 只对已展开目录调用（1 个：'big'），不做 10002 次 per-row 状态读取
    expect(nodeStateSpy).toHaveBeenCalledTimes(1)
    // 行级 O(1)：2×行数 上界证明无 per-row 派生/前缀扫描（每行 gitStatus + lineStats 各一次）
    expect(countingOverlay.getCalls).toBeLessThanOrEqual(rows.length * 2)
  })

  it('getNodeState 只按需调用（展开目录数），不做 per-row 派生（替代旧每行 12 computed 的调用面）', () => {
    const store = useFileTreeStore()
    store.setTree('s1', buildBigTree(10000))
    store.setNodeState('s1', 'big', { status: 'loaded' })
    store.setNodeState('s1', 'big/nested', { status: 'loaded' })
    store.addExpanded('s1', 'big')
    store.addExpanded('s1', 'big/nested')

    const spy = vi.fn((s: string, p: string) => store.getNodeState(s, p))
    const rows = projectVisibleRows(
      (s) => store.getTree(s),
      (s) => store.getExpanded(s),
      (s) => store.getGitOverlay(s),
      (s) => store.getDirChangeCounts(s),
      store.filterText,
      store.showIgnored,
      's1',
      spy,
    )
    expect(rows).toHaveLength(20002) // big + 10000 files + nested + 10000 files，全部展开
    // 只对 2 个已展开目录调用（loading/error hint 判定），不做 20002 次 per-row 状态读取
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('过滤态投影：匹配判定一次 O(节点数)，投影只含命中祖先链（旧递归语义）', () => {
    const store = useFileTreeStore()
    store.setTree('s1', buildBigTree(10000))
    store.setNodeState('s1', 'big', { status: 'loaded' })
    store.setFilter('g5000') // 仅 big/nested/g5000.ts 命中

    // 未展开 → 顶层 big 祖先链保留（1 行，其余顶层节点被裁）
    expect(project(store).map((r) => r.path)).toEqual(['big'])

    // 展开 big（nested 未展开）→ 旧递归语义：顶层命中 → 整棵子树按展开态渲染（不裁中间层）
    store.addExpanded('s1', 'big')
    const rows = project(store)
    expect(rows).toHaveLength(10002) // big + 10000 files + nested

    // 展开 nested → 命中链全部可见（g0..g9999 与命中兄弟全部渲染——旧语义）
    store.addExpanded('s1', 'big/nested')
    const rows2 = project(store)
    expect(rows2).toHaveLength(20002) // 1 + 10000 + 1 + 10000

    // 无匹配 → 空投影
    store.setFilter('zzz_no_match')
    expect(project(store)).toHaveLength(0)
  })
})

describe('visibleRowKey 稳定性', () => {
  it('节点行 key = path；hint 行 key 带类型前缀（跨投影稳定）', () => {
    expect(visibleRowKey({ path: 'a.ts', type: 'file', depth: 0 } as VisibleRow)).toBe('a.ts')
    expect(
      visibleRowKey({ path: 'src', type: 'dir', depth: 1, hint: 'loading' } as VisibleRow),
    ).toBe('hint:loading:src')
  })

  it('[W28 审查 Fix-3] 旧前缀形状的真实路径与 hint 行 key 不撞（hint: 分隔，Windows 禁冒号）', () => {
    // 真实文件路径以旧前缀 '__loading__' 开头（POSIX 合法文件名）vs loading hint 行——新格式隔离
    const realFile = visibleRowKey({ path: '__loading__src', type: 'file', depth: 0 } as VisibleRow)
    const loadingHint = visibleRowKey({ path: 'src', type: 'dir', depth: 1, hint: 'loading' } as VisibleRow)
    expect(realFile).toBe('__loading__src') // 节点行 key 恒为原 path，不带前缀
    expect(loadingHint).toBe('hint:loading:src')
    expect(realFile).not.toBe(loadingHint)

    // 三类 hint 前缀互斥：同 path 不同 hint 类型 key 各异
    const hintKeys = ['loading', 'error', 'empty'].map((h) =>
      visibleRowKey({ path: 'src', type: 'dir', depth: 1, hint: h as VisibleRow['hint'] } as VisibleRow),
    )
    expect(new Set(hintKeys).size).toBe(3)
  })
})

describe('projectVisibleRows 与 store 组合行为（懒加载/目录协议不破坏）', () => {
  it('未加载 children 的展开目录不产出子行（懒加载语义，ADR-0026 不变）', () => {
    const store = useFileTreeStore()
    // 顶层 dir 无 children（unloaded）
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    store.addExpanded('s1', 'src')
    const rows = project(store)
    expect(briefs(rows)).toEqual([{ path: 'src', depth: 0, kind: 'dir' }])
  })

  it('展开态拉取 children 后（setNodeState loaded + merge）→ 新行进入可见列表', () => {
    const store = useFileTreeStore()
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    store.addExpanded('s1', 'src')
    store.setNodeState('s1', 'src', { status: 'loaded' }, [
      { path: 'src/a.ts', name: 'a.ts', type: 'file' },
    ])
    const rows = project(store)
    expect(briefs(rows)).toEqual([
      { path: 'src', depth: 0, kind: 'dir' },
      { path: 'src/a.ts', depth: 1, kind: 'file' },
    ])
  })

  it('clearSession 后投影空（分桶清理）', () => {
    const store = useFileTreeStore()
    setupTree(store, ['src'])
    expect(project(store)).not.toHaveLength(0)
    store.clearSession('s1')
    expect(project(store)).toHaveLength(0)
  })
})

describe('[W28 审查 Fix-2] E7-a 细粒度 getter 分桶（异 sid 更新不触发本 sid 投影重算）', () => {
  it('异 sid overlay 更新不重算本 sid 投影；同 sid 更新重算（split mode 多面板隔离）', () => {
    const store = useFileTreeStore()
    setupTree(store, ['src'])
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/utils/b.ts', xyCode: 'A ', status: 'added' },
    ])

    // 模拟 FileView 的投影 computed（getter 传参形态）
    let recomputes = 0
    const rows = computed(() => {
      recomputes += 1
      return project(store, 's1')
    })
    void rows.value // 首次求值
    expect(recomputes).toBe(1)

    // 异 sid overlay 回写（split mode 另一面板的 git.status）→ 本 sid 投影缓存命中不重算
    store.setGitOverlay('s2', [{ path: 'other.ts', xyCode: ' M', status: 'modified' }])
    expect(rows.value).toBe(rows.value) // 同一数组引用（未 dirty）
    expect(recomputes).toBe(1)

    // 同 sid overlay 更新 → 重算一次（setGitOverlay keyed set 触发本 sid 分桶）
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/utils/b.ts', xyCode: 'A ', status: 'added' },
      { path: 'src/empty/x.ts', xyCode: ' M', status: 'modified' },
    ])
    expect(rows.value).toBe(rows.value)
    expect(recomputes).toBe(2)
  })
})

describe('[W28 审查 Fix-7] 金标准用例（手写期望行序列，不经 reference 生成）', () => {
  it('invalidated 展开目录仍渲染旧 children（hint 判定不吞 children）', () => {
    const store = useFileTreeStore()
    store.setTree('s1', [
      {
        path: 'src',
        name: 'src',
        type: 'dir',
        children: [{ path: 'src/a.ts', name: 'a.ts', type: 'file' }],
      },
    ])
    store.addExpanded('s1', 'src')
    store.setNodeState('s1', 'src', { status: 'invalidated' })
    // invalidated 不是 loading/error → 落到 children 分支，渲旧缓存子行（下次展开重发请求）
    expect(briefs(project(store))).toEqual([
      { path: 'src', depth: 0, kind: 'dir' },
      { path: 'src/a.ts', depth: 1, kind: 'file' },
    ])
  })

  it('loaded 但无 children 的展开目录：不产子行也不产 hint（懒加载盲区：加载完成但未 merge children）', () => {
    const store = useFileTreeStore()
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    store.addExpanded('s1', 'src')
    store.setNodeState('s1', 'src', { status: 'loaded' })
    expect(briefs(project(store))).toEqual([{ path: 'src', depth: 0, kind: 'dir' }])
  })
})
