/**
 * useBtwTabData 单测（btw-question M3-b：badge 数据通道 + updateFor 隔离 + 虚拟 key 清理登记）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 使用者（黑盒 DOM）：Host 把 threads 计数 / Σ unread 投影成文本节点，每条用例断言可见文本
 *   （拉取落地 / 迟到响应不串台 / 进视口清除 / 剪枝后归零）
 * - 观察者（形态）：挂载即主动拉取（不依赖广播）；线列表与 badge 数据面按主会话分区落位
 * - 构建者（白盒）：updateFor(capturedSid) 迟到响应写旧分区（规则 8 隔离）+ 虚拟 key 登记
 *   三函数（get/clear/reconcile——M4-a 消费面先写后读）+ 出册线观察停止
 *
 * mock 策略（TEST-STRATEGY §5）：vi.mock('@/api') 局部替换 btw 域（spread actual 保门面
 * 其余域，btw-panel 同款）；真实 chat store（setMessages 真实分区增长驱动未读 watch）+
 * 真实 core drawer 域（视口判定与抽屉活动触发面）。i18n 走全局 setup（本文件无文案断言）。
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
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import {
  useBtwTabData,
  getBtwVirtualIdsByMain,
  clearBtwVirtualKeyMapping,
  disposeBtwLinePartitions,
  isBtwPending,
  ensureBtwPendingBookkeeping,
  invalidateBtwRequests,
  invalidateBtwStaleFromSnapshot,
  btwExpiredNoticeOf,
  clearBtwExpiredNotice,
  firstBtwDialogReq,
  markBtwStaleInteractiveFromReplay,
  BTW_EXPIRED_REASON_SNAPSHOT_PRUNED,
  BTW_EXPIRED_REASON_REPLAY_DANGLING,
  __resetBtwPendingBookkeepingForTest,
} from '@/composables/panel/useBtwTabData'
import { getExtensionBus } from '@/composables/shell/useExtensionHostBridge'
import { dispatchGlobal, dispatchSession } from '@taiji/core/transport/api'
import { useWorkflowStore } from '@/stores/workflow'
import { useSubagentStore } from '@/stores/subagent'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { subagentVirtualId } from '@taiji/shared'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { useChatStore } from '@/stores/chat'

// ── @/api 门面局部 mock：只替换 badge 数据源 btw 域 ──
const btwMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return { ...actual, btw: btwMock }
})

const SID_A = 's-btw-data-a'
const SID_B = 's-btw-data-b'

/** 最小 Host：把 composable 暴露面投影成可见文本节点（使用者视角断言面） */
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
  btwMock.list.mockResolvedValue([])
  boundSid = ref(SID_A)
  bindDrawerSessionId(boundSid)
  _resetDrawerForTest()
  __clearSessionCleanupRegistryForTest()
  __resetBtwPendingBookkeepingForTest() // 模块级待处理簿记（含回收提醒集合 + 广播订阅）逐用例清零
  clearBtwVirtualKeyMapping(SID_A)
  clearBtwVirtualKeyMapping(SID_B)
})

describe('挂载/切会话主动拉取（broadcast 时序竞争规则：必拉不依赖广播）', () => {
  it('挂载即主动拉取 btw.list(mainSid)，线列表落当前分区', async () => {
    btwMock.list.mockResolvedValue([{ vid: 'btw:t1' }, { vid: 'btw:t2' }])
    const w = mountHost(SID_A)
    await settle(w)

    expect(btwMock.list).toHaveBeenCalledWith(SID_A)
    expect(text(w, 'threads')).toBe('2') // 用户可见：线列表投影
    expect(text(w, 'unread')).toBe('0')
  })

  it('切会话：按新 mainSid 重拉，两主会话分区互不污染', async () => {
    btwMock.list.mockImplementation((sid: string) =>
      Promise.resolve(sid === SID_A ? [{ vid: 'btw:ta' }] : [{ vid: 'btw:tb1' }, { vid: 'btw:tb2' }]),
    )
    const w = mountHost(SID_A)
    await settle(w)
    expect(text(w, 'threads')).toBe('1')

    await w.setProps({ sid: SID_B })
    await settle(w)
    expect(btwMock.list).toHaveBeenLastCalledWith(SID_B)
    expect(text(w, 'threads')).toBe('2')
  })
})

