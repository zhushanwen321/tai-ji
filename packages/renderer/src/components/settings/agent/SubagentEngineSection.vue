<template>
  <GroupCard :title="t('settings.subagentEngine.title')">
    <div class="px-2.5 pt-1 pb-2" data-testid="subagent-engine-section">
      <SettingRow :label="t('settings.subagentEngine.label')" :desc="t('settings.subagentEngine.desc')">
        <Select
          :model-value="current"
          :disabled="loading || engines.length === 0"
          @update:model-value="onEngineChange"
        >
          <SelectTrigger class="h-8 w-[160px] px-2 text-xs" data-testid="subagent-engine-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="e in engines" :key="e" :value="e">{{ e }}</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
    </div>
  </GroupCard>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { GroupCard } from '@taiji/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import { getSubagentEngineConfig, setSubagentDefaultEngine } from '@taiji/core/transport/api/domains/session'

const { t } = useI18n()

// 引擎清单来自 runtime（extension engines.json 动态同步——未来新增引擎零改动出现在此）
const engines = ref<string[]>([])
const current = ref('pi')
const loading = ref(true)

onMounted(async () => {
  try {
    const config = await getSubagentEngineConfig()
    engines.value = config.engines
    current.value = config.defaultEngine
  } catch (err) {
    // best-effort：拉取失败回退 ['pi']（runtime 侧同兜底语义），选择器仍可用
    console.error('[settings] getSubagentEngineConfig failed:', err)
    engines.value = ['pi']
  } finally {
    loading.value = false
  }
})

async function onEngineChange(value: unknown): Promise<void> {
  const engineId = typeof value === 'string' ? value : ''
  if (engineId === '' || engineId === current.value) return
  try {
    await setSubagentDefaultEngine(engineId)
    current.value = engineId
  } catch (err) {
    // 写失败保持现值（配置未变）；下次打开设置重新拉取对齐
    console.error('[settings] setSubagentDefaultEngine failed:', err)
  }
}
</script>
