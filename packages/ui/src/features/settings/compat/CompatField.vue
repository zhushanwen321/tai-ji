<template>
  <!--
    CompatField —— compat 单字段渲染（switch / select / text 三种 type）。
    从 CompatEditor 抽出，保证父组件 template 不超 400 行。
    纯展示 + 受控 emit，状态由父组件管理。
    emit 规范：单 payload 对象（change: [{ field, value }]），禁止多参数。
  -->
  <div class="flex flex-col gap-0.5">
    <!-- switch 字段 -->
    <div v-if="meta.type === 'switch'" class="flex items-center justify-between">
      <Label class="text-[12px] text-neutral-fg">{{ t(meta.labelKey) }}</Label>
      <Switch
        :model-value="value === true"
        :aria-label="t(meta.labelKey)"
        @update:model-value="$emit('change', { field: meta.field, value: $event })"
      />
    </div>
    <!-- select 字段 -->
    <div v-else-if="meta.type === 'select'" class="flex items-center justify-between gap-3">
      <Label class="min-w-0 flex-1 truncate text-[12px] text-neutral-fg">{{ t(meta.labelKey) }}</Label>
      <Select
        :model-value="typeof value === 'string' ? value : undefined"
        @update:model-value="$emit('change', { field: meta.field, value: $event })"
      >
        <SelectTrigger class="h-7 w-[180px] shrink-0 px-2 text-[11px]">
          <SelectValue :placeholder="t('settings.compat.unset')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="o in meta.options"
            :key="o.value"
            :value="o.value"
          >{{ t(`${meta.optionsKeyPrefix ?? 'settings.compat.thinkingFormat.options'}.${o.labelKeySuffix}`) }}</SelectItem>
        </SelectContent>
      </Select>
    </div>
    <!-- text 字段：object 类高级字段（openRouterRouting / vercelGatewayRouting / chatTemplateKwargs），
         渲染 JSON 编辑器：值→JSON.stringify 显示，blur 时 JSON.parse 校验，成功 emit，失败提示。 -->
    <div v-else class="flex flex-col gap-1">
      <Label class="text-[12px] text-neutral-fg">{{ t(meta.labelKey) }}</Label>
      <Textarea
        :model-value="draft"
        rows="4"
        class="font-mono text-[11px]"
        :aria-label="t(meta.labelKey)"
        @update:model-value="onDraftInput"
        @blur="commitDraft"
      />
      <p v-if="jsonError" class="text-[10px] text-danger">{{ t('settings.compat.jsonInvalid') }}</p>
    </div>
    <!-- hint 注脚 -->
    <p class="text-[10px] text-neutral-dim">{{ t(meta.hintKey) }}</p>
  </div>
</template>

<script setup lang="ts">
import { Switch, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Textarea, Label } from '@taiji/ui'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { CompatFieldMeta } from '@taiji/core'

/**
 * props.value 是 compat 对象里该字段的当前值（unknown），由父组件 getValue 透传。
 * emit('change', { field, value }) —— 父组件做 immutable 更新（单 payload 对象）。
 */
const props = defineProps<{
  meta: CompatFieldMeta
  value: unknown
}>()

const emit = defineEmits<{
  change: [payload: { field: string; value: unknown }]
}>()

const { t } = useI18n()

// ── text 字段 JSON 编辑器本地态 ──
// draft: 文本框内容（JSON 字符串）。jsonError: 解析失败标记。
// 仅 text 类型用到；switch/select 不渲染 Textarea，这两个 ref 闲置无副作用。
const draft = ref('')
const jsonError = ref(false)

/** JSON 缩进量（抽常量避免 no-magic-numbers）。 */
const JSON_INDENT = 2

/** 把 compat 值序列化成缩进 JSON 字符串（string/number 等原样 JSON 化）。 */
function serialize(v: unknown): string {
  if (v === undefined) return ''
  try {
    return JSON.stringify(v, null, JSON_INDENT)
  } catch {
    return ''
  }
}

// 外部 value 变化（父组件更新/预设填充）→ 同步 draft，清错误。
// 仅在用户未编辑出错时覆盖；这里无条件同步保证受控语义。
watch(
  () => props.value,
  (v) => {
    draft.value = serialize(v)
    jsonError.value = false
  },
  { immediate: true },
)

/** 用户输入时实时清错误标记（允许中途打字态非法），不立即 commit。 */
function onDraftInput(next: string | number): void {
  draft.value = String(next)
  jsonError.value = false
}

/** blur 时尝试解析并 emit；解析失败置错误标记、不清空原值（保留 props.value 不变）。 */
function commitDraft(): void {
  const text = draft.value.trim()
  // 空串 = 清空该字段 → emit undefined
  if (text === '') {
    jsonError.value = false
    emitChange(undefined)
    return
  }
  try {
    const parsed: unknown = JSON.parse(text)
    jsonError.value = false
    emitChange(parsed)
  } catch {
    // 非法 JSON：仅提示，不更新 compat（原值保留），draft 保留用户输入便于修正。
    jsonError.value = true
  }
}

function emitChange(value: unknown): void {
  emit('change', { field: props.meta.field, value })
}
</script>
