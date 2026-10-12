/**
 * Composer staging banner 组件级测试（demo .mode-banner 形态对齐波）。
 *
 * 覆盖：
 * - 条件渲染：无 staging（activeStaging null）不渲染；fork 活跃渲染标题 + 图标 + ×
 * - × click 触发 staging.exit（banner 消失，与 Esc/发送/切 session 同一退出语义）
 * - handoff 态：handoff 图标（lucide-arrow-right-left）与标题/描述文案正确
 *
 * 驱动方式：fork/handoff 进入走真实信号链（triggerEnterForkMode / triggerEnterHandoffMode
 * 写 channel signal → Composer 内 watch → staging.enter），与 Sidebar 快捷键同一生产通路。
 * mock 骨架同 composer-fork-mode.test.ts 范式（helpers/composer-mount.ts 单源）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-staging-banner.test.ts
 */
// helper import 必须先于一切项目内模块（@/stores 等会在模块图加载期触发 @/api mock
// factory，factory 引用的 helper 绑定彼时必须已初始化，否则 TDZ——vi.mock hoisting 约束）
import {
  composerApiModule,
  composerChatModule,
  composerChildStubs,
  composerFlowModule,
  composerProjectSkillsModule,
  composerSessionStoreModule,
  composerSidebarForkModule,
  enterForkMode,
  expectBannerVisible,
  makeKeyboardComposerInputMock,
  resetComposerMountState,
} from '../helpers/composer-mount'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { triggerEnterForkMode } from '@/composables/panel/useForkModeChannel'
import { triggerEnterHandoffMode } from '@/composables/panel/useHandoffModeChannel'

// mock 装配同 fork 族：banner 组件级断言走真实信号链驱动（triggerEnter*）
vi.mock('@/composables/features/chat/useChat', () => composerChatModule())

vi.mock('@/composables/features/new-task/useNewTaskFlow', () => composerFlowModule())
vi.mock('@/api', () => composerApiModule())
vi.mock('@/composables/features/settings/useProjectSkills', () => composerProjectSkillsModule())
vi.mock('@/stores/session', () => composerSessionStoreModule())
vi.mock('@/composables/features/sidebar/useSidebar', () => composerSidebarForkModule())

// ── ComposerInput mock：helper 键盘交互变体单源（props/expose 面同手写版）──
const { lastInputText, ComposerInputMock } = makeKeyboardComposerInputMock()

const mountStubs = {
  ComposerInput: ComposerInputMock,
  ...composerChildStubs,
}

import Composer from '@/components/panel/Composer.vue'

beforeEach(() => {
  resetComposerMountState(lastInputText)
})

function mountComposer(props: { sessionId: string | null }) {
  return mount(Composer, { props, global: { stubs: mountStubs } })
}

// ── 条件渲染：无 staging 不渲染 / fork 态渲染 ─────────────────────────────
describe('banner 条件渲染（驱动位 staging.activeStaging）', () => {
  it('无 staging（activeStaging null）→ banner 不渲染', () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    expectBannerVisible(wrapper, false)
    expect(wrapper.find('[data-testid="composer-handoff-banner"]').exists()).toBe(false)
  })

  it('fork 态 → 渲染 fork 标题 + GitBranch 图标 + × 退出钮，box 无 fork-mode 染色', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    await enterForkMode(wrapper, 's1')

    const banner = wrapper.find('[data-testid="composer-mode-banner"]')
    expect(banner.exists()).toBe(true)
    // 文案 = 粗体标题 + 「 · 」+ 描述（demo 权威 zh 文案；连写断言含空格间距——
    // 模板换行空白经 Vue condense 折叠为单空格，防「标题·描述」贴死形态回归）
    expect(banner.text()).toContain('Fork 新分支')
    expect(banner.text()).toMatch(/新分支 · 当前输入将发到新分支，与主线隔离/)
    // 图标 = GitBranch（fork 映射，demo 权威 git-branch；lucide svg 类名锚点）
    expect(banner.find('svg.lucide-git-branch').exists()).toBe(true)
    // × 退出钮存在（Button ghost 渲染为 button 元素）
    expect(banner.find('button').exists()).toBe(true)
    // box 无 fork-mode 染色（[HISTORICAL] 整框染色档已退役，banner 图标是唯一 accent 染色点）
    expect(wrapper.find('[data-testid="composer-box"]').classes()).not.toContain('fork-mode')
  })
})

// ── × 退出：click → staging.exit → banner 消失 ───────────────────────────
describe('banner × click 触发 staging.exit', () => {
  it('fork 态点 × → banner 消失（模式退出）', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    await enterForkMode(wrapper, 's1')
    expectBannerVisible(wrapper, true)

    await wrapper.find('[data-testid="composer-mode-banner"] button').trigger('click')
    await wrapper.vm.$nextTick()

    expectBannerVisible(wrapper, false)
  })
})

// ── handoff 态：图标与文案分流 ────────────────────────────────────────────
describe('handoff 态 banner（图标 ArrowRightLeft + handoff 文案）', () => {
  it('handoff 信号进入 → handoff testid + handoff 标题/描述 + ArrowRightLeft 图标', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    triggerEnterHandoffMode('s1')
    await wrapper.vm.$nextTick()

    const banner = wrapper.find('[data-testid="composer-handoff-banner"]')
    expect(banner.exists()).toBe(true)
    expectBannerVisible(wrapper, false)
    // 文案 = handoff 标题 + 描述（demo 权威 zh 文案）
    expect(banner.text()).toContain('Handoff 交接')
    expect(banner.text()).toContain('发送后将生成会话摘要，交接给新会话继续')
    // 图标 = ArrowRightLeft（handoff 映射），且不是 fork 的 GitBranch
    expect(banner.find('svg.lucide-arrow-right-left').exists()).toBe(true)
    expect(banner.find('svg.lucide-git-branch').exists()).toBe(false)
    // 图标染 accent = 模式在途唯一染色点（text-accent 落在 banner svg 上）
    expect(banner.find('svg').classes()).toContain('text-accent')
  })
})
