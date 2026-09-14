<template>
  <!--
    容器组件 · trace-view（session-trace §3.1 终态：占满 main 区的全量 entry 台账）。
    结构：TraceToolbar（状态行 + chips + 搜索 + context toggle）+ 行列表 + context 分界行。
    加载/空态/失败路径（§3.1）：loading 转圈 / empty（未落盘）文案 / oversize（超预检阈值
    D5④）降级文案 / error 重试 / 过滤空态。
    虚拟滚动（D9）：>500 item 启用 virtua Virtualizer（MessageStream 同族设施），
    ≤500 直接 v-for（短列表免测量开销）。两路径共用 TraceRowItem。
    数据不重建（A42）：rows 从 store 分区派生（mapSessionTraceRows 纯函数重算），
    视图切换/组件卸载不碰 store 分区，切回状态保留。
  -->
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    <!-- 加载态 -->
    <div
      v-if="partition.status === 'loading'"
      class="flex flex-1 flex-col items-center justify-center gap-2 text-center"
      data-testid="trace-loading"
    >
      <Loader2 class="size-5 animate-spin text-neutral-dim opacity-60" />
      <p class="text-[length:var(--text-xs)] text-neutral-dim">{{ t('panel.trace.loading') }}</p>
    </div>
    <!-- 失败路径：加载失败（§3.1 失败路径，文案 t() 占位收口 trace-i18n） -->
    <div
      v-else-if="partition.status === 'error'"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
      data-testid="trace-error"
    >
      <AlertCircle class="size-6 text-danger opacity-60" />
      <p class="text-[length:var(--text-xs)] text-neutral-fg">{{ t('panel.trace.loadFailed') }}</p>
      <p class="max-w-[420px] text-[length:var(--text-2xs)] leading-relaxed text-neutral-dim">{{ t('panel.trace.loadFailedHint') }}</p>
      <p class="font-mono text-[length:var(--text-3xs)] text-neutral-faint">{{ partition.errorCode }}</p>
      <!-- envelope message 透出（分区已存此前未渲染）：payload_too_large 等传输守卫错误
           的恢复指引在此字段（「加载更早」分页入口 + session 文件路径，crash-resilience §3.4），
           只显示 code 会把恢复路径藏掉 -->
      <p
        v-if="partition.errorMessage"
        class="max-w-[420px] break-all text-[length:var(--text-2xs)] leading-relaxed text-neutral-dim"
        data-testid="trace-error-message"
      >{{ partition.errorMessage }}</p>
      <Button variant="ghost" size="sm" data-testid="trace-retry" @click="retry(props.sessionId)">
        <RotateCcw class="mr-1 size-3" />
        {{ t('panel.trace.retry') }}
      </Button>
    </div>
    <!-- 失败路径：session 未落盘（pi 延迟写入窗口，规则 6——不创建文件，落盘后自动加载） -->
    <div
      v-else-if="partition.source === 'empty'"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
      data-testid="trace-empty-not-persisted"
    >
      <Hourglass class="size-6 text-neutral-dim opacity-40" />
      <p class="text-[length:var(--text-xs)] text-neutral-dim">{{ t('panel.trace.emptyNotPersisted') }}</p>
      <Button variant="ghost" size="sm" data-testid="trace-retry" @click="retry(props.sessionId)">
        <RotateCcw class="mr-1 size-3" />
        {{ t('panel.trace.retry') }}
      </Button>
    </div>
    <!-- 失败路径：文件超 runtime 读取预检阈值（crash-resilience §3.3 D5④）——entries 恒空，
         独立分支渲染，不与 empty 空态混淆。降级文案（体积 + 源文件绝对路径）由 runtime
         formatTraceOversizeMessage 产出经分区透传（设计定版文案 SSOT 在 runtime；快照无
         独立体积字段，组件不可本地重组）。组件形态对齐 empty 分支（icon + 文案 + 重试）。 -->
    <div
      v-else-if="partition.source === 'oversize'"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
      data-testid="trace-oversize"
    >
      <FileWarning class="size-6 text-neutral-dim opacity-40" />
      <p class="text-[length:var(--text-xs)] text-neutral-fg" data-testid="trace-oversize-message">{{ partition.oversizeMessage }}</p>
      <Button variant="ghost" size="sm" data-testid="trace-retry" @click="retry(props.sessionId)">
        <RotateCcw class="mr-1 size-3" />
        {{ t('panel.trace.retry') }}
      </Button>
    </div>
    <!-- 台账主体 -->
    <template v-else>
      <!-- RPC 降级 banner（§3.1 失败路径：pi RPC 失败/非活跃 session 走文件直读，无实时增量）。
           source='file' 涵盖两种情形，语义统一：凡文件路径均无实时更新（增量腿只随 RPC 建立）。 -->
      <div
        v-if="partition.source === 'file'"
        class="flex flex-shrink-0 items-center gap-1.5 border-b border-hairline px-3.5 py-1 text-[length:var(--text-2xs)] text-neutral-dim"
        data-testid="trace-degraded-banner"
      >
        <FileWarning class="size-3 shrink-0 opacity-70" />
        <span>{{ t('panel.trace.degradedFileSource') }}</span>
      </div>
      <!--
           B11 台账截断降级 banner（正交字段 truncated，参照 source:'oversize' 先例——
           不新增 status 值，台账仍正常渲染）：entries 达 5000 软上限停止追加后提示台账
           不完整。与 file 降级 banner 同构（icon + 文案），正交可同时出现。 -->
      <div
        v-if="partition.truncated"
        class="flex flex-shrink-0 items-center gap-1.5 border-b border-hairline px-3.5 py-1 text-[length:var(--text-2xs)] text-neutral-dim"
        data-testid="trace-truncated-banner"
      >
        <FileWarning class="size-3 shrink-0 opacity-70" />
        <span>{{ t('panel.trace.truncatedLedger') }}</span>
      </div>
      <TraceToolbar
        :rows="rows"
        :context-only="partition.contextOnly"
        :active-groups="partition.activeGroups"
        :search-text="partition.searchText"
        :current-prompt="partition.currentPrompt"
        :fetching="partition.currentPromptFetching"
        :fetch-error-code="partition.currentPromptErrorCode"
        @toggle-group="onToggleGroup"
        @toggle-context="onToggleContext"
        @update:search-text="(v) => setFilter(props.sessionId, { searchText: v })"
        @fetch-current="fetchCurrentPrompt(props.sessionId)"
      />
      <!-- 左侧 timeline 轨道线：neutral-faint（token 语义「极弱/装饰」，实色明确可见）
           填充 seq 右对齐列的留白区；border 在滚动容器边框盒上，行 hover 底色（内容区）
           不会盖住线；ml-2 让线与面板边缘留 8px 呼吸 -->
      <div
        ref="scrollEl"
        class="ml-2 min-h-0 flex-1 overflow-y-auto border-l border-neutral-faint pb-4 pt-1 [overflow-anchor:none]"
        data-testid="trace-list"
      >
        <!-- 空态：过滤后无匹配 -->
        <div
          v-if="items.length === 0"
          class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
          data-testid="trace-empty"
        >
          <ListTree class="size-6 text-neutral-dim opacity-40" />
          <p class="text-[length:var(--text-xs)] text-neutral-dim">
            {{ rows.length === 0 ? t('panel.trace.emptyNoRows') : t('panel.trace.emptyFiltered') }}
          </p>
        </div>
        <!-- >500 启用虚拟滚动（D9）。slot 内仅单一 TraceListItem vnode + 稳定 key
             （virtua 从 slot vnode 取 key，注释/多 vnode 会破坏 stable-key；
             block 子行 key = `<entryKey>#block-N`，不与 entry key 冲突）。 -->
        <Virtualizer
          v-else-if="virtualized"
          ref="vlistRef"
          :data="items"
          :item-size="ESTIMATED_ROW_HEIGHT"
          :key="props.sessionId"
        >
          <template #default="{ item }">
            <TraceListItem
              :key="displayItemKey(item)"
              :item="item"
              :selected="displayItemKey(item) === partition.selectedKey"
              @select="onSelectRow"
              @jump-parent="onJumpParent"
              @toggle-expand="onToggleExpand"
              @select-block="onSelectBlock"
            />
          </template>
        </Virtualizer>
        <!-- ≤500 直接渲染（短列表免 virtua 测量开销） -->
        <template v-else>
          <TraceListItem
            v-for="item in items"
            :key="displayItemKey(item)"
            :item="item"
            :selected="displayItemKey(item) === partition.selectedKey"
            @select="onSelectRow"
            @jump-parent="onJumpParent"
            @toggle-expand="onToggleExpand"
            @select-block="onSelectBlock"
          />
        </template>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * Trace 视图主体。rows 派生链：store 分区（header/entries/malformed/sessionEnd/leafId）
 * → mergeTraceLines → core mapSessionTraceRows（12 kind + context 边界 + 影子化）。
 * 过滤链：core filterTraceRows（contextOnly + chips）+ 文本搜索（UI 层，demo 语义不匹配隐藏）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Virtualizer } from 'virtua/vue'
