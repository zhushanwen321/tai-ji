/**
 * Composer 聚焦态行为测试（MF-2 回归护栏；M4a demo 复刻后聚焦形态 = 外框 border-strong）。
 *
 * 锁死 Composer.vue focusRingClass 的 3 条分支：
 * - (a) 聚焦 → 外框提亮 border-strong（demo 权威：.composer-box:focus-within
 *       { border-color: var(--border-strong) }；v6 3px accent 外环已退役）
 * - (b) 聚焦 + bash 活跃 → 抑制聚焦态（exclusion：boxClass[0] 含 border-[var(--accent)]）
 * - (c) 未聚焦 → 无聚焦态
 *
 * 背景：focusRingClass 的排除条件用脆弱字符串匹配 `border-[var(--accent)]`
 * （注释自述「Plan 04 删 animate-steer-breathe 后原字符串条件变死代码，F3 修复」），
 * 已出过一次回归却无测试护栏。本测试锁死 exclusion 分支，防止再次误删。
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

/** focus 聚焦态 class（唯一标识：外框 border-strong 提亮，! 前缀压过默认 border 色） */
const FOCUS_CLASS = '!border-[var(--border-strong)]'

beforeEach(() => resetComposerMountState(lastInputText))

const mountComposer = mountComposerWithStubs(Composer, otherStubs)

describe('MF-2 Composer 聚焦态 focusRingClass 三分支', () => {
  it('(a) 聚焦 → composer-box 外框提亮 border-strong（demo :focus-within 权威形态）', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('focus')
    await wrapper.vm.$nextTick()

    const box = wrapper.find('[data-testid="composer-box"]')
    expect(box.classes()).toContain(FOCUS_CLASS)
  })

  it('(b) 聚焦 + bash 活跃 → 聚焦态被抑制（exclusion：boxClass 含 border-[var(--accent)] 不叠加）', async () => {
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
    // 聚焦态被抑制（exclusion 分支命中）
    expect(box.classes()).not.toContain(FOCUS_CLASS)
  })

  it('(c) 未聚焦 → 无聚焦态（focusRingClass 返回空串）', () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    const box = wrapper.find('[data-testid="composer-box"]')
    expect(box.classes()).not.toContain(FOCUS_CLASS)
  })
})
