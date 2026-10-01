// @vitest-environment happy-dom
/**
 * useTtsSpeechEnabled 降级路径单测（ai-voice-tts 设计 §5.2 通用开关）。
 *
 * 覆盖 localStorage 不可用两分支（模块级单例在装载期读、setEnabled 写）：
 * - 读失败（隐私模式等）→ 默认开启（true）
 * - 写失败 → 仅内存生效 + console.warn 降级，不阻断开关交互
 *
 * 模块级单例在首条 import 时求值，读失败用例经 vi.resetModules + 动态 import 驱动。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useTtsSpeechEnabled localStorage 降级', () => {
  it('读失败（localStorage.getItem 抛错）→ 模块装载期降级为默认开启', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    const { useTtsSpeechEnabled } = await import('@/components/settings/tts/use-tts-enabled')
    const { enabled } = useTtsSpeechEnabled()
    expect(enabled.value).toBe(true)
  })

  it('写失败（setItem 抛错）→ console.warn 降级，内存态仍切换不阻断', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    const { useTtsSpeechEnabled } = await import('@/components/settings/tts/use-tts-enabled')
    const { enabled, setEnabled } = useTtsSpeechEnabled()
    setEnabled(false)
    expect(enabled.value).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith('[tts] persist speech-enabled failed', expect.any(Error))
  })
})
