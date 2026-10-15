<template>
  <!-- [w2] demo 对照：SystemSection.vue「智能上下文压缩」卡——阈值行 = UiInput w72 ×3 +
       neutral-mid「/」分隔 + srow-desc「K」；排除 chips = mono t-note + dashed border-strong
       999px 圆角 + padding 2px 8px + 24px 命中区负 margin 移除钮；添加钮 = btn ghost（plus 12px）。
       real 的添加走 Select 下拉（功能结构，demo 为 mock 逐个添加），形态对齐 ghost。 -->
  <GroupCard :title="t('settings.system.smartContextTitle')">
    <div class="px-[10px] pt-[4px] pb-[8px]">
      <!-- RD-4#8：读配置失败常驻提示（默认值非已存值）+ 重试；控件禁用直到重拉成功 -->
      <div
        v-if="loadError"
        data-testid="smart-context-load-error"
        class="mb-2 flex items-center gap-2 rounded-md border border-[color-mix(in_oklch,var(--warn)_40%,transparent)] bg-warn-soft px-3 py-1.5 text-[length:var(--text-2xs)] text-warn"
      >
        <AlertTriangle class="size-3.5 shrink-0" />
        <span>{{ t('settings.system.loadErrorHint') }}</span>
        <Button
          variant="ghost"
          size="sm"
          class="h-5 px-1.5 text-[length:var(--text-2xs)] text-accent"
          data-testid="smart-context-load-retry"
          @click="loadConfig"
        >{{ t('settings.system.loadErrorRetry') }}</Button>
      </div>
      <SettingRow :label="t('settings.system.smartContextEnable')" :desc="t('settings.system.smartContextDesc')">
        <Switch
          data-testid="setting-smart-context-switch"
          :model-value="enabled"
          :disabled="toggling || loadError"
          @update:model-value="enabledField.persist"
        />
      </SettingRow>
      <SettingRow :label="t('settings.system.smartContextModelLabel')" :desc="t('settings.system.smartContextModelHint')">
        <Select
          :model-value="selectedValue"
          :disabled="!enabled || compactModelBusy || loadError"
          @update:model-value="onCompactModelChange"
        >
          <SelectTrigger class="w-[200px]" data-testid="setting-smart-context-model">
            <SelectValue :placeholder="t('settings.system.smartContextModelFollow')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="MODEL_UNSET_SENTINEL">{{ t('settings.system.smartContextModelFollow') }}</SelectItem>
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
      <SettingRow :label="t('settings.system.smartContextThresholdLabel')" :desc="t('settings.system.smartContextThresholdDesc')">
        <template v-for="(_tk, i) in thresholdsK" :key="i">
          <span v-if="i > 0" class="text-neutral-mid">/</span>
          <Input
            :data-testid="`setting-smart-context-threshold-${i + 1}`"
            v-model.number="thresholdsK[i]"
            type="number"
            :min="1"
            :step="1"
            :aria-label="`${t('settings.system.smartContextThresholdLabel')} ${i + 1}`"
            class="w-[72px]"
            :disabled="!enabled || thresholdsBusy || loadError"
            @change="onThresholdsSave"
          />
          <span class="text-[length:var(--text-sm)] text-neutral-fg-2">K</span>
        </template>
      </SettingRow>
      <SettingRow :label="t('settings.system.smartContextExcludedLabel')" :desc="t('settings.system.smartContextExcludedDesc')">
        <div data-testid="setting-smart-context-excluded" class="flex flex-wrap items-center gap-[6px]">
          <span
            v-for="model in excludedModels"
            :key="model"
            class="inline-flex max-w-[200px] items-center gap-1 rounded-full border border-dashed border-border-strong px-[8px] py-[2px] font-mono text-[length:var(--text-2xs)] text-neutral-fg-2"
          >
            <span class="truncate">{{ model }}</span>
            <!-- 24px 命中区：负 margin 补偿使 chip 视觉尺寸不变（demo 同款） -->
            <Button
              variant="ghost"
              class="m-[-7px] grid size-6 flex-none place-items-center rounded-full p-0 text-neutral-dim hover:text-neutral-fg"
              :title="t('settings.system.smartContextExcludedRemove')"
              @click="onExcludedRemove(model)"
            >
              <X class="size-[10px]" />
            </Button>
          </span>
          <Select
            :model-value="EXCLUDED_ADD_PLACEHOLDER"
            :disabled="!enabled || excludedBusy || addableGroups.length === 0 || loadError"
            @update:model-value="onExcludedAdd"
          >
            <SelectTrigger class="h-[32px] w-auto gap-1 border-0 bg-transparent px-[12px] text-[length:var(--text-sm)] text-neutral-mid">
              <Plus class="size-[12px]" />
              {{ t('settings.system.smartContextExcludedAdd') }}
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="EXCLUDED_ADD_PLACEHOLDER" disabled>
                {{ t('settings.system.smartContextExcludedAdd') }}
              </SelectItem>
              <SelectGroup v-for="group in addableGroups" :key="group.providerId">
                <SelectLabel>{{ group.providerName }}</SelectLabel>
                <SelectItem v-for="m in group.models" :key="m.value" :value="m.value">
                  {{ m.label }}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </SettingRow>
    </div>
  </GroupCard>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Plus, AlertTriangle } from '@lucide/vue'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { GroupCard } from '@taiji/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import { getSettingsTransport } from '@taiji/core'
