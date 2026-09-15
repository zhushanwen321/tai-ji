<template>
  <!--
    展示组件 · 文件视图（#4，draft-five-states §B）。
    [W28/D-7.2] 树形递归渲染 → 扁平可见行（projectVisibleRows）+ virtua 虚拟滚动：
    - 树数据仍是 SSOT（fileTreeStore 4 facet 不变），本组件持有唯一「树→可见行」投影 computed
    - FileTreeRow 改纯行组件（收 VisibleRow），展开/选中交互在本层编排（useFileTree + useSideDrawer）
    - 头部（session label + showIgnored 开关）与过滤框移到滚动区外固定——virtua Virtualizer 要求
      其 parentElement 即滚动容器且前方无内容（startMargin 动态高度脆弱），过滤器固定可见
      （旧版头部随树滚动，属 D-7.2 结构改动的刻意取舍）
    - 万级目录展开只挂载视口 ± 缓冲的行（探针 P-D7-1：5000 文件目录 DOM 行数 < 200）

    数据来源（W4 重写，替代旧「改动文件列表」）：
    - fileTreeStore.tree（per-session FileNode[]）+ expandedPaths（D-019 rehydrate）
    - gitOverlay 提供 M/A/D/U 角标（D-012 树/标注分离）
    - 编排走 useFileTree（loadTree/expandNode/collapseNode/selectFile/setFilter）
    - sessionId 由 Sidebar 注入（当前 active session），切 session 触发 loadTree
  -->
  <div class="flex h-full min-h-0 flex-col gap-0.5 px-1" data-testid="file-view-root">
    <!-- 头部：当前 session 标签 + 分支（左）× showIgnored 开关（右），同一行。
         D-020/D-004：忽略项开关从过滤框下方上移至此（与会话名同行：会话名左、忽略项右）。 -->
    <div v-if="sessionLabel" class="flex items-center gap-2 px-2 py-1.5">
      <div class="min-w-0 flex-1 truncate font-mono text-[length:var(--text-3xs)] text-neutral-mid">
        <span class="text-neutral-fg">{{ sessionLabel }}</span>
        <span v-if="branch" class="opacity-60"> · </span>
        <span v-if="branch" class="text-accent">{{ branch }}</span>
      </div>
      <Button
        variant="ghost"
        class="h-5 shrink-0 gap-1 rounded-sm px-1.5 text-[length:var(--text-3xs)]"
        :class="store.showIgnored ? 'text-accent' : 'text-neutral-dim'"
        :title="store.showIgnored ? t('sidebar.fileView.hideIgnored') : t('sidebar.fileView.showIgnored')"
        data-testid="file-show-ignored-toggle"
        @click="onToggleShowIgnored"
      >
        <EyeOff v-if="store.showIgnored" class="size-3" />
        <Eye v-else class="size-3" />
        <span>{{ t('sidebar.fileView.ignoredItem') }}</span>
      </Button>
    </div>

    <!-- 过滤框：实时按 path 模糊匹配（store.filterText，useFileTree.setFilter 驱动） -->
    <div class="relative px-2 pb-1.5">
      <!-- 图标按 input(h-6=24px) 高度居中：top-3(12px)=input 中心，再 -translate-y-1/2。
           不能用 top-1/2：容器有 pb-1.5(底部6px) 无顶部 padding，容器 box 高 30px，
           top-1/2=15px 会让图标相对整个容器居中而偏低 3px（padding/2）。 -->
      <Search class="pointer-events-none absolute left-4 top-3 size-3 -translate-y-1/2 text-neutral-dim" />
      <Input
        :model-value="filterDisplay"
        class="h-6 pl-6 pr-2 text-[length:var(--text-2xs)]"
        :placeholder="t('sidebar.fileView.filterPlaceholder')"
        data-testid="file-filter-input"
        @focus="filterFocused = true"
        @blur="filterFocused = false"
        @update:model-value="onFilter"
      />
    </div>

    <!-- 滚动区：仅承载树（加载/错误/空态）。virtua Virtualizer 必须是其 parentElement
         （ScrollAreaViewport）的直接子节点——滚动容器由 virtua 从 parentElement 探测，
         中间不能有包装 div（探针实证，MessageStream 同结构）。三态与树互为 v-if/v-else 链。 -->
    <ScrollArea class="min-h-0 flex-1" horizontal>
      <!-- 加载态（loadTree 在途） -->
      <div
        v-if="rootState.status === 'loading'"
        class="flex flex-col items-center justify-center gap-2 py-10 text-center"
        data-testid="file-loading"
      >
        <Loader2 class="size-4 animate-spin text-neutral-dim opacity-60" />
        <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-60">{{ t('sidebar.fileView.loadingTree') }}</p>
      </div>

      <!-- 错误态（loadTree 失败，可重试） -->
      <div
        v-else-if="rootState.status === 'error'"
        class="flex flex-col items-center justify-center gap-2 py-10 text-center"
        data-testid="file-error"
      >
        <AlertCircle class="size-5 text-danger opacity-60" />
        <p class="text-[length:var(--text-2xs)] text-neutral-mid">{{ t('sidebar.fileView.loadFailed', { reason: rootState.reason ?? 'unknown' }) }}</p>
        <Button variant="ghost" class="h-6 text-[length:var(--text-2xs)] text-accent" data-testid="file-retry" @click="retry">{{ t('sidebar.fileView.retry') }}</Button>
      </div>

      <!-- 空态：loaded 但无节点（空目录 cwd）或过滤无匹配（E7-c：投影空 → 维持既有空态） -->
      <div
        v-else-if="visibleRows.length === 0"
        class="flex flex-col items-center justify-center gap-2 py-10 text-center"
        data-testid="file-empty"
      >
        <component :is="hasFilter ? SearchX : FolderOpen" class="size-5 text-neutral-dim opacity-50" />
        <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-55">{{ hasFilter ? t('sidebar.fileView.noMatch') : t('sidebar.fileView.noFile') }}</p>
      </div>

      <!-- 文件树：virtua 挂扁平行（可见行 = projectVisibleRows 投影；itemProps 宽度 max-content
           使长文件名撑开横向滚动，minWidth 100% 保短行 hover 铺满容器——实测量化见 W28 汇报探针）。
           注意：<template #default> 内禁止放注释/文本节点——virtua 的 item key 提取要求 slot 返回
           恰好 1 个 vnode（P(): e.length===1 才取 e[0].key），注释节点会 fallback 索引 key。 -->
      <Virtualizer
        v-else
        class="mt-1"
        :data="visibleRows"
        :item-size="ROW_HEIGHT_ESTIMATE"
        :item-props="() => ({ style: { width: 'max-content', minWidth: '100%' } })"
        :key="props.sessionId"
      >
        <template #default="{ item }">
          <FileTreeRow
            :key="visibleRowKey(item)"
            :row="item"
            :selected="item.type === 'file' && item.path === store.selectedPath"
            @toggle="onToggleRow"
            @select="onSelectRow"
          />
        </template>
      </Virtualizer>
    </ScrollArea>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, toRef } from 'vue'