import type { VirtualizerHandle } from 'virtua/vue'
import { AlertCircle, FileWarning, Hourglass, ListTree, Loader2, RotateCcw } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useToast } from '@/composables/useToast'
import {
  filterTraceRows,
} from '@xyz-agent/core/domain/session-trace'
import type { TraceKindGroup, TraceRow } from '@xyz-agent/core/domain/session-trace'
import { useTraceRows } from '@/composables/features/trace/useTraceRows'
import {
  ensureTraceLoaded,
  fetchCurrentPrompt,
  retryTraceLoad,
  selectTraceEntry,
  setTraceFilter,
  toggleTraceExpand,
  useSessionTrace,
} from '@/composables/features/trace/useSessionTrace'
import {
  buildTraceDisplayItems,
  displayItemKey,
} from '@/composables/features/trace/trace-display-items'
import type { TraceDisplayItem } from '@/composables/features/trace/trace-display-items'
import TraceToolbar from './TraceToolbar.vue'
import TraceListItem from './TraceListItem.vue'
import { jumpToParentSession } from '@/composables/features/trace/useTraceJump'

const props = defineProps<{
  sessionId: string
}>()

const { t } = useI18n()
const { error: toastError } = useToast()
const { partition } = useSessionTrace()
const retry = retryTraceLoad
const setFilter = setTraceFilter

