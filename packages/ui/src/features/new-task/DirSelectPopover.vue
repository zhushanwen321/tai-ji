<script setup lang="ts">
/**
 * DirSelectPopover.vue —— 步骤2 选目录 popover（spec §3.2 IA 重构后）。
 *
 * [w4 迁移] 自 renderer components/new-task/DirSelectPopover.vue（192 行）迁入 ui 包
 * features/new-task/（C-NT-4 跨端共享组件）。变化：workspaceStore.records → deps.recentWorkspaces
 * （NewTaskDeps inject，C-W4-1）；ui 原语走包内相对导入（不经顶层 barrel，防自引用环）；
 * useFlatListNav/path 本地化（C-W4-3）。props/emits/模板逐字迁移（CT-4，不做功能改动）。
 *
 * 纯文件系统导航：最近工作区 + 打开文件夹。
 * Worktree 相关内容（已有 worktree 列表 / 新建 worktree / 远程连接）已迁至 BranchSelectPopover 的
 * Worktree tab，本组件只保留目录选择职责。
 *
 * 形态：popover 内容面板（宽度 320px；向上展开由父级 PopoverContent side="top" 控制）。
 *
 * 数据流（container for data）：deps.recentWorkspaces → RecentWorkspaceRecord[] top6。
 * 动作（presentational for actions，emit 单 payload 对象）：
 * - 选列表项 → emit('select', { cwd })（父接 flow.selectWorkspace）
 * - 「打开文件夹」→ emit('open-dir-dialog')（父接 flow.openDirDialog → OS 原生 dialog）
 * - Esc → emit('close')
 *
 * 空态（T3.2 / AC-5.4）：records=[] → 「暂无最近工作区 · 选择一个本地目录开始」。
 */
import { ref, computed, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Folder, FolderPlus } from '@lucide/vue'
// ui 原语走包内相对导入（不经 @taiji/ui 顶层 barrel）：new-task 组件经顶层 barrel
// 再导出，顶层 barrel 自引用会闭合循环依赖环（R2 S-1）
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
  (e: 'open-dir-dialog'): void
  (e: 'close'): void
}>()

const { t } = useI18n()
const { recentWorkspaces } = useNewTaskDeps()

const search = ref('')
const root = ref<HTMLElement | null>(null)

/** W1（MAX_RECORDS 10→6）：popover 列表展示上限，与 runtime RecentWorkspacesStore.MAX_RECORDS 对齐
 *  双保险：即便 runtime 返超量也只显 6 项 */
const MAX_DISPLAY = 6

/** 尾部动作项数（只剩「打开文件夹」一项） */
const ACTION_ITEM_COUNT = 1

/** W3: 改接 deps.recentWorkspaces（取代旧 workspaceStore.records 直连） */
const workspaces = computed<RecentWorkspaceRecord[]>(() => recentWorkspaces.value)

/** 搜索即时过滤（无 debounce，list < 50 本地缓存，spec §3.2） */
const filtered = computed<RecentWorkspaceRecord[]>(() => {
  const q = search.value.trim().toLowerCase()
  // W1（MAX_RECORDS 10→6）：双保险，即便 runtime 返超量也只显 6 项
  if (!q) return workspaces.value.slice(0, MAX_DISPLAY)
  // label 已是 cwd basename，是其全路径 cwd 的子串，单独按 cwd 匹配即可覆盖两者
  return workspaces.value.filter((w) => w.cwd.toLowerCase().includes(q)).slice(0, MAX_DISPLAY)
})

/** 空态：无最近工作区，或搜索无命中 */
const isEmpty = computed(() => filtered.value.length === 0)

/** 扁平化索引基准：recent 列表 + 动作项。DOM 顺序：recent items → open-dir */
const openDirIdx = computed(() => filtered.value.length)

/** basename 出现该次数即视为同名，需追加上级段名消歧 */
const DUP_THRESHOLD = 2

/**
 * 当前可见列表内重复 ≥ DUP_THRESHOLD 次的 basename 集合——这些目录需追加上级段名消歧
 * （如 /Code/chat_project 与 /Stock/chat_project → 都显 chat_project(Code)/chat_project(Stock)）。
 * 以 filtered（搜索后实际展示的列表）为统计范围，让搜索缩小范围后也能正确消歧。
 */
const dupBasenames = computed<Set<string>>(() => {
  const counts = new Map<string, number>()
  for (const w of filtered.value) {
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

function openFolder(): void {
  emit('open-dir-dialog')
}

/**
 * 扁平化激活：列表项区间 → selectWorkspace，尾部动作项（idx === listLen）→ openFolder()。
 */
function activate(idx: number): void {
  const listLen = filtered.value.length
  if (idx < listLen) {
    selectWorkspace(filtered.value[idx])
    return
  }
  // 动作项：仅 open-dir 一项
  openFolder()
}

// 键盘导航收敛到 composables/useFlatListNav（与 BranchSelectPopover 共用）。
const { activeIndex, onKeydown, isActiveItem } = useFlatListNav({
  getTotal: () => filtered.value.length + ACTION_ITEM_COUNT,
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
    <!-- 搜索 input（sticky 顶部，spec §3.2） -->
    <div class="border-b border-border p-2">
      <Input
        v-model="search"
        :placeholder="t('newTask.dirSelect.searchPlaceholder')"
        class="h-8 bg-surface-2 text-[13px]"
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
        <p class="text-[12px] text-neutral-mid">{{ t('newTask.dirSelect.noRecent') }}</p>
      </div>

      <!-- 列表项（非空态）：默认只显目录名，同名时追加 (parent) 消歧 -->
      <PopoverListItem
        v-for="(ws, i) in filtered"
        :key="ws.cwd"
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

      <!-- 分隔线 -->
      <div class="my-1 h-px bg-border" />

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
