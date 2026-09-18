/**
 * GitRepoResolver 单测（缓存治理批 4 U10）：walk-up 一次遍历同时产出 {isBare, gitDir, headPath}。
 *
 * fs 走真实临时目录 fixture（mkdtempSync 自建自删，不触真实数据目录）；branch 的 execSync 经
 * vi.mock 钉死（不真 spawn git）——验证的是 walk-up 判定逻辑与 branch 解析契约。
 *
 * 测试框架 vitest，运行命令：cd packages/runtime && npx vitest run src/infra/system/git-repo-resolver.test.ts
 */
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitRepoResolver } from './git-repo-resolver.js'

vi.mock('node:child_process', () => ({ execSync: vi.fn(() => 'main\n') }))

const execSyncMock = vi.mocked(execSync)

/** 本文件创建的全部临时根目录（afterEach 统一自删）。 */
const tmpRoots: string[] = []

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-repo-resolver-'))
  tmpRoots.push(dir)
  return dir
}

afterEach(() => {
  execSyncMock.mockReset()
  execSyncMock.mockImplementation(() => 'main\n')
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

describe('GitRepoResolver.resolve walk-up', () => {
  it('cwd 根有 .git 目录 → 普通 repo 锚点（gitDir/headPath 落定，isWorktree/isBare=false）', () => {
    const root = makeTmp()
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'src'))

    const obs = new GitRepoResolver().resolve(join(root, 'src'))
    expect(obs).toEqual({
      branch: 'main',
      isWorktree: false,
      isBare: false,
      gitDir: join(root, '.git'),
      headPath: join(root, '.git', 'HEAD'),
    })
  })

  it('worktree：.git 文件且 gitdir: 指针（绝对路径）→ isWorktree=true，gitDir 取指针指向', () => {
    const root = makeTmp()
    const worktreeGitDir = makeTmp()
    writeFileSync(join(root, '.git'), `gitdir: ${worktreeGitDir}/admin\n`)

    const obs = new GitRepoResolver().resolve(root)
    expect(obs.isWorktree).toBe(true)
    expect(obs.gitDir).toBe(join(worktreeGitDir, 'admin'))
    expect(obs.headPath).toBe(join(worktreeGitDir, 'admin', 'HEAD'))
    expect(obs.isBare).toBe(false)
  })

  it('worktree：gitdir: 相对指针 → 相对 .git 文件所在目录 resolve 成绝对路径', () => {
    const root = makeTmp()
    mkdirSync(join(root, 'feat-x'))
    writeFileSync(join(root, 'feat-x', '.git'), 'gitdir: ../.bare/worktrees/feat-x\n')

    const obs = new GitRepoResolver().resolve(join(root, 'feat-x'))
    expect(obs.isWorktree).toBe(true)
    expect(obs.gitDir).toBe(join(root, '.bare', 'worktrees', 'feat-x'))
    expect(obs.headPath).toBe(join(root, '.bare', 'worktrees', 'feat-x', 'HEAD'))
  })

  it('.git 文件但无 gitdir: 前缀 → isWorktree=false 降级，headPath 无法定位为 undefined', () => {
    const root = makeTmp()
    writeFileSync(join(root, '.git'), 'not a gitdir pointer\n')

    const obs = new GitRepoResolver().resolve(root)
    expect(obs.isWorktree).toBe(false)
    expect(obs.gitDir).toBe(join(root, '.git'))
    expect(obs.headPath).toBeUndefined()
  })

  it('.git 文件 gitdir: 前缀但指针为空 → isWorktree=false 降级（与旧读失败分支一致）', () => {
    const root = makeTmp()
    writeFileSync(join(root, '.git'), 'gitdir:   \n')

    const obs = new GitRepoResolver().resolve(root)
    expect(obs.isWorktree).toBe(false)
    expect(obs.headPath).toBeUndefined()
  })

  it('bare workspace 根：.bare 目录 → isBare=true，gitDir/headPath 由 .bare 承接', () => {
    const root = makeTmp()
    mkdirSync(join(root, '.bare'))

    const obs = new GitRepoResolver().resolve(root)
    expect(obs.isBare).toBe(true)
    expect(obs.isWorktree).toBe(false)
    expect(obs.gitDir).toBe(join(root, '.bare'))
    expect(obs.headPath).toBe(join(root, '.bare', 'HEAD'))
  })

  it('.bare workspace 下的 worktree 子目录 → isBare 与 isWorktree 同时成立（旧两套缓存的历史组合语义）', () => {
    const root = makeTmp()
    mkdirSync(join(root, '.bare'))
    mkdirSync(join(root, 'feat-x'))
    writeFileSync(join(root, 'feat-x', '.git'), `gitdir: ${join(root, '.bare', 'worktrees', 'feat-x')}\n`)

    const obs = new GitRepoResolver().resolve(join(root, 'feat-x'))
    expect(obs.isBare).toBe(true)
    expect(obs.isWorktree).toBe(true)
    expect(obs.gitDir).toBe(join(root, '.bare', 'worktrees', 'feat-x'))
    expect(obs.headPath).toBe(join(root, '.bare', 'worktrees', 'feat-x', 'HEAD'))
  })

  it('同级同时存在 .git 目录与 .bare 目录 → .git 锚点承接 gitDir/headPath，isBare 仍为 true', () => {
    const root = makeTmp()
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, '.bare'))

    const obs = new GitRepoResolver().resolve(root)
    expect(obs.isBare).toBe(true)
    expect(obs.gitDir).toBe(join(root, '.git'))
    expect(obs.headPath).toBe(join(root, '.git', 'HEAD'))
  })

  it('非 repo：全字段降级；branch 解析仍执行（rev-parse 从 cwd 起算，与旧实现等价）', () => {
    const root = makeTmp()
    const obs = new GitRepoResolver().resolve(root)
    expect(obs).toEqual({ branch: 'main', isWorktree: false, isBare: false, gitDir: undefined, headPath: undefined })
    expect(execSyncMock).toHaveBeenCalledTimes(1)
  })
})

