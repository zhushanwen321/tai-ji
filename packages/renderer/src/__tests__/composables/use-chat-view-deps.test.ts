/**
 * useChatViewDeps.onHandoff 忙拦截测试（review round 1 must-fix）。
 *
 * 覆盖：streaming 中点 handoff → 提前拦下（toast handoffBusy 短路，不发 RPC）；
 * 非活跃 → 正常走 handoff RPC；RPC 失败 → toast handoffFailed；
 * [RD-1#8] 文件白名单（file.search）加载失败 → console.warn 留痕（降级为空集行为不变）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-chat-view-deps.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { Message } from '@taiji/shared'
import { useChatStore } from '@/stores/chat'
import { useChatViewDeps } from '@/composables/panel/useChatViewDeps'
import { useTtsSpeechEnabled } from '@/components/settings/tts/use-tts-enabled'

// ── mock：sidebar.handoff（RPC spy）/ toast（错误 toast spy）/ useChat ──
// （u5.2 生产切换 useChatViewDeps → useSidebar，mock 同步改指——原 legacy mock 已被架空）
const handoffMock = vi.fn(() => Promise.resolve())
const toastErrorMock = vi.fn()
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ handoff: handoffMock, forkSession: vi.fn(() => Promise.resolve()) }),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastErrorMock, info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({ abortBash: vi.fn(), editAndResend: vi.fn() }),
}))
// [RD-1#8] 文件白名单加载（file.search）可控失败/成功
const loadFileCandidatesMock = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
vi.mock('@/composables/features/search/useFileSearch', () => ({
  useFileSearch: () => ({ load: loadFileCandidatesMock }),
}))

// ── ai-voice-tts §5.1（u5 装配）：useTtsPlayer 三方法 spy，锁定 onSpeak 动作分流 ──
const ttsSpeakMock = vi.hoisted(() => vi.fn())
const ttsStopMock = vi.hoisted(() => vi.fn())
const ttsStateMock = vi.hoisted(() => vi.fn(() => 'idle' as const))
vi.mock('@/composables/features/chat/useTtsPlayer', () => ({
  useTtsPlayer: () => ({ speak: ttsSpeakMock, stop: ttsStopMock, speakStateOf: ttsStateMock }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/** useChatViewDeps 内含 watch（immediate，订阅 sessionId）——scope 内装配，用例末 stop 防泄漏 */
function setupDeps(sid: string): { deps: ReturnType<typeof useChatViewDeps>; stop: () => void } {
  const scope = effectScope()
  let deps!: ReturnType<typeof useChatViewDeps>
  scope.run(() => { deps = useChatViewDeps(ref(sid)) })
  return { deps, stop: () => scope.stop() }
}

/** 制造 streaming：真实 chat store 写 message_start → isActive=true */
function makeStreaming(sid: string): void {
  useChatStore().applyMessageEvent(sid, {
    type: 'message.message_start',
    payload: { sessionId: sid, messageId: 'a1' },
  })
}

describe('onHandoff streaming 忙拦截', () => {
  it('session 活跃 → toast handoffBusy 且 handoff RPC 不发出', () => {
    const sid = 's-handoff-busy'
    makeStreaming(sid)
    expect(useChatStore().isActive(sid)).toBe(true)

    const { deps, stop } = setupDeps(sid)
    deps.onHandoff(sid)

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    // i18n mock 从 zh-CN 取文案（panel.composer.handoffBusy）
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('请等待当前回复完成')
    expect(handoffMock).not.toHaveBeenCalled()
    stop()
  })

  it('session 非活跃 → 正常发 handoff RPC，无忙拦截 toast', async () => {
    const sid = 's-handoff-idle'
    const { deps, stop } = setupDeps(sid)
    deps.onHandoff(sid)
    await vi.waitFor(() => expect(handoffMock).toHaveBeenCalledWith(sid))
    expect(toastErrorMock).not.toHaveBeenCalled()
    stop()
  })

  it('handoff RPC 失败 → toast handoffFailed（含错误信息）', async () => {
    handoffMock.mockRejectedValueOnce(new Error('rpc down'))
    const sid = 's-handoff-fail'
    const { deps, stop } = setupDeps(sid)
    deps.onHandoff(sid)
    await vi.waitFor(() => expect(toastErrorMock).toHaveBeenCalled())
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('rpc down')
    stop()
  })
})

