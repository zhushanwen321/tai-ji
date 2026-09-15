import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Toast 进出场过渡回归守卫（Plan 03: toast enter-exit transition）。
 *
 * 背景：Toast 进出场是所有用户高频看到的动画，scoped style 三错叠加：
 *   1. transition: all（AUDIT §5「always a finding」——未限定过渡属性）
 *   2. leave 用 ease-in（AUDIT §2——起速慢，延迟消失瞬间）
 *   3. 0.3s/0.2s 硬编码，与 --ease/--duration-* token 体系脱节
 *
 * Plan 03 修复：显式列 opacity + transform 属性、enter/leave 都用 var(--ease)、
 * enter 用 --duration(200ms)、leave 用 --duration-fast(120ms) 更果断。
 *
 * 本测试固化修复成果，防止上述 3 个 finding 回归，并守护 plan Boundaries
 * （不改 translateX 方向距离、不加 keyframes、类名命名不变）。
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

    it('.toast-leave-active 用 --duration-fast（120ms，比 enter 更果断）', () => {
      expect(source).toMatch(
        /\.toast-leave-active\s*\{[^}]*var\(--duration-fast\)/,
      )
    })
  })

  describe('plan Boundaries 守护（不改的部分）', () => {
    it('.toast-enter-from / .toast-leave-to 保持 translateX(20px)（方向距离不变）', () => {
      const fromMatches = source.match(/translateX\(20px\)/g)
      expect(
        fromMatches,
        'translateX(20px) 应出现 2 次（enter-from + leave-to）',
      ).toHaveLength(2)
    })

    it('保持 transition 不加 keyframes（维持可中断性，AUDIT §4 已合规）', () => {
      expect(source).not.toContain('@keyframes')
    })

    it('仍使用 TransitionGroup name="toast"（类名命名不变）', () => {
      expect(source).toContain('name="toast"')
    })
  })
})
