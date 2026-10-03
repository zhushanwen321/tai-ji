/**
 * useTerminalXterm —— TerminalView 的 xterm 视图生命周期（多实例，u2 提取以收敛组件 script 规模）。
 *
 * 职责：xterm 实例 + addons 的创建/销毁、模块级分区历史回放（分批逐帧）、flush 监听注册、
 * 当前显示实例切换时重建视图与焦点落点、settings 变化的动态应用、选区状态（联动 1 浮动按钮）。
 *
 * 与 useTerminal 的分工：useTerminal 管「实例域状态 + PTY 控制」（模块级，跨组件存活）；
 * 本 composable 管「xterm 组件实例」（跟随 tab 可见性 × 当前显示实例）。切换实例 = 重建
 * xterm + 回放目标实例分区（各实例输出历史互相隔离，设计 §1 目标 2）。
 *
 * 焦点规则（设计 §3.3「焦点规则」）：切换实例后键盘焦点落新显示实例输入区；
 * 关闭实例后焦点落其右侧相邻（无右取左）——active 落位在注册表层，本层在 active 变化
 * 后 focus 新 xterm。首挂载不主动抢焦点（保持改造前「开面板不夺焦」的体感，目标 5）。
 */
import { ref, watch, type ComputedRef, type Ref } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { getSettingsStore } from '@taiji/core'
import { resolveXtermFontOptions } from '@/components/panel/terminal-xterm-options'
import { darkTerminalTheme } from '@/composables/terminal/terminal-themes'
import type { TerminalSpawnDims } from '@/composables/features/terminal/useTerminalSpawnFeedback'
import {
  replayChunksBatched,
  type TerminalBuffer,
  type UseTerminalReturn,
} from '@/composables/features/terminal/useTerminal'

import '@xterm/xterm/css/xterm.css'

export type UseTerminalXtermOptions = {
  /** xterm 挂载点。 */
  container: Ref<HTMLDivElement | null>
  /** useTerminal 实例（分区读写 + PTY 控制 + flush 监听注册）。 */
  terminal: UseTerminalReturn
  /** 当前显示实例编号（null = 空态，不建 xterm）。 */
  activeTerminalId: ComputedRef<string | null>
  /** 惰取 spawn / attach 维度（cwd/cols/rows）。 */
  resolveDims: () => TerminalSpawnDims
  /** 用户输入 → 写 PTY。 */
  onData: (data: string) => void
}

