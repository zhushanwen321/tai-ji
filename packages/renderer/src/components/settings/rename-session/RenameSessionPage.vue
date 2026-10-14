<!--
  Settings · SessionRename 菜单页（rename-prompt-config 设计）。
  双卡片：基本设置（开关/触发模式/标题模型/最大长度，逐字段即时持久化）/ 标题提示词
  （风格 Select + 自定义指令 Textarea，显式保存三键 + 可折叠内置默认参考区）。
  数据层：SettingsTransport seam（config.get/setRenamePrompt 等四键）。
  范式参照 SystemPromptPage.vue（显式保存 + corrupted 提示 + 参考折叠区）；卡 1 用
  SettingRow + setting-field 逐字段乐观更新范式，卡 2 快照读取同注册进字段组 load 归并
  （读失败与卡 1 同禁用链）。
-->
<template>
  <div data-testid="rename-session-page" class="flex max-w-[860px] flex-col gap-3">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.sessionRename') }}</h1>
        <p class="desc">{{ t('settings.menu.sessionRenameDesc') }}</p>
      </div>
    </header>

    <!-- loadError 提示条：任一字段 load 失败（默认值非已存值）+ 重试 -->
    <div
      v-if="loadError"
      data-testid="rename-load-error"
      class="flex items-center gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-[12px] text-neutral-fg"
    >
      <AlertTriangle class="size-4 flex-shrink-0 text-warn" />
      <span>{{ t('settings.renameSession.loadErrorHint') }}</span>
      <Button
        variant="ghost"
        size="sm"
        class="h-5 px-1.5 text-[11px] text-accent"
        data-testid="rename-load-retry"
        @click="loadConfig"
      >{{ t('settings.renameSession.loadErrorRetry') }}</Button>
    </div>

    <!-- 卡 1：基本设置（#actions = 自动重命名开关） -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.renameSession.cardBasicTitle') }}</h3>
          <p class="gc-sub">{{ t('settings.renameSession.cardBasicSub') }}</p>
        </div>
      </template>
      <template #actions>
        <Switch
          data-testid="rename-enabled-switch"
          :model-value="autoRenameEnabled"
          :disabled="autoRenameBusy || loadError"
          @update:model-value="autoRenameEnabledField.persist"
        />
      </template>
      <div class="px-4 py-3">
        <SettingRow :label="t('settings.renameSession.triggerMode')" :desc="t('settings.renameSession.triggerModeHint')">
          <Select
            :model-value="renameMode"
            :disabled="renameModeBusy || loadError"
            @update:model-value="onRenameModeChange"
          >
            <SelectTrigger class="h-8 w-[180px] px-2 text-xs" data-testid="rename-trigger-mode">
              <SelectValue :placeholder="t('settings.renameSession.triggerMode')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="opt in TRIGGER_MODE_OPTIONS" :key="opt.value" :value="opt.value">
                {{ t(opt.labelKey) }}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow :label="t('settings.renameSession.renameModel')" :desc="t('settings.renameSession.renameModelHint')">
          <Select
            :model-value="selectedModelValue"
            :disabled="!autoRenameEnabled || renameModelBusy || loadError"
            @update:model-value="onRenameModelChange"
          >
            <SelectTrigger class="h-8 w-[200px] px-2 text-xs" data-testid="rename-title-model">
              <SelectValue :placeholder="t('settings.renameSession.renameModelFollow')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="MODEL_UNSET_SENTINEL">{{ t('settings.renameSession.renameModelFollow') }}</SelectItem>
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
        <SettingRow :label="t('settings.renameSession.maxLength')" :desc="t('settings.renameSession.maxLengthHint')">
          <Select
            :model-value="String(renameMaxLength)"
            :disabled="maxLengthBusy || loadError"
            @update:model-value="onMaxLengthChange"
          >
            <SelectTrigger class="h-8 w-[120px] px-2 text-xs" data-testid="rename-max-length">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="n in MAX_LENGTH_OPTIONS" :key="n" :value="String(n)">{{ n }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </div>
    </GroupCard>

    <!-- 卡 2：标题提示词（显式保存三键，SystemPromptPage 范式） -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.renameSession.cardPromptTitle') }}</h3>
          <p class="gc-sub">{{ t('settings.renameSession.cardPromptSub') }}</p>
        </div>
      </template>
      <div class="px-4 py-3">
        <!-- corrupted 提示条：getRenamePrompt 返回 corrupted=true 时显示 -->
        <div
          v-if="promptCorrupted"
          data-testid="rename-prompt-corrupted"
          class="mb-3 flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-[12px] text-neutral-fg"
        >
          <AlertTriangle class="mt-px size-4 flex-shrink-0 text-warn" />
          <span>{{ t('settings.renameSession.corruptedHint') }}</span>
        </div>

        <SettingRow :label="t('settings.renameSession.style')" :desc="t('settings.renameSession.styleHint')">
          <Select
            :model-value="promptStyle"
            :disabled="loadError"
            @update:model-value="onStyleChange"
          >
            <SelectTrigger class="h-8 w-[180px] px-2 text-xs" data-testid="rename-prompt-style">
              <SelectValue :placeholder="t('settings.renameSession.style')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="opt in STYLE_OPTIONS" :key="opt.value" :value="opt.value">
                {{ t(opt.labelKey) }}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <p data-testid="rename-style-example" class="mb-1 mt-2 text-[11px] text-neutral-dim">
          {{ t('settings.renameSession.exampleLabel') }}
          <span class="text-accent">{{ styleExample }}</span>
        </p>

        <Label class="mb-1 mt-2 block text-[11px] text-neutral-dim" for="rename-instruction-input">
          {{ t('settings.renameSession.instructionLabel') }}
        </Label>
        <Textarea
          id="rename-instruction-input"
          data-testid="rename-instruction-input"
          v-model="instructionDisplay"
          :disabled="promptStyle !== 'custom' || loadError"
          :placeholder="instructionPlaceholder"
          class="min-h-[120px] resize-y font-mono text-[12px]"
        />
        <div class="mt-1 flex items-center justify-between">
          <span
            data-testid="rename-instruction-charcount"
            class="font-mono text-[10px] text-neutral-dim"
            :class="{ 'text-warn': instructionOverLimit }"
          >{{ instructionCount }}/{{ RENAME_INSTRUCTION_MAX_LENGTH }}</span>
          <div class="flex items-center gap-1.5">
            <Button
              data-testid="rename-prompt-discard"
              variant="danger"
              size="dense"
              :disabled="!promptDirty || savingPrompt"
              @click="discardPrompt"
            >
              {{ t('settings.renameSession.discard') }}
            </Button>
            <Button
              data-testid="rename-prompt-reset"
              variant="secondary"
              size="dense"
              :disabled="!promptDirty || savingPrompt"
              @click="resetPrompt"
            >
              {{ t('settings.renameSession.restoreDefault') }}
            </Button>
            <Button
              data-testid="rename-prompt-save"
              size="dense"
              :disabled="!canSavePrompt"
              @click="savePrompt.run()"
            >
              {{ t('settings.renameSession.save') }}
            </Button>
          </div>
        </div>

        <!-- 可折叠：内置默认提示词参考（slug 风格，随 extension 版本升级） -->
        <div class="mt-3 border-t border-border pt-3">
          <Button
            data-testid="rename-prompt-ref-toggle"
            variant="ghost"
            size="sm"
            class="h-auto w-full justify-start gap-1 px-0 py-0 text-[11px] font-normal text-accent hover:bg-transparent hover:text-accent [&_svg]:size-3"
            @click="showRef = !showRef"
          >
            <ChevronRight class="transition-transform duration-[var(--duration)] ease-[var(--ease)]" :class="{ 'rotate-90': showRef }" />
            {{ t('settings.renameSession.refToggle') }}
          </Button>
          <div v-if="showRef" class="mt-2">
            <p class="mb-2 text-[10px] leading-relaxed text-neutral-dim">{{ t('settings.renameSession.refNote') }}</p>
            <Button
              data-testid="rename-prompt-ref-copy"
              variant="ghost"
              size="sm"
              class="mb-2 h-auto gap-1 px-0 py-0 text-[11px] text-neutral-dim hover:bg-transparent hover:text-neutral-fg [&_svg]:size-3"
              @click="copyRef"
            >
              <Copy />
              {{ t('settings.renameSession.copy') }}
            </Button>
            <pre
              data-testid="rename-prompt-ref-content"
              class="max-h-[240px] select-text overflow-auto whitespace-pre-wrap break-words rounded-sm bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-neutral-fg"
            >{{ REF_CONTENT }}</pre>
          </div>
        </div>
      </div>
    </GroupCard>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AlertTriangle, ChevronRight, Copy } from '@lucide/vue'
