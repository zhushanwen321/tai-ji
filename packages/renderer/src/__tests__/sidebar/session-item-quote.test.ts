/**
 * 簇 1-7 合并产物（round5-f U5，主文件 session-item-quote）。
 *
 * 来源（基名）：
 *   - sidebar/session-item-quote.test.ts（主文件，3 例）
 *   - sidebar/session-item-assign-project.test.ts（5 例）
 *   - sidebar/sidebar-layout.test.ts（3 例）
 *   - effects/use-message-stream-rail-virtua.test.ts（13 例，相对 import 改写）
 *   - useSidebar-hydrate-turn-expansion.test.ts（2 例）
 *
 * 改造登记（保留式 mock，模板参照 command-popover-landing 先例）：
 *   - '@/stores/session' 原窄替换（仅 active/list/applySnapshot 三键）改为 spread
 *     actual 全成员：quote 节显式控制 active 时（sessionState.active !== undefined）
 *     返回真实 store 快照 + active 覆写（对 quote 节等价原窄替换形态）；未控制时
 *     直通真实 store（hydrate 节真实 useSidebar 13 步切入链要 groups/list/activeId
 *     全成员与响应性，零影响）。quote 节 afterEach 复位 sessionState.active。
 *
 * 剔出：effects/tool-status-flip.test.ts（6 例，清单既定剔出——useChat/useChatViewDeps
 * mock 与 useSidebar-hydrate 真实链交叉）。
 *
 * 合并纪律：describe/it 名零改动；各节原文件级钩子下沉包裹层 describe；
 * rail-virtua 节 './_virtua-mock-helper' 改写为 '../effects/_virtua-mock-helper'
 * （跨目录搬运，波 1 簇 2-4 先例）；hydrate 节的 @/api / useFileTree / useNewTaskFlow
 * 三 mock 为文件级 vi.mock（对 sidebar 三节零消费链，自检核）。
 *
 * 节序约束（不可重排）：assign-project 节必须在所有挂载 SessionItem 的节之前——
 * useSessionMarkers 模块级 cache 只 hydrate 一次，assign-project 的 unread 用例
 * 依赖「本文件首个 SessionItem 挂载发生在其用例内」hydrate 到其写入的 markers。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, computed, defineComponent, h, ref, shallowRef, effectScope } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

import SessionItem from '@/components/sidebar/SessionItem.vue'
import SegmentedTab from '@/components/sidebar/SegmentedTab.vue'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'
import { expectTextOnlyTabs } from '../helpers/sidebar-mount'
import type { VirtualizerHandle } from 'virtua/vue'
import { useMessageStreamRail } from '@/composables/panel/useMessageStreamRail'
import type { MessageTurn, RenderItem } from '@/composables/logic/messageTurns'
import { createMockVlist } from '../effects/_virtua-mock-helper'
import { resetAppBootstrap } from '@/composables/features/sidebar/useSidebar'
import { useChatStore } from '@/stores/chat'
import { useTurnExpansionStore } from '@/stores/turn-expansion'

/* ══ 来源：session-item-quote 的 mock（U5 改造点） ══ */

// sessionStore 状态源：SessionItem 读 active 决定注入目标路由（可变 active 覆盖两场景）
const sessionState = vi.hoisted(() => ({
  active: undefined as { id: string; cwd: string } | undefined,
}))
// [U5 保留式改造] 见文件头「改造登记」
vi.mock('@/stores/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/session')>()
  return {
    ...actual,
    useSessionStore: () => {
      const store = actual.useSessionStore()
      return sessionState.active === undefined ? store : { ...store, active: sessionState.active }
    },
  }
})

/* ══ 来源：useSidebar-hydrate-turn-expansion 的 mock（@/api 域 + useFileTree / useNewTaskFlow） ══ */

