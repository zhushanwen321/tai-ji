<!--
  预设工具/扩展模式区。
  4 种 mode 切换（all/allowlist/denylist/none）+ Checkbox 列表。
  工具列表标注「默认启用/默认禁用」。扩展列表复用 settings store extensions。

  v6 §5.8 mode-block：每个 mode 区套 surface-2 + radius + space-3 浮起容器，
  区隔「基本信息」与「访问策略」。mode-btn active = surface-hover 底 + accent inset ring。
-->
<template>
  <div class="flex flex-col gap-4">
    <!-- 工具访问策略（surface-2 浮起容器，v6 §5.8 mode-block） -->
    <div class="flex flex-col gap-2 rounded bg-surface-2 p-3">
      <Label class="flex items-center gap-1.5 text-[11px] font-semibold text-neutral-fg">
        {{ t('settings.preset.toolMode') }}
        <!-- 只读徽章：内置预设 disabled 时显示，替代旧 opacity-50 的隐式只读视觉 -->
        <span v-if="disabled" class="rounded-sm bg-surface px-1.5 py-0.5 text-[11px] font-normal normal-case tracking-normal text-neutral-dim">{{ t('settings.preset.readonlyBadge') }}</span>
      </Label>
      <div class="flex items-center gap-1">
        <Button
          v-for="m in TOOL_MODES"
          :key="m.value"
          variant="ghost"
          class="h-8 rounded-sm px-3 text-[11px]"
          :class="preset.toolMode === m.value ? 'bg-surface-hover text-neutral-fg shadow-[inset_0_0_0_1px_var(--accent-ring)]' : 'text-neutral-mid hover:bg-surface hover:text-neutral-fg'"
          :disabled="disabled"
          @click="onToolModeChange(m.value)"
        >
          {{ m.label }}
        </Button>
      </div>
      <!-- allowlist/denylist：先一行策略语义说明（denylist 勾选=禁用，与 allowlist 相反），再 checkbox 列表 -->
      <div v-if="preset.toolMode === 'allowlist' || preset.toolMode === 'denylist'">
        <p class="mb-2 text-[11px] text-neutral-dim">
          {{ preset.toolMode === 'allowlist' ? t('settings.preset.allowlistHint') : t('settings.preset.denylistHint') }}
        </p>
        <div class="flex flex-wrap gap-2">
          <Label
            v-for="tool in BUILTIN_TOOLS"
            :key="tool"
            class="flex items-center gap-1.5 rounded-sm border border-border px-2 py-1"
            :class="disabled ? 'cursor-default' : 'cursor-pointer hover:bg-surface'"
          >
            <Checkbox
              :model-value="isToolChecked(tool)"
              :disabled="disabled"
              @update:model-value="(checked) => onToolToggle(tool, checked === true)"
            />
            <span class="text-[11px] text-neutral-fg">{{ tool }}</span>
            <span
              class="text-[11px]"
              :class="isDefaultEnabled(tool) ? 'text-success' : 'text-neutral-dim'"
            >{{ isDefaultEnabled(tool) ? t('settings.preset.defaultOn') : t('settings.preset.defaultOff') }}</span>
          </Label>
        </div>
      </div>
      <!-- all/none：无可勾选清单，显式说明当前策略语义（旧版直接不渲染，用户不知道策略含义） -->
      <p v-else class="text-[11px] italic text-neutral-dim">
        {{ preset.toolMode === 'all' ? t('settings.preset.allListHint') : t('settings.preset.noneListHint') }}
      </p>
    </div>

    <!-- 扩展访问策略（surface-2 浮起容器，v6 §5.8 mode-block） -->
    <div class="flex flex-col gap-2 rounded bg-surface-2 p-3">
      <Label class="flex items-center gap-1.5 text-[11px] font-semibold text-neutral-fg">
        {{ t('settings.preset.extensionMode') }}
        <span v-if="disabled" class="rounded-sm bg-surface px-1.5 py-0.5 text-[11px] font-normal normal-case tracking-normal text-neutral-dim">{{ t('settings.preset.readonlyBadge') }}</span>
      </Label>
      <div class="flex items-center gap-1">
        <Button
          v-for="m in EXT_MODES"
          :key="m.value"
          variant="ghost"
          class="h-8 rounded-sm px-3 text-[11px]"
          :class="preset.extensionMode === m.value ? 'bg-surface-hover text-neutral-fg shadow-[inset_0_0_0_1px_var(--accent-ring)]' : 'text-neutral-mid hover:bg-surface hover:text-neutral-fg'"
          :disabled="disabled"
          @click="onExtModeChange(m.value)"
        >
          {{ m.label }}
        </Button>
      </div>
      <div v-if="preset.extensionMode === 'allowlist' || preset.extensionMode === 'denylist'">
        <p class="mb-2 text-[11px] text-neutral-dim">
          {{ preset.extensionMode === 'allowlist' ? t('settings.preset.allowlistHint') : t('settings.preset.denylistHint') }}
        </p>
        <div class="flex flex-wrap gap-2">
          <div v-if="!availableExtensions.length" class="text-[11px] text-neutral-mid">
            {{ t('settings.preset.noExtensions') }}
          </div>
          <Label
            v-for="ext in availableExtensions"
            :key="ext.name"
            class="flex items-center gap-1.5 rounded-sm border border-border px-2 py-1"
            :class="disabled ? 'cursor-default' : 'cursor-pointer hover:bg-surface'"
          >
            <Checkbox
              :model-value="isExtChecked(ext.name)"
              :disabled="disabled"
              @update:model-value="(checked) => onExtToggle(ext.name, checked === true)"
            />
            <span class="text-[11px] text-neutral-fg">{{ ext.displayName }}</span>
          </Label>
        </div>
      </div>
      <p v-else class="text-[11px] italic text-neutral-dim">
        {{ preset.extensionMode === 'all' ? t('settings.preset.allListHint') : t('settings.preset.noneListHint') }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button, Label, Checkbox } from '@taiji/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { getSettingsStore } from '@taiji/core'
