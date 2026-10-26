/**
 * mermaid.ts 合并测试产物（round5-g ui idx6）。
 *
 * 来源节（每来源文件包以基名命名的 describe）：
 *   mermaid-render-cleanup / mermaid-theme-sync
 *
 * mock 策略：仅 render-cleanup 节 mock 'mermaid' 库模块（renderMermaid 动态 import('mermaid')
 * 取 default 单例；vi.hoisted 共享 initialize/render 间谍）。theme-sync 节只测
 * resolveMermaidThemeVariables 纯函数、不触 mermaid 库——文件级 mock 对其惰性。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/mermaid.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { __resetMermaidForTest, renderMermaid, resolveMermaidThemeVariables } from '../mermaid'

// vi.mock 工厂被提升（hoisted），引用外部变量须走 vi.hoisted（TEST-STRATEGY §5 mock 策略）
const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}))

// mock 'mermaid' 模块（renderMermaid 动态 import('mermaid') 取 default 单例）
vi.mock('mermaid', () => ({
  default: { initialize: mermaidMocks.initialize, render: mermaidMocks.render },
}))

describe('mermaid-render-cleanup', () => {
/**
 * renderMermaid 临时 DOM 残留清理单测（B10，内存泄漏审计中危#4）。
 *
 * 泄漏机理：mermaid 11.16 的 render() 解析失败时 throw 先于内部 removeTempElements()，
 * 临时 `#d{id}` div 残留 document.body；调用侧每次生成新唯一 id，旧残留无法被后续渲染
 * 回收（流式期间不完整语法逐帧 parse 失败 → 逐帧泄漏）。
 *
 * 本文件测 logic 层 renderMermaid 的 try/finally 补捞：mock mermaid 模块（render 收到
 * id 后先在 body 植入 `#d{id}` div 再 throw / 返回——复现真实库「先建容器再 parse」
 * 行为），断言成功/失败/空 svg 三路径结束后 body 均无 `[id^="dmd-"]` 残留
 * （A7 探针 `document.querySelectorAll('[id^="dmd-"]')` 恒为空的单测前置）。
 *
 * 组件级失败态渲染（「渲染失败」占位）归 mermaid.test.ts（U12），此处不重复。
 *
 * [D10 渲染链下沉] 自 renderer 随渲染链迁入 ui（import 改相对路径）。
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/mermaid-render-cleanup.test.ts
 */

/** 复现真实 mermaid 失败路径的临时 DOM 植入：render(id) 先在 body 放 `#d{id}` div
 *  （真实库先建容器再 parse；成功时自清、失败时 throw 后残留——本 mock 统一不自清，
 *  清理责任完全交给 renderMermaid 的 finally，与被测修复点形成最强断言）。 */
function plantTempDiv(id: string): HTMLElement {
  const el = document.createElement('div')
  el.id = `d${id}`
  document.body.appendChild(el)
  return el
}

/** body 上 mermaid 临时元素残留清单（A7 探针同款选择器）。 */
function residueIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[id^="dmd-"]')).map((el) => el.id)
}

beforeEach(() => {
  mermaidMocks.render.mockReset()
  mermaidMocks.initialize.mockReset()
  __resetMermaidForTest()
  for (const el of Array.from(document.querySelectorAll('[id^="dmd-"]'))) el.remove()
})

describe('renderMermaid 临时 DOM 清理（B10 try/finally 补捞）', () => {
  it('解析失败（render throw）：异常照常上抛，finally 补捞清除临时 #d{id} div', async () => {
    mermaidMocks.render.mockImplementation((id: string) => {
      plantTempDiv(id)
      throw new Error('parse error')
    })
    await expect(renderMermaid('graph TD; A--->>', 'dark')).rejects.toThrow('parse error')
    expect(residueIds()).toEqual([])
  })

  it('成功路径：finally 的 remove 对已清/未清元素均为 no-op，svg 正常返回', async () => {
    mermaidMocks.render.mockImplementation((id: string) => {
      // 模拟 mermaid 成功自清后返回（临时 div 已被库自身移除的形态）
      plantTempDiv(id).remove()
      return { svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' }
    })
    const result = await renderMermaid('graph TD; A-->B', 'dark')
    expect(result.svg).toContain('<svg')
    expect(residueIds()).toEqual([])
  })

  it('成功路径（库未及自清的宽容形态）：finally 兜底清除仍生效', async () => {
    mermaidMocks.render.mockImplementation((id: string) => {
      plantTempDiv(id) // 不 remove：交给 finally
      return { svg: '<svg viewBox="0 0 10 10"/>' }
    })
    await expect(renderMermaid('graph TD; A-->B', 'dark')).resolves.toMatchObject({
      svg: expect.stringContaining('<svg'),
    })
    expect(residueIds()).toEqual([])
  })

  it('空 svg（happy-dom/jsdom 静默失败形态）：throw 前 finally 先清临时 div', async () => {
    mermaidMocks.render.mockImplementation((id: string) => {
      plantTempDiv(id)
      return { svg: '' }
    })
    await expect(renderMermaid('bad source', 'dark')).rejects.toThrow('空 svg')
    expect(residueIds()).toEqual([])
  })

  it('连续失败（流式逐帧 parse 失败形态）：多次调用后无累积残留', async () => {
    mermaidMocks.render.mockImplementation((id: string) => {
      plantTempDiv(id)
      throw new Error('parse error')
    })
    for (let i = 0; i < 5; i++) {
      await expect(renderMermaid(`incomplete frame ${i}`, 'dark')).rejects.toThrow('parse error')
    }
    expect(residueIds()).toEqual([])
  })
})
})

describe('mermaid-theme-sync', () => {
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
})
