// @vitest-environment happy-dom
/**
 * useTtsPlayer 单测（全 mock：core tts 域 + @/i18n + Audio 桩，不发真实请求）。
 *
 * 对应验收条款（任务书 u6 验收 1-5，设计 §7.5 四要点）：
 * 1. 判空判长本地拦截不发 RPC（command mock 零调用断言）
 * 2. 取消后 reply 迟到丢弃：状态回 idle、不播放、无 toast
 * 3. settings-tts-test 伪 id 与对话朗读全局互斥（双向切换）
 * 4. 错误码 → toast key 映射（§5.4 表逐码；key 登记归 u4，此处断言 key 存在性而非文案）
 * 5. playing 态由 Audio.play() resolve 驱动；ended / stop 回 idle
 *
 * timer 策略：fake timers + advanceTimersByTimeAsync 排空微任务链（toast 自动移除 timer 同被
 * fake，用例不依赖其触发）；单例状态经 __resetTtsPlayerForTest 用例间隔离。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MAX_SPEAK_CHARS } from '@taiji/shared'
import { useToast } from '@/composables/useToast'
import {
  useTtsPlayer,
  __resetTtsPlayerForTest,
  SETTINGS_TTS_TEST_MESSAGE_ID,
} from '../useTtsPlayer'

// ── mock：core tts 域（speak 是唯一被消费的 RPC）─────────────────────────────
const ttsMocks = vi.hoisted(() => ({ speak: vi.fn() }))
vi.mock('@taiji/core/transport/api/domains/tts', () => ttsMocks)

// ── mock：@/i18n（t 恒回 key 本身——断言 key 存在性，文案登记归 u4）──────────
const i18nMocks = vi.hoisted(() => ({ t: vi.fn((key: string, _params?: Record<string, unknown>) => key) }))
vi.mock('@/i18n', () => ({ default: { global: { t: i18nMocks.t } } }))

// ── Audio 桩：唯一实例经模块内懒构造，桩以「构造即登记」方式收集实例 ─────────
interface AudioStub {
  src: string
  play: ReturnType<typeof vi.fn<() => Promise<void>>>
  pause: ReturnType<typeof vi.fn<() => void>>
  onended: (() => void) | null
}

const audioState = {
  stubs: [] as AudioStub[],
  /** 每次 play() 调用挂起的 resolve（测试手动放行以驱动 loading → playing） */
  playResolvers: [] as Array<() => void>,
}

function installAudioStub(): void {
  audioState.stubs = []
  audioState.playResolvers = []
  const AudioCtor = vi.fn(function AudioStubCtor() {
    const stub: AudioStub = {
      src: '',
      play: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            audioState.playResolvers.push(resolve)
          }),
      ),
      pause: vi.fn(),
      onended: null,
    }
    audioState.stubs.push(stub)
    return stub
  })
  vi.stubGlobal('Audio', AudioCtor)
}

function lastStub(): AudioStub | undefined {
  return audioState.stubs.at(-1)
}

/** 放行最近一次挂起的 play()（驱动 playing 态） */
function resolvePlay(): void {
  audioState.playResolvers.at(-1)?.()
}

/** 排空微任务链（fake timers 下经 advanceTimersByTimeAsync 驱动） */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

function toastMessages(): string[] {
  return useToast().toasts.value.map((toast) => toast.message)
}

function player(): ReturnType<typeof useTtsPlayer> {
  return useTtsPlayer()
}

/** speak mock 默认成功回 filePath（flush 时即结算） */
function speakResolves(filePath = '/data/tts-cache/ab12.wav'): void {
  ttsMocks.speak.mockResolvedValue({ filePath })
}

// ── deferred reply：手动放行结算时点（构造「reply 迟到」时序用）──────────────
type ReplyResolve = (value: { filePath: string }) => void
type ReplyReject = (e: unknown) => void
let pendingReplies: Array<{ resolve: ReplyResolve; reject: ReplyReject }> = []

function speakDeferred(): void {
  ttsMocks.speak.mockImplementation(
    () =>
      new Promise<{ filePath: string }>((resolve, reject) => {
        pendingReplies.push({ resolve, reject })
      }),
  )
}

/** 放行最早挂起的 reply（成功） */
function settleOldestReply(filePath = '/data/tts-cache/ab12.wav'): void {
  pendingReplies.shift()?.resolve({ filePath })
}

/** 放行最早挂起的 reply（以带 code 的 Error 拒绝，pending.resolveEnvelope 的 reject 同形） */
function rejectOldestReply(code: string, message = 'boom'): void {
  pendingReplies.shift()?.reject(Object.assign(new Error(message), { code }))
}

/** speak mock 以带 code 的 Error 拒绝（flush 时即结算；错误码映射用例用） */
function speakRejectsWithCode(code: string, message = 'boom'): void {
  speakResolves()
  ttsMocks.speak.mockRejectedValueOnce(Object.assign(new Error(message), { code }))
}

