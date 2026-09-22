<!--
  Settings · Worktree 配置页。
  三个 section：普通 git 仓库 / bare-workspace / 通用。
  所有设置项变更后立即通过 WS 同步到 runtime（乐观更新 + 失败回滚）。
-->
<template>
  <div class="flex max-w-[860px] flex-col gap-3">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.worktree') }}</h1>
        <p class="desc">{{ t('settings.menu.worktreeDesc') }}</p>
      </div>
    </header>

    <!-- Section 1：普通 git 仓库 -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.worktree.sectionPlainRepo') }}</h3>
          <p class="gc-sub">{{ t('settings.worktree.sectionPlainRepoDesc') }}</p>
        </div>
      </template>
      <div>
        <!-- 专用目录 -->
        <div class="flex items-center justify-between px-4 py-3">
          <div class="flex flex-col gap-0.5">
            <Label class="text-[12px] text-neutral-fg">{{ t('settings.worktree.worktreeRootDir') }}</Label>
            <span class="text-[10px] text-neutral-mid">{{ t('settings.worktree.worktreeRootDirHint') }}</span>
          </div>
          <div class="flex items-center gap-2">
            <Input
              v-model="worktreeRootDir"
              data-testid="worktree-root-dir-input"
              :placeholder="t('settings.worktree.worktreeRootDirPlaceholder')"
              class="h-8 w-[240px] text-[12px]"
              @blur="onSaveWorktreeRootDir"
            />
            <Button
              variant="ghost"
              class="h-8 px-2 text-[11px] text-accent hover:bg-transparent hover:underline"
              disabled
              :title="t('settings.worktree.browseComingSoon')"
            >
              {{ t('settings.worktree.browse') }}
            </Button>
          </div>
        </div>
        <!-- 初始化脚本 -->
        <div class="flex items-center justify-between border-t border-border px-4 py-3">
          <div class="flex flex-col gap-0.5">
            <Label class="text-[12px] text-neutral-fg">{{ t('settings.worktree.setupScript') }}</Label>
            <span class="text-[10px] text-neutral-mid">{{ t('settings.worktree.setupScriptHint') }}</span>
          </div>
          <Input
            v-model="setupScript"
            :placeholder="t('settings.worktree.setupScriptPlaceholder')"
            class="h-8 w-[280px] text-[12px]"
            @blur="onSaveSetupScript"
          />
        </div>
      </div>
    </GroupCard>

    <!-- Section 2：bare-workspace -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.worktree.sectionBareWorkspace') }}</h3>
          <p class="gc-sub">{{ t('settings.worktree.sectionBareWorkspaceDesc') }}</p>
        </div>
      </template>
      <div>
        <!-- 初始化脚本 -->
        <div class="flex items-center justify-between px-4 py-3">
          <div class="flex flex-col gap-0.5">
            <Label class="text-[12px] text-neutral-fg">{{ t('settings.worktree.bareSetupScript') }}</Label>
            <span class="text-[10px] text-neutral-mid">{{ t('settings.worktree.bareSetupScriptHint') }}</span>
          </div>
          <Input
            v-model="bareSetupScript"
            :placeholder="t('settings.worktree.bareSetupScriptPlaceholder')"
            class="h-8 w-[280px] text-[12px]"
            @blur="onSaveBareSetupScript"
          />
        </div>
        <!-- 超时时间 -->
        <div class="flex items-center justify-between border-t border-border px-4 py-3">
          <div class="flex flex-col gap-0.5">
            <Label class="text-[12px] text-neutral-fg">{{ t('settings.worktree.timeout') }}</Label>
            <span class="text-[10px] text-neutral-mid">{{ t('settings.worktree.timeoutHint') }}</span>
          </div>
          <div class="flex flex-col items-end gap-1">
            <Input
              v-model.number="timeout"
              type="number"
              data-testid="worktree-timeout-input"
              :placeholder="t('settings.worktree.timeoutPlaceholder')"
              class="h-8 w-[120px] text-[12px]"
              min="1"
              max="3600"
              @blur="onSaveTimeout"
            />
            <span v-if="timeoutError" data-testid="worktree-timeout-error" class="text-[11px] text-danger">{{ timeoutError }}</span>
          </div>
        </div>
      </div>
    </GroupCard>

    <!-- Section 3：通用 -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.worktree.sectionGeneral') }}</h3>
          <p class="gc-sub">{{ t('settings.worktree.sectionGeneralDesc') }}</p>
        </div>
      </template>
      <div>
        <!-- 默认基分支 -->
        <div class="flex items-center justify-between px-4 py-3">
          <div class="flex flex-col gap-0.5">
            <Label class="text-[12px] text-neutral-fg">{{ t('settings.worktree.defaultBaseBranch') }}</Label>
            <span class="text-[10px] text-neutral-mid">{{ t('settings.worktree.defaultBaseBranchHint') }}</span>
          </div>
          <div class="flex flex-col items-end gap-1">
            <Input
              v-model="defaultBaseBranch"
              data-testid="worktree-base-branch-input"
              :placeholder="t('settings.worktree.defaultBaseBranchPlaceholder')"
              class="h-8 w-[200px] text-[12px]"
              @blur="onSaveDefaultBaseBranch"
            />
            <span v-if="baseBranchError" data-testid="worktree-base-branch-error" class="text-[11px] text-danger">{{ baseBranchError }}</span>
          </div>
        </div>
      </div>
    </GroupCard>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { GroupCard } from '@taiji/ui/features/settings'
