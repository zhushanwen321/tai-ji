/**
 * RD-5#2 / terminal-multi-instance u2：终端实例新建失败反馈（TerminalView 用）。
 *
 * PTY 起不来时原实现 `void terminal.spawnTerminal(...)` 丢弃裸 reject → 用户只看到一块空白
 * 终端，「起不来」与「起来还没输出」不可分。本 composable 把失败落成两条既有反馈通道：
 * - **挂载自动新建腿**（存量会话首开无实例时自动建默认实例）：`spawnError` inline 错误条
 *   （复用 FileView error 态范式：留痕 + 可重试），失败时不出现新条目；
 * - **「+」手动新建腿**（设计 §3.3「新建失败」）：失败经**既有全局错误通道**（toast）提示，
 *   切换条不出现新条目、不影响既有实例。
 *
 * 反馈职责分层：useTerminal.spawnTerminal 只负责留痕 + rethrow（不吞），本层把失败变成
 * 用户可行动的 UI 态。
 *
 * @param terminal useTerminal 实例（spawn 入口）
 * @param resolveDims 惰取当前 spawn 维度（cwd/cols/rows）——重试与首 spawn 同源
 */
import { ref } from 'vue'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'
import type { UseTerminalReturn } from '@/composables/features/terminal/useTerminal'

export interface TerminalSpawnDims {
  cwd: string | undefined
  cols: number
  rows: number
}

/** i18n.global.t 的类型窄化 cast（先例：useConnection.ts 同款）。 */
const t = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

export function useTerminalSpawnFeedback(
  terminal: UseTerminalReturn,
  resolveDims: () => TerminalSpawnDims,
) {
  const spawnError = ref<string | null>(null)

  /**
   * 挂载自动新建：清错误态后 spawn，失败置 inline 错误条（不出现新条目）。
   * 返回 spawn 落定（ack 建档 / 失败）即 resolve 的 promise——首挂载轮据此在置位交互门前
   * 等 ack 建档落位（见 TerminalView.activateSession「首挂载不夺焦」）。
   */
  function spawnWithFeedback(): Promise<void> {
    spawnError.value = null
    const { cwd, cols, rows } = resolveDims()
    return terminal.spawnTerminal(cwd, cols, rows).then(
      () => undefined,
      (e: unknown) => {
        spawnError.value = e instanceof Error ? e.message : String(e)
      },
    )
  }

  /** 错误条重试：清错误态后重发 spawn（返回同上，供调用方等待落定）。 */
  function retrySpawn(): Promise<void> {
    return spawnWithFeedback()
  }

  /**
   * 「+」手动新建（设计 §3.3「新建失败」）：失败经既有全局错误通道提示，
   * 不占 inline 错误条、不影响既有实例。成功时返回 ack 回传的新实例编号（调用方据此自动
   * 切到新实例并聚焦其输入区——2026-10-04 用户裁决：点「+」是显式用户意图）；失败返回 null。
   * 入口先清 spawnError：挂载腿的 inline 错误条不得跨腿泄漏到已成功新建的场景
   *（挂载 spawn 失败留下错误条后，点「+」成功建档会让错误条覆盖在新实例之上）。
   */
  function createWithToast(): Promise<string | null> {
    spawnError.value = null
    const { cwd, cols, rows } = resolveDims()
    return terminal.spawnTerminal(cwd, cols, rows).then(
      (terminalId) => terminalId,
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        console.warn('[terminal] 新建实例失败:', e)
        useToast().error(t('panel.terminal.spawnFailed', { error: message }))
        return null
      },
    )
  }

  return { spawnError, spawnWithFeedback, retrySpawn, createWithToast }
}
