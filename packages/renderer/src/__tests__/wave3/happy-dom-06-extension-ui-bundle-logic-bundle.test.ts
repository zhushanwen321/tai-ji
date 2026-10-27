import { detectFileKind, extToLang } from '@/composables/logic/file-type';
import { cycleTabFocus, getFocusableElements, FOCUSABLE_SELECTOR } from '@/composables/logic/focus-trap';
import type { MessageTurn } from '@/composables/logic/messageTurns';
import { summarizeTurnForRail, summarizeAssistantForRail } from '@/composables/logic/summarizeTurn';
import { __resetBtwLineMembershipForTest, noteBtwLinesPulled } from '@/composables/panel/btw-line-membership';
import { isBtwPending, invalidateBtwRequests, btwExpiredNoticeOf, firstBtwDialogReq } from '@/composables/panel/btw-pending-bookkeeping';
import { useBtwTabData, getBtwSessionIdsByMain, clearBtwVirtualKeyMapping, disposeBtwLinePartitions, ensureBtwPendingBookkeeping, __resetBtwPendingBookkeepingForTest } from '@/composables/panel/useBtwTabData';
import * as bridge from '@/composables/shell/useExtensionHostBridge';
import { getExtensionBus, initExtensionHostBridge, __testing as bridgeTesting, HEADER_ACTIONS_SOURCE_KEY, type HeaderActionsSource } from '@/composables/shell/useExtensionHostBridge';
import { useExtensionUI, __testing } from '@/composables/useExtensionUI';
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState';
import { useChatStore } from '@/stores/chat';
import { useExtensionUIStore } from '@/stores/extension-ui';
import { useSubagentStore } from '@/stores/subagent';
import { useWorkflowStore } from '@/stores/workflow';
import { InternalEventBus, MessageBusBridge, type IncomingPluginMessage, type PluginMessageSource } from '@taiji/core';
import { bindDrawerSessionId, drawerControl, openDrawerTab, setBtwView, _resetDrawerForTest } from '@taiji/core/domain/drawer';
import { sendExtensionUIResponse } from '@taiji/core/transport/api/domains/extension';
import { type Message, subagentVirtualId } from '@taiji/shared';
import { flushPromises, mount, enableAutoUnmount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computed, createApp, defineComponent, effectScope, inject, nextTick, ref, type Ref } from 'vue';

// wave3 簇 [renderer/happy-dom] 2 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/composables/extension-ui-bundle.test.ts
 * - composables/logic/__tests__/logic-bundle.test.ts
 */

// ======================================================================
// ← __tests__/composables/extension-ui-bundle.test.ts
// ======================================================================

/**
 * extension UI 域合并产物（round 5-G U7）：三文件同产物，环境全默认（happy-dom；
 * pending-send / plugin-points-wiring 原为 node 环境，纯 bus/store 逻辑无 DOM 依赖，
 * 迁移实证兼容）。
 *
 * 并入来源（基名）：
 *  - panel/use-btw-tab-data（btw badge 数据通道 + updateFor 隔离，15 例；跨目录自
 *    composables/panel/ 搬入）
 *  - use-extension-ui-pending-send（respond 分型锚点 + invalidated 清除，13 例）
 *  - extension-host-plugin-points-wiring（桥接线测试 u4b，5 例）
 *
 * mock 注册与 U7 解锁改造记录：
 *  - '@/api'（use-btw-tab-data 节）：保留式 spread + 仅覆写 btw.create/remove、
 *    chat.getHistory 桩、session.listSessions（原文件已是该形态，照搬）。
 *  - '@taiji/core/transport/api/domains/extension'（pending-send 节 4 键窄 mock）：保留——
 *    已核 extension-ui store 只 import 类型、btw-bookkeeping / useBtwTabData /
 *    useExtensionHostBridge 链均不消费该域运行时成员，无泄漏危害。
 *  - '@/composables/features/command/useCommandStore'（plugin-points 节窄 mock）：
 *    仅桥 initExtensionHostBridge 内消费，btw / pending-send 节不 init 桥，无泄漏。
 *  - **改造**（原 pending-send 的两处模块 mock 撤销，改节内 spy）：
 *    ① '@/stores/chat' 窄 mock（useChatStore 仅返回 clearPendingSend）撤销——use-btw-tab-data
 *    节三处 useChatStore() 需要真实 store 全成员（波 1 登记的互斥根因）。pending-send 节改在
 *    beforeEach 对真实 store 实例 spyOn clearPendingSend（useExtensionUI 内部调用形态为
 *    useChatStore().clearPendingSend(sid)，同 pinia 同实例，spy 生效）。
 *    ② '@/composables/shell/useExtensionHostBridge' 模块 mock（getExtensionBus → mockBus）
 *    撤销——use-btw-tab-data 节（seedPending/簿记订阅）与 plugin-points 节（initBridge 后
 *    bus.emit 断言桥链）都依赖真实 getExtensionBus，模块级覆写会让两节拿到脱离真实桥的
    bus。pending-send 节改 beforeEach spy 模块对象的 getExtensionBus 返回节内 mockBus，
 *    afterEach restoreAllMocks 复位（spy 模块导出形态先例：chat-shell-bundle 的
 *    spyOn(events, 'onGlobalType')）。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/composables/extension-ui-bundle.test.ts
 */
