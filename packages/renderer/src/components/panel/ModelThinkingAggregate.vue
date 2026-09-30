<!--
  ModelThinkingAggregate —— composer 底栏「模型 · 思考等级」聚合入口（W3a 三步聚合的末档：
  模型选择 + 思考档位收为单图标按钮）。

  形态硬约束（S1–S7 / D2）：
  - 聚合按钮**单一图标**（Boxes），title = 「模型 · 思考等级」；
  - 模型聚合 = **click** 弹层（Popover，与指标聚合的 hover 语义区分）；
  - 弹层上半 = ModelPickerPanel（hover 选择开启），发丝分隔，下半 = 思考档位行；
  - **hover 模型行 / 思考档行即切换**（D2）：hover 切换**不关**弹层，click 选中后才关；
    hover 只在「值有变化」时 emit（与当前值相同不 emit，天然去抖）。

  契约：
  - props：selected（模型 id，可能带 provider 前缀）/ level / levelMap / supportedLevels /
    switching（U4「切换中」单飞锁透传，与 ModelSelectPopover/ThinkingLevelPopover 同 prop 语义）；
  - emits：selectModel（与 ModelSelectPopover 的 select 完全同形）/ selectThinking
    （发 runtime 的实际值，复用 resolveThinkingValue，与 ThinkingLevelPopover 同语义）；
  - 数据面与 ModelSelectPopover 同源（model-picker-data：settingsStore.models + enabled 过滤，
    反查失败静默忽略的兜底共用）；档位可用集与 ThinkingLevelPopover 同源（./thinking-levels，
    禁止复制常量）。

  U4 单飞锁（与 Composer 展开态两触发器同一把锁）：switching 期间 hover/click 均不再 emit
  （click 仅保留关浮层）——聚合态与展开态一样禁第二条并发切换 RPC；非 switching 期间，
  hover 已 emit 启动切换后的同目标 click 幂等去重（本地 pending 记录最近一次已 emit 未回流的
  目标，回流或切换终态即清），防快速掠过多行 = 多目标并发切换。
-->
<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        variant="ghost"
        data-testid="composer-model-thinking-aggregate"
        class="h-7 gap-1 rounded-sm px-1.5 text-neutral-dim transition-colors hover:text-neutral-mid"
        :title="t('panel.modelSelect.modelThinkingAggregateTitle')"
      >
        <Boxes class="size-4 shrink-0" />
      </Button>
    </PopoverTrigger>
    <PopoverContent side="top" class="w-[240px] p-0">
      <!-- 上半：模型选择（hover 选择开启——hover 即切，不关弹层） -->
      <ModelPickerPanel
        :groups="pickerGroups"
        :model-value="bareModelId(props.selected)"
        :has-candidates="hasAnyModel"
        hover-select
        @hover-select="onHoverModel"
        @update:model-value="onPickModel"
      />
      <span class="block h-px bg-border-strong" aria-hidden="true" />
      <!-- 下半：思考档位行（radio 圆点 + 显示 label + Check 选中态；可用集与 ThinkingLevelPopover 同源） -->
      <div class="py-1" data-testid="model-thinking-level-list">
        <Button
          v-for="opt in availableOptions"
          :key="opt.level"
          variant="ghost"
          :data-testid="'thinking-level-row-' + opt.level"
          class="flex w-full items-center gap-2 rounded-none px-2.5 py-2 text-[13px] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
          :class="opt.level === currentLevelKey && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent'"
          @pointerenter="onHoverLevel(opt)"
          @click="onPickLevel(opt)"
        >
          <span
            class="size-[7px] shrink-0 rounded-full"
            :class="opt.level === currentLevelKey ? 'bg-accent' : 'bg-neutral-dim'"
          />
          <span class="flex-1 text-left">{{ getDisplayLabel(opt.level, props.levelMap, t) }}</span>
          <Check
            class="size-[13px] text-accent transition-opacity"
            :class="opt.level === currentLevelKey ? 'opacity-100' : 'opacity-0'"
          />
        </Button>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Boxes, Check } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { ProviderId } from '@taiji/shared'
import ModelPickerPanel from './ModelPickerPanel.vue'
import { bareModelId, useModelPickerData } from './model-picker-data'
import {
  currentThinkingLevelKey,
  availableThinkingLevelOptions,
  resolveThinkingValue,
  getDisplayLabel,
  type ThinkingLevelOption,
  type ThinkingLevel,
} from './thinking-levels'

const emit = defineEmits<{
  /** 选中模型（hover / click 同形，与 ModelSelectPopover 的 select 完全同形） */
  selectModel: [payload: { modelId: string; provider: ProviderId }]
  /** 选中思考档位：发给 runtime 的实际 level（经 thinkingLevelMap value 映射） */
  selectThinking: [level: string]
}>()

