<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, watch } from 'vue'
/**
 * Landing.vue —— 新建任务落地空态（#2，spec §3.1 / §4.5）。
 *
 * 渲染条件由 Panel 控制（messageCount===0 && !isGenerating）。本组件是 presentational：
 * 接 props（cwd/branch/error 态）+ emit 动作（open-dir/open-branch/retry），不直接耦合状态机。
 * Panel（容器）把 emit 接到 useNewTaskFlow / useSidebar.retryHistory。
 *
 * UC-7 守卫（AC-2.2）：gitBranch 为空（非 git 目录）→ branch chip 隐藏。
 * NFR④#2 AC-2.6：historyError=true → 显重试按钮，不永久卡住。
 * 首次启动延迟 create（AC-1.7）：currentCwd 为空 → directory chip 显「选择目录」空态。
 *
 * [w5 壳接线] 5 个跨端组件 + dirNameOf 从 @taiji/ui import（w4 迁入）；
 * NewTaskDeps（12 字段壳适配）经 useNewTaskDeps() 构造 + provide NewTaskDepsKey，
 * ui 组件经 inject 消费（C-W4-1）；flow = deps.flow（core useNewTaskFlow 单例，
 * 与 useSidebar 共享——双状态机断裂防护）。
 */

import { useI18n } from 'vue-i18n'
import { Folder, GitFork, RefreshCw } from '@lucide/vue'
import { resolveLaunchConfig } from '@taiji/core'
import { BUILTIN_PRESET_IDS, type PiLaunchPreset } from '@taiji/shared'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DirSelectPopover,
  BranchSelectPopover,
  CreateBranchModal,
  CreateWorktreeModal,
  PresetSelectChip,
  NewTaskDepsKey,
  dirNameOf,
} from '@taiji/ui'
import Composer from '@/components/panel/Composer.vue'
import { useNewTaskDeps } from '@/composables/features/new-task/useNewTaskDeps'

const props = withDefaults(
  defineProps<{
    /** 绑定的 session id（首次启动延迟 create 时为 null） */
    sessionId: string | null
    /** 当前 cwd（chip 回灌；null/空 → 首次启动空态文案） */
    currentCwd?: string | null
    /** 当前分支名（空 → 非 git 目录，branch chip 隐藏，AC-2.2） */
    gitBranch?: string | null
    /** getHistory 加载失败 → 显重试按钮（AC-2.6） */
    historyError?: boolean
  }>(),
  { currentCwd: null, gitBranch: null, historyError: false },
)

const emit = defineEmits<{
  (e: 'open-dir'): void
  (e: 'open-branch'): void
  (e: 'retry'): void
}>()

const { t } = useI18n()
// [w5] deps 组装 + provide NewTaskDepsKey（ui 组件经 inject 消费）；flow = deps.flow
const deps = useNewTaskDeps()
provide(NewTaskDepsKey, deps)
const flow = deps.flow
const toastError = deps.toast.error

/**
 * onOpenDirDialog — 打开 OS 目录选择器（AC-5.6 异常反馈）。
 *
 * flow.openDirDialog 的 IPC 招错时 toast 提示用户（不再变 unhandled rejection）。
 * 模板不能内联 flow.openDirDialog()：那样返回的 Promise 无人 catch，reject 变 unhandled rejection。
 */
function onOpenDirDialog(): void {
  flow.openDirDialog().catch((e: unknown) => {
    const reason = e instanceof Error ? e.message : String(e)
    toastError(t('newTask.landing.dirSelectorFailed', { reason }))
  })
}
// landing 态 session 真源是 NewTaskFlow（selectWorkspace/openDirDialog create 的 session 不经
// useSidebar，panel leaf.sessionId 滞后）。优先 flow 真源，props 作 fallback（常态新建两者一致）。
// 前两者都 null（真 landing 态）时 composerSid 为 null——CommandPopover 走 skills fallback
// （settingsStore 全局 skills + projectSkills），不再依赖公共 session pi 命令（W3 已移除公共 session）。
const composerSid = computed(() => flow.currentSessionId.value ?? props.sessionId)
const cwd = computed(() => flow.currentCwd.value ?? props.currentCwd)

