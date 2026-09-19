<!--
  TrayWidgetButton —— composer 任务托盘（Widget Tray）的协议 widget 条目按钮
  （设计 docs/design/composer-task-tray.md §3.1 场景 B + §3.3 D3/D4/D7 + §3.5 错误规格）。

  ── 契约（供 u-tray-shell 消费）──
  props.viewId: string —— widget key（= ViewHostStore viewId，extension 调 setWidget 的第一个
    参数）；用作显示标题兜底与宿主内置 icon 映射键
  props.meta?: WidgetMeta —— widget 宿主元数据（v1.1 wire 可选；v1 旧 extension 推送时缺省）
  props.pinned?: boolean（默认 false）—— pin 态（外壳持有：点 icon 切换，再点 / Esc / 点外部
    解除）；本组件只渲染按下视觉 + aria-pressed
  props.expanded?: boolean（默认 false）—— 关联面板是否可见（外壳持有：hover 预览或 pin 均置
    true）；只驱动 aria-expanded 与提亮视觉
  emits.hover-start / hover-end —— 指针进入 / 离开 icon。开合时序在外壳（D8：hover 160ms 开 /
    离开整体 240ms 收），本组件不持计时器
  emits.toggle-pin —— 点击 icon（外壳据此切换 pin）

  数据流（D3/D7）：本组件**不持数据源**——条目存在与否由外壳 entries computed 决定
  （ViewHostStore 有 entry 即渲染、invalidate 即消失）；组件只把 entry.meta 投影成
  icon/badge/status 视觉（O(1) 派生），guiTree 不经本组件（面板职责）。

  ── 依赖追踪契约（承自已退役的对话流 widget pill entries computed 头注，托盘为唯一消费端）──
  外壳父级 computed 必须在**同一调用路径内**同时触碰 `getViewIds(sessionId)`（分区键迭代）
  与 `getView(sessionId, viewId)`（分区值读），否则 Vue 不建依赖链 → widget 推送后条目不重算。
  可运行的复刻样例见 __tests__/panel/tray/tray-widget.test.ts 的「外壳契约复刻」宿主。

  ── icon fallback 链（D4，四档）──
  ① `meta.icon` 为 `{ paths }` 且过 `validateWidgetIconPaths` 白名单 → 渲染自定义形状
     `<path :d>`：统一 viewBox 24 / fill none / stroke currentColor / stroke-width 1.75 /
     round linecap·join（形状归 extension、线宽颜色尺寸归宿主锁死）
  ② `meta.icon` 为 string → 宿主 registry 按 lucide 名解析（大小写 / 连字符 / 下划线不敏感）
  ③ 上一档未命中或越限 → 宿主内置 widgetKey 映射（'todo'→ListChecks、'goal'→Target）
  ④ 仍无 → 通用 widget icon（LayoutGrid，与 PluginViewContainer DEFAULT_ICON 同源）
  ① 越限 / ② 未命中时 console.warn 一次（按 viewId+原因去重，防 tool call 级推送刷屏，§3.5）；
  无 icon 字段（含 v1 旧 extension）不是坏数据，静默走 ③/④，不 warn。
  [落地裁决] ② 的「按 lucide 名解析」实现为宿主 registry 白名单而非 @lucide/vue 全量
  namespace 解析——namespace import 击穿 tree-shaking，会把整套 1500+ icon 打进 renderer
  bundle；新增可用名在 WIDGET_ICON_ENTRIES 一行登记即可。

  ── badge fallback 链（D4）──
  `meta.badge` → `meta.progress.label ?? String(meta.progress.current)` → 无
  超长 truncate 至 BADGE_MAX_CHARS 字符，全文进 badge 的 title（§3.5）

  ── status 视觉（D4：running=accent+呼吸点 / done=success / failed=danger / idle=dim）──
  视觉序列 = `[icon][呼吸点（仅 running，size-1.5 + animate-pulse，与统一表单 overlay
  同款）][badge 计数]`（外壳 built-in 三件按同序镜像 → §3.1 场景 A 的「icon + mono 计数 +
  呼吸点」同视觉语言）。
  icon 与 badge 同取状态色；idle 走 neutral-dim；v1 旧 extension 无 status 时 icon 继承按钮
  中性色（常态 dim、交互提亮）。归零不虚亮：非 running 不渲染任何呼吸点元素。
