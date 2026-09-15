/**
 * fileTreeStore —— 文件树前端状态容器（#3，D-021 目标结构）。
 *
 * [HISTORICAL D-021] 状态存储模型重构（⑥execution-plan W3 强制对齐项）：
 * 骨架是旧结构（nodeStatus 光杆 string + per-path），已按 §3 签名表 D-021 重写：
 * 1. nodeStates: Map<sid, Map<path, NodeState>>（对象化 NodeState，非光杆 string）+ per-session 分桶
 * 2. gitOverlay: Map<sid, Map<path, GitFileStatus>>（per-session 分桶，与 tree 同生命周期）
 * 3. setNodeState 单一原子入口：同步 set status(+reason) 与结构 merge children，消除双源不一致
 *
 * 4 facet per-session（D-019 rehydrate）：tree / expandedPaths / nodeStates / gitOverlay 都按 sessionId
 * 分桶，切回 session 时展开态恢复（graceful 跳过已删路径）。
 *
 * [W15/D-7.1] dirChangeCounts 是 gitOverlay 的预聚合派生（sid → dirPath → count，随 setGitOverlay
 * 一次构建）——非独立权威源，getDirChangeCount 行级读取 O(1)。
 *
 * [W28/D-7.2] projectVisibleRows 是唯一「树 → 可见行」投影点（纯函数，SSOT 仍是 tree）：
 * FileView 用 computed 包裹它，FileTreeRow 改纯行组件收 VisibleRow——树形递归渲染改为
 * 扁平可见行 + virtua 虚拟滚动（消除万级目录展开的全量 DOM 挂载）。4 facet 结构不变，
 * 13 个非测试消费方零迁移（R-21 排查结论见 W28 汇报）。
 *
 * [K-9 反哺] 跨 store 编排在 composable 层：store 暴露 invalidate 接口，不自行 subscribe chat store
 * （stores 间禁止互相 import，见 sidebar.ts:4 约束）。
 *
 * stores 间禁止互相 import（与 chat.ts/sidebar.ts 一致）。
 */
import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { defineStore } from 'pinia'
import type { FileNode, GitFileStatus } from '@taiji/shared'
import { findNodeByPath, nodeMatchesFilter } from '@/composables/logic/file-tree-utils'

/** 节点加载态（②§5 状态机：5 态） */
type LoadStatus = 'unloaded' | 'loading' | 'loaded' | 'error' | 'invalidated'

/**
 * 节点状态对象（D-021：加载态复合对象，单一权威源）。
 * - status：5 态加载状态机
 * - reason：仅 error 态非空，来自 WS error envelope 的 code（routeInbound 透传到 Error.code）
 */
export interface NodeState {
  status: LoadStatus
  /** error code（如 'out_of_cwd' / 'permission_denied' / 'timeout'），仅 status='error' 时有意义 */
  reason?: string
}

/** Map<path, T> 的 per-session 分桶类型别名 */
type PathMap<T> = Map<string, T>
/** Map<sessionId, Map<path, T>> 的 per-session 分桶类型别名（nodeStates/gitOverlay 用） */
type SessionPathMap<T> = Map<string, PathMap<T>>
/** Map<sessionId, T> 的 per-session 单值分桶（tree 用：每 session 一个 FileNode[]） */
type SessionMap<T> = Map<string, T>

/** [W2] 文件行数结构：tracked 改动 {add/del}，untracked 降级 {size}，无数据 null */
interface LineStats {
  add?: number
  del?: number
  size?: number
}

/**
 * [W28/D-7.2] 可见行数据结构（09 文档 §3.3.2 定案 + 审查修正）。
 * 供 virtua 虚拟滚动消费的扁平行——树仍是 SSOT，本行是渲染投影：
 * depth/expanded/changeCount/gitStatus/lineStats 全部在投影时预计算，
 * 替代旧递归 FileTreeRow 的 per-row computed（旧实现每行 12 个 computed）。
 *
 * hint 字段为审查修正扩展（09 文档草案未建模，代码现实要求保留）：
 * 旧递归组件对「已展开目录」按 nodeStates 渲染 loading/error/empty 三类子区占位行，
 * 扁平化后必须显式建模，否则展开在途/空目录的 UI 反馈丢失（行为回归）。
 */
