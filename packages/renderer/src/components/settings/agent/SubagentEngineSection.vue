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
import { useToast } from '@/composables/useToast'

const { t } = useI18n()
const { error: toastError } = useToast()

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
  } catch (e) {
    // RD-4#3 失败显形 + 回滚：current 仅在写成功后前进（Select 以 :model-value 受控于 current，
    // reka-ui 非被动模式显示值恒跟随 props），故显示自动回滚旧值；此处补 toast 让失败可见
    // （此前仅 console.error，用户以为已切换、子 agent 按未生效引擎跑）。文案透传 runtime 错误。
    toastError(e instanceof Error ? e.message : String(e))
  }
}
</script>
