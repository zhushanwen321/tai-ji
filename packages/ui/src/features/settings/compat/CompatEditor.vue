<template>
  <!--
    CompatEditor —— Provider 兼容性配置编辑器。
    v-model 绑定 compat: Record<string, unknown> | undefined；prop `api` 决定显示哪组字段。
    字段定义从 compat-fields.ts SSOT 取，按 essential / advanced 分组渲染。
    单字段渲染抽到 CompatField.vue，本组件只负责分组、折叠、清空等编排。
  -->
  <div class="compat-editor flex flex-col gap-3 py-2">
    <!-- 国产模型预设（一键配置）：按 api 类型过滤显示 -->
    <div v-if="presets.length" class="flex flex-wrap items-center gap-1.5 border-b border-border pb-2">
      <span class="text-[10px] text-neutral-dim">{{ t('settings.compat.presetLabel') }}</span>
      <Button
        v-for="p in presets"
        :key="p.id"
        variant="ghost"
        size="sm"
        class="h-6 rounded-sm border border-border px-2 text-[10px] text-neutral-fg hover:border-accent hover:bg-accent-soft hover:text-accent"
        :title="t(`settings.compat.preset.${p.id}.hint`)"
        @click="applyPreset(p)"
      >
        {{ t(`settings.compat.preset.${p.id}.label`) }}
      </Button>
    </div>

    <!-- 无字段兜底（理论上不会触发，所有 api 类型都有字段）-->
    <p v-if="!essentialFields.length && !advancedFields.length" class="text-[11px] text-neutral-mid">
      {{ t('settings.compat.noEssential') }}
    </p>

    <!-- 关键字段区（essential，始终露出）-->
    <div v-if="essentialFields.length" class="flex flex-col gap-2">
      <span class="text-[11px] font-semibold text-neutral-mid">{{ t('settings.compat.essential') }}</span>
      <CompatField
        v-for="f in essentialFields"
        :key="f.field"
        :meta="f"
        :value="getValue(f.field)"
        @change="setValue"
      />
    </div>

    <!-- 高级字段区（advanced，默认折叠）-->
    <div v-if="advancedFields.length">
      <Button
        variant="ghost"
        class="h-auto p-0 text-[11px] text-accent hover:bg-transparent hover:underline"
        :aria-expanded="showAdvanced"
        @click="showAdvanced = !showAdvanced"
      >
        <ChevronRight class="size-3 transition-transform" :class="showAdvanced ? 'rotate-90' : ''" />
        {{ showAdvanced ? t('settings.compat.collapseAdvanced') : t('settings.compat.showAdvanced') }}
      </Button>
      <div v-if="showAdvanced" class="mt-2 flex flex-col gap-2">
        <CompatField
          v-for="f in advancedFields"
          :key="f.field"
          :meta="f"
          :value="getValue(f.field)"
          @change="setValue"
        />
      </div>
    </div>

    <!-- 清空按钮 -->
    <Button
      v-if="hasValue"
      variant="ghost"
      class="h-auto p-0 text-[11px] text-danger hover:bg-transparent hover:underline"
      @click="clearAll"
    >
      {{ t('settings.compat.clearAll') }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@taiji/ui'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from '@lucide/vue'

import { getCompatFields, getPresetsForApi } from '@taiji/core'
import CompatField from './CompatField.vue'

/**
 * props.api: model 的 api 类型（'openai-completions' | 'openai-responses' | 'anthropic-messages'）。
 * props.modelValue: 当前 compat 对象；undefined 表示未配置（所有字段回落默认）。
 */
const props = defineProps<{
  api?: string
  modelValue?: Record<string, unknown>
}>()

const emit = defineEmits<{
  'update:modelValue': [value: Record<string, unknown> | undefined]
}>()

const { t } = useI18n()

// 高级区折叠态：默认收起，避免一次性堆 16 个字段压垮嵌入区。
const showAdvanced = ref(false)

const allFields = computed(() => getCompatFields(props.api))
const essentialFields = computed(() => allFields.value.filter(f => f.group === 'essential'))
const advancedFields = computed(() => allFields.value.filter(f => f.group === 'advanced'))

/** 当前 api 类型可用的预设（无预设时返回空，按钮行整体隐藏）。 */
const presets = computed(() => getPresetsForApi(props.api))

/** 是否有任意已配置字段（驱动「清除所有」按钮显隐）。 */
const hasValue = computed(() => props.modelValue !== undefined && Object.keys(props.modelValue).length > 0)

function getValue(field: string): unknown {
  return props.modelValue?.[field]
}

/**
 * immutable 更新单个字段。接收 CompatField 的单 payload 对象（{ field, value }）。
 * switch/select/text 三类字段均经此入口（text 字段在 JSON 校验通过后 emit）。
 */
function setValue(payload: { field: string; value: unknown }): void {
  emit('update:modelValue', { ...props.modelValue, [payload.field]: payload.value })
}

/** 清空 compat：emit undefined。 */
function clearAll(): void {
  emit('update:modelValue', undefined)
}

/**
 * 应用预设：merge 模式——preset 字段覆盖同名字段，用户已存在但不在 preset 中的字段保留。
 * （spread 顺序：现有字段在前，preset 覆盖在后。）
 *
 * 另外：cacheControlFormat 已从 UI 字段列表移除（单选下拉无意义），但语义需保留。
 * 应用 anthropic 相关预设时自动注入 { cacheControlFormat: 'anthropic' }（若 preset
 * 数据已显式提供该字段则保持，不重复覆盖）。
 */
function applyPreset(preset: { api?: string; compat: Record<string, unknown> }): void {
  const existingCompat = props.modelValue ?? {}
  const merged: Record<string, unknown> = { ...existingCompat, ...preset.compat }
  // anthropic 相关预设（anthropic-messages API，或 preset 已声明 cacheControlFormat）
  // → 确保 cacheControlFormat='anthropic'（唯一有效值），不暴露无意义单选 UI。
  if (preset.api === 'anthropic-messages' && merged.cacheControlFormat === undefined) {
    merged.cacheControlFormat = 'anthropic'
  }
  emit('update:modelValue', merged)
}
</script>
