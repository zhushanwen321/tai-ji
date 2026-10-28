import { FsExecutor } from '../src/infra/fs-executor.js';
import { deriveCounts, parseGitStatus, parseNumstatEntries, type NumstatEntry, xyToGitStatus } from '../src/infra/git/git-status-parser.js';
import { FileChangeDiffAdapter } from '../src/infra/pi/file-change-diff-adapter.js';
import { computeLineCounts, diffSnapshots, parseGitStatusPorcelain, xyToStatus } from '../src/infra/pi/file-change-reconciler.js';
import { _resetSessionMetaCacheForTest, cleanupMigrateResidues, cleanupTmpMigrateResidue, extractSessionOutcome, invalidateScanDirCache, normalizeSessionFileInPlace, persistAgentBinding, persistHandoffSidecar, persistPresetBinding, persistProjectBinding, persistSessionEnd, projectSidecarPath, scanPiSessions, type SessionOutcome } from '../src/infra/pi/session-file-utils.js';
import type { ISessionService } from '../src/interfaces.js';
import { FileError } from '../src/services/file-error.js';
import { FileService, MAX_SEARCH_RESULTS, type FileServiceOptions } from '../src/services/file-service.js';
import { GitError, GitService, type GitServiceOptions } from '../src/services/git-service.js';
import { GitStateService } from '../src/services/git/git-state-service.js';
import type { FsEntry, IFileExecutor } from '../src/services/ports/file-executor.js';
import { GitExecutorError, type GitCommand, type GitExecutorResult, type IGitExecutor } from '../src/services/ports/git-executor.js';
import { FileMessageHandler } from '../src/transport/file-message-handler.js';
import { FileChange, FileChangeStatus, type ClientMessage, type GitFileStatus } from '@taiji/shared';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


/** stub 观测器：用例不触观测器链，仅满足 GitStateService 必选依赖（类型收窄）。 */
const stubObserver = {
  readObservation: () => { throw new Error('stub observer 不应被调用') },
  pruneCache: () => {},
  invalidateCwd: () => {},
} as unknown as import('../src/services/git/repo-observer.js').GitRepoObserver


const executor = { exec: vi.fn() }


const sessionService = { getSummary: vi.fn() }


function svc(): GitService {
  return new GitService({
    sessionService: sessionService as unknown as GitServiceOptions['sessionService'],
    executor: executor as unknown as IGitExecutor,
    // getFileDiff 不经状态服务；注入真 GitStateService（共享 executor）满足必选依赖
    stateService: new GitStateService({ executor: executor as unknown as IGitExecutor, repoObserver: stubObserver }),
  })
}


function res(over: Partial<GitExecutorResult> = {}): GitExecutorResult {
  return { stdout: '', stderr: '', exitCode: 0, ...over }
}


// ======================================================================
// ← test/git-service-status-cache.test.ts
// ======================================================================

/**
 * GitService.getStatus 收编端到端单测（perf W17 验收①，03-git-state-service D4-4 U2）。
 *
 * 覆盖（真 GitStateService + fake executor_m2，不起真实 git）：
 * - TTL 命中：同 sid 连续两次 getStatus，第二次零 exec（executor_m2.exec 计数停在首次聚合的 3 次）
 * - invalidateStatusCache({sessionId}) 后重新执行——「写操作后立即 getStatus 不返回陈旧」
   的服务层链路（handler 侧失效调用见 new-task/git-message-handler.test.ts）
 * - invalidateStatusCache({cwd}) 按 cwd 失效（session-less 写操作场景，跨 session 生效）
 * - 非 git 仓库 → isRepo=false 降级（收编后降级语义不变）
 * - session 不存在 → GitError('session_not_found')（session→cwd 解析留在 GitService）
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/git-service-status-cache.test.ts
 */
/** stub 观测器：用例不触观测器链，仅满足 GitStateService 必选依赖（类型收窄）。 */
const stubObserver_m2 = {
  readObservation: () => { throw new Error('stub observer 不应被调用') },
  pruneCache: () => {},
  invalidateCwd: () => {},
} as unknown as import('../src/services/git/repo-observer.js').GitRepoObserver


const executor_m2 = { exec: vi.fn() }


const sessionService_m2 = { getSummary: vi.fn() }


function res_m2(over: Partial<GitExecutorResult> = {}): GitExecutorResult {
  return { stdout: '', stderr: '', exitCode: 0, ...over }
}


/** 标准仓库 mock：status / numstat / branch 三命令各返回一次（GitStateService 内部并发消费）。
 * 只覆盖 implementation 不清调用记录（计数是断言基数；用例间清理由 beforeEach clearAllMocks 负责）。 */
function stubRepo(branchList = 'main\n') {
  executor_m2.exec.mockImplementation(async (_cwd: string, command: string) => {
    if (command === 'status') return res_m2({ stdout: `## main\u0000 M a.ts\u0000` })
    if (command === 'diff') return res_m2({ stdout: '1\t2\ta.ts\n' })
    return res_m2({ stdout: branchList })
  })
}


function svc_m2(): GitService {
  return new GitService({
    sessionService: sessionService_m2 as unknown as GitServiceOptions['sessionService'],
    executor: executor_m2 as unknown as IGitExecutor,
    stateService: new GitStateService({ executor: executor_m2 as unknown as IGitExecutor, repoObserver: stubObserver_m2 }),
  })
}


// ======================================================================
// ← test/file-change-diff-adapter.test.ts
// ======================================================================

/** stub 观测器：用例不触观测器链，仅满足 GitStateService 必选依赖（类型收窄）。 */
const stubObserver_m3 = {
  readObservation: () => { throw new Error('stub observer 不应被调用') },
  pruneCache: () => {},
  invalidateCwd: () => {},
} as unknown as import('../src/services/git/repo-observer.js').GitRepoObserver


type ExecImpl = (cwd: string, command: GitCommand, args: string[]) => Promise<GitExecutorResult>


/** 手写 fake IGitExecutor：记录全部调用（含 timeoutMs），行为可编程。 */
function createFakeExecutor() {
  const calls: Array<{ cwd: string; command: GitCommand; args: string[]; timeoutMs: number | undefined }> = []
  let impl: ExecImpl = async () => ({ stdout: '', stderr: '', exitCode: 0 })
  const exec = vi.fn(
    async (cwd: string, command: GitCommand, args: string[] = [], opts?: { timeoutMs?: number }) => {
      calls.push({ cwd, command, args, timeoutMs: opts?.timeoutMs })
      return impl(cwd, command, args)
    },
  )
  const executor: IGitExecutor = { exec }
  return {
    executor,
    calls,
    countOf: (command: GitCommand) => calls.filter((c) => c.command === command).length,
    setImpl(next: ExecImpl) { impl = next },
  }
}


function makeAdapter(fake: ReturnType<typeof createFakeExecutor>) {
  const gitState = new GitStateService({ executor: fake.executor, repoObserver: stubObserver_m3 })
  return new FileChangeDiffAdapter(gitState)
}


/** 按子命令路由的可编程 status/numstat 输出。 */
function statusNumstatImpl(statusOut: () => string, numstatOut: () => string): ExecImpl {
  return async (_cwd, command) =>
    command === 'status'
      ? { stdout: statusOut(), stderr: '', exitCode: 0 }
      : { stdout: numstatOut(), stderr: '', exitCode: 0 }
}


// ======================================================================
// ← test/file-message-handler.test.ts
// ======================================================================

interface CapturedReply {
  id: string | undefined
  type: string
  payload: Record<string, unknown>
}


interface CapturedError {  // oe-exempt:20261027:test:
  code: string
  message: string
  id: string | undefined
  details?: Record<string, unknown>
}


/** 构造 mock ctx + 捕获 reply/error。fileService 各方法可按用例 override（未给的为 undefined）。 */
function makeHandler(fileServiceMethods: Record<string, ReturnType<typeof vi.fn>>) {
  const replies: CapturedReply[] = []
  const errors: CapturedError[] = []
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id: string | undefined, details?: Record<string, unknown>) => {
      errors.push({ code, message, id, details })
    }),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      replies.push({ id, type, payload })
    }),
    fileService: fileServiceMethods,
  }
  const handler = new FileMessageHandler(ctx as unknown as ConstructorParameters<typeof FileMessageHandler>[0])
  return { replies, errors, handler }
}


function buildMsg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}


const WS = {} as never


// ======================================================================
// ← test/file-read-permission.test.ts
// ======================================================================

const executor_m3 = { listDir: vi.fn(), stat: vi.fn(), readFile: vi.fn() }


const sessionService_m3 = { getSummary: vi.fn() }


const ALLOWED = ['/home/user/.agents/skills', '/data/agent/skills', '/data/agent/npm']


