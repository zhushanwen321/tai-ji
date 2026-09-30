/**
 * useChatViewDeps 装配器测试。
 *
 * 覆盖：[RD-1#8] 文件白名单（file.search）加载失败 → console.warn 留痕（降级为空集行为不变）。
 * （onHandoff 忙拦截用例随 D6 死字段收敛删除——onHandoff 字段退役，handoff 后台入口收拢
 * 到 useSidebar/handoff 模式通道，忙拦截语义由其自身入口承载。）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-chat-view-deps.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useChatViewDeps } from '@/composables/panel/useChatViewDeps'

// ── mock：useChat（装配器解构 abortBash/editAndResend/revokeMessage）──
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({ abortBash: vi.fn(), editAndResend: vi.fn(), revokeMessage: vi.fn(() => Promise.resolve()) }),
}))
// [RD-1#8] 文件白名单加载（file.search）可控失败/成功
const loadFileCandidatesMock = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
vi.mock('@/composables/features/search/useFileSearch', () => ({
  useFileSearch: () => ({ load: loadFileCandidatesMock }),
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
