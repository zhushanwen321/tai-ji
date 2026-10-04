<template>
  <GroupCard :title="t('settings.system.smartContextTitle')">
    <div class="px-2.5 pt-1 pb-2">
      <!-- RD-4#8：读配置失败常驻提示（默认值非已存值）+ 重试；控件禁用直到重拉成功 -->
      <div
        v-if="loadError"
        data-testid="smart-context-load-error"
        class="mb-2 flex items-center gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-1.5 text-[11px] text-warn"
      >
        <AlertTriangle class="size-3.5 shrink-0" />
        <span>{{ t('settings.system.loadErrorHint') }}</span>
        <Button
          variant="ghost"
          size="sm"
          class="h-5 px-1.5 text-[11px] text-accent"
          data-testid="smart-context-load-retry"
          @click="loadConfig"
        >{{ t('settings.system.loadErrorRetry') }}</Button>
      </div>
      <SettingRow :label="t('settings.system.smartContextEnable')" :desc="t('settings.system.smartContextDesc')">
        <Switch
          data-testid="setting-smart-context-switch"
          :model-value="enabled"
          :disabled="toggling || loadError"
          @update:model-value="onSaveEnabled"
        />
      </SettingRow>
      <SettingRow :label="t('settings.system.smartContextModelLabel')" :desc="t('settings.system.smartContextModelHint')">
        <Select
          :model-value="selectedValue"
          :disabled="!enabled || savingCompactModel || loadError"
          @update:model-value="onCompactModelChange"
        >
          <SelectTrigger class="h-8 w-[200px] px-2 text-xs" data-testid="setting-smart-context-model">
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
          <span v-if="i > 0" class="text-neutral-faint text-xs">/</span>
          <Input
            :data-testid="`setting-smart-context-threshold-${i + 1}`"
            v-model.number="thresholdsK[i]"
            type="number"
            :min="1"
            :step="1"
            :aria-label="`${t('settings.system.smartContextThresholdLabel')} ${i + 1}`"
            class="h-8 w-[72px] px-2 text-right font-mono text-xs"
            :disabled="!enabled || savingThresholds || loadError"
            @change="onThresholdsSave"
          />
          <span class="text-neutral-dim font-mono text-xs">K</span>
        </template>
      </SettingRow>
      <SettingRow :label="t('settings.system.smartContextExcludedLabel')" :desc="t('settings.system.smartContextExcludedDesc')">
        <div data-testid="setting-smart-context-excluded" class="flex max-w-[320px] flex-wrap items-center justify-end gap-1.5">
          <span
            v-for="model in excludedModels"
            :key="model"
            class="inline-flex max-w-[200px] items-center gap-1 rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-neutral-mid"
          >
            <span class="truncate">{{ model }}</span>
            <Button
              variant="ghost"
              class="grid size-4 shrink-0 place-items-center rounded-sm p-0 text-neutral-dim hover:text-neutral-fg"
              :title="t('settings.system.smartContextExcludedRemove')"
              @click="onExcludedRemove(model)"
            >
              <X class="size-3" />
            </Button>
          </span>
          <Select
            :model-value="EXCLUDED_ADD_PLACEHOLDER"
            :disabled="!enabled || savingExcluded || addableGroups.length === 0 || loadError"
            @update:model-value="onExcludedAdd"
          >
            <SelectTrigger class="h-6 gap-1 rounded-sm border border-dashed border-border-strong px-2 text-xs text-neutral-dim">
              <Plus class="size-3" />
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
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Plus, AlertTriangle } from '@lucide/vue'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { GroupCard } from '@taiji/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import { type SystemSettings } from '@taiji/core'
import {
  getSmartContextConfig,
  setSmartContextCompactModel,
  setSmartContextEnabled,
  setSmartContextExcludedModels,
  setSmartContextThresholds,
} from '@taiji/core/transport/api/domains/settings'
import { useToast } from '@/composables/useToast'
import {
  MODEL_UNSET_SENTINEL,
  fromSelectValue,
  staleModelRef,
  toSelectValue,
  useAuthedModelGroups,
  type AuthedModelGroup,
} from '@/composables/features/settings/useAuthedModelGroups'

// 统一 Section 契约（未使用 system：smart-context 走独立 API；不 emit：变更经各自 API 持久化）
defineProps<{
  system: SystemSettings
}>()

defineEmits<{
  update: [patch: Partial<SystemSettings>]
}>()

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

const TOKENS_PER_K = 1000

/** 默认 3 档阈值（K 显示值，对应 extension DEFAULT_REMINDER_THRESHOLDS 的 200K/400K/600K）。 */
// eslint-disable-next-line no-magic-numbers -- 200K/400K/600K 是与 pi-smart-context extension 契约对齐的默认档位
const DEFAULT_THRESHOLDS_K = [200, 400, 600]

// ── 启用开关（独立字段，乐观更新 + 失败回滚）──
const enabled = ref(true)
const toggling = ref(false)

// ── 压缩模型（"provider/modelId" 复合串，空串 = 跟随当前会话模型）──
const compactModel = ref('')
const savingCompactModel = ref(false)

// 可选模型分组 / sentinel / stale 判定共享实现（与 SystemAutoRenameSection 同源）
const { modelGroups, availableValues } = useAuthedModelGroups()

const selectedValue = computed(() => toSelectValue(compactModel.value))

/** 当前 ref 不在可选列表时返回该 ref（渲染 disabled 兜底项），否则 null。 */
const staleRef = computed(() => staleModelRef(compactModel.value, availableValues.value))

