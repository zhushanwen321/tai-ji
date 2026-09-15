<script setup lang="ts">
/**
 * BranchSelectPopover.vue —— 步骤3 Git popover（分支/Worktree 双 tab，spec §3.3 IA 重构）。
 *
 * [w4 迁移] 自 renderer components/new-task/BranchSelectPopover.vue（364 行）迁入 ui 包
 * features/new-task/（C-NT-4）。变化：worktreeApi.listBranches → deps.listBranches
 * （NewTaskDeps inject，C-W4-1）；useToast().error → deps.toast.error（gitGraphStub）；
 * useFlatListNav 本地化（C-W4-3）；ui 原语走包内相对导入（不经顶层 barrel，防自引用环）。
 * props/emits/双 tab 模板逐字迁移（CT-4，不做功能改动）。
 *
 * 语义升级：从「选分支 popover」升级为「Git popover（分支/Worktree 双 tab）」。
 * Tab 栏在搜索框上方，分支 tab 承载原有全部分支逻辑，Worktree tab 承载 worktree 列表。
 * 文件名保留 BranchSelectPopover（语义升级，不重命名，避免大面积引用改动）。
 *
 * 形态：popover 内容面板（宽度 420px；向上展开由父级 PopoverContent side="top" 控制）。
 *
 * 数据流（container for data）：
 * - 分支列表：onMounted → deps.listBranches(cwd)（cwd 驱动，landing 态也可用）。
 *   旧实现用 gitApi.status(sessionId)，landing 态无 session → 恒空。现统一用 cwd-based RPC。
 * - 当前分支：currentBranch prop（父级从 gitInfo 派生，landing 态从 worktree HEAD 项派生）。
 * - unborn HEAD：local 分支为空 → 空态引导首次 commit
 * - listBranches 失败：reject → 显错不崩
 * - 分支 100+：渲染上限 + 搜索过滤
 *
 * IA（按模式裁剪 tab，非默认 tab 切换）：
 * - bare-workspace 模式：只渲染 Worktree tab（分支与 worktree 一一对应，切分支=切 worktree）。
 *   点 worktree = 切目录（selectWorkspace）；创建 = 建 worktree（建分支+建目录）。
 * - plain-repo 模式：只渲染分支 tab（N 分支共享 1 目录，切分支=git checkout）。
 *   底部同时提供「创建分支」+「创建 worktree」。
 * - 单 tab 时隐藏 tab bar（只有一个 tab 无需显示切换器）。
 *
 * 动作（presentational for actions，emit 单 payload 对象）：
 * 分支 tab：
 * - 选干净分支 → emit('select', { name })（父接 flow.selectBranch）
 * - 「创建并检出新分支」→ emit('open-branch-modal')（父接 flow.openBranchModal）
 * - 「Git 图谱」→ v1 stub toast（spec §6 / issues #12 P3 延后）
 * Worktree tab：
 * - 选 worktree → emit('select-worktree', { path })（父接 flow.selectWorktree）
 * - 「新建 worktree」→ emit('create-worktree')（父接 flow.createWorktree）
 * - Esc → emit('close')
 */
