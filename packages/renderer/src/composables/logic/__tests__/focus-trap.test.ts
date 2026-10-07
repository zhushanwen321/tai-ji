/**
 * focus-trap 纯工具直测（SettingsModal 等宿主共享的 Tab 焦点陷阱）。
 *
 * 三路循环语义：
 * - 末个非 shift Tab → preventDefault + 聚焦首个
 * - 首个 shift Tab → preventDefault + 聚焦末个
 * - 中间元素 Tab → 不拦截（交浏览器原生顺序）
 * - 空枚举 → 放行；getFocusableElements 按 DOM 序枚举且排除禁用态 / tabindex="-1"
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/logic/__tests__/focus-trap.test.ts
 */
import { describe, it, expect } from 'vitest'
import { cycleTabFocus, getFocusableElements, FOCUSABLE_SELECTOR } from '../focus-trap'

/** 构造 keydown 事件（cancelable 必须 true，否则 preventDefault 无效果可断言） */
function tabEvent(shift = false): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, cancelable: true })
}

function mountFocusables(): HTMLElement {
    const host = document.createElement('div')
    host.innerHTML = `
      <button id="first">first</button>
      <input id="mid" />
      <button id="last">last</button>
      <button id="disabled" disabled>disabled</button>
      <span id="neg" tabindex="-1">neg</span>
    `
    document.body.appendChild(host)
    return host
}

describe('cycleTabFocus', () => {
  it('末个非 shift Tab：preventDefault + 回首个', () => {
    const host = mountFocusables()
    const first = host.querySelector('#first') as HTMLElement
    const last = host.querySelector('#last') as HTMLElement
    const e = tabEvent(false)
    last.focus()
    cycleTabFocus(e, () => getFocusableElements(host))
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    host.remove()
  })

  it('首个 shift Tab：preventDefault + 跳末个', () => {
    const host = mountFocusables()
    const first = host.querySelector('#first') as HTMLElement
    const last = host.querySelector('#last') as HTMLElement
    const e = tabEvent(true)
    first.focus()
    cycleTabFocus(e, () => getFocusableElements(host))
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)
    host.remove()
  })

  it('中间元素 Tab：不拦截（交浏览器原生顺序），焦点不变', () => {
    const host = mountFocusables()
    const mid = host.querySelector('#mid') as HTMLElement
    const e = tabEvent(false)
    mid.focus()
    cycleTabFocus(e, () => getFocusableElements(host))
    expect(e.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(mid)
    host.remove()
  })

  it('无可聚焦元素：放行', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const e = tabEvent(false)
    cycleTabFocus(e, () => getFocusableElements(host))
    expect(e.defaultPrevented).toBe(false)
    host.remove()
  })
})

describe('getFocusableElements', () => {
  it('按 DOM 序枚举可聚焦元素，排除 disabled 与 tabindex="-1"', () => {
    const host = mountFocusables()
    const ids = getFocusableElements(host).map((el) => el.id)
    expect(ids).toEqual(['first', 'mid', 'last'])
    host.remove()
  })

  it('FOCUSABLE_SELECTOR 覆盖 href / select / textarea / tabindex 形态', () => {
    const host = document.createElement('div')
    host.innerHTML = `
      <a id="link" href="#a">link</a>
      <select id="sel"><option>o</option></select>
      <textarea id="ta"></textarea>
      <div id="tn" tabindex="0">tn</div>
    `
    document.body.appendChild(host)
    const ids = getFocusableElements(host).map((el) => el.id)
    expect(ids).toEqual(['link', 'sel', 'ta', 'tn'])
    expect(FOCUSABLE_SELECTOR).toContain('[href]')
    host.remove()
  })
})
