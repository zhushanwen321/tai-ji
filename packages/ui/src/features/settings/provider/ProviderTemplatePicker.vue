<script setup lang="ts">
/**
 * 内置 Provider 模板选择器 + 「添加供应商」入口（wave-picker-b，对齐 demo 模块 B）。
 *
 * 两级结构（审查 S9 保留）：
 *  - Popover 入口菜单：「从内置模板（推荐，默认高亮）」/「自定义（手填）」——点「从内置模板」
 *    关闭 Popover 并打开 720px Dialog 选择器；点「自定义」emit('custom') 走原手填流程。
 *  - Dialog 选择器（对齐 demo pickerOverlay）：搜索（name/id/envVar）+ 分类 tab
 *    （全部/API Key/OAuth/云凭证，both 双归属）+ 3 列卡片网格（品牌色 logo/名称/模型数/认证 chip）。
 *
 * 品牌色：brand-colors.ts 16 色品牌表 + hash fallback（T4/D4）。
 * 每次打开都重置回 menu 视图（入口聚合，选择器是二级）。
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Library, Pencil, Plus } from '@lucide/vue'
import {
  Popover,
  PopoverContent,
  PopoverTriggerButton,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Button,
} from '@taiji/ui'
import type { BuiltinProviderTemplate } from '@taiji/shared'
import { brandColor } from './brand-colors.js'

const props = defineProps<{ providers: BuiltinProviderTemplate[] }>()

const emit = defineEmits<{
  select: [template: BuiltinProviderTemplate]
  /** 菜单「自定义」条目 → 父走原手填流程（createAndExpand） */
  custom: []
}>()

const { t } = useI18n()

/** Popover 受控开关（入口菜单） */
const open = ref(false)
/** Dialog 受控开关（选择器二级视图） */
const dialogOpen = ref(false)
/** 搜索词（按 name/id/envVar 模糊匹配，大小写不敏感） */
const search = ref('')
/** 分类 tab：all / api_key / oauth / ambient */
const activeTab = ref<'all' | 'api_key' | 'oauth' | 'ambient'>('all')

watch(open, (v) => {
  if (v) {
    search.value = ''
    activeTab.value = 'all'
  }
})

/** 分类过滤（both 双归属：api_key tab 含 both，oauth tab 含 both） */
const filteredByTab = computed<BuiltinProviderTemplate[]>(() => {
  const tab = activeTab.value
  if (tab === 'all') return props.providers
  if (tab === 'api_key') return props.providers.filter(p => p.authMode === 'api_key' || p.authMode === 'both')
  if (tab === 'oauth') return props.providers.filter(p => p.authMode === 'oauth' || p.authMode === 'both')
  return props.providers.filter(p => p.authMode === 'ambient')
})

/** 搜索（name/id/envVar）+ tab 过滤 */
const filtered = computed<BuiltinProviderTemplate[]>(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return filteredByTab.value
  return filteredByTab.value.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q) ||
      p.envVars.some(env => env.toLowerCase().includes(q)),
  )
})

const TABS = [
  { id: 'all', label: 'tabAll' },
  { id: 'api_key', label: 'tabApiKey' },
  { id: 'oauth', label: 'tabOAuth' },
  { id: 'ambient', label: 'tabAmbient' },
] as const

/** 认证 chip 列表（both 双 chip，对齐 demo tile-auth） */
function authChips(mode: BuiltinProviderTemplate['authMode']): Array<'api_key' | 'oauth' | 'ambient'> {
  if (mode === 'both') return ['api_key', 'oauth']
  return [mode]
}

function chipLabel(kind: 'api_key' | 'oauth' | 'ambient'): string {
  return t(`settings.provider.builtinTemplate.authChip.${kind}`)
}

/** 首字母（name 缺省回退 id 首字符） */
function avatarChar(p: BuiltinProviderTemplate): string {
  return (p.name || p.id).charAt(0).toUpperCase()
}

/** 菜单：从内置模板 → 关 Popover + 开 Dialog */
function onMenuBuiltin(): void {
  open.value = false
  dialogOpen.value = true
}

/** 菜单：自定义 → 关闭 + emit('custom')，父走原手填流程 */
function onMenuCustom(): void {
  open.value = false
  emit('custom')
}