function svc_m3(): FileService {
  return new FileService({
    sessionService: sessionService_m3 as unknown as FileServiceOptions['sessionService'],
    executor: executor_m3 as unknown as IFileExecutor,
    allowedReadDirs: ALLOWED,
  })
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('git-file-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('git-service-diff', () => {
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
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('git-service-status-cache', () => {
beforeEach(() => {
  vi.clearAllMocks()
  sessionService_m2.getSummary.mockReturnValue({ cwd: '/repo' })
})
describe('GitService.getStatus 收编（perf W17）', () => {
  it('TTL 命中：同 sid 连续两次 getStatus，第二次零 exec（首次聚合 status+diff+branch 共 3 次）', async () => {
    stubRepo()
    const service = svc_m2()
    const first = await service.getStatus('s1')
    expect(first.isRepo).toBe(true)
    expect(executor_m2.exec).toHaveBeenCalledTimes(3)

    const second = await service.getStatus('s1')
    expect(second).toEqual(first)
    // 缓存命中：exec 计数不增
    expect(executor_m2.exec).toHaveBeenCalledTimes(3)
  })

  it('invalidateStatusCache({sessionId}) 后重新执行：下次 getStatus 拿到新状态（不返回陈旧）', async () => {
    stubRepo('main\n')
    const service = svc_m2()
    await service.getStatus('s1')
    expect(executor_m2.exec).toHaveBeenCalledTimes(3)

    // 写操作成功后 handler 调失效；模拟工作区变化：分支列表多出 feat-x
    stubRepo('feat-x\nmain\n')
    service.invalidateStatusCache({ sessionId: 's1' })
    const fresh = await service.getStatus('s1')
    expect(executor_m2.exec).toHaveBeenCalledTimes(6) // 重新聚合一组
    expect(fresh.branches).toEqual(['feat-x', 'main']) // 新状态，非缓存陈旧值
  })

  it('invalidateStatusCache({cwd}) 按 cwd 失效：同 cwd 的另一 session 缓存也被清（session-less 写操作场景）', async () => {
    stubRepo()
    const service = svc_m2()
    await service.getStatus('sid-a')
    await service.getStatus('sid-b')
    expect(executor_m2.exec).toHaveBeenCalledTimes(6)

    // checkoutCwd（无 session）按 cwd 失效：两个 session 的缓存都要重新取
    stubRepo('main\n')
    service.invalidateStatusCache({ cwd: '/repo' })
    await service.getStatus('sid-a')
    await service.getStatus('sid-b')
    expect(executor_m2.exec).toHaveBeenCalledTimes(12)
  })

  it('非 git 仓库 → isRepo=false 降级（收编后降级语义不变，reply 形状不变）', async () => {
    executor_m2.exec.mockImplementation(async () =>
      res_m2({ stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }),
    )
    const result = await svc_m2().getStatus('s1')
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
    sessionService_m2.getSummary.mockReturnValue(undefined)
    await expect(svc_m2().getStatus('nope')).rejects.toMatchObject({
      code: 'session_not_found',
    })
    expect(executor_m2.exec).not.toHaveBeenCalled()
  })
})
});
// ======================================================================
// ← test/git-status-parser-shared.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('git-status-parser-shared', () => {
describe('xyToGitStatus', () => {
  it('?? → untracked', () => {
    expect(xyToGitStatus('??')).toBe('untracked')
  })

  it('A  → added', () => {
    expect(xyToGitStatus('A ')).toBe('added')
  })

  it('D  → deleted', () => {
    expect(xyToGitStatus('D ')).toBe('deleted')
    expect(xyToGitStatus(' D')).toBe('deleted')
  })

  it('R  → renamed', () => {
    expect(xyToGitStatus('R ')).toBe('renamed')
  })

  it('C  → renamed', () => {
    expect(xyToGitStatus('C ')).toBe('renamed')
  })

  it('M  → modified', () => {
    expect(xyToGitStatus('M ')).toBe('modified')
    expect(xyToGitStatus(' M')).toBe('modified')
    expect(xyToGitStatus('MM')).toBe('modified')
  })

  it('T  → modified (type change)', () => {
    expect(xyToGitStatus('T ')).toBe('modified')
    expect(xyToGitStatus(' T')).toBe('modified')
  })

  it('U  → unmerged (conflict)', () => {
    expect(xyToGitStatus('U ')).toBe('unmerged')
    expect(xyToGitStatus(' U')).toBe('unmerged')
    expect(xyToGitStatus('UU')).toBe('unmerged')
  })

  it('DD / AA / DU / UD → unmerged（both deleted/added + 单侧删除）', () => {
    expect(xyToGitStatus('DD')).toBe('unmerged')
    expect(xyToGitStatus('AA')).toBe('unmerged')
    expect(xyToGitStatus('DU')).toBe('unmerged')
    expect(xyToGitStatus('UD')).toBe('unmerged')
  })
})
describe('parseGitStatus', () => {
  it('空输入返回空结果', () => {
    expect(parseGitStatus('')).toEqual({ files: [] })
  })

  it('解析 branch 头 + 单个文件', () => {
    // `## main` + `M  src/foo.ts` NUL 分隔
    const output = '## main\0M  src/foo.ts'
    const result = parseGitStatus(output)
    expect(result.branch).toBe('main')
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toBe('src/foo.ts')
    expect(result.files[0].status).toBe('modified')
  })

  it('detached HEAD 返回 branch=undefined', () => {
    const output = '## HEAD (no branch)\0M  src/foo.ts'
    const result = parseGitStatus(output)
    expect(result.branch).toBeUndefined()
  })

  it('No commits yet 返回 branch=undefined', () => {
    const output = '## No commits yet on main\0?? new-file.txt'
    const result = parseGitStatus(output)
    expect(result.branch).toBeUndefined()
  })

  it('解析 upstream tracking', () => {
    const output = '## main...origin/main [ahead 2]\0M  src/foo.ts'
    const result = parseGitStatus(output)
    expect(result.branch).toBe('main')
  })

  it('重命名文件：XY=R，跳过源路径记录', () => {
    // R  old.ts\0new.ts（dst 在第一条，src 在第二条 NUL 记录）
    const output = '## main\0R  new.ts\0old.ts'
    const result = parseGitStatus(output)
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toBe('new.ts')
    expect(result.files[0].status).toBe('renamed')
  })

  it('拷贝文件：XY=C，跳过源路径记录', () => {
    const output = '## main\0C  copy.ts\0original.ts'
    const result = parseGitStatus(output)
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toBe('copy.ts')
    expect(result.files[0].status).toBe('renamed')
  })

  it('冲突文件：UU → unmerged', () => {
    const output = '## main\0UU src/conflict.ts'
    const result = parseGitStatus(output)
    expect(result.files).toHaveLength(1)
    expect(result.files[0].status).toBe('unmerged')
  })

  it('T 类型变更 → modified', () => {
    const output = '## main\0T  src/link.ts'
    const result = parseGitStatus(output)
    expect(result.files).toHaveLength(1)
    expect(result.files[0].status).toBe('modified')
  })

  it('多个文件混合状态', () => {
    const output = [
      '## main',
      'M  src/modified.ts',
      'A  src/added.ts',
      'D  src/deleted.ts',
      '?? src/untracked.ts',
    ].join('\0')
    const result = parseGitStatus(output)
    expect(result.files).toHaveLength(4)
    expect(result.files[0].status).toBe('modified')
    expect(result.files[1].status).toBe('added')
    expect(result.files[2].status).toBe('deleted')
    expect(result.files[3].status).toBe('untracked')
  })

  it('跳过空记录（连续 NUL）', () => {
    const output = '## main\0\0\0M  src/foo.ts'
    const result = parseGitStatus(output)
    expect(result.files).toHaveLength(1)
  })
})
describe('deriveCounts', () => {
  it('空文件列表返回零计数', () => {
    expect(deriveCounts([])).toEqual({ stagedCount: 0, unstagedCount: 0, hasConflict: false })
  })

  it('staged 文件（X 列有变化）', () => {
    const files = parseGitStatus('## main\0A  src/new.ts\0M  src/mod.ts').files
    const counts = deriveCounts(files)
    expect(counts.stagedCount).toBe(2)
    expect(counts.unstagedCount).toBe(0)
  })

  it('unstaged 文件（Y 列有变化）', () => {
    const files = parseGitStatus('## main\0 M src/mod.ts\0 D src/del.ts').files
    const counts = deriveCounts(files)
    expect(counts.stagedCount).toBe(0)
    expect(counts.unstagedCount).toBe(2)
  })

  it('未跟踪文件（??）计入 unstaged', () => {
    const files = parseGitStatus('## main\0?? src/new.ts').files
    const counts = deriveCounts(files)
    expect(counts.stagedCount).toBe(0)
    expect(counts.unstagedCount).toBe(1)
  })

  it('混合 staged + unstaged', () => {
    const files = parseGitStatus('## main\0MM src/foo.ts').files
    const counts = deriveCounts(files)
    expect(counts.stagedCount).toBe(1)
    expect(counts.unstagedCount).toBe(1)
  })

  it('冲突文件设置 hasConflict', () => {
    const files = parseGitStatus('## main\0UU src/conflict.ts').files
    const counts = deriveCounts(files)
    expect(counts.hasConflict).toBe(true)
  })

  it('无冲突文件 hasConflict=false', () => {
    const files = parseGitStatus('## main\0M  src/foo.ts').files
    const counts = deriveCounts(files)
    expect(counts.hasConflict).toBe(false)
  })
})
describe('parseNumstatEntries', () => {
  it('空输入返回空数组', () => {
    expect(parseNumstatEntries('')).toEqual([])
  })

  it('正常解析单行', () => {
    const entries = parseNumstatEntries('10\t5\tsrc/foo.ts')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({ add: 10, del: 5, path: 'src/foo.ts' })
  })

  it('二进制文件：add/del 为 undefined', () => {
    const entries = parseNumstatEntries('-\t-\timage.png')
    expect(entries).toHaveLength(1)
    expect(entries[0].add).toBeUndefined()
    expect(entries[0].del).toBeUndefined()
    expect(entries[0].path).toBe('image.png')
  })

  it('多行解析', () => {
    const output = '10\t5\tsrc/foo.ts\n0\t3\tsrc/bar.ts\n-\t-\timg.png'
    const entries = parseNumstatEntries(output)
    expect(entries).toHaveLength(3)
    expect(entries[2].path).toBe('img.png')
  })

  it('路径含 tab：join 还原', () => {
    // numstat 用 tab 分隔前两列，路径从第 3 列起 join('\t')
    const entries = parseNumstatEntries('1\t0\tpath/with\ttab.ts')
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe('path/with\ttab.ts')
  })

  it('跳过列数不足的行', () => {
    const entries = parseNumstatEntries('10\t5\ninvalid-line')
    expect(entries).toHaveLength(0)
  })

  it('NaN 计数解析为 undefined', () => {
    const entries = parseNumstatEntries('abc\t5\tsrc/foo.ts')
    expect(entries).toHaveLength(1)
    expect(entries[0].add).toBeUndefined()
    expect(entries[0].del).toBe(5)
  })
})
// ── 原版独有边界（自 git-status-parser.test.ts 并入，2026-09 测试舰队审查去重）──

describe('parseGitStatus / deriveCounts / parseNumstatEntries — 原版独有边界', () => {
  it('path with spaces preserved (NUL safety)', () => {
    const out = '## main\0M \tmy file with spaces.ts'
    const res = parseGitStatus(out)
    expect(res.files[0]?.path).toBe('my file with spaces.ts')
  })

  it('mixed: AM counts staged only（X=A staged，Y=M unstaged——verify single staged 不双计）', () => {
    const files: GitFileStatus[] = [{ path: 'p', xyCode: 'AM', status: 'added' }]
    const c = deriveCounts(files)
    expect(c.stagedCount).toBe(1)
    expect(c.unstagedCount).toBe(1)
  })

  it('numstat 半二进制：单字段为 -（add 有效、del 二进制）→ add 保留、del undefined', () => {
    const entries = parseNumstatEntries('5\t-\tmixed.bin')
    expect(entries).toHaveLength(1)
    expect(entries[0].add).toBe(5)
    expect(entries[0].del).toBeUndefined()
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('file-change-diff-adapter', () => {
describe('FileChangeDiffAdapter × GitStateService（W18 采集收编）', () => {
  it('A2: 并发单飞——同 cwd 并发采集共享一次 exec（重复采集零重复 spawn）', async () => {
    const fake = createFakeExecutor()
    fake.setImpl(statusNumstatImpl(() => ' M a.ts', () => ''))
    const adapter = makeAdapter(fake)

    const [s1, s2, s3] = await Promise.all([
      adapter.snapshotGitStatus('/repo'),
      adapter.snapshotGitStatus('/repo'),
      adapter.snapshotGitStatus('/repo'),
    ])
    expect(fake.countOf('status')).toBe(1)
    expect(s1).toEqual(s2)
    expect(s2).toEqual(s3)
  })

  it('A3: 不陈旧——顺序两次采集各自真实执行，第二次反映写操作后的新状态', async () => {
    const fake = createFakeExecutor()
    let statusOut = ' M a.ts'
    fake.setImpl(statusNumstatImpl(() => statusOut, () => ''))
    const adapter = makeAdapter(fake)

    const before = (await adapter.snapshotGitStatus('/repo')) as Map<string, FileChangeStatus> | null
    expect(before?.has('a.ts')).toBe(true)
    expect(before?.has('new.ts')).toBe(false)

    // 写操作：新文件出现（模拟 git status 变化）
    statusOut = ' M a.ts\n?? new.ts'
    const after = (await adapter.snapshotGitStatus('/repo')) as Map<string, FileChangeStatus> | null
    // snapshotStatus 无结果 TTL 缓存（D4-3 有意：缓存会漏报变更）→ 第二次真实执行且新鲜
    expect(fake.countOf('status')).toBe(2)
    expect(after?.get('new.ts')).toBe('added')
  })

  it('A4: 非仓库负缓存——首次 not-a-repo 失败后，60s 内二次采集零 spawn', async () => {
    const fake = createFakeExecutor()
    fake.setImpl(async () => ({
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
      exitCode: 128,
    }))
    const adapter = makeAdapter(fake)

    expect(await adapter.snapshotGitStatus('/not-repo')).toBeNull()
    expect(await adapter.numstat('/not-repo')).toBeNull()
    expect(fake.calls).toHaveLength(1)
  })

  it('A5: diffSnapshots / computeLineCounts 纯函数转发与 reconciler 行为一致', async () => {
    const fake = createFakeExecutor()
    const adapter = makeAdapter(fake)

    const snap = new Map<string, FileChangeStatus>([['a.ts', 'modified'], ['b.ts', 'added']])
    const changes: FileChange[] = adapter.diffSnapshots(snap)
    expect(changes).toHaveLength(2)
    expect(changes.map((c) => c.filePath).sort()).toEqual(['a.ts', 'b.ts'])

    adapter.computeLineCounts(changes, new Map([['a.ts', { add: 3, del: 1, path: 'a.ts' }]]))
    const a = changes.find((c) => c.filePath === 'a.ts')
    expect(a?.addLines).toBe(3)
    expect(a?.delLines).toBe(1)
    // null（采集失败）不填充行数
    const changes2: FileChange[] = adapter.diffSnapshots(snap)
    adapter.computeLineCounts(changes2, null)
    expect(changes2.find((c) => c.filePath === 'a.ts')?.addLines).toBeUndefined()
  })
})
});
// ======================================================================
// ← test/file-change-reconciler.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('file-change-reconciler', () => {
describe('file-change-reconciler', () => {
  describe('parseGitStatusPorcelain', () => {
    it('解析标准 A/M/D/?? 条目', () => {
      const output = [
        'A  src/new.ts',
        ' M src/modified.ts',
        'D  src/deleted.ts',
        '?? src/untracked.ts',
      ].join('\n')
      const entries = parseGitStatusPorcelain(output)
      expect(entries).toHaveLength(4)
      expect(entries[0]).toEqual({ xy: 'A ', path: 'src/new.ts' })
      expect(entries[1]).toEqual({ xy: ' M', path: 'src/modified.ts' })
      expect(entries[2]).toEqual({ xy: 'D ', path: 'src/deleted.ts' })
      expect(entries[3]).toEqual({ xy: '??', path: 'src/untracked.ts' })
    })

    it('解析重命名条目（取目标路径）', () => {
      const entries = parseGitStatusPorcelain('R  src/old.ts -> src/new.ts')
      expect(entries).toHaveLength(1)
      expect(entries[0]).toEqual({ xy: 'R ', path: 'src/new.ts' })
    })

    it('空输出返回空数组', () => {
      expect(parseGitStatusPorcelain('')).toEqual([])
    })
  })

  describe('xyToStatus', () => {
    it('未跟踪 ?? → added', () => {
      expect(xyToStatus('??')).toBe('added')
    })
    it('新增 A → added', () => {
      expect(xyToStatus('A ')).toBe('added')
    })
    it('修改 M（staged/working）→ modified', () => {
      expect(xyToStatus('M ')).toBe('modified')
      expect(xyToStatus(' M')).toBe('modified')
    })
    it('删除 D（staged/working）→ deleted', () => {
      expect(xyToStatus('D ')).toBe('deleted')
      expect(xyToStatus(' D')).toBe('deleted')
    })
    it('重命名/拷贝 R/C → modified（目标路径）', () => {
      expect(xyToStatus('R ')).toBe('modified')
      expect(xyToStatus('C ')).toBe('modified')
    })
  })

  describe('diffSnapshots（W18 R-09：单参数，current 全集即变更清单）', () => {
    /** 辅助：构造快照（filePath → status） */
    const snap = (entries: Record<string, FileChangeStatus>) => new Map(Object.entries(entries))

    it('current 全集即变更清单（含 turn 前已 dirty 的文件也报告）', () => {
      // [HISTORICAL] dirty 漏报修复后输出只依赖 current——turn 开始前已 dirty 的文件照常报告，
      // 否则 pi 再改这些文件时 git status 仍是 modified → 漏报 → 变更集卡不显示。
      const current = snap({ 'src/a.ts': 'modified', 'src/b.ts': 'added', 'src/new.ts': 'added' })
      const changes = diffSnapshots(current)
      expect(changes).toHaveLength(3)
      const byPath = new Map(changes.map((c) => [c.filePath, c.status]))
      expect(byPath.get('src/a.ts')).toBe('modified')
      expect(byPath.get('src/b.ts')).toBe('added')
      expect(byPath.get('src/new.ts')).toBe('added')
    })

    it('current 为 null（非仓库/采集失败）→ 空数组', () => {
      expect(diffSnapshots(null)).toEqual([])
    })

    it('current 为空快照 → 空数组（无变更不推帧）', () => {
      expect(diffSnapshots(snap({}))).toEqual([])
    })

    it('R-09 死参数验证：输出形状只含 filePath/status，全集即清单（若恢复差集语义此测试提醒行为变化）', () => {
      // R-09 删除 baseline 的依据是「baseline 对输出零影响、current 全集即变更清单」。
      // 锁定输出形状与全集语义（W18 review：原断言 diffSnapshots(current) 自比较恒真，改为
      // 有实值的形状断言）；未来若有人恢复差集语义（baseline 有 current 无 → 排除），
      // 'gone-from-nowhere.ts'（仅 current 有）会从输出消失，此测试报警。
      const current = snap({ 'keep.ts': 'modified', 'gone-from-nowhere.ts': 'added' })
      expect(diffSnapshots(current)).toEqual([
        { filePath: 'keep.ts', status: 'modified' },
        { filePath: 'gone-from-nowhere.ts', status: 'added' },
      ])
    })
  })

  describe('computeLineCounts（W18 D4-5：numstat 注入纯函数）', () => {
    /** 构造 numstat 条目 */
    const ns = (path: string, add?: number, del?: number): NumstatEntry => ({ path, add, del })
    /** 构造待填充的 FileChange（FileChange[] 注解使 addLines/delLines 可选属性可写可断言） */
    const ch = (filePath: string, status: FileChange['status']): FileChange => ({ filePath, status })

    it('numstatMap 命中：填充 addLines/delLines', () => {
      const changes: FileChange[] = [ch('a.ts', 'modified'), ch('b.ts', 'added')]
      computeLineCounts(changes, new Map([['a.ts', ns('a.ts', 10, 2)], ['b.ts', ns('b.ts', 3, undefined)]]))
      expect(changes[0].addLines).toBe(10)
      expect(changes[0].delLines).toBe(2)
      expect(changes[1].addLines).toBe(3)
      expect(changes[1].delLines).toBeUndefined() // 二进制/缺失列不覆盖
    })

    it('numstatMap 为 null（采集失败）→ 行数靠 writeContents 回退（现状降级语义）', () => {
      const changes: FileChange[] = [ch('untracked.ts', 'added')]
      computeLineCounts(changes, null, new Map([['untracked.ts', 'line1\nline2\nline3']]))
      expect(changes[0].addLines).toBe(3)
    })

    it('numstatMap 缺项 + writeContents 命中 → untracked 文件从 content 分行计数', () => {
      const changes: FileChange[] = [ch('new.ts', 'added')]
      computeLineCounts(changes, new Map(), new Map([['new.ts', 'a\nb']]))
      expect(changes[0].addLines).toBe(2)
    })

    it('numstatMap 缺项 + writeContents 缺项/空串 → 行数保持 undefined（bash 建的 untracked 无行数）', () => {
      const changes: FileChange[] = [ch('bash-made.ts', 'added'), ch('empty.ts', 'added')]
      computeLineCounts(changes, new Map(), new Map([['empty.ts', '']]))
      expect(changes[0].addLines).toBeUndefined()
      expect(changes[1].addLines).toBeUndefined()
    })

    it('numstatMap 命中优先于 writeContents（已跟踪文件不读 content）', () => {
      const changes: FileChange[] = [ch('tracked.ts', 'modified')]
      computeLineCounts(
        changes,
        new Map([['tracked.ts', ns('tracked.ts', 7, 1)]]),
        new Map([['tracked.ts', 'x\ny\nz\nw\nv\nu\nt\ns\nr\nq']]),
      )
      expect(changes[0].addLines).toBe(7)
      expect(changes[0].delLines).toBe(1)
    })

    it('空 changes → no-op（不触碰任何输入）', () => {
      const changes: FileChange[] = []
      expect(() => computeLineCounts(changes, null)).not.toThrow()
    })

    it('纯函数性：同输入同输出（D4-5 验收——签名不含 cwd，numstat 结果注入）', () => {
      // 同输入两次调用结果 deepEqual（纯函数断言）
      const first: FileChange[] = [ch('a.ts', 'modified')]
      const second: FileChange[] = [ch('a.ts', 'modified')]
      const numstatMap = new Map([['a.ts', ns('a.ts', 5, 4)]])
      computeLineCounts(first, numstatMap)
      computeLineCounts(second, numstatMap)
      expect(first).toEqual(second)
    })
  })

  describe('源码零同步子进程（W18 主线程零同步 git 验收）', () => {
    // W18 review 扩范围：热路径 3 文件——采集/纯函数层（reconciler）+ 编排层（interpreter，
    // sendDiffFileChanges 链上采集点）+ port 适配层（diff-adapter，委托 GitStateService）。
    // 任何一处回流 execSync/execFileSync 都会在 streaming 期间阻塞事件循环（所有 session
    // 的 token 流排队等待）。
    const HOT_PATH_SOURCES = [
      '../src/infra/pi/file-change-reconciler.ts',
      '../src/services/session/event-interpreter.ts',
      '../src/infra/pi/file-change-diff-adapter.ts',
    ]

    it.each(HOT_PATH_SOURCES)('%s 不含 child_process import 与 execSync/execFileSync 调用（采集已收进 GitStateService 异步路径）', (rel) => {
      const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
      // 断言 import 与调用形态（注释中的历史说明不误伤）
      expect(source).not.toMatch(/from\s+'node:child_process'/)
      expect(source).not.toMatch(/\bexecSync\s*\(/)
      expect(source).not.toMatch(/\bexecFileSync\s*\(/)
    })
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('file-message-handler', () => {
describe('FileMessageHandler — file.search', () => {
  it('U12 success：searchFiles 返回 → reply file.search:result {sessionId, files}', async () => {
    const files = [{ path: 'a.ts', name: 'a.ts', type: 'file' }]
    const { replies, handler } = makeHandler({ searchFiles: vi.fn().mockResolvedValue(files) })

    await handler.handleFileMessage(buildMsg('file.search', { sessionId: 's1' }), WS)

    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ id: 'm1', type: 'file.search:result' })
    expect(replies[0].payload).toMatchObject({ sessionId: 's1' })
    expect((replies[0].payload as { files: unknown[] }).files).toHaveLength(1)
  })

  it('U13 error：searchFiles reject session_not_found → error envelope 透传 sessionId', async () => {
    const { replies, errors, handler } = makeHandler({
      searchFiles: vi.fn().mockRejectedValue(new FileError('session_not_found', 'Session 不存在: sX')),
    })

    await handler.handleFileMessage(buildMsg('file.search', { sessionId: 'sX' }, 'm2'), WS)

    expect(replies).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'session_not_found', id: 'm2', details: { sessionId: 'sX' } })
  })

  it('U14 handles 清单含 file.search', () => {
    const { handler } = makeHandler({ searchFiles: vi.fn() })
    expect(handler.handles).toContain('file.search')
  })
})
describe('FileMessageHandler — file.search.cwd（landing cwd 路）', () => {
  it('U15 success：searchFilesInCwd 返回 → reply file.search.cwd:result {files, truncated}（payload 无 sessionId 字段）', async () => {
    const files = [{ path: 'src/a.ts', name: 'a.ts', type: 'file' }]
    const { replies, handler } = makeHandler({ searchFilesInCwd: vi.fn().mockResolvedValue({ files, truncated: true }) })

    await handler.handleFileMessage(buildMsg('file.search.cwd', { cwd: '/repo' }), WS)

    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ id: 'm1', type: 'file.search.cwd:result' })
    expect(replies[0].payload).toEqual({ files, truncated: true })
    expect(replies[0].payload).not.toHaveProperty('sessionId')
  })

  it('U16 cwd 参数透传 searchFilesInCwd（协议 payload 仅 { cwd }，无 showIgnored）', async () => {
    const searchFilesInCwd = vi.fn().mockResolvedValue({ files: [], truncated: false })
    const { handler } = makeHandler({ searchFilesInCwd })

    await handler.handleFileMessage(buildMsg('file.search.cwd', { cwd: '/repo' }, 'm9'), WS)

    expect(searchFilesInCwd).toHaveBeenCalledWith('/repo')
  })

  it('U17 error：searchFilesInCwd reject not_found → error envelope（cwd 路无 sessionId，details 省略）', async () => {
    const { replies, errors, handler } = makeHandler({
      searchFilesInCwd: vi.fn().mockRejectedValue(new FileError('not_found', 'cwd 不存在或不是目录: /gone')),
    })

    await handler.handleFileMessage(buildMsg('file.search.cwd', { cwd: '/gone' }, 'm3'), WS)

    expect(replies).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'not_found', id: 'm3' })
    expect(errors[0].details).toBeUndefined()
  })

  it('U18 handles 清单含 file.search.cwd', () => {
    const { handler } = makeHandler({})
    expect(handler.handles).toContain('file.search.cwd')
  })
})
describe('FileMessageHandler — file.read 分流 + file.write 骨架（U07 覆盖缺口补齐）', () => {
  it('file.read 有 sessionId → readFile(sessionId, path)（cwd 守门，文件树预览）', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: 'hello', truncated: true })
    const { replies, handler } = makeHandler({ readFile })

    await handler.handleFileMessage(buildMsg('file.read', { sessionId: 's1', path: 'x/a.ts' }), WS)

    expect(readFile).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledWith('s1', 'x/a.ts')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toEqual({
      id: 'm1',
      type: 'file.read:result',
      payload: { content: 'hello', truncated: true, path: 'x/a.ts' },
    })
  })

  it('file.read 无 sessionId → readFileFromWhitelist（BC-3 三目录白名单：skill 文件预览，向后兼容）', async () => {
    const readFileFromWhitelist = vi.fn().mockResolvedValue({ content: 'skill body', truncated: false })
    const { replies, handler } = makeHandler({ readFileFromWhitelist })

    await handler.handleFileMessage(buildMsg('file.read', { path: 'skills/x/SKILL.md' }), WS)

    expect(readFileFromWhitelist).toHaveBeenCalledTimes(1)
    expect(readFileFromWhitelist).toHaveBeenCalledWith('skills/x/SKILL.md')
    expect(replies).toHaveLength(1)
    expect(replies[0]?.payload).toEqual({ content: 'skill body', truncated: false, path: 'skills/x/SKILL.md' })
  })

  it.each([
    { type: 'file.write.create', method: 'createFile', payload: { sessionId: 's1', path: 'x/n.md', content: 'hi' }, expected: { sessionId: 's1', path: 'x/n.md', implemented: false } },
    { type: 'file.write.rename', method: 'renameFile', payload: { sessionId: 's1', oldPath: 'a.md', newPath: 'b.md' }, expected: { sessionId: 's1', newPath: 'b.md', implemented: false } },
    { type: 'file.write.delete', method: 'deleteFile', payload: { sessionId: 's1', path: 'x/n.md' }, expected: { sessionId: 's1', path: 'x/n.md', implemented: false } },
  ])('AC-14.4：$type 抛 not_implemented → 转结构化 result（非 error envelope）', async ({ type, method, payload, expected }) => {
    const svcMethod = vi.fn().mockRejectedValue(new FileError('not_implemented'))
    const { replies, errors, handler } = makeHandler({ [method]: svcMethod })

    await handler.handleFileMessage(buildMsg(type, payload), WS)

    expect(errors).toHaveLength(0)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toEqual({ id: 'm1', type: `${type}:result`, payload: expected })
  })

  it('AC-14.4 反向：file.write.create 抛非 not_implemented 的 FileError → 仍走 error envelope', async () => {
    const createFile = vi.fn().mockRejectedValue(new FileError('permission_denied', 'denied'))
    const { replies, errors, handler } = makeHandler({ createFile })

    await handler.handleFileMessage(buildMsg('file.write.create', { sessionId: 's1', path: 'x/n.md', content: 'hi' }), WS)

    expect(replies).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'permission_denied', id: 'm1', details: { sessionId: 's1' } })
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('file-read-permission', () => {
beforeEach(() => {
  vi.clearAllMocks()
})
describe('FileService.readFileFromWhitelist (#7 BC-3 白名单)', () => {
  it('T6.11 白名单目录内文件可读（~/.agents/skills 下）', async () => {
    executor_m3.stat.mockResolvedValueOnce({ type: 'file', size: 100 })
    executor_m3.readFile.mockResolvedValueOnce('file content')
    const result = await svc_m3().readFileFromWhitelist('/home/user/.agents/skills/my-skill/SKILL.md')
    expect(result.content).toBe('file content')
    expect(result.truncated).toBe(false)
  })

  it('T6.3 白名单外路径 → FileError(out_of_cwd)', async () => {
    await expect(svc_m3().readFileFromWhitelist('/etc/passwd')).rejects.toMatchObject({
      code: 'out_of_cwd',
    })
    expect(executor_m3.readFile).not.toHaveBeenCalled()
  })

  it('路径穿越 ../../etc → FileError(out_of_cwd)', async () => {
    await expect(
      svc_m3().readFileFromWhitelist('/home/user/.agents/skills/../../../etc/passwd'),
    ).rejects.toMatchObject({ code: 'out_of_cwd' })
  })

  it('文件不存在 → FileError(not_found)', async () => {
    executor_m3.stat.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    await expect(
      svc_m3().readFileFromWhitelist('/home/user/.agents/skills/missing.md'),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('>1MB 文件 → truncated=true', async () => {
    const big = 'x'.repeat(2_000_000)
    executor_m3.stat.mockResolvedValueOnce({ type: 'file', size: 2_000_000 })
    executor_m3.readFile.mockResolvedValueOnce(big)
    const result = await svc_m3().readFileFromWhitelist('/home/user/.agents/skills/big.md')
    expect(result.truncated).toBe(true)
    expect(result.content.length).toBe(1_048_576) // MAX_FILE_SIZE
  })

  it('无 allowedReadDirs 配置 → 任何路径都 out_of_cwd', async () => {
    const svcNoWhitelist = new FileService({
      sessionService: sessionService_m3 as unknown as FileServiceOptions['sessionService'],
      executor: executor_m3 as unknown as IFileExecutor,
    })
    await expect(svcNoWhitelist.readFileFromWhitelist('/any/path')).rejects.toMatchObject({
      code: 'out_of_cwd',
    })
  })
})
/**
 * FileService.readFile(sessionId, path) 单测（W5 #7 BC-3 扩展：cwd 子树守门）。
 *
 * 覆盖 file.read 有 sessionId 的分流路径（file-message-handler 根据 sessionId 有无分流）：
 * - sessionId 存在 → readFile(sessionId, path) 走 cwd 守门（isUnderOrEqual(cwd, resolvedPath)）
 * - cwd 内文件可读（相对路径 + 绝对路径穿越）
 * - cwd 外路径 → FileError('out_of_cwd')
 * - bad sessionId → FileError('session_not_found')
 * - >1MB 截断
 */
describe('FileService.readFile (W5 #7 cwd 子树守门)', () => {
  const CWD = '/project/sample'

  beforeEach(() => {
    sessionService_m3.getSummary.mockReturnValue({ cwd: CWD })
  })

  it('cwd 内相对路径文件可读', async () => {
    executor_m3.stat.mockResolvedValueOnce({ type: 'file', size: 100 })
    executor_m3.readFile.mockResolvedValueOnce('file content')
    const result = await svc_m3().readFile('sess-1', 'src/index.ts')
    expect(result.content).toBe('file content')
    expect(result.truncated).toBe(false)
  })

  it('cwd 外路径 → FileError(out_of_cwd)', async () => {
    await expect(svc_m3().readFile('sess-1', '../../../etc/passwd')).rejects.toMatchObject({
      code: 'out_of_cwd',
    })
    expect(executor_m3.readFile).not.toHaveBeenCalled()
  })

  it('bad sessionId（无 cwd）→ FileError(session_not_found)', async () => {
    sessionService_m3.getSummary.mockReturnValueOnce(null)
    await expect(svc_m3().readFile('bad-sess', 'src/index.ts')).rejects.toMatchObject({
      code: 'session_not_found',
    })
  })

  it('>1MB 文件 → truncated=true', async () => {
    const big = 'x'.repeat(2_000_000)
    executor_m3.stat.mockResolvedValueOnce({ type: 'file', size: 2_000_000 })
    executor_m3.readFile.mockResolvedValueOnce(big)
    const result = await svc_m3().readFile('sess-1', 'big.log')
    expect(result.truncated).toBe(true)
    expect(result.content.length).toBe(1_048_576)
  })

  it('文件不存在 → FileError(not_found)', async () => {
    executor_m3.stat.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    await expect(svc_m3().readFile('sess-1', 'missing.ts')).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})
});
// ======================================================================
// ← test/file-service.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('file-service', () => {
// 本文件另为 FileService 合并载体（file-service-real 折叠为分节）。
/**
 * file-service.test.ts — searchFilesInCwd cwd 路用例（u2-runtime，landing `$` 候选数据通路）。
 * [ADR-0122 退役登记] F6 文件操作超时直测 describe 已随 fs 读取墙钟（READ_TIMEOUT_MS /
 * withTimeout 原语）删除。
 *
 * mock 策略照 file-service-ignore-cache.test.ts 范式（IFileExecutor + ISessionService
 * 构造注入，纯 mock 不触真实 fs）。覆盖验收条款：
 * - 合法 cwd 返回 files（全量递归 + sortNodes 排序）
 * - cwd 不存在（stat ENOENT）/ 非目录（stat type='file'）→ FileError('not_found')
 *   结构化失败（设计 D6 准入边界，不做白名单）
 * - session 路等价回归：searchFiles('s1') ≡ searchFilesInCwd(cwd)（薄包装行为不变），
 *   且 session 不存在仍抛 session_not_found（requireCwd 保留在包装层）
 */

describe('FileService · searchFilesInCwd cwd 路 + searchFiles 薄包装等价回归', () => {
  const executor = { listDir: vi.fn(), stat: vi.fn(), readFile: vi.fn() }
  const sessionService = { getSummary: vi.fn() }

  const svc = () =>
    new FileService({
      sessionService: sessionService as unknown as FileServiceOptions['sessionService'],
      executor: executor as unknown as IFileExecutor,
    })

  const enoent = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

  /** /repo stat 目录命中，其余（.gitignore 等）ENOENT → 空 matcher，不读文件。 */
  const statRepoDir = (p: string): Promise<{ type: 'dir'; size: number; mtimeMs: number }> =>
    p === '/repo' ? Promise.resolve({ type: 'dir', size: 0, mtimeMs: 1 }) : Promise.reject(enoent())

  /** 固定小目录树：顶层 b.ts + src/ + a.ts，src/ 下 x.ts。 */
  const listRepo = async (p: string): Promise<FsEntry[]> => {
    if (p === '/repo') {
      return [
        { name: 'b.ts', type: 'file' },
        { name: 'src', type: 'dir' },
        { name: 'a.ts', type: 'file' },
      ]
    }
    if (p === '/repo/src') return [{ name: 'x.ts', type: 'file' }]
    return []
  }

  beforeEach(() => {
    vi.clearAllMocks()
    sessionService.getSummary.mockReturnValue({ cwd: '/repo' })
  })

  it('cwd 路合法目录：返回扁平 FileNode[]（dir 在前 + name 降序，子目录递归）+ truncated=false', async () => {
    executor.stat.mockImplementation(statRepoDir)
    executor.readFile.mockRejectedValue(enoent())
    executor.listDir.mockImplementation(listRepo)

    const { files, truncated } = await svc().searchFilesInCwd('/repo')

    // sortNodes：dir 在前；同类型 name 降序（x.ts > b.ts > a.ts）
    expect(files.map((n) => n.path)).toEqual(['src', 'src/x.ts', 'b.ts', 'a.ts'])
    expect(files.every((n) => !n.path.startsWith('/'))).toBe(true) // path 相对 cwd，无前导斜杠
    expect(truncated).toBe(false) // 小目录不触发 DoS 上限（D7）
  })

  it('cwd 不存在（stat ENOENT）→ FileError("not_found")，且不进入递归（准入先行）', async () => {
    executor.stat.mockRejectedValue(enoent())

    await expect(svc().searchFilesInCwd('/gone')).rejects.toMatchObject({
      name: 'FileError',
      code: 'not_found',
    })
    expect(executor.listDir).not.toHaveBeenCalled()
  })

  it('cwd 是文件非目录（stat type=file）→ FileError("not_found")', async () => {
    executor.stat.mockResolvedValue({ type: 'file', size: 3, mtimeMs: 1 })

    await expect(svc().searchFilesInCwd('/repo')).rejects.toMatchObject({
      name: 'FileError',
      code: 'not_found',
    })
  })

  it('session 路等价回归：searchFiles("s1") 与 searchFilesInCwd("…cwd") 结果一致（薄包装行为不变）', async () => {
    executor.stat.mockImplementation(statRepoDir)
    executor.readFile.mockRejectedValue(enoent())
    executor.listDir.mockImplementation(listRepo)

    const service = svc()
    const viaSession = await service.searchFiles('s1')
    const viaCwd = await service.searchFilesInCwd('/repo')
    expect(viaSession).toEqual(viaCwd.files)
    expect(viaSession.map((n) => n.path)).toEqual(['src', 'src/x.ts', 'b.ts', 'a.ts'])
  })

  it('session 路回归：session 不存在仍抛 session_not_found（requireCwd 保留在包装层）', async () => {
    sessionService.getSummary.mockReturnValue(undefined)

    await expect(svc().searchFiles('sX')).rejects.toMatchObject({
      name: 'FileError',
      code: 'session_not_found',
    })
  })

  it('session 存在但 cwd 目录已删（stat ENOENT）→ not_found（非 session_not_found，D6 #12）', async () => {
    // beforeEach 已置 getSummary → { cwd: '/repo' }：session 在、目录没了——session 路
    // 照样走 cwd 准入 stat，失败分类为 not_found（错误码语义：目录缺失 ≠ session 缺失）
    executor.stat.mockRejectedValue(enoent())

    await expect(svc().searchFiles('s1')).rejects.toMatchObject({
      name: 'FileError',
      code: 'not_found',
    })
    expect(executor.listDir).not.toHaveBeenCalled()
  })

  it('cwd 归一化（D6 #11）：`~/repo` 与带冗余段的 `/repo/./` 均 stat 归一后路径', async () => {
    const home = homedir()
    const statCalls: string[] = []
    // 归一后根有两形：/repo 与 <home>/repo（~ 展开产物）——都按目录命中
    const statNormalizedRepoDir = (p: string): Promise<{ type: 'dir'; size: number; mtimeMs: number }> =>
      p === '/repo' || p === join(home, 'repo')
        ? Promise.resolve({ type: 'dir', size: 0, mtimeMs: 1 })
        : Promise.reject(enoent())
    executor.stat.mockImplementation((p: string) => {
      statCalls.push(p)
      return statNormalizedRepoDir(p)
    })
    executor.readFile.mockRejectedValue(enoent())
    // ~ 展开后的根走 walk：listDir 把 <home>/repo 前缀映射回 /repo 的同一目录树
    const homeRepoPrefix = `${join(home, 'repo')}/`
    executor.listDir.mockImplementation(async (p: string) =>
      p === join(home, 'repo') ? listRepo('/repo') : listRepo(p.startsWith(homeRepoPrefix) ? p.replace(homeRepoPrefix, '/repo/') : p),
    )

    const { files } = await svc().searchFilesInCwd('~/repo')
    expect(files.map((n) => n.path)).toEqual(['src', 'src/x.ts', 'b.ts', 'a.ts'])
    expect(statCalls[0]).toBe(join(home, 'repo')) // ~ 已展开（executor 收到的全是规范绝对路径）

    statCalls.length = 0
    await svc().searchFilesInCwd('/repo/.')
    expect(statCalls[0]).toBe('/repo') // resolve 归一（尾段冗余剥离）
  })

  it('DoS 上限 5000 截止（D7）：同层还有未收集条目 → files 截在 5000 + truncated=true', async () => {
    // 单层 5001 文件：收集到第 5000 个时 cap 截止、本层还剩 1 条未收集（硬信号）
    executor.stat.mockImplementation(statRepoDir)
    executor.readFile.mockRejectedValue(enoent())
    executor.listDir.mockImplementation(async (p: string) =>
      p === '/repo'
        ? Array.from({ length: MAX_SEARCH_RESULTS + 1 }, (_, i) => ({ name: `f${i}.ts`, type: 'file' }))
        : [],
    )

    const { files, truncated } = await svc().searchFilesInCwd('/repo')

    expect(files).toHaveLength(MAX_SEARCH_RESULTS)
    expect(truncated).toBe(true)
  })

  it('DoS 上限边界（D7）：恰 5000 条全量收集完（自然扫完无剩余）→ truncated=false', async () => {
    executor.stat.mockImplementation(statRepoDir)
    executor.readFile.mockRejectedValue(enoent())
    executor.listDir.mockImplementation(async (p: string) =>
      p === '/repo'
        ? Array.from({ length: MAX_SEARCH_RESULTS }, (_, i) => ({ name: `f${i}.ts`, type: 'file' }))
        : [],
    )

    const { files, truncated } = await svc().searchFilesInCwd('/repo')

    expect(files).toHaveLength(MAX_SEARCH_RESULTS)
    expect(truncated).toBe(false)
  })
})
/**
 * file.write 骨架契约（#14 AC-14，自 file-write-skeleton.test.ts 并入）。
 *
 * FileService 三个写方法当前为骨架，一律 throw FileError('not_implemented')（#14 G4 实现延后）；
 * handler 侧 catch 后转结构化 { implemented:false } 的语义由 file-message-handler.test.ts AC-14.4 覆盖。
 * 若写实现落地，本 describe 应重写为真实行为测试（而非删除）。
 */
describe('FileService file.write 骨架 (#14 AC-14)', () => {
  const skeletonExecutor = { listDir: vi.fn(), stat: vi.fn(), readFile: vi.fn() }
  const skeletonSessionService = { getSummary: vi.fn() }

  const skeletonSvc = () =>
    new FileService({
      sessionService: skeletonSessionService as unknown as FileServiceOptions['sessionService'],
      executor: skeletonExecutor as unknown as IFileExecutor,
    })

  beforeEach(() => {
    vi.clearAllMocks()
    // 骨架在抛 not_implemented 前先 requireCwd 校验 session 存在
    skeletonSessionService.getSummary.mockReturnValue({ cwd: '/repo' })
  })

  it('AC-14.1~14.3 createFile/renameFile/deleteFile 均抛 FileError(not_implemented) 且不触达 executor', async () => {
    await expect(skeletonSvc().createFile('s1', 'a.txt', 'hi')).rejects.toMatchObject({
      name: 'FileError',
      code: 'not_implemented',
    })
    await expect(skeletonSvc().renameFile('s1', 'a.txt', 'b.txt')).rejects.toMatchObject({
      code: 'not_implemented',
    })
    await expect(skeletonSvc().deleteFile('s1', 'a.txt')).rejects.toMatchObject({
      code: 'not_implemented',
    })
    expect(skeletonExecutor.listDir).not.toHaveBeenCalled()
    expect(skeletonExecutor.readFile).not.toHaveBeenCalled()
  })
})
// ════════════════ 来源: file-service-real.test.ts ════════════════

describe('file-service-real', () => {
  describe('FileService.readFile real fs', () => {
    let tempDir: string
    let service: FileService

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'file-service-real-'))
      const sessionService: ISessionService = {
        getSummary: vi.fn().mockReturnValue({ cwd: tempDir }),
      } as unknown as ISessionService
      service = new FileService({ sessionService, executor: new FsExecutor() })
    })

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('E1: cwd 内文件正常读取', async () => {
      const insideFile = join(tempDir, 'inside.md')
      writeFileSync(insideFile, 'inside content')

      const result = await service.readFile('s1', 'inside.md')
      expect(result).toEqual({ content: 'inside content', truncated: false })
    })

    it('E2: cwd 外绝对路径 → FileError(out_of_cwd)', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'file-service-outside-'))
      const outsideFile = join(outsideDir, 'outside.md')
      writeFileSync(outsideFile, 'outside content')

      try {
        await expect(service.readFile('s1', outsideFile)).rejects.toMatchObject({
          name: 'FileError',
          code: 'out_of_cwd',
        })
      } finally {
        rmSync(outsideDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    it('E3: cwd 外绝对路径抛出的是 FileError 实例（类型检查）', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'file-service-outside-'))
      const outsideFile = join(outsideDir, 'outside.md')
      writeFileSync(outsideFile, 'outside content')

      try {
        await expect(service.readFile('s1', outsideFile)).rejects.toBeInstanceOf(FileError)
      } finally {
        rmSync(outsideDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })
  })

  /**
   * symlink 形态不一致场景（A1 实测回归）：session cwd 是前端/DB 记录的词法形态，
   * pi 子进程 process.cwd() 拼出的目标常是解析后物理形态（macOS /tmp → /private/tmp），
   * 纯词法前缀判定误拒同一物理目录内的文件。守门前两侧 realpath 归一后应放行。
   *
   * 构造：realDir（真实目录）+ linkDir（指向 realDir 的 symlink 别名）互为同一物理目录的
   * 两种形态——与 macOS /tmp vs /private/tmp 机制同构且跨平台确定（macOS 上 tmpdir 自身
   * 还叠加 /var → /private/var 一层，realDir 的 mkdtemp 返回值本身即词法形态）。
   */
  describe('FileService.readFile symlink 形态不一致（realpath 归一守门）', () => {
    let realDir: string
    let linkParent: string
    let linkDir: string

    beforeEach(() => {
      realDir = mkdtempSync(join(tmpdir(), 'file-service-sym-real-'))
      linkParent = mkdtempSync(join(tmpdir(), 'file-service-sym-link-'))
      linkDir = join(linkParent, 'alias')
      symlinkSync(realDir, linkDir, 'dir')
    })

    afterEach(() => {
      for (const dir of [realDir, linkParent]) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    const makeService = (cwd: string): FileService => {
      const sessionService: ISessionService = {
        getSummary: vi.fn().mockReturnValue({ cwd }),
      } as unknown as ISessionService
      return new FileService({ sessionService, executor: new FsExecutor() })
    }

    it('S1: cwd 用别名形态、目标用物理形态（A1 同构）→ 读取成功', async () => {
      writeFileSync(join(realDir, 'plan.md'), 'plan content')
      const result = await makeService(linkDir).readFile('s1', join(realDir, 'plan.md'))
      expect(result).toEqual({ content: 'plan content', truncated: false })
    })

    it('S2: 反向——cwd 用物理形态、目标用别名形态 → 读取成功', async () => {
      writeFileSync(join(realDir, 'plan.md'), 'plan content')
      const result = await makeService(realDir).readFile('s1', join(linkDir, 'plan.md'))
      expect(result).toEqual({ content: 'plan content', truncated: false })
    })

    it('S3: symlink cwd 下目标真在 cwd 外 → 仍 out_of_cwd', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'file-service-sym-out-'))
      writeFileSync(join(outsideDir, 'outside.md'), 'outside content')
      try {
        await expect(makeService(linkDir).readFile('s1', join(outsideDir, 'outside.md'))).rejects.toMatchObject({
          name: 'FileError',
          code: 'out_of_cwd',
        })
      } finally {
        rmSync(outsideDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    it('S4: 目标不存在（目标侧 realpath 失败退回词法路径）→ 仍 not_found', async () => {
      // A1 同构形态：目标前缀用 realpathSync(realDir) 的物理形态（pi 侧 process.cwd() 拼出
      // /private/tmp/... 的等价物）——realpath(cwd) 归一后与退回词法的目标串同前缀 → 守门通过，
      // not_found 由后续 stat ENOENT 给出。若退词法后误判越界或 realpath 失败抛错，此用例红。
      const physicalDir = realpathSync(realDir)
      await expect(makeService(linkDir).readFile('s1', join(physicalDir, 'missing.md'))).rejects.toMatchObject({
        name: 'FileError',
        code: 'not_found',
      })
    })
  })

  describe('FileService.readFileFromWhitelist symlink 形态不一致', () => {
    let realDir: string
    let linkParent: string
    let linkDir: string

    beforeEach(() => {
      realDir = mkdtempSync(join(tmpdir(), 'file-service-wl-real-'))
      linkParent = mkdtempSync(join(tmpdir(), 'file-service-wl-link-'))
      linkDir = join(linkParent, 'alias')
      symlinkSync(realDir, linkDir, 'dir')
    })

    afterEach(() => {
      for (const dir of [realDir, linkParent]) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    const makeWhitelistService = (allowedReadDirs: string[]): FileService =>
      new FileService({
        sessionService: { getSummary: vi.fn() } as unknown as ISessionService, // 白名单路不触达 sessionService
        executor: new FsExecutor(),
        allowedReadDirs,
      })

    it('W1: 白名单目录用别名形态、目标用物理形态 → 读取成功', async () => {
      writeFileSync(join(realDir, 'SKILL.md'), 'skill body')
      const result = await makeWhitelistService([linkDir]).readFileFromWhitelist(join(realDir, 'SKILL.md'))
      expect(result).toEqual({ content: 'skill body', truncated: false })
    })

    it('W2: 白名单外路径 → 仍 out_of_cwd', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'file-service-wl-out-'))
      writeFileSync(join(outsideDir, 'outside.md'), 'outside content')
      try {
        await expect(
          makeWhitelistService([linkDir]).readFileFromWhitelist(join(outsideDir, 'outside.md')),
        ).rejects.toMatchObject({ name: 'FileError', code: 'out_of_cwd' })
      } finally {
        rmSync(outsideDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })
  })
})
});
});

// ======================================================================
// ← session-file-utils.test.ts
// ======================================================================

// ════════════════ 来源: binding-cache-coherence.test.ts ════════════════

/** 合法 JSONL 首行（type=session header），格式与现有 sidecar 测试夹具一致。 */
function sessionHeaderLine(id: string): string {
  return `{"type":"session","id":"${id}","cwd":"/tmp","timestamp":"2026-01-01"}\n`
}


/**
 * 创建隔离的数据目录夹具：TAIJI_AGENT_DATA_DIR 指向独立 tmpdir（getSessionsDir()
 * 经 <data>/agent/sessions 解析），模块级两层缓存清零。返回 createSessionFile 工厂与
 * cleanup（env 恢复 + 缓存清零 + rmSync，放 try/finally 保证断言失败也能清理）。
 */
function setupFixture(prefix: string): {
  createSessionFile: (sessionId: string) => string
  cleanup: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const origDataDir = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = dir
  const sessionsDir = join(dir, 'agent', 'sessions')

  return {
    // mkdir 放工厂内：不需要建文件的用例（暂无）也不会留空目录歧义
    createSessionFile(sessionId: string): string {
      mkdirSync(sessionsDir, { recursive: true })
      const fp = join(sessionsDir, `${sessionId}.jsonl`)
      writeFileSync(fp, sessionHeaderLine(sessionId))
      return fp
    },
    cleanup(): void {
      _resetSessionMetaCacheForTest()
      invalidateScanDirCache()
      if (origDataDir === undefined) {
        delete process.env.TAIJI_AGENT_DATA_DIR
      } else {
        process.env.TAIJI_AGENT_DATA_DIR = origDataDir
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}


// ════════════════ 来源: session-file-utils-model-sidecar-residue.test.ts ════════════════

/** 写一个最小文件（内容非本测试关注面），返回绝对路径。 */
function writeSidecarResidueFile(dir: string, name: string, content = '{}\n'): string {
  const filePath = join(dir, name)
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}


// ════════════════ 来源: session-file-utils-tmp-migrate.test.ts ════════════════

/** 写一个合法 session JSONL（首行 session header），返回文件绝对路径。 */
function writeTmpMigrateSessionFile(dir: string, name: string, id: string, cwd: string): string {
  const filePath = join(dir, name)
  writeFileSync(
    filePath,
    JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-08-19T00:00:00Z' }) + '\n',
    'utf-8',
  )
  return filePath
}


/** 把文件 mtime 回拨到 ageMs 之前（构造过期残留；atime 同步设置，utimesSync 必填）。 */
function ageFile(filePath: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs)
  utimesSync(filePath, t, t)
}


// ════════════════ 来源: session-file-utils-migrate-cleanup.test.ts ════════════════

function tmpMigrateNames(dir: string): string[] {
  return readdirSync(dir).filter(n => n.includes('.tmp-migrate-'))
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-file-utils', () => {
// ── 写方向立即可见（A2 类：缺陷 B 写方向，5 写点逐一锁定）──────────────────

describe('persistProjectBinding（.project.json）', () => {
  it('A2: 归入项目后无参 TTL 扫描立即读到新 projectId', () => {
    const f = setupFixture('bcc-proj-')
    try {
      const fp = f.createSessionFile('sess-project')

      // 冷缓存 force 扫描填满两层缓存，确立基线：无 sidecar → projectId undefined
      let sessions = scanPiSessions({ force: true })
      expect(sessions).toHaveLength(1)
      expect(sessions[0].projectId).toBeUndefined()

      persistProjectBinding(fp, 'proj-X')

      // 无参扫描（TTL 快照路径，绝不传 force）：写点失效缓存后新值必须立即可见
      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].projectId).toBe('proj-X')
    } finally {
      f.cleanup()
    }
  })
})
describe('persistPresetBinding（.preset.json）', () => {
  it('A2: 绑定 launch preset 后无参 TTL 扫描立即读到新 presetId', () => {
    const f = setupFixture('bcc-preset-')
    try {
      const fp = f.createSessionFile('sess-preset')

      let sessions = scanPiSessions({ force: true })
      expect(sessions).toHaveLength(1)
      expect(sessions[0].launchPresetId).toBeUndefined()

      persistPresetBinding(fp, 'preset-X')

      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].launchPresetId).toBe('preset-X')
    } finally {
      f.cleanup()
    }
  })
})
describe('persistAgentBinding（.agent.json）', () => {
  it('A2/A4: 记录 agent 来源后无参 TTL 扫描立即读到 spawnSource 与父 session', () => {
    const f = setupFixture('bcc-agent-')
    try {
      const fp = f.createSessionFile('sess-agent')

      let sessions = scanPiSessions({ force: true })
      expect(sessions).toHaveLength(1)
      expect(sessions[0].spawnSource).toBeUndefined()
      expect(sessions[0].parentAgentSessionId).toBeUndefined()

      persistAgentBinding(fp, 'agent', 'parent-x')

      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].spawnSource).toBe('agent')
      expect(sessions[0].parentAgentSessionId).toBe('parent-x')
    } finally {
      f.cleanup()
    }
  })
})
describe('persistHandoffSidecar（.handoff.json）', () => {
  it('A2/A4: handoff 交接后无参 TTL 扫描立即读到 handedOffTo', () => {
    const f = setupFixture('bcc-handoff-')
    try {
      const fp = f.createSessionFile('sess-src')

      let sessions = scanPiSessions({ force: true })
      expect(sessions).toHaveLength(1)
      expect(sessions[0].handedOffTo).toBeUndefined()

      persistHandoffSidecar(fp, 'next-sess')

      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].handedOffTo).toBe('next-sess')
    } finally {
      f.cleanup()
    }
  })
})
describe('persistSessionEnd（.meta.json）', () => {
  it('A2: 会话终态落盘后无参 TTL 扫描立即读到 outcome=error', () => {
    const f = setupFixture('bcc-meta-')
    try {
      const fp = f.createSessionFile('sess-end')

      let sessions = scanPiSessions({ force: true })
      expect(sessions).toHaveLength(1)
      expect(sessions[0].outcome).toBeNull()

      persistSessionEnd(fp, 'error', 'reason-x')

      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].outcome).toBe('error')
    } finally {
      f.cleanup()
    }
  })
})
// ── 删方向立即可见（A9：移出项目，缺陷 B 镜像实例）─────────────────────────

