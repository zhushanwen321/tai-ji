/**
 * 等价测试共用断言锚。
 *
 * apply-entry-buffer-equivalence / apply-entry-fold-equivalence 两个元断言文件共用
 * 「无 id entry 派生 `e<N>` 连续 id」的断言（孪生断言单点书写，防两文件各自漂移）。
 */
import { expect } from 'vitest'

/** messages 的 id 序列恰为 `e0..e(n-1)`（无 id entry 确定性 id 派生路径的断言面）。 */
export function expectDerivedIdSequence(messages: ReadonlyArray<{ id: string }>, n: number): void {
  expect(messages.map((m) => m.id), `n=${n}`).toEqual(Array.from({ length: n }, (_, i) => `e${i}`))
}
