<template>
  <!--
    展示组件 · 归档列表视图（session-archive 设计 D10，u-renderer-entry）。

    侧栏 sessions tab 内容区的第二视图（SessionList ↔ 本组件互斥渲染，视图开关 =
    archive store.viewOpen，切换编排在 useArchiveView）：头 = 返回钮 +「已归档 (N)」+
    筛选后总体积（磁盘占用口径：压缩后体积，压缩中条目按原文件计）；头下时间筛选行
    （mono 短码档位「全/1d/2-3d/4-7d/7d+」= 互斥时间段，四档计数相加 = 全部；筛选生效
    时行内联批量清理钮「N 项」，两段确认）；行结构（D10）= 名称（staging 态带「压缩中」
    标注）/ 原项目标签 + 压缩信息 sub 行 / 归档时间右列；悬停时时间列让位 [恢复]
    （accent）/ [彻底删除]（danger 两段）双钮（对齐 SessionItem 悬停钮替换时间列的
    范式——右槽 opacity 互斥，占位不变零跳动）。点击行 = 主区呈现摘要视图（emit
    select，Sidebar 接 useArchiveView.openSummary）。空态：全量「暂无归档会话」/
    筛选档「该时间范围内暂无归档」；拉取失败显示重试。

    纯展示（零 RPC）：数据 props 注入（store.archives / loading / listError /
    batchPurging 经 Sidebar 转发），筛选为组件内 UI 态（关视图重挂载即回「全」档），
    projectName 按 archive.projectId 经 projectStore 解析（同 SessionList 消费
    projectStore 先例）。
  -->
  <div class="flex h-full min-h-0 flex-col" data-testid="archive-list-view">
    <!-- 头（对齐 SessionList 区头节奏）：返回钮 + 标题 + mono 计数 -->
    <div class="flex shrink-0 items-center gap-[6px] px-[10px] pt-[8px] pb-[5px]" data-testid="archive-list-header">
      <Button
        variant="ghost"
        size="icon"
        data-testid="archive-back-btn"
        class="grid size-[24px] place-items-center rounded-[var(--radius-xs)] p-0 text-neutral-dim transition-colors hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-[13px]"
        :title="t('archive.entry.back')"
        :aria-label="t('archive.entry.back')"
        @click="emit('back')"
      >
        <ArrowLeft :stroke-width="1.8" />
      </Button>
      <span class="truncate text-[length:var(--text-xs)] text-neutral-mid">{{ t('archive.entry.header') }}</span>
      <span class="font-mono text-[length:var(--text-2xs)] text-neutral-fg-2" data-testid="archive-list-count">{{ visibleArchives.length }}</span>
      <!-- 筛选后总体积（磁盘占用口径：压缩后体积，staging 按原文件计；随筛选联动） -->
      <span
        class="ml-auto shrink-0 font-mono text-[length:var(--text-2xs)] text-neutral-dim"
        :title="t('archive.entry.totalSizeTitle')"
        data-testid="archive-total-size"
      >{{ totalDiskSizeLabel }}</span>
    </div>

    <!-- 时间筛选行（一行 = mono 短码档位槽 + 内联批量清理钮；档位 = 互斥时间段，四档计数相加 = 全部） -->
    <div class="flex shrink-0 items-center gap-[6px] px-[10px] pt-[3px] pb-[7px]">
      <div
        class="flex gap-[1px] rounded-sm border border-hairline bg-surface p-[2px]"
        role="tablist"
        :aria-label="t('archive.entry.filterTablistLabel')"
        data-testid="archive-filter-bar"
        @keydown="onFilterKeydown"
      >
        <Button
          v-for="f in FILTER_DEFS"
          :key="f.key"
          variant="ghost"
          role="tab"
          :aria-selected="filterKey === f.key"
          :title="t(f.titleKey)"
          :data-testid="`archive-filter-${f.key}`"
          class="h-[21px] shrink-0 rounded-[var(--radius-xs)] px-[5px] font-mono text-[length:var(--text-2xs)]"
          :class="filterKey === f.key
            ? 'bg-[var(--sel-bg)] text-neutral-fg [font-weight:var(--fw-mid)] shadow-[inset_0_0_0_1px_var(--sel-edge)] hover:bg-[var(--sel-bg)] hover:text-neutral-fg'
            : 'bg-transparent text-neutral-dim hover:bg-transparent hover:text-neutral-fg'"
          @click="selectFilter(f.key)"
        >{{ t(f.labelKey) }}</Button>
      </div>
      <!-- 批量清理（仅筛选生效且有可见条目；待发态「N 项」——垃圾桶图标承载删除语义；两段确认第二击执行） -->
      <Button
        v-if="batchPurgeVisible"
        variant="ghost"
        :disabled="batchPurging"
        :aria-label="t('archive.entry.batchPurgeAria', { count: visibleArchives.length })"
        :title="batchConfirming
          ? t('archive.entry.batchPurgeConfirm', { count: visibleArchives.length })
          : t('archive.entry.batchPurgeAria', { count: visibleArchives.length })"
        data-testid="archive-batch-purge-btn"
        class="ml-auto inline-flex h-[22px] shrink-0 items-center gap-[5px] rounded-[var(--radius-xs)] px-[7px] font-mono text-[length:var(--text-2xs)] transition-colors disabled:cursor-default disabled:opacity-40"
        :class="batchConfirming
          ? 'bg-danger [font-weight:var(--fw-mid)] text-danger-fg hover:bg-danger'
          : 'text-danger hover:bg-danger-soft'"
        @click="onBatchPurgeClick"
      >
        <Check v-if="batchConfirming" class="size-[12px]" />
        <Trash2 v-else class="size-[12px]" />
        <span>{{ batchPurging
          ? t('archive.entry.batchPurging')
          : batchConfirming
            ? t('archive.entry.batchPurgeConfirm', { count: visibleArchives.length })
            : t('archive.entry.batchPurgeLabel', { count: visibleArchives.length }) }}</span>
      </Button>
    </div>

    <ScrollArea class="min-h-0 flex-1">
      <div class="flex flex-col pb-2 pl-1.5">
        <!-- 拉取失败 + 重试（对齐 session-list-error 范式） -->
        <div
          v-if="listError"
          class="flex flex-col items-center justify-center gap-2 py-10 text-center"
          data-testid="archive-list-error"
        >
          <AlertCircle class="size-5 text-danger opacity-60" />
          <p class="text-[length:var(--text-2xs)] text-neutral-mid">{{ t('archive.entry.loadFailed', { error: listError }) }}</p>
          <Button variant="ghost" class="h-6 text-[length:var(--text-2xs)] text-accent" data-testid="archive-list-retry" @click="emit('retry')">{{ t('sidebar.retry') }}</Button>
        </div>

        <!-- 空态（D10：列表区居中「暂无归档会话」；非加载中才显——加载闪空态是误报；
             筛选档下的空结果给该档专属文案，与全量空态区分） -->
        <div
          v-else-if="!loading && visibleArchives.length === 0"
          class="flex flex-col items-center justify-center gap-2 py-10 text-center"
          :data-testid="filterKey === 'all' ? 'archive-list-empty' : 'archive-list-empty-filtered'"
        >
          <Archive class="size-5 text-neutral-dim opacity-40" />
          <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-55">{{ filterKey === 'all' ? t('archive.entry.empty') : t('archive.entry.filterEmpty') }}</p>
        </div>

        <!-- 行列表 -->
        <div
          v-for="entry in visibleArchives"
          :key="entry.sessionId"
          role="button"
          tabindex="0"
          class="group/row relative flex cursor-pointer select-none items-center gap-[8px] rounded-sm px-[8px] py-[7px] transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-surface-hover"
          :data-testid="`archive-row-${entry.sessionId}`"
          :aria-label="rowAriaLabel(entry)"
          @click="emit('select', entry)"
          @keydown.enter.prevent="emit('select', entry)"
          @keydown.space.prevent="emit('select', entry)"
        >
          <!-- 主体：名称行（staging 带「压缩中」标注）+ sub 行（原项目标签 · 压缩信息） -->
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-1 text-[length:var(--text-sm)] [font-weight:var(--fw-mid)] leading-[1.55] text-neutral-fg-2">
              <span class="min-w-0 flex-1 truncate">{{ displayName(entry) }}</span>
              <!-- staging 过渡态标注（D5/V10：后台压缩未完成，「压缩中」行标注，不做进度条） -->
              <span
                v-if="entry.status === 'staging'"
                data-testid="archive-row-compressing"
                class="shrink-0 rounded-sm bg-surface px-1 py-0.5 font-mono text-[length:var(--text-3xs)] leading-none text-neutral-dim"
              >{{ t('archive.summary.compressing') }}</span>
            </div>
            <div class="flex min-w-0 items-center gap-[4px] truncate font-mono text-[length:var(--text-2xs)] leading-[1.55] text-neutral-dim">
              <span
                v-if="projectNameOf(entry)"
                class="shrink-0 truncate"
                :data-testid="`archive-row-project-${entry.sessionId}`"
              >{{ projectNameOf(entry) }}</span>
              <span v-if="projectNameOf(entry)" class="shrink-0">·</span>
              <span class="min-w-0 truncate" :data-testid="`archive-row-compression-${entry.sessionId}`">{{ compressionLabel(entry) }}</span>
            </div>
          </div>

          <!-- 右槽：归档时间（悬停让位双钮——opacity 互斥对齐 SessionItemDisplay 范式） -->
          <div class="relative flex h-full w-[58px] shrink-0 items-center justify-end gap-[2px]">
            <span
              class="shrink-0 font-mono text-[length:var(--text-2xs)] leading-[1.55] text-neutral-dim"
              :class="purgeConfirmingId === entry.sessionId ? 'opacity-0' : 'group-hover/row:opacity-0 group-focus-within/row:opacity-0'"
              :data-testid="`archive-row-time-${entry.sessionId}`"
            >{{ formatRelativeTime(Date.parse(entry.archivedAt)) }}</span>
            <!-- 悬停双钮（D10：恢复 accent / 彻底删除 danger 两段；覆盖右槽，名称构造性不受遮） -->
            <div
              class="absolute inset-0 justify-end gap-[2px]"
              :class="purgeConfirmingId === entry.sessionId ? 'flex' : 'flex opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100'"
            >
              <Button
                variant="ghost"
                size="icon"
                tabindex="-1"
                data-testid="archive-row-restore-btn"
                class="relative size-[18px] rounded-sm text-accent after:absolute after:inset-[-3px] after:content-[''] hover:bg-surface-hover disabled:cursor-default disabled:opacity-40"
                :disabled="restoringSessionId === entry.sessionId"
                :title="t('archive.summary.restore')"
                @click.stop="emit('restore', entry)"
                @pointerdown.stop
              >
                <RotateCcw class="size-[12px]" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                tabindex="-1"
                data-testid="archive-row-purge-btn"
                class="relative size-[18px] rounded-sm after:absolute after:inset-[-3px] after:content-[''] disabled:cursor-default disabled:opacity-40"
                :disabled="purgingSessionId === entry.sessionId"
                :class="purgeConfirmingId === entry.sessionId
                  ? 'bg-danger text-danger-fg hover:bg-danger'
                  : 'text-neutral-dim hover:bg-surface-hover hover:text-danger'"
                :title="purgeConfirmingId === entry.sessionId ? t('archive.entry.purgeConfirm') : t('archive.entry.purge')"
                @click.stop="onPurgeClick(entry)"
                @pointerdown.stop
              >
                <Check v-if="purgeConfirmingId === entry.sessionId" class="size-[12px]" />
                <Trash2 v-else class="size-[12px]" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </ScrollArea>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, RotateCcw, Trash2, Check, Archive, AlertCircle } from '@lucide/vue'
