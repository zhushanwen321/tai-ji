/**
 * composables/effects 域合并产物（round 6 renderer 测试压缩）：两文件同产物，
 * 环境统一默认（happy-dom）。useSessionStreamSync 原为 node 环境注释（纯 pinia + watch
 * 逻辑无 DOM 依赖），迁移实证兼容。
 *
 * 并入来源（基名）：
 *  - effects/useSessionStreamSync（w1：diffSessionList 纯函数 + bindSessionStreamSync
 *    集成（mock useChat），10 例，原 node）
 *  - effects/useCompletionSound（系统提示音 IPC + Audio 播放，13 例）
 *
 * mock 注册与互斥核查：
 *  - useSessionStreamSync mock '@/composables/features/chat/useChat'（砍成员工厂：
 *    ensureStreamSubscription/useChat/resetChatModuleState）——useCompletionSound 节
 *    不消费 useChat，不受截断。
 *  - useCompletionSound 零 vi.mock；原文件级 beforeEach/afterEach（注入 electronAPI +
 *    替换 globalThis.Audio）已下沉进 describe 并补 afterEach 恢复（独立文件时靠 worker
 *    隔离吸收全局替换，合并后须显式还原，防泄漏到其余节）。
 *  - useSessionStreamSync 的顶层 await import 链保持原时序（vi.mock 注册后求值）。
 *
 * 互斥登记（不并入本产物的原因）：
 *  - useSessionStreamSync-boundary（真 useChat 真链路）与本文件 mock useChat 结构性
 *    互斥——已并入 shell-host-bundle.test.ts。
 *  - useCompletionNotify mock '../useCompletionSound'（本产物被测对象之一）+ 另两个姊妹
 *    被测对象——保留独立。useMessageEffects mock 六个 store + useCompletionNotify，
 *    与真 store 链邻居互斥——保留独立。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/composables/effects/__tests__/stream-sound-bundle.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import { diffSessionList } from '../useSessionStreamSync'
import type { SessionSummary } from '@taiji/shared'

// ── useSessionStreamSync 节的 useChat mock ──
// mock useChat（隔离 streamSubscriptions 模块级 Map + 捕获调用）。
// disposeSessionMock 为模块级共享，便于 TC6/TC9/TC10 断言调用次数/参数。
const disposeSessionMock = vi.fn()
vi.mock('@/composables/features/chat/useChat', () => ({
  ensureStreamSubscription: vi.fn(),
  useChat: () => ({ disposeSession: disposeSessionMock }),
  resetChatModuleState: vi.fn(),
}))

const useChatMock = await import('@/composables/features/chat/useChat')
const ensureStreamSubscriptionMock = useChatMock.ensureStreamSubscription as ReturnType<typeof vi.fn>
const { useSessionStore } = await import('@/stores/session')
const { bindSessionStreamSync } = await import('../useSessionStreamSync')

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：effects/useSessionStreamSync（原 node 环境文件）
// ─────────────────────────────────────────────────────────────────────────────

/** 辅助：构造最小 SessionSummary（cast 补齐可选字段，测试代码可接受） */
function mkSession(id: string): SessionSummary {
  return { id, label: id, cwd: '/x', status: 'idle' } as SessionSummary
}

describe('diffSessionList', () => {
  it('TC1: 纯新增', () => {
    const result = diffSessionList([mkSession('a'), mkSession('b')], [])
    expect(result).toEqual({ added: ['a', 'b'], removed: [] })
  })
  it('TC2: 纯移除', () => {
    const result = diffSessionList([], [mkSession('a'), mkSession('b')])
    expect(result).toEqual({ added: [], removed: ['a', 'b'] })
  })
  it('TC3: 混合（新增+移除+保留）', () => {
    const result = diffSessionList(
      [mkSession('a'), mkSession('c'), mkSession('d')],
      [mkSession('a'), mkSession('b'), mkSession('e')],
    )
    expect(result.added).toEqual(['c', 'd'])
    expect(result.removed).toEqual(['b', 'e'])
  })
  it('TC4: 双空 list', () => {
    const result = diffSessionList([], [])
    expect(result).toEqual({ added: [], removed: [] })
  })
})

