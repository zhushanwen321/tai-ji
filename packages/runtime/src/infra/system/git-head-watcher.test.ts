/**
 * GitHeadWatcher 单测（缓存治理批 4 U11）：fs.watch HEAD 所在目录的事件链 + 两层恢复链。
 *
 * 策略：
 * - fake timers 只 fake setTimeout/setInterval/clearTimeout/clearInterval/Date——驱动 debounce /
 *   L1 重试 / L2 周期等 timer 语义；真实 fs.watch 事件到达（物理 IO 事实）用重注入轮询等待
 *   （injectUntilPending），睡眠走 node:timers/promises（不在 vi.useFakeTimers 的 toFake 替换面内，
 *   已探针核实）。
 * - fs.watch 事件在满并行 vitest（多 worker CPU 饱和）下墙钟迟到可达秒级且无稳定上界，macOS
 *   FSEvents 满载下单次 rename 的事件还可能彻底丢失（本目录生产码注释承认的平台形态，产品面由
 *   L2 周期兜底覆盖）——对「事件在预算内到达」零容忍的一次性等待是 flake 根因，故全部真实 IO
 *   等待点改为「周期性重注入 + 轮询 pred + 提前 return + 宽预算」。
 * - fixture = mkdtempSync 临时目录下手搭 .git/HEAD（无需 git init——watch 目标是目录）；
 *   「git 原子写 HEAD」用 writeFileSync(tmp) + renameSync(tmp, HEAD) 模拟（正是换 inode 的
 *   rename 形态，watch 目标选目录的核心理由）。
 * - 测试全部落在 os.tmpdir() 白名单（fs-guard 红线）；teardown rmSync 带 maxRetries。
 *
 * 测试框架 vitest，运行命令：cd packages/runtime && npx vitest run src/infra/system/git-head-watcher.test.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleepReal } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitHeadWatcher } from './git-head-watcher.js'
import type { RepoObservation } from '../../services/ports/git-info.js'

const NON_REPO: RepoObservation = { branch: undefined, isWorktree: false, isBare: false, gitDir: undefined, headPath: undefined }

function obsOf(partial: Partial<RepoObservation>): RepoObservation {
  return { ...NON_REPO, ...partial }
}

/** git 原子写模拟：tmp + rename（换 inode——watch 文件会失效、watch 目录不受影响的形态）。 */
function atomicWriteHead(gitDir: string): void {
  const tmp = join(gitDir, `HEAD.tmp-${process.hrtime.bigint()}`)
  writeFileSync(tmp, 'ref: refs/heads/main\n')
  renameSync(tmp, join(gitDir, 'HEAD'))
}

/** 带 errno code 的 Error（watcher error 事件注入用；运行时 guard 形态构造，非断言）。 */
function errnoError(code: string): Error {
  const err = new Error(`mock fs.watch error (${code})`)
  Object.assign(err, { code })
  return err
}

/** 真实时间让出：真实 sleep 至少 ms（sleepReal 是 node:timers/promises 导出，不被 fake timers 替换）。 */
async function yieldReal(ms: number): Promise<void> {
  await sleepReal(ms)
}

/**
 * 周期性重注入直至 pred 置位（置位立即返回；预算耗尽才判失败）。
 *
 * 为什么「注入 + 等待」必须合成重注入循环：满并行 vitest 下多 worker 抢满 CPU，fs.watch 事件经
 * libuv/FSEvents 派发的墙钟延迟无稳定上界（全包跑实测超 5s 预算）；macOS FSEvents 满载下单次
 * rename 的事件还可能彻底丢失。对「事件在预算内到达」零容忍的一次性等待是 flake 根因——重注入
 * 把「丢失」翻转为下一次尝试，轮询把「迟到」消化在预算内（默认 15s，远大于实测迟到量级、远小于
 * 用例 timeout 30s）。多次注入只合并进同一 debounce 批次（生产码语义），不改变任何后续断言。
 *
 * 计时用 hrtime（不受 fake timers 影响）；真实 sleep 让出 CPU 给 libuv 派发回调，比 setImmediate
 * busy-poll 在饱和下更快拿到事件。
 */
