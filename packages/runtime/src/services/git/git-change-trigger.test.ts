/**
 * GitChangeTrigger 单测（缓存治理批 4 U11）：「最后一公里」触发器的统一入口语义。
 *
 * observations 用可编程 fake（per-cwd 当前解析值——refreshOne 只读一次重解析值，
 * 值变化判定的锚是 trigger 自持的 lastPushedBranch，不再依赖「刷新前缓存值」）；
 * pushSessionList 即 mock broker（对应生产 server.broadcastSessionList——内部即
 * listPersistedSessions 重扫 + config.sessions 广播）。
 *
 * 覆盖：值变化判定（无变化不广播）/ 首刷无锚语义 / 冷缓存不吞变更（锚 = 上次推送值，
 * 非 缓存态——TTL 过期后缓存态翻新是吞变更事故形态）/ leading 节流（首变立即、2s 窗口
 * 合并连发、窗口外新 leading）/ 兜底修正 warn（watch 来源不 warn）/ dispose 撤销窗口收尾。
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
 * 可编程 fake 观测面：values[cwd] = 当前重解析值（refreshOne 每轮只读一次）；
 * 测试在两轮 refresh 之间用 stubResolved 切换值模拟分支切换 / 冷缓存翻新。
 */
function createFakeObservations() {
  const values = new Map<string, string | undefined>()
  const read = vi.fn((cwd: string): RepoObservation => obsOf(values.get(cwd)))
  const invalidate = vi.fn((_cwd: string): void => {})
  const port: GitObservationPort = { readObservation: read, invalidateByCwd: invalidate }
  return {
    port,
    read,
    invalidate,
    stubResolved(cwd: string, branch: string | undefined): void {
      values.set(cwd, branch)
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

describe('GitChangeTrigger 值变化判定（统一入口，锚 = 上次推送值）', () => {
  it('branch 变化 → listPersistedSessions/broker 链（pushSessionList）被调（leading 立即放行）', () => {
    const fake = createFakeObservations()
    fake.stubResolved('/repo', 'feature-x')
    const { trigger, pushSessionList } = createTrigger(fake)

    trigger.refresh(new Set(['/repo']), 'watch')

    expect(fake.read).toHaveBeenCalledTimes(1) // 只读重解析值（锚来自 trigger 自持 Map）
    expect(fake.invalidate).toHaveBeenCalledWith('/repo') // statusCache 相关键失效入口
    expect(pushSessionList).toHaveBeenCalledTimes(1) // 同步立即，无 timer 延迟
  })

  it('首刷无锚：任意值视为变化广播一次（锚建立），同值再刷不广播', () => {
    const fake = createFakeObservations()
    fake.stubResolved('/repo', 'main')
    const { trigger, pushSessionList } = createTrigger(fake)

    trigger.refresh(new Set(['/repo']), 'watch')
    expect(pushSessionList).toHaveBeenCalledTimes(1) // 无锚（undefined ≠ main）→ 首刷建锚广播

    trigger.refresh(new Set(['/repo']), 'watch')
    expect(pushSessionList).toHaveBeenCalledTimes(1) // 锚 = main，重解析同值 → 不广播
  })

  it('冷缓存形态（TTL 过期后缓存态已翻新）不吞变更——锚为上次推送值而非缓存态', () => {
    const fake = createFakeObservations()
    fake.stubResolved('/repo', 'main')
    const { trigger, pushSessionList } = createTrigger(fake)
    trigger.refresh(new Set(['/repo']), 'watch') // 锚 = main
    expect(pushSessionList).toHaveBeenCalledTimes(1)

    // 闲置 >TTL 后切分支再触发刷新：真实观测器 readObservation 此时惰性重解析，
    // 读到的已是新值（原实现以「刷新前缓存读」为锚 → before===after 恒成立 →
    // 变更被吞且缓存已翻新，徽章无限期陈旧）。
    vi.advanceTimersByTime(2000) // 越过节流窗口（同实例二连刷的第二次是新 leading）
    fake.stubResolved('/repo', 'feature-x')
    trigger.refresh(new Set(['/repo']), 'watch')
    expect(pushSessionList).toHaveBeenCalledTimes(2)
  })

  it('branch → undefined（repo 被删）算变化', () => {
    const fake = createFakeObservations()
    fake.stubResolved('/repo', 'main')
    const { trigger, pushSessionList } = createTrigger(fake)
    trigger.refresh(new Set(['/repo']), 'watch')
    expect(pushSessionList).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2000) // 同上：越过节流窗口
    fake.stubResolved('/repo', undefined)
    trigger.refresh(new Set(['/repo']), 'watch')
    expect(pushSessionList).toHaveBeenCalledTimes(2)
  })

  it('非 git 目录（undefined 锚 + undefined 解析值）首刷不广播', () => {
    const fake = createFakeObservations()
    fake.stubResolved('/dir', undefined)
    const { trigger, pushSessionList } = createTrigger(fake)
    trigger.refresh(new Set(['/dir']), 'watch')
    expect(pushSessionList).not.toHaveBeenCalled()
  })

  it('多 cwd 批次：任一变化即触发一次广播，其余未变化 cwd 不叠加', () => {
    const fake = createFakeObservations()
    fake.stubResolved('/a', 'main')
    fake.stubResolved('/b', 'main')
    const { trigger, pushSessionList } = createTrigger(fake)
    trigger.refresh(new Set(['/a', '/b']), 'watch') // 建锚（首刷变化）
    pushSessionList.mockClear()

    vi.advanceTimersByTime(2000) // 同上：越过节流窗口
    fake.stubResolved('/a', 'feat') // 变化；/b 仍 main 未变化
    trigger.refresh(new Set(['/a', '/b']), 'watch')
    expect(pushSessionList).toHaveBeenCalledTimes(1)
  })
})

describe('GitChangeTrigger leading 节流（首变立即放行，2s 窗口只合并后续连发）', () => {
  it('2s 窗口内的连发不延长窗口：到点收尾合并执行一次（共 2 次广播）', () => {
    const fake = createFakeObservations()
    const { trigger, pushSessionList } = createTrigger(fake)

    fake.stubResolved('/a', 'feat-a')
    trigger.refresh(new Set(['/a']), 'watch')
    expect(pushSessionList).toHaveBeenCalledTimes(1) // leading：首变立即

    vi.advanceTimersByTime(800)
    fake.stubResolved('/b', 'feat-b')
    trigger.refresh(new Set(['/b']), 'watch')
    expect(pushSessionList).toHaveBeenCalledTimes(1) // 窗口内：只合并不放行

    vi.advanceTimersByTime(1200) // 窗口收尾（首变起算 2s，连发不延长）
    expect(pushSessionList).toHaveBeenCalledTimes(2)
  })

  it('窗口收尾后的新变化是新 leading：立即放行', () => {
    const fake = createFakeObservations()
    const { trigger, pushSessionList } = createTrigger(fake)

    fake.stubResolved('/a', 'feat-a')
    trigger.refresh(new Set(['/a']), 'watch')
    vi.advanceTimersByTime(2000) // 窗口结束（无连发，收尾空转）

    fake.stubResolved('/b', 'feat-b')
    trigger.refresh(new Set(['/b']), 'watch')
    expect(pushSessionList).toHaveBeenCalledTimes(2) // 新窗口 leading：立即
    expect(pushSessionList).toHaveBeenCalledTimes(2) // 无额外收尾
  })

  it('dispose 撤销未放行的窗口收尾 timer', () => {
    const fake = createFakeObservations()
    const { trigger, pushSessionList } = createTrigger(fake)

    fake.stubResolved('/a', 'feat-a')
    trigger.refresh(new Set(['/a']), 'watch') // leading 放行，lastPushAt = now
    expect(pushSessionList).toHaveBeenCalledTimes(1)

    fake.stubResolved('/b', 'feat-b')
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
    fake.stubResolved('/repo', 'main')
    const { trigger, pushSessionList } = createTrigger(fake)
    trigger.refresh(new Set(['/repo']), 'watch') // 锚 = main
    pushSessionList.mockClear()
    vi.advanceTimersByTime(2000) // 同上：越过节流窗口

    fake.stubResolved('/repo', 'feature-x')
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
    fake.stubResolved('/repo', 'main')
    const { trigger, pushSessionList } = createTrigger(fake)
    trigger.refresh(new Set(['/repo']), 'watch') // 锚 = main
    expect(warnSpy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2000) // 同上：越过节流窗口
    trigger.refresh(new Set(['/repo']), 'fallback') // 重解析同值
    expect(warnSpy).not.toHaveBeenCalled()
    expect(pushSessionList).toHaveBeenCalledTimes(1) // 仅首刷建锚的那次
    warnSpy.mockRestore()
  })
})