/**
 * landing 态进入保障 + cwd 同步：
 * app 启动 / 空 session 时 Panel 因 !sessionId 渲染 Landing，但 flow.state 可能还是 idle
 * （未走 startFlow）→ presetCwd 不执行（要求 state=landing）→ cwd 未同步 → mode 恒 not-repo →
 * Git chip 不显示 + 点 chip 时 idle→branch-popover 非法转换报错。
 * startFlow 幂等（已 landing 不翻 state，只刷新 cwd），idle 态调它会 idle→landing + presetCwd。
 */
onMounted(() => {
  if (flow.state.value !== 'landing') {
    flow.startFlow(props.currentCwd ?? undefined)
  } else if (!flow.currentCwd.value && props.currentCwd) {
    flow.presetCwd(props.currentCwd)
  }
})
/**
 * [D4 卸载守卫] Landing 是 landing/overlay 态的唯一承接视图，卸载即终结：
 * 封死「视图消失、状态漂留」的残留路径（flow.state 是 core 模块级单例，视图卸载后
 * 若停留 landing/overlay，无任何承接者能终结它——本守卫即 D4 的
 * 出口兜底层）。限定 isActive（landing/overlay 活跃态）才 cancel：正常首发
 * （completed）与切换（cancelled，selectSession 守卫已 cancel）路径下卸载时已非活跃，
 * 守卫 noop，不产生非法转换。
 *
 * [不变式] Landing 全仓唯一挂载点 = Panel.vue 的 landing 分支（多面板 split 拓扑
 * 已于 2026-07-24 删除），由 landing.test.ts 静态断言锁定。若未来重新引入多挂载点
 * 拓扑，「卸载即 cancel」会误杀其他挂载点正在编辑的草稿（flow 是单例，跨实例协调
 * 不能靠组件实例变量）——本处卸载语义必须先重新设计。
 */
onUnmounted(() => {
  if (flow.isActive.value) flow.cancelFlow()
})
watch(() => props.currentCwd, (newCwd) => {
  if (!flow.currentCwd.value && newCwd) {
    flow.presetCwd(newCwd)
  }
})
/**
 * 当前分支名（Git chip 显示）。flow.gitInfo 现已合并 landing 态数据源
 *（useNewTaskFlow 从 dirSelect.worktreeItems HEAD 项派生），无需组件层再查 worktreeItems。
 */
const branch = computed(() => flow.gitInfo.value?.branch ?? props.gitBranch ?? null)
/** 是否为 git 仓库目录（Git chip 可见性守卫，pendingCwd 驱动的 workspace.detect 三态）。 */
const isGitRepo = computed(() => flow.mode?.value !== 'not-repo')

/** directory chip 文案：有 cwd 显示目录名，否则首次启动空态（AC-1.7） */
const dirLabel = computed(() => {
  const c = cwd.value
  if (!c) return t('newTask.landing.selectDir')
  // 取末段目录名（dirNameOf 收敛到 logic/path SSOT，与 PanelHeader mono cwd 风格一致）
  return dirNameOf(c)
})

/** 时段问候语前缀（spec §3.1「上午好呀/下午好呀/晚上好呀」） */
// 时段分界：<12 上午，<18 下午，否则晚上（24h 制）
const HOUR_NOON = 12
const HOUR_EVENING = 18
const greetingPrefix = computed(() => {
  const h = new Date().getHours()
  if (h < HOUR_NOON) return t('app.greetingMorning')
  if (h < HOUR_EVENING) return t('app.greetingAfternoon')
  return t('app.greetingEvening')
})
const isDirOpen = computed({
  get: () => flow.state.value === 'dir-popover',
  set: (v) => { if (!v) flow.closeOverlay(); else flow.openDirPopover() },
})
const isBranchOpen = computed({
  get: () => flow.state.value === 'branch-popover',
  set: (v) => { if (!v) flow.closeOverlay(); else flow.openBranchPopover() },
})
/** preset popover 展开绑定（preset 互斥 wave）：与 dir/branch 同模式共享 flow 单实例状态机互斥 */
const isPresetOpen = computed({
  get: () => flow.state.value === 'preset-popover',
  set: (v) => { if (!v) flow.closeOverlay(); else flow.openPresetPopover() },
})
/** 创建分支 modal 渲染绑定（#7）：state===branch-modal 时挂载 CreateBranchModal（Dialog teleport 到 body） */
const isBranchModalOpen = computed(() => flow.state.value === 'branch-modal')