import { ref, computed, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { GitBranch, GitFork, Plus, GitGraph, TriangleAlert, Loader2 } from '@lucide/vue'
// ui 原语走包内相对导入（不经 @taiji/ui 顶层 barrel）：new-task 组件经顶层 barrel
// 再导出，顶层 barrel 自引用会闭合循环依赖环（R2 S-1）
import { Input } from '../../primitives/input'
import { PopoverActionItem, PopoverListItem } from '../../primitives/popover'
import { useNewTaskDeps } from './new-task-deps'
import { useFlatListNav } from './composables/useFlatListNav'

/** T4.9 / AC-6.9：分支极多时渲染上限，超出靠搜索过滤（v1 限制渲染数，不引入虚拟滚动库） */
const MAX_RENDER_BRANCHES = 50
/** 分支 tab 尾部动作项数（创建并检出新分支 + Git 图谱 + 创建 worktree） */
const BRANCH_ACTION_COUNT = 3
/** Worktree tab 尾部动作项数（新建 worktree） */
const WORKTREE_ACTION_COUNT = 1
/** spec §6：Git 图谱 v1 stub（issues #12 P3） */
// v1 暂未支持 Git 图谱（i18n key: newTask.branchSelect.gitNotSupported）

const props = withDefaults(
  defineProps<{
    /** cwd 所在 workspace 的 git 模式（决定渲染哪些 tab）。bare-workspace→只 Worktree tab；plain-repo→只分支 tab */
    mode: 'bare-workspace' | 'plain-repo'
    /** 当前 cwd（拉取分支列表用，cwd 驱动） */
    cwd: string
    /** 当前分支名（父级从 gitInfo 派生；landing 态从 worktree HEAD 项派生，已建 session 从 gitInfo.branch 派生） */
    currentBranch?: string | null
    /** 当前 cwd 所在 workspace 的已有 worktree 列表（Worktree tab 数据源） */
    worktreeItems?: Array<{ path: string; branch: string; HEAD: boolean; bare: boolean }>
  }>(),
  { currentBranch: null, worktreeItems: () => [] },
)

const emit = defineEmits<{
  (e: 'select', payload: { name: string }): void
  (e: 'open-branch-modal'): void
  (e: 'select-worktree', payload: { path: string }): void
  (e: 'create-worktree'): void
  (e: 'close'): void
}>()

const { t } = useI18n()
const { listBranches, toast } = useNewTaskDeps()

const statusError = ref<unknown>(null)
const search = ref('')
const root = ref<HTMLElement | null>(null)
const branchesLoading = ref(true)
onMounted(async () => {
  // 打开即 focus 搜索框（spec §3.3 键盘契约）
  nextTick(() => root.value?.querySelector('input')?.focus())
  // plain-repo 模式才拉分支列表（bare 模式不显示分支 tab）
  if (props.mode !== 'plain-repo') { branchesLoading.value = false; return }
  try {
    const reply = await listBranches(props.cwd)
    branches.value = reply.local
  } catch (e) {
    // 显错不崩
    statusError.value = e
  } finally { branchesLoading.value = false }
})

const branches = ref<string[]>([])
const allBranches = computed<string[]>(() => branches.value)
const currentBranch = computed<string | undefined>(
  () => props.currentBranch ?? undefined,
)

/** unborn HEAD：是 git 仓库但无任何分支（无首次提交） */
const isUnborn = computed(() => allBranches.value.length === 0)

/** 搜索过滤 + 渲染上限（T4.9） */
const filtered = computed<string[]>(() => {
  const q = search.value.trim().toLowerCase()
  const list = q
    ? allBranches.value.filter((b) => b.toLowerCase().includes(q))
    : allBranches.value
  return list.slice(0, MAX_RENDER_BRANCHES)
})

function selectBranch(name: string): void {
  if (name === currentBranch.value) {
    emit('close') // 已在当前分支，仅关 popover
    return
  }
  emit('select', { name })
}

function openBranchModal(): void {
  emit('open-branch-modal')
}

function gitGraphStub(): void {
  toast.error(t('newTask.branchSelect.gitNotSupported'))
}

function selectWorktree(path: string): void {
  emit('select-worktree', { path })
}

/** 取路径的末尾目录名作为 worktree 显示名（用户只关心目录名，完整路径太长）。 */
function worktreeName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const slashIdx = trimmed.lastIndexOf('/')
  return slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed
}

function createWorktree(): void {
  emit('create-worktree')
}

/**
 * 扁平化激活（按 mode 路由）：
 * - bare-workspace：idx < wtLen → selectWorktree；idx === wtLen → createWorktree
 * - plain-repo：idx < branchesLen → selectBranch；尾部（创建分支 / Git 图谱 / 创建 worktree）
 */
