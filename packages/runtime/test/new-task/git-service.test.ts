/**
 * GitService.checkout/createBranch + getStatus 分支列表单测（#6/#7，T4.1/T4.5/T6.1/T6.3/T6.4/T6.8 + T4.3/T4.9 数据源）。
 *
 * 覆盖：
 * - T4.1 干净分支：checkout → execSafe(cwd,'checkout',[name]) exit 0 → resolve
 * - T4.5 E8 冲突：exitCode 非 0 → throw GitError('git_failed')
 * - T4.3 unborn HEAD：getStatus → branches=[]（无 commit），isRepo=true
 * - T4.9 分支列表：getStatus → branches 含本地分支
 * - session 不存在 → GitError('session_not_found')；port 超时 → GitError('git_unavailable')
 *
 * mock 策略（test-strategy §2.2）：IGitExecutor 构造注入，sessionService.getSummary 提供 cwd。
 * 不起真实 git 进程。
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/new-task/git-service.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GitService, GitError, type GitServiceOptions } from '../../src/services/git-service.js'
import { GitExecutorError } from '../../src/services/ports/git-executor.js'
import type { IGitExecutor, GitExecutorResult } from '../../src/services/ports/git-executor.js'
import { GitStateService } from '../../src/services/git/git-state-service.js'

const executor = { exec: vi.fn() }
const sessionService = { getSummary: vi.fn() }

function svc(): GitService {
  return new GitService({
    sessionService: sessionService as unknown as GitServiceOptions['sessionService'],
    executor: executor as unknown as IGitExecutor,
    // perf W17 收编：getStatus 走真 GitStateService（共享 executor mock）——下方 getStatus
    // 用例即为「收编后行为等价」回归（分支列表 / per-file 行数 / -uall 参数语义不变）
    stateService: new GitStateService({ executor: executor as unknown as IGitExecutor }),
  })
}

function res(over: Partial<GitExecutorResult> = {}): GitExecutorResult {
  return { stdout: '', stderr: '', exitCode: 0, ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionService.getSummary.mockReturnValue({ cwd: '/repo' })
})

describe('GitService.checkout (#6 选分支 popover)', () => {
  it('T4.1 干净分支→execSafe(cwd,checkout,[name]) exit 0→resolve', async () => {
    executor.exec.mockResolvedValueOnce(res())
    await expect(svc().checkout('s1', 'main')).resolves.toBeUndefined()
    expect(executor.exec).toHaveBeenCalledWith('/repo', 'checkout', ['main'])
  })

  it('T4.5 E8 冲突/分支不存在→exitCode 非0→throw GitError', async () => {
    executor.exec.mockResolvedValueOnce(res({ exitCode: 1, stderr: 'error: Your local changes would be overwritten' }))
    await expect(svc().checkout('s1', 'feature')).rejects.toBeInstanceOf(GitError)
    expect(executor.exec).toHaveBeenCalledWith('/repo', 'checkout', ['feature'])
  })

  it('非0 退出的 GitError code=git_failed（handler 据此转 error envelope）', async () => {
    executor.exec.mockResolvedValueOnce(res({ exitCode: 128, stderr: 'fatal: not a valid object name' }))
    await expect(svc().checkout('s1', 'nope')).rejects.toMatchObject({
      name: 'GitError',
      code: 'git_failed',
    })
  })

  it('session 不存在（cwd 空）→GitError(session_not_found)，不触达 exec', async () => {
    sessionService.getSummary.mockReturnValue({ cwd: '' })
    await expect(svc().checkout('s1', 'main')).rejects.toMatchObject({
      name: 'GitError',
      code: 'session_not_found',
    })
    expect(executor.exec).not.toHaveBeenCalled()
  })

  it('port 超时→GitExecutorError(timeout)→GitError(git_unavailable)', async () => {
    executor.exec.mockRejectedValueOnce(new GitExecutorError('timeout', 'timed out'))
    await expect(svc().checkout('s1', 'main')).rejects.toMatchObject({
      name: 'GitError',
      code: 'git_unavailable',
    })
  })
})

describe('GitService.getStatus 分支列表（#6 popover 数据源）', () => {
  it('T4.9 正常仓库→isRepo=true 且 branches 含本地分支列表', async () => {
    // status 头 + 干净工作区；branch --list 返回两个本地分支
    executor.exec
      .mockResolvedValueOnce(res({ stdout: '## main\u0000' })) // status
      .mockResolvedValueOnce(res({ stdout: '' })) // diff numstat（空）
      .mockResolvedValueOnce(res({ stdout: 'main\nfeature/x\n' })) // branch --list
    const r = await svc().getStatus('s1')
    expect(r.isRepo).toBe(true)
    expect(r.branch).toBe('main')
    expect(r.branches).toEqual(['main', 'feature/x'])
  })

  it('T4.3 unborn HEAD（无首次提交）→isRepo=true、branches=[]、branch=undefined', async () => {
    // status 在 unborn 仓库 exit 0，头为 "## No commits yet on main"；branch --list 空
    executor.exec
      .mockResolvedValueOnce(res({ stdout: '## No commits yet on main\u0000' })) // status exit 0
      .mockResolvedValueOnce(res({ stdout: '', exitCode: 128 })) // diff HEAD 失败（无 HEAD）→ stats 0
      .mockResolvedValueOnce(res({ stdout: '' })) // branch --list 空
    const r = await svc().getStatus('s1')
    expect(r.isRepo).toBe(true)
    expect(r.branch).toBeUndefined()
    expect(r.branches).toEqual([])
  })

  it('branch --list 失败（非0）→branches 兜底为空数组，不影响主状态', async () => {
    executor.exec
      .mockResolvedValueOnce(res({ stdout: '## main\u0000' }))
      .mockResolvedValueOnce(res({ stdout: '' }))
      .mockResolvedValueOnce(res({ exitCode: 128, stderr: 'err' })) // branch 列举失败
    const r = await svc().getStatus('s1')
    expect(r.isRepo).toBe(true)
    expect(r.branch).toBe('main')
    expect(r.branches).toEqual([])
  })
})

describe('GitService.getStatus per-file 行数（W1 文件树 +N −M 角标）', () => {
  it('tracked modified 文件填充 additions/deletions', async () => {
    // status：两个 modified 文件（XY=' M'）；diff numstat 提供 per-file 行数
    executor.exec
      .mockResolvedValueOnce(res({ stdout: '## main\u0000 M\tsrc/a.ts\u0000 M\tsrc/b.ts\u0000' })) // status
      .mockResolvedValueOnce(res({ stdout: '10\t2\tsrc/a.ts\n5\t0\tsrc/b.ts' })) // diff numstat
      .mockResolvedValueOnce(res({ stdout: 'main\n' })) // branch --list
    const r = await svc().getStatus('s1')
    const a = r.files.find((f) => f.path === 'src/a.ts')
    const b = r.files.find((f) => f.path === 'src/b.ts')
    expect(a).toMatchObject({ additions: 10, deletions: 2 })
    expect(b).toMatchObject({ additions: 5, deletions: 0 })
  })

  it('untracked 文件 additions/deletions 为 undefined（numstat 不含未跟踪）', async () => {
    executor.exec
      .mockResolvedValueOnce(res({ stdout: '## main\u0000??\tnew.tmp\u0000 M\tcode.ts\u0000' })) // status
      .mockResolvedValueOnce(res({ stdout: '3\t1\tcode.ts' })) // diff numstat（无 new.tmp）
      .mockResolvedValueOnce(res({ stdout: 'main\n' })) // branch --list
    const r = await svc().getStatus('s1')
    const untracked = r.files.find((f) => f.path === 'new.tmp')
    const modified = r.files.find((f) => f.path === 'code.ts')
    expect(untracked).toMatchObject({ status: 'untracked' })
    expect(untracked?.additions).toBeUndefined()
    expect(untracked?.deletions).toBeUndefined()
    expect(modified).toMatchObject({ additions: 3, deletions: 1 })
  })

  it('status 命令带 --untracked-files=all 展开未跟踪目录到单文件（修复目录徽章失配）', async () => {
    // -uall 输出：untracked 目录展开到文件级（无尾斜杠），与 FileNode.path 一致
    executor.exec
      .mockResolvedValueOnce(res({ stdout: '## main\u0000??\tredis-learn/a.py\u0000??\tredis-learn/b.md\u0000' }))
      .mockResolvedValueOnce(res({ stdout: '' })) // numstat 空（无 tracked 改动）
      .mockResolvedValueOnce(res({ stdout: 'main\n' }))
    const r = await svc().getStatus('s1')
    // 展开后的每个 untracked 文件单独报告（无尾斜杠目录折叠）
    expect(r.files.map((f) => f.path)).toEqual(['redis-learn/a.py', 'redis-learn/b.md'])
    expect(r.files.every((f) => f.status === 'untracked')).toBe(true)
    // 验证 status 命令确实带了 --untracked-files=all（perf W17 收编后经 GitStateService
    // 执行，第 4 参为 D3-1 定案的 8000ms 超时）
    expect(executor.exec).toHaveBeenNthCalledWith(1, '/repo', 'status', [
      '--porcelain=v1', '-z', '-b', '--untracked-files=all',
    ], { timeoutMs: 8000 })
  })
})

describe('GitService.createBranch (#7 创建并检出分支)', () => {
  it('T6.1 合法名→execSafe(cwd,checkout,[-b,name]) exit 0→resolve', async () => {
    executor.exec.mockResolvedValueOnce(res())
    await expect(svc().createBranch('s1', 'feat/x')).resolves.toBeUndefined()
    expect(executor.exec).toHaveBeenCalledWith('/repo', 'checkout', ['-b', 'feat/x'])
  })

  it('T6.3 E10 分支已存在→exitCode 非0→throw GitError(git_failed)', async () => {
    executor.exec.mockResolvedValueOnce(
      res({ exitCode: 128, stderr: "fatal: A branch named 'feat/x' already exists" }),
    )
    await expect(svc().createBranch('s1', 'feat/x')).rejects.toMatchObject({
      name: 'GitError',
      code: 'git_failed',
    })
    expect(executor.exec).toHaveBeenCalledWith('/repo', 'checkout', ['-b', 'feat/x'])
  })

  it('T6.4 E11 port 超时→GitExecutorError(timeout)→GitError(git_unavailable)', async () => {
    executor.exec.mockRejectedValueOnce(new GitExecutorError('timeout', 'timed out'))
    await expect(svc().createBranch('s1', 'feat/x')).rejects.toMatchObject({
      name: 'GitError',
      code: 'git_unavailable',
    })
  })

  it('T6.8 NFR runtime 分支名二次校验：非法名在 exec 前被拒', async () => {
    await expect(svc().createBranch('s1', 'bad name')).rejects.toMatchObject({
      name: 'GitError',
    })
    expect(executor.exec).not.toHaveBeenCalled()
  })

  it('T6.8 非法名（含 ..）→拒绝，不触达 exec', async () => {
    await expect(svc().createBranch('s1', 'feat..x')).rejects.toMatchObject({
      name: 'GitError',
    })
    expect(executor.exec).not.toHaveBeenCalled()
  })

  it('session 不存在（cwd 空）→GitError(session_not_found)，不触达 exec', async () => {
    sessionService.getSummary.mockReturnValue({ cwd: '' })
    await expect(svc().createBranch('s1', 'feat/x')).rejects.toMatchObject({
      name: 'GitError',
      code: 'session_not_found',
    })
    expect(executor.exec).not.toHaveBeenCalled()
  })
})
