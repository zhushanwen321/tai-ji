<!--
  警示组件 · turn 超时警示条（warn 告警条，remove-turn-progress-bar 设计 §2.2）。
  前身 = session-dead V5② 常驻观测条；warn 化后组件名/文件名/testid（turn-progress-bar）
  沿用未还名——命名语义错位为已接受代价（头注回写缓解误用；重审条件 = 本组件下次
  功能性改动时一并还名）。

  渲染条件 = snapshot && snapshot.warn（常态零 DOM 占用）：仅当本 turn 活跃且超阈值
  （10min，TURN_PROGRESS_WARN_THRESHOLD_MS，P-3 实测定值纪律）且未被豁免/抑制时出现。
  warn 态内容 = Clock 警示色 +「本 turn 已 N 分钟」+ 中性操作项（D7：不预置推荐，两个
  动作同权重）——「中止此 turn」emit abort 由父组件接既有 abort 链路（Panel.vue
  onProgressAbort → useChat.abort），本组件不直接触 RPC；「继续等待」= snoozeWarn
  （本 turn 内抑制警示，bar 随之消失，用户仍可经 Composer stop 中止）。

  ask_user 豁免（D6）：等待用户输入期间 core 侧抑制 warn（超阈值也不渲染，豁免是 warn
  计算输入而非渲染后隐藏）；awaitingUser 分型文案已删除——「为何 turn 不动」的解释价值
  由 AskUserOverlay 在屏承接。

  数据源 = core useTurnProgress（chat store 既有事件流投影纯本地派生，零协议改动）：
  turn 结束（agent_settled → occupancy idle）snapshot 归 null → v-if 自动消失；
  纯本地派生无持久化，reload 后天然无残留。

  文案纪律（D7）：只陈述事实，禁止判断词（卡死/无响应/异常）——i18n key 见
  locales/*/sidebar.ts turnProgress 段，文案断言测试锁定。
-->
<template>
  <div
    v-if="snapshot && snapshot.warn"
    data-testid="turn-progress-bar"
    class="mb-1.5 flex items-center gap-2 rounded-md border border-warn/35 bg-warn-soft px-3 py-1.5 text-[length:var(--text-xs)] text-neutral-fg"
  >
    <Clock class="size-3 shrink-0 text-warn" />
    <span data-testid="turn-progress-elapsed" class="font-medium">{{ t('sidebar.turnProgress.turnElapsed', { duration: formatDuration(snapshot.turnElapsedMs) }) }}</span>
    <span class="flex-1" />
    <Button variant="secondary" size="dense" data-testid="turn-progress-abort" @click="emit('abort')">
      {{ t('sidebar.turnProgress.abortTurn') }}
    </Button>
    <Button variant="secondary" size="dense" data-testid="turn-progress-keep-waiting" @click="snoozeWarn()">
      {{ t('sidebar.turnProgress.keepWaiting') }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clock } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useTurnProgress } from '@xyz-agent/core'
import { useChatStore } from '@/stores/chat'
import { useExtensionUIStore } from '@/stores/extension-ui'

const props = defineProps<{
  sessionId: string | null
}>()

const emit = defineEmits<{
  abort: []
}>()

const { t } = useI18n()
const chatStore = useChatStore()
// ask_user 豁免信号（D6）：extensionUIStore pending SSOT 的非响应式 getter（与
// deriveStatus 同模式）——每秒 tick 轮询，信号出现后 ≤1 tick 抑制 warn（bar 不渲染）。
const extensionUIStore = useExtensionUIStore()

const { snapshot, snoozeWarn } = useTurnProgress(
  computed(() => props.sessionId),
  chatStore,
  { getAwaitingUser: (sid) => extensionUIStore.hasPendingAskUser(sid) },
)

/** 时长换算常量（no-magic-numbers：展示粒度分/时的进率单一声明处）。 */
const MS_PER_MINUTE = 60_000
const MINUTES_PER_HOUR = 60

/**
 * 时长格式化：分钟 → 小时+分（i18n 模板承载单位措辞，双语结构差异不进逻辑）。
 * 两分支正确性前提 = TURN_PROGRESS_WARN_THRESHOLD_MS ≥ 60s，P-3 重定值跌破时须恢复秒分支
 * （设计 §2.4 round-2 S3：阈值在 core 包、formatter 在 renderer 包，跨包耦合无机器守卫）。
 */
function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / MS_PER_MINUTE)
  if (totalMin < MINUTES_PER_HOUR) return t('sidebar.turnProgress.durationMin', { min: totalMin })
  return t('sidebar.turnProgress.durationHourMin', { h: Math.floor(totalMin / MINUTES_PER_HOUR), min: totalMin % MINUTES_PER_HOUR })
}
</script>
