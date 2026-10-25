// project-chips 纯函数单测（remote-use-mobile-v2 §6.12；验收条款 5）。
//
// 锁定：排序源 = SessionSummary（projectId, lastActiveAt）分组取 max 聚合——**禁用
// Project.lastUsedAt 作活跃信号**（R6.2 用户裁决：该字段仅创建时写入、此后不可变，
// 按它排得到创建序）。cwd 派生 = 组内最近会话的 cwd；无会话项目稳定殿后。
import { describe, expect, it } from 'vitest'
import type { Project, SessionSummary } from '@taiji/shared'
import { aggregateProjectChips, DEFAULT_PROJECT_ID } from '../project-chips'

function project(id: string, name: string, lastUsedAt: number): Project {
  return { id, name, lastUsedAt }
}

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    label: overrides.id,
    cwd: `/ws/${overrides.id}`,
    status: 'idle',
    lastActiveAt: 1000,
    ...overrides,
  } as SessionSummary
}

describe('项目 chip 聚合排序（§6.12 / R6.2）', () => {
  it('按组内 max(lastActiveAt) 降序排 chip（活跃序，与 Project.lastUsedAt 无关）', () => {
    // p1 的 lastUsedAt 最大（创建序最新）但会话最旧；p2 相反——排序必须跟会话活跃走
    const projects = [project('p1', '老项目', 999), project('p2', '新项目', 1)]
    const sessions = [
      session({ id: 's1', projectId: 'p1', lastActiveAt: 100 }),
      session({ id: 's2', projectId: 'p2', lastActiveAt: 200 }),
    ]
    const chips = aggregateProjectChips(projects, sessions)
    expect(chips.map((c) => c.projectId)).toEqual(['p2', 'p1'])
    expect(chips[0]?.lastActiveAt).toBe(200)
    expect(chips[1]?.lastActiveAt).toBe(100)
  })

  it('cwd 派生 = 组内最近会话的 cwd（max lastActiveAt 决定，非首条）', () => {
    const projects = [project('p1', '项目一', 1)]
    const sessions = [
      session({ id: 's-old', projectId: 'p1', cwd: '/ws/old', lastActiveAt: 100 }),
      session({ id: 's-new', projectId: 'p1', cwd: '/ws/new', lastActiveAt: 300 }),
      session({ id: 's-mid', projectId: 'p1', cwd: '/ws/mid', lastActiveAt: 200 }),
    ]
    const chips = aggregateProjectChips(projects, sessions)
    expect(chips[0]?.cwd).toBe('/ws/new')
  })

  it('无 projectId 会话归默认项目兜底聚合（D14 语义）', () => {
    const projects: Project[] = []
    const sessions = [session({ id: 's1', projectId: undefined, lastActiveAt: 50 })]
    const chips = aggregateProjectChips(projects, sessions)
    expect(chips[0]?.projectId).toBe(DEFAULT_PROJECT_ID)
    expect(chips[0]?.name).toBe('')
    expect(chips[0]?.cwd).toBe('/ws/s1')
  })

  it('btw 旁路线会话不进聚合（surface 过滤）', () => {
    const projects = [project('p1', '项目一', 1)]
    const sessions = [
      session({ id: 's1', projectId: 'p1' }),
      session({ id: 's-btw', projectId: 'p1', surface: 'btw', lastActiveAt: 9000, cwd: '/ws/btw' }),
    ]
    const chips = aggregateProjectChips(projects, sessions)
    expect(chips[0]?.sessionCount).toBe(1)
    expect(chips[0]?.lastActiveAt).toBe(1000)
  })

  it('清单有但无会话的项目稳定殿后（lastActiveAt=0；有 cwd 缺省 = 手输兜底）', () => {
    const projects = [project('p-empty', '空项目', 500), project('p-active', '活跃项目', 1)]
    const sessions = [session({ id: 's1', projectId: 'p-active', lastActiveAt: 100 })]
    const chips = aggregateProjectChips(projects, sessions)
    expect(chips.map((c) => c.projectId)).toEqual(['p-active', 'p-empty'])
    expect(chips[1]?.cwd).toBeUndefined()
    expect(chips[1]?.sessionCount).toBe(0)
  })

  it('空清单空会话 → 空数组（手输兜底由调用方降级链承接）', () => {
    expect(aggregateProjectChips([], [])).toEqual([])
  })
})
