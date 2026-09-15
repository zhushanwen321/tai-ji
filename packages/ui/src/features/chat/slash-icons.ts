/**
 * slash 命令 icon 组件映射 SSOT（多前端壳共享）。
 *
 * 设计分层（audit §15.6 新发现-1 归位）：
 * - core `command-store.ts` 产出 icon key 字符串（builtin 命令名 或 source 泛化 key），
 *   BUILTIN_COMMAND_ICON_KEYS 是命令名 SSOT
 * - 本文件（ui）把 key 绑定到 lucide 组件，key 集合 = 泛化 key ∪ BUILTIN_COMMAND_ICON_KEYS
 * - renderer 消费方（CommandPopover / Composer / CommandDocPanel）经 @taiji/ui 取
 *
 * markRaw：组件对象无需响应式代理，跳过 reactivity 避免无谓开销（reka-ui / lucide 惯例）。
 */
import { markRaw, type Component } from 'vue'
import {
  Braces,
  FileText,
  Folder,
  Star,
  Terminal,
  Wrench,
  // builtin 命令专属图标（对齐 demo v6 CommandPopover：每条命令独立 icon）
  Layers,
  Target,
  ListChecks,
  ShieldCheck,
  CalendarClock,
  Tag,
  Bot,
  Workflow,
  NotebookPen,
  SlidersHorizontal,
  Gauge,
  PanelTop,
  Wand2,
} from '@lucide/vue'

/** 泛化 icon key → lucide 组件（fallback，与 source 映射对应） */
const GENERIC_ICON_COMPONENTS: Record<string, Component> = {
  file: markRaw(FileText),
  symbol: markRaw(Braces),
  skill: markRaw(Star),
  folder: markRaw(Folder),
  terminal: markRaw(Terminal),
  wrench: markRaw(Wrench),
  star: markRaw(Star),
}

/**
 * builtin 命令名 → 专属 lucide 组件（对齐 demo v6 CommandPopover）。
 * key 必须与 core `BUILTIN_COMMAND_ICON_KEYS` 一一对应——新增 builtin 命令时两边同步。
 * icon 选型依据 demo `.tmp/v6/src/mock/sessions.ts` 的 inline SVG path（lucide v1 等价组件）。
 */
const BUILTIN_COMMAND_ICONS: Record<string, Component> = {
  compact: markRaw(Layers),
  goal: markRaw(Target),
  todos: markRaw(ListChecks),
  permission: markRaw(ShieldCheck),
  schedule: markRaw(CalendarClock),
  'auto-rename': markRaw(Tag),
  subagents: markRaw(Bot),
  workflows: markRaw(Workflow),
  plan: markRaw(NotebookPen),
  'context-engineering': markRaw(SlidersHorizontal),
  'context-stats': markRaw(Gauge),
  'setup-statusline': markRaw(PanelTop),
  commit: markRaw(Wand2), // skill 命令但 demo 赋予专属 Wand，覆盖默认 Star
}

/** 统一映射：泛化 key + builtin 命令名 都能查到组件 */
export const SLASH_ICON_COMPONENTS: Record<string, Component> = {
  ...GENERIC_ICON_COMPONENTS,
  ...BUILTIN_COMMAND_ICONS,
}
