<!--
  TerminalView —— drawer 集成终端的交互式渲染组件（Phase 3 / 多实例 u2）。

  基于 xterm.js + addons（fit/web-links/search/unicode11），接收 sessionId prop。
  生命周期解耦（见 useTerminal / useTerminalXterm 注释）：本组件只编排查表与交互，
  xterm 视图在 useTerminalXterm，PTY + per-instance scrollback 在 useTerminal。

  多实例（terminal-multi-instance 设计 §3.1 / §3.3）：
  - 头部一行（三卡化 2026-10-04）：实例切换条（TerminalInstanceBar）= tab 条 + 右簇
    （「+」新建 / 收起按钮）；原第二行工具栏（清屏/终止）随 head 一行化删除——终止与
    tab 关闭叉同义，清屏功能随之移除（用户裁决）；
  - 收起按钮 = 收起整个终端区（toggleBottomDrawer，收起语义非销毁——实例保留，重开走
    对账恢复），收起后焦点回 composer（§6.7 焦点契约，与 TerminalToggleButton 同款）；
  - 挂载与切 session（会话激活 / ⌘R 界面刷新腿）：`terminal.list` 对账；成功空清单且是
    本会话首开 → 自动新建默认实例（存量会话「行为与改造前一致」）；**拉取失败不自动新建**
    （否则与后台存活实例撞号并存），保留既有条目、下次触发自然重试；
  - 焦点规则：切换实例后焦点落新显示实例输入区；**点「+」新建后自动切到新实例并聚焦其输入区**
    （2026-10-04 用户裁决：点「+」是显式用户意图）；关闭实例后焦点落其右侧相邻（无右取左，
    active 落位在注册表层），首挂载不主动夺焦；
  - 新建失败：「+」走全局错误通道（toast）；挂载自动新建走 inline 错误条 + 重试。
-->
<template>
  <div data-testid="terminal-view" class="flex h-full flex-col">
    <!-- 头部一行：实例切换条 + 右簇（+/收起）；空态占位与「+」引导由 u3-bar 组件内建 -->
    <TerminalInstanceBar
      :instances="instances"
      :active-terminal-id="activeTerminalId"
      @select="onSelect"
      @create="onCreate"
      @close="onClose"
      @collapse="onCollapseDrawer"
    />
    <!-- xterm 挂载点（relative 包裹浮动按钮）。纯黑圆角块嵌在卡片 surface 上；
         空态（实例 0）时容器透明——黑块仅在有实例时呈现，空态不再悬无内容黑区。 -->
    <div class="relative m-2 min-h-0 flex-1 rounded" :class="instances.length > 0 ? 'bg-black' : ''">
      <!-- RD-5#2：spawn 失败 inline 错误条（挂载自动新建腿；复用 FileView error 态范式） -->
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
import { MessageSquare, AlertCircle } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import TerminalInstanceBar from '@/components/panel/TerminalInstanceBar.vue'
import { useTerminal } from '@/composables/features/terminal/useTerminal'
import { useTerminalXterm } from '@/composables/features/terminal/useTerminalXterm'
import { useTerminalSpawnFeedback } from '@/composables/features/terminal/useTerminalSpawnFeedback'
import { useSessionStore } from '@/stores/session'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'
import { toggleBottomDrawer } from '@taiji/core/domain/bottom-drawer'
import { focusComposer } from '@/composables/features/app/key-orchestrator'

const props = defineProps<{ sessionId: string | null }>()

const { t } = useI18n()
const xtermContainer = ref<HTMLDivElement | null>(null)

const terminal = useTerminal(toRef(props, 'sessionId'))
const state = terminal.current
const instances = terminal.instances
const activeTerminalId = terminal.activeTerminalId
const composerInjection = composerInjectionStore

/** 取 session cwd（spawn 用）。 */
function getSessionCwd(): string | undefined {
  if (!props.sessionId) return undefined
  const sessionStore = useSessionStore()
  return sessionStore.list.find((s) => s.id === props.sessionId)?.cwd
}

/** spawn 维度惰取（首 spawn / 重试 / 「+」新建同源）。 */
function resolveDims() {
  const partition = state.value
  return { cwd: getSessionCwd(), cols: partition.cols, rows: partition.rows }
}

// RD-5#2：挂载自动新建失败 → inline 错误条；「+」手动新建失败 → 全局错误通道（toast）。
const { spawnError, spawnWithFeedback, retrySpawn, createWithToast } = useTerminalSpawnFeedback(
  terminal,
  resolveDims,
)

// xterm 视图生命周期（多实例：切换实例重建 + 回放目标实例分区；焦点落当前实例输入区）。
const view = useTerminalXterm({
  container: xtermContainer,
  terminal,
  activeTerminalId,
  resolveDims,
  onData: (data) => terminal.writeToTerminal(data),
})
const hasSelection = view.hasSelection
const selectionPos = view.selectionPos