function activate(idx: number): void {
  if (props.mode === 'bare-workspace') {
    const wtLen = props.worktreeItems.length
    if (idx < wtLen) selectWorktree(props.worktreeItems[idx].path)
    else if (idx === wtLen) createWorktree()
    return
  }
  const listLen = filtered.value.length
  // 分支 panel 尾部动作项偏移（0=创建分支, 1=Git 图谱, 2=创建 worktree）
  const OFFSET_CREATE_BRANCH = 0
  const OFFSET_GIT_GRAPH = 1
  const OFFSET_CREATE_WORKTREE = 2
  if (idx < listLen) selectBranch(filtered.value[idx])
  else if (idx === listLen + OFFSET_CREATE_BRANCH) openBranchModal()
  else if (idx === listLen + OFFSET_GIT_GRAPH) gitGraphStub()
  else if (idx === listLen + OFFSET_CREATE_WORKTREE) createWorktree()
}

// 键盘导航收敛到 composables/useFlatListNav（与 DirSelectPopover 共用）。
const { activeIndex, onKeydown, isActiveItem } = useFlatListNav({
  getTotal: () =>
    props.mode === 'bare-workspace'
      ? props.worktreeItems.length + WORKTREE_ACTION_COUNT
      : filtered.value.length + BRANCH_ACTION_COUNT,
  onActivate: activate,
  onEscape: () => emit('close'),
})

// 模式不变（单 panel），无需 watch activeTab 重置 activeIndex
</script>

