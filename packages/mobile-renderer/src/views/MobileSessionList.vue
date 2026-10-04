<script setup lang="ts">
// MobileSessionList —— 移动壳会话列表（core createSessionStore/createUseSession 驱动，D7 列表行）。
//
// 数据源：app-runtime 的 sessionList（groups 扁平派生，lastActiveAt 倒序）+ listLoadError
// （core loadSessions 错误落 store，点击重试走同一入口）。运行中状态可见（status 点 + 文案）。
// 点击条目 → core selectSession（12 步切入链 headless 形态：switch RPC → hydrate → 激活）→
// 上抛 open-chat 切到聊天视图。新建入口「+」上抛 new-task（表单由 App 挂载）。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus } from '@lucide/vue'
import { Button } from '@taiji/ui'
import type { SessionStatus, SessionSummary } from '@taiji/shared'
import { loadSessions, selectSession, sessionList, sessionStore } from '../shell/app-runtime'

const emit = defineEmits<{
  (e: 'new-task'): void
  (e: 'open-chat', sessionId: string): void
}>()

const { t } = useI18n()

const loadError = computed(() => sessionStore.listLoadError.value)
const activeId = computed(() => sessionStore.activeId.value)

/** 列表条目：lastActiveAt 倒序（最近活跃在前） */
const items = computed<SessionSummary[]>(() =>
  [...sessionList.value].sort((a, b) => b.lastActiveAt - a.lastActiveAt),
)

const STATUS_DOT_CLASS: Record<SessionStatus, string> = {
  active: 'bg-accent',
  idle: 'bg-neutral-dim',
  dead: 'bg-danger',
  done: 'bg-neutral-mid',
  error: 'bg-danger',
  stopped: 'bg-neutral-mid',
}

function statusLabel(status: SessionStatus): string {
  return t(`mobile.sessionList.status.${status}`)
}

/** 时间数字位数（HH:mm 两位补零） */
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

async function onOpen(item: SessionSummary): Promise<void> {
  await selectSession(item.id)
  emit('open-chat', item.id)
}

function onRetry(): void {
  void loadSessions()
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="mobile-session-list">
    <div class="flex shrink-0 items-center justify-between px-3 py-2">
      <span class="text-sm font-medium text-neutral-fg">{{ t('mobile.tabs.sessions') }}</span>
      <Button
        variant="ghost"
        size="icon"
        data-testid="mobile-new-task"
        :aria-label="t('mobile.sessionList.newTask')"
        :title="t('mobile.sessionList.newTask')"
        @click="emit('new-task')"
      >
        <Plus class="size-5" />
      </Button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <p
        v-if="loadError"
        data-testid="mobile-session-list-error"
        class="cursor-pointer rounded px-2 py-3 text-sm text-danger"
        role="alert"
        @click="onRetry"
      >
        {{ loadError ?? t('mobile.sessionList.loadFailed') }}
      </p>
      <p v-else-if="items.length === 0" class="px-2 py-6 text-center text-sm text-neutral-dim" data-testid="mobile-session-list-empty">
        {{ t('mobile.sessionList.empty') }}
      </p>
      <ul v-else class="flex flex-col gap-1">
        <li v-for="item in items" :key="item.id">
          <!-- role="button" 条目（原生 button 由 vue_rules_checker 拦；ui Button 形态不符列表条目，先例 = CompanionBand role="radio" 条目） -->
          <div
            role="button"
            tabindex="0"
            class="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent"
            :class="item.id === activeId ? 'bg-accent-soft' : 'active:bg-surface-hover'"
            :data-testid="`mobile-session-item-${item.id}`"
            @click="onOpen(item)"
            @keydown.enter="onOpen(item)"
          >
            <span class="size-2 shrink-0 rounded-full" :class="STATUS_DOT_CLASS[item.status]" />
            <span class="min-w-0 flex-1 truncate text-sm text-neutral-fg">{{ item.label }}</span>
            <span class="shrink-0 text-xs text-neutral-dim">{{ statusLabel(item.status) }}</span>
            <span class="shrink-0 text-xs text-neutral-dim">{{ formatTime(item.lastActiveAt) }}</span>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
