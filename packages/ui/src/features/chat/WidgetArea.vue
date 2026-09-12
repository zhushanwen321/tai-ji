<script setup lang="ts">
/**
 * WidgetArea（M17 → v1.1 meta head → D 方案：单行状态带 + 详情浮层）。
 *
 * 消费 ViewHostStore 的 per-session widget 缓存（经注入 ViewHostSource）：
 * getViewIds 枚举该 session 全部 viewId（widgetKey），逐个 getView 聚合。
 *
 * D 方案形态（对话流零挤压）：widget 区从「常驻展开的多卡面板」压缩为单行 pill 状态带——
 * 每个 widget 一个 seg（状态点 + 标题 + 进度计数），加第一个进行中项的文本预览
 * （todo/goal 属「给 agent 看的工作记忆」，人只需知道「有几个、现在做到哪」；
 * 竞品佐证：opencode 桌面 dock 收起态计数+活动项、zcode 桌面「已完成 N」组计数）。
 * 点击 pill 经 reka Popover 弹出完整列表浮层（浮在对话流上方，不占对话流空间）。
 *
 * 数据源经 inject 注入（VIEW_HOST_SOURCE_KEY），壳层 provide 真实实现，单测
 * global.provide mock；无注入时静默空态不崩（inject(key, null) 兜底）。
 * gui:null 清除语义不变：entries 为空时整体零 DOM（含 pill），不残留空容器。
 *
 * 活动项提取：guiTree 中第一个 status==='running' 的 list-tree 条目 label（group
 * 递归下钻）——数据由 extension 的 GuiRenderResult 自带，宿主零协议改动。
 */
import { computed, inject, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown } from '@lucide/vue'
import { VIEW_HOST_SOURCE_KEY } from '../../extension-host'
import type { ViewCacheEntry } from '../../extension-host'
import type { GuiComponent, WidgetMeta } from '@xyz-agent/extension-protocol'
// primitives / 渲染协议直接路径（不经顶层 barrel，chat 组件被 barrel 再导出会闭合循环依赖环）
import { Button } from '../../primitives/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover'
import GuiComponentRenderer from '../../rendering-protocol/GuiComponentRenderer.vue'

const { t } = useI18n()

const props = defineProps<{
  /** 所属 session */
  sessionId: string
}>()

const source = inject(VIEW_HOST_SOURCE_KEY, null)

/** 单张 widget 卡的装配结果（viewId + 命中的缓存条目）。 */
interface WidgetEntry {
  viewId: string
  entry: ViewCacheEntry
}

/**
 * 该 session 全部可渲染 widget。
 *
 * getViewIds 与 getView 必须都在本 computed 内调用：壳层 reactive 桥的依赖追踪
 * 靠调用路径触碰 reactive Map（分区后建 trigger + partition keys 迭代追踪），
 * 拆到 computed 外会断链 → widget 推送后不重算。过滤 entry 缺失或 guiTree 空的
 * 条目（gui:null 清除语义 + 异常 payload 防护，不出空 seg）。
 */
const entries = computed<WidgetEntry[]>(() => {
  if (!source) return []
  return source
    .getViewIds(props.sessionId)
    .map((viewId) => ({ viewId, entry: source.getView(props.sessionId, viewId) }))
    .filter((e): e is WidgetEntry => e.entry !== undefined && e.entry.guiTree.length > 0)
})

const popoverOpen = ref(false)

// ── 状态/进度渲染辅助（meta → 类名/文本）──

/** 状态点 bg 色：running=accent / done=success / failed=danger / idle=弱中性点 */
function statusDotClass(status: WidgetMeta['status'] | undefined): string {
  switch (status) {
    case 'running': return 'bg-accent'
    case 'done': return 'bg-success'
    case 'failed': return 'bg-danger'
    case 'idle': return 'bg-neutral-dim'
    default: return 'bg-neutral-dim'
  }
}

/** 进度 mini bar fill 色：显式 severity 优先（预算阈值），否则 done→success、默认 accent */
function progressFillClass(meta: WidgetMeta | undefined): string {
  const severity = meta?.progress?.severity
  if (severity === 'danger') return 'bg-danger'
  if (severity === 'warn') return 'bg-warn'
  if (severity === 'ok') return 'bg-accent'
  return meta?.status === 'done' ? 'bg-success' : 'bg-accent'
}

/** 进度计数文本：extension 格式化值 ?? current/total */
function progressLabel(meta: WidgetMeta | undefined): string {
  const p = meta?.progress
  if (!p) return ''
  return p.label ?? `${p.current}/${p.total}`
}

/** 百分比换算因子（no-magic-numbers，同 useDrawerSplitWidth PCT_SCALE 模式） */
const PCT_SCALE = 100

/** 进度 fill 宽度（0-100 clamp，total<=0 防除零） */
function progressWidth(meta: WidgetMeta | undefined): string {
  const p = meta?.progress
  if (!p || p.total <= 0) return '0%'
  return `${Math.min(PCT_SCALE, Math.max(0, (p.current / p.total) * PCT_SCALE))}%`
}

// ── 活动项提取（pill 中部的进行中预览）──

/**
 * GuiComponent 是泛型接口实例化（type: 联合 + props: 联合映射），非判别联合——
 * `c.type === 'list-tree'` 只收窄 type 不联动收窄 props，须用显式类型守卫。
 */
function isListTree(c: GuiComponent): c is GuiComponent<'list-tree'> {
  return c.type === 'list-tree'
}

function isGroup(c: GuiComponent): c is GuiComponent<'group'> {
  return c.type === 'group'
}

