/**
 * GitStateService 单测（perf W16 验收）：in-flight 单飞去重 / 分层 TTL 缓存 /
 * 非仓库负缓存 / invalidate 失效（含在飞竞态防护）。
 *
 * executor 用手写 fake（记录调用 + 可编程结果），不真 spawn git——验证的是缓存与
 * 去重策略本身；真实 git 执行链路经 git-executor.test.ts 单独覆盖。
 *
 * 测试框架 vitest（从 vitest 导入 describe/it/expect/vi），运行命令 npx vitest run。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusResult } from '@taiji/shared'
import { GitExecutorError } from '../ports/git-executor.js'
import type { GitCommand, GitExecutorResult, IGitExecutor } from '../ports/git-executor.js'
import { GitRepoObserver } from './repo-observer.js'
import { GitStateService } from './git-state-service.js'

/**
 * 白盒访问私有 statusCache（Fix-3 验收要求断言 Map size 与驱逐序——「过期后 size 不增长」
 * 在行为层不可观测）。仅测试断言用，生产代码不得仿效。
 */
function statusCacheOf(svc: GitStateService): Map<string, { result: GitStatusResult; ts: number }> {
  return (svc as unknown as { statusCache: Map<string, { result: GitStatusResult; ts: number }> }).statusCache
}

/** fake executor 记录的单次调用。 */
interface ExecCall {
  cwd: string
  command: GitCommand
  args: string[]
  timeoutMs: number | undefined
}

type ExecImpl = (cwd: string, command: GitCommand, args: string[]) => Promise<GitExecutorResult>

/** 手写 fake IGitExecutor：记录全部调用（含 timeoutMs），行为可编程。 */
function createFakeExecutor() {
  const calls: ExecCall[] = []
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
    /** 断言前过滤出指定子命令的调用次数 */
    countOf: (command: GitCommand) => calls.filter((c) => c.command === command).length,
    setImpl(next: ExecImpl) {
      impl = next
    },
  }
}

/** 构造被测服务（TTL 用真实短值 + fake timers 推进）。 */
function createService(executor: IGitExecutor) {
  return new GitStateService({ executor, repoObserver: makeStubObserver(), statusTtlMs: 2000, notRepoTtlMs: 60_000 })
}

/** stub 观测器（status 链用例不触观测器；类型收窄免构造真实 resolver）。 */
function makeStubObserver(): GitRepoObserver {
  const stub = {
    readObservation: () => { throw new Error('stub observer 不应在 status 链被调用') },
    pruneCache: () => {},
    invalidateCwd: () => {},
  }
  return stub as unknown as GitRepoObserver
}

const NOT_REPO_STDERR = 'fatal: not a git repository (or any of the parent directories): .git'

let flush: () => Promise<void>