import { GroupCard } from '@taiji/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import { getSettingsTransport } from '@taiji/core'
import type { RenameMode, RenameStyle } from '@taiji/shared'
import { RENAME_INSTRUCTION_MAX_LENGTH } from '@taiji/shared'
import { BUILTIN_PREVIEW, SLUG_SYSTEM_PROMPT, STYLE_EXAMPLES } from './rename-prompt-constants'
import { useToast } from '@/composables/useToast'
import { createExplicitSave, createSettingFieldGroup, type SettingField } from '@/composables/features/settings/setting-field'
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
const { info, error } = useToast()

// ── 卡 1：基本设置（setting-field 逐字段编排组：乐观更新/回滚/toast/loadError 归并）──
const group = createSettingFieldGroup()
const loadError = group.loadError

const autoRenameEnabledField = group.field<boolean>(true, {
  load: () => transport.getAutoRenameEnabled().then((res) => res.enabled),
  save: (next) => transport.setAutoRenameEnabled(next).then(() => undefined),
})
const autoRenameEnabled = autoRenameEnabledField.value
const autoRenameBusy = autoRenameEnabledField.busy

/** 触发模式选项（rename-prompt-config：agent-tool 从 GUI 移除——底层 rename_session 工具保留，
 *  存量 agent-tool 配置仍生效，仅不再从设置页入口产生新配置）。 */
