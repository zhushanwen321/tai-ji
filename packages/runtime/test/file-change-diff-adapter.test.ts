/**
 * FileChangeDiffAdapter × GitStateService 集成单测（W18 验收 ②/③）。
 *
 * 锁定：
 * - A1: 采集委托——adapter.snapshotGitStatus 走 GitStateService.snapshotStatus（裸 --porcelain
 *   + 5000ms），adapter.numstat 走 GitStateService.numstat（--numstat HEAD）
 * - A2: 并发单飞——同 cwd 并发采集共享一次 exec（重复采集零重复 spawn；D4-3 定案
 *   snapshotStatus 不做结果 TTL 缓存——「写操作后不陈旧」由无缓存天然保证，见 A3）
 * - A3: 不陈旧——顺序两次采集（模拟写操作后）各自真实执行且第二次反映新状态
 *   （snapshotStatus 无结果缓存，invalidate 链路的 file_changes 侧语义）
 * - A4: 非仓库负缓存——首次 not-a-repo 失败后 60s 内零 spawn（file_changes 采集路径
 *       的最大节省，03 D4-3/V5）
 * - A5: diffSnapshots / computeLineCounts 纯函数转发与 reconciler 行为一致
 *
 * executor 用手写 fake（记录调用 + 可编程结果），不真 spawn git。
 *
 * 运行：npx vitest run test/file-change-diff-adapter.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { FileChange, FileChangeStatus } from '@taiji/shared'
import { FileChangeDiffAdapter } from '../src/infra/pi/file-change-diff-adapter.js'
import { GitStateService } from '../src/services/git/git-state-service.js'
import type { GitCommand, GitExecutorResult, IGitExecutor } from '../src/services/ports/git-executor.js'


/** stub 观测器：用例不触观测器链，仅满足 GitStateService 必选依赖（类型收窄）。 */
const stubObserver = {
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
  const gitState = new GitStateService({ executor: fake.executor, repoObserver: stubObserver })
  return new FileChangeDiffAdapter(gitState)
}

/** 按子命令路由的可编程 status/numstat 输出。 */
function statusNumstatImpl(statusOut: () => string, numstatOut: () => string): ExecImpl {
  return async (_cwd, command) =>
    command === 'status'
      ? { stdout: statusOut(), stderr: '', exitCode: 0 }
      : { stdout: numstatOut(), stderr: '', exitCode: 0 }
}

describe('FileChangeDiffAdapter × GitStateService（W18 采集收编）', () => {
  it('A1: 采集委托 GitStateService——裸 --porcelain（5000ms）+ --numstat HEAD（5000ms）', async () => {
    const fake = createFakeExecutor()
    fake.setImpl(statusNumstatImpl(() => ' M a.ts', () => '1\t2\ta.ts'))
    const adapter = makeAdapter(fake)

    const snap = (await adapter.snapshotGitStatus('/repo')) as Map<string, FileChangeStatus> | null
    expect(snap?.get('a.ts')).toBe('modified')
    const ns = await adapter.numstat('/repo')
    expect(ns?.get('a.ts')).toMatchObject({ add: 1, del: 2 })

    const statusCall = fake.calls.find((c) => c.command === 'status')
    expect(statusCall?.args).toEqual(['--porcelain'])
    expect(statusCall?.timeoutMs).toBe(5000)
    const numstatCall = fake.calls.find((c) => c.command === 'diff')
    expect(numstatCall?.args).toEqual(['--numstat', 'HEAD'])
    expect(numstatCall?.timeoutMs).toBe(5000)
  })

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
