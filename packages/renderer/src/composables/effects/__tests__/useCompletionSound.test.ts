import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// 注意：本文件禁止顶层静态 import 被测模块 —— lib/ipc 在模块加载时捕获
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
})

// helpers：动态 import 拿最新模块状态
async function loadModule() {
  const mod = await import('../useCompletionSound')
  return { playSuccess: mod.playSuccess, playError: mod.playError, playByName: mod.playByName }
}

describe('useCompletionSound', () => {
  it('playSuccess 调用 electronAPI.playSystemSound', async () => {
    const { playSuccess } = await loadModule()
    await playSuccess()
    expect(mockPlaySystemSound).toHaveBeenCalledTimes(1)
    // W3：playSuccess 转发 kind='success'（main 据此回落平台默认）
    expect(mockPlaySystemSound).toHaveBeenCalledWith(expect.any(String), 'success')
  })

  it('playError 调用 electronAPI.playSystemSound', async () => {
    const { playError } = await loadModule()
    await playError()
    expect(mockPlaySystemSound).toHaveBeenCalledTimes(1)
    // W3：playError 转发 kind='error'
    expect(mockPlaySystemSound).toHaveBeenCalledWith(expect.any(String), 'error')
  })

  it('playByName 传入指定名字时透传给 IPC', async () => {
    const { playByName } = await loadModule()
    await playByName('Hero')
    // playByName 现转发可选 kind（W3）；不传时为 undefined
    expect(mockPlaySystemSound).toHaveBeenCalledWith('Hero', undefined)
  })

  it('playByName 传 kind 时透传给 IPC（W3 跨平台失效兜底用）', async () => {
    const { playByName } = await loadModule()
    await playByName('Hero', 'success')
    expect(mockPlaySystemSound).toHaveBeenCalledWith('Hero', 'success')
  })

  it('electronAPI 不存在时不抛错（安全降级）', async () => {
    // @ts-expect-error 测试桩：移除 electronAPI
    delete globalThis.window.electronAPI
    const { playSuccess } = await loadModule()
    await expect(playSuccess()).resolves.toBeUndefined()
  })

  it('playSystemSound 抛错时不传播（提示音失败不阻塞对话流）', async () => {
    mockPlaySystemSound.mockRejectedValueOnce(new Error('ipc down'))
    const { playSuccess } = await loadModule()
    await expect(playSuccess()).resolves.toBeUndefined()
  })

  it('win 路径：main 返回 audioData 时 new Audio 播放', async () => {
    mockPlaySystemSound.mockResolvedValueOnce({
      audioData: 'dGVzdA==', // 'test' base64
      mimeType: 'audio/wav',
    })
    const { playByName } = await loadModule()
    await playByName('Windows Notify System Generic')
    expect(mockAudioCtor).toHaveBeenCalledTimes(1)
    // 验证 dataURI 构造正确
    expect(mockAudioCtor).toHaveBeenCalledWith('data:audio/wav;base64,dGVzdA==')
    expect(mockAudioPlay).toHaveBeenCalledTimes(1)
  })

  it('win 路径：Audio.play 被 autoplay 拒绝时不抛错', async () => {
    mockPlaySystemSound.mockResolvedValueOnce({ audioData: 'dGVzdA==', mimeType: 'audio/wav' })
    mockAudioPlay.mockRejectedValueOnce(new Error('autoplay blocked'))
    const { playByName } = await loadModule()
    await expect(playByName('Windows Notify System Generic')).resolves.toBeUndefined()
  })

  it('[Q1-3] win 路径连续播放同音复用 Audio（不重复 new Audio）', async () => {
    mockPlaySystemSound.mockResolvedValue({ audioData: 'dGVzdA==', mimeType: 'audio/wav' })
    const { playByName } = await loadModule()
    await playByName('Windows Notify System Generic')
    await playByName('Windows Notify System Generic')
    await playByName('Windows Notify System Generic')
    // Audio 构造只发生一次（Map<name, Audio> 复用），每次播放都触发 play
    expect(mockAudioCtor).toHaveBeenCalledTimes(1)
    expect(mockAudioPlay).toHaveBeenCalledTimes(3)
  })

  it('[Q1-3] 不同音名 / data URI 变化时重建 Audio（缓存键正确）', async () => {
    const { playByName } = await loadModule()
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
      const { playSuccess } = await loadModule()
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
      const { playSuccess, playError } = await loadModule()
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

  it('[Fix-5] readyState 守卫：HAVE_METADATA 前不赋值 currentTime，到达后重置为 0', async () => {
    mockPlaySystemSound.mockResolvedValue({ audioData: 'dGVzdA==', mimeType: 'audio/wav' })
    const { playByName } = await loadModule()
    // 首播：mock Audio 无 readyState（undefined < 1，对应 HAVE_NOTHING）→ 守卫跳过 currentTime 赋值
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
