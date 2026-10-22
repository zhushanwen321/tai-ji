/**
 * provider-live-sync 测试的 tick 驱动共用件（catalog-bridge 与 model-sync 的同款夹具）。
 *
 * 驱动约定：fake timers 只替换 setTimeout/clearTimeout，tick 链上的 readFile 与
 * setImmediate 保持真实（I/O 宏任务逐事件循环轮次自然落地）。
 *
 * 拍屏障：每拍等 `getTimerCount() >= 1`——本拍 tick 落地后其 `.finally(schedule)` 必然
 * 注册下一个 fake timer，等它即证明本拍 readFile 链（真实线程池 I/O）已结束。固定轮次
 * flush 不行：线程池完成回调的到达轮次不定，偶发「tick 晚于下一拍的 writeFileSync
 * 完成 → 新内容被当首基线」假红。
 */
import { expect, vi } from 'vitest'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import providerLiveSync, { POLL_INTERVAL_MS } from '../index.ts'

/** 逐真实事件循环轮次（setImmediate 未被 fake）轮询等待谓词成立。 */
async function waitFor(predicate: () => boolean, maxTurns = 5_000): Promise<void> {
  for (let i = 0; i < maxTurns && !predicate(); i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/** 推进一个轮询周期并等本拍 tick 完整落地（拍屏障说明见模块头注释）。 */
export async function tickOnce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
  await waitFor(() => vi.getTimerCount() >= 1)
}

/**
 * 启动扩展并注入 fake modelRegistry 会话 ctx（tick 驱动用例的共同骨架）：捕获
 * session_start handler、以 `{ refresh, getError }` spy 的 ctx 调用它。`piStub` = 各
 * 测试文件特有的 pi 宿主面（appendEntry / registerProvider 等 spy）。
 */
export function startWithRegistryCtx<T extends Record<string, unknown>>(
  piStub: T,
): { refresh: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> } {
  const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }))
  const getError = vi.fn(() => null)
  const ctx = { modelRegistry: { refresh, getError } }
  const on = vi.fn()
  providerLiveSync({ ...piStub, on } as unknown as ExtensionAPI)
  const handler = on.mock.calls.find((call) => call[0] === 'session_start')?.[1] as
    | ((event: unknown, sessionCtx: unknown) => void)
    | undefined
  expect(handler).toBeTypeOf('function')
  handler?.({ type: 'session_start' }, ctx)
  return { refresh, on }
}
