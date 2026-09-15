<template>
  <!--
    思考等级 popover（draft-composer-states §2c）。
    触发器与列表均中性配色（与上下文容量 / 模型触发器同款 text-neutral-dim），仅选中态走 accent。
    等级强度靠 popover 内 off→max 的语义表达。
  -->
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        variant="ghost"
        class="h-7 gap-1 rounded-sm px-2 text-[11px] text-neutral-dim transition-colors hover:text-neutral-mid"
        :title="t('panel.thinkingLevel.title')"
      >
        <Brain class="size-3 shrink-0" />
        <span>{{ currentLabel }}</span>
        <ChevronDown
          class="ml-px size-[9px] transition-transform duration-[var(--duration)] ease-[var(--ease)]"
          :class="open && 'rotate-180'"
        />
      </Button>
    </PopoverTrigger>
    <PopoverContent side="top" class="w-[180px] p-0">
      <!-- head -->
      <div
        class="flex items-center justify-between border-b border-border bg-white/[0.015] px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-neutral-dim"
      >
        <span>{{ t('panel.thinkingLevel.title') }}</span>
      </div>
      <!-- 可用档位列表（由当前模型的 thinkingLevelMap 动态决定，只显示可用的） -->
      <Button
        v-for="opt in availableOptions"
        :key="opt.level"
        variant="ghost"
        class="flex w-full items-center gap-2 rounded-none px-2.5 py-2 text-[13px] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
        :class="level === opt.level && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent'"
        @click="onSelect(opt)"
      >
        <span
          class="size-[7px] shrink-0 rounded-full"
          :class="level === opt.level ? 'bg-accent' : 'bg-neutral-dim'"
        />
        <span class="flex-1 text-left">{{ getDisplayLabel(opt.level, props.levelMap, t) }}</span>
        <Check
          class="size-[13px] text-accent transition-opacity"
          :class="level === opt.level ? 'opacity-100' : 'opacity-0'"
        />
      </Button>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, Brain } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  THINKING_LEVELS,
  normalizeSupportedLevels,
  highestAvailableLevel,
  resolveThinkingValue,
  resolveThinkingKey,
  getDisplayLabel,
  type ThinkingLevelOption,
  type ThinkingLevel,
} from './thinking-levels'

const emit = defineEmits<{
  /** 选中档位后，发给 runtime 的实际 level（经 thinkingLevelMap value 映射） */
  select: [level: string]
}>()

// 外部当前等级（Composer 从 SessionSummary.thinkingLevel 透传，是 runtime 返回的 value）。
// 需经 resolveThinkingKey 反向映射为 UI 档位 key 才能正确高亮。
// [HISTORICAL] reasoning 必须 withDefaults 显式置 undefined：Vue 对 Boolean prop 的 casting
// 会把「未传」变成 false（而非 undefined），误触发 non-reasoning 分支致只剩 off 档。
const props = withDefaults(
  defineProps<{
    level?: string
    /** 当前模型的思考档位映射（per-model thinkingLevelMap）。
     *  key = UI 可选档位（ThinkingLevel 枚举值，含 max），value = 发给 runtime 的实际 level——
     *  只做档位名→实际值映射，不承载可用性语义（可用集由 supportedLevels 决定，U6 切源）。
     *  切换模型后 Composer 传入新模型的 map。 */
    levelMap?: Record<string, string | null>
    /** 当前模型档位可用集（models[].supportedLevels，runtime 注册表 pi 同源计算下发，U6 切源）。
     *  undefined/空 = 下发链路未接通 → 归一默认五档（off..high）。 */
    supportedLevels?: string[]
 }>(),
  { level: undefined, levelMap: undefined, supportedLevels: undefined },
)

const { t } = useI18n()
const open = ref(false)
// prop level 是 runtime 返回的 value，反查 map 得到 UI 档位 key
const level = ref<ThinkingLevel>(
  props.level
    ? resolveThinkingKey(props.level, props.levelMap, highestAvailableLevel(props.supportedLevels))
    : 'max',
)
watch(() => props.level, (v) => {
  if (v) level.value = resolveThinkingKey(v, props.levelMap, highestAvailableLevel(props.supportedLevels))
})

/** 当前模型的可用档位选项（只渲染可用的，不灰显不可用档位；可用集来自 supportedLevels 下发） */
const availableOptions = computed<ThinkingLevelOption[]>(() => {
  const available = new Set(normalizeSupportedLevels(props.supportedLevels))
  return THINKING_LEVELS.filter((opt) => available.has(opt.level))
})

const currentLabel = computed(
  () => props.level ? getDisplayLabel(level.value, props.levelMap, t) : t('panel.thinkingLevel.placeholder'),
)

function onSelect(opt: ThinkingLevelOption): void {
  level.value = opt.level
  // 发给 runtime 的是 map 映射后的 value（如 max 档发 xhigh），而非 UI 档位名
  emit('select', resolveThinkingValue(opt.level, props.levelMap))
  open.value = false
}
</script>
