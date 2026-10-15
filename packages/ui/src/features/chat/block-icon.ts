import type { Component } from 'vue'
import {
  Lightbulb,
  BookOpen,
  ChevronRight,
  SquareTerminal,
  Pencil,
  SquareFunction,
  Search,
  Users,
  Workflow,
  ArrowRight,
} from '@lucide/vue'
import type { ToolCallStatus } from '@taiji/shared'

/**
 * block-icon.ts —— trace 块图标映射（Demo H 最终视觉 SSOT）。
 *
 * 9 类 BlockIconKind 对应 trace 流里所有块的图标语义。getBlockIcon 按「状态 > 类型」的
 * 固定优先级决策（running 覆盖一切 → subagent → workflow → toolName 映射）。
 *
 * failed 不换形（demo TurnList.vue:86-89 权威：图标名不随失败态变，仅由消费方
 * headerIconClass 把原工具图标染 danger——原 'failed'→AlertTriangle 换形枚举已删）。
 *
 * BLOCK_ICON_LUCIDE 是 H 最终图标（lightbulb/book-open/square-terminal/pencil/search/users/
 * workflow/arrow-right），统一规格 14×14 / stroke-width 1.7 / currentColor。
 * running 态不走该映射，消费方改用 RunningBlockIcon 动效组件（每类活动专属动效，
 * 字形保留 + accent 动效元素——双环/呼吸弧全类型共用 loader 退役，见 RunningBlockIcon.vue）。
 *
 * 归属：本文件是图标决策的 SSOT（IF1/IF2 契约）。消费方拿 BlockIconKind 后，running 用
 * toolName → 动效 kind 映射（Block.vue TOOL_RUNNING_KIND），其余用 BLOCK_ICON_LUCIDE[kind]。
 */
export type BlockIconKind =
  | 'thinking' | 'tool-read' | 'tool-bash' | 'tool-cmd' | 'tool-edit' | 'tool-grep' | 'tool-other'
  | 'subagent' | 'workflow' | 'running' | 'text'

/**
 * 运行中动效 kind（RunningBlockIcon 消费；与静态档一一对应 + thinking 轨道点）。
 * 独立类型 = 消费方映射表（Block.vue TOOL_RUNNING_KIND / RUN_GROUP_RUNNING_ICON）的键域约束。
 */
export type RunningIconKind =
  | 'thinking' | 'tool-read' | 'tool-bash' | 'tool-edit' | 'tool-grep'
  | 'subagent' | 'workflow' | 'tool-other'

/** toolName → tool 细分类映射（未命中的 toolName 走 'tool-other'）。grep/find 探索类
 *  单列 tool-grep（Search 字形 + 透镜扫掠动效），不再落 SquareFunction 兜底。
 *  bash 静态字形 = tool-cmd（裸 › 提示符，2026-10-15 裁决 ③B：成员/单行 bash 抽象化，
 *  波及组内外所有 bash 行——本映射是全局 SSOT）；running 动效不经此表（走 Block.vue
 *  TOOL_RUNNING_KIND，bash 仍 'tool-bash' 方框终端 + 光标闪烁）；exec 组头静态仍
 *  tool-bash（RUN_GROUP_ICON 独立映射，不动）。 */
const TOOL_ICON_MAP: Record<string, BlockIconKind> = {
  read: 'tool-read',
  bash: 'tool-cmd',
  edit: 'tool-edit',
  write: 'tool-edit',
  grep: 'tool-grep',
  find: 'tool-grep',
}

/**
 * 决策块图标种类。优先级（覆盖关系）：
 *   status==='running' → running（运行中态覆盖一切，用 loader 动画）
 *   isSubagent         → subagent
 *   isWorkflow         → workflow
 *   否则               → TOOL_ICON_MAP[toolName] ?? 'tool-other'
 * status==='error' 不入决策（MF-1-29 demo 权威：failed 行保持原工具图标，失败信号由
 * 消费方 headerIconClass 染 danger 承担，图标名不变——见 BLOCK_ICON_LUCIDE 上方说明）。
 */
export function getBlockIcon(
  toolName: string,
  status: ToolCallStatus,
  isSubagent: boolean,
  isWorkflow: boolean,
): BlockIconKind {
  if (status === 'running') return 'running'
  if (isSubagent) return 'subagent'
  if (isWorkflow) return 'workflow'
  return TOOL_ICON_MAP[toolName] ?? 'tool-other'
}

/**
 * BlockIconKind → lucide 组件映射（不含 running——running 用 RunningBlockIcon 动效组件）。
 * tool-read=book-open / tool-cmd=chevron-right（bash 静态字形，2026-10-15 裁决 ③B）/
 * tool-bash=square-terminal（exec 组头保留方框终端）/ tool-edit=pencil / tool-grep=search /
 * tool-other=square-function / subagent=users / text=arrow-right。
 * workflow=workflow（lucide Workflow 双节点连线，与 composer slash 菜单 slash-icons.ts 同款——
 * 原独立档 list-checks 与菜单图标不一致，统一到同源字形）。
 * run 组块（run 类型分组）不占独立档：组头图标 = 组类型的语义图标（探索→tool-read /
 * 改动→tool-edit / 执行命令→tool-bash，映射在 Block.vue 的 RUN_GROUP_ICON），组身份由
 * 「类型名 + N 步」文案承载，行内有 running 成员时图标位让给 RunningBlockIcon 动效款
 * （组头动效 = 组类别同款，见 RunningBlockIcon）。
 */
