<script setup lang="ts">
/**
 * 列表树组件（v6）——替代 TUI 的 ⎿ ├─ └─ 缩进。
 * 递归渲染 TreeItem：每项含可选行号 + icon + label + 可选 status 圆点 + 可选 children。
 *
 * v6 改造（§3.4）：
 * - 缩进 depth × 16px padding-left（从 20px 收，留白档优于 border-l 引导线）。
 * - icon size-3(12px) 对齐 trace 档，去 statusClass 着色改中性（继承 label neutral-mid），
 *   状态信息全部由圆点承担（单一信息源，避免 icon 与 status 双重表达）。
 * - status 从文字标签改为 7px 圆点（done→bg-success / running→bg-accent / failed→bg-danger），
 *   margin-left:auto 右对齐（对齐 §3.3 状态指示范式）。
 * - done 项 label 降为 neutral-dim（终态弱化，与 ProgressBar「done 中性化」同哲学：
 *   圆点承载状态色，亮度承载强调层级——非第二状态指示）。
 * - numbered（v1.1）：行首弱化 mono 序号（1/2/3…，编辑器行号范式）。扁平有序清单用；
 *   icon 与序号互斥（序号占据 icon 槽位，避免行首双元素）。
 * - 递归 depth 逻辑不变。
 */
import type { TreeItem, TreeItemIcon } from '@taiji/extension-protocol'
import {
  ChevronRight, Check, X, Circle, Dot, Pause, GitBranch,
} from '@lucide/vue'
import type { Component } from 'vue'

const props = defineProps<{
  items: TreeItem[]
  /** 行首显示弱化序号（index+1）。扁平有序清单（todo）用；自带编号文本勿开（双重编号） */
  numbered?: boolean
  /** 当前层深度（根层=0，递归 children 时 +1）。外部不需传，内部递归自动管理。 */
  depth?: number
}>()

const ICON_MAP: Record<TreeItemIcon, Component> = {
  arrow: ChevronRight,
  check: Check,
  cross: X,
  circle: Circle,
  dot: Dot,
  pause: Pause,
  branch: GitBranch,
}

/** v6：status → 圆点 bg 色（done=success / running=accent / failed=danger）。 */
const statusDotClass = (status?: TreeItem['status']) => {
  if (!status) return ''
  const map = { running: 'bg-accent', done: 'bg-success', failed: 'bg-danger' } as const
  return map[status]
}

/** v6：done 项 label 终态弱化（同光标行高亮哲学——完成的项让位给进行中的项）。 */
const labelClass = (status?: TreeItem['status']) =>
  status === 'done' ? 'text-neutral-dim' : 'text-neutral-mid'

const INDENT_PX = 16
const currentDepth = () => props.depth ?? 0
const depthPadding = () => ({ paddingLeft: `${currentDepth() * INDENT_PX}px` })
</script>

<template>
  <div class="list-tree font-mono text-[length:var(--text-sm)] leading-relaxed" data-testid="gui-list-tree">
    <template v-for="(item, i) in items" :key="i">
      <div class="list-tree__item flex items-center gap-1.5" :style="depthPadding()">
        <!-- numbered：行首弱化序号（编辑器行号范式，占据 icon 槽位） -->
        <span v-if="numbered" class="w-4 shrink-0 text-right font-mono text-[10px] tabular-nums text-neutral-dim">
          {{ i + 1 }}
        </span>
        <span v-else class="list-tree__icon flex w-3.5 shrink-0 justify-center">
          <component
            v-if="item.icon"
            :is="ICON_MAP[item.icon]"
            class="size-3"
          />
        </span>
        <span :class="labelClass(item.status)">{{ item.label }}</span>
        <span
          v-if="item.status"
          data-testid="list-tree-status"
          class="list-tree__status ml-auto size-[7px] shrink-0 rounded-full"
          :class="statusDotClass(item.status)"
        />
      </div>
      <!-- 递归渲染 children：depth + 1 自动缩进（children 层不开序号） -->
      <template v-if="item.children && item.children.length > 0">
        <ListTree :items="item.children" :depth="currentDepth() + 1" />
      </template>
    </template>
  </div>
</template>