import type { ArchiveSummary } from '@taiji/shared'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { formatRelativeTime } from '@/composables/logic/formatTime'
import { useProjectStore } from '@/stores/project'

const props = defineProps<{
  /** 归档列表（config.archives 拉取快照，store.archives 经 Sidebar 转发） */
  archives: ArchiveSummary[]
  /** 拉取进行中（空态判定的防闪条件） */
  loading: boolean
  /** 拉取失败原因（null = 无失败；显示重试入口） */
  listError: string | null
  /** 在途恢复的 sessionId（该行恢复钮禁用——§5.1 loading 语义的防双击落地） */
  restoringSessionId: string | null
  /** 在途彻底删除的 sessionId（该行删除钮禁用） */
  purgingSessionId: string | null
  /** 批量彻底删除进行中（筛选行批量钮禁用 + 「删除中…」） */
  batchPurging: boolean
}>()

const emit = defineEmits<{
  /** 返回会话列表（头返回钮；useArchiveView.closeArchiveView） */
  back: []
  /** 点击行 → 主区摘要视图（useArchiveView.openSummary） */
  select: [archive: ArchiveSummary]
  /** 恢复（悬停 accent 钮；useArchiveView.restoreArchive） */
  restore: [archive: ArchiveSummary]
  /** 彻底删除（悬停 danger 两段确认后；useArchiveView.purgeArchiveEntry） */
  purge: [archive: ArchiveSummary]
  /** 批量彻底删除（筛选行内联钮两段确认后；useArchiveView.purgeArchivesBatch） */
  purgeBatch: [archives: ArchiveSummary[]]
  /** 拉取失败重试（useArchiveView.refreshArchives） */
  retry: []
}>()

