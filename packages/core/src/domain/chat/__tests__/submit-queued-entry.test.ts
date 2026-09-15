/**
 * submitQueuedEntry 单测（session-occupancy u4b / D5.1——flush 逐条提交的 send/steer
 * 等价编排）。
 *
 * 覆盖契约（设计 D5.1 两通道最小编排 + defer segments 化 / D-A1-2/D-A1-3）：
 * - channel='send'（队首，启动新 run）：挂 inflight 占位（防确认帧被 message_end 处理序
 *   ② 误拦漏配 ① 分区匹配）→ ensureStreamSubscription（订阅保障）→ chatApi.send 携
 *   clientUuid = 条目 id（D2 消歧）。
 * - channel='steer'（并入当前 run）：仅 chatApi.steer——不挂占位（steer 条目无确认配额）、
 *   不 pushPending（defer 条目入流由 pending 气泡承担，确认走 ① 队列分区匹配非腿 1 暂存）。
 * - RPC 失败原样上抛（flush 侧决策留队/回滚/停止后续），本函数只负责「挂」不管「回滚」。
 * - [defer segments 化] 富内容条目：提交文本 = segmentsToPrompt(segments) + 尾标记；
 *   sidecar 按 deferEntryId 写（仅非纯文本）；纯文本条目不写 sidecar。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/submit-queued-entry.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { submitQueuedEntry } from '../useChat'
import type { SubmitQueuedEntryDeps } from '../useChat'
import { createChatStore } from '../store'
import type { Segment } from '@taiji/shared'

function makeDeps(over: Partial<{ send: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; writeSegments: ReturnType<typeof vi.fn> }> = {}) {
  const chat = createChatStore()
  const send = over.send ?? vi.fn(() => Promise.resolve())
  const steer = over.steer ?? vi.fn(() => Promise.resolve())
  const writeSegments = over.writeSegments ?? vi.fn(() => Promise.resolve())
  const deps: SubmitQueuedEntryDeps = {
    chatApi: {
      send: send as unknown as SubmitQueuedEntryDeps['chatApi']['send'],
      steer: steer as unknown as SubmitQueuedEntryDeps['chatApi']['steer'],
      streamSubscribe: vi.fn(() => () => {}) as unknown as SubmitQueuedEntryDeps['chatApi']['streamSubscribe'],
    },
    writeSegments: writeSegments as unknown as SubmitQueuedEntryDeps['writeSegments'],
    chat,
    sessionStore: { applySnapshot: vi.fn(), revive: vi.fn() },
    // [session-dead 第三环] warning：toast 端口透传 ensureStreamSubscription 的注入面（本用例不触发）
    toast: { error: vi.fn(), warning: vi.fn() },
    t: vi.fn((key: string) => key),
    getCompactQueue: vi.fn(),
  }
  return { deps, chat, send, steer, writeSegments }
}

describe('submitQueuedEntry（u4b / D5.1）', () => {
  it('send 通道：挂 inflight 占位 + 建会话订阅 + chatApi.send 携 clientUuid=条目 id + 文本尾投递确认标记（簇 A2）', async () => {
    const { deps, chat } = makeDeps()
    await submitQueuedEntry('s1', { id: 'entry-1', text: 'm1' }, 'send', deps)

    // 占位先于 RPC（乐观语义——确认帧到达时 inflight>0 由 ① 优先消费不被 ② 误拦）
    expect(chat.getInflight('s1')).toBe(1)
    expect(deps.chatApi.streamSubscribe).toHaveBeenCalledWith('s1', expect.any(Function))
    expect(deps.chatApi.send).toHaveBeenCalledTimes(1)
    // [簇 A2] 文本尾附加裸 uuid 形态确认标记（bare id 不被 msg-id-mapper 剥除，
    // message_end(user) 回流文本携带 → core ① 按 id 确认出队）
    expect(deps.chatApi.send).toHaveBeenCalledWith('s1', 'm1\n<!--taiji:msg:entry-1-->', { clientUuid: 'entry-1' })
  })

  it('steer 通道：仅 chatApi.steer——不挂占位、不建订阅，文本尾同样附加确认标记（簇 A2）', async () => {
    const { deps, chat } = makeDeps()
    await submitQueuedEntry('s1', { id: 'entry-2', text: 'm2' }, 'steer', deps)

    expect(chat.getInflight('s1')).toBe(0)
    expect(deps.chatApi.streamSubscribe).not.toHaveBeenCalled()
    expect(deps.chatApi.send).not.toHaveBeenCalled()
    expect(deps.chatApi.steer).toHaveBeenCalledWith('s1', 'm2\n<!--taiji:msg:entry-2-->')
  })

  it('steer 通道不 pushPending（defer 条目不进暂存——确认走 ① 分区匹配非腿 1 drainN）', async () => {
    const { deps, chat } = makeDeps()
    await submitQueuedEntry('s1', { id: 'entry-3', text: 'm3' }, 'steer', deps)
    // pendingBuffer 无货：drainN 取不出任何条目（与 pushPending 的正常 steer 提交对照）
    expect(chat.drainN('s1', 'steer', 5)).toEqual([])
  })

  it('send 通道 RPC reject 原样上抛（回滚归 flush 侧——本函数只负责挂占位）', async () => {
    const { deps, chat } = makeDeps({
      send: vi.fn(() => Promise.reject(new Error('rpc fail'))),
    })
    await expect(
      submitQueuedEntry('s1', { id: 'entry-4', text: 'm4' }, 'send', deps),
    ).rejects.toThrow('rpc fail')
    // 占位保持挂起状态：flush catch 分支负责 decrementInflight 回滚（重试时重挂）
    expect(chat.getInflight('s1')).toBe(1)
  })
})

// ── [defer segments 化 / D-A1-2/D-A1-3] 富内容条目：序列化提交 + deferEntryId sidecar ──

/** 富内容段（image + skill——序列化产物 ≠ draft 文本） */
const RICH_SEGMENTS: Segment[] = [
  { type: 'text', text: '帮我看下这个报错' },
  { type: 'image', id: 'img-1', path: '/tmp/shot.png', fileName: 'shot.png', displayName: '截图.png' },
  { type: 'skill', name: 'code-review' },
]

