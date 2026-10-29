/**
 * ProjectStore 命令通道测试（connection-datasync-ssot §6.6/u6a）。
 *
 * 真 store + mkdtemp 临时目录（fs-guard 白名单 = tmpdir 自建自删），锚定：
 * - revision 水位：存量无 revision 文件按 0 读（P-4）、首写补 1、命令 +1、失配拒绝
 * - 串行队列：并发到达依序执行（受控 promise 构造——后条携带前条执行后的 revision，
 *   通过校验即证明前条已完整执行；拒绝不阻断后继）
 * - 归一化（§6.6① 迁入）：load 读时修复仅修返回视图不改盘（前后文件字节一致）；
 *   命令路径随命令落盘一并承载修复（不产生第二次写盘）
 * - 语义拒绝：默认项保护 / 目标不存在 / 空名（renderer addProject 等行为对齐）
 *
 * 运行命令：cd packages/runtime && npx vitest run src/services/project
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, ProjectCommandError } from './project-store.js'
import type { Project, ProjectStoreState } from '@taiji/shared'

const DEFAULT_PROJECT_ID = 'proj-default'

let tmpRoot = ''

/** 每用例独立临时 configDir（写删都在 tmpdir 白名单内）。 */
function newStore(): { store: ProjectStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'u6a-project-store-'))
  tmpRoot = dir
  return { store: new ProjectStore(dir), dir }
}

function fixtureFile(dir: string, state: Partial<ProjectStoreState> & { revision?: number }): string {
  const path = join(dir, 'projects.json')
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8')
  return path
}

function readFile(path: string): string {
  return readFileSync(path, 'utf-8')
}

function expectCommandRejection(p: Promise<unknown>, code: string): Promise<void> {
  return expect(p).rejects.toMatchObject({ code } satisfies Partial<ProjectCommandError>)
}

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    tmpRoot = ''
  }
})

// ── revision 水位（§6.6：文件写入代数，存量兼容 P-4） ─────────────────

describe('ProjectStore revision 水位', () => {
  it('存量无 revision 文件按 0 读、首写补 1 落盘（P-4 fixture）', async () => {
    const { store, dir } = newStore()
    const path = fixtureFile(dir, {
      projects: [{ id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 }],
      activeProjectId: DEFAULT_PROJECT_ID,
    })

    expect(store.getRevision()).toBe(0)
    const reply = await store.createProject('first', 0)
    expect(reply.revision).toBe(1)
    store.flushAll()

    const onDisk = JSON.parse(readFile(path)) as { revision?: number }
    expect(onDisk.revision).toBe(1)
  })

  it('带 revision 的存量文件按文件值读，命令以该值为基线校验', async () => {
    const { store, dir } = newStore()
    fixtureFile(dir, {
      projects: [{ id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 }],
      activeProjectId: DEFAULT_PROJECT_ID,
      revision: 5,
    })

    expect(store.getRevision()).toBe(5)
    await expectCommandRejection(store.createProject('stale', 4), 'project_revision_mismatch')
    const reply = await store.createProject('fresh', 5)
    expect(reply.revision).toBe(6)
  })

  it('revision 失配拒绝且状态与水位不变；匹配执行后 +1', async () => {
    const { store } = newStore()

    await expectCommandRejection(store.createProject('stale', 5), 'project_revision_mismatch')
    expect(store.getRevision()).toBe(0)
    expect(store.load().projects.some((p) => p.name === 'stale')).toBe(false)

    const ok = await store.createProject('fresh', 0)
    expect(ok.revision).toBe(1)

    // 过时窗口：并发双写形态（第二条仍携带旧水位 0）→ 拒绝
    await expectCommandRejection(store.createProject('second', 0), 'project_revision_mismatch')
    expect(store.getRevision()).toBe(1)
  })

  it('命令落盘带 revision 字段（一次写 → 文件内 revision +1）', async () => {
    const { store, dir } = newStore()
    const path = join(dir, 'projects.json')

    await store.createProject('a', 0)
    expect(store.getRevision()).toBe(1)
    store.flushAll()

    const onDisk = JSON.parse(readFile(path)) as { revision?: number }
    expect(onDisk.revision).toBe(1)
  })
})

// ── 串行队列（§6.6 前提 4：异步 fire-and-forget 派发下的结构保证） ────────

