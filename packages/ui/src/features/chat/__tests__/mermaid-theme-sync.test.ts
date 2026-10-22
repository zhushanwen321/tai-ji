/**
 * mermaid 主题表 ↔ style.css token 对拍单测（防漂移机检）。
 *
 * mermaid 的 themeVariables 不支持 CSS 变量引用（颜色 bake 进 SVG），故
 * mermaid.ts 的主题表是 style.css token 值的**手工快照**——本测试从 style.css
 * 解析对应 token 现值与快照逐项断言相等：token 改值时此处变红，提示同步 mermaid 表。
 * 边框类 token 是 rgba 形态，mermaid 需要 8 位 hex（#RRGGBBAA），按 alpha×255 四舍五入换算。
 *
 * 已知限制（mermaid.ts 头注释同款）：preset（黛蓝/暖墨/青墨/朱印）accent 色相不进本映射，
 * themeVariables 只有暗/亮轴——本测试只对拍 :root（玄）与 [data-theme="light"]（皓）两块。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveMermaidThemeVariables } from '../mermaid.js'

const styleCss = readFileSync(
  resolve(import.meta.dirname, '../../../../../renderer/src/style.css'),
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

/** token 值 → mermaid 表形态：hex 原样；rgba(r,g,b,a) → 8 位 hex（alpha×255 四舍五入） */
function toMermaidForm(raw: string): string {
  const hex = raw.match(/^#[0-9a-fA-F]{6}$/)
  if (hex) return raw
  const rgba = raw.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/)
  expect(rgba, `token 值形态非 hex/rgba，需扩展换算：${raw}`).not.toBeNull()
  const [, r, g, b, a] = rgba!
  const alpha = Math.round(Number(a) * 255)
    .toString(16)
    .padStart(2, '0')
  return `#${Number(r).toString(16).padStart(2, '0')}${Number(g).toString(16).padStart(2, '0')}${Number(b).toString(16).padStart(2, '0')}${alpha}`
}

/** mermaid 变量 → token 名（暗/亮两轴共用同一映射） */
const MERMAID_TO_TOKEN: Record<string, string> = {
  primaryColor: '--surface',
  primaryBorderColor: '--border-strong',
  primaryTextColor: '--neutral-fg',
  secondaryColor: '--surface-2',
  secondaryBorderColor: '--accent',
  secondaryTextColor: '--neutral-mid',
  tertiaryColor: '--bg',
  tertiaryBorderColor: '--border',
  tertiaryTextColor: '--neutral-mid',
  lineColor: '--accent',
  noteBkgColor: '--surface-2',
  noteTextColor: '--neutral-fg',
  noteBorderColor: '--accent',
}

const BLOCKS = {
  dark: { chain: [':root'], label: '暗（玄）' },
  light: { chain: [':root', '[data-theme="light"]'], label: '亮（皓）' },
} as const

describe('mermaid 主题表 ↔ style.css token 对拍（改 token 必同批同步 mermaid.ts）', () => {
  for (const [theme, block] of Object.entries(BLOCKS)) {
    it(`${block.label}：13 个 themeVariables 与 token 现值一致`, () => {
      const merged: Record<string, string> = {}
      for (const selector of block.chain) Object.assign(merged, parseBlockVars(selector))
      const table = resolveMermaidThemeVariables(theme as 'dark' | 'light')
      for (const [mermaidVar, tokenName] of Object.entries(MERMAID_TO_TOKEN)) {
        const raw = merged[tokenName]
        expect(raw, `token ${tokenName} 缺声明`).toBeDefined()
        expect(
          table[mermaidVar],
          `${block.label} ${mermaidVar}（注释锚定 ${tokenName}）与 style.css 现值漂移：表 ${table[mermaidVar]} vs token ${toMermaidForm(raw!)}`,
        ).toBe(toMermaidForm(raw!))
      }
    })
  }
})
