/**
 * 主题预览 swatch ↔ style.css token 对拍单测（防漂移机检）。
 *
 * 设置页主题行的四色预览块（accent / fg / surface / bg）消费 useTaijiThemes.ts 的
 * swatch 静态快照——快照是功能必需（各行预览各自主题色，不能像当前主题元素那样用
 * var() 渲染），但 hex 与 style.css 现值之间无运行时关联，桌面改 token 时会静默漂移。
 * 本测试从 style.css 级联解析六主题的四个 token 实值与 swatch 数组逐项断言相等：
 * 改 token 必同批同步 swatch，否则此处变红。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TAIJI_THEMES } from '../useTaijiThemes.js'

const styleCss = readFileSync(
  resolve(import.meta.dirname, '../../style.css'),
  'utf-8',
).replace(/\/\*[\s\S]*?\*\//g, '')

function parseBlockVars(selector: string): Record<string, string> {
  const idx = styleCss.indexOf(selector)
  expect(idx, `style.css 未找到选择器块：${selector}`).toBeGreaterThanOrEqual(0)
  const open = styleCss.indexOf('{', idx)
  const close = styleCss.indexOf('}', open)
  const vars: Record<string, string> = {}
  for (const m of styleCss.slice(open + 1, close).matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars[m[1]] = m[2].trim()
  }
  return vars
}

/** swatch 顺序 = [accent, fg, surface, bg]，与 demo chip 四色条同序 */
const SWATCH_TOKENS = ['--accent', '--neutral-fg', '--surface', '--bg'] as const

/** 各主题的 style.css 级联链（与 contrast-tokens.test.ts 同口径）；键 = theme:preset
 *  （皓白/玄青的 preset 都是空串，单靠 preset 区分不出亮色默认） */
const THEME_CHAIN: Record<string, string[]> = {
  'dark:': [':root'],
  'dark:dailan': [':root', ':root[data-theme-preset="dailan"]'],
  'dark:nuanmo': [':root', ':root[data-theme-preset="nuanmo"]'],
  'light:': [':root', '[data-theme="light"]'],
  'light:qingmo': [':root', '[data-theme="light"]', '[data-theme="light"][data-theme-preset="qingmo"]'],
  'light:zhuyin': [':root', '[data-theme="light"]', '[data-theme="light"][data-theme-preset="zhuyin"]'],
}

describe('主题行 swatch 快照 ↔ style.css 对拍（改 token 必同批同步 useTaijiThemes）', () => {
  for (const theme of TAIJI_THEMES) {
    it(`${theme.shortName}：swatch 四色与 style.css 现值一致`, () => {
      const merged: Record<string, string> = {}
      const chain = THEME_CHAIN[`${theme.theme}:${theme.preset}`]
      expect(chain, `主题 ${theme.shortName} 缺级联链登记`).toBeDefined()
      for (const selector of chain) Object.assign(merged, parseBlockVars(selector))
      expect(theme.swatch, `${theme.shortName} swatch 应为四色 [accent, fg, surface, bg]`).toHaveLength(4)
      theme.swatch.forEach((hex, i) => {
        const tokenName = SWATCH_TOKENS[i]
        const tokenValue = merged[tokenName]?.toLowerCase()
        expect(tokenValue, `token ${tokenName} 应为 hex 字面值`).toMatch(/^#[0-9a-fA-F]{6}$/)
        expect(
          hex.toLowerCase(),
          `${theme.shortName} swatch[${i}]（${tokenName}）与 style.css 漂移：swatch ${hex} vs token ${tokenValue}`,
        ).toBe(tokenValue)
      })
    })
  }
})
