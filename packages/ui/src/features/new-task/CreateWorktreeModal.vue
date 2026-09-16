<script setup lang="ts">
/**
 * CreateWorktreeModal.vue —— 创建 worktree modal（T5 升级版）。
 *
 * [w4 迁移] 自 renderer components/new-task/CreateWorktreeModal.vue（379 行）迁入 ui 包
 * features/new-task/（C-NT-4）。变化：flow.currentCwd/gitInfo → deps.flow（C-W4-2）；
 * worktreeApi.listBranches/create → deps.listBranches/deps.createWorktree；detectWorkspace →
 * deps.detectWorkspace；pickDirectory → deps.pickDirectory（D8 IPC 收编）；ui 原语走
 * @taiji/ui barrel；INVALID_BRANCH_REGEX/WorktreeErrorCode 走 @taiji/shared。
 * 五态状态机/emit 契约（close/success/use-existing）逐字迁移（CT-4，不做功能改动）。
 *
 * 五态状态机（内部自管）：form → progress → success / error / exists
 * T5：Git 仓库选择器 + base branch 可搜索 combobox + 创建位置 radio + workspaceHint/locationMode 透传。
 * form 态用 <form @submit.prevent> 包裹（对齐 CreateBranchModal）：分支名输入框按 Enter
 * 原生触发创建（base 搜索框经 PopoverPortal teleport 在 form DOM 外，Enter 不会误触提交）。
 */
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, Check, AlertTriangle, ChevronDown, ChevronRight, GitBranch, Folder, FolderOpen } from '@lucide/vue'
// ui 原语走包内相对导入（不经 @taiji/ui 顶层 barrel）：new-task 组件经顶层 barrel
// 再导出，顶层 barrel 自引用会闭合循环依赖环（R2 S-1）
import { Button } from '../../primitives/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../primitives/dialog'
import { Input } from '../../primitives/input'
import { Label } from '../../primitives/label'
import { Popover, PopoverTrigger, PopoverContent } from '../../primitives/popover'
import { useNewTaskDeps } from './new-task-deps'
import type { WorktreeErrorCode } from '@taiji/shared'
import { INVALID_BRANCH_REGEX } from '@taiji/shared'

interface WorktreeError { code?: WorktreeErrorCode; message?: string; cwd?: string; exitCode?: number; stderr?: string }
type ModalPhase = 'form' | 'progress' | 'success' | 'error' | 'exists'
type RepoMode = 'bare-workspace' | 'plain-repo' | 'not-repo'
type LocationMode = 'workspace' | 'repo-dir' | 'dedicated-dir'
interface BranchItem { name: string; group: 'quick' | 'remote' | 'local' }

const SUCCESS_EMIT_DELAY_MS = 2000

const props = defineProps<{ initialBranch?: string }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'success', payload: { cwd: string }): void
  (e: 'use-existing', payload: { cwd: string }): void
}>()

const { t } = useI18n()
const { flow, listBranches, createWorktree, detectWorkspace, pickDirectory } = useNewTaskDeps()

// ── 仓库检测 ──
const repoMode = ref<RepoMode>('not-repo')
const repoPath = ref('')
const repoDetectLoading = ref(true)
const defaultBranch = ref('main')
const remoteBranches = ref<string[]>([])
const localBranches = ref<string[]>([])
const branchesLoading = ref(true)

// ── form ──
const branchName = ref(props.initialBranch ?? '')
const baseBranch = ref('')
const basePopoverOpen = ref(false)
const baseSearch = ref('')
const inputRef = ref<InstanceType<typeof Input> | null>(null)
const locationMode = ref<LocationMode>('workspace')

// ── 状态机 ──
const phase = ref<ModalPhase>('form')
const lastError = ref<WorktreeError | null>(null)
const logExpanded = ref(false)
const successTimer = ref<ReturnType<typeof setTimeout> | null>(null)
const cancelled = ref(false)

