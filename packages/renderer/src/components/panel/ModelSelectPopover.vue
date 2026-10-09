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
  <Popover v-model:open="canOpen">
    <!-- 默认 trigger（PopoverTriggerButton）。调用方可传 #trigger slot 自定义触发器
         （如 ProviderPage 默认 pill），此时调用方需自行包 <PopoverTrigger as-child>。 -->
    <slot name="trigger">
      <PopoverTriggerButton
        :open="open"
        variant="text"
        show-chevron
        :title="t('panel.modelSelect.switchModel')"
      >
        <!-- U4：切换中显示转圈（停止态切模型要先 ensureActive 拉活，1–2s 可见反馈） -->
        <LoaderCircle v-if="switching" class="size-[13px] shrink-0 animate-spin" />
        <!-- 模型名两态规格（S4）：非聚合态恒完整展示，DOM 不得带 truncate/max-w 截断 class——
             名字过长由 fit 实测回路升级到聚合按钮（两态），不在展开态内省略。 -->
        <span v-else>{{ currentName }}</span>
      </PopoverTriggerButton>
    </slot>
    <!-- 容器对齐 demo `.popover right w190`（workbench.css composer 段，M4c）：右锚
         （align end）/ 锚距 10px / 最小宽 190px / r-lg 圆角 / 4px 内边距（搜索框与行自带的
         内边距叠在其上）；开合动效走文件尾 ms-pop-motion 全局块（M4b tray-pop-motion 同范式） -->
    <PopoverContent
      side="top"
      align="end"
      :side-offset="10"
      class="ms-pop-motion min-w-[190px] rounded-lg p-1"
    >
      <ModelPickerPanel
        :groups="pickerGroups"
        :model-value="bareModelId(selectedValue)"
        :model-value-provider-id="selectedProviderId"
        :has-candidates="hasAnyModel"
        @update:model-value="onPickFromPanel"
      />
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { LoaderCircle } from '@lucide/vue'
import { Popover, PopoverContent, PopoverTriggerButton } from '@/components/ui/popover'
import type { ProviderId } from '@taiji/shared'
import { getSettingsStore } from '@taiji/core'
import ModelPickerPanel from './ModelPickerPanel.vue'
import { useSwitchingGatedPopoverOpen } from './popover-open-gate'
import { bareModelId, resolveProviderIdFromGroups, useModelPickerData } from './model-picker-data'

const emit = defineEmits<{
  select: [payload: { modelId: string; provider: ProviderId }]
}>()

// 接收外部当前选中（Composer 传入），替代写死的 'claude-sonnet-4.5'
const props = withDefaults(defineProps<{
  selected?: string
  /** 限定展示的 provider 分组（ProviderPage 默认 pill 传 [p.id]，只列该供应商模型） */
  providerFilter?: ProviderId[]
  /**
   * U4「切换中」：true 时 trigger 显示转圈并**忽略开合与点选**（禁用重复点击；并发两条
   * model.switch 在飞会让回执乱序与 session.modelId 双写竞争）。读条件由调用方判
   * sessionId 等值后传入（本组件不感知 session）。
   */
  switching?: boolean
  // [HISTORICAL] `variant` prop 已删（W3b）：触发器恒为文本形态，图标态由 ModelThinkingAggregate 承担
}>(), {
  selected: '',
  providerFilter: undefined,
  switching: false,
})

const { t } = useI18n()
const settingsStore = getSettingsStore()
// U4：切换中禁止开合（门禁在 useSwitchingGatedPopoverOpen，与 ThinkingLevelPopover 共用）
const { open, canOpen } = useSwitchingGatedPopoverOpen(() => props.switching)

// 数据面（分组 / enabled 过滤 / pickerGroups / 反查）在 model-picker-data——
// 顶层绑定名保持 groups（既有测试经 vm.groups 断言分组形状，语义不漂移）
const { groups, hasAnyModel, pickerGroups } = useModelPickerData(() => props.providerFilter)

/** 当前选中值（纯受控：直接用 props，不存本地副本，避免 watch 拉回导致 UI 闪退） */
const selectedValue = computed(() => props.selected ?? '')

/** 当前选中的 provider 归属（复合串拆段——高亮双匹配与展示名精确匹配的依据） */
const selectedProviderId = computed(() => {
  const v = selectedValue.value
  const i = v.lastIndexOf('/')
  return i > 0 ? v.slice(0, i) : undefined
})

const currentName = computed(() => {
  if (!selectedValue.value) return t('panel.modelSelect.placeholder')
  // 复合串精确匹配优先（同 short-id 多 provider 时展示被选中的那个），回落裸 id
  const exact = settingsStore.models.value.find((m) => `${m.providerId}/${m.id}` === selectedValue.value)
  if (exact) return exact.name ?? exact.id
  const id = bareModelId(selectedValue.value)
  return settingsStore.models.value.find((m) => m.id === id)?.name ?? id
})

/** panel 选中回调：组级 providerId 优先（被点行归属——同 short-id 多 provider 歧义
 *  修复，D3 顺带发现 7），缺省回落裸 id 反查（自建分组形态） */
function onPickFromPanel(payload: { id: string; providerId?: ProviderId }): void {
  const { id: modelId } = payload
  const provider = payload.providerId ?? resolveProviderIdFromGroups(groups.value, modelId)
  // 渲染与点击之间 groups 被刷新（模型禁用/移除、providerFilter 变化）时反查失败：
  // 不发 select——provider 缺失时伪造空串会穿品牌类型，下游拼出 `/modelId` 畸形复合 id；
  // 静默忽略该次点击，浮层保持打开展示刷新后的列表
  if (!provider) return
  onSelect(modelId, provider)
}

function onSelect(id: string, provider: ProviderId): void {
  // provider 参数实为 providerId（switch 标识用 id，pi set_model 按 id 查；group.provider 是 name 仅用于分组标题显示）
  open.value = false
  emit('select', { modelId: id, provider })
}
</script>

<style>
/*
 * 模型弹层开合动效（demo E5 方向缓动，drawers.css 的 .pop-enter-active / .pop-leave-active
 * 权威；M4b tray-pop-motion 同范式）：进 = opacity 0→1 + translateY(3px)→0，ease-out；
 * 出 = 反向，ease-in；时长 120ms（--duration-fast，与 demo --dur-fast 同值，由基类
 * .reka-popover-transition 的 transition 简写承载）；关闭态 transform 由基类 scale(0.96)
 * 改写为 translateY(3px)。!important 压过基类同特异性规则（style.css 中
 * .reka-popover-transition 声明序在 tailwind utilities 之后，非 important 覆写会输掉级联）；
 * @starting-style 给进场首帧提供 translateY(3px) 起点（Tailwind 无法表达，机制先例见
 * TrayPanelSurface.vue 文件头）。命名空间 ms- 前缀防与其他浮层动效类冲突。
 */
.ms-pop-motion[data-state='open'] {
  transform: translateY(0) !important;
  transition-timing-function: var(--ease-out) !important;
}
.ms-pop-motion[data-state='closed'] {
  transform: translateY(3px) !important;
  transition-timing-function: var(--ease-in) !important;
}
@starting-style {
  .ms-pop-motion[data-state='open'] {
    transform: translateY(3px) !important;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ms-pop-motion[data-state='open'],
  .ms-pop-motion[data-state='closed'] {
    transition: none !important;
  }
}
</style>
