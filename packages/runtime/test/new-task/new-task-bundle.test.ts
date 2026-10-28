import { GitError, GitService, type GitServiceOptions } from '../../src/services/git-service.js';
import { GitStateService } from '../../src/services/git/git-state-service.js';
import { GitExecutorError } from '../../src/services/ports/git-executor.js';
import { GitMessageHandler } from '../../src/transport/git-message-handler.js';
import type { ClientMessage } from '@taiji/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← test/new-task/git-message-handler.test.ts
// ======================================================================

import type { GitCommand, GitExecutorResult, IGitExecutor } from '../../src/services/ports/git-executor.js';
/** stub 观测器：用例不触观测器链，仅满足 GitStateService 必选依赖（类型收窄）。 */
const stubObserver = {
  readObservation: () => { throw new Error('stub observer 不应被调用') },
  pruneCache: () => {},
  invalidateCwd: () => {},
} as unknown as import('../../src/services/git/repo-observer.js').GitRepoObserver


interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
}


/** 写操作方法的可编程实现（默认全部 resolve——成功路径）。 */
interface GitImpls {
  checkout?: ReturnType<typeof vi.fn>
  createBranch?: ReturnType<typeof vi.fn>
  commit?: ReturnType<typeof vi.fn>
  stage?: ReturnType<typeof vi.fn>
  unstage?: ReturnType<typeof vi.fn>
  checkoutByCwd?: ReturnType<typeof vi.fn>
  getFileDiff?: ReturnType<typeof vi.fn>
}


function makeHandler(impls: GitImpls = {}) {
  const cap: Captured = { replies: [], errors: [] }
  /** 捕获 broadcastChangeSetInvalidated 调用（D5 重构：commit 后广播） */
  const invalidations: { sessionId: string; reason: 'committed' }[] = []
  /**
   * W17 审查 Fix-4：暴露 reply 原始 mock——cap.replies 只记内容不记调用序，
   * 「invalidate 在 reply 前」需 invocationCallOrder（全局单调递增）断言。
   */
  const reply = vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
    cap.replies.push({ id, type, payload })
  })
  /** W17 审查 Fix-2：checkout 失效需经 getSummary 解析 cwd，暴露 mock 供用例编程返回值 */
  const sessionService = { getSummary: vi.fn() }
  const gitService = {
    getStatus: vi.fn(),
    stage: impls.stage ?? vi.fn().mockResolvedValue(undefined),
    unstage: impls.unstage ?? vi.fn().mockResolvedValue(undefined),
    commit: impls.commit ?? vi.fn().mockResolvedValue(undefined),
    checkout: impls.checkout ?? vi.fn().mockResolvedValue(undefined),
    checkoutByCwd: impls.checkoutByCwd ?? vi.fn().mockResolvedValue(undefined),
    createBranch: impls.createBranch ?? vi.fn().mockResolvedValue(undefined),
    getFileDiff: impls.getFileDiff ?? vi.fn().mockResolvedValue({ patch: '', binary: false }),
    /** perf W17：写操作成功后的状态缓存失效入口（被测新行为） */
    invalidateStatusCache: vi.fn(),
  }
  const ctx = {
    send: vi.fn(),
    reply,
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string, details?: Record<string, unknown>) => {
      cap.errors.push({ id, code, message, details })
    }),
    sessionService,
    gitService,
    broadcastChangeSetInvalidated: vi.fn((sessionId: string, reason: 'committed') => {
      invalidations.push({ sessionId, reason })
    }),
  }
  const handler = new GitMessageHandler(ctx as unknown as ConstructorParameters<typeof GitMessageHandler>[0])
  return { cap, handler, gitService, invalidations, reply, sessionService }
}


function checkoutMsg(sessionId: string, name: string, id = 'm1'): ClientMessage {
  return { type: 'git.checkout', id, payload: { sessionId, name } } as unknown as ClientMessage
}


function createBranchMsg(sessionId: string, name: string, id = 'm1'): ClientMessage {
  return { type: 'git.createBranch', id, payload: { sessionId, name } } as unknown as ClientMessage
}


function commitMsg(sessionId: string, message: string, id = 'm1'): ClientMessage {
  return { type: 'git.commit', id, payload: { sessionId, message } } as unknown as ClientMessage
}


function diffMsg(sessionId: string, path: string, id = 'm1'): ClientMessage {
  return { type: 'git.diff', id, payload: { sessionId, path } } as unknown as ClientMessage
}