beforeEach(() => {
  vi.useFakeTimers()
  ttsMocks.speak.mockReset()
  i18nMocks.t.mockClear()
  pendingReplies = []
  installAudioStub()
  __resetTtsPlayerForTest()
  useToast().toasts.value = []
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useTtsPlayer — 发送前本地拦截（验收 1：不发 RPC）', () => {
  it('清洗后空文本（整条只有代码块）：toast speakEmpty、speak 零调用、状态从未离开 idle', async () => {
    player().speak('s1', 'm1', '```js\nconst a = 1\n```')
    await flush()
    expect(ttsMocks.speak).not.toHaveBeenCalled()
    expect(player().speakStateOf('m1')).toBe('idle')
    expect(toastMessages()).toEqual(['panel.message.speakEmpty'])
  })

  it('超长（> MAX_SPEAK_CHARS）：toast speakTooLong 带清洗后字符数、speak 零调用', async () => {
    player().speak('s1', 'm1', 'a'.repeat(MAX_SPEAK_CHARS + 1))
    await flush()
    expect(ttsMocks.speak).not.toHaveBeenCalled()
    expect(i18nMocks.t).toHaveBeenCalledWith('panel.message.speakTooLong', { count: MAX_SPEAK_CHARS + 1 })
    expect(player().speakStateOf('m1')).toBe('idle')
    expect(toastMessages()).toEqual(['panel.message.speakTooLong'])
  })

  it('空文本拦截发生在全局互斥取消之前：正在播放的朗读不受影响（§5.1「点击无效即终态」）', async () => {
    speakResolves()
    player().speak('s1', 'm1', 'hello')
    await flush()
    resolvePlay()
    await flush()
    expect(player().speakStateOf('m1')).toBe('playing')
    player().speak('s1', 'm2', '```\nfence only\n```')
    await flush()
    expect(toastMessages()).toEqual(['panel.message.speakEmpty'])
    expect(player().speakStateOf('m1')).toBe('playing')
    expect(player().speakStateOf('m2')).toBe('idle')
  })
})

describe('useTtsPlayer — 播放态驱动（验收 5：playing 由 play() resolve 驱动，ended/stop 回 idle）', () => {
  it('loading → play() resolve → playing → onended → idle；Audio src 为 local-file 拼法', async () => {
    speakResolves('/data/tts-cache/x.wav')
    player().speak('s1', 'm1', '你好世界')
    await flush()
    expect(ttsMocks.speak).toHaveBeenCalledWith({ sessionId: 's1', text: '你好世界' })
    expect(player().speakStateOf('m1')).toBe('loading')
    resolvePlay()
    await flush()
    expect(player().speakStateOf('m1')).toBe('playing')
    expect(lastStub()?.src).toBe(`local-file:///${encodeURIComponent('/data/tts-cache/x.wav')}`)
    lastStub()?.onended?.()
    await flush()
    expect(player().speakStateOf('m1')).toBe('idle')
  })

  it('playing 中 stop()：pause 被调、立即回 idle', async () => {
    speakResolves()
    player().speak('s1', 'm1', 'hello')
    await flush()
    resolvePlay()
    await flush()
    expect(player().speakStateOf('m1')).toBe('playing')
    player().stop()
    expect(lastStub()?.pause).toHaveBeenCalledTimes(1)
    expect(player().speakStateOf('m1')).toBe('idle')
  })

  it('发出的是清洗后文本（围栏代码块已剥除，D7 客户端先行清洗）', async () => {
    speakResolves()
    player().speak('s1', 'm1', '结论如下：\n\n```js\nconst x = 1\n```\n\n完成')
    await flush()
    expect(ttsMocks.speak).toHaveBeenCalledWith({ sessionId: 's1', text: '结论如下： 完成' })
  })

  it('非当前任务的 messageId 查询恒 idle（互斥语义的查询面）', async () => {
    speakResolves()
    player().speak('s1', 'm1', 'hello')
    await flush()
    expect(player().speakStateOf('m-not-mine')).toBe('idle')
  })
})

describe('useTtsPlayer — 取消：reply 迟到丢弃（验收 2：回 idle、不播放、无 toast）', () => {
  it('stop() 后 reply 才到达：不触发播放、无 toast、保持 idle', async () => {
    speakDeferred()
    player().speak('s1', 'm1', 'hello')
    await flush()
    expect(player().speakStateOf('m1')).toBe('loading')
    player().stop()
    settleOldestReply()
    await flush()
    // Audio 从未被构造、play() 从未被调用（reply 丢弃发生在播放之前）
    expect(audioState.stubs).toHaveLength(0)
    expect(audioState.playResolvers).toHaveLength(0)
    expect(player().speakStateOf('m1')).toBe('idle')
    expect(toastMessages()).toEqual([])
  })

  it('点了别条朗读（顶替）：旧任务 reply 迟到被丢弃，新任务不受扰', async () => {
    speakDeferred()
    player().speak('s1', 'm1', 'first')
    await flush()
    player().speak('s1', 'm2', 'second')
    await flush()
    expect(ttsMocks.speak).toHaveBeenCalledTimes(2)
    expect(player().speakStateOf('m1')).toBe('idle')
    expect(player().speakStateOf('m2')).toBe('loading')
    // m1 的 reply 迟到到达：直接丢弃——不构造 Audio、不 play
    settleOldestReply()
    await flush()
    expect(audioState.stubs).toHaveLength(0)
    expect(toastMessages()).toEqual([])
    // m2 的 reply 正常到达：进入 play 等待（loading）
    settleOldestReply()
    await flush()
    expect(audioState.playResolvers).toHaveLength(1)
    expect(player().speakStateOf('m2')).toBe('loading')
  })

  it('取消后失败的 reply 迟到：静默丢弃（无 toast），不覆盖 idle', async () => {
    speakDeferred()
    player().speak('s1', 'm1', 'hello')
    await flush()
    player().stop()
    rejectOldestReply('tts_network_error', 'late failure')
    await flush()
    expect(toastMessages()).toEqual([])
    expect(player().speakStateOf('m1')).toBe('idle')
  })
})

