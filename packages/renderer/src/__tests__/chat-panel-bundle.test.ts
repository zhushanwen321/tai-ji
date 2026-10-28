/**
 * chat 状态机 / PanelContainer 底抽屉 / 流跟随等合并产物（round 5-G U4）：七文件同产物，
 * 环境全默认（happy-dom；derive-status / panel.store 原为 node 环境，纯 store 逻辑无 DOM
 * 依赖，迁移实证兼容）。
 *
 * 并入来源（基名）：
 *  - panel/panel-container-bottom-drawer（底抽屉纵轴布局集成，8 例；跨目录自 panel/ 搬入）
 *  - useChat（流式状态机 + pendingSend/compact/subagent 转发，21 例）
 *  - effects/use-message-stream-follow-triggers（RO 双 rAF 流跟随，12 例；跨目录自
 *    effects/ 搬入，_virtua-mock-helper 相对路径已改写）
 *  - composables/derive-status（derivedStatus 联动，2 例；原 node，跨目录搬入）
 *  - panel/tray/tray-order（tray 排序纯函数 + 渲染栈，7 例）
 *  - panel/model-picker-data（canonicalizeModelRef 归一，6 例；相对路径已改写）
 *  - panel.store（单 panel 状态，4 例；原 node）
 *
 * mock 注册与 U4 解锁改造记录：
 *  - **改造①**（bottom-drawer 的 '@/stores/chat' 窄 mock（useChatStore 仅 getMessages）
 *    撤销）：useChat 节依赖真实 store 全成员（applyMessageEvent/pendingSend/isActive 等，
 *    波 1 登记互斥根因）。bottom-drawer 节改 beforeEach 对真实 store 实例 spy getMessages
 *    → 读 reactiveMessages Map（原 chatMock.registerReader 机制的等价直连形态），
 *    afterEach restoreAllMocks 复位。
 *  - **改造②**（bottom-drawer 的 '@/composables/features/chat/useSessionDerivations' 模块
 *    mock 撤销）：derive-status 节的被测本体就是该模块（含 invalidateStatusCache 导出，窄
 *    mock 会砍掉）。bottom-drawer 节改 beforeEach spy 模块对象的 useSessionDerivations
 *    返回 derivedStatus 恒 done 的桩，afterEach restore。
 *  - **改造③**（useChat 的 '@/api' 窄 mock 改保留式）：spread 真实门面 + 域内逐成员覆写
 *    （project.load/save、chat 7 动作、session 4 成员转发 apiMock）——原窄替换砍门面其余
 *    域，bottom-drawer 节挂真实 PanelContainer 全树的消费面（transport/mock 全量）不受影响。
 *  - bottom-drawer 的 12 条组件 vi.mock + useGitStatus mock 保留：useChat /
 *    follow-triggers / derive-status / tray-order / model-picker-data / panel.store 各节
 *    不挂这些组件、不消费 useGitStatus，无泄漏危害。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/chat-panel-bundle.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount, type VueWrapper } from '@vue/test-utils'
import { computed, defineComponent, h, nextTick, reactive, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useChatStore } from '@/stores/chat'
import type { Message, ModelInfo, Segment, ServerMessage } from '@taiji/shared'
import { textToSegments } from '@taiji/shared'
import * as derivationsModule from '@/composables/features/chat/useSessionDerivations'
import {
  bindDrawerSessionId,
  openDrawerTab,
  toggleDrawer,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import {
  bindBottomDrawerSessionId,
  toggleBottomDrawer,
  _resetBottomDrawerForTest,
  getBottomDrawerHeightPct,
  BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT,
  BOTTOM_DRAWER_HEIGHT_KEY,
  BOTTOM_DRAWER_HEIGHT_MAX_PCT,
} from '@taiji/core/domain/bottom-drawer'
import {
  providePlatform,
  __resetPlatformForTesting,
  type KVStorage,
  type PlatformPort,
} from '@taiji/core/platform/port'
import { useMessageStreamFollowTriggers, RO_FOLLOW_DEBOUNCE_MS } from '@/composables/panel/useMessageStreamFollowTriggers'
import type { RenderItem } from '@/composables/logic/messageTurns'
import { ManualResizeObserverStub } from './effects/_virtua-mock-helper'
import { TRAY_WIDGET_KNOWN_ORDER, orderTrayWidgetIds } from '@/components/panel/tray/tray-order'
import { canonicalizeModelRef } from '../components/panel/model-picker-data'

// ── bottom-drawer 节的懒加载面板 mock（轻量占位，带 sessionId 透传断言范围）──
vi.mock('@/components/panel/TerminalView.vue', () => ({
  default: {
    name: 'TerminalView',
    props: { sessionId: { type: String, default: null } },
    template: '<div data-testid="terminal-loaded" :data-session-id="sessionId" />',
  },
  [Symbol.toStringTag]: 'Module',
}))
vi.mock('@/components/panel/DetailPane.vue', () => ({
  default: { name: 'DetailPane', template: '<div data-testid="detail-loaded" />' },
  [Symbol.toStringTag]: 'Module',
}))

// ── bottom-drawer 节的静态重面板 + 壳层组件 vi.mock ──
vi.mock('@/components/panel/GitPanel.vue', () => ({
  default: { name: 'GitPanel', template: '<div data-testid="git-panel" />' },
}))
vi.mock('@/components/panel/CommandDocPanel.vue', () => ({
  default: { name: 'CommandDocPanel', template: '<div data-testid="doc-panel" />' },
}))
vi.mock('@/components/extension/BackgroundTaskDetailPanel.vue', () => ({
  default: { name: 'BackgroundTaskDetailPanel', template: '<div data-testid="bash-task-detail-panel" />' },
}))
vi.mock('@/components/panel/plan/PlanDocsPanel.vue', () => ({
  default: { name: 'PlanDocsPanel', template: '<div data-testid="plan-docs-panel" />' },
}))
vi.mock('@/components/panel/BtwPanel.vue', () => ({
  default: { name: 'BtwPanel', template: '<div data-testid="btw-panel" />' },
}))
vi.mock('@/components/panel/Panel.vue', () => ({
  default: {
    name: 'Panel',
    props: { panelId: String, sessionId: { type: String, default: null } },
    template: '<div data-testid="panel" :data-panel-id="panelId" />',
  },
}))
vi.mock('@/components/panel/PanelHeader.vue', () => ({
  default: { name: 'PanelHeader', template: '<div />' },
}))
vi.mock('@/components/ui/ToastContainer.vue', () => ({
  default: { name: 'ToastContainer', template: '<div />' },
}))
vi.mock('@/components/panel/trace/TraceInspector.vue', () => ({
  default: { name: 'TraceInspector', template: '<div />' },
}))
vi.mock('@/components/panel/SubagentTab.vue', () => ({
  default: { name: 'SubagentTab', template: '<div />' },
}))

vi.mock('@/composables/features/file-tree/useGitStatus', () => ({
  GIT_STATUS_KEY: Symbol('git-status'),
  provideGitStatus: () => ({ indicator: { value: undefined }, state: { value: 'clean' }, lines: { value: [] } }),
}))

// ── useChat 节的 '@/api' 保留式 mock（U4 改造③）：spread 真实门面 + 域内逐成员覆写。
//    vi.hoisted 保证 mock 工厂在模块加载前就绪；holder 捕获 streamSubscribe 注册的 handler ──
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
    // [u3c/D1] 统一提交入口（core submitSegments → delivery.submit）
    submitDelivery: vi.fn(() =>
      Promise.resolve({ clientUuid: 'u-mock', state: 'in-flight' as const, lane: 'direct' as const }),
    ),
    getHistory: vi.fn(() => Promise.resolve([])),
    abort: vi.fn(() => Promise.resolve()),
    compact: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
    // useChat subagent 定向消息转发（原 useChat-subagent-directive.test.ts 并入）
    subagentAction: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    project: {
      ...actual.project,
      load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
      save: vi.fn().mockResolvedValue(undefined),
    },
    chat: {
      ...actual.chat,
      streamSubscribe: apiMock.streamSubscribe,
      send: apiMock.send,
      submitDelivery: apiMock.submitDelivery,
      getHistory: apiMock.getHistory,
      abort: apiMock.abort,
      compact: apiMock.compact,
      followUp: apiMock.followUp,
    },
    session: {
      ...actual.session,
      // wave:runtime-patch W2：useChat 现从 @/api import session（writeSegments），
      // useMessageBusSubscription 调 session.subscribe——补 stub 避免 not-a-function
      subscribe: vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 }),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      writeSegments: vi.fn().mockResolvedValue(undefined),
      subagentAction: apiMock.subagentAction,
    },
  }
})

import { useChat, resetChatModuleState } from '@/composables/features/chat/useChat'

// ══════════ 来源节：panel/panel-container-bottom-drawer（U4 改造①②：@/stores/chat 与
// useSessionDerivations 两处模块 mock 撤销，改节内 spy）══════════

describe('PanelContainer 底抽屉（panel-container-bottom-drawer 合并节）', () => {
  // U4 改造①：原模块窄 mock（useChatStore 仅 getMessages 读 reactiveMessages）改为节内
  // spy 真实 store 实例的 getMessages——useChat 节需要真实 store 全成员。
  const reactiveMessages = reactive(new Map<string, unknown[]>())

  // ── KV 内存 stub（layout.test.ts 同款简化版）：peek 看落盘值，setWrites 记录写穿 ──
  class StubKV implements KVStorage {
    private map = new Map<string, string>()
    setWrites: Array<[string, string]> = []
    peek(): string | undefined {
      return this.map.get(BOTTOM_DRAWER_HEIGHT_KEY)
    }
    async get(key: string): Promise<string | null> {
      return this.map.get(key) ?? null
    }
    async set(key: string, value: string): Promise<void> {
      this.setWrites.push([key, value])
      this.map.set(key, value)
    }
    async remove(key: string): Promise<void> {
      this.map.delete(key)
    }
  }

  let kv: StubKV

  /** jsdom 无布局：按用例注入 pool 高度（clamp/拖拽数学基准）。mount 前安装（测量在挂载期） */
  function stubPoolRect(height: number): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return {
        width: 1000,
        height,
        top: 0,
        left: 0,
        right: 1000,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect
    })
  }

  /** 读取底抽屉高度 style（jsdom 不执行 CSS transition，style.height 即终态） */
  function bottomHeight(wrapper: Awaited<ReturnType<typeof mountContainer>>): string {
    const style = wrapper.find('[data-testid="bottom-drawer"]').attributes('style') ?? ''
    return /height:\s*([^;]+);/.exec(style)?.[1] ?? ''
  }

  async function mountContainer() {
    const PanelContainer = (await import('@/components/workspace/PanelContainer.vue')).default
    // 真实 Transition（test-utils 默认 <transition-stub> 会吞掉 leave 语义——U6 收合期内容
    // 保挂载的回归锚点必须走真实 leave 路径）；enter 无 CSS 类零动画，其余用例无感
    return mount(PanelContainer, { global: { stubs: { transition: false } } })
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    // U4 改造①：getMessages 节内 spy（真实 store 实例，afterEach restoreAllMocks 复位）
    vi.spyOn(useChatStore(), 'getMessages').mockImplementation(
      (sid: string) => (reactiveMessages.get(sid) ?? []) as never,
    )
    // U4 改造②：useSessionDerivations 节内 spy（原模块 mock 会砍 invalidateStatusCache，
    // derive-status 节的被测本体）
    vi.spyOn(derivationsModule, 'useSessionDerivations').mockReturnValue(
      { derivedStatus: () => ({ value: 'done' }) } as never,
    )
    bindDrawerSessionId(computed(() => usePanelStore().focusedSessionId))
    bindBottomDrawerSessionId(computed(() => usePanelStore().focusedSessionId))
    _resetDrawerForTest()
    _resetBottomDrawerForTest()
    reactiveMessages.clear()
    localStorage.clear()
    kv = new StubKV()
    providePlatform({
      kind: 'mock',
      storage: kv,
      webSocket: { create: () => { throw new Error('unused') } },
    } as PlatformPort)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetPlatformForTesting()
  })
  enableAutoUnmount(afterEach)

  describe('底抽屉纵轴布局（S1/S2 形态：split 行之下、全宽）', () => {
    it('开底抽屉 → terminal 挂载于 split 行之下，且不在 drawer-area 内（全宽）', async () => {
      const panel = usePanelStore()
      panel.loadSession(ROOT_PANEL_ID, 'sess-bd')
      const wrapper = await mountContainer()
      toggleBottomDrawer()
      await flushPromises()

      // terminal 搬家后的新家（挂载点带 sessionId）
      const terminal = wrapper.find('[data-testid="terminal-loaded"]')
      expect(terminal.exists()).toBe(true)
      expect(terminal.attributes('data-session-id')).toBe('sess-bd')

      // 纵轴顺序（观察者形态）：split 行 → 底抽屉
      const html = wrapper.html()
      expect(html.indexOf('data-testid="split-area"')).toBeLessThan(html.indexOf('data-testid="bottom-drawer"'))

      // 全宽：底抽屉是纵轴池的直接子项（与 split 行同级），不在 drawer-area 里
      const pool = wrapper.find('[data-testid="vertical-pool"]')
      expect(pool.exists()).toBe(true)
      expect(wrapper.find('[data-testid="drawer-area"] [data-testid="bottom-drawer"]').exists()).toBe(false)

      // 上沿拖拽手柄（role=separator，键盘可达）
      const handle = wrapper.find('[data-testid="bottom-drawer-resize-handle"]')
      expect(handle.exists()).toBe(true)
      expect(handle.attributes('role')).toBe('separator')
      expect(handle.attributes('aria-orientation')).toBe('horizontal')
      // aria 值三件套（spec drawers spec（demo） §3.2 键盘微调可达性；real 模型 = pct 钳制 15–70）
      expect(handle.attributes('aria-valuemin')).toBe('15')
      expect(handle.attributes('aria-valuemax')).toBe('70')
      expect(Number(handle.attributes('aria-valuenow'))).toBeGreaterThanOrEqual(15)
      expect(Number(handle.attributes('aria-valuenow'))).toBeLessThanOrEqual(70)
      // 壳层 height 过渡 ease 恒 --ease（demo workbench.css .bottom-pane 权威；E5 分向缓动只属
      // 显隐层）。classes() 数组元素全等断言：分向 ease-out/ease-in 类回归即红
      expect(wrapper.find('[data-testid="bottom-drawer"]').classes()).toContain('ease-[var(--ease)]')
    }, 60_000)

    it('S2 双容器同开：右抽屉 git + 底抽屉同时可见', async () => {
      const panel = usePanelStore()
      panel.loadSession(ROOT_PANEL_ID, 'sess-bd-dual')
      openDrawerTab('git')
      toggleBottomDrawer()
      const wrapper = await mountContainer()
      await flushPromises()

      expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="bottom-drawer"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="terminal-loaded"]').exists()).toBe(true)
    }, 60_000)

    it('S10 默认 git：首开右抽屉呈现 git tab（terminal 已迁出 L1）', async () => {
      const panel = usePanelStore()
      panel.loadSession(ROOT_PANEL_ID, 'sess-bd-default')
      const wrapper = await mountContainer()
      toggleDrawer()
      await flushPromises()

      // 用户可见：首开右抽屉是 git 内容 + git 图标高亮
      expect(wrapper.find('[data-testid="git-panel"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="drawer-tab-git"]').classes()).toContain('bg-surface-hover')
      expect(wrapper.find('[data-testid="drawer-tab-terminal"]').exists()).toBe(false)
    }, 60_000)

    it('收回底抽屉 → 高度回 0%；收合过渡期终端保挂载（U6），leave 结束后卸载（对话流恢复原高：split 行吃回 flex-1）', async () => {
      const panel = usePanelStore()
      panel.loadSession(ROOT_PANEL_ID, 'sess-bd-close')
      const wrapper = await mountContainer()
      toggleBottomDrawer()
      await flushPromises()
      expect(wrapper.find('[data-testid="terminal-loaded"]').exists()).toBe(true)

      toggleBottomDrawer()
      await nextTick()
      expect(bottomHeight(wrapper)).toBe('0%')
      // 壳层过渡 ease 不随开合方向变化（恒 --ease；E5 分向缓动只属显隐层）
      expect(wrapper.find('[data-testid="bottom-drawer"]').classes()).toContain('ease-[var(--ease)]')
      // [U6] 收合动画期（壳 height 过渡期）终端仍挂载——动画期空抽屉回归锚点（真实
      // Transition leave：元素带 leave-active 类保挂载，卸载时机 = leave 过渡结束）
      expect(wrapper.find('[data-testid="terminal-loaded"]').exists()).toBe(true)
      // 手柄（v-if 随开合态，不经 Transition）同帧消失
      expect(wrapper.find('[data-testid="bottom-drawer-resize-handle"]').exists()).toBe(false)

      // leave 过渡结束（测试环境无 CSS → 时长 0，双 rAF 帧后移除）：终端卸载
      await vi.waitFor(() => {
        expect(wrapper.find('[data-testid="terminal-loaded"]').exists()).toBe(false)
      }, { interval: 1 })
    }, 60_000)
  })

  describe('底抽屉高度（S2：默认 35% / 拖拽持久化 / 显示期 clamp 不写回）', () => {
    it('默认高度 35%（§7.1 裁决值）', async () => {
      const panel = usePanelStore()
      panel.loadSession(ROOT_PANEL_ID, 'sess-bd-h-default')
      toggleBottomDrawer()
      const wrapper = await mountContainer()
      await flushPromises()

      expect(bottomHeight(wrapper)).toBe(`${BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT}%`)
      expect(getBottomDrawerHeightPct()).toBe(BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT)
    }, 60_000)

    it('拖上沿调高度：指针跟手改高度 + 写侧 clamp + 全局单键持久化（刷新后保持）', async () => {
      stubPoolRect(800)
      const panel = usePanelStore()
      panel.loadSession(ROOT_PANEL_ID, 'sess-bd-h-drag')
      toggleBottomDrawer()
      const wrapper = await mountContainer()
      await flushPromises()

      const handle = wrapper.find('[data-testid="bottom-drawer-resize-handle"]')
      await handle.trigger('pointerdown', { pointerId: 1 })
      // 拖到 y=440：高 = (800-440)/800 = 45%
      await handle.trigger('pointermove', { pointerId: 1, clientY: 440 })
      await flushPromises()
      expect(bottomHeight(wrapper)).toBe('45%')
      expect(getBottomDrawerHeightPct()).toBe(45)

      // 写侧 clamp：拖到 y=60 → 目标 92.5% → 钳到上限 70%
      await handle.trigger('pointermove', { pointerId: 1, clientY: 60 })
      await flushPromises()
      expect(bottomHeight(wrapper)).toBe(`${BOTTOM_DRAWER_HEIGHT_MAX_PCT}%`)
      expect(getBottomDrawerHeightPct()).toBe(BOTTOM_DRAWER_HEIGHT_MAX_PCT)

      await handle.trigger('pointerup', { pointerId: 1 })
      await flushPromises()
      // 持久化：全局单键落盘（同构尺寸值同粒度，§7.1）
      expect(kv.peek()).toBe(JSON.stringify(BOTTOM_DRAWER_HEIGHT_MAX_PCT))
      expect(kv.setWrites).toContainEqual([BOTTOM_DRAWER_HEIGHT_KEY, JSON.stringify(BOTTOM_DRAWER_HEIGHT_MAX_PCT)])
    }, 60_000)

    it('矮窗显示期 clamp：显示高受主区最小可视钳制，但不写回持久值（恢复高度回到拖拽值）', async () => {
      // 矮窗：pool 高 300px，主区最小可视 240px → 显示上限 (300-240)/300 = 20%
      stubPoolRect(300)
      const panel = usePanelStore()
      panel.loadSession(ROOT_PANEL_ID, 'sess-bd-h-clamp')
      toggleBottomDrawer()
      const wrapper = await mountContainer()
      await flushPromises()

      expect(bottomHeight(wrapper)).toBe('20%')
      // 未写回：持久值仍是默认 35，KV 无写入（恢复窗口高度后回到拖拽持久值）
      expect(getBottomDrawerHeightPct()).toBe(BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT)
      expect(kv.setWrites).toEqual([])
    }, 60_000)

    it('键盘微调（separator 可达性）：ArrowUp 变高 / ArrowDown 变低', async () => {
      const panel = usePanelStore()
      panel.loadSession(ROOT_PANEL_ID, 'sess-bd-h-key')
      toggleBottomDrawer()
      const wrapper = await mountContainer()
      await flushPromises()

      const handle = wrapper.find('[data-testid="bottom-drawer-resize-handle"]')
      await handle.trigger('keydown', { key: 'ArrowUp' })
      await flushPromises()
      expect(getBottomDrawerHeightPct()).toBe(BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT + 2)
      await handle.trigger('keydown', { key: 'ArrowDown' })
      await flushPromises()
      expect(getBottomDrawerHeightPct()).toBe(BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT)
    }, 60_000)
  })
})

