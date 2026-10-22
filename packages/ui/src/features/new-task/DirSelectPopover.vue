<script setup lang="ts">
/**
 * DirSelectPopover.vue —— 步骤2 选目录 popover（spec §3.2 IA 重构后）。
 *
 * [w4 迁移] 自 renderer components/new-task/DirSelectPopover.vue（192 行）迁入 ui 包
 * features/new-task/（C-NT-4 跨端共享组件）。变化：workspaceStore.records → deps.recentWorkspaces
 * （NewTaskDeps inject，C-W4-1）；ui 原语走包内相对导入（不经顶层 barrel，防自引用环）；
 * useFlatListNav/path 本地化（C-W4-3）。props/emits/模板逐字迁移（CT-4，不做功能改动）。
 *
 * 纯文件系统导航：已固定 + 最近工作区 + 默认会话 + 打开文件夹。
 * Worktree 相关内容（已有 worktree 列表 / 新建 worktree / 远程连接）已迁至 BranchSelectPopover 的
 * Worktree tab，本组件只保留目录选择职责。
 *
 * 形态：popover 内容面板（宽度 320px；向上展开由父级 PopoverContent side="top" 控制）。
 *
 * 数据流（container for data）：deps.recentWorkspaces → 分区渲染（pinned「已固定」区置顶 +
 * 最近区，两区独立上限由 runtime 保证）+ deps.defaultSessionDir（「默认会话」固定入口）。
 * 动作（presentational for actions，emit 单 payload 对象）：
 * - 选列表项 → emit('select', { cwd })（父接 flow.selectWorkspace）
 * - 选「默认会话」→ emit('select-default')（父接 flow.selectWorkspace(dir, {record:false})——
 *   固定入口不进最近工作区 LRU，用户裁决 2026-10-22）
 * - pin/unpin → 组件内闭环调 deps.setPinned（不涉及 flow；超上限 deps 返回 false → toast）
 * - 「打开文件夹」→ emit('open-dir-dialog')（父接 flow.openDirDialog → OS 原生 dialog）
 * - Esc → emit('close')
 *
 * 空态（T3.2 / AC-5.4）：两区均空且无默认会话目录 → 「暂无最近工作区 · 选择一个本地目录开始」。
 */
import { ref, computed, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Folder, FolderPlus, House, Pin, PinOff } from '@lucide/vue'
// ui 原语走包内相对导入（不经 @taiji/ui 顶层 barrel）：new-task 组件经顶层 barrel
// 再导出，顶层 barrel 自引用会封住循环依赖环（R2 S-1）
import { Input } from '../../primitives/input'
import { PopoverActionItem, PopoverListItem } from '../../primitives/popover'
import { useNewTaskDeps } from './new-task-deps'
import { useFlatListNav } from './composables/useFlatListNav'
import { dirNameOf, parentDirNameOf } from './logic/path'
import type { RecentWorkspaceRecord } from '@taiji/shared'

const props = defineProps<{
  /** 当前 cwd（高亮已选项，Card-Active） */
  currentCwd: string | null
}>()

const emit = defineEmits<{
  (e: 'select', payload: { cwd: string }): void
  (e: 'select-default'): void
  (e: 'open-dir-dialog'): void
  (e: 'close'): void
}>()

const { t } = useI18n()
const { recentWorkspaces, defaultSessionDir, setPinned, toast } = useNewTaskDeps()

const search = ref('')
const root = ref<HTMLElement | null>(null)

/** W1（MAX_RECORDS 10→6）：最近区分区展示上限，与 runtime RecentWorkspacesStore.MAX_RECORDS 对齐
 *  双保险：即便 runtime 返超量也只显 6 项（pinned 区独立上限 ≤5，runtime 保证） */
const MAX_DISPLAY = 6

/** 尾部动作项基数（「打开文件夹」恒在）；「默认会话」按需 +1 */
const BASE_ACTION_COUNT = 1
const actionCount = computed(
  () => BASE_ACTION_COUNT + (defaultSessionDir.value ? 1 : 0),
)

/** 已固定区（runtime 已排序置前，双保险再过滤一次 + 截断）；最近区同构。 */
const pinnedItems = computed<RecentWorkspaceRecord[]>(() =>
  recentWorkspaces.value.filter((w) => w.pinned).slice(0, MAX_DISPLAY),
)
const recentItems = computed<RecentWorkspaceRecord[]>(() => {
  const recent = recentWorkspaces.value.filter((w) => !w.pinned)
  return recent.slice(0, MAX_DISPLAY)
})

/** 搜索即时过滤（无 debounce，list < 50 本地缓存，spec §3.2）；两区独立过滤 + 截断 */
const filteredPinned = computed<RecentWorkspaceRecord[]>(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return pinnedItems.value
  // label 已是 cwd basename，是其全路径 cwd 的子串，单独按 cwd 匹配即可覆盖两者
  return pinnedItems.value.filter((w) => w.cwd.toLowerCase().includes(q))
})
const filteredRecent = computed<RecentWorkspaceRecord[]>(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return recentItems.value
  return recentItems.value.filter((w) => w.cwd.toLowerCase().includes(q)).slice(0, MAX_DISPLAY)
})