// ── use-btw-tab-data 节的 '@/api' 门面局部 mock：替换 badge 数据源（W4b 起 =
//    session.listSessions）+ 回放链 getHistory 桩 ──
// btw 域本节不再直接消费（线枚举走 session.list {surface:'btw', mainSessionId}）。
const sessionListMock = vi.hoisted(() => ({
  listSessions: vi.fn(),
}))
// getHistory 桩（微任务即回的空历史，语义 = 线从未 flush）：drawer 开 + 选中线会触发
// stores/btw-replay 的真实回放链，mock transport 的 TIMING.ack 是 40ms setTimeout
//（settle 只冲刷微任务，等不到它），迟到的空历史 hydrate 会清掉用例刚 seed 的线分区、
// 未读 watch 的 prev 基线随之归零——重负载下定时器落点漂移，未读计数随机翻错。
// 本节断言范围是 badge 计数不是回放，桩成同步空历史后回放链不再产生墙钟竞争。
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

// ── pending-send 节的 extension 域 mock（照 useExtensionUI.test.ts 形态）──
vi.mock('@taiji/core/transport/api/domains/extension', () => ({
  // 返 true = 送达；断连场景用例单独 mockReturnValueOnce(false)
  sendExtensionUIResponse: vi.fn((): boolean => true),
  onNotify: () => () => {},
  onExtensions: vi.fn(),
  getPendingRequests: vi.fn().mockResolvedValue([]),
}))

// ── plugin-points 节的 commandStore 窄 mock：bridge 测试不注入平台端口，
//    stub 掉判定输入（仅 initExtensionHostBridge 内消费）──
vi.mock('@/composables/features/command/useCommandStore', () => ({
  useCommandStore: () => ({ getCommands: () => [] as Array<{ name: string }> }),
}))

// ══════════ 来源节：panel/use-btw-tab-data（原文件顶层 hook / enableAutoUnmount 下沉包裹层内）══════════

describe('useBtwTabData（use-btw-tab-data 合并节）', () => {
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
        dialogKind: 'select',
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
})

// ══════════ 来源节：use-extension-ui-pending-send（原 node 环境文件；U7 改造：
// 撤销 @/stores/chat 与 useExtensionHostBridge 两处模块 mock，改节内 spy）══════════

