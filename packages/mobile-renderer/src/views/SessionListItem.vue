<script setup lang="ts">
// SessionListItem —— 移动会话列表行条目（u13/A5：自 MobileSessionList.vue 内联行模板机械拆出，
// MobileSessionList 消费本组件渲染等价）。纯渲染组件，数据经 props 传入，无 app-runtime 依赖。
//
// 渲染 SessionSummary 自带字段：label + 状态点/状态文案 + 时间 + 模型/思考档只读标签
// （A5：modelId/thinkingLevel 数据已在 SessionSummary，移动补渲染——V11 与桌面设置一致；
// thinkingLevel 显示原始值，移动壳无 models 列表消费面，不做 id→展示名映射）。
// 状态点 = 派生态（remote-use A14/U20）：derivedStatus prop 由 MobileSessionList 经 core
// deriveSessionStatus 按参数化输入计算（occupancy + subagent 运行态 + meta；blockingOverlay
// 移动恒 false，D9③ 白名单）——与桌面侧栏同源 9 态，替代原 SessionStatus 6 态直渲染。
// dead 是进程态非对话派生态（9 态词表无 dead）：保留红点 + 「已退出」特判（A3 dead 分流的
// 视觉锚；桌面同场景 = 行级置灰表达，移动以点色/文案承载）。判据归 core 谓词，本组件的
// 9 态色/文案映射是展示层（CSS 类属各壳自持，同桌面 DOT_CLASS/STATUS_ICON 分工）。
// 列表排序/长按菜单/恢复编排不归本组件（u12/u20）。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DerivedStatus } from '@taiji/core'
import type { SessionSummary } from '@taiji/shared'

const props = defineProps<{ item: SessionSummary; active: boolean; derivedStatus: DerivedStatus }>()

const emit = defineEmits<{
  (e: 'open', sessionId: string): void
}>()

const { t } = useI18n()

/** 派生 9 态 → 状态点语义色（对齐桌面 DOT_CLASS 色语言：accent 运行族 / warn 等待族 / success 完成 / danger 出错） */
const DERIVED_DOT_CLASS: Record<DerivedStatus, string> = {
  streaming: 'bg-accent',
  pending: 'bg-accent',
  compacting: 'bg-accent',
  working: 'bg-accent',
  waiting: 'bg-warn',
  retrying: 'bg-warn',
  done: 'bg-success',
  stopped: 'bg-neutral-dim opacity-50',
  error: 'bg-danger',
}

/** dead 进程态优先于派生态（判据 = meta 真态，与 store.applySnapshot 的 dead 保护同语义） */
const isDead = computed(() => props.item.status === 'dead')

const dotClass = computed(() =>
  isDead.value ? 'bg-danger' : DERIVED_DOT_CLASS[props.derivedStatus],
)

const statusText = computed(() =>
  isDead.value
    ? t('mobile.sessionList.status.dead')
    : t(`mobile.sessionList.status.${props.derivedStatus}`),
)

/** 时间数字位数（HH:mm 两位补零；taste-lint no-magic-numbers ignore 仅 [0,1,-1]，2 须具名） */
const TIME_PAD_WIDTH = 2

/** 列表时间：今天显 HH:mm，更早显 M/D（无新增文案 key） */
function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    const hh = String(d.getHours()).padStart(TIME_PAD_WIDTH, '0')
    const mm = String(d.getMinutes()).padStart(TIME_PAD_WIDTH, '0')
    return `${hh}:${mm}`
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 模型/思考档只读标签（A5）：modelId 必有；thinkingLevel 可选，有值以「 · 」分隔 */
const modelLine = computed(() =>
  props.item.thinkingLevel ? `${props.item.modelId} · ${props.item.thinkingLevel}` : props.item.modelId,
)

function onOpen(): void {
  emit('open', props.item.id)
}
</script>

<template>
  <li>
    <!-- role="button" 条目（原生 button 由 vue_rules_checker 拦；ui Button 形态不符列表条目，先例 = CompanionBand role="radio" 条目） -->
    <div
      role="button"
      tabindex="0"
      class="flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent"
      :class="active ? 'bg-accent-soft' : 'active:bg-surface-hover'"
      :data-testid="`mobile-session-item-${item.id}`"
      @click="onOpen"
      @keydown.enter="onOpen"
    >
      <div class="flex w-full items-center gap-2">
        <span class="size-2 shrink-0 rounded-full" :class="dotClass" />
        <span class="min-w-0 flex-1 truncate text-sm text-neutral-fg">{{ item.label }}</span>
        <span class="shrink-0 text-xs text-neutral-dim">{{ statusText }}</span>
        <span class="shrink-0 text-xs text-neutral-dim">{{ formatTime(item.lastActiveAt) }}</span>
      </div>
      <!-- testid 不用 mobile-session-item- 前缀：该前缀是行根 testid 命名空间
          （列表测试按 `^=` 前缀遍历行），副行撞前缀会污染行遍历断言 -->
      <span data-testid="mobile-session-model-line" class="w-full truncate text-xs text-neutral-dim">
        {{ modelLine }}
      </span>
    </div>
  </li>
</template>
