<!--
  Settings · Extension 域「插件贡献」子页（M16 接线，方案 A）。
  挂 ExtensionPage 旁：SettingsModal 在 extension 域内按 extensionView 状态切换本子页 / ExtensionPage。
  内容 = ui/extension-host 的 PluginSettingsPage（插件列表 + contribution 可用性置灰 + 原因），
  数据源经 PluginSettingsDataSourceKey inject（壳 useExtensionHostBridge app.provide 注入真实实现，
  单测 global.provide mock）。本子页只做入口装配（page-head + 返回按钮 + 挂载），不持有数据。
-->
<template>
  <div class="flex flex-col gap-4">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.extension.contributionsTitle') }}</h1>
        <p class="desc">{{ t('settings.extension.contributionsDesc') }}</p>
      </div>
      <div class="head-actions">
        <Button
          variant="ghost"
          size="dense"
          class="rounded-sm text-[12px]"
          data-testid="plugin-contributions-back"
          @click="emit('back')"
        >
          <ArrowLeft class="size-3.5" />
          {{ t('common.back') }}
        </Button>
      </div>
    </header>

    <PluginSettingsPage />
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ArrowLeft } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { PluginSettingsPage } from '@taiji/ui/extension-host'

const emit = defineEmits<{ back: [] }>()
const { t } = useI18n()
</script>
