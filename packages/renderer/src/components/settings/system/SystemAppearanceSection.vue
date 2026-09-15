<template>
  <div class="flex flex-col gap-4">
    <!-- 语言与声音（外观项已迁 AppearancePage） -->
    <GroupCard :title="t('settings.system.languageAppearance')">
      <div class="px-2.5 pt-1 pb-2">
        <SettingRow :label="t('settings.system.language')" :desc="t('settings.system.languageDesc')">
          <Select
            :model-value="system.locale"
            @update:model-value="emit('update', { locale: $event as SystemSettings['locale'] })"
          >
            <SelectTrigger class="h-8 w-[200px] px-2 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zh-CN">{{ t('settings.system.langZhCN') }}</SelectItem>
              <SelectItem value="en-US">{{ t('settings.system.langEnUS') }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow :label="t('settings.system.completionSound')" :desc="t('settings.system.completionSoundDesc')">
          <Switch
            data-testid="setting-completion-sound"
            :model-value="system.completionSound ?? true"
            @update:model-value="emit('update', { completionSound: $event === true })"
          />
        </SettingRow>
      </div>
    </GroupCard>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { GroupCard } from '@taiji/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import type { SystemSettings } from '@taiji/core'

defineProps<{
  system: SystemSettings
}>()

const emit = defineEmits<{
  update: [patch: Partial<SystemSettings>]
}>()

const { t } = useI18n()
</script>