describe('persistProjectBinding 空 projectId 删除分支', () => {
  it('A9: 移出项目（清空归属）后无参 TTL 扫描立即回到 undefined，无 1s 弹回窗口', () => {
    const f = setupFixture('bcc-unbind-')
    try {
      const fp = f.createSessionFile('sess-out')

      // 先绑 P：persistProjectBinding 自身失效缓存，随后的无参扫描从磁盘读到 proj-P 并填充两层缓存
      persistProjectBinding(fp, 'proj-P')
      let sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].projectId).toBe('proj-P')

      // 移出项目：unlink sidecar + 失效两层缓存
      persistProjectBinding(fp, '')

      // 若删除分支漏失效目录缓存，此处命中 pre-delete 快照 → proj-P 弹回（缺陷 B 镜像现象）
      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].projectId).toBeUndefined()
    } finally {
      f.cleanup()
    }
  })
})
// ── 负面对照（防恒真：证明本文件走的是真实 TTL 快照路径而非透传直读）──────────

describe('裸写 sidecar 不失效缓存的负面对照', () => {
  it('绕过 helper 的 writeFileSync 直写在 TTL 窗口内不可见，双清缓存后才可见', () => {
    const f = setupFixture('bcc-bare-')
    try {
      const fp = f.createSessionFile('sess-bare')

      // 填满两层缓存（此时无 sidecar）
      let sessions = scanPiSessions({ force: true })
      expect(sessions[0].projectId).toBeUndefined()

      // 绕过 helper 直接裸写 sidecar：不触发任何失效
      writeFileSync(projectSidecarPath(fp), JSON.stringify({ projectId: 'proj-bare', version: 1 }))

      // 立即无参扫描：目录层 TTL 快照命中 pre-write 视图 → stale（≠ 透传直读，裸写若立即可见则本断言恒真化失效）
      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].projectId).toBeUndefined()

      // 仅清目录层再扫：依然 stale——文件层 sessionMetaCache 键只含 JSONL (mtimeMs,size)，
      // sidecar 变更不变 JSONL stat（W2-2 教训声明的机制），单清目录层穿透不了它
      invalidateScanDirCache()
      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].projectId).toBeUndefined()

      // 双清（文件层 + 目录层）后再扫：TTL 首窗为空 → 从磁盘重建，裸写值此刻才可见
      _resetSessionMetaCacheForTest()
      invalidateScanDirCache()
      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].projectId).toBe('proj-bare')
    } finally {
      f.cleanup()
    }
  })
})
// ── 冷启动对照（TTL 首窗为空时正常建立缓存）───────────────────────────────

