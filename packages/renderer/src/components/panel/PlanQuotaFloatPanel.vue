<template>
  <!--
    套餐浮层（plan-quota-float）：对话流左侧，展示全部 quota.enabled provider 的
    三窗口用量。收起条件由宿主单点判定（trace 激活 / 文件 drawer 打开 / 用户手动，
    collapsed prop 收敛三者），本组件只渲染两态 + 上报手动切换；内容让位（gutter）
    由宿主 panelStyle 联动，本组件不挤压消息列。
  -->
  <section
    v-if="entries.length > 0"
    class="absolute top-3 z-30 overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface/95 shadow-lg backdrop-blur-sm transition-[width] duration-[260ms]"
    :style="floatStyle"
    data-testid="plan-quota-float"
    :aria-label="t('panel.quotaFloat.title')"
  >
    <!-- 展开态：标题行 + 套餐清单（宽度定宽防内容随收起动画回流） -->
    <div
      v-show="!collapsed"
      class="max-h-[calc(100%-12px)] overflow-y-auto p-3"
      :style="{ width: `${QUOTA_FLOAT_WIDTH_EXPANDED}px` }"
      data-testid="plan-quota-body"
    >
      <div class="mb-2 flex items-center gap-1.5">
        <Zap class="size-3.5 shrink-0 text-neutral-dim" aria-hidden="true" />
        <span class="flex-1 text-[length:var(--text-sm)] font-medium text-neutral-fg">{{ t('panel.quotaFloat.title') }}</span>
        <Button
          variant="ghost"
          size="icon"
          class="size-7 rounded-[var(--radius-sm)] text-neutral-dim hover:text-neutral-fg"
          :aria-label="t('panel.quotaFloat.collapse')"
          data-testid="plan-quota-collapse"
          @click="emit('update:userCollapsed', true)"
        >
          <ChevronsLeft class="size-3.5" aria-hidden="true" />
        </Button>
      </div>
      <div class="flex flex-col">
        <PlanQuotaItem
          v-for="(entry, idx) in entries"
          :key="entry.providerId"
          :provider-id="entry.providerId"
          :label="entry.label"
          :current="entry.providerId === currentProviderId"
          :class="idx > 0 ? 'mt-2 border-t border-border pt-2' : ''"
        />
      </div>
    </div>
    <!-- 收起态：左侧竖排把手，点击恢复展开 -->
    <Button
      v-show="collapsed"
      variant="ghost"
      class="h-auto max-h-[calc(100%-12px)] flex-col gap-2 rounded-none py-2 text-neutral-dim hover:text-neutral-fg"
      :style="{ width: `${QUOTA_FLOAT_WIDTH_COLLAPSED}px` }"
      :aria-label="t('panel.quotaFloat.expand')"
      data-testid="plan-quota-rail"
      @click="emit('update:userCollapsed', false)"
    >
      <ChevronsRight class="size-3.5 shrink-0" aria-hidden="true" />
      <span class="text-xs tracking-[0.2em] [writing-mode:vertical-rl]">{{ t('panel.quotaFloat.title') }}</span>
    </Button>
  </section>
</template>

<script setup lang="ts">
/**
 * PlanQuotaFloatPanel —— 对话流左侧套餐浮层。
 *
 * 展示全部 quota.enabled provider 的三窗口用量，数据通道复用 coding-plan quota
 * 基建（quota store + useQuotaQuery），不新建通道。「当前」标记 = 当前会话生效模型
 * （session store 的 per-session modelId）的 provider 段命中的清单项。
 *
 * 受控组件：收起状态由宿主 Panel 单点持有（collapsed prop 收敛 trace 激活 / drawer
 * 打开 / 用户手动三个来源），本组件仅上报手动切换（update:userCollapsed）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronsLeft, ChevronsRight, Zap } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import PlanQuotaItem from './PlanQuotaItem.vue'
import {
  QUOTA_FLOAT_INSET_LEFT,
  QUOTA_FLOAT_WIDTH_COLLAPSED,
  QUOTA_FLOAT_WIDTH_EXPANDED,
} from './plan-quota-float'
import { useQuotaPlanList } from '@/composables/features/model/useQuotaPlanList'
import { useSessionStore } from '@/stores/session'

const props = defineProps<{
  /** 当前会话（「当前」标记的模型真值来源） */
  sessionId: string | null
  /** 收起态（宿主收敛：trace 激活 / drawer 打开 / 用户手动） */
  collapsed: boolean
}>()

const emit = defineEmits<{
  (e: 'update:userCollapsed', value: boolean): void
}>()

const { t } = useI18n()
const { entries } = useQuotaPlanList()
const sessionStore = useSessionStore()

/** 当前会话生效模型的 providerId（modelId 形如 "provider/model"；无 session/未选模型 → null） */
const currentProviderId = computed<string | null>(() => {
  const sid = props.sessionId
  if (!sid) return null
  const modelId = sessionStore.list.find((s) => s.id === sid)?.modelId ?? ''
  const slash = modelId.indexOf('/')
  return slash > 0 ? modelId.slice(0, slash) : null
})

/** 浮层定位/宽度（plan-quota-float.ts 尺寸契约 SSOT）：左缘偏移 + 随收起态切换的宽度
 *  （transition-[width] 承接切换动画）；宿主让位 gutter 与本宽度同源派生，改宽度只改常量模块。 */
const floatStyle = computed(() => ({
  left: `${QUOTA_FLOAT_INSET_LEFT}px`,
  width: `${props.collapsed ? QUOTA_FLOAT_WIDTH_COLLAPSED : QUOTA_FLOAT_WIDTH_EXPANDED}px`,
}))
</script>