beforeEach(() => {
  vi.useFakeTimers()
  // microtask flush（fake timers 不影响微任务队列，await 一次即排空一级微任务）
  flush = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GitStateService.snapshotStatus', () => {
  it('同 cwd 并发请求共享一次执行（in-flight 去重：spawn 计数 = 1）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)

    let releaseExec: ((res: GitExecutorResult) => void) | undefined
    fake.setImpl(
      () =>
        new Promise<GitExecutorResult>((resolve) => {
          releaseExec = resolve
        }),
    )

    const p1 = svc.snapshotStatus('/repo')
    const p2 = svc.snapshotStatus('/repo')
    const p3 = svc.snapshotStatus('/repo')
    await flush()
    // 三请求已并发发起，但执行只挂起一次
    expect(fake.calls).toHaveLength(1)
    releaseExec?.({ stdout: ' M a.ts\n', stderr: '', exitCode:0 })
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(fake.calls).toHaveLength(1)
    expect(r1).toEqual(r2)
    expect(r1).toEqual(r3)
    expect(r1?.get('a.ts')).toBe('modified')
  })

  it('结果不做 TTL 缓存：顺序两次调用各执行一次（每次 diff 需当前真实状态）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    fake.setImpl(async (_cwd, command) =>
      command === 'status' ? { stdout: '', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 },
    )

    await svc.snapshotStatus('/repo')
    await svc.snapshotStatus('/repo')
    expect(fake.countOf('status')).toBe(2)
  })

  it('裸 --porcelain 参数 + 5000ms 超时（D3-1：沿用 reconciler 现状，与 getStatus 的 -uall 有意区分）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    await svc.snapshotStatus('/repo')
    expect(fake.calls[0]?.args).toEqual(['--porcelain'])
    expect(fake.calls[0]?.timeoutMs).toBe(5000)
  })

  it('解析 XY 码为 4 态 status（untracked 折叠为 added，与 reconciler 基线一致）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    fake.setImpl(async (_cwd, command) =>
      command === 'status'
        ? { stdout: ' M src/a.ts\n?? new.txt\nD  gone.ts\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 },
    )

    const snapshot = await svc.snapshotStatus('/repo')
    expect(snapshot?.get('src/a.ts')).toBe('modified')
    expect(snapshot?.get('new.txt')).toBe('added')
    expect(snapshot?.get('gone.ts')).toBe('deleted')
    expect(snapshot?.size).toBe(3)
  })

  it('非仓库负缓存：首次失败后 60s 内零 spawn（snapshotStatus / numstat 同享 cwd 级判定）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    fake.setImpl(async (_cwd, command) =>
      command === 'status' || command === 'diff'
        ? { stdout: '', stderr: NOT_REPO_STDERR, exitCode: 128 }
        : { stdout: '', stderr: '', exitCode: 0 },
    )

    expect(await svc.snapshotStatus('/not-repo')).toBeNull()
    expect(await svc.snapshotStatus('/not-repo')).toBeNull()
    expect(await svc.numstat('/not-repo')).toBeNull()
    expect(fake.calls).toHaveLength(1) // 仅首次探测，后续全部负缓存命中

    vi.advanceTimersByTime(59_999)
    expect(await svc.snapshotStatus('/not-repo')).toBeNull()
    expect(fake.calls).toHaveLength(1)

    vi.advanceTimersByTime(1) // 累计 60s，负缓存过期 → 重新探测
    expect(await svc.snapshotStatus('/not-repo')).toBeNull()
    expect(fake.calls).toHaveLength(2)
  })

  it('force 绕过负缓存强制重探', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    fake.setImpl(async () => ({ stdout: '', stderr: NOT_REPO_STDERR, exitCode: 128 }))

    await svc.snapshotStatus('/not-repo')
    expect(fake.calls).toHaveLength(1)
    await svc.snapshotStatus('/not-repo', { force: true })
    expect(fake.calls).toHaveLength(2)
  })

  it('force 重探成功后清负缓存：后续非 force 调用重新执行而非命中负缓存（Fix-4）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)

    // ① 误判为非仓库（负缓存写入）
    fake.setImpl(async () => ({ stdout: '', stderr: NOT_REPO_STDERR, exitCode: 128 }))
    expect(await svc.snapshotStatus('/becomes-repo')).toBeNull()
    expect(fake.calls).toHaveLength(1)

    // ② 目录变为仓库后 force 重探成功 → 应清负缓存
    fake.setImpl(async () => ({ stdout: ' M a.ts\n', stderr: '', exitCode: 0 }))
    const forced = await svc.snapshotStatus('/becomes-repo', { force: true })
    expect(forced?.get('a.ts')).toBe('modified')
    expect(fake.calls).toHaveLength(2)

    // ③ 非 force 调用不命中旧负缓存（清了才走执行；没清会直接返回 null 零 spawn）
    const after = await svc.snapshotStatus('/becomes-repo')
    expect(after?.get('a.ts')).toBe('modified')
    expect(fake.calls).toHaveLength(3)
  })

  it('瞬态失败（非「not a repository」的退出失败）不写负缓存：下次仍重试', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    fake.setImpl(async () => ({ stdout: '', stderr: 'fatal: unable to access', exitCode: 128 }))

    expect(await svc.snapshotStatus('/repo')).toBeNull()
    expect(await svc.snapshotStatus('/repo')).toBeNull()
    expect(fake.calls).toHaveLength(2)
  })

  it('stderr 含同文案但 exitCode 非 128 → 不写负缓存（Fix-2：排除 wrapper 等非 git fatal 形态）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    fake.setImpl(async () => ({ stdout: '', stderr: NOT_REPO_STDERR, exitCode: 1 }))

    expect(await svc.snapshotStatus('/repo')).toBeNull()
    expect(await svc.snapshotStatus('/repo')).toBeNull()
    expect(fake.calls).toHaveLength(2) // 每次都重试 = 未写负缓存
  })

  it('git 不可用 / 超时（GitExecutorError）→ null 且不写负缓存', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    fake.setImpl(async () => {
      throw new GitExecutorError('timeout', '执行超时')
    })

    expect(await svc.snapshotStatus('/repo')).toBeNull()
    expect(await svc.snapshotStatus('/repo')).toBeNull()
    expect(fake.calls).toHaveLength(2)
  })
})

