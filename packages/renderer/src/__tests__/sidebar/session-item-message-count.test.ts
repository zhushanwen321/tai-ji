/**
 * 簇 1-1 合并产物（round5-f U3，主文件 session-item-message-count）。
 *
 * 来源（基名）：
 *   - sidebar/session-item-message-count.test.ts（主文件，5 例）
 *   - composables/modal-surface-registry/production-wiring.test.ts（8 例）
 *   - sidebar/session-item-agent-badge.test.ts（8 例）
 *   - sidebar/session-item-handoff-badge.test.ts（4 例）
 *   - sidebar/session-item-import-fresh.test.ts（4 例）
 *   - panel/btw-panel-contract-invisible.test.ts（3 例）
 *
 * 改造登记（保留式 mock，模板参照 command-popover-landing 先例）：
 *   - '@taiji/core/transport/api' 原窄替换（仅 command 转发 + RPC_BACKSTOP_TIMEOUT_MS
 *     两键）改为 spread actual 全成员 + 覆写 command（转发 commandMock）与
 *     RPC_BACKSTOP_TIMEOUT_MS（保持原测试值 5000，断言字面量与其对齐，不随真实常量漂移）。
 *
 * 剔出：App-runtime-start-error.test.ts（8 例，清单既定剔出——ToastContainer.vue 组件
 * 整体 stub 与 production-wiring 的真实注册互斥，组件 stub 不适用保留式）。
 *
 * 合并纪律：describe/it 名零改动；六节各外包一层 describe（原文件级钩子随之下沉）；
 * production-wiring 节置首（其 enableAutoUnmount 节内注册，先跑则全局跟踪表无他节
 * 残留 wrapper，卸载语义与原单文件等价）；btw 节原 enableAutoUnmount 改为节内手动
 * 登记本节 wrapper（防全局卸载已清 body 的他节残留，波 2a 同型教训）；btw 节 helper
 * import 置全文件 import 首位（@/api mock 工厂 TDZ 约束）。
 */
import { composerApiModuleActualWithBtw, composerBtwApiMock, btwLineGroups } from '../helpers/composer-mount'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { DialogRoot, PopoverRoot, SelectRoot, SelectTrigger } from 'reka-ui'
import type { SessionGroup } from '@taiji/shared'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import SessionItem from '@/components/sidebar/SessionItem.vue'
import SessionList from '@/components/sidebar/SessionList.vue'
import { __resetMessageCountCacheForTest } from '@/components/sidebar/session-item/use-message-count'
import {
  registerModalSurface,
  resetModalSurfaceRegistry,
  isModalSurfaceId,
  anyModalSurfaceYieldsEsc,
  anyModalSurfaceYieldsCmdW,
  openShieldingSurfaces,
  isModalSurfaceOpen,
} from '@/composables/features/app/modal-surface-registry'
import { MODAL_SURFACE_REGISTRAR_KEY, PopoverContent as UiPopoverContent, type UiModalSurfaceRegistration } from '@taiji/ui'
import { useToast } from '@/composables/useToast'
import { DialogContent as DialogContentWrapper } from '@/components/ui/dialog'
import { PopoverContent as PopoverContentWrapper } from '@/components/ui/popover'
import { SelectContent as SelectContentWrapper } from '@/components/ui/select'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import FormOverlay from '@/components/extension/form/FormOverlay.vue'
import {
  markImportedFresh,
  __resetImportedFreshForTest,
  IMPORT_FRESH_VISIBLE_MS,
  IMPORT_FRESH_FADE_MS,
} from '@/composables/features/sidebar/useImportSession'
import { bindDrawerSessionId, _resetDrawerForTest } from '@taiji/core/domain/drawer'
import BtwPanel from '@/components/panel/BtwPanel.vue'

/* ══ 来源：session-item-message-count 的 mock（U3 改造点） ══ */

const { commandMock } = vi.hoisted(() => ({ commandMock: vi.fn() }))

// [U3 保留式改造] 原窄替换 { command, RPC_BACKSTOP_TIMEOUT_MS } → spread actual
// 全成员 + 覆写两目标成员（RPC_BACKSTOP_TIMEOUT_MS 保持原测试值，断言字面量对齐）
vi.mock('@taiji/core/transport/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api')>()
  return {
    ...actual,
    command: (...args: unknown[]) => commandMock(...args),
    RPC_BACKSTOP_TIMEOUT_MS: 5000,
  }
})

/* ══ 来源：btw-panel-contract-invisible 的 mock（@/api btw 域局部替换 + 组件 stub） ══ */

// ── @/api 门面局部 mock：只替换 btw 域（同 btw-panel.test.ts 范式）──
vi.mock('@/api', (importActual) => composerApiModuleActualWithBtw(importActual))
// 断言锚点：btw 域 spy 单例（helper 持有，播种/断言经别名）
const btwApiMock = composerBtwApiMock