// ══════════ 来源节：useChat（原文件顶层 beforeEach 下沉包裹层内）══════════

describe('useChat（useChat 合并节）', () => {
  /** 向被测 useChat 订阅的 handler 注入一条 ServerMessage */
  function emit(msg: ServerMessage): void {
    if (apiMock.holder.handler) apiMock.holder.handler(msg)
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    resetChatModuleState()
    vi.clearAllMocks()
    apiMock.holder.handler = null
  })

  describe('useChat 流式状态机', () => {
    it('首次 send 订阅流式事件恰好一次', async () => {
      const { send } = useChat()
      await send('s-subscribe', textToSegments('hello'))
      expect(apiMock.streamSubscribe).toHaveBeenCalledTimes(1)
      expect(apiMock.submitDelivery).toHaveBeenCalledTimes(1)
    })

    it('同 session 二次 send 不重复订阅（ensureStreamSubscription 幂等）', async () => {
      const { send } = useChat()
      await send('s-idempotent', textToSegments('one'))
      // 第一轮流式周期结束（message_start 清 dispatching + 设 isStreaming，complete 清 isStreaming）
      emit({ type: 'message.message_start', payload: { sessionId: 's-idempotent', messageId: 'a1' } })
      emit({ type: 'message.complete', payload: { sessionId: 's-idempotent' } })
      await send('s-idempotent', textToSegments('two'))
      expect(apiMock.streamSubscribe).toHaveBeenCalledTimes(1)
      expect(apiMock.submitDelivery).toHaveBeenCalledTimes(2)
    })

    it('message.message_start → isGenerating=true', async () => {
      const chat = useChatStore()
      const { send } = useChat()
      await send('s-start', textToSegments('hi'))
      expect(chat.isGenerating('s-start')).toBe(false)
      emit({ type: 'message.message_start', payload: { sessionId: 's-start', messageId: 'a1' } })
      expect(chat.isGenerating('s-start')).toBe(true)
    })

    it('message.complete → isGenerating=false', async () => {
      const chat = useChatStore()
      const { send } = useChat()
      await send('s-complete', textToSegments('hi'))
      emit({ type: 'message.message_start', payload: { sessionId: 's-complete', messageId: 'a1' } })
      expect(chat.isGenerating('s-complete')).toBe(true)
      emit({ type: 'message.complete', payload: { sessionId: 's-complete' } })
      expect(chat.isGenerating('s-complete')).toBe(false)
    })

    it('message.error → isGenerating=false（规则 #3 终态复位）', async () => {
      const chat = useChatStore()
      const { send } = useChat()
      await send('s-error', textToSegments('hi'))
      emit({ type: 'message.message_start', payload: { sessionId: 's-error', messageId: 'a1' } })
      expect(chat.isGenerating('s-error')).toBe(true)
      emit({ type: 'message.error', payload: { sessionId: 's-error', message: 'boom' } })
      expect(chat.isGenerating('s-error')).toBe(false)
    })

    it('message.stream_error → isGenerating=false（stream_error 终态复位关键分支）', async () => {
      const chat = useChatStore()
      const { send } = useChat()
      await send('s-stream-err', textToSegments('hi'))
      emit({ type: 'message.message_start', payload: { sessionId: 's-stream-err', messageId: 'a1' } })
      expect(chat.isGenerating('s-stream-err')).toBe(true)
      // 若 pi 发了 message_update{error} 后不再发 agent_end，必须在此复位
      emit({ type: 'message.stream_error', payload: { sessionId: 's-stream-err', content: 'err' } })
      expect(chat.isGenerating('s-stream-err')).toBe(false)
    })

    it('send 检查：空文本/纯空白时早退', async () => {
      const { send } = useChat()
      await send('s-empty', textToSegments('   '))
      await send('s-empty', textToSegments(''))
      expect(apiMock.streamSubscribe).not.toHaveBeenCalled()
      expect(apiMock.submitDelivery).not.toHaveBeenCalled()
    })

    it('[u3c/D1] 占用期 send 照常统一提交（B 策略本地转 steer 已退役，lane 判定在内核）', async () => {
      const chat = useChatStore()
      const { send } = useChat()
      await send('s-busy', textToSegments('first'))
      emit({ type: 'message.message_start', payload: { sessionId: 's-busy', messageId: 'a1' } })
      expect(chat.isGenerating('s-busy')).toBe(true)
      await send('s-busy', textToSegments('second'))
      // 两次都经统一提交（内核判 lane：queued/steer 由内核承接），renderer 不再本地转 steer
      expect(apiMock.submitDelivery).toHaveBeenCalledTimes(2)
    })
  })

  describe('useChat pendingSend 合并态（空窗期）', () => {
    // fake timers 统一恢复：放用例尾部会在断言失败时跳过恢复 → 向后续用例泄漏 fake timers
    afterEach(() => {
      vi.clearAllTimers()
      vi.useRealTimers()
    })

    it('send 置 pendingSend → isActive 立即为 true（不等 message_start）', async () => {
      const chat = useChatStore()
      const { send } = useChat()
      // send 的 api.send 是异步的，但我们用 await 等它 resolve
      await send('s-dispatch', textToSegments('hello'))
      // send resolve 后到 message_start 之前，pendingSend 应保持（空窗期 isActive=true）
      expect(chat.pendingSend.has('s-dispatch')).toBe(true)
      expect(chat.isActive('s-dispatch')).toBe(true)
      expect(chat.isGenerating('s-dispatch')).toBe(false) // message_start 未到
    })

    it('message_start 到达 → 清 pendingSend + 设 isGenerating（空窗期无缝切换）', async () => {
      const chat = useChatStore()
      const { send } = useChat()
      await send('s-switch', textToSegments('hi'))
      expect(chat.pendingSend.has('s-switch')).toBe(true)
      emit({ type: 'message.message_start', payload: { sessionId: 's-switch', messageId: 'a1' } })
      expect(chat.pendingSend.has('s-switch')).toBe(false)
      expect(chat.isGenerating('s-switch')).toBe(true)
      expect(chat.isActive('s-switch')).toBe(true) // 合并态仍 true
    })

    it('终态（complete）清 pendingSend（兜底，message_start 未到的异常路径）', async () => {
      const chat = useChatStore()
      const { send } = useChat()
      await send('s-terminal', textToSegments('hi'))
      expect(chat.pendingSend.has('s-terminal')).toBe(true)
      // 模拟 pi 未发 message_start 直接 complete（异常但需兜底）
      emit({ type: 'message.complete', payload: { sessionId: 's-terminal' } })
      expect(chat.pendingSend.has('s-terminal')).toBe(false)
      expect(chat.isActive('s-terminal')).toBe(false)
    })

    it('send 失败零乐观残留（受理回执前不上屏——无气泡无占位，失败信号走 toast/false 契约）', async () => {
      const chat = useChatStore()
      apiMock.submitDelivery.mockRejectedValueOnce(new Error('network'))
      const { send } = useChat()
      // [W2] send 失败不再 throw（toast + false，不 throw）；
      // [R2-A5] send 契约 Promise<boolean>——失败返回 false，dispatch 侧按 false 恢复草稿。
      // [ADR-0122 受理回执后上屏] 失败时气泡/占位从未置位（无回滚面，结构性零残留）。
      await expect(send('s-fail', textToSegments('hi'))).resolves.toBe(false)
      expect(chat.getMessages('s-fail')).toHaveLength(0)
      expect(chat.pendingSend.has('s-fail')).toBe(false)
      expect(chat.isActive('s-fail')).toBe(false)
    })

    // [审计候选 8] useChat.steer 已随 message.steer 协议路径退役删除——其统一提交 / 非活跃早退 /
    // 乐观气泡用例随被测符号移除；followUp 通路契约由下方用例承接。

    it('[u3c/D1] followUp 统一提交并生成自己的乐观气泡（空窗期）', async () => {
      const chat = useChatStore()
      const { send, followUp } = useChat()
      await send('s-pending', textToSegments('first'))
      await followUp('s-pending', textToSegments('followup 内容'))
      // 两条各自经统一提交（内核判 lane）；每条都有乐观气泡入流。[B1 退役] 前身「pendingBuffer
      // 不暂存」哨兵已删：分区本尊随计数路径删除，无暂存由缺字段结构性保证。
      expect(apiMock.submitDelivery).toHaveBeenCalledTimes(2)
      const users = chat.getMessages('s-pending').filter((m) => m.role === 'user')
      expect(users).toHaveLength(2)
    })

    it('abort 乐观清 pendingSend（W4：失败路径不残留）', async () => {
      const chat = useChatStore()
      const { send, abort } = useChat()
      await send('s-abort', textToSegments('first'))
      expect(chat.pendingSend.has('s-abort')).toBe(true)
      // abort 即使 RPC 失败也清 pendingSend（乐观清理 + catch 兜底）
      apiMock.abort.mockRejectedValueOnce(new Error('session not found'))
      await abort('s-abort') // 不抛（catch 吞掉）
      expect(chat.pendingSend.has('s-abort')).toBe(false)
      expect(chat.isActive('s-abort')).toBe(false)
    })

    // [ADR-0122] 原「pendingSend 30s 超时兜底（W3）」用例随 30s 空窗 timer 退役删除：
    // pendingSend 收尾全事件驱动（message_start / finalizeSession 各 reason / deliveryHandled /
    // delivery morph / occupancy idle 帧 / 断连 finalizeAllStreaming），无墙钟兜底可推演。
    // 「message_start 永不到」的现实成因（pi 死亡）由断连链收尾——finalizeAllStreaming 用例覆盖。

    it('finalizeAllStreaming 强制收尾所有 streaming session（runtime 崩溃时 useConnection 调）', () => {
      const chat = useChatStore()
      // 创建 streaming entity（isActive=true via isGenerating）
      chat.applyMessageEvent('s-crash', { type: 'message.message_start', payload: { sessionId: 's-crash', messageId: 'a1' } })
      expect(chat.isActive('s-crash')).toBe(true)
      expect(chat.isGenerating('s-crash')).toBe(true)
      // runtime 崩溃：finalizeAllStreaming 收尾（useConnection restart/disconnect 时调）
      chat.finalizeAllStreaming('restart')
      expect(chat.isGenerating('s-crash')).toBe(false)
      expect(chat.isActive('s-crash')).toBe(false)
    })

    // [ADR-0122] 原「正常流转清除 pendingSend 超时 timer」用例随 timer 退役删除：
    // message_start 到达清 pendingSend 的语义由「message_start 到达 → 清 pendingSend +
    // 设 isGenerating」用例覆盖，无 timer 残留断言范围。

    it('[u3c/D1] followUp 提交失败零乐观残留（受理回执前不上屏）+ toast 提示', async () => {
      const chat = useChatStore()
      const { send, followUp } = useChat()
      await send('s-fu-rollback', textToSegments('first'))
      const before = chat.getMessages('s-fu-rollback').length
      apiMock.submitDelivery.mockRejectedValueOnce(new Error('ws disconnected'))
      await expect(followUp('s-fu-rollback', textToSegments('下轮'))).resolves.toBe(false)
      // 失败时新气泡从未上屏（无回滚面，分区长度不变——结构性零残留）
      expect(chat.getMessages('s-fu-rollback')).toHaveLength(before)
    })
  })

  describe('useChat compact 状态机（#6）', () => {
    it('compact 调 chatApi.compact 且建立会话级订阅（消费 compacting/compacted）', async () => {
      const { compact } = useChat()
      await compact('c-sub')
      // compact(sessionId, customInstructions?) → chatApi.compact(sid, undefined)（未传自定义指令）
      expect(apiMock.compact).toHaveBeenCalledWith('c-sub', undefined)
      expect(apiMock.streamSubscribe).toHaveBeenCalledTimes(1)
    })

    it('session.compacting + occupancy{compacting:true} → isCompacting=true；occupancy{false} 帧 → false（u5b 派生视图驱动）', async () => {
      const chat = useChatStore()
      const { compact } = useChat()
      await compact('c-flow')
      // [u5b] membership 由 occupancy 派生视图推导（interpreter 同一挂点先发 session.compacting
      // 再发 occupancy——帧序镜像 runtime 实发）；session.compacting 只承载 reason 文案源。
      emit({ type: 'session.compacting', payload: { sessionId: 'c-flow', status: 'compacting', reason: 'manual' } })
      expect(chat.getCompactingReason('c-flow')).toBe('manual')
      emit({ type: 'session.occupancy', payload: { sessionId: 'c-flow', turn: 'idle', compacting: true, bash: false } })
      expect(chat.isCompacting('c-flow')).toBe(true)
      // compaction_end 三路复位（含失败）→ occupancy compacting=false 帧 → 派生视图复位
      emit({ type: 'session.compacted', payload: { sessionId: 'c-flow', status: 'compacted' } })
      emit({ type: 'session.occupancy', payload: { sessionId: 'c-flow', turn: 'idle', compacting: false, bash: false } })
      expect(chat.isCompacting('c-flow')).toBe(false)
      expect(chat.getCompactingReason('c-flow')).toBeUndefined()
    })

    it('compact 失败（pending reject）→ toast 错误提示，不抛出（不卡 UI，M8 toast 方案）', async () => {
      const chat = useChatStore()
      apiMock.compact.mockRejectedValueOnce(new Error('Session not found'))
      const { compact } = useChat()
      await expect(compact('c-err')).resolves.toBe(false)
      // M8: compact 错误走 toast 而非 appendSystemNotice，不再插入 system 消息
      const msgs = chat.getMessages('c-err')
      expect(msgs).toEqual([])
    })
  })

  // ── 原 useChat-subagent-directive.test.ts 并入（同 SUT useChat.send、同 mock 骨架）──
  // U2b chatApiPort.subagentAction 懒转发：send 携带 subagent 段时经端口调
  // session.subagentAction（sid, action, params），不走主 agent send 通道。
  describe('useChat subagent 定向消息转发（@ chip）', () => {
    beforeEach(() => {
      setActivePinia(createPinia())
      resetChatModuleState()
      vi.clearAllMocks()
      apiMock.holder.handler = null
    })

    it('send 含 subagent 段（subagentId 非空）→ 调 session.subagentAction(message)，不走主 agent send', async () => {
      const { send } = useChat()
      const segments: Segment[] = [
        { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
        { type: 'text', text: '展开讲讲' },
      ]
      await send('s-directive', segments)

      expect(apiMock.subagentAction).toHaveBeenCalledTimes(1)
      expect(apiMock.subagentAction).toHaveBeenCalledWith('s-directive', 'message', {
        subagentId: 'rec-1',
        // 前导空格 = subagent(chip)→text 边界补格（segmentsToText，chip 产出空串后
        // 补格残留）——8f93d7feb 已裁决该形态「保真随行发出」并同步其测试期望，此处对齐。
        text: ' 展开讲讲',
      })
      // 无主 agent turn（§3.3.8：不经 message.send 通道）
      expect(apiMock.send).not.toHaveBeenCalled()
    })

    it('subagentId 空串（新建占位 chip）→ subagentAction(start)，slug 自动生成', async () => {
      const { send } = useChat()
      const segments: Segment[] = [
        { type: 'subagent', subagentId: '', slug: '新任务' },
        { type: 'text', text: '帮我修 bug' },
      ]
      await send('s-start-action', segments)

      expect(apiMock.subagentAction).toHaveBeenCalledWith('s-start-action', 'start', {
        slug: expect.stringMatching(/^chat-/),
        // 同上：chip→text 边界补格的前导空格，保真透传（8f93d7feb 口径）
        task: ' 帮我修 bug',
      })
      expect(apiMock.send).not.toHaveBeenCalled()
    })
  })
})

