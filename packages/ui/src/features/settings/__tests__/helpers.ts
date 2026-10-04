/**
 * settings 功能测试共享 helper。
 *
 * 对齐同包 chat 功能 `__tests__/helpers.ts` 惯例：跨测试文件复用的测试脚手架
 * 收拢一处，供本目录测试文件 import（ui 包不依赖 renderer，跨包同名桩属包边界真差异）。
 */
import type { KVStorage } from '@taiji/core'
import { expect } from 'vitest'
import { flushPromises, type VueWrapper } from '@vue/test-utils'

/** 内存 storage 桩（providePlatform.storage 用；与 renderer 端 platform-storage-stub 为
 *  跨包包边界两副本（ui 不得依赖 renderer 测试基建），契约层经 KVStorage 类型锚定单源
 *  ——类型漂移由两包 typecheck 拦截） */
export function inMemoryStorage(): KVStorage {
  const map = new Map<string, string>()
  return {
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => { map.set(k, v) },
    remove: async (k: string) => { map.delete(k) },
  }
}

/** reka Select 交互（happy-dom 需显式 pointer 事件；同 renderer rename-model 测试模式） */
export async function pickSelectOption(triggerEl: HTMLElement, label: string): Promise<void> {
  triggerEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  triggerEl.click()
  await flushPromises()
  const target = Array.from(document.body.querySelectorAll('[role="option"]'))
    .find((el): el is HTMLElement => (el.textContent ?? '').includes(label))
  expect(target).toBeTruthy()
  target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  target!.click()
  await flushPromises()
}

/** 断言测试连接失败指引区块（provider-test-hints）已渲染且文本含全部给定片段 */
export function expectTestHints(w: VueWrapper, ...fragments: string[]): void {
  const hints = w.find('[data-testid="provider-test-hints"]')
  expect(hints.exists()).toBe(true)
  for (const fragment of fragments) {
    expect(hints.text()).toContain(fragment)
  }
}