async function injectUntilPending(
  inject: () => void,
  pred: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const { timeoutMs = 15_000, intervalMs = 50 } = opts
  const deadlineMs = Number(process.hrtime.bigint() / 1_000_000n) + timeoutMs
  for (;;) {
    if (pred()) return
    inject()
    if (Number(process.hrtime.bigint() / 1_000_000n) > deadlineMs) {
      throw new Error(
        `injectUntilPending: real IO timeout after ${timeoutMs}ms — fs.watch 事件在预算内未入 debounce 批次` +
          `（watch 未生效 / 事件全部丢失 / 平台限制），检查 fixture 目录存在性与 watcher 挂载状态`,
      )
    }
    await yieldReal(intervalMs)
  }
}

let outerDir: string

beforeEach(() => {
  // toFake 只管 timer 面（debounce/L1/L2 语义）；真实 IO 等待的 sleepReal 走 node:timers/promises
  // 模块导出，不在本替换面内（探针核实），fs.watch 事件派发不受影响。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  outerDir = mkdtempSync(join(tmpdir(), 'taiji-git-head-watcher-'))
})

afterEach(() => {
  vi.useRealTimers()
  // maxRetries：目录刚 rm 后个别平台句柄释放滞后的兜底（Windows 常见，macOS 保守同配）
  rmSync(outerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

interface Fixture {
  repoCwd: string
  gitDir: string
}

/** 手搭普通 repo 形态：<outer>/<name>/.git/HEAD（HEAD 文件可缺席——首次 observe 时 gitDir 存在即可）。 */
function makeRepo(name = 'repo'): Fixture {
  const repoCwd = join(outerDir, name)
  const gitDir = join(repoCwd, '.git')
  mkdirSync(gitDir, { recursive: true })
  return { repoCwd, gitDir }
}

function repoObs(fx: Fixture): RepoObservation {
  return obsOf({ gitDir: fx.gitDir, headPath: join(fx.gitDir, 'HEAD') })
}

describe('GitHeadWatcher watch 事件链（HEAD 目录 + 500ms debounce）', () => {
  it('HEAD rename（原子写换 inode）触发 → 事件入 debounce 批次 → 500ms 到点放行受影响 cwd', { timeout: 30_000 }, async () => {
    const fx = makeRepo()
    const onGitEvent = vi.fn()
    const watcher = new GitHeadWatcher({ onGitEvent, onFallbackTick: vi.fn() })
    watcher.observe(fx.repoCwd, repoObs(fx))
    expect(watcher.watchedDirsForTests()).toEqual([fx.gitDir])

    atomicWriteHead(fx.gitDir)
    await injectUntilPending(() => atomicWriteHead(fx.gitDir), () => watcher.hasPendingGitEventsForTests())
    expect(onGitEvent).not.toHaveBeenCalled() // debounce 窗口内未放行（fake timer 未推进，结构性成立）

    vi.advanceTimersByTime(500)
    expect(onGitEvent).toHaveBeenCalledTimes(1)
    expect(onGitEvent).toHaveBeenCalledWith(new Set([fx.repoCwd]))
    watcher.dispose()
  })

  it('debounce 窗口内连发（多次 rename）合并为一次放行', { timeout: 30_000 }, async () => {
    const fx = makeRepo()
    const onGitEvent = vi.fn()
    const watcher = new GitHeadWatcher({ onGitEvent, onFallbackTick: vi.fn() })
    watcher.observe(fx.repoCwd, repoObs(fx))

    await injectUntilPending(() => atomicWriteHead(fx.gitDir), () => watcher.hasPendingGitEventsForTests())
    atomicWriteHead(fx.gitDir) // 窗口内第二次事件（timer 已排，只合并不重置）
    await yieldReal(100) // 让出真实事件循环，确保第二事件已派发
    vi.advanceTimersByTime(500)

    expect(onGitEvent).toHaveBeenCalledTimes(1)
    expect(onGitEvent).toHaveBeenCalledWith(new Set([fx.repoCwd]))
    watcher.dispose()
  })

  it('reftable 仓库加挂 reftable 目录 watch：reftable 下写文件同样触发', { timeout: 30_000 }, async () => {
    const fx = makeRepo()
    const reftableDir = join(fx.gitDir, 'reftable')
    mkdirSync(reftableDir)
    const onGitEvent = vi.fn()
    const watcher = new GitHeadWatcher({ onGitEvent, onFallbackTick: vi.fn() })
    watcher.observe(fx.repoCwd, repoObs(fx))
    expect(watcher.watchedDirsForTests()).toEqual([fx.gitDir, reftableDir])

    // macOS FSEvents 满载下单次 rename 的事件可延迟/丢失（设计 §3.4.3 已承认的平台形态，
    // 产品面由 L2 兜底覆盖）。本用例关注「reftable 目录 watch 已挂上且事件能到达」，不关注
    // 「恰好第一次到达」——统一走 injectUntilPending 重注入，预算耗尽才判失败。
    await injectUntilPending(
      () => {
        const tmp = join(reftableDir, `tables.list.tmp-${process.hrtime.bigint()}`)
        writeFileSync(tmp, 'test')
        renameSync(tmp, join(reftableDir, 'tables.list'))
      },
      () => watcher.hasPendingGitEventsForTests(),
      { timeoutMs: 25_000, intervalMs: 250 },
    )
    vi.advanceTimersByTime(500)

    expect(onGitEvent).toHaveBeenCalledWith(new Set([fx.repoCwd]))
    watcher.dispose()
  })

  it('observe 幂等：同一 cwd 重复登记不叠加 watcher', () => {
    const fx = makeRepo()
    const watcher = new GitHeadWatcher({ onGitEvent: vi.fn(), onFallbackTick: vi.fn() })
    watcher.observe(fx.repoCwd, repoObs(fx))
    watcher.observe(fx.repoCwd, repoObs(fx))
    expect(watcher.watchedDirsForTests()).toEqual([fx.gitDir])
    watcher.dispose()
  })

  it('非 repo 观测（headPath/gitDir undefined）不挂载；forget 收缩孤儿 dir 的 watcher', () => {
    const fx = makeRepo()
    const watcher = new GitHeadWatcher({ onGitEvent: vi.fn(), onFallbackTick: vi.fn() })

    watcher.observe('/not-a-repo', NON_REPO)
    expect(watcher.watchedDirsForTests()).toEqual([])

    const fxB = makeRepo('repo-b')
    watcher.observe(fx.repoCwd, repoObs(fx))
    watcher.observe(fxB.repoCwd, repoObs(fxB))
    expect(watcher.watchedDirsForTests()).toEqual([fx.gitDir, fxB.gitDir])

    watcher.forget(new Set([fx.repoCwd]))
    expect(watcher.watchedDirsForTests()).toEqual([fxB.gitDir])
    watcher.dispose()
  })
})

describe('GitHeadWatcher L1：error → 清全部 watcher → 5s 定时重试挂载', () => {
  it('watch 构造即抛（路径不存在）→ 同步 warn + 5s 重试；重试再失败再次 warn（持续重试不冻结）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onGitEvent = vi.fn()
    const watcher = new GitHeadWatcher({ onGitEvent, onFallbackTick: vi.fn() })

    watcher.observe('/gone', obsOf({ gitDir: '/gone/.git', headPath: join('/gone/.git', 'HEAD') }))
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('fs.watch error')
    expect(watcher.watchedDirsForTests()).toEqual([]) // 构造抛 → 无 watcher 驻留

    vi.advanceTimersByTime(5000) // L1 定时重试挂载 → 仍失败 → 再次 error 处理
    expect(warnSpy).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(5000) // 持续重试循环（绝不允许熔断后冻结到重启）
    expect(warnSpy).toHaveBeenCalledTimes(3)
    expect(onGitEvent).not.toHaveBeenCalled()
    watcher.dispose()
    warnSpy.mockRestore()
  })

  it('运行中 error 事件（注入 emit）→ 清全部 watcher + 5s 重试挂载成功，事件驱动恢复', { timeout: 30_000 }, async () => {
    const fx = makeRepo()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onGitEvent = vi.fn()
    const watcher = new GitHeadWatcher({ onGitEvent, onFallbackTick: vi.fn() })
    watcher.observe(fx.repoCwd, repoObs(fx))
    expect(watcher.watchedDirsForTests()).toEqual([fx.gitDir])

    // 注入运行中 error（macOS FSEvents 对「watch 目录被删」不保证派发 error——静默丢事件
    // 形态走 L2 兜底，故此处用 A6 验收同款的测试钩子注入，确定性覆盖 L1 运行中分支）
    watcher.watcherForTests(fx.gitDir)?.emit('error', errnoError('EPERM'))
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('(EPERM)')
    expect(watcher.watchedDirsForTests()).toEqual([]) // 清全部 git watcher

    vi.advanceTimersByTime(5000) // L1 定时重试挂载 → 成功
    expect(watcher.watchedDirsForTests()).toEqual([fx.gitDir])
    expect(warnSpy).toHaveBeenCalledTimes(1) // 重试成功无新 warn

    atomicWriteHead(fx.gitDir) // 事件驱动已恢复
    await injectUntilPending(() => atomicWriteHead(fx.gitDir), () => watcher.hasPendingGitEventsForTests())
    vi.advanceTimersByTime(500)
    expect(onGitEvent).toHaveBeenCalledWith(new Set([fx.repoCwd]))
    watcher.dispose()
    warnSpy.mockRestore()
  })
})

describe('GitHeadWatcher L2：60s 周期兜底（无条件运行 + 顺带重挂）', () => {
  it('静默丢事件形态（无任何文件变化）：周期到点发 onFallbackTick（已登记 cwd 集合）', () => {
    const fx = makeRepo()
    const onFallbackTick = vi.fn()
    const watcher = new GitHeadWatcher({
      onGitEvent: vi.fn(),
      onFallbackTick,
      retryDelayMs: 10_000, // 排除 L1 重试干扰，精确证明 L2
      fallbackIntervalMs: 100,
    })
    watcher.observe(fx.repoCwd, repoObs(fx))

    vi.advanceTimersByTime(100)
    expect(onFallbackTick).toHaveBeenCalledTimes(1)
    expect(onFallbackTick).toHaveBeenCalledWith(new Set([fx.repoCwd]))

    vi.advanceTimersByTime(100) // 周期持续运行
    expect(onFallbackTick).toHaveBeenCalledTimes(2)
    watcher.dispose()
  })

  it('L2 顺带重挂恢复事件驱动：挂载失败（目录缺席）+ L1 重试未到期时，L2 周期 remount 成功', { timeout: 30_000 }, async () => {
    const gitDirAbsent = join(outerDir, 'late-repo', '.git')
    const lateCwd = join(outerDir, 'late-repo')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onGitEvent = vi.fn()
    const watcher = new GitHeadWatcher({
      onGitEvent,
      onFallbackTick: vi.fn(),
      retryDelayMs: 10_000, // L1 重试远未到期——事件若恢复只能归功 L2 顺带重挂
      fallbackIntervalMs: 100,
    })
    watcher.observe(lateCwd, obsOf({ gitDir: gitDirAbsent, headPath: join(gitDirAbsent, 'HEAD') }))
    expect(warnSpy).toHaveBeenCalledTimes(1) // 初始挂载失败（目录不存在）

    mkdirSync(gitDirAbsent, { recursive: true }) // 目录随后出现（如 git init）
    vi.advanceTimersByTime(100) // L2 周期：remountAll 顺带重挂 → 成功
    expect(warnSpy).toHaveBeenCalledTimes(1) // 无新 error
    expect(watcher.watchedDirsForTests()).toEqual([gitDirAbsent])

    atomicWriteHead(gitDirAbsent) // 事件驱动经 L2 重挂恢复
    await injectUntilPending(() => atomicWriteHead(gitDirAbsent), () => watcher.hasPendingGitEventsForTests())
    vi.advanceTimersByTime(500)
    expect(onGitEvent).toHaveBeenCalledWith(new Set([lateCwd]))
    expect(existsSync(join(gitDirAbsent, 'HEAD'))).toBe(true) // fixture 自检：rename 确实发生
    watcher.dispose()
    warnSpy.mockRestore()
  })

  it('dispose 后 L2 周期停止、observe 无操作（runtime shutdown 收口语义）', () => {
    const fx = makeRepo()
    const onFallbackTick = vi.fn()
    const watcher = new GitHeadWatcher({ onGitEvent: vi.fn(), onFallbackTick, fallbackIntervalMs: 100 })
    watcher.dispose()

    watcher.observe(fx.repoCwd, repoObs(fx))
    expect(watcher.watchedDirsForTests()).toEqual([])
    vi.advanceTimersByTime(1000)
    expect(onFallbackTick).not.toHaveBeenCalled()
  })
})
