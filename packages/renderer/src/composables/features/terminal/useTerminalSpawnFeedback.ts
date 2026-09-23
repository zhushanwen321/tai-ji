/**
 * RD-5#2：终端 spawn 失败反馈（TerminalView 用）。
 *
 * PTY 起不来时原实现 `void terminal.spawnTerminal(...)` 丢弃裸 reject → 用户只看到一块空白
 * 终端，「起不来」与「起来还没输出」不可分。本 composable 把失败落成可见状态：
 * - `spawnError`：null = 无错误；string = 归一化错误消息（供 inline 错误条渲染）
 * - `spawnWithFeedback`：发起 spawn 前先清错误态；失败才置位（不清则是重试后旧错误残留）
 * - `retrySpawn`：错误条「重试」按钮——清态后重发 spawn（useTerminal 内部不缓存 PTY，
 *   直接重发即重新拉起；成功后错误条由下一次 spawnWithFeedback 的清态消失）
 *
 * 反馈职责分层：useTerminal.spawnTerminal 只负责留痕 + rethrow（不吞），本层负责把失败变成
 * 用户可行动的 UI 态——与 P7 的 RD-5#4 write/resize/kill/attach `.catch` 不重复（后者是
 * 管道级故障，由 runtime terminal.writeFailed toast 链覆盖）。
 *
 * @param terminal useTerminal 实例（spawn 入口）
 * @param resolveDims 惰取当前 spawn 维度（cwd/cols/rows）——重试与首 spawn 同源
 */
import { ref } from 'vue'
import type { UseTerminalReturn } from '@/composables/features/terminal/useTerminal'

export interface TerminalSpawnDims {
  cwd: string | undefined
  cols: number
  rows: number
}

export function useTerminalSpawnFeedback(
  terminal: UseTerminalReturn,
  resolveDims: () => TerminalSpawnDims,
) {
  const spawnError = ref<string | null>(null)

  function spawnWithFeedback(): void {
    spawnError.value = null
    const { cwd, cols, rows } = resolveDims()
    void terminal.spawnTerminal(cwd, cols, rows).catch((e: unknown) => {
      spawnError.value = e instanceof Error ? e.message : String(e)
    })
  }

  /** 错误条重试：清错误态后重发 spawn。 */
  function retrySpawn(): void {
    spawnWithFeedback()
  }

  return { spawnError, spawnWithFeedback, retrySpawn }
}