// ── MessageStream / Composer stub：渲染普通消息 / 表单 fixture 文本（可见非空面）──
// 注意：vi.mock 工厂被 hoist 到文件顶部，工厂内不得引用顶层 const——文案字面量内联。
vi.mock('@/components/panel/MessageStream.vue', async () => {
  const { defineComponent: dc, h: hs } = await import('vue')
  return {
    default: dc({
      name: 'MessageStream',
      setup: () =>
        () =>
          hs('div', { 'data-fixture': 'stream' }, [
            '普通消息 fixture：用户提问，助手给出回答。',
          ]),
    }),
  }
})
vi.mock('@/components/panel/Composer.vue', async () => {
  const { defineComponent: dc, h: hs } = await import('vue')
  return {
    default: dc({
      name: 'Composer',
      setup: () =>
        () =>
          hs('div', { 'data-fixture': 'composer' }, ['表单 fixture：输入消息']),
    }),
  }
})

/* ════════ 来源：composables/modal-surface-registry/production-wiring.test.ts（置首：auto-unmount 语义守恒） ════════ */

describe('production-wiring', () => {
  beforeEach(() => {
    resetModalSurfaceRegistry()
  })

  // 原文件级注册；本节置首执行，全局跟踪表内无他节残留 wrapper，卸载范围等价原单文件
  enableAutoUnmount(afterEach)

  /**
   * ui 桥注册的测试装配（App.vue 生产同款）：浮层三包装收敛至 @taiji/ui 后走
   * registerUiModalSurface provide/inject 桥自注册，宿主须 provide 桥把注册转接进
   * renderer registry（未装配桥 = ui 原语静默跳过注册，见下方「ui 包注册桥」describe）。
   */
  function uiBridgeProvide() {
    return {
      global: {
        provide: {
          [MODAL_SURFACE_REGISTRAR_KEY as symbol]: (registration: UiModalSurfaceRegistration): (() => void) => {
            if (!isModalSurfaceId(registration.surface)) {
              throw new Error(`modal-surface-registry: 未登记的表面 id '${registration.surface}'——先在 manifest.ts 登记（§6.7 完备性判据）`)
            }
            return registerModalSurface(registration)
          },
        },
      },
    }
  }

  /** 受控 DialogRoot 宿主（消费方形态：Dialog :open + DialogContent 常驻模板） */
  function mountDialogHost() {
    const open = ref(false)
    const wrapper = mount(defineComponent({
      setup() {
        return () =>
          h(DialogRoot, { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } }, {
            default: () => h(DialogContentWrapper),
          })
      },
    }), uiBridgeProvide())
    return { wrapper, open }
  }

  /** PopoverRoot 开关载体 mount 单源（open ref 可控；插槽内容与 mount options 由调用方给）。 */
  function mountPopoverRoot(content: () => ReturnType<typeof h>, options?: Parameters<typeof mount>[1]) {
    const open = ref(false)
    // open 读取必须留在渲染函数体内（每次渲染取 ref 当前值；提出即恒初始值）
    const host = defineComponent({
      setup: () => () => h(PopoverRoot, { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } }, { default: content }),
    })
    const wrapper = mount(host, options)
    return { open, wrapper }
  }

  describe('reka 托管弹层族（renderer 三包装）：开合态绑 root context open 状态本体', () => {
    it('dialog-confirm：开 → Esc/⌘W 双让位 + shieldsView unconditional；关 → 全复位', async () => {
      const host = mountDialogHost()
      expect(isModalSurfaceOpen('dialog-confirm'), '包装常驻挂载即注册（关态也在册）').toBe(false)
      expect(anyModalSurfaceYieldsEsc()).toBe(false)

      host.open.value = true
      await nextTick()
      expect(isModalSurfaceOpen('dialog-confirm')).toBe(true)
      expect(anyModalSurfaceYieldsEsc()).toBe(true)
      expect(anyModalSurfaceYieldsCmdW()).toBe(true)
      expect(openShieldingSurfaces()).toEqual([{ id: 'dialog-confirm', mode: 'unconditional' }])

      host.open.value = false
      await nextTick()
      expect(isModalSurfaceOpen('dialog-confirm')).toBe(false)
      expect(anyModalSurfaceYieldsEsc()).toBe(false)
      expect(anyModalSurfaceYieldsCmdW()).toBe(false)
      expect(openShieldingSurfaces()).toEqual([])
    })

    it('popover-content：开 → Esc 让位、⌘W 不让位（R4 双键拆分）+ shieldsView intersecting 带 rect', async () => {
      const { open, wrapper } = mountPopoverRoot(() => h(PopoverContentWrapper), uiBridgeProvide())
      void wrapper

      open.value = true
      await nextTick()
      await nextTick()
      expect(anyModalSurfaceYieldsEsc()).toBe(true)
      expect(anyModalSurfaceYieldsCmdW()).toBe(false)
      const report = openShieldingSurfaces()
      expect(report).toHaveLength(1)
      expect(report[0]!.id).toBe('popover-content')
      expect(report[0]!.mode).toBe('intersecting')
      expect(report[0]!.rect, 'rect 由内容根元素实测（happy-dom 全零 rect 仍成键）').toBeDefined()

      open.value = false
      await nextTick()
      await nextTick()
      expect(anyModalSurfaceYieldsEsc()).toBe(false)
      expect(openShieldingSurfaces()).toEqual([])
    })

    it('select-content：开 → Esc 让位、⌘W 不让位 + shieldsView intersecting；关 → 复位', async () => {
      const open = ref(false)
      mount(defineComponent({
        setup() {
          return () =>
            h(SelectRoot, { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } }, {
              default: () => [h(SelectTrigger), h(SelectContentWrapper)],
            })
        },
      }), uiBridgeProvide())

      open.value = true
      await nextTick()
      await nextTick()
      expect(anyModalSurfaceYieldsEsc()).toBe(true)
      expect(anyModalSurfaceYieldsCmdW()).toBe(false)
      expect(openShieldingSurfaces().map((s) => s.id)).toEqual(['select-content'])

      open.value = false
      await nextTick()
      await nextTick()
      expect(openShieldingSurfaces()).toEqual([])
    })

    it('注册对称性：包装卸载即注销（同 id 多实例互不串扰——实例级 key）', async () => {
      const hostA = mountDialogHost()
      const hostB = mountDialogHost()

      hostA.open.value = true
      await nextTick()
      expect(isModalSurfaceOpen('dialog-confirm')).toBe(true)

      // A 卸载（关态注销），B 仍关——聚合复位；B 开后聚合独立翻转（未串到 A 的闭包状态）
      hostA.wrapper.unmount()
      await nextTick()
      expect(isModalSurfaceOpen('dialog-confirm')).toBe(false)

      hostB.open.value = true
      await nextTick()
      expect(isModalSurfaceOpen('dialog-confirm')).toBe(true)
      expect(anyModalSurfaceYieldsEsc()).toBe(true)
    })
  })

  describe('ToastContainer：开合态绑 useToast 在列态本体', () => {
    it('入列 → open（intersecting）；清空 → closed；双键都不让位（Toast 不入让位族）', async () => {
      setActivePinia(createPinia())
      const wrapper = mount(ToastContainer)
      const { info, remove, toasts } = useToast()
      expect(isModalSurfaceOpen('toast-container')).toBe(false)

      info('遮蔽联动事实源')
      await nextTick()
      await nextTick()
      expect(toasts.value.length).toBe(1)
      expect(isModalSurfaceOpen('toast-container')).toBe(true)
      expect(anyModalSurfaceYieldsEsc()).toBe(false)
      expect(anyModalSurfaceYieldsCmdW()).toBe(false)
      const report = openShieldingSurfaces()
      expect(report).toEqual([{ id: 'toast-container', mode: 'intersecting', rect: expect.anything() }])

      remove(toasts.value[0]!.id)
      await nextTick()
      await nextTick()
      expect(isModalSurfaceOpen('toast-container')).toBe(false)
      expect(openShieldingSurfaces()).toEqual([])
      void wrapper
    })
  })

  describe('挂载⇔开型（FormOverlay）：注册随挂载 / 注销随卸载', () => {
    it('挂载即在册且 yieldsEsc（面板表单 overlay 打开中）；卸载即注销', async () => {
      const wrapper = mount(FormOverlay, { props: { questions: [{ type: 'text', question: 'q' }] } })
      expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(true)
      expect(isModalSurfaceOpen('form-overlay')).toBe(true)
      expect(anyModalSurfaceYieldsEsc()).toBe(true)
      expect(openShieldingSurfaces()).toEqual([{ id: 'form-overlay', mode: 'unconditional' }])

      wrapper.unmount()
      await nextTick()
      expect(isModalSurfaceOpen('form-overlay')).toBe(false)
      expect(anyModalSurfaceYieldsEsc()).toBe(false)
    })
  })

  describe('ui 包注册桥（MODAL_SURFACE_REGISTRAR_KEY）', () => {
    it('provide 注册桥后，ui 原语挂载即经桥注册、旗标查询联动（App.vue 同款登记红线）', async () => {
      const registrations: UiModalSurfaceRegistration[] = []
      const registrar = (registration: UiModalSurfaceRegistration): (() => void) => {
        registrations.push(registration)
        const { surface, key, isOpen, rect } = registration
        if (!isModalSurfaceId(surface)) {
          throw new Error(`modal-surface-registry: 未登记的表面 id '${registration.surface}'——先在 manifest.ts 登记（§6.7 完备性判据）`)
        }
        return registerModalSurface({ surface, key, isOpen, rect })
      }
      const { open, wrapper } = mountPopoverRoot(() => h(UiPopoverContent), {
        global: { provide: { [MODAL_SURFACE_REGISTRAR_KEY as symbol]: registrar } },
      })
      void wrapper

      open.value = true
      await nextTick()
      await nextTick()
      expect(registrations.map((r) => r.surface)).toContain('popover-content')
      expect(anyModalSurfaceYieldsEsc()).toBe(true)
      expect(anyModalSurfaceYieldsCmdW()).toBe(false)
    })

    it('未装配桥（无 provide）：ui 原语挂载零注册零副作用', async () => {
      const open = ref(true)
      mount(defineComponent({
        setup() {
          return () =>
            h(PopoverRoot, { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } }, {
              default: () => h(UiPopoverContent),
            })
        },
      }))
      await nextTick()
      await nextTick()
      // ui 原语开态存在（reka 渲染），但注册表零条目——ui 单测 / 非 taiji 宿主零副作用
      expect(openShieldingSurfaces()).toEqual([])
      expect(anyModalSurfaceYieldsEsc()).toBe(false)
    })
  })
})

