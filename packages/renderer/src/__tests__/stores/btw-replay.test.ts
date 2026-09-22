/**
 * btw-replay —— btw 重载链接线测试（btw-question D5「重载链」/ M2-c 验收 ③④）。
 *
 * 覆盖面：
 * - ③ 接线：重开线（drawer 复合条件翻出 selectedBtwVid）→ getHistory(vid) → chatStore
 *   分区注入；触发门控（非 btw tab 不回放）；已 hydrate 幂等；驱逐后重开回填一致；
 *   失败降级（markHistoryFailed + 重开重试）。
 * - ④ live ≡ reload 等价口径（btw 分区纳入 applyEntry 等价性覆盖面）：同 vid 上
 *   live 帧链（message.message_end 载 entry → applyEntryFrame 累积）≡ 文件回放
 *   （replayEntries 投影经接线注入分区）——两腿喂同一 applyEntry reducer。
 * - V8 回放侧核实：半截 entry（悬空 toolCall，无 toolResult）重开回放的呈现形态。
 *
 * mock 策略（TEST-STRATEGY §5）：vi.mock('@/api') 局部替换 chat.getHistory（门面其余域
 * 走 actual）——数据源用既有 snapshot/history 通路的 mock 形态（transport 归 M2-b，本单元
 * 不碰）；mock 返回值 = replayEntries(entries).messages，即 runtime getEntries → lift →
 * replayEntries 的 applyEntry 投影（回放腿「文件→分区经 applyEntry」的等价构造）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/btw-replay.test.ts
 * 测试框架 vitest（禁止 node:test / tsx --test）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import {
  bindDrawerSessionId,
  drawerControl,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import { replayEntries } from '@taiji/core'
import type { Message, PiEntry, PiMessageBody, PiMessageEntry } from '@taiji/shared'
import { useChatStore } from '@/stores/chat'

// ── @/api 门面局部 mock：只替换 chat.getHistory（回放数据源），其余域走 actual ──
const getHistoryMock = vi.hoisted(() => vi.fn())
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return { ...actual, chat: { ...actual.chat, getHistory: getHistoryMock } }
})

const MAIN = 's-replay-main'

/** 构造最小 Message（回放快照投影音形）。 */
function msgOf(id: string, content: string): Message {
  return { id, role: 'user', content, status: 'complete', timestamp: 1 }
}

/** PiMessageEntry 工厂（真实形态：ISO timestamp / parentId 链，core helpers/fixtures 同构的本地版）。 */
function msgEntry(id: string, body: PiMessageBody, parentId: string | null = null): PiMessageEntry {
  return { type: 'message', id, parentId, timestamp: '2026-09-22T10:00:00.000Z', message: body }
}

/** session.history 应答（u4d 窗口契约三字段必填）。 */
function reply(messages: Message[]): {
  messages: Message[]
  truncated: boolean
  loadedTurns: number
  totalTurnsEstimate: number
} {
  return { messages, truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 }
}

let store: ReturnType<typeof useChatStore>
let boundSid: Ref<string | null>

/** watch flush:'pre' + 回放链两跳（触发 → getHistory resolve → hydrate）——双 flushPromises 收敛。 */
async function settle(): Promise<void> {
  await flushPromises()
  await flushPromises()
}

/** 打开 btw tab 并选中线（生产链 = BtwPanel autoSelect / chip 点击 → setBtwView）。 */
async function openThread(vid: string): Promise<void> {
  drawerControl.open('btw')
  drawerControl.setBtwView(vid)
  await settle()
}

beforeEach(() => {
  setActivePinia(createPinia())
  boundSid = ref<string | null>(MAIN)
  bindDrawerSessionId(boundSid)
  _resetDrawerForTest()
  store = useChatStore()
  getHistoryMock.mockReset()
})

afterEach(() => {
  store.$dispose() // 停 store effect scope（含回放 watch），防跨用例监听残留
  _resetDrawerForTest()
})

