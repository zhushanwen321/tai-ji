// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Toast 进出场过渡回归检查（Plan 03: toast enter-exit transition）。
 *
 * 背景：Toast 进出场是所有用户高频看到的动画，scoped style 三错叠加：
 *   1. transition: all（AUDIT §5「always a finding」——未限定过渡属性）
 *   2. leave 用 ease-in（AUDIT §2——起速慢，延迟消失瞬间）
 *   3. 0.3s/0.2s 硬编码，与 --ease/--duration-* token 体系脱节
 *
 * Plan 03 修复：显式列 opacity + transform 属性、enter/leave 都用 var(--ease)、
 * 时长消费 --duration token。
 *
 * [M7b demo 对照更新] 进出场动效对齐 demo ToastHost.vue（视觉唯一权威）：
 * enter/leave 双向 var(--duration)(200ms)（原 leave --duration-fast 120ms 不对称档
 * 退役）、位移方向 translateX(20px) 横滑 → translateY(8px) 纵浮（demo .toast-enter-from/
 * .toast-leave-to 实测）。
 *
 * 本测试固化上述成果，防止回归，并守护 plan Boundaries
 * （不加 keyframes、类名命名不变）。
 *
 * 参考：.taiji-harness/2026-08-09-animation-audit/03-toast-enter-exit-transition.md
 */
const source = readFileSync(
  resolve(__dirname, '../ToastContainer.vue'),
  'utf-8',
)

describe('Toast 进出场过渡（Plan 03: toast enter-exit transition）', () => {
  describe('TC1: 消除 transition: all（显式列过渡属性）', () => {
    it('源码不含 transition: all（AUDIT §5 always a finding）', () => {
      expect(source).not.toContain('transition: all')
    })

    it('.toast-enter-active 显式列 opacity + transform', () => {
      expect(source).toMatch(
        /\.toast-enter-active\s*\{[^}]*transition:\s*opacity[^}]*transform/,
      )
    })

    it('.toast-leave-active 显式列 opacity + transform', () => {
      expect(source).toMatch(
        /\.toast-leave-active\s*\{[^}]*transition:\s*opacity[^}]*transform/,
      )
    })
  })

  describe('TC2: leave 消除 ease-in（enter/leave 都用 --ease）', () => {
    it('源码不含 ease-in（AUDIT §2 always a finding）', () => {
      expect(source).not.toContain('ease-in')
    })

    it('.toast-enter-active 引用 var(--ease)', () => {
      expect(source).toMatch(/\.toast-enter-active\s*\{[^}]*var\(--ease\)/)
    })

    it('.toast-leave-active 引用 var(--ease)', () => {
      expect(source).toMatch(/\.toast-leave-active\s*\{[^}]*var\(--ease\)/)
    })
  })

  describe('TC3: 消费动效 token，不硬编码时长', () => {
    it('源码不含硬编码时长 0.3s / 0.2s', () => {
      expect(source).not.toContain('0.3s')
      expect(source).not.toContain('0.2s')
    })

    it('.toast-enter-active 用 --duration（200ms），非 fast', () => {
      expect(source).toMatch(/\.toast-enter-active\s*\{[^}]*var\(--duration\)/)
      const enterRule = source.match(/\.toast-enter-active\s*\{([^}]*)\}/)
      expect(enterRule, '应能匹配 .toast-enter-active 规则').not.toBeNull()
      expect(enterRule?.[1], 'enter 不应误用 --duration-fast').not.toContain(
        '--duration-fast',
      )
    })

    it('.toast-leave-active 用 --duration（200ms，M7b demo 对照：双向同档 200ms）', () => {
      expect(source).toMatch(
        /\.toast-leave-active\s*\{[^}]*var\(--duration\)/,
      )
    })
  })

  describe('plan Boundaries 守护（M7b 后的形态）', () => {
    it('.toast-enter-from / .toast-leave-to 保持 translateY(8px)（demo 纵浮方向距离不变）', () => {
      // 规则级匹配（非全文计数）：注释里的示例字样不参与断言
      const enterFrom = source.match(/\.toast-enter-from\s*\{([^}]*)\}/)?.[1] ?? ''
      const leaveTo = source.match(/\.toast-leave-to\s*\{([^}]*)\}/)?.[1] ?? ''
      expect(enterFrom).toContain('translateY(8px)')
      expect(leaveTo).toContain('translateY(8px)')
    })

    it('保持 transition 不加 keyframes（维持可中断性，AUDIT §4 已合规）', () => {
      expect(source).not.toContain('@keyframes')
    })

    it('仍使用 TransitionGroup name="toast"（类名命名不变）', () => {
      expect(source).toContain('name="toast"')
    })
  })
})
