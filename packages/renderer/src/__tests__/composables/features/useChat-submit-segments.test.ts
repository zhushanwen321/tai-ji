/**
 * useChat submitSegments 统一编排器单测（阶段 3a：renderer composables 层重构）。
 *
 * 覆盖核心交付：submitSegments 是 send / editAndResend 共享的「文本化 + 发送」编排器。
 *
 * 关键测试用例：
 * - SS1: send(含 image) → chatApi.send 不含 images（路径模式，路径在 promptText 里）
 * - SS2: editAndResend(含 image) → 委托 submitSegments → 路径进 promptText（不丢）
 * - SS3: editAndResend(text-only) → chatApi.send 第二参数 promptText（行为与 send 对齐）
 * - SS4: send(text-only) → 无 clientUuid 标记 + 不写 sidecar（最小写入：纯文本降级渲染等价）
 *
 * 图片走路径模式（对齐 pi TUI）：image segment 的裸路径由 segmentsToText 产出进 promptText，
 * LLM 自己调 read 工具读。不再走 base64 message.send.images 通道。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/features/useChat-submit-segments.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage } from '@taiji/shared'

// ── api mock（chatApi.send/steer/streamSubscribe 等）──
const apiMock = vi.hoisted(() => {
  const holder: { handler: ((msg: ServerMessage) => void) | null } = { handler: null }
  return {
    holder,
    streamSubscribe: vi.fn((_sid: string, handler: (msg: ServerMessage) => void) => {
      holder.handler = handler
      return () => {
        holder.handler = null
      }
    }),
    send: vi.fn(() => Promise.resolve()),
    getHistory: vi.fn(() => Promise.resolve([])),
    abort: vi.fn(() => Promise.resolve()),
    compact: vi.fn(() => Promise.resolve()),
    steer: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: {
    streamSubscribe: apiMock.streamSubscribe,
    send: apiMock.send,
    getHistory: apiMock.getHistory,
    abort: apiMock.abort,
    compact: apiMock.compact,
    steer: apiMock.steer,
    followUp: apiMock.followUp,
  },
  session: {
    writeSegments: sessionDomainMock.writeSegments,
  },
}))

// ── session domain mock：writeSegments 捕获 sidecar 写入（clientUuid + segments 回填用）──
const sessionDomainMock = vi.hoisted(() => ({
  writeSegments: vi.fn(() => Promise.resolve()),
}))

import { useChatStore } from '@/stores/chat'
import { useChat, resetChatModuleState } from '@/composables/features/chat/useChat'

beforeEach(() => {
  setActivePinia(createPinia())
  resetChatModuleState()
  vi.clearAllMocks()
  apiMock.holder.handler = null
  sessionDomainMock.writeSegments.mockResolvedValue(undefined)
})

// ── SS1: send(含 image) → submitSegments → chatApi.send 路径模式 ──

describe('submitSegments 统一通路：send', () => {
  it('SS1: send(含 image) → chatApi.send(sessionId, promptText, options)，promptText 含裸路径 + clientUuid 标记', async () => {
    const { send } = useChat()
    await send('ss-send', [
      { type: 'text', text: 'look' },
      { type: 'image', id: 'img-x', path: '/tmp/x.png', fileName: 'x-uuid.png', displayName: 'x.png' },
    ])

    expect(apiMock.send).toHaveBeenCalledTimes(1)
    const call = apiMock.send.mock.calls[0]!
    expect(call[0]).toBe('ss-send')
    // promptText 含裸路径（图片走路径模式，对齐 pi TUI）
    expect(call[1]).toContain('/tmp/x.png')
    // 不含匿名占位 [图片 N]（已弃用）
    expect(call[1]).not.toContain('[图片')
    // promptText 末尾含 clientUuid 标记（pi extension input hook 剥离 + 写 custom entry）
    // 标记格式严格：<!--taiji:msg:u-<uuid>-->，clientUuid 是 appendUser 生成的 message id
    expect(call[1]).toMatch(/\n<!--taiji:msg:u-[0-9a-fA-F-]{36}-->$/)
    // images 位保持不传（路径模式，路径在 promptText 里）；第 4 参为 options.clientUuid
    // （session-occupancy D2：经 ChatApiPort 适配 → 域函数 4 参形态，与标记同源）
    expect(call[2]).toBeUndefined()
    expect(call[3]).toEqual({ clientUuid: expect.stringMatching(/^u-[0-9a-fA-F-]{36}$/) })
    // options.clientUuid 与 prompt 标记里的 uuid 一致（同一 user message 的双通路标识）
    const ss1MarkerUuid = (call[1] as string).match(/<!--taiji:msg:(u-[0-9a-fA-F-]{36})-->/)![1]
    expect((call[3] as { clientUuid?: string }).clientUuid).toBe(ss1MarkerUuid)

    // writeSegmentsMetadata 被调（写 segments.json sidecar，clientUuid 关联回填用）
    expect(sessionDomainMock.writeSegments).toHaveBeenCalledTimes(1)
    const sidecarCall = sessionDomainMock.writeSegments.mock.calls[0]![0]
    expect(sidecarCall.sessionId).toBe('ss-send')
    expect(sidecarCall.entry.clientUuid).toMatch(/^u-[0-9a-fA-F-]{36}$/)
    // sidecar 的 clientUuid 必须与 prompt 标记里的 uuid 一致（同一 user message 的映射键）
    const markerUuid = (call[1] as string).match(/<!--taiji:msg:(u-[0-9a-fA-F-]{36})-->/)![1]
    expect(sidecarCall.entry.clientUuid).toBe(markerUuid)
    expect(sidecarCall.entry.segments).toHaveLength(2)
    expect(sidecarCall.entry.timestamp).toBeTypeOf('number')
  })

  it('SS4: send(text-only) → promptText 无 clientUuid 标记 + 不写 sidecar（最小写入）', async () => {
    const { send } = useChat()
    await send('ss-send-text', [{ type: 'text', text: '纯文本消息' }])

    expect(apiMock.send).toHaveBeenCalledTimes(1)
    const call = apiMock.send.mock.calls[0]!
    expect(call[0]).toBe('ss-send-text')
    // 纯文本轮不加标记（textToSegments 降级与结构化回填渲染等价，无需映射）
    expect(call[1]).toBe('纯文本消息')
    expect(call[1]).not.toMatch(/<!--taiji:msg:/)
    // 纯文本轮不写 sidecar（不变式：sidecar 条目存在 ⟺ 映射 custom entry 存在）
    expect(sessionDomainMock.writeSegments).not.toHaveBeenCalled()
  })
})

// ── SS2/SS3: editAndResend 委托 submitSegments ──

describe('submitSegments 统一通路：editAndResend', () => {
  it('SS2: editAndResend(含 image) → 委托 submitSegments → chatApi.send 路径进 promptText（不丢）', async () => {
    const chat = useChatStore()
    // 先注入原 user message（供 truncateFrom 操作）
    chat.appendUser('ss-edit', [{ type: 'text', text: '原问题' }])
    const userMsg = chat.getMessages('ss-edit').find((m) => m.role === 'user')!

    const { editAndResend } = useChat()
    // 阶段 3a：editAndResend 接收 segments（不再是 text 字符串），保留 image segments
    await editAndResend('ss-edit', userMsg.id, [
      { type: 'text', text: 'edited text' },
      { type: 'image', id: 'img-edit', path: '/tmp/edit.png', fileName: 'edit-uuid.png', displayName: 'edit.png' },
    ])

    expect(apiMock.send).toHaveBeenCalledTimes(1)
    const call = apiMock.send.mock.calls[0]!
    expect(call[0]).toBe('ss-edit')
    // promptText 含编辑后文本 + 裸路径
    expect(call[1]).toContain('edited text')
    expect(call[1]).toContain('/tmp/edit.png')
    // images 位不传（路径模式）；第 4 参为 options.clientUuid（D2 透传）
    expect(call[2]).toBeUndefined()
    expect(call[3]).toEqual({ clientUuid: expect.stringMatching(/^u-[0-9a-fA-F-]{36}$/) })
  })

  it('SS3: editAndResend(text-only) → chatApi.send 第二参数 promptText（与 send 对齐）', async () => {
    const chat = useChatStore()
    chat.appendUser('ss-edit-text', [{ type: 'text', text: '原问题' }])
    const userMsg = chat.getMessages('ss-edit-text').find((m) => m.role === 'user')!

    const { editAndResend } = useChat()
    await editAndResend('ss-edit-text', userMsg.id, [{ type: 'text', text: 'edited' }])

    expect(apiMock.send).toHaveBeenCalledTimes(1)
    const call = apiMock.send.mock.calls[0]!
    expect(call[0]).toBe('ss-edit-text')
    // promptText 含编辑后文本；纯文本轮不加 clientUuid 标记后缀（最小写入，与 send 同通路）
    expect(call[1]).toContain('edited')
    expect(call[1]).not.toMatch(/<!--taiji:msg:/)
    // 纯文本轮不写 sidecar（不变式：sidecar 条目存在 ⟺ 映射 custom entry 存在）
    expect(sessionDomainMock.writeSegments).not.toHaveBeenCalled()
    // 无图 → images 位不传；第 4 参为 options.clientUuid（D2 透传，与 send 同通路）
    expect(call[2]).toBeUndefined()
    expect(call[3]).toEqual({ clientUuid: expect.stringMatching(/^u-[0-9a-fA-F-]{36}$/) })
  })
})

// 引用 useChatStore 避免 ts unused
void useChatStore