// ══════════ 来源节：effects/use-message-stream-follow-triggers（节内 hook 原样；
// 跨目录自 effects/ 搬入，_virtua-mock-helper 相对路径已改写）══════════

describe('useMessageStreamFollowTriggers（数据信号主触发 + wrap RO 测量留守 / 触发支 debounce 兜底）', () => {
  function msg(id: string, content: string, role: Message['role'] = 'user'): Message {
    return { id, role, content, status: 'complete' }
  }

  /** turn 渲染项（isStreaming = 回合工作态；assistants 各条文本求和构成数据通路观察对象） */
  function turnItem(id: string, text: string, isStreaming: boolean): RenderItem {
    return {
      kind: 'turn',
      turn: {
        index: 0,
        user: msg(`${id}-u`, '问'),
        assistants: [msg(`${id}-a`, text, 'assistant')],
        isStreaming,
        hasFoldable: false,
      },
    }
  }

  /** bashExecution 渲染项（双工作态窗口内 append 到末位的 system item 形态） */
  function bashItem(id: string): RenderItem {
    return { kind: 'bashExecution', message: msg(id, 'bash 输出', 'system') }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    ManualResizeObserverStub.install()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    ManualResizeObserverStub.uninstall()
  })

  /** 挂载 harness：composable 依赖全部可断言注入，返回 wrapper + 依赖句柄 */
  function mountTriggers() {
    const renderItems = ref<RenderItem[]>([])
    const scrollEl = ref<HTMLElement | null>(document.createElement('div'))
    const followIfStuck = vi.fn()
    const followToBottomForce = vi.fn()
    const notifyRoActivity = vi.fn()
    const refreshDistanceSnapshot = vi.fn()
    const submitSeq = ref(0)

    let api!: ReturnType<typeof useMessageStreamFollowTriggers>
    const Harness = defineComponent({
      setup() {
        api = useMessageStreamFollowTriggers({
          renderItems: computed(() => renderItems.value),
          submitSeq: () => submitSeq.value,
          scrollEl,
          followIfStuck,
          followToBottomForce,
          notifyRoActivity,
          refreshDistanceSnapshot,
        })
        return () => h('div', { ref: api.contentWrapEl }, [h('div', { ref: api.tailEl })])
      },
    })
    const wrapper: VueWrapper = mount(Harness)

    // onMounted 创建顺序：wrap RO 先、scroll RO 后
    const [wrapRo, scrollRo] = ManualResizeObserverStub.created()
    if (!wrapRo || !scrollRo) throw new Error('RO stub 未按预期创建（wrap 先、scroll 后）')
    return {
      wrapper,
      api,
      renderItems,
      followIfStuck,
      followToBottomForce,
      refreshDistanceSnapshot,
      submitSeq,
      notifyRoActivity,
      wrapRo,
      scrollRo,
    }
  }

  /** 覆盖 tailEl 实例 offsetHeight getter（happy-dom 恒 0，无法表达真实增高） */
  function stubTailHeight(api: ReturnType<typeof useMessageStreamFollowTriggers>, height: number): void {
    const el = api.tailEl.value
    if (!el) throw new Error('tailEl 未挂载')
    Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true })
  }

  /** 高度变化投递（wrap 分量变化；触发支进 debounce 窗） */
  function dispatchWrapHeightChange(wrapRo: ManualResizeObserverStub, height: number): void {
    wrapRo.dispatch([{ contentRect: { height } as DOMRectReadOnly }])
  }

  it('双 rAF 核心：scrollEl RO 触发后 follow 不立即执行，flush 一帧后才调 followIfStuck()', async () => {
    const { scrollRo, followIfStuck, notifyRoActivity } = mountTriggers()

    scrollRo.dispatch()

    // 外层 rAF pending 期间：follow 未触发（RO 回调 → 外层 rAF → followIfStuck 内层 rAF）。
    // 视口 resize 通路不经 debounce 门（触发矩阵 4 行：视口变化必有跟随需要且低频）。
    expect(followIfStuck).not.toHaveBeenCalled()
    // notifyRoActivity 在首次 RO 回调即喂信号（不因双 rAF 拖延）
    expect(notifyRoActivity).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(16) // flush 外层 rAF
    expect(followIfStuck).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledWith()
    expect(notifyRoActivity).toHaveBeenCalledTimes(1) // 外层 rAF 执行不补喂
  })

  it('连续触发 cancel 合并：同帧两次 scrollEl RO 只产生一次 followIfStuck', async () => {
    const { scrollRo, followIfStuck } = mountTriggers()

    scrollRo.dispatch()
    scrollRo.dispatch() // 同帧第二次：cancel 旧外层 rAF 重排

    await vi.advanceTimersByTimeAsync(16)
    expect(followIfStuck).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledWith()
  })

  it('视口 resize 即时触发，wrap 高度投递窗尾独立执行（两通路不互相吞并）', async () => {
    const { wrapRo, scrollRo, followIfStuck } = mountTriggers()

    scrollRo.dispatch() // resize 通路：立即排外层 rAF
    dispatchWrapHeightChange(wrapRo, 500) // wrap 通路：进 debounce 窗（250ms）
    await vi.advanceTimersByTimeAsync(16)
    expect(followIfStuck).toHaveBeenCalledTimes(1) // resize 即时已执行

    await vi.advanceTimersByTimeAsync(RO_FOLLOW_DEBOUNCE_MS + 16) // 窗尾到期 + flush rAF
    expect(followIfStuck).toHaveBeenCalledTimes(2) // wrap 窗尾独立补一次
  })

  it('wrap RO 高度变化 → 窗内静默（不立即跟随），窗尾到期才跟随一次', async () => {
    const { wrapRo, followIfStuck } = mountTriggers()

    dispatchWrapHeightChange(wrapRo, 500) // wrap 高度变、tail 未变

    await vi.advanceTimersByTimeAsync(16) // 即使 flush 外层 rAF 也不触发（触发支在 debounce 窗内）
    expect(followIfStuck).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(RO_FOLLOW_DEBOUNCE_MS + 16) // 窗尾到期 + flush rAF
    expect(followIfStuck).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledWith()
  })

  it('store watch 通路保持直调（不套外层 rAF）：renderItems 条数变化 nextTick 内即触发', async () => {
    const { renderItems, followIfStuck } = mountTriggers()

    renderItems.value = [turnItem('m1', '你好', false)]
    await nextTick()

    // 未 flush 任何 rAF：条数 watch 通路不经外层 rAF 也不经 debounce 门（append / 前插 /
    // bash append 同型，估算高度误差由 wrap 触发支窗尾兜底收敛）。
    // 无参调用形态：脱离态不滚的 guard 语义在 useVirtuaFollow 原语内部。
    expect(followIfStuck).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledWith()
  })

  it('dispose 取消 pending 外层 rAF：dispatch 后卸载，flush 后不产生幽灵 follow', async () => {
    const { wrapper, scrollRo, followIfStuck } = mountTriggers()

    scrollRo.dispatch()
    expect(followIfStuck).not.toHaveBeenCalled()

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(32)
    expect(followIfStuck).not.toHaveBeenCalled()
  })

  it('dispose 清 debounce 计时器：wrap 投递后卸载，窗尾到期不产生幽灵 follow', async () => {
    const { wrapper, wrapRo, followIfStuck } = mountTriggers()

    dispatchWrapHeightChange(wrapRo, 500)
    expect(followIfStuck).not.toHaveBeenCalled()

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(RO_FOLLOW_DEBOUNCE_MS + 32)
    expect(followIfStuck).not.toHaveBeenCalled() // 计时器随 dispose 清理，窗尾不补滚
  })

  // ── 流式跟随主触发（数据信号通路）：观察对象 = 全部 streaming 回合文本总长 ──
  it('数据通路双 rAF：streaming 回合文本增长 → 不立即执行，flush 一帧后 followIfStuck 一次', async () => {
    const { renderItems, followIfStuck } = mountTriggers()

    renderItems.value = [turnItem('t1', '回答开头', true)]
    await nextTick() // 基线：首次赋值建立 getter 基线（0 → 长度，触发一次）
    const baseline = followIfStuck.mock.calls.length

    renderItems.value = [turnItem('t1', '回答开头 + 流式增量', true)]
    await nextTick() // watch 回调 → followFromRo 排外层 rAF（不直调）
    expect(followIfStuck.mock.calls.length).toBe(baseline) // 外层 rAF pending，尚未执行

    await vi.advanceTimersByTimeAsync(16) // flush 外层 rAF（内层 rAF 在 followIfStuck 原语内）
    expect(followIfStuck.mock.calls.length).toBe(baseline + 1)
  })

  it('数据通路 cancel 合并：同帧两次文本增长（同 turn 不可变替换）只产生一次 followIfStuck', async () => {
    const { renderItems, followIfStuck } = mountTriggers()

    renderItems.value = [turnItem('t1', '基线', true)]
    await nextTick()
    await vi.advanceTimersByTimeAsync(16) // 首次赋值（0 → 总长）的基线触发 flush 完毕，再清计数
    followIfStuck.mockClear()

    renderItems.value = [turnItem('t1', '基线+增量一', true)]
    await nextTick()
    renderItems.value = [turnItem('t1', '基线+增量一二', true)]
    await nextTick() // 同帧第二次：cancel 旧外层 rAF 重排

    await vi.advanceTimersByTimeAsync(16)
    expect(followIfStuck).toHaveBeenCalledTimes(1)
  })

  it('非 streaming 回合文本变化不触发数据通路（getter 内聚 isStreaming 判定）', async () => {
    const { renderItems, followIfStuck } = mountTriggers()

    renderItems.value = [turnItem('t1', '已完成回答', false)]
    await nextTick()
    followIfStuck.mockClear()

    renderItems.value = [turnItem('t1', '已完成回答（编辑改写）', false)]
    await nextTick()
    await vi.advanceTimersByTimeAsync(RO_FOLLOW_DEBOUNCE_MS + 16)

    expect(followIfStuck).not.toHaveBeenCalled()
  })

  it('双工作态窗口：streaming 回合退居非末位（bash 项 append 到末位）其文本增长仍触发', async () => {
    const { renderItems, followIfStuck } = mountTriggers()

    // bash 系统消息 append 后末位是 bashExecution 项，streaming turn 退居倒数第二
    renderItems.value = [turnItem('t1', '回答开头', true), bashItem('b1')]
    await nextTick()
    await vi.advanceTimersByTimeAsync(16) // 场景建立期的触发 flush 完毕，再清计数
    followIfStuck.mockClear()

    renderItems.value = [turnItem('t1', '回答开头 + 退居非末位仍增长', true), bashItem('b1')]
    await nextTick()
    await vi.advanceTimersByTimeAsync(16)

    expect(followIfStuck).toHaveBeenCalledTimes(1) // 旧「末条」getter 对该形态失明，新观察对象覆盖
  })

  // ── debounce 静默窗两态（D2：流式期间触发支零执行 / 窗外投递窗尾触发）──
  it('debounce 静默窗·态一：流式期间高频投递（间隔 < 窗口值）触发支零执行，测量支每投递照常喂', async () => {
    const { wrapRo, followIfStuck, refreshDistanceSnapshot } = mountTriggers()

    // 模拟流式渲染：每 50ms 一轮高度投递（< 250ms 窗口值，计时器不断被重置）
    for (let i = 1; i <= 10; i += 1) {
      dispatchWrapHeightChange(wrapRo, i * 100)
      await vi.advanceTimersByTimeAsync(50)
      expect(followIfStuck).not.toHaveBeenCalled() // 触发支整个「流式期间」零执行
    }

    expect(refreshDistanceSnapshot).toHaveBeenCalledTimes(10) // 测量支不受门：每投递喂快照（胶囊浮现即时性）
    expect(followIfStuck).not.toHaveBeenCalled()
  })

  it('debounce 静默窗·态二：窗外投递（静默窗到期后）经 followFromRo 双 rAF 触发一次', async () => {
    const { wrapRo, followIfStuck } = mountTriggers()

    dispatchWrapHeightChange(wrapRo, 500) // 最后一轮投递
    await vi.advanceTimersByTimeAsync(RO_FOLLOW_DEBOUNCE_MS) // 静默窗到期（流停 / 间隙超窗）
    expect(followIfStuck).not.toHaveBeenCalled() // 到期走 followFromRo：外层 rAF 先 pending

    await vi.advanceTimersByTimeAsync(16) // flush 外层 rAF
    expect(followIfStuck).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledWith()
  })

  it('S7 载体：dev 构建窗尾到期输出一条含本窗重置次数的汇总（不逐投递刷屏）', async () => {
    if (!import.meta.env.DEV) throw new Error('本用例依赖 dev 构建（vitest 默认 DEV=true）')
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { wrapRo, followIfStuck } = mountTriggers()

    // 高频投递 3 轮（首投递建窗 + 2 次重置），随后静默到期
    for (let i = 1; i <= 3; i += 1) {
      dispatchWrapHeightChange(wrapRo, i * 100)
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(infoSpy).not.toHaveBeenCalled() // 流式期间零输出（防刷屏）

    await vi.advanceTimersByTimeAsync(RO_FOLLOW_DEBOUNCE_MS + 16)
    expect(followIfStuck).toHaveBeenCalledTimes(1) // 窗尾确实执行
    expect(infoSpy).toHaveBeenCalledTimes(1) // 汇总只输出一条
    expect(String(infoSpy.mock.calls[0]?.[0])).toMatch(/重置 2 次/) // 含本窗重置次数
  })

  // ── 用户主动发送 → 强制回底重锚定（feat-new-message-to-bottom，触发矩阵末行）──
  // [chat-flow-consistency F1] 语义分层：本文件只验「触发判定」（提交序号递增 →
  // followToBottomForce）；force 原语本身的完整重置面（无视 stickToBottom / NaN 快照 / 开收敛
  // 抑制窗）已在 use-virtua-follow.test.ts W1TC8 覆盖。旧「尾部新增 user 消息」watch 已删除：
  // morph 回执重建复用 user 消息身份尾插命中旧 watch 强拉回底——序号判据结构性排除。
  it('提交序号递增（用户主动发送，submitNewMessage 单点 +1）→ followToBottomForce', async () => {
    const { submitSeq, followToBottomForce } = mountTriggers()

    await nextTick()
    expect(followToBottomForce).not.toHaveBeenCalled() // 基线：无提交

    submitSeq.value += 1
    await nextTick()
    expect(followToBottomForce).toHaveBeenCalledTimes(1)
  })

  it('morph 回执重建（user 消息尾插但提交序号不动）→ 不 force（旧 watch 的误拉回底形态已消除）', async () => {
    const { renderItems, submitSeq, followToBottomForce } = mountTriggers()

    // 验收形态（impl-plan U4「morph 回执不再强拉回底」）：用户上翻阅读中，steer 插话
    // 注入回执到达——user-delivery 复用原 clientUuid 尾插 user 消息，submitSeq 不变。
    renderItems.value = [turnItem('u1', '第一问回答', false)]
    await nextTick()
    renderItems.value = [...renderItems.value, turnItem('u2', '插话回执重建', false)] // 尾插新 turn
    await nextTick()

    expect(submitSeq.value).toBe(0)
    expect(followToBottomForce).not.toHaveBeenCalled()
  })

  it('提交序号递减（session 切换读到另一分区更小值）→ 不 force', async () => {
    const { submitSeq, followToBottomForce } = mountTriggers()

    submitSeq.value = 5
    await nextTick()
    expect(followToBottomForce).toHaveBeenCalledTimes(1) // 前置递增正常触发（对照）
    followToBottomForce.mockClear()

    submitSeq.value = 2 // 切 session 后 watch 源读到新分区值（更小）
    await nextTick()

    expect(followToBottomForce).not.toHaveBeenCalled()
  })

  // ── [chat-flow-consistency F2] 脱离态几何快照刷新调用点接线 ──
  it('F2: wrap RO 高度变化 → 测量支即时喂快照刷新，触发支窗尾跟随', async () => {
    const { wrapRo, followIfStuck, refreshDistanceSnapshot } = mountTriggers()

    dispatchWrapHeightChange(wrapRo, 500) // wrap 分量高度变化
    expect(refreshDistanceSnapshot).toHaveBeenCalledTimes(1) // 测量支同步喂（脱离态胶囊即时浮现）

    await vi.advanceTimersByTimeAsync(RO_FOLLOW_DEBOUNCE_MS + 16)
    expect(followIfStuck).toHaveBeenCalledTimes(1) // 触发支窗尾跟随
  })

  it('F2: 纯宽度变化（高度未变）→ 不喂快照刷新（测量支 no-op 门，与跟随同门）', async () => {
    const { wrapRo, refreshDistanceSnapshot } = mountTriggers()

    wrapRo.dispatch([{ contentRect: { height: 0 } as DOMRectReadOnly }])
    await vi.advanceTimersByTimeAsync(RO_FOLLOW_DEBOUNCE_MS + 16)

    expect(refreshDistanceSnapshot).not.toHaveBeenCalled()
  })

  it('F2: renderItems 条数 watch → refreshDistanceSnapshot 与 followIfStuck 同点触发', async () => {
    const { renderItems, followIfStuck, refreshDistanceSnapshot } = mountTriggers()

    renderItems.value = [turnItem('m1', '你好', false)]
    await nextTick()

    expect(refreshDistanceSnapshot).toHaveBeenCalledTimes(1)
    expect(followIfStuck).toHaveBeenCalledTimes(1)
  })
})