export interface VisibleRow {
  /** 节点相对路径（SSOT key；hint 行 = 所属目录 path） */
  path: string
  /** 显示名（hint 行为空串） */
  name: string
  /** 节点类型（hint 行恒 'dir'，实际渲染走 hint 分支） */
  type: 'file' | 'dir'
  /** 缩进层级（投影时算好，替代递归 depth prop） */
  depth: number
  /** 目录是否展开（从 expandedPaths 投影） */
  expanded: boolean
  /** 目录子树改动数（从预聚合 Map 投影，替代 per-row computed） */
  changeCount: number
  /** 文件角标（从 gitOverlay 投影） */
  gitStatus?: GitFileStatus
  /** 行数 +N −M（投影时算好） */
  lineStats?: LineStats
  ignored: boolean
  /**
   * 子区占位行标记（非节点行）：'loading'（展开在途）/ 'error'（展开失败）/
   * 'empty'（已加载空目录或全部被 showIgnored 过滤）。仅 hint 行非空。
   */
  hint?: 'loading' | 'error' | 'empty'
}

/**
 * 子区占位行 key 前缀（防与真实节点 path 冲突，v-for :key 用）。
 * [W28 审查 Fix-3] 旧前缀（'__loading__' 等）与真实相对路径理论碰撞（POSIX 允许文件名以
 * '__loading__' 开头）——改 'hint:{type}:' 分隔形式：Windows 文件名禁止 ':'，POSIX 相对
 * 路径含 ':' 需 cwd 下真实存在 'hint:loading:…' 前缀文件，碰撞概率趋零（理论残留仅此场景）。
 */
const HINT_KEY_PREFIX: Record<NonNullable<VisibleRow['hint']>, string> = {
  loading: 'hint:loading:',
  error: 'hint:error:',
  empty: 'hint:empty:',
}

/**
 * [W28/D-7.2] 扁平行 v-for 稳定 key：hint 行加类型前缀（与目录行 path 同值时防冲突），
 * 节点行直接用 path。hint 行跨投影稳定（同目录同态 → 同 key），无插删错位。
 */
export function visibleRowKey(row: VisibleRow): string {
  return row.hint ? `${HINT_KEY_PREFIX[row.hint]}${row.path}` : row.path
}

/**
 * [W28/D-7.2] 唯一「树 → 可见行」投影点（纯函数，零副作用）。
 *
 * 语义 = 旧递归渲染（FileView.visibleNodes 顶层裁 + FileTreeRow 递归子行）的逐行等价：
 * - 顶层：showIgnored 过滤 + filterText 命中判定（nodeMatchesFilter，仅祖先链保留）；
 * - 子层：showIgnored 过滤，展开目录 DFS 展开（懒加载——未加载 children 不产出子行）；
 * - 已展开目录按 nodeStates 渲染 loading/error/empty 占位行（与旧递归一致）。
 *
 * E7-a 更新策略：调用方（FileView）用 computed 包裹，依赖分桶后的细粒度 getter——
 * 展开/折叠/过滤/overlay 变化各触发一次全量重投影（O(可见行)，懒加载下是「已加载」子集）。
 * [W28 审查 Fix-2] gitOverlay/dirChangeCounts 同样走 per-session getter 传参（与 getExpanded
 * 同款分桶）：computed 只追踪本 sid 分桶 key，异 sid overlay 回写（split mode 多面板
 * git.status）不触发本 sid 重投影——依赖 store 侧 setGitOverlay/rebuildDirChangeCounts
 * 用响应式 Map 的 keyed set（不再整体替换外层 ref）。
 *
 * @param getTree 取 session 树（computed 内读 store.getTree 触发响应式）
 * @param getExpanded 取 session 展开态 Set
 * @param getGitOverlay 取 session overlay 分桶（无则 undefined；与 getExpanded 同款细粒度分桶）
 * @param getDirChangeCounts 取 session 预聚合分桶（同 getGitOverlay）
 * @param filterText 过滤关键词（原始输入，内部 trim/lower）
 * @param showIgnored 是否显示忽略项
 * @param sid 目标 session
 * @param getNodeState [审查修正扩展] 取节点加载态（hint 行判定需要；文档草案签名未含）
 */
