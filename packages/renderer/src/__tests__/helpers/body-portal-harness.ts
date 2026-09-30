/**
 * reka Portal（teleport 到 document.body）交互工具（provider-builtin-ui /
 * provider-import-preview 两文件逐字重复段单源；范式同 toast-queue.ts）。
 *
 * mount attachTo body 后，portal 内容不在 wrapper 树内：查询/交互统一走 document.body；
 * 事件用原生派发（Vue @click 监听原生 click event，bubbles 生效）。
 */
/** body 内元素点击（portal 内容触发 Vue @click） */
export function clickBody(selector: string): void {
  const el = document.body.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`body 元素未找到: ${selector}`)
  el.click()
}

/** body 内 input 赋值 + 派发 input 事件（v-model 更新） */
export function setBodyInput(selector: string, value: string): void {
  const el = document.body.querySelector<HTMLInputElement>(selector)
  if (!el) throw new Error(`body input 未找到: ${selector}`)
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * reka Select 交互：打开/选中依赖 pointerdown/pointerup（click 不触发）。
 * happy-dom 缺 pointer capture API（SelectTrigger onPointerdown 直接调 target.hasPointerCapture），
 * 派发前 polyfill 到元素上。
 */
export function pointerBody(selector: string, type: 'pointerdown' | 'pointerup'): void {
  const el = document.body.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`body 元素未找到: ${selector}`)
  const anyEl = el as HTMLElement & {
    hasPointerCapture?: (id: number) => boolean
    releasePointerCapture?: (id: number) => void
  }
  if (typeof anyEl.hasPointerCapture !== 'function') anyEl.hasPointerCapture = () => false
  if (typeof anyEl.releasePointerCapture !== 'function') anyEl.releasePointerCapture = () => {}
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0 }))
}
