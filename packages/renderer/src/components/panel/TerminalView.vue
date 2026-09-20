<!--
  TerminalView —— drawer 集成终端的交互式渲染组件（Phase 3）。

  基于 xterm.js + addons（fit/web-links/search/unicode11），接收 sessionId prop。
  生命周期解耦（见 useTerminal 注释）：本组件只管 xterm 实例，PTY + scrollback 在 useTerminal。

  mount 流程：新建 xterm → 回放 scrollback → 若 !ptyAlive 发 spawn（cwd 取 session.cwd）→ attach
  unmount 流程：xterm.dispose()（PTY + buffer 不动，切回重放）
-->
<template>
  <div data-testid="terminal-view" class="flex h-full flex-col">
    <!-- 工具栏：clear / kill。2026-08-14 裁决遵循 v6-drawer-tabs-demo：跟随 drawer 深底、
         去 border-white/10（层级靠底色差不靠边框），按钮 neutral 配色（spec .tv-v6 的按钮规范）。 -->
    <div data-testid="terminal-toolbar" class="flex items-center gap-1 px-2 py-1">
      <Button
        variant="ghost"
        class="size-6 shrink-0 rounded-sm p-0 text-neutral-mid hover:text-neutral-fg"
        :title="t('panel.terminal.clear')"
        data-testid="terminal-btn-clear"
        @click="clear"
      >
        <Eraser class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        class="size-6 shrink-0 rounded-sm p-0 text-neutral-mid hover:text-neutral-fg"
        :class="state.ptyAlive ? '' : 'opacity-30'"
        :disabled="!state.ptyAlive"
        :title="t('panel.terminal.kill')"
        data-testid="terminal-btn-kill"
        @click="killTerminal"
      >
        <Square class="size-3.5" />
      </Button>
    </div>
    <!-- xterm 挂载点（relative 包裹浮动按钮）。纯黑圆角块嵌在 drawer 深底上
         （demo .terminal-mock：#000 + radius 8px + padding 12px）。 -->
    <div class="relative m-2 min-h-0 flex-1 rounded bg-black">
      <!-- RD-5#2：spawn 失败 inline 错误条（复用 FileView error 态范式：留痕 + 可重试）。
           PTY 起不来时不再静默显示空白终端——失败既可见也可行动；重试直接重发 spawn
           （retrySpawn），成功后错误条消失、PTY 输出经 flush 监听回放。 -->
      <div
        v-if="spawnError"
        class="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/90 p-4 text-center"
        data-testid="terminal-spawn-error"
      >
        <AlertCircle class="size-5 text-danger opacity-70" />
        <p class="text-[length:var(--text-2xs)] text-neutral-mid">{{ t('panel.terminal.spawnFailed', { error: spawnError }) }}</p>
        <Button
          variant="ghost"
          class="h-6 text-[length:var(--text-2xs)] text-accent"
          data-testid="terminal-spawn-retry"
          @click="retrySpawn"
        >
          {{ t('panel.terminal.retry') }}
        </Button>
      </div>
      <div data-testid="terminal-xterm" ref="xtermContainer" class="h-full p-3" />
      <!-- 选区浮动按钮（Phase 4 联动 1：选中输出 → 发给 AI） -->
      <Transition name="fade">
        <Button
          v-if="hasSelection"
          variant="ghost"
          data-testid="terminal-send-to-ai"
          class="absolute z-10 flex items-center gap-1 rounded-sm bg-accent px-2 py-1 text-xs text-accent-fg shadow-lg"
          :style="{ top: selectionPos.top + 'px', left: selectionPos.left + 'px' }"
          @click="sendSelectionToAI"
        >
          <MessageSquare class="size-3" />
          {{ t('panel.terminal.sendToAI') }}
        </Button>
      </Transition>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, toRef, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Eraser, Square, MessageSquare, AlertCircle } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { useTerminal, replayChunksBatched, type TerminalBuffer } from '@/composables/features/terminal/useTerminal'
import { useTerminalSpawnFeedback } from '@/composables/features/terminal/useTerminalSpawnFeedback'
import { resolveXtermFontOptions } from './terminal-xterm-options'
import { useSessionStore } from '@/stores/session'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'
import { getSettingsStore } from '@taiji/core'
import { darkTerminalTheme } from '@/composables/terminal/terminal-themes'

import '@xterm/xterm/css/xterm.css'

const props = defineProps<{ sessionId: string | null }>()

const { t } = useI18n()
const xtermContainer = ref<HTMLDivElement | null>(null)

const terminal = useTerminal(toRef(props, 'sessionId'))
const state = terminal.current
const composerInjection = composerInjectionStore
const settingsStore = getSettingsStore()

// Phase 4 联动 1：选区浮动按钮状态
const hasSelection = ref(false)
const selectionPos = ref({ top: 0, left: 0 })