/**
 * 交互门：首轮激活（挂载轮 / 挂载后经 loadSession 绑上会话轮，两腿同语义）不主动夺焦
 * （保持改造前「开面板不夺焦」体感，设计目标 5）；激活轮结束后由用户手势触发的
 * 切换 / 关闭 / 守卫迁焦才按焦点规则落焦。
 * 置位时序：见 activateSessionRound——轮内 await 完 spawn（含其后的 nextTick 屏障）才置 true，
 * 使 ack 建档引起的 active 变化 watcher 先于置位消费，不被误判为「用户切换」。
 * 两腿都须置位：面板可能先以 sessionId=null 挂载（stores/panel.ts initialLeaf）、随后
 * loadSession 绑上会话——只在 onMounted 置位会让该路径的交互门永不打开，§3.3 焦点规则
 * （切换落新实例 / 关闭落相邻）整体落空。
 */
let interactive = false

/**
 * 「+」新建（u3-bar create）：失败经全局错误通道提示，不出现新条目、不影响既有实例。
 * 成功后**自动把当前显示实例切到新实例并聚焦其输入区**（2026-10-04 产品裁决：点「+」是
 * 用户显式意图，与「首挂载不夺焦」不冲突）。自动切换只走本路径显式 select——`terminal.list`
 * 对账路径不抢 active（见 terminal-instance-registry.registerInstance 注释）。
 */
async function onCreate(): Promise<void> {
  const terminalId = await createWithToast()
  if (terminalId === null) return
  terminal.selectInstance(terminalId)
  // 显式同步视图 + 落焦：空态（active 本为 null）时 registerInstance 已把 active 置为新实例，
  // 再 select 同值不会触发 active watcher，须在此直接复现「切换实例」的视图重建 + 焦点语义。
  view.syncView()
  view.focus()
}

/** 切换当前显示实例（u3-bar select）——焦点由 active 变化 watcher 落新实例输入区。 */
function onSelect(terminalId: string): void {
  terminal.selectInstance(terminalId)
}

/** 关闭实例（u3-bar close，最后实例按钮禁用态由组件保证）——焦点落右侧相邻（无右取左）。 */
function onClose(terminalId: string): void {
  terminal.closeInstance(terminalId)
}

/**
 * 收起整个终端区（u3-bar collapse，三卡化 2026-10-04）：收起语义非销毁——实例保留，
 * 重开走 terminal.list 对账恢复。本组件只在底抽屉展开态挂载，toggle 即收起；
 * 焦点回 composer（§6.7 契约，与 TerminalToggleButton 关闭分支同款）。
 */
function onCollapseDrawer(): void {
  toggleBottomDrawer()
  focusComposer()
}

/** Phase 4 联动 1：选中文本 → 注入 composer「发给 AI」。 */
function sendSelectionToAI(): void {
  const text = view.getSelection()
  if (!text) return
  composerInjection.requestInjection({
    target: 'current',
    text,
    sessionId: props.sessionId,
  })
  view.dismissSelection()
}

/**
 * 会话激活腿（挂载 / 切 session）：`terminal.list` 对账；成功空清单 → 自动新建默认实例。
 * 拉取失败不自动新建（保留既有条目、下次触发重试，设计 §3.3 触发点分腿语义）。
 */
async function activateSession(): Promise<void> {
  const result = await terminal.reconcileInstances()
  // await 落定：激活轮内 ack 建档引起的 active 变化不被误判为「用户切换」（见 interactive 注释）
  if (result.ok && result.count === 0) await spawnWithFeedback()
  view.syncView()
}

/**
 * 激活轮收口（挂载轮 / 挂载后绑定会话轮共用）：对账 → 必要时自动新建（含 ack 建档落位）→
 * 同步视图，**轮末才开放交互门**。置位判据 = 「该会话的实例集合已落定（ack 建档、可写）」——
 * 此后由用户手势触发的 active 变化（切换 / 关闭 / 守卫迁焦）才按焦点规则落焦。
 */
async function activateSessionRound(): Promise<void> {
  await nextTick()
  await activateSession()
  await nextTick()
  interactive = true
}

onMounted(async () => {
  if (!props.sessionId) return
  await activateSessionRound()
})

onBeforeUnmount(() => {
  view.dispose()
})

// 当前显示实例变化（切换 / 新建 / 关闭 / 世代重置）：同步视图 + 焦点规则（首挂载不夺焦）。
watch(activeTerminalId, () => {
  view.syncView()
  if (interactive) view.focus()
})

// sessionId 变化（切 session）：重新对账 + 回放新会话当前实例分区。
watch(
  () => props.sessionId,
  async (sid) => {
    if (!sid) return
    // 挂载后绑定会话腿（sessionId=null → loadSession 绑上）：与挂载轮同语义收口，
    // 轮末开放交互门，否则该路径交互门永不置位（见 interactive 注释）。
    await activateSessionRound()
  },
)
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
