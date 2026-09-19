<!--
  ComposerTray —— composer 任务托盘外壳（设计 docs/design/composer-task-tray.md
  §3.3 D1/D6/D8/D9/D12 + §3.1 场景 A/C + §3.4 终态数据流 + §3.5 错误规格 + §3.6 探针 P7）。

  ── 结构与挂载（D1/D12）──
  挂 `Composer.vue` 的 `.composer-bar` 左簇、AddMenuPopover 之后（`v-if="sessionId"`，landing 态
  隐藏与 GenStatsTriggers 同判据）；随 Composer 实例化（per-Composer 归属），数据按该 Composer 绑定
  的 sessionId 过滤——三件计数走 `useTrayCounts(sessionId)`（**唯一实例在本外壳创建**，见文末
  「数据面归属」），widget 走 ViewHostStore 的 per-session 分区，切 session 即跟随。
  条目 = built-in 四件（bash → subagent → workflow → session，固定序恒在最左）+ 协议 widget 区（排序后逐个
  TrayWidgetButton）。两类条目共用同一套外壳状态机（hover/pin/互斥），面板内容按类型分流：

    built-in 三件 → TrayNativePanel（kind / sessionId / **显式透传 pinned**——否则行内操作永不渲染）
    built-in 第 4 件 session（u7）→ TraySessionPanel（子会话扁平列表，:session-id / pinned）
    widget   → TrayWidgetPanel（viewId / meta / guiTree，meta+guiTree 取自外壳 entries 切片）

  ── built-in 三态（D7；验收 N2「归零不虚亮」）──
  running > 0 → 亮计数 + 呼吸点（accent；视觉序与 TrayWidgetButton 同款 [icon][呼吸点][计数]）
  有历史无进行中 → dim 常驻（无计数、无呼吸点）
  全无记录 → 该按钮不渲染（DOM 层不存在，而非 opacity:0 —— 归零不虚亮的结构性保证）

  ── 交互状态机（D8）──
  hover icon 160ms → 开面板；指针离开 icon+面板整体 240ms → 收起；期间指针移入浮层内不收起
  （热区 = 浮层内容 div，其内边距 p-1.5 在内容 div 自身上 ⇒ 覆盖浮层全幅，指针停在 padding
  带上同样取消计时；U3 修复）。
  点击 icon = pin（面板常驻；hover 态刻意不渲染行内按钮防误触，见 TrayNativePanel 契约）；
  再点 / Esc / 点面板外 = 解除。**同一时刻至多一个面板**——由单一 activeKey 结构性保证（互斥不是
  靠多实例互检），派生视觉（按钮 aria-*、面板 data-pinned）全部由它派生，无双份真相。

  ── 面板浮层（D8 + 探针 P7 + [固定高裁决 2026-09-16]）──
  锚定 icon 上方（side="top"）、宽 400px、内容区固定高 h-[340px]（小屏 max-h 60vh 兜底）内
  滚动——固定高使切内部 tab 时容器不塌缩，hover 态指针不落空（面板收起的根因消除）；浮层
  样式沿用仓内 popover 范式
  （PopoverContent：bg-elevated + border-strong + shadow-2 + radius-md；锚点范式见 docs/DESIGN.md
  §5.12）。面板本身不设宽度/高度（尺寸由外壳承载，见两面板组件头注契约）。
  [探针 P7 真机复核，阶段 5] 若窗口最小宽度下 reka Popover 翻转/裁剪异常，降级预案 = 手写
  anchored 浮层（absolute 相对按钮容器，bottom: calc(100% + 6px)，同 §5.12 锚点范式）；降级只换
  浮层实现，本文件的状态机与两面板契约不动。

  ── 关闭路径接线（外壳消费 reka DismissableLayer，open 受控）──
  - `:open` 由外壳状态驱动，reka 只上报「应关闭」（Esc / 层外 pointerdown / 焦点移出）→
    onPanelOpenChange 清 activeKey 与 pin，不反向驱动开；
  - 托盘自身按钮行内的 pointerdown 在 reka 眼里属「层外」（anchor 非 trigger）：若不拦截会先把面板
    关掉、再被随后的 click 重新 pin——表现为「永远 pin 不住」。故 onInteractOutside 对托盘根节点内
    的目标 preventDefault（click 的 pin 语义归 onTogglePin 独占）；
  - 面板打开不抢焦点（onOpenAutoFocus preventDefault）：hover 预览打开时用户可能正在 composer 输入。
  - 条目消失（widget 被 setWidget(key, undefined) 清屏 / built-in 该类记录归零）→ 面板与 pin 一并
    作废（判据 = renderedPanelKeys）；条目重新出现时不继承旧交互态（不「诈尸」弹回）。

  ── widget 区依赖追踪契约（u-tray-widget 头注；断链症状 = 推送后不重算）──
  entries computed 必须**在同一调用路径内**同时触碰 `getViewIds(sessionId)`（分区键迭代）与
  `getView(sessionId, viewId)`（分区值读），顺序由 tray-order 的 orderTrayWidgetIds（known-order
  ['todo','goal'] 优先 + 当前插入序）决定；拆开即断链。可运行复刻样例见
  __tests__/panel/tray/tray-widget.test.ts 的「外壳契约复刻」宿主。

  ── 数据面归属（D2/D13）──
  计数/首拉/错误态全部在 useTrayCounts，**唯一实例在本外壳创建**（面板随 Popover 开合反复
  挂载/卸载，数据面必须活在外壳上：面板打开时数据已在，且打开/关闭不重发首拉 RPC）——创建即
  provide(TRAY_COUNTS_KEY)，面板经 useTrayCountsContext inject 消费同一实例；行集与行内操作在
  TrayNativePanel 自持（面板 emits 为空，外壳无需回调）。
