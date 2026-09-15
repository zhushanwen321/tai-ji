/**
 * ProjectStore 单测（D14，2026-08-04：project 列表迁 runtime projects.json）。
 *
 * 覆盖：
 * - save → load 往返（projects + activeProjectId 持久化）
 * - userOrder 字段 roundtrip（A5：拖拽用户序跨重启不丢，含「未拖动保持无 userOrder」）
 * - 删除的 project 从文件消失（全量替换语义）
 * - 文件损坏 → 空态不抛（INV-1）
 * - flushAll 立即落盘 + 文件内容为 ProjectStoreState 结构
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/project-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ProjectStoreState, Project } from '@taiji/shared'
import { ProjectStore } from '../services/project/project-store.js'

function mkProject(id: string, name: string, lastUsedAt = 0, userOrder?: number): Project {
  return userOrder === undefined ? { id, name, lastUsedAt } : { id, name, lastUsedAt, userOrder }
}

describe('ProjectStore', () => {
  let dir: string
  let store: ProjectStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'projects-'))
    store = new ProjectStore(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('save → load 往返：projects + activeProjectId 都持久化', () => {
    const state: ProjectStoreState = {
      projects: [mkProject('proj-a', 'Alpha'), mkProject('proj-default', '', 0)],
      activeProjectId: 'proj-a',
    }
    store.save(state)
    store.flushAll()

    const reloaded = new ProjectStore(dir)
    const loaded = reloaded.load()
    expect(loaded.projects.map((p) => p.id)).toEqual(['proj-a', 'proj-default'])
    expect(loaded.projects[0]!.name).toBe('Alpha')
    expect(loaded.activeProjectId).toBe('proj-a')
  })

  it('A5 重启持久化：userOrder 随 project 原样 roundtrip（save → flushAll → 新实例 load）', () => {
    // D7 两段式排序的持久化前提：拖拽赋的用户序跨重启不丢（store 层零转换读写，
    // 此处锁 runtime 持久化字节不剥字段）
    const state: ProjectStoreState = {
      projects: [
        mkProject('proj-x1', 'X1', 0, 0),
        mkProject('proj-x2', 'X2', 0, 1),
        mkProject('proj-a', 'Alpha', 500),
      ],
      activeProjectId: 'proj-x1',
    }
    store.save(state)
    store.flushAll()

    const reloaded = new ProjectStore(dir).load()
    expect(reloaded.projects.find((p) => p.id === 'proj-x1')!.userOrder).toBe(0)
    expect(reloaded.projects.find((p) => p.id === 'proj-x2')!.userOrder).toBe(1)
    // 未拖动的自动序项目保持无 userOrder
    expect(reloaded.projects.find((p) => p.id === 'proj-a')!.userOrder).toBeUndefined()
  })

  it('文件内容为 ProjectStoreState 结构（{ projects, activeProjectId }）', () => {
    const state: ProjectStoreState = {
      projects: [mkProject('proj-a', 'Alpha')],
      activeProjectId: 'proj-a',
    }
    store.save(state)
    store.flushAll()

    const raw = JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf-8'))
    expect(Array.isArray(raw.projects)).toBe(true)
    expect(raw.activeProjectId).toBe('proj-a')
    expect(raw.projects[0].id).toBe('proj-a')
  })

  it('全量替换语义：save 后删除的 project 从文件消失', () => {
    store.save({ projects: [mkProject('a', 'A'), mkProject('b', 'B')], activeProjectId: 'a' })
    store.flushAll()
    // 第二次 save 只保留 a（b 被删）
    store.save({ projects: [mkProject('a', 'A')], activeProjectId: 'a' })
    store.flushAll()

    const raw = JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf-8'))
    expect(raw.projects.map((p: Project) => p.id)).toEqual(['a'])
  })

  it('首启无文件 → 空态（不抛）', () => {
    const loaded = store.load()
    expect(loaded.projects).toEqual([])
    expect(loaded.activeProjectId).toBe('')
  })

  it('文件损坏 → 空态不抛（INV-1）', () => {
    writeFileSync(join(dir, 'projects.json'), '{broken json', 'utf-8')
    const loaded = store.load()
    expect(loaded.projects).toEqual([])
  })

  it('非法结构（非 ProjectStoreState）→ 空态不抛', () => {
    writeFileSync(join(dir, 'projects.json'), JSON.stringify([{ id: 'a' }]), 'utf-8')
    const loaded = store.load()
    expect(loaded.projects).toEqual([])
  })

  it('load 触发 WriteBackCache 懒加载（save 后新实例能读到已落盘数据）', () => {
    store.save({ projects: [mkProject('p1', 'One')], activeProjectId: 'p1' })
    store.flushAll()
    const s2 = new ProjectStore(dir)
    const loaded = s2.load()
    expect(loaded.projects).toHaveLength(1)
    expect(loaded.projects[0]!.name).toBe('One')
  })

  it('existsSync 确认文件确实落盘', () => {
    store.save({ projects: [mkProject('p1', 'One')], activeProjectId: 'p1' })
    store.flushAll()
    expect(existsSync(join(dir, 'projects.json'))).toBe(true)
  })
})
