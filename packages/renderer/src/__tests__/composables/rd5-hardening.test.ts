/**
 * RD-5 code-harden 定向回归（P9 收尾批次）。
 *
 * 覆盖四行：
 * - RD-5#1（major）：useHandoffActions.handoffFromLastAssistant —— handoff 失败时
 *   函数内 catch + toastError（⌘J 快捷键调用方 `void handoffFromLastAssistant()` 会丢弃
 *   返回 Promise，函数内不 catch = 裸 reject + 用户零反馈）。形态对齐 useForkActions
 *   forkFromLastAssistant 先例；复用既有 i18n key panel.message.handoffFailed。
 * - RD-5#2（major）：useTerminal.spawnTerminal —— spawn RPC 失败留痕 + rethrow；
 *   TerminalView 渲染 inline 错误条（terminal-spawn-error）+ 重试（terminal-spawn-retry），
 *   复用 FileView error 态范式。
 * - RD-5#3（minor）：useFileSearch.load / useFileTree.loadTree overlay —— 降级路径
 *   补 console.warn 留痕（此前 catch{return[]} / allSettled rejected 分支零日志）。
 * - RD-5#5（minor）：useBrowserZoom —— session 切换的 async watch 加 seq 守卫
 *   （丢弃 stale 响应）+ catch（IPC 失败不裸 reject）。
 *
 * 运行：
 *   cd packages/renderer && npx vitest run src/__tests__/composables/rd5-hardening.test.ts
 *   cd packages/renderer && npx vitest run src/__tests__/terminal/terminal-view-spawn-error.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'

// ── RD-5#1：useHandoffActions handoffFromLastAssistant ────────────

const mocks = vi.hoisted(() => ({
  handoff: vi.fn(),
  getMessages: vi.fn<(sid: string) => Array<Record<string, unknown>>>(),
  getFileCandidates: vi.fn(),
}))

// 单一 @/api mock（本文件三处消费方共用：handoff / fileSearch）
vi.mock('@/api', () => ({
  session: { handoff: mocks.handoff, abortHandoff: vi.fn() },
  composer: { getFileCandidates: mocks.getFileCandidates },
}))
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    getMessages: mocks.getMessages,
    setHandingOff: vi.fn(),
  }),
}))
vi.mock('@/composables/panel/useHandoffModeChannel', () => ({
  triggerEnterHandoffMode: vi.fn(),
}))

import { useHandoffActions } from '@/composables/features/fork-handoff/useHandoffActions'
import { useToast } from '@/composables/useToast'
import { clearToasts } from '../helpers/toast-queue'

const SID = 'sid-handoff-actions'

beforeEach(() => {
  vi.clearAllMocks()
  clearToasts()
  mocks.getMessages.mockReturnValue([
    { id: 'm1', role: 'assistant', timestamp: '2026-09-17T00:00:00Z' },
  ] as unknown as Array<Record<string, unknown>>)
  mocks.handoff.mockResolvedValue(undefined)
})

describe('RD-5#1 useHandoffActions.handoffFromLastAssistant（⌘J 路径错误反馈）', () => {
  it('handoff 成功 → 无 toast', async () => {
    const { handoffFromLastAssistant } = useHandoffActions(ref(SID))
    await handoffFromLastAssistant()
    expect(mocks.handoff).toHaveBeenCalledTimes(1)
    expect(useToast().toasts.value).toHaveLength(0)
  })

  it('handoff RPC reject → 不向上抛（调用方 void 丢弃安全）+ error toast 可见（含失败原因）', async () => {
    mocks.handoff.mockRejectedValue(new Error('rpc down'))
    const { handoffFromLastAssistant } = useHandoffActions(ref(SID))
    await expect(handoffFromLastAssistant()).resolves.toBeUndefined()
    const { toasts } = useToast()
    const errorToast = toasts.value.find((toast) => toast.type === 'error')
    expect(errorToast).toBeDefined()
    expect(errorToast?.message).toContain('交接失败')
    expect(errorToast?.message).toContain('rpc down')
  })
})

// ── RD-5#3：useFileSearch 降级留痕 ────────────────────────────────

import { useFileSearch } from '@/composables/features/search/useFileSearch'

describe('RD-5#3 useFileSearch.load 失败留痕（降级空数组 + warn）', () => {
  it('getFileCandidates reject → 返回 [] 且 console.warn 含 sid', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.getFileCandidates.mockRejectedValue(new Error('session gone'))
    const { load } = useFileSearch()

    await expect(load('sid-fs')).resolves.toEqual([])
    const texts = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(texts).toContain('sid-fs')
    warnSpy.mockRestore()
  })
})

// ── RD-5#5：useBrowserZoom seq 守卫 + catch ───────────────────────

const zoomMocks = vi.hoisted(() => ({
  browserGetZoom: vi.fn(),
  browserSetZoom: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/lib/ipc', () => ({
  browserGetZoom: zoomMocks.browserGetZoom,
  browserSetZoom: zoomMocks.browserSetZoom,
}))

import { useBrowserZoom } from '@/composables/features/browser/useBrowserZoom'

describe('RD-5#5 useBrowserZoom seq 守卫 + catch', () => {
  beforeEach(() => {
    zoomMocks.browserGetZoom.mockReset()
    zoomMocks.browserSetZoom.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('快速切 session：晚到的旧 sid 响应被丢弃（不写陈旧值）', async () => {
    const sid = ref('sess-1')
    // 旧 sid 的读取延迟 resolve，新 sid 立即 resolve
    zoomMocks.browserGetZoom.mockImplementation((target: string) => (
      target === 'sess-1'
        ? new Promise<number>((resolve) => setTimeout(() => resolve(0.3), 20))
        : Promise.resolve(0.6)
    ))
    const { zoomFactor } = useBrowserZoom(sid)

    sid.value = 'sess-2'
    await vi.waitFor(() => expect(zoomFactor.value).toBe(0.6))
    // 等旧 sid 的迟到响应到达：不得覆盖新值
    await new Promise((r) => setTimeout(r, 40))
    expect(zoomFactor.value).toBe(0.6)
  })

  it('browserGetZoom reject → 保持本地值 + console.warn 留痕（不裸 reject）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    zoomMocks.browserGetZoom.mockRejectedValue(new Error('ipc down'))
    const sid = ref('sess-1')
    const { zoomFactor } = useBrowserZoom(sid)

    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled())
    const texts = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(texts).toContain('sess-1')
    // 本地值不被写坏（维持默认 1.0）
    expect(zoomFactor.value).toBe(1.0)
    warnSpy.mockRestore()
  })
})