const TRIGGER_MODE_OPTIONS: ReadonlyArray<{ value: RenameMode; labelKey: string }> = [
  { value: 'first-prompt', labelKey: 'settings.renameSession.triggerModeFirstPrompt' },
  { value: 'first-stop', labelKey: 'settings.renameSession.triggerModeFirstStop' },
]

const renameModeField: SettingField<RenameMode> = group.field<RenameMode>('first-stop', {
  load: () => transport.getRenameMode().then((res) => res.mode),
  save: (next) => transport.setRenameMode(next).then((reply) => reply.mode),
  savedToastKey: 'settings.renameSession.triggerModeSwitched',
})
const renameMode = renameModeField.value
const renameModeBusy = renameModeField.busy

const renameModelField = group.field<string>('', {
  load: () => transport.getRenameModel().then((res) => res.model),
  save: (next) => transport.setRenameModel(next).then((reply) => reply.model),
})
const renameModel = renameModelField.value
const renameModelBusy = renameModelField.busy

const { modelGroups, availableValues } = useAuthedModelGroups()
const selectedModelValue = computed(() => toSelectValue(renameModel.value))
const staleRef = computed(() => staleModelRef(renameModel.value, availableValues.value))

/** 标题最大长度可选档位（GUI 预设；自由值可经配置文件直改，extension 接受任意正整数）。 */
const MAX_LENGTH_COMPACT = 24
/** 默认档（与 extension DEFAULT_RENAME_CONFIG.maxTitleLength / runtime DEFAULT_RENAME_MAX_LENGTH 同值镜像）。 */
const MAX_LENGTH_DEFAULT = 50
const MAX_LENGTH_LOOSE = 80
const MAX_LENGTH_OPTIONS = [MAX_LENGTH_COMPACT, MAX_LENGTH_DEFAULT, MAX_LENGTH_LOOSE] as const

const maxLengthField = group.field<number>(MAX_LENGTH_DEFAULT, {
  load: () => transport.getRenameMaxLength().then((res) => res.maxLength),
  save: (next) => transport.setRenameMaxLength(next).then((reply) => reply.maxLength),
})
const renameMaxLength = maxLengthField.value
const maxLengthBusy = maxLengthField.busy

/** 参考折叠区内容：slug 词表 + 固定 system 骨架（展示用拼接）。 */
const REF_CONTENT = `${BUILTIN_PREVIEW.slug}\n\n${t('settings.renameSession.refSystemNote')}\n${SLUG_SYSTEM_PROMPT}`

// ── 卡 2：标题提示词（显式保存 + 快照 dirty，SystemPromptPage 范式）──

const STYLE_OPTIONS: ReadonlyArray<{ value: RenameStyle; labelKey: string }> = [
  { value: 'slug', labelKey: 'settings.renameSession.styleSlug' },
  { value: 'sentence', labelKey: 'settings.renameSession.styleSentence' },
  { value: 'emoji', labelKey: 'settings.renameSession.styleEmoji' },
  { value: 'custom', labelKey: 'settings.renameSession.styleCustom' },
]

const promptCorrupted = ref(false)
const showRef = ref(false)
/** 已保存快照（dirty = diff；save 成功后刷新）。instruction 仅 custom 语义。 */
const savedPrompt = ref<{ style: RenameStyle; instruction: string }>({ style: 'slug', instruction: '' })
/** 当前风格选择。 */
const promptStyle = ref<RenameStyle>('slug')
/** 自定义指令草稿（仅 style=custom 时可编辑；切走保留不丢）。 */
const customDraft = ref('')

/** Select 载荷收窄 guard（禁 any：运行时校验后才写 ref）。 */
function isRenameStyleValue(value: unknown): value is RenameStyle {
  return typeof value === 'string' && STYLE_OPTIONS.some((o) => o.value === value)
}

/** Textarea 显示值：custom = 自定义草稿；其余 = 内置模板只读预览（writable computed 承载 v-model）。 */
const instructionDisplay = computed<string>({
  get: () => (promptStyle.value === 'custom' ? customDraft.value : (BUILTIN_PREVIEW[promptStyle.value] ?? '')),
  set: (v) => {
    customDraft.value = v
  },
})