import { useToast } from '@/composables/useToast'
import {
  getWorktreeRootDir,
  setWorktreeRootDir,
  getSetupScript,
  setSetupScript,
  getBareSetupScript,
  setBareSetupScript,
  getWorktreeTimeout,
  setWorktreeTimeout,
  getDefaultBaseBranch,
  setDefaultBaseBranch,
} from '@taiji/core/transport/api/domains/settings'

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

/** worktree 创建超时默认值（秒） */
const DEFAULT_TIMEOUT_SECONDS = 60

/** RD-4#7：超时上限（对齐 runtime worktree-config-helper setTimeout 的 (0, 3600] 区间）。 */
const TIMEOUT_MAX_SECONDS = 3600

// ── 本地状态（乐观更新：先更新 UI，失败时回滚）──
const worktreeRootDir = ref('')
const setupScript = ref('')
const bareSetupScript = ref('')
const timeout = ref(DEFAULT_TIMEOUT_SECONDS)
const defaultBaseBranch = ref('origin/main')

// ── 初始值快照（用于失败回滚）──
let prevWorktreeRootDir = ''
let prevSetupScript = ''
let prevBareSetupScript = ''
let prevTimeout = DEFAULT_TIMEOUT_SECONDS
let prevDefaultBaseBranch = 'origin/main'

// ── RD-4#7：前端校验 inline error（命中即显形，不发 RPC）──
const timeoutError = ref('')
const baseBranchError = ref('')

// ── 加载初始配置 ──
onMounted(async () => {
  const [rootDirRes, scriptRes, bareScriptRes, timeoutRes, baseBranchRes] = await Promise.allSettled([
    getWorktreeRootDir(),
    getSetupScript(),
    getBareSetupScript(),
    getWorktreeTimeout(),
    getDefaultBaseBranch(),
  ])

  if (rootDirRes.status === 'fulfilled') {
    worktreeRootDir.value = rootDirRes.value.dir
    prevWorktreeRootDir = rootDirRes.value.dir
  }
  if (scriptRes.status === 'fulfilled') {
    setupScript.value = scriptRes.value.script
    prevSetupScript = scriptRes.value.script
  }
  if (bareScriptRes.status === 'fulfilled') {
    bareSetupScript.value = bareScriptRes.value.script
    prevBareSetupScript = bareScriptRes.value.script
  }
  if (timeoutRes.status === 'fulfilled') {
    timeout.value = timeoutRes.value.timeout
    prevTimeout = timeoutRes.value.timeout
  }
  if (baseBranchRes.status === 'fulfilled') {
    defaultBaseBranch.value = baseBranchRes.value.baseBranch
    prevDefaultBaseBranch = baseBranchRes.value.baseBranch
  }

  // 收集所有 rejected，提示用户（allSettled 自身永不 reject，但内部 RPC 可能失败）
  const failures = [rootDirRes, scriptRes, bareScriptRes, timeoutRes, baseBranchRes]
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failures.length > 0) {
    const details = failures.map(r => r.reason instanceof Error ? r.reason.message : String(r.reason)).join('; ')
    toastError(t('settings.worktree.loadFailed', { details }))
  }
})