describe('ProjectStore 命令串行队列', () => {
  it('并发到达的命令依调用顺序串行执行（受控 promise：后条 revision 以前条完成值为前提）', async () => {
    const { store } = newStore()

    // 三条命令并发派发（第一条未 await 即发后续，模拟消息异步 fire-and-forget 到达）。
    // 第 2/3 条携带的 revision 只有在前序命令完整执行（+1）后才匹配——全部成功即
    // 证明逐条串行无交错（若并发执行，第 2 条会以 revision=1 失配被拒）。
    const results = await Promise.all([
      store.createProject('A', 0),
      store.createProject('B', 1),
      store.createProject('C', 2),
    ])

    expect(results.map((r) => r.revision)).toEqual([1, 2, 3])
    const final = results[2]
    // 效果按序叠加：A/B/C 均在（依创建序），活跃 = 最后创建的 C
    expect(final.state.projects.map((p) => p.name)).toEqual(expect.arrayContaining(['A', 'B', 'C']))
    expect(final.state.activeProjectId).toBe(final.state.projects.find((p) => p.name === 'C')?.id)
    expect(store.getRevision()).toBe(3)
  })

  it('串行链上后条命令看到前条完整效果（rename 作用于并发 create 的产物）', async () => {
    const { store } = newStore()

    const created = store.createProject('A', 0)
    const createdReply = await created
    const aId = createdReply.state.projects.find((p) => p.name === 'A')?.id ?? ''

    const renamed = await store.renameProject(aId, 'A2', 1)
    expect(renamed.state.projects.find((p) => p.id === aId)?.name).toBe('A2')
    expect(renamed.revision).toBe(2)
  })

  it('前驱拒绝不阻断后继（失败只传给该命令的调用方）', async () => {
    const { store } = newStore()

    const rejected = store.createProject('A', 7) // 失配拒绝
    const ok = store.createProject('B', 0) // 排在其后，正常执行
    await expectCommandRejection(rejected, 'project_revision_mismatch')
    await expect(ok).resolves.toMatchObject({ revision: 1 })
  })
})

// ── 归一化（§6.6①：自 renderer 迁入，load 读时修复 / 命令路径落盘修复） ────

describe('ProjectStore 归一化读时修复（不改盘）', () => {
  it('失配文件 load 返回修复视图，前后文件字节一致（含 debounce 窗口后复查）', async () => {
    const { store, dir } = newStore()
    const path = fixtureFile(dir, {
      // 失配形态：activeProjectId 指向不存在的 project + nameless 默认项缺失
      projects: [{ id: 'p1', name: 'alpha', lastUsedAt: 10 }],
      activeProjectId: 'ghost-id',
    })
    const bytesBefore = readFile(path)

    const view = store.load()
    // 视图已修复：默认项补插 + activeProjectId 回退链（nameless 默认项命中）
    expect(view.projects[0]).toMatchObject({ id: DEFAULT_PROJECT_ID, name: '' })
    expect(view.activeProjectId).toBe(DEFAULT_PROJECT_ID)
    expect(view.projects.some((p) => p.id === 'p1')).toBe(true)

    // 读时修复不写盘：字节一致（cache 无 dirty → 无 debounce flush）。
    // 负向断言按分片采样形态覆盖 flushMs=500 的 debounce 窗口（每片断言一次，
    // 规避单次长 sleep 的盲等形态：CPU 忙时事件循环延迟会吃掉 sleep 余量）
    expect(readFile(path)).toBe(bytesBefore)
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 25))
      expect(readFile(path)).toBe(bytesBefore)
    }
  })

  it('命令路径随命令落盘一并承载修复（失配文件首次编辑后收敛，不产生第二次写盘）', async () => {
    const { store, dir } = newStore()
    const path = fixtureFile(dir, {
      projects: [{ id: 'p1', name: 'alpha', lastUsedAt: 10 }],
      activeProjectId: 'ghost-id',
    })

    const reply = await store.createProject('beta', 0)
    expect(reply.revision).toBe(1)
    expect(reply.state.projects[0]?.id).toBe(DEFAULT_PROJECT_ID)

    store.flushAll()
    const onDisk = JSON.parse(readFile(path)) as ProjectStoreState & { revision: number }
    // 文件已收敛到不变量：默认项在、active 指向新建项（createProject 设活跃）、revision 补 1
    expect(onDisk.projects.some((p) => p.id === DEFAULT_PROJECT_ID)).toBe(true)
    expect(onDisk.activeProjectId).toBe(onDisk.projects.find((p) => p.name === 'beta')?.id)
    expect(onDisk.revision).toBe(1)
  })
})