-->
<template>
  <div
    ref="trayRootEl"
    data-testid="composer-tray"
    :data-session-id="sessionId"
    role="group"
    :aria-label="t('panel.tray.trayLabel')"
    class="flex min-w-0 shrink-0 items-center gap-0.5"
  >
    <!-- 序 4 聚合单入口（D6 密度档 `aggregated`）：整个托盘收为「层叠图标 + 运行数」一个按钮，
         点击开面板（TrayPanelSurface）内分段展示全部类别（TrayAggregatePanel）；
         `hasTrayItems === false`（三态之「全无」）整块不渲染——聚合态同样不留死入口。
         图标语义硬约束：聚合入口 = 层叠图标（此处），溢出入口 = 省略号（Composer 底栏），两者不共用。 -->
    <Popover
      v-if="aggregated && hasTrayItems"
      :open="activeKey === AGGREGATE_PANEL_KEY"
      @update:open="(open: boolean) => onPanelOpenChange(AGGREGATE_PANEL_KEY, open)"
    >
      <PopoverAnchor as-child>
        <Button
          type="button"
          variant="ghost"
          data-testid="tray-aggregate-button"
          :data-running="aggregateRunningCount"
          :title="aggregateTitle"
          :aria-label="aggregateTitle"
          :aria-expanded="activeKey === AGGREGATE_PANEL_KEY ? 'true' : 'false'"
          :aria-pressed="isPinnedOf(AGGREGATE_PANEL_KEY) ? 'true' : 'false'"
          :class="trayItemButtonClass(isPinnedOf(AGGREGATE_PANEL_KEY) || activeKey === AGGREGATE_PANEL_KEY)"
          @pointerenter="onHoverStart(AGGREGATE_PANEL_KEY)"
          @pointerleave="onHoverEnd"
          @click="onTogglePin(AGGREGATE_PANEL_KEY)"
        >
          <!-- 层叠图标（各类别 icon 重叠排布；仅 widget 无 built-in 时给通用网格图标兜底） -->
          <span class="flex shrink-0 items-center -space-x-1" aria-hidden="true">
            <span
              v-for="item in builtinItems"
              :key="item.kind"
              class="grid size-4 place-items-center rounded-full bg-bg-input ring-1 ring-border"
            >
              <component
                :is="item.icon"
                class="size-2.5"
                :class="item.running > 0 ? 'text-accent' : 'text-neutral-dim'"
              />
            </span>
            <LayoutGrid v-if="builtinItems.length === 0" class="size-4 text-neutral-dim" />
          </span>
          <!-- 运行数（归零不虚亮：running === 0 时呼吸点与计数都不出，与三态同款） -->
          <span
            v-if="aggregateRunningCount > 0"
            data-testid="tray-aggregate-pulse"
            :class="TRAY_PULSE_CLASS"
            aria-hidden="true"
          />
          <span
            v-if="aggregateRunningCount > 0"
            data-testid="tray-aggregate-count"
            :class="[TRAY_ITEM_COUNT_CLASS, 'text-accent']"
          >{{ aggregateRunningCount }}</span>
        </Button>
      </PopoverAnchor>
      <TrayPanelSurface
        panel-key="aggregate"
        :pinned="isPinnedOf(AGGREGATE_PANEL_KEY)"
        @panel-enter="onPanelEnter"
        @panel-leave="onPanelLeave"
        @interact-outside="onInteractOutside"
        @open-auto-focus="onOpenAutoFocus"
      >
        <TrayAggregatePanel
          :session-id="sessionId"
          :sections="builtinItems"
          :widgets="widgetItems"
          :pinned="isPinnedOf(AGGREGATE_PANEL_KEY)"
        />
      </TrayPanelSurface>
    </Popover>

    <template v-if="!aggregated">
    <!-- built-in 三件（固定序 bash → subagent → workflow；三态判定见文件头） -->
    <Popover
      v-for="item in builtinItems"
      :key="item.kind"
      :open="activeKey === builtinKey(item.kind)"
      @update:open="(open: boolean) => onPanelOpenChange(builtinKey(item.kind), open)"
    >
      <PopoverAnchor as-child>
        <Button
          type="button"
          variant="ghost"
          data-testid="tray-builtin-button"
          :data-kind="item.kind"
          :data-state="item.running > 0 ? 'running' : 'idle'"
          :title="t(`panel.tray.title.${item.kind}`)"
          :aria-label="t(`panel.tray.title.${item.kind}`)"
          :aria-expanded="activeKey === builtinKey(item.kind) ? 'true' : 'false'"
          :aria-pressed="isPinnedOf(builtinKey(item.kind)) ? 'true' : 'false'"
          :class="trayItemButtonClass(isPinnedOf(builtinKey(item.kind)) || activeKey === builtinKey(item.kind))"
          @pointerenter="onHoverStart(builtinKey(item.kind))"
          @pointerleave="onHoverEnd"
          @click="onTogglePin(builtinKey(item.kind))"
        >
          <component
            :is="item.icon"
            class="size-4 shrink-0"
            :class="item.running > 0 ? 'text-accent' : ''"
            aria-hidden="true"
          />
          <!-- 呼吸点 + 计数：仅「有进行中」渲染（有历史无进行中 → 两者都不出，归零不虚亮） -->
          <span
            v-if="item.running > 0"
            data-testid="tray-builtin-pulse"
            :class="TRAY_PULSE_CLASS"
            aria-hidden="true"
          />
          <span
            v-if="item.running > 0"
            data-testid="tray-builtin-count"
            :class="[TRAY_ITEM_COUNT_CLASS, 'text-accent']"
          >{{ badgeCount(item) }}</span>
        </Button>
      </PopoverAnchor>
      <TrayPanelSurface
        :panel-key="builtinKey(item.kind)"
        :pinned="isPinnedOf(builtinKey(item.kind))"
        @panel-enter="onPanelEnter"
        @panel-leave="onPanelLeave"
        @interact-outside="onInteractOutside"
        @open-auto-focus="onOpenAutoFocus"
      >
        <TrayNativePanel
          v-if="item.kind !== 'session'"
          :session-id="sessionId"
          :kind="item.kind"
          :pinned="isPinnedOf(builtinKey(item.kind))"
        />
        <TraySessionPanel
          v-else
          :session-id="sessionId"
          :pinned="isPinnedOf(builtinKey(item.kind))"
        />
      </TrayPanelSurface>
    </Popover>

    <!-- 协议 widget 区（D3/D6/D7）：有 entry 即渲染、invalidate 即消失（条目存在性由 entries 决定） -->
    <Popover
      v-for="item in widgetItems"
      :key="item.viewId"
      :open="activeKey === widgetKey(item.viewId)"
      @update:open="(open: boolean) => onPanelOpenChange(widgetKey(item.viewId), open)"
    >
      <PopoverAnchor as-child>
        <TrayWidgetButton
          :view-id="item.viewId"
          :meta="item.entry.meta"
          :pinned="isPinnedOf(widgetKey(item.viewId))"
          :expanded="activeKey === widgetKey(item.viewId)"
          @hover-start="onHoverStart(widgetKey(item.viewId))"
          @hover-end="onHoverEnd"
          @toggle-pin="onTogglePin(widgetKey(item.viewId))"
        />
      </PopoverAnchor>
      <TrayPanelSurface
        :panel-key="widgetKey(item.viewId)"
        :pinned="isPinnedOf(widgetKey(item.viewId))"
        @panel-enter="onPanelEnter"
        @panel-leave="onPanelLeave"
        @interact-outside="onInteractOutside"
        @open-auto-focus="onOpenAutoFocus"
      >
        <!-- ScrollArea flex-1 + min-h-0：固定高下内容超出即内部滚动，不足则顶部对齐留白 -->
        <ScrollArea class="min-h-0 flex-1">
          <TrayWidgetPanel
            :view-id="item.viewId"
            :meta="item.entry.meta"
            :gui-tree="item.entry.guiTree"
          />
        </ScrollArea>
      </TrayPanelSurface>
    </Popover>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 脚本分区：常量与类型 / 数据面（计数 + widget entries） / 外壳状态机（hover·pin·互斥） /
 * 关闭路径接线（reka 层） / 会话切换与卸载清理。
 */
