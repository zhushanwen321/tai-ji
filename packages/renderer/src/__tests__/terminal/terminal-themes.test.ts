import { describe, it, expect } from 'vitest'
import { darkTerminalTheme } from '@/composables/terminal/terminal-themes'

describe('darkTerminalTheme', () => {
  const hexPattern = /^#[0-9a-f]{6}$/i
  const rgbaPattern = /^rgba\(\d+,\s*\d+,\s*\d+,\s*[\d.]+\)$/

  it('核心色：fg/cursor 对齐 v3 tokens，背景为纯黑块（2026-08-14 裁决，f9719a71e）', () => {
    // f9719a71e：终端为纯黑圆角块嵌 drawer 深底（v6-drawer-tabs-demo），
    // background/cursorAccent 由 #1a1b1f 改 #000000 与黑块画布一致
    expect(darkTerminalTheme.background).toBe('#000000')
    expect(darkTerminalTheme.foreground).toBe('#f7f8fc')
    expect(darkTerminalTheme.cursor).toBe('#4f8ef7')
    expect(darkTerminalTheme.cursorAccent).toBe('#000000')
  })

  it('selectionBackground 使用 rgba（透明度）', () => {
    expect(darkTerminalTheme.selectionBackground).toMatch(rgbaPattern)
    expect(darkTerminalTheme.selectionInactiveBackground).toMatch(rgbaPattern)
  })

  it('16 色 ANSI 调色板全部为合法 hex', () => {
    const colorKeys = [
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
      'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
    ] as const

    for (const key of colorKeys) {
      const value = darkTerminalTheme[key]
      expect(value, `${key} should be defined`).toBeDefined()
      expect(value, `${key} should be valid hex`).toMatch(hexPattern)
    }
  })

  it('bright 变体比标准色更亮（亮度递增）', () => {
    // 简单验证：bright 变体不等于标准色（除了 black 特殊情况）
    expect(darkTerminalTheme.brightRed).not.toBe(darkTerminalTheme.red)
    expect(darkTerminalTheme.brightGreen).not.toBe(darkTerminalTheme.green)
    expect(darkTerminalTheme.brightBlue).not.toBe(darkTerminalTheme.blue)
    expect(darkTerminalTheme.brightWhite).not.toBe(darkTerminalTheme.white)
  })

  it('状态色对齐 v3 状态色', () => {
    expect(darkTerminalTheme.red).toBe('#ef4444')       // --danger
    expect(darkTerminalTheme.green).toBe('#22c55e')     // --success
    expect(darkTerminalTheme.yellow).toBe('#f5a524')    // --warning
    expect(darkTerminalTheme.cyan).toBe('#38bdf8')      // --info
    expect(darkTerminalTheme.magenta).toBe('#a78bfa')   // --reasoning
  })
})