describe('useTtsPlayer — settings-tts-test 互斥（验收 3：测试播放与对话朗读双向顶替）', () => {
  it('测试播放中触发对话朗读：测试停（无提示）、对话进 loading', async () => {
    speakResolves()
    player().speak(undefined, SETTINGS_TTS_TEST_MESSAGE_ID, '你好，我是太极语音助手。')
    await flush()
    expect(player().speakStateOf(SETTINGS_TTS_TEST_MESSAGE_ID)).toBe('loading')
    player().speak('s1', 'm1', 'hello')
    await flush()
    expect(player().speakStateOf(SETTINGS_TTS_TEST_MESSAGE_ID)).toBe('idle')
    expect(player().speakStateOf('m1')).toBe('loading')
    expect(toastMessages()).toEqual([])
  })

  it('对话朗读中触发测试播放：对话停（无提示）、测试进 loading', async () => {
    speakResolves()
    player().speak('s1', 'm1', 'hello')
    await flush()
    player().speak(undefined, SETTINGS_TTS_TEST_MESSAGE_ID, '样句')
    await flush()
    expect(player().speakStateOf('m1')).toBe('idle')
    expect(player().speakStateOf(SETTINGS_TTS_TEST_MESSAGE_ID)).toBe('loading')
    expect(toastMessages()).toEqual([])
  })
})

describe('useTtsPlayer — 错误码 → toast key（验收 4：§5.4 逐码映射，key 断言）', () => {
  it.each([
    ['tts_not_configured', ['panel.message.speakNotConfigured']],
    ['tts_auth_failed', ['panel.message.speakAuthFailed']],
    // 额度耗尽的「不要重试」指引文案随该 key 由 u4 locale 登记（§5.4），此处锁 key 命中
    ['tts_quota_exceeded', ['panel.message.speakQuotaExceeded']],
    ['tts_network_error', ['panel.message.speakNetworkError']],
    ['tts_empty_text', ['panel.message.speakEmpty']],
  ])('%s → 对应 speak* key，任务回 idle', async (code, expected) => {
    speakRejectsWithCode(code)
    player().speak('s1', 'm1', 'hello')
    await flush()
    expect(toastMessages()).toEqual(expected)
    expect(player().speakStateOf('m1')).toBe('idle')
  })

  it('tts_vendor_error → speakVendorError，detail = 厂商错误摘要', async () => {
    speakRejectsWithCode('tts_vendor_error', 'voice not supported')
    player().speak('s1', 'm1', 'hello')
    await flush()
    expect(i18nMocks.t).toHaveBeenCalledWith('panel.message.speakVendorError', { detail: 'voice not supported' })
    expect(toastMessages()).toEqual(['panel.message.speakVendorError'])
    expect(player().speakStateOf('m1')).toBe('idle')
  })

  it('tts_vendor_error 摘要截断到 200 字符（§5.4 截断上限）', async () => {
    speakRejectsWithCode('tts_vendor_error', 'x'.repeat(300))
    player().speak('s1', 'm1', 'hello')
    await flush()
    expect(i18nMocks.t).toHaveBeenCalledWith('panel.message.speakVendorError', { detail: 'x'.repeat(200) })
  })

  it('tts_text_too_long（runtime 防御路径）→ speakTooLong，count = 清洗后长度', async () => {
    speakRejectsWithCode('tts_text_too_long')
    player().speak('s1', 'm1', 'hello')
    await flush()
    expect(i18nMocks.t).toHaveBeenCalledWith('panel.message.speakTooLong', { count: 5 })
    expect(toastMessages()).toEqual(['panel.message.speakTooLong'])
  })

  it('未知错误码（传输层 timeout 等）→ speakFailed 兜底（D8 catch-all）', async () => {
    speakRejectsWithCode('timeout')
    player().speak('s1', 'm1', 'hello')
    await flush()
    expect(toastMessages()).toEqual(['panel.message.speakFailed'])
    expect(player().speakStateOf('m1')).toBe('idle')
  })

  it('非 Error 形态的 reject → speakFailed 兜底', async () => {
    speakResolves()
    ttsMocks.speak.mockRejectedValueOnce('plain string failure')
    player().speak('s1', 'm1', 'hello')
    await flush()
    expect(toastMessages()).toEqual(['panel.message.speakFailed'])
    expect(player().speakStateOf('m1')).toBe('idle')
  })
})
