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
import type { ProviderId } from '@taiji/shared'
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
  /**
   * provider 归属 id（点击事件随组上抛——同 short-id 多 provider 时被点行的归属以
   * 本字段为准，消费方不再按裸 id 全局反查首中，D3 顺带发现 7 歧义修复）。
   * 可选：自建分组且无 provider 语义的调用方（ScheduleForm 直挂）可缺省——消费方
   * 回退裸 id 反查。
   */
  providerId?: ProviderId
  models: ModelPickerModel[]
}

const props = withDefaults(defineProps<{
  /** 未过滤的全量候选分组（搜索过滤在本组件内） */
  groups: ModelPickerGroup[]
  /** 当前选中 id（消费方已 normalize；空串 = 无选中） */
  modelValue?: string
  /**
   * 当前选中的 provider 归属（可选——传入时高亮要求 id 与组 providerId 双匹配，
   * 同 short-id 多 provider 不再双行同亮；缺省按裸 id 匹配，现状行为不变）。
   * 仅作等值比较（选中值复合串拆段而来的未品牌串即可），不随事件回抛。
   */
  modelValueProviderId?: string
  /** 候选池是否非空——区分「无候选」与「搜索无结果」两种空态（缺省从 groups 派生） */
  hasCandidates?: boolean
  /** 列表项 data-testid 前缀（消费方自定义，便于各自回归断言） */
  itemTestIdPrefix?: string
  /**
   * hover 选择（W3a，D2 模型聚合的 hover 切换）：开启时行 pointerenter 即上抛 hoverSelect；
   * 默认关闭——不传时行为与改动前逐字节一致（其他三个模型选择面不受影响）。
   */
  hoverSelect?: boolean
}>(), {
  modelValue: '',
  modelValueProviderId: undefined,
  hasCandidates: undefined,
  itemTestIdPrefix: 'model-picker-item',
  hoverSelect: false,
})

/** 行事件单 payload（id + 所属组 providerId——provider 归属单点随组上行；组无 providerId 时缺省） */
interface ModelPickPayload {
  id: string
  providerId?: ProviderId
}

const emit = defineEmits<{
  /** 选中项（id + 所属组 providerId） */
  'update:modelValue': [payload: ModelPickPayload]
  /** hover 过某行（仅 hoverSelect 开启时上抛；值未变的去重在消费方） */
  hoverSelect: [payload: ModelPickPayload]
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

/** 行选中判定：传了 modelValueProviderId 时 id + 组归属双匹配（同 short-id 多
 *  provider 不双行同亮），否则按裸 id（现状语义）。 */
function isRowSelected(model: ModelPickerModel, group: ModelPickerGroup): boolean {
  if (model.id !== props.modelValue) return false
  return props.modelValueProviderId !== undefined ? group.providerId === props.modelValueProviderId : true
}

function onPick(model: ModelPickerModel, group: ModelPickerGroup): void {
  emit('update:modelValue', { id: model.id, ...(group.providerId !== undefined ? { providerId: group.providerId } : {}) })
}

/** 行 hover：仅 hoverSelect 开启时上抛（关闭时是空操作，DOM 形态不受影响） */
function onRowEnter(model: ModelPickerModel, group: ModelPickerGroup): void {
  if (props.hoverSelect) emit('hoverSelect', { id: model.id, ...(group.providerId !== undefined ? { providerId: group.providerId } : {}) })
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
          :class="isRowSelected(model, group) && SELECTED_ITEM_CLASS"
          @click="onPick(model, group)"
          @pointerenter="onRowEnter(model, group)"
        >
          <span class="flex-1 text-left">{{ model.name ?? model.id }}</span>
          <Check
            class="size-[13px] text-accent opacity-0"
            :class="isRowSelected(model, group) && 'opacity-100'"
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
