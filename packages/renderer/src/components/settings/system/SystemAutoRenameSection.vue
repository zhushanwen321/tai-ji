<template>
  <GroupCard :title="t('settings.system.autoRenameSession')">
    <!-- RD-4#8：读配置失败常驻提示（默认值非已存值）+ 重试；控件禁用直到重拉成功 -->
    <div
      v-if="loadError"
      data-testid="auto-rename-load-error"
      class="flex items-center gap-2 px-2.5 pt-2 pb-1 text-[11px] text-warn"
    >
      <AlertTriangle class="size-3.5 shrink-0" />
      <span>{{ t('settings.system.loadErrorHint') }}</span>
      <Button
        variant="ghost"
        size="sm"
        class="h-5 px-1.5 text-[11px] text-accent"
        data-testid="auto-rename-load-retry"
        @click="loadConfig"
      >{{ t('settings.system.loadErrorRetry') }}</Button>
    </div>
    <div class="px-2.5 pt-1 pb-2">
      <SettingRow :label="t('settings.system.autoRenameSession')" :desc="t('settings.system.autoRenameDesc')">
        <Switch
          data-testid="setting-auto-rename-session"
          :model-value="autoRenameEnabled"
          :disabled="autoRenameBusy || loadError"
          @update:model-value="autoRenameEnabledField.persist"
        />
      </SettingRow>
      <SettingRow :label="t('settings.system.renameMode')" :desc="t('settings.system.renameModeHint')">
        <Select
          :model-value="renameMode"
          :disabled="renameModeBusy || loadError"
          @update:model-value="onRenameModeChange"
        >
          <SelectTrigger class="h-8 w-[200px] px-2 text-xs" data-testid="setting-rename-mode">
            <SelectValue :placeholder="t('settings.system.renameMode')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="opt in RENAME_MODE_OPTIONS" :key="opt.value" :value="opt.value">
              {{ t(opt.labelKey) }}
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow :label="t('settings.system.renameModel')" :desc="t('settings.system.renameModelHint')">
        <Select
          :model-value="selectedValue"
          :disabled="!autoRenameEnabled || renameModelBusy || loadError"
          @update:model-value="onRenameModelChange"
        >
          <SelectTrigger class="h-8 w-[200px] px-2 text-xs" data-testid="setting-rename-model">
            <SelectValue :placeholder="t('settings.system.renameModelFollow')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="MODEL_UNSET_SENTINEL">{{ t('settings.system.renameModelFollow') }}</SelectItem>
            <SelectGroup v-for="group in modelGroups" :key="group.providerId">
              <SelectLabel>{{ group.providerName }}</SelectLabel>
              <SelectItem v-for="m in group.models" :key="m.value" :value="m.value">
                {{ m.label }}
              </SelectItem>
            </SelectGroup>
            <!-- 当前配置的 ref 不在可选列表（模型被删/provider 未配凭证）→ 保留显示供改选，标记不可用 -->
            <SelectItem v-if="staleRef" :value="staleRef" disabled>
              {{ staleRef }} {{ t('settings.system.renameModelUnavailable') }}
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
    </div>
  </GroupCard>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle } from '@lucide/vue'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { GroupCard } from '@taiji/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import { getSettingsTransport } from '@taiji/core'
import type { RenameMode } from '@taiji/shared'
import { createSettingFieldGroup, type SettingField } from '@/composables/features/settings/setting-field'
import {
  MODEL_UNSET_SENTINEL,
  fromSelectValue,
  staleModelRef,
  toSelectValue,
  useAuthedModelGroups,
} from '@/composables/features/settings/useAuthedModelGroups'

// [C3] settings 域 transport 只经 SettingsTransport seam（禁直连门面 / 禁深 import transport 域）
const transport = getSettingsTransport()

const { t } = useI18n()

// ── 字段编排组（setting-field module）：加载归并（RD-4#8 loadError）+ 乐观更新/回滚/toast/回填 ──
const group = createSettingFieldGroup()
const loadError = group.loadError

