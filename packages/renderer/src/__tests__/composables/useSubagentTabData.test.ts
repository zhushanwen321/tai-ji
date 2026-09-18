/**
 * useSubagentTabData 单测（drawer-blank-fix u2-seed，T2 判定矩阵——设计 §10 v4）。
 *
 * 覆盖 loadSubagentData subagent 三段式分支的空历史兜底判定顺序（判定顺序即优先级）：
 * - ①outcome 兜底先行（非 pi，U4 A8 既有分支）——命中后分区非空，②自然跳过
 * - ②task 种入随后（分区空 × task 非空）——pi 主场景 + 非 pi 磁盘扫描滞后窗口
 * - 分区非空（E-4 先到）→ 不种不擦；reload 幂等；空 task 不种
 *
 * mock 模式对齐 __tests__/panel/subagent-tab.test.ts（@/api 门面 session 重定向 + transport/api
 * events mock）；chat store 用真 store（pinia）——虚拟分区即 MessageStream 渲染源，
 * getMessages(virtualId) 断言即用户可见内容面（三视角之观察者形态）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useSubagentTabData.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computed, ref } from 'vue'
import { useChatStore } from '@/stores/chat'
import { subagentVirtualId } from '@/stores/subagent'
import { useSubagentTabData, type SubagentTabDataDeps } from '@/composables/panel/useSubagentTabData'
import type { SubagentRecord, Message } from '@taiji/shared'

// mock sessionApi：fetchAndInject 内部调 getSubagentHistory（快照腿）
vi.mock('@taiji/core/transport/api/domains/session', () => ({
  getSubagentHistory: vi.fn(),
  getSubagents: vi.fn().mockResolvedValue([]),
  subagentAction: vi.fn(),
  getAgentCallHistory: vi.fn(),
}))
// subagent store 经 @/api 门面导入 session；vitest 环境 VITE_MOCK=true 时门面把 session
// 解析到 src/api/mock（mockApi.getSubagentHistory 永不 resolve → fetchAndInject 卡死）。
// 需把门面 session 指回上面 mock 的 domains 命名空间，保证 store 与断言用的是同一个 vi.fn()
// （subagent-tab.test.ts / stores/subagent.test.ts 同款手法）。
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  return { ...actual, session }
})
// events mock：subscribeStream 经 events.on 注册 stream_delta 订阅（恒订阅，本套件不断言其行为）
vi.mock('@taiji/core/transport/api', () => ({
  on: vi.fn(() => vi.fn()),
  off: vi.fn(),
  dispatch: vi.fn(),
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
  onGlobal: vi.fn(() => vi.fn()),
  onGlobalType: vi.fn(() => vi.fn()),
  onCrossSession: vi.fn(() => vi.fn()),
  dispatchCrossSession: vi.fn(),
}))

import * as sessionApi from '@taiji/core/transport/api/domains/session'

const MAIN_SID = 's-comp-main'
const SUB_ID = 'sub-comp-1'
const VIRTUAL_ID = subagentVirtualId(MAIN_SID, SUB_ID)
const NO_OUTCOME_TEXT = '(no outcome recorded)'

function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: SUB_ID,
    sessionFile: null,
    agent: 'general-purpose',
    slug: 'worker',
    task: '帮我 review 登录模块',
    status: 'running',
    ...overrides,
  }
}

/**
 * 挂载 composable（deps.currentRecord 经 ref 注入，对齐组件 computed 形态；
 * chat store 用真 store——分区状态即渲染源）。
 */
let recordRef = ref<SubagentRecord | null>(null)
function mountComposable(record: SubagentRecord | null) {
  recordRef.value = record
  const deps: SubagentTabDataDeps = {
    currentRecord: computed(() => recordRef.value),
    noOutcomeText: () => NO_OUTCOME_TEXT,
  }
  const chat = useChatStore()
  return { chat, setSpy: vi.spyOn(chat, 'setMessages'), tabData: useSubagentTabData(deps) }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  recordRef = ref<SubagentRecord | null>(null)
  // 默认空历史（主场景：派发瞬间 sessionFile 未落盘，runtime 读历史必然 []）
  vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
})