// ── 四命令语义（对齐 renderer addProject/renameProject/removeProject/setActiveProject 行为） ──

describe('ProjectStore 四命令语义', () => {
  async function seededStore(): Promise<{ store: ProjectStore; alphaId: string; betaId: string }> {
    const { store } = newStore()
    const r1 = await store.createProject('alpha', 0)
    const alphaId = r1.state.projects.find((p) => p.name === 'alpha')?.id ?? ''
    const r2 = await store.createProject('beta', 1)
    const betaId = r2.state.projects.find((p) => p.name === 'beta')?.id ?? ''
    return { store, alphaId, betaId }
  }

  it('createProject：回执完整新状态（默认项 + 新项），trim 空名拒绝且不 +1', async () => {
    const { store } = newStore()

    await expectCommandRejection(store.createProject('   ', 0), 'project_invalid_name')
    expect(store.getRevision()).toBe(0)

    const reply = await store.createProject('  spaced  ', 0)
    expect(reply.revision).toBe(1)
    const created = reply.state.projects.find((p) => p.name === 'spaced')
    expect(created).toBeDefined()
    expect(created?.id).toMatch(/^proj-/)
    // 默认项兜底在列 + 新项设为活跃
    expect(reply.state.projects.some((p) => p.id === DEFAULT_PROJECT_ID)).toBe(true)
    expect(reply.state.activeProjectId).toBe(created?.id)
  })

  it('renameProject：改名生效；默认项（nameless）与未知 id 与空名拒绝', async () => {
    const { store, alphaId } = await seededStore()

    const reply = await store.renameProject(alphaId, 'renamed', 2)
    expect(reply.state.projects.find((p) => p.id === alphaId)?.name).toBe('renamed')
    expect(reply.revision).toBe(3)

    await expectCommandRejection(store.renameProject(DEFAULT_PROJECT_ID, 'x', 3), 'project_default_protected')
    await expectCommandRejection(store.renameProject('no-such', 'x', 3), 'project_not_found')
    await expectCommandRejection(store.renameProject(alphaId, '  ', 3), 'project_invalid_name')
    expect(store.getRevision()).toBe(3) // 拒绝不 +1
  })

  it('removeProject：删除生效；删活跃项锚定回落默认；默认项与未知 id 拒绝', async () => {
    const { store, alphaId, betaId } = await seededStore()
    // 当前活跃 = beta（最后创建）——删 beta 验证锚定回落
    const reply = await store.removeProject(betaId, 2)
    expect(reply.state.projects.some((p) => p.id === betaId)).toBe(false)
    expect(reply.state.activeProjectId).toBe(DEFAULT_PROJECT_ID)
    expect(reply.revision).toBe(3)

    await expectCommandRejection(store.removeProject(DEFAULT_PROJECT_ID, 3), 'project_default_protected')
    await expectCommandRejection(store.removeProject('no-such', 3), 'project_not_found')

    // 删除非活跃项：锚定保持不变
    const keepActive = await store.removeProject(alphaId, 3)
    expect(keepActive.state.activeProjectId).toBe(DEFAULT_PROJECT_ID)
    expect(keepActive.state.projects.every((p: Project) => p.id !== alphaId)).toBe(true)
  })

  it('setActiveProject：切换生效且不更新 lastUsedAt（顺序稳定裁决 R6.2）；未知 id 拒绝', async () => {
    const { store, alphaId } = await seededStore()
    const before = store.load().projects.find((p) => p.id === alphaId)?.lastUsedAt

    const reply = await store.setActiveProject(alphaId, 2)
    expect(reply.state.activeProjectId).toBe(alphaId)
    expect(reply.state.projects.find((p) => p.id === alphaId)?.lastUsedAt).toBe(before)

    await expectCommandRejection(store.setActiveProject('no-such', 3), 'project_not_found')
  })
})