const { t } = useI18n()
const projectStore = useProjectStore()

// ── 时间筛选（互斥四档 + 全部；档位边界 = 距今小时数，四档计数相加 = 全部） ──────

/** 筛选档 key（i18n label/title 经 FILTER_DEFS 映射）。 */
type ArchiveFilterKey = 'all' | 'd1' | 'd23' | 'd47' | 'older'

interface ArchiveFilterDef {
  key: ArchiveFilterKey
  labelKey: string
  titleKey: string
  /** 命中判据：entry 距今小时数 */
  match: (ageHours: number) => boolean
}

const HOUR = 3_600_000

/** 档位时间边界（单位 = 距今小时数；72 = 3 天、168 = 7 天）。 */
const HOURS_PER_DAY = 24
const D3_BOUNDARY_H = 72
const D7_BOUNDARY_H = 168

/** 档位静态定义（互斥时间段；「全」为缺省档）。 */
const FILTER_DEFS: ArchiveFilterDef[] = [
  { key: 'all', labelKey: 'archive.entry.filterAll', titleKey: 'archive.entry.filterAllTitle', match: () => true },
  { key: 'd1', labelKey: 'archive.entry.filter1d', titleKey: 'archive.entry.filter1dTitle', match: (h) => h <= HOURS_PER_DAY },
  { key: 'd23', labelKey: 'archive.entry.filter23d', titleKey: 'archive.entry.filter23dTitle', match: (h) => h > HOURS_PER_DAY && h <= D3_BOUNDARY_H },
  { key: 'd47', labelKey: 'archive.entry.filter47d', titleKey: 'archive.entry.filter47dTitle', match: (h) => h > D3_BOUNDARY_H && h <= D7_BOUNDARY_H },
  { key: 'older', labelKey: 'archive.entry.filterOlder', titleKey: 'archive.entry.filterOlderTitle', match: (h) => h > D7_BOUNDARY_H },
]

