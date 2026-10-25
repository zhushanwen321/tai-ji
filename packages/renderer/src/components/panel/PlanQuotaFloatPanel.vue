<template>
  <!--
    套餐浮层（plan-quota-float）：对话流左侧，展示全部 quota.enabled provider 的
    窗口用量。纯 overlay 悬浮在对话流上方，不挤占消息列/composer 边距。收起条件由
    宿主单点判定（trace 激活 / 文件 drawer 打开 / panel 宽度不足 / 用户手动，
    collapsed prop 收敛四者），本组件只渲染两态 + 上报手动切换。
  -->
  <section
    v-if="entries.length > 0"
    class="absolute top-3 z-30 overflow-hidden rounded-[var(--radius-lg)] border border-border bg-bg shadow-2 transition-[width] duration-[260ms]"
    :style="floatStyle"
    data-testid="plan-quota-float"
    :aria-label="t('panel.quotaFloat.title')"
  >
    <!-- 展开态：标题行 + 套餐清单（宽度定宽防内容随收起动画回流；间距对齐紧凑化定稿：
         body 10px / 标题行下 7px / 项分隔 7px） -->
    <div
      v-show="!collapsed"
      class="max-h-[calc(100%-12px)] overflow-y-auto p-2.5"
      :style="{ width: `${QUOTA_FLOAT_WIDTH_EXPANDED}px` }"
      data-testid="plan-quota-body"
    >
      <div class="mb-[7px] flex items-center gap-1.5">
        <Zap class="size-3.5 shrink-0 text-neutral-mid" aria-hidden="true" />
        <span class="flex-1 text-[length:var(--text-xs)] font-medium text-neutral-fg">{{ t('panel.quotaFloat.title') }}</span>
        <Button
          variant="ghost"
          size="icon"
          class="size-6 rounded-[var(--radius-sm)] text-neutral-dim hover:text-neutral-fg"
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
          :class="idx > 0 ? 'mt-[7px] border-t border-hairline pt-[7px]' : ''"
        />
      </div>
    </div>
    <!-- 收起态：左侧竖排把手，点击恢复展开 -->
    <Button
      v-show="collapsed"
      variant="ghost"
      class="h-auto max-h-[calc(100%-12px)] flex-col gap-2 rounded-none py-2 text-neutral-mid hover:text-neutral-fg"
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
 * 展示全部 quota.enabled provider 的窗口用量，数据通道复用 coding-plan quota
 * 基建（quota store + useQuotaQuery），不新建通道。「当前」标记 = 当前会话生效模型
 * （session store 的 per-session modelId）的 provider 段命中的清单项。
 *
 * 受控组件：收起状态由宿主 Panel 单点持有（collapsed prop 收敛 trace / drawer /
 * panel 宽度 / 用户手动四个来源），本组件仅上报手动切换（update:userCollapsed）。
 *
 * 刷新：挂载期间定时统一刷新（QUOTA_FLOAT_REFRESH_INTERVAL_MS，收起态跳过）——
 * 定时器 bump provide tick，各 PlanQuotaItem watch tick 重新查询
 * （通道契约见 plan-quota-float.ts QUOTA_FLOAT_REFRESH_TICK_KEY）。
 */
import { computed, onScopeDispose, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronsLeft, ChevronsRight, Zap } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import PlanQuotaItem from './PlanQuotaItem.vue'
import {
  QUOTA_FLOAT_INSET_LEFT,
  QUOTA_FLOAT_REFRESH_INTERVAL_MS,
  QUOTA_FLOAT_REFRESH_TICK_KEY,
  QUOTA_FLOAT_WIDTH_COLLAPSED,
  QUOTA_FLOAT_WIDTH_EXPANDED,
} from './plan-quota-float'
import { useQuotaPlanList } from '@/composables/features/model/useQuotaPlanList'
import { useSessionLiveState } from '@/composables/features/session/useSessionLiveState'

const props = defineProps<{
  /** 当前会话（「当前」标记的模型真值来源） */
  sessionId: string | null
  /** 收起态（宿主收敛：trace 激活 / drawer 打开 / panel 宽度不足 / 用户手动） */
  collapsed: boolean
}>()

const emit = defineEmits<{
  (e: 'update:userCollapsed', value: boolean): void
}>()

const { t } = useI18n()
const { entries } = useQuotaPlanList()
// 选择器统一：与 composer / 移动壳同源（useSessionLiveState → core createSessionLiveStateSelector）
const { modelId: currentModelId } = useSessionLiveState(computed(() => props.sessionId))

/**
 * 当前会话生效模型的 providerId（modelId 形如 "provider/model"；无 session/未选模型 → null）。
 *
 * [W1 会话架构四层分离] 读状态层（按会话 id 寄存），不再读 sessionStore.list 条目——
 * applySnapshot 已不再写 modelId，列表查找会使本判定恒 null。
 * 状态尚未观测（undefined）= 显式未知 → null（UI 不标「当前」，禁止猜测）。
 */
const currentProviderId = computed<string | null>(() => {
  const sid = props.sessionId
  if (!sid) return null
  const modelId = currentModelId.value ?? ''
  const slash = modelId.indexOf('/')
  return slash > 0 ? modelId.slice(0, slash) : null
})

/** 刷新 tick（子项 watch 此值重查；不清缓存，旧数据保留到新数据到达） */
const refreshTick = ref(0)
provide(QUOTA_FLOAT_REFRESH_TICK_KEY, refreshTick)

// 定时统一刷新：挂载期间每 5 分钟 bump 一次；收起态跳过（不可见期间的查询无人消费）。
// 查询并发/节流保护在 useQuotaQuery（pending 标记）与 runtime QuotaService（10s 节流）。
// refreshTimer 声明先于 watch（immediate 回调同步执行，声明在后会踩 TDZ）。
let refreshTimer: ReturnType<typeof setInterval> | undefined
watch(() => props.collapsed, (collapsed) => {
  if (collapsed) {
    clearInterval(refreshTimer)
    refreshTimer = undefined
  } else if (refreshTimer === undefined) {
    refreshTimer = setInterval(() => {
      refreshTick.value += 1
    }, QUOTA_FLOAT_REFRESH_INTERVAL_MS)
  }
}, { immediate: true })
onScopeDispose(() => clearInterval(refreshTimer))

/** 浮层定位/宽度（plan-quota-float.ts 尺寸契约 SSOT）：左缘偏移 + 随收起态切换的宽度
 *  （transition-[width] 承接切换动画）。纯 overlay 不挤占消息列/composer 边距——宿主不设
 *  让位 gutter，宽度档位只有浮层侧动态 style 消费，改宽度只改常量模块。 */
const floatStyle = computed(() => ({
  left: `${QUOTA_FLOAT_INSET_LEFT}px`,
  width: `${props.collapsed ? QUOTA_FLOAT_WIDTH_COLLAPSED : QUOTA_FLOAT_WIDTH_EXPANDED}px`,
}))
</script>
