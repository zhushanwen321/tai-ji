<template>
  <!--
    Settings · System 菜单页（v6 §6.4 + §5.8）。
    容器：header + 8 Section 纵向编排。业务逻辑在各 Section 内。
    （v6 demo 回填：版本检查区块已移至 UpdatePage 自动更新卡，本页不再渲染。）
    [w2] 卡间距 = demo `.pg-set .gcard + .gcard` 16px：容器不设 gap，靠 GroupCard
    自带相邻 margin（var(--space-4)=16px）；页头间距由壳层共享 page-head mb-4 承担。
  -->
  <div class="flex flex-col">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.system') }}</h1>
        <p class="desc">{{ t('settings.menu.systemDesc') }}</p>
      </div>
    </header>

    <SystemAppearanceSection :system="system" @update="emit('update', $event)" />
    <SystemSoundSection :system="system" @update="emit('update', $event)" />
    <SystemShortcutSection :system="system" @update="emit('update', $event)" />
    <SystemAutoRenameSection />
    <SystemSmartContextSection />
    <SystemLlmRetrySection />
    <SystemCodemodeSection />
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
import SystemCodemodeSection from './SystemCodemodeSection.vue'
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