describe('updateFor(capturedSid) 隔离（AGENTS 规则 8：迟到响应写旧分区）', () => {
  it('切会话后旧 sid 的迟到响应只写旧分区，不污染当前分区；切回恢复', async () => {
    let resolveA!: (v: { vid: string }[]) => void
    btwMock.list.mockImplementation((sid: string) => {
      if (sid === SID_A) {
        return new Promise((resolve) => {
          resolveA = resolve
        })
      }
      return Promise.resolve([{ vid: 'btw:tb1' }, { vid: 'btw:tb2' }])
    })
    const w = mountHost(SID_A)
    await flushPromises() // A 的拉取挂起（capture 已回写 loadSeq）
    await w.setProps({ sid: SID_B })
    await settle(w)
    expect(text(w, 'threads')).toBe('2') // 当前 = B 的线

    // A 迟到落地：若实现误用 update（当前 sid），B 分区会被覆写成 1
    resolveA([{ vid: 'btw:ta' }])
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
    btwMock.list.mockResolvedValue([{ vid: 'btw:t1' }])
    const w = mountHost(SID_A)
    await settle(w)
    const chat = useChatStore()

    chat.setMessages('btw:t1', [msg('a1')])
    await settle(w)
    expect(text(w, 'unread')).toBe('1')

    // 进视口（drawer 开 btw tab + 选中该线）→ 清
    openDrawerTab('btw')
    drawerControl.setBtwView('btw:t1')
    await settle(w)
    expect(text(w, 'unread')).toBe('0')

    // 视口内到达：不计
    chat.setMessages('btw:t1', [msg('a1'), msg('a2')])
    await settle(w)
    expect(text(w, 'unread')).toBe('0')

    // 离开视口：新回复再计
    drawerControl.close()
    await settle(w)
    chat.setMessages('btw:t1', [msg('a1'), msg('a2'), msg('a3')])
    await settle(w)
    expect(text(w, 'unread')).toBe('1')
  })
})

describe('回收提醒消费接线（D1 renderer 半边：reclaimImminent 两路解析点 → badge 待处理聚合）', () => {
  it('拉取 reply 携带 reclaimImminent=true → 集合命中 + 待处理聚合计数用户可见；缺省线不计', async () => {
    btwMock.list.mockResolvedValue([
      { vid: 'btw:t1', reclaimImminent: true },
      { vid: 'btw:t2' }, // 可选字段缺省 = 无提醒（防破坏既有消费）
    ])
    const w = mountHost(SID_A)
    await settle(w)

    expect(isBtwPending('btw:t1')).toBe(true) // 集合命中（白盒：reclaimReminderVids）
    expect(isBtwPending('btw:t2')).toBe(false)
    expect(text(w, 'pending')).toBe('1') // 用户可见：badge 待处理聚合（totalPending）
    expect(text(w, 'threads')).toBe('2')
  })

  it('state 帧广播翻转 false（live 帧 payload 无 sessionId → global 通道路由）→ 集合清除、聚合计数回落', async () => {
    btwMock.list.mockResolvedValue([{ vid: 'btw:t1', reclaimImminent: true }])
    const w = mountHost(SID_A)
    await settle(w)
    expect(text(w, 'pending')).toBe('1')

    // runtime onWillReclaim/onThreadStateChanged 置位/清除同发的 live 广播（双通道同 payload）
    dispatchGlobal({
      type: 'btw.list',
      payload: { mainSid: SID_A, threads: [{ vid: 'btw:t1', reclaimImminent: false }] },
    })
    await settle(w)

    expect(isBtwPending('btw:t1')).toBe(false) // 集合清除
    expect(text(w, 'pending')).toBe('0') // 聚合回落（用户可见）
  })

  it('stateSnapshot 回放腿（session 通道，重连/切回按订阅 sid 分发）：广播置位 true → 集合命中、聚合计数上升', async () => {
    btwMock.list.mockResolvedValue([{ vid: 'btw:t1' }]) // 拉取时无提醒
    const w = mountHost(SID_A)
    await settle(w)
    expect(text(w, 'pending')).toBe('0')

    dispatchSession(SID_A, {
      type: 'btw.list',
      payload: { mainSid: SID_A, threads: [{ vid: 'btw:t1', reclaimImminent: true }] },
    })
    await settle(w)

    expect(isBtwPending('btw:t1')).toBe(true)
    expect(text(w, 'pending')).toBe('1') // 聚合上升（用户可见）
  })
})

