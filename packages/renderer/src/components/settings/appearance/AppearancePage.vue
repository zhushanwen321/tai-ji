<template>
  <!--
    Settings · 外观菜单页（v6 §6.4 + §5.8）。
    聚合系统级外观偏好：外观模式（light/dark/system）、太极配色、全局字号（D17），
    以及分区字号（sidebar/chat/drawer 档位 + 终端 px，后者与 TerminalPage 同一 config SSOT）。
    尾部保留 Token 读值（原 TokenDebugPage 调试能力的留存量产部分）；
    原调试用的主题/字号即时覆盖已由本页持久化控件取代，不再保留。
  -->
  <div class="flex flex-col gap-4">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.appearance') }}</h1>
        <p class="desc">{{ t('settings.menu.appearanceDesc') }}</p>
      </div>
    </header>

    <!-- 外观模式 + 全局字号（自 SystemAppearanceSection 迁入） -->
    <GroupCard :title="t('settings.system.appearance')">
      <div class="px-2.5 pt-1 pb-2">
        <SettingRow :label="t('settings.system.appearance')" :desc="t('settings.system.appearanceDesc')">
          <Select
            :model-value="system.theme"
            @update:model-value="emit('update', { theme: $event as SystemSettings['theme'] })"
          >
            <SelectTrigger class="h-8 w-[200px] px-2 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">{{ t('settings.system.themeLight') }}</SelectItem>
              <SelectItem value="dark">{{ t('settings.system.themeDark') }}</SelectItem>
              <SelectItem value="system">{{ t('settings.system.themeSystem') }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow :label="t('settings.system.fontSize')" :desc="t('settings.system.fontSizeDesc')">
          <Select
            :model-value="system.fontSize ?? 'medium'"
            @update:model-value="emit('update', { fontSize: $event as SystemSettings['fontSize'] })"
          >
            <SelectTrigger class="h-8 w-[200px] px-2 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="small">{{ t('settings.system.fontSmall') }}</SelectItem>
              <SelectItem value="medium">{{ t('settings.system.fontMedium') }}</SelectItem>
              <SelectItem value="large">{{ t('settings.system.fontLarge') }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </div>
    </GroupCard>

    <!-- 配色主题（太极 · 即时切换，自 SystemAppearanceSection 迁入） -->
    <GroupCard :title="t('settings.system.themePresetTitle')">
      <p class="mt-1.5 mb-2 mx-2.5 text-xs text-neutral-mid">{{ t('settings.system.themePresetHint') }}</p>
      <div class="flex flex-col gap-0.5 px-2.5 pb-2.5">
        <Button
          v-for="th in TAIJI_THEMES"
          :key="th.label"
          variant="ghost"
          type="button"
          class="theme-row flex items-center justify-between rounded-md px-3 py-2.5 text-neutral-fg cursor-pointer transition-colors hover:bg-surface-hover"
          :class="th.label === currentTheme.label ? 'bg-surface text-accent hover:bg-surface' : ''"
          :aria-pressed="th.label === currentTheme.label"
          :data-testid="`appearance-theme-${th.preset}`"
          @click="applyTaijiTheme(th)"
        >
          <span class="text-sm font-medium">{{ th.label }}</span>
          <span class="flex gap-1">
            <span
              v-for="(c, i) in th.swatch"
              :key="i"
              class="size-4 rounded-full border border-border"
              :style="{ background: c }"
            />
          </span>
        </Button>
      </div>
    </GroupCard>

    <!-- 分区字号：sidebar / chat / drawer 档位 + 终端 px -->
    <GroupCard :title="t('settings.appearance.regionFontTitle')">
      <p class="mt-1.5 mb-2 mx-2.5 text-xs text-neutral-mid">{{ t('settings.appearance.regionFontHint') }}</p>
      <div class="px-2.5 pt-1 pb-2">
        <SettingRow
          v-for="region in FONT_REGIONS"
          :key="region.key"
          :label="t(`settings.appearance.region.${region.key}`)"
          :desc="t(region.descKey)"
        >
          <Select
            :model-value="system.fontScales?.[region.key] ?? 'medium'"
            @update:model-value="onRegionScale(region.key, $event as FontScaleTier)"
          >
            <SelectTrigger class="h-8 w-[200px] px-2 text-xs" :data-testid="`appearance-fs-${region.key}-trigger`">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="small">{{ t('settings.appearance.tierSmall') }}</SelectItem>
              <SelectItem value="medium">{{ t('settings.appearance.tierMedium') }}</SelectItem>
              <SelectItem value="large">{{ t('settings.appearance.tierLarge') }}</SelectItem>
              <SelectItem value="xlarge">{{ t('settings.appearance.tierXLarge') }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow :label="t('settings.appearance.region.terminal')" :desc="t('settings.appearance.terminalFontDesc')">
          <Input
            type="number"
            min="8"
            max="24"
            class="h-8 w-[200px] px-2 font-mono text-xs"
            data-testid="appearance-terminal-font-size-input"
            :disabled="terminalLoading"
            :model-value="terminalFontSize"
            @update:model-value="onTerminalFontSize"
            @blur="saveTerminalFontSize"
          />
        </SettingRow>
      </div>
    </GroupCard>

    <!-- Token 读值（getComputedStyle 读 :root，反映当前主题/字号实际渲染值） -->
    <GroupCard
      v-for="g in tokenRows"
      :key="g.titleKey"
      :title="t('settings.appearance.tokenGroup.' + g.titleKey)"
    >
      <div class="px-2.5 pt-1 pb-2 divide-y divide-border/50">
        <div v-for="row in g.rows" :key="row.name" class="flex items-center gap-2.5 py-1.5 px-1.5 font-mono text-xs">
          <span class="flex-1 text-neutral-fg">{{ row.name }}</span>
          <span
            class="size-[18px] rounded-sm border border-border shrink-0"
            :style="{ background: row.value.startsWith('#') || row.value.startsWith('rgb') ? row.value : 'transparent' }"
          />
          <span class="text-neutral-mid min-w-[120px] text-right">{{ row.value || '—' }}</span>
        </div>
      </div>
    </GroupCard>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { GroupCard } from '@taiji/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import type { SystemSettings, FontScaleTier } from '@taiji/core'
import type { TerminalConfig } from '@taiji/shared'
import { TAIJI_THEMES, resolveTaijiTheme, type TaijiTheme } from '@/composables/useTaijiThemes'
import { config } from '@/api'
import { useToast } from '@/composables/useToast'

const props = defineProps<{
  system: SystemSettings
}>()

const emit = defineEmits<{
  update: [patch: Partial<SystemSettings>]
}>()

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

// ── 太极主题（即时切换：写 store + 同步 DOM） ──
const currentTheme = computed<TaijiTheme>(() => resolveTaijiTheme(props.system))
function applyTaijiTheme(th: TaijiTheme): void {
  emit('update', { theme: th.theme, themePreset: th.preset })
}

// ── 分区字号（setSystem 浅合并，须回传完整 fontScales 对象） ──
const FONT_REGIONS = [
  { key: 'sidebar', descKey: 'settings.appearance.regionSidebarDesc' },
  { key: 'chat', descKey: 'settings.appearance.regionChatDesc' },
  { key: 'drawer', descKey: 'settings.appearance.regionDrawerDesc' },
] as const

function onRegionScale(region: 'sidebar' | 'chat' | 'drawer', tier: FontScaleTier): void {
  emit('update', { fontScales: { ...props.system.fontScales, [region]: tier } })
}

// ── 终端字号（xterm 画布渲染不走 CSS，直接编辑 terminal config，与 TerminalPage 同一 SSOT） ──
const TERMINAL_FONT_MIN = 8
const TERMINAL_FONT_MAX = 24
const TERMINAL_FONT_DEFAULT = 14
const terminalFontSize = ref<number>(TERMINAL_FONT_DEFAULT)
const terminalLoading = ref(true)
let terminalConfig: TerminalConfig | null = null

async function loadTerminalConfig(): Promise<void> {
  try {
    const res = await config.getTerminalConfig()
    terminalConfig = res.config
    terminalFontSize.value = res.config.fontSize
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  } finally {
    terminalLoading.value = false
  }
}

/** 输入中仅更新本地值；blur 时整体写回 config（保留 shell/字体等其他终端偏好）。 */
async function saveTerminalFontSize(): Promise<void> {
  const size = Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(Number(terminalFontSize.value) || TERMINAL_FONT_DEFAULT)))
  if (!terminalConfig || size === terminalConfig.fontSize) return
  try {
    await config.setTerminalConfig({ ...terminalConfig, fontSize: size })
    terminalConfig = { ...terminalConfig, fontSize: size }
    terminalFontSize.value = size
    toastInfo(t('settings.appearance.terminalFontSaved'))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

function onTerminalFontSize(v: string | number): void {
  terminalFontSize.value = Number(v)
}

// ── Token 读值（getComputedStyle 读 :root 实际渲染值；主题切换后由 watch 刷新） ──
const TOKEN_GROUPS = [
  { titleKey: 'bg', tokens: ['--bg', '--bg-sunken', '--surface', '--surface-hover', '--surface-2', '--bg-elevated', '--bg-input', '--bg-card'] },
  { titleKey: 'text', tokens: ['--neutral-fg', '--neutral-mid', '--neutral-dim', '--neutral-faint', '--neutral-ico'] },
  { titleKey: 'accent', tokens: ['--accent', '--accent-hover', '--accent-fg', '--success', '--warn', '--danger', '--info', '--reasoning'] },
  { titleKey: 'border', tokens: ['--border', '--border-strong', '--hairline'] },
  { titleKey: 'misc', tokens: ['--radius-sm', '--radius', '--radius-card', '--radius-lg', '--space-1', '--space-2', '--space-3', '--space-4', '--space-6', '--space-8'] },
]
const tokenValues = ref<Record<string, string>>({})

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function refreshTokens(): void {
  const out: Record<string, string> = {}
  for (const g of TOKEN_GROUPS) for (const tk of g.tokens) out[tk] = readToken(tk)
  tokenValues.value = out
}

const tokenRows = computed(() =>
  TOKEN_GROUPS.map((g) => ({
    titleKey: g.titleKey,
    rows: g.tokens.map((tk) => ({ name: tk, value: tokenValues.value[tk] ?? '' })),
  })),
)

// 主题/预设/字号变化 → token 实际值变化；DOM 属性由壳层 useSettingsShell 同步，rAF 后读到新值
watch(
  () => [props.system.theme, props.system.themePreset, props.system.fontSize, props.system.fontScales],
  () => requestAnimationFrame(refreshTokens),
)
onMounted(() => {
  void loadTerminalConfig()
  refreshTokens()
  window.addEventListener('resize', refreshTokens)
})
onUnmounted(() => {
  window.removeEventListener('resize', refreshTokens)
  // 终端字号失焦兜底：直接卸载（如切页）时保存未落盘的输入
  void saveTerminalFontSize()
})
</script>
