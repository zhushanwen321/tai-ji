/**
 * Composer.vue landing 态 skill reload 集成测试（PR #123 review fix · reviewer-D WARNING-2 / WARNING-3）。
 *
 * ── WHY THIS FILE（AGENTS.md 测试规范 #6 [MANDATORY] + 首屏冒烟模板）──
 *
 * WARNING-2：command-popover-landing.test.ts 的 TC5 mount 的是测试内局部 GlobalSkillsHarness（手接
 * useGlobalSkills → CommandPopover），而非 AGENTS.md #6 要求的「文档指定入口」。本功能的文档入口是
 * Composer.vue（TEST-STRATEGY.md docs/testing/01-chat-panel-composer.md §2（Composer）：Composer.vue 是容器，line 192 调
 * useGlobalSkills() 是生产连线点）。GlobalSkillsHarness 是 Composer 这段连线的复制品——若有人删了
 * Composer.vue 的 useGlobalSkills 调用或改了 prop 传递，TC5 仍绿（测的是复制品），生产却断线。
 * 本文件 mount 真实 Composer.vue，验证生产连线：广播 → useGlobalSkills → landingGlobalSkills prop →
 * CommandPopover DOM 反映刷新。Composer.vue 任何连线改动都会被本用例捕获。
 *
 * WARNING-3：AGENTS.md 「首屏冒烟模板」[MANDATORY]（行 415-423）要求 mount 顶层容器断言 composer
 * 输入区存在于 DOM（防「77 单测全绿但 Landing 无 composer 输入区」事故重演）。command-popover-landing
 * .test.ts 无任何用例断言 composer 输入区在 DOM。本文件补这条冒烟 gate。
 *
 * ── 入口选择说明（AGENTS.md #6 允许降级但须显式说明）──
 *
 * 完整 Landing.vue 依赖大量 store/provider（DirSelectPopover / BranchSelectPopover / CreateBranchModal /
 * CreateWorktreeModal / useNewTaskFlow 内部 startFlow 副作用），mount 成本与 noise 高（同 landing-bash-
 * integration.test.ts 的入口取舍理由）。本功能（slash 命令 skill reload）的生产连线入口是 Composer.vue
 * （line 192 useGlobalSkills() → line 24 :global-skills="landingGlobalSkills"），mount Composer
 * variant=landing 即完整覆盖 skill reload 链路 + composer 输入区渲染。故入口选 Composer.vue（非降级，
 * 是功能真源入口；Landing.vue 的目录/分支 chip 不在本功能链路上）。
 *
 * ── 策略 ──
 * - 真 pinia + 真 chatStore（isActive 派生驱动 onSend 分流守卫）
 * - mock useChat（spy 化 send/steer/abort...，landing 首发不应触发 send）
 * - mock useNewTaskFlow（submitFirstMessage spy + currentCwd=null ref 使 useProjectSkills 不 RPC）
 * - mock @/api（getGlobalSkills 可控 mock，onSkillCacheInvalidated 接真实 events.onGlobalType 端到端可达）
 * - mock ComposerInput（渲染 data-testid="composer-input" + emit slash-trigger 开浮层，对齐 01-chat-panel-composer.md §2（Composer）
 *   §3 改进建议与 landing-bash-integration.test.ts 既有惯例；真实 ComposerInput 暂无此 testid）
 * - 真实 CommandPopover（不 stub——验证 skill 列表 DOM 刷新是本用例核心；portal 到 body，按 bodyItemButtons 查）
 * - 其余非浮层子组件 stub（AddMenuPopover / ContextChipsBar / 容量/模型/思考 popover 等）
 *
 * ── 模块单例隔离（声明顺序约定）──
 * useGlobalSkills 是模块级 singleton（globalSkillsCache / globalLoaded / globalInvalidateSubscribed 跨
 * 用例共享）。TC5-Composer 必须是首个 mount Composer 的用例，拿到干净 singleton 完成首次拉取 + force
 * reload 验证（首拉 SKILL_A → 广播 force 重拉 SKILL_A_B）。首屏冒烟用例不检查 skill 列表内容（只断言
 * composer-box / composer-input testid 存在），对 singleton 状态不敏感，故放后面无副作用。与
 * command-popover-landing.test.ts 同范式（依赖文件级首拉拿到干净 singleton）。broadcast 走文件级静态
 * import 的 events 模块（与 vi.mock 工厂内 realEvents.onGlobalType 同实例），订阅与广播同 module 实例。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-landing-skill-reload.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage, SkillInfo } from '@xyz-agent/shared'
import * as events from '@xyz-agent/core/transport/api'

// ── getGlobalSkills 可控 mock（hoisted：vi.mock 工厂早于 import 求值）──
// TC5-Composer 中途改返回值模拟 runtime 重扫 globalCache 后缓存更新。
const getGlobalSkillsMock = vi.hoisted(() => vi.fn().mockResolvedValue([]))

// ── onSkillCacheInvalidated 接真实 events.onGlobalType：让 dispatchGlobal 广播能端到端触达
// useGlobalSkills 的订阅回调（loadGlobal(true) force 重拉）。这是「真实订阅链路」验证的关键。
vi.mock('@/api', async () => {
  const realEvents = await import('@xyz-agent/core/transport/api')
  return {
    model: { switchModel: vi.fn() },
    session: { setThinkingLevel: vi.fn() },
    composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
    config: {
      getGlobalSkills: getGlobalSkillsMock,
      getProjectSkills: vi.fn().mockResolvedValue([]),
      onSkillCacheInvalidated: (handler: (p: { scope: 'global' | 'project'; cwd?: string }) => void) =>
        realEvents.onGlobalType('config.skillCacheInvalidated', (msg) => {
          handler(msg.payload as { scope: 'global' | 'project'; cwd?: string })
        }),
    },
  }
})

// ── mock useChat（spy 化，landing 首发不应触发 send）──
const chatApiMock = {
  send: vi.fn(() => Promise.resolve()),
  steer: vi.fn(() => Promise.resolve()),
  followUp: vi.fn(() => Promise.resolve()),
  abort: vi.fn(() => Promise.resolve()),
  compact: vi.fn(() => Promise.resolve()),
  editAndResend: vi.fn(),
  hydrateHistory: vi.fn(),
}
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => chatApiMock,
}))

// ── mock useNewTaskFlow：currentCwd=null（真 ref）使 useProjectSkills 早退不 RPC，聚焦 global 链路 ──
vi.mock('@/composables/features/new-task/useNewTaskFlow', async () => {
  const { ref } = await import('vue')
  return {
    useNewTaskFlow: () => ({
      submitFirstMessage: vi.fn(() => Promise.resolve()),
      currentModel: { value: null },
      setPendingModel: vi.fn(),
      // currentCwd 必须是真 ref：Composer.vue line 191 传给 useProjectSkills，其内部 watch(currentCwd)
      // 要求 watch source 是 ref/getter。null cwd 使 useProjectSkills 早退（不 RPC）。
      currentCwd: ref(null),
    }),
    resetNewTaskFlow: vi.fn(),
  }
})
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn() }),
}))

// ── ComposerInput mock：渲染 data-testid="composer-input"（AGENTS.md 冒烟模板 + 01-chat-panel-composer.md §2（Composer）§3
//    改进建议；真实 ComposerInput.vue 暂无此 testid，按既有 Composer-mount 测试惯例注入）+ emit
//    slash-trigger 开 slash 浮层。expose Composer.vue 需要的 instance 方法（clear/setText/insertSlashChip/
//    getSegments/moveCaretVertical/getText）。──
const ComposerInputMock = defineComponent({
  name: 'ComposerInput',
  emits: ['input', 'keydown', 'slash-trigger', 'file-trigger'],
  setup(_, { expose }) {
    expose({
      clear: vi.fn(),
      setText: vi.fn(),
      insertSlashChip: vi.fn(),
      getSegments: () => [],
      getText: () => '',
      moveCaretVertical: () => 'noop' as const,
    })
    return {}
  },
  template: '<div data-testid="composer-input" />',
})

const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
// 注意：CommandPopover 不在 stubs 中——保留真实组件，验证 skill 列表 DOM 刷新（本用例核心）。
// 其余非浮层子组件 stub，降低 mount noise。
const otherStubs = {
  ComposerInput: ComposerInputMock,
  AddMenuPopover: SIMPLE,
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

import Composer from '@/components/panel/Composer.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 默认空数组；TC5-Composer 用例内覆盖为具体 skill 列表
  getGlobalSkillsMock.mockResolvedValue([])
  // 清 body（reka-ui Popover portal 到 body，跨用例残留会污染断言）
  document.body.innerHTML = ''
})

/** reka-ui PopoverContent portal 到 body：在 body 内找命令项行（v-for 渲染为 .cmd-row div）。
 *  按 item 列表容器（.max-h-[180px]）定位——**不回退到 document.body**：mount Composer 时工具栏
 *  也会渲染 Button（发送位等 svg-only 按钮文案为空），回退会误抓工具栏按钮污染断言。列表未渲染
 *  （items.length===0）时返回 []，让 vi.waitFor 继续轮询直到 skill 加载、列表出现。
 *  [B3] 行从 <Button> 改为纯 div（对齐 demo .cmd-row），选择器同步从 'button' 改为 '.cmd-row'。 */
