/**
 * settings 域页面测试的共享断言（system-prompt-page / terminal-page 等保存失败 toast 与
 * corrupted 损坏提示用例的逐字重复断言段单源）。
 */
import { expect } from 'vitest'
import { useToast } from '@/composables/useToast'

/** 断言出现 message 含指定片段的 error toast（保存失败透传场景） */
export function expectErrorToastSaved(messagePart: string): void {
  const { toasts } = useToast()
  expect(toasts.value.some((t) => t.type === 'error' && t.message.includes(messagePart))).toBe(true)
}

/** 断言页内出现配置损坏提示（corrupted=true；三种文案命中其一即可） */
export function expectCorruptedHint(pageTestId: string): void {
  const page = document.body.querySelector(`[data-testid="${pageTestId}"]`)
  expect(page).toBeTruthy()
  const text = page!.textContent ?? ''
  expect(text.includes('已损坏') || text.includes('回退默认') || text.includes('损坏')).toBe(true)
}