describe('useExtensionUI respond 分型（use-extension-ui-pending-send 合并节）', () => {
  // ── clearPendingSend 因果断言锚（由节内 beforeEach spy 真实 chat store 实例转发
  //    到这里；mock 已撤销、不进 vi.mock 工厂，无需 hoisted）──
  const chatStoreMocks = { clearPendingSend: vi.fn() }

  // ── mockBus：节内真实 InternalEventBus 实例（U7 改造：原模块 mock getExtensionBus
  //    撤销，beforeEach 经 vi.spyOn(bridge, 'getExtensionBus') 返回本实例）──
  let mockBus: InternalEventBus

  /** 在独立 effectScope 内运行，模拟单 Panel 实例的完整生命周期 */
  function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
    const scope = effectScope()
    let result!: T
    scope.run(() => {
      result = fn()
    })
    return { result, dispose: () => scope.stop() }
  }

  /** 统一表单请求（runtime marker 分支产出的 view-ready 帧形状，form 键原生携带） */
  function mkFormReq(requestId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      requestId,
      pluginId: 'p',
      kind: 'select',
      dialogKind: 'select',
      title: 't',
      form: true,
      formQuestions: [{ type: 'text', header: 'q', question: 'q?' }],
      allowCancel: true,
      ...overrides,
    }
  }

  function emitBusUIRequest(sid: string, request: unknown): void {
    mockBus.emit({ kind: 'ui-request', sessionId: sid, request } as never)
  }

  function emitBusRequestsInvalidated(sid: string, requestIds: string[], reason: string): void {
    mockBus.emit({ kind: 'requests-invalidated', sessionId: sid, requestIds, reason } as never)
  }

  beforeEach(() => {
    __testing.__resetExtensionBusSubscriptionForTesting()
    setActivePinia(createPinia())
    mockBus = new InternalEventBus()
    // U7 改造①：getExtensionBus 节内 spy → mockBus（原模块 mock 撤销，恢复真实桥给
    // use-btw-tab-data / plugin-points 两节用；afterEach restoreAllMocks 复位）
    vi.spyOn(bridge, 'getExtensionBus').mockReturnValue(mockBus)
    // U7 改造②：真实 chat store 实例上 spy clearPendingSend → 断言锚单例（原模块窄 mock
    // 撤销，use-btw-tab-data 节需要真实 store 全成员）
    vi.spyOn(useChatStore(), 'clearPendingSend').mockImplementation(chatStoreMocks.clearPendingSend)
    vi.mocked(sendExtensionUIResponse).mockClear()
    chatStoreMocks.clearPendingSend.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('① cancel 型（result=null）respond 送达后收尾 pendingSend（D1 采用项 1）', () => {
    it('respond(requestId, null) 送达 → removeRequest + clearPendingSend(sid)', () => {
      const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

      emitBusUIRequest('sessionA', mkFormReq('r-cancel'))
      expect(result.currentFormRequest.value?.requestId).toBe('r-cancel')

      result.respond('r-cancel', null)

      // 送达 + 出队（现状行为不回归）
      expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-cancel', 'select', null)
      expect(useExtensionUIStore().getRequestsBySession('sessionA')).toEqual([])
      // cancel 型清除锚点：按请求归属 sid 收尾假忙窗口
      expect(chatStoreMocks.clearPendingSend).toHaveBeenCalledTimes(1)
      expect(chatStoreMocks.clearPendingSend).toHaveBeenCalledWith('sessionA')
      dispose()
    })

    it('cancel() 便捷函数（Esc / 取消按钮同链）等价触发清除', () => {
      const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

      emitBusUIRequest('sessionA', mkFormReq('r-esc'))
      result.cancel('r-esc')

      expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-esc', 'select', null)
      expect(chatStoreMocks.clearPendingSend).toHaveBeenCalledTimes(1)
      expect(chatStoreMocks.clearPendingSend).toHaveBeenCalledWith('sessionA')
      dispose()
    })
  })

  describe('② 提交型（result≠null）不清——pendingSend 桥接 message_start（现状语义保留）', () => {
    it('respond(requestId, 表单 answers JSON string) 送达 → 不调 clearPendingSend', () => {
      const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

      emitBusUIRequest('sessionA', mkFormReq('r-submit'))
      const answers = JSON.stringify({ title: '任务' })

      result.respond('r-submit', answers)

      // 送达 + 出队照常（respond 主路径不回归），仅清除锚点分型跳过
      expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-submit', 'select', answers)
      expect(useExtensionUIStore().getRequestsBySession('sessionA')).toEqual([])
      expect(chatStoreMocks.clearPendingSend).not.toHaveBeenCalled()
      dispose()
    })

    it('boolean 检查格：respond(requestId, false) 非 null 同样不清（判据严格 === null，非 falsy）', () => {
      const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

      emitBusUIRequest('sessionA', mkFormReq('r-bool'))
      result.respond('r-bool', false)

      expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-bool', 'select', false)
      expect(chatStoreMocks.clearPendingSend).not.toHaveBeenCalled()
      dispose()
    })
  })

  describe('⑤ expectTurn 三态矩阵（form-submit-busy-convergence 场景 7，6 格）', () => {
    // 矩阵 = {result null / 非 null} × {expectTurn true / undefined / false}：
    // - result=null → 清恒定（3 格，cancel 型语义不依赖 expectTurn）
    // - result≠null + true/undefined → 不清（2 格，桥接 message_start 照旧；
    //   undefined = 存量扩展缺省态，truthy 简化（!expectTurn）会把这两格误清——D2 不采用其余方案的理由）
    // - result≠null + false → 清（1 格，命令 handler 内 select 提交即收尾，消除 30s 假忙）
    // result 非 null 格取表单 answers JSON string（提交型主流形态，对齐 ② 用例输入范围）；
    // 该输入范围同时是 toExtensionUIRequest expectTurn 透传（D1 段 4）的因果断言——透传断
    // 链时 false 格必然翻红。经 bus 帧入队（真实透传链），非直写 store。
    const answers = JSON.stringify({ title: '任务' })
    const matrix: Array<{
      label: string
      requestId: string
      result: string | null
      frameExpectTurn?: boolean
      expectCleared: boolean
    }> = [
      { label: 'null × true', requestId: 'r-m1', result: null, frameExpectTurn: true, expectCleared: true },
      { label: 'null × undefined', requestId: 'r-m2', result: null, frameExpectTurn: undefined, expectCleared: true },
      { label: 'null × false', requestId: 'r-m3', result: null, frameExpectTurn: false, expectCleared: true },
      { label: '非null × true', requestId: 'r-m4', result: answers, frameExpectTurn: true, expectCleared: false },
      { label: '非null × undefined', requestId: 'r-m5', result: answers, frameExpectTurn: undefined, expectCleared: false },
      { label: '非null × false', requestId: 'r-m6', result: answers, frameExpectTurn: false, expectCleared: true },
    ]

    it.each(matrix)(
      '$label → clearPendingSend 调用 = $expectCleared',
      ({ requestId, result, frameExpectTurn, expectCleared }) => {
        const { result: ui, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

        // undefined 格省键（对齐 event-adapter 条件落键形态——帧上不出现该键）
        emitBusUIRequest(
          'sessionA',
          mkFormReq(requestId, frameExpectTurn !== undefined ? { expectTurn: frameExpectTurn } : {}),
        )
        ui.respond(requestId, result)

        // 主路径不回归：送达 + 出队对全部 6 格恒成立（分型只影响清除锚点）
        expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', requestId, 'select', result)
        expect(useExtensionUIStore().getRequestsBySession('sessionA')).toEqual([])

        if (expectCleared) {
          expect(chatStoreMocks.clearPendingSend).toHaveBeenCalledTimes(1)
          expect(chatStoreMocks.clearPendingSend).toHaveBeenCalledWith('sessionA')
        } else {
          expect(chatStoreMocks.clearPendingSend).not.toHaveBeenCalled()
        }
        dispose()
      },
    )
  })

  describe('③ delivered=false（WS 断连）不清——锚点只挂送达成功后（现状保留路径）', () => {
    it('send 返 false → removeRequest 与 clearPendingSend 均不调，请求保留', () => {
      const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

      emitBusUIRequest('sessionA', mkFormReq('r-drop'))
      vi.mocked(sendExtensionUIResponse).mockReturnValueOnce(false)

      result.cancel('r-drop')

      expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-drop', 'select', null)
      // 断连期请求保留（FormOverlay 不消失，现状行为）+ pendingSend 不收尾
      //（表单仍占输入范围，假忙窗口不暴露——设计 §3.1 失败路径语义）
      expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(1)
      expect(chatStoreMocks.clearPendingSend).not.toHaveBeenCalled()
      dispose()
    })
  })

  describe('④ requests-invalidated 广播按帧 sid 清（D1 采用项 2 / 探针 P-fh5）', () => {
    it('invalidated 帧 → 该 sid 请求移除 + clearPendingSend(帧 sid)', () => {
      const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

      emitBusUIRequest('sessionA', mkFormReq('r-inv'))
      expect(result.currentFormRequest.value?.requestId).toBe('r-inv')

      emitBusRequestsInvalidated('sessionA', ['r-inv'], 'reclaimed')

      // 表单移除（P2-2 既有行为）+ pendingSend 收尾（D1 新增锚点）
      expect(result.currentFormRequest.value).toBeUndefined()
      expect(useExtensionUIStore().getRequestsBySession('sessionA')).toEqual([])
      expect(chatStoreMocks.clearPendingSend).toHaveBeenCalledTimes(1)
      expect(chatStoreMocks.clearPendingSend).toHaveBeenCalledWith('sessionA')
      dispose()
    })

    it('帧 sid 缺失 → 不清（跳过，与 removeRequest 同一检查）', () => {
      runWithScope(() => useExtensionUI(ref('sessionA')))

      // 事件契约 sessionId 可选；缺失帧整体跳过（无 sid 可清）
      mockBus.emit({ kind: 'requests-invalidated', requestIds: ['r-nosid'], reason: 'reclaimed' } as never)

      expect(chatStoreMocks.clearPendingSend).not.toHaveBeenCalled()
    })
  })
})

// ══════════ 来源节：extension-host-plugin-points-wiring（原 node 环境文件；节内 hook 原样）══════════

describe('useExtensionHostBridge plugin points wiring (u4b)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  function initBridge() {
    const app = createApp({ render: () => null })
    initExtensionHostBridge(app)
    const handles = bridgeTesting.lastInitHandles
    if (!handles) throw new Error('initExtensionHostBridge did not record handles')
    return { app, bus: getExtensionBus(), contributions: handles.contributions }
  }

  it('订阅链：plugin:headerActionUpdate 帧 → per-session 分区镜像（provide source 消费）', () => {
    const { app, bus } = initBridge()
    bus.emit({
      kind: 'plugin:headerActionUpdate',
      headerAction: { pluginId: 'scheduler-manager', headerActionId: 'scheduler-manager.open', sessionId: 's1', badge: '7', disabled: false },
    })
    const source = app.runWithContext(() => inject(HEADER_ACTIONS_SOURCE_KEY)) as HeaderActionsSource
    expect(source).not.toBeNull()
    expect(source.getRuntimeState('s1', 'scheduler-manager.open')?.badge).toBe('7')
    expect(source.getRuntimeState('s2', 'scheduler-manager.open')).toBeUndefined()
  })

  it('丢帧出声（renderer 复核）：bridge 对新帧 emit 对应事件、未知 type emit error', () => {
    const bus = new InternalEventBus()
    const seen: string[] = []
    bus.on('plugin:headerActionUpdate', () => seen.push('headerActionUpdate'))
    bus.on('error', () => seen.push('error'))
    let handler: ((msg: IncomingPluginMessage) => void) | null = null
    const source: PluginMessageSource = { subscribe: (h) => { handler = h; return () => { handler = null } } }
    new MessageBusBridge({ source, bus })
    handler!({ type: 'plugin:headerActionUpdate', payload: { pluginId: 'p1', headerActionId: 'p1.open', sessionId: 's1' } })
    expect(seen).toEqual(['headerActionUpdate'])
    handler!({ type: 'plugin:notRegisteredAnywhere', payload: {} })
    expect(seen).toEqual(['headerActionUpdate', 'error'])
  })

  it('E2：crashed → 声明镜像清；active → registerBuiltin 静态表重放（按钮恢复）', async () => {
    const { bus, contributions } = initBridge()
    // bootstrap step5 等价：builtin 声明注册（含 scheduler-manager）
    contributions.registerBuiltin()
    expect(contributions.getContributions({ type: 'headerAction', pluginId: 'scheduler-manager' })).toHaveLength(1)

    bus.emit({ kind: 'plugin-crashed', pluginId: 'scheduler-manager' })
    await nextTick()
    // E2：headerAction 声明消失（按钮消失）
    expect(contributions.getContributions({ type: 'headerAction' })).toEqual([])

    // 用户重启用 → 静态表重放（registerBuiltin），按钮回来
    bus.emit({ kind: 'plugin-status-change', pluginId: 'scheduler-manager', status: 'active' })
    await nextTick()
    const restored = contributions.getContributions({ type: 'headerAction', pluginId: 'scheduler-manager' })
    expect(restored.map((c) => c.contributionId)).toEqual(['scheduler-manager.open'])
  })

  it('E2：statusChange inactive（禁用）→ 声明清 + 命令注销（E13 灰置的清理侧）', () => {
    const { bus, contributions } = initBridge()
    contributions.registerBuiltin()
    bus.emit({ kind: 'plugin-status-change', pluginId: 'scheduler-manager', status: 'inactive' })
    expect(contributions.getContributions({ type: 'command', pluginId: 'scheduler-manager' })).toEqual([])
  })

  it('E3 执行侧：provide source.executeCommand 对缺失命令返回 false（CommandRegistry emit error 出声）', () => {
    const { app, bus } = initBridge()
    const errors: string[] = []
    bus.on('error', (e) => errors.push(e.message))
    const source = app.runWithContext(() => inject(HEADER_ACTIONS_SOURCE_KEY)) as HeaderActionsSource
    expect(source.executeCommand('scheduler-manager.not-registered')).toBe(false)
    expect(errors.some((m) => m.includes('scheduler-manager.not-registered'))).toBe(true)
  })
})

