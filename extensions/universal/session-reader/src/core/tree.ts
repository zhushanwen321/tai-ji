import type { Entry } from './parser.js'

export interface TreeView {
  /** root → leaf 的 id 序列（pi 重开视角的当前对话线，design D-2） */
  leafPath: string[]
  /** forkPointId(=leafPath 上某节点 id) → 该分叉下旁支子树的 entry 数 */
  branches: Map<string, number>
  /** parentId 指向不存在 entry、且自身不在 leafPath 上的 entry id */
  orphans: string[]
}

/**
 * 沿祖先链找最近的、属于 leafSet 的分叉点。
 * 返回 null：祖先链触不到 leafSet（多 root 独立子树）或检测到环。
 *
 * 计算旁支子树大小：对每个非主链 entry 沿祖先链归到最近 leafSet 节点计数（design §3.5
 * 算法 2 步骤 5「按 forkPoint 聚合子树大小」）。如 A→D→E 旁支（D、E 都挂在 forkPoint A
 * 下）count=2，而非只数直接子节点。
 */
function findForkPoint(
  startId: string | null,
  index: Map<string, Entry>,
  leafSet: Set<string>,
): string | null {
  let cur = startId
  const seen = new Set<string>()
  while (cur !== null && index.has(cur) && !leafSet.has(cur)) {
    if (seen.has(cur)) return null // 环防御（坏数据）
    seen.add(cur)
    cur = index.get(cur)!.parentId
  }
  if (cur !== null && leafSet.has(cur)) return cur
  return null
}

/**
 * 按 design §3.5 算法 2 重建 leaf 路径视图。
 *
 * leafId = 末尾往前第一个 parentId !== null 的 entry（D-2 修正：pi 写的 subagent-identity
 * 等元数据 custom entry 是 subagent session 文件尾行，但 parentId=null、非对话流节点；
 * 若直接取文件尾 entry 会让 leafPath 在第一步断链，丢失全部对话 entry）。从 leafId 沿
 * parentId 回溯到 root，遇 parentId 不在索引（断点/孤儿 root）即停。全空 session（仅
 * header + 元数据，无 parentId!==null 的对话节点）→ leafId fallback entries[0]。
 *
 * orphans 只收集「不在 leafPath 上 + parentId 指向不存在」的 entry；leafPath 根自身
 * 即使 parentId 断（断点处）也不重复计入——它已有归属（主链根），符合「孤儿=无归属」语义。
 * design 步骤 6 字面未排除 leafPath 节点，此处按语义实现。
 */
export function buildTreeView(entries: Entry[]): TreeView {
  const leafPath: string[] = []
  const branches = new Map<string, number>()
  const orphans: string[] = []

  if (entries.length === 0) {
    return { leafPath, branches, orphans }
  }

  // 1. id→entry 索引（同 id 后写覆盖先写）
  const index = new Map<string, Entry>()
  for (const e of entries) index.set(e.id, e)

  // 2. leafId = 末尾往前第一个 parentId !== null 的 entry（跳过 subagent-identity 等
  //    尾部元数据 custom；全空 session fallback entries[0]=root header）
  let leafId: string = entries[0].id
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].parentId !== null) {
      leafId = entries[i].id
      break
    }
  }

  // 3. 从 leafId 沿 parentId 回溯到 root
  let cur: string | null = leafId
  const backtrackSeen = new Set<string>()
  while (cur !== null && index.has(cur)) {
    if (backtrackSeen.has(cur)) break // 环防御
    backtrackSeen.add(cur)
    leafPath.unshift(cur)
    cur = index.get(cur)!.parentId
  }

  // 4. leafSet
  const leafSet = new Set(leafPath)

  // 5-6. 旁支计数 + 孤儿收集
  for (const e of entries) {
    if (leafSet.has(e.id)) continue // 主链节点
    const pid = e.parentId
    if (pid === null) continue // 独立 root（多 root 边界）：不在当前 leaf 视图，不计旁支不计孤儿
    if (!index.has(pid)) {
      orphans.push(e.id)
      continue
    }
    const fp = findForkPoint(pid, index, leafSet)
    if (fp !== null) {
      branches.set(fp, (branches.get(fp) ?? 0) + 1)
    }
    // fp===null：祖先链触不到 leafSet（多 root 独立子树），静默忽略
  }

  return { leafPath, branches, orphans }
}