function bodyItemButtons(): HTMLElement[] {
  const list = document.body.querySelector('.max-h-\\[180px\\]')
  if (!list) return []
  return Array.from(list.querySelectorAll('.cmd-row'))
}

describe('Composer.vue landing 态 skill reload 集成（PR#123 reviewer-D WARNING-2/3）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  /** mount 真实 Composer.vue（landing 态：variant=landing + sessionId=null，对齐 Landing.vue 的 composerSid 真实态）。 */
  async function mountLandingComposer(): Promise<ReturnType<typeof mount>> {
    const w = mount(Composer, {
      attachTo: document.body,
      props: { sessionId: null, variant: 'landing' },
      global: { stubs: otherStubs },
    })
    await flushPromises()
    await nextTick()
    return w
  }

  /** 触发输入区 slash-trigger 事件 → Composer.onSlashTrigger → cmdOpen=true 打开 CommandPopover slash 浮层。 */
  async function openSlashPopover(w: ReturnType<typeof mount>): Promise<void> {
    w.findComponent(ComposerInputMock).vm.$emit('slash-trigger', { query: '' })
    await flushPromises()
    await nextTick()
  }

  // ── 用例声明顺序约定（singleton 隔离）──
  // useGlobalSkills 是模块级 singleton（globalSkillsCache / globalLoaded / globalInvalidateSubscribed 跨
  // 用例共享）。TC5-Composer 必须是首个 mount Composer 的用例，拿到干净的 singleton 完成首次拉取 +
  // force reload 验证（首拉 SKILL_A → 广播 force 重拉 SKILL_A_B）。首屏冒烟用例不检查 skill 列表内容
  // （只断言 composer-box / composer-input testid 存在），对 singleton 状态不敏感，故放后面无副作用。
  // 与 command-popover-landing.test.ts 同范式（依赖文件级首拉拿到干净 singleton）。

  // ── WARNING-2：mount 文档入口 Composer.vue，验证 skill reload 生产连线（AGENTS.md #6 MANDATORY）──
  // 端到端链路：dispatchGlobal {scope:'global'} → useGlobalSkills 订阅回调（Composer.vue line 192 真实
  // 调用）→ loadGlobal(true) force 重拉 → landingGlobalSkills ref 刷新 → :global-skills prop 透传 →
  // CommandPopover DOM 反映新 skill 列表。若 Composer.vue 删了 useGlobalSkills 调用或改了 prop 传递，
  // 本用例红（区别于 command-popover-landing.test.ts TC5 的 GlobalSkillsHarness 复制品）。
  it('TC5-Composer: mount Composer.vue → dispatchGlobal skillCacheInvalidated → CommandPopover DOM 反映 globalSkills 刷新（文档入口集成）', async () => {
    const SKILL_A: SkillInfo[] = [
      { id: 'sk-a', name: 'skill-a', description: 'alpha', enabled: true, source: 'agents', effective: true },
    ]
    const SKILL_A_B: SkillInfo[] = [
      { id: 'sk-a', name: 'skill-a', description: 'alpha', enabled: true, source: 'agents', effective: true },
      { id: 'sk-b', name: 'skill-b', description: 'beta', enabled: true, source: 'agents', effective: true },
    ]

    // 初始 getGlobalSkills resolve([skill-a]) → useGlobalSkills 首次拉取缓存 skill-a
    getGlobalSkillsMock.mockResolvedValue(SKILL_A)
    wrapper = await mountLandingComposer()
    await openSlashPopover(wrapper)

    // 浮层应显示 skill-a（1 项）
    await vi.waitFor(() => {
      const btns = bodyItemButtons()
      expect(btns).toHaveLength(1)
      expect(btns[0].textContent).toContain('skill-a')
    })

    // mock 改返回 [skill-a, skill-b]（模拟 runtime 重扫 globalCache 后缓存更新）
    getGlobalSkillsMock.mockResolvedValue(SKILL_A_B)
    // 派发 global scope 失效信号 → Composer.vue line 192 的 useGlobalSkills 订阅回调 → loadGlobal(true)
    // force 重拉 → landingGlobalSkills ref 刷新 → :global-skills prop 更新 → CommandPopover DOM 刷新
    events.dispatchGlobal({
      type: 'config.skillCacheInvalidated',
      payload: { scope: 'global' },
    } as ServerMessage<'config.skillCacheInvalidated'>)

    // 浮层现在应显示 skill-a + skill-b（2 项，DOM 文案反映刷新）
    await vi.waitFor(() => {
      const btns = bodyItemButtons()
      expect(btns).toHaveLength(2)
      expect(btns.some((b) => b.textContent?.includes('skill-a'))).toBe(true)
      expect(btns.some((b) => b.textContent?.includes('skill-b'))).toBe(true)
    })

    // 反向断言：landing 首发未被触发（仅验证 skill 刷新，不应误发消息）
    expect(chatApiMock.send).not.toHaveBeenCalled()
  })

  // ── WARNING-3：首屏冒烟 gate（AGENTS.md 行 415-423 MANDATORY 模板）──
  // 防「77 单测全绿但 Landing 态无 composer 输入区」事故重演：mount 真实 Composer.vue landing 态，
  // 断言 composer 输入区 + composer-box 容器存在于 DOM。放 TC5-Composer 之后（singleton 已被首用例
  // 拉取填充 SKILL_A_B，但本用例不检查 skill 内容，不受影响）。
  it('首屏冒烟：Landing 态 Composer DOM 含 composer 输入区 + composer-box（AGENTS.md MANDATORY 渲染 gate）', async () => {
    wrapper = await mountLandingComposer()

    // composer-box：Composer.vue:32 的 testid（01-chat-panel-composer.md §2（Composer）§3 文档入口 testid）
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    // composer-input：AGENTS.md 首屏冒烟模板断言项（事故复现点：曾全绿但此处 DOM 缺失）
    expect(wrapper.find('[data-testid="composer-input"]').exists()).toBe(true)
  })
})
