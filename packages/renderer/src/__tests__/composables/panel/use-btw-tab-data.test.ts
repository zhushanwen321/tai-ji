/**
 * useBtwTabData 单测（btw-question M3-b：badge 数据通道 + updateFor 隔离 + 虚拟 key 清理登记）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 使用者（黑盒 DOM）：Host 把 threads 计数 / Σ unread 映射成文本节点，每条用例断言可见文本
 *   （拉取落地 / 迟到响应不串台 / 进视口清除 / 剪枝后归零）
 * - 观察者（形态）：挂载即主动拉取（不依赖广播）；线列表与 badge 数据范围按主会话分区落位
 * - 构建者（白盒）：updateFor(capturedSid) 迟到响应写旧分区（规则 8 隔离）+ 虚拟 key 登记
 *   三函数（get/clear/reconcile——M4-a 消费方先写后读）+ 出册线观察停止
 *
 * W4b：badge 数据源 = session.list {surface:'btw', mainSessionId}（btw 线进通用列表，
 * btw.list 退役——原「回收提醒两路解析点」用例随该帧退役删除，机制本体已随 ADR-0122
 * 删除、最后一处 feed 即 btw.list 帧）。
 *
 * mock 策略（TEST-STRATEGY §5）：vi.mock('@/api') 局部替换 session.listSessions（spread actual 保门面
 * 其余域，btw-panel 同款）+ chat.getHistory 桩（见 mock 处注释——回放链不产生墙钟竞争）；
 * 真实 chat store（setMessages 真实分区增长驱动未读 watch）+
 * 真实 core drawer 域（视口判定与抽屉活动触发范围）。i18n 走全局 setup（本文件无文案断言）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/panel/use-btw-tab-data.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount, enableAutoUnmount, type VueWrapper } from '@vue/test-utils'
import { computed, defineComponent, nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { Message } from '@taiji/shared'
import {
  bindDrawerSessionId,
  drawerControl,
  openDrawerTab,
  setBtwView,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import {
  useBtwTabData,
  getBtwSessionIdsByMain,
  clearBtwVirtualKeyMapping,
  disposeBtwLinePartitions,
  ensureBtwPendingBookkeeping,
  __resetBtwPendingBookkeepingForTest,
} from '@/composables/panel/useBtwTabData'
import {
  isBtwPending,
  invalidateBtwRequests,
  btwExpiredNoticeOf,
  firstBtwDialogReq,
} from '@/composables/panel/btw-pending-bookkeeping'
import { getExtensionBus } from '@/composables/shell/useExtensionHostBridge'
import { __resetBtwLineMembershipForTest, noteBtwLinesPulled } from '@/composables/panel/btw-line-membership'
import { useWorkflowStore } from '@/stores/workflow'
import { useSubagentStore } from '@/stores/subagent'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { subagentVirtualId } from '@taiji/shared'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { useChatStore } from '@/stores/chat'

// ── @/api 门面局部 mock：替换 badge 数据源（W4b 起 = session.listSessions）+ 回放链 getHistory 桩 ──
// btw 域本文件不再直接消费（线枚举走 session.list {surface:'btw', mainSessionId}）。
const sessionListMock = vi.hoisted(() => ({
  listSessions: vi.fn(),
}))
// getHistory 桩（微任务即回的空历史，语义 = 线从未 flush）：drawer 开 + 选中线会触发
// stores/btw-replay 的真实回放链，mock transport 的 TIMING.ack 是 40ms setTimeout
//（settle 只冲刷微任务，等不到它），迟到的空历史 hydrate 会清掉用例刚 seed 的线分区、
// 未读 watch 的 prev 基线随之归零——重负载下定时器落点漂移，未读计数随机翻错。
// 本文件断言范围是 badge 计数不是回放，桩成同步空历史后回放链不再产生墙钟竞争。
const chatGetHistoryMock = vi.hoisted(() =>
  vi.fn(async () => ({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })),
)
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return {
    ...actual,
    btw: { create: vi.fn(), remove: vi.fn() },
    chat: { ...actual.chat, getHistory: chatGetHistoryMock },
    session: { ...actual.session, listSessions: sessionListMock.listSessions },
  }
})

const SID_A = 's-btw-data-a'
const SID_B = 's-btw-data-b'

/** 最小 Host：把 composable 暴露面映射成可见文本节点（使用者视角断言范围） */
const Host = defineComponent({
  props: { sid: { type: String, default: null } },
  setup(props) {
    const sidRef = computed(() => props.sid as string | null)
    const { state, totalUnread, totalPending } = useBtwTabData(sidRef)
    return { state, totalUnread, totalPending }
  },
  template: `
    <div>
      <span data-testid="threads">{{ state.threads.length }}</span>
      <span data-testid="unread">{{ totalUnread }}</span>
      <span data-testid="pending">{{ totalPending }}</span>
    </div>
  `,
})