// ══════════ 来源节：composables/derive-status（原 node 环境文件；节内 hook 原样）══════════

describe('T3: useSessionDerivations 注入 extensionUIStore.hasPendingBlockingOverlay（集成）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('extensionUIStore 有表单 pending → derivedStatus 响应式 = waiting；respond 后回落 done', async () => {
    // 延迟 import：invalidateStatusCache 需在每次 pinia 重置后清理模块级缓存，
    // 避免 computed 持有上个用例的旧 store 闭包（对齐 session-active-state.test.ts 模式；
    // 下同——本文件两个 describe 共用此模式）
    const { useSessionDerivations, invalidateStatusCache } = await import(
      '@/composables/features/chat/useSessionDerivations'
    )
    const { useExtensionUIStore } = await import('@/stores/extension-ui')
    invalidateStatusCache()

    const { derivedStatus } = useSessionDerivations()
    const extensionUIStore = useExtensionUIStore()
    const sessionId = 's-int'

    // 初始无 pending → 未 hydrate + 非活跃 → done
    expect(derivedStatus(sessionId).value).toBe('done')

    // push 一个表单请求（form=true，legacy askUser 帧归一后形状）
    extensionUIStore.addRequest(sessionId, {
      sessionId,
      requestId: 'r1',
      dialogKind: 'select',
      form: true,
    })
    // 响应式：computed 应重算为 waiting
    expect(derivedStatus(sessionId).value).toBe('waiting')

    // respond（removeRequest）后回落 done
    extensionUIStore.removeRequest(sessionId, 'r1')
    expect(derivedStatus(sessionId).value).toBe('done')
  })
})