export function projectVisibleRows(
  getTree: (sid: string) => FileNode[] | undefined,
  getExpanded: (sid: string) => Set<string>,
  getGitOverlay: (sid: string) => Map<string, GitFileStatus> | undefined,
  getDirChangeCounts: (sid: string) => Map<string, number> | undefined,
  filterText: string,
  showIgnored: boolean,
  sid: string,
  getNodeState: (sid: string, path: string) => NodeState,
): VisibleRow[] {
  const nodes = getTree(sid)
  if (!nodes) return []

  const q = filterText.trim().toLowerCase()
  const expanded = getExpanded(sid)
  const overlay = getGitOverlay(sid)
  const counts = getDirChangeCounts(sid)

  const rows: VisibleRow[] = []

  function lineStatsOf(node: FileNode): LineStats | undefined {
    const git = overlay?.get(node.path)
    if (!git) return undefined
    if (git.additions !== undefined || git.deletions !== undefined) {
      return { add: git.additions, del: git.deletions }
    }
    if (git.status === 'untracked' && node.size !== undefined) {
      return { size: node.size }
    }
    return undefined
  }

  function makeRow(node: FileNode, depth: number): VisibleRow {
    return {
      path: node.path,
      name: node.name,
      type: node.type,
      depth,
      expanded: node.type === 'dir' && expanded.has(node.path),
      changeCount: node.type === 'dir' ? (counts?.get(node.path) ?? 0) : 0,
      gitStatus: overlay?.get(node.path),
      lineStats: lineStatsOf(node),
      ignored: node.ignored ?? false,
    }
  }

  function makeHint(
    hint: NonNullable<VisibleRow['hint']>,
    dirPath: string,
    depth: number,
  ): VisibleRow {
    // path 保持目录 path（旧 testid `file-tree-loading-<dirPath>` 语义不变）；
    // v-for key 由消费方用 rowKey(row)（hint 前缀 + path）保证与目录行不冲突。
    // [W28 审查 Fix-1] expanded 恒 true：hint 行只在目录已展开时渲染（walk 的
    // expanded.has 分支内），目录必然在 expandedPaths 中。旧递归版 error 行点击 =
    // 折叠（hint 只在已展开目录渲染）；expanded:false 会让 FileView.onToggleRow 走
    // expandNode → error 态重新发请求（重试而非折叠）——true 恢复旧折叠语义。
    return {
      path: dirPath,
      name: '',
      type: 'dir',
      depth,
      expanded: true,
      changeCount: 0,
      ignored: false,
      hint,
    }
  }

  function walk(list: FileNode[], depth: number): void {
    for (const node of list) {
      rows.push(makeRow(node, depth))
      if (node.type !== 'dir' || !expanded.has(node.path)) continue
      // 已展开目录的子区：按 nodeStates 渲染占位行或 DFS 子行（与旧递归 FileTreeRow 等价）
      const status = getNodeState(sid, node.path).status
      if (status === 'loading') {
        rows.push(makeHint('loading', node.path, depth + 1))
        continue
      }
      if (status === 'error') {
        rows.push(makeHint('error', node.path, depth + 1))
        continue
      }
      if (node.children) {
        const visibleChildren = showIgnored
          ? node.children
          : node.children.filter((c) => !c.ignored)
        if (visibleChildren.length === 0) {
          rows.push(makeHint('empty', node.path, depth + 1))
          continue
        }
        walk(visibleChildren, depth + 1)
      }
    }
  }

  let topLevel = showIgnored ? nodes : nodes.filter((n) => !n.ignored)
  if (q) topLevel = topLevel.filter((n) => nodeMatchesFilter(n, q))
  walk(topLevel, 0)
  return rows
}