describe('冷启动对照', () => {
  it('新夹具首次无参扫描即发现 session 及预写 sidecar 的绑定字段', () => {
    const f = setupFixture('bcc-cold-')
    try {
      const fp = f.createSessionFile('sess-cold')
      // 预写 project sidecar（不经 helper，无缓存交互诉求——首窗为空，首扫必然读盘）
      writeFileSync(projectSidecarPath(fp), JSON.stringify({ projectId: 'proj-cold', version: 1 }))

      // 无任何预热（不 force、不预填）：目录层缓存为空 → 正常走磁盘扫描建立缓存
      const sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].id).toBe('sess-cold')
      expect(sessions[0].filePath).toBe(fp)
      expect(sessions[0].projectId).toBe('proj-cold')

      // 窗口内的第二次无参扫描同样稳定可见（快照复用语义）
      expect(scanPiSessions()).toHaveLength(1)
    } finally {
      f.cleanup()
    }
  })
})
describe('cleanupTmpMigrateResidue U9 家族（退役 .model.json sidecar 残留清扫）', () => {
  let dataDir: string
  let sessionsDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'u9-sidecar-residue-'))
    sessionsDir = join(dataDir, 'agent', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('残留 .model.json 删除（根目录 + cwd 子目录两层），JSONL 主文件不受影响', () => {
    const subDir = join(sessionsDir, '--Users-x-proj--')
    const rootJsonl = writeSidecarResidueFile(sessionsDir, 'sess-root.jsonl', '{"type":"session","id":"sess-root"}\n')
    const rootSidecar = writeSidecarResidueFile(sessionsDir, 'sess-root.jsonl.model.json', '{"modelId":"a/b"}')
    mkdirSync(subDir, { recursive: true })
    const subJsonl = writeSidecarResidueFile(subDir, 'sess-sub.jsonl', '{"type":"session","id":"sess-sub"}\n')
    const subSidecar = writeSidecarResidueFile(subDir, 'sess-sub.jsonl.model.json', '{"modelId":"c/d"}')

    // 启动挂点的调用形态：默认 maxAgeMs（U9 家族不受该参数约束）
    const removed = cleanupTmpMigrateResidue(sessionsDir)

    expect(removed).toBe(2)
    expect(existsSync(rootSidecar)).toBe(false)
    expect(existsSync(subSidecar)).toBe(false)
    expect(existsSync(rootJsonl)).toBe(true)
    expect(existsSync(subJsonl)).toBe(true)
  })

  it('年龄无关全删：刚写入的 sidecar 残留也删（对比：新鲜 tmp 标记残留仍按龄保留）', () => {
    const freshSidecar = writeSidecarResidueFile(sessionsDir, 'sess-1.jsonl.model.json', '{"modelId":"a/b"}')
    const freshTmp = writeSidecarResidueFile(sessionsDir, 'sess-1.jsonl.tmp-import-999.jsonl')

    const removed = cleanupTmpMigrateResidue(sessionsDir)

    expect(removed).toBe(1)
    expect(existsSync(freshSidecar)).toBe(false)
    expect(existsSync(freshTmp)).toBe(true)
  })

  it('目录无残留时零操作不抛（无 sidecar / 目录不存在均返回 0）', () => {
    writeSidecarResidueFile(sessionsDir, 'sess-1.jsonl', '{"type":"session","id":"sess-1"}\n')

    expect(cleanupTmpMigrateResidue(sessionsDir)).toBe(0)
    expect(cleanupTmpMigrateResidue(join(dataDir, 'no-such-dir'))).toBe(0)
    expect(existsSync(sessionsDir)).toBe(true)
  })

  it('只删 *.jsonl.model.json 形态：现存 sidecar 与其他命名不误删', () => {
    const metaSidecar = writeSidecarResidueFile(sessionsDir, 'sess-1.jsonl.meta.json')
    const handoffSidecar = writeSidecarResidueFile(sessionsDir, 'sess-1.jsonl.handoff.json')
    const bareModel = writeSidecarResidueFile(sessionsDir, 'notes.model.json')
    const bakSuffix = writeSidecarResidueFile(sessionsDir, 'sess-1.jsonl.model.json.bak')
    const residue = writeSidecarResidueFile(sessionsDir, 'sess-2.jsonl.model.json', '{"modelId":"x/y"}')

    const removed = cleanupTmpMigrateResidue(sessionsDir)

    expect(removed).toBe(1)
    expect(existsSync(residue)).toBe(false)
    expect(existsSync(metaSidecar)).toBe(true)
    expect(existsSync(handoffSidecar)).toBe(true)
    expect(existsSync(bareModel)).toBe(true)
    expect(existsSync(bakSuffix)).toBe(true)
  })

  it('幂等：清扫后二次执行返回 0 不抛', () => {
    writeSidecarResidueFile(sessionsDir, 'sess-1.jsonl.model.json', '{"modelId":"a/b"}')
    expect(cleanupTmpMigrateResidue(sessionsDir)).toBe(1)

    expect(cleanupTmpMigrateResidue(sessionsDir)).toBe(0)
  })
})
describe('cleanupTmpMigrateResidue（W3 残留清理）', () => {
  let dataDir: string
  let sessionsDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'w3-tmp-migrate-'))
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    invalidateScanDirCache()
    sessionsDir = join(dataDir, 'agent', 'sessions')
  })

  afterEach(() => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    invalidateScanDirCache()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('过期残留删除（根目录 + cwd 分组子目录两层都清）', () => {
    const subDir = join(sessionsDir, 'proj-a')
    mkdirSync(subDir, { recursive: true })
    const residueRoot = writeTmpMigrateSessionFile(sessionsDir, 'sess-1.jsonl.tmp-migrate-1700000000000.jsonl', 'x', '/w')
    const residueSub = writeTmpMigrateSessionFile(subDir, 'sess-2.jsonl.tmp-migrate-1700000000001.jsonl', 'x', '/w')
    ageFile(residueRoot, 2 * 3_600_000)
    ageFile(residueSub, 2 * 3_600_000)

    const removed = cleanupTmpMigrateResidue(sessionsDir, 3_600_000)

    expect(removed).toBe(2)
    expect(existsSync(residueRoot)).toBe(false)
    expect(existsSync(residueSub)).toBe(false)
  })

  it('新鲜残留保留（mtime 晚于 now-maxAgeMs 不删，防并发误删进行中的归一化临时文件）', () => {
    mkdirSync(sessionsDir, { recursive: true })
    const fresh = writeTmpMigrateSessionFile(sessionsDir, 'sess-1.jsonl.tmp-migrate-9999999999999.jsonl', 'x', '/w')

    const removed = cleanupTmpMigrateResidue(sessionsDir, 3_600_000)

    expect(removed).toBe(0)
    expect(existsSync(fresh)).toBe(true)
  })

  it('目录不存在 no-op 安全（返回 0，不上抛）', () => {
    expect(cleanupTmpMigrateResidue(join(dataDir, 'no-such-dir'), 3_600_000)).toBe(0)
  })

  it('非匹配文件零触碰（正常 session / sidecar / 非 tmp-migrate 命名的 jsonl 均保留）', () => {
    mkdirSync(sessionsDir, { recursive: true })
    const normal = writeTmpMigrateSessionFile(sessionsDir, 'sess-1.jsonl', 'sess-1', '/w')
    const sidecar = join(sessionsDir, 'sess-1.jsonl.meta.json')
    writeFileSync(sidecar, '{}', 'utf-8')
    const otherJsonl = writeTmpMigrateSessionFile(sessionsDir, 'notes.jsonl', 'x', '/w')
    ageFile(normal, 2 * 3_600_000)
    ageFile(sidecar, 2 * 3_600_000)
    ageFile(otherJsonl, 2 * 3_600_000)

    const removed = cleanupTmpMigrateResidue(sessionsDir, 3_600_000)

    expect(removed).toBe(0)
    expect(existsSync(normal)).toBe(true)
    expect(existsSync(sidecar)).toBe(true)
    expect(existsSync(otherJsonl)).toBe(true)
  })

  it('端到端：同 id 正式文件 + 残留共存 → scanPiSessions 只收录正式文件；清理后目录只剩正式文件', () => {
    const subDir = join(sessionsDir, 'proj-a')
    mkdirSync(subDir, { recursive: true })
    const official = writeTmpMigrateSessionFile(subDir, 'sess-1.jsonl', 'sess-1', '/work/a')
    // 残留与正式文件同 id（内容是合法 session——正是 isScannableSessionFile 按名排除的动机）
    const residue = writeTmpMigrateSessionFile(subDir, 'sess-1.jsonl.tmp-migrate-1700000000000.jsonl', 'sess-1', '/work/a')
    ageFile(residue, 2 * 3_600_000)

    // 全链路：scanPiSessions（目录 TTL 缓存 + 文件名过滤 + header 解析）不收录残留
    const scanned = scanPiSessions()
    expect(scanned).toHaveLength(1)
    expect(scanned[0].id).toBe('sess-1')
    expect(scanned[0].filePath).toBe(official)

    // 清理后：目录只剩正式文件（残留被删、正式文件未动）
    const removed = cleanupTmpMigrateResidue(sessionsDir, 3_600_000)
    expect(removed).toBe(1)
    expect(existsSync(residue)).toBe(false)
    expect(existsSync(official)).toBe(true)
    // 清理后再扫仍一致（清理未破坏扫描视图）
    invalidateScanDirCache()
    expect(scanPiSessions()).toHaveLength(1)
  })
})
// ════════════════ 来源: session-scan-degraded.test.ts ════════════════

