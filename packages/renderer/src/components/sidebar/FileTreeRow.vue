<template>
  <!--
    [W28/D-7.2] 纯行组件（收 VisibleRow，替代旧递归行）：
    - 递归 v-for（旧 :65-71）移出——展开子行由 FileView 的扁平行投影（projectVisibleRows）产出，
      本组件只渲染单行（dir/file/loading/error/empty 五态）
    - 零 store 依赖：depth/expanded/changeCount/gitStatus/lineStats 全部来自 row（投影预计算），
      交互（toggle/select）经 emit 交给 FileView（持有 useFileTree + useSideDrawer）
    - data-testid 用 path（E2E 选择器，与旧递归版一致），dir/file 区分前缀
    - [HISTORICAL v-if/v-else 链断裂事故] 五态链保持单根：loading v-if → error v-else-if →
      empty v-else-if → dir v-else-if → file v-else，条件块之间不插任何其它节点
  -->
  <div>
    <!-- 展开在途占位（hint 行，depth 已含 +1 缩进） -->
    <div
      v-if="row.hint === 'loading'"
      class="flex items-center gap-1.5 py-1 pr-2 font-mono text-[length:var(--text-3xs)] text-neutral-dim"
      :style="rowPaddingStyle"
      :data-testid="`file-tree-loading-${row.path}`"
    >
      <span :class="chevronSlotClass" data-testid="chevron-slot" />
      <Loader2 class="size-3 animate-spin opacity-60" />
      <span>{{ t('sidebar.fileTree.loading') }}</span>
    </div>

    <!-- 展开失败占位（点击沿用旧语义：已展开目录 → 折叠） -->
    <div
      v-else-if="row.hint === 'error'"
      class="flex items-center gap-1.5 py-1 pr-2 font-mono text-[length:var(--text-3xs)] text-danger"
      :style="rowPaddingStyle"
      :data-testid="`file-tree-error-${row.path}`"
      @click="emit('toggle', row)"
    >
      <span :class="chevronSlotClass" data-testid="chevron-slot" />
      <AlertCircle class="size-3" />
      <span>{{ t('sidebar.fileTree.loadFailed') }}</span>
    </div>

    <!-- 已加载空目录（全部子项被 showIgnored 过滤后也视为空） -->
    <div
      v-else-if="row.hint === 'empty'"
      class="py-1 pr-2 font-mono text-[length:var(--text-3xs)] text-neutral-dim italic"
      :style="rowPaddingStyle"
      :data-testid="`file-tree-empty-${row.path}`"
    >
      {{ t('sidebar.fileTree.emptyDir') }}
    </div>

    <!-- 目录行 -->
    <div
      v-else-if="row.type === 'dir'"
      class="flex w-max min-w-full cursor-pointer items-center gap-1 rounded-md py-0.5 pr-2 font-mono text-[length:var(--text-xs)] transition-colors hover:bg-surface-hover"
      :style="rowPaddingStyle"
      :data-testid="`file-tree-dir-${row.path}`"
      @click="emit('toggle', row)"
    >
      <span :class="chevronSlotClass" data-testid="chevron-slot">
        <ChevronRight
          class="size-3 text-neutral-dim transition-transform duration-[var(--duration)] ease-[var(--ease)]"
          :class="{ 'rotate-90': row.expanded }"
        />
      </span>
      <Folder class="size-3.5 shrink-0 text-neutral-mid" />
      <span class="shrink whitespace-nowrap" :class="row.ignored ? 'text-neutral-dim italic' : 'text-neutral-fg'">{{ row.name }}</span>
      <!-- W2 目录改动数徽章（子树改动文件数，>0 才显；预聚合 count 由投影预计算） -->
      <span
        v-if="row.changeCount > 0"
        class="shrink-0 rounded-sm bg-surface-2 px-1 py-0.5 font-mono text-[length:var(--text-3xs)] text-neutral-dim"
        :data-testid="`file-tree-dir-badge-${row.path}`"
      >{{ row.changeCount > 999 ? '999+' : row.changeCount }}</span>
    </div>

    <!-- 文件行（v-else 紧邻上方目录 v-else-if，链绑定到 row.type 判断） -->
    <div
      v-else
      class="flex w-max min-w-full cursor-pointer items-center gap-1 rounded-md py-0.5 pr-2 transition-colors hover:bg-surface-hover"
      :class="{ 'bg-surface': selected }"
      :style="rowPaddingStyle"
      :data-testid="`file-tree-file-${row.path}`"
      @click="emit('select', row)"
    >
      <!-- D-022：chevron 槽固定宽度占位，使文件 icon 与目录 folder icon 垂直对齐 -->
      <span :class="chevronSlotClass" data-testid="chevron-slot" />
      <component :is="fileIcon" class="size-3.5 shrink-0" :class="fileIconColor" />
      <span
        class="shrink whitespace-nowrap font-mono text-[length:var(--text-xs)]"
        :class="[
          row.ignored ? 'text-neutral-dim italic' : 'text-neutral-fg',
          selected ? 'font-semibold text-accent' : '',
        ]"
      >{{ row.name }}</span>
      <!-- git overlay 角标（D-012 树/标注分离：从投影的 row.gitStatus 取 status） -->
      <span
        v-if="gitBadge"
        class="rounded-sm px-1 py-0.5 font-mono text-[length:var(--text-3xs)]"
        :class="gitBadgeClass"
      >{{ gitBadge }}</span>
      <!-- W2 文件行数 +N −M（tracked 改动有 numstat；untracked 降级显 ~size） -->
      <span
        v-if="row.lineStats"
        class="shrink-0 font-mono text-[length:var(--text-3xs)]"
        :data-testid="`file-tree-linestats-${row.path}`"
      >
        <span v-if="row.lineStats.add !== undefined" class="text-success">+{{ formatCount(row.lineStats.add) }}</span>
        <span v-if="row.lineStats.del !== undefined" class="text-danger">−{{ formatCount(row.lineStats.del) }}</span>
        <span v-if="row.lineStats.size !== undefined" class="text-neutral-dim">~{{ formatCount(row.lineStats.size) }}</span>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight, Folder, FileText, FileCode, FileJson, Loader2, AlertCircle } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { VisibleRow } from '@/stores/fileTree'