import { computed, inject, onBeforeUnmount, provide, ref, watch } from 'vue'
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot, LayoutGrid, SquareTerminal, Waypoints, Workflow } from '@lucide/vue'
import { VIEW_HOST_SOURCE_KEY } from '@taiji/ui/extension-host'
import type { ViewCacheEntry } from '@taiji/ui/extension-host'
import { Popover, PopoverAnchor } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TRAY_COUNTS_KEY, useTrayCounts } from '@/components/panel/tray/useTrayCounts'
import type { TrayBuiltinKind } from '@/components/panel/tray/useTrayCounts'
import { orderTrayWidgetIds } from '@/components/panel/tray/tray-order'
import TrayAggregatePanel from '@/components/panel/tray/TrayAggregatePanel.vue'
import TrayNativePanel from '@/components/panel/tray/TrayNativePanel.vue'
import TrayPanelSurface from '@/components/panel/tray/TrayPanelSurface.vue'
import TraySessionPanel from '@/components/panel/tray/TraySessionPanel.vue'
import TrayWidgetButton from '@/components/panel/tray/TrayWidgetButton.vue'
import TrayWidgetPanel from '@/components/panel/tray/TrayWidgetPanel.vue'
import { TRAY_ITEM_COUNT_CLASS, TRAY_PULSE_CLASS, trayItemButtonClass } from '@/components/panel/tray/tray-item-button'

