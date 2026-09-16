<script setup lang="ts">
/**
 * 标签栏组件（v6）——TC6 连体 pill 范式。
 * 容器 bg-bg-input + rounded-lg + padding 3px（spec .gtabbar padding:3px）；
 * tab 项 rounded-sm，active 用 bg-elevated + neutral-fg 浮起（去 accent-soft 蓝染底）；
 * status=done 显 success 点，status=pending 显 neutral-dim 半透明点。
 *
 * 容器化（协议 v1.1 可选 sections，设计 §3.3 D5）：
 * - `sections` 与 `tabs` 等长 → 渲染 `tabs[本地 active]` 对应子树，子树经
 *   PRIMITIVE_RENDER_KEY 注入的渲染器递归渲染（与 Card/Columns/Group 同款接入）；
 * - active 归宿主本地：容器化首现时取推送 `tabs[i].active`（无 active 取 0），
 *   用户点击只切本地序号——后续推送更新内容但不重置选择，tabs 缩短仅 clamp；
 * - 缺省（无 sections）= 纯展示现状（旧 extension 零改动，无点击态样式）；
 * - sections 与 tabs 不等长 / 无渲染器上下文 → 忽略 sections 退化纯展示 + warn（§3.5）。
 *
 * 渲染器只取注入值、不静态回退 PrimitiveRouter：tab-bar 在 PrimitiveRouter 的叶子
 * 映射表内（Router 静态 import 本组件），静态回退即 Router ↔ TabBar 二文件环——
 * 与 container-registry 头注（R2 S-1）的断环不变量冲突：递归渲染子组件的组件不得
 * 被 Router 静态 import（容器原语靠 barrel 注册进注册表断环，tab-bar 迁入注册表
 * 属 rendering-protocol 包外改动）。缺位时走上面的降级路径；若后续 tab-bar 迁入
 * 注册表，可换成 `inject(PRIMITIVE_RENDER_KEY, PrimitiveRouter)` 回退。
 */
import { computed, inject, ref, watch } from 'vue'
import type { Component } from 'vue'
import type { GuiComponent, GuiComponentProps } from '@zhushanwen/extension-protocol'
import { PRIMITIVE_RENDER_KEY } from '../primitive-render-key'

type TabItem = GuiComponentProps['tab-bar']['tabs'][number]

const props = defineProps<{
  tabs: GuiComponentProps['tab-bar']['tabs']
  sections?: GuiComponentProps['tab-bar']['sections']
}>()

/** 递归渲染器（GuiComponentRenderer provide 自身）；undefined = 无渲染器上下文的 standalone 挂载。
 *  显式传 undefined 默认值 = 抑制 Vue 的「injection not found」dev 警告（纯展示 tab-bar
 *  本就不需要渲染器，旧 extension 场景零噪音）；缺位降级出声由下方 warn 承担。 */
const renderer = inject<Component | undefined>(PRIMITIVE_RENDER_KEY, undefined)

/** sections 形态：absent = 缺省纯展示（现状）；ok = 容器化；其余两种 = 降级原因（§3.5） */
const sectionsState = computed<'absent' | 'ok' | 'length-mismatch' | 'no-renderer'>(() => {
  const sections = props.sections
  if (sections === undefined) return 'absent'
  if (sections.length !== props.tabs.length) return 'length-mismatch'
  return renderer === undefined ? 'no-renderer' : 'ok'
})

/** 容器化生效（渲染 active section + tab 可点）：sections 合法且有 tab */
const containerized = computed(() => sectionsState.value === 'ok' && props.tabs.length > 0)

/** 本地 active 序号（容器化模式）；null = 尚未建立 = 容器化首现时取推送值建立 */
const localActive = ref<number | null>(null)

/** 推送值：首个 active=true 的 tab 序号，无 active 取 0（§3.3 D5 首挂载语义） */
const pushedActiveIndex = computed(() => {
  const index = props.tabs.findIndex(tab => tab.active === true)
  return index >= 0 ? index : 0
})

const clampIndex = (index: number, tabsLength: number): number =>
  tabsLength === 0 ? 0 : Math.min(Math.max(index, 0), tabsLength - 1)