const WS = {} as never

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('git-message-handler', () => {
describe('GitMessageHandler git.checkout 路由（#6）', () => {
  it("handles 清单含 'git.checkout'", () => {
    const { handler } = makeHandler()
    expect(handler.handles).toContain('git.checkout')
  })

  it('T4.1 checkout 成功→gitService.checkout 调用 + reply message.status switched', async () => {
    const { cap, handler, gitService } = makeHandler()
    await handler.handleGitMessage(checkoutMsg('s1', 'main'), WS)
    expect(gitService.checkout).toHaveBeenCalledWith('s1', 'main')
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'm1',
      type: 'message.status',
      payload: { sessionId: 's1', status: 'switched' },
    })
    expect(cap.errors).toHaveLength(0)
  })

  it('checkout 失败(GitError git_failed)→error envelope，code/sessionId 透传，不 reply success', async () => {
    const { cap, handler } = makeHandler({ checkout: vi.fn().mockRejectedValue(new GitError('git_failed', 'checkout conflict')) })
    await handler.handleGitMessage(checkoutMsg('s1', 'feature'), WS)
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1',
      code: 'git_failed',
      message: 'checkout conflict',
      details: { sessionId: 's1' },
    })
    expect(cap.replies).toHaveLength(0) // 关键：失败不 reply success
  })
})
describe('GitMessageHandler git.createBranch 路由（#7）', () => {
  it("handles 清单含 'git.createBranch'", () => {
    const { handler } = makeHandler()
    expect(handler.handles).toContain('git.createBranch')
  })

  it('T6.1 createBranch 成功→gitService.createBranch 调用 + reply message.status branch_created', async () => {
    const { cap, handler, gitService } = makeHandler()
    await handler.handleGitMessage(createBranchMsg('s1', 'feat/x'), WS)
    expect(gitService.createBranch).toHaveBeenCalledWith('s1', 'feat/x')
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'm1',
      type: 'message.status',
      payload: { sessionId: 's1', status: 'branch_created' },
    })
    expect(cap.errors).toHaveLength(0)
  })

  it('createBranch 失败(GitError git_failed)→error envelope，不 reply success', async () => {
    const { cap, handler } = makeHandler({
      createBranch: vi.fn().mockRejectedValue(new GitError('git_failed', 'branch exists')),
    })
    await handler.handleGitMessage(createBranchMsg('s1', 'feat/x'), WS)
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1', code: 'git_failed', message: 'branch exists', details: { sessionId: 's1' } })
    expect(cap.replies).toHaveLength(0)
  })
})
describe('GitMessageHandler git.commit 路由（D5 重构：commit 后广播 changeSetInvalidated）', () => {
  it("handles 清单含 'git.commit'", () => {
    const { handler } = makeHandler()
    expect(handler.handles).toContain('git.commit')
  })

  it('commit 成功→gitService.commit 调用 + 广播 changeSetInvalidated + reply committed', async () => {
    const { cap, handler, gitService, invalidations, reply } = makeHandler()
    await handler.handleGitMessage(commitMsg('s1', 'fix: changeSet baseline diff'), WS)
    expect(gitService.commit).toHaveBeenCalledWith('s1', 'fix: changeSet baseline diff')
    // 广播必须在 reply 之前（避免前端短暂停留在 ready 态）
    expect(invalidations).toEqual([{ sessionId: 's1', reason: 'committed' }])
    expect(cap.replies[0]).toMatchObject({
      id: 'm1',
      type: 'message.status',
      payload: { sessionId: 's1', status: 'committed' },
    })
    expect(cap.errors).toHaveLength(0)
    // W17 审查 Fix-4：invocationCallOrder（全局单调递增调用序）固定「invalidate 在 reply 前」——
    // 前端收到 committed ack 后可能立即刷新 git zone，失效晚于 reply 会让刷新命中 2s 旧缓存
    const invalidateOrder = gitService.invalidateStatusCache.mock.invocationCallOrder[0] ?? -1
    const replyOrder = reply.mock.invocationCallOrder[0] ?? -1
    expect(invalidateOrder).toBeGreaterThan(0) // 已调用（invocationCallOrder 从 1 起）
    expect(replyOrder).toBeGreaterThan(0)
    expect(invalidateOrder).toBeLessThan(replyOrder)
  })

  it('commit 失败(GitError nothing_to_commit)→error envelope，不广播不 reply', async () => {
    const { cap, handler, invalidations } = makeHandler({
      commit: vi.fn().mockRejectedValue(new GitError('nothing_to_commit', 'no changes')),
    })
    await handler.handleGitMessage(commitMsg('s1', 'msg'), WS)
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1', code: 'nothing_to_commit', message: 'no changes', details: { sessionId: 's1' } })
    // commit 失败时不应广播失效（工作区未变）
    expect(invalidations).toHaveLength(0)
    expect(cap.replies).toHaveLength(0)
  })
})
describe('GitMessageHandler 写操作失效（perf W17，03 D4-3 U2）', () => {
  /** 生成一条 ClientMessage（类型字面量 + payload 原样透传）。 */
  function msg<T extends string>(type: T, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
    return { type, id, payload } as unknown as ClientMessage
  }

  it('git.stage 成功→invalidateStatusCache({sessionId})，在 reply 前', async () => {
    const { handler, gitService, cap } = makeHandler()
    await handler.handleGitMessage(msg('git.stage', { sessionId: 's1', filePaths: ['a.ts'] }), WS)
    expect(gitService.stage).toHaveBeenCalledWith('s1', ['a.ts'])
    expect(gitService.invalidateStatusCache).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(cap.replies).toHaveLength(1) // ack 照常
  })

  it('git.unstage 成功→invalidateStatusCache({sessionId})', async () => {
    const { handler, gitService } = makeHandler()
    await handler.handleGitMessage(msg('git.unstage', { sessionId: 's1' }), WS)
    expect(gitService.invalidateStatusCache).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('git.commit 成功→invalidateStatusCache({sessionId})（广播 changeSetInvalidated 之后）', async () => {
    const { handler, gitService, invalidations } = makeHandler()
    await handler.handleGitMessage(commitMsg('s1', 'msg'), WS)
    expect(gitService.invalidateStatusCache).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(invalidations).toEqual([{ sessionId: 's1', reason: 'committed' }])
  })

  it('git.checkout 成功→invalidateStatusCache({sessionId, cwd})（W17 审查 Fix-2：checkout 改 worktree HEAD，按 cwd 失效与 checkoutCwd 对称）', async () => {
    const { handler, gitService, sessionService } = makeHandler()
    vi.mocked(sessionService.getSummary).mockReturnValue({ cwd: '/repo' })
    await handler.handleGitMessage(checkoutMsg('s1', 'main'), WS)
    expect(gitService.invalidateStatusCache).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/repo' })
  })

  it('git.checkout 成功但 getSummary 竞态返回空→退回 {sessionId}（至少保住单 session 失效）', async () => {
    const { handler, gitService } = makeHandler()
    await handler.handleGitMessage(checkoutMsg('s1', 'main'), WS)
    expect(gitService.invalidateStatusCache).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('git.checkoutCwd 成功→invalidateStatusCache({cwd})（session-less，按 cwd 失效）', async () => {
    const { handler, gitService, cap } = makeHandler()
    await handler.handleGitMessage(msg('git.checkoutCwd', { cwd: '/repo', name: 'main' }), WS)
    expect(gitService.checkoutByCwd).toHaveBeenCalledWith('/repo', 'main')
    expect(gitService.invalidateStatusCache).toHaveBeenCalledWith({ cwd: '/repo' })
    expect(cap.replies[0]).toMatchObject({ payload: { status: 'switched' } })
  })

  it('git.createBranch 成功→invalidateStatusCache({sessionId})', async () => {
    const { handler, gitService } = makeHandler()
    await handler.handleGitMessage(createBranchMsg('s1', 'feat/x'), WS)
    expect(gitService.invalidateStatusCache).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('写操作失败→不失效（状态未变，缓存仍有效）', async () => {
    const { handler, gitService, cap } = makeHandler({
      stage: vi.fn().mockRejectedValue(new GitError('stage_failed', 'boom')),
    })
    await handler.handleGitMessage(msg('git.stage', { sessionId: 's1' }), WS)
    expect(gitService.invalidateStatusCache).not.toHaveBeenCalled()
    expect(cap.errors).toHaveLength(1)
  })
})
describe('W17 审查 Fix-2 全链：checkout(sessionId) 按 cwd 失效（同 worktree HEAD 对全部同 cwd session 可见）', () => {
  /**
   * 真实链条 GitMessageHandler → GitService → GitStateService（executor 用 fake，不真 spawn git）。
   * 可证伪性：TTL 设 60s——若 handler 仍只 invalidate(sessionId)，session B 的二次 status
   * 会命中缓存零 spawn，下方 spawn 数断言失败。
   */
  it('session A checkout 后，同 cwd 的 session B 缓存也失效（重新执行而非命中旧缓存）', async () => {
    const exec = vi.fn(async (_cwd: string, command: GitCommand): Promise<GitExecutorResult> => {
      if (command === 'status') return { stdout: '## main\0 M a.ts\0', stderr: '', exitCode: 0 }
      if (command === 'diff') return { stdout: '3\t1\ta.ts\n', stderr: '', exitCode: 0 }
      if (command === 'branch') return { stdout: 'feat-x\nmain\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 } // checkout 等
    })
    const executor: IGitExecutor = { exec }
    const stateService = new GitStateService({ executor, repoObserver: stubObserver, statusTtlMs: 60_000 })
    const summaries: Record<string, { cwd: string }> = { 'sid-a': { cwd: '/repo' }, 'sid-b': { cwd: '/repo' } }
    const gitService = new GitService({
      sessionService: { getSummary: (sid: string) => summaries[sid] },
      executor,
      stateService,
    } as unknown as ConstructorParameters<typeof GitService>[0])
    const reply = vi.fn()
    const handler = new GitMessageHandler({
      send: vi.fn(),
      reply,
      sendError: vi.fn(),
      sessionService: { getSummary: (sid: string) => summaries[sid] },
      gitService,
      broadcastChangeSetInvalidated: vi.fn(),
    } as unknown as ConstructorParameters<typeof GitMessageHandler>[0])
    const statusMsg = (sessionId: string): ClientMessage =>
      ({ type: 'git.status', id: `st-${sessionId}`, payload: { sessionId } }) as unknown as ClientMessage

    // 双 session 各预热一组缓存（status+diff+branch = 3 spawn/组）
    await handler.handleGitMessage(statusMsg('sid-a'), WS)
    await handler.handleGitMessage(statusMsg('sid-b'), WS)
    expect(exec.mock.calls.length).toBe(6)

    // TTL 窗口内 session A checkout（+1 checkout spawn）
    await handler.handleGitMessage(checkoutMsg('sid-a', 'feat-x'), WS)
    expect(exec.mock.calls.length).toBe(7)
    expect(reply).toHaveBeenCalledWith(WS, 'm1', 'message.status', { sessionId: 'sid-a', status: 'switched' })

    // session B 再取 status：按 cwd 失效 ⇒ 重执行一组（6+1+3=10）；只 invalidate(sid-a) 则命中缓存停在 7
    await handler.handleGitMessage(statusMsg('sid-b'), WS)
    expect(exec.mock.calls.length).toBe(10)
  })
})
describe('GitMessageHandler git.diff 路由（U07 覆盖缺口补齐）', () => {
  it('getFileDiff 成功 → reply git.diff:result {sessionId, patch, binary}', async () => {
    const { cap, handler, gitService } = makeHandler({
      getFileDiff: vi.fn().mockResolvedValue({ patch: 'diff --git a/x b/x', binary: false }),
    })

    await handler.handleGitMessage(diffMsg('s1', 'x/a.ts'), WS)

    expect(gitService.getFileDiff).toHaveBeenCalledWith('s1', 'x/a.ts')
    expect(cap.errors).toHaveLength(0)
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toEqual({
      id: 'm1',
      type: 'git.diff:result',
      payload: { sessionId: 's1', patch: 'diff --git a/x b/x', binary: false },
    })
  })

  it('getFileDiff 失败(GitError)→error envelope（code/sessionId 透传），不 reply', async () => {
    const { cap, handler } = makeHandler({
      getFileDiff: vi.fn().mockRejectedValue(new GitError('git_failed', 'diff boom')),
    })

    await handler.handleGitMessage(diffMsg('s1', 'x/a.ts', 'm2'), WS)

    expect(cap.replies).toHaveLength(0)
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({ id: 'm2', code: 'git_failed', message: 'diff boom', details: { sessionId: 's1' } })
  })
})
});

// ======================================================================
// ← test/new-task/git-service.test.ts
// ======================================================================

/** stub 观测器：用例不触观测器链，仅满足 GitStateService 必选依赖（类型收窄）。 */
const stubObserver_m2 = {
  readObservation: () => { throw new Error('stub observer 不应被调用') },
  pruneCache: () => {},
  invalidateCwd: () => {},
} as unknown as import('../../src/services/git/repo-observer.js').GitRepoObserver


const executor = { exec: vi.fn() }

const sessionService = { getSummary: vi.fn() }


function svc(): GitService {
  return new GitService({
    sessionService: sessionService as unknown as GitServiceOptions['sessionService'],
    executor: executor as unknown as IGitExecutor,
    // perf W17 收编：getStatus 走真 GitStateService（共享 executor mock）——下方 getStatus
    // 用例即为「收编后行为等价」回归（分支列表 / per-file 行数 / -uall 参数语义不变）
    stateService: new GitStateService({ executor: executor as unknown as IGitExecutor, repoObserver: stubObserver_m2 }),
  })
}


function res(over: Partial<GitExecutorResult> = {}): GitExecutorResult {
  return { stdout: '', stderr: '', exitCode: 0, ...over }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('git-service', () => {
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
    // 执行（D3-1 的 8000ms 墙钟已随 ADR-0122 退役，回退 executor 默认档）
    expect(executor.exec).toHaveBeenNthCalledWith(1, '/repo', 'status', [
      '--porcelain=v1', '-z', '-b', '--untracked-files=all',
    ])
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
});