const instructionPlaceholder = computed(() =>
  promptStyle.value === 'custom'
    ? t('settings.renameSession.instructionPlaceholderCustom')
    : t('settings.renameSession.instructionPlaceholderPreset'),
)

const styleExample = computed(() => STYLE_EXAMPLES[promptStyle.value])

// 字数/超限按 Unicode 码点计数，与 runtime normalizeRenameInstruction、extension
// normalizeRenameConfig 同口径（UTF-16 .length 把 surrogate pair 记 2 字元，含 emoji 的
// 指令会被前端提前误判超限）
const instructionCount = computed(() => Array.from(instructionDisplay.value).length)
const instructionOverLimit = computed(() => instructionCount.value > RENAME_INSTRUCTION_MAX_LENGTH)

const promptDirty = computed(
  () => promptStyle.value !== savedPrompt.value.style || customDraft.value !== savedPrompt.value.instruction,
)

const canSavePrompt = computed(() => promptDirty.value && !instructionOverLimit.value && !savingPrompt.value)

const savePrompt = createExplicitSave({
  run: async () => {
    // 非 custom 风格保存时透传快照原值（不把只读预览写进 customInstruction，保留用户自定义文本）
    const instruction = promptStyle.value === 'custom' ? customDraft.value : savedPrompt.value.instruction
    const reply = await transport.setRenamePrompt(promptStyle.value, instruction)
    // 回填 runtime 归一后的生效值（reply = 生效值，防本地乐观值漂移）
    promptStyle.value = reply.style
    customDraft.value = reply.instruction
    savedPrompt.value = { style: reply.style, instruction: reply.instruction }
    promptCorrupted.value = reply.corrupted
  },
  savedToastKey: 'settings.renameSession.savedToast',
})
const savingPrompt = savePrompt.saving

function discardPrompt(): void {
  promptStyle.value = savedPrompt.value.style
  customDraft.value = savedPrompt.value.instruction
}

/** 恢复默认（SystemPromptPage reset 语义）：编辑操作不写盘，需保存生效。 */
function resetPrompt(): void {
  promptStyle.value = 'slug'
  customDraft.value = ''
}

// ── 加载（卡 1 字段组归并 + 卡 2 快照同归并）──

// 卡 2 快照读取注册进字段组归并：读失败与卡 1 字段同样置 loadError——卡 2 控件随禁用链
// 不可操作、loadErrorHint 横幅与重试入口生效，避免快照停留假默认值时用户的保存动作把
// 已存 customInstruction 静默清空（C-proc-21）。catch 保留错误原文 toast，rethrow 交
// loadAll 归并置 loadError
group.registerLoader(async () => {
  try {
    const res = await transport.getRenamePrompt()
    promptCorrupted.value = res.corrupted
    promptStyle.value = res.style
    customDraft.value = res.instruction
    savedPrompt.value = { style: res.style, instruction: res.instruction }
  } catch (e) {
    error(e instanceof Error ? e.message : String(e))
    throw e
  }
})

async function loadConfig(): Promise<void> {
  // 三个卡 1 字段（便捷 load）+ 卡 2 快照（上方注册 loader）并行归并，任一失败置 loadError
  await group.loadAll()
}

onMounted(() => {
  void loadConfig()
})

// ── Select change 处理（乐观更新 + 失败回滚由 setting-field 承载）──

/** Select 载荷收窄 guard（禁 any：运行时校验后收窄为 RenameMode 再交给 persist）。 */
function isRenameModeValue(value: unknown): value is RenameMode {
  return typeof value === 'string' && TRIGGER_MODE_OPTIONS.some((o) => o.value === value)
}

function onRenameModeChange(value: unknown): void {
  if (!isRenameModeValue(value) || value === renameMode.value) return
  void renameModeField.persist(value)
}

function onRenameModelChange(value: unknown): void {
  void renameModelField.persist(fromSelectValue(value))
}

function onMaxLengthChange(value: unknown): void {
  // reka Select 值为 string（SelectItem :value="String(n)"）→ 转数字后过白名单（NaN/越界值拒绝）
  const n = typeof value === 'string' ? Number(value) : NaN
  if (!MAX_LENGTH_OPTIONS.some((m) => m === n) || n === renameMaxLength.value) return
  void maxLengthField.persist(n)
}

function onStyleChange(value: unknown): void {
  if (!isRenameStyleValue(value) || value === promptStyle.value) return
  promptStyle.value = value
}

/** 复制内置默认提示词到剪贴板。 */
async function copyRef(): Promise<void> {
  try {
    await navigator.clipboard.writeText(REF_CONTENT)
    info(t('settings.renameSession.copiedToast'))
  } catch (e) {
    error(e instanceof Error ? e.message : String(e))
  }
}
</script>