/** guiTree 中第一个 running 条目的 label（list-tree 直取，group 递归下钻）。 */
function firstRunningLabel(tree: GuiComponent[]): string | null {
  for (const c of tree) {
    if (isListTree(c)) {
      const running = c.props.items.find((it) => it.status === 'running')
      if (running) return running.label
    } else if (isGroup(c)) {
      const nested = firstRunningLabel(c.props.children)
      if (nested) return nested
    }
  }
  return null
}

/** 第一个有 running 条目的 widget 及其 label；无进行中项（全完成/全 pending）→ null。 */
const activePreview = computed<{ widget: string; label: string } | null>(() => {
  for (const w of entries.value) {
    const label = firstRunningLabel(w.entry.guiTree)
    if (label) return { widget: w.entry.meta?.title ?? w.viewId, label }
  }
  return null
})
</script>

<template>
  <!-- 外层 band：px-5 对齐 composer-band 侧距；relative 供 popover 定位参照。
       D 方案：单行 pill（默认收起态，常态高度 28px 级），点击弹浮层看完整列表。 -->
  <div v-if="entries.length > 0" data-testid="widget-area" class="relative flex-shrink-0 px-5 py-2">
    <Popover v-model:open="popoverOpen">
      <PopoverTrigger as-child>
        <Button
          type="button"
          variant="ghost"
          data-testid="widget-pill"
          class="flex h-7 max-w-full cursor-pointer select-none items-center gap-3 overflow-hidden rounded-full bg-surface-2 px-3.5 font-mono text-[length:var(--text-2xs)] text-neutral-mid transition-colors hover:bg-surface-hover hover:text-neutral-fg"
        >
          <!-- 每个 widget 一个 seg：状态点 + 标题 + 进度计数 -->
          <span
            v-for="w in entries"
            :key="w.viewId"
            data-testid="widget-pill-seg"
            class="flex shrink-0 items-center gap-1.5"
          >
            <span
              data-testid="widget-pill-dot"
              class="size-[7px] shrink-0 rounded-full"
              :class="statusDotClass(w.entry.meta?.status)"
            />
            <span class="font-medium">{{ w.entry.meta?.title ?? w.viewId }}</span>
            <span
              v-if="w.entry.meta?.progress"
              data-testid="widget-pill-progress"
              class="tabular-nums text-neutral-dim"
            >
              {{ progressLabel(w.entry.meta) }}
            </span>
          </span>
          <!-- 进行中项预览（人实时需要的唯一一条：现在做到哪了） -->
          <span
            v-if="activePreview"
            data-testid="widget-pill-active"
            class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-neutral-fg"
            :title="`${activePreview.widget}: ${activePreview.label}`"
          >
            {{ activePreview.label }}
          </span>
          <!-- 详情 seg：chevron 随 popover 开合旋转 -->
          <span class="flex shrink-0 items-center gap-1 text-neutral-dim">
            {{ t('panel.widget.details') }}
            <ChevronDown
              class="size-3 transition-transform"
              :class="popoverOpen ? 'rotate-180' : ''"
              aria-hidden="true"
            />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        :side-offset="8"
        :collision-padding="8"
        class="w-[560px] max-w-[calc(100vw-16px)] p-0"
        @open-auto-focus.prevent
      >
        <!-- 多 widget 纵向堆叠；max-h 钳制防长列表顶出视口（collision-padding 外的
             自身保险）；select-text 恢复内容可选中复制（全局 user-select:none）。
             testid 落在内层容器：放 PopoverContent 上会被 teleport 吞掉（fragment
             根节点不继承 attrs）。 -->
        <div
          data-testid="widget-popover"
          class="flex max-h-[320px] select-text flex-col gap-3 overflow-y-auto p-3"
        >
          <section
            v-for="w in entries"
            :key="w.viewId"
            data-testid="widget-popover-card"
            class="flex min-w-0 flex-col gap-1.5"
          >
            <!-- 只读卡头（meta 驱动）：状态点 + 标题 + 计数 + mini bar，无折叠交互 -->
            <div class="flex h-6 items-center gap-2 px-1">
              <span
                class="size-[7px] shrink-0 rounded-full"
                :class="statusDotClass(w.entry.meta?.status)"
              />
              <span
                class="min-w-0 truncate font-mono text-[length:var(--text-2xs)] font-medium text-neutral-fg"
              >
                {{ w.entry.meta?.title ?? w.viewId }}
              </span>
              <template v-if="w.entry.meta?.progress">
                <span class="ml-auto shrink-0 font-mono text-[length:var(--text-3xs)] tabular-nums text-neutral-dim">
                  {{ progressLabel(w.entry.meta) }}
                </span>
                <span class="h-[3px] w-10 shrink-0 overflow-hidden rounded-full bg-surface-hover">
                  <span
                    data-testid="widget-popover-progress-fill"
                    class="block h-full rounded-full transition-[width] duration-300"
                    :class="progressFillClass(w.entry.meta)"
                    :style="{ width: progressWidth(w.entry.meta) }"
                  />
                </span>
              </template>
            </div>
            <!-- guiTree 逐项交渲染协议；index key 前提是原语均 props-only 无内部状态，
                 原语引入本地状态时需改稳定 key -->
            <div class="flex min-w-0 flex-col gap-1">
              <GuiComponentRenderer
                v-for="(component, i) in w.entry.guiTree"
                :key="i"
                :component="component"
              />
            </div>
          </section>
        </div>
      </PopoverContent>
    </Popover>
  </div>
</template>