describe('GitRepoResolver.resolve branch 解析', () => {
  it('execSync 形状：git rev-parse --abbrev-ref HEAD，2000ms 超时，从 cwd 起算', () => {
    const root = makeTmp()
    mkdirSync(join(root, '.git'))
    new GitRepoResolver().resolve(root)

    expect(execSyncMock).toHaveBeenCalledTimes(1)
    const [command, opts] = execSyncMock.mock.calls[0] as unknown as [string, { cwd: string; timeout: number; env: Record<string, string> }]
    expect(command).toBe('git rev-parse --abbrev-ref HEAD')
    expect(opts.cwd).toBe(root)
    expect(opts.timeout).toBe(2000)
    expect(opts.env).toBeDefined()
  })

  it('非 0 退出（execSync 抛出，如未出生分支 / 非 repo）→ branch=undefined，其余字段不受影响', () => {
    const root = makeTmp()
    mkdirSync(join(root, '.git'))
    execSyncMock.mockImplementation(() => {
      throw new Error('exit 128')
    })

    const obs = new GitRepoResolver().resolve(root)
    expect(obs.branch).toBeUndefined()
    expect(obs.gitDir).toBe(join(root, '.git'))
  })

  it('空输出（trim 后空串）→ branch=undefined', () => {
    const root = makeTmp()
    execSyncMock.mockImplementation(() => '\n')
    expect(new GitRepoResolver().resolve(root).branch).toBeUndefined()
  })

  it('detached HEAD → branch 为 rev-parse 原生输出 HEAD（现状语义）', () => {
    const root = makeTmp()
    execSyncMock.mockImplementation(() => 'HEAD\n')
    expect(new GitRepoResolver().resolve(root).branch).toBe('HEAD')
  })
})
