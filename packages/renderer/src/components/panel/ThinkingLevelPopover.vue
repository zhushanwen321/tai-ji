<template>
  <!--
    思考等级 popover（draft-composer-states §2c）。
    触发器对齐 demo `.thinksel`（M4c：11px 字号 / r-xs 圆角 / --fw-mid 字重，「可操作 = 亮字」
    口径与模型触发器同款）；浮层列表对齐 demo `.popover right w120` 行语言（.pop-item：
    min-h 28 / 5px 8px 内边距 / r-sm / fs-md / mid 字 hover 提 fg，无行首档位点——demo 行 =
    名称 + 选中勾两元素），选中态 = 行尾对勾显隐（demo R3：弹层行不进选中范式，
    无底/框/字色选中态声明）。
  -->
  <Popover v-model:open="canOpen">
    <PopoverTrigger as-child>
      <Button
        variant="ghost"
        class="h-7 gap-1 rounded-[var(--radius-xs)] px-2 text-[length:var(--text-2xs)] text-neutral-fg font-semibold transition-colors"
        :title="t('panel.thinkingLevel.title')"
      >
        <!-- U4：切换中（停止态切档要先 ensureActive 拉活）→ 转圈 + 禁止重复开合/点选 -->
        <LoaderCircle v-if="switching" class="size-3 shrink-0 animate-spin" />
        <Brain v-else class="size-3 shrink-0" />
        <span>{{ currentLabel }}</span>
        <ChevronDown
          class="ml-px size-[9px] transition-transform duration-[var(--duration)] ease-[var(--ease)]"
          :class="open && 'rotate-180'"
        />
      </Button>
    </PopoverTrigger>
    <!-- 容器对齐 demo `.popover right w120`：右锚 / 锚距 10px / 最小宽 120px / r-lg / 4px 内边距 -->
    <PopoverContent
      side="top"
      align="end"
      :side-offset="10"
      class="tl-pop-motion min-w-[120px] rounded-lg p-1"
    >
      <!-- head（demo .pop-head：mono 小写字距标，无底色无分隔边） -->
      <div
        class="px-2 pb-[4px] pt-[6px] font-mono text-[length:var(--text-3xs)] uppercase tracking-[0.08em] text-neutral-dim"
      >
        <span>{{ t('panel.thinkingLevel.title') }}</span>
      </div>
      <!-- 可用档位列表（由当前模型的 thinkingLevelMap 动态决定，只显示可用的） -->
      <Button
        v-for="opt in availableOptions"
        :key="opt.level"
        variant="ghost"
        class="flex min-h-[28px] w-full items-center gap-2 rounded-sm px-2 py-[5px] font-normal text-[length:var(--text-xs)] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
        @click="onSelect(opt)"
      >
        <span class="flex-1 text-left">{{ getDisplayLabel(opt.level, props.levelMap, t) }}</span>
        <!-- 选中指示 = 行尾对勾显隐（demo R3：弹层行不进选中范式，行无底/框/字色选中态） -->
        <Check
          class="size-[13px] shrink-0 transition-opacity"
          :stroke-width="2.2"
          :class="level === opt.level ? 'opacity-100' : 'opacity-0'"
        />
      </Button>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, LoaderCircle, Brain } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  currentThinkingLevelKey,
  availableThinkingLevelOptions,
  resolveThinkingValue,
  getDisplayLabel,
  type ThinkingLevelOption,
  type ThinkingLevel,
} from './thinking-levels'
import { useSwitchingGatedPopoverOpen } from './popover-open-gate'

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
    /**
     * U4「切换中」：true 时档位触发器显示转圈并**忽略开合与点选**（禁用重复点击）。
     * 读条件由调用方判 sessionId 等值后传入（本组件不感知 session）。
     */
    switching?: boolean
    // [HISTORICAL] `iconOnly` prop 已删（W3b）：图标态由 ModelThinkingAggregate（单图标聚合页）
    // 承担，本组件触发器恒为「Brain + 档位名 + chevron」文本形态
 }>(),
  {
    level: undefined,
    levelMap: undefined,
    supportedLevels: undefined,
    switching: false,
  },
)

const { t } = useI18n()
// U4：切换中禁止开合（门禁在 useSwitchingGatedPopoverOpen，与 ModelSelectPopover 共用）
const { open, canOpen } = useSwitchingGatedPopoverOpen(() => props.switching)
// prop level 是 runtime 返回的 value，反查 map 得到 UI 档位 key
const level = ref<ThinkingLevel>(
  currentThinkingLevelKey(props.level, props.levelMap, props.supportedLevels),
)
watch(() => props.level, (v) => {
  if (v) level.value = currentThinkingLevelKey(v, props.levelMap, props.supportedLevels)
})

/** 当前模型的可用档位选项（只渲染可用的，不灰显不可用档位；可用集来自 supportedLevels 下发） */
const availableOptions = computed<ThinkingLevelOption[]>(() =>
  availableThinkingLevelOptions(props.supportedLevels),
)

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

<style>
/*
 * 思考档位弹层开合动效（demo E5 方向缓动；M4b tray-pop-motion 同范式，机制说明见
 * ModelSelectPopover.vue 文件尾同款块）：进 ease-out / 出 ease-in，位移 3px + 透明度，
 * 120ms；@starting-style 提供进场首帧；reduced-motion 全关。tl- 前缀命名空间。
 */
.tl-pop-motion[data-state='open'] {
  transform: translateY(0) !important;
  transition-timing-function: var(--ease-out) !important;
}
.tl-pop-motion[data-state='closed'] {
  transform: translateY(3px) !important;
  transition-timing-function: var(--ease-in) !important;
}
@starting-style {
  .tl-pop-motion[data-state='open'] {
    transform: translateY(3px) !important;
  }
}
@media (prefers-reduced-motion: reduce) {
  .tl-pop-motion[data-state='open'],
  .tl-pop-motion[data-state='closed'] {
    transition: none !important;
  }
}
</style>