const scrollEl = ref<HTMLElement | null>(null)
const vlistRef = ref<VirtualizerHandle | null>(null)

/** 虚拟滚动启用阈值（D9：>500 entry）与行高估计。 */
const VIRTUAL_SCROLL_THRESHOLD = 500
const ESTIMATED_ROW_HEIGHT = 28

/** store 分区 → core TraceRow[]（useTraceRows 共享派生，TraceInspector 同源）。 */
const rows = useTraceRows()

/** 行可搜索文本（kind + headline + meta 值拼接，demo data-text 同源语义）。 */
function searchableText(row: TraceRow): string {
  const metaText = Object.values(row.meta)
    .filter((v) => v !== undefined)
    .join(' ')
  return `${row.kind} ${row.headline} ${metaText}`.toLowerCase()
}

/** 过滤管道：core filterTraceRows（contextOnly + chips）+ 文本搜索（UI 层）。 */
const filteredRows = computed<TraceRow[]>(() => {
  const p = partition.value
  const byState = filterTraceRows(rows.value, {
    contextOnly: p.contextOnly,
    activeGroups: p.activeGroups,
  })
  const q = p.searchText.trim().toLowerCase()
  if (!q) return byState
  return byState.filter((row) => searchableText(row).includes(q))
})

/** 渲染项：展开子 block 的台账行 + context 分界行（最后一个 COMPACTED 之后；contextOnly 态隐藏——demo 行为）。 */
const items = computed<TraceDisplayItem[]>(() => {
  const list = buildTraceDisplayItems(filteredRows.value, partition.value.expandedKeys)
  if (partition.value.contextOnly) return list
  let lastCompactionIdx = -1
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]
    if (item.kind === 'row' && item.row.kind === 'COMPACTED') {
      lastCompactionIdx = i
      break
    }
  }
  if (lastCompactionIdx >= 0 && lastCompactionIdx < list.length - 1) {
    list.splice(lastCompactionIdx + 1, 0, { kind: 'divider' })
  }
  return list
})

