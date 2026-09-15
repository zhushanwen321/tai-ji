<template>
  <!--
    容器组件 · Overview（overview/spec.md，L1 独立 Region · 多会话鸟瞰）。
    激活时覆盖整个 workspace（main）区，sidebar 持久（ADR-0023）。
    取向 = 统筹/监控（网格、信息密集），区别于 Session List 的导航/切换。

    v1 范围（spec §8.5）：卡片网格骨架 + 进入（sidebar 按钮，FG3 已建）+ 基本退出。
    退出：Esc → navigation.back()（canBack 守卫，历史栈空则 no-op）；
         点卡片 → selectSession(id) 载入该 session 回 chat view。
    DEFERRED（spec §9）：卡片筛选/排序/批量操作（工具栏只留新建 + 计数）；
         ⌘⇧O 切换快捷键（G3-003 v1 不做）；后台 agent 进度聚合（flow-3）。
  -->
  <div class="overview flex h-full w-full flex-col overflow-hidden p-6">
    <!-- 工具栏：标题 + 计数 + 新建（筛选/排序 DEFERRED 不渲染入口，G3-002 hide） -->
    <header class="mb-3.5 flex items-center gap-2.5">
      <h1 class="text-[18px] font-semibold tracking-tight text-neutral-fg">{{ t('overview.title') }}</h1>
      <span class="rounded-full bg-surface px-2 py-0.5 font-mono text-[11px] text-neutral-mid">
        {{ t('overview.sessionCount', { count: session.list.length }) }}
      </span>
      <Button
        variant="ghost"
        size="sm"
        class="ml-auto gap-1.5 text-[12px] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
        @click="onNew"
      >
        <Plus class="size-[15px] text-neutral-dim" />
        <span>{{ t('overview.newSession') }}</span>
        <kbd class="rounded-sm border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-[10px] text-neutral-dim">{{ formatKbd('n') }}</kbd>
      </Button>
    </header>

    <!-- 卡片网格：响应式 3/2/1 列（draft-overview §布局）。
         v1 用 CSS grid auto-fill + minmax 让列数随视口自适应，无需媒体查询断点。 -->
    <ScrollArea class="min-h-0 flex-1">
      <div v-if="session.list.length" class="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 pb-4">
        <SessionCard
          v-for="s in session.list"
          :key="s.id"
          :session="s"
          :active="s.id === focusedSessionId"
          :status="statusOf(s.id)"
          :summary="digestOf(s.id).summary"
          :turn-count="digestOf(s.id).turnCount"
          @open="onOpen"
        />
      </div>

      <!-- 空状态（session=0，design-system §7：图标 + 一句说明 + Primary 入口） -->
      <div
        v-else
        class="flex flex-col items-center justify-center gap-3.5 rounded-lg border border-dashed border-border-strong p-14 text-center"
      >
        <LayoutGrid class="size-9 text-neutral-dim" />
        <p class="text-[15px] text-neutral-mid">{{ t('overview.emptyTitle') }}</p>
        <Button class="gap-1.5 text-[13px] font-semibold" @click="onNew">
          <Plus class="size-[14px]" />
          {{ t('overview.emptyHint') }}
        </Button>
      </div>
    </ScrollArea>
  </div>
</template>

<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { Plus, LayoutGrid } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useNavigationStore } from '@/stores/navigation'
import { useSessionStore } from '@/stores/session'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { useSessionDerivations } from '@/composables/features/chat/useSessionDerivations'
import { usePlatformShortcut } from '@/composables/usePlatformShortcut'
import SessionCard from './SessionCard.vue'

const { t } = useI18n()
const { formatKbd } = usePlatformShortcut()
const navigation = useNavigationStore()
const session = useSessionStore()
const { selectSession, newSession, focusedSessionId } = useSidebar()
const { derivedStatus, sessionDigest } = useSessionDerivations()

/** 状态点派生（D6）：features 层读 chat+session store 派生 5 态 */
function statusOf(id: string) {
  return derivedStatus(id).value
}

/** 鸟瞰摘要派生（末条 assistant 文本 + 回合计数） */
function digestOf(id: string) {
  return sessionDigest(id).value
}

/** 点卡片载入 session 回 chat view（ADR-0023 退出路径之一） */
async function onOpen(id: string): Promise<void> {
  await selectSession(id)
}

/** 新建会话（工具栏 Primary / 空态入口） */
async function onNew(): Promise<void> {
  await newSession()
}

/**
 * Esc 基本退出（spec §8.5 v1 必做）：回到上一个 chat view。
 * canBack 守卫——历史栈空（如冷启动直接进 Overview）则 no-op，避免 back 越界。
 * ⌘⇧O 切换快捷键 DEFERRED（G3-003），v1 不绑。
 */
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return
  if (navigation.current.view !== 'overview') return
  if (!navigation.canBack) return
  e.preventDefault()
  navigation.back()
})
</script>