export const BLOCK_ICON_LUCIDE: Record<Exclude<BlockIconKind, 'running'>, Component> = {
  thinking: Lightbulb,
  'tool-read': BookOpen,
  'tool-bash': SquareTerminal,
  'tool-cmd': ChevronRight,
  'tool-edit': Pencil,
  'tool-grep': Search,
  'tool-other': SquareFunction,
  subagent: Users,
  workflow: Workflow,
  text: ArrowRight,
}

/**
 * running 态呼吸弧 loader SVG（ui-optimize-unified 决策 11 / N14）。
 * [2026-10 trace 块动效退役] trace 块行头的 running 态已改用 RunningBlockIcon 动效组件
 * （每类活动专属动效，字形保留 + accent 动效元素）；本常量仅存 TurnRail / BashOutputBlock
 * 两个非块头消费点（rail 位置/通知位不与块动效同屏争抢），不再新增消费点。
 * 淡轨整圈 circle r=10 opacity 0.16 + accent 弧段 circle r=10 pathLength=100，
 * viewBox 0 0 24 24，stroke currentColor stroke-width 1.7 / linecap round / linejoin round。
 * 颜色唯一 accent（消费方 text-accent 继承 currentColor），不加发光与缩放脉冲。
 *
 * 三重动画的驱动位置：
 * - 整体旋转 = 消费方容器 class animate-loader-spin（1.15s/圈 cubic-bezier(.6,.1,.35,.9)，
 *   简写注册在 renderer tailwind.config.ts animation 段）；
 * - 弧段呼吸/摆动 = 全局 .ld-arc 类（style.css 动画 SSOT 区：dasharray 16%↔54% 呼吸
 *   2.3s ease-in-out + 150° 摆动同周期同相）——v-html 注入的 SVG 内部元素不带 scoped
 *   data-v 属性，Tailwind 类也无法静态命中，只能全局类声明（keyframes 同理必须全局）。
 *
 * prefers-reduced-motion 由 style.css 全局 @media reduce 兜底（animation-duration 0.01ms
 * + iteration 1）：三重动画全部瞬切终态后回 .ld-arc 基态——静态呈现「淡轨整圈 + 固定
 * 相位弧段」，无运动感但保留形态识别。
 *
 * 淡轨 .ld-track / 弧段 .ld-arc class 仅作形态标记与动画挂点，样式一律由 CSS 侧持有，
 * inline 只保留无动画的静态属性（opacity/pathLength），保证 v-html 可用。
 */
export const RUNNING_LOADER_SVG: string =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle class="ld-track" cx="12" cy="12" r="10" opacity="0.16"/>' +
  '<circle class="ld-arc" cx="12" cy="12" r="10" pathLength="100"/>' +
  '</svg>'

/**
 * trace 块 header 的 ICON + 前缀文案统一规格（thinking / tool / subagent / workflow 四块共用）。
 *
 * 图标静态档 = --neutral-dim（demo `.tool .sicon { color: var(--dim) }`，workbench.css:378，
 * --dim 即「工具行/元信息」档）；demo 图标无 hover 变色，故不带 hover 类——failed/thinking/
 * running 三状态分支的显式换色不受影响（消费方 headerIconClass / 行内显式类各自覆盖）。
 *
 * 前缀单语言化后必须非 mono、非 uppercase、非 letter-spacing：中文 label 走 mono 会掉回 CJK
 * 字体（英文 mono 的等宽观感消失），tracking 撑开汉字间距正是 DESIGN.md:124/:862 禁的
 * 「uppercase + tracking-wider 装饰文字」。字号走 --text-base（14px，demo 过程行 fs-lg 档，
 * 见 BLOCK_LABEL_CLASS 注释），层级由色彩承担而非缩到 11px。
 */
export const BLOCK_ICON_CLASS =
  'size-[15px] shrink-0 text-neutral-dim [stroke-width:1.6]'
/** 动作词 label（思考 / 执行工具 / WORKFLOW. / SUBAGENT. 前缀）：字重走 --fw-mid；
 *  颜色落行层级灰 --neutral-mid。M3b demo 复刻对齐（demo .blk 过程行 14px + label
 *  fw-mid），随 BLOCK_ICON_CLASS 同批从 13px/bold 迁移。 */
export const BLOCK_LABEL_CLASS =
  'mr-0.5 inline-block shrink-0 whitespace-nowrap text-[length:var(--text-base)] [font-weight:var(--fw-mid)] text-neutral-mid'
