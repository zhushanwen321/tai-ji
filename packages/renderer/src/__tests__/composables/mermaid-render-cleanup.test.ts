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
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/mermaid-render-cleanup.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { __resetMermaidForTest, renderMermaid } from '@/composables/logic/mermaid'

// vi.mock 工厂被提升（hoisted），引用外部变量须走 vi.hoisted（TEST-STRATEGY §5 mock 策略）
const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}))

// mock 'mermaid' 模块（renderMermaid 动态 import('mermaid') 取 default 单例）
vi.mock('mermaid', () => ({
  default: { initialize: mermaidMocks.initialize, render: mermaidMocks.render },
}))

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