describe('虚拟 key 清理登记（M3-b 登记结构；deleteSession 消费面归 M4-a）', () => {
  it('拉取成功登记 mainSid → vid 映射，clearBtwVirtualKeyMapping 后出册', async () => {
    btwMock.list.mockResolvedValue([{ vid: 'btw:t1' }, { vid: 'btw:t2' }])
    const w = mountHost(SID_A)
    await settle(w)

    expect(text(w, 'threads')).toBe('2') // 使用者可见面
    expect(getBtwVirtualIdsByMain(SID_A)).toEqual(['btw:t1', 'btw:t2'])
    clearBtwVirtualKeyMapping(SID_A)
    expect(getBtwVirtualIdsByMain(SID_A)).toEqual([])
  })

  it('出册线：重拉剪枝残留未读与登记，观察停止后不再计数', async () => {
    btwMock.list.mockResolvedValue([{ vid: 'btw:t1' }, { vid: 'btw:t2' }])
    const w = mountHost(SID_A)
    await settle(w)
    const chat = useChatStore()

    chat.setMessages('btw:t2', [msg('b1')])
    await settle(w)
    expect(text(w, 'unread')).toBe('1')

    // 关线后重拉（抽屉活动触发面）：权威列表只剩 t1
    btwMock.list.mockResolvedValue([{ vid: 'btw:t1' }])
    openDrawerTab('btw')
    await settle(w)
    expect(text(w, 'threads')).toBe('1')
    expect(text(w, 'unread')).toBe('0') // 残留未读按权威列表剪掉（视口清除支不触达：未选中线）
    expect(getBtwVirtualIdsByMain(SID_A)).toEqual(['btw:t1']) // 登记 reconcile

    // 出册线后续增长不再产生 badge 信号（观察已停）
    chat.setMessages('btw:t2', [msg('b1'), msg('b2')])
    await settle(w)
    expect(text(w, 'unread')).toBe('0')
  })
})