/**
 * 创建 worktree modal 渲染绑定（W2 wave）：state===worktree-modal 时挂载 CreateWorktreeModal。
 * BranchSelectPopover Worktree tab 点「新建 worktree…」→ flow.openCreateWorktree → state=worktree-modal。
 */
const isWorktreeModalOpen = computed(() => flow.state.value === 'worktree-modal')

/** 当前 cwd 所在 workspace 的已有 worktree 列表（BranchSelectPopover Worktree tab 数据源）。 */
const worktreeItems = computed(() => flow.worktreeItems?.value ?? [])

/** 短名去尾缀后的最小保留长度（低于此值回退全名，避免「模式」二字模式名被去空） */
const MIN_SHORT_NAME_LENGTH = 2

/**
 * 当前显示 / 将生效的模式（u4b 接线）：与 PresetSelectChip 内部同一 resolve 链
 * （explicit > 全局默认 > builtin:full，D3 单一解析层）。renderer 侧算好全名 / 短名 /
 * 信任标记文案，经 props 传给 ui chip（ui 包不耦合 renderer i18n——u4a 的 props 契约）。
 */
const displayPreset = computed<PiLaunchPreset | null>(() => {
  const presets = deps.presets.value
  const resolved = resolveLaunchConfig({
    pendingPreset: flow.pendingPreset?.value ?? null,
    presets,
    defaultPresetId: deps.defaultPresetId.value,
  })
  const id =
    resolved.presetId ??
    (presets.some((p) => p.id === BUILTIN_PRESET_IDS.FULL) ? BUILTIN_PRESET_IDS.FULL : '')
  return presets.find((p) => p.id === id) ?? null
})
/** 模式全名（缺省 undefined → ui chip 回落其内部解析名，既有接入零改动） */
const modeName = computed(() => displayPreset.value?.name)
/** 模式短名（中文本土模式名去「模式」尾缀；无尾缀保持全名） */
const modeShortName = computed(() => {
  const name = modeName.value
  if (!name) return undefined
  const stripped = name.replace(/模式$/, '')
  return stripped.length >= MIN_SHORT_NAME_LENGTH ? stripped : name
})
/** 信任标记判据（设计 §7.1：`replace.enabled && 文案非空`） */
const modeHasReplace = computed(() => {
  const seg = displayPreset.value?.prompt?.replace
  return !!seg?.enabled && (seg.prompt ?? '').trim().length > 0
})
/** 信任标记文案（文本/短名档 = chip 内后缀；纯图标档 = 角标 tooltip；空 → ui chip 不渲染标记） */
const modeReplaceHint = computed(() =>
  modeHasReplace.value ? t('newTask.presetChip.replaceHint') : undefined,
)
/**
 * 模式 chip 强调底判据（设计 §5.1「颜色即状态」；方案 B）：当前生效模式 ≠ 默认模式才算非默认。
 *
 * 与 displayPreset 同源（同一 resolve 链）——displayPreset 存在 + id !== 默认档。默认档用
 * `||` 而非 `??`：store 未加载时 deps.defaultPresetId 为 `''`（非 null），`'' ?? x` 仍是 `''`，
 * 会把默认模式误判成非默认（恒亮 accent = 不携带信息，正是本判据要消除的退化）。
 * 注意 displayPreset 已把「解析不到」回落到 builtin:full（含 presets 未加载的 `''` 分支），
 * 故存在性 + 默认档比对即可，无需再处理空档。
 */