describe('scanPiSessions · 降级计数 + 轮末汇总（RT-3#2）', () => {
  let dir: string
  let warnSpy: MockInstance<typeof console.warn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scan-degraded-rt3-2-'))
    process.env.TAIJI_AGENT_DATA_DIR = dir
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    delete process.env.TAIJI_AGENT_DATA_DIR
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** sessions 目录（getSessionsDir = <dataDir>/agent/sessions）。 */
  function sessionsDir(): string {
    return join(dir, 'agent', 'sessions')
  }

  function writeSession(name: string, id: string): string {
    const p = join(sessionsDir(), name)
    writeFileSync(p, `{"type":"session","version":3,"id":"${id}","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n`, 'utf-8')
    return p
  }

  it('非 session 首行的 .jsonl → 不收录 + 汇总 warn 含 noHeader 计数与样例路径', () => {
    mkdirSync(sessionsDir(), { recursive: true })
    const bad = join(sessionsDir(), 'not-a-session.jsonl')
    writeFileSync(bad, '{"type":"label","label":"x"}\n', 'utf-8')

    const results = scanPiSessions({ force: true })

    expect(results).toHaveLength(0)
    const summary = warnSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('scanPiSessions degraded'))
    expect(summary).toBeDefined()
    expect(summary).toContain('noHeader=1')
    expect(summary).toContain(bad)
  })

  it('坏 header（type=session 缺 cwd）→ badHeader 计入汇总；正常会话仍收录', () => {
    mkdirSync(sessionsDir(), { recursive: true })
    writeSession('good.jsonl', 'good-id')
    const badHeader = join(sessionsDir(), 'bad-header.jsonl')
    writeFileSync(badHeader, '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z"}\n', 'utf-8')

    const results = scanPiSessions({ force: true })

    expect(results.map(r => r.id)).toEqual(['good-id'])
    const summary = warnSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('scanPiSessions degraded'))
    expect(summary).toBeDefined()
    expect(summary).toContain('badHeader=1')
    expect(summary).toContain(badHeader)
  })

  it('cwd 子目录不可读（EACCES）→ dirFail 计入汇总', () => {
    mkdirSync(sessionsDir(), { recursive: true })
    writeSession('root-level.jsonl', 'root-id')
    const sub = join(sessionsDir(), 'group-a')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'inner.jsonl'), '{"type":"session","version":3,"id":"inner-id","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n', 'utf-8')
    chmodSync(sub, 0o000)

    try {
      const results = scanPiSessions({ force: true })
      // 子目录整体未收录（只有根层正常条目）
      expect(results.map(r => r.id)).toEqual(['root-id'])
      const summary = warnSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('scanPiSessions degraded'))
      expect(summary).toBeDefined()
      expect(summary).toContain('dirFail=1')
      expect(summary).toContain(sub)
    } finally {
      chmodSync(sub, 0o755)
    }
  })

  it('零降级 → 无汇总 warn（正常态安静）', () => {
    mkdirSync(sessionsDir(), { recursive: true })
    writeSession('only.jsonl', 'only-id')
    const results = scanPiSessions({ force: true })
    expect(results).toHaveLength(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
// ════════════════ 来源: session-end-entry.test.ts ════════════════

describe('W4: persistSessionEnd + extractSessionOutcome round-trip（AC-3）', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-session-end-'))
    filePath = join(dir, 'test.jsonl')
    // 模拟 pi 已 flush 的 session 文件（首行 session header）
    writeFileSync(filePath, JSON.stringify({ type: 'session', id: 's1', cwd: '/x', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('persistSessionEnd(done) 后 extractSessionOutcome 返回 done', () => {
    persistSessionEnd(filePath, 'done')
    expect(extractSessionOutcome(filePath)).toBe('done')
  })

  it('persistSessionEnd(error) 后 extractSessionOutcome 返回 error', () => {
    persistSessionEnd(filePath, 'error', 'Connection failed')
    expect(extractSessionOutcome(filePath)).toBe('error')
  })

  it('persistSessionEnd(stopped) 后 extractSessionOutcome 返回 stopped', () => {
    persistSessionEnd(filePath, 'stopped')
    expect(extractSessionOutcome(filePath)).toBe('stopped')
  })

  it('写入的 sidecar .meta.json 含 outcome + timestamp（B7 sidecar 方案）', () => {
    persistSessionEnd(filePath, 'done')
    // B7: persistSessionEnd 写 sidecar .meta.json（不再往 JSONL append session_end）
    const metaPath = filePath + '.meta.json'
    expect(existsSync(metaPath)).toBe(true)
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    expect(meta.outcome).toBe('done')
    expect(meta.timestamp).toBeTruthy()
  })

  it('无 session_end 的文件 → extractSessionOutcome 返回 null（AC-4 回退）', () => {
    expect(extractSessionOutcome(filePath)).toBeNull()
  })

  it('sidecar 不覆盖 JSONL 原有内容（B7: 写 .meta.json，JSONL 不变）', () => {
    // 先写几条消息
    writeFileSync(filePath, JSON.stringify({ type: 'session', id: 's1', cwd: '/x', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n'
      + JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'hi' }, timestamp: '2026-01-01T00:00:01.000Z' }) + '\n')
    persistSessionEnd(filePath, 'done')
    // JSONL 内容不变（2 行），session_end 写进 sidecar
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).type).toBe('session')
    expect(JSON.parse(lines[1]).type).toBe('message')
    // sidecar 存在且含 outcome
    const meta = JSON.parse(readFileSync(filePath + '.meta.json', 'utf-8'))
    expect(meta.outcome).toBe('done')
  })
})
describe('W4: persistSessionEnd existsSync guard（AC-7 规则 #6）', () => {
  it('文件不存在时不创建文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-no-file-'))
    const nonExist = join(dir, 'never-existed.jsonl')
    try {
      expect(existsSync(nonExist)).toBe(false)
      persistSessionEnd(nonExist, 'done')
      // 关键断言：文件仍未被创建（不违反规则 #6 pi _persist openSync(wx) 竞态）
      expect(existsSync(nonExist)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('文件不存在时不抛异常', () => {
    const nonExist = join(mkdtempSync(join(tmpdir(), 'cw-no-throw-')), 'no.jsonl')
    expect(() => persistSessionEnd(nonExist, 'done')).not.toThrow()
  })

  it('空路径直接 return 不抛', () => {
    expect(() => persistSessionEnd('', 'done')).not.toThrow()
  })
})
describe('W4: SessionOutcome 类型完整性', () => {
  it('三种 outcome 值可被 extractSessionOutcome 正确区分', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-types-'))
    try {
      const outcomes: SessionOutcome[] = ['done', 'error', 'stopped']
      for (const o of outcomes) {
        const fp = join(dir, `${o}.jsonl`)
        writeFileSync(fp, JSON.stringify({ type: 'session', id: 's', cwd: '/x', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n')
        persistSessionEnd(fp, o)
        expect(extractSessionOutcome(fp)).toBe(o)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
describe('normalizeSessionFileInPlace rename 失败回滚（suggestion 6）', () => {
  it('rename 目标是已存在的非空目录 → 抛错且不留 .tmp-migrate- 残留，原目标未动', () => {
    const dir = mkdtempSync(join(tmpdir(), 's6-rollback-'))
    try {
      // 目标路径做成已存在的非空目录 → renameSync(file → dir) 真实抛错
      const target = join(dir, '2026-08-19T00-00-00-000Z_sess-x.jsonl')
      mkdirSync(target)
      writeFileSync(join(target, 'occupant.txt'), 'x')

      expect(() => normalizeSessionFileInPlace(target, 'line\n')).toThrow()
      // 回滚：刚写的临时文件已删，目录零 .tmp-migrate- 残留
      expect(tmpMigrateNames(dir)).toEqual([])
      // 原目标（目录）未被触碰
      expect(existsSync(join(target, 'occupant.txt'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('rename 成功路径行为不变：临时文件被消费，产物落原路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 's6-ok-'))
    try {
      const target = join(dir, '2026-08-19T00-00-00-000Z_sess-y.jsonl')
      writeFileSync(target, 'old\n')
      normalizeSessionFileInPlace(target, 'new-content\n')
      expect(readFileSync(target, 'utf-8')).toBe('new-content\n')
      expect(tmpMigrateNames(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
describe('cleanupMigrateResidues（suggestion 6）', () => {
  it('只删同 basename 前缀 + .jsonl 后缀的残留，不碰其他文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 's6-sweep-'))
    try {
      const base = '2026-08-19T00-00-00-000Z_sess-a.jsonl'
      const main = join(dir, base)
      writeFileSync(main, 'main\n')
      // 命中：同 basename 前缀残留 ×2
      writeFileSync(join(dir, `${base}.tmp-migrate-111.jsonl`), 'r1\n')
      writeFileSync(join(dir, `${base}.tmp-migrate-222.jsonl`), 'r2\n')
      // 不命中：其他 session 的残留 / 前缀匹配但非 .jsonl 后缀 / 无关文件
      const other = '2026-08-19T00-00-00-000Z_sess-b.jsonl.tmp-migrate-333.jsonl'
      writeFileSync(join(dir, other), 'other-session-residue\n')
      writeFileSync(join(dir, `${base}.tmp-migrate-444.txt`), 'wrong-suffix\n')
      writeFileSync(join(dir, 'unrelated.jsonl'), 'keep\n')

      cleanupMigrateResidues(main)

      const names = readdirSync(dir)
      expect(names).toContain(base)
      expect(names).toContain(other)
      expect(names).toContain(`${base}.tmp-migrate-444.txt`)
      expect(names).toContain('unrelated.jsonl')
      expect(names).not.toContain(`${base}.tmp-migrate-111.jsonl`)
      expect(names).not.toContain(`${base}.tmp-migrate-222.jsonl`)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('无残留时 no-op；目录不存在时不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 's6-noop-'))
    try {
      const main = join(dir, 'x.jsonl')
      writeFileSync(main, 'm\n')
      expect(() => cleanupMigrateResidues(main)).not.toThrow()
      expect(readdirSync(dir)).toEqual(['x.jsonl'])
      expect(() => cleanupMigrateResidues(join(dir, 'no-such-dir', 'x.jsonl'))).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
});