/** 线 SessionSummary 构造（session.list 合成条目同口径最小字段；label 可区分形态 §3.4.3） */
function line(sessionId: string, seq = 1): SessionSummary {
  return { id: sessionId, label: `btw-${seq}`, cwd: '/repo/main', status: 'idle', lastActiveAt: 0, surface: 'btw' }
}

/** SessionGroup[] 构造（单 cwd 组——useBtwTabData 只消费扁平 sessions，cwd 不影响断言） */
function groupsOf(...sessions: SessionSummary[]): SessionGroup[] {
  return [{ cwd: '/repo/main', sessions }]
}

let boundSid: Ref<string | null>

function mountHost(sid: string | null): VueWrapper {
  return mount(Host, { props: { sid } })
}

function text(w: VueWrapper, testid: string): string {
  return w.find(`[data-testid="${testid}"]`).text()
}

async function settle(w: VueWrapper): Promise<void> {
  await flushPromises()
  await nextTick()
  await nextTick()
}

function msg(id: string): Message {
  return { id, role: 'assistant', content: 'x', status: 'complete', timestamp: 0 }
}

enableAutoUnmount(afterEach)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  sessionListMock.listSessions.mockResolvedValue([])
  boundSid = ref(SID_A)
  bindDrawerSessionId(boundSid)
  _resetDrawerForTest()
  __clearSessionCleanupRegistryForTest()
  __resetBtwPendingBookkeepingForTest() // 模块级待处理簿记（含回收提醒集合 + 广播订阅）逐用例清零
  clearBtwVirtualKeyMapping(SID_A)
  clearBtwVirtualKeyMapping(SID_B)
  // W4b 收编判别器播种：btw 簿记订阅壳的 ui-request/requests-invalidated 路由判据 =
  // session.list {surface:'btw'} 拉取缓存成员判别（btw-line-membership）——本文件用例线
  // id（t*/line-*）按线预热（等价于抽屉打开时的拉取产物喂入）。
  __resetBtwLineMembershipForTest()
  noteBtwLinesPulled(['t1', 't2', 't3', 't4', 't5'])
})

describe('挂载/切会话主动拉取（broadcast 时序竞争规则：必拉不依赖广播）', () => {
  it("挂载即主动拉取 session.list {surface:'btw', mainSessionId}，线列表落当前分区", async () => {
    sessionListMock.listSessions.mockResolvedValue(groupsOf(line('t1', 1), line('t2', 2)))
    const w = mountHost(SID_A)
    await settle(w)

    expect(sessionListMock.listSessions).toHaveBeenCalledWith({ surface: 'btw', mainSessionId: SID_A })
    expect(text(w, 'threads')).toBe('2') // 用户可见：线列表派生视图
    expect(text(w, 'unread')).toBe('0')
  })

  it('切会话：按新 mainSid 重新拉取，两主会话分区互不污染', async () => {
    sessionListMock.listSessions.mockImplementation((q: { mainSessionId?: string }) =>
      Promise.resolve(q.mainSessionId === SID_A ? groupsOf(line('ta')) : groupsOf(line('tb1', 1), line('tb2', 2))),
    )
    const w = mountHost(SID_A)
    await settle(w)
    expect(text(w, 'threads')).toBe('1')

    await w.setProps({ sid: SID_B })
    await settle(w)
    expect(sessionListMock.listSessions).toHaveBeenLastCalledWith({ surface: 'btw', mainSessionId: SID_B })
    expect(text(w, 'threads')).toBe('2')
  })
})