export const useFileTreeStore = defineStore('fileTree', () => {
  // ── State（4 facet per-session + showIgnored + selectedPath）──

  /** 文件树缓存：sessionId → 顶层 FileNode[]（dir 的 children 随展开 merge 进去） */
  const tree: Ref<SessionMap<FileNode[]>> = ref(new Map())
  /** 展开态：sessionId → Set<相对路径>（D-019 rehydrate） */
  const expandedPaths: Ref<Map<string, Set<string>>> = ref(new Map())
  /** 节点加载态（D-021 对象化 + per-session）：sessionId → path → NodeState */
  const nodeStates: Ref<SessionPathMap<NodeState>> = ref(new Map())
  /** git 标注 overlay（D-012 树/标注分离 + D-021 per-session）：sessionId → path → GitFileStatus */
  const gitOverlay: Ref<SessionPathMap<GitFileStatus>> = ref(new Map())
  /**
   * [W15/D-7.1] 目录改动数预聚合：sessionId → dirPath → count。
   * 随 setGitOverlay 一次 O(n) 构建（n=改动文件数），行级读取 O(1)——
   * 消除旧 getDirChangeCount 的 per-directory-row O(n) 前缀扫描（D 个目录行 × N 个改动文件 = O(D×N)）。
   */
  const dirChangeCounts: Ref<Map<string, Map<string, number>>> = ref(new Map())
  /** 显示忽略项开关（D-020，默认 false） */
  const showIgnored = ref(false)
  /** 当前选中文件路径（全局，非 per-session——单选焦点） */
  const selectedPath = ref<string | null>(null)
  /** 过滤关键词（#4 文件名过滤） */
  const filterText = ref('')

  // ── Getters（per-session 读，默认参数便于 composable 调用）──

  /** 取 session 的文件树（无缓存返回 undefined） */
  function getTree(sessionId: string): FileNode[] | undefined {
    return tree.value.get(sessionId)
  }

  /** 取 session 的展开路径集合（无则空 Set） */
  function getExpanded(sessionId: string): Set<string> {
    return expandedPaths.value.get(sessionId) ?? new Set()
  }

  /** 取节点加载态（无记录默认 unloaded） */
  function getNodeState(sessionId: string, path: string): NodeState {
    return nodeStates.value.get(sessionId)?.get(path) ?? { status: 'unloaded' }
  }

  /** 取节点的 git 标注（无则 undefined） */
  function getGitStatus(sessionId: string, path: string): GitFileStatus | undefined {
    return gitOverlay.value.get(sessionId)?.get(path)
  }

  /**
   * [W28 审查 Fix-2] 取 session 的 git overlay 分桶（无则 undefined）。
   * per-session 细粒度 getter（与 getExpanded 同款分桶模式）：投影 computed 经它读本
   * sid 分桶，只追踪该 key——setGitOverlay 的 keyed set 不会让异 sid 更新触发本 sid 重投影。
   */
  function getGitOverlay(sessionId: string): Map<string, GitFileStatus> | undefined {
    return gitOverlay.value.get(sessionId)
  }

  /**
   * [W28 审查 Fix-2] 取 session 的目录改动数预聚合分桶（无则 undefined）。
   * 同 getGitOverlay 的细粒度分桶语义。
   */
  function getDirChangeCounts(sessionId: string): Map<string, number> | undefined {
    return dirChangeCounts.value.get(sessionId)
  }

  /**
   * [W15/D-7.1] 预聚合目录改动数——随 setGitOverlay 一次 O(n) 构建（n=改动文件数）。
   * 语义与旧 per-row 前缀扫描（path.startsWith(`${dirPath}/`)) 等价：
   * 对每个改动文件 path 'a/b/c.ts'，其所有非空祖先目录（'a'、'a/b'）计数 +1；
   * 根目录（dirPath=''，旧算法 prefix='/' 不匹配相对路径）不计数。
   * [W28 审查 Fix-2] 用响应式 Map 的 keyed set（不整体替换外层 ref）——投影 computed
   * 只追踪本 sid 分桶 key，异 sid 更新不触发重投影（E7-a 细粒度分桶的前提）。
   */
  function rebuildDirChangeCounts(sessionId: string): void {
    const overlay = gitOverlay.value.get(sessionId)
    const counts = new Map<string, number>()
    if (overlay) {
      for (const path of overlay.keys()) {
        // 沿 '/' 切出全部祖先目录（不含 path 自身），逐级 +1
        let idx = path.indexOf('/')
        while (idx !== -1) {
          const dir = path.slice(0, idx)
          // 空 dir（path 以 '/' 开头）防御性跳过，保持与旧前缀语义一致
          if (dir) counts.set(dir, (counts.get(dir) ?? 0) + 1)
          idx = path.indexOf('/', idx + 1)
        }
      }
    }
    // keyed set：仅本 sid 的响应式触发（dirChangeCounts 是 ref(新 Map()) 深响应式代理）
    dirChangeCounts.value.set(sessionId, counts)
  }

  /**
   * [W2/W15] 统计目录子树内改动文件数（用于目录行的改动数徽章）。
   * [W15/D-7.1] 改读预聚合 Map（O(1)）——精确前缀语义（'src/'，兄弟目录 'src-other/' 不误算）
   * 由 rebuildDirChangeCounts 的祖先目录投影保证。空 overlay / session 不存在 → 0。
   */
  function getDirChangeCount(sessionId: string, dirPath: string): number {
    return dirChangeCounts.value.get(sessionId)?.get(dirPath) ?? 0
  }

  /** 当前选中文件节点（computed，跨 tree 查找——selectedPath 全局，tree per-session） */
  const currentFile: ComputedRef<FileNode | null> = computed(() => {
    if (!selectedPath.value) return null
    // 在所有 session 的 tree 中查找选中路径对应的节点（扁平搜索，selectedPath 全局焦点）
    for (const nodes of tree.value.values()) {
      const found = findNodeByPath(nodes, selectedPath.value)
      if (found) return found
    }
    return null
  })

  // ── Actions ──

  /** 设置 session 的文件树（首加载或刷新） */
  function setTree(sessionId: string, nodes: FileNode[]): void {
    tree.value.set(sessionId, nodes)
    // 触发响应式（Map.set 不自动触发，需重新赋值或用 reactive——这里用 new Map 替换触发）
    tree.value = new Map(tree.value)
  }

  /**
   * [D-021] 设置节点加载态——单一原子入口。
   * 同步 set status(+reason) 与结构 merge children（展开成功时），消除「status=loaded 但 children=undefined」
   * 双源不一致态。失败时 set error + reason（code 来自 WS error envelope）。
   *
   * @param sessionId session id
   * @param path 节点相对路径
   * @param state 新状态（status + 可选 reason）
   * @param children 展开成功时的子节点（仅 status='loaded' 时 merge 进 tree；其它状态忽略）
   */
  function setNodeState(
    sessionId: string,
    path: string,
    state: NodeState,
    children?: FileNode[],
  ): void {
    // 1. 更新 nodeStates（per-session 分桶）
    let sessionStates = nodeStates.value.get(sessionId)
    if (!sessionStates) {
      sessionStates = new Map()
      nodeStates.value.set(sessionId, sessionStates)
    }
    sessionStates.set(path, state)
    nodeStates.value = new Map(nodeStates.value)

    // 2. loaded 态时 merge children 进 tree（原子同 step，消除双源不一致）
    if (state.status === 'loaded' && children) {
      mergeChildren(sessionId, path, children)
    }
  }

  /**
   * merge 子节点到 tree 的指定路径下（展开成功的结构更新）。
   * 顶层 path='' 时直接替换 session 的顶层 nodes。
   */
  function mergeChildren(sessionId: string, path: string, children: FileNode[]): void {
    if (path === '') {
      // 顶层：直接 set
      tree.value.set(sessionId, children)
      tree.value = new Map(tree.value)
      return
    }
    const nodes = tree.value.get(sessionId)
    if (!nodes) return
    // 在树中找到 path 对应的 dir 节点，设置其 children
    const target = findNodeByPath(nodes, path)
    if (target && target.type === 'dir') {
      target.children = children
      tree.value = new Map(tree.value) // 触发响应式
    }
  }

  /** 记录展开路径（D-019 rehydrate） */
  function addExpanded(sessionId: string, path: string): void {
    let set = expandedPaths.value.get(sessionId)
    if (!set) {
      set = new Set()
      expandedPaths.value.set(sessionId, set)
    }
    set.add(path)
    expandedPaths.value = new Map(expandedPaths.value)
  }

  /** 移除展开路径（折叠） */
  function removeExpanded(sessionId: string, path: string): void {
    expandedPaths.value.get(sessionId)?.delete(path)
    expandedPaths.value = new Map(expandedPaths.value)
  }

  /** 设置选中文件路径 */
  function selectFile(path: string | null): void {
    selectedPath.value = path
  }

  /** 设置 git overlay（per-session，git.status 变化时只更新 overlay 不触发树重建） */
  function setGitOverlay(sessionId: string, statuses: GitFileStatus[]): void {
    const map: PathMap<GitFileStatus> = new Map()
    for (const s of statuses) {
      map.set(s.path, s)
    }
    // [W28 审查 Fix-2] keyed set 替代整体替换外层 ref：gitOverlay 是 ref(深响应式 Map)，
    // set(sid) 只触发本 sid key 的追踪者——投影 computed（经 getGitOverlay(sid) 读本分桶）
    // 不被异 sid 回写触发（split mode 多面板 git.status 互不干扰，E7-a 细粒度分桶前提）。
    gitOverlay.value.set(sessionId, map)
    // [W15/D-7.1] 同步预聚合目录改动数（后续 loadTree 之外的 setGitOverlay 调用点天然携带新计数）
    rebuildDirChangeCounts(sessionId)
  }

  /** 设置过滤关键词（#4） */
  function setFilter(text: string): void {
    filterText.value = text
  }

  /** 切换 showIgnored 开关（D-020） */
  function toggleShowIgnored(): void {
    showIgnored.value = !showIgnored.value
  }

  /**
   * [K-9] 跨 store 失效接口——标相关节点 loaded→invalidated（D-017）。
   * 供 composable 派发（useFileTree.invalidateOnFileChanges watch chat store 后调此），
   * store 不自行监听（stores 间禁止 import）。
   */
  function invalidate(sessionId: string, paths: string[]): void {
    const sessionStates = nodeStates.value.get(sessionId)
    if (!sessionStates) return
    for (const p of paths) {
      const current = sessionStates.get(p)
      if (current?.status === 'loaded') {
        sessionStates.set(p, { status: 'invalidated' })
      }
    }
    nodeStates.value = new Map(nodeStates.value)
  }

  /** 清理 session 的所有状态（session 删除时） */
  function clearSession(sessionId: string): void {
    tree.value.delete(sessionId)
    expandedPaths.value.delete(sessionId)
    nodeStates.value.delete(sessionId)
    gitOverlay.value.delete(sessionId)
    dirChangeCounts.value.delete(sessionId)
    tree.value = new Map(tree.value)
    expandedPaths.value = new Map(expandedPaths.value)
    nodeStates.value = new Map(nodeStates.value)
    gitOverlay.value = new Map(gitOverlay.value)
    dirChangeCounts.value = new Map(dirChangeCounts.value)
  }

  return {
    // state
    tree,
    expandedPaths,
    nodeStates,
    gitOverlay,
    // [W28/D-7.2] dirChangeCounts 暴露（投影 computed 的依赖源；9 文档「投影函数 + dirChangeCounts 暴露」）
    dirChangeCounts,
    showIgnored,
    selectedPath,
    filterText,
    // getters
    currentFile,
    getTree,
    getExpanded,
    getNodeState,
    getGitStatus,
    getGitOverlay,
    getDirChangeCounts,
    getDirChangeCount,
    // actions
    setTree,
    setNodeState,
    mergeChildren,
    addExpanded,
    removeExpanded,
    selectFile,
    setGitOverlay,
    setFilter,
    toggleShowIgnored,
    invalidate,
    clearSession,
  }
})