vi.mock('@/api', () => ({
  chat: { getHistory: vi.fn(() => Promise.resolve({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })), streamSubscribe: vi.fn(() => () => {}) },
  session: {
    list: vi.fn(() => Promise.resolve([])),
    create: vi.fn(() => Promise.resolve({ id: 'mock', label: 'mock', cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 })),
    switchSession: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    removeByCwd: vi.fn(() => Promise.resolve({ cwd: '/proj', deleted: [], failed: [] })),
    rename: vi.fn(() => Promise.resolve()),
    restoreSession: vi.fn(() => Promise.resolve({ id: 'mock', label: 'mock', cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 })),
    getCommands: vi.fn(() => Promise.resolve({ sessionId: 'mock', commands: [] })),
    getContext: vi.fn(() => Promise.resolve({ inputTokens: 0, contextLimit: 0, usagePercent: 0 })),
    getSubagents: vi.fn(() => Promise.resolve({ subagents: [], oversize: false, found: true })),
    getWorkflows: vi.fn(() => Promise.resolve({ workflows: [], oversize: false, found: true })),
    setProject: vi.fn(() => Promise.resolve()),
    setThinkingLevel: vi.fn(() => Promise.resolve()),
    unsubscribe: vi.fn(() => Promise.resolve()),
  },
  extension: { scan: vi.fn(() => Promise.resolve({ extensions: [] })) },
  workspace: { listRecent: vi.fn(() => Promise.resolve([])), defaultSessionDir: vi.fn(() => Promise.resolve('')) },
  project: { load: vi.fn(() => Promise.resolve({ projects: [], activeProjectId: '' })) },
  file: { tree: vi.fn(() => Promise.resolve([])), expand: vi.fn(() => Promise.resolve([])) },
  git: { status: vi.fn(() => Promise.resolve({ sessionId: 'mock', isRepo: false, files: [] })) },
}))

// 切入链 sessionEntry.preloadFileTree 的文件树加载（本测试不需要树）
vi.mock('@/composables/features/file-tree/useFileTree', () => ({
  useFileTree: () => ({ loadTree: vi.fn(() => Promise.resolve()) }),
}))

// initApp 编排的 landing 入口：no-op 壳（本测试不消费 landing 态）
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({
    isActive: { value: false },
    currentSession: { value: null },
    currentCwd: { value: null },
    currentModel: { value: null },
    startFlow: vi.fn(() => Promise.resolve()),
    presetCwd: vi.fn(),
    cancelFlow: vi.fn(),
  }),
  resetNewTaskFlow: vi.fn(),
}))

import { useSidebar } from '@/composables/features/sidebar/useSidebar'

/* ════════ 来源：sidebar/session-item-assign-project.test.ts ════════ */

