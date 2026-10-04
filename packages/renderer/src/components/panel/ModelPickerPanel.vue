<script setup lang="ts">
/**
 * ModelPickerPanel —— 模型选择表现层（可搜索 + 按 provider 分组的选中列表）。
 *
 * 架构审查 D4（scheduler-trigger-inversion §6.4）从 ModelSelectPopover 抽出的可复用列表体：
 * 搜索框 / provider 分组 / 两种空态（无候选 vs 搜索无结果）收在一处，四个模型选择面共用
 * （Composer / ProviderPage 经 ModelSelectPopover，ScheduleForm 直挂，settings pill 共用同一
 * ModelSelectPopover）。
 *
 * 边界（设计 §6.4）：本组件只负责「展示 + 选中」，数据源与所选语义由消费方提供——
 * - groups 已经是「未过滤的全量候选」（搜索过滤在组件内做），故可区分两种空态；
 * - modelValue 由消费方normalize（ModelSelectPopover 传裸 modelId，ScheduleForm 传原文 id）；
 * - 字符串 id → 展示名的映射责任在消费方（无 name 时展示 id 原文）。
 *
 * 布局容器由消费方决定（PopoverContent / 内联折叠区），本组件只渲染列表体自身。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SELECTED_ITEM_CLASS } from '@/composables/logic/popover-styles'

export interface ModelPickerModel {
  id: string
  /** 展示名；缺省时展示 id 原文（映射责任在消费方，设计 §6.4） */
  name?: string
}

export interface ModelPickerGroup {
  /** provider 展示名（分组标题）；空串表示无分组标题（如无 provider 前缀的候选） */
  provider: string
  models: ModelPickerModel[]
}

const props = withDefaults(defineProps<{
  /** 未过滤的全量候选分组（搜索过滤在本组件内） */
  groups: ModelPickerGroup[]
  /** 当前选中 id（消费方已 normalize；空串 = 无选中） */
  modelValue?: string
  /** 候选池是否非空——区分「无候选」与「搜索无结果」两种空态（缺省从 groups 派生） */
  hasCandidates?: boolean
  /** 列表项 data-testid 前缀（消费方自定义，便于各自回归断言） */
  itemTestIdPrefix?: string
}>(), {
  modelValue: '',
  hasCandidates: undefined,
  itemTestIdPrefix: 'model-picker-item',
})

const emit = defineEmits<{
  /** 选中项 id（消费方据此映射 provider / 回写状态） */
  'update:modelValue': [id: string]
}>()

const { t } = useI18n()
const query = ref('')

/** 候选池非空（区分两种空态）：显式 prop 优先，否则按 groups 派生 */
const hasAnyCandidate = computed(
  () => props.hasCandidates ?? props.groups.some((g) => g.models.length > 0),
)

/** 搜索过滤（name 优先、id 兜底；空分组不渲染） */
const filteredGroups = computed<ModelPickerGroup[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return props.groups
  return props.groups
    .map((g) => ({
      ...g,
      models: g.models.filter((m) => (m.name ?? m.id).toLowerCase().includes(q) || m.id.toLowerCase().includes(q)),
    }))
    .filter((g) => g.models.length > 0)
})

function onPick(id: string): void {
  emit('update:modelValue', id)
}
</script>

<template>
  <div class="flex flex-col" data-testid="model-picker-panel">
    <!-- 搜索 -->
    <div class="border-b border-border p-2">
      <Input
        v-model="query"
        data-testid="model-picker-search"
        :placeholder="t('panel.modelSelect.searchPlaceholder')"
        class="h-7 bg-surface-2 text-[12px]"
      />
    </div>

    <!-- 分组列表 -->
    <div class="max-h-[280px] overflow-y-auto py-1" data-testid="model-picker-list">
      <div
        v-for="group in filteredGroups"
        :key="group.provider || '__ungrouped__'"
        class="py-1"
      >
        <div
          v-if="group.provider"
          class="px-2.5 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-neutral-dim"
        >
          {{ group.provider }}
        </div>
        <Button
          v-for="model in group.models"
          :key="model.id"
          variant="ghost"
          :data-testid="`${itemTestIdPrefix}-${model.id}`"
          class="flex w-full items-center gap-2 rounded-none px-2.5 py-[7px] text-[13px] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
          :class="model.id === modelValue && SELECTED_ITEM_CLASS"
          @click="onPick(model.id)"
        >
          <span class="flex-1 text-left">{{ model.name ?? model.id }}</span>
          <Check
            class="size-[13px] text-accent opacity-0"
            :class="model.id === modelValue && 'opacity-100'"
          />
        </Button>
      </div>
      <!-- 空态区分：候选池为空 → 引导配置凭据；池有模型但搜索无结果 → 无匹配 -->
      <div
        v-if="filteredGroups.length === 0"
        data-testid="model-picker-empty"
        class="px-2.5 py-3 text-center text-[12px] text-neutral-dim"
      >
        {{ hasAnyCandidate ? t('panel.modelSelect.noMatch') : t('panel.modelSelect.noModel') }}
      </div>
    </div>
  </div>
</template>
