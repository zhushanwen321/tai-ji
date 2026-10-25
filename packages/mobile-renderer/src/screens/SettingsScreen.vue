<script setup lang="ts">
// SettingsScreen —— 移动壳设置屏（settings 目的域；remote-use-mobile-v2 §6.17 偏好持久化 +
// §6.11 连接信息客户端派生）。
//
// 外观段：主题（深/浅）与字号（小/中/大）——读写经 PlatformPort.storage（taiji.mobile.prefs
// 单 JSON 键，app-runtime 偏好接线段），切换即时生效（根节点 data-theme / data-font-size
// 槽位，不重挂载）。
//
// 连接信息段（全客户端派生，§6.11）：主机 = location.host；网络形态 = Tailscale 网段判定
// （networkKindFromHost）；已连接时长 = 壳内记录的连接建立时刻（connectedSince）派生。
// tokenCreatedAt 无 runtime 下发信号——不显示（没有事实源的字段显示即造假，§6.11 裁决）。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { SegmentedControl, type SegmentedOption } from '@taiji/ui'
import {
  applyMobilePrefs,
  connectedSince,
  loadMobilePrefs,
  networkKindFromHost,
  saveMobilePrefs,
  type MobilePrefs,
} from '../shell/app-runtime'

const { t } = useI18n()

/** 已连接时长显示刷新周期（分钟粒度；产品功能定时——纯显示刷新，ADR-0122 保留白名单类目） */
const CONNECTED_DURATION_TICK_MS = 60_000

/** 分钟换算（时长显示粒度） */
const MS_PER_MINUTE = 60_000

// ── 偏好段 ──────────────────────────────────────────────────────────────

const prefs = ref<MobilePrefs>({ theme: 'dark', fontSize: 'medium' })

onMounted(() => {
  void loadMobilePrefs().then((loaded) => {
    prefs.value = loaded
    applyMobilePrefs(loaded)
  })
})

async function onThemeChange(theme: string): Promise<void> {
  prefs.value = await saveMobilePrefs({ theme: theme as MobilePrefs['theme'] })
  applyMobilePrefs(prefs.value)
}

async function onFontSizeChange(size: string): Promise<void> {
  prefs.value = await saveMobilePrefs({ fontSize: size as MobilePrefs['fontSize'] })
  applyMobilePrefs(prefs.value)
}

const THEME_OPTIONS: SegmentedOption[] = [
  { value: 'dark', label: t('mobile.settings.themeDark') },
  { value: 'light', label: t('mobile.settings.themeLight') },
]

const FONT_SIZE_OPTIONS: SegmentedOption[] = [
  { value: 'small', label: t('mobile.settings.fontSmall') },
  { value: 'medium', label: t('mobile.settings.fontMedium') },
  { value: 'large', label: t('mobile.settings.fontLarge') },
]

// ── 连接信息段（客户端派生）────────────────────────────────────────────

const host = location.host
const networkKind = networkKindFromHost(location.hostname)

// 已连接时长（分钟粒度）：挂载计算 + 60s 周期刷新（产品功能定时——纯显示刷新，
// ADR-0122 保留白名单类目）；卸载清理。
const connectedMinutes = ref<number | null>(null)

function recomputeConnectedMinutes(): void {
  connectedMinutes.value =
    connectedSince.value === null ? null : Math.max(0, Math.floor((Date.now() - connectedSince.value) / MS_PER_MINUTE))
}

let displayTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  recomputeConnectedMinutes()
  displayTimer = setInterval(recomputeConnectedMinutes, CONNECTED_DURATION_TICK_MS)
})

onUnmounted(() => {
  if (displayTimer !== null) clearInterval(displayTimer)
})

const connectedText = computed(() =>
  connectedMinutes.value === null ? '—' : t('mobile.settings.connectedFor', { minutes: connectedMinutes.value }),
)
</script>

<template>
  <main
    class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-[var(--m-gutter)] pt-[calc(var(--safe-area-top)+var(--m-gutter))]"
    data-testid="settings-screen"
  >
    <!-- 外观段 -->
    <section class="flex flex-col gap-3" data-testid="settings-appearance">
      <h2 class="text-[length:var(--m-text-title)] font-semibold text-neutral-fg">
        {{ t('mobile.settings.appearance') }}
      </h2>
      <div class="flex items-center justify-between gap-4">
        <span class="text-[length:var(--m-text-body)] text-neutral-fg">{{ t('mobile.settings.theme') }}</span>
        <SegmentedControl
          :model-value="prefs.theme"
          :options="THEME_OPTIONS"
          :label="t('mobile.settings.theme')"
          data-testid="settings-theme"
          @update:model-value="onThemeChange"
        />
      </div>
      <div class="flex items-center justify-between gap-4">
        <span class="text-[length:var(--m-text-body)] text-neutral-fg">{{ t('mobile.settings.fontSize') }}</span>
        <SegmentedControl
          :model-value="prefs.fontSize"
          :options="FONT_SIZE_OPTIONS"
          :label="t('mobile.settings.fontSize')"
          data-testid="settings-font-size"
          @update:model-value="onFontSizeChange"
        />
      </div>
    </section>

    <!-- 连接信息段（客户端派生；无 tokenCreatedAt——无事实源不显示） -->
    <section class="flex flex-col gap-3" data-testid="settings-connection">
      <h2 class="text-[length:var(--m-text-title)] font-semibold text-neutral-fg">
        {{ t('mobile.settings.connection') }}
      </h2>
      <div class="flex items-center justify-between gap-4">
        <span class="text-[length:var(--m-text-body)] text-neutral-fg">{{ t('mobile.settings.host') }}</span>
        <span class="text-[length:var(--m-text-sub)] text-neutral-mid" data-testid="settings-host">{{ host }}</span>
      </div>
      <div class="flex items-center justify-between gap-4">
        <span class="text-[length:var(--m-text-body)] text-neutral-fg">{{ t('mobile.settings.network') }}</span>
        <span class="text-[length:var(--m-text-sub)] text-neutral-mid" data-testid="settings-network">
          {{ networkKind === 'tailscale' ? t('mobile.settings.networkTailscale') : t('mobile.settings.networkLan') }}
        </span>
      </div>
      <div class="flex items-center justify-between gap-4">
        <span class="text-[length:var(--m-text-body)] text-neutral-fg">{{ t('mobile.settings.connectedDuration') }}</span>
        <span class="text-[length:var(--m-text-sub)] text-neutral-mid" data-testid="settings-connected-duration">
          {{ connectedText }}
        </span>
      </div>
    </section>
  </main>
</template>
