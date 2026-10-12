<template>
  <!--
    [w3b] demo 对照：ExtensionSection.vue 内置/用户行主列（.srow-main）——name 14px/600 +
    v 版本（mono t-note 档）+ 来源/内置徽标（.tag.ok：h18/px7/r-full/text-2xs/fw-mid/accent-soft）
    + desc（13px fg-2）+ tools chips（demo：mono text-2xs / border 边 / r 4px / px 5px py 1px / fg-2）。
    自动升级开关为 real 功能结构（demo 位在行右操作区；搬位涉编排接线，超纯展示边界，原位保留），
    标签形态对齐 demo（gap 6px / text-xs / neutral-mid）。
  -->
  <div class="flex min-w-0 flex-1 flex-col">
    <div class="flex flex-wrap items-center gap-[8px]">
      <span class="truncate text-[length:var(--text-base)] font-semibold text-neutral-fg">{{ ext.displayName ?? ext.name }}</span>
      <span class="font-mono text-[length:var(--text-2xs)] text-[color:var(--neutral-fg-2)]">v{{ ext.version }}</span>
      <!-- 来源标签 -->
      <span v-if="ext.source === 'user-installed'" class="inline-flex h-[18px] shrink-0 items-center rounded-full bg-accent-soft px-[7px] text-[length:var(--text-2xs)] font-semibold text-accent">{{ t('settings.extension.sourceUser') }}</span>
      <span v-if="ext.source === 'discovery'" class="inline-flex h-[18px] shrink-0 items-center rounded-full bg-accent-soft px-[7px] text-[length:var(--text-2xs)] font-semibold text-accent">{{ t('settings.extension.sourceDiscovery') }}</span>
      <!-- 内置 badge：builtin 层扩展（layer='builtin'，不可卸载；infrastructure 子级亦不可禁） -->
      <span v-if="ext.layer === 'builtin'" class="inline-flex h-[18px] shrink-0 items-center rounded-full bg-accent-soft px-[7px] text-[length:var(--text-2xs)] font-semibold text-accent">{{ t('settings.extension.mandatoryBadge') }}</span>
    </div>
    <span class="mt-0.5 truncate text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ ext.description }}</span>
    <div v-if="ext.tools?.length" class="mt-[4px] flex flex-wrap gap-[4px]">
      <span v-for="t in ext.tools" :key="t" class="rounded-[4px] border border-border px-[5px] py-[1px] font-mono text-[length:var(--text-2xs)] text-[color:var(--neutral-fg-2)]">{{ t }}</span>
    </div>
    <!-- 自动升级开关（仅 user 层 + user-installed 来源扩展显示；builtin 由 runtime 管理） -->
    <div v-if="ext.layer !== 'builtin' && ext.source === 'user-installed'" class="mt-[6px] flex items-center gap-[6px]">
      <Switch
        :model-value="ext.autoUpgrade ?? false"
        class="shrink-0"
        :disabled="toggling.has(ext.name)"
        :aria-label="t('settings.extension.autoUpgrade')"
        @update:model-value="onSetAutoUpgrade(ext, $event)"
      />
      <span class="text-[length:var(--text-xs)] text-neutral-mid">{{ t('settings.extension.autoUpgrade') }}</span>
    </div>
    <!-- 操作失败就近反馈（非静默吞，AGENTS.md 规则 #3） -->
    <div v-if="error" class="mt-[4px] flex items-center gap-1.5 text-[length:var(--text-2xs)] text-danger">
      <AlertCircle class="size-[12px] shrink-0" />
      <span class="truncate">{{ error }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { AlertCircle } from '@lucide/vue'
import { Switch } from '@/components/ui/switch'
import { getSettingsTransport } from '@taiji/core'
import type { ExtensionItem } from '@taiji/core'
import { getSettingsStore } from '@taiji/core'
import { useOptimisticExtensionFlagToggle } from './extension-flag-toggle'

defineProps<{ ext: ExtensionItem }>()

const settingsStore = getSettingsStore()
const { t } = useI18n()

// autoUpgrade 开关的乐观切换（toggling 防双击 / error 就近错误面；编排与 ExtensionActions
// 的启用开关共用 extension-flag-toggle）
const { toggling, error, toggleFlag } = useOptimisticExtensionFlagToggle()

/** 设置扩展自动升级开关（仅 user-installed）→ 乐观更新 + 持久化（编排走
 * useOptimisticExtensionFlagToggle 的乐观更新协议，与启用开关共用）。 */
async function onSetAutoUpgrade(ext: ExtensionItem, enabled: boolean) {
  await toggleFlag(ext.name, enabled, {
    setFlag: (v) => settingsStore.setExtensionAutoUpgrade(ext.name, v),
    persist: () => getSettingsTransport().setExtensionAutoUpgrade(ext.name, enabled),
    formatError: (e) => e instanceof Error
      ? t('settings.extension.autoUpgradeFailed', { msg: e.message })
      : t('settings.extension.autoUpgradeFailed', { msg: String(e) }),
  })
}
</script>