const isNonDefaultPreset = computed(() => {
  const p = displayPreset.value
  if (!p) return false
  return p.id !== (deps.defaultPresetId.value || BUILTIN_PRESET_IDS.FULL)
})

function onSelectWorkspace(payload: { cwd: string }): void {
  flow.selectWorkspace(payload.cwd)
}
function onSelectBranch(payload: { name: string }): void {
  flow.selectBranch(payload.name)
}
/**
 * worktree 创建成功（CreateWorktreeModal emit success）：创建成功即回灌新 worktree cwd
 * （chip 同刻切换），不关 overlay——modal 成功屏自行展示后 emit close（或用户提前关），
 * 统一走 closeOverlay 回 landing。
 * [HISTORICAL] 旧链路：success emit 挂在 modal 的 2s 展示定时器上，窗口内关 modal
 * → 卸载清 timer → 切换静默丢失（chip 留旧目录，首发 create 也落旧目录）。
 */
function onWorktreeCreated(payload: { cwd: string }): void {
  flow.adoptWorktreeCwd(payload.cwd)
}
/**
 * exists 态「直接开始」（CreateWorktreeModal emit use-existing）：
 * 选定 worktree 的 cwd（chip 回灌）+ 关 overlay 回 landing（无成功屏，直接切换）。
 */
function onWorktreeActivated(payload: { cwd: string }): void {
  flow.selectWorkspace(payload.cwd)
  flow.closeOverlay()
}

/**
 * selectWorktree —— 选择已有 worktree，切换到该 worktree 的 cwd。
 * 语义同 selectWorkspace（记 pendingCwd + 关 popover），路径来源为 worktree item.path。
 */
function onSelectWorktree(payload: { path: string }): void {
  flow.selectWorkspace(payload.path)
  flow.closeOverlay()
}
function onRetry(): void {
  emit('retry')
}
/**
 * onPresetSelect — PresetSelectChip emit select 的接收点（B6 透传链路修复）。
 *
 * 用户在 landing 态真实点击选预设（非默认回显）→ 写 flow.pendingPreset（对齐 pendingCwd/pendingModel
 * 范式），submitFirstMessage create session 时透传 sessionApi.create。Composer.onSend 不再
 * 直接读 store.selectedPresetId（已删除第二真源），统一经 flow 单一真源。
 */
function onPresetSelect(payload: { presetId: string }): void {
  flow.setPendingPreset(payload.presetId)
}
</script>

