<template>
  <!-- [w3b] demo 对照：AgentSection.vue「子代理引擎」卡（gc-title 卡头 + tight body + SettingRow +
       Select w160）。loadError 行形态与 SystemAutoRenameSection 同族（RD-4#8；卡内 padding 10/8/4
       绝对 px + text-2xs 令牌），重试钮保持 W2 卡内小钮档。 -->
  <GroupCard :title="t('settings.subagentEngine.title')">
    <!-- RD-4#8：读配置失败常驻提示（默认值非已存值）+ 重试；控件禁用直到重拉成功 -->
    <div
      v-if="loadError"
      data-testid="subagent-engine-load-error"
      class="flex items-center gap-2 px-[10px] pt-[8px] pb-[4px] text-[length:var(--text-2xs)] text-warn"
    >
      <AlertTriangle class="size-3.5 shrink-0" />
      <span>{{ t('settings.subagentEngine.loadErrorHint') }}</span>
      <Button
        variant="ghost"
        size="sm"
        class="h-5 px-1.5 text-[length:var(--text-2xs)] text-accent"
        data-testid="subagent-engine-load-retry"
        @click="loadConfig"
      >{{ t('settings.subagentEngine.loadErrorRetry') }}</Button>
    </div>
    <div class="px-[10px] pt-[4px] pb-[8px]" data-testid="subagent-engine-section">
      <SettingRow :label="t('settings.subagentEngine.label')" :desc="t('settings.subagentEngine.desc')">
        <Select
          :model-value="current"
          :disabled="loading || saving || engines.length === 0 || loadError"
          @update:model-value="onEngineChange"
        >
          <SelectTrigger class="w-[160px]" data-testid="subagent-engine-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="e in engines" :key="e" :value="e">{{ e }}</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <!-- per-engine 默认模型行（engine-provider-unification D5）：有清单的引擎渲染 Select；
           pi 行只渲染说明文案（S4 零配置叙事）；无清单引擎不渲染行。 -->
      <SettingRow
        v-for="row in modelRows"
        :key="row.engine"
        :label="t('settings.subagentEngine.modelLabel', { engine: row.engine })"
        :desc="t('settings.subagentEngine.modelDesc')"
      >
        <Select
          :model-value="row.current"
          :disabled="loading || row.busy || loadError"
          @update:model-value="onModelChange(row.engine, $event)"
        >
          <SelectTrigger class="w-[200px]" :data-testid="`subagent-engine-model-${row.engine}`">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="m in row.options" :key="m.id" :value="m.id">{{ m.name ?? m.id }}</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        v-if="engines.includes(PI_ENGINE)"
        :label="t('settings.subagentEngine.modelLabel', { engine: PI_ENGINE })"
        :desc="t('settings.subagentEngine.piModelNote')"
        data-testid="subagent-engine-pi-note"
      />
    </div>
  </GroupCard>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle } from '@lucide/vue'
import type { SubagentEngineModelInfo } from '@taiji/shared'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { GroupCard } from '@taiji/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import { getSettingsTransport } from '@taiji/core'
import { createSettingFieldGroup, type SettingField } from '@/composables/features/settings/setting-field'

// [C3] settings 域 transport 只经 SettingsTransport seam（禁直连门面 / 禁深 import transport 域）
const transport = getSettingsTransport()

const { t } = useI18n()

/** 默认引擎占位值（load 失败时明确渲染为默认而非已存值，禁止把默认值当已存值操作——RD-4#8）。 */
const DEFAULT_ENGINE = 'pi'
/** pi 引擎：模型由 pi 自身解析（S4），不渲染模型选择，只渲染说明文案行。 */
const PI_ENGINE = 'pi'

// 引擎清单来自 runtime（extension engines.json 动态同步——未来新增引擎零改动出现在此）；
// 初始与 load 失败时保留默认占位，配合 loadError 禁用防止误操作
const engines = ref<string[]>([DEFAULT_ENGINE])
/** per-engine 可选模型清单（D5 reply 扩展键，缺省空表 = 全引擎无清单不渲染模型行）。 */
const engineModels = ref<Record<string, SubagentEngineModelInfo[]>>({})

// ── 字段编排走 setting-field module：load 失败归并 loadError + 乐观写/失败回滚/toast ──
const group = createSettingFieldGroup()
const loadError = group.loadError

const engineField = group.field<string>(DEFAULT_ENGINE, {
  // 受控 Select 显示恒跟随 value：乐观写立即前进，失败回滚即回弹旧值；resolve engineId = 权威回填
  save: (next) => transport.setSubagentDefaultEngine(next).then((res) => res.engineId),
  savedToastKey: 'settings.subagentEngine.saved',
  saveFailedToastKey: 'settings.subagentEngine.saveFailed',
})
const current = engineField.value
const saving = engineField.busy

/**
 * per-engine 默认模型字段（shallowRef：field 对象含内部 Ref（value/busy），深度 reactive 会
 * 把嵌套 Ref 自动解包、破坏 SettingField 语义，浅层只在重赋值（重拉）时触发行重算）。
 * load 后按「有清单的引擎」逐个创建；save resolve modelRef = 权威回填（runtime 校验后的 ref）。
 */
const modelFields = shallowRef<Record<string, SettingField<string>>>({})

/** 模型行视图模型：有清单且非 pi 的引擎各一行（current/busy 快照随乐观写/回滚响应式更新）。 */
const modelRows = computed(() => {
  const rows: Array<{ engine: string; options: SubagentEngineModelInfo[]; current: string; busy: boolean }> = []
  for (const engine of engines.value) {
    if (engine === PI_ENGINE) continue
    const options = engineModels.value[engine]
    const field = modelFields.value[engine]
    if (!options?.length || !field) continue
    rows.push({ engine, options, current: field.value.value, busy: field.busy.value })
  }
  return rows
})

// 单次 getSubagentEngineConfig 共享回填引擎清单 / 模型清单 / 默认引擎 / 模型偏好四路数据
group.registerLoader(async () => {
  const config = await transport.getSubagentEngineConfig()
  engines.value = config.engines
  engineModels.value = config.engineModels ?? {}
  engineField.reset(config.defaultEngine)
  const defaults = config.engineDefaults ?? {}
  const fields: Record<string, SettingField<string>> = {}
  for (const engine of config.engines) {
    if (engine === PI_ENGINE) continue
    if (!(config.engineModels?.[engine]?.length)) continue
    fields[engine] = group.field<string>(defaults[engine] ?? '', {
      save: (next) => transport.setSubagentEngineDefaultModel(engine, next).then((res) => res.modelRef),
      savedToastKey: 'settings.subagentEngine.saved',
      saveFailedToastKey: 'settings.subagentEngine.modelSaveFailed',
    })
  }
  modelFields.value = fields
})
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

/** 模型 Select change：定位该引擎的 field，persist 编排与引擎切换同款。 */
function onModelChange(engine: string, value: unknown): void {
  if (typeof value !== 'string' || value === '') return
  const field = modelFields.value[engine]
  if (!field) return
  void field.persist(value)
}
</script>
