/**
 * Composer 聚焦态行为测试（R3 撤销口径回归护栏）。
 *
 * demo workbench.css composer 段 R3 撤销：composer 输入区无焦点边界，光标即焦点反馈。
 * focusRingClass 恒空（聚焦不再产生任何可见 class）——本文件锁死「任何聚焦状态下
 * composer-box 都不得出现聚焦边界 class」，防止按已退役的两代旧形态（v6 3px accent 外环 /
 * 外框 border-strong 提亮）复刻回归。
 *
 * 策略：mock 骨架单源 helpers/composer-mount.ts（useChat/useNewTaskFlow/api/stores/session
 * 四模块工厂 + 子组件 stub）+ ComposerInput 可聚焦变体 mock（defineExpose + emit focus/blur/input）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-focus-ring.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import '../helpers/composer-shell-mount'
import {
  composerApiModule,
  composerChildStubs,
  makeFocusableComposerInputMock,
  mountComposerWithStubs,
  resetComposerMountState,
} from '../helpers/composer-mount'

// ── 壳 mock（useChat / useNewTaskFlow / stores/session）：import composer-shell-mount 即
//    注册；本文件无 useChat spy 断言，'@/api' 注册留文件内 ──
vi.mock('@/api', () => composerApiModule())

// ── ComposerInput mock：defineExpose + emit focus/blur/input（focus/blur 是聚焦行为测试
//    特有事件 → helper 可聚焦变体工厂）──
const { lastInputText, ComposerInputMock } = makeFocusableComposerInputMock()

const otherStubs = { ComposerInput: ComposerInputMock, ...composerChildStubs }

import Composer from '@/components/panel/Composer.vue'

/** 已退役聚焦边界 class（R3 前旧形态：外框 border-strong 提亮） */
const RETIRED_FOCUS_CLASS = '!border-[var(--border-strong)]'

beforeEach(() => resetComposerMountState(lastInputText))

const mountComposer = mountComposerWithStubs(Composer, otherStubs)

describe('R3 无焦点边界：聚焦不产生任何聚焦 class', () => {
  it('(a) 聚焦 → composer-box 无聚焦边界（光标即焦点反馈，R3 撤销口径）', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('focus')
    await wrapper.vm.$nextTick()

    const box = wrapper.find('[data-testid="composer-box"]')
    expect(box.classes()).not.toContain(RETIRED_FOCUS_CLASS)
  })

  it('(b) 聚焦 + bash 活跃 → bash 语义色不受聚焦态影响（accent border 语义色照常在）', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    // 输入 ! 前缀触发 bash 模式 → boxClass[0] = composer-bash-mode border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-ring)]
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '!ls')
    await wrapper.vm.$nextTick()
    // 同时聚焦
    wrapper.findComponent(ComposerInputMock).vm.$emit('focus')
    await wrapper.vm.$nextTick()

    const box = wrapper.find('[data-testid="composer-box"]')
    // bash 语义色存在（无 ! 前缀的 Tailwind shadow-[] 工具类）
    expect(box.classes()).toContain('shadow-[0_0_0_3px_var(--accent-ring)]')
    // 聚焦态不叠加任何聚焦边界
    expect(box.classes()).not.toContain(RETIRED_FOCUS_CLASS)
  })

  it('(c) 未聚焦 → 无聚焦态（focusRingClass 恒空）', () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    const box = wrapper.find('[data-testid="composer-box"]')
    expect(box.classes()).not.toContain(RETIRED_FOCUS_CLASS)
  })
})