// 建立本地 active（仅一次）：此后推送不重置用户选择（组件实例存续期内）
watch(containerized, (isContainerized) => {
  if (isContainerized && localActive.value === null) {
    localActive.value = clampIndex(pushedActiveIndex.value, props.tabs.length)
  }
}, { immediate: true })

// tabs 数量变化 → clamp 本地序号（收敛越界，不重置、不恢复推送值）
watch(() => props.tabs.length, (tabsLength) => {
  if (localActive.value !== null) localActive.value = clampIndex(localActive.value, tabsLength)
})

/** 降级出声：同一形态只 warn 一次（防每次推送刷屏）；恢复合法后清空，再违约可再出声一次 */
let warnedShape = ''
watch(
  [sectionsState, () => props.tabs.length, () => props.sections?.length ?? 0],
  ([state, tabsLength, sectionsLength]) => {
    if (state === 'absent' || state === 'ok') {
      warnedShape = ''
      return
    }
    const shape = `${state}:${tabsLength}:${sectionsLength}`
    if (shape === warnedShape) return
    warnedShape = shape
    console.warn(
      state === 'length-mismatch'
        ? `[gui-tab-bar] sections 与 tabs 长度不等（sections=${sectionsLength} / tabs=${tabsLength}），忽略 sections 退化为纯展示。修复：extension 修正 buildGui 使两者等长（docs/architecture/extension-gui-protocol.md §3.2 tab-bar）`
        : '[gui-tab-bar] sections 需要渲染器上下文（PRIMITIVE_RENDER_KEY 未注入），忽略 sections 退化为纯展示。修复：经 GuiComponentRenderer 渲染该组件树，或挂载时 provide PRIMITIVE_RENDER_KEY',
    )
  },
  { immediate: true },
)

/** tab 点击：只切本地序号（协议无 UI→extension 回传通道，不回传） */
const selectTab = (index: number): void => {
  if (!containerized.value) return
  localActive.value = clampIndex(index, props.tabs.length)
}

/** tab active 视觉：容器化 = 本地序号（宿主本地优先）；纯展示 = 推送值（现状不变） */
const isActiveTab = (tab: TabItem, index: number): boolean =>
  containerized.value ? index === localActive.value : tab.active === true

/** active section 渲染载荷（渲染器与子树一并收窄；null = 不渲染 section） */
const activeSection = computed<{ renderer: Component; children: GuiComponent[] } | null>(() => {
  if (!containerized.value || renderer === undefined) return null
  const children = props.sections?.[localActive.value ?? 0]
  return children ? { renderer, children } : null
})

const dotClass = (status?: 'done' | 'pending') => {
  if (status === 'done') return 'bg-success'
  if (status === 'pending') return 'bg-neutral-dim opacity-50'
  return ''
}
</script>

<template>
  <div
    class="tab-bar flex gap-0.5 rounded-lg bg-bg-input p-[3px]"
    data-testid="gui-tab-bar"
  >
    <div
      v-for="(tab, i) in tabs"
      :key="i"
      class="tab-bar__tab flex items-center gap-1 rounded-sm px-2.5 py-1 font-mono text-[length:var(--text-xs)] text-neutral-dim transition-colors hover:text-neutral-fg"
      :class="{
        'bg-elevated text-neutral-fg': isActiveTab(tab, i),
        'cursor-pointer': containerized,
      }"
      @click="selectTab(i)"
    >
      <span
        v-if="tab.status"
        class="tab-bar__dot size-[7px] shrink-0 rounded-full"
        :class="dotClass(tab.status)"
      />
      <span class="tab-bar__label">{{ tab.label }}</span>
    </div>
  </div>
  <!-- 容器化：active section 子树（渲染器递归渲染）；纯展示/降级不渲染本节点 -->
  <div
    v-if="activeSection"
    class="tab-bar__section mt-2 flex flex-col gap-2"
    data-testid="gui-tab-bar-section"
  >
    <component
      :is="activeSection.renderer"
      v-for="(child, i) in activeSection.children"
      :key="i"
      :component="child"
    />
  </div>
</template>