describe('线终结分区处置（M4-a 消费面：reconcile 出册同拍 dispose + 单入口直调）', () => {
  it('关线重拉出册：线分区 + 派生 subagent 键同拍清、映射不留残留；他线/主分区不受误伤', async () => {
    btwMock.list.mockResolvedValue([{ vid: 'btw:line-x' }])
    const w = mountHost(SID_A)
    await settle(w)
    expect(getBtwVirtualIdsByMain(SID_A)).toEqual(['btw:line-x'])

    const chat = useChatStore()
    chat.setMessages('btw:line-x', [msg('l1')])
    // 派生键（D9③ 中段位约定：owner = 线 piSessionId，映射即 extract）
    chat.setMessages(subagentVirtualId('line-x', 's1'), [msg('d1')])
    chat.setMessages('btw:line-other', [msg('keep')]) // 他主名下线
    chat.setMessages(SID_A, [msg('main')]) // 主分区

    // 关线（btw.remove 同拍）→ 抽屉活动触发面重拉 → 权威列表空 → 出册同拍处置（单入口幂等）
    btwMock.list.mockResolvedValue([])
    openDrawerTab('btw')
    await settle(w)

    expect(chat.getMessages('btw:line-x')).toHaveLength(0) // 线分区清（P-cascade 前端腿）
    expect(chat.getMessages(subagentVirtualId('line-x', 's1'))).toHaveLength(0) // 派生键清（D9④ 清派生键）
    expect(getBtwVirtualIdsByMain(SID_A)).toEqual([]) // 映射不留空 set 残留（被删主迟到空拉取同口径）
    expect(chat.getMessages('btw:line-other')).toHaveLength(1) // 非本主名下线不误伤
    expect(chat.getMessages(SID_A)).toHaveLength(1) // 主分区不误伤
  })

  it('失效腿不清键：线列表不变（闲置回收/进程亡不改 registry）→ 无出册 → 分区保留（D9④）', async () => {
    btwMock.list.mockResolvedValue([{ vid: 'btw:line-alive' }])
    const w = mountHost(SID_A)
    await settle(w)
    const chat = useChatStore()
    chat.setMessages('btw:line-alive', [msg('keep')])
    chat.setMessages(subagentVirtualId('line-alive', 's1'), [msg('d')])

    openDrawerTab('btw') // 失效（回收）只杀进程——重拉线列表仍含该线
    await settle(w)

    expect(getBtwVirtualIdsByMain(SID_A)).toEqual(['btw:line-alive'])
    expect(chat.getMessages('btw:line-alive')).toHaveLength(1) // 分区保留待重载链回填
    expect(chat.getMessages(subagentVirtualId('line-alive', 's1'))).toHaveLength(1)
  })

  it('disposeBtwLinePartitions 单入口：agentcall（按线 vid 挂名）+ 两 store 记录分区 + 二次调用幂等', () => {
    const chat = useChatStore()
    const workflow = useWorkflowStore()
    const subagent = useSubagentStore()
    const vid = 'btw:line-y'
    chat.setMessages(vid, [msg('l')])
    chat.setMessages(subagentVirtualId('line-y', 's2'), [msg('d')])
    chat.setMessages('agentcall:acs-y', [msg('ac')])
    workflow.registerAgentCall(vid, 'agentcall:acs-y')
    subagent.applyRecords(vid, [{
      sessionFile: null, agent: 'a', slug: 's', task: 't', status: 'idle', subagentId: 's2',
    }])
    workflow.applyRecords(vid, [{
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

describe('失效支单入口（两路合并收口：事件路薄委托 + 快照修剪路共用 invalidateBtwRequests）', () => {
  /** 经真实 bus 入账一条挂起 dialog 族请求（confirm——簿记五类之一） */
  function seedPending(vid: string, requestId: string): void {
    ensureBtwPendingBookkeeping()
    getExtensionBus().emit({
      kind: 'ui-request',
      sessionId: vid,
      request: { requestId, method: 'confirm', title: '允许执行？', message: 'm' },
    } as never)
  }

  it('快照修剪路：簿记有、keepIds 无 → 失效提示置位 + 待处理出账 + dialog 载荷撤下', () => {
    seedPending('btw:t1', 'r1')
    expect(isBtwPending('btw:t1')).toBe(true)
    expect(firstBtwDialogReq('btw:t1')).toBeDefined()

    invalidateBtwStaleFromSnapshot('btw:t1', new Set(['other-id']), BTW_EXPIRED_REASON_SNAPSHOT_PRUNED)

    expect(btwExpiredNoticeOf('btw:t1')).toBe(BTW_EXPIRED_REASON_SNAPSHOT_PRUNED)
    expect(isBtwPending('btw:t1')).toBe(false) // 挂起簿记出账（badge 待处理随之清）
    expect(firstBtwDialogReq('btw:t1')).toBeUndefined() // dialog 渲染载荷同步撤下
  })

  it('正例保护：快照仍含的请求不置提示、保持挂起；未知 vid / 空簿记 no-op', () => {
    seedPending('btw:t2', 'r2')

    invalidateBtwStaleFromSnapshot('btw:t2', new Set(['r2']), BTW_EXPIRED_REASON_SNAPSHOT_PRUNED)
    expect(btwExpiredNoticeOf('btw:t2')).toBeNull() // 快照仍含 → 不置提示
    expect(isBtwPending('btw:t2')).toBe(true)

    // 未知 vid / 空簿记：no-op 不抛、无副作用
    expect(() => invalidateBtwStaleFromSnapshot('btw:t-none', new Set(), BTW_EXPIRED_REASON_SNAPSHOT_PRUNED)).not.toThrow()
    expect(() => invalidateBtwRequests('btw:t-none', ['x'], 'turn-aborted')).not.toThrow()
    expect(btwExpiredNoticeOf('btw:t-none')).toBeNull()
  })

  it('事件路与修剪路同函数收口：invalidated 事件置位后，修剪差集空不覆盖既有提示', () => {
    seedPending('btw:t3', 'r3')
    getExtensionBus().emit({
      kind: 'requests-invalidated',
      sessionId: 'btw:t3',
      requestIds: ['r3'],
      reason: 'turn-aborted',
    } as never)
    expect(btwExpiredNoticeOf('btw:t3')).toBe('turn-aborted')
    expect(isBtwPending('btw:t3')).toBe(false)

    // 簿记已空 → 修剪差集为空 → 既有提示不被覆盖/清除
    invalidateBtwStaleFromSnapshot('btw:t3', new Set(), BTW_EXPIRED_REASON_SNAPSHOT_PRUNED)
    expect(btwExpiredNoticeOf('btw:t3')).toBe('turn-aborted')
  })
})

describe('回放对账路（markBtwStaleInteractiveFromReplay：持久层悬空交互请求 toolCall → 失效提示）', () => {
  /**
   * 回放投影音形的 assistant 消息（apply-entry-convert collectToolCallPart 构造形态）：
   * 悬空 toolCall = 无 output 字段（fillHostToolCall 只对已闭合 toolCall 无条件回填
   * `output: string`，空串也算闭合——V8 已接受面「悬空调用定格 completed 无产出」）。
   * **红线（上轮教训）**：主用例禁止 seed 簿记伪造前提——整机杀重启后簿记恒为空。
   */
  function replayedAssistantMsg(id: string, toolName: string, closedOutput?: string): Message {
    return {
      id,
      role: 'assistant',
      content: '',
      status: 'complete',
      timestamp: 0,
      toolCalls: [
        {
          id: `${id}-tc`,
          toolName,
          input: {},
          status: 'completed',
          startTime: 0,
          ...(closedOutput !== undefined && { output: closedOutput }),
        },
      ],
    }
  }

  /** 经真实 bus 入账一条挂起 dialog 族请求（存活挂起守卫的簿记半边） */
  function seedPending(vid: string, requestId: string): void {
    ensureBtwPendingBookkeeping()
    getExtensionBus().emit({
      kind: 'ui-request',
      sessionId: vid,
      request: { requestId, method: 'confirm', title: '允许执行？', message: 'm' },
    } as never)
  }

  it('整机重启形态（红线）：簿记为空 + 投影含悬空 ask_user toolCall → 提示置位，无簿记出账', () => {
    // 不 seedPending：模拟整机杀重启后首轮回放（模块簿记与 runtime pending 同时清零）
    markBtwStaleInteractiveFromReplay('btw:replay-1', [
      { id: 'u1', role: 'user', content: '帮我查下', status: 'complete', timestamp: 0 },
      replayedAssistantMsg('a1', 'ask_user'),
    ])

    expect(btwExpiredNoticeOf('btw:replay-1')).toBe(BTW_EXPIRED_REASON_REPLAY_DANGLING)
    expect(isBtwPending('btw:replay-1')).toBe(false) // 只写提示不出账（簿记本来就没账可出）
  })

  it('名单窄而准：悬空普通工具（bash）不置提示；闭合的交互请求（output 已回填）不置提示', () => {
    markBtwStaleInteractiveFromReplay('btw:replay-2', [replayedAssistantMsg('a2', 'bash')])
    expect(btwExpiredNoticeOf('btw:replay-2')).toBeNull()

    // 闭合 = output 有值（空串也算闭合——fillHostToolCall 无条件回填 string）
    markBtwStaleInteractiveFromReplay('btw:replay-3', [replayedAssistantMsg('a3', 'ask_user', '')])
    expect(btwExpiredNoticeOf('btw:replay-3')).toBeNull()
  })

  it('存活挂起守卫：簿记/store 族仍有该线挂起请求 = 请求尚待应答，悬空只是未闭合 → 不置提示', () => {
    // 簿记半边：agent ask_user 提问帧已到达（dialog 族入簿记），用户此刻才打开线触发回放
    seedPending('btw:replay-4', 'live-1')
    markBtwStaleInteractiveFromReplay('btw:replay-4', [replayedAssistantMsg('a4', 'ask_user')])
    expect(btwExpiredNoticeOf('btw:replay-4')).toBeNull()

    // store 族半边（form/planReview 分区）同样短路
    const store = useExtensionUIStore()
    store.addRequest('btw:replay-5', {
      sessionId: 'btw:replay-5',
      requestId: 'live-form-1',
      method: 'select',
      form: true,
    })
    markBtwStaleInteractiveFromReplay('btw:replay-5', [replayedAssistantMsg('a5', 'schedule')])
    expect(btwExpiredNoticeOf('btw:replay-5')).toBeNull()
  })

  it('幂等：重复回放重复置位同值不翻动；dismiss 后同痕迹重放仍可再置', () => {
    const msgs = [replayedAssistantMsg('a6', 'plan')]
    markBtwStaleInteractiveFromReplay('btw:replay-6', msgs)
    expect(btwExpiredNoticeOf('btw:replay-6')).toBe(BTW_EXPIRED_REASON_REPLAY_DANGLING)
    clearBtwExpiredNotice('btw:replay-6')

    // 用户 dismiss 后再次回放（同持久痕迹）→ 重新置位（痕迹仍在文件里，提示语义仍成立）
    markBtwStaleInteractiveFromReplay('btw:replay-6', msgs)
    expect(btwExpiredNoticeOf('btw:replay-6')).toBe(BTW_EXPIRED_REASON_REPLAY_DANGLING)
  })
})