describe('GitStateService.numstat', () => {
  it('解析 numstat 为 path → 条目 Map（二进制 `-` 条目保留 undefined，lossless）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    fake.setImpl(async (_cwd, command) =>
      command === 'diff'
        ? { stdout: '1\t2\tsrc/a.ts\n-\t-\tbin.dat\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 },
    )

    const map = await svc.numstat('/repo')
    expect(map?.get('src/a.ts')).toEqual({ add: 1, del: 2, path: 'src/a.ts' })
    expect(map?.get('bin.dat')).toEqual({ add: undefined, del: undefined, path: 'bin.dat' })
    expect(map?.size).toBe(2)
  })

  it('同 cwd 并发请求共享一次执行（in-flight 去重）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)

    let releaseExec: ((res: GitExecutorResult) => void) | undefined
    fake.setImpl(
      () =>
        new Promise<GitExecutorResult>((resolve) => {
          releaseExec = resolve
        }),
    )

    const p1 = svc.numstat('/repo')
    const p2 = svc.numstat('/repo')
    await flush()
    expect(fake.calls).toHaveLength(1)
    releaseExec?.({ stdout: '1\t2\ta.ts\n', stderr: '', exitCode: 0 })
    await Promise.all([p1, p2])
    expect(fake.calls).toHaveLength(1)
  })

  it('numstat 失败 → null（调用方走 writeContents 回退，现状语义）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    fake.setImpl(async () => ({ stdout: '', stderr: 'fatal: bad object HEAD', exitCode: 128 }))

    expect(await svc.numstat('/repo')).toBeNull()
  })

  it('5000ms 超时透传（D3-1）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    await svc.numstat('/repo')
    expect(fake.calls[0]?.command).toBe('diff')
    expect(fake.calls[0]?.timeoutMs).toBe(5000)
  })
})

