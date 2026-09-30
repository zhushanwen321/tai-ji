/**
 * Composer 聚焦态聚焦环行为测试（MF-2 回归护栏）。
 *
 * 锁死 Composer.vue focusRingClass 的 3 条分支：
 * - (a) 聚焦 → 输出 3px accent-ring 外环（v6 §6.1 .focused 真值）
 * - (b) 聚焦 + bash 活跃 → 抑制聚焦环（exclusion：boxClass[0] 含 border-[var(--accent)]）
 * - (c) 未聚焦 → 无聚焦环
 *
 * 背景：focusRingClass 的排除条件用脆弱字符串匹配 `border-[var(--accent)]`
 * （注释自述「Plan 04 删 animate-steer-breathe 后原字符串条件变死代码，F3 修复」），
 * 已出过一次回归却无测试护栏。本测试锁死 exclusion 分支，防止再次误删。
 *
 * 断言 token 必须是 --accent-ring（30%），非 --shadow-glow（25%）——与 MF-1 裁决一致。
 * focus 聚焦环用 CSS 属性语法 `![box-shadow:0_0_0_3px_var(--accent-ring)]`（带 ! 前缀），
 * 与 bash 分支的 Tailwind 工具类 `shadow-[0_0_0_3px_var(--accent-ring)]`（无 !）区分。
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

/** focus 聚焦环 class（唯一标识：CSS 属性语法 + ! 前缀，区别于 bash 的 Tailwind shadow-[] 工具类） */
const FOCUS_RING_CLASS = '![box-shadow:0_0_0_3px_var(--accent-ring)]'

beforeEach(() => resetComposerMountState(lastInputText))

const mountComposer = mountComposerWithStubs(Composer, otherStubs)

describe('MF-2 Composer 聚焦环 focusRingClass 三分支', () => {
  it('(a) 聚焦 → composer-box 含 3px accent-ring 聚焦环（token=--accent-ring，非 shadow-glow）', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('focus')
    await wrapper.vm.$nextTick()

    const box = wrapper.find('[data-testid="composer-box"]')
    // 聚焦环出现（token 为 --accent-ring 30%，对应 v6 §6.1 .focused 真值）
    expect(box.classes()).toContain(FOCUS_RING_CLASS)
  })

  it('(b) 聚焦 + bash 活跃 → 聚焦环被抑制（exclusion：boxClass 含 border-[var(--accent)] 不叠环）', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    // 输入 ! 前缀触发 bash 模式 → boxClass[0] = composer-bash-mode border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-ring)]
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '!ls')
    await wrapper.vm.$nextTick()
    // 同时聚焦
    wrapper.findComponent(ComposerInputMock).vm.$emit('focus')
    await wrapper.vm.$nextTick()

    const box = wrapper.find('[data-testid="composer-box"]')
    // bash 环存在（无 ! 前缀的 Tailwind shadow-[] 工具类）
    expect(box.classes()).toContain('shadow-[0_0_0_3px_var(--accent-ring)]')
    // 聚焦环被抑制（exclusion 分支命中）
    expect(box.classes()).not.toContain(FOCUS_RING_CLASS)
  })

  it('(c) 未聚焦 → 无聚焦环（focusRingClass 返回空串）', () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    const box = wrapper.find('[data-testid="composer-box"]')
    expect(box.classes()).not.toContain(FOCUS_RING_CLASS)
  })
})
