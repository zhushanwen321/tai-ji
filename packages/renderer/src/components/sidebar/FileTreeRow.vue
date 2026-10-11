<template>
  <!--
    [W28/D-7.2] 纯行组件（收 VisibleRow，替代旧递归行）：
    - 递归 v-for（旧 :65-71）移出——展开子行由 FileView 的扁平行投影（projectVisibleRows）产出，
      本组件只渲染单行（dir/file/loading/error/empty 五态）
    - 零 store 依赖：depth/expanded/childCount/gitStatus/lineStats 全部来自 row（投影预计算），
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
      class="flex select-none items-center gap-1.5 py-1 pr-2 font-mono text-[length:var(--text-3xs)] text-danger"
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

    <!-- 目录行（demo .frow 语言：height 24px / gap 5px / radius-sm / mono 12px mid 字、hover 提 fg）。
         行高必须 px 定高 h-[24px]：h-6=1.5rem 在 html 14px 基准（style.css --text-base）下=21px，缺 3px。
         树语义（files spec（demo）§2/§3.1）：role=treeitem + tabindex=0 + aria-expanded 同步 +
         Enter/Space 开合（键盘与点击同通道）。 -->
    <div
      v-else-if="row.type === 'dir'"
      class="flex h-[24px] w-full cursor-default select-none items-center gap-[5px] rounded-sm py-0.5 pr-2 font-mono text-[length:var(--text-xs)] text-neutral-mid transition-colors hover:bg-surface-hover hover:text-neutral-fg"
      :style="rowPaddingStyle"
      role="treeitem"
      tabindex="0"
      :aria-expanded="row.expanded"
      :data-testid="`file-tree-dir-${row.path}`"
      @click="emit('toggle', row)"
      @keydown.enter.prevent="emit('toggle', row)"
      @keydown.space.prevent="emit('toggle', row)"
    >
      <span :class="chevronSlotClass" data-testid="chevron-slot">
        <ChevronRight
          class="size-[10px] text-neutral-dim transition-transform duration-[var(--duration-fast)] ease-[var(--ease-out)]"
          :class="{ 'rotate-90': row.expanded }"
        />
      </span>
      <Folder class="size-[13px] shrink-0 text-neutral-dim" />
      <!-- 长文件名 = demo .fname 契约（2026-10-10 裁决改向：省略号截断 + title 悬停展示全名，
           不做 hover 横向滚动——原 marquee 双层结构/keyframes 已随改向卸载）。
           无 flex-1：demo .fname 无 flex 声明（min-width:0 + ellipsis 收缩截断），
           徽标 .fbadge flex:none 紧跟文件名，不贴行尾 -->
      <span
        class="fname block min-w-0 overflow-hidden whitespace-nowrap text-ellipsis"
        :class="row.ignored ? 'text-neutral-dim italic' : ''"
        :title="row.name"
      >{{ row.name }}</span>
      <!-- 目录徽标（demo .fbadge 权威：是目录即恒渲染，内容 = 可见直接子项数，0 也显；
           形态 = 10px / card-inset 凹陷底 / radius-xs / 1×5 padding）。
           [2026-10-10 改向] 原「子树改动数 >0 才显」语义退役（改动数承载去向见 ledger 登记） -->
      <span
        class="shrink-0 rounded-[var(--radius-xs)] bg-bg-input px-[5px] py-px font-mono text-[length:var(--text-3xs)] text-neutral-dim"
        :data-testid="`file-tree-dir-badge-${row.path}`"
      >{{ row.childCount > 999 ? '999+' : row.childCount }}</span>
    </div>

    <!-- 文件行（v-else 紧邻上方目录 v-else-if，链绑定到 row.type 判断）。
         选中态 = demo Tier B 行类范式（.frow.sel 无底无框，仅文字提亮 fg + fw-mid）。
         树语义（files spec（demo）§3.1）：role=treeitem + tabindex=0 + Enter 打开。 -->
    <div
      v-else
      class="flex h-[24px] w-full cursor-default select-none items-center gap-[5px] rounded-sm py-0.5 pr-2 font-mono text-[length:var(--text-xs)] text-neutral-mid transition-colors hover:bg-surface-hover hover:text-neutral-fg"
      :class="{ 'text-neutral-fg': selected }"
      :style="rowPaddingStyle"
      role="treeitem"
      tabindex="0"
      :data-testid="`file-tree-file-${row.path}`"
      @click="emit('select', row)"
      @keydown.enter.prevent="emit('select', row)"
    >
      <!-- D-022：chevron 槽固定宽度占位，使文件 icon 与目录 folder icon 垂直对齐 -->
      <span :class="chevronSlotClass" data-testid="chevron-slot" />
      <component :is="fileIcon" class="size-[13px] shrink-0" :class="fileIconColor" />
      <!-- 长文件名 = demo .fname 契约（同目录行：ellipsis 截断 + title 悬停展示全名；
           无 flex-1，lineStats 的 ml-auto 承接右贴） -->
      <span
        class="fname block min-w-0 overflow-hidden whitespace-nowrap text-ellipsis"
        :class="[
          row.ignored ? 'text-neutral-dim italic' : '',
          selected ? 'text-neutral-fg [font-weight:var(--fw-mid)]' : '',
        ]"
        :title="row.name"
      >{{ row.name }}</span>
      <!-- git overlay 角标（D-012 树/标注分离：从投影的 row.gitStatus 取 status）。
           形态 = demo .gmark（10px fw-mid / radius-xs / 1×5 padding / 语义软底） -->
      <span
        v-if="gitBadge"
        class="rounded-[var(--radius-xs)] px-[5px] py-px font-mono text-[length:var(--text-3xs)] [font-weight:var(--fw-mid)]"
        :class="gitBadgeClass"
      >{{ gitBadge }}</span>
      <!-- W2 文件行数 +N −M（tracked 改动有 numstat；untracked 降级显 ~size）。
           形态 = demo .fdiff（ml-auto 右贴 + gap 5px + flex:none），三档 span 不再粘连 -->
      <span
        v-if="row.lineStats"
        class="ml-auto inline-flex shrink-0 gap-[5px] font-mono text-[length:var(--text-3xs)]"
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
  /** 选中态（store.getSelectedPath(sessionId) === row.path，由 FileView 传入——本组件零 store 依赖） */
  selected?: boolean
}>()

const emit = defineEmits<{
  toggle: [row: VisibleRow]
  select: [row: VisibleRow]
}>()

/** 缩进步进（px）：层级缩进档（files spec（demo）§4，demo .frow.ind0-3 权威：18px 步进，
 *  depth 0/1/2/3 = padding-left 8/26/44/62px）。原 v6 §6.2 的 10px 步进已随新 spec 树退役。 */
const INDENT_STEP = 18
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
    case 'unmerged': return 'bg-danger-soft text-danger'
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