-->
<template>
  <Button
    type="button"
    variant="ghost"
    data-testid="tray-widget-button"
    :data-widget-key="viewId"
    :title="displayTitle"
    :aria-label="displayTitle"
    :aria-expanded="expanded ? 'true' : 'false'"
    :aria-pressed="pinned ? 'true' : 'false'"
    :class="trayItemButtonClass(pinned || expanded)"
    @pointerenter="emit('hover-start')"
    @pointerleave="emit('hover-end')"
    @click="emit('toggle-pin')"
  >
    <!-- icon 区（fallback 链产物：自定义形状 svg 或 lucide 组件二选一） -->
    <span
      data-testid="tray-widget-icon"
      class="flex size-4 shrink-0 items-center justify-center"
      :class="toneClass"
    >
      <svg
        v-if="icon.kind === 'paths'"
        data-testid="tray-widget-icon-paths"
        class="size-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path v-for="(d, i) in icon.paths" :key="i" :d="d" />
      </svg>
      <component
        :is="icon.component"
        v-else
        data-testid="tray-widget-icon-glyph"
        stroke-width="1.75"
        aria-hidden="true"
      />
    </span>
    <!-- badge 组：呼吸点（仅 running）+ 计数文本（两段都无 → 整组不渲染，零视觉噪音） -->
    <span
      v-if="showBadgeGroup"
      data-testid="tray-widget-status"
      class="flex shrink-0 items-center gap-1"
    >
      <span
        v-if="isRunning"
        data-testid="tray-widget-pulse"
        :class="TRAY_PULSE_CLASS"
        aria-hidden="true"
      />
      <span
        v-if="badgeText"
        data-testid="tray-widget-badge"
        :class="[TRAY_ITEM_COUNT_CLASS, toneClass]"
        :title="badgeFull"
      >
        {{ badgeText }}
      </span>
    </span>
  </Button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import { CircleCheck, CircleDot, Clock, Flag, Gauge, LayoutGrid, ListChecks, ListTodo, SquareCheckBig, Target, Zap } from '@lucide/vue'
import { validateWidgetIconPaths } from '@zhushanwen/extension-protocol'
import type { WidgetMeta } from '@zhushanwen/extension-protocol'
import { Button } from '@/components/ui/button'
import { TRAY_ITEM_COUNT_CLASS, TRAY_PULSE_CLASS, trayItemButtonClass } from '@/components/panel/tray/tray-item-button'
import { widgetToneText } from '@/components/panel/tray/tray-tone'

const props = withDefaults(
  defineProps<{
    /** widget key（= ViewHostStore viewId）：标题兜底 + 内置 icon 映射键 */
    viewId: string
    /** widget 宿主元数据（可选：v1 旧 extension 推送无 meta） */
    meta?: WidgetMeta
    /** pin 态（外壳持有） */
    pinned?: boolean
    /** 关联面板是否可见（外壳持有：hover 预览或 pin） */
    expanded?: boolean
  }>(),
  { pinned: false, expanded: false },
)

const emit = defineEmits<{
  /** 指针进入 icon（外壳 160ms 后开面板） */
  'hover-start': []
  /** 指针离开 icon（外壳 240ms 后收起；移入面板不收起由外壳统一热区判定） */
  'hover-end': []
  /** 点击 icon（外壳切换 pin） */
  'toggle-pin': []
}>()

/** badge 截断上限（D4/§3.5：建议 extension ≤6 字符，超出由宿主 truncate 且全文进 title） */
const BADGE_MAX_CHARS = 6

/** 宿主内置 widgetKey → icon 映射（D4 第三档；新增默认 widget 在此登记）。
 *  用 Map 非普通对象：viewId 由 extension 决定，裸对象下标会把 'constructor' 等原型链键
 *  取成函数当组件渲染（脏数据崩渲染）。 */
const BUILTIN_WIDGET_ICONS: ReadonlyMap<string, Component> = new Map<string, Component>([
  ['todo', ListChecks],
  ['goal', Target],
])

/**
 * 宿主 icon registry（D4 第二档）：按 lucide 名解析（归一化后匹配，见 normalizeIconKey）。
 * 刻意不用 @lucide/vue namespace 全量解析——见文件头「落地裁决」。
 */
const WIDGET_ICON_ENTRIES: ReadonlyArray<readonly [string, Component]> = [
  ['list-checks', ListChecks],
  ['list-todo', ListTodo],
  ['square-check-big', SquareCheckBig],
  ['circle-check', CircleCheck],
  ['circle-dot', CircleDot],
  ['target', Target],
  ['clock', Clock],
  ['zap', Zap],
  ['flag', Flag],
  ['gauge', Gauge],
]