const props = defineProps<{
  /** 当前选中模型 id（可能带 provider 前缀，bareModelId 拆裸 id 比对/高亮） */
  selected: string
  /** 当前思考档位（runtime 返回的 value，经 resolveThinkingKey 反查 UI key 高亮） */
  level?: string
  /** 当前模型的思考档位映射（per-model thinkingLevelMap），与 ThinkingLevelPopover 同 prop 语义 */
  levelMap?: Record<string, string | null>
  /** 当前模型档位可用集（undefined/empty = 归一默认五档），与 ThinkingLevelPopover 同 prop 语义 */
  supportedLevels?: string[]
  /** U4「切换中」：true 期间 hover/click 均不 emit（click 仅关浮层），禁第二条并发切换 RPC */
  switching?: boolean
}>()

const { t } = useI18n()
const open = ref(false)

// ── 模型面（与 ModelSelectPopover 同源数据面；聚合页不限定 provider）──
const { pickerGroups, hasAnyModel, resolveProviderId } = useModelPickerData()

/** 当前选中裸 id（hover 去重与高亮同用此值，复合串先拆段） */
const selectedBare = computed(() => bareModelId(props.selected))

// ── U4 单飞锁 + 本地 pending 去重（hover 触发面并发收敛）──
// 去重基准 = 「runtime 已确认值 ∪ 本地已 emit 未回流目标」：hover 已启动切换后，
// 同目标 click 不再发第二条 RPC；pending 在目标回流（selected/level 更新到位）或
// 切换终态（switching 回落 false，覆盖失败/超时——允许用户重试同目标）时清除。
const pendingModelBare = ref<string | null>(null)
const pendingLevelKey = ref<ThinkingLevel | null>(null)

watch(selectedBare, (v) => {
  if (v !== null && v === pendingModelBare.value) pendingModelBare.value = null
})
watch(
  () => props.switching,
  (now, prev) => {
    if (prev === true && now !== true) {
      pendingModelBare.value = null
      pendingLevelKey.value = null
    }
  },
)

/**
 * 裸 id → emit selectModel：反查 providerId，失败静默忽略（渲染与点击之间列表被刷新时
 * 不伪造 provider——与 ModelSelectPopover 同一兜底，逻辑在 model-picker-data 单份持有）。
 */
function emitModel(modelId: string): void {
  if (props.switching) return // U4：切换中忽略 hover/click 触发
  if (modelId === selectedBare.value || modelId === pendingModelBare.value) return // 同值不 emit（hover 天然去抖 + pending 幂等）
  const provider = resolveProviderId(modelId)
  if (!provider) return
  pendingModelBare.value = modelId
  emit('selectModel', { modelId, provider })
}

/** hover 模型行：切换但**不关**弹层（D2） */
function onHoverModel(modelId: string): void {
  emitModel(modelId)
}

/** click 模型行：切换并关弹层（switching 中不 emit，仅关浮层） */
function onPickModel(modelId: string): void {
  emitModel(modelId)
  open.value = false
}

// ── 思考档位面（可用集 / value 映射与 ThinkingLevelPopover 同源：./thinking-levels）──

/** 当前档位的 UI key（高亮与 hover 去重的基准；与 ThinkingLevelPopover 同款反查与缺省语义） */
const currentLevelKey = computed<ThinkingLevel>(() =>
  currentThinkingLevelKey(props.level, props.levelMap, props.supportedLevels),
)

// pending 档位回流确认（基准值在上方定义，watch 置此避免 TDZ）
watch(currentLevelKey, (v) => {
  if (v !== null && v === pendingLevelKey.value) pendingLevelKey.value = null
})

/** 可用档位选项（只渲染可用的，不灰显不可用档位；可用集来自 supportedLevels 下发） */
const availableOptions = computed<ThinkingLevelOption[]>(() =>
  availableThinkingLevelOptions(props.supportedLevels),
)

/** emit 的值 = map 映射后的实际 value（如 max 档发 xhigh），非 UI 档位名 */
function emitLevel(opt: ThinkingLevelOption): void {
  if (props.switching) return // U4：切换中忽略 hover/click 触发
  if (opt.level === currentLevelKey.value || opt.level === pendingLevelKey.value) return // 同值不 emit（hover 天然去抖 + pending 幂等）
  pendingLevelKey.value = opt.level
  emit('selectThinking', resolveThinkingValue(opt.level, props.levelMap))
}

/** hover 思考行：切换但**不关**弹层（D2） */
function onHoverLevel(opt: ThinkingLevelOption): void {
  emitLevel(opt)
}

/** click 思考行：切换并关弹层（switching 中不 emit，仅关浮层） */
function onPickLevel(opt: ThinkingLevelOption): void {
  emitLevel(opt)
  open.value = false
}
</script>
