/**
 * GitService.getStatus 收编端到端单测（perf W17 验收①，03-git-state-service D4-4 U2）。
 *
 * 覆盖（真 GitStateService + fake executor，不起真实 git）：
 * - TTL 命中：同 sid 连续两次 getStatus，第二次零 exec（executor.exec 计数停在首次聚合的 3 次）
 * - invalidateStatusCache({sessionId}) 后重新执行——「写操作后立即 getStatus 不返回陈旧」
   的服务层链路（handler 侧失效调用见 new-task/git-message-handler.test.ts）
 * - invalidateStatusCache({cwd}) 按 cwd 失效（session-less 写操作场景，跨 session 生效）
 * - 非 git 仓库 → isRepo=false 降级（收编后降级语义不变）
 * - session 不存在 → GitError('session_not_found')（session→cwd 解析留在 GitService）
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/git-service-status-cache.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GitService, GitError, type GitServiceOptions } from '../src/services/git-service.js'
import { GitStateService } from '../src/services/git/git-state-service.js'
import type { IGitExecutor, GitExecutorResult } from '../src/services/ports/git-executor.js'

const executor = { exec: vi.fn() }
const sessionService = { getSummary: vi.fn() }

function res(over: Partial<GitExecutorResult> = {}): GitExecutorResult {
  return { stdout: '', stderr: '', exitCode: 0, ...over }
}

/** 标准仓库 mock：status / numstat / branch 三命令各返回一次（GitStateService 内部并发消费）。
 * 只覆盖 implementation 不清调用记录（计数是断言基数；用例间清理由 beforeEach clearAllMocks 负责）。 */
function stubRepo(branchList = 'main\n') {
  executor.exec.mockImplementation(async (_cwd: string, command: string) => {
    if (command === 'status') return res({ stdout: `## main\u0000 M a.ts\u0000` })
    if (command === 'diff') return res({ stdout: '1\t2\ta.ts\n' })
    return res({ stdout: branchList })
  })
}

function svc(): GitService {
  return new GitService({
    sessionService: sessionService as unknown as GitServiceOptions['sessionService'],
    executor: executor as unknown as IGitExecutor,
    stateService: new GitStateService({ executor: executor as unknown as IGitExecutor }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionService.getSummary.mockReturnValue({ cwd: '/repo' })
})

describe('GitService.getStatus 收编（perf W17）', () => {
  it('TTL 命中：同 sid 连续两次 getStatus，第二次零 exec（首次聚合 status+diff+branch 共 3 次）', async () => {
    stubRepo()
    const service = svc()
    const first = await service.getStatus('s1')
    expect(first.isRepo).toBe(true)
    expect(executor.exec).toHaveBeenCalledTimes(3)

    const second = await service.getStatus('s1')
    expect(second).toEqual(first)
    // 缓存命中：exec 计数不增
    expect(executor.exec).toHaveBeenCalledTimes(3)
  })

  it('invalidateStatusCache({sessionId}) 后重新执行：下次 getStatus 拿到新状态（不返回陈旧）', async () => {
    stubRepo('main\n')
    const service = svc()
    await service.getStatus('s1')
    expect(executor.exec).toHaveBeenCalledTimes(3)

    // 写操作成功后 handler 调失效；模拟工作区变化：分支列表多出 feat-x
    stubRepo('feat-x\nmain\n')
    service.invalidateStatusCache({ sessionId: 's1' })
    const fresh = await service.getStatus('s1')
    expect(executor.exec).toHaveBeenCalledTimes(6) // 重新聚合一组
    expect(fresh.branches).toEqual(['feat-x', 'main']) // 新状态，非缓存陈旧值
  })

  it('invalidateStatusCache({cwd}) 按 cwd 失效：同 cwd 的另一 session 缓存也被清（session-less 写操作场景）', async () => {
    stubRepo()
    const service = svc()
    await service.getStatus('sid-a')
    await service.getStatus('sid-b')
    expect(executor.exec).toHaveBeenCalledTimes(6)

    // checkoutCwd（无 session）按 cwd 失效：两个 session 的缓存都要重新取
    stubRepo('main\n')
    service.invalidateStatusCache({ cwd: '/repo' })
    await service.getStatus('sid-a')
    await service.getStatus('sid-b')
    expect(executor.exec).toHaveBeenCalledTimes(12)
  })

  it('非 git 仓库 → isRepo=false 降级（收编后降级语义不变，reply 形状不变）', async () => {
    executor.exec.mockImplementation(async () =>
      res({ stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }),
    )
    const result = await svc().getStatus('s1')
    expect(result).toMatchObject({
      sessionId: 's1',
      isRepo: false,
      stagedCount: 0,
      unstagedCount: 0,
      stats: { add: 0, del: 0 },
      hasConflict: false,
      files: [],
    })
  })

  it('session 不存在（无 cwd）→ GitError(session_not_found)，不触达 executor', async () => {
    stubRepo()
    sessionService.getSummary.mockReturnValue(undefined)
    await expect(svc().getStatus('nope')).rejects.toMatchObject({
      code: 'session_not_found',
    })
    expect(executor.exec).not.toHaveBeenCalled()
  })
})
