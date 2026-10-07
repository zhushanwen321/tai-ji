// @vitest-environment node

/**
 * W4 —— chat store subagent streaming 收口测试（U8/U9）。
 *
 * 背景：subagent store 原 applyStreamDelta 绕过 chat store 直调 setMessages，
 * chat store 应成为所有 assistant content mutation 的唯一入口。本测试覆盖
 * 从 subagent store 迁入的两个新 action：
 * - applySubagentStreamDelta(virtualId, lines)：全量替换 content + 幂等补 contentBlock
 * - finalizeSubagentStream(virtualId)：streaming → complete 收口
 *
 * virtualId = 'subagent:<subagentId>'，是 chat store messages Map 的 key，
 * 与主 session 共用同一 Map（仅 key 不同）。注意：本组 VIRTUAL_ID（下方 fixture）为
 * W4 遗留两段式形态，仅作 Map key 使用；拉取路径用例必须用三段式工厂形态
 * subagent:<mainSid>:<subId>（见 THREE_SEG_VID——执行器经 extractMainSessionId 解析主
 * session，两段式键解析出垃圾 mainSid，SSOT 见 stores/subagent.ts 与下方 B2 注释）。
 *
 * E3（mount Panel 组件树 + WS subagent.stream_delta 端到端）需手工验证：
 * 这里降级为对 chat store action 的直接断言（store action 是组件树渲染的
 * 数据源，断言 action 行为即可锁定渲染契约）。
 *
 * 运行：npx vitest run src/__tests__/stores/chat-subagent-stream.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { session as coreMockSession } from '@taiji/core/transport/mock'
import type { Message } from '@taiji/shared'

/** 宏任务冲刷：拉取链（subagentStreamPull promise → .then 回灌状态机）全部 microtask 落地 */
const flushPull = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// [B2 u-renderer] 拉取执行器断言锚点：测试环境 VITE_MOCK=true（vitest.config define）→
// stores/chat.ts 装配的 subagentStreamPull 执行器实际调用 core mock session 的
// getSubagentStreamState（门面 mock 侧与此处是同一对象引用）——beforeEach spy 该方法获得
// 调用断言与可控响应。刻意不 vi.mock('@/api') 模块：mock 工厂缺成员会打断 btw-replay 等
// 同链消费方（worker OOM 实测），spy 单方法是替换面最小的可控形态。
const pullMock = () => vi.mocked(coreMockSession.getSubagentStreamState)