// ── 会话自动重命名开关（独立 flag file，不走 SystemSettings 体系）──
const autoRenameEnabledField = group.field<boolean>(true, {
  load: () => transport.getAutoRenameEnabled().then((res) => res.enabled),
  // resolve void = 开关无权威回填语义（API 无归一），乐观值即生效值
  save: (next) => transport.setAutoRenameEnabled(next).then(() => undefined),
})
const autoRenameEnabled = autoRenameEnabledField.value
const autoRenameBusy = autoRenameEnabledField.busy

/** 触发模式选项（值域 = shared protocol RenameMode；排列 = 触发时点从早到晚，agent 模式殿后）。 */
const RENAME_MODE_OPTIONS: ReadonlyArray<{ value: RenameMode; labelKey: string }> = [
  { value: 'first-prompt', labelKey: 'settings.system.renameModeFirstPrompt' },
  { value: 'first-stop', labelKey: 'settings.system.renameModeFirstStop' },
  { value: 'agent-tool', labelKey: 'settings.system.renameModeAgentTool' },
]

/** Select 载荷收窄 guard（禁 any：运行时校验后才交给 setRenameMode）。 */
function isRenameModeValue(value: unknown): value is RenameMode {
  return typeof value === 'string' && RENAME_MODE_OPTIONS.some((o) => o.value === value)
}

// ── 触发模式（三选一，默认 first-stop；与开关独立——agent-tool 的 rename_session 工具注册
//    不受开关 flag 门控，extension 侧 load 时只看 mode，故本行不随开关 disabled）──
// 显式类型标注：savedToastKey 闭包引用本字段自身，不标注会构成自引用初始化环（TS7022）
const renameModeField: SettingField<RenameMode> = group.field<RenameMode>('first-stop', {
  load: () => transport.getRenameMode().then((res) => res.mode),
  // 成功后回填 runtime 归一后的生效值（reply.mode，非法值由 runtime 归一为默认 first-stop），
  // 避免本地乐观值与实际生效值漂移
  save: (next) => transport.setRenameMode(next).then((reply) => reply.mode),
  // 设计 D1 求值时点边界：事件面 live 生效、工具面（rename_session 注册）只对新会话生效——
  // 开关关 + 自动模式组合下自动路径被 enabled flag 拦截（D1 正交契约：flag 只门控自动路径），
  // 换提示指明恢复动作，不承诺不会发生的「已生效」。开关值在保存完成时求值。
  savedToastKey: () =>
    !autoRenameEnabled.value && renameModeField.value.value !== 'agent-tool'
      ? 'settings.system.renameModeSwitchedAutoDisabled'
      : 'settings.system.renameModeSwitched',
})
const renameMode = renameModeField.value
const renameModeBusy = renameModeField.busy

// ── 重命名模型（extension 配置文件，"provider/modelId" 复合串，空串 = 未设置）──
const renameModelField = group.field<string>('', {
  load: () => transport.getRenameModel().then((res) => res.model),
  save: (next) => transport.setRenameModel(next).then((reply) => reply.model),
})
const renameModel = renameModelField.value
const renameModelBusy = renameModelField.busy

// 可选模型分组 / sentinel / stale 判定共享实现（与 SystemSmartContextSection 同源）
const { modelGroups, availableValues } = useAuthedModelGroups()

/** Select 受控值：空串 → sentinel；否则原样 ref（不在列表时由 staleRef 项兜底显示）。 */
const selectedValue = computed(() => toSelectValue(renameModel.value))

/** 当前 ref 不在可选列表时返回该 ref（渲染 disabled 兜底项），否则 null。 */
const staleRef = computed(() => staleModelRef(renameModel.value, availableValues.value))

async function loadConfig(): Promise<void> {
  // 三个字段独立加载（便捷 load 已注册进 group），任一失败即置 loadError（loadAll 归并）
  await group.loadAll()
}

onMounted(() => {
  void loadConfig()
})

/** Select change：sentinel → 空串（跟随会话模型）；乐观更新 + 成功回填生效值 + 失败回滚。 */
function onRenameModelChange(value: unknown): void {
  void renameModelField.persist(fromSelectValue(value))
}

/** Select change：sentinel/guard 后乐观更新；成功提示按开关状态分流（见 savedToastKey）。 */
function onRenameModeChange(value: unknown): void {
  if (!isRenameModeValue(value) || value === renameMode.value) return
  void renameModeField.persist(value)
}
</script>