/* ════════ 来源：sidebar/session-item-message-count.test.ts（主文件） ════════ */

describe('session-item-message-count', () => {
  const SID = 'count-1'

  function mountItem(lastActiveAt = 1000) {
    return mount(SessionItem, {
      attachTo: document.body,
      props: {
        session: { id: SID, label: '计数会话', cwd: '/p', lastActiveAt },
        active: false,
        status: 'done' as never,
      },
    })
  }

  async function hover(wrapper: VueWrapper): Promise<void> {
    await wrapper.find('.session-item').trigger('pointerenter')
    await flushPromises()
  }

  function detailCard(): HTMLElement | null {
    return document.body.querySelector('[data-testid="session-detail-card"]')
  }

  function msgCountSegment(): HTMLElement | null {
    return document.body.querySelector('[data-testid="session-detail-card-msg-count"]')
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    __resetMessageCountCacheForTest()
    commandMock.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  describe('悬停详情卡消息计数（通道 2）', () => {
    it('悬停 → 末行「时间 · N 条消息」两段式渲染（使用者黑盒 DOM 断言）', async () => {
      commandMock.mockResolvedValue({ sessionId: SID, count: 3 })
      const wrapper = mountItem()
      await hover(wrapper)

      const card = detailCard()
      expect(card).not.toBeNull()
      const seg = msgCountSegment()
      expect(seg).not.toBeNull()
      expect(seg!.textContent).toBe('3 条消息')
      // 两段式 = 「时间 · 消息数」（demo `cardSess.upd · cardSess.msgs` 分隔形态）
      expect(card!.textContent).toContain(' · ')
      // command 入参 = session.getMessageCount + sessionId（payload 单对象）
      expect(commandMock).toHaveBeenCalledWith('session.getMessageCount', { sessionId: SID }, 5000)
    })

    it('计数未返回前该段不渲染（不闪 0——meta 行只有相对时间，无分隔符）', async () => {
      commandMock.mockReturnValue(new Promise(() => {})) // 永不 resolve 的在途拉取
      const wrapper = mountItem()
      await wrapper.find('.session-item').trigger('pointerenter')
      await flushPromises()

      expect(detailCard()).not.toBeNull()
      expect(msgCountSegment()).toBeNull()
      const lastRow = detailCard()!.lastElementChild!
      expect(lastRow.textContent).not.toContain('·')
      expect(lastRow.textContent).not.toContain('0')
    })

    it('缓存命中（同 sessionId + lastActiveAt 未变）不重复调用 command', async () => {
      commandMock.mockResolvedValue({ sessionId: SID, count: 3 })
      const first = mountItem()
      await hover(first)
      first.unmount()

      const second = mountItem() // 新实例（同 id + 同 lastActiveAt）
      await hover(second)
      second.unmount()

      expect(commandMock).toHaveBeenCalledTimes(1)
      // 第二次悬停仍显示缓存值（DOM 断言缓存语义可观察）
      const third = mountItem()
      await hover(third)
      expect(msgCountSegment()!.textContent).toBe('3 条消息')
    })

    it('lastActiveAt 变化（失效键）→ 重新拉取（缓存不复用）', async () => {
      commandMock.mockResolvedValue({ sessionId: SID, count: 3 })
      const before = mountItem(1000)
      await hover(before)
      before.unmount()
      expect(commandMock).toHaveBeenCalledTimes(1)

      commandMock.mockResolvedValue({ sessionId: SID, count: 7 })
      const after = mountItem(2000) // lastActiveAt 变 = 会话有新消息
      await hover(after)

      expect(commandMock).toHaveBeenCalledTimes(2)
      expect(msgCountSegment()!.textContent).toBe('7 条消息')
    })

    it('拉取失败 → 占位不渲染 + 不缓存（下次悬停重试成功后显示）', async () => {
      commandMock.mockRejectedValueOnce(new Error('read failed'))
      const wrapper = mountItem()
      await hover(wrapper)
      expect(msgCountSegment()).toBeNull()

      commandMock.mockResolvedValue({ sessionId: SID, count: 5 })
      await wrapper.find('.session-item').trigger('pointerleave')
      await hover(wrapper) // 同实例再次悬停 = 重试（失败未缓存）

      expect(commandMock).toHaveBeenCalledTimes(2)
      expect(msgCountSegment()!.textContent).toBe('5 条消息')
    })
  })
})

/* ════════ 来源：sidebar/session-item-agent-badge.test.ts ════════ */

describe('session-item-agent-badge', () => {
  /** agent 创建的 session fixture（spawnSource + 父 id，U8 新字段） */
  const AGENT_SESSION = {
    id: 'u8-agent-1',
    label: 'agent 创建的会话',
    cwd: '/p',
    lastActiveAt: 0,
    spawnSource: 'agent' as const,
    parentAgentSessionId: 'u8-parent-1',
  }

  function mountItem(sessionOverrides: Record<string, unknown> = {}) {
    return mount(SessionItem, {
      attachTo: document.body,
      props: {
        session: { ...AGENT_SESSION, ...sessionOverrides },
        active: false,
        status: 'done' as never,
      },
    })
  }

  /** 挂载含一个 agent session + 一个 user session 的 SessionList（U8-B3 事件链用） */
  function mountList(sessions: Array<Record<string, unknown>>) {
    return mount(SessionList, {
      attachTo: document.body,
      props: {
        groups: [{ cwd: '/p', sessions }] as unknown as SessionGroup[],
        activeId: null,
        statusOf: () => 'done' as never,
      },
    })
  }

  /** 对 session item 根节点触发 contextmenu（reka ContextMenuTrigger 监听该事件）并等内容渲染。
   *  Trigger 内部先 await nextTick 再 open，故多等一帧保证 Portal 内容落 body。 */
  async function openContextMenu(wrapper: { find: (sel: string) => { trigger: (ev: string) => Promise<void> } }) {
    await wrapper.find('.session-item').trigger('contextmenu')
    await nextTick()
    await nextTick()
  }

  /** body 中的「查看父 session」菜单项元素（无则 null） */
  function findViewParentItem(): HTMLElement | null {
    return document.body.querySelector('[data-testid="session-view-parent-item"]')
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.removeItem('taiji:session-markers')
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  describe('U8-B1 agent badge 渲染（SessionItem）', () => {
    it('U8-B1 spawnSource=agent → session-agent-badge 存在且可见文本为 AI（使用者黑盒）', () => {
      const wrapper = mountItem()
      const badge = wrapper.find('[data-testid="session-agent-badge"]')
      expect(badge.exists()).toBe(true)
      // 用户可见 DOM：badge 文本就是 'AI' 标记
      expect(badge.text()).toBe('AI')
    })

    it('U8-B1 spawnSource=user 与 undefined → 均不渲染 badge（构建者白盒条件分支）', () => {
      const userWrapper = mountItem({ id: 'u8-user-1', spawnSource: 'user' })
      expect(userWrapper.find('[data-testid="session-agent-badge"]').exists()).toBe(false)

      // spawnSource 未写（旧数据/普通用户 session）同样无 badge
      const unsetWrapper = mountItem({ id: 'u8-unset-1', spawnSource: undefined, parentAgentSessionId: undefined })
      expect(unsetWrapper.find('[data-testid="session-agent-badge"]').exists()).toBe(false)
    })

    it('U8-B1 badge 形态：accent 低饱和小标签（bg-accent-soft + text-accent + 10px），不抢左侧状态 icon（观察者形态）', () => {
      const wrapper = mountItem()
      const badge = wrapper.find('[data-testid="session-agent-badge"]')
      // accent 低饱和配对 = bg-accent-soft 底 + accent 字（项目 badge 通行形态）
      expect(badge.classes()).toContain('bg-accent-soft')
      expect(badge.classes()).toContain('text-accent')
      // 克制尺寸：10px 小标签，与标题 12px 拉开层级
      expect(badge.classes()).toContain('text-[length:var(--text-3xs)]')
      // 状态信号焦点仍在左侧 7px 单一 icon（badge 不替代它）
      expect(wrapper.find('[data-testid="session-icon"]').exists()).toBe(true)
    })
  })

  describe('U8-B2 右键「查看父 session」菜单（SessionItem）', () => {
    it('U8-B2 agent session（有 parentAgentSessionId）右键 → 出现「查看父 session」菜单项（使用者黑盒）', async () => {
      const wrapper = mountItem()
      await openContextMenu(wrapper)

      const item = findViewParentItem()
      expect(item).not.toBeNull()
      // 用户可见 DOM：菜单项文案
      expect(item!.textContent).toContain('查看父 session')
    })

    it('U8-B2 user session 右键 → 无「查看父 session」项（force-quit 功能上线后 user session 有强制退出项，菜单容器会渲染）', async () => {
      const wrapper = mountItem({ id: 'u8-user-2', spawnSource: 'user' })
      await openContextMenu(wrapper)

      expect(findViewParentItem()).toBeNull()
      // [更新 2026-XX force-quit] 原断言「整块菜单不渲染」已失效：非 dead session 现在始终挂
      // 「强制退出」菜单项（sidebar 强制退出逃生入口），菜单容器随之渲染。此处锁定新行为：
      // 容器存在但仅含 forceQuit 一项，无 viewParent。
      expect(document.body.querySelector('[data-testid="session-context-menu"]')).not.toBeNull()
      expect(document.body.querySelector('[data-testid="session-force-quit-item"]')).not.toBeNull()
    })

    it('U8-B2 agent session 但无 parentAgentSessionId → 右键无菜单项（有 badge 无导航目标，构建者白盒）', async () => {
      const wrapper = mountItem({ id: 'u8-agent-no-parent', parentAgentSessionId: undefined })
      // badge 仍显示（标记来源）
      expect(wrapper.find('[data-testid="session-agent-badge"]').exists()).toBe(true)
      await openContextMenu(wrapper)
      expect(findViewParentItem()).toBeNull()
    })
  })

  describe('U8-B3 navigateParent 事件链（SessionItem → SessionList）', () => {
    it('U8-B3 点菜单项 → SessionItem emit navigateParent 携带 parentAgentSessionId（构建者白盒）', async () => {
      const wrapper = mountItem()
      await openContextMenu(wrapper)

      findViewParentItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushPromises()

      expect(wrapper.emitted('navigateParent')).toEqual([['u8-parent-1']])
    })

    it('U8-B3 SessionList 层：点菜单项后收到 navigateParent 且 payload 含 parentAgentSessionId（使用者黑盒全链路）', async () => {
      const wrapper = mountList([
        { ...AGENT_SESSION },
        { id: 'u8-user-3', label: '用户会话', cwd: '/p', lastActiveAt: 0, spawnSource: 'user' },
      ])
      await openContextMenu(wrapper)

      const item = findViewParentItem()
      expect(item).not.toBeNull()
      item!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushPromises()

      // SessionList 转发链路：payload 单字符串 = parentAgentSessionId
      const emitted = wrapper.emitted('navigateParent')
      expect(emitted).toBeTruthy()
      expect(emitted![0]).toEqual(['u8-parent-1'])
    })
  })
})

/* ════════ 来源：sidebar/session-item-handoff-badge.test.ts ════════ */

describe('session-item-handoff-badge', () => {
  const BASE_SESSION = {
    id: 'src-1',
    label: '源会话',
    cwd: '/p',
    lastActiveAt: 0,
  }

  function mountItem(sessionOverrides: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
    return mount(SessionItem, {
      attachTo: document.body,
      props: {
        session: { ...BASE_SESSION, ...sessionOverrides },
        active: false,
        status: 'done' as never,
        ...props,
      },
    })
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  describe('S8 已交接徽标渲染（SessionItemDisplay）', () => {
    it('handedOffTo 非空 → session-handoff-badge 存在，徽标文本「已交接」', () => {
      const wrapper = mountItem({ handedOffTo: 'target-abc' })
      const badge = wrapper.find('[data-testid="session-handoff-badge"]')
      expect(badge.exists()).toBe(true)
      expect(badge.text()).toBe('已交接')
    })

    it('未交接（无 handedOffTo）→ 徽标不渲染', () => {
      const wrapper = mountItem()
      expect(wrapper.find('[data-testid="session-handoff-badge"]').exists()).toBe(false)
    })

    it('title 显目标名（容器反查注入 handoffTargetLabel）；目标已删回退 id 前缀', () => {
      const withLabel = mountItem(
        { handedOffTo: 'target-abc' },
        { handoffTargetLabel: '交接后的新会话' },
      )
      expect(withLabel.find('[data-testid="session-handoff-badge"]').attributes('title')).toBe(
        '已交接至 交接后的新会话',
      )
      const withoutLabel = mountItem({ handedOffTo: 'target-abc12345' })
      expect(withoutLabel.find('[data-testid="session-handoff-badge"]').attributes('title')).toBe(
        '已交接至 target-a',
      )
    })

    it('观察者形态：徽标为中性描边小标签（border 描边 + dim 字，不占 accent）', () => {
      const wrapper = mountItem({ handedOffTo: 't' })
      const cls = wrapper.find('[data-testid="session-handoff-badge"]').attributes('class') ?? ''
      expect(cls).toContain('border-border-strong')
      expect(cls).toContain('text-neutral-dim')
      expect(cls).not.toContain('accent')
    })
  })
})

/* ════════ 来源：sidebar/session-item-import-fresh.test.ts ════════ */

describe('session-item-import-fresh', () => {
  const SESSION = {
    id: 'imported-session-1',
    label: '刚导入的会话',
    cwd: '/p',
    lastActiveAt: 0,
  }

  function mountItem(id: string = SESSION.id) {
    return mount(SessionItem, {
      attachTo: document.body,
      props: {
        session: { ...SESSION, id },
        active: false,
        status: 'done' as never,
      },
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    localStorage.removeItem('taiji:session-markers')
    __resetImportedFreshForTest()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    __resetImportedFreshForTest()
    vi.useRealTimers()
  })

  describe('fresh「导入」徽标渲染（SessionItem × useImportSession fresh 状态机）', () => {
    it('标记后徽标可见：文案「导入」+ accent 低饱和形态（使用者黑盒 + 观察者形态）', async () => {
      const wrapper = mountItem()
      expect(wrapper.find('[data-testid="session-imported-fresh"]').exists()).toBe(false)

      markImportedFresh(SESSION.id)
      await nextTick()

      const badge = wrapper.find('[data-testid="session-imported-fresh"]')
      expect(badge.exists()).toBe(true)
      expect(badge.text()).toBe('导入')
      // accent 低饱和配对（与 agent badge / ForkGroup fresh 同源 token）
      expect(badge.classes()).toContain('bg-accent-soft')
      expect(badge.classes()).toContain('text-accent')
    })

    it('淡出时序（demo doImport）：3.2s 实显 → fading 加 opacity-0 → 200ms 后移除', async () => {
      const wrapper = mountItem()
      markImportedFresh(SESSION.id)
      await nextTick()

      vi.advanceTimersByTime(IMPORT_FRESH_VISIBLE_MS)
      await nextTick()
      let badge = wrapper.find('[data-testid="session-imported-fresh"]')
      expect(badge.exists()).toBe(true)
      // 观察者：淡出阶段走 opacity 过渡类，非瞬间卸载
      expect(badge.classes()).toContain('opacity-0')
      expect(badge.classes()).toContain('transition-opacity')

      vi.advanceTimersByTime(IMPORT_FRESH_FADE_MS)
      await nextTick()
      badge = wrapper.find('[data-testid="session-imported-fresh"]')
      expect(badge.exists()).toBe(false)
    })

    it('未标记的 session 不渲染徽标（构建者白盒：per-session 隔离）', async () => {
      const wrapper = mountItem('other-session-2')
      markImportedFresh(SESSION.id)
      await nextTick()

      expect(wrapper.find('[data-testid="session-imported-fresh"]').exists()).toBe(false)
    })

    it('mount 后才标记也生效（响应式链路：isImportedFresh 订阅模块级集合）', async () => {
      const wrapper = mountItem()
      expect(wrapper.find('[data-testid="session-imported-fresh"]').exists()).toBe(false)

      markImportedFresh(SESSION.id)
      await nextTick()

      expect(wrapper.find('[data-testid="session-imported-fresh"]').exists()).toBe(true)
    })
  })
})

/* ════════ 来源：panel/btw-panel-contract-invisible.test.ts（原 enableAutoUnmount 改节内手动登记） ════════ */

describe('btw-panel-contract-invisible', () => {
  const MESSAGE_FIXTURE_TEXT = '普通消息 fixture：用户提问，助手给出回答。'
  const COMPOSER_FIXTURE_TEXT = '表单 fixture：输入消息'
  const MAIN_A = 's-btw-a'

  // ── 契约文本提取：readFileSync 只读源文件 + 正则提取导出字符串字面量为常量 A ──
  /** 源文件路径候选：优先 import.meta.url（与 vitest cwd 无关，稳形态），回退 cwd 两形态。 */
  function resolveContractSource(): string {
    const rel = 'runtime/src/services/session/btw-contract-inject.ts'
    const candidates: string[] = []
    // vitest 下 import.meta.url 不保证 file: scheme，仅在是 file URL 时作为首选锚点
    try {
      if (import.meta.url.startsWith('file:')) {
        candidates.push(fileURLToPath(new URL(`../../../../${rel}`, import.meta.url)))
      }
    } catch {
      /* 非 file URL → 退 cwd 候选 */
    }
    candidates.push(
      resolve(process.cwd(), `../${rel}`), // cwd = 包根
      resolve(process.cwd(), `packages/${rel}`), // cwd = 仓根
    )
    const hit = candidates.find((p) => existsSync(p))
    if (!hit) throw new Error(`btw-contract-inject.ts not found in candidates: ${candidates.join(', ')}`)
    return hit
  }

  /** 正则提取 `export const BTW_BEHAVIOR_CONTRACT = '…'` 字面量内容（单/双引号皆容）。 */
  function extractContract(): string {
    const src = readFileSync(resolveContractSource(), 'utf8')
    const m = /export\s+const\s+BTW_BEHAVIOR_CONTRACT\s*=\s*(['"])([\s\S]*?)\1/.exec(src)
    if (!m) throw new Error('BTW_BEHAVIOR_CONTRACT literal not found — extraction regex drifted')
    return m[2]
  }

  const A = extractContract()

  /** D9⑤ 稳定关键词（防提取静默失败 + A ≡ 源当前内容的防漂移锚）。 */
  const D9_KEYS = ['父任务快照仅供背景', '不自动续主任务', '改工作区'] as const

  /** 契约句切分：按 ；/。 切（契约本身以 ； 分句），逐句反向断言防换行打断漏判。 */
  function contractSentences(contract: string): string[] {
    return contract
      .split(/[；。;]/)
      .map((s) => s.trim())
      .filter(Boolean)
  }

  let boundSid: Ref<string | null>

  // 原文件用 enableAutoUnmount——会全局卸载他节残留 wrapper（body 已清，卸载崩），
  // 改节内手动登记本节 wrapper（卸载语义等价、作用域收敛）
  const btwWrappers: VueWrapper[] = []

  function mountPanel(sessionId: string | null) {
    const wrapper = mount(BtwPanel, { props: { sessionId } })
    btwWrappers.push(wrapper)
    return wrapper
  }

  async function settle(wrapper: Awaited<ReturnType<typeof mountPanel>>) {
    await flushPromises()
    await nextTick()
    await nextTick()
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    boundSid = ref<string | null>(MAIN_A)
    bindDrawerSessionId(boundSid)
    _resetDrawerForTest()
  })

  afterEach(() => {
    for (const w of btwWrappers.splice(0)) w.unmount()
  })

  describe('D9⑤ 契约提取自源（构建者白盒 + 防漂移锚）', () => {
    it('A 非空且含 D9⑤ 稳定关键词（提取未静默失败；A 即源当前内容，逐字一致成立）', () => {
      expect(A.length).toBeGreaterThan(0)
      for (const key of D9_KEYS) expect(A).toContain(key)
      // 句切分产出多句（反向断言的输入范围有效）
      expect(contractSentences(A).length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('BtwPanel 契约 UI 反向断言（使用者黑盒 DOM + 观察者形态）', () => {
    it('含普通消息/表单 fixture 的面板渲染文本不含契约任一句（D9⑤ model-only 不可见）', async () => {
      btwApiMock.list.mockResolvedValue(btwLineGroups({ id: 'pi-1' }))
      const wrapper = mountPanel(MAIN_A)
      await settle(wrapper)

      // 观察者：fixture 面可见（防空壳——断言必须跑在非空渲染范围上）
      const dom = wrapper.text()
      // 注意：不用 data-testid——父组件透传的 data-testid 会覆盖 stub 自有值（同 btw-panel.test.ts 落点）
      expect(wrapper.find('[data-fixture="stream"]').exists()).toBe(true)
      expect(wrapper.find('[data-fixture="composer"]').exists()).toBe(true)
      expect(dom).toContain(MESSAGE_FIXTURE_TEXT)
      expect(dom).toContain(COMPOSER_FIXTURE_TEXT)

      // 使用者：整串不可见
      expect(dom).not.toContain(A)
      // 逐句反向断言（防 markdown/渲染换行打断单句导致整串漏判）
      const sentences = contractSentences(A)
      expect(sentences.length).toBeGreaterThanOrEqual(2)
      for (const s of sentences) expect(dom).not.toContain(s)
    })

    it('空态（无线）与新建线（fork pill）路径同样不含契约任一句', async () => {
      btwApiMock.list.mockResolvedValue([])
      btwApiMock.create.mockResolvedValue({
        sessionId: 'pi-9',
        mainSid: MAIN_A,
        forkState: 'full',
      })

      const wrapper = mountPanel(MAIN_A)
      await settle(wrapper)
      const emptyDom = wrapper.text()
      expect(emptyDom).toContain('还没有旁路线') // 空态可见，防空壳
      expect(emptyDom).not.toContain(A)
      for (const s of contractSentences(A)) expect(emptyDom).not.toContain(s)

      await wrapper.find('[data-testid="btw-empty-new"]').trigger('click')
      await settle(wrapper)
      const createdDom = wrapper.text()
      expect(createdDom).toContain('已含主对话快照') // fork pill 可见，防空壳
      expect(createdDom).not.toContain(A)
      for (const s of contractSentences(A)) expect(createdDom).not.toContain(s)
    })
  })
})