/**
 * 当前筛选档（组件内 UI 态——关视图重挂载即回「全」；不进 store：跨视图保持无已发生
 * 需求，且列表快照本身每次打开都重拉）。
 */
const filterKey = ref<ArchiveFilterKey>('all')

/** 批量清理两段确认态（档位切换/在途开始即复位；语义对齐行级 purgeConfirmingId）。 */
const batchConfirming = ref(false)

/** 筛选产物：可见条目（archivedAt 距今小时数按档位判据过滤；快照刷新/档位切换自动重算）。 */
const visibleArchives = computed<ArchiveSummary[]>(() => {
  const def = FILTER_DEFS.find((f) => f.key === filterKey.value)!
  return props.archives.filter((a) => def.match((Date.now() - Date.parse(a.archivedAt)) / HOUR))
})

/** 条目磁盘占用（archived 按压缩体、staging 按原文件——staging 期磁盘上是明文）。 */
function diskBytesOf(a: ArchiveSummary): number {
  return a.status === 'archived' ? a.compressedBytes : a.rawBytes
}

/** 筛选后总体积标签（无可见条目显示「—」）。 */
const totalDiskSizeLabel = computed(() =>
  visibleArchives.value.length > 0
    ? formatSize(visibleArchives.value.reduce((sum, a) => sum + diskBytesOf(a), 0))
    : '—',
)

