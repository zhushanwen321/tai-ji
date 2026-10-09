<!--
  TTS 选中服务商全量表单（ai-voice-tts 设计 §5.2 第 4 点；TtsPage 子组件）。

  控件存在性规则（§7.3 注，全部由表单投影 TtsFormModel 静态依赖数据驱动）：
  - 枚举类空数组 = 不渲染（emotions/languages/channels/长尾整区）
  - 数值类 null = 置灰（speedRange/volumeRange/pitchRange → disabled 下拉）
  - 开关/结构类不在清单 / 为 0 = 不渲染（toggles 清单 / maxTimbreVoices / voiceModify / 词典）
  全部内置选项不手填（§5.2 开篇）：数值档位由投影 range 生成下拉，无自由数字输入。

  Key 展示态归父级状态机（keyDisplay v-model）：无 Key 键入明文、已存 Key 展示 ***
  脱敏串、带入填充串/清除清空都只是页面填充——落盘统一走保存（armed 动作消费）。
  清除/带入只发事件；聚焦遇掩码态全选便于整体替换，失焦空值回填脱敏展示。
-->
<template>
  <div class="flex flex-col" :data-testid="`tts-form-${providerId}`">
    <!-- ── 凭据（[w3] 卡体 tight + SettingRow 行化，demo TtsSection 同款行范式）── -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.tts.credentialsSection') }}</h3>
        </div>
      </template>
      <div class="px-[10px] pb-[8px] pt-[4px]">
        <SettingRow :label="t('settings.tts.apiKeyLabel')">
          <div class="flex items-center gap-2">
            <Input
              :id="`tts-apikey-${providerId}`"
              v-model="keyDisplay"
              :data-testid="`tts-apikey-input-${providerId}`"
              type="text"
              autocomplete="off"
              :placeholder="hasApiKey ? t('settings.tts.apiKeySavedPlaceholder') : t('settings.tts.apiKeyPlaceholder')"
              :disabled="disabled"
              class="w-[320px] font-mono"
              @focus="onKeyFocus"
              @blur="emit('keyBlur')"
            />
            <Button
              v-if="hasApiKey"
              variant="ghost"
              :data-testid="`tts-apikey-clear-${providerId}`"
              :title="t('settings.tts.clearKeyTitle')"
              :aria-label="t('settings.tts.clearKey')"
              :aria-pressed="keyOp === 'clear'"
              class="h-[32px] px-[12px] text-[length:var(--text-sm)]"
              :class="keyOp === 'clear' ? '!bg-surface !text-neutral-fg' : ''"
              :disabled="disabled"
              @click="emit('clearKey')"
            >
              {{ t('settings.tts.clearKey') }}
            </Button>
          </div>
        </SettingRow>
        <!-- armed 待生效提示（点击动作按钮后可见，保存后消失） -->
        <p
          v-if="keyOp"
          :data-testid="`tts-keyop-pending-${providerId}`"
          class="px-[6px] pb-[4px] text-[length:var(--text-2xs)] text-neutral-mid"
        >
          {{ keyOp === 'clear' ? t('settings.tts.keyOpPendingClear') : t('settings.tts.keyOpPendingBring') }}
        </p>
        <!-- Key 联动提示（D4；providerKeyAvailable 由 runtime 判定，StepFun 恒 false 不渲染） -->
        <div
          v-if="providerKeyAvailable"
          :data-testid="`tts-key-link-hint-${providerId}`"
          class="mx-[6px] mb-[8px] flex items-center gap-2 rounded-md bg-surface-2 px-2.5 py-1.5 text-[length:var(--text-xs)] text-neutral-mid"
        >
          <KeyRound class="size-[14px] shrink-0" aria-hidden="true" />
          <span class="flex-1">{{ t('settings.tts.providerKeyLinked') }}</span>
          <Button
            variant="secondary"
            :data-testid="`tts-key-bring-${providerId}`"
            :aria-pressed="keyOp === 'bring'"
            class="h-[32px] px-[12px] text-[length:var(--text-sm)]"
            :class="keyOp === 'bring' ? '!border-accent !bg-surface' : ''"
            :disabled="disabled"
            @click="emit('bringKey')"
          >
            {{ t('settings.tts.bringFromProvider') }}
          </Button>
        </div>
        <SettingRow :label="t('settings.tts.baseUrlLabel')">
          <Select v-model="state.baseUrl" :disabled="disabled">
            <SelectTrigger :id="`tts-baseurl-${providerId}`" :data-testid="`tts-baseurl-select-${providerId}`" class="w-[320px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="opt in form.baseUrlOptions" :key="opt.url" :value="opt.url" :data-testid="`tts-baseurl-option-${providerId}`">
                {{ opt.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </div>
    </GroupCard>

    <!-- ── 基础（模型/音色恒渲染；语速/音量/音调按值域 null 置灰：desc 注记 + 「—」占位）── -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.tts.basicSection') }}</h3>
        </div>
      </template>
      <div class="px-[10px] pb-[8px] pt-[4px]">
        <SettingRow :label="t('settings.tts.modelLabel')">
          <Select v-model="state.model" :disabled="disabled">
            <SelectTrigger :id="`tts-model-${providerId}`" :data-testid="`tts-model-select-${providerId}`" class="w-[320px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="opt in form.models" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow :label="t('settings.tts.voiceLabel')">
          <Select v-model="state.voice" :disabled="disabled">
            <SelectTrigger :id="`tts-voice-${providerId}`" :data-testid="`tts-voice-select-${providerId}`" class="w-[320px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="opt in form.voices" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          :label="t('settings.tts.speedLabel')"
          :desc="speedOpts.length === 0 ? t('settings.tts.notSupportedHint') : undefined"
        >
          <Select v-model="speedModel" :disabled="disabled || speedOpts.length === 0">
            <SelectTrigger :id="`tts-speed-${providerId}`" :data-testid="`tts-speed-select-${providerId}`" class="w-[160px]">
              <SelectValue :placeholder="speedOpts.length > 0 ? undefined : '—'" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="opt in speedOpts" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          :label="t('settings.tts.volumeLabel')"
          :desc="volumeOpts.length === 0 ? t('settings.tts.notSupportedHint') : undefined"
        >
          <Select v-model="volumeModel" :disabled="disabled || volumeOpts.length === 0">
            <SelectTrigger :id="`tts-volume-${providerId}`" :data-testid="`tts-volume-select-${providerId}`" class="w-[160px]">
              <SelectValue :placeholder="volumeOpts.length > 0 ? undefined : '—'" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="opt in volumeOpts" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          :label="t('settings.tts.pitchLabel')"
          :desc="pitchOpts.length === 0 ? t('settings.tts.notSupportedHint') : undefined"
        >
          <Select v-model="pitchModel" :disabled="disabled || pitchOpts.length === 0">
            <SelectTrigger :id="`tts-pitch-${providerId}`" :data-testid="`tts-pitch-select-${providerId}`" class="w-[160px]">
              <SelectValue :placeholder="pitchOpts.length > 0 ? undefined : '—'" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="opt in pitchOpts" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </div>
    </GroupCard>

    <!-- ── 音频（采样率 + 声道；输出格式与比特率不进 M0 表单，D9）── -->
    <GroupCard v-if="hasAudioSection">
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.tts.audioSection') }}</h3>
        </div>
      </template>
      <div class="px-[10px] pb-[8px] pt-[4px]">
        <SettingRow v-if="sampleRateOpts.length > 0" :label="t('settings.tts.sampleRateLabel')">
          <Select v-model="sampleRateModel" :disabled="disabled">
            <SelectTrigger :id="`tts-samplerate-${providerId}`" :data-testid="`tts-samplerate-select-${providerId}`" class="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="opt in sampleRateOpts" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow v-if="form.channels.length > 0" :label="t('settings.tts.channelLabel')">
          <Select v-model="channelModel" :disabled="disabled">
            <SelectTrigger :id="`tts-channel-${providerId}`" :data-testid="`tts-channel-select-${providerId}`" class="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="opt in form.channels" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </div>
    </GroupCard>

    <!-- ── 风格（指令/情感/音色标签/风格区开关/语言增强；全空整卡不渲染）── -->
    <GroupCard v-if="hasStyleSection">
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.tts.styleSection') }}</h3>
        </div>
      </template>
      <div class="px-[10px] pb-[8px] pt-[4px]">
        <!-- 风格指令 = demo .vrow 纵排（标签在上 + 全宽 textarea，W2 TerminalPage vrow 同款） -->
        <div v-if="form.capabilities.supportsInstructions" class="flex flex-col gap-[6px] border-t border-hairline py-[10px] first:border-t-0">
          <!-- 指令置灰只对 perModel 显式 null 条目生效；无条目（undefined）= 默认支持、无上限不置灰 -->
          <Label class="text-[length:var(--text-2xs)] font-normal text-[color:var(--neutral-fg-2)]" :for="`tts-instructions-${providerId}`">{{ t('settings.tts.instructionsLabel') }}</Label>
          <Textarea
            :id="`tts-instructions-${providerId}`"
            v-model="state.instructions"
            :data-testid="`tts-instructions-input-${providerId}`"
            :placeholder="t('settings.tts.instructionsPlaceholder')"
            :maxlength="instructionMaxChars ?? undefined"
            :disabled="disabled || instructionMaxChars === null"
            class="min-h-[64px]"
          />
        </div>
        <SettingRow v-if="form.emotions.length > 0" :label="t('settings.tts.emotionLabel')">
          <Select v-model="emotionModel" :disabled="disabled">
            <SelectTrigger :id="`tts-emotion-${providerId}`" :data-testid="`tts-emotion-select-${providerId}`" class="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="NONE_OPTION_ID" :data-testid="`tts-emotion-none-${providerId}`">{{ t('settings.tts.emotionNone') }}</SelectItem>
              <SelectItem v-for="opt in form.emotions" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <!-- 音色标签（StepFun voice_label；perModel 表非空才携带，选中模型不支持则置灰） -->
        <SettingRow v-if="showVoiceLabel" :label="t('settings.tts.voiceTagLabel')">
          <div class="flex items-center gap-2">
            <Select :model-value="NONE_OPTION_ID" :disabled="true">
              <SelectTrigger :id="`tts-voicetag-${providerId}`" :data-testid="`tts-voicetag-select-${providerId}`" class="w-[220px]">
                <SelectValue :placeholder="t('settings.tts.voiceTagNone')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="NONE_OPTION_ID">{{ t('settings.tts.voiceTagNone') }}</SelectItem>
              </SelectContent>
            </Select>
            <span v-if="!voiceLabelSupported" class="text-[length:var(--text-xs)] text-[var(--neutral-dim)]">{{ t('settings.tts.voiceTagDisabledHint') }}</span>
          </div>
        </SettingRow>
        <SettingRow v-for="id in styleToggles" :key="id" :label="t(`settings.tts.toggle.${id}`)">
          <Switch
            :id="`tts-toggle-${providerId}-${id}`"
            :data-testid="`tts-toggle-${providerId}-${id}`"
            :model-value="state.toggles[id] === true"
            :disabled="disabled"
            @update:model-value="state.toggles[id] = $event === true"
          />
        </SettingRow>
        <SettingRow v-if="form.languages.length > 0" :label="t('settings.tts.languageBoostLabel')">
          <Select v-model="languageModel" :disabled="disabled">
            <SelectTrigger :id="`tts-lang-${providerId}`" :data-testid="`tts-lang-select-${providerId}`" class="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="NONE_OPTION_ID">{{ t('settings.tts.languageBoostNone') }}</SelectItem>
              <SelectItem v-for="opt in form.languages" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </div>
    </GroupCard>

    <!-- ── 进阶（长尾四区：混合音色/效果器/词典/长尾区开关；全空整卡不渲染；demo mock 投影为空无对应形态，
         字段行跟随 SettingRow 范式、分节标题 = W1 PiPresets 分节档）── -->
    <GroupCard v-if="hasLongtailSection">
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.tts.longtailSection') }}</h3>
        </div>
      </template>
      <div class="px-[10px] pb-[8px] pt-[4px]">
        <div v-if="form.maxTimbreVoices > 0" class="flex flex-col border-t border-hairline py-[10px] first:border-t-0">
          <span class="text-[length:var(--text-xs)] font-semibold text-[color:var(--neutral-fg-2)]">{{ t('settings.tts.timbreSection') }}</span>
          <SettingRow class="mt-[4px]" :label="t('settings.tts.secondVoiceLabel')">
            <Select v-model="secondVoiceModel" :disabled="disabled">
              <SelectTrigger :id="`tts-secondvoice-${providerId}`" :data-testid="`tts-secondvoice-select-${providerId}`" class="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="NONE_OPTION_ID" :data-testid="`tts-secondvoice-none-${providerId}`">{{ t('settings.tts.secondVoiceNone') }}</SelectItem>
                <SelectItem v-for="opt in form.voices" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow v-if="state.secondVoice" :label="t('settings.tts.secondVoiceWeightLabel')">
            <Select v-model="state.secondVoiceWeight" :disabled="disabled">
              <SelectTrigger :id="`tts-weight-${providerId}`" :data-testid="`tts-weight-select-${providerId}`" class="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="opt in weightOpts" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        </div>
        <div v-if="form.voiceModify" class="flex flex-col border-t border-hairline py-[10px]">
          <span class="text-[length:var(--text-xs)] font-semibold text-[color:var(--neutral-fg-2)]">{{ t('settings.tts.voiceModifySection') }}</span>
          <SettingRow v-for="tier in form.voiceModify.tiers" :key="tier.id" class="mt-[4px]" :label="tier.label">
            <Select v-model="state.voiceModifyValues[tier.id]" :disabled="disabled">
              <SelectTrigger :id="`tts-vm-${providerId}-${tier.id}`" :data-testid="`tts-vm-${providerId}-${tier.id}`" class="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="opt in modifyOpts" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow v-if="form.voiceModify.effects.length > 0" :label="t('settings.tts.voiceModifyEffectLabel')">
            <Select v-model="voiceModifyEffectModel" :disabled="disabled">
              <SelectTrigger :id="`tts-vm-effect-${providerId}`" :data-testid="`tts-vm-effect-${providerId}`" class="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="NONE_OPTION_ID">{{ t('settings.tts.voiceModifyEffectNone') }}</SelectItem>
                <SelectItem v-for="opt in form.voiceModify.effects" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        </div>
        <SettingRow v-for="id in longtailToggles" :key="id" :label="t(`settings.tts.toggle.${id}`)">
          <Switch
            :id="`tts-toggle-${providerId}-${id}`"
            :data-testid="`tts-toggle-${providerId}-${id}`"
            :model-value="state.toggles[id] === true"
            :disabled="disabled"
            @update:model-value="state.toggles[id] = $event === true"
          />
        </SettingRow>
        <div v-if="form.hasPronunciationDict" class="flex flex-col gap-[6px] border-t border-hairline py-[10px]">
          <span class="text-[length:var(--text-xs)] font-semibold text-[color:var(--neutral-fg-2)]">{{ t('settings.tts.pronunciationSection') }}</span>
          <TtsPronunciationEditor v-model="state.pronunciationRules" :testid="providerId" :disabled="disabled" />
        </div>
      </div>
    </GroupCard>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { KeyRound } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { GroupCard } from '@taiji/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import TtsPronunciationEditor from './TtsPronunciationEditor.vue'
import {
  NONE_OPTION_ID,
  hasVoiceLabelControl,
  optionLabelWithSuffix,
  perModelOf,
  rangeOptions,
  speedOptions,
  timbreWeightOptions,
  voiceModifyOptions,
  isLongtailToggle,
  type TtsProviderFormState,
} from './tts-form-model'
import type { FormOption, TtsFormModel, TtsProviderId } from '@taiji/shared'

const { t } = useI18n()

const props = defineProps<{
  providerId: TtsProviderId
  form: TtsFormModel
  hasApiKey: boolean
  providerKeyAvailable: boolean
  /** 已 armed 的 Key 动作（清除/带入；保存时消费，armed 态驱动按钮按下样式 + 待生效提示）。 */
  keyOp?: 'clear' | 'bring' | null
  /** 展示值是否为掩码态（*** / 带入填充串；驱动聚焦全选）。 */
  keyMasked?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{ clearKey: []; bringKey: []; keyBlur: [] }>()

const state = defineModel<TtsProviderFormState>('state', { required: true })
const keyDisplay = defineModel<string>('keyDisplay', { required: true })

/** 掩码态聚焦全选：键入即整体替换，避免新字符追加在掩码串尾部。 */
function onKeyFocus(e: FocusEvent): void {
  if (props.keyMasked === true) (e.target as HTMLInputElement).select()
}

/** 「不指定」null 档 Select 中介（NONE 哨兵 ⇄ null；SelectItem value 不接受空串）。 */
function nullableModel(get: () => string | null, set: (v: string | null) => void) {
  return computed<string>({
    get: () => get() ?? NONE_OPTION_ID,
    set: (v) => set(v === NONE_OPTION_ID ? null : v),
  })
}

const speedOpts = computed(() => speedOptions(props.form))
const volumeOpts = computed(() => (props.form.volumeRange ? rangeOptions(props.form.volumeRange) : []))
const pitchOpts = computed(() => (props.form.pitchRange ? rangeOptions(props.form.pitchRange) : []))
const sampleRateOpts = computed<FormOption[]>(() =>
  props.form.capabilities.pcmSampleRates.map((rate) => ({ id: String(rate), label: t('settings.tts.sampleRateHz', { rate }) })),
)
const weightOpts = computed(() => optionLabelWithSuffix(timbreWeightOptions(), '%'))
const modifyOpts = computed(() => voiceModifyOptions())

const speedModel = nullableModel(
  () => state.value.speed,
  (v) => { state.value.speed = v },
)
const volumeModel = nullableModel(
  () => state.value.volume,
  (v) => { state.value.volume = v },
)
const pitchModel = nullableModel(
  () => state.value.pitch,
  (v) => { state.value.pitch = v },
)
const sampleRateModel = computed<string>({
  get: () => state.value.sampleRate ?? '',
  set: (v) => { state.value.sampleRate = v },
})
const channelModel = computed<string>({
  get: () => state.value.channel ?? '',
  set: (v) => { state.value.channel = v },
})
const emotionModel = nullableModel(
  () => state.value.emotion,
  (v) => { state.value.emotion = v },
)
const languageModel = nullableModel(
  () => state.value.languageBoost,
  (v) => { state.value.languageBoost = v },
)
const secondVoiceModel = nullableModel(
  () => state.value.secondVoice,
  (v) => { state.value.secondVoice = v },
)
const voiceModifyEffectModel = nullableModel(
  () => state.value.voiceModifyEffect,
  (v) => { state.value.voiceModifyEffect = v },
)

// per-model 联动（投影静态依赖数据驱动）
const perModel = computed(() => perModelOf(props.form, state.value.model))
const instructionMaxChars = computed(() => perModel.value.instructionMaxChars)
const showVoiceLabel = computed(() => hasVoiceLabelControl(props.form))
const voiceLabelSupported = computed(() => perModel.value.voiceLabelSupported)

// 分区开关（布局分区由投影组合判定，无厂商 id 分支）
const styleToggles = computed(() => props.form.toggles.filter((id) => !isLongtailToggle(id)))
const longtailToggles = computed(() => props.form.toggles.filter((id) => isLongtailToggle(id)))
const hasAudioSection = computed(() => sampleRateOpts.value.length > 0 || props.form.channels.length > 0)
const hasStyleSection = computed(
  () =>
    props.form.capabilities.supportsInstructions ||
    props.form.emotions.length > 0 ||
    showVoiceLabel.value ||
    styleToggles.value.length > 0 ||
    props.form.languages.length > 0,
)
const hasLongtailSection = computed(
  () =>
    props.form.maxTimbreVoices > 0 ||
    props.form.voiceModify !== null ||
    longtailToggles.value.length > 0 ||
    props.form.hasPronunciationDict,
)
</script>
