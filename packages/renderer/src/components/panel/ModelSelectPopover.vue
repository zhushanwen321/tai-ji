<template>
  <!--
    §2b 模型分组 select popover（draft-composer-states §2b）。
    click 触发，所有 provider 平铺同一列表，按分组标题分隔；顶部搜索过滤。
    点选即切换当前 session 模型。

    表现层已抽为 ModelPickerPanel（架构审查 D4）——本组件保留 Popover 壳 + trigger + 数据源
    （settingsStore.models → groups + providerFilter/enabled 兜底过滤）与 select 语义。
  -->
  <Popover v-model:open="canOpen">
    <!-- 默认 trigger（PopoverTriggerButton）。调用方可传 #trigger slot 自定义触发器
         （如 ProviderPage 默认 pill），此时调用方需自行包 <PopoverTrigger as-child>。 -->
    <slot name="trigger">
      <PopoverTriggerButton
        :open="open"
        :variant="props.variant === 'icon' ? 'icon' : 'text'"
        :show-chevron="props.variant !== 'icon'"
        :title="props.variant === 'icon' ? currentName : t('panel.modelSelect.switchModel')"
      >
        <!-- U4：切换中显示转圈（停止态切模型要先 ensureActive 拉活，1–2s 可见反馈） -->
        <LoaderCircle v-if="switching" class="size-[13px] shrink-0 animate-spin" />
        <!-- fit L2 图标态：只留图标，模型全名进 title / popover（信息不丢） -->
        <Boxes v-else-if="props.variant === 'icon'" class="size-4" />
        <span v-else class="truncate">{{ currentName }}</span>
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
import { Boxes, LoaderCircle } from '@lucide/vue'
import { Popover, PopoverContent, PopoverTriggerButton } from '@/components/ui/popover'
import type { ModelInfo } from '@/api'
import type { ProviderId } from '@taiji/shared'
import { getSettingsStore } from '@taiji/core'
import ModelPickerPanel, { type ModelPickerGroup } from './ModelPickerPanel.vue'

const emit = defineEmits<{
  select: [payload: { modelId: string; provider: ProviderId }]
}>()

// 接收外部当前选中（Composer 传入），替代写死的 'claude-sonnet-4.5'
const props = withDefaults(defineProps<{
  selected?: string
  /** 限定展示的 provider 分组（ProviderPage 默认 pill 传 [p.id]，只列该供应商模型） */
  providerFilter?: ProviderId[]
  /**
  /**
   * U4「切换中」：true 时 trigger 显示转圈并**忽略开合与点选**（禁用重复点击；并发两条
   * model.switch 在飞会让回执乱序与 session.modelId 双写竞争）。读条件由调用方判
   * sessionId 等值后传入（本组件不感知 session）。
   */
  switching?: boolean
  /**
   * 触发器形态（u6b fit 轴）：`text` = 模型名文本（默认）；`icon` = 纯图标
   * （fit L2 图标化，模型全名进 title 与 popover）。调用方传 `#trigger` slot 时本 prop 无效。
   */
  variant?: 'text' | 'icon'
}>(), {
  selected: '',
  providerFilter: undefined,
  switching: false,
  variant: 'text',
})

const { t } = useI18n()
const settingsStore = getSettingsStore()
const open = ref(false)
// U4：切换中禁止开合（内联处理，避免侵入 ui 包 PopoverTriggerButton 的 props 面）
const canOpen = computed({
  get: () => open.value,
  set: (v: boolean) => { open.value = props.switching ? false : v },
})

/**
 * 拆出裸 modelId：selected 可能是 "provider/modelId" 复合串
 * （SessionSummary.modelId / config.defaults.defaultModel 均为此格式），
 * 但 ModelInfo.id 是裸 modelId。匹配列表项时取 `/` 后段。
 */
function bareModelId(v: string): string {
  const i = v.lastIndexOf('/')
  return i >= 0 ? v.slice(i + 1) : v
}

// 模型列表从 settingsStore 常驻订阅读取（init 在 AppShell 根注册，不随组件卸载断开）。
// 旧实现用 onMounted 本地订阅，组件随 Composer v-if 重新挂载时会错过 sendInitialState
// 一次性推送 → 列表空（2026-07-01 竞态修复）。
interface ModelGroup {
  providerId: ProviderId
  provider: string
  models: ModelInfo[]
}

// 按 provider 分组（搜索过滤与空态判定下沉 ModelPickerPanel）。空分组不渲染。
// 同时过滤 enabled===false 的 model：runtime aggregateModels 已过滤一遍，
// 但 settingsStore.models 与 providers 同源广播，若某次广播未过滤则会泄漏禁用模型到切换器，
// 故前端兜底再过滤一次（双保险）。
/** 过滤 providerFilter + enabled（未过滤前的全量候选，供 panel 区分空态） */
const groups = computed<ModelGroup[]>(() => {
  const map = new Map<string, ModelGroup>()
  for (const m of settingsStore.models.value) {
    if (m.enabled === false) continue
    if (props.providerFilter && !props.providerFilter.includes(m.providerId)) continue
    const key = m.providerId
    let g = map.get(key)
    if (!g) {
      g = { providerId: key, provider: m.providerName, models: [] }
      map.set(key, g)
    }
    g.models.push(m)
  }
  return [...map.values()]
})

/** 模型池是否非空（enabled 过滤 + providerFilter 限定），空态区分依据 */
const hasAnyModel = computed(() => groups.value.length > 0)

/** ModelPickerPanel 分组形状（provider 名 + {id,name} 列表；providerId 不进表现层） */
const pickerGroups = computed<ModelPickerGroup[]>(() =>
  groups.value.map((g) => ({
    provider: g.provider,
    models: g.models.map((m) => ({ id: m.id, name: m.name })),
  })),
)

/** 当前选中值（纯受控：直接用 props，不存本地副本，避免 watch 拉回导致 UI 闪退） */
const selectedValue = computed(() => props.selected ?? '')

const currentName = computed(() => {
  if (!selectedValue.value) return t('panel.modelSelect.placeholder')
  const id = bareModelId(selectedValue.value)
  return settingsStore.models.value.find((m) => m.id === id)?.name ?? id
})

/** panel 选中回调：裸 id → 反查 providerId → 复用 onSelect 的 select 语义 */
function onPickFromPanel(modelId: string): void {
  const group = groups.value.find((g) => g.models.some((m) => m.id === modelId))
  // 渲染与点击之间 groups 被刷新（模型禁用/移除、providerFilter 变化）时反查失败：
  // 不发 select——provider 缺失时伪造空串会穿品牌类型，下游拼出 `/modelId` 畸形复合 id；
  // 静默忽略该次点击，浮层保持打开展示刷新后的列表
  if (!group) return
  onSelect(modelId, group.providerId)
}

function onSelect(id: string, provider: ProviderId): void {
  // provider 参数实为 providerId（switch 标识用 id，pi set_model 按 id 查；group.provider 是 name 仅用于分组标题显示）
  open.value = false
  emit('select', { modelId: id, provider })
}
</script>