const virtualized = computed(() => items.value.length > VIRTUAL_SCROLL_THRESHOLD)

function onToggleGroup(group: 'all' | TraceKindGroup): void {
  const current = partition.value.activeGroups
  let next: TraceKindGroup[]
  if (group === 'all') {
    next = [] // 全部 = 无 chips 激活（白名单语义）
  } else if (current.includes(group)) {
    next = current.filter((g) => g !== group)
  } else {
    next = [...current, group]
  }
  setFilter(props.sessionId, { activeGroups: next })
}

function onToggleContext(): void {
  setFilter(props.sessionId, { contextOnly: !partition.value.contextOnly })
}

function onSelectRow(row: TraceRow): void {
  selectTraceEntry(props.sessionId, row.key)
}

/** assistant 聚合行 chevron：切换子 block 展开（不改变选中态）。 */
function onToggleExpand(row: TraceRow): void {
  toggleTraceExpand(props.sessionId, row.key)
}

/** 子 block 行点击：选中该 block（selectedKey = `<entryKey>#block-N`）。 */
function onSelectBlock(key: string): void {
  selectTraceEntry(props.sessionId, key)
}

/**
 * 溯源跳转（§3.1 样例 5）：SESSION 行 parentSession 链接 → 切源 session + 开 Trace +
 * 定位 forkEntryId 行。失败 toast（文案 i18n，reason → 键映射）。跳转本身切走本视图，
 * 本组件随 session 切换重挂载/重绑，无需本地清理。
 */
async function onJumpParent(row: TraceRow): Promise<void> {
  const ref = row.meta.parentSession
  if (typeof ref !== 'string' || !ref) return
  const forkId = typeof row.meta.forkEntryId === 'string' ? row.meta.forkEntryId : undefined
  const result = await jumpToParentSession(props.sessionId, ref, forkId)
  if (!result.ok) {
    toastError(t(result.reason === 'target_not_found' ? 'panel.trace.jumpTargetNotFound' : 'panel.trace.jumpLoadFailed'))
  }
}

/**
 * 溯源定位滚动：revealRequest 到达 → 滚动到目标行居中（虚拟/非虚拟两路径）。
 * 行不在 items（被过滤/不存在）时静默忽略——选中态已写入，用户可手动找。
 */
watch(
  () => partition.value.revealRequest,
  (req) => {
    if (!req) return
    const idx = items.value.findIndex((it) => it.kind === 'row' && it.row.key === req.key)
    if (idx < 0) return
    if (virtualized.value) {
      vlistRef.value?.scrollToIndex(idx, { align: 'center' })
    } else {
      const seq = items.value[idx]?.kind === 'row' ? items.value[idx].row.seq : 0
      scrollEl.value
        ?.querySelector(`[data-testid="trace-row-${seq}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  },
)

onMounted(() => {
  ensureTraceLoaded(props.sessionId)
})
// session 切换（split/换绑场景）：确保新分区加载（幂等）
watch(
  () => props.sessionId,
  (sid) => ensureTraceLoaded(sid),
)
</script>
