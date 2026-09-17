/**
 * GitChangeTrigger 单测（缓存治理批 4 U11）：「最后一公里」触发器的统一入口语义。
 *
 * observations 用可编程 fake（per-cwd 队列：第一次 readObservation 返回旧值，invalidate 后
 * 第二次返回新值——与真实链「缓存命中 → invalidateByCwd → miss 重解析」同构）；
 * pushSessionList 即 mock broker（对应生产 server.broadcastSessionList——内部即
 * listPersistedSessions 重扫 + config.sessions 广播）。
 *
 * 覆盖：值变化判定（无变化不广播）/ leading 节流（首变立即、2s 窗口合并连发、窗口外新 leading）/
 * 兜底修正 warn（watch 来源不 warn）/ dispose 撤销窗口收尾。
 *
 * 测试框架 vitest，运行命令：cd packages/runtime && npx vitest run src/services/git/git-change-trigger.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitChangeTrigger } from './git-change-trigger.js'
import type { GitObservationPort } from './git-change-trigger.js'
import type { RepoObservation } from '../ports/git-info.js'

const NON_REPO: RepoObservation = { branch: undefined, isWorktree: false, isBare: false, gitDir: undefined, headPath: undefined }

function obsOf(branch: string | undefined): RepoObservation {
  return { ...NON_REPO, branch }
}

/**
 * 可编程 fake 观测面：queues[cwd] = 按 readObservation 调用序弹出的 branch 序列
 * （第 1 次 = 刷新前缓存值，第 2 次 = invalidate 后重解析值）；队列空则视为解析失败 undefined。
 */
function createFakeObservations() {
  const queues = new Map<string, Array<string | undefined>>()
  const read = vi.fn((cwd: string): RepoObservation => {
    const q = queues.get(cwd)
    return obsOf(q && q.length > 0 ? q.shift() : undefined)
  })
  const invalidate = vi.fn((_cwd: string): void => {})
  const port: GitObservationPort = { readObservation: read, invalidateByCwd: invalidate }
  return {
    port,
    read,
    invalidate,
    stubBranchTransition(cwd: string, before: string | undefined, after: string | undefined): void {
      queues.set(cwd, [before, after])
    },
  }
}

function createTrigger(fake: ReturnType<typeof createFakeObservations>, throttleWindowMs = 2000) {
  const pushSessionList = vi.fn()
  const trigger = new GitChangeTrigger({ observations: fake.port, pushSessionList, throttleWindowMs })
  return { trigger, pushSessionList }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GitChangeTrigger 值变化判定（统一入口）', () => {
  it('branch 变化 → listPersistedSessions/broker 链（pushSessionList）被调（leading 立即放行）', () => {
    const fake = createFakeObservations()
    fake.stubBranchTransition('/repo', 'main', 'feature-x')
    const { trigger, pushSessionList } = createTrigger(fake)

    trigger.refresh(new Set(['/repo']), 'watch')

    expect(fake.read).toHaveBeenCalledTimes(2) // 读旧值 + invalidate 后重解析
    expect(fake.invalidate).toHaveBeenCalledWith('/repo') // statusCache 相关键失效入口
    expect(pushSessionList).toHaveBeenCalledTimes(1) // 同步立即，无 timer 延迟
  })

  it('branch 未变化（invalidate 重解析值相同）→ 不广播', () => {
    const fake = createFakeObservations()
    fake.stubBranchTransition('/repo', 'main', 'main')
    const { trigger, pushSessionList } = createTrigger(fake)

    trigger.refresh(new Set(['/repo']), 'watch')

    expect(pushSessionList).not.toHaveBeenCalled()
  })

  it('undefined → branch（git init 后收敛形态）与 branch → undefined（repo 被删）都算变化', () => {
    const fake = createFakeObservations()
    fake.stubBranchTransition('/repo', undefined, 'main')
    const { trigger, pushSessionList } = createTrigger(fake)
    trigger.refresh(new Set(['/repo']), 'watch')
    expect(pushSessionList).toHaveBeenCalledTimes(1)

    const fake2 = createFakeObservations()
    fake2.stubBranchTransition('/repo2', 'main', undefined)
    const { trigger: trigger2, pushSessionList: push2 } = createTrigger(fake2)
    trigger2.refresh(new Set(['/repo2']), 'watch')
    expect(push2).toHaveBeenCalledTimes(1)
  })

  it('多 cwd 批次：任一变化即触发一次广播，其余未变化 cwd 不叠加', () => {
    const fake = createFakeObservations()
    fake.stubBranchTransition('/a', 'main', 'feat') // 变化
    fake.stubBranchTransition('/b', 'main', 'main') // 未变化
    const { trigger, pushSessionList } = createTrigger(fake)

    trigger.refresh(new Set(['/a', '/b']), 'watch')
    expect(pushSessionList).toHaveBeenCalledTimes(1)
  })
})