import { createSettingFieldGroup } from '@/composables/features/settings/setting-field'
import {
  MODEL_UNSET_SENTINEL,
  fromSelectValue,
  staleModelRef,
  toSelectValue,
  useAuthedModelGroups,
  type AuthedModelGroup,
} from '@/composables/features/settings/useAuthedModelGroups'

// [C3] settings 域 transport 只经 SettingsTransport seam（禁直连门面 / 禁深 import transport 域）
const transport = getSettingsTransport()

const { t } = useI18n()

const TOKENS_PER_K = 1000

/** 默认 3 档阈值（K 显示值，对应 extension DEFAULT_REMINDER_THRESHOLDS 的 200K/400K/600K）。 */
// eslint-disable-next-line no-magic-numbers -- 200K/400K/600K 是与 pi-smart-context extension 契约对齐的默认档位
const DEFAULT_THRESHOLDS_K = [200, 400, 600]

// ── 字段编排组（setting-field module）：单 loader 拉全量回填 + per-field 乐观更新/回滚/toast/回填 ──
const group = createSettingFieldGroup()
const loadError = group.loadError

// ── 启用开关 ──
const enabledField = group.field<boolean>(true, {
  // resolve void = 开关无权威回填语义（API 无归一），乐观值即生效值
  save: (next) => transport.setSmartContextEnabled(next).then(() => undefined),
})
const enabled = enabledField.value
const toggling = enabledField.busy

// ── 压缩模型（"provider/modelId" 复合串，空串 = 跟随当前会话模型）──
const compactModelField = group.field<string>('', {
  save: (next) => transport.setSmartContextCompactModel(next).then(() => undefined),
})
const compactModel = compactModelField.value
const compactModelBusy = compactModelField.busy

// ── 3 档提醒阈值（GUI 显示 K，保存 ×1000 转绝对数）──
const thresholdsField = group.field<number[]>([...DEFAULT_THRESHOLDS_K], {
  // 非法正数校验拒绝：不调 RPC，回弹已保存基准 + 专属 toast（saveFailed 专属文案不弹）
  validate: (next) =>
    next.some((tk) => !Number.isFinite(tk) || tk <= 0) ? 'settings.system.smartContextThresholdInvalid' : null,
  // ×1000 落盘；成功回填 runtime clamp（升序 3 档）后的实际生效值
  save: (next) =>
    transport.setSmartContextThresholds(next.map((tk) => Math.round(tk * TOKENS_PER_K))).then((res) =>
      res.thresholds.map((tk) => tk / TOKENS_PER_K),
    ),
})
const thresholdsK = thresholdsField.value
const thresholdsBusy = thresholdsField.busy

// ── 排除模型（tag 列表 + Select 添加）──
const excludedField = group.field<string[]>([], {
  // 成功回填 runtime 过滤去重结果
  save: (next) => transport.setSmartContextExcludedModels(next).then((res) => res.models),
})
const excludedModels = excludedField.value
const excludedBusy = excludedField.busy

// 共享 loader：getSmartContextConfig 一次拉全量，4 个 field.reset 回填（基准由 reset 内化）
group.registerLoader(async () => {
  const cfg = await transport.getSmartContextConfig()
  enabledField.reset(cfg.enabled)
  compactModelField.reset(cfg.compactModel)
  thresholdsField.reset(cfg.reminderThresholds.map((tk) => tk / TOKENS_PER_K))
  excludedField.reset(cfg.excludedModels)
})

// 可选模型分组 / sentinel / stale 判定共享实现（useAuthedModelGroups composable）
const { modelGroups, availableValues } = useAuthedModelGroups()

const selectedValue = computed(() => toSelectValue(compactModel.value))

/** 当前 ref 不在可选列表时返回该 ref（渲染 disabled 兜底项），否则 null。 */
const staleRef = computed(() => staleModelRef(compactModel.value, availableValues.value))

/** 添加 Select 的占位项 value（受控值恒定 = 选择后回到占位，形成可反复添加的「菜单按钮」）。 */
const EXCLUDED_ADD_PLACEHOLDER = '__add__'

/** 可添加候选 = 已配凭证模型 − 已排除项（已排除的不再出现在添加下拉）。 */
const addableGroups = computed<AuthedModelGroup[]>(() => {
  const excluded = new Set(excludedModels.value)
  return modelGroups.value
    .map((g) => ({ ...g, models: g.models.filter((m) => !excluded.has(m.value)) }))
    .filter((g) => g.models.length > 0)
})

async function loadConfig(): Promise<void> {
  await group.loadAll()
}

onMounted(() => {
  void loadConfig()
})

/** Select change：sentinel → 空串（跟随当前会话模型）；乐观更新 + 失败回滚。 */
function onCompactModelChange(value: unknown): void {
  void compactModelField.persist(fromSelectValue(value))
}

/** 阈值 change（失焦/回车）：v-model 已直改 value → persist 读当前值过 validate 后 ×1000 保存。 */
function onThresholdsSave(): void {
  void thresholdsField.persist(thresholdsK.value)
}

function onExcludedAdd(value: unknown): void {
  if (typeof value !== 'string' || value === EXCLUDED_ADD_PLACEHOLDER) return
  if (excludedModels.value.includes(value)) return
  void excludedField.persist([...excludedModels.value, value])
}

function onExcludedRemove(model: string): void {
  void excludedField.persist(excludedModels.value.filter((m) => m !== model))
}
</script>
