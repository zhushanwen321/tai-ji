<template>
  <!--
    外观快捷入口（chat-flow-text-color 同批 · 字号/主题快调）：sidebar footer 齿轮旁的
    Palette 按钮 + 轻量 popover。两条快捷通道，写同一 settings store（getSettingsStore
    单例），DOM 同步由 useSettingsShell 的 watch(applySystemToDom) 承接——本组件零 DOM 操作：
    - 主题：6 太极主题 2×2 色块按钮，点击即生效（同 AppearancePage applyTaijiTheme 通道）；
    - 对话流字号：chat 分区 4 档 segmented（分区字号 SSOT = system.fontScales.chat，
      落 DEFAULT_FONT_SCALES.chat 回落）。
    完整设置（外观模式/全局字号/其余分区/终端 px）仍在 SettingsModal 外观页，本面板是
    高频项快捷路径，不承载全量编辑。
  -->
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        variant="ghost"
        class="grid size-6 shrink-0 place-items-center rounded-sm p-0 text-neutral-dim transition-colors hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-[14px]"
        :title="t('sidebar.appearanceTitle')"
        data-testid="sidebar-appearance-quick"
        :aria-expanded="open"
      >
        <Palette class="size-[14px]" />
      </Button>
    </PopoverTrigger>
    <PopoverContent
      side="top"
      align="end"
      :collision-padding="8"
      class="w-[240px] p-3"
    >
      <!-- 主题行：2×2 色块方卡，active = accent 描边 -->
      <p class="mb-1.5 text-[length:var(--text-2xs)] font-medium text-neutral-mid">
        {{ t('settings.appearance.quickTheme') }}
      </p>
      <div class="mb-3 flex items-center justify-between" data-testid="appearance-quick-themes">
        <Button
          v-for="th in TAIJI_THEMES"
          :key="th.label"
          variant="ghost"
          type="button"
          class="rounded-md border p-[3px] transition-colors"
          :class="th.label === currentTheme.label
            ? 'border-accent bg-surface-hover hover:bg-surface-hover'
            : 'border-transparent hover:border-border hover:bg-surface-hover'"
          :title="th.label"
          :aria-pressed="th.label === currentTheme.label"
          :data-testid="`appearance-quick-theme-${th.preset || th.theme}`"
          @click="applyTheme(th)"
        >
          <span class="grid size-6 grid-cols-2 gap-[2px] overflow-hidden rounded-sm">
            <span
              v-for="(c, i) in th.swatch"
              :key="i"
              class="size-full"
              :style="{ background: c }"
            />
          </span>
        </Button>
      </div>

      <!-- 对话流字号行：chat 分区 4 档 segmented -->
      <p class="mb-1.5 text-[length:var(--text-2xs)] font-medium text-neutral-mid">
        {{ t('settings.appearance.quickChatFont') }}
      </p>
      <div class="flex gap-0.5 rounded-lg bg-bg-input p-[3px]" data-testid="appearance-quick-chat-seg">
        <Button
          v-for="tier in FONT_SCALE_TIERS"
          :key="tier"
          variant="ghost"
          class="h-7 flex-1 justify-center rounded-sm px-1 text-xs"
          :class="chatTier === tier
            ? 'bg-bg-elevated text-neutral-fg hover:bg-bg-elevated hover:text-neutral-fg'
            : 'text-neutral-mid hover:bg-transparent hover:text-neutral-fg'"
          :data-testid="`appearance-quick-chat-${tier}`"
          :aria-pressed="chatTier === tier"
          @click="applyChatTier(tier)"
        >
          {{ t(`settings.appearance.${TIER_LABEL_KEYS[tier]}`) }}
        </Button>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Palette } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { getSettingsStore, DEFAULT_FONT_SCALES } from '@taiji/core'
import type { FontScaleTier } from '@taiji/core'
import { TAIJI_THEMES, resolveTaijiTheme, type TaijiTheme } from '@/composables/useTaijiThemes'

const { t } = useI18n()
const open = ref(false)
const store = getSettingsStore()

const currentTheme = computed<TaijiTheme>(() => resolveTaijiTheme(store.system.value))

/** chat 分区档位显示回落（SSOT = DEFAULT_FONT_SCALES，浅合并可能缺 key） */
const chatTier = computed<FontScaleTier>(() => store.system.value.fontScales?.chat ?? DEFAULT_FONT_SCALES.chat)

const FONT_SCALE_TIERS: readonly FontScaleTier[] = ['small', 'medium', 'large', 'xlarge']
/** tier → i18n 档位文案键（tierXLarge 等既有 ui locale 键复用，不新增词表） */
const TIER_LABEL_KEYS: Record<FontScaleTier, string> = {
  small: 'tierSmall',
  medium: 'tierMedium',
  large: 'tierLarge',
  xlarge: 'tierXLarge',
}

function applyTheme(th: TaijiTheme): void {
  void store.setSystem({ theme: th.theme, themePreset: th.preset })
}

function applyChatTier(tier: FontScaleTier): void {
  void store.setSystem({ fontScales: { ...store.system.value.fontScales, chat: tier } })
}
</script>