describe('W4 chat store — subagent streaming 收口（U8/U9）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    setActivePinia(createPinia())
    vi.spyOn(coreMockSession, 'getSubagentStreamState')
  })

  const VIRTUAL_ID = 'subagent:bg-1'

  // ── U8：applySubagentStreamDelta ──

  it('U8.1: 无 streaming assistant → push 新 assistant（status:streaming + contentBlocks:[text]）', () => {
    const store = useChatStore()
    // 预置一条 user 消息（模拟 subagent 历史）
    store.setMessages(VIRTUAL_ID, [
      { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: 1 },
    ])

    store.applySubagentStreamDelta(VIRTUAL_ID, ['line1', 'line2'])

    const list = store.getMessages(VIRTUAL_ID)
    expect(list).toHaveLength(2)
    const assistant = list[1]
    expect(assistant.role).toBe('assistant')
    expect(assistant.status).toBe('streaming')
    expect(assistant.content).toBe('line1\nline2')
    expect(assistant.id).toMatch(/^sa-/)
    expect(assistant.contentBlocks).toEqual([{ type: 'text', refId: 'text' }])
  })

  it('U8.2: 有 streaming assistant → 全量替换 content（lines.join(chr(10))）', () => {
    const store = useChatStore()
    // 预置 streaming assistant（首次 delta 后的状态）
    store.setMessages(VIRTUAL_ID, [
      {
        id: 'sa-1',
        role: 'assistant',
        content: '旧文本',
        status: 'streaming',
        contentBlocks: [{ type: 'text', refId: 'text' }],
        timestamp: 1,
      },
    ])

    // 扩展层传的是 buffer 的 split('\n')，每次都是完整文本
    store.applySubagentStreamDelta(VIRTUAL_ID, ['第一行', '第二行', '第三行'])

    const list = store.getMessages(VIRTUAL_ID)
    expect(list).toHaveLength(1) // 不新增
    const assistant = list[0]
    expect(assistant.content).toBe('第一行\n第二行\n第三行')
    expect(assistant.status).toBe('streaming')
  })

  it('U8.3: 幂等补 contentBlock —— 首次补 text 块，再次不重复 push', () => {
    const store = useChatStore()
    // 预置 streaming assistant 但 contentBlocks 为空（首次 delta 前状态）
    store.setMessages(VIRTUAL_ID, [
      {
        id: 'sa-1',
        role: 'assistant',
        content: '',
        status: 'streaming',
        contentBlocks: [],
        timestamp: 1,
      },
    ])

    // 首次 delta：补 text 块
    store.applySubagentStreamDelta(VIRTUAL_ID, ['first'])
    let assistant = store.getMessages(VIRTUAL_ID)[0]
    expect(assistant.contentBlocks).toEqual([{ type: 'text', refId: 'text' }])

    // 再次 delta：不重复 push
    store.applySubagentStreamDelta(VIRTUAL_ID, ['first', 'second'])
    assistant = store.getMessages(VIRTUAL_ID)[0]
    expect(assistant.contentBlocks).toEqual([{ type: 'text', refId: 'text' }])
    expect(assistant.content).toBe('first\nsecond')
  })

  it('U8.4: 已含非 text contentBlocks → 补 text 块到尾部（不破坏已有顺序）', () => {
    const store = useChatStore()
    store.setMessages(VIRTUAL_ID, [
      {
        id: 'sa-1',
        role: 'assistant',
        content: '',
        status: 'streaming',
        contentBlocks: [{ type: 'thinking', refId: 'th1' }],
        timestamp: 1,
      },
    ])

    store.applySubagentStreamDelta(VIRTUAL_ID, ['text'])

    const assistant = store.getMessages(VIRTUAL_ID)[0]
    expect(assistant.contentBlocks).toEqual([
      { type: 'thinking', refId: 'th1' },
      { type: 'text', refId: 'text' },
    ])
  })

  it('U8.5: 最后一条 assistant 非 streaming（已 complete）→ push 新 streaming assistant', () => {
    const store = useChatStore()
    store.setMessages(VIRTUAL_ID, [
      {
        id: 'sa-old',
        role: 'assistant',
        content: '已收口',
        status: 'complete',
        contentBlocks: [{ type: 'text', refId: 'text' }],
        timestamp: 1,
      },
    ])

    store.applySubagentStreamDelta(VIRTUAL_ID, ['新回合'])

    const list = store.getMessages(VIRTUAL_ID)
    expect(list).toHaveLength(2)
    const newAssistant = list[1]
    expect(newAssistant.status).toBe('streaming')
    expect(newAssistant.content).toBe('新回合')
    // 旧的保持不变
    expect(list[0].status).toBe('complete')
  })

  // ── U9：finalizeSubagentStream ──

  it('U9.1: streaming assistant → finalize 后翻 complete（sealed 收口）', () => {
    const store = useChatStore()
    store.setMessages(VIRTUAL_ID, [
      {
        id: 'sa-1',
        role: 'assistant',
        content: '流式内容',
        status: 'streaming',
        contentBlocks: [{ type: 'text', refId: 'text' }],
        timestamp: 1,
      },
    ])

    store.finalizeSubagentStream(VIRTUAL_ID)

    const list = store.getMessages(VIRTUAL_ID)
    expect(list[0].status).toBe('complete')
    expect(list[0].content).toBe('流式内容') // content 不变
  })

  it('U9.2: 多条 assistant，只翻最后一条 streaming', () => {
    const store = useChatStore()
    store.setMessages(VIRTUAL_ID, [
      {
        id: 'sa-1',
        role: 'assistant',
        content: '回合1',
        status: 'complete',
        timestamp: 1,
      },
      {
        id: 'sa-2',
        role: 'assistant',
        content: '回合2',
        status: 'streaming',
        contentBlocks: [{ type: 'text', refId: 'text' }],
        timestamp: 2,
      },
    ])

    store.finalizeSubagentStream(VIRTUAL_ID)

    const list = store.getMessages(VIRTUAL_ID)
    expect(list[0].status).toBe('complete') // 第一条不变
    expect(list[1].status).toBe('complete') // 第二条收口
  })

  it('U9.3: 无 streaming assistant → 幂等 no-op（不抛错，不改已有 complete 消息）', () => {
    const store = useChatStore()
    store.setMessages(VIRTUAL_ID, [
      {
        id: 'sa-1',
        role: 'assistant',
        content: '已收口',
        status: 'complete',
        timestamp: 1,
      },
    ])

    expect(() => store.finalizeSubagentStream(VIRTUAL_ID)).not.toThrow()
    expect(store.getMessages(VIRTUAL_ID)[0].status).toBe('complete')
  })

  it('U9.4: virtualId 无消息分区 → 幂等 no-op（不抛错）', () => {
    const store = useChatStore()
    expect(() => store.finalizeSubagentStream('subagent:never-exists')).not.toThrow()
  })

  // ── sealed 守卫对齐（D-010 parity）──

  it('sealed parity: finalize 后再 applySubagentStreamDelta → push 新 streaming（不污染已 complete 实体）', () => {
    const store = useChatStore()
    store.setMessages(VIRTUAL_ID, [
      {
        id: 'sa-1',
        role: 'assistant',
        content: '回合1',
        status: 'streaming',
        contentBlocks: [{ type: 'text', refId: 'text' }],
        timestamp: 1,
      },
    ])

    store.finalizeSubagentStream(VIRTUAL_ID)
    // 收口后再来 delta（如迟到的 WS 帧）
    store.applySubagentStreamDelta(VIRTUAL_ID, ['新回合'])

    const list = store.getMessages(VIRTUAL_ID)
    expect(list).toHaveLength(2)
    // 旧的保持 complete 不被污染
    expect(list[0].status).toBe('complete')
    expect(list[0].content).toBe('回合1')
    // 新建 streaming
    expect(list[1].status).toBe('streaming')
  })

  // ── E3 降级断言：chat store action 是组件树渲染的数据源 ──

  it('E3 (degraded): subagent 虚拟 session 与主 session 共用 messages Map（key 隔离）', () => {
    const store = useChatStore()
    const MAIN_SID = 'session-main'

    // 主 session 与 subagent 虚拟 session 各写各的，互不干扰
    store.appendUser(MAIN_SID, '主会话消息')
    store.applySubagentStreamDelta(VIRTUAL_ID, ['subagent 流式'])

    expect(store.getMessages(MAIN_SID)).toHaveLength(1)
    expect(store.getMessages(MAIN_SID)[0].role).toBe('user')
    expect(store.getMessages(VIRTUAL_ID)).toHaveLength(1)
    expect(store.getMessages(VIRTUAL_ID)[0].role).toBe('assistant')
    expect(store.getMessages(VIRTUAL_ID)[0].status).toBe('streaming')
  })

  // ── [B2 subagent-stream-chunk §4.3] 增量 chunk 消费状态机（store 委托层）──
  // 状态机分支判定 / 水位回放 / 在途去重的全量断言在 core streaming-state-machine.test.ts
  // （分区状态与拉取执行器注入属 core 工厂测试面）；本组锁定 pinia store 委托入口行为
  // （renderer 分派改造（u-renderer）的消费面契约）。

  const RECORD_ID = 'bg-1'

  it('chunk 委托·干净起步与顺序追加：applySubagentStreamChunk 增量拼 content（非全量替换）', () => {
    const store = useChatStore()
    store.applySubagentStreamChunk(VIRTUAL_ID, RECORD_ID, 1, 0, 'a')
    store.applySubagentStreamChunk(VIRTUAL_ID, RECORD_ID, 1, 1, 'b')

    const list = store.getMessages(VIRTUAL_ID)
    expect(list).toHaveLength(1)
    expect(list[0].role).toBe('assistant')
    expect(list[0].status).toBe('streaming')
    expect(list[0].content).toBe('ab')
    expect(list[0].id).toMatch(/^sa-/)
  })

  it('chunk 委托·跨消息边界：msgSeq 推进开新 streaming 消息（旧实体收口，增量不并入旧消息）', () => {
    const store = useChatStore()
    store.applySubagentStreamChunk(VIRTUAL_ID, RECORD_ID, 1, 0, '第一回合')
    store.applySubagentStreamChunk(VIRTUAL_ID, RECORD_ID, 2, 0, '第二回合')

    const list = store.getMessages(VIRTUAL_ID)
    expect(list).toHaveLength(2)
    expect(list[0].status).toBe('complete')
    expect(list[0].content).toBe('第一回合')
    expect(list[1].status).toBe('streaming')
    expect(list[1].content).toBe('第二回合')
  })

  it('chunk 委托·失步缺前缀：未注入拉取执行器时不抛错、失步 chunk 不上屏（core 单测锁拉取路径）', () => {
    const store = useChatStore()
    store.applySubagentStreamChunk(VIRTUAL_ID, RECORD_ID, 1, 0, 'a')

    expect(() => store.applySubagentStreamChunk(VIRTUAL_ID, RECORD_ID, 1, 5, 'gap')).not.toThrow()
    const list = store.getMessages(VIRTUAL_ID)
    expect(list).toHaveLength(1)
    expect(list[0].content).toBe('a') // 失步 chunk 不上屏（待拉取收敛）
  })

  it('拉取响应委托·found:true 全量替换；found:false 不动作', () => {
    const store = useChatStore()
    store.applySubagentStreamState(VIRTUAL_ID, RECORD_ID, { found: true, msgSeq: 3, lastDeltaSeq: 1, lines: ['l0', 'l1'] })
    let list = store.getMessages(VIRTUAL_ID)
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('streaming')
    expect(list[0].content).toBe('l0\nl1') // 复用 applySubagentStreamDelta 全量替换形态

    store.applySubagentStreamState(VIRTUAL_ID, RECORD_ID, { found: false, msgSeq: 0, lastDeltaSeq: 0, lines: [] })
    list = store.getMessages(VIRTUAL_ID)
    expect(list).toHaveLength(1) // 无进行中流：不新建不动
    expect(list[0].content).toBe('l0\nl1')
  })

  it('拉取响应委托·≤ sealedMsgSeq 丢弃：sealSubagentStream 落水位后，定稿消息响应不复活内容', () => {
    const store = useChatStore()
    store.applySubagentStreamChunk(VIRTUAL_ID, RECORD_ID, 1, 0, 'live')
    store.sealSubagentStream(VIRTUAL_ID, RECORD_ID, 1)

    store.applySubagentStreamState(VIRTUAL_ID, RECORD_ID, { found: true, msgSeq: 1, lastDeltaSeq: 9, lines: ['sealed'] })

    const list = store.getMessages(VIRTUAL_ID)
    expect(list).toHaveLength(1)
    expect(list[0].content).toBe('live') // 已定稿消息的晚到响应不覆写
  })

  it('生命周期委托：clearSubagentChunkState / clearSubagentChunkStateForSession 幂等不抛错', () => {
    const store = useChatStore()
    store.applySubagentStreamChunk(VIRTUAL_ID, RECORD_ID, 1, 0, 'a')

    expect(() => {
      store.clearSubagentChunkState(VIRTUAL_ID, RECORD_ID)
      store.clearSubagentChunkState(VIRTUAL_ID)
      store.clearSubagentChunkStateForSession('session-main')
    }).not.toThrow()

    // 清除后同键 chunk 干净重建（msgSeq 回 0，边界推进正常）
    store.applySubagentStreamChunk(VIRTUAL_ID, RECORD_ID, 1, 0, 'fresh')
    expect(store.getMessages(VIRTUAL_ID)).toHaveLength(2)
    expect(store.getMessages(VIRTUAL_ID)[1].content).toBe('fresh')
  })

  // ── [B2 u-renderer §4.3] 拉取触发接线（触发点②③ + 单在途合并）──
  // 拉取执行器 = stores/chat.ts 装配注入（subagentStreamPull → '@/api' session 域 mock 侧
  // 单方法 spy，见文件头）。分派端（subscribeStream handler）的端到端断言在
  // subagent-tab.test.ts；本组锁定 core 状态机经真实装配执行器的触发语义。
  // 虚拟键用三段式工厂形态（subagent:<mainSid>:<subId>——执行器经 extractMainSessionId
  // 解析主 session，两段式旧形态键解析出垃圾 mainSid）。

  const MAIN_SID = 'session-main'
  const THREE_SEG_VID = `subagent:${MAIN_SID}:${RECORD_ID}`

  it('触发点② 首见缺前缀：无状态机首条 chunk deltaSeq>0 → 失步入缓冲 + 发起拉取，响应经全量替换入口上屏', async () => {
    const store = useChatStore()
    pullMock().mockResolvedValue({ found: true, msgSeq: 1, lastDeltaSeq: 5, lines: ['完整前缀', '与晚到片段'] })

    // 无状态机 + deltaSeq=5 > 0：新建分区后边界推进 → expected=0 必失步入缓冲并触发拉取
    store.applySubagentStreamChunk(THREE_SEG_VID, RECORD_ID, 1, 5, '晚到片段')
    expect(pullMock()).toHaveBeenCalledTimes(1)
    // 执行器入参 = 解析后的主 session + recordId（virtualId 三段式经 extractMainSessionId）
    expect(pullMock()).toHaveBeenCalledWith(MAIN_SID, RECORD_ID)

    await flushPull()
    const list = store.getMessages(THREE_SEG_VID)
    expect(list).toHaveLength(1)
    expect(list[0].role).toBe('assistant')
    expect(list[0].content).toBe('完整前缀\n与晚到片段') // 复用 applySubagentStreamDelta 全量替换
    // 水位去重：缓冲 deltaSeq=5 ≤ lastDeltaSeq=5 不回放 → 全文唯一，无重复文本
    expect(list[0].content).not.toContain('晚到片段晚到片段')
  })

  it('触发点② 反例（干净起步不拉取）：无状态机首条 chunk deltaSeq=0 → 直接建状态机追加，零拉取', () => {
    const store = useChatStore()
    store.applySubagentStreamChunk(THREE_SEG_VID, RECORD_ID, 1, 0, 'clean')

    expect(pullMock()).not.toHaveBeenCalled()
    expect(store.getMessages(THREE_SEG_VID)).toHaveLength(1)
    expect(store.getMessages(THREE_SEG_VID)[0].content).toBe('clean')
  })

  it('触发点③ 失步跳号：顺序 chunk 后跳号 → 拉取，响应重置水位后缓冲 > 水位回放再失步 → 再次拉取收敛（回放水位单调推进）', async () => {
    const store = useChatStore()
    store.applySubagentStreamChunk(THREE_SEG_VID, RECORD_ID, 1, 0, 'a')
    // 第一次拉取：水位 2（全文含 deltaSeq 0-2）；缓冲 chunk(1,4) > 3 回放再失步 → 第二次拉取
    pullMock()
      .mockResolvedValueOnce({ found: true, msgSeq: 1, lastDeltaSeq: 2, lines: ['a', 'b', 'c'] })
      .mockResolvedValueOnce({ found: true, msgSeq: 1, lastDeltaSeq: 4, lines: ['a', 'b', 'c', 'd', 'e'] })

    // 跳过 deltaSeq=1,2：失步入缓冲 + 拉取（同 record 首个在途）
    store.applySubagentStreamChunk(THREE_SEG_VID, RECORD_ID, 1, 4, 'e')
    expect(pullMock()).toHaveBeenCalledTimes(1)

    await flushPull()
    // 设计 §4.3「回放中再遇跳号 → 再次拉取」：第二次响应水位 4 覆盖缓冲 → expected=5，
    // 缓冲 deltaSeq=4 ≤ 水位丢弃 → 内容收敛为最新全文（无缺段无重复，无无限拉取）
    expect(pullMock()).toHaveBeenCalledTimes(2)
    const list = store.getMessages(THREE_SEG_VID)
    expect(list).toHaveLength(1)
    expect(list[0].content).toBe('a\nb\nc\nd\ne')
  })

  it('单在途合并：在途拉取未返回期间连续失步 → 不重复发起（在途去重），响应到达后一并收敛', async () => {
    const store = useChatStore()
    let resolvePull!: (v: { found: boolean; msgSeq: number; lastDeltaSeq: number; lines: string[] }) => void
    pullMock().mockReturnValue(
      new Promise<{ found: boolean; msgSeq: number; lastDeltaSeq: number; lines: string[] }>((resolve) => {
        resolvePull = resolve
      }),
    )

    store.applySubagentStreamChunk(THREE_SEG_VID, RECORD_ID, 1, 2, 'x') // 失步 → 发起拉取
    store.applySubagentStreamChunk(THREE_SEG_VID, RECORD_ID, 1, 3, 'y') // 失步 → 在途去重
    expect(pullMock()).toHaveBeenCalledTimes(1)

    resolvePull({ found: true, msgSeq: 1, lastDeltaSeq: 3, lines: ['x', 'y'] })
    await flushPull()
    const list = store.getMessages(THREE_SEG_VID)
    expect(list).toHaveLength(1)
    expect(list[0].content).toBe('x\ny') // 缓冲两条均 ≤ 水位 3，丢弃不回放
  })

  // ── [B2 u-renderer §4.3] 清除挂点（生命周期挂既有删除编排链）──
  // disposeSession / evictSessionWithVirtual / evictVirtualKey 是双壳 deleteSession →
  // core triggerSessionCleanups → SessionCleanupHooks 编排链的真实成员方法；本组断言三个
  // 挂点执行后 chunk 分区清除。观察信号 = 清除后同 (msgSeq, deltaSeq) chunk 走边界推进
  // 开新消息（chunk 分区未清则 deltaSeq=0 < expected=1 被拦截丢弃）。messages 分区随挂点
  // 的处置差异：disposeSession 只删 mainSid key（'a' 流式消息保留）；两个 evict 挂点经
  // LRU 虚拟键联动连 messages 分区一并删（fresh chunk 成分区唯一消息）。

  function seedStreamingChunk(store: ReturnType<typeof useChatStore>): void {
    store.applySubagentStreamChunk(THREE_SEG_VID, RECORD_ID, 1, 0, 'a') // 分区 msgSeq=1, expected=1
  }

  it('清除挂点·session 级：disposeSession（deleteSession 编排链成员）按 mainSid 清名下 chunk 分区', () => {
    const store = useChatStore()
    seedStreamingChunk(store)

    store.disposeSession(MAIN_SID)
    store.applySubagentStreamChunk(THREE_SEG_VID, RECORD_ID, 1, 0, 'fresh')
    const list = store.getMessages(THREE_SEG_VID)
    expect(list).toHaveLength(2) // 'a' 保留 + fresh 走边界推进开新消息
    expect(list[1].status).toBe('streaming')
    expect(list[1].content).toBe('fresh')
  })

  it('清除挂点·显式驱逐：evictSessionWithVirtual 按 mainSid 清名下 chunk 分区', () => {
    const store = useChatStore()
    seedStreamingChunk(store)

    store.evictSessionWithVirtual(MAIN_SID)
    store.applySubagentStreamChunk(THREE_SEG_VID, RECORD_ID, 1, 0, 'fresh')
    const list = store.getMessages(THREE_SEG_VID)
    // messages 分区被 LRU 虚拟键联动一并清 → fresh 是唯一消息；chunk 分区未清时本 chunk
    // 会被旧 expected 拦截 → 0 条（断言区分点）
    expect(list).toHaveLength(1)
    expect(list[0].content).toBe('fresh')
  })

  it('清除挂点·record 级：evictVirtualKey 清该虚拟键名下 chunk 分区（record 级随虚拟分区删除）', () => {
    const store = useChatStore()
    seedStreamingChunk(store)

    store.evictVirtualKey(THREE_SEG_VID)
    store.applySubagentStreamChunk(THREE_SEG_VID, RECORD_ID, 1, 0, 'fresh')
    const list = store.getMessages(THREE_SEG_VID)
    expect(list).toHaveLength(1) // 分区整体已删，fresh 重建为唯一消息（chunk 分区未清则 0 条）
    expect(list[0].content).toBe('fresh')
  })
})
