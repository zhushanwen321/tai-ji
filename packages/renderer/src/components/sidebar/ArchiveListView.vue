<template>
  <!--
    展示组件 · 归档列表视图（session-archive 设计 D10，u-renderer-entry）。

    侧栏 sessions tab 内容区的第二视图（SessionList ↔ 本组件互斥渲染，视图开关 =
    archive store.viewOpen，切换编排在 useArchiveView）：头 = 返回钮 +「已归档 (N)」；
    行结构（D10）= 名称（staging 态带「压缩中」标注）/ 原项目标签 + 压缩信息 sub 行 /
    归档时间右列；悬停时时间列让位 [恢复]（accent）/ [彻底删除]（danger 两段）双钮
    （对齐 SessionItem 悬停钮替换时间列的范式——右槽 opacity 互斥，占位不变零跳动）。
    点击行 = 主区呈现摘要视图（emit select，Sidebar 接 useArchiveView.openSummary）。
    空态：列表区居中「暂无归档会话」；拉取失败显示重试。

    纯展示（零 RPC）：数据 props 注入（store.archives / loading / listError 经
    Sidebar 转发），projectName 按 archive.projectId 经 projectStore 解析（同
    SessionList 消费 projectStore 先例）。
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
      <span class="font-mono text-[length:var(--text-2xs)] text-neutral-fg-2" data-testid="archive-list-count">{{ archives.length }}</span>
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

        <!-- 空态（D10：列表区居中「暂无归档会话」；非加载中才显——加载闪空态是误报） -->
        <div
          v-else-if="!loading && archives.length === 0"
          class="flex flex-col items-center justify-center gap-2 py-10 text-center"
          data-testid="archive-list-empty"
        >
          <Package class="size-5 text-neutral-dim opacity-40" />
          <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-55">{{ t('archive.entry.empty') }}</p>
        </div>

        <!-- 行列表 -->
        <div
          v-for="entry in archives"
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
                  ? 'bg-danger text-neutral-fg'
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
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, RotateCcw, Trash2, Check, Package, AlertCircle } from '@lucide/vue'
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
  /** 拉取失败重试（useArchiveView.refreshArchives） */
  retry: []
}>()

const { t } = useI18n()
const projectStore = useProjectStore()

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

/** 文件大小人类可读（B/KB/MB 一位小数——ArchiveSummaryView.formatSize 同款口径）。 */
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