// ======================================================================
// ← composables/logic/__tests__/logic-bundle.test.ts
// ======================================================================

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：logic/file-type（原 node 环境文件）
// ─────────────────────────────────────────────────────────────────────────────

describe('detectFileKind · HTML 恢复 code 类（渲染态退役回归）', () => {
  it('.html / .htm → code（shiki 源码高亮，与实施前行为一致）', () => {
    expect(detectFileKind('report.html')).toBe('code')
    expect(detectFileKind('index.htm')).toBe('code')
  })

  it('大小写不敏感（.HTML / .HTM）', () => {
    expect(detectFileKind('Report.HTML')).toBe('code')
    expect(detectFileKind('Index.HTM')).toBe('code')
  })

  it('含目录前缀 / 绝对路径均按扩展名判定', () => {
    expect(detectFileKind('docs/report.html')).toBe('code')
    expect(detectFileKind('/Users/demo/.taiji/artifacts/sid/report.html')).toBe('code')
  })

  it('.xml 维持 code', () => {
    expect(detectFileKind('feed.xml')).toBe('code')
  })

  it('既有类别不受扩展影响（回归锚点）', () => {
    expect(detectFileKind('README.md')).toBe('markdown')
    expect(detectFileKind('logo.png')).toBe('image')
    expect(detectFileKind('app.ts')).toBe('code')
    expect(detectFileKind('notes.unknownext')).toBe('text')
  })
})