export function useTerminalXterm(opts: UseTerminalXtermOptions) {
  const settingsStore = getSettingsStore()

  // Phase 4 联动 1：选区浮动按钮状态
  const hasSelection = ref(false)
  const selectionPos = ref({ top: 0, left: 0 })

  let xterm: Terminal | null = null
  let fitAddon: FitAddon | null = null
  let resizeObserver: ResizeObserver | null = null
  /** 当前 xterm 绑定的实例编号（切实例时重建）。 */
  let viewTerminalId: string | null = null
  /** 版本回放指针（本视图已回放 chunk 总数）。 */
  let replayedVersion = 0
  let unregisterFlush: (() => void) | null = null

  // ── 回放分批写队列（Fix-5）：全量可达 5000 chunks × 4KB，拆批逐帧写；指针入队即推进 ──
  const replayWriteQueue: string[] = []
  let replayWriteScheduled = false

  /** 消费一帧：写队列首批，非空则调度下一帧继续（rAF 链）。 */
  function pumpReplayWrites(): void {
    replayWriteScheduled = false
    if (replayWriteQueue.length === 0) return
    if (!xterm) {
      replayWriteQueue.length = 0
      return
    }
    xterm.write(replayWriteQueue.shift()!)
    if (replayWriteQueue.length > 0) {
      replayWriteScheduled = true
      requestAnimationFrame(pumpReplayWrites)
    }
  }

  /** 回放批次入队（顺序 = 入队序）：空闲即同步消费，否则 rAF 链逐帧。 */
  function enqueueReplayWrites(batches: string[]): void {
    replayWriteQueue.push(...batches)
    if (!replayWriteScheduled) pumpReplayWrites()
  }

  /**
   * 版本回放（D-6.2）：fromVersion（含）之后 append 的 chunk 分批复放（每批 ≤500，Fix-5）。
   * 指针立即推进到 targetVersion；clamped（指针落后裁剪线）时先清屏 + 丢挂起批次再写。
   */
  function replayFrom(fromVersion: number, buffer: TerminalBuffer): void {
    if (!xterm) return
    const result = replayChunksBatched(buffer, fromVersion)
    if (result === null) return
    if (result.clamped) {
      xterm.clear()
      replayWriteQueue.length = 0
    }
    replayedVersion = result.targetVersion
    enqueueReplayWrites(result.batches)
  }

  /** flush 监听回调：模块级 flush 完成后按本视图指针增量回放。 */
  function onFlushed(buffer: TerminalBuffer): void {
    if (buffer.version < replayedVersion) {
      // version 单调只增，回退 = 被 clearPartition 重置（Fix-3）：清本视图 + 指针归零 + 丢挂起批次
      xterm?.clear()
      replayedVersion = 0
      replayWriteQueue.length = 0
    }
    replayFrom(replayedVersion, buffer)
  }

  /** 初始化 xterm 实例 + addons。 */
  function initXterm(): boolean {
    if (!opts.container.value || xterm) return false
    const fit = new FitAddon()
    fitAddon = fit
    const fontOpts = resolveXtermFontOptions(settingsStore.terminalConfig.value?.config)
    const term = new Terminal({
      fontSize: fontOpts.fontSize,
      fontFamily: fontOpts.fontFamily,
      cursorStyle: fontOpts.cursorStyle,
      cursorBlink: true,
      scrollback: fontOpts.scrollback,
      allowProposedApi: true,
      theme: darkTerminalTheme,
    })
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.loadAddon(new SearchAddon())
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.open(opts.container.value)

    // 用户输入 → 写入 PTY
    term.onData((data) => {
      opts.onData(data)
    })

    // resize：fit 后通知 runtime PTY resize
    term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      opts.terminal.resizeTerminal(cols, rows)
    })

    // Phase 4 联动 1：选区变化 → 更新浮动按钮显隐 + 定位
    term.onSelectionChange(() => {
      if (term.hasSelection()) {
        const pos = term.getSelectionPosition()
        hasSelection.value = true
        // 估算浮动按钮位置（选区末行下方）。cell 尺寸约 fontSize * 0.6（宽）/ 1.2（高）
        const cellHeight = 16
        const cellWidth = 8
        selectionPos.value = {
          top: (pos?.end.y ?? 0) * cellHeight + cellHeight,
          left: (pos?.end.x ?? 0) * cellWidth,
        }
      } else {
        hasSelection.value = false
      }
    })

    // 容器尺寸变化 → fit
    resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch (e) {
        // best-effort：容器未渲染（尺寸 0）时 fit 抛错，降级不调整——下次回调重试
        console.debug('[terminal] fit skipped (container size 0)', e)
      }
    })
    resizeObserver.observe(opts.container.value)

    xterm = term
    return true
  }

  /** 拆除当前 xterm 视图（实例切换 / 卸载）。 */
  function teardownXterm(): void {
    unregisterFlush?.()
    unregisterFlush = null
    resizeObserver?.disconnect()
    resizeObserver = null
    xterm?.dispose()
    xterm = null
    fitAddon = null
    replayedVersion = 0
    replayWriteQueue.length = 0
    hasSelection.value = false
  }

  /**
   * 同步视图到当前显示实例：编号未变且 xterm 在场 → no-op；否则重建 + 全量回放该实例分区 +
   * 注册 flush 监听 + attach（确保订阅，幂等兜底）。
   */
  function syncView(): void {
    const terminalId = opts.activeTerminalId.value
    if (terminalId === viewTerminalId && xterm) return
    teardownXterm()
    viewTerminalId = terminalId
    if (terminalId === null) return
    if (!initXterm()) return
    replayFrom(0, opts.terminal.partitionOf(terminalId).buffer)
    unregisterFlush = opts.terminal.registerFlushListener(terminalId, onFlushed)
    opts.terminal.attachTerminal()
    try {
      fitAddon?.fit()
    } catch (e) {
      // best-effort：mount / 切实例瞬间容器尺寸为 0 时 fit 抛错，降级不调整
      // （ResizeObserver 后续回调会补偿）
      console.debug('[terminal] initial fit skipped (container size 0)', e)
    }
  }

  /** 焦点落当前实例输入区（切换 / 关闭后由 active 变化驱动）。 */
  function focus(): void {
    xterm?.focus()
  }

  /** 清屏（清 xterm + 当前实例分区 buffer，Fix-3：切走切回历史不复活）。 */
  function clear(): void {
    xterm?.clear()
    opts.terminal.clearTerminal()
  }

  /** 当前选区文本（联动 1「发给 AI」）。 */
  function getSelection(): string {
    return xterm?.getSelection() ?? ''
  }

  /** 清选区态（注入后关闭浮动按钮）。 */
  function dismissSelection(): void {
    hasSelection.value = false
  }

  /** settings → Terminal 配置变化（字体/字号/scrollback/cursorStyle）动态应用到已挂载 xterm。 */
  const stopSettingsWatch = watch(
    () => settingsStore.terminalConfig.value,
    () => {
      if (!xterm) return
      const o = resolveXtermFontOptions(settingsStore.terminalConfig.value?.config)
      xterm.options.fontSize = o.fontSize
      xterm.options.fontFamily = o.fontFamily
      xterm.options.scrollback = o.scrollback
      xterm.options.cursorStyle = o.cursorStyle
      try {
        fitAddon?.fit()
      } catch (e) {
        // best-effort：config 变化时容器若未渲染（如 tab 不可见）fit 抛错，降级不调整——
        // 下次可见时 ResizeObserver 补偿
        console.debug('[terminal] refit skipped after config change', e)
      }
    },
  )

  /** 全拆（组件卸载）：视图 + settings watch。 */
  function dispose(): void {
    teardownXterm()
    viewTerminalId = null
    stopSettingsWatch()
  }

  return {
    hasSelection,
    selectionPos,
    syncView,
    focus,
    clear,
    getSelection,
    dismissSelection,
    dispose,
  }
}