function onSelect(tpl: BuiltinProviderTemplate): void {
  dialogOpen.value = false
  emit('select', tpl)
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTriggerButton
      data-testid="provider-template-picker"
      :title="t('settings.provider.builtinTemplate.trigger')"
    >
      <Plus class="size-3.5" />
      {{ t('settings.provider.builtinTemplate.trigger') }}
    </PopoverTriggerButton>
    <PopoverContent class="w-72 p-1">
      <!-- 一级：入口菜单（内置模板（推荐，默认高亮）+ 自定义） -->
      <Button
        variant="ghost"
        data-testid="add-menu-builtin"
        class="flex h-auto w-full items-center gap-2 rounded-sm bg-surface-2 px-2.5 py-2 text-[13px] text-neutral-fg ring-1 ring-inset ring-accent-ring hover:bg-surface-2"
        @click="onMenuBuiltin"
      >
        <Library class="size-4 shrink-0 text-accent" />
        <span class="flex-1 truncate text-left font-medium">{{ t('settings.provider.builtinTemplate.menuBuiltin') }}</span>
        <span class="shrink-0 rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">{{ t('settings.provider.builtinTemplate.menuRecommended') }}</span>
      </Button>
      <Button
        variant="ghost"
        data-testid="add-menu-custom"
        class="flex h-auto w-full items-center gap-2 rounded-sm px-2.5 py-2 text-[13px] text-neutral-fg hover:bg-surface-hover"
        @click="onMenuCustom"
      >
        <Pencil class="size-4 shrink-0 text-neutral-dim" />
        <span class="flex-1 truncate text-left font-medium">{{ t('settings.provider.builtinTemplate.menuCustom') }}</span>
      </Button>
    </PopoverContent>
  </Popover>

  <!-- 二级：模板选择器 Dialog（对齐 demo pickerOverlay 720px） -->
  <Dialog v-model:open="dialogOpen">
    <DialogContent data-testid="provider-template-dialog" class="max-w-[720px]">
      <DialogHeader>
        <DialogTitle>{{ t('settings.provider.builtinTemplate.dialogTitle') }}</DialogTitle>
        <p class="text-[12px] text-neutral-mid">{{ t('settings.provider.builtinTemplate.dialogSubtitle', { count: props.providers.length }) }}</p>
        <Input
          v-model="search"
          data-testid="provider-template-search"
          :placeholder="t('settings.provider.builtinTemplate.searchPlaceholder')"
          class="h-8"
        />
      </DialogHeader>

      <!-- 分类 tab -->
      <div class="flex gap-1 px-5 pb-2" data-testid="picker-tabs">
        <Button
          v-for="tab in TABS"
          :key="tab.id"
          variant="ghost"
          size="sm"
          :data-testid="`picker-tab-${tab.id}`"
          class="h-auto px-2.5 py-1 text-[12px]"
          :class="activeTab === tab.id
            ? 'bg-accent-soft text-accent'
            : 'text-neutral-mid hover:text-neutral-fg'"
          @click="activeTab = tab.id"
        >
          {{ t(`settings.provider.builtinTemplate.${tab.label}`) }}
        </Button>
      </div>

      <!-- 3 列卡片网格 -->
      <div
        class="grid max-h-[52vh] grid-cols-3 gap-2 overflow-y-auto px-5 pb-5"
        data-testid="provider-template-grid"
      >
        <Button
          v-for="p in filtered"
          :key="p.id"
          variant="ghost"
          :data-testid="`provider-template-${p.id}`"
          class="h-auto flex-col items-stretch gap-2 rounded-md border border-border bg-bg-card p-3 text-left hover:border-accent hover:bg-surface-2"
          @click="onSelect(p)"
        >
          <span class="flex items-center gap-2.5">
            <span
              class="grid size-7 shrink-0 place-items-center rounded-sm text-[13px] font-bold text-white"
              :style="{ backgroundColor: brandColor(p.id) }"
            >{{ avatarChar(p) }}</span>
            <span class="min-w-0">
              <span class="block truncate text-[13px] font-semibold text-neutral-fg">{{ p.name }}</span>
              <span class="block text-[10px] text-neutral-dim">{{ t('settings.provider.builtinTemplate.modelsSuffix', { count: p.modelCount }) }}</span>
            </span>
          </span>
          <span class="flex flex-wrap gap-1">
            <span
              v-for="kind in authChips(p.authMode)"
              :key="kind"
              class="rounded-sm px-1.5 py-0.5 text-[9px] font-medium"
              :class="kind === 'api_key' ? 'bg-surface-hover text-neutral-mid' : kind === 'oauth' ? 'bg-warn-soft text-warn' : 'bg-info-soft text-info'"
            >{{ chipLabel(kind) }}</span>
          </span>
        </Button>
        <p
          v-if="!filtered.length"
          class="col-span-3 px-2 py-8 text-center text-[13px] text-neutral-dim"
        >
          {{ t('settings.provider.builtinTemplate.noResult') }}
        </p>
      </div>
    </DialogContent>
  </Dialog>
</template>
