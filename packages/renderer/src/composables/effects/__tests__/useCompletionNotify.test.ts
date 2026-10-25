import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { handleCompletion, __resetDebounceForTest } from '../useCompletionNotify'
import * as sound from '../useCompletionSound'
import * as markers from '../../useSessionMarkers'
import { useBackgroundWork } from '../../features/chat/useBackgroundWork'
import { getSettingsStore, provideSettingsStore, createSettingsStore } from '@taiji/core'
import {
  __resetBtwLineMembershipForTest,
  noteBtwLinesPulled,
} from '@/composables/panel/btw-line-membership'

// btw 线成员判别（W4b 收编）经 @/api session.listSessions 拉取——本文件只走缓存预热 +
// 一次补拉两条路径，mock 掉门面的 listSessions（spread actual 保其余域）。
const sessionListMock = vi.hoisted(() => ({ listSessions: vi.fn() }))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return { ...actual, session: { ...actual.session, listSessions: sessionListMock.listSessions } }
})

vi.mock('../useCompletionSound', () => ({
  // playSuccess/playError 现在是 async + 接受可选声音名参数
  playSuccess: vi.fn<(name?: string) => Promise<void>>().mockResolvedValue(undefined),
  playError: vi.fn<(name?: string) => Promise<void>>().mockResolvedValue(undefined),
}))

vi.mock('../../useSessionMarkers', () => ({
  markUnread: vi.fn(),
}))

// useBackgroundWork 默认 mock：hasBackgroundWork 返回 false。
// 既有 10 个用例默认假设无 background work（非 background 场景），保持行为不变。
// TC6/TC7/TC8 用 vi.mocked(useBackgroundWork).mockReturnValue 覆盖返回值。
vi.mock('../../features/chat/useBackgroundWork', () => ({
  useBackgroundWork: vi.fn(() => ({ hasBackgroundWork: () => false })),
}))

