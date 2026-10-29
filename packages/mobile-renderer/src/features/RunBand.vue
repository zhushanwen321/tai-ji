<script setup lang="ts">
// RunBand —— 移动壳子代理运行带（remote-use-mobile-v2 §7.3 M-10 升级：v1 SubagentStatusLine
// 只读一行 → 运行带可点入 SubagentSheet 两级面板）。
//
// 数据源 = shell/subagent-records 的 per-session 分区（bootstrap effects.onSubagents 直挂
// 写入，ADR-0049 Map 分区范式）经 runningSubagentRecordsOf 读口——单数据源消费，禁第二
// 副本分区。
// 占用判据 = running 且无 stopReason（镜像桌面 isRunningProjection SSOT 口径，读口内聚）。
//
// 交互：无运行中子代理不渲染不占位；计数 > 0 显示运行带，点击 → openSheet('subagentList')
// （sheet-manager 单槽互斥，§6.13）。运行中 bash 的停止入口不在此——那是 ChatView 工具行
// 的 ToolRow 停止按钮（deps.abortBash 接线，M-8），与本带无关。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from '@lucide/vue'
import { runningSubagentRecordsOf } from '../shell/subagent-records'
import { openSheet } from '../shell/sheet-manager'

const props = defineProps<{ sessionId: string }>()

const { t } = useI18n()

const runningCount = computed(() => runningSubagentRecordsOf(props.sessionId).length)
</script>

<template>
  <!-- 运行带（§5.1 步骤 6「运行带计数」形态；无运行中子代理结构性不渲染）：
       role=button 条目（原生 button 由 vue_rules_checker 拦，先例 = QueueStrip 行） -->
  <div
    v-if="runningCount > 0"
    role="button"
    tabindex="0"
    class="flex shrink-0 cursor-pointer items-center gap-1.5 border-b border-[var(--border)] px-3 py-2 text-xs text-neutral-mid outline-none active:bg-bg-input focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
    data-testid="mobile-run-band"
    :aria-label="t('mobile.runBand.open', { count: runningCount })"
    @click="openSheet('subagentList')"
    @keydown.enter="openSheet('subagentList')"
  >
    <span class="relative flex size-2 shrink-0" aria-hidden="true">
      <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
      <span class="relative inline-flex size-2 rounded-full bg-accent" />
    </span>
    <span class="min-w-0 flex-1 truncate" data-testid="mobile-run-band-count">
      {{ t('mobile.runBand.running', { count: runningCount }) }}
    </span>
    <ChevronRight class="size-3.5 shrink-0 text-neutral-mid" aria-hidden="true" />
  </div>
</template>
