<!--
  Settings · Pi 预设详情编辑区（PresetDetailSection）。
  单预设的展开态编辑内容：名称/ID/描述（受控 Input + debounce）+ 工具/扩展访问策略（PresetModeSection）。
  字段变更（name/description）经 400ms debounce 聚合后 emit('update-field', 完整镜像)，
  容器统一调 store update（FR7）。PresetModeSection 的模式变更原样透传 emit('mode-update')。
-->
<template>
  <div class="flex flex-col gap-3 px-3 py-3">
    <!-- 名称 + ID（内置 disabled） -->
    <!-- 受控写法（:model-value + @update:model-value）有意为之：配合 debounce
         控制字段更新的 flush 时机（onFieldChange → debouncedUpdate 400ms）。
         改 v-model 会失去 debounce 能力（每次 keystroke 立即触发 RPC）。 -->
    <div class="grid grid-cols-2 gap-3">
      <div>
        <Label class="mb-1 block text-[11px] font-semibold text-neutral-mid">
          {{ t('settings.preset.name') }}
        </Label>
        <Input
          :model-value="preset.name"
          :disabled="disabled"
          class="h-8 text-[12px]"
          :placeholder="t('settings.preset.namePlaceholder')"
          @update:model-value="(v) => onFieldChange('name', String(v))"
        />
      </div>
      <div>
        <Label class="mb-1 block text-[11px] font-semibold text-neutral-mid">
          {{ t('settings.preset.id') }}
        </Label>
        <Input
          :model-value="preset.id"
          disabled
          class="h-8 text-[12px] font-mono"
        />
      </div>
    </div>
    <!-- 描述（受控写法 + debounce，同 name 字段，见上文注释） -->
    <div>
      <Label class="mb-1 block text-[11px] font-semibold text-neutral-mid">
        {{ t('settings.preset.description') }}
      </Label>
      <Input
        :model-value="preset.description ?? ''"
        :disabled="disabled"
        class="h-8 text-[12px]"
        :placeholder="t('settings.preset.descPlaceholder')"
        @update:model-value="(v) => onFieldChange('description', String(v))"
      />
    </div>

    <!-- 工具模式 + 扩展模式 -->
    <PresetModeSection :preset="preset" :disabled="disabled" @update="(payload) => emit('mode-update', payload)" />
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useDebounceFn } from '@vueuse/core'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PresetModeSection } from '@taiji/ui/features/settings'
import type { PiLaunchPreset, ToolMode, ExtensionMode } from '@taiji/shared'

const props = defineProps<{
  preset: PiLaunchPreset
  /** 内置预设（builtin）不可编辑。 */
  disabled: boolean
}>()

const emit = defineEmits<{
  'update-field': [preset: PiLaunchPreset]
  'mode-update': [payload: {
    presetId: string
    toolMode?: ToolMode
    extensionMode?: ExtensionMode
    allowedTools?: string[]
    deniedTools?: string[]
    allowedExtensions?: string[]
    deniedExtensions?: string[]
  }]
}>()

const { t } = useI18n()

/** 字段编辑（name/description）的 debounce 延迟——W-RN-2 节流 RPC 频率。 */
const FIELD_UPDATE_DEBOUNCE_MS = 400

/**
 * 字段变更（name/description）→ 乐观更新（emit 完整镜像，容器统一调 store update）。
 *
 * W-RN-2：每次 keystroke 不直接触发 update，先 debounce 400ms 聚合连续输入。
 * 同一输入框的连续 keystroke 共享一个 debounce timer（人类一次只编辑一个字段），
 * 最后一次输入的 preset 镜像被 flush 发出。
 * 容器 update 内部已乐观 upsert + reply 回写（W-RN-3），这里只负责节流 RPC 频率。
 *
 * debounce 而非「失焦/Enter flush」：编辑器场景用户期望静默自动保存（无需手动
 * 失焦/回车），debounce 是更符合直觉的折中。
 */
const updateFieldDebounced = useDebounceFn(
  (preset: PiLaunchPreset) => {
    emit('update-field', preset)
  },
  FIELD_UPDATE_DEBOUNCE_MS,
)

/** 字段变更（name/description）入口：构造乐观镜像并交 debounce 节流。 */
function onFieldChange(field: 'name' | 'description', value: string) {
  if (props.disabled) return
  const updated = { ...props.preset, [field]: value || undefined }
  void updateFieldDebounced(updated)
}
</script>
