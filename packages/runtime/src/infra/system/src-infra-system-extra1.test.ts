import type { IGitRepoObserver, RepoObservation } from '../../services/ports/git-info.js';
import { GitInfoReader } from './git-info-reader.js';
import { GitRepoResolver } from './git-repo-resolver.js';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/infra/system/git-info-reader.test.ts
// ======================================================================

const NON_REPO: RepoObservation = { branch: undefined, isWorktree: false, isBare: false, gitDir: undefined, headPath: undefined }


function fakeObserver(obs: RepoObservation): IGitRepoObserver {
  return {
    readObservation: vi.fn(() => obs),
    pruneCache: vi.fn(),
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('git-info-reader', () => {
describe('GitInfoReader.readGitInfo（观测器缓存 → GitInfo 映射）', () => {
  it('repo（gitDir + branch 均在）→ 映射 {branch, isWorktree}', () => {
    const observer = fakeObserver({ branch: 'feat-x', isWorktree: true, isBare: false, gitDir: '/ws/.bare/wt', headPath: '/ws/.bare/wt/HEAD' })
    const reader = new GitInfoReader(observer)

    expect(reader.readGitInfo('/ws/feat-x')).toEqual({ branch: 'feat-x', isWorktree: true })
    expect(observer.readObservation).toHaveBeenCalledWith('/ws/feat-x')
  })

  it('非 repo（gitDir undefined）→ undefined（摘要字段留空）', () => {
    const reader = new GitInfoReader(fakeObserver(NON_REPO))
    expect(reader.readGitInfo('/not-a-repo')).toBeUndefined()
  })

  it('branch undefined（rev-parse 失败 / 未出生分支 / git 不可用）→ undefined，即使 gitDir 存在', () => {
    const observer = fakeObserver({ branch: undefined, isWorktree: false, isBare: true, gitDir: '/ws/.bare', headPath: '/ws/.bare/HEAD' })
    const reader = new GitInfoReader(observer)
    expect(reader.readGitInfo('/ws')).toBeUndefined()
  })

  it('bare workspace 根形态：branch 有效时正常映射（isWorktree=false）', () => {
    // workspace 根在更上层 repo 之内的边界：walk-up 命中 .bare，rev-parse 从 cwd 起算仍可解析
    const observer = fakeObserver({ branch: 'main', isWorktree: false, isBare: true, gitDir: '/repo/inner/.bare', headPath: '/repo/inner/.bare/HEAD' })
    const reader = new GitInfoReader(observer)
    expect(reader.readGitInfo('/repo/inner')).toEqual({ branch: 'main', isWorktree: false })
  })
})
describe('GitInfoReader.pruneStaleCache（收缩动作打观测器单点）', () => {
  it('签名保留，动作整体委托观测器 pruneCache（branch/worktree/bare 同一缓存）', () => {
    const observer = fakeObserver(NON_REPO)
    const reader = new GitInfoReader(observer)

    const cwds = new Set(['/a', '/b'])
    reader.pruneStaleCache(cwds)
    expect(observer.pruneCache).toHaveBeenCalledTimes(1)
    expect(observer.pruneCache).toHaveBeenCalledWith(cwds)
  })
})
});

// ======================================================================
// ← src/infra/system/git-repo-resolver.test.ts
// ======================================================================

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn(() => 'main\n') }
})


const execSyncMock = vi.mocked(execSync)


/** 本文件创建的全部临时根目录（afterEach 统一自删）。 */
const tmpRoots: string[] = []


function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-repo-resolver-'))
  tmpRoots.push(dir)
  return dir
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('git-repo-resolver', () => {
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
});
