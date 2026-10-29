/**
 * project 数据模型单测（v6 D14 + §6.6① 归一化共享纯函数）。
 *
 * 守护三方共用的领域规则（runtime ProjectStore / renderer project store / core mock
 * 均消费同一实现，禁止复刻副本）：
 * - makeDefaultProject 工厂形状（nameless + lastUsedAt 0 = 稳定殿后）
 * - isDefaultProjectOf 判定（name 空 = 未命名兜底聚合）
 * - normalizeProjectState 归一化：默认项缺失补插头部（按 id 占用判定，改名不双插）+
 *   activeProjectId 失配回退链「nameless 默认项 → 首个 → DEFAULT_PROJECT_ID」
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/project-model.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PROJECT_ID,
  makeDefaultProject,
  isDefaultProjectOf,
  normalizeProjectState,
  type ProjectStoreState,
} from '../project.js'

describe('makeDefaultProject', () => {
  it('工厂形状：DEFAULT_PROJECT_ID + nameless + lastUsedAt 0（稳定殿后初始键）', () => {
    expect(makeDefaultProject()).toEqual({ id: 'proj-default', name: '', lastUsedAt: 0 })
    expect(DEFAULT_PROJECT_ID).toBe('proj-default')
  })
})

describe('isDefaultProjectOf', () => {
  it('name 空 = 默认项目；name 非空 = 命名项目（改名后的默认项不再判默认）', () => {
    expect(isDefaultProjectOf({ name: '' })).toBe(true)
    expect(isDefaultProjectOf({ name: '多仓重构' })).toBe(false)
  })
})

describe('normalizeProjectState', () => {
  it('默认项在位 + activeProjectId 匹配 → 原样返回（不重排、不补插）', () => {
    const state: ProjectStoreState = {
      projects: [
        { id: 'proj-default', name: '', lastUsedAt: 0 },
        { id: 'proj-a', name: 'A', lastUsedAt: 100 },
      ],
      activeProjectId: 'proj-a',
    }
    expect(normalizeProjectState(state)).toEqual(state)
  })

  it('默认项缺失（legacy/外部编辑）→ 按 id 占用判定补插头部；改名不产生双插', () => {
    const state: ProjectStoreState = {
      projects: [{ id: 'proj-a', name: 'A', lastUsedAt: 100 }],
      activeProjectId: 'proj-a',
    }
    const normalized = normalizeProjectState(state)
    expect(normalized.projects[0]).toEqual({ id: 'proj-default', name: '', lastUsedAt: 0 })
    expect(normalized.projects.filter((p) => p.id === DEFAULT_PROJECT_ID)).toHaveLength(1)
    // 输入不被原地修改（纯函数：复制后补插）
    expect(state.projects).toHaveLength(1)
  })

  it('activeProjectId 失配 + nameless 默认项在位 → 回退默认项', () => {
    const state: ProjectStoreState = {
      projects: [
        { id: 'proj-default', name: '', lastUsedAt: 0 },
        { id: 'proj-a', name: 'A', lastUsedAt: 100 },
      ],
      activeProjectId: 'proj-ghost',
    }
    expect(normalizeProjectState(state).activeProjectId).toBe('proj-default')
  })

  it('activeProjectId 失配 + 默认项已被改名（无 nameless）→ 回退首个项目', () => {
    const state: ProjectStoreState = {
      projects: [
        { id: 'proj-default', name: '改名后的默认组', lastUsedAt: 0 },
        { id: 'proj-b', name: 'B', lastUsedAt: 50 },
      ],
      activeProjectId: 'proj-ghost',
    }
    expect(normalizeProjectState(state).activeProjectId).toBe('proj-default')
  })

  it('空 projects → 补插默认项且 active 回退 DEFAULT_PROJECT_ID', () => {
    const normalized = normalizeProjectState({ projects: [], activeProjectId: '' })
    expect(normalized.projects).toEqual([makeDefaultProject()])
    expect(normalized.activeProjectId).toBe('proj-default')
  })
})
