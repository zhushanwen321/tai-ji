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

    <!-- RD-4#8：读配置失败常驻提示（默认值非已存值）+ 重试；控件禁用直到重新拉取成功 -->
    <div
      v-if="loadError"
      data-testid="worktree-load-error"
      class="flex items-center gap-2 px-4 text-[length:var(--text-2xs)] text-warn"
    >
      <AlertTriangle class="size-3.5 shrink-0" />
      <span>{{ t('settings.worktree.loadErrorHint') }}</span>
      <Button
        variant="ghost"
        size="sm"
        class="h-5 px-1.5 text-[length:var(--text-2xs)] text-accent"
        data-testid="worktree-load-retry"
        @click="loadConfig"
      >{{ t('settings.worktree.loadErrorRetry') }}</Button>
    </div>

    <!-- Section 1：普通 git 仓库。卡体 = demo .gcard-body.tight（4px 10px 8px）+ SettingRow（.srow 行范式：
         label 14px/600 左 · desc 13px 右下，控件右置；首行无分隔线由 first:border-t-0 提供） -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.worktree.sectionPlainRepo') }}</h3>
          <p class="gc-sub">{{ t('settings.worktree.sectionPlainRepoDesc') }}</p>
        </div>
      </template>
      <div class="px-[10px] pb-[8px] pt-[4px]">
        <!-- 专用目录 -->
        <SettingRow :label="t('settings.worktree.worktreeRootDir')" :desc="t('settings.worktree.worktreeRootDirHint')">
          <Input
            v-model="worktreeRootDir"
            data-testid="worktree-root-dir-input"
            :placeholder="t('settings.worktree.worktreeRootDirPlaceholder')"
            class="w-[240px] font-mono"
            :disabled="rootDirBusy || loadError"
            @blur="onSaveWorktreeRootDir"
          />
          <!-- 浏览 = demo .btn.secondary（描边 32px；disabled 持久化，功能位保留） -->
          <Button
            variant="secondary"
            class="h-8 px-[12px] text-[length:var(--text-sm)]"
            disabled
            :title="t('settings.worktree.browseComingSoon')"
          >
            {{ t('settings.worktree.browse') }}
          </Button>
        </SettingRow>
        <!-- 初始化脚本 -->
        <SettingRow :label="t('settings.worktree.setupScript')" :desc="t('settings.worktree.setupScriptHint')">
          <Input
            v-model="setupScript"
            :placeholder="t('settings.worktree.setupScriptPlaceholder')"
            class="w-[280px] font-mono"
            :disabled="setupScriptBusy || loadError"
            @blur="onSaveSetupScript"
          />
        </SettingRow>
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
      <div class="px-[10px] pb-[8px] pt-[4px]">
        <!-- 初始化脚本 -->
        <SettingRow :label="t('settings.worktree.bareSetupScript')" :desc="t('settings.worktree.bareSetupScriptHint')">
          <Input
            v-model="bareSetupScript"
            :placeholder="t('settings.worktree.bareSetupScriptPlaceholder')"
            class="w-[280px] font-mono"
            :disabled="bareSetupScriptBusy || loadError"
            @blur="onSaveBareSetupScript"
          />
        </SettingRow>
        <!-- 超时时间（校验反馈 danger text-xs 在输入下方——demo settings spec §6 三件套统一
             小字档；demo 的「秒」后缀依赖新增 i18n key，
             locale 文件不在本波清单——不造词，单位说明由 hint 承载） -->
        <SettingRow :label="t('settings.worktree.timeout')" :desc="t('settings.worktree.timeoutHint')">
          <div class="flex flex-col items-end gap-1">
            <Input
              v-model.number="timeout"
              type="number"
              data-testid="worktree-timeout-input"
              :placeholder="t('settings.worktree.timeoutPlaceholder')"
              class="w-[120px]"
              min="1"
              max="3600"
              :disabled="timeoutBusy || loadError"
              @blur="onSaveTimeout"
            />
            <span v-if="timeoutInvalid" data-testid="worktree-timeout-error" class="text-[length:var(--text-xs)] text-danger">
              {{ inlineText(timeoutInvalid) }}
            </span>
          </div>
        </SettingRow>
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
      <div class="px-[10px] pb-[8px] pt-[4px]">
        <!-- 默认基分支（校验反馈位形态同超时行） -->
        <SettingRow :label="t('settings.worktree.defaultBaseBranch')" :desc="t('settings.worktree.defaultBaseBranchHint')">
          <div class="flex flex-col items-end gap-1">
            <Input
              v-model="defaultBaseBranch"
              data-testid="worktree-base-branch-input"
              :placeholder="t('settings.worktree.defaultBaseBranchPlaceholder')"
              class="w-[200px] font-mono"
              :disabled="baseBranchBusy || loadError"
              @blur="onSaveDefaultBaseBranch"
            />
            <span v-if="baseBranchInvalid" data-testid="worktree-base-branch-error" class="text-[length:var(--text-xs)] text-danger">
              {{ inlineText(baseBranchInvalid) }}
            </span>
          </div>
        </SettingRow>
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
import { GroupCard } from '@taiji/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import { getSettingsTransport } from '@taiji/core'
import { WORKTREE_AUTO_BASE_BRANCH } from '@taiji/shared'
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
// 缺省值 = 跨端协议哨兵（@taiji/shared SSOT，runtime 读到后按远端实况动态推导），禁手抄字面量
const baseBranchField = group.field<string>(WORKTREE_AUTO_BASE_BRANCH, {
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