const pendingCwd = computed(() => flow.currentCwd.value)
const currentBranch = computed(() => flow.gitInfo.value?.branch ?? 'main')
const trimmedName = computed(() => branchName.value.trim())
const isBranchValid = computed(() => { const n = trimmedName.value; return n.length > 0 && !INVALID_BRANCH_REGEX.test(n) })
const showFormatError = computed(() => branchName.value.length > 0 && !isBranchValid.value)
const canSubmit = computed(() => phase.value === 'form' && isBranchValid.value && baseBranch.value.length > 0)
const dirPreview = computed(() => { const n = trimmedName.value; return n ? n.replace(/\//g, '-') : '' })
const isBareMode = computed(() => repoMode.value === 'bare-workspace')
const isPlainRepoMode = computed(() => repoMode.value === 'plain-repo')
const isNotRepoMode = computed(() => repoMode.value === 'not-repo')
const dedicatedDirPreview = computed(() => `~/worktrees/${dirPreview.value || '...'}`)

const allBranchItems = computed<BranchItem[]>(() => {
  const items: BranchItem[] = [{ name: currentBranch.value, group: 'quick' }]
  for (const b of remoteBranches.value) items.push({ name: b, group: 'remote' })
  for (const b of localBranches.value) { if (b !== currentBranch.value) items.push({ name: b, group: 'local' }) }
  return items
})
const filteredBranchItems = computed(() => {
  const q = baseSearch.value.trim().toLowerCase()
  return q ? allBranchItems.value.filter((i) => i.name.toLowerCase().includes(q)) : allBranchItems.value
})
const baseDisplayLabel = computed(() => baseBranch.value || t('newTask.createWorktree.baseSearchPlaceholder'))
const progressSteps = computed(() => [
  { testid: 'worktree-step-0', label: t('newTask.createWorktree.stepCreateBranch') },
  { testid: 'worktree-step-1', label: t('newTask.createWorktree.stepCheckoutDir') },
  { testid: 'worktree-step-2', label: t('newTask.createWorktree.stepRunSetup') },
])

/** 按分组过滤（模板 v-for 用） */
function groupItems(group: BranchItem['group']): BranchItem[] {
  return filteredBranchItems.value.filter((i) => i.group === group)
}

// ── 仓库检测 + 分支加载 ──
onMounted(async () => {
  nextTick(() => { const el = inputRef.value?.$el as HTMLInputElement | undefined; el?.focus() })
  const cwd = pendingCwd.value
  if (!cwd) { repoDetectLoading.value = false; branchesLoading.value = false; return }
  try {
    const result = await detectWorkspace(cwd)
    if (cancelled.value) return
    repoMode.value = result.mode
    repoPath.value = result.mode === 'bare-workspace' ? result.wsRoot : result.repoRoot
    defaultBranch.value = result.defaultBranch || 'main'
    baseBranch.value = `origin/${defaultBranch.value}`
    locationMode.value = result.mode === 'bare-workspace' ? 'workspace' : 'dedicated-dir'
  } catch {
    repoMode.value = 'not-repo'
  } finally { repoDetectLoading.value = false }
  const repoCwd = repoPath.value || cwd
  if (repoMode.value !== 'not-repo') {
    try {
      const branches = await listBranches(repoCwd)
      if (cancelled.value) return
      remoteBranches.value = branches.remote
      localBranches.value = branches.local
      if (branches.defaultBranch) { defaultBranch.value = branches.defaultBranch; baseBranch.value = `origin/${branches.defaultBranch}` }
    } catch (e) {
      // best-effort: 分支加载失败不阻断，用 workspace.detect 的 defaultBranch 兜底
      console.warn('[CreateWorktreeModal] listBranches failed, falling back to workspace.detect defaultBranch:', e)
    } finally { branchesLoading.value = false }
  } else { branchesLoading.value = false }
})

// ── Dialog ──
function onOpenChange(v: boolean): void { if (v || phase.value === 'progress') return; emit('close') }

// ── base combobox ──
function selectBaseBranch(name: string): void { baseBranch.value = name; basePopoverOpen.value = false; baseSearch.value = '' }
function onBasePopoverOpenChange(open: boolean): void {
  basePopoverOpen.value = open
  if (open) nextTick(() => { (document.querySelector('[data-testid="worktree-base-search"]') as HTMLInputElement)?.focus() })
}

// ── 创建位置 ──
function selectLocation(mode: LocationMode): void { locationMode.value = mode }

// ── 仓库更换（plain-repo） ──
async function onChangeRepo(): Promise<void> {
  try {
    const result = await pickDirectory({ defaultPath: pendingCwd.value ?? undefined })
    if (result.canceled || !result.path) return
    const detectResult = await detectWorkspace(result.path)
    if (cancelled.value) return
    repoMode.value = detectResult.mode
    repoPath.value = detectResult.mode === 'bare-workspace' ? detectResult.wsRoot : detectResult.repoRoot
    defaultBranch.value = detectResult.defaultBranch || 'main'
    baseBranch.value = `origin/${defaultBranch.value}`
    if (cancelled.value) return
    branchesLoading.value = true
    try {
      const branches = await listBranches(repoPath.value || result.path)
      if (cancelled.value) return
      remoteBranches.value = branches.remote; localBranches.value = branches.local
      if (branches.defaultBranch) { defaultBranch.value = branches.defaultBranch; baseBranch.value = `origin/${branches.defaultBranch}` }
    } catch (e) {
      // best-effort: 分支加载失败不阻断
      console.warn('[CreateWorktreeModal] listBranches failed after repo change:', e)
    } finally { branchesLoading.value = false }
  } catch (e) {
    // best-effort: pickDirectory 失败静默降级，用户可重试
    console.warn('[CreateWorktreeModal] onChangeRepo failed:', e)
  }
}

// ── 提交创建 ──
async function submitCreate(): Promise<void> { if (canSubmit.value) await runCreate(trimmedName.value, baseBranch.value) }
async function runCreate(branch: string, base: string): Promise<void> {
  phase.value = 'progress'; lastError.value = null; logExpanded.value = false
  try {
    const result = await createWorktree({ branch, baseBranch: base, locationMode: locationMode.value, workspaceHint: repoPath.value || pendingCwd.value || undefined })
    if (cancelled.value) return
    // 创建成功 ⇒ chip 切换同刻发生：success 事件立即 emit（不挂定时器），父层据此回灌
    // pendingCwd。2s 成功屏只承担展示 + 延迟关闭（scheduleCloseEmit）——窗口内用户关 modal
    // （Esc/点外/X/切 session）最多丢「延迟关闭」，不会丢切换。
    // [HISTORICAL] 旧链路 success emit 挂在 2s 定时器上且卸载即取消，窗口内关 modal
    // → 切换静默丢失（chip 留旧目录，首发 create 也落旧目录）。
    phase.value = 'success'
    emit('success', { cwd: result.cwd })
    scheduleCloseEmit()
  } catch (e) {
    if (cancelled.value) return
    const err = (e as WorktreeError) ?? {}; lastError.value = err
    phase.value = err.code === 'WORKTREE_EXISTS' ? 'exists' : 'error'
  }
}
/** 成功屏展示窗后仅负责关闭（切换已在 success 事件同步完成）。 */
function scheduleCloseEmit(): void { clearSuccessTimer(); successTimer.value = setTimeout(() => emit('close'), SUCCESS_EMIT_DELAY_MS) }
function clearSuccessTimer(): void { if (successTimer.value != null) { clearTimeout(successTimer.value); successTimer.value = null } }
async function onRetry(): Promise<void> { await runCreate(trimmedName.value, baseBranch.value) }
function onCleanup(): void { emit('close') }
function onUseExisting(): void { const cwd = lastError.value?.cwd; if (cwd) emit('use-existing', { cwd }) }
function onCancel(): void { emit('close') }
onBeforeUnmount(() => { cancelled.value = true; clearSuccessTimer() })
</script>

<template>
  <Dialog :open="true" @update:open="onOpenChange">
    <DialogContent data-testid="create-worktree-modal" class="sm:max-w-[560px]" :hide-close="phase === 'progress'">
      <DialogHeader>
        <DialogTitle>{{ t('newTask.createWorktree.title') }}</DialogTitle>
        <DialogDescription>{{ t('newTask.createWorktree.desc') }}</DialogDescription>
      </DialogHeader>

      <!-- ── form 态（<form> 包裹：Enter 提交走原生隐式提交链路） ── -->
      <form v-if="phase === 'form'" class="mt-2 space-y-4" @submit.prevent="submitCreate">
        <!-- Git 仓库选择器 -->
        <div class="space-y-1.5">
          <Label>{{ t('newTask.createWorktree.repoLabel') }}</Label>
          <div v-if="repoDetectLoading" data-testid="repo-loading" class="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
            <Loader2 class="size-4 animate-spin text-neutral-dim" /><span class="text-[13px] text-neutral-dim">...</span>
          </div>
          <div v-else-if="isBareMode" data-testid="repo-bare" class="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
            <Folder class="size-4 shrink-0 text-neutral-dim" />
            <span class="flex-1 truncate font-mono text-[13px] text-neutral-fg">{{ repoPath }}</span>
            <span data-testid="repo-bare-badge" class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">{{ t('newTask.createWorktree.repoBareBadge') }}</span>
          </div>
          <div v-else-if="isPlainRepoMode" data-testid="repo-plain" class="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
            <FolderOpen class="size-4 shrink-0 text-neutral-dim" />
            <span class="flex-1 truncate font-mono text-[13px] text-neutral-fg">{{ repoPath }}</span>
            <Button type="button" variant="ghost" data-testid="repo-change-btn" class="h-auto shrink-0 px-2 py-0.5 text-[12px] text-accent hover:text-accent" @click="onChangeRepo">{{ t('newTask.createWorktree.repoChange') }}</Button>
          </div>
          <div v-else data-testid="repo-not-repo" class="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 opacity-60">
            <AlertTriangle class="size-4 shrink-0 text-warn" />
            <span class="text-[13px] text-neutral-mid">{{ t('newTask.createWorktree.repoNotRepo') }}</span>
          </div>
        </div>

        <!-- 分支名 -->
        <div class="space-y-1.5">
          <Label for="worktree-branch-input">{{ t('newTask.createWorktree.branchLabel') }}</Label>
          <Input id="worktree-branch-input" ref="inputRef" v-model="branchName" data-testid="worktree-branch-input" :placeholder="t('newTask.createWorktree.branchPlaceholder')" autocomplete="off" :class="showFormatError ? '!border-destructive' : ''" :disabled="isNotRepoMode" />
          <p v-if="showFormatError" data-testid="worktree-branch-error" class="text-[12px] text-danger">{{ t('newTask.createWorktree.branchValidation') }}</p>
        </div>

        <!-- 目录名预览 -->
        <div class="space-y-1">
          <p class="text-[12px] text-neutral-dim">{{ t('newTask.createWorktree.dirPreviewLabel') }}</p>
          <p data-testid="worktree-dir-preview" class="rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-[13px] text-neutral-fg">{{ dirPreview || '—' }}</p>
        </div>

        <!-- base 分支可搜索 combobox -->
        <div class="space-y-1">
          <p class="text-[12px] text-neutral-dim">{{ t('newTask.createWorktree.baseLabel') }}</p>
          <Popover :open="basePopoverOpen" @update:open="onBasePopoverOpenChange">
            <PopoverTrigger as-child>
              <Button type="button" variant="ghost" data-testid="worktree-base-trigger" class="h-auto w-full justify-between rounded-md border border-border bg-surface-2 px-3 py-2 text-left text-[13px] text-neutral-fg hover:bg-surface-hover" :disabled="isNotRepoMode || branchesLoading">
                <span class="flex items-center gap-2 truncate"><GitBranch class="size-3.5 shrink-0 text-neutral-dim" /><span class="truncate">{{ baseDisplayLabel }}</span></span>
                <ChevronDown class="size-3.5 shrink-0 text-neutral-dim" />
              </Button>
            </PopoverTrigger>
            <PopoverContent class="w-[var(--reka-popover-trigger-width)] p-0" align="start">
              <div class="border-b border-border p-2">
                <Input v-model="baseSearch" data-testid="worktree-base-search" :placeholder="t('newTask.createWorktree.baseSearchPlaceholder')" class="h-8 bg-surface-2 text-[13px]" />
              </div>
              <div class="max-h-60 overflow-y-auto py-1">
                <template v-for="(group, gIdx) in (['quick', 'remote', 'local'] as const)" :key="group">
                  <div v-if="groupItems(group).length > 0" :class="gIdx > 0 ? 'mt-1 border-t border-border' : ''" class="px-3 py-1 text-[11px] text-neutral-dim">
                    {{ group === 'quick' ? t('newTask.createWorktree.baseGroupQuick') : group === 'remote' ? t('newTask.createWorktree.baseGroupRemote') : t('newTask.createWorktree.baseGroupLocal') }}
                  </div>
                  <Button v-for="item in groupItems(group)" :key="`${group}-${item.name}`" type="button" variant="ghost" data-testid="worktree-base-item" :data-branch="item.name" class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-hover" :class="baseBranch === item.name ? 'bg-accent/10 text-accent' : 'text-neutral-fg'" @click="selectBaseBranch(item.name)">
                    <span class="flex-1 truncate font-mono">{{ item.name }}</span>
                    <Check v-if="baseBranch === item.name" class="size-3.5 shrink-0 text-accent" />
                  </Button>
                </template>
                <div v-if="filteredBranchItems.length === 0" class="px-3 py-4 text-center text-[12px] text-neutral-mid">—</div>
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <!-- 创建位置 radio（用 Button + aria-pressed 表达单选；不用原生 <input type="radio">） -->
        <div class="space-y-1">
          <p class="text-[12px] text-neutral-dim">{{ t('newTask.createWorktree.locationLabel') }}</p>
          <div v-if="isBareMode" class="space-y-1">
            <Button
              type="button"
              variant="ghost"
              data-testid="location-workspace"
              role="radio"
              :aria-checked="locationMode === 'workspace'"
              class="flex h-auto w-full cursor-pointer items-center justify-start gap-3 rounded-md border px-3 py-2 transition-colors hover:bg-transparent"
              :class="locationMode === 'workspace' ? 'border-accent bg-accent/5 text-neutral-fg hover:bg-accent/5' : 'border-border bg-surface-2 text-neutral-fg hover:bg-surface-2'"
              @click="selectLocation('workspace')"
            >
              <span class="size-3.5 shrink-0 rounded-full border" :class="locationMode === 'workspace' ? 'border-accent bg-accent' : 'border-border'" />
              <span class="text-[13px]">{{ t('newTask.createWorktree.locationWorkspace') }}</span>
            </Button>
          </div>
          <div v-else-if="isPlainRepoMode" class="space-y-1">
            <Button
              type="button"
              variant="ghost"
              data-testid="location-repo-dir"
              role="radio"
              :aria-checked="locationMode === 'repo-dir'"
              class="flex h-auto w-full cursor-pointer items-center justify-start gap-3 rounded-md border px-3 py-2 transition-colors hover:bg-transparent"
              :class="locationMode === 'repo-dir' ? 'border-accent bg-accent/5 text-neutral-fg hover:bg-accent/5' : 'border-border bg-surface-2 text-neutral-fg hover:bg-surface-2'"
              @click="selectLocation('repo-dir')"
            >
              <span class="size-3.5 shrink-0 rounded-full border" :class="locationMode === 'repo-dir' ? 'border-accent bg-accent' : 'border-border'" />
              <span class="text-[13px]">{{ t('newTask.createWorktree.locationRepoDir') }}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              data-testid="location-dedicated-dir"
              role="radio"
              :aria-checked="locationMode === 'dedicated-dir'"
              class="flex h-auto w-full cursor-pointer items-center justify-start gap-3 rounded-md border px-3 py-2 transition-colors hover:bg-transparent"
              :class="locationMode === 'dedicated-dir' ? 'border-accent bg-accent/5 text-neutral-fg hover:bg-accent/5' : 'border-border bg-surface-2 text-neutral-fg hover:bg-surface-2'"
              @click="selectLocation('dedicated-dir')"
            >
              <span class="size-3.5 shrink-0 rounded-full border" :class="locationMode === 'dedicated-dir' ? 'border-accent bg-accent' : 'border-border'" />
              <span class="flex-1 text-left text-[13px]">{{ t('newTask.createWorktree.locationDedicatedDir', { dir: dedicatedDirPreview }) }}</span>
              <span data-testid="location-recommended-badge" class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">{{ t('newTask.createWorktree.locationRecommended') }}</span>
            </Button>
          </div>
        </div>

        <div class="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" data-testid="worktree-cancel-btn" @click="onCancel">{{ t('newTask.createWorktree.cancelBtn') }}</Button>
          <Button type="submit" data-testid="worktree-create-btn" :disabled="!canSubmit">{{ t('newTask.createWorktree.createBtn') }}</Button>
        </div>
      </form>

      <!-- ── progress 态 ── -->
      <div v-else-if="phase === 'progress'" class="mt-2 space-y-3">
        <div data-testid="worktree-loading-bar" class="h-1 w-full overflow-hidden rounded-full bg-surface-2"><div class="h-full w-1/3 animate-pulse rounded-full bg-accent"></div></div>
        <ul class="space-y-2">
          <li v-for="(step, idx) in progressSteps" :key="step.testid" :data-testid="step.testid" class="flex items-center gap-2 text-[13px]">
            <Loader2 class="size-4 animate-spin text-accent" /><span class="text-neutral-fg">{{ step.label }}</span>
            <span v-if="idx === progressSteps.length - 1" class="ml-auto text-[11px] text-neutral-dim">...</span>
          </li>
        </ul>
        <Button variant="ghost" data-testid="worktree-log-toggle" class="h-auto w-full justify-start gap-1 rounded px-1 py-0.5 text-[12px] text-neutral-dim" @click="logExpanded = !logExpanded">
          <ChevronDown v-if="logExpanded" class="size-3.5" /><ChevronRight v-else class="size-3.5" />
          {{ t('newTask.createWorktree.showLog') }}
        </Button>
      </div>

      <!-- ── success 态 ── -->
      <div v-else-if="phase === 'success'" data-testid="worktree-success" class="mt-2 space-y-3">
        <div class="flex items-center gap-3">
          <div class="flex size-9 items-center justify-center rounded-full bg-accent-soft"><Check class="size-5 text-accent" /></div>
          <div class="space-y-0.5">
            <p class="text-[14px] font-medium text-neutral-fg">{{ t('newTask.createWorktree.successTitle') }}</p>
            <p class="text-[12px] text-neutral-dim">{{ t('newTask.createWorktree.successDesc') }}</p>
          </div>
        </div>
      </div>

      <!-- ── error 态 ── -->
      <div v-else-if="phase === 'error'" class="mt-2 space-y-3">
        <div class="flex items-start gap-2">
          <AlertTriangle class="mt-0.5 size-4 shrink-0 text-danger" />
          <div data-testid="worktree-step-failed" class="min-w-0 flex-1 space-y-1">
            <p class="text-[13px] font-medium text-neutral-fg">{{ t('newTask.createWorktree.failedStep') }}</p>
            <p v-if="lastError?.code" class="text-[11px] text-neutral-dim">code: {{ lastError.code }}<template v-if="lastError.exitCode != null"> · exit {{ lastError.exitCode }}</template></p>
          </div>
        </div>
        <pre v-if="lastError?.stderr" data-testid="worktree-error-output" class="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-2 font-mono text-[11px] text-neutral-fg">{{ lastError.stderr }}</pre>
        <pre v-else data-testid="worktree-error-output" class="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-2 font-mono text-[11px] text-neutral-fg">{{ lastError?.message ?? '' }}</pre>
        <div class="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" data-testid="worktree-cleanup-btn" @click="onCleanup">{{ t('newTask.createWorktree.cleanupBtn') }}</Button>
          <Button type="button" variant="default" data-testid="worktree-retry-btn" class="primary" @click="onRetry">{{ t('newTask.createWorktree.retryBtn') }}</Button>
        </div>
      </div>

      <!-- ── exists 态 ── -->
      <div v-else-if="phase === 'exists'" class="mt-2 space-y-3">
        <div data-testid="worktree-exists-notice" class="flex items-start gap-2 rounded-md border border-border bg-surface-2 p-3">
          <AlertTriangle class="mt-0.5 size-4 shrink-0 text-warn" /><p class="text-[13px] text-neutral-fg">{{ t('newTask.createWorktree.existsNotice') }}</p>
        </div>
        <div class="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" data-testid="worktree-cancel-btn" @click="onCancel">{{ t('newTask.createWorktree.cancelBtn') }}</Button>
          <Button type="button" variant="default" data-testid="worktree-use-existing-btn" @click="onUseExisting">{{ t('newTask.createWorktree.useExistingBtn') }}</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