const props = withDefaults(
  defineProps<{
    /** 焦点 session id（数据分区键；Composer 侧 `v-if="sessionId"` 保证非空） */
    sessionId: string
    /**
     * 密度档驱动的托盘形态（u6b / D6 序 4）：true = 收为单个聚合入口
     * （层叠图标 + 运行数 → 面板内分段展示全部类别）；false = 既有逐件按钮行。
     */
    aggregated?: boolean
  }>(),
  { aggregated: false },
)

/**
 * 托盘三态上抛（能力标志 `hasTrayItems`）：托盘数据的唯一实例在本外壳（D2），Composer 底栏的
 * 密度状态机需要「托盘是否全无条目」才能决定序 4 是否生效——故由本外壳 watch 后经事件上抛，
 * 而不是让 Composer 自建第二份托盘数据面。
 */
const emit = defineEmits<{ 'update:hasItems': [hasItems: boolean] }>()

const { t } = useI18n()

// ── 常量 ──

/** hover 开面板延时（D8：160ms——高频「瞄一眼」不让指针路过就闪面板） */
const HOVER_OPEN_DELAY_MS = 160
/** 指针离开 icon+面板整体后的收起延时（D8：240ms——覆盖 icon 与面板之间 6px 间隙的移动耗时） */
const HOVER_CLOSE_DELAY_MS = 240