// RD-5#2：spawn 失败态（PTY 起不来时显示 inline 错误条 + 重试，复用 FileView error 态范式）。
// 实现见 composables/features/terminal/useTerminalSpawnFeedback.ts。
const { spawnError, spawnWithFeedback, retrySpawn } = useTerminalSpawnFeedback(terminal, () => {
  const partition = state.value
  return { cwd: getSessionCwd(), cols: partition.cols, rows: partition.rows }
})

let xterm: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
// 版本回放指针（D-6.2）：本视图已回放 chunk 总数（= buffer.version 语义，单调），mount/切 session 归零
let replayedVersion = 0
// 本视图的 flush 监听反注册（mount 注册 / unmount 与切 session 反注册）
let unregisterFlush: (() => void) | null = null

// ── 回放分批写队列（Fix-5）：全量回放可达 5000 chunks × 4KB ≈ 20MB，拆批逐帧写；指针入队即推进 ──
let replayWriteQueue: string[] = []
let replayWriteScheduled = false

/** 消费一帧：写队列首批，非空则调度下一帧继续（rAF 链）。 */
function pumpReplayWrites(): void {
  replayWriteScheduled = false
  if (replayWriteQueue.length === 0) return
  if (!xterm) { replayWriteQueue.length = 0; return } // 视图销毁：丢挂起批次（重挂载全量重放）
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
 * 指针立即推进到 targetVersion，后续增量从新指针起算，不重叠不重复（重复回放不幂等——
 * xterm.write 追加语义，靠下方 clamped 清屏守卫保证不重复显示）。
 */
function replayFrom(fromVersion: number, buffer: TerminalBuffer): void {
  if (!xterm) return
  const result = replayChunksBatched(buffer, fromVersion)
  if (result === null) return
  if (result.clamped) { xterm.clear(); replayWriteQueue.length = 0 } // S-15：指针落后裁剪线钳 0 全量重放 → 先清屏+丢挂起批次再写，防屏上旧内容与全量重放重复（对齐 onFlushed 回退 clear 模式）
  replayedVersion = result.targetVersion
  enqueueReplayWrites(result.batches)
}

/** flush 监听回调：模块级 flush 完成后按本视图指针增量回放（替代 W14 的 watch 链）。 */
function onFlushed(buffer: TerminalBuffer): void {
  if (buffer.version < replayedVersion) {
    // version 单调只增，回退 = 被 clearPartition 重置（Fix-3）：清本视图 + 指针归零 + 丢挂起批次
    xterm?.clear()
    replayedVersion = 0
    replayWriteQueue.length = 0
  }
  replayFrom(replayedVersion, buffer)
}

/** 清屏（清 xterm + 当前分区 buffer，Fix-3：切走切回历史不复活）。 */
function clear(): void {
  xterm?.clear()
  terminal.clearTerminal()
}

/** 取 session cwd（spawn 用）。 */
function getSessionCwd(): string | undefined {
  if (!props.sessionId) return undefined
  const sessionStore = useSessionStore()
  return sessionStore.list.find((s) => s.id === props.sessionId)?.cwd
}

/** 初始化 xterm 实例 + addons。返回创建的 fitAddon（供调用方访问，绕过 TS 控制流不跨函数窄化）。 */
function initXterm(): FitAddon | null {
  if (!xtermContainer.value || xterm) return null

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

  term.open(xtermContainer.value)

  // 用户输入 → 写入 PTY
  term.onData((data) => {
    terminal.writeToTerminal(data)
  })

  // resize：fit 后通知 runtime PTY resize
  term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
    terminal.resizeTerminal(cols, rows)
  })

  // Phase 4 联动 1：选区变化 → 更新浮动按钮显隐 + 定位
  term.onSelectionChange(() => {
    // hasSelection() 布尔判定替代 getSelection() 全文拷贝（拖选每帧触发）；行为差异（已确认）：纯空白选区也显示按钮，点击后空文本早退
    if (term.hasSelection()) {
      const pos = term.getSelectionPosition()
      hasSelection.value = true
      // 估算浮动按钮位置（选区末行下方）。xterm 的 cell 尺寸约 fontSize * 0.6（宽）/ 1.2（高）
      // 粗略定位到选区结束位置右下方，精确度足够（不需像素级）。
      const cellHeight = 16 // ≈ fontSize 13 * 1.2 line-height
      const cellWidth = 8 // ≈ fontSize 13 * 0.6
      selectionPos.value = {
        top: (pos?.end.y ?? 0) * cellHeight + cellHeight,
        left: (pos?.end.x ?? 0) * cellWidth,
      }
    } else {
      hasSelection.value = false
    }
  })

  // 容器尺寸变化 → fit（闭包捕获局部 fit，绕过模块级 fitAddon 的控制流问题）
  resizeObserver = new ResizeObserver(() => {
    try {
      fit.fit()
    } catch (e) {
      // best-effort：fit 在容器未渲染时（尺寸为 0）会抛错，降级为不调整——下次 ResizeObserver 回调会重试
      console.debug('[terminal] fit skipped (container size 0)', e)
    }
  })
  resizeObserver.observe(xtermContainer.value)

  // 赋值到模块级（replayScrollback / dispose 用）。fit 不存模块级（用闭包/返回值传递）。
  xterm = term
  return fit
}