describe('scheduler 表单 pending → derivedStatus waiting（form 键判定联动）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('extensionUIStore 有 scheduler 表单 pending（legacy 帧归一 form 键）→ derivedStatus 响应式 = waiting；respond 后回落 done', async () => {
    const { useSessionDerivations, invalidateStatusCache } = await import(
      '@/composables/features/chat/useSessionDerivations'
    )
    const { useExtensionUIStore } = await import('@/stores/extension-ui')
    invalidateStatusCache()

    const { derivedStatus } = useSessionDerivations()
    const extensionUIStore = useExtensionUIStore()
    const sessionId = 's-sc'

    // 初始无 pending → 未 hydrate + 非活跃 → done
    expect(derivedStatus(sessionId).value).toBe('done')

    // push 一个 scheduler 表单请求（legacy scheduleCreate 帧归一后形状：原键保留 + form 附加）
    extensionUIStore.addRequest(sessionId, {
      sessionId,
      requestId: 'r-sc',
      dialogKind: 'select',
      form: true,
      scheduleCreate: true,
      scheduleDraft: { kind: 'recurring', schedule: '0 9 * * *', prompt: 'p', models: [] },
    })
    // 响应式：computed 应重算为 waiting
    expect(derivedStatus(sessionId).value).toBe('waiting')

    // respond（removeRequest）后回落 done
    extensionUIStore.removeRequest(sessionId, 'r-sc')
    expect(derivedStatus(sessionId).value).toBe('done')
  })
})