/** 空态：两区均空且无默认会话入口（有固定入口时恒有可选目标，不出空态） */
const isEmpty = computed(
  () => filteredPinned.value.length === 0 && filteredRecent.value.length === 0 && !defaultSessionDir.value,
)

/** 当前 pin 数（上限提示判据；runtime MAX_PINNED=5 的前端镜像，双保险） */
const PIN_LIMIT = 5
const pinnedCount = computed(() => recentWorkspaces.value.filter((w) => w.pinned).length)

/**
 * 扁平化索引基准（键盘导航）：filteredPinned → filteredRecent → 默认会话（按需）→ 打开文件夹。
 * DOM 顺序与索引序一致；各区间隔即长度叠加。
 */
const pinnedLen = computed(() => filteredPinned.value.length)
const recentLen = computed(() => filteredRecent.value.length)
const defaultSessionIdx = computed(() => pinnedLen.value + recentLen.value)
const openDirIdx = computed(() => defaultSessionIdx.value + (defaultSessionDir.value ? 1 : 0))

/** 当前可见列表合并序（已固定 → 最近）= 渲染序 = 键盘导航扁平索引序。 */
const allFiltered = computed<RecentWorkspaceRecord[]>(() => [
  ...filteredPinned.value,
  ...filteredRecent.value,
])

/** basename 出现该次数即视为同名，需追加上级段名消歧 */
const DUP_THRESHOLD = 2

/**
 * 当前可见列表（两区合并）内重复 ≥ DUP_THRESHOLD 次的 basename 集合——这些目录需追加上级段名
 * 消歧（如 /Code/chat_project 与 /Stock/chat_project → 都显 chat_project(Code)/chat_project(Stock)）。
 * 以过滤后实际展示的列表为统计范围，让搜索缩小范围后也能正确消歧。
 */
const dupBasenames = computed<Set<string>>(() => {
  const counts = new Map<string, number>()
  for (const w of [...filteredPinned.value, ...filteredRecent.value]) {
    const b = dirNameOf(w.cwd)
    counts.set(b, (counts.get(b) ?? 0) + 1)
  }
  return new Set([...counts.entries()].filter(([, n]) => n >= DUP_THRESHOLD).map(([b]) => b))
})

/** 列表项显示文案：默认 basename，同名时追加 (parent) 消歧 */
function displayLabel(ws: RecentWorkspaceRecord): string {
  const base = dirNameOf(ws.cwd)
  if (!dupBasenames.value.has(base)) return base
  const parent = parentDirNameOf(ws.cwd)
  return parent ? `${base}(${parent})` : base
}

onMounted(() => {
  // 打开即 focus 搜索框（spec §3.2 键盘契约）
  nextTick(() => root.value?.querySelector('input')?.focus())
})

function selectWorkspace(ws: RecentWorkspaceRecord): void {
  emit('select', { cwd: ws.cwd })
}

function selectDefaultSession(): void {
  emit('select-default')
}

function openFolder(): void {
  emit('open-dir-dialog')
}

/**
 * pin/unpin（组件内闭环，不涉及 flow）：调 deps.setPinned（壳适配 store，内部已热更新
 * records）。超上限被拒（false）→ toast 提示上限（用户裁决 2026-10-22：上限 5 个）。
 */
async function onTogglePin(ws: RecentWorkspaceRecord): Promise<void> {
  const next = !ws.pinned
  if (next && pinnedCount.value >= PIN_LIMIT) {
    toast.error(t('newTask.dirSelect.pinLimitReached', { count: PIN_LIMIT }))
    return
  }
  const applied = await setPinned(ws.cwd, next)
  if (!applied) {
    toast.error(t('newTask.dirSelect.pinLimitReached', { count: PIN_LIMIT }))
  }
}

/**
 * 扁平化激活：列表项区间 → selectWorkspace，尾部动作项（默认会话 / open-dir）→ 对应动作。
 */
function activate(idx: number): void {
  if (idx < pinnedLen.value) {
    selectWorkspace(filteredPinned.value[idx])
    return
  }
  if (idx < defaultSessionIdx.value) {
    selectWorkspace(filteredRecent.value[idx - pinnedLen.value])
    return
  }
  if (defaultSessionDir.value && idx === defaultSessionIdx.value) {
    selectDefaultSession()
    return
  }
  openFolder()
}

// 键盘导航收敛到 composables/useFlatListNav（与 BranchSelectPopover 共用）。
const { activeIndex, onKeydown, isActiveItem } = useFlatListNav({
  getTotal: () => pinnedLen.value + recentLen.value + actionCount.value,
  onActivate: activate,
  onEscape: () => emit('close'),
})
</script>