/** 批量清理钮可见性：筛选生效（非「全」）且有可见条目（空档无操作对象，不渲染）。 */
const batchPurgeVisible = computed(() => filterKey.value !== 'all' && visibleArchives.value.length > 0)

function selectFilter(key: ArchiveFilterKey): void {
  if (filterKey.value === key) return
  filterKey.value = key
  batchConfirming.value = false
}

/** tablist 方向键环形切换（对齐 SegmentedTab 先例：四键同义，移动即激活）。 */
function onFilterKeydown(e: KeyboardEvent): void {
  const order = FILTER_DEFS.map((f) => f.key)
  const i = order.indexOf(filterKey.value)
  if (i < 0) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
    e.preventDefault()
    selectFilter(order[(i + 1) % order.length])
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
    e.preventDefault()
    selectFilter(order[(i - 1 + order.length) % order.length])
  }
}

/** 批量清理两段确认：首击进 danger 确认态（完整文案防误触）；第二击 emit 执行。 */
function onBatchPurgeClick(): void {
  if (props.batchPurging) return
  if (!batchConfirming.value) {
    batchConfirming.value = true
    return
  }
  batchConfirming.value = false
  emit('purgeBatch', visibleArchives.value)
}

/**
 * 彻底删除两段确认态（D6「两段红确认」）：当前确认的 sessionId（同时只允许一行确认）。
 * reset 通道收窄为行切换/行卸载（v-for 重渲染即清）——归档行生命周期短（操作即消失），
 * 不引入 Esc/外部点击多路 reset（误触代价 = 再次点击才执行，确认钮本身即拦截）。
 */
const purgeConfirmingId = ref<string | null>(null)

function onPurgeClick(archive: ArchiveSummary): void {
  if (props.purgingSessionId === archive.sessionId) return
  if (purgeConfirmingId.value !== archive.sessionId) {
    purgeConfirmingId.value = archive.sessionId
    return
  }
  purgeConfirmingId.value = null
  emit('purge', archive)
}

/** 条目显示名（name 空串回退未命名占位，D3 合法形态）。 */
function displayName(archive: ArchiveSummary): string {
  return archive.name.length > 0 ? archive.name : t('archive.summary.unnamed')
}

/** 原项目标签（projectId 经 projectStore 解析；未归类/解析失败返回空串——sub 行省略该段）。 */
function projectNameOf(archive: ArchiveSummary): string {
  const id = archive.projectId
  if (!id) return ''
  return projectStore.projects.find((p) => p.id === id)?.name ?? ''
}

/** 文件大小人类可读（B/KB/MB 一位小数——ImportSessionDialog.formatSize 同款口径）。 */
const BYTES_PER_KB = 1024
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB

function formatSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes} B`
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`
}

/** 百分比换算基数（no-magic-numbers：命名常量承载） */
const PCT_SCALE = 100

/** 压缩信息（D10 行结构格式 `12.4 MB → 2.5 MB · -80%`；staging 显示「压缩中」）。 */
function compressionLabel(archive: ArchiveSummary): string {
  if (archive.status === 'staging') return t('archive.summary.compressing')
  const base = `${formatSize(archive.rawBytes)} → ${formatSize(archive.compressedBytes)}`
  if (archive.rawBytes <= 0) return base
  const pct = Math.round((1 - archive.compressedBytes / archive.rawBytes) * PCT_SCALE)
  if (pct <= 0) return base
  return `${base} · -${pct}%`
}

/** 行 aria-label：屏幕阅读器读出「已归档会话 <名称>」（归档语义 + 名称）。 */
function rowAriaLabel(archive: ArchiveSummary): string {
  return t('archive.entry.rowAria', { name: displayName(archive) })
}
</script>