describe('updateFor(capturedSid) 隔离（AGENTS 规则 8：迟到响应写旧分区）', () => {
  it('切会话后旧 sid 的迟到响应只写旧分区，不污染当前分区；切回恢复', async () => {
    let resolveA!: (v: SessionGroup[]) => void
    sessionListMock.listSessions.mockImplementation((q: { mainSessionId?: string }) => {
      if (q.mainSessionId === SID_A) {
        return new Promise((resolve) => {
          resolveA = resolve
        })
      }
      return Promise.resolve(groupsOf(line('tb1', 1), line('tb2', 2)))
    })
    const w = mountHost(SID_A)
    await flushPromises() // A 的拉取挂起（capture 已回写 loadSeq）
    await w.setProps({ sid: SID_B })
    await settle(w)
    expect(text(w, 'threads')).toBe('2') // 当前 = B 的线

    // A 迟到落地：若实现误用 update（当前 sid），B 分区会被覆写成 1
    resolveA(groupsOf(line('ta')))
    await settle(w)
    expect(text(w, 'threads')).toBe('2')

    // 切回 A：分区保留（迟到响应确实写进了 captured 分区）
    await w.setProps({ sid: SID_A })
    await flushPromises()
    await nextTick()
    expect(text(w, 'threads')).toBe('1')
  })
})

describe('未读计数与视口清除（D8 终态表「未读」行）', () => {
  it('非视口增长计数；线内容进视口即清；视口内不计；离开视口再计', async () => {
    sessionListMock.listSessions.mockResolvedValue(groupsOf(line('t1')))
    const w = mountHost(SID_A)
    await settle(w)
    const chat = useChatStore()

    chat.setMessages('t1', [msg('a1')])
    await settle(w)
    expect(text(w, 'unread')).toBe('1')

    // 进视口（drawer 开 btw tab + 选中该线）→ 清
    openDrawerTab('btw')
    setBtwView('t1')
    await settle(w)
    expect(text(w, 'unread')).toBe('0')

    // 视口内到达：不计
    chat.setMessages('t1', [msg('a1'), msg('a2')])
    await settle(w)
    expect(text(w, 'unread')).toBe('0')

    // 离开视口：新回复再计
    drawerControl.close()
    await settle(w)
    chat.setMessages('t1', [msg('a1'), msg('a2'), msg('a3')])
    await settle(w)
    expect(text(w, 'unread')).toBe('1')
  })

  it('多线并发增长按线 session id 各自归属 delta，不串计（线 id 路由锚）', async () => {
    sessionListMock.listSessions.mockResolvedValue(groupsOf(line('t1', 1), line('t2', 2)))
    const w = mountHost(SID_A)
    await settle(w)
    const chat = useChatStore()

    // 一次各写两条/一条：t1 delta 2、t2 delta 1，Σ = 3
    chat.setMessages('t1', [msg('a1'), msg('a2')])
    chat.setMessages('t2', [msg('b1')])
    await settle(w)
    expect(text(w, 'unread')).toBe('3')
  })

  it('各 tab 不串区：A 主线增长只计 A 分区，切到 B 归零、B 线计 B，切回 A 保留（D7③ 后台累计）', async () => {
    sessionListMock.listSessions.mockImplementation((q: { mainSessionId?: string }) =>
      Promise.resolve(q.mainSessionId === SID_A ? groupsOf(line('ta')) : groupsOf(line('tb'))),
    )
    const w = mountHost(SID_A)
    await settle(w)
    const chat = useChatStore()

    chat.setMessages('ta', [msg('a1'), msg('a2')])
    await settle(w)
    expect(text(w, 'unread')).toBe('2')

    // 切到 B：B 分区零未读（A 线的分区隔离，不串区）
    await w.setProps({ sid: SID_B })
    await settle(w)
    expect(text(w, 'unread')).toBe('0')

    // B 自己的线计自己
    chat.setMessages('tb', [msg('b1')])
    await settle(w)
    expect(text(w, 'unread')).toBe('1')

    // 切走期增长注入（杀伤锚点）：非焦点线（A 线）在 B 焦点期间增长 +1——
    // routeUnreadGrowth 按线 id 归属写 A 分区（updateFor(owner)），B 焦点计数不动；
    // 退化为写当前焦点分区的变异（update）会把增长写到 B 分区，切回 A 时丢失 → 红
    chat.setMessages('ta', [msg('a1'), msg('a2'), msg('a3')])
    await settle(w)
    expect(text(w, 'unread')).toBe('1') // B 焦点计数不因 A 线增长而变

    // 切回 A：切走期间分区保留，未读含切走期增长（2 + 1 = 3，D7③ 线后台运行、分区继续累计）
    await w.setProps({ sid: SID_A })
    await settle(w)
    expect(text(w, 'unread')).toBe('3')
  })
})