describe('extToLang · html 源码高亮语言', () => {
  it('html / htm → html（抽屉源码态 = 既有 shiki html 高亮）', () => {
    expect(extToLang('report.html')).toBe('html')
    expect(extToLang('index.htm')).toBe('html')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：logic/focus-trap
// ─────────────────────────────────────────────────────────────────────────────

/** 构造 keydown 事件（cancelable 必须 true，否则 preventDefault 无效果可断言） */
function tabEvent(shift = false): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, cancelable: true })
}

function mountFocusables(): HTMLElement {
    const host = document.createElement('div')
    host.innerHTML = `
      <button id="first">first</button>
      <input id="mid" />
      <button id="last">last</button>
      <button id="disabled" disabled>disabled</button>
      <span id="neg" tabindex="-1">neg</span>
    `
    document.body.appendChild(host)
    return host
}

describe('cycleTabFocus', () => {
  it('末个非 shift Tab：preventDefault + 回首个', () => {
    const host = mountFocusables()
    const first = host.querySelector('#first') as HTMLElement
    const last = host.querySelector('#last') as HTMLElement
    const e = tabEvent(false)
    last.focus()
    cycleTabFocus(e, () => getFocusableElements(host))
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    host.remove()
  })

  it('首个 shift Tab：preventDefault + 跳末个', () => {
    const host = mountFocusables()
    const first = host.querySelector('#first') as HTMLElement
    const last = host.querySelector('#last') as HTMLElement
    const e = tabEvent(true)
    first.focus()
    cycleTabFocus(e, () => getFocusableElements(host))
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)
    host.remove()
  })

  it('中间元素 Tab：不拦截（交浏览器原生顺序），焦点不变', () => {
    const host = mountFocusables()
    const mid = host.querySelector('#mid') as HTMLElement
    const e = tabEvent(false)
    mid.focus()
    cycleTabFocus(e, () => getFocusableElements(host))
    expect(e.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(mid)
    host.remove()
  })

  it('无可聚焦元素：放行', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const e = tabEvent(false)
    cycleTabFocus(e, () => getFocusableElements(host))
    expect(e.defaultPrevented).toBe(false)
    host.remove()
  })
})