<template>
  <div
    ref="root"
    data-testid="branch-select-popover"
    class="w-[420px] overflow-hidden"
    @keydown="onKeydown"
  >
    <!-- Tab 栏隐藏：按模式裁剪后每模式只有一个 panel（bare→worktree，plain→branch），无需 tab 切换器 -->

    <!-- ───── 分支 panel（plain-repo 模式独占）───── -->
    <div v-if="mode === 'plain-repo'">
      <!-- 顶部标题栏（模式标注） -->
      <div class="flex items-center justify-between border-b border-border px-3 py-2">
        <span class="text-[12px] font-medium text-neutral-fg">{{ t('newTask.branchSelect.titlePlainRepo') }}</span>
        <span class="rounded-md bg-surface-hover px-1.5 py-0.5 text-[10px] font-semibold text-neutral-dim">{{ allBranches.length }}</span>
      </div>
      <!-- 搜索 input -->
      <div class="border-b border-border p-2">
        <Input
          v-model="search"
          :placeholder="t('newTask.branchSelect.searchPlaceholder')"
          class="h-8 bg-surface-2 text-[13px]"
        />
      </div>

      <!-- getStatus 失败（T4.6） -->
      <div
        v-if="statusError"
        data-testid="status-error"
        class="flex items-center gap-2 px-3 py-4 text-[12px] text-danger"
      >
        <TriangleAlert class="size-4 shrink-0" />
        <span>{{ t('newTask.branchSelect.loadFailed') }}</span>
      </div>

      <!-- 加载中 → 不显示空态（防闪） -->
      <div
        v-else-if="branchesLoading"
        data-testid="branches-loading"
        class="flex items-center justify-center px-4 py-6"
      >
        <Loader2 class="size-4 animate-spin text-neutral-dim" />
      </div>

      <!-- unborn HEAD 空态（T4.3） -->
      <div
        v-else-if="isUnborn"
        data-testid="empty-state"
        class="flex flex-col items-center gap-2 px-4 py-6 text-center"
      >
        <GitBranch class="size-5 text-neutral-dim" />
        <p class="text-[12px] text-neutral-mid">{{ t('newTask.branchSelect.noBranch') }}</p>
      </div>

      <!-- 分支列表（最多 6 项可见，超出滚动） -->
      <div
        v-else
        class="max-h-[228px] overflow-y-auto py-1"
      >
        <PopoverListItem
          v-for="(name, i) in filtered"
          :key="name"
          test-id="branch-item"
          :active="isActiveItem(i)"
          :selected="name === currentBranch"
          @click="selectBranch(name)"
          @mouseenter="activeIndex = i"
        >
          <template #icon>
            <GitBranch class="shrink-0 text-neutral-dim" />
          </template>
          <span class="truncate font-mono text-neutral-fg">{{ name }}</span>
        </PopoverListItem>
      </div>
      <!-- 列表滚动区结束；动作项不滚动，固定底部 -->

      <div class="my-1 h-px bg-border" />

      <!-- 动作项：创建并检出新分支 -->
        <PopoverActionItem
          test-id="action-create-branch"
          :active="isActiveItem(filtered.length)"
          @click="openBranchModal"
          @mouseenter="activeIndex = filtered.length"
        >
          <template #icon>
            <Plus class="shrink-0 text-neutral-dim" />
          </template>
          {{ t('newTask.branchSelect.createAndCheckout') }}
        </PopoverActionItem>

        <!-- 动作项：Git 图谱（v1 stub） -->
        <PopoverActionItem
          test-id="action-git-graph"
          :active="isActiveItem(filtered.length + 1)"
          @click="gitGraphStub"
          @mouseenter="activeIndex = filtered.length + 1"
        >
          <template #icon>
            <GitGraph class="shrink-0 text-neutral-dim" />
          </template>
          {{ t('newTask.branchSelect.gitGraph') }}
        </PopoverActionItem>

        <!-- 动作项：创建 worktree（plain-repo 下与创建分支并列，隔离开发场景） -->
        <PopoverActionItem
          test-id="action-create-worktree"
          :active="isActiveItem(filtered.length + 2)"
          @click="createWorktree"
          @mouseenter="activeIndex = filtered.length + 2"
        >
          <template #icon>
            <GitFork class="shrink-0 text-neutral-dim" />
          </template>
          {{ t('newTask.dirSelect.createWorktree') }}
        </PopoverActionItem>


    </div>

    <!-- ───── Worktree panel（bare-workspace 模式独占）───── -->
    <div v-if="mode === 'bare-workspace'">
      <!-- 顶部标题栏（模式标注） -->
      <div class="flex items-center justify-between border-b border-border px-3 py-2">
        <span class="text-[12px] font-medium text-neutral-fg">{{ t('newTask.branchSelect.titleBareWorkspace') }}</span>
        <span class="rounded-md bg-surface-hover px-1.5 py-0.5 text-[10px] font-semibold text-neutral-dim">{{ props.worktreeItems.length }}</span>
      </div>
      <!-- 空态：无 worktree（新建 worktree 动作仍 accent 强调在底部） -->
      <div
        v-if="props.worktreeItems.length === 0"
        data-testid="wt-empty-state"
        class="flex flex-col items-center gap-2 px-4 py-6 text-center"
      >
        <GitFork class="size-5 text-neutral-dim" />
        <p class="text-[12px] text-neutral-mid">{{ t('newTask.dirSelect.noWorktrees') }}</p>
      </div>

      <!-- worktree 列表（最多 6 项可见，超出滚动；仅显目录名，不显完整路径） -->
      <div
        v-else
        class="max-h-[228px] overflow-y-auto py-1"
      >
        <PopoverListItem
          v-for="(wt, wi) in props.worktreeItems"
          :key="wt.path"
          test-id="worktree-item"
          :active="isActiveItem(wi)"
          :selected="wt.HEAD"
          @click="selectWorktree(wt.path)"
          @mouseenter="activeIndex = wi"
        >
          <template #icon>
            <GitFork class="shrink-0 text-neutral-dim" />
          </template>
          <span class="flex min-w-0 flex-1 items-center gap-1.5 truncate text-neutral-fg">
            <span class="truncate">{{ worktreeName(wt.path) }}</span>
            <span
              v-if="wt.HEAD"
              class="rounded bg-accent-soft px-1 py-px font-mono text-[10px] font-semibold text-accent"
            >HEAD</span>
          </span>
        </PopoverListItem>
      </div>

      <div class="my-1 h-px bg-border" />

      <!-- 动作项：新建 worktree（accent 强调，git repo 推荐入口） -->
      <PopoverActionItem
        test-id="action-create-worktree"
        class="bg-accent-soft"
        :active="isActiveItem(props.worktreeItems.length)"
        @click="createWorktree"
        @mouseenter="activeIndex = props.worktreeItems.length"
      >
        <template #icon>
          <GitFork class="shrink-0 text-accent" />
        </template>
        {{ t('newTask.dirSelect.createWorktree') }}
      </PopoverActionItem>
    </div>
  </div>
</template>
