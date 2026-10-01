/**
 * reka-ui Select 交互 helper（先例 = system-page-smart-context.test.ts）。
 *
 * SelectContent 经 SelectPortal teleport 到 body 且仅 open 时挂载；Trigger 在 pointerdown
 * 时打开，happy-dom 下需显式 dispatch；选中项按可见文本点选（pointerup + click）。
 * 禁止事后清 body.innerHTML——Teleport 的 fragment 节点仍被 Vue 持有，强拆会在组件
 * unmount 时抛 nextSibling null。
 */
import { expect } from 'vitest'
import { flushPromises } from '@vue/test-utils'

/** 被 mount 出的组件包装的最小结构面（避免跨文件耦合 VueWrapper 泛型；纯数据形状用 type 别名）。 */
export type SelectHost = {
  find(selector: string): { element: Element }
}

/** 打开 triggerTestid 指向的 Select 并点选 option（优先全等匹配文本，退化 includes 子串）。 */
export async function pickSelect(w: SelectHost, triggerTestid: string, optionText: string): Promise<void> {
  const trigger = w.find(`[data-testid="${triggerTestid}"]`).element as HTMLElement
  // reka SelectTrigger 在 pointerdown 打开，happy-dom 下需显式 dispatch（系统级交互约定，见文件头）
  trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  trigger.click()
  await flushPromises()
  const options = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
  const target = options.find((o) => o.textContent?.trim() === optionText)
    ?? options.find((o) => o.textContent?.includes(optionText))
  expect(target, `option "${optionText}" not found for ${triggerTestid}`).toBeTruthy()
  target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  target!.click()
  await flushPromises()
}
