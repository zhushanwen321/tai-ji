/**
 * ProjectStore 单测（D14，2026-08-04：project 列表迁 runtime projects.json；
 * 写通道命令化 connection-datasync-ssot §6.6 后，写路径 = 命令通道）。
 *
 * 覆盖：
 * - 命令 → load 往返（projects + activeProjectId 持久化）
 * - 删除的 project 从文件消失（命令路径 cache 清空重建语义）
 * - 文件损坏 / 非法结构 / 首启无文件 → 兜底默认项不抛（INV-1 + §6.6① 归一化）
 * - flushAll 立即落盘 + 文件内容为 ProjectStoreState 结构
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/project-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Project } from '@taiji/shared'
import { ProjectStore } from '../services/project/project-store.js'

/** projects.json 磁盘形态（与 persistToFile 写入结构对齐；revision 由 store 维护）。 */
interface RawFileState {
  projects: Project[]
  activeProjectId: string
  revision?: number
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

  it('命令 → load 往返：projects + activeProjectId 都持久化', async () => {
    await store.createProject('Alpha', 0)
    await store.createProject('Beta', 1)
    store.flushAll()

    const reloaded = new ProjectStore(dir)
    const loaded = reloaded.load()
    // ensureInvariants 补插默认项（name 空）在头部；锚定 = 最后创建项
    expect(loaded.projects.map((p) => p.name)).toEqual(['', 'Alpha', 'Beta'])
    expect(loaded.activeProjectId).toBe(loaded.projects.find((p) => p.name === 'Beta')?.id)
  })

  it('文件内容为 ProjectStoreState 结构（{ projects, activeProjectId }）', async () => {
    await store.createProject('Alpha', 0)
    store.flushAll()

    const raw = JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf-8')) as RawFileState
    expect(Array.isArray(raw.projects)).toBe(true)
    expect(raw.projects.map((p) => p.name)).toEqual(['', 'Alpha'])
    expect(raw.activeProjectId).toBe(raw.projects.find((p) => p.name === 'Alpha')?.id)
  })

  it('删除的 project 从文件消失（命令路径 cache 清空重建语义）', async () => {
    await store.createProject('A', 0)
    const b = await store.createProject('B', 1)
    store.flushAll()
    await store.removeProject(b.state.projects.find((p) => p.name === 'B')!.id, 2)
    store.flushAll()

    const raw = JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf-8')) as RawFileState
    expect(raw.projects.map((p) => p.name)).toEqual(['', 'A'])
  })

  it('首启无文件 → 归一化兜底默认项（不抛）', () => {
    const loaded = store.load()
    expect(loaded.projects.map((p) => p.id)).toEqual(['proj-default'])
    expect(loaded.activeProjectId).toBe('proj-default')
    expect(store.getRevision()).toBe(0)
  })

  it('文件损坏 → 隔离后空态兜底默认项，不抛（INV-1）', () => {
    writeFileSync(join(dir, 'projects.json'), '{broken json', 'utf-8')
    const loaded = store.load()
    expect(loaded.projects.map((p) => p.id)).toEqual(['proj-default'])
  })

  it('非法结构（非 ProjectStoreState）→ 空态兜底默认项，不抛', () => {
    writeFileSync(join(dir, 'projects.json'), JSON.stringify([{ id: 'a' }]), 'utf-8')
    const loaded = store.load()
    expect(loaded.projects.map((p) => p.id)).toEqual(['proj-default'])
  })

  it('load 触发 WriteBackCache 懒加载（命令落盘后新实例能读到已落盘数据）', async () => {
    await store.createProject('One', 0)
    store.flushAll()
    const s2 = new ProjectStore(dir)
    const loaded = s2.load()
    expect(loaded.projects.some((p) => p.name === 'One')).toBe(true)
  })

  it('existsSync 确认文件确实落盘', async () => {
    await store.createProject('One', 0)
    store.flushAll()
    expect(existsSync(join(dir, 'projects.json'))).toBe(true)
  })
})
