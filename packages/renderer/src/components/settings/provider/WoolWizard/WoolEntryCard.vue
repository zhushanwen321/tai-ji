<template>
  <!--
    provider 列表 · 羊毛条目卡（D6 ③/条目徽标：额度条/模型数/签到状态/登录态失效）。
    数据 = wool 快照单家族视图（账号状态消费管理通道缓存；目录 = 派生缓存 + 时点标注）。
    动作：刷新（status+refresh）、一键签到（点击签到徽标）。未完成接入态显示引导。
  -->
  <div
    :data-testid="`wool-entry-${family.family}`"
    class="rounded-md bg-surface p-[12px_14px]"
  >
    <div class="flex min-w-0 items-center gap-3">
      <!-- 状态点（对齐 ProviderPage statusDot 语义：登录 = 绿；无凭据/失效 = 中性/红） -->
      <span class="size-[7px] shrink-0 rounded-full" :class="statusDot" />

      <!-- 名称 + 羊毛徽标 -->
      <span class="flex-1 truncate text-[length:var(--text-base)] font-semibold text-neutral-fg">{{ family.displayName }}</span>
      <span
        data-testid="wool-entry-wool-badge"
        class="inline-flex h-[18px] shrink-0 items-center rounded-full bg-accent-soft px-[7px] text-[length:var(--text-2xs)] font-semibold text-accent"
      >{{ t('wool.badgeWool') }}</span>

      <!-- 登录态失效徽标（token 过期且 loggedIn=false 时最高优先显示） -->
      <span
        v-if="loginExpired"
        data-testid="wool-entry-login-expired"
        class="inline-flex h-[18px] shrink-0 items-center rounded-full bg-danger-soft px-[7px] text-[length:var(--text-2xs)] font-semibold text-danger"
      >{{ t('wool.loginExpired') }}</span>

      <!-- 模型数徽标（目录缓存计数 + 数据时点 title） -->
      <span
        v-if="modelCount > 0"
        :data-testid="`wool-entry-models`"
        class="shrink-0 text-[length:var(--text-xs)] text-neutral-fg-2"
        :title="family.catalog ? t('wool.catalogFetchedAt', { time: new Date(family.catalog.fetchedAt).toLocaleString() }) : undefined"
      >{{ t('wool.badgeModelsCount', { count: modelCount }) }}</span>

      <!-- 签到徽标（点击触发单次签到——D5 一键签到；@taiji/ui Button，禁原生表单元素） -->
      <Button
        v-if="family.account"
        variant="ghost"
        :data-testid="`wool-entry-checkin-${family.family}`"
        class="h-[18px] shrink-0 rounded-full px-[7px] py-0 text-[length:var(--text-2xs)] font-semibold"
        :class="family.account.checkin?.doneToday ? 'bg-success-soft text-success hover:bg-success-soft' : 'bg-warn-soft text-warn hover:bg-warn-soft'"
        :disabled="checkinRunning"
        @click="emit('checkin')"
      >{{ family.account.checkin?.doneToday ? t('wool.badgeCheckinDone') : t('wool.badgeCheckinTodo') }}</Button>

      <!-- 刷新按钮（status + catalog 双拉取） -->
      <Button
        variant="ghost"
        class="h-[24px] w-[24px] shrink-0 rounded-md p-0 text-neutral-mid hover:bg-surface-hover hover:text-accent [&_svg]:size-[13px]"
        :title="t('wool.refresh')"
        data-testid="wool-entry-refresh"
        :disabled="refreshing"
        @click="emit('refresh')"
      >
        <RefreshCw :class="refreshing ? 'animate-spin' : ''" />
      </Button>
    </div>

    <!-- 额度条（quota 有值时；used/total 比例 + 文案） -->
    <div v-if="family.account?.quota" class="mt-[10px] flex items-center gap-2" data-testid="wool-entry-quota">
      <div class="h-[4px] flex-1 overflow-hidden rounded-full bg-surface-hover">
        <div
          class="h-full rounded-full bg-accent"
          :style="{ width: quotaPercent }"
        />
      </div>
      <span class="shrink-0 font-mono text-[length:var(--text-2xs)] text-neutral-mid">{{ quotaText }}</span>
    </div>

    <!-- 未完成接入引导（installed 但未 adopted / 或未安装） -->
    <p v-if="!family.adopted" data-testid="wool-entry-not-adopted" class="mt-[8px] text-[length:var(--text-2xs)] text-neutral-mid">
      {{ t('wool.notAdoptedHint') }}
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * 纯展示 + 动作上抛（刷新/签到由 ProviderPage 编排——wool.runAction 后快照经广播回推）。
 * 登录态失效判定（失败路径表）：account.loggedIn=false（status 动作回写）即失效呈现。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCw } from '@lucide/vue'
import { Button } from '@taiji/ui'
import type { WoolFamilyState } from '@taiji/shared'

const props = defineProps<{
  family: WoolFamilyState
  refreshing?: boolean
  checkinRunning?: boolean
}>()

const emit = defineEmits<{
  refresh: []
  checkin: []
}>()

const { t } = useI18n()

const modelCount = computed(() => props.family.catalog?.models.length ?? 0)
const loginExpired = computed(() => props.family.account !== null && !props.family.account.loggedIn)

const statusDot = computed(() => {
  if (props.family.account === null) return 'bg-neutral-dim'
  return props.family.account.loggedIn ? 'bg-success' : 'bg-danger'
})

/** 额度条百分比上限（used/total → 显示宽度 clamp）。 */
const QUOTA_PERCENT_MAX = 100

const quotaPercent = computed(() => {
  const quota = props.family.account?.quota
  if (!quota || quota.total === undefined || quota.total <= 0) return '0%'
  return `${Math.min(QUOTA_PERCENT_MAX, Math.round((quota.used / quota.total) * QUOTA_PERCENT_MAX))}%`
})

const quotaText = computed(() => {
  const quota = props.family.account?.quota
  if (!quota) return ''
  return quota.total !== undefined
    ? t('wool.quotaUsed', { used: quota.used, total: quota.total, unit: quota.unit })
    : t('wool.quotaOnly', { used: quota.used, unit: quota.unit })
})
</script>
