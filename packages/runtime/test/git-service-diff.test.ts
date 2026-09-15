/**
 * GitService.getFileDiff 单测（#5，T6.1/T6.8/T6.9/T6.13/T6.14）。
 *
 * 覆盖：
 * - T6.1 M 文件 → diff patch（经 executor.exec port + 数组形式防注入）
 * - T6.8 git.diff 经 executor.exec + 防注入（数组参数，非字符串拼接）
 * - T6.9 越界 path → GitError('path_not_allowed')（K-6 新写越界校验）
 * - T6.13 超时 → GitExecutorError → GitError（execSafe 转 git_failed/git_unavailable）
 * - T6.14 cwd 非 repo → exitCode 非 0 + 空 stdout → 空 patch（不抛错）
 * - AC-5.5 二进制 → stdout 含 "Binary files ... differ" → binary=true
 *
 * mock 策略：IGitExecutor + sessionService 注入，不起真实 git。
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/git-service-diff.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GitService, GitError, type GitServiceOptions } from '../src/services/git-service.js'
import { GitExecutorError } from '../src/services/ports/git-executor.js'
import type { IGitExecutor, GitExecutorResult } from '../src/services/ports/git-executor.js'
import { GitStateService } from '../src/services/git/git-state-service.js'

const executor = { exec: vi.fn() }
const sessionService = { getSummary: vi.fn() }

function svc(): GitService {
  return new GitService({
    sessionService: sessionService as unknown as GitServiceOptions['sessionService'],
    executor: executor as unknown as IGitExecutor,
    // getFileDiff 不经状态服务；注入真 GitStateService（共享 executor）满足必选依赖
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

describe('GitService.getFileDiff (#5 git.diff 全链路)', () => {
  it('T6.1 M 文件 → 返回 diff patch', async () => {
    const patch = 'diff --git a/src/index.ts b/src/index.ts\n+new line'
    executor.exec.mockResolvedValueOnce(res({ stdout: patch }))
    const result = await svc().getFileDiff('s1', 'src/index.ts')
    expect(result.patch).toBe(patch)
    expect(result.binary).toBe(false)
  })

  it('T6.8 经 executor.exec 数组形式（防注入，NFR-AC-S3）', async () => {
    executor.exec.mockResolvedValueOnce(res())
    await svc().getFileDiff('s1', 'src/x.ts')
    // 验证调用经 port + 数组 args（非字符串拼接）
    expect(executor.exec).toHaveBeenCalledWith('/repo', 'diff', ['--', 'src/x.ts'])
  })

  it('T6.9 越界 path → GitError(path_not_allowed)', async () => {
    // /etc/passwd 不在 /repo 之下（isUnderOrEqual false）
    await expect(svc().getFileDiff('s1', '../../etc/passwd')).rejects.toMatchObject({
      code: 'path_not_allowed',
    })
    expect(executor.exec).not.toHaveBeenCalled() // 越界守门在 exec 前
  })

  it('T6.14 cwd 非 repo → exitCode 非 0 + 空 stdout → 空 patch（不抛）', async () => {
    executor.exec.mockResolvedValueOnce(res({ exitCode: 128, stdout: '', stderr: 'not a git repository' }))
    const result = await svc().getFileDiff('s1', 'src/x.ts')
    expect(result.patch).toBe('')
    expect(result.binary).toBe(false)
  })

  it('AC-5.5 二进制文件 → stdout 含 "Binary files differ" → binary=true', async () => {
    executor.exec.mockResolvedValueOnce(res({ stdout: 'Binary files a/x.png and b/x.png differ' }))
    const result = await svc().getFileDiff('s1', 'x.png')
    expect(result.binary).toBe(true)
  })

  it('T6.13 超时 → GitExecutorError → GitError', async () => {
    executor.exec.mockRejectedValueOnce(new GitExecutorError('timeout', 'git diff timed out'))
    await expect(svc().getFileDiff('s1', 'src/x.ts')).rejects.toBeInstanceOf(GitError)
  })

  it('session 不存在 → GitError(session_not_found)', async () => {
    sessionService.getSummary.mockReturnValueOnce(undefined)
    await expect(svc().getFileDiff('nope', 'src/x.ts')).rejects.toMatchObject({
      code: 'session_not_found',
    })
  })

  it('AC-5.3 diff 命令参数含 -- 分隔符（防 path 注入）', async () => {
    executor.exec.mockResolvedValueOnce(res())
    await svc().getFileDiff('s1', 'src/x.ts')
    const [, , args] = executor.exec.mock.calls[0] as [string, string, string[]]
    expect(args[0]).toBe('--')
    expect(args[1]).toBe('src/x.ts')
  })
})
