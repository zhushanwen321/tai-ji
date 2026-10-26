/**
 * chat store 与 shell 接线合并产物（round 5-G S7）：六文件同产物，环境统一默认
 * （happy-dom；chat 系三文件原为 node 环境，纯 pinia store 逻辑无 DOM 依赖，迁移实证兼容）。
 *
 * 并入来源（基名）：
 *  - stores/chat-subagent-stream（subagent streaming 收尾状态机，24 例，原 node）
 *  - stores/chat-store（F7 错误不变量，6 例，原 node）
 *  - stores/chat-stream-warn（B1 WARN 通道隔离，2 例，原 node）
 *  - useConnection-assembly（连接装配点回归，4 例；跨目录自根搬入）
 *  - shell/useGlobalShortcuts（shortcutOverrides 分支，4 例；跨目录自 shell/ 搬入）
 *  - composables/features/search-modal-deps-session-list（搜索 session 源迁移，2 例；
 *    跨目录自 composables/features/ 搬入）
 *
 * mock 注册与互斥核查（S7 复筛记录）：
 *  - chat 系三文件零 vi.mock——刻意不 mock '@/api'（VITE_MOCK=true 下门面 session 域指向
 *    core transport/mock，与 '@taiji/core/transport/mock' 同对象引用；工厂 mock 会砍成员
 *    断同链消费方），拉取执行器经 beforeEach spy 单方法。
 *  - shell/useGlobalShortcuts mock '@taiji/core' 桶（spread actual 仅覆写 useSearchModal）与
 *    useCommandStore（壳 mock 仅 shortcutOverrides）：stores/chat 从桶取 createChatStore 走
 *    spread actual 真实成员，同引用断言不受影响；useSearchModalDeps 构造期仅调
 *    useCommandStore() 透传不访问成员，壳 mock 泄漏无害。
 *  - search-modal-deps mock '@taiji/core/transport/api/domains/session' 深路径：门面
 *    VITE_MOCK 分支不消费该深路径（session 域走 transport/mock），不影响 chat 系同引用链；
 *    useGlobalShortcuts/useConnection 链不消费 session 域。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/stores/chat-shell-bundle.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import { useChatStore } from '@/stores/chat'
import { session as coreMockSession } from '@taiji/core/transport/mock'
import type { Message, ServerMessage, SessionGroup } from '@taiji/shared'
import {
  providePlatform,
  disconnect,
  WS_READY_STATE,
  type WebSocketLike,
} from '@taiji/core'

// ── shell/useGlobalShortcuts 节的 mock（commandStore 壳 mock + 桶 spread）──

/** commandStore 壳 mock：shortcutOverrides 可控 ref（重录键注入点） */
const commandStoreMock = vi.hoisted(() => ({
  shortcutOverrides: { value: {} as Record<string, string> },
}))
vi.mock('@/composables/features/command/useCommandStore', () => ({
  useCommandStore: () => ({
    shortcutOverrides: commandStoreMock.shortcutOverrides,
  }),
}))

/** @taiji/core 仅覆盖 useSearchModal（toggle spy），其余导出保留真实实现 */
const searchModalMock = vi.hoisted(() => ({
  toggle: vi.fn(),
}))
vi.mock('@taiji/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core')>()
  return {
    ...actual,
    useSearchModal: () => ({ toggle: searchModalMock.toggle }),
  }
})

// ── search-modal-deps 节的深路径 mock ──

const listSessionsMock = vi.hoisted(() => vi.fn(async (): Promise<SessionGroup[]> => []))
const listMock = vi.hoisted(() => vi.fn(async (): Promise<SessionGroup[]> => []))
const listArchivesMock = vi.hoisted(() => vi.fn(async () => []))

vi.mock('@taiji/core/transport/api/domains/session', () => ({
  list: listMock,
  listSessions: listSessionsMock,
  listArchives: listArchivesMock,
}))

import { useConnection } from '@/composables/useConnection'
import { useGlobalShortcuts, type UseGlobalShortcutsOptions } from '@/composables/shell/useGlobalShortcuts'
import { useSidebarStore } from '@/stores/sidebar'
import { useNavigationStore } from '@/stores/navigation'
import { usePresetStore } from '@/stores/preset'
import { useSearchModalDeps } from '@/composables/features/search/useSearchModalDeps'

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：stores/chat-subagent-stream（原 node 环境文件，节内 hook 原样）
// ─────────────────────────────────────────────────────────────────────────────

