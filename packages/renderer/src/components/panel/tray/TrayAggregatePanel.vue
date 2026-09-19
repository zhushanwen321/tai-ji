<!--
  TrayAggregatePanel —— 托盘聚合入口（序 4 / D6「托盘整体聚合为单入口 → 面板内分段展示全部类别」）
  的面板内容：把 built-in 各类别 + 协议 widget 各自作为**一段（segment）**在一个面板内展示。

  ── 为什么是「段」而不是重造行渲染 ──
  每段直接复用既有面板组件（built-in → TrayNativePanel，widget → TrayWidgetPanel）——行渲染 /
  分桶 tab / 行内操作（pin 态两段式）/ 行点击归宿矩阵全部保持不变（D6「托盘既有契约不改变，
  只新增退化层」）；本文件只新增「段头 + 每段的定高容器 + 段间滚动」，零行级逻辑复制。
  段高定值（SEGMENT_HEIGHT_CLASS）：既让多段可同屏扫读，又给 TrayNativePanel 的内部
  ScrollArea 一个有界高度（其根是 flex-1 + min-h-0，无界高度下内部滚动不成立）。

  ── 契约 ──
  props.sessionId: string —— 焦点 session id（透传段内面板；数据面经 inject 消费外壳单例，
    本组件不自建 useTrayCounts 实例）
  props.sections: 段头 + 段体所需的 built-in 切片（kind / icon / running / total；由外壳
    ComposerTray 从同一份 `useTrayCounts` 计数派生传入——计数只有一份口径）
  props.widgets: 协议 widget 切片（viewId + entry；entry 的 meta/guiTree 直接喂 TrayWidgetPanel）
  props.pinned: pin 态（透传段内面板：行内操作仅 pin 态渲染，D8 防误触）
  emits: 无 —— 段内组件自持交互（与两面板契约一致）
  尺寸：不设宽高（外壳内容区固定高 h-[340px] / 宽 400px 由 TrayPanelSurface 承载）；段超出
    经本组件 ScrollArea（flex-1 + min-h-0）滚动。
-->
<template>
  <div
    data-testid="tray-aggregate-panel"
    class="flex min-h-0 w-full flex-1 flex-col"
  >
    <ScrollArea class="min-h-0 flex-1">
      <div class="flex flex-col gap-2 p-0.5">
        <!-- built-in 各类别段（顺序 = 外壳 built-in 固定序 bash → subagent → workflow → session） -->
        <section
          v-for="section in sections"
          :key="section.kind"
          :data-testid="`tray-aggregate-section-${section.kind}`"
          class="flex flex-col gap-0.5"
        >
          <div
            class="flex shrink-0 items-center gap-1.5 px-1 pb-1 font-mono text-[length:var(--text-2xs)] uppercase tracking-[0.06em] text-neutral-dim"
          >
            <component :is="section.icon" class="size-3.5 shrink-0" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate">{{ t(`panel.tray.title.${section.kind}`) }}</span>
            <!-- 段头计数：进行中 / 全量（与段内面板 tab 计数同源，不是第二口径） -->
            <span
              :data-testid="`tray-aggregate-count-${section.kind}`"
              class="shrink-0 tabular-nums"
              :class="section.running > 0 ? 'text-accent' : ''"
            >{{ section.running }}/{{ section.total }}</span>
          </div>
          <div :class="[SEGMENT_HEIGHT_CLASS, 'flex min-h-0 flex-col']">
            <TrayNativePanel
              v-if="section.kind !== 'session'"
              :kind="section.kind"
              :session-id="sessionId"
              :pinned="pinned"
            />
            <TraySessionPanel v-else :session-id="sessionId" :pinned="pinned" />
          </div>
        </section>

        <!-- 协议 widget 段（有 entry 即渲染，invalidate 即消失——条目存在性由外壳切片决定） -->
        <section
          v-for="widget in widgets"
          :key="widget.viewId"
          :data-testid="`tray-aggregate-widget-${widget.viewId}`"
          class="flex flex-col gap-0.5"
        >
          <div
            class="flex shrink-0 items-center gap-1.5 px-1 pb-1 font-mono text-[length:var(--text-2xs)] uppercase tracking-[0.06em] text-neutral-dim"
          >
            <span class="min-w-0 flex-1 truncate">{{ widget.entry.meta?.title ?? widget.viewId }}</span>
          </div>
          <div :class="[SEGMENT_HEIGHT_CLASS, 'flex min-h-0 flex-col']">
            <TrayWidgetPanel
              :view-id="widget.viewId"
              :meta="widget.entry.meta"
              :gui-tree="widget.entry.guiTree"
            />
          </div>
        </section>
      </div>
    </ScrollArea>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { Component } from 'vue'
import type { GuiComponent, WidgetMeta } from '@zhushanwen/extension-protocol'
import { ScrollArea } from '@/components/ui/scroll-area'
import TrayNativePanel from '@/components/panel/tray/TrayNativePanel.vue'
import TraySessionPanel from '@/components/panel/tray/TraySessionPanel.vue'
import TrayWidgetPanel from '@/components/panel/tray/TrayWidgetPanel.vue'
import type { TrayBuiltinKind } from '@/components/panel/tray/useTrayCounts'

/** 单个 built-in 类别段（kind / 图标 / 进行中与全量计数） */
export interface TrayAggregateSection {
  kind: TrayBuiltinKind
  icon: Component
  running: number
  total: number
}

/** 协议 widget 段切片（entry 只取面板渲染所需两字段，形状与 ViewCacheEntry 结构兼容） */
export interface TrayAggregateWidget {
  viewId: string
  entry: { meta?: WidgetMeta; guiTree: GuiComponent[] }
}

defineProps<{
  /** 焦点 session id（透传段内面板） */
  sessionId: string
  /** built-in 段切片（由外壳从同一份 useTrayCounts 计数派生，已过滤「全无」类别） */
  sections: TrayAggregateSection[]
  /** 协议 widget 段切片（有 entry 即入列） */
  widgets: TrayAggregateWidget[]
  /** pin 态（透传段内面板：行内操作仅 pin 态渲染） */
  pinned: boolean
}>()

const { t } = useI18n()

/** 段体定高（3 段同屏可扫读；同时给段内面板的内部滚动一个上界） */
const SEGMENT_HEIGHT_CLASS = 'h-[190px]'
</script>
