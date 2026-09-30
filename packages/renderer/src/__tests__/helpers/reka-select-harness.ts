/**
 * reka Select 下拉交互 harness（settings/appearance-page.test.ts 与
 * settings/update-page-source.test.ts 两文件逐字重复的单选交互序列单源）。
 *
 * reka Select 真实组件交互：pointerdown 打开（SelectPortal teleport 到 body），在
 * document.body 找 [role="option"]，pointerup + click 点选。断言文案未命中即失败
 * （expect 内带 label 信息，定位失败可读）。
 */
import { expect } from 'vitest'
import { flushPromises } from '@vue/test-utils'

/** 打开指定 trigger 的下拉，返回全部 option 元素（reka Select：pointerdown 打开） */
export async function openRekaDropdown(trigger: Element): Promise<HTMLElement[]> {
  trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  ;(trigger as HTMLElement).click()
  await flushPromises()
  return Array.from(document.body.querySelectorAll('[role="option"]')) as HTMLElement[]
}

/** 在已展开下拉的 option 清单中点选含指定文案的项（pointerup + click 走 reka 真实交互链；
 *  断言文案未命中即失败，expect 内带 label 信息，定位失败可读） */
export async function pickRekaOptionFrom(options: HTMLElement[], label: string): Promise<void> {
  const target = options.find((el) => (el.textContent ?? '').includes(label))
  expect(target, `option "${label}" should exist in dropdown`).toBeTruthy()
  target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  target!.click()
  await flushPromises()
}

/** 打开指定 trigger 的下拉并点选含指定文案的 option（pointerdown 打开 + pickRekaOptionFrom 点选） */
export async function pickRekaOption(trigger: Element, label: string): Promise<void> {
  await pickRekaOptionFrom(await openRekaDropdown(trigger), label)
}