describe('getFocusableElements', () => {
  it('按 DOM 序枚举可聚焦元素，排除 disabled 与 tabindex="-1"', () => {
    const host = mountFocusables()
    const ids = getFocusableElements(host).map((el) => el.id)
    expect(ids).toEqual(['first', 'mid', 'last'])
    host.remove()
  })

  it('FOCUSABLE_SELECTOR 覆盖 href / select / textarea / tabindex 形态', () => {
    const host = document.createElement('div')
    host.innerHTML = `
      <a id="link" href="#a">link</a>
      <select id="sel"><option>o</option></select>
      <textarea id="ta"></textarea>
      <div id="tn" tabindex="0">tn</div>
    `
    document.body.appendChild(host)
    const ids = getFocusableElements(host).map((el) => el.id)
    expect(ids).toEqual(['link', 'sel', 'ta', 'tn'])
    expect(FOCUSABLE_SELECTOR).toContain('[href]')
    host.remove()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：logic/summarizeTurn（原 node 环境文件）
// ─────────────────────────────────────────────────────────────────────────────

/** 构造最小可用的 MessageTurn（用 as 断言绕开完整 Message 字段需求）。 */
function makeTurn(userContent: string | null): MessageTurn {
  return {
    index: 1,
    user:
      userContent === null
        ? null
        : ({ id: 'u1', role: 'user', content: userContent, status: 'done' } as MessageTurn['user']),
    assistants: [],
    isStreaming: false,
    hasFoldable: false,
  } as MessageTurn
}

describe('summarizeTurnForRail (IF5)', () => {
  it('TC-w3-9: 剥离 markdown 标记后取前 20 字纯文本', () => {
    // 标题 + 加粗 + 链接 + 行内代码混合
    const turn = makeTurn('# 修复 **trace** 渲染 [bug](https://x.com) `code`')
    const summary = summarizeTurnForRail(turn)
    // 预期：# / ** / [bug](url) / ` 全部剥离，纯文本 = "修复 trace 渲染 bug code"
    expect(summary).toBe('修复 trace 渲染 bug code')
    // 长度上限校验：短文本不加省略号
    expect(summary.length).toBeLessThanOrEqual(20)
  })

  it('TC-w3-9b: 超长文本截断到 20 字 + 省略号', () => {
    const longText = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'
    // 30 字符的中文串，应截到 19 字 + '…' = 20 字符
    const summary = summarizeTurnForRail(makeTurn(longText))
    expect(summary.length).toBe(20)
    expect(summary.endsWith('…')).toBe(true)
    expect(summary.startsWith('一二三四五六七八九十一二三四五六七八九')).toBe(true)
  })

  it('TC-w3-10: user 为 null 时返回空串', () => {
    expect(summarizeTurnForRail(makeTurn(null))).toBe('')
  })
})

/** 构造带 assistant 的 MessageTurn（agent 摘要测试用）。 */
function makeTurnWithAssistant(opts: {
  assistantContents?: string[]   // 多 assistant 的 content 数组（默认 [''] 空 content）
  thinkingCount?: number
  toolCount?: number
}): MessageTurn {
  const contents = opts.assistantContents ?? ['']
  const thinking = opts.thinkingCount
    ? Array.from({ length: opts.thinkingCount }, (_, i) => ({
        id: `th${i}`, content: `thinking ${i}`, collapsed: true,
      }))
    : undefined
  const toolCalls = opts.toolCount
    ? Array.from({ length: opts.toolCount }, (_, i) => ({
        id: `tc${i}`, toolName: 'read', input: { path: `f${i}.ts` },
        status: 'done' as const, startTime: 0,
      }))
    : undefined
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: '用户输入', status: 'done' } as Message,
    assistants: contents.map((c, i) => ({
      id: `a${i}`,
      role: 'assistant',
      content: c,
      status: 'done',
      thinking: i === 0 ? thinking : undefined,
      toolCalls: i === 0 ? toolCalls : undefined,
    } as Message)),
    isStreaming: false,
    hasFoldable: false,
  } as MessageTurn
}

describe('summarizeAssistantForRail', () => {
  it('TC-A1: content 非空 → 返回 content 截断（stripMarkdown 后）', () => {
    const turn = makeTurnWithAssistant({ assistantContents: ['修复了 **Block.vue** 的折叠状态'] })
    expect(summarizeAssistantForRail(turn)).toBe('修复了 Block.vue 的折叠状态')
  })

  it('TC-A2: content 空 + 有 thinking/tools → fallback 计数 N thoughts · M tools', () => {
    const turn = makeTurnWithAssistant({ assistantContents: [''], thinkingCount: 2, toolCount: 3 })
    expect(summarizeAssistantForRail(turn)).toBe('2 thoughts · 3 tools')
  })

  it('TC-A3: content 空 + 仅 thinking → 只显 N thoughts', () => {
    const turn = makeTurnWithAssistant({ assistantContents: [''], thinkingCount: 5 })
    expect(summarizeAssistantForRail(turn)).toBe('5 thoughts')
  })

  it('TC-A4: content 空 + 仅 tools → 只显 M tools', () => {
    const turn = makeTurnWithAssistant({ assistantContents: [''], toolCount: 4 })
    expect(summarizeAssistantForRail(turn)).toBe('4 tools')
  })

  it('TC-A5: content 空 + 无 thinking/tools → 返回空串（调用方显占位）', () => {
    const turn = makeTurnWithAssistant({ assistantContents: [''] })
    expect(summarizeAssistantForRail(turn)).toBe('')
  })

  it('TC-A6: 多 assistant → 取首个非空 content（不 concat）', () => {
    const turn = makeTurnWithAssistant({ assistantContents: ['', '', '最终回复'] })
    // 前两条空，取第三条非空 content
    expect(summarizeAssistantForRail(turn)).toBe('最终回复')
  })

  it('TC-A7: assistants 为空数组 → 返回空串', () => {
    const turn = { index: 1, user: null, assistants: [], isStreaming: false, hasFoldable: false } as MessageTurn
    expect(summarizeAssistantForRail(turn)).toBe('')
  })
})