describe('重开线回放接线（D5 重载链：文件 → chatStore 分区）', () => {
  it('选中 btw 线 → getHistory(vid) 回放注入分区（hydrated + 窗口状态同写）', async () => {
    const history = [msgOf('r1', '线内历史'), msgOf('r2', '第二条')]
    getHistoryMock.mockResolvedValue(reply(history))

    await openThread('btw:pi-9')

    expect(getHistoryMock).toHaveBeenCalledTimes(1)
    expect(getHistoryMock).toHaveBeenCalledWith('btw:pi-9')
    expect(store.getMessages('btw:pi-9')).toEqual(history)
    expect(store.isHydrated('btw:pi-9')).toBe(true)
    expect(store.getHistoryWindow('btw:pi-9')).toEqual({
      truncated: false,
      loadedTurns: 1,
      totalTurnsEstimate: 1,
    })
  })

  it('触发门控：非 btw tab 不回放；切到 btw tab 触发一次；关 drawer 再开幂等不重拉', async () => {
    getHistoryMock.mockResolvedValue(reply([msgOf('r1', '回填')]))
    store.hydrate(MAIN, [msgOf('m1', '主对话')]) // 主分区已回放态（不参与触发面）

    // 门控①：drawer 开在其他 tab、selectedBtwVid 在场（切走残留）→ 不回放
    drawerControl.open('git')
    drawerControl.setBtwView('btw:pi-1')
    await settle()
    expect(getHistoryMock).not.toHaveBeenCalled()

    // 门控②：切到 btw tab（源 null → vid 翻出）→ 回放一次
    drawerControl.setTab('btw')
    await settle()
    expect(getHistoryMock).toHaveBeenCalledTimes(1)
    expect(store.isHydrated('btw:pi-1')).toBe(true)

    // 幂等：关 drawer（vid → null）再开（null → vid）→ 已 hydrate，不重复拉取
    drawerControl.close()
    await settle()
    drawerControl.open('btw')
    await settle()
    expect(getHistoryMock).toHaveBeenCalledTimes(1)
    // 主分区回放态未被打扰（触发面只写 btw 分区）
    expect(store.getMessages(MAIN)).toEqual([msgOf('m1', '主对话')])
  })

  it('驱逐后重开：hydrated 随驱逐清除 → 再回放，分区内容回填一致', async () => {
    const history = [msgOf('b1', '线回复')]
    getHistoryMock.mockResolvedValue(reply(history))
    await openThread('btw:pi-r')
    expect(store.getMessages('btw:pi-r')).toEqual(history)

    // LRU 驱逐（btw 键普通候选，core chat-lru-btw 断言面）：分区 + hydrated 标记同清
    store.evictSessionWithVirtual('btw:pi-r')
    expect(store.getMessages('btw:pi-r')).toEqual([])
    expect(store.isHydrated('btw:pi-r')).toBe(false)

    // 关 drawer 再开（选中值在 drawer 分区内持久，靠 isOpen 翻转重新触发）→ 回填
    drawerControl.close()
    await settle()
    drawerControl.open('btw')
    await settle()
    expect(getHistoryMock).toHaveBeenCalledTimes(2)
    expect(store.getMessages('btw:pi-r')).toEqual(history)
  })

  it('回放失败：markHistoryFailed 收口不写分区；重开自动重试成功后清除失败态', async () => {
    getHistoryMock.mockRejectedValueOnce(new Error('session not registered'))

    await openThread('btw:pi-fail')
    expect(store.failedHistory.has('btw:pi-fail')).toBe(true)
    expect(store.getMessages('btw:pi-fail')).toEqual([])

    // 重开（关 → 开）触发重试：成功回填 + 失败态清除
    getHistoryMock.mockResolvedValue(reply([msgOf('r1', '重试成功')]))
    drawerControl.close()
    await settle()
    drawerControl.open('btw')
    await settle()
    expect(getHistoryMock).toHaveBeenCalledTimes(2)
    expect(store.failedHistory.has('btw:pi-fail')).toBe(false)
    expect(store.getMessages('btw:pi-fail')).toEqual([msgOf('r1', '重试成功')])
  })
})

describe('live ≡ reload 等价口径（btw 分区纳入 applyEntry 等价性覆盖面）', () => {
  it('同 vid：live message_end 帧链累积 ≡ 文件回放投影注入（两腿同一 applyEntry reducer）', async () => {
    const vid = 'btw:pi-eq'
    const entries: PiEntry[] = [
      msgEntry('e1', { role: 'user', content: [{ type: 'text', text: '你好' }], timestamp: 1000 }),
      msgEntry(
        'e2',
        { role: 'assistant', content: [{ type: 'text', text: '答复' }], timestamp: 2000 },
        'e1',
      ),
    ]

    // live 腿：entry 载体帧喂 applyEntryFrame（W21 实时侧权威累积；ref 投影不参与本口径）
    for (const entry of entries) {
      store.applyMessageEvent(vid, { type: 'message.message_end', payload: { sessionId: vid, entry } })
    }
    const liveState = store.testInternals._entryStatesForTest.get(vid)
    expect(liveState).toBeDefined()

    // reload 腿：文件回放投影（runtime getEntries → lift → replayEntries 同一 reducer）经接线注入
    getHistoryMock.mockResolvedValue(reply(replayEntries(entries).messages))
    await openThread(vid)

    expect(getHistoryMock).toHaveBeenCalledWith(vid)
    expect(store.getMessages(vid)).toEqual(liveState!.messages)
    expect(store.isHydrated(vid)).toBe(true)
  })

  it('V8 回放侧：半截 entry（悬空 toolCall，无 toolResult）重开按已落盘内容呈现——悬空调用 status=completed 无 output，不悬挂 running', async () => {
    const entries: PiEntry[] = [
      msgEntry('e-u', { role: 'user', content: [{ type: 'text', text: '跑一下' }], timestamp: 1000 }),
      msgEntry(
        'e-a',
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '执行中' },
            { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'ls' } },
          ],
          timestamp: 2000,
        },
        'e-u',
      ),
    ]
    getHistoryMock.mockResolvedValue(reply(replayEntries(entries).messages))

    await openThread('btw:pi-half')

    const msgs = store.getMessages('btw:pi-half')
    expect(msgs).toHaveLength(2)
    const assistant = msgs[1]!
    expect(assistant.role).toBe('assistant')
    expect(assistant.status).toBe('complete')
    expect(assistant.toolCalls).toHaveLength(1)
    expect(assistant.toolCalls![0]!.status).toBe('completed')
    expect(assistant.toolCalls![0]!.output).toBeUndefined()
  })
})
