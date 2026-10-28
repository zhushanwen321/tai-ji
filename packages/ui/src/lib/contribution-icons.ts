/**
 * contribution-icons.ts —— §6.13 图标解析的渲染端组件换算（容器扩展点统一，四容器与头部
 * 按钮共用）。
 *
 * 分工：图标解析（归一化 / 白名单校验 / 错名兜底 + 按去重键 warn 一次）全在 core 单函数
 * resolveContributionIcon（failure-degradation.ts，headless 无组件）；本模块只做解析结果
 * → lucide 组件的最后一跳——CONTRIBUTION_ICON_KEYS 每个成员在此登记组件，缺登成员落
 * 统一兜底（与错名同径，不崩渲染）。各容器不再自持字面量映射表（原四套本地表已随接线
 * 退役），同一图标名跨容器换算结果一致（§6.13 效果）。
 *
 * 放置：ui 包（renderer 依赖 ui、DrawerPanel 在 ui 包内）——renderer 三处消费方经主入口
 * import，DrawerPanel 同包相对 import。
 */
import type { LucideIcon } from '@lucide/vue'
import {
  Blocks,
  BookOpen,
  Bot,
  ChartColumn,
  ClipboardList,
  CircleCheck,
  CircleDot,
  Clock,
  Download,
  FileText,
  Flag,
  Gauge,
  GitBranch,
  Globe,
  LayoutGrid,
  ListChecks,
  ListTree,
  ListTodo,
  MessagesSquare,
  Network,
  Palette,
  PanelRight,
  ScrollText,
  Server,
  Settings,
  SlidersHorizontal,
  Sparkles,
  SquareCheckBig,
  SquareTerminal,
  Tag,
  Target,
  Terminal,
  TerminalSquare,
  Volume2,
  Waypoints,
  Wifi,
  Workflow,
  Zap,
} from '@lucide/vue'
import {
  resolveContributionIcon,
  type ContributionIconInput,
} from '@taiji/core'

/** 白名单 lucide 名 → lucide 组件（键 = CONTRIBUTION_ICON_KEYS 登记名，即 resolveContributionIcon
 *  declared 结果的 canonical key）。 */
const ICON_COMPONENTS: Record<string, LucideIcon> = {
  terminal: Terminal,
  globe: Globe,
  'git-branch': GitBranch,
  'book-open': BookOpen,
  'file-text': FileText,
  bot: Bot,
  'square-terminal': SquareTerminal,
  'square-check-big': SquareCheckBig,
  'messages-square': MessagesSquare,
  workflow: Workflow,
  'list-tree': ListTree,
  'list-checks': ListChecks,
  'list-todo': ListTodo,
  'circle-check': CircleCheck,
  'circle-dot': CircleDot,
  target: Target,
  clock: Clock,
  zap: Zap,
  flag: Flag,
  gauge: Gauge,
  settings: Settings,
  sparkles: Sparkles,
  blocks: Blocks,
  server: Server,
  'clipboard-list': ClipboardList,
  palette: Palette,
  'scroll-text': ScrollText,
  tag: Tag,
  'volume-2': Volume2,
  'terminal-square': TerminalSquare,
  download: Download,
  wifi: Wifi,
  waypoints: Waypoints,
  'sliders-horizontal': SlidersHorizontal,
  'chart-column': ChartColumn,
  network: Network,
  'layout-grid': LayoutGrid,
  'panel-right': PanelRight,
}

/** 统一兜底组件（FALLBACK_CONTRIBUTION_ICON = 'layout-grid' 的组件形态；未声明/错名/
 *  组件表缺登三者同径）。 */
export const FALLBACK_CONTRIBUTION_ICON_COMPONENT: LucideIcon = LayoutGrid

/**
 * §6.13 渲染端唯一图标入口：resolveContributionIcon 解析 + 组件换算。未声明（unset）与
 * 未命中（fallback，core 已按去重键 warn 一次）都落统一兜底。
 */
export function contributionIconComponent(input: ContributionIconInput): LucideIcon {
  const resolution = resolveContributionIcon(input)
  if (resolution.status !== 'declared') return FALLBACK_CONTRIBUTION_ICON_COMPONENT
  return contributionIconComponentByKey(resolution.key)
}

/**
 * canonical 白名单键 → 组件换算（declared 结果的最后一跳）。供需要分辨 declared 与
 * fallback 的消费方（托盘 icon 链 declared 命中即返、fallback 下探内置映射）与高阶封装
 * 共用；键不在组件表（白名单成员缺组件登记）落统一兜底，不崩渲染。
 */
export function contributionIconComponentByKey(key: string): LucideIcon {
  return ICON_COMPONENTS[key] ?? FALLBACK_CONTRIBUTION_ICON_COMPONENT
}