describe('bindSessionStreamSync', () => {
  let pinia: ReturnType<typeof createPinia>
  let scope: ReturnType<typeof effectScope>
  let sessionStore: ReturnType<typeof useSessionStore>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    pinia = createPinia()
    setActivePinia(pinia)
    scope = effectScope()
    sessionStore = scope.run(() => {
      const s = useSessionStore()
      bindSessionStreamSync() // 在 scope 内注册 effect
      return s
    })!
  })

  afterEach(() => {
    scope.stop()
    vi.restoreAllMocks()
  })

  it('TC5: list 从空变 [s1,s2]，ensureStreamSubscription 被对每个 added 调用', () => {
    sessionStore.appendSession(mkSession('s1'))
    sessionStore.appendSession(mkSession('s2'))
    expect(ensureStreamSubscriptionMock).toHaveBeenCalledTimes(2)
    // 验证参数含正确 sid（第 0 参数）
    expect(ensureStreamSubscriptionMock.mock.calls[0][0]).toBe('s1')
    expect(ensureStreamSubscriptionMock.mock.calls[1][0]).toBe('s2')
  })

  it('TC6: removed 触发 disposeSession，参数为被移除的 sid', () => {
    sessionStore.appendSession(mkSession('s1'))
    sessionStore.appendSession(mkSession('s2'))
    expect(disposeSessionMock).not.toHaveBeenCalled()
    sessionStore.removeFromList('s2')
    expect(disposeSessionMock).toHaveBeenCalledTimes(1)
    expect(disposeSessionMock).toHaveBeenCalledWith('s2')
  })

  it('TC7: flush:sync——appendSession 后不 await 立即已建订阅', () => {
    // 同步 append 后立即断言（证明 flush:'sync'，非异步）
    sessionStore.appendSession(mkSession('s-sync'))
    expect(ensureStreamSubscriptionMock).toHaveBeenCalledTimes(1)
    expect(ensureStreamSubscriptionMock.mock.calls[0][0]).toBe('s-sync')
  })

  it('TC8: scope.stop() 后 watch 退订，append 不再触发 ensureStreamSubscription', () => {
    // 不清 mock：通过比较 scope.stop() 前后的调用次数差证明 watch 已取消。
    // clearAllMocks 会把计数清零，断言通过不能证明 watch 真的解绑（验证空洞）。
    const beforeCount = ensureStreamSubscriptionMock.mock.calls.length
    scope.stop()
    // stop 后再 append（store 已存在，scope 已 stop，但 store 调用仍安全）
    sessionStore.appendSession(mkSession('s-after-stop'))
    // watch 已取消：appendSession 不触发 ensureStreamSubscription，调用次数应保持不变
    expect(ensureStreamSubscriptionMock.mock.calls.length).toBe(beforeCount)
  })

  it('TC9: 异常隔离——单 session ensureStreamSubscription throw 不阻断其余', () => {
    // s1 throw，s2 正常
    ensureStreamSubscriptionMock.mockImplementation((sid: string) => {
      if (sid === 's1') throw new Error('boom-s1')
    })
    sessionStore.appendSession(mkSession('s1'))
    sessionStore.appendSession(mkSession('s2'))
    // s2 仍被调用（未因 s1 失败而中断）
    expect(ensureStreamSubscriptionMock).toHaveBeenCalledTimes(2)
    expect(ensureStreamSubscriptionMock.mock.calls[0][0]).toBe('s1')
    expect(ensureStreamSubscriptionMock.mock.calls[1][0]).toBe('s2')
    // s1 失败记录 warn，含 sid
    expect(console.warn).toHaveBeenCalled()
    const warnMsg = JSON.stringify((console.warn as ReturnType<typeof vi.fn>).mock.calls)
    expect(warnMsg).toContain('s1')
  })

  it('TC10: removed 路径内层 try-catch 隔离——disposeSession 抛错不冒泡到 removeFromList 调用栈', () => {
    // 诚实降级说明：原 TC10 声称测"最外层 try-catch 防冒泡"，但用 ensureStreamSubscription/disposeSession
    // 抛错只能到达内层 per-session try-catch（源码 added/removed 循环内已有 try-catch 吞掉），最外层
    // catch 不可达——实测为验证空洞（断言全绿但没测到声称的分支）。
    // 唯一能穿透到最外层 catch 的是 diffSessionList 抛错，但 diffSessionList 是同模块 export，
    // ESM 模块绑定下 spyOn 命名空间对象无法覆盖源码内的直接引用（已实测 spy 不生效），强行注入需
    // 重构生产代码（过度）。因此降级为名副其实地测内层 try-catch：
    // - TC9 已覆盖 added 路径（ensureStreamSubscription 抛错隔离）；
    // - 本 TC10 覆盖 removed 路径——disposeSession 抛错被内层 catch 吞，不冒泡 + 记录 warn。
    disposeSessionMock.mockImplementation(() => {
      throw new Error('dispose-boom')
    })
    sessionStore.appendSession(mkSession('s1'))
    // try 内调 removeFromList——disposeSession 抛错应被内层 try-catch 兜住，不冒泡
    expect(() => {
      sessionStore.removeFromList('s1')
    }).not.toThrow()
    // 内层 catch 记录 warn，消息含 sid（区别于最外层 watch callback error）
    expect(console.warn).toHaveBeenCalled()
    const warnMsg = JSON.stringify((console.warn as ReturnType<typeof vi.fn>).mock.calls)
    expect(warnMsg).toContain('s1')
    expect(warnMsg).toContain('disposeSession failed')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：effects/useCompletionSound
// ─────────────────────────────────────────────────────────────────────────────

// 注意：本节禁止顶层静态 import 被测模块 —— lib/ipc 在模块加载时捕获
// window.electronAPI（const api = window.electronAPI），静态 import 会在
// beforeEach 注入 mock 之前求值导致 api 永远 undefined。一律经动态 import。

// Mock window.electronAPI.playSystemSound
const mockPlaySystemSound = vi.fn<(name: string) => Promise<{ audioData?: string; mimeType?: string }>>()
mockPlaySystemSound.mockResolvedValue({}) // mac/linux 默认空对象（main spawn 播）

// Mock HTMLAudioElement.play（win 路径用 new Audio）
const mockAudioPlay = vi.fn().mockResolvedValue(undefined)

// Audio 必须是 constructor（new Audio()）→ vi.fn 包裹普通 function
const mockAudioCtor = vi.fn(function (this: { play: typeof mockAudioPlay; currentTime?: number }) {
  this.play = mockAudioPlay
})

// 合并新增：保存全局原值，afterEach 显式还原（原独立文件靠 worker 隔离吸收，
// 合并后防泄漏到本文件其余节）
const realAudioCtor = globalThis.Audio

// helpers：动态 import 拿最新模块状态
async function loadSoundModule() {
  const mod = await import('../useCompletionSound')
  return { playSuccess: mod.playSuccess, playError: mod.playError, playByName: mod.playByName }
}

describe('useCompletionSound', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockPlaySystemSound.mockResolvedValue({})
    // @ts-expect-error 测试桩：注入 electronAPI（必须先于被测模块首次求值）
    globalThis.window = globalThis.window || {}
    // @ts-expect-error 测试桩
    globalThis.window.electronAPI = {
      playSystemSound: mockPlaySystemSound,
    }
    // @ts-expect-error 测试桩：mock Audio 为 constructor
    globalThis.Audio = mockAudioCtor as unknown as typeof Audio
    // Q1-3 缓存隔离：探测 memo / 默认音解析 / Audio 复用 Map 全清，用例间互不渗透
    const soundMod = await import('../useCompletionSound')
    soundMod.__resetSoundCachesForTest()
    const platformMod = await import('../../sound-platform')
    platformMod.__resetPlatformMemoForTest()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    // 合并新增：还原全局替换，防泄漏到本文件其余节
    globalThis.Audio = realAudioCtor
    // @ts-expect-error 测试桩：移除 electronAPI（用例内可能已删，幂等）
    delete globalThis.window.electronAPI
  })

  it('playSuccess 调用 electronAPI.playSystemSound', async () => {
    const { playSuccess } = await loadSoundModule()
    await playSuccess()
    expect(mockPlaySystemSound).toHaveBeenCalledTimes(1)
    // W3：playSuccess 转发 kind='success'（main 据此回落平台默认）
    expect(mockPlaySystemSound).toHaveBeenCalledWith(expect.any(String), 'success')
  })

  it('playError 调用 electronAPI.playSystemSound', async () => {
    const { playError } = await loadSoundModule()
    await playError()
    expect(mockPlaySystemSound).toHaveBeenCalledTimes(1)
    // W3：playError 转发 kind='error'
    expect(mockPlaySystemSound).toHaveBeenCalledWith(expect.any(String), 'error')
  })

  it('playByName 传入指定名字时透传给 IPC', async () => {
    const { playByName } = await loadSoundModule()
    await playByName('Hero')
    // playByName 现转发可选 kind（W3）；不传时为 undefined
    expect(mockPlaySystemSound).toHaveBeenCalledWith('Hero', undefined)
  })

  it('playByName 传 kind 时透传给 IPC（W3 跨平台失效兜底用）', async () => {
    const { playByName } = await loadSoundModule()
    await playByName('Hero', 'success')
    expect(mockPlaySystemSound).toHaveBeenCalledWith('Hero', 'success')
  })

  it('electronAPI 不存在时不抛错（安全降级）', async () => {
    // @ts-expect-error 测试桩：移除 electronAPI
    delete globalThis.window.electronAPI
    const { playSuccess } = await loadSoundModule()
    await expect(playSuccess()).resolves.toBeUndefined()
  })

  it('playSystemSound 抛错时不传播（提示音失败不阻塞对话流）', async () => {
    mockPlaySystemSound.mockRejectedValueOnce(new Error('ipc down'))
    const { playSuccess } = await loadSoundModule()
    await expect(playSuccess()).resolves.toBeUndefined()
  })

  it('win 路径：main 返回 audioData 时 new Audio 播放', async () => {
    mockPlaySystemSound.mockResolvedValueOnce({
      audioData: 'dGVzdA==', // 'test' base64
      mimeType: 'audio/wav',
    })
    const { playByName } = await loadSoundModule()
    await playByName('Windows Notify System Generic')
    expect(mockAudioCtor).toHaveBeenCalledTimes(1)
    // 验证 dataURI 构造正确
    expect(mockAudioCtor).toHaveBeenCalledWith('data:audio/wav;base64,dGVzdA==')
    expect(mockAudioPlay).toHaveBeenCalledTimes(1)
  })

  it('win 路径：Audio.play 被 autoplay 拒绝时不抛错', async () => {
    mockPlaySystemSound.mockResolvedValueOnce({ audioData: 'dGVzdA==', mimeType: 'audio/wav' })
    mockAudioPlay.mockRejectedValueOnce(new Error('autoplay blocked'))
    const { playByName } = await loadSoundModule()
    await expect(playByName('Windows Notify System Generic')).resolves.toBeUndefined()
  })

  it('[Q1-3] win 路径连续播放同音复用 Audio（不重复 new Audio）', async () => {
    mockPlaySystemSound.mockResolvedValue({ audioData: 'dGVzdA==', mimeType: 'audio/wav' })
    const { playByName } = await loadSoundModule()
    await playByName('Windows Notify System Generic')
    await playByName('Windows Notify System Generic')
    await playByName('Windows Notify System Generic')
    // Audio 构造只发生一次（Map<name, Audio> 复用），每次播放都触发 play
    expect(mockAudioCtor).toHaveBeenCalledTimes(1)
    expect(mockAudioPlay).toHaveBeenCalledTimes(3)
  })

  it('[Q1-3] 不同音名 / data URI 变化时重建 Audio（缓存键正确）', async () => {
    const { playByName } = await loadSoundModule()
    mockPlaySystemSound.mockResolvedValueOnce({ audioData: 'dGVzdA==', mimeType: 'audio/wav' })
    await playByName('Windows Notify System Generic')
    mockPlaySystemSound.mockResolvedValueOnce({ audioData: 'dGVzdA==', mimeType: 'audio/wav' })
    await playByName('Windows Notify Email')
    mockPlaySystemSound.mockResolvedValueOnce({ audioData: 'eHl6', mimeType: 'audio/wav' })
    await playByName('Windows Notify System Generic')
    // 3 个不同 (name, uri) 组合 → 3 次构造
    expect(mockAudioCtor).toHaveBeenCalledTimes(3)
  })

  it('[Q1-3] 平台探测被 memo：navigator.platform 变化后默认音解析仍用首次探测结果', async () => {
    const ownDesc = Object.getOwnPropertyDescriptor(navigator, 'platform')
    expect(ownDesc?.configurable ?? true).toBe(true)
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    try {
      const { playSuccess } = await loadSoundModule()
      await playSuccess() // 首次探测 darwin → 默认成功音 Glass
      // 探测结果已 memo：navigator 变成 Win32 也不重探测（否则默认音会变 Windows Notify System Generic）
      Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
      await playSuccess()
      expect(mockPlaySystemSound).toHaveBeenNthCalledWith(1, 'Glass', 'success')
      expect(mockPlaySystemSound).toHaveBeenNthCalledWith(2, 'Glass', 'success')
    } finally {
      // 还原 navigator，避免污染其他用例
      if (ownDesc) Object.defineProperty(navigator, 'platform', ownDesc)
      else delete (navigator as { platform?: string }).platform
    }
  })

  it('[Q1-3] 默认音解析按 kind memo：success/error 各解析一次', async () => {
    const ownDesc = Object.getOwnPropertyDescriptor(navigator, 'platform')
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    try {
      const { playSuccess, playError } = await loadSoundModule()
      await playSuccess()
      await playSuccess()
      await playError()
      await playError()
      expect(mockPlaySystemSound).toHaveBeenNthCalledWith(1, 'Glass', 'success')
      expect(mockPlaySystemSound).toHaveBeenNthCalledWith(2, 'Glass', 'success')
      expect(mockPlaySystemSound).toHaveBeenNthCalledWith(3, 'Funk', 'error')
      expect(mockPlaySystemSound).toHaveBeenNthCalledWith(4, 'Funk', 'error')
    } finally {
      if (ownDesc) Object.defineProperty(navigator, 'platform', ownDesc)
      else delete (navigator as { platform?: string }).platform
    }
  })

  it('[Fix-5] readyState 检查：HAVE_METADATA 前不赋值 currentTime，到达后重置为 0', async () => {
    mockPlaySystemSound.mockResolvedValue({ audioData: 'dGVzdA==', mimeType: 'audio/wav' })
    const { playByName } = await loadSoundModule()
    // 首播：mock Audio 无 readyState（undefined < 1，对应 HAVE_NOTHING）→ 检查跳过 currentTime 赋值
    //（HTML 规范：HAVE_NOTHING 时赋值 currentTime 是设置 default playback start position，语义不是回到起点）
    await playByName('Tinker')
    expect(mockAudioCtor).toHaveBeenCalledTimes(1)
    const audio = mockAudioCtor.mock.instances[0] as unknown as {
      currentTime?: number
      readyState?: number
    }
    expect('currentTime' in audio).toBe(false)
    // 元数据到达（readyState >= 1）后重播 → currentTime 重置为 0（从头重播语义保留）
    audio.readyState = 1
    await playByName('Tinker')
    expect(audio.currentTime).toBe(0)
    expect(mockAudioPlay).toHaveBeenCalledTimes(2)
  })
})
