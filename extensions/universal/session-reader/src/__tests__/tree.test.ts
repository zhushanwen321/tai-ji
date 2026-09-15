import { describe, it, expect } from 'vitest'
import { buildTreeView } from '../core/tree.js'
import type { Entry } from '../core/parser.js'

/** 构造最小 Entry（tree.ts 只消费 type/id/parentId，其余字段省略） */
function e(id: string, parentId: string | null): Entry {
  return { type: 'message', id, parentId }
}

describe('buildTreeView', () => {
  it('线性链：leafPath 含全部 id，branches/orphans 空', () => {
    const entries = [e('A', null), e('B', 'A'), e('C', 'B')]
    const t = buildTreeView(entries)

    expect(t.leafPath).toEqual(['A', 'B', 'C'])
    expect(t.branches.size).toBe(0)
    expect(t.orphans).toEqual([])
  })

  it('单分叉：旁支子树按 forkPoint 聚合（D+E 归 A，count=2）', () => {
    // 主链 A→B→C，旁支 A→D→E；C 放最后 → leafId=C
    const entries = [e('A', null), e('B', 'A'), e('D', 'A'), e('E', 'D'), e('C', 'B')]
    const t = buildTreeView(entries)

    expect(t.leafPath).toEqual(['A', 'B', 'C'])
    expect(t.branches.size).toBe(1)
    expect(t.branches.get('A')).toBe(2)
    expect(t.orphans).toEqual([])
  })

  it('多级分叉：深层旁支沿祖先链归到 leafPath 上的 forkPoint', () => {
    // 主链 A→B→C→D，旁支 B→X→Y→Z；D 放最后 → leafId=D
    const entries = [
      e('A', null), e('B', 'A'),
      e('X', 'B'), e('Y', 'X'), e('Z', 'Y'),
      e('C', 'B'), e('D', 'C'),
    ]
    const t = buildTreeView(entries)

    expect(t.leafPath).toEqual(['A', 'B', 'C', 'D'])
    // X/Y/Z 全部沿祖先链回到 forkPoint=B → count=3
    expect(t.branches.get('B')).toBe(3)
    expect(t.orphans).toEqual([])
  })

  it('多个 forkPoint：旁支挂在 leafPath 不同节点上各自计数', () => {
    // 主链 A→B→C→D，旁支挂 A（A→X）和挂 C（C→Y）；D 放最后 → leafId=D
    const entries = [e('A', null), e('X', 'A'), e('B', 'A'), e('C', 'B'), e('Y', 'C'), e('D', 'C')]
    const t = buildTreeView(entries)

    expect(t.leafPath).toEqual(['A', 'B', 'C', 'D'])
    expect(t.branches.get('A')).toBe(1)
    expect(t.branches.get('C')).toBe(1)
    expect(t.orphans).toEqual([])
  })

  it('孤儿：parentId 指向不存在 → 进 orphans；leafPath 在断点停', () => {
    // A 是 leafPath 根但 parentId 断（MISSING_A 不在 index）→ leafPath 在 A 处停
    // X 非 leafPath 且 parentId 断 → 孤儿
    // B=leafId（最后），B.parentId=A
    const entries = [e('A', 'MISSING_A'), e('X', 'MISSING_X'), e('B', 'A')]
    const t = buildTreeView(entries)

    // 回溯 B→A→MISSING_A(不在 index) 停
    expect(t.leafPath).toEqual(['A', 'B'])
    // A 在 leafPath 上（断点根，有归属）→ 不重复计入 orphans
    expect(t.orphans).toEqual(['X'])
    expect(t.branches.size).toBe(0)
  })

  it('leafId = entries 最后一条的 id（D-2 语义）：同样节点不同顺序 → 不同 leafPath', () => {
    const ordered = [e('A', null), e('B', 'A'), e('C', 'B'), e('D', 'C')] // leafId=D
    const swapped = [e('A', null), e('B', 'A'), e('D', 'C'), e('C', 'B')] // leafId=C，D 变旁支

    const t1 = buildTreeView(ordered)
    const t2 = buildTreeView(swapped)

    expect(t1.leafPath).toEqual(['A', 'B', 'C', 'D'])
    expect(t2.leafPath).toEqual(['A', 'B', 'C'])
    // swapped 里 D 挂在 C（leafPath 末端）下，成旁支
    expect(t2.branches.get('C')).toBe(1)
  })

  it('空 entries：返回空视图', () => {
    const t = buildTreeView([])
    expect(t.leafPath).toEqual([])
    expect(t.branches.size).toBe(0)
    expect(t.orphans).toEqual([])
  })

  it('多 root 独立子树：触不到 leafPath 的 entry 不计入 branches/orphans', () => {
    // 主链 R→A（leafId=A），另有独立 root X→Y（X.parentId=null，与主链无连接）
    const entries = [e('R', null), e('X', null), e('Y', 'X'), e('A', 'R')]
    const t = buildTreeView(entries)

    expect(t.leafPath).toEqual(['R', 'A'])
    // X 是独立 root（parentId=null）→ 跳过；Y 触不到 leafPath → 静默忽略
    expect(t.branches.size).toBe(0)
    expect(t.orphans).toEqual([])
  })

  it('subagent-identity 尾行（parentId=null）不劫持 leafId：跳过取末尾对话节点', () => {
    // 模拟 subagent session：header A → message B → message C（对话链），尾行 identity sa-x（parentId=null）
    const entries = [e('A', null), e('B', 'A'), e('C', 'B'), e('sa-x', null)]
    const t = buildTreeView(entries)
    // leafId 跳过 sa-x（parentId=null），取 C（末尾 parentId!==null）→ leafPath 含完整对话链
    expect(t.leafPath).toEqual(['A', 'B', 'C'])
    // sa-x parentId=null → 独立 root，不计旁支不计孤儿
    expect(t.branches.size).toBe(0)
    expect(t.orphans).toEqual([])
  })

  it('全空 session（仅 header + 元数据 custom，无 parentId!==null 对话节点）→ leafId fallback entries[0]', () => {
    const entries = [e('A', null), e('sa-x', null)]
    const t = buildTreeView(entries)
    // 全 parentId=null → leafId fallback entries[0]=A → leafPath=[A]
    expect(t.leafPath).toEqual(['A'])
    expect(t.branches.size).toBe(0)
    expect(t.orphans).toEqual([])
  })
})