<template>
  <div
    ref="root"
    data-testid="dir-select-popover"
    class="w-[320px] max-h-[420px] overflow-hidden"
    @keydown="onKeydown"
  >
    <!-- 搜索 input（sticky 顶部，spec §3.2；凹陷底 = demo 弹窗输入语言 --bg-input） -->
    <div class="border-b border-hairline p-2">
      <Input
        v-model="search"
        :placeholder="t('newTask.dirSelect.searchPlaceholder')"
        class="h-8 bg-bg-input text-[length:var(--text-sm)]"
      />
    </div>

    <div class="max-h-[360px] overflow-y-auto py-1">
      <!-- 空态（T3.2 / AC-5.4，spec §6 三要素：subtle 图标 + 说明 + Primary 入口在下方动作项） -->
      <div
        v-if="isEmpty"
        data-testid="empty-state"
        class="flex flex-col items-center gap-2 px-4 py-6 text-center"
      >
        <Folder class="size-5 text-neutral-dim" />
        <p class="text-[length:var(--text-xs)] text-neutral-mid">{{ t('newTask.dirSelect.noRecent') }}</p>
      </div>

      <!-- 列表项统一渲染（已固定区置顶 + 「已固定」组头 + 区间分隔线 + 每行右侧悬停 pin/unpin）。
           allFiltered 索引 = 键盘导航扁平索引（pinned → recent），行结构与 pin 按钮两区一致。 -->
      <template v-for="(ws, i) in allFiltered" :key="ws.cwd">
        <!-- 已固定组头（首行） -->
        <div
          v-if="i === 0 && filteredPinned.length > 0"
          class="px-2.5 pt-1 pb-0.5 font-mono text-[length:var(--text-3xs)] tracking-[0.08em] uppercase text-neutral-dim"
        >
          {{ t('newTask.dirSelect.pinnedGroup') }}
        </div>
        <!-- 区间分隔线（demo pop-sep 语言：hairline 弱分隔 + 6px 水平缩进） -->
        <div
          v-if="i === pinnedLen && filteredPinned.length > 0 && filteredRecent.length > 0"
          class="mx-1.5 my-1 border-t border-hairline"
        />
        <div class="group relative">
          <PopoverListItem
            test-id="workspace-item"
            :active="isActiveItem(i)"
            :selected="ws.cwd === props.currentCwd"
            @click="selectWorkspace(ws)"
            @mouseenter="activeIndex = i"
          >
            <template #icon>
              <Folder class="shrink-0 text-neutral-dim" />
            </template>
            <span class="flex min-w-0 flex-1 flex-col items-start">
              <span class="truncate text-neutral-fg">{{ displayLabel(ws) }}</span>
            </span>
          </PopoverListItem>
          <!-- 悬停 pin/unpin（绝对定位覆盖行尾，不入 Button 内层——HTML 禁 button 嵌套；
               键盘焦点行同显 group-focus-within）。点击 stop 防触发行选择。 -->
          <button
            type="button"
            :data-testid="`workspace-pin-${ws.pinned ? 'off' : 'on'}`"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-1 text-neutral-dim opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-surface-hover hover:text-neutral-fg"
            :aria-label="ws.pinned ? t('newTask.dirSelect.unpin') : t('newTask.dirSelect.pin')"
            :title="ws.pinned ? t('newTask.dirSelect.unpin') : t('newTask.dirSelect.pin')"
            @click.stop="onTogglePin(ws)"
          >
            <Pin v-if="ws.pinned" class="size-3.5" />
            <PinOff v-else class="size-3.5" />
          </button>
        </div>
      </template>

      <!-- 分隔线（demo pop-sep 语言：hairline 弱分隔 + 6px 水平缩进） -->
      <div class="mx-1.5 my-1 border-t border-hairline" />

      <!-- 动作项：默认会话（固定入口，恒显不参与搜索过滤；runtime 目录未就绪/失败时隐藏）。
           点击 = 选定该目录且不计入最近工作区（record:false，父组件接线）。 -->
      <PopoverActionItem
        v-if="defaultSessionDir"
        test-id="action-default-session"
        :active="isActiveItem(defaultSessionIdx)"
        @click="selectDefaultSession"
        @mouseenter="activeIndex = defaultSessionIdx"
      >
        <template #icon>
          <House class="shrink-0 text-neutral-dim" />
        </template>
        {{ t('newTask.dirSelect.defaultSession') }}
      </PopoverActionItem>

      <!-- 动作项：打开文件夹（空态时即 Primary 入口，spec §6） -->
      <PopoverActionItem
        test-id="action-open-dir"
        :active="isActiveItem(openDirIdx)"
        @click="openFolder"
        @mouseenter="activeIndex = openDirIdx"
      >
        <template #icon>
          <FolderPlus class="shrink-0 text-neutral-dim" />
        </template>
        {{ t('newTask.dirSelect.openFolder') }}
      </PopoverActionItem>
    </div>
  </div>
</template>