// ── 保存 handlers（乐观更新 + 失败回滚）──

async function onSaveWorktreeRootDir() {
  if (worktreeRootDir.value === prevWorktreeRootDir) return
  const prev = prevWorktreeRootDir
  prevWorktreeRootDir = worktreeRootDir.value
  try {
    await setWorktreeRootDir(worktreeRootDir.value)
    toastInfo(t('settings.worktree.saved'))
  } catch (e) {
    worktreeRootDir.value = prev
    prevWorktreeRootDir = prev
    toastError(t('settings.worktree.saveFailed', { reason: e instanceof Error ? e.message : String(e) }))
  }
}

async function onSaveSetupScript() {
  if (setupScript.value === prevSetupScript) return
  const prev = prevSetupScript
  prevSetupScript = setupScript.value
  try {
    await setSetupScript(setupScript.value)
    toastInfo(t('settings.worktree.saved'))
  } catch (e) {
    setupScript.value = prev
    prevSetupScript = prev
    toastError(t('settings.worktree.saveFailed', { reason: e instanceof Error ? e.message : String(e) }))
  }
}

async function onSaveBareSetupScript() {
  if (bareSetupScript.value === prevBareSetupScript) return
  const prev = prevBareSetupScript
  prevBareSetupScript = bareSetupScript.value
  try {
    await setBareSetupScript(bareSetupScript.value)
    toastInfo(t('settings.worktree.saved'))
  } catch (e) {
    bareSetupScript.value = prev
    prevBareSetupScript = prev
    toastError(t('settings.worktree.saveFailed', { reason: e instanceof Error ? e.message : String(e) }))
  }
}

async function onSaveTimeout() {
  timeoutError.value = ''
  if (timeout.value === prevTimeout) return
  // RD-4#7：前端范围校验（对齐 runtime (0, 3600]），命中即 inline error 回滚，不发 RPC
  if (!Number.isFinite(timeout.value) || timeout.value <= 0 || timeout.value > TIMEOUT_MAX_SECONDS) {
    timeoutError.value = t('settings.worktree.timeoutInvalid')
    timeout.value = prevTimeout
    return
  }
  const prev = prevTimeout
  prevTimeout = timeout.value
  try {
    await setWorktreeTimeout(timeout.value)
    toastInfo(t('settings.worktree.saved'))
  } catch (e) {
    timeout.value = prev
    prevTimeout = prev
    toastError(t('settings.worktree.saveFailed', { reason: e instanceof Error ? e.message : String(e) }))
  }
}

async function onSaveDefaultBaseBranch() {
  baseBranchError.value = ''
  if (defaultBaseBranch.value === prevDefaultBaseBranch) return
  // RD-4#7：前端非空校验（runtime setDefaultBaseBranch 不校验空串，直到 git 操作才炸），
  // 命中即 inline error 回滚，不发 RPC
  if (defaultBaseBranch.value.trim() === '') {
    baseBranchError.value = t('settings.worktree.baseBranchEmpty')
    defaultBaseBranch.value = prevDefaultBaseBranch
    return
  }
  const prev = prevDefaultBaseBranch
  prevDefaultBaseBranch = defaultBaseBranch.value
  try {
    await setDefaultBaseBranch(defaultBaseBranch.value)
    toastInfo(t('settings.worktree.saved'))
  } catch (e) {
    defaultBaseBranch.value = prev
    prevDefaultBaseBranch = prev
    toastError(t('settings.worktree.saveFailed', { reason: e instanceof Error ? e.message : String(e) }))
  }
}

// ── 浏览按钮（placeholder：后续可接入 Electron dialog）──
// stub: onBrowseWorktreeRootDir 暂不导出——按钮 disabled，后续 wave 接 dialog.showOpenDialog 时再加
// function onBrowseWorktreeRootDir(): void {
//   toastInfo(t('settings.worktree.browseComingSoon'))
// }
</script>
