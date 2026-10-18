<template>
  <!-- 请求统计卡（llm-network-proxy §3.1 卡 3）：范围 Select（24h/7d/累计）+ 刷新 + 重置
       （confirm 后 reset）+ 图例 + 按服务商行（名称+主机名 | 经代理/直连计数条 | 数字；
       主机名↔服务商名反查自 provider 清单，查不到显裸主机名）。数据自治：onMounted 拉 +
       手动刷新；「累计」档显示截断窗口标注（runtime truncatedNote 优先，缺省本地固定文案）。 -->
  <GroupCard>
    <template #head>
      <div class="gc-head-text">
        <h3 class="gc-title">{{ t('settings.network.statsCard') }}</h3>
        <p class="gc-sub">{{ t('settings.network.statsCardDesc') }}</p>
      </div>
    </template>
    <template #actions>
      <div class="flex items-center gap-2">
        <Select v-model="rangeModel" :disabled="!enabled">
          <SelectTrigger data-testid="network-stats-range" class="h-[28px] w-[130px] text-[length:var(--text-xs)]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="24h" :data-testid="`network-stats-range-24h`">{{ t('settings.network.range24h') }}</SelectItem>
            <SelectItem value="7d" :data-testid="`network-stats-range-7d`">{{ t('settings.network.range7d') }}</SelectItem>
            <SelectItem value="all" :data-testid="`network-stats-range-all`">{{ t('settings.network.rangeAll') }}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="sm"
          class="size-[28px] p-0 text-neutral-mid hover:text-neutral-fg"
          :title="t('settings.network.refresh')"
          :aria-label="t('settings.network.refresh')"
          :disabled="!enabled"
          data-testid="network-stats-refresh"
          @click="loadStats"
        >
          <RefreshCw class="size-[14px]" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          class="h-[28px] gap-1 px-2 text-[length:var(--text-xs)] text-neutral-mid hover:text-neutral-fg"
          :disabled="!enabled"
          data-testid="network-stats-reset"
          @click="showResetConfirm = true"
        >
          <RotateCcw class="size-3.5" />
          {{ t('settings.network.reset') }}
        </Button>
      </div>
    </template>

    <div class="flex flex-col gap-[10px] px-[10px] pt-[4px] pb-[10px]" data-testid="network-stats-card">
      <!-- 图例（demo stats-legend 形态：swatch + 文案；纯灰阶对齐太极设计系统） -->
      <div class="flex gap-[16px] text-[length:var(--text-xs)] text-[color:var(--neutral-fg-2)]">
        <span class="inline-flex items-center gap-[6px]">
          <span class="size-[9px] shrink-0 rounded-[3px] bg-[color:var(--neutral-fg-2)]" aria-hidden="true"></span>
          {{ t('settings.network.legendProxied') }}
        </span>
        <span class="inline-flex items-center gap-[6px]">
          <span class="size-[9px] shrink-0 rounded-[3px] bg-[color:var(--neutral-faint)]" aria-hidden="true"></span>
          {{ t('settings.network.legendDirect') }}
        </span>
      </div>

      <p v-if="loadError" class="text-[length:var(--text-sm)] text-warn" data-testid="network-stats-error">
        {{ t('settings.network.statsLoadFailed') }}
      </p>

      <!-- 按服务商行（demo stat-row 形态：三列 grid；计数条 = 直连底 + 经代理段） -->
      <div v-if="rows.length > 0" class="flex flex-col" data-testid="network-stats-rows">
        <div
          v-for="row in rows"
          :key="row.host"
          class="grid grid-cols-[168px_1fr_120px] items-center gap-[10px] border-b border-hairline py-[8px] last:border-b-0"
          :data-testid="`network-stats-row-${row.host}`"
        >
          <div class="flex min-w-0 flex-col">
            <span class="truncate text-[length:var(--text-sm)] font-medium text-neutral-fg">{{ row.name }}</span>
            <span class="truncate text-[length:var(--text-2xs)] text-[color:var(--neutral-fg-2)]">{{ row.host }}</span>
          </div>
          <div class="h-[8px] w-full overflow-hidden rounded-[3px] bg-[color:var(--neutral-faint)]">
            <div class="h-full rounded-[3px] bg-[color:var(--neutral-fg-2)]" :style="{ width: `${row.proxiedPct}%` }"></div>
          </div>
          <div class="text-right text-[length:var(--text-2xs)] leading-[1.5] text-[color:var(--neutral-fg-2)]">
            <div><span class="font-medium text-neutral-fg">{{ row.proxied }}</span> {{ t('settings.network.legendProxied') }}</div>
            <div>{{ row.direct }} {{ t('settings.network.legendDirect') }}</div>
          </div>
        </div>
      </div>
      <p v-else-if="!loadError" class="py-[6px] text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]" data-testid="network-stats-empty">
        {{ t('settings.network.statsEmpty') }}
      </p>

      <!-- 「累计」档截断窗口标注：runtime 下发 truncatedNote 优先，缺省本地固定文案 -->
      <p v-if="range === 'all'" class="text-[length:var(--text-2xs)] text-[color:var(--neutral-fg-2)]" data-testid="network-stats-truncated-note">
        {{ truncatedNote ?? t('settings.network.truncatedNote') }}
      </p>
    </div>

    <ConfirmDialog
      :open="showResetConfirm"
      :title="t('settings.network.resetConfirmTitle')"
      :description="t('settings.network.resetConfirmDesc')"
      :confirm-text="t('settings.network.reset')"
      :cancel-text="t('settings.network.cancel')"
      :loading="resetting"
      variant="danger"
      @update:open="showResetConfirm = $event"
      @confirm="onReset"
    />
  </GroupCard>