import { BUILTIN_TOOLS, isBuiltinExtension } from '@taiji/shared'
import type { PiLaunchPreset, ToolMode, ExtensionMode } from '@taiji/shared'

const props = defineProps<{
  preset: PiLaunchPreset
  disabled: boolean
}>()

const emit = defineEmits<{
  update: [payload: {
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
// core settings store 是纯 ref 集合（非 pinia），extensions 本身即为 Ref，无需 storeToRefs
const { extensions } = getSettingsStore()

const TOOL_MODES = computed(() => [
  { value: 'all' as ToolMode, label: t('settings.preset.modeAll') },
  { value: 'allowlist' as ToolMode, label: t('settings.preset.modeAllowlist') },
  { value: 'denylist' as ToolMode, label: t('settings.preset.modeDenylist') },
  { value: 'none' as ToolMode, label: t('settings.preset.modeNone') },
])

const EXT_MODES = computed(() => [
  { value: 'all' as ExtensionMode, label: t('settings.preset.modeAll') },
  { value: 'allowlist' as ExtensionMode, label: t('settings.preset.modeAllowlist') },
  { value: 'denylist' as ExtensionMode, label: t('settings.preset.modeDenylist') },
  { value: 'none' as ExtensionMode, label: t('settings.preset.modeNone') },
])

/**
 * 可用扩展列表（排除内置扩展）。
 *
 * 使用 isBuiltinExtension 函数检查扩展是否是内置的（基于 mandatory-extensions.json SSOT）。
 */
const availableExtensions = computed(() =>
  extensions.value
    .filter((e) => !isBuiltinExtension(e.name))
    .map((e) => ({ name: e.name, displayName: e.displayName ?? e.name })),
)

/**
 * 默认启用的工具（read/write/bash/edit）。
 *
 * S-RN-3：此集合与 shared BUILTIN_TOOLS 语义不同——BUILTIN_TOOLS 是 pi 硬编码的全部
 * 7 个内置工具（含 grep/find/ls），DEFAULT_ENABLED_TOOLS 是「内置预设默认勾选的核心
 * 4 个」，仅用于 UI 显示「默认启用/默认禁用」徽章。保留本地定义不导入 shared，因
 * 两者语义不同（核心子集 vs 全集），无法用 BUILTIN_TOOLS 子集表达「核心」概念。
 */
const DEFAULT_ENABLED_TOOLS = new Set(['read', 'write', 'bash', 'edit'])

function isDefaultEnabled(tool: string): boolean {
  return DEFAULT_ENABLED_TOOLS.has(tool)
}

function isToolChecked(tool: string): boolean {
  if (props.preset.toolMode === 'allowlist') {
    return (props.preset.allowedTools ?? []).includes(tool)
  }
  // denylist: checked = not denied
  return !(props.preset.deniedTools ?? []).includes(tool)
}

function isExtChecked(ext: string): boolean {
  if (props.preset.extensionMode === 'allowlist') {
    return (props.preset.allowedExtensions ?? []).includes(ext)
  }
  return !(props.preset.deniedExtensions ?? []).includes(ext)
}

function onToolModeChange(mode: ToolMode) {
  emit('update', { presetId: props.preset.id, toolMode: mode })
}

function onExtModeChange(mode: ExtensionMode) {
  emit('update', { presetId: props.preset.id, extensionMode: mode })
}

/**
 * 工具勾选切换（W-RN-4：显式接收 checked 实参，不靠反转逻辑推断）。
 *
 * - allowlist：checked=true → 加入 allowedTools；checked=false → 移除。
 * - denylist：checked=true（表示启用该工具）→ 从 deniedTools 移除；checked=false → 加入。
 */
function onToolToggle(tool: string, checked: boolean) {
  if (props.preset.toolMode === 'allowlist') {
    const list = props.preset.allowedTools ?? []
    const next = checked ? [...list, tool] : list.filter((t) => t !== tool)
    emit('update', { presetId: props.preset.id, allowedTools: next })
  } else {
    // denylist：deniedTools 存的是「被禁用的工具」，勾选语义相反
    const list = props.preset.deniedTools ?? []
    const next = checked ? list.filter((t) => t !== tool) : [...list, tool]
    emit('update', { presetId: props.preset.id, deniedTools: next })
  }
}

/** 扩展勾选切换（同 onToolToggle 语义，W-RN-4）。 */
function onExtToggle(ext: string, checked: boolean) {
  if (props.preset.extensionMode === 'allowlist') {
    const list = props.preset.allowedExtensions ?? []
    const next = checked ? [...list, ext] : list.filter((e) => e !== ext)
    emit('update', { presetId: props.preset.id, allowedExtensions: next })
  } else {
    const list = props.preset.deniedExtensions ?? []
    const next = checked ? list.filter((e) => e !== ext) : [...list, ext]
    emit('update', { presetId: props.preset.id, deniedExtensions: next })
  }
}
</script>