/** built-in 四件固定序（D1：不参与 widget 动态排序，恒在最左；第 4 件 session 见 u7 / §6.7 D7） */
const BUILTIN_ORDER: readonly TrayBuiltinKind[] = ['bash', 'subagent', 'workflow', 'session']

/** built-in 四件 icon（四件各自语义直取：bash = 终端、subagent = Bot、workflow = 流程、session = 层叠路径） */
const BUILTIN_ICONS: Record<TrayBuiltinKind, Component> = {
  bash: SquareTerminal,
  subagent: Bot,
  workflow: Workflow,
  session: Waypoints,
}

/** 面板键：built-in 与 widget 各带命名空间前缀，避免「widget 恰好叫 bash」撞键（单 activeKey 互斥，键必须无歧义） */
type BuiltinPanelKey = `native:${TrayBuiltinKind}`
type WidgetPanelKey = `widget:${string}`
/** 序 4 聚合入口的面板键（单入口单面板，故为单字面量而非前缀模板） */
type AggregatePanelKey = 'aggregate'
type TrayPanelKey = AggregatePanelKey | BuiltinPanelKey | WidgetPanelKey

const AGGREGATE_PANEL_KEY: AggregatePanelKey = 'aggregate'

function builtinKey(kind: TrayBuiltinKind): BuiltinPanelKey {
  return `native:${kind}`
}
function widgetKey(viewId: string): WidgetPanelKey {
  return `widget:${viewId}`
}

interface BuiltinItem {
  kind: TrayBuiltinKind
  icon: Component
  /** 进行中计数（> 0 决定亮计数/呼吸点；0 且 total > 0 → dim 常驻） */
  running: number
  /** 全量计数（聚合面板段头显示 running/total；与面板 tab 计数同源） */
  total: number
}

interface WidgetItem {
  viewId: string
  entry: ViewCacheEntry
}

// ── 数据面 ──

/** 托盘根节点：层外 pointerdown 判定用（点击自身按钮行不算「面板外」，见文件头） */
const trayRootEl = ref<HTMLElement | null>(null)

/**
 * built-in 三件计数（口径/首拉/错误态全在 useTrayCounts；本组件只做三态判定）。
 * **数据面单例**：本组件是唯一实例创建者，创建即 provide 给面板（TRAY_COUNTS_KEY）——
 * 面板随 Popover 每次打开重新挂载，自建实例会在每次 hover 打开时重发首拉 RPC。
 */
const tray = useTrayCounts(computed(() => props.sessionId))
provide(TRAY_COUNTS_KEY, tray)

/**
 * built-in 条目 = 有记录的三件（三态：running > 0 亮 / 有历史 dim / 全无 → 不渲染）。
 * 计数源与面板列表同源（useTrayCounts），不产生第二份口径。
 */