describe('session-item-assign-project', () => {
  function mountItem(sessionOverrides: Record<string, unknown> = {}, projectId?: string) {
    return mount(SessionItem, {
      attachTo: document.body,
      props: {
        session: {
          id: 's1',
          label: '会话 1',
          cwd: '/p',
          lastActiveAt: 0,
          ...sessionOverrides,
          ...(projectId !== undefined ? { projectId } : {}),
        },
        active: false,
        status: 'done' as never,
      },
    })
  }

  /** 打开归入项目菜单并返回 body 中的选项元素数组（可指定 session 归属 projectId） */
  async function openAssignMenu(projectId?: string): Promise<HTMLElement[]> {
    const wrapper = mountItem({}, projectId)
    await wrapper.find('[data-testid="assign-project-btn"]').trigger('click')
    await nextTick()
    return Array.from(document.body.querySelectorAll('[data-testid="assign-project-option"]'))
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.removeItem('taiji:session-markers')
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  describe('SessionItem 未读圆点（review S-5）', () => {
    it('unread=true → 渲染 session-unread-dot（bg-accent 实心）', () => {
      localStorage.setItem('taiji:session-markers', JSON.stringify({ s1: { unread: true } }))
      const wrapper = mountItem()
      const dot = wrapper.find('[data-testid="session-unread-dot"]')
      expect(dot.exists()).toBe(true)
      expect(dot.classes()).toContain('bg-accent')
    })

    it('unread=false → 不渲染 unread dot，7px 状态 icon 存在', () => {
      // 注意：markers 模块级 cache 只 hydrate 一次（首查即定），此用例用另一 session id 避免读到上例缓存
      const wrapper = mountItem({ id: 's2' })
      expect(wrapper.find('[data-testid="session-unread-dot"]').exists()).toBe(false)
      // 新范式：状态 icon 始终存在（7px 单一 icon 范式），无透明占位 span
      expect(wrapper.find('[data-testid="session-icon"]').exists()).toBe(true)
    })
  })

  describe('SessionItem 归入项目菜单（review MF-7）', () => {
    it('菜单项 = 「默认项目」+ 全部命名 project（空名 project 不出现）', async () => {
      const store = useProjectStore()
      store.projects = [
        { id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 },
        { id: 'p1', name: 'Alpha', lastUsedAt: 0 },
        { id: 'p2', name: 'Beta', lastUsedAt: 0 },
        // 非规范 id 的空名 project：assignTargets 按 p.name 过滤，不应出现
        { id: 'p-empty', name: '', lastUsedAt: 0 },
      ]
      store.activeProjectId = 'p1'
      // loaded 态（§6.9）：无有效数据形态下归属入口整体隐藏，目标列表为空
      store.revision = 1
      store.loadState = 'loaded'

      const options = await openAssignMenu()
      expect(options.map((o) => o.textContent)).toEqual(['默认项目', 'Alpha', 'Beta'])
    })

    it('点选项 emit setProject {sessionId, projectId} 且菜单关闭', async () => {
      const store = useProjectStore()
      store.projects = [
        { id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 },
        { id: 'p1', name: 'Alpha', lastUsedAt: 0 },
      ]
      store.activeProjectId = 'p1'
      store.revision = 1 // loaded 态（§6.9）：无有效数据形态下归属入口整体隐藏
      store.loadState = 'loaded'

      const wrapper = mountItem({}, 'p1')
      await wrapper.find('[data-testid="assign-project-btn"]').trigger('click')
      await nextTick()

      // 归回默认项目（id=''）
      const defaultOption = Array.from(
        document.body.querySelectorAll('[data-testid="assign-project-option"]'),
      ).find((o) => o.textContent === '默认项目')!
      defaultOption.dispatchEvent(new MouseEvent('click'))
      await nextTick()

      expect(wrapper.emitted('setProject')).toEqual([[{ sessionId: 's1', projectId: '' }]])
      // 菜单关闭语义：reka PopoverContent data-state=closed（exit 动画依赖 transitionend，
      // happy-dom 不触发，内容不会卸载——以 state 断言关闭而非 DOM 消失）
      expect(document.body.querySelector('[data-state="closed"]')).not.toBeNull()
    })

    it('当前归属项 accent 高亮：命名归属 → 对应项；未归类（undefined）→ 默认项目项（review S-2）', async () => {
      const store = useProjectStore()
      store.projects = [
        { id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 },
        { id: 'p1', name: 'Alpha', lastUsedAt: 0 },
      ]
      store.activeProjectId = 'p1'
      store.revision = 1 // loaded 态（§6.9）：无有效数据形态下归属入口整体隐藏
      store.loadState = 'loaded'

      // 归属 p1 → Alpha 项行首勾标（spec 待裁决 3 既定方向：浮层复用右键菜单「移动到项目」
      // 分组渲染——行首 14px 定宽列 + accent Check，行本体保持中性字色）
      let options = await openAssignMenu('p1')
      const alpha = options.find((o) => o.textContent === 'Alpha')!
      const def = options.find((o) => o.textContent === '默认项目')!
      const alphaCheck = alpha.querySelector('svg')
      expect(alphaCheck).toBeTruthy()
      expect(alphaCheck?.classList.contains('text-accent')).toBe(true)
      expect(def.querySelector('svg')).toBeNull()
      expect(alpha.className).not.toContain('text-accent')
      document.body.innerHTML = ''

      // 未归类（无 projectId）→ 默认项目项勾标（(undefined || '') === '' 命中）
      options = await openAssignMenu()
      const def2 = options.find((o) => o.textContent === '默认项目')!
      const def2Check = def2.querySelector('svg')
      expect(def2Check).toBeTruthy()
      expect(def2Check?.classList.contains('text-accent')).toBe(true)
    })
  })
})

/* ════════ 来源：sidebar/session-item-quote.test.ts（主文件） ════════ */

describe('session-item-quote', () => {
  /** 本条被引用 session 的 fixture（sidebar 列表项） */
  const ITEM = { id: 's-item', label: '会话条目', cwd: '/p', lastActiveAt: 0 }

  function mountItem(): ReturnType<typeof mount> {
    return mount(SessionItem, {
      attachTo: document.body,
      props: { session: ITEM, active: false, status: 'done' as never },
    })
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.removeItem('taiji:session-markers')
    composerInjectionStore.clearInjection()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    // [U5 改造配套] 复位 active 控制——undefined = 直通真实 store（他节零影响）
    sessionState.active = undefined
  })

  describe('SessionItem 引用到输入区（写入侧）', () => {
    it('有活跃 session → target=current：目标 = 活跃 session，被引用 = 本条 session', async () => {
      sessionState.active = { id: 's-cur', cwd: '/p' }
      const wrapper = mountItem()
      // 2026-10-10 入口重设计：引用入口自 ghost 钮迁右键菜单（session-quote-item）
      await wrapper.find('.session-item').trigger('contextmenu')
      const item = document.body.querySelector('[data-testid="session-quote-item"]')
      expect(item).not.toBeNull()
      item!.dispatchEvent(new MouseEvent('click', { bubbles: true }))

      const store = composerInjectionStore
      expect(store.pendingInjection.value).toMatchObject({
        target: 'current',
        sessionId: 's-cur',
        refSessionId: 's-item',
        label: '会话条目',
      })
    })

    it('landing 态（无活跃 session）→ target=new + sessionId null（landing composer 消费）', async () => {
      sessionState.active = undefined
      const wrapper = mountItem()
      await wrapper.find('.session-item').trigger('contextmenu')
      const item = document.body.querySelector('[data-testid="session-quote-item"]')
      expect(item).not.toBeNull()
      item!.dispatchEvent(new MouseEvent('click', { bubbles: true }))

      const store = composerInjectionStore
      expect(store.pendingInjection.value).toMatchObject({
        target: 'new',
        sessionId: null,
        refSessionId: 's-item',
        label: '会话条目',
      })
    })

    it('引用自身（活跃 session 即本条）→ 正常注入无特判', async () => {
      sessionState.active = { id: 's-item', cwd: '/p' }
      const wrapper = mountItem()
      await wrapper.find('.session-item').trigger('contextmenu')
      const item = document.body.querySelector('[data-testid="session-quote-item"]')
      expect(item).not.toBeNull()
      item!.dispatchEvent(new MouseEvent('click', { bubbles: true }))

      const store = composerInjectionStore
      expect(store.pendingInjection.value).toMatchObject({
        target: 'current',
        sessionId: 's-item',
        refSessionId: 's-item',
      })
    })
  })
})