describe('虚拟 key 清理登记（M3-b 登记结构；deleteSession 消费方归 M4-a）', () => {
  it('拉取成功登记 mainSid → 线 id 映射，clearBtwVirtualKeyMapping 后出册', async () => {
    sessionListMock.listSessions.mockResolvedValue(groupsOf(line('t1', 1), line('t2', 2)))
    const w = mountHost(SID_A)
    await settle(w)

    expect(text(w, 'threads')).toBe('2') // 使用者可见部分
    expect(getBtwSessionIdsByMain(SID_A)).toEqual(['t1', 't2'])
    clearBtwVirtualKeyMapping(SID_A)
    expect(getBtwSessionIdsByMain(SID_A)).toEqual([])
  })

  it('出册线：重新拉取剪枝残留未读与登记，观察停止后不再计数', async () => {
    sessionListMock.listSessions.mockResolvedValue(groupsOf(line('t1', 1), line('t2', 2)))
    const w = mountHost(SID_A)
    // 等观察点在册（threads 派生视图到位 = syncWatchedLines 登记完成，与未读 watch 基线
    // 同拍）：per-线未读观察以「首次见到的分区长度」为基线（产品语义：初始快照内的消息
    // 不算新未读），setMessages 必须落在登记之后，否则会被基线吞掉且无重算路径。
    // 到达手段 = settle 的 macrotask 边界：refresh 链（session.list mock resolve → threads
    // 写分区 → 登记）是纯微任务链（链路各环节已核实无真实 timer），微任务清空是事件
    // 循环的构造性保证，负载只影响墙钟不影响到达——不依赖轮询窗口。
    await settle(w)
    expect(text(w, 'threads')).toBe('2')

    const chat = useChatStore()
    chat.setMessages('t2', [msg('b1')])
    await settle(w)
    expect(text(w, 'unread')).toBe('1')

    // 关线后重新拉取（抽屉活动触发范围）：权威列表只剩 t1
    sessionListMock.listSessions.mockResolvedValue(groupsOf(line('t1')))
    openDrawerTab('btw')
    await settle(w)
    expect(text(w, 'threads')).toBe('1')
    expect(text(w, 'unread')).toBe('0') // 残留未读按权威列表剪掉（视口清除支不触达：未选中线）
    expect(getBtwSessionIdsByMain(SID_A)).toEqual(['t1']) // 登记 reconcile

    // 出册线后续增长不再产生 badge 信号（观察已停）
    chat.setMessages('t2', [msg('b1'), msg('b2')])
    await settle(w)
    expect(text(w, 'unread')).toBe('0')
  })
})