beforeEach(() => {
  // W4b 收编：btw 线成员判别缓存逐用例清零（拉取缓存 = session.list {surface:'btw'}）
  __resetBtwLineMembershipForTest()
  sessionListMock.listSessions.mockResolvedValue([])
  setActivePinia(createPinia())
  provideSettingsStore(createSettingsStore())
  vi.clearAllMocks()
  // 重置 useBackgroundWork mock 到默认实现（hasBackgroundWork=false），
  // 避免上一个用例的 mockReturnValue 污染下一个用例。
  vi.mocked(useBackgroundWork).mockReturnValue({ hasBackgroundWork: () => false })
  __resetDebounceForTest()
  // 默认设置 completionSound = true
  const settingsStore = getSettingsStore()
  settingsStore.system.value = { ...settingsStore.system.value, completionSound: true }
  // 默认 document.visibilityState = 'visible'
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

describe('useCompletionNotify', () => {
  it('后台完成 stopReason=stop → playSuccess + markUnread', async () => {
    await handleCompletion('s1', 'stop', 'other-sid')
    expect(sound.playSuccess).toHaveBeenCalledOnce()
    expect(markers.markUnread).toHaveBeenCalledWith('s1')
  })

  it('后台完成 stopReason=error → playError + markUnread', async () => {
    await handleCompletion('s1', 'error', 'other-sid')
    expect(sound.playError).toHaveBeenCalledOnce()
    expect(markers.markUnread).toHaveBeenCalledWith('s1')
  })

  it('后台完成 stopReason=aborted → 不响 + 不标记未读', async () => {
    await handleCompletion('s1', 'aborted', 'other-sid')
    expect(sound.playSuccess).not.toHaveBeenCalled()
    expect(sound.playError).not.toHaveBeenCalled()
    expect(markers.markUnread).not.toHaveBeenCalled()
  })

  it('前台完成（focused + visible）→ 不响', async () => {
    await handleCompletion('s1', 'stop', 's1')
    expect(sound.playSuccess).not.toHaveBeenCalled()
    expect(markers.markUnread).not.toHaveBeenCalled()
  })

  it('前台但页面不可见 → 仍然触发', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await handleCompletion('s1', 'stop', 's1')
    expect(sound.playSuccess).toHaveBeenCalledOnce()
    expect(markers.markUnread).toHaveBeenCalledWith('s1')
  })

  it('1s 防抖：连续 2 个完成只响一次', async () => {
    await handleCompletion('s1', 'stop', 'other-sid')
    await handleCompletion('s2', 'stop', 'other-sid')
    expect(sound.playSuccess).toHaveBeenCalledOnce()
    // 但 markUnread 每次都调（未读不受防抖影响）
    expect(markers.markUnread).toHaveBeenCalledTimes(2)
  })

  it('completionSound=false → 不响但仍然标记未读', async () => {
    const settingsStore = getSettingsStore()
    settingsStore.system.value = { ...settingsStore.system.value, completionSound: false }
    await handleCompletion('s1', 'stop', 'other-sid')
    expect(sound.playSuccess).not.toHaveBeenCalled()
    expect(markers.markUnread).toHaveBeenCalledWith('s1')
  })

  it('设置 successSound 时透传给 playSuccess', async () => {
    const settingsStore = getSettingsStore()
    settingsStore.system.value = { ...settingsStore.system.value, successSound: 'Hero' }
    await handleCompletion('s1', 'stop', 'other-sid')
    expect(sound.playSuccess).toHaveBeenCalledWith('Hero')
  })

  it('设置 errorSound 时透传给 playError', async () => {
    const settingsStore = getSettingsStore()
    settingsStore.system.value = { ...settingsStore.system.value, errorSound: 'Sosumi' }
    await handleCompletion('s1', 'error', 'other-sid')
    expect(sound.playError).toHaveBeenCalledWith('Sosumi')
  })

  it('未设置声音名时传 undefined（playSuccess 内部 fallback 到平台默认）', async () => {
    await handleCompletion('s1', 'stop', 'other-sid')
    expect(sound.playSuccess).toHaveBeenCalledWith(undefined)
  })

  // ── background work 检查（CW wave completion-sound-bg-guard）──

  it('TC6: background work 仍在跑 → 跳过提示音 + 不标记未读（检查命中）', async () => {
    vi.mocked(useBackgroundWork).mockReturnValue({ hasBackgroundWork: () => true })
    await handleCompletion('s1', 'stop', 'other-sid')
    expect(sound.playSuccess).not.toHaveBeenCalled()
    expect(sound.playError).not.toHaveBeenCalled()
    expect(markers.markUnread).not.toHaveBeenCalled()
  })

  it('TC7: background 全 done → 正常触发提示音 + 标记未读（检查放行）', async () => {
    vi.mocked(useBackgroundWork).mockReturnValue({ hasBackgroundWork: () => false })
    await handleCompletion('s1', 'stop', 'other-sid')
    expect(sound.playSuccess).toHaveBeenCalledOnce()
    expect(markers.markUnread).toHaveBeenCalledWith('s1')
  })

  it('TC8: aborted + background 仍在跑 → 仍跳过（aborted 检查先短路，与 background 检查并列都不触发）', async () => {
    vi.mocked(useBackgroundWork).mockReturnValue({ hasBackgroundWork: () => true })
    await handleCompletion('s1', 'aborted', 'other-sid')
    expect(sound.playSuccess).not.toHaveBeenCalled()
    expect(sound.playError).not.toHaveBeenCalled()
    expect(markers.markUnread).not.toHaveBeenCalled()
  })

  it('TC9: background error 态完成 → 检查放行后走 error 路径（playError）', async () => {
    vi.mocked(useBackgroundWork).mockReturnValue({ hasBackgroundWork: () => false })
    await handleCompletion('s1', 'error', 'other-sid')
    expect(sound.playError).toHaveBeenCalledOnce()
    expect(markers.markUnread).toHaveBeenCalledWith('s1')
  })

  // ── [retry-sound] pi auto-retry 中间失败静音（runtime 透传 willRetry）──

  it('RC1: willRetry=true 后台 error → 不响 + 不标未读（中间失败，turn 未结束）', async () => {
    await handleCompletion('s1', 'error', 'other-sid', true)
    expect(sound.playError).not.toHaveBeenCalled()
    expect(sound.playSuccess).not.toHaveBeenCalled()
    expect(markers.markUnread).not.toHaveBeenCalled()
  })

  it('RC2: willRetry=true 优先于后续检查（background work 在跑时同样静音）', async () => {
    vi.mocked(useBackgroundWork).mockReturnValue({ hasBackgroundWork: () => true })
    await handleCompletion('s1', 'error', 'other-sid', true)
    expect(sound.playError).not.toHaveBeenCalled()
    expect(markers.markUnread).not.toHaveBeenCalled()
  })

  it('RC3: willRetry=false 重试用尽终态 error → 正常响 error + 标未读', async () => {
    await handleCompletion('s1', 'error', 'other-sid', false)
    expect(sound.playError).toHaveBeenCalledOnce()
    expect(markers.markUnread).toHaveBeenCalledWith('s1')
  })

  it('RC4: willRetry 缺省（旧 runtime）→ 行为与现状一致（error 照响）', async () => {
    await handleCompletion('s1', 'error', 'other-sid', undefined)
    expect(sound.playError).toHaveBeenCalledOnce()
    expect(markers.markUnread).toHaveBeenCalledWith('s1')
  })

  it('RC5: 重试链场景——“中间失败（静音）→ 终态成功（响一声）”全程只响一次 success', async () => {
    // attempt 1 失败（pi 将重试）
    await handleCompletion('s1', 'error', 'other-sid', true)
    // 续跑成功终态
    await handleCompletion('s1', 'stop', 'other-sid', false)
    expect(sound.playError).not.toHaveBeenCalled()
    expect(sound.playSuccess).toHaveBeenCalledOnce()
    expect(markers.markUnread).toHaveBeenCalledTimes(1)
  })

  it('RC6: willRetry=true + aborted 组合 → aborted 先短路，同样不响', async () => {
    await handleCompletion('s1', 'aborted', 'other-sid', true)
    expect(sound.playError).not.toHaveBeenCalled()
    expect(markers.markUnread).not.toHaveBeenCalled()
  })
})

describe('[M4-a] P-invisible·通知侧：btw 线完成不进全局通知（D9③ 派生视图收窄；W4b 收编后拉取供数）', () => {
  it('btw 线完成 → 无提示音 + 不落 sidebar 未读标记；主会话同输入对照照常', async () => {
    // W4b 收编判别器 = session.list {surface:'btw'} 拉取缓存成员判别
    // （btw-line-membership；旧 isBtwVirtualId 前缀判别随 vid 退役、session.surfaces 派生表
    // 随收编删除，设计 §5-W4b）——线 session id 经缓存预热（= 抽屉拉取产物喂入）。
    noteBtwLinesPulled(['line-notify-1'])
    await handleCompletion('line-notify-1', 'stop', 'other-sid')
    expect(sound.playSuccess).not.toHaveBeenCalled()
    expect(markers.markUnread).not.toHaveBeenCalled() // 不写 taiji:session-markers（防已删线死条目）

    // 对照：主会话完成不受抑制（既有行为回归；缓存外 id = 非线）
    await handleCompletion('s1', 'stop', 'other-sid')
    expect(sound.playSuccess).toHaveBeenCalledOnce()
    expect(markers.markUnread).toHaveBeenCalledWith('s1')
  })

  it('W4b：查找落空补拉一次再判——补拉结果在线即抑制（覆盖度缓解，不猜）', async () => {
    // 缓存未覆盖的线（后台建线、抽屉未开）：完成事件到达 → 补拉一次 → 拉到即抑制
    sessionListMock.listSessions.mockResolvedValue([
      { cwd: '/repo/main', sessions: [{ id: 'bg-line-1', label: 'btw-1', cwd: '/repo/main', status: 'idle', lastActiveAt: 0, surface: 'btw' }] },
    ])
    await handleCompletion('bg-line-1', 'stop', 'other-sid')
    expect(sessionListMock.listSessions).toHaveBeenCalledWith({ surface: 'btw' })
    expect(sound.playSuccess).not.toHaveBeenCalled()
    expect(markers.markUnread).not.toHaveBeenCalled()
  })

  it('W4b：缓存外 id 补拉后仍不在线 → 判非线照常通知（不猜成线）', async () => {
    noteBtwLinesPulled(['line-known'])
    sessionListMock.listSessions.mockResolvedValue([])
    await handleCompletion('never-seen-line', 'stop', 'other-sid')
    expect(sound.playSuccess).toHaveBeenCalledOnce()
    expect(markers.markUnread).toHaveBeenCalledWith('never-seen-line')
  })

  it('W4b：拉取失败 = 显式未知 warn + 当次不抑制（失败方向 = 偶发全局通知，可接受）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sessionListMock.listSessions.mockRejectedValue(new Error('ws down'))
    await handleCompletion('pull-fail-line', 'stop', 'other-sid')
    expect(warnSpy).toHaveBeenCalled()
    expect(sound.playSuccess).toHaveBeenCalledOnce() // 当次不抑制
    expect(markers.markUnread).toHaveBeenCalledWith('pull-fail-line')
    warnSpy.mockRestore()
  })
})