// ── 3 档提醒阈值（GUI 显示 K，保存 ×1000 转绝对数）──
const thresholdsK = ref<number[]>([...DEFAULT_THRESHOLDS_K])
/** 已加载/已保存的回滚基准（K）。 */
const loadedThresholdsK = ref<number[]>([...DEFAULT_THRESHOLDS_K])
const savingThresholds = ref(false)

// ── 排除模型（tag 列表 + Select 添加）──
const excludedModels = ref<string[]>([])
const savingExcluded = ref(false)

/** 添加 Select 的占位项 value（受控值恒定 = 选择后回到占位，形成可反复添加的「菜单按钮」）。 */
const EXCLUDED_ADD_PLACEHOLDER = '__add__'

/** 可添加候选 = 已配凭证模型 − 已排除项（已排除的不再出现在添加下拉）。 */
const addableGroups = computed<AuthedModelGroup[]>(() => {
  const excluded = new Set(excludedModels.value)
  return modelGroups.value
    .map((g) => ({ ...g, models: g.models.filter((m) => !excluded.has(m.value)) }))
    .filter((g) => g.models.length > 0)
})

/** RD-4#8：读配置失败标志——置位时控件禁用 + 顶部常驻提示，禁止把默认值当已存值渲染。 */
const loadError = ref(false)

async function loadConfig(): Promise<void> {
  try {
    const cfg = await getSmartContextConfig()
    enabled.value = cfg.enabled
    compactModel.value = cfg.compactModel
    thresholdsK.value = cfg.reminderThresholds.map((tk) => tk / TOKENS_PER_K)
    loadedThresholdsK.value = [...thresholdsK.value]
    excludedModels.value = cfg.excludedModels
    loadError.value = false
  } catch (e) {
    // RD-4#8：读失败不再 best-effort 冒充已存值。此前 console.warn 后按默认值渲染（开关显
    // 「开」冒充已存值），误显的默认值会随用户操作直接落盘。现置 loadError → 控件禁用 +
    // 常驻提示 + 可重试，默认值明确标注为默认而非已存。
    console.warn('[SystemSmartContextSection] failed to load smart-context config:', e)
    loadError.value = true
  }
}

onMounted(() => {
  void loadConfig()
})

async function onSaveEnabled(next: boolean): Promise<void> {
  if (toggling.value) return
  toggling.value = true
  const prev = enabled.value
  enabled.value = next
  try {
    await setSmartContextEnabled(next)
    toastInfo(t('settings.system.saved'))
  } catch (e) {
    enabled.value = prev
    toastError(t('settings.system.saveFailed', { reason: e instanceof Error ? e.message : String(e) }))
  } finally {
    toggling.value = false
  }
}

/** Select change：sentinel → 空串（跟随当前会话模型）；乐观更新 + 失败回滚。 */
async function onCompactModelChange(value: unknown): Promise<void> {
  if (savingCompactModel.value) return
  const next = fromSelectValue(value)
  savingCompactModel.value = true
  const prev = compactModel.value
  compactModel.value = next
  try {
    await setSmartContextCompactModel(next)
    toastInfo(t('settings.system.saved'))
  } catch (e) {
    compactModel.value = prev
    toastError(t('settings.system.saveFailed', { reason: e instanceof Error ? e.message : String(e) }))
  } finally {
    savingCompactModel.value = false
  }
}

/** 阈值 change（失焦/回车）：校验正数 → ×1000 保存；成功回填 clamp 后结果，失败/非法回滚。 */
async function onThresholdsSave(): Promise<void> {
  if (savingThresholds.value) return
  const nums = thresholdsK.value
  if (nums.some((tk) => !Number.isFinite(tk) || tk <= 0)) {
    toastError(t('settings.system.smartContextThresholdInvalid'))
    thresholdsK.value = [...loadedThresholdsK.value]
    return
  }
  savingThresholds.value = true
  try {
    const res = await setSmartContextThresholds(nums.map((tk) => Math.round(tk * TOKENS_PER_K)))
    // runtime clamp（升序 3 档）可能与输入不同 → 回填实际生效值
    thresholdsK.value = res.thresholds.map((tk) => tk / TOKENS_PER_K)
    loadedThresholdsK.value = [...thresholdsK.value]
    toastInfo(t('settings.system.saved'))
  } catch (e) {
    thresholdsK.value = [...loadedThresholdsK.value]
    toastError(t('settings.system.saveFailed', { reason: e instanceof Error ? e.message : String(e) }))
  } finally {
    savingThresholds.value = false
  }
}

/** 持久化排除列表（乐观更新 + 失败回滚；成功回填 runtime 过滤去重结果）。 */
async function persistExcluded(next: string[]): Promise<void> {
  if (savingExcluded.value) return
  savingExcluded.value = true
  const prev = excludedModels.value
  excludedModels.value = next
  try {
    const res = await setSmartContextExcludedModels(next)
    excludedModels.value = res.models
    toastInfo(t('settings.system.saved'))
  } catch (e) {
    excludedModels.value = prev
    toastError(t('settings.system.saveFailed', { reason: e instanceof Error ? e.message : String(e) }))
  } finally {
    savingExcluded.value = false
  }
}

function onExcludedAdd(value: unknown): void {
  if (typeof value !== 'string' || value === EXCLUDED_ADD_PLACEHOLDER) return
  if (excludedModels.value.includes(value)) return
  void persistExcluded([...excludedModels.value, value])
}

function onExcludedRemove(model: string): void {
  void persistExcluded(excludedModels.value.filter((m) => m !== model))
}
</script>