/* ════════ 来源：sidebar/sidebar-layout.test.ts ════════ */

describe('sidebar-layout', () => {
  beforeEach(() => {
    // SessionItem setup 内 useProjectStore（D14 归入项目菜单），mount 需激活 pinia
    setActivePinia(createPinia())
  })

  describe('D4: SessionItem hover 按钮定位', () => {
    function makeSession() {
      return {
        id: 'sess-1',
        label: 'Test Session',
        cwd: '/Users/test/project',
        lastActiveAt: Date.now(),
      }
    }

    it('hover 按钮容器覆盖行右侧定宽槽（2026-10-11 裁决：absolute inset-0 覆盖「点+时间」槽，不遮名称）', () => {
      const wrapper = mount(SessionItem, {
        props: {
          session: makeSession(),
          active: false,
          status: 'done' as never,
        },
      })
      // 契约：Actions 容器 = absolute inset-0 justify-end（覆盖 Display 右槽 58px，槽内
      // meta 悬停淡出）；名称块 flex-1 min-w-0 在槽左缘截断，钮构造性不遮名称。
      // 用 [class~=] 单词匹配避开 happy-dom 对 class 选择器中点/方括号转义的脆弱性。
      const actionsContainer = wrapper.find('.absolute[class~="inset-0"][class~="justify-end"]')
      expect(actionsContainer.exists()).toBe(true)
      expect(actionsContainer.classes()).toContain('gap-[2px]')
      // 右槽定宽 58px（三钮 18px×3 + gap 2×2 的覆盖预算）
      const slot = wrapper.find('.relative[class~="w-[58px]"]')
      expect(slot.exists()).toBe(true)
      // 状态点在右槽内（时间左侧），不在名称块前（2026-10-11 裁决改位）
      expect(slot.find('[data-testid="session-icon"]').exists()).toBe(true)
      const nameBlock = wrapper.find('.min-w-0.flex-1')
      expect(nameBlock.find('[data-testid="session-icon"]').exists()).toBe(false)
    })
  })

  describe('D5: SegmentedTab 文字 tab 形态', () => {
    it('count > 0 也不渲染数字与 icon（demo .vtab 文字 tab）', () => {
      const wrapper = mount(SegmentedTab, {
        props: {
          modelValue: 'sessions',
          sessionCount: 3,
          fileCount: 10,
        },
      })
      // badge 蓝点（原 absolute 定位 span）已移除
      expect(wrapper.find('.absolute.right-1.top-1').exists()).toBe(false)
      // 文字 tab：三按钮只含 label 文字，无 icon svg、无 count 数字
      const buttons = wrapper.findAll('button')
      expect(buttons).toHaveLength(3)
      expectTextOnlyTabs(buttons, ['3', '10'])
    })
  })

  describe('滚动修复：Sidebar 子视图区 overflow-hidden 防御', () => {
    it('Sidebar.vue 子视图区容器含 overflow-hidden（防止子组件溢出撑开 footer）', async () => {
      // 静态源码断言：Sidebar 整体 mount 依赖多个 store/composable，成本高且与滚动修复无关。
      // 滚动修复的关键是子视图区容器（SegmentedTab 下方）的 class，直接读源码验证。
      const fs = await import('node:fs')
      const path = await import('node:path')
      const sidebarPath = path.resolve(__dirname, '../../components/sidebar/Sidebar.vue')
      const source = fs.readFileSync(sidebarPath, 'utf-8')
      // 子视图区容器：min-h-0 flex-1 后须含 overflow-hidden；mt-1 已删（视觉复刻 MF-1-16：
      // flex 容器内不塌缩多出 4px，节奏由 SegmentedTab mb-2 承担）
      const hasOverflowHidden = /min-h-0\s+flex-1\s+overflow-hidden/.test(source)
      expect(hasOverflowHidden).toBe(true)
      expect(source).not.toMatch(/class="mt-1\s+min-h-0/)
    })
  })
})

/* ════════ 来源：effects/use-message-stream-rail-virtua.test.ts（helper 相对路径改写） ════════ */

describe('use-message-stream-rail-virtua', () => {
  /** 构造一个 turn RenderItem（index 可控；content 缺省 'q'，rail 派生视图摘要 = 'q'）。 */
  function turnItem(index: number, content = 'q'): RenderItem {
    return {
      kind: 'turn',
      turn: {
        index,
        user: { id: `u${index}`, role: 'user', content } as never,
        assistants: [],
        isStreaming: false,
        hasFoldable: false,
      } as MessageTurn,
    }
  }

  /** 构造 3 个 turn 的 renderItems（rail 索引空间 = 3 turns，renderItems 下标 0/1/2）。 */
  function makeRenderItems(): RenderItem[] {
    return [turnItem(1), turnItem(2), turnItem(3)]
  }

  /**
   * mount 一个 host 组件，setup 内调 useMessageStreamRail（composable 内 onMounted/onScopeDispose
   * 需 active component instance，用 host 组件包裹避免「no active effect scope」warning）。
   * 返回 rail composable 返回值 + host wrapper（unmount 触发 onScopeDispose 清理）。
   */
  function mountRail(opts: {
    renderItems?: RenderItem[]
    scrollEl?: HTMLElement | null
    vlistRef?: Ref<VirtualizerHandle | null>
  }): {
    rail: ReturnType<typeof useMessageStreamRail>
    wrapper: ReturnType<typeof mount>
    renderItemsRef: Ref<RenderItem[]>
  } {
    const sessionId = computed(() => 's-rail-virtua-test')
    // shallowRef 对齐生产语义：MessageStream 传入的 renderItems 是 computed（产出原始数组，
    // 无深代理）；deep ref 会把读取侧 item.turn 包成 reactive 代理，引用恒等断言拿不到原始引用。
    const renderItemsRef = shallowRef<RenderItem[]>(opts.renderItems ?? makeRenderItems())
    const scrollElRef = ref<HTMLElement | null>(opts.scrollEl ?? null)
    const vlistRef = opts.vlistRef ?? ref<VirtualizerHandle | null>(createMockVlist())
    let rail!: ReturnType<typeof useMessageStreamRail>
    const Host = defineComponent({
      setup() {
        rail = useMessageStreamRail({
          sessionId,
          renderItems: renderItemsRef,
          scrollEl: scrollElRef,
          vlistRef,
        })
        return () => h('div')
      },
    })
    const wrapper = mount(Host, { global: { plugins: [createPinia()] } })
    return { rail, wrapper, renderItemsRef }
  }

  /** 造一个有真实 scrollTop/scrollHeight/clientHeight 的 mock scrollEl（happy-dom 下 div 即可）。 */
  function makeScrollEl(): HTMLElement {
    const el = document.createElement('div')
    Object.defineProperty(el, 'scrollTop', { writable: true, value: 0 })
    Object.defineProperty(el, 'scrollHeight', { writable: true, value: 600 })
    Object.defineProperty(el, 'clientHeight', { writable: true, value: 200 })
    return el
  }

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('useMessageStreamRail · W2TC2: 传 mock vlistRef（virtua 路径）', () => {
    it('onJump 调 vlist.scrollToIndex(renderIdx, {align:"start"})', () => {
      const scrollEl = makeScrollEl()
      const mock = createMockVlist()
      const vlistRef = ref<VirtualizerHandle | null>(mock)
      const { rail } = mountRail({ scrollEl, vlistRef })

      rail.onJump(1) // renderItems 下标=1

      expect(mock.scrollToIndex).toHaveBeenCalledWith(1, { align: 'start' })
    })

    it('updateActiveTurnIndex 调 vlist.findItemIndex(v.scrollOffset)，写 activeTurnIndex', () => {
      // findItemIndex mock：返回固定 2（模拟 vlist 当前可见首项）
      const findItemIndex = vi.fn(() => 2)
      const mock = createMockVlist({ scrollOffset: 500, findItemIndex })
      const vlistRef = ref<VirtualizerHandle | null>(mock)
      const { rail } = mountRail({ vlistRef })

      rail.updateActiveTurnIndex()

      expect(findItemIndex).toHaveBeenCalledWith(500)
      expect(rail.activeTurnIndex.value).toBe(2)
    })

    it('updateActiveTurnIndex 把 renderItems 空间下标映射回 railTurns 空间（system 穿插场景）', () => {
      const renderItems: RenderItem[] = [
        turnItem(1),
        { kind: 'systemNotice', message: { id: 's1', role: 'system', content: 'x' } as never },
        turnItem(2),
        { kind: 'systemNotice', message: { id: 's2', role: 'system', content: 'y' } as never },
        turnItem(3),
      ]
      const findItemIndex = vi.fn(() => 4)
      const mock = createMockVlist({ scrollOffset: 800, findItemIndex })
      const vlistRef = ref<VirtualizerHandle | null>(mock)
      const { rail } = mountRail({ renderItems, vlistRef })

      rail.updateActiveTurnIndex()

      expect(findItemIndex).toHaveBeenCalledWith(800)
      expect(rail.activeTurnIndex.value).toBe(2)
    })

    it('onJump rail idx 映射回 renderItems 下标（系统提示行穿插场景）', () => {
      const renderItems: RenderItem[] = [
        { kind: 'systemNotice', message: { id: 's1', role: 'system', content: 'x' } as never },
        turnItem(1),
        { kind: 'systemNotice', message: { id: 's2', role: 'system', content: 'y' } as never },
        turnItem(2),
        turnItem(3),
      ]
      const scrollEl = makeScrollEl()
      const mock = createMockVlist()
      const vlistRef = ref<VirtualizerHandle | null>(mock)
      const { rail } = mountRail({ renderItems, scrollEl, vlistRef })

      rail.onJump(2) // rail idx 2 = turn3 → renderItems 下标 4

      expect(mock.scrollToIndex).toHaveBeenCalledWith(4, { align: 'start' })
    })

    it('[cw wave w4] vlistRef.value=null（首帧未挂载）→ onJump/updateActiveTurnIndex 早返回 no-op', () => {
      const scrollEl = makeScrollEl()
      const vlistRef = ref<VirtualizerHandle | null>(null)
      const { rail } = mountRail({ scrollEl, vlistRef })

      expect(() => rail.onJump(1)).not.toThrow()
      expect(() => rail.updateActiveTurnIndex()).not.toThrow()
      expect(rail.activeTurnIndex.value).toBe(0)
    })
  })

  describe('useMessageStreamRail · streaming perf（railTurns 引用恒等 + O(1) 下标索引）', () => {
    it('renderItems 替换数组引用但 turn 成员未变 → railTurns 复用上次数组引用（下游 props 不变即不重渲）', () => {
      const base = makeRenderItems()
      const { rail, renderItemsRef, wrapper } = mountRail({ renderItems: base })
      const first = rail.railTurns.value

      renderItemsRef.value = [...base]

      expect(rail.railTurns.value).toBe(first)
      wrapper.unmount()
    })

    it('turn 引用变化且 rail 派生视图摘要变化 → railTurns 产出新数组且未变成员引用逐项保留', () => {
      const base = makeRenderItems()
      const { rail, renderItemsRef, wrapper } = mountRail({ renderItems: base })
      const first = rail.railTurns.value
      const rebuiltLast = turnItem(4, 'changed question')

      renderItemsRef.value = [base[0]!, base[1]!, rebuiltLast]
      const second = rail.railTurns.value

      expect(second).not.toBe(first)
      expect(second[0]).toBe(first[0])
      expect(second[1]).toBe(first[1])
      expect(second[2]).toBe(rebuiltLast.turn)
      wrapper.unmount()
    })

    it('仅末位 turn 引用不同且 rail 派生视图摘要未变 → railTurns 复用旧数组引用（派生视图恒等放宽）', () => {
      const base = makeRenderItems()
      const { rail, renderItemsRef, wrapper } = mountRail({ renderItems: base })
      const first = rail.railTurns.value
      const rebuiltLast = turnItem(4) // content 同为 'q' → rail 派生视图摘要相同

      renderItemsRef.value = [base[0]!, base[1]!, rebuiltLast]

      expect(rail.railTurns.value).toBe(first)
      wrapper.unmount()
    })

    it('派生视图恒等复用后 onJump 末位 rail 下标仍跳到当前最新 turn（结构定位兜底）', () => {
      const base = makeRenderItems()
      const findItemIndex = vi.fn(() => 0)
      const mock = createMockVlist({ findItemIndex })
      const vlistRef = ref<VirtualizerHandle | null>(mock)
      const { rail, renderItemsRef, wrapper } = mountRail({ renderItems: base, vlistRef })
      rail.railTurns.value // 触发首次求值
      const rebuiltLast = turnItem(4) // 摘要相同 → 放宽复用

      renderItemsRef.value = [base[0]!, base[1]!, rebuiltLast]
      rail.onJump(2) // rail 末位下标

      expect(mock.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start' })
      wrapper.unmount()
    })

    it('派生视图恒等复用后 updateActiveTurnIndex 对末位新引用仍定位末位下标（补映射不退化）', () => {
      const base = makeRenderItems()
      const findItemIndex = vi.fn(() => 2)
      const mock = createMockVlist({ scrollOffset: 800, findItemIndex })
      const vlistRef = ref<VirtualizerHandle | null>(mock)
      const { rail, renderItemsRef, wrapper } = mountRail({ renderItems: base, vlistRef })
      rail.railTurns.value
      const rebuiltLast = turnItem(4)

      renderItemsRef.value = [base[0]!, base[1]!, rebuiltLast]
      rail.updateActiveTurnIndex()

      expect(rail.activeTurnIndex.value).toBe(2)
      wrapper.unmount()
    })

    it('railTurns 引用恒等连带 expandedTurns 不重算（非空 Set 引用稳定）——依赖链切断的可观测证据', () => {
      const base = makeRenderItems()
      const { rail, renderItemsRef, wrapper } = mountRail({ renderItems: base })
      rail.onToggle(0)
      const expanded = rail.expandedTurns.value
      expect(expanded.size).toBe(1)

      renderItemsRef.value = [...base]

      expect(rail.expandedTurns.value).toBe(expanded)
      wrapper.unmount()
    })

    it('O(1) 索引随 railTurns 重建同步更新：同一 turn 引用移动下标后仍定位新下标（检查索引过期回归）', () => {
      const moved = turnItem(2)
      const findItemIndex = vi.fn(() => 1)
      const mock = createMockVlist({ scrollOffset: 400, findItemIndex })
      const vlistRef = ref<VirtualizerHandle | null>(mock)
      const { rail, renderItemsRef, wrapper } = mountRail({
        renderItems: [turnItem(1), moved],
        vlistRef,
      })

      rail.updateActiveTurnIndex()
      expect(rail.activeTurnIndex.value).toBe(1)

      findItemIndex.mockImplementation(() => 0)
      renderItemsRef.value = [moved, turnItem(9)]
      rail.updateActiveTurnIndex()
      expect(rail.activeTurnIndex.value).toBe(0)
      wrapper.unmount()
    })

    it('updateActiveTurnIndex：可见首项为 system 项 → 保持上次 activeTurnIndex（映射分支行为不变）', () => {
      const renderItems: RenderItem[] = [
        turnItem(1),
        { kind: 'systemNotice', message: { id: 's1', role: 'system', content: 'x' } as never },
      ]
      const findItemIndex = vi.fn(() => 1)
      const mock = createMockVlist({ scrollOffset: 100, findItemIndex })
      const vlistRef = ref<VirtualizerHandle | null>(mock)
      const { rail, wrapper } = mountRail({ renderItems, vlistRef })

      rail.updateActiveTurnIndex()

      expect(rail.activeTurnIndex.value).toBe(0)
      wrapper.unmount()
    })
  })
})

/* ════════ 来源：useSidebar-hydrate-turn-expansion.test.ts ════════ */

describe('useSidebar-hydrate-turn-expansion', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    resetAppBootstrap()
  })

  describe('useSidebar chatPort.reconcileHistory 清 turn-expansion 分区接线（C4 重载重置侧）', () => {
    it('未 hydrate 会话切入（走盘重载）→ 展开分区被清（重置侧断言）', async () => {
      const expansion = useTurnExpansionStore()
      // 重载前的展开态（live 期 id；重载后 id 换空间，状态不应存活）
      expansion.expand('s-hydrate-fresh', 'turn-live-id')

      const scope = effectScope()
      const sidebar = scope.run(() => useSidebar())!
      await sidebar.selectSession('s-hydrate-fresh')

      expect(expansion.isExpanded('s-hydrate-fresh', 'turn-live-id')).toBe(false)
      scope.stop()
    })

    it('已 hydrate 会话切回（驻留期 reconcile 刷新）→ 展开分区保持（驻留保持侧断言）', async () => {
      const chat = useChatStore()
      const expansion = useTurnExpansionStore()

      const scope = effectScope()
      const sidebar = scope.run(() => useSidebar())!
      // 第一次切入：走盘重载（hydrate 分支）
      await sidebar.selectSession('s-hydrate-kept')
      // 驻留期手动展开（重载后用盘侧新 id 展开）
      expansion.expand('s-hydrate-kept', 'turn-reloaded-id')
      // 第二次切入：isHydrated=true → refreshHistory（reconcile），不得清展开
      await sidebar.selectSession('s-hydrate-kept')

      expect(chat.isHydrated('s-hydrate-kept')).toBe(true)
      expect(expansion.isExpanded('s-hydrate-kept', 'turn-reloaded-id')).toBe(true)
      scope.stop()
    })
  })
})