describe('GitChangeTrigger leading 节流（首变立即放行，2s 窗口只合并后续连发）', () => {
  it('2s 窗口内的连发不延长窗口：到点收尾合并执行一次（共 2 次广播）', () => {
    const fake = createFakeObservations()
    const { trigger, pushSessionList } = createTrigger(fake)

    fake.stubBranchTransition('/a', 'main', 'feat-a')
    trigger.refresh(new Set(['/a']), 'watch')
    expect(pushSessionList).toHaveBeenCalledTimes(1) // leading：首变立即

    vi.advanceTimersByTime(800)
    fake.stubBranchTransition('/b', 'main', 'feat-b')
    trigger.refresh(new Set(['/b']), 'watch')
    expect(pushSessionList).toHaveBeenCalledTimes(1) // 窗口内：只合并不放行

    vi.advanceTimersByTime(1200) // 窗口收尾（首变起算 2s，连发不延长）
    expect(pushSessionList).toHaveBeenCalledTimes(2)
  })

  it('窗口收尾后的新变化是新 leading：立即放行', () => {
    const fake = createFakeObservations()
    const { trigger, pushSessionList } = createTrigger(fake)

    fake.stubBranchTransition('/a', 'main', 'feat-a')
    trigger.refresh(new Set(['/a']), 'watch')
    vi.advanceTimersByTime(2000) // 窗口结束（无连发，收尾空转）

    fake.stubBranchTransition('/b', 'main', 'feat-b')
    trigger.refresh(new Set(['/b']), 'watch')
    expect(pushSessionList).toHaveBeenCalledTimes(2) // 新窗口 leading：立即
    expect(pushSessionList).toHaveBeenCalledTimes(2) // 无额外收尾
  })

  it('dispose 撤销未放行的窗口收尾 timer', () => {
    const fake = createFakeObservations()
    const { trigger, pushSessionList } = createTrigger(fake)

    fake.stubBranchTransition('/a', 'main', 'feat-a')
    trigger.refresh(new Set(['/a']), 'watch') // leading 放行，lastPushAt = now
    expect(pushSessionList).toHaveBeenCalledTimes(1)

    fake.stubBranchTransition('/b', 'main', 'feat-b')
    trigger.refresh(new Set(['/b']), 'watch') // 排窗口收尾 timer
    trigger.dispose()

    vi.advanceTimersByTime(5000)
    expect(pushSessionList).toHaveBeenCalledTimes(1) // 收尾已撤销，不再放行
  })
})

describe('GitChangeTrigger 兜底修正 warn（可观测信号）', () => {
  it('source=fallback 且值被修正 → console.warn（高频出现 = 平台 watch 缺陷复发信号）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = createFakeObservations()
    fake.stubBranchTransition('/repo', 'main', 'feature-x')
    const { trigger, pushSessionList } = createTrigger(fake)

    trigger.refresh(new Set(['/repo']), 'fallback')

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('fallback rescan corrected branch')
    expect(warnSpy.mock.calls[0][0]).toContain('/repo')
    expect(pushSessionList).toHaveBeenCalledTimes(1) // 兜底修正同链广播（统一入口）
    warnSpy.mockRestore()
  })

  it('source=watch 的正常刷新不 warn；fallback 路径值未变同样不 warn 不广播', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = createFakeObservations()
    fake.stubBranchTransition('/repo', 'main', 'feature-x')
    const { trigger } = createTrigger(fake)
    trigger.refresh(new Set(['/repo']), 'watch')
    expect(warnSpy).not.toHaveBeenCalled()

    const fake2 = createFakeObservations()
    fake2.stubBranchTransition('/repo2', 'main', 'main')
    const { trigger: trigger2, pushSessionList } = createTrigger(fake2)
    trigger2.refresh(new Set(['/repo2']), 'fallback')
    expect(warnSpy).not.toHaveBeenCalled()
    expect(pushSessionList).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