import { Virtualizer } from 'virtua/vue'
import { FolderOpen, Search, SearchX, Loader2, AlertCircle, Eye, EyeOff } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import FileTreeRow from './FileTreeRow.vue'
import {
  useFileTreeStore,
  projectVisibleRows,
  visibleRowKey,
  type VisibleRow,
} from '@/stores/fileTree'
import { useFileTree } from '@/composables/features/file-tree/useFileTree'
import { useSideDrawer } from '@/composables/features/drawer/useSideDrawer'

const { t } = useI18n()

const props = defineProps<{
  /** 当前 active session id（Sidebar 注入，切 session 触发 loadTree） */
  sessionId: string
  sessionLabel?: string
  branch?: string
}>()

const store = useFileTreeStore()
const { loadTree, setFilter, setupInvalidation, toggleShowIgnored, expandNode, collapseNode, selectFile } = useFileTree()
const drawer = useSideDrawer()

/** virtua item-size 初始估算（px）：行高 = py-0.5(4px) + 单行内容 ≈ 24px，挂载后 ResizeObserver 实测校正 */
const ROW_HEIGHT_ESTIMATE = 24

/** 跨 store 失效 unwatch 句柄（onBeforeUnmount 清理，W6 #3.11） */
let unwatchInvalidation: (() => void) | null = null

/** 根节点加载态（path='' 的 NodeState） */
const rootState = computed(() => store.getNodeState(props.sessionId, ''))

/**
 * [W28/D-7.2] 唯一「树 → 可见行」投影 computed（E7-a：computed 缓存投影，依赖分桶后的
 * 细粒度 getter——展开/折叠/过滤/overlay 变化触发一次 O(可见行) 重投影）。
 * [W28 审查 Fix-2] overlay/counts 走 per-session getter（getGitOverlay/getDirChangeCounts，
 * 与 getExpanded 同款分桶）——只追踪本 sid 分桶 key，异 sid git.status 回写不触发重算
 * （split mode 多面板隔离；store 侧 setGitOverlay 已改 keyed set 支撑）。
 * 语义与旧递归渲染逐行等价（顶层过滤 + 展开 DFS + loading/error/empty 占位行）。
 */