describe('[RD-1#8] 文件白名单加载失败留痕（降级可见，非静默吞噬）', () => {
  it('file.search 失败 → console.warn 留痕 + 不抛错（白名单降级为空集的行为不变）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadFileCandidatesMock.mockRejectedValueOnce(new Error('file.search down'))
    const sid = 's-file-whitelist-fail'

    const { stop } = setupDeps(sid)
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled())

    const first = String(warnSpy.mock.calls[0]?.[0])
    expect(first).toContain('[useChatViewDeps] file whitelist load failed for session')
    expect(first).toContain(sid)
    // 留痕携带原始错误（排障可定位）
    expect(warnSpy.mock.calls[0]?.[1]).toBeInstanceOf(Error)

    stop()
    warnSpy.mockRestore()
  })

  it('file.search 成功 → 零 warn（不污染正常流的观测信号）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadFileCandidatesMock.mockResolvedValueOnce([])

    const { stop } = setupDeps('s-file-whitelist-ok')
    await vi.waitFor(() => expect(loadFileCandidatesMock).toHaveBeenCalled())

    expect(warnSpy).not.toHaveBeenCalled()
    stop()
    warnSpy.mockRestore()
  })
})

// ── ai-voice-tts §5.1（u5 装配）：onSpeak 动作分流 + speakStateOf 直通 ──────────
describe('onSpeak 朗读装配（ai-voice-tts §5.1）', () => {
  const { setEnabled } = useTtsSpeechEnabled()

  /** assistant 消息 fixture（assistant content 为纯 string，ADR-0043） */
  function makeAssistant(id: string, content: string): Message {
    return { id, role: 'assistant', content, status: 'complete', timestamp: 0 }
  }

  it('idle 态点击 → speak(sid, messageId, 消息正文)，清洗由 useTtsPlayer 内部承担', () => {
    const { deps, stop } = setupDeps('s-tts')
    const msg = makeAssistant('a1', '需要朗读的正文')
    ttsStateMock.mockReturnValue('idle')

    deps.onSpeak!('s-tts', msg)

    expect(ttsSpeakMock).toHaveBeenCalledTimes(1)
    expect(ttsSpeakMock).toHaveBeenCalledWith('s-tts', 'a1', '需要朗读的正文')
    expect(ttsStopMock).not.toHaveBeenCalled()
    stop()
  })

  it('loading/playing 态点击 = 取消/停止 → 调 useTtsPlayer.stop，不重入 speak', () => {
    const { deps, stop } = setupDeps('s-tts-stop')
    const msg = makeAssistant('a2', '正在朗读中')
    ttsStateMock.mockReturnValue('playing')

    deps.onSpeak!('s-tts-stop', msg)

    expect(ttsStopMock).toHaveBeenCalledTimes(1)
    expect(ttsSpeakMock).not.toHaveBeenCalled()
    stop()
  })

  it('speakStateOf 查询直通 useTtsPlayer（按 messageId 投影三态）', () => {
    const { deps, stop } = setupDeps('s-tts-state')
    ttsStateMock.mockReturnValue('loading')

    expect(deps.speakStateOf!('a1')).toBe('loading')
    expect(ttsStateMock).toHaveBeenCalledWith('a1')
    stop()
  })

  // ── 朗读总开关（ai-voice-tts §5.2 通用配置：关闭后朗读按钮报「语音服务未配置」）──
  // use-tts-enabled 真模块不 mock（装配器与设置页消费同一模块级单例，测真实接线），
  // 经唯一写点 setEnabled 驱动；用例末恢复默认开启，不留状态给后续用例。
  it('总开关关闭：idle 态点击不发合成请求（speak 未被调 = 不发 RPC），toast「语音服务未配置」', () => {
    setEnabled(false)
    const { deps, stop } = setupDeps('s-tts-disabled')
    const msg = makeAssistant('a3', '开关关闭时的正文')
    ttsStateMock.mockReturnValue('idle')

    deps.onSpeak!('s-tts-disabled', msg)

    expect(ttsSpeakMock).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('语音服务未配置')
    setEnabled(true)
    stop()
  })

  it('关闭态下非 idle（playing）点朗读 = 停止，不受开关拦截（stop 照常被调）', () => {
    setEnabled(false)
    const { deps, stop } = setupDeps('s-tts-disabled-stop')
    const msg = makeAssistant('a4', '关闭开关也应能停止在播内容')
    ttsStateMock.mockReturnValue('playing')

    deps.onSpeak!('s-tts-disabled-stop', msg)

    expect(ttsStopMock).toHaveBeenCalledTimes(1)
    expect(ttsSpeakMock).not.toHaveBeenCalled()
    setEnabled(true)
    stop()
  })
})
