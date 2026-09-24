<template>
  <!--
    §2b 模型分组 select popover（draft-composer-states §2b）。
    click 触发，所有 provider 平铺同一列表，按分组标题分隔；顶部搜索过滤。
    点选即切换当前 session 模型。

    表现层已抽为 ModelPickerPanel（架构审查 D4）——本组件保留 Popover 壳 + trigger + select 语义；
    数据面（settingsStore.models → groups + providerFilter/enabled 兜底过滤、裸 id 反查 provider）
    在 model-picker-data（与 ModelThinkingAggregate 共用，禁止两处复制）。
    [HISTORICAL] `variant='icon'`（fit L2 图标态，Boxes 触发器）已随 W3b 删除——
    聚合形态由 ModelThinkingAggregate（单图标聚合页）承担，本组件恒为文本触发器。
  -->
  <Popover v-model:open="open">
    <!-- 默认 trigger（PopoverTriggerButton）。调用方可传 #trigger slot 自定义触发器
         （如 ProviderPage 默认 pill），此时调用方需自行包 <PopoverTrigger as-child>。 -->
    <slot name="trigger">
      <PopoverTriggerButton
        :open="open"
        variant="text"
        show-chevron
        :title="t('panel.modelSelect.switchModel')"
      >
        <!-- 模型名两态规格（S4）：非聚合态恒完整展示，DOM 不得带 truncate/max-w 截断 class——
             名字过长由 fit 实测回路升级到聚合按钮（两态），不在展开态内省略。 -->
        <span>{{ currentName }}</span>
      </PopoverTriggerButton>
    </slot>
    <PopoverContent side="top" class="w-[220px] p-0">
      <ModelPickerPanel
        :groups="pickerGroups"
        :model-value="bareModelId(selectedValue)"
        :has-candidates="hasAnyModel"
        @update:model-value="onPickFromPanel"
      />
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Popover, PopoverContent, PopoverTriggerButton } from '@/components/ui/popover'
import type { ProviderId } from '@taiji/shared'
import { getSettingsStore } from '@taiji/core'
import ModelPickerPanel from './ModelPickerPanel.vue'
import { bareModelId, resolveProviderIdFromGroups, useModelPickerData } from './model-picker-data'

const emit = defineEmits<{
  select: [payload: { modelId: string; provider: ProviderId }]
}>()

// 接收外部当前选中（Composer 传入），替代写死的 'claude-sonnet-4.5'
const props = withDefaults(defineProps<{
  selected?: string
  /** 限定展示的 provider 分组（ProviderPage 默认 pill 传 [p.id]，只列该供应商模型） */
  providerFilter?: ProviderId[]
  // [HISTORICAL] `variant` prop 已删（W3b）：触发器恒为文本形态，图标态由 ModelThinkingAggregate 承担
}>(), {
  selected: '',
  providerFilter: undefined,
})

const { t } = useI18n()
const settingsStore = getSettingsStore()
const open = ref(false)

// 数据面（分组 / enabled 过滤 / pickerGroups / 反查）在 model-picker-data——
// 顶层绑定名保持 groups（既有测试经 vm.groups 断言分组形状，语义不漂移）
const { groups, hasAnyModel, pickerGroups } = useModelPickerData(() => props.providerFilter)

/** 当前选中值（纯受控：直接用 props，不存本地副本，避免 watch 拉回导致 UI 闪退） */
const selectedValue = computed(() => props.selected ?? '')

const currentName = computed(() => {
  if (!selectedValue.value) return t('panel.modelSelect.placeholder')
  const id = bareModelId(selectedValue.value)
  return settingsStore.models.value.find((m) => m.id === id)?.name ?? id
})

/** panel 选中回调：裸 id → 反查 providerId → 复用 onSelect 的 select 语义 */
function onPickFromPanel(modelId: string): void {
  // 渲染与点击之间 groups 被刷新（模型禁用/移除、providerFilter 变化）时反查失败：
  // 不发 select——provider 缺失时伪造空串会穿品牌类型，下游拼出 `/modelId` 畸形复合 id；
  // 静默忽略该次点击，浮层保持打开展示刷新后的列表
  const provider = resolveProviderIdFromGroups(groups.value, modelId)
  if (!provider) return
  onSelect(modelId, provider)
}

function onSelect(id: string, provider: ProviderId): void {
  // provider 参数实为 providerId（switch 标识用 id，pi set_model 按 id 查；group.provider 是 name 仅用于分组标题显示）
  open.value = false
  emit('select', { modelId: id, provider })
}
</script>