const visibleRows = computed<VisibleRow[]>(() =>
  projectVisibleRows(
    (sid) => store.getTree(sid),
    (sid) => store.getExpanded(sid),
    (sid) => store.getGitOverlay(sid),
    (sid) => store.getDirChangeCounts(sid),
    store.filterText,
    store.showIgnored,
    props.sessionId,
    (sid, path) => store.getNodeState(sid, path),
  ),
)

const hasFilter = computed(() => store.filterText.trim().length > 0)

/**
 * [W15 审查] 输入框显示值与提交值解绑：
 * filterDisplay 是本地显示 ref（击键即时更新），store.filterText 是 200ms 防抖后的
 * 提交值（visibleRows 过滤重算的依赖源）。解绑消除窄窗口竞态——commit 的渲染 flush
 * 与新击键交错时，受控 prop（上一次提交值）不得把用户正在输入的显示拉回旧值。
 * Input 内部 useVModel(passive) 会让 prop 更新覆盖本地击键值，绑定 store.filterText
 * 直连时该竞态表现为输入框瞬回退（≤200ms 后下次 commit 自愈）。
 */
const filterDisplay = ref('')

/** 过滤框聚焦态：聚焦中 store.filterText 的变化不回写显示值（用户击键优先） */
const filterFocused = ref(false)

/**
 * store → 显示同步：仅非聚焦态（程序改 filterText 等场景）。聚焦中跳过——聚焦期间
 * store 的唯一写入源就是自己的防抖 commit（值与 filterDisplay 一致），跳过无损；
 * 若未来出现聚焦中的外部写入方，blur 后下一次 store 变化才会同步（已知取舍）。
 */
watch(
  () => store.filterText,
  (v) => {
    if (!filterFocused.value) filterDisplay.value = v
  },
  { immediate: true },
)

/** 过滤输入：本地显示即时更新 + 透传 useFileTree.setFilter 防抖提交（#4） */
function onFilter(value: string | number): void {
  filterDisplay.value = String(value)
  setFilter(String(value))
}

/** 错误态重试：重 loadTree（useFileTree 内 loaded 复用，error 态会重发） */
function retry(): void {
  void loadTree(props.sessionId)
}

/**
 * 切换 showIgnored：纯前端投影过滤（与过滤框同机制），瞬时无闪烁。
 * tree 已含全部 ignored 节点（后端始终返回并标记），切换只改 store.showIgnored，
 * visibleRows 投影重算，无需重拉。
 */
function onToggleShowIgnored(): void {
  toggleShowIgnored()
}

/**
 * [W28/D-7.2] 目录行 toggle（含 error 占位行点击——沿用旧递归语义：已展开 → 折叠）。
 * FileTreeRow 不再持有 useFileTree 依赖，交互统一归位本层（09 文档检查点）。
 */
function onToggleRow(row: VisibleRow): void {
  if (row.expanded) collapseNode(props.sessionId, row.path)
  else void expandNode(props.sessionId, row.path)
}

/**
 * 选中文件（#6 预览触发，code-architecture §4 功能3 时序：点文件→SideDrawer.openDetailPane）。
 * selectFile 设 store.selectedPath（useDetailPane watch 自动加载内容），
 * drawer.open('detail') 打开抽屉切到 detail tab（DetailPane 挂载）。
 */
function onSelectRow(row: VisibleRow): void {
  selectFile(row.path)
  drawer.open('detail')
}

/**
 * 切 session 触发 loadTree（首加载）。
 * useFileTree.loadTree 内部已缓存复用 + rehydrate 展开（D-019）。
 */
watch(
  () => props.sessionId,
  (sid) => {
    if (sid) void loadTree(sid)
  },
  { immediate: true },
)

/**
 * [W6 #3.11] 跨 store 失效：setupInvalidation watch chat store fileChanges 变化 → invalidate。
 * onMounted 建立 watch，onBeforeUnmount 清理（setupInvalidation 返回 unwatch 函数）。
 */
onMounted(() => {
  unwatchInvalidation = setupInvalidation(toRef(props, 'sessionId'))
})

onBeforeUnmount(() => {
  unwatchInvalidation?.()
  unwatchInvalidation = null
})
</script>