describe('useSubagentTabData — 空历史兜底判定顺序即优先级（drawer-blank-fix §7.2）', () => {
  it('pi + 空历史 + 分区空 + task 非空 → task 气泡种入（主场景，setMessages 收到 1 条 user 消息）', async () => {
    const record = makeRecord({ startedAt: 1234 })
    const { chat, setSpy, tabData } = mountComposable(record)

    await tabData.loadSubagentData(VIRTUAL_ID)

    // fetchAndInject 空历史不写分区（u1）→ 唯一一次 setMessages 来自 seed
    expect(setSpy).toHaveBeenCalledTimes(1)
    const [vidArg, msgsArg] = setSpy.mock.calls[0]
    expect(vidArg).toBe(VIRTUAL_ID)
    expect(msgsArg).toHaveLength(1)
    expect(msgsArg[0].id).toBe(`task-u-${record.subagentId}`)
    expect(msgsArg[0].role).toBe('user')
    expect(msgsArg[0].content).toBe(record.task)
    expect(msgsArg[0].status).toBe('complete')
    expect(msgsArg[0].timestamp).toBe(1234)

    // 用户可见断言：分区（MessageStream 渲染源）内容含 task 文本——drawer 打开秒见任务
    const partition = chat.getMessages(VIRTUAL_ID)
    expect(partition).toHaveLength(1)
    expect(partition[0].content).toContain('帮我 review 登录模块')
  })

  it('pi + 空历史 + 分区已有内容（E-4 先到）→ 不种不擦（分区内容保持）', async () => {
    const { chat, setSpy, tabData } = mountComposable(makeRecord())
    // 模拟 E-4 entry 帧先于 drawer 打开到达（routeInbound → applySubagentEntries 已投影）
    const e4Projected: Message[] = [
      { id: 'e4-a1', role: 'assistant', content: 'E-4 先到的产出', status: 'complete', timestamp: 100 },
    ]
    chat.setMessages(VIRTUAL_ID, e4Projected)
    // spy 只计 loadSubagentData 内的写入：预置（模拟 E-4 已落地）不计入
    setSpy.mockClear()

    await tabData.loadSubagentData(VIRTUAL_ID)

    // 不擦：u1 空历史不写分区 + seed 被分区空守卫跳过 → E-4 内容原样保留
    const partition = chat.getMessages(VIRTUAL_ID)
    expect(partition).toEqual(e4Projected)
    expect(partition[0].id).toBe('e4-a1')
    expect(partition[0].content).toContain('E-4 先到的产出')
    // 不种：无 task-u-* 消息混入
    expect(partition.some((m) => m.id.startsWith('task-u-'))).toBe(false)
    // 全程零写入（fetchAndInject 空不写 + outcome pi 跳过 + seed 分区非空跳过）
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('非 pi（zcode）+ 空历史 + outcome 有值 + 分区空 → 仅 outcome 投影，无 seed 消息', async () => {
    const { chat, setSpy, tabData } = mountComposable(
      makeRecord({ engine: 'zcode', status: 'done', result: '最终结论文本', startedAt: 1000, endedAt: 2000 }),
    )

    await tabData.loadSubagentData(VIRTUAL_ID)

    // 唯一一次写入来自 outcome 分支（U4 A8）
    expect(setSpy).toHaveBeenCalledTimes(1)
    const partition = chat.getMessages(VIRTUAL_ID)
    // outcome 形态：task user 气泡（outcome-u-*）+ result assistant（outcome-a-*）
    expect(partition.some((m) => m.id.startsWith('outcome-u-'))).toBe(true)
    expect(partition.some((m) => m.id.startsWith('outcome-a-'))).toBe(true)
    expect(partition.map((m) => m.content).join('\n')).toContain('最终结论文本')
    // 无 seed：判定顺序即优先级，outcome 命中后分区非空 → task-u-* 不出现
    expect(partition.some((m) => m.id.startsWith('task-u-'))).toBe(false)
  })

  it('非 pi + 空历史 + 无 outcome → seed（可达场景：runtime 磁盘扫描滞后窗口）', async () => {
    const { chat, tabData } = mountComposable(makeRecord({ engine: 'zcode', status: 'running' }))

    await tabData.loadSubagentData(VIRTUAL_ID)

    const partition = chat.getMessages(VIRTUAL_ID)
    expect(partition).toHaveLength(1)
    expect(partition[0].id).toBe(`task-u-${SUB_ID}`)
    expect(partition[0].role).toBe('user')
    expect(partition[0].content).toBe('帮我 review 登录模块')
  })

  it('record.task 为空串 → 不种（分区保持为空）', async () => {
    const { chat, setSpy, tabData } = mountComposable(makeRecord({ task: '' }))

    await tabData.loadSubagentData(VIRTUAL_ID)

    expect(setSpy).not.toHaveBeenCalled()
    expect(chat.getMessages(VIRTUAL_ID)).toHaveLength(0)
  })

  it('reload 幂等：种入后再次 loadSubagentData（仍空 history）→ 分区仍只有一条 task 气泡（不重复种）', async () => {
    const { chat, tabData } = mountComposable(makeRecord())

    await tabData.loadSubagentData(VIRTUAL_ID)
    expect(chat.getMessages(VIRTUAL_ID)).toHaveLength(1)

    // 重开 drawer：reload 仍空历史 → seed 被分区空守卫跳过（首种气泡保留）
    await tabData.loadSubagentData(VIRTUAL_ID)

    const partition = chat.getMessages(VIRTUAL_ID)
    expect(partition).toHaveLength(1)
    expect(partition[0].id).toMatch(/^task-u-/)
    expect(partition[0].content).toContain('帮我 review 登录模块')
  })

  it('reload 后无兜底残留：种入后非空 history 到达 → 真实历史整体取代 task 气泡', async () => {
    const { chat, tabData } = mountComposable(makeRecord())
    await tabData.loadSubagentData(VIRTUAL_ID)
    expect(chat.getMessages(VIRTUAL_ID)[0].id).toMatch(/^task-u-/)

    // 子进程产出落盘后 reload：fetchAndInject 非空 → setMessages 整体替换（定稿权威语义）
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([
      { id: 'real-u1', role: 'user', content: '真实历史 user', status: 'complete', timestamp: 1 },
      { id: 'real-a1', role: 'assistant', content: '真实历史产出', status: 'complete', timestamp: 2 },
    ] as Message[])
    await tabData.loadSubagentData(VIRTUAL_ID)

    const partition = chat.getMessages(VIRTUAL_ID)
    expect(partition).toHaveLength(2)
    expect(partition.map((m) => m.id)).toEqual(['real-u1', 'real-a1'])
    expect(partition.some((m) => m.id.startsWith('task-u-'))).toBe(false)
  })
})