const { t } = useI18n()

const props = defineProps<{
  /** 可见行（投影产物，depth/expanded/徽章/角标已预计算） */
  row: VisibleRow
  /** 选中态（store.selectedPath === row.path，由 FileView 传入——本组件零 store 依赖） */
  selected?: boolean
}>()

const emit = defineEmits<{
  toggle: [row: VisibleRow]
  select: [row: VisibleRow]
}>()

/** 缩进步进（px）：每层级增加的 padding-left（v6 spec §6.2：14→10）*/
const INDENT_STEP = 10
/** 行 padding 基线（px）：depth=0 时的起始 padding-left（D-022） */
const BASE_PADDING = 8
/**
 * chevron 槽 Tailwind 类（D-022）：固定宽度 inline-flex 占位，目录放 ChevronRight、
 * 文件空占位，使目录 folder icon 与文件 file icon 垂直对齐。
 * 注意：宽度固定 14px（图标 12px + 留白），与 INDENT_STEP **独立**——缩进步进仅控制
 * 每层左侧 padding 增量，chevron 槽宽度保证目录/文件图标列对齐，二者无联动关系。
 * 宽度必须写死静态字符串，Tailwind JIT 不识别运行时拼接的任意值类。
 */
const chevronSlotClass = 'w-[14px] shrink-0 inline-flex items-center justify-center'

/**
 * 行 padding-left（D-022 单一公式）：dir/file/hint 行共用。
 * hint 行的 depth 在投影时已 +1（子区占位缩进），无需旧 childHintPaddingStyle 双公式。
 */
const rowPaddingStyle = computed(() => ({
  paddingLeft: `${props.row.depth * INDENT_STEP + BASE_PADDING}px`,
}))

/** git overlay 角标（从投影 row.gitStatus 取，非 node 字段） */
const gitStatus = computed(() => props.row.gitStatus?.status)

const gitBadge = computed(() => {
  switch (gitStatus.value) {
    case 'modified': return 'M'
    case 'added': return 'A'
    case 'deleted': return 'D'
    case 'unmerged': return 'U'
    case 'renamed': return 'R'
    case 'untracked': return 'A' // T2.8b: untracked ?? → 绿 A
    default: return ''
  }
})

/** M/A/D/U/R 角标配色（design-tokens 语义色） */
const gitBadgeClass = computed(() => {
  switch (gitStatus.value) {
    case 'modified': return 'bg-warn-soft text-warn'
    case 'added': return 'bg-success-soft text-success'
    case 'deleted': return 'bg-danger-soft text-danger'
    case 'unmerged': return 'bg-danger-soft text-danger font-semibold'
    case 'renamed': return 'bg-info-soft text-info'
    case 'untracked': return 'bg-success-soft text-success'
    default: return ''
  }
})

/** [W2] 行数压缩阈值：≥此值显 9.9k（对齐 ProviderPage 上下文数压缩策略） */
const LINE_COUNT_COMPACT_THRESHOLD = 10000
/** [W2] 行数压缩除数（1000 → 显 k 后缀） */
const LINE_COUNT_COMPACT_DIVISOR = 1000

/** [W2] 格式化行数/大小（≥阈值显 9.9k，否则原值） */
function formatCount(n: number): string {
  return n >= LINE_COUNT_COMPACT_THRESHOLD
    ? `${(n / LINE_COUNT_COMPACT_DIVISOR).toFixed(1)}k`
    : String(n)
}

const ext = computed(() => {
  const parts = props.row.name.split('.')
  return parts.length > 1 ? (parts.pop() ?? '') : ''
})

/** 文件图标按扩展名 */
const fileIcon = computed(() => {
  switch (ext.value) {
    case 'ts': case 'tsx': case 'js': case 'cjs': case 'mjs': return FileCode
    case 'json': return FileJson
    default: return FileText
  }
})

/** 图标色按扩展名（避开 M/A/D 的橙绿红） */
const fileIconColor = computed(() => {
  switch (ext.value) {
    case 'ts': case 'tsx': return 'text-info'
    case 'vue': return 'text-success'
    case 'json': return 'text-warn'
    case 'md': return 'text-neutral-mid'
    default: return 'text-neutral-dim'
  }
})
</script>
