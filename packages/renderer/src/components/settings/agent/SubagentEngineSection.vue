<template>
  <GroupCard :title="t('settings.subagentEngine.title')">
    <!-- RD-4#8：读配置失败常驻提示（默认值非已存值）+ 重试；控件禁用直到重拉成功 -->
    <div
      v-if="loadError"
      data-testid="subagent-engine-load-error"
      class="flex items-center gap-2 px-2.5 pt-2 pb-1 text-[11px] text-warn"
    >
      <AlertTriangle class="size-3.5 shrink-0" />
      <span>{{ t('settings.subagentEngine.loadErrorHint') }}</span>
      <Button
        variant="ghost"
        size="sm"
        class="h-5 px-1.5 text-[11px] text-accent"
        data-testid="subagent-engine-load-retry"
        @click="loadConfig"
      >{{ t('settings.subagentEngine.loadErrorRetry') }}</Button>
    </div>
    <div class="px-2.5 pt-1 pb-2" data-testid="subagent-engine-section">
      <SettingRow :label="t('settings.subagentEngine.label')" :desc="t('settings.subagentEngine.desc')">
        <Select
          :model-value="current"
          :disabled="loading || engines.length === 0 || loadError"
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
import { AlertTriangle } from '@lucide/vue'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
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
/** RD-4#8：读配置失败标志——置位时控件禁用 + 顶部常驻提示，禁止把默认值当已存值渲染。 */
const loadError = ref(false)

async function loadConfig(): Promise<void> {
  loading.value = true
  try {
    const config = await getSubagentEngineConfig()
    engines.value = config.engines
    current.value = config.defaultEngine
    loadError.value = false
  } catch (err) {
    // RD-4#8：读失败不再 best-effort 冒充已存值。置 loadError → 控件禁用 + 常驻提示 + 可重试。
    // 默认 ['pi'] 仅作占位渲染，明确标注为默认值（此前 console.error 后静默按默认值渲染，
    // 下拉显示 'pi' 冒充已存引擎，子 agent 按未生效引擎跑）。
    console.error('[settings] getSubagentEngineConfig failed:', err)
    engines.value = ['pi']
    loadError.value = true
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadConfig()
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
