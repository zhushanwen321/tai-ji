<script setup lang="ts">
/**
 * Provider 导入入口菜单（W2 · cw-2026-07-26-migration-other-agents）。
 *
 * Popover 下拉触发器：点击展开 4 个源 agent 候选（Pi/ZCode/Codex/Claude Code），
 * 选中后 emit('select', source) 给父组件（ProviderPage）驱动 preview 流程。
 *
 * 复用 @taiji/ui 的 Popover（PopoverTriggerButton + PopoverActionItem），禁止原生 select/menu。
 */
import { Popover, PopoverContent, PopoverTriggerButton, PopoverActionItem } from '@taiji/ui'
import { ref } from 'vue'
import { Download } from '@lucide/vue'
import { useI18n } from 'vue-i18n'

import type { ProviderSource } from '@taiji/shared'

defineProps<{ disabled?: boolean }>()

const emit = defineEmits<{
  'select': [source: ProviderSource]
}>()

const { t } = useI18n()

/** 4 个可导入的源 agent（与 ProviderSource 对齐）。label 走 i18n（settings.loadPaths.sourceLabels.<id>），避免硬编码重复。 */
const SOURCES: ReadonlyArray<ProviderSource> = ['pi', 'zcode', 'codex', 'claude']

/** Popover 受控开关：选中后立即关闭 */
const open = ref(false)

function onSelect(source: ProviderSource): void {
  open.value = false
  emit('select', source)
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTriggerButton
      data-testid="import-providers-menu"
      :disabled="disabled"
      :title="t('settings.provider.importFromAgents')"
    >
      <Download class="size-3.5" />
      {{ t('settings.provider.importFromAgents') }}
    </PopoverTriggerButton>
    <PopoverContent>
      <PopoverActionItem
        v-for="s in SOURCES"
        :key="s"
        :test-id="`import-source-${s}`"
        @click="onSelect(s)"
      >
        {{ t('settings.loadPaths.sourceLabels.' + s) }}
      </PopoverActionItem>
    </PopoverContent>
  </Popover>
</template>