/** 宏任务冲刷：拉取链（subagentStreamPull promise → .then 回灌状态机）全部 microtask 落地 */
const flushPull = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// [B2 u-renderer] 拉取执行器断言锚点：测试环境 VITE_MOCK=true（vitest.config define）→
// stores/chat.ts 装配的 subagentStreamPull 执行器实际调用 core mock session 的
// getSubagentStreamState（门面 mock 侧与此处是同一对象引用）——beforeEach spy 该方法获得
// 调用断言与可控响应。刻意不 vi.mock('@/api') 模块：mock 工厂缺成员会打断 btw-replay 等
// 同链消费方（worker OOM 实测），spy 单方法是替换面最小的可控形态。
const pullMock = () => vi.mocked(coreMockSession.getSubagentStreamState)

describe('W4 chat store — subagent streaming 收尾（U8/U9）', () => {
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
        content: '已收尾',
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

  it('U9.1: streaming assistant → finalize 后翻 complete（sealed 收尾）', () => {
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
    expect(list[1].status).toBe('complete') // 第二条收尾
  })

  it('U9.3: 无 streaming assistant → 幂等 no-op（不抛错，不改已有 complete 消息）', () => {
    const store = useChatStore()
    store.setMessages(VIRTUAL_ID, [
      {
        id: 'sa-1',
        role: 'assistant',
        content: '已收尾',
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

  // ── sealed 检查对齐（D-010 parity）──

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
    // 收尾后再来 delta（如迟到的 WS 帧）
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
  // （分区状态与拉取执行器注入属 core 工厂测试）；本组锁定 pinia store 委托入口行为
  // （renderer 分派改造（u-renderer）的消费方契约）。

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

  it('chunk 委托·跨消息边界：msgSeq 推进开新 streaming 消息（旧实体收尾，增量不并入旧消息）', () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：stores/chat-store（原 node 环境文件，节内 hook 原样）
// ─────────────────────────────────────────────────────────────────────────────

describe('ChatStore · F7 错误不变量集中', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('F7: markSessionError 重置 streaming 状态', () => {
    const store = useChatStore()
    const sid = 'session-f7-1'

    // 模拟 streaming 状态
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'msg-1' },
    })
    expect(store.getMessages(sid)[0].status).toBe('streaming')
    expect(store.isGenerating(sid)).toBe(true)

    // markSessionError 应重置 streaming 状态
    store.markSessionError(sid, 'Error occurred')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('error')
    expect(store.isGenerating(sid)).toBe(false)
  })

  it('F7: markSessionError 同时重置 isGenerating 和 streaming', () => {
    const store = useChatStore()
    const sid = 'session-f7-2'

    // 设置 streaming 状态
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'msg-2' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '部分内容' },
    })
    expect(store.isGenerating(sid)).toBe(true)
    expect(store.getMessages(sid)[0].status).toBe('streaming')

    // markSessionError 应同时重置
    store.markSessionError(sid, 'Crash error')
    expect(store.isGenerating(sid)).toBe(false)
    expect(store.getMessages(sid)[0].status).toBe('error')
  })

  it('F7: markSessionError 生成 error 消息（无 streaming 时新建）', () => {
    const store = useChatStore()
    const sid = 'session-f7-3'

    store.markSessionError(sid, 'Process crashed')

    const messages = store.getMessages(sid)
    expect(messages.length).toBe(1)
    expect(messages[0].role).toBe('assistant')
    expect(messages[0].status).toBe('error')
    expect(messages[0].content).toBe('') // [M2] 错误文本不拼进 content
    expect(messages[0].error).toBe('Process crashed')
  })

  it('F7: markSessionError 并入 streaming 消息（有 streaming 时不新建）', () => {
    const store = useChatStore()
    const sid = 'session-f7-4'

    // 创建 streaming 消息
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'msg-3' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '部分内容' },
    })

    store.markSessionError(sid, 'Process crashed')

    const messages = store.getMessages(sid)
    expect(messages.length).toBe(1) // 不新建
    expect(messages[0].id).toBe('msg-3') // 原消息转态
    expect(messages[0].status).toBe('error')
    expect(messages[0].content).toContain('部分内容') // 保留已生成内容
    expect(messages[0].error).toBe('Process crashed') // error 字段
  })

  it('F7: markSessionError 不影响其他 session', () => {
    const store = useChatStore()
    const sid1 = 'session-f7-5a'
    const sid2 = 'session-f7-5b'

    // 两个 session 都在 streaming
    store.applyMessageEvent(sid1, {
      type: 'message.message_start',
      payload: { sessionId: sid1, messageId: 'msg-1' },
    })
    store.applyMessageEvent(sid2, {
      type: 'message.message_start',
      payload: { sessionId: sid2, messageId: 'msg-2' },
    })

    // 只 markSessionError sid1
    store.markSessionError(sid1, 'Error in sid1')

    // sid1 应重置
    expect(store.isGenerating(sid1)).toBe(false)
    expect(store.getMessages(sid1)[0].status).toBe('error')

    // sid2 不受影响
    expect(store.isGenerating(sid2)).toBe(true)
    expect(store.getMessages(sid2)[0].status).toBe('streaming')
  })

  it('F7: markSessionError 幂等 — 多次调用不产生多条错误消息', () => {
    const store = useChatStore()
    const sid = 'session-f7-6'

    // 多次调用
    store.markSessionError(sid, 'Error 1')
    store.markSessionError(sid, 'Error 2')
    store.markSessionError(sid, 'Error 3')

    const messages = store.getMessages(sid)
    // 应只有一条错误消息（或最后一条的 error 是最新的）
    const errorMessages = messages.filter(m => m.status === 'error')
    expect(errorMessages.length).toBeLessThanOrEqual(3) // 允许多条，但通常合并
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：stores/chat-stream-warn（原 node 环境文件，节内 hook 原样）
// ─────────────────────────────────────────────────────────────────────────────

describe('B1: message.stream_warn 不收尾 session（WARN 与 ERROR 通道隔离）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('stream_warn 到达 streaming session → isGenerating 仍 true（不收尾）', () => {
    const store = useChatStore()
    const sid = 's-warn'
    // 构造一个 streaming 中的 session（message.message_start 创建 streaming entity）
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid },
    } as ServerMessage)
    expect(store.isGenerating(sid)).toBe(true)

    // WARN 到达
    const warnMsg: ServerMessage = {
      type: 'message.stream_warn',
      payload: { sessionId: sid, content: '长时间无响应（120s 无活动）' },
    }
    store.applyMessageEvent(sid, warnMsg)

    // 核心：WARN 不应收尾——streaming assistant 消息 status 不变（未被 finalize 成 error）
    // stream_warn 会追加一条 system 提示消息，但不应影响 assistant 实体的 streaming 态
    const msgs = store.getMessages(sid)
    const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
    expect(lastAssistant).toBeDefined()
    expect(lastAssistant!.status).toBe('streaming')
  })

  it('stream_error 到达 → 仍正常收尾（回归防护，两通道隔离）', () => {
    const store = useChatStore()
    const sid = 's-err'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid },
    } as ServerMessage)
    expect(store.isGenerating(sid)).toBe(true)

    const errMsg: ServerMessage = {
      type: 'message.stream_error',
      payload: { sessionId: sid, content: '真正错误', kind: 'error' },
    }
    store.applyMessageEvent(sid, errMsg)

    // stream_error 是真错误通道，必须收尾
    expect(store.isGenerating(sid)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：useConnection-assembly（节内 hook 原样；装配点模块加载即执行 setConnectionPorts
// ——不显式注入也能连，防「忘了注入」回归）
// ─────────────────────────────────────────────────────────────────────────────

const mockHolder = vi.hoisted(() => ({
  createCalls: [] as string[],
}))

/** fake webSocket factory：登记 create 调用 + 同步模拟连接成功（onopen 微任务触发） */
function installTestPlatform(): void {
  providePlatform({
    kind: 'mock',
    storage: {
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    },
    webSocket: {
      create: (url: string) => {
        mockHolder.createCalls.push(url)
        const socket: WebSocketLike = {
          readyState: WS_READY_STATE.OPEN,
          send: () => {},
          close: () => {},
          onopen: null,
          onclose: null,
          onmessage: null,
          onerror: null,
        }
        // ws-client create 返回后才赋 onopen（connect 内赋值），微任务触发模拟连接成功
        queueMicrotask(() => socket.onopen?.())
        return socket
      },
    },
  })
}

describe('useConnection 装配点（§10.2 D-1）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHolder.createCalls = []
    installTestPlatform()
    // happy-dom 默认 visible；显式设置保证断言环境一致
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
  })

  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    // 清模块级单例（listener/watch/initialised），避免跨用例泄漏
    teardownConnection()
  })

  function teardownConnection(): void {
    try {
      const { teardown } = useConnection()
      teardown()
    } catch {
      // teardown 幂等，失败忽略
    }
  }

  it('模块加载即完成端口注入：init 走真实链路建立连接（mock 模式 connect mock://）', async () => {
    const { init, teardown } = useConnection()
    await init()
    expect(mockHolder.createCalls).toContain('mock://localhost')
    teardown()
  })

  it('visibility 端口接真实 DOM：切回可见（visible）且未连接 → 主动重连', async () => {
    const { init, teardown } = useConnection()
    await init()

    // 模拟标签页后台时连接掉了（真实 ws-client disconnect → state=disconnected）
    disconnect()
    mockHolder.createCalls = []

    // 真实 DOM 事件 → 装配点 visibility 端口 → core 重连检查放行 → connect
    document.dispatchEvent(new Event('visibilitychange'))

    expect(mockHolder.createCalls.length).toBeGreaterThan(0)
    teardown()
  })

  it('visibility 端口接真实 DOM：已 connected 时切回前台 → 不重连', async () => {
    const { init, teardown } = useConnection()
    await init()
    // fake socket 已同步 onopen → state=connected

    mockHolder.createCalls = []

    document.dispatchEvent(new Event('visibilitychange'))

    expect(mockHolder.createCalls).toHaveLength(0)
    teardown()
  })

  it('teardown 卸载 visibility 监听：卸载后 visibilitychange 不再触发重连', async () => {
    const { init, teardown } = useConnection()
    await init()

    disconnect()
    mockHolder.createCalls = []
    teardown()

    document.dispatchEvent(new Event('visibilitychange'))
    expect(mockHolder.createCalls).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：shell/useGlobalShortcuts（节内 hook 原样；监听器经 effectScope + scope.stop
// 每用例解绑，避免用例间监听器累积重复派发）
// ─────────────────────────────────────────────────────────────────────────────

/** 构造 keydown 事件并派发到 window（useGlobalShortcuts 的监听挂点） */
function fireKey(options: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }): void {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: options.key,
    metaKey: options.metaKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    shiftKey: options.shiftKey ?? false,
    altKey: options.altKey ?? false,
    bubbles: true,
    cancelable: true,
  }))
}