// ══════════ 来源节：panel/tray/tray-order（纯函数 + 渲染栈；零 mock）══════════

describe('orderTrayWidgetIds（D6：known-order + 当前插入序）', () => {
  it('known-order 优先：todo 恒在 goal 前，与传入数组序无关', () => {
    expect(orderTrayWidgetIds(['goal', 'todo'])).toEqual(['todo', 'goal'])
    expect(orderTrayWidgetIds(['todo', 'goal'])).toEqual(['todo', 'goal'])
    // 前置顺序来源是常量表（外部可读，作为宿主契约的单一登记处）
    expect(TRAY_WIDGET_KNOWN_ORDER).toEqual(['todo', 'goal'])
  })

  it('未知 key 按传入数组序追加在 known-order 之后', () => {
    expect(orderTrayWidgetIds(['custom-b', 'todo', 'custom-a', 'goal'])).toEqual([
      'todo',
      'goal',
      'custom-b',
      'custom-a',
    ])
  })

  it('known-order 缺失即跳过，不产生幽灵条目', () => {
    expect(orderTrayWidgetIds(['todo', 'only-custom'])).toEqual(['todo', 'only-custom'])
    expect(orderTrayWidgetIds(['only-custom'])).toEqual(['only-custom'])
    expect(orderTrayWidgetIds([])).toEqual([])
  })

  it('纯函数：不改入参、每次返回新数组', () => {
    const input = ['goal', 'todo', 'x']
    const out = orderTrayWidgetIds(input)
    expect(input).toEqual(['goal', 'todo', 'x'])
    expect(out).not.toBe(input)
    expect(orderTrayWidgetIds(input)).not.toBe(out)
  })

  it('「当前插入序」契约：invalidate 后重注册的未知 key 落尾部（Map delete+set 语义）', () => {
    // ViewHostStore 内部 Map 的插入序 = getViewIds 返回数组序（ECMAScript 规范语义）
    const views = new Map<string, number>()
    views.set('todo', 1)
    views.set('goal', 2)
    views.set('alpha', 3)
    views.set('beta', 4)
    const order = () => orderTrayWidgetIds([...views.keys()])
    expect(order()).toEqual(['todo', 'goal', 'alpha', 'beta'])

    // widget 清屏（setWidget(key, undefined) → invalidate → 删键）
    views.delete('alpha')
    expect(order()).toEqual(['todo', 'goal', 'beta'])

    // 重注册 = 新插入键 → 落到尾部（不回原位；宿主不新增 seq 字段）
    views.set('alpha', 5)
    expect(order()).toEqual(['todo', 'goal', 'beta', 'alpha'])
  })

  it('known-order 内的 key 不受重注册影响：清屏重注册后仍在最前位', () => {
    const views = new Map<string, number>()
    views.set('custom', 1)
    views.set('goal', 2)
    views.delete('goal')
    views.set('goal', 3)

    // goal 的 Map 位置已移到 custom 之后，但 known-order 把它拉回前置位
    expect([...views.keys()]).toEqual(['custom', 'goal'])
    expect(orderTrayWidgetIds([...views.keys()])).toEqual(['goal', 'custom'])
  })
})