describe('线终结分区处置（M4-a 消费方：reconcile 出册同拍 dispose + 单入口直调）', () => {
  it('关线重新拉取出册：线分区 + 派生 subagent 键同拍清、映射不留残留；他线/主分区不受误伤', async () => {
    sessionListMock.listSessions.mockResolvedValue(groupsOf(line('line-x')))
    const w = mountHost(SID_A)
    await settle(w)
    expect(getBtwSessionIdsByMain(SID_A)).toEqual(['line-x'])

    const chat = useChatStore()
    chat.setMessages('line-x', [msg('l1')])
    // 派生键（D9③ 中段位约定：owner = 线 piSessionId，映射即 extract）
    chat.setMessages(subagentVirtualId('line-x', 's1'), [msg('d1')])
    chat.setMessages('line-other', [msg('keep')]) // 他主名下线
    chat.setMessages(SID_A, [msg('main')]) // 主分区

    // 关线（btw.remove 同拍）→ 抽屉活动触发范围重新拉取 → 权威列表空 → 出册同拍处置（单入口幂等）
    sessionListMock.listSessions.mockResolvedValue([])
    openDrawerTab('btw')
    await settle(w)

    expect(chat.getMessages('line-x')).toHaveLength(0) // 线分区清（P-cascade 前端路径）
    expect(chat.getMessages(subagentVirtualId('line-x', 's1'))).toHaveLength(0) // 派生键清（D9④ 清派生键）
    expect(getBtwSessionIdsByMain(SID_A)).toEqual([]) // 映射不留空 set 残留（被删主迟到空拉取同口径）
    expect(chat.getMessages('line-other')).toHaveLength(1) // 非本主名下线不误伤
    expect(chat.getMessages(SID_A)).toHaveLength(1) // 主分区不误伤
  })

  it('失效路径不清键：线列表不变（闲置回收/进程亡不改 registry）→ 无出册 → 分区保留（D9④）', async () => {
    sessionListMock.listSessions.mockResolvedValue(groupsOf(line('line-alive')))
    const w = mountHost(SID_A)
    await settle(w)
    const chat = useChatStore()
    chat.setMessages('line-alive', [msg('keep')])
    chat.setMessages(subagentVirtualId('line-alive', 's1'), [msg('d')])

    openDrawerTab('btw') // 失效（回收）只杀进程——重新拉取线列表仍含该线
    await settle(w)

    expect(getBtwSessionIdsByMain(SID_A)).toEqual(['line-alive'])
    expect(chat.getMessages('line-alive')).toHaveLength(1) // 分区保留待重载链回填
    expect(chat.getMessages(subagentVirtualId('line-alive', 's1'))).toHaveLength(1)
  })

  it('disposeBtwLinePartitions 单入口：agentcall（按线 session id 挂名）+ 两 store 记录分区 + 二次调用幂等', () => {
    const chat = useChatStore()
    const workflow = useWorkflowStore()
    const subagent = useSubagentStore()
    const vid = 'line-y' // 线 session id（W4a 后 = pi 真实 id）
    chat.setMessages(vid, [msg('l')])
    chat.setMessages(subagentVirtualId('line-y', 's2'), [msg('d')])
    chat.setMessages('agentcall:acs-y', [msg('ac')])
    workflow.registerAgentCall(vid, 'agentcall:acs-y')
    subagent.applyRecords(vid, [{
      sessionFile: null, agent: 'a', slug: 's', task: 't', status: 'idle', subagentId: 's2',
    }])
    // 种数据（applyRecords 已私有化，直写分区 ref）
    workflow.recordsBySession = new Map(workflow.recordsBySession).set(vid, [{
      runId: 'r1', scriptName: 'w', status: 'running', startedAt: '2026-09-22T00:00:00.000Z',
      agentCalls: [], stateFilePath: '/tmp/wf.jsonl',
    }])
    // 前置：seed 生效（防假绿）
    expect(subagent.recordsOf(vid).value).toHaveLength(1)
    expect(workflow.recordsOf(vid).value).toHaveLength(1)
    expect(workflow.getAgentCallVirtualIdsByMain(vid)).toEqual(['agentcall:acs-y'])

    disposeBtwLinePartitions(vid)

    expect(chat.getMessages(vid)).toHaveLength(0)
    expect(chat.getMessages(subagentVirtualId('line-y', 's2'))).toHaveLength(0)
    expect(chat.getMessages('agentcall:acs-y')).toHaveLength(0) // D9 清理两半边·agentcall
    expect(workflow.getAgentCallVirtualIdsByMain(vid)).toEqual([])
    expect(subagent.recordsOf(vid).value).toHaveLength(0)
    expect(workflow.recordsOf(vid).value).toHaveLength(0)

    // 幂等：二次调用零动作不抛
    expect(() => disposeBtwLinePartitions(vid)).not.toThrow()
  })
})

