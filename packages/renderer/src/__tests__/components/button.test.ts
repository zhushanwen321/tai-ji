/**
 * buttonVariants base class 回归守卫（Plan 02 — Button 按下物理反馈）。
 *
 * 守护契约 C1：buttonVariants 的 base class 必须含按下物理反馈 token：
 *   - active:scale-[0.97]（press 微缩，AUDIT §3 推荐区 0.95-0.98 中值）
 *   - transition-[background-color,color,border-color,transform]（显式属性，禁 transition-all）
 *   - duration-[var(--duration-fast)] ease-[var(--ease)]（引用 token，120ms，AUDIT 100-160ms 区间）
 * 且不得回退为 transition-colors（旧值，不含 transform）或 transition-all（plan 明确禁止）。
 *
 * 设计说明：buttonVariants 是 class-variance-authority 的 cva() 返回的纯函数，
 * 无参调用返回 base + 默认 variant 拼接的 class 字符串。用 substring (includes) 断言
 * 对拼接结果天然鲁棒——只要 base 段出现在输出里即成立，无需关心 variant 拼接顺序。
 * 不 mount Button：jsdom 不应用 :active 伪类样式也不渲染 Tailwind 真实 CSS，
 * 视觉回弹由 Plan 02 的手动 Feel check（TC2-4）覆盖。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/button.test.ts
 */
import { describe, it, expect } from 'vitest'
import { buttonVariants } from '@/components/ui/button'

describe('buttonVariants base class — Plan 02 按下物理反馈', () => {
  // cva 无参调用：返回 base + defaultVariants(variant=default,size=default) 拼接的 class 字符串。
  // base 段恒定出现在输出首部，substring 断言鲁棒。
  const baseClass = buttonVariants()

  it('正向：含按下微缩 + 显式属性 transition + token 化时长/缓动（契约 C1 全量）', () => {
    // active:scale-[0.97]（AUDIT §3 推荐区中值）
    expect(baseClass).toContain('active:scale-[0.97]')
    // 显式 transform transition（覆盖 background/color/border/transform 四属性）
    expect(baseClass).toContain('transition-[background-color,color,border-color,transform]')
    // 动效 token（duration-fast 120ms，AUDIT 100-160ms 区间）
    expect(baseClass).toContain('duration-[var(--duration-fast)]')
    expect(baseClass).toContain('ease-[var(--ease)]')
  })

  it('负向：不含旧值 transition-colors 与禁止的 transition-all（AUDIT §5）', () => {
    // transition-colors 不含 transform 覆盖（按下回弹不平滑）
    expect(baseClass).not.toContain('transition-colors')
    // 显式属性优于 all（避免 GPU 外属性意外参与动画）
    expect(baseClass).not.toContain('transition-all')
  })
})