<template>
  <div
    data-testid="new-task-landing"
    class="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-8 overflow-hidden p-6"
  >

    <!-- 问候语（22px / weight 650 / --fg，spec §3.1） -->
    <h1 class="z-10 text-center text-[22px] font-[650] text-neutral-fg">
      {{ greetingPrefix }}，{{ t('app.greetingPrompt') }}
    </h1>

    <!-- getHistory 失败重试出口（AC-2.6，不永久卡住） -->
    <Button
      v-if="historyError"
      data-testid="retry-history"
      variant="secondary"
      class="z-10 h-auto gap-1.5 px-3 py-1.5 text-[12px] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-3.5"
      @click="onRetry"
    >
      <RefreshCw class="shrink-0" />
      {{ t('newTask.landing.retryHistory') }}
    </Button>

    <!-- composer 卡片（variant=landing：720px 居中，--bg-input + --border + --radius-lg）。
         spec §3.1：chip 是 composer 卡片顶部元信息行，非悬空 → 经 #meta-row slot 注入。
         landing 态 session 真源用 flow（composerSid），props 作 fallback。 -->
    <Composer variant="landing" :session-id="composerSid">
      <template #meta-row>
        <!-- 首行三 chip（目录 ｜ 分支 ｜ 模式；设计 §7.4）：容器 nowrap + overflow-hidden，
             各 chip min-w-0；截断优先级 = 目录截断(110px) → 分支截断(76px) → 分支退化为图标
             （纯 CSS flex-shrink，分支 shrink-[8] 先于模式 shrink）→ 模式退化为纯图标
             （PresetSelectChip 内部实测自适应，颜色即状态：默认模式中性底 / 非默认模式 accent 底
             [方案 B，:accent=isNonDefaultPreset]，跨档不丢的信任标记）。 -->
        <div class="flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden px-2.5 pt-2.5">
          <Popover v-model:open="isDirOpen">
            <PopoverTrigger as-child>
              <Button
                data-testid="chip-directory"
                variant="ghost"
                class="h-auto min-w-0 shrink-0 gap-1.5 px-2 py-1 text-[12px] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-3.5"
                :class="{ '!text-accent': !cwd }"
              >
                <Folder class="shrink-0" />
                <span class="max-w-[110px] truncate font-mono">{{ dirLabel }}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" :collision-padding="8" class="w-[320px] p-0">
              <DirSelectPopover
                :current-cwd="currentCwd ?? null"
                @select="onSelectWorkspace"
                @open-dir-dialog="onOpenDirDialog"
                @close="flow.closeOverlay()"
              />
            </PopoverContent>
          </Popover>
          <span v-if="isGitRepo" aria-hidden="true" class="h-3.5 w-px shrink-0 bg-border" />
          <Popover v-if="isGitRepo" v-model:open="isBranchOpen">
            <PopoverTrigger as-child>
              <Button
                data-testid="chip-branch"
                variant="ghost"
                class="h-auto min-w-0 shrink-[8] gap-1.5 px-2 py-1 text-[12px] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-3.5"
              >
                <GitFork class="shrink-0" />
                <span class="max-w-[76px] min-w-0 truncate font-mono">{{ branch || t('newTask.landing.gitRepo') }}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" :collision-padding="8" class="w-[420px] p-0">
              <BranchSelectPopover
                :mode="flow.mode?.value === 'bare-workspace' ? 'bare-workspace' : 'plain-repo'"
                :cwd="cwd ?? ''"
                :current-branch="branch"
                :worktree-items="worktreeItems"
                @select="onSelectBranch"
                @open-branch-modal="flow.openBranchModal()"
                @select-worktree="onSelectWorktree"
                @create-worktree="flow.openCreateWorktree()"
                @close="flow.closeOverlay()"
              />
            </PopoverContent>
          </Popover>
          <span aria-hidden="true" class="h-3.5 w-px shrink-0 bg-border" />
          <PresetSelectChip
            :session-id="composerSid"
            :launch-preset-id="flow.currentSession.value?.launchPresetId"
            :accent="isNonDefaultPreset"
            :mode-name="modeName"
            :short-name="modeShortName"
            :has-replace-prompt="modeHasReplace"
            :replace-hint="modeReplaceHint"
            v-model:preset-open="isPresetOpen"
            @select="onPresetSelect"
          />
        </div>
      </template>
    </Composer>

    <!-- 创建分支 modal（#7）：BranchSelectPopover emit open-branch-modal → openBranchModal → state=branch-modal → 渲染。modal 内 Esc/提交失败留 modal（D-7）。 -->
    <CreateBranchModal v-if="isBranchModalOpen" />

    <!-- 创建 worktree modal（W2 wave）：BranchSelectPopover emit create-worktree → openCreateWorktree →
         state=worktree-modal → 渲染。modal 内五态自管；success → adoptWorktreeCwd（chip 同刻切换，
         不关 overlay）；close（2s 定时器/用户关）→ closeOverlay 回 landing；
         use-existing → selectWorkspace + closeOverlay（无成功屏直接切换）。 -->
    <CreateWorktreeModal
      v-if="isWorktreeModalOpen"
      @close="flow.closeOverlay()"
      @success="onWorktreeCreated"
      @use-existing="onWorktreeActivated"
    />
  </div>
</template>