describe('submitQueuedEntry segments 化（defer segments 化 / D-A1）', () => {
  it('富内容 send 条目：提交文本 = segmentsToPrompt(segments) + 尾标记；sidecar 按 deferEntryId 写（裸 uuid key，无 clientUuid）', async () => {
    const { deps, writeSegments } = makeDeps()
    await submitQueuedEntry('s1', { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', text: '帮我看下这个报错', segments: RICH_SEGMENTS }, 'send', deps)

    // 序列化产物 + 裸标记（image 段产出裸路径、skill 段产出 <taiji-skill/> 标记——与直发同款）
    expect(deps.chatApi.send).toHaveBeenCalledTimes(1)
    const sentText = vi.mocked(deps.chatApi.send).mock.calls[0]![1]
    expect(sentText).toContain('/tmp/shot.png')
    expect(sentText).toContain('<taiji-skill')
    expect(sentText.endsWith('\n<!--taiji:msg:3f2504e0-4f89-41d3-9a0c-0305e82c3301-->')).toBe(true)
    // sidecar：deferEntryId = 条目 id（裸 uuid），不写 clientUuid（key 空间互斥——
    // msg-id-mapper 对 clientUuid 有 u-<uuid> 形态约定）
    expect(writeSegments).toHaveBeenCalledTimes(1)
    expect(writeSegments).toHaveBeenCalledWith({
      sessionId: 's1',
      entry: {
        deferEntryId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        segments: RICH_SEGMENTS,
        timestamp: expect.any(Number),
      },
    })
    const written = vi.mocked(writeSegments).mock.calls[0]![0].entry
    expect(written.clientUuid).toBeUndefined()
  })

  it('富内容 steer 条目：同样序列化 + sidecar（send/steer 两通道同链），不挂占位', async () => {
    const { deps, chat, writeSegments } = makeDeps()
    await submitQueuedEntry('s1', { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3302', text: 'draft 文本', segments: RICH_SEGMENTS }, 'steer', deps)

    expect(chat.getInflight('s1')).toBe(0)
    expect(deps.chatApi.steer).toHaveBeenCalledTimes(1)
    const sentText = vi.mocked(deps.chatApi.steer).mock.calls[0]![1]
    expect(sentText).toContain('/tmp/shot.png')
    expect(sentText.endsWith('\n<!--taiji:msg:3f2504e0-4f89-41d3-9a0c-0305e82c3302-->')).toBe(true)
    expect(writeSegments).toHaveBeenCalledTimes(1)
  })

  it('submitText 优先复用（flush 侧算好的序列化文本，避免双算）；纯文本条目不写 sidecar', async () => {
    const { deps, writeSegments } = makeDeps()
    const submitText = '帮我看下这个报错\n/tmp/shot.png'
    await submitQueuedEntry('s1', { id: 'e-1', text: '帮我看下这个报错', segments: RICH_SEGMENTS, submitText }, 'send', deps)

    // 提交文本 = submitText 原文 + 标记（不再现场重算 segmentsToPrompt）
    expect(vi.mocked(deps.chatApi.send).mock.calls[0]![1]).toBe(`${submitText}\n<!--taiji:msg:e-1-->`)

    // 纯文本条目（全部 text 段）：sidecar 跳过（最小写入，对齐 submitSegments 谓词），
    // 提交文本 = segments 缺省包的 text 单段序列化 + 标记
    await submitQueuedEntry('s2', { id: 'e-2', text: 'plain' }, 'steer', deps)
    expect(writeSegments).toHaveBeenCalledTimes(1) // 仅上面的富内容条目写过
    expect(vi.mocked(deps.chatApi.steer).mock.calls[0]![1]).toBe('plain\n<!--taiji:msg:e-2-->')
  })

  it('sidecar 写失败不阻断提交（fire-and-forget console.warn）', async () => {
    const { deps } = makeDeps({ writeSegments: vi.fn(() => Promise.reject(new Error('sidecar io'))) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        submitQueuedEntry('s1', { id: 'e-3', text: 't', segments: RICH_SEGMENTS }, 'send', deps),
      ).resolves.toBeUndefined()
      expect(deps.chatApi.send).toHaveBeenCalledTimes(1)
      // 微任务后 warn 落地（fire-and-forget catch）
      await Promise.resolve()
      await Promise.resolve()
      expect(warn).toHaveBeenCalledWith('[useChat] defer writeSegments failed:', expect.any(Error))
    } finally {
      warn.mockRestore()
    }
  })
})
