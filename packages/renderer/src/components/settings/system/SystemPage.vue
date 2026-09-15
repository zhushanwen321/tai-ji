<template>
  <!--
    Settings · System 菜单页（v6 §6.4 + §5.8）。
    容器：header + 6 Section 纵向编排。业务逻辑在各 Section 内。
    （v6 demo 回填：版本检查区块已移至 UpdatePage 自动更新卡，本页不再渲染。）
  -->
  <div class="flex flex-col gap-4">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.system') }}</h1>
        <p class="desc">{{ t('settings.menu.systemDesc') }}</p>
      </div>
    </header>

    <SystemAppearanceSection :system="system" @update="emit('update', $event)" />
    <SystemSoundSection :system="system" @update="emit('update', $event)" />
    <SystemShortcutSection :system="system" @update="emit('update', $event)" />
    <SystemAutoRenameSection :system="system" @update="emit('update', $event)" />
    <SystemSmartContextSection :system="system" @update="emit('update', $event)" />
    <SystemLlmRetrySection />
    <SystemStreamingIdleSection :system="system" @update="emit('update', $event)" />
    <SystemDiagnosticsSection />
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import SystemAppearanceSection from './SystemAppearanceSection.vue'
import SystemSoundSection from './SystemSoundSection.vue'
import SystemShortcutSection from './SystemShortcutSection.vue'
import SystemAutoRenameSection from './SystemAutoRenameSection.vue'
import SystemSmartContextSection from './SystemSmartContextSection.vue'
import SystemLlmRetrySection from './SystemLlmRetrySection.vue'
import SystemStreamingIdleSection from './SystemStreamingIdleSection.vue'
import SystemDiagnosticsSection from './SystemDiagnosticsSection.vue'
import type { SystemSettings } from '@taiji/core'

defineProps<{
  system: SystemSettings
}>()

const emit = defineEmits<{
  update: [patch: Partial<SystemSettings>]
}>()

const { t } = useI18n()
</script>