describe('GitStateService.getStatus', () => {
  /** 标准 mock：仓库 status / numstat / branch 三命令的典型输出。 */
  function stubRepo(fake: ReturnType<typeof createFakeExecutor>) {
    fake.setImpl(async (_cwd, command) => {
      if (command === 'status') {
        return { stdout: '## main...origin/main\0 M src/a.ts\0?? new.txt\0', stderr: '', exitCode: 0 }
      }
      if (command === 'diff') {
        return { stdout: '3\t1\tsrc/a.ts\n', stderr: '', exitCode: 0 }
      }
      return { stdout: 'feat-x\nmain\n', stderr: '', exitCode: 0 } // branch --list
    })
  }

  it('聚合 status + numstat + branch，返回形状与 git-service.getStatus 现状一致', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    stubRepo(fake)

    const result = await svc.getStatus('sid-1', '/repo')
    expect(result.isRepo).toBe(true)
    expect(result.sessionId).toBe('sid-1')
    expect(result.branch).toBe('main')
    expect(result.branches).toEqual(['feat-x', 'main'])
    expect(result.stats).toEqual({ add: 3, del: 1 })
    expect(result.files).toHaveLength(2)
    expect(result.files[0]).toMatchObject({ path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 })
    // untracked 无 numstat → 无行数字段（前端降级展示）
    expect(result.files[1]).toMatchObject({ path: 'new.txt', status: 'untracked' })
    expect(result.files[1]).not.toHaveProperty('additions')
    // -uall 展开参数 + 8000ms 超时（D3-1：getStatus 沿用 git-executor 默认）
    const statusCall = fake.calls.find((c) => c.command === 'status')
    expect(statusCall?.args).toEqual(['--porcelain=v1', '-z', '-b', '--untracked-files=all'])
    expect(statusCall?.timeoutMs).toBe(8000)
  })

  it('TTL 命中：窗口内二次调用零 spawn；过期后重取', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    stubRepo(fake)

    await svc.getStatus('sid-1', '/repo')
    expect(fake.calls).toHaveLength(3) // status + diff + branch

    const second = await svc.getStatus('sid-1', '/repo')
    expect(fake.calls).toHaveLength(3) // 缓存命中零 spawn
    expect(second.sessionId).toBe('sid-1')

    vi.advanceTimersByTime(2001) // TTL 2000ms 过期
    await svc.getStatus('sid-1', '/repo')
    expect(fake.calls).toHaveLength(6)
  })

  it('缓存键含 sessionId：同 cwd 不同 session 各自执行（D4-3 防跨 session 串扰）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    stubRepo(fake)

    const [a, b] = await Promise.all([
      svc.getStatus('sid-a', '/repo'),
      svc.getStatus('sid-b', '/repo'),
    ])
    expect(a.sessionId).toBe('sid-a')
    expect(b.sessionId).toBe('sid-b')
    expect(fake.calls).toHaveLength(6) // 两 session 各自一组
  })

  it('并发同 key 请求共享一次执行（in-flight 去重）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)

    let releaseExec: ((res: GitExecutorResult) => void) | undefined
    fake.setImpl(
      (_cwd, command) =>
        new Promise<GitExecutorResult>((resolve) => {
          if (command === 'status') {
            releaseExec = resolve
          } else {
            resolve(command === 'diff' ? { stdout: '', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 })
          }
        }),
    )

    const p1 = svc.getStatus('sid-1', '/repo')
    const p2 = svc.getStatus('sid-1', '/repo')
    await flush()
    expect(fake.countOf('status')).toBe(1)
    releaseExec?.({ stdout: '## main\0', stderr: '', exitCode: 0 })
    const [r1, r2] = await Promise.all([p1, p2])
    expect(fake.countOf('status')).toBe(1)
    expect(r1).toEqual(r2)
  })

  it('非仓库 → isRepo=false 降级 + 负缓存：二次调用零 spawn', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    fake.setImpl(async (_cwd, command) =>
      command === 'status' ? { stdout: '', stderr: NOT_REPO_STDERR, exitCode: 128 } : { stdout: '', stderr: '', exitCode: 0 },
    )

    const result = await svc.getStatus('sid-1', '/not-repo')
    expect(result.isRepo).toBe(false)
    expect(result.sessionId).toBe('sid-1')
    expect(fake.calls).toHaveLength(1) // status 失败即短路，diff/branch 不执行

    const second = await svc.getStatus('sid-1', '/not-repo')
    expect(second.isRepo).toBe(false)
    expect(fake.calls).toHaveLength(1) // 负缓存命中零 spawn
  })

  it('git 不可用 → 降级 isRepo=false 且不写 TTL 缓存（缓存不因失败写入错误值）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    fake.setImpl(async () => {
      throw new GitExecutorError('git_unavailable', 'git CLI 未安装')
    })

    expect((await svc.getStatus('sid-1', '/repo')).isRepo).toBe(false)
    // 失败结果未缓存：二次调用重新执行（仍是失败，但语义上「不缓存错误值」）
    expect((await svc.getStatus('sid-1', '/repo')).isRepo).toBe(false)
    expect(fake.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('W17 审查 Fix-1：未知异常（非 GitExecutorError）→ 仍降级 isRepo:false，且 console.warn 出声（含 sessionId/cwd）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    fake.setImpl(async () => {
      throw new TypeError('cannot read properties of undefined')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await svc.getStatus('sid-x', '/repo')
      expect(result.isRepo).toBe(false) // 降级语义保持（不 rethrow）
      expect(result.sessionId).toBe('sid-x')
      expect(warnSpy).toHaveBeenCalledTimes(1) // 但必须出声
      // 出声内容可定位：含 sessionId 与 cwd（错误栈经 console.warn 第二参数透传）
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('sid-x')
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('/repo')
      expect(warnSpy.mock.calls[0]?.[1]).toBeInstanceOf(TypeError)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('W17 审查 Fix-1：GitExecutorError（已知降级路径）→ 静默降级不 warn', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    fake.setImpl(async () => {
      throw new GitExecutorError('timeout', '执行超时')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect((await svc.getStatus('sid-1', '/repo')).isRepo).toBe(false)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('invalidate 后缓存 miss：下一次 getStatus 重新执行；不影响其他 session', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    stubRepo(fake)

    await svc.getStatus('sid-a', '/repo')
    await svc.getStatus('sid-b', '/repo')
    expect(fake.calls).toHaveLength(6)

    svc.invalidate('sid-a')
    // sid-b 的缓存不受影响（零新 spawn）
    await svc.getStatus('sid-b', '/repo')
    expect(fake.calls).toHaveLength(6)
    // sid-a 缓存已失效（重新执行一组）
    await svc.getStatus('sid-a', '/repo')
    expect(fake.calls).toHaveLength(9)
  })

  it('invalidate 与在飞执行的竞态：飞行中被失效的执行完成后不回写缓存（旧值不复活）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)

    let releaseStatus: ((res: GitExecutorResult) => void) | undefined
    fake.setImpl(
      (_cwd, command) =>
        new Promise<GitExecutorResult>((resolve) => {
          if (command === 'status') {
            releaseStatus = resolve
          } else {
            resolve({ stdout: '', stderr: '', exitCode: 0 })
          }
        }),
    )

    const inflight = svc.getStatus('sid-1', '/repo')
    await flush()
    // 执行飞行中触发失效（模拟写操作在读取过程中完成）
    svc.invalidate('sid-1')
    releaseStatus?.({ stdout: '## main\0 M a.ts\0', stderr: '', exitCode: 0 })
    const stale = await inflight
    expect(stale.isRepo).toBe(true) // 发起于失效前的调用方仍拿到结果（promise 语义）

    // 恢复立即返回的实现（deferred 版会让第二个 getStatus 永久挂起）
    fake.setImpl(async (_cwd, command) =>
      command === 'status'
        ? { stdout: '## main\0 M a.ts\0', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 },
    )
    // 失效后旧值未回写缓存：新调用重新执行而非命中旧值
    const callsBefore = fake.calls.length
    const fresh = await svc.getStatus('sid-1', '/repo')
    expect(fake.calls.length).toBeGreaterThan(callsBefore)
    expect(fresh.isRepo).toBe(true)
  })

  it('invalidateByCwd（perf W17）：清同 cwd 全部 session 的缓存，其他 cwd 不受影响', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    stubRepo(fake)

    await svc.getStatus('sid-a', '/repo')
    await svc.getStatus('sid-b', '/repo')
    await svc.getStatus('sid-c', '/other')
    expect(fake.calls).toHaveLength(9) // 3 组聚合

    // session-less 写操作（checkoutCwd）按 cwd 失效
    svc.invalidateByCwd('/repo')
    await svc.getStatus('sid-c', '/other')
    expect(fake.calls).toHaveLength(9) // 其他 cwd 缓存不受影响

    await svc.getStatus('sid-a', '/repo')
    await svc.getStatus('sid-b', '/repo')
    expect(fake.calls).toHaveLength(15) // /repo 两 session 均重新执行
  })

  it('微项 8（perf W17）单趟解析边界：二进制/半二进制行不进 per-file，聚合只计数字列（parseNumstat 薄包装删除后的等价行为锚点，W17 审查 Fix-5）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    // numstat 输出：正常条目 + 全二进制（- -）+ 半二进制（add 有 del -）
    fake.setImpl(async (_cwd, command) => {
      if (command === 'status') {
        return { stdout: '## main\0 M a.ts\0 M bin.dat\0 M mixed.bin\0', stderr: '', exitCode: 0 }
      }
      if (command === 'diff') {
        return { stdout: '3\t1\ta.ts\n-\t-\tbin.dat\n5\t-\tmixed.bin\n', stderr: '', exitCode: 0 }
      }
      return { stdout: 'main\n', stderr: '', exitCode: 0 }
    })

    const result = await svc.getStatus('sid-1', '/repo')
    // 聚合：a.ts 全计；bin.dat 全跳过；mixed.bin 只计 add（del undefined 独立跳过）
    expect(result.stats).toEqual({ add: 8, del: 1 })
    // per-file：双值均数字才收录（bin.dat / mixed.bin 不进 Map → 行数字段保持 undefined）
    expect(result.files.find((f) => f.path === 'a.ts')).toMatchObject({ additions: 3, deletions: 1 })
    expect(result.files.find((f) => f.path === 'bin.dat')?.additions).toBeUndefined()
    expect(result.files.find((f) => f.path === 'mixed.bin')?.additions).toBeUndefined()
  })

  it('TTL 过期重写不增长 statusCache（Fix-3：TTL miss 即删，重写不产生重复滞留条目）', async () => {
    const fake = createFakeExecutor()
    const svc = createService(fake.executor)
    stubRepo(fake)

    await svc.getStatus('sid-1', '/repo')
    await svc.getStatus('sid-2', '/repo')
    expect(statusCacheOf(svc).size).toBe(2)

    vi.advanceTimersByTime(2001) // 双双过期
    // 只重查 sid-1：其旧条目应被「过期即删」清掉再重写，size 不变
    await svc.getStatus('sid-1', '/repo')
    expect(statusCacheOf(svc).size).toBe(2)
  })

  it('超帽驱逐最老写入条目，过期重写移位后驱逐序仍正确（Fix-3：容量帽 oldest-insert）', async () => {
    const fake = createFakeExecutor()
    const svc = new GitStateService({
      executor: fake.executor,
      repoObserver: makeStubObserver(),
      statusTtlMs: 2000,
      notRepoTtlMs: 60_000,
      statusCacheMaxSize: 2,
    })
    stubRepo(fake)

    await svc.getStatus('sid-1', '/repo') // 写 key1 → Map 序 [key1]
    await svc.getStatus('sid-2', '/repo') // 写 key2 → Map 序 [key1, key2]（帽满）
    expect(statusCacheOf(svc).size).toBe(2)

    vi.advanceTimersByTime(2001) // key1/key2 过期
    await svc.getStatus('sid-1', '/repo') // key1 TTL miss 即删 + 尾部重写 → Map 序 [key2, key1]
    expect(fake.calls).toHaveLength(9) // 3 组执行（3+3+3）

    await svc.getStatus('sid-3', '/repo') // 帽满驱逐 first key = key2（最旧写入）
    expect(fake.calls).toHaveLength(12)

    // key1 刚重写（TTL 窗口内）应命中缓存零 spawn；key2 已被驱逐应重新执行
    await svc.getStatus('sid-1', '/repo')
    expect(fake.calls).toHaveLength(12) // key1 命中
    await svc.getStatus('sid-2', '/repo')
    expect(fake.calls).toHaveLength(15) // key2 被驱逐后重执行
    expect(statusCacheOf(svc).size).toBe(2)
  })
})