/** registry 查表（模块级常量表，非缓存：仅归一化键名映射，无运行时写方） */
const WIDGET_ICON_REGISTRY: ReadonlyMap<string, Component> = new Map(
  WIDGET_ICON_ENTRIES.map(([name, icon]) => [normalizeIconKey(name), icon]),
)

/** 通用 widget icon（D4 第四档）：与 PluginViewContainer 的 view 兜底 icon 同源（LayoutGrid） */
const FALLBACK_WIDGET_ICON: Component = LayoutGrid

/** registry 键归一化：忽略大小写与 -/_/空格（extension 侧拼写习惯各异，宽容优于强制单写法） */
function normalizeIconKey(name: string): string {
  return name.trim().toLowerCase().replace(/[-_\s]/g, '')
}

/** icon 解析结果：自定义形状 paths 或 lucide 组件（二选一，模板据此分支） */
type WidgetIcon =
  | { kind: 'paths'; paths: string[] }
  | { kind: 'glyph'; component: Component }

/**
 * warn 去重表（§3.5「console warn 一次」）：键 = viewId|原因——同一 widget 的同因坏数据在
 * tool call 级重推下只提示一次。模块级持有（同 Vue warnOnce 模式，跨实例生效），
 * 不承载任何业务状态（只记已提示过的诊断键）。
 */
const warnedIconIssues = new Set<string>()

/** 坏 icon 数据的一次性诊断（含恢复动作，规则 16：错误信息必须可操作） */
function warnIconOnce(viewId: string, reason: string): void {
  const key = `${viewId}|${reason}`
  if (warnedIconIssues.has(key)) return
  warnedIconIssues.add(key)
  console.warn(
    `[tray] widget '${viewId}' 的 meta.icon 落兜底（${reason}）——`
      + '请 extension 修正 icon（自定义形状见 validateWidgetIconPaths 白名单，或改用宿主 registry 内的 lucide 名）',
  )
}

/** icon fallback 链（D4 四档顺序，见文件头）。越限/未知各 warn 一次后继续下探。 */
function resolveWidgetIcon(viewId: string, raw: WidgetMeta['icon'] | undefined): WidgetIcon {
  if (raw !== undefined && typeof raw !== 'string') {
    // 显式 null 是协议可达形态（wire 上 stripUndefined 只删 undefined 不删 null，第三方独立
    // 安装扩展可推 icon: null）——null 无 paths 可取，归 'not-array' 走既有兜底链（与非法
    // paths 同路：warn 一次 + 下探内置映射），守住「坏数据不崩渲染」契约
    const validation = validateWidgetIconPaths(raw === null ? undefined : raw.paths)
    if (validation.valid) return { kind: 'paths', paths: validation.paths }
    warnIconOnce(viewId, validation.reason)
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    const hit = WIDGET_ICON_REGISTRY.get(normalizeIconKey(raw))
    if (hit) return { kind: 'glyph', component: hit }
    warnIconOnce(viewId, 'unknown-key')
  }
  const builtin = BUILTIN_WIDGET_ICONS.get(normalizeIconKey(viewId))
  return { kind: 'glyph', component: builtin ?? FALLBACK_WIDGET_ICON }
}

const icon = computed<WidgetIcon>(() => resolveWidgetIcon(props.viewId, props.meta?.icon))

/** 显示标题：meta.title（空串视为缺省）→ viewId（v1 旧 extension 与脏数据兜底） */
const displayTitle = computed(() => {
  const title = props.meta?.title
  return title !== undefined && title.trim() !== '' ? title : props.viewId
})

/** badge 全文：meta.badge → progress.label ?? String(progress.current) → 无（空串等同无） */
const badgeFull = computed<string | undefined>(() => {
  const progress = props.meta?.progress
  const raw = props.meta?.badge ?? progress?.label ?? (progress ? String(progress.current) : undefined)
  return raw !== undefined && raw !== '' ? raw : undefined
})

/** badge 显示文本（超长 truncate，全文在 title） */
const badgeText = computed<string | undefined>(() =>
  badgeFull.value === undefined ? undefined : badgeFull.value.slice(0, BADGE_MAX_CHARS),
)

const isRunning = computed(() => props.meta?.status === 'running')

const toneClass = computed<string>(() => widgetToneText(props.meta?.status))

/** badge 组可见性：running 的呼吸点独立于 badge 文本（无计数也表达「在跑」） */
const showBadgeGroup = computed(() => isRunning.value || badgeText.value !== undefined)
</script>