const builtinItems = computed<BuiltinItem[]>(() =>
  BUILTIN_ORDER.flatMap((kind) => {
    const { running, total } = tray.counts.value[kind]
    if (total === 0) return []
    return [{ kind, icon: BUILTIN_ICONS[kind], running, total }]
  }),
)

/** 计数徽标值：session 件 = 子会话总数（设计 `.tmp/tech-design/mode-system-composer-density.md` §6.7 D7），其余件 = 进行中数 */
function badgeCount(item: BuiltinItem): number {
  return item.kind === 'session' ? item.total : item.running
}

/** ViewHost 数据源（未 provide 时视为无 widget：不抛错不 warn——缺 source 只影响 widget 区渲染） */
const viewHostSource = inject(VIEW_HOST_SOURCE_KEY, null)

/**
 * widget 区条目（依赖追踪契约见文件头：getViewIds + getView 同路径，拆开即断链）。
 * guiTree 空（异常 payload / 清屏竞态）视为无条目，不渲染空壳。
 */
const widgetItems = computed<WidgetItem[]>(() => {
  const source = viewHostSource
  if (!source) return []
  const sessionId = props.sessionId
  return orderTrayWidgetIds(source.getViewIds(sessionId))
    .map((viewId) => ({ viewId, entry: source.getView(sessionId, viewId) }))
    .filter((item): item is WidgetItem => item.entry !== undefined && item.entry.guiTree.length > 0)
})

/**
 * 托盘是否有条目（built-in 任一类别有记录 或 协议 widget 有 entry）——三态之「全无」的对立面，
 * 供 ① 序 4 聚合入口是否渲染（本地）② Composer 底栏密度状态机的 `hasTrayItems`（上抛）。
 * 声明位置在 widgetItems 之后：`immediate` 立即求值，不得落进 widgetItems 的 TDZ 窗口。
 */
const hasTrayItems = computed(() => builtinItems.value.length > 0 || widgetItems.value.length > 0)

watch(hasTrayItems, (value) => emit('update:hasItems', value), { immediate: true })

/** 聚合入口运行数（built-in 进行中 + widget 推送中；归零不虚亮由按钮 v-if 统一判定） */
const aggregateRunningCount = computed(
  () =>
    builtinItems.value.reduce((sum, item) => sum + item.running, 0) +
    widgetItems.value.filter((item) => item.entry.meta?.status === 'running').length,
)

/** 聚合入口 title / aria-label（带运行数：聚合态下这是唯一可扫读的数字） */
const aggregateTitle = computed(() =>
  t('panel.tray.aggregate.title', { running: aggregateRunningCount.value }),
)

/** 当前渲染出按钮的面板键集合（activeKey 有效性判据：键不在集合内 = 条目已消失，状态随之作废） */
const renderedPanelKeys = computed<TrayPanelKey[]>(() => {
  // 聚合态下只有聚合面板键存在（条目集 = 「有任一条目」）；非聚合态逐件键（同既有语义）
  if (props.aggregated) return hasTrayItems.value ? [AGGREGATE_PANEL_KEY] : []
  return [
    ...builtinItems.value.map((item) => builtinKey(item.kind)),
    ...widgetItems.value.map((item) => widgetKey(item.viewId)),
  ]
})

// ── 外壳状态机（D8：hover 预览 + pin 常驻 + 互斥）──

/** 当前打开的面板键（null = 全关）；互斥由它单一持有 */
const activeKey = ref<TrayPanelKey | null>(null)
/** pin 态：只对当前 activeKey 生效（切换面板即回到预览态） */
const pinned = ref(false)

let openTimer: ReturnType<typeof setTimeout> | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null

function clearOpenTimer(): void {
  if (openTimer !== null) {
    clearTimeout(openTimer)
    openTimer = null
  }
}