// ── 使用者视角：排序结果 = 用户看到的按钮顺序（渲染栈最小复刻）──
describe('orderTrayWidgetIds 渲染栈（观察者视角：顺序即 DOM 顺序）', () => {
  it('响应式 viewIds 变化后，DOM 顺序随排序结果重算', async () => {
    const state = reactive({ viewIds: ['custom-b', 'goal', 'custom-a', 'todo'] })
    const host = defineComponent({
      setup() {
        const ordered = computed(() => orderTrayWidgetIds(state.viewIds))
        return () =>
          h(
            'div',
            { 'data-testid': 'tray-order-strip' },
            ordered.value.map((id) => h('span', { 'data-testid': 'tray-order-item', key: id }, id)),
          )
      },
    })
    const wrapper = mount(host)
    const readOrder = (): string[] =>
      wrapper.findAll('[data-testid="tray-order-item"]').map((n) => n.text())

    expect(readOrder()).toEqual(['todo', 'goal', 'custom-b', 'custom-a'])

    state.viewIds = ['goal', 'todo']
    await wrapper.vm.$nextTick()
    expect(readOrder()).toEqual(['todo', 'goal'])
  })
})

// ══════════ 来源节：panel/model-picker-data（纯函数；零 mock；相对路径已改写）══════════