describe('失效支与 badge 派生（事件帧失效一路：dialog FIFO 出队 + 行内提示置位）', () => {
  /** 经真实 bus 入账一条挂起 dialog 族请求（confirm——簿记五类之一） */
  function seedPending(vid: string, requestId: string): void {
    ensureBtwPendingBookkeeping()
    getExtensionBus().emit({
      kind: 'ui-request',
      sessionId: vid,
      request: { requestId, method: 'confirm', title: '允许执行？', message: 'm' },
    } as never)
  }

  it('badge 派生公式三分量：dialog 族挂起经 FIFO 分量点亮；store 族挂起经 extensionUIStore 分量点亮；各自出账后熄灭', () => {
    // dialog 族（confirm → FIFO 载荷）：id 镜像删除后不丢点亮（badge 派生 FIFO 分量回归锚）
    seedPending('t1', 'r1')
    expect(isBtwPending('t1')).toBe(true)
    expect(firstBtwDialogReq('t1')).toBeDefined()
    invalidateBtwRequests('t1', ['r1'], 'turn-aborted')
    expect(isBtwPending('t1')).toBe(false)

    // store 族（form → extensionUIStore 分区载荷）
    const store = useExtensionUIStore()
    store.addRequest('t2', {
      sessionId: 't2',
      requestId: 'form-1',
      method: 'select',
      form: true,
    })
    expect(isBtwPending('t2')).toBe(true)
    store.removeRequest('t2', 'form-1')
    expect(isBtwPending('t2')).toBe(false)
  })

  it('事件路：invalidated 帧命中 dialog 族挂起 → 行内提示置位 + FIFO 载荷撤下 + badge 熄灭', () => {
    seedPending('t3', 'r3')
    getExtensionBus().emit({
      kind: 'requests-invalidated',
      sessionId: 't3',
      requestIds: ['r3'],
      reason: 'turn-aborted',
    } as never)
    expect(btwExpiredNoticeOf('t3')).toBe('turn-aborted')
    expect(firstBtwDialogReq('t3')).toBeUndefined() // dialog 渲染载荷同步撤下
    expect(isBtwPending('t3')).toBe(false) // FIFO 出队后 badge 派生自动回落
  })

  it('stale 检查：requestIds 与 FIFO 无交集时零副作用（无关帧不置提示不撤载荷）', () => {
    seedPending('t4', 'r4')

    // 无关帧：无交集 → no-op
    getExtensionBus().emit({
      kind: 'requests-invalidated',
      sessionId: 't4',
      requestIds: ['other-id'],
      reason: 'turn-aborted',
    } as never)
    expect(btwExpiredNoticeOf('t4')).toBeNull()
    expect(isBtwPending('t4')).toBe(true)
    expect(firstBtwDialogReq('t4')).toBeDefined()

    // 未知 vid / 空 FIFO：no-op 不抛、无副作用
    expect(() => invalidateBtwRequests('t-none', ['x'], 'turn-aborted')).not.toThrow()
    expect(btwExpiredNoticeOf('t-none')).toBeNull()
  })

  it('清除支：新请求顶掉既有失效提示（表单重新可达）', () => {
    seedPending('t5', 'r5')
    invalidateBtwRequests('t5', ['r5'], 'turn-aborted')
    expect(btwExpiredNoticeOf('t5')).toBe('turn-aborted')

    seedPending('t5', 'r6') // 新请求到达 → 顶掉提示
    expect(btwExpiredNoticeOf('t5')).toBeNull()
    expect(isBtwPending('t5')).toBe(true)
  })
})
