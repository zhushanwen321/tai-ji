// @vitest-environment node

/**
 * terminal 域纯逻辑测试合并文件（波 2a 簇 1-17 语义子集）。
 *
 * 节 1 — terminal-themes：darkTerminalTheme 常量断言（核心色/ANSI 调色板/状态色）。
 * 节 2 — terminal-instance-registry：isTerminalIdOfSession 参数顺序口径 +
 *        registerInstance 的 active 落位语义（对账/恢复 vs 用户显式新建）。
 *
 * 合并说明：两节全零 mock 纯逻辑，node 环境，无同名绑定；describe/it 名零改动。
 * 簇内其余 4 文件（contrast-tokens / use-git-status / animation-source-guards /
 * i18n-value-smoke）语义互异（令牌断言 / git composable / 动画静态扫描 / i18n 冒烟），
 * 异域剔除保持独立。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/terminal/terminal-themes.test.ts --pool=threads
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { darkTerminalTheme } from '@/composables/terminal/terminal-themes'
import {
  activeTerminalIdOf,
  isTerminalIdOfSession,
  registerInstance,
  sessionIdOfTerminalId,
  unregisterInstance,
  __resetTerminalInstanceRegistryForTest,
} from '@/composables/features/terminal/terminal-instance-registry'

// ══════════ 节 1/2 — 来源: terminal-themes.test.ts ══════════

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

// ══════════ 节 2/2 — 来源: terminal-instance-registry.test.ts ══════════

/**
 * terminal-instance-registry 参数顺序口径测试（跨包同名函数防错序）。
 *
 * 背景（D2 一致性审查第 2 轮）：renderer 侧 `isTerminalIdOfSession(terminalId, sessionId)`
 * 与 runtime 侧同名函数（terminal-service.ts）顺序一致，两包无编译期约束、两参数同为
 * string——传反不报错、静默恒 false（实例被误判为他会话/非成员）。本用例把顺序口径钉成
 * 可测断言：正序命中、反序必不命中；并复核精确前缀负例（sid 含冒号不误纳）。
 */

describe('isTerminalIdOfSession 参数顺序口径（terminalId 在前、sessionId 在后）', () => {
  it('REG-1: 正序 (terminalId, sessionId) 归属命中；反序必不命中（防跨包错序静默恒 false）', () => {
    const terminalId = 'term:session-a:2'
    const sessionId = 'session-a'
    expect(isTerminalIdOfSession(terminalId, sessionId)).toBe(true)
    // 反序：terminalId 当会话、sessionId 当编号 → 前缀不可能命中
    expect(isTerminalIdOfSession(sessionId, terminalId)).toBe(false)
    // 与编号解析器自洽：解析出的会话段正是归属会话
    expect(sessionIdOfTerminalId(terminalId)).toBe(sessionId)
  })

  it('REG-2: 精确前缀（序号段须纯数字）——sid 含冒号不误纳他人实例', () => {
    expect(isTerminalIdOfSession('term:a:1:1', 'a')).toBe(false)
    expect(isTerminalIdOfSession('term:a:1:1', 'a:1')).toBe(true)
  })
})

describe('registerInstance 的 active 落位语义（对账/恢复 vs 用户显式新建）', () => {
  beforeEach(() => {
    __resetTerminalInstanceRegistryForTest()
  })

  it('REG-3: 仅会话首个实例自动成 active；后续注册不抢 active（对账批量注册不跳到最后一条目）', () => {
    registerInstance('term:s:1', true)
    expect(activeTerminalIdOf('s')).toBe('term:s:1')

    registerInstance('term:s:2', true)
    registerInstance('term:s:3', true)
    // 对账路径（terminal.list 批量注册）不抢 active：用户已选中的 / 首个实例保持
    expect(activeTerminalIdOf('s')).toBe('term:s:1')
  })

  it('REG-4: 唯一 active 实例被回收后 active 回空；此后注册才重新落位（首个实例语义）', () => {
    registerInstance('term:s:1', true)
    unregisterInstance('term:s:1')
    expect(activeTerminalIdOf('s')).toBeNull()
    registerInstance('term:s:2', true)
    expect(activeTerminalIdOf('s')).toBe('term:s:2')
  })
})