describe('GitStateService repo 观测器（缓存治理批 4 U10）', () => {
  /** 计数 resolver：每次解析记录 cwd（行为式断言观测器缓存的命中/失效）。 */
  function createCountingResolver() {
    const calls: string[] = []
    return {
      calls,
      resolver: {
        resolve(cwd: string) {
          calls.push(cwd)
          return { branch: 'main', isWorktree: false, isBare: false, gitDir: '/repo/.git', headPath: '/repo/.git/HEAD' }
        },
      },
    }
  }

  it('readObservation 走观测器缓存：同 cwd 二次读取命中（IGitRepoObserver service 面，门面经此共享单源）', () => {
    const fake = createFakeExecutor()
    const { resolver, calls } = createCountingResolver()
    const svc = new GitStateService({ executor: fake.executor, repoObserver: new GitRepoObserver({ resolver }) })

    svc.readObservation('/repo')
    svc.readObservation('/repo')
    expect(calls).toEqual(['/repo'])
  })

  it('invalidateByCwd 同步打观测器单点：观测条目被失效，下一次读取重新解析（旧 gitInfoCache 无写失效通道，结构性补齐）', () => {
    const fake = createFakeExecutor()
    const { resolver, calls } = createCountingResolver()
    const svc = new GitStateService({ executor: fake.executor, repoObserver: new GitRepoObserver({ resolver }) })

    svc.readObservation('/repo')
    svc.invalidateByCwd('/repo')
    svc.readObservation('/repo')
    expect(calls).toEqual(['/repo', '/repo'])
  })

  it('pruneCache 委托观测器收缩：空活跃集合清空后重新解析', () => {
    const fake = createFakeExecutor()
    const { resolver, calls } = createCountingResolver()
    const svc = new GitStateService({ executor: fake.executor, repoObserver: new GitRepoObserver({ resolver }) })

    svc.readObservation('/repo')
    svc.pruneCache(new Set<string>())
    svc.readObservation('/repo')
    expect(calls).toEqual(['/repo', '/repo'])
  })

  it('invalidate(sessionId) 不触观测器（sessionId 键无 cwd 可定位，观测器条目由 TTL 收敛）', () => {
    const fake = createFakeExecutor()
    const { resolver, calls } = createCountingResolver()
    const svc = new GitStateService({ executor: fake.executor, repoObserver: new GitRepoObserver({ resolver }) })

    svc.readObservation('/repo')
    svc.invalidate('sid-1')
    svc.readObservation('/repo')
    expect(calls).toEqual(['/repo'])
  })
})