function clearCloseTimer(): void {
  if (closeTimer !== null) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
}

function clearTimers(): void {
  clearOpenTimer()
  clearCloseTimer()
}

/** 面板关闭（清计时器 + 清 activeKey + 清 pin）：Esc / 点面板外 / 会话切换 / 条目清屏共用 */
function closePanel(): void {
  clearTimers()
  activeKey.value = null
  pinned.value = false
}

/** 某面板是否为「当前打开且已 pin」（按钮按下视觉、面板 pinned 透传的唯一判据） */
function isPinnedOf(key: TrayPanelKey): boolean {
  return pinned.value && activeKey.value === key
}

/** 指针进入 icon：取消待收起；已开则只取消收起；未开则 160ms 后开（切换时旧面板随之关闭 = 互斥） */
function onHoverStart(key: TrayPanelKey): void {
  clearCloseTimer()
  clearOpenTimer()
  if (activeKey.value === key) return
  openTimer = setTimeout(() => {
    openTimer = null
    activeKey.value = key
    pinned.value = false
  }, HOVER_OPEN_DELAY_MS)
}

/** 指针离开 icon 或面板：取消待打开；pin 态不收起；否则 240ms 后收起（移入面板会取消该计时器） */
function onHoverEnd(): void {
  clearOpenTimer()
  if (pinned.value) return
  clearCloseTimer()
  closeTimer = setTimeout(() => {
    closeTimer = null
    if (!pinned.value) activeKey.value = null
  }, HOVER_CLOSE_DELAY_MS)
}

/** 指针移入面板（icon 与面板之间的间隙移动）：取消待收起 */
function onPanelEnter(): void {
  clearCloseTimer()
}

/** 指针离开面板：与离开 icon 同语义（240ms 后收起，除非 pin） */
function onPanelLeave(): void {
  onHoverEnd()
}

/** 点击 icon：pin 切换（再点同键 = 解除）；其余情况 = 立刻打开并 pin（不等 hover 延时） */
function onTogglePin(key: TrayPanelKey): void {
  clearTimers()
  if (activeKey.value === key && pinned.value) {
    closePanel()
    return
  }
  activeKey.value = key
  pinned.value = true
}

// ── 关闭路径接线（reka 层：Esc / 点面板外 / 焦点移出 → update:open(false)）──

/** reka 的 open 上报：只消费「应关闭」（打开恒由外壳状态驱动） */
function onPanelOpenChange(key: TrayPanelKey, open: boolean): void {
  if (open) return
  if (activeKey.value !== key) return
  closePanel()
}

/**
 * 层外交互拦截：目标落在托盘按钮行内时不视为「面板外」——否则 pointerdown 先解除 pin、
 * 随后的 click 又把它 pin 回去，用户永远解不开（见文件头「关闭路径接线」）。
 */
function onInteractOutside(event: Event): void {
  const target = event.target
  if (trayRootEl.value && target instanceof Node && trayRootEl.value.contains(target)) {
    event.preventDefault()
  }
}

/** 面板打开不抢焦点：hover 预览期间用户可能正在 composer 输入（`!` 前缀等） */
function onOpenAutoFocus(event: Event): void {
  event.preventDefault()
}

// ── 会话切换 / 条目消失 / 卸载清理 ──

// 切 session：面板与 pin 一并作废（否则新 session 下会沿用旧态，A6「不残留旧任务」）
watch(() => props.sessionId, () => {
  closePanel()
})

// 条目消失（widget 被清屏 setWidget(key, undefined) → invalidate；built-in 该类记录归零 → 按钮摘除）：
// 面板随条目一并作废，pin 不残留——否则条目重新出现时面板会「诈尸」弹回（新条目不该继承旧交互态）。
watch(renderedPanelKeys, (keys) => {
  const key = activeKey.value
  if (key !== null && !keys.includes(key)) closePanel()
})

onBeforeUnmount(() => {
  clearTimers()
})
</script>