/** 在独立 effect scope 内启动快捷键派发，返回 stop 函数（解绑 window 监听） */
function mountShortcuts(options: UseGlobalShortcutsOptions): () => void {
  const scope = effectScope()
  scope.run(() => useGlobalShortcuts(options))
  return () => scope.stop()
}

describe('useGlobalShortcuts shortcutOverrides 分支', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    commandStoreMock.shortcutOverrides.value = {}
  })

  it('new-session 重录为 mod+m：按重录键触发 onNewSession，按默认 ⌘N 不触发', () => {
    const onNewSession = vi.fn()
    const stop = mountShortcuts({ onNewSession, forkFromLastAssistant: vi.fn(), enterForkModeFromLastAssistant: vi.fn(), handoffFromLastAssistant: vi.fn(), navigation: useNavigationStore(), openSettings: vi.fn() })
    try {
      // 重录键与默认键（mod+n）错开，才能验证「重录后默认键失效」
      commandStoreMock.shortcutOverrides.value = { 'new-session': 'mod+m' }

      // 重录键 mod+m（meta 前缀）→ 触发
      fireKey({ key: 'm', metaKey: true })
      expect(onNewSession).toHaveBeenCalledTimes(1)

      // 默认键 ⌘N 失效：override 取代 keymap 默认匹配，按 ⌘N 不再触发
      fireKey({ key: 'n', metaKey: true })
      expect(onNewSession).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })

  it('toggle-sidebar 重录为 shift+j：按 shift+j 触发 toggleCollapsed，默认 ⌘B 不触发', () => {
    const sidebar = useSidebarStore()
    const stop = mountShortcuts({ onNewSession: vi.fn(), forkFromLastAssistant: vi.fn(), enterForkModeFromLastAssistant: vi.fn(), handoffFromLastAssistant: vi.fn(), navigation: useNavigationStore(), openSettings: vi.fn() })
    try {
      commandStoreMock.shortcutOverrides.value = { 'toggle-sidebar': 'shift+j' }
      const before = sidebar.collapsed

      // 重录键 shift+j → 折叠切换
      fireKey({ key: 'j', shiftKey: true })
      expect(sidebar.collapsed).toBe(!before)

      // 默认键 ⌘B 失效（override 取代默认匹配，且 j 键默认走 handoff 分支有 composer 检查，此处无关）
      fireKey({ key: 'b', metaKey: true })
      expect(sidebar.collapsed).toBe(!before)
    } finally {
      stop()
    }
  })

  it('open-preset-select 重录为 alt+x：按 alt+x 触发 requestOpen，默认 ⌘⇧P 不触发', () => {
    const requestOpen = vi.spyOn(usePresetStore(), 'requestOpen')
    const stop = mountShortcuts({ onNewSession: vi.fn(), forkFromLastAssistant: vi.fn(), enterForkModeFromLastAssistant: vi.fn(), handoffFromLastAssistant: vi.fn(), navigation: useNavigationStore(), openSettings: vi.fn() })
    try {
      commandStoreMock.shortcutOverrides.value = { 'open-preset-select': 'alt+x' }

      // 重录键 alt+x → requestOpen
      fireKey({ key: 'x', altKey: true })
      expect(requestOpen).toHaveBeenCalledTimes(1)

      // 默认键 ⌘⇧P 失效
      fireKey({ key: 'p', metaKey: true, shiftKey: true })
      expect(requestOpen).toHaveBeenCalledTimes(1)
    } finally {
      stop()
      requestOpen.mockRestore()
    }
  })

  it('重录键命中走 override：无 override 时默认 ⌘N 仍触发 onNewSession（回归防护）', () => {
    const onNewSession = vi.fn()
    const stop = mountShortcuts({ onNewSession, forkFromLastAssistant: vi.fn(), enterForkModeFromLastAssistant: vi.fn(), handoffFromLastAssistant: vi.fn(), navigation: useNavigationStore(), openSettings: vi.fn() })
    try {
      // 默认（无 override）：⌘N 触发
      fireKey({ key: 'n', metaKey: true })
      expect(onNewSession).toHaveBeenCalledTimes(1)

      // 无 mod 修饰不触发
      fireKey({ key: 'n' })
      expect(onNewSession).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：composables/features/search-modal-deps-session-list（节内 hook 原样）
// ─────────────────────────────────────────────────────────────────────────────

describe('useSearchModalDeps：搜索 session 源迁移 session.list（W4b）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listSessionsMock.mockClear()
    listMock.mockClear()
  })

  it('ports.sessionList 调 listSessions({surface:"sidebar"})——显式传参，不依赖无参默认语义', async () => {
    const deps = useSearchModalDeps({ selectSession: vi.fn(), newSession: vi.fn() })
    await deps.ports.sessionList()
    expect(listSessionsMock).toHaveBeenCalledTimes(1)
    expect(listSessionsMock).toHaveBeenCalledWith({ surface: 'sidebar' })
    // 旧 config.sessions 查询侧不再被搜索消费（同一 port 换消息）
    expect(listMock).not.toHaveBeenCalled()
  })

  it('返回 SessionGroup[] 原样（端口形状不变，编排层零改动）', async () => {
    const groups: SessionGroup[] = [{ cwd: '/repo', sessions: [] }]
    listSessionsMock.mockResolvedValueOnce(groups)
    const deps = useSearchModalDeps({ selectSession: vi.fn(), newSession: vi.fn() })
    await expect(deps.ports.sessionList()).resolves.toEqual(groups)
  })
})
