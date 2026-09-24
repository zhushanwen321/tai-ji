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
          :disabled="loading || saving || engines.length === 0 || loadError"
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
import { getSettingsTransport } from '@taiji/core'
import { createSettingFieldGroup } from '@/composables/features/settings/setting-field'

// [C3] settings 域 transport 只经 SettingsTransport seam（禁直连门面 / 禁深 import transport 域）
const transport = getSettingsTransport()

const { t } = useI18n()

/** 默认引擎占位值（load 失败时明确渲染为默认而非已存值，禁止把默认值当已存值操作——RD-4#8）。 */
const DEFAULT_ENGINE = 'pi'

// 引擎清单来自 runtime（extension engines.json 动态同步——未来新增引擎零改动出现在此）；
// 初始与 load 失败时保留默认占位，配合 loadError 禁用防止误操作
const engines = ref<string[]>([DEFAULT_ENGINE])

// ── 字段编排走 setting-field module：load 失败归并 loadError + 乐观写/失败回滚/toast ──
const group = createSettingFieldGroup()
const loadError = group.loadError

const engineField = group.field<string>(DEFAULT_ENGINE, {
  // load 成功：引擎清单回填，defaultEngine 经 reset 回填为已保存基准（含回滚锚点）
  load: async () => {
    const config = await transport.getSubagentEngineConfig()
    engines.value = config.engines
    return config.defaultEngine
  },
  // 受控 Select 显示恒跟随 value：乐观写立即前进，失败回滚即回弹旧值；resolve engineId = 权威回填
  save: (next) => transport.setSubagentDefaultEngine(next).then((res) => res.engineId),
  savedToastKey: 'settings.subagentEngine.saved',
  saveFailedToastKey: 'settings.subagentEngine.saveFailed',
})
const current = engineField.value
const saving = engineField.busy
/** 首拉/重试进行中禁用控件：堵「加载窗口内选中 → in-flight loader 用过期已存值 reset 回退显示」的竞态窗口 */
const loading = ref(true)

/** 加载/重试：字段便捷 load 注册进 group，loadAll 归并（任一失败置 loadError）。 */
async function loadConfig(): Promise<void> {
  loading.value = true
  try {
    await group.loadAll()
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadConfig()
})

/** Select change：编排全在 setting-field module（同值短路 → 乐观写 → 失败回滚 + toast）。 */
function onEngineChange(value: unknown): void {
  // Select 只发出选项值；空串防御（不存在于引擎清单，禁止落盘）
  if (typeof value !== 'string' || value === '') return
  void engineField.persist(value)
}
</script>
