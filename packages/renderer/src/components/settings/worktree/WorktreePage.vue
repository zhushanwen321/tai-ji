<!--
  Settings · Worktree 配置页。
  三个 section：普通 git 仓库 / bare-workspace / 通用。
  所有设置项变更后立即通过 WS 同步到 runtime（乐观更新 + 失败回滚）。
  字段编排走 setting-field module（RD-4#8 loadError 归并：加载失败常驻禁用 + 可重试）。
-->
<template>
  <div class="flex max-w-[860px] flex-col gap-3">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.worktree') }}</h1>
        <p class="desc">{{ t('settings.menu.worktreeDesc') }}</p>
      </div>
    </header>

    <!-- RD-4#8：读配置失败常驻提示（默认值非已存值）+ 重试；控件禁用直到重拉成功 -->
    <div
      v-if="loadError"
      data-testid="worktree-load-error"
      class="flex items-center gap-2 px-4 text-[11px] text-warn"
    >
      <AlertTriangle class="size-3.5 shrink-0" />
      <span>{{ t('settings.worktree.loadErrorHint') }}</span>
      <Button
        variant="ghost"
        size="sm"
        class="h-5 px-1.5 text-[11px] text-accent"
        data-testid="worktree-load-retry"
        @click="loadConfig"
      >{{ t('settings.worktree.loadErrorRetry') }}</Button>
    </div>

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
              :disabled="rootDirBusy || loadError"
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
            :disabled="setupScriptBusy || loadError"
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
            :disabled="bareSetupScriptBusy || loadError"
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
              :disabled="timeoutBusy || loadError"
              @blur="onSaveTimeout"
            />
            <span v-if="timeoutInvalid" data-testid="worktree-timeout-error" class="text-[11px] text-danger">
              {{ inlineText(timeoutInvalid) }}
            </span>
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
              :disabled="baseBranchBusy || loadError"
              @blur="onSaveDefaultBaseBranch"
            />
            <span v-if="baseBranchInvalid" data-testid="worktree-base-branch-error" class="text-[11px] text-danger">
              {{ inlineText(baseBranchInvalid) }}
            </span>
          </div>
        </div>
      </div>
    </GroupCard>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { GroupCard } from '@taiji/ui/features/settings'
import { getSettingsTransport } from '@taiji/core'
import { createSettingFieldGroup } from '@/composables/features/settings/setting-field'

// [C3] settings 域 transport 只经 SettingsTransport seam（禁直连门面 / 禁深 import transport 域）
const transport = getSettingsTransport()

const { t } = useI18n()

/** worktree 创建超时默认值（秒） */
const DEFAULT_TIMEOUT_SECONDS = 60

/** RD-4#7：超时上限（对齐 runtime worktree-config-helper setTimeout 的 (0, 3600] 区间）。 */
const TIMEOUT_MAX_SECONDS = 3600

// ── 字段编排组（setting-field module）：RD-4#8 加载归并 + 乐观更新/回滚/toast/同值短路 ──
const group = createSettingFieldGroup()
const loadError = group.loadError

// worktree 域 toast 文案（与迁移前一致，不用 module 默认的 settings.system.*）
const TOAST_KEYS = {
  savedToastKey: 'settings.worktree.saved',
  saveFailedToastKey: 'settings.worktree.saveFailed',
} as const

// ── RD-4#7：前端校验 inline error 通道（validate 拒绝置 key，命中即显形不发 RPC）──
const timeoutInvalid = ref<string | null>(null)
const baseBranchInvalid = ref<string | null>(null)

/** inline error key → 用户可见文案（模板渲染 helper；null 已被 v-if 拦截）。 */
function inlineText(key: string | null): string {
  return key === null ? '' : t(key)
}

// ── Section 1：普通 git 仓库（rootDir / setupScript 无前端域校验，失败走 saveFailed 回滚）──
const rootDirField = group.field<string>('', {
  load: () => transport.getWorktreeRootDir().then((res) => res.dir),
  // resolve void = 不回填（setXxx echo 无归一语义），乐观值即生效值
  save: (next) => transport.setWorktreeRootDir(next).then(() => undefined),
  ...TOAST_KEYS,
})
const worktreeRootDir = rootDirField.value
const rootDirBusy = rootDirField.busy

const setupScriptField = group.field<string>('', {
  load: () => transport.getSetupScript().then((res) => res.script),
  save: (next) => transport.setSetupScript(next).then(() => undefined),
  ...TOAST_KEYS,
})
const setupScript = setupScriptField.value
const setupScriptBusy = setupScriptField.busy

// ── Section 2：bare-workspace ──
const bareSetupScriptField = group.field<string>('', {
  load: () => transport.getBareSetupScript().then((res) => res.script),
  save: (next) => transport.setBareSetupScript(next).then(() => undefined),
  ...TOAST_KEYS,
})
const bareSetupScript = bareSetupScriptField.value
const bareSetupScriptBusy = bareSetupScriptField.busy

const timeoutField = group.field<number>(DEFAULT_TIMEOUT_SECONDS, {
  load: () => transport.getWorktreeTimeout().then((res) => res.timeout),
  // RD-4#7：前端范围校验（对齐 runtime (0, 3600]），inline error 形态不弹 toast
  validate: (next) =>
    !Number.isFinite(next) || next <= 0 || next > TIMEOUT_MAX_SECONDS ? 'settings.worktree.timeoutInvalid' : null,
  invalidInline: timeoutInvalid,
  save: (next) => transport.setWorktreeTimeout(next).then(() => undefined),
  ...TOAST_KEYS,
})
const timeout = timeoutField.value
const timeoutBusy = timeoutField.busy

// ── Section 3：通用 ──
const baseBranchField = group.field<string>('origin/main', {
  load: () => transport.getDefaultBaseBranch().then((res) => res.baseBranch),
  // RD-4#7：非空校验（runtime setDefaultBaseBranch 不校验空串，直到 git 操作才炸），inline error 形态
  validate: (next) => (next.trim() === '' ? 'settings.worktree.baseBranchEmpty' : null),
  invalidInline: baseBranchInvalid,
  save: (next) => transport.setDefaultBaseBranch(next).then(() => undefined),
  ...TOAST_KEYS,
})
const defaultBaseBranch = baseBranchField.value
const baseBranchBusy = baseBranchField.busy

/** 加载/重试：五个字段的便捷 load 已注册进 group，loadAll 归并（任一失败置 loadError）。 */
async function loadConfig(): Promise<void> {
  await group.loadAll()
}

onMounted(() => {
  void loadConfig()
})

// ── blur 保存（薄转发，编排全在 setting-field module：同值短路 → validate → 乐观写/回滚/toast）──
function onSaveWorktreeRootDir(): void {
  void rootDirField.persist(worktreeRootDir.value)
}

function onSaveSetupScript(): void {
  void setupScriptField.persist(setupScript.value)
}

function onSaveBareSetupScript(): void {
  void bareSetupScriptField.persist(bareSetupScript.value)
}

function onSaveTimeout(): void {
  void timeoutField.persist(timeout.value)
}

function onSaveDefaultBaseBranch(): void {
  void baseBranchField.persist(defaultBaseBranch.value)
}
</script>