</template>

<script setup lang="ts">
/**
 * 请求统计卡（自治 Section 形态，onMounted 拉 + 手动刷新 + confirm 重置）。
 * range 切换即重拉；确认弹层消费 ui ConfirmDialog 原语（settings 域先例 = PiPresetsPage）。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCw, RotateCcw } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConfirmDialog } from '@/components/ui/dialog'
import { GroupCard } from '@taiji/ui/features/settings'
import { getSettingsTransport } from '@taiji/core'
import { useToast } from '@/composables/useToast'
import type { NetworkProxyStats, NetworkProxyStatsRange, ProviderInfo } from '@taiji/shared'
import { providerNameForHost } from './network-page-model'

const RANGES: readonly NetworkProxyStatsRange[] = ['24h', '7d', 'all']
/** 占比换算基线（proxiedPct = proxied / total × PCT_SCALE，demo stat-bar width% 同口径）。 */
const PCT_SCALE = 100

const transport = getSettingsTransport()
const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

const props = defineProps<{
  /** 开关总态：false 时禁交互（降灰由 page 层 wrapper 承担） */
  enabled: boolean
  /** 主机名↔服务商名反查数据源（page 拉取的 provider 清单） */
  providers: ProviderInfo[]
}>()

const range = ref<NetworkProxyStatsRange>('24h')
const stats = ref<NetworkProxyStats[]>([])
const truncatedNote = ref<string | null>(null)
const loadError = ref(false)
const showResetConfirm = ref(false)
const resetting = ref(false)

/** range Select 桥（reka 回填 AcceptableValue；运行时判型收窄，切换即重拉）。 */
const rangeModel = computed<NetworkProxyStatsRange>({
  get: () => range.value,
  set: (v) => {
    if (typeof v === 'string' && (RANGES as readonly string[]).includes(v)) {
      range.value = v as NetworkProxyStatsRange
      void loadStats()
    }
  },
})

/** 统计行投影：服务商名反查（查不到显裸主机名）+ 经代理占比（总数 0 时 0%，直连底显满条）。 */
const rows = computed(() =>
  stats.value.map((s) => {
    const total = s.proxied + s.direct
    return {
      host: s.host,
      name: providerNameForHost(s.host, props.providers) ?? s.host,
      proxied: s.proxied,
      direct: s.direct,
      proxiedPct: total > 0 ? Math.round((s.proxied / total) * PCT_SCALE) : 0,
    }
  }),
)

async function loadStats(): Promise<void> {
  try {
    const reply = await transport.getNetworkProxyStats(range.value)
    stats.value = reply.stats
    truncatedNote.value = reply.truncatedNote ?? null
    loadError.value = false
  } catch (e) {
    loadError.value = true
    console.warn('[NetworkStatsCard] getNetworkProxyStats failed:', e)
  }
}

/** 重置：confirm 后 reset；reply = 清零后统计，直接刷新视图（协议语义，不重复拉取）。 */
async function onReset(): Promise<void> {
  if (resetting.value) return
  resetting.value = true
  try {
    const reply = await transport.resetNetworkProxyStats()
    stats.value = reply.stats
    truncatedNote.value = reply.truncatedNote ?? null
    loadError.value = false
    toastInfo(t('settings.network.resetDoneToast'))
    showResetConfirm.value = false
  } catch (e) {
    toastError(t('settings.network.statsLoadFailed'))
    console.warn('[NetworkStatsCard] resetNetworkProxyStats failed:', e)
  } finally {
    resetting.value = false
  }
}

onMounted(() => {
  void loadStats()
})
</script>
