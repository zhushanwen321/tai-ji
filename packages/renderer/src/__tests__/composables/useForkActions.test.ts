/**
 * useForkActions forkFromLastAssistant 错误反馈测试（⌘G 快捷键路径）。
 *
 * 背景：forkFromLastAssistant 是 useGlobalShortcuts ⌘G 的 action（调用方 void 丢弃
 * 返回 Promise），fork RPC 失败时若函数内不 catch → unhandled rejection 且用户零反馈。
 * 契约：fork RPC reject → 函数本身不 reject（快捷键路径安全）+ 用户可见 error toast
 * （panel.message.forkFailed 文案，含失败原因）。
 *
 * mock 策略：'@/api' / stores / useChat 全量替身（forkFromLastAssistant 路径只触
 * getMessages + sessionApi.fork + appendSession）；useToast 用真实模块级单例（断言
 * toasts 队列）；vue-i18n 走全局 setup（真实 zh-CN 文案 + {error} 插值）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useForkActions.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import type { Message } from '@taiji/shared'

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  appendSession: vi.fn(),
  getMessages: vi.fn<(sid: string) => Message[]>(),
}))

vi.mock('@/api', () => ({
  chat: { send: vi.fn() },
  session: { fork: mocks.fork, remove: vi.fn() },
}))
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({ getMessages: mocks.getMessages }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ appendSession: mocks.appendSession }),
}))
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({ disposeSession: vi.fn() }),
  ensureStreamSubscription: vi.fn(),
}))
vi.mock('@/composables/panel/useForkModeChannel', () => ({
  triggerEnterForkMode: vi.fn(),
}))
vi.mock('@/composables/effects/useForkNoticeEffect', () => ({
  pushForkNoticeAsk: vi.fn(),
}))

import { useForkActions } from '@/composables/features/fork-handoff/useForkActions'
import { useToast } from '@/composables/useToast'

const SID = 'sid-fork-actions'

/** 清空 toast 模块级队列（测试无 timer 消费，需显式清） */
function clearToasts(): void {
  const { toasts, remove } = useToast()
  for (const toast of [...toasts.value]) remove(toast.id)
}

beforeEach(() => {
  vi.clearAllMocks()
  clearToasts()
  mocks.getMessages.mockReturnValue([
    { id: 'm1', role: 'assistant', timestamp: '2026-09-17T00:00:00Z', piEntryId: 'e1' },
  ] as unknown as Message[])
  mocks.fork.mockResolvedValue({ id: 'sid-new' })
})

describe('useForkActions forkFromLastAssistant（⌘G 路径错误反馈）', () => {
  it('fork 成功 → 新 session 入列表，无 toast', async () => {
    const { forkFromLastAssistant } = useForkActions(ref(SID))
    await forkFromLastAssistant()
    expect(mocks.fork).toHaveBeenCalledTimes(1)
    expect(mocks.appendSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'sid-new' }))
    expect(useToast().toasts.value).toHaveLength(0)
  })

  it('fork RPC reject → 不向上抛（调用方 void 丢弃安全）+ error toast 可见（含失败原因）', async () => {
    mocks.fork.mockRejectedValue(new Error('rpc down'))
    const { forkFromLastAssistant } = useForkActions(ref(SID))
    await expect(forkFromLastAssistant()).resolves.toBeUndefined()
    const { toasts } = useToast()
    const errorToast = toasts.value.find((toast) => toast.type === 'error')
    expect(errorToast).toBeDefined()
    expect(errorToast?.message).toContain('fork 后台失败')
    expect(errorToast?.message).toContain('rpc down')
  })
})