/** Phase 4 联动 1：选中文本 → 注入 composer「发给 AI」。 */
function sendSelectionToAI(): void {
  const text = xterm?.getSelection()
  if (!text) return
  composerInjection.requestInjection({
    target: 'current',
    text,
    sessionId: props.sessionId,
  })
  hasSelection.value = false
}

onMounted(async () => {
  if (!props.sessionId) return
  await nextTick()
  const fit = initXterm()
  if (!xterm || !fit) return

  // 全量回放模块级分区历史（切回 mount 场景：切走期间累积的输出在此补齐）
  replayFrom(0, terminal.current.value.buffer)
  // 注册 flush 监听：之后的输出经模块级订阅 → flush → 本监听增量回放
  // （先全量回放再注册：回放指针锚定到当前版本，增量不重复不遗漏）
  unregisterFlush = terminal.registerFlushListener(props.sessionId, onFlushed)

  // 若 PTY 未活，发 spawn
  const partition = state.value
  if (!partition.ptyAlive) {
    // RD-5#2：spawn 失败走 inline 错误条 + 重试（原 void 丢弃 → 裸 reject + 空白终端）；
    // 维度（cwd/cols/rows）由 useTerminalSpawnFeedback 的 resolveDims 惰取
    spawnWithFeedback()
  }
  terminal.attachTerminal()

  // 初次 fit（容器尺寸稳定后）
  try {
    fit.fit()
  } catch (e) {
    // best-effort：mount 瞬间容器尺寸为 0 时 fit 抛错，ResizeObserver 后续回调会补偿
    console.debug('[terminal] initial fit skipped (container size 0)', e)
  }
})

onBeforeUnmount(() => {
  unregisterFlush?.()
  unregisterFlush = null
  resizeObserver?.disconnect()
  resizeObserver = null
  xterm?.dispose()
  xterm = null
  fitAddon = null
  replayedVersion = 0
  // 丢弃挂起回放批次（Fix-5：防旧会话内容写入重挂载后的新 xterm）
  replayWriteQueue.length = 0
})

// Settings → Terminal 配置变化（字体/字号/scrollback/cursorStyle）：动态应用到已挂载的 xterm。
// mount 时若 config 尚未加载（null），会用默认值 init；config 广播到达后此处补偿更新。
watch(
  () => settingsStore.terminalConfig.value,
  () => {
    if (!xterm) return
    const opts = resolveXtermFontOptions(settingsStore.terminalConfig.value?.config)
    xterm.options.fontSize = opts.fontSize
    xterm.options.fontFamily = opts.fontFamily
    xterm.options.scrollback = opts.scrollback
    xterm.options.cursorStyle = opts.cursorStyle
    // 字号/字体变化后 cell 尺寸变，需重新 fit 同步 PTY resize
    try {
      fitAddon?.fit()
    } catch (e) {
      // best-effort：config 变化时容器若未渲染（如 tab 不可见）fit 抛错，降级为不调整——下次可见时 ResizeObserver 补偿
      console.debug('[terminal] refit skipped after config change', e)
    }
  },
)

// sessionId 变化（切 session）：重新 init xterm + 回放新分区 + spawn（若需要）
watch(
  () => props.sessionId,
  async (sid) => {
    if (!sid) return
    // 切 session 视为重新挂载：反注册旧监听 + dispose 旧 xterm，重 init
    unregisterFlush?.()
    unregisterFlush = null
    resizeObserver?.disconnect()
    xterm?.dispose()
    xterm = null
    fitAddon = null
    replayedVersion = 0
    replayWriteQueue.length = 0
    await nextTick()
    const fit2 = initXterm()
    if (!xterm || !fit2) return
    replayFrom(0, terminal.current.value.buffer)
    unregisterFlush = terminal.registerFlushListener(sid, onFlushed)
    const partition = state.value
    if (!partition.ptyAlive) {
      // RD-5#2：spawn 失败走 inline 错误条 + 重试（维度由 resolveDims 惰取）
      spawnWithFeedback()
    }
    terminal.attachTerminal()
    try {
      fit2.fit()
    } catch (e) {
      // best-effort：session 切换瞬间容器尺寸为 0 时 fit 抛错，ResizeObserver 后续回调会补偿
      console.debug('[terminal] refit skipped (container size 0)', e)
    }
  },
)

const { killTerminal } = terminal
</script>

<style scoped>
/* escape hatch：Vue Transition 类（Tailwind 无法表达），浮动按钮淡入淡出 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--duration-fast) var(--ease);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