/** fixture（ProviderId 是品牌类型，与 model-select-popover.test.ts 同款断言式构造）。 */
function model(providerId: string, id: string, name = id) {
  return { id, name, providerId, providerName: providerId }
}

const MODELS = [
  model('zai-coding-cn', 'glm-5.3-flash', 'GLM-5.3-Flash'),
  model('xiaomi-token-plan-cn', 'mimo-v2.6-flash', 'MiMo-V2.6-Flash'),
] as unknown as ModelInfo[]

describe('canonicalizeModelRef — 选中 ref 模型段大小写归一', () => {
  it('引擎目录拼写命中 pi 行（大小写不敏感）：回写 pi 行原生 id', () => {
    expect(canonicalizeModelRef('zai-coding-cn/GLM-5.3-Flash', MODELS)).toBe('zai-coding-cn/glm-5.3-flash')
  })

  it('已是 pi 行原生拼写：恒等返回（热切回执 / 覆盖意图分支统一套用无副作用）', () => {
    expect(canonicalizeModelRef('zai-coding-cn/glm-5.3-flash', MODELS)).toBe('zai-coding-cn/glm-5.3-flash')
  })

  it('provider 不在清单：原样返回（不伪造匹配）', () => {
    expect(canonicalizeModelRef('account:bigmodel-individual-coding-plan/GLM-5.3-Flash', MODELS)).toBe(
      'account:bigmodel-individual-coding-plan/GLM-5.3-Flash',
    )
  })

  it('provider 命中但模型段无匹配：原样返回', () => {
    expect(canonicalizeModelRef('zai-coding-cn/model-not-registered', MODELS)).toBe('zai-coding-cn/model-not-registered')
  })

  it('裸 id（不含 /）：恒等返回', () => {
    expect(canonicalizeModelRef('glm-5.3-flash', MODELS)).toBe('glm-5.3-flash')
  })

  it('同 short-id 多 provider：providerId 圈定行集，不跨 provider 误归一', () => {
    const models = [...MODELS, model('other-provider', 'GLM-5.3-FLASH')] as unknown as ModelInfo[]
    expect(canonicalizeModelRef('zai-coding-cn/GLM-5.3-Flash', models)).toBe('zai-coding-cn/glm-5.3-flash')
  })
})

// ══════════ 来源节：panel.store（原 node 环境文件；节内 hook 原样）══════════

describe('usePanelStore 单 panel 状态（v2：移除 split）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('初始态：单 panel、currentLeaf 存在、activePanelId=ROOT_PANEL_ID、focusedSessionId=null', () => {
    const panel = usePanelStore()
    expect(panel.currentLeaf).toBeDefined()
    expect(panel.currentLeaf.id).toBe(ROOT_PANEL_ID)
    expect(panel.activePanelId).toBe(ROOT_PANEL_ID)
    expect(panel.focusedSessionId).toBe(null)
  })

  it('loadSession：目标 leaf 不可变替换（原 leaf 对象引用改变）', () => {
    const panel = usePanelStore()
    const leafBefore = panel.currentLeaf
    panel.loadSession(ROOT_PANEL_ID, 's-load')
    const leafAfter = panel.currentLeaf
    expect(leafAfter.sessionId).toBe('s-load')
    // leaf 对象被替换（不可变更新，非就地突变），保证 Vue 响应式触发
    expect(leafAfter).not.toBe(leafBefore)
    // focusedSessionId 跟随 layout.value.sessionId
    expect(panel.focusedSessionId).toBe('s-load')
  })

  it('loadSession 对不存在的 panelId 是 no-op', () => {
    const panel = usePanelStore()
    const layoutBefore = panel.layout
    panel.loadSession('no-such-panel', 's1')
    expect(panel.layout).toBe(layoutBefore)
  })

  it('findPanelBySession：命中返回叶子，未命中返回 null', () => {
    const panel = usePanelStore()
    expect(panel.findPanelBySession('s1')).toBeNull()
    panel.loadSession(ROOT_PANEL_ID, 's-x')
    const found = panel.findPanelBySession('s-x')
    expect(found?.id).toBe(ROOT_PANEL_ID)
  })
})
