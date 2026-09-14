<template>
  <!--
    容器组件 · composer（panel/spec.md zone ④，draft-composer-states）。
    发送位四态（u6b / D6 表）：send（↑ idle 直发）/ stop（■ turn 活跃 / settling 单独）/
    queue（↑ 时钟角标：compacting/bash/settling+compacting，点击入 defer 队列）/
    spinner（isSending）。staging 模式优先（fork/handoff）。
    steer/followUp/defer 路由：⏎/Alt+⏎ 全部汇入统一发送分发器（D6，composer-shell
    sendRoute——turn 活跃→steer、占用→defer、idle→direct），Alt+⏎ 在 steer 路由行保留
    followUp 语义。
    staging 优先（fork/handoff，与视觉层 boxClass/placeholder 优先级对齐）：staging 活跃时 ⏎/Alt+⏎
      均提交 staging（发送位也替换为 staging 发送按钮，streaming 中同样生效）；handoff 的
      streaming 拦截在 enterHandoffMode/handleHandoffSend（isSessionActive 守卫）。

    [W4 迁移] 壳改写：消费 composer-shell.ts（core dispatch/context/model-thinking deps 组装 +
    视觉派生），ComposerInput 从 ui 包渲染（D5 占位：壳内硬编码渲染，P4 ExtensionHost 前不走
    contribution 路由）。子组件（CommandPopover/AddMenu/ModelSelect 等）留壳，不在本 wave 范围。
  -->
  <div class="composer content-col">
    <!-- retry/queue 指示位（spec C10，#13，composer 上方独立行）：
         auto_retry_end / message_start 到达时 store 自动清 → state=undefined → 组件 v-if 消失 -->
    <RetryIndicator :state="retryState" />
    <!-- [remove-turn-progress-bar §2.2 warn 化] turn 进展观测条挂载点已上移 Panel.vue
         composer-band（overlay/composer 互斥对之外）：ask_user 等待期 Composer 整体卸载，
         留在本组件内会随等待期一起消失。warn 化后为组件内部自判渲染（snapshot &&
         snapshot.warn，常态/ask_user 豁免期零 DOM；旧 awaitingUser 分型文案已随本设计
         删除）。挂载点/abort 接线见 Panel.vue。 -->
    <!-- 命令浮层（§2d @/#//）：anchor = composer-box（slot），reka-ui Popover portal body。
         composer-box 内 focus 算 inside 不触发 dismiss，键盘路由见 onKeydown。
         cwd：landing 态 $ 候选的 cwd 通道（landing-composer-session-file-symbols D2；
         panel 有 sid 不消费。flow.currentCwd 是普通对象内嵌套 ComputedRef，模板不自动
         解包，须显式 .value；可选链 + ?? null 兑容无 currentCwd 字段的旧 mock/flow 形态，
         缺失即无 cwd 不弹，与 S4b 空态语义一致） -->
    <CommandPopover
      ref="commandPopoverRef"
      v-model:open="cmdOpen"
      :type="cmdType"
      :session-id="sessionId ?? undefined"
      :cwd="flow.currentCwd?.value ?? null"
      :variant="variant"
      :project-skills="landingProjectSkills"
      :global-skills="landingGlobalSkills"
      :selected-skill-names="selectedSkillNames"
      :query="popoverQuery"
      @select="onCmdSelect"
    >
      <div
        ref="composerBoxRef"
        class="composer-box relative rounded-lg border bg-[var(--composer-bg)]"
        :class="[boxClass, focusRingClass]"
        data-testid="composer-box"
        @dragover.prevent="onDragOver"
        @dragleave.prevent="onDragLeave"
        @drop.prevent="onDrop"
      >
        <!-- QueueBubble（v6 §8.5：内嵌 composer-box 顶部，去独立卡片/pulse/标签/chevron，
             仅 border-b 分隔，Zap/Clock/Hourglass icon + truncate 文本）——6 区第 1 位。
             [compact-defer-composer-queue u1] defer 行三 props（deferEntries/deferChip/deferHint）
             由本组件从 useCompactQueue + sessionPhase 算好传入；@remove-defer 撤销未提交条目 -->
        <QueueBubble
          :state="queueState"
          :defer-entries="deferEntries"
          :defer-chip="deferChip"
          :defer-hint="deferHint"
          @remove-defer="onRemoveDefer"
        />
        <!-- Staging 模式标识 chip（fork/handoff 统一）：顶部 accent chip 提示当前 staging 类型 + × 退出。
             经 staging.activeStaging 统一渲染（ADR-0057），退出调 staging.exit() -->
        <div
          v-if="staging.activeStaging.value"
          class="composer-mode-chip mx-2.5 mt-2 flex items-center gap-1.5 rounded-md bg-[var(--accent-soft)] px-2 py-1 text-[length:var(--text-2xs)] font-medium text-[var(--accent)]"
          :data-testid="staging.activeStaging.value.type === 'fork' ? 'composer-mode-chip' : 'composer-handoff-chip'"
        >
          <component :is="staging.activeStaging.value.visual.chipIcon" class="size-3" />
          <span class="flex-1">{{ t(staging.activeStaging.value.visual.chipLabelKey) }}</span>
          <Button
            variant="ghost"
            size="icon"
            class="size-4 rounded-sm p-0 text-[var(--accent)] hover:bg-[var(--accent)] hover:text-accent-fg"
            :title="staging.activeStaging.value.type === 'fork' ? t('panel.composer.forkExit') : t('panel.composer.handoffExit')"
            @click="staging.exit"
          >
            <X class="size-3" />
          </Button>
        </div>
        <!-- 顶部元信息行 slot（landing 态：directory/branch chip；panel 态留空） -->
        <slot name="meta-row" />
        <!-- 已附上下文 chip 行（§2f）。W4：从 segments 派生 image chips，× 删除定位 DOM 节点移除 -->
        <ContextChipsBar :items="attachedItems" @remove="onRemoveContextChip" />
        <!-- 输入区：ui 包 ComposerInput（contenteditable 富文本，draft §1/§2e，支持 slash chip 与 @/# mention 内联）。
             deps（pasteImage/renderIcon/t）经 ComposerInputDeps inject token 注入（ADR-0058）。 -->
        <ComposerInput
          ref="inputRef"
          :placeholder="placeholder"
          :disabled="isSending"
          :session-id="sessionId"
          :suppress-triggers="isBashMode"
          @input="onInputChange"
          @keydown="onKeydown"
          @slash-trigger="onSlashTrigger"
          @skill-trigger="onSkillTrigger"
          @file-trigger="onFileTrigger"
          @session-trigger="onSessionTrigger"
          @subagent-trigger="onSubagentTrigger"
          @focus="onBoxFocusIn"
          @blur="onBoxFocusOut"
        />

      <!-- 工具条（panel/spec §composer line 51）：上下文/模型/thinking-level 展示型 + 发送位三态。
           gap-0：三触发器贴合紧凑成一条工具带（draft「不画分隔线」，仅靠 padding 区隔），发送位 ml-1.5 独立锚点。 -->
      <div class="composer-bar flex flex-wrap items-center justify-end gap-0 px-2.5 pb-2 mt-1">
        <!-- + 添加内容（左锚定，spec §1 ①，click 出浮层：附件 / 命令；# 文件改走 inline 触发） -->
        <AddMenuPopover @select="onAddSelect" />
        <!-- ExtensionHost composer.toolbar 挂载点（audit §12.1，MountPointRegistry composer.toolbar）。
             plugin 贡献工具栏视图 → ViewHost 渲染。empty="hidden"：无贡献时零 DOM 不影响布局。
             见 02-extension-host-wiring.md 重构 2。 -->
        <ViewHost
          v-if="sessionId"
          view-id="composer.toolbar"
          :session-id="sessionId"
          empty="hidden"
        />
        <span class="flex-1" />
        <!-- 生成指标双触发器（composer-gen-stats §3.1：速度 t/s + 缓存命中率 %，位于上下文容量左侧）。
             landing（无 session，尚未开始）隐藏：无采样无用量，两项恒「—」横线无信息量。 -->
        <GenStatsTriggers v-if="sessionId" :session-id="sessionId ?? undefined" :model-id="currentModelId" />
        <!-- 上下文容量（spec §2a：hover 出容量 popover；session 通道订阅 context.update）；landing 同上隐藏 -->
        <ContextCapacityPopover v-if="sessionId" :session-id="sessionId ?? undefined" :model-id="currentModelId" />
        <!-- 模型（spec §2b：click 出模型切换 popover） -->
        <ModelSelectPopover :selected="currentModelId" @select="onModelSelect" />
        <!-- 思考等级（spec §2c：click 出档位 popover；level 从 session 透传；reasoning 决定可用档集——non-reasoning 只 off） -->
        <ThinkingLevelPopover :level="currentThinkingLevel" :level-map="currentThinkingLevelMap" :supported-levels="currentSupportedLevels" @select="onThinkingSelect" />

        <!-- 发送位四态（u6b / D6 表「发送位」列）：staging（fork/handoff，含 streaming 中）→
             staging send / stop（turn 活跃 dispatching|generating；settling 单独）→ ■ stop /
             queue（compacting/bash/settling+compacting）→ ↑ 带时钟角标（可点入队，flush 于占用
             解除后自动投递）/ S5 sending→spinner / 全 idle→send。
             派生源 = shell sendButtonState（与分发器 sendRoute 同源 effectivePhase，不漂移）。
             staging 优先于 stop（用户决策）：streaming 中提交 fork 合法（对源只读）；需停止时
             先 Esc 退出 staging 再点 stop。staging 发送中（isSending）仍走 spinner。 -->
        <Button
          v-if="staging.activeStaging.value && !isSending"
          variant="default"
          size="icon"
          class="ml-1.5 size-[var(--composer-btn-size)] rounded-md bg-accent text-accent-fg transition-colors enabled:hover:bg-accent-hover disabled:bg-transparent disabled:text-[var(--neutral-dim)]"
          :disabled="!canSubmit"
          :data-testid="staging.activeStaging.value.type === 'fork' ? 'fork-send-btn' : 'handoff-send-btn'"
          :title="staging.activeStaging.value.type === 'fork' ? t('panel.composer.forkSend') : t('panel.composer.handoffSend')"
          @click="onSendClick"
        >
          <ArrowUp class="size-[15px]" />
        </Button>
        <Button
          v-else-if="sendButtonState === 'stop'"
          variant="ghost"
          size="icon"
          class="stop-btn ml-1.5 size-[var(--composer-btn-size)] rounded-md bg-surface-hover text-neutral-mid hover:bg-danger-soft hover:text-danger"
          :title="t('panel.composer.stop')"
          @click="onStopClick"
        >
          <Square class="size-[13px]" />
        </Button>
        <Button
          v-else-if="sendButtonState === 'queue'"
          variant="default"
          size="icon"
          class="queue-send-btn relative ml-1.5 size-[var(--composer-btn-size)] rounded-md bg-accent text-accent-fg transition-colors enabled:hover:bg-accent-hover disabled:bg-transparent disabled:text-[var(--neutral-dim)]"
          :disabled="!canSubmit"
          :title="canSubmit ? `${t('panel.composer.queueSend')} · ⏎` : t('panel.composer.sendHint')"
          @click="onSendClick"
        >
          <ArrowUp class="size-[15px]" />
          <!-- 时钟角标（D6 场景 1）：排队语义视觉锚点，右上角 1/4 尺寸 -->
          <Clock class="absolute right-[2px] top-[2px] size-2" aria-hidden="true" />
        </Button>
        <div
          v-else-if="isSending"
          class="ml-1.5 grid size-[var(--composer-btn-size)] place-items-center rounded-md bg-accent text-accent-fg"
          :title="t('panel.composer.sending')"
        >
          <Loader2 class="size-4 animate-spin" />
        </div>
        <Button
          v-else
          variant="default"
          size="icon"
          class="ml-1.5 size-[var(--composer-btn-size)] rounded-md bg-accent text-accent-fg transition-colors enabled:hover:bg-accent-hover disabled:bg-transparent disabled:text-[var(--neutral-dim)]"
          :disabled="!canSubmit"
          :title="canSubmit ? `${t('panel.composer.send')} · ⏎` : t('panel.composer.sendHint')"
          @click="onSendClick"
        >
          <ArrowUp class="size-[15px]" />
        </Button>
      </div>
    </div>
    </CommandPopover>

  </div>
</template>

<script setup lang="ts">
import { computed, createVNode, nextTick, onBeforeUnmount, onMounted, provide, ref, render, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUp, Clock, Loader2, Square, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { ComposerInput, ComposerInputDepsKey, type ComposerInputDeps } from '@xyz-agent/ui/features/composer'
import { ViewHost } from '@xyz-agent/ui/extension-host'
import AddMenuPopover from './AddMenuPopover.vue'
import CommandPopover from './CommandPopover.vue'
import ContextCapacityPopover from './ContextCapacityPopover.vue'
import GenStatsTriggers from './GenStatsTriggers.vue'
import ModelSelectPopover from './ModelSelectPopover.vue'
import ThinkingLevelPopover from './ThinkingLevelPopover.vue'
import ContextChipsBar from './ContextChipsBar.vue'
import RetryIndicator from './RetryIndicator.vue'
import QueueBubble from './QueueBubble.vue'
import { useChatStore } from '@/stores/chat'
import { useProjectSkills, useGlobalSkills } from '@/composables/features/settings/useProjectSkills'
import { useNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow'
import { useCommandPopoverTrigger } from '@/composables/panel/useCommandPopoverTrigger'
import { useDeferQueueRows } from '@/composables/panel/useDeferQueueRows'
import { useComposerFocusRing } from '@/composables/panel/composer-focus-ring'
import { useComposerShell, createComposerDrafts, type ShellInputInstance } from '@/composables/panel/composer-shell'
import { useComposerKeydown } from '@/composables/panel/composer-keydown'
import { useCompositionFlag } from '@/composables/panel/composition-flag'
import type { DraftStore } from '@xyz-agent/dom-core/composer/input'
import { handleImagePaste } from '@/composables/panel/useImageAttachment'
import { SLASH_ICON_COMPONENTS } from '@/composables/slashIcons'

const props = withDefaults(
  defineProps<{
    sessionId: string | null
    variant?: 'panel' | 'landing'
  }>(),
  { variant: 'panel' },
)

const { t } = useI18n()
const chatStore = useChatStore()
const flow = useNewTaskFlow()
const { projectSkills: landingProjectSkills } = useProjectSkills(flow.currentCwd) // W3 ADR-0051：landing 当前 cwd 项目 skill
const { globalSkills: landingGlobalSkills } = useGlobalSkills() // W4 FR-5：landing 全局 skill
const isActive = computed(() => {
  if (!props.sessionId) return false
  return chatStore.isActive(props.sessionId)
})

/** #13 retry/queue 指示位数据源（store 由 W0/#8 维护，不可变 Map 更新触发响应） */
const retryState = computed(() => (props.sessionId ? chatStore.getRetryState(props.sessionId) : undefined))
const queueState = computed(() => (props.sessionId ? chatStore.getQueueState(props.sessionId) : undefined))

const draft = ref('')
const inputRef = ref<InstanceType<typeof ComposerInput> | null>(null)
// W4：shell 的 input 契约是结构类型 ShellInputInstance（composer-shell.ts）——
// ui 包 ComposerInput 实例含全部 expose 方法（clear/focus/getText/getSegments/setText/
// insertTextAtCursor/insertSlashChip/insertFileChip/insertImageBadge/removeImageChip/
// moveCaretVertical），与契约结构兼容，模板 ref 类型断言传递（Vue 实例类型含 props/emits
// 无法直接赋给结构契约 ref）
const shellInputRef = inputRef as Ref<ShellInputInstance | null>

const sessionIdRef = computed(() => props.sessionId)

// [compact-defer-composer-queue u1] defer 行四出口（行数约束拆出 useDeferQueueRows，逻辑零改动）
const { deferEntries, deferChip, deferHint, onRemoveDefer } = useDeferQueueRows(sessionIdRef)
const {
  cmdOpen,
  cmdType,
  slashQuery,
  fileQuery,
  sessionQuery,
  subagentQuery,
  skillQuery,
  commandPopoverRef,
  onSlashTrigger,
  onFileTrigger,
  onSessionTrigger,
  onSubagentTrigger,
  onSkillTrigger,
  onAddSelect,
  onCmdSelect,
} = useCommandPopoverTrigger(shellInputRef, sessionIdRef)

/** 命令浮层过滤 query 五路映射（四符号体系 + skill：$ file / # session / @ subagent / 行首 / slash / 空格后 / skill） */
const popoverQuery = computed(() => {
  if (cmdType.value === 'file') return fileQuery.value
  if (cmdType.value === 'session') return sessionQuery.value
  if (cmdType.value === 'subagent') return subagentQuery.value
  if (cmdType.value === 'skill') return skillQuery.value
  return slashQuery.value
})

/**
 * 已插入 skill 名集合（多 skill 注入 D2 已选禁选数据面）：从 composer 当前 segments 取，
 * 透传 CommandPopover.selectedSkillNames。显式刷新（非 computed）——getSegments 读 DOM
 * 非响应式，随 onInputChange 同步刷新（chip 插入/删除走 onChanged → emit input，
 * 与 refreshAttachedItems 同一模式）。
 */
const selectedSkillNames = ref<string[]>([])

const isSending = ref(false)
// focusin/focusout 用原生 listener 注册（非 template @focusin）：composer-box 经
// CommandPopover 的 PopoverAnchor as-child 包裹，Vue template 事件绑定在 clone element 时丢失。
// ref 指向真实 DOM，addEventListener 稳定生效。
onMounted(() => {
  // composerBoxRef 在 CommandPopover PopoverAnchor as-child 包裹下透传丢失（ref 为 null），
  // 聚焦态改由子组件 ComposerInput emit focus/blur 驱动（见 @focus/@blur 绑定）。
})
onBeforeUnmount(() => {
  composerBoxRef.value?.removeEventListener('focusin', onBoxFocusIn)
  composerBoxRef.value?.removeEventListener('focusout', onBoxFocusOut)
})
/** composer-box 聚焦态：由 ComposerInput @focus/@blur 驱动（composer-box 经 CommandPopover
 *  PopoverAnchor as-child 包裹，ref 透传丢失，改由子组件 ComposerInput emit focus/blur）。 */
// [u6b] 本地 isCompacting computed 已退役：压缩维度的唯一读口收敛到 shell sendButtonState
// （occupancy 投影派生，与分发器 sendRoute 同源——双轨收口完成）。

// composer-box 容器 ref（拖拽落位 + 视觉）——先声明，再喂给 shell
const composerBoxRef = ref<HTMLElement | null>(null)
// FR4: per-session 草稿存储（ADR-0049 分区，工厂在 composer-shell）
const drafts: DraftStore = createComposerDrafts(sessionIdRef)

// ── W4 壳改写：core 模块 deps 组装 + 视觉派生集中在 composer-shell.ts（替代 14 个 useComposer* shim）──
const shell = useComposerShell({
  sessionIdRef,
  variantRef: computed(() => props.variant),
  inputRef: shellInputRef,
  composerBoxRef,
  draft,
  isSending,
  drafts,
  isActive,
})
const {
  currentModelId,
  currentThinkingLevel,
  currentThinkingLevelMap,
  currentSupportedLevels,
  onModelSelect,
  onThinkingSelect,
  handleArrowUp,
  handleArrowDown,
  resetBrowsing,
  isBrowsing,
  attachedItems,
  refreshAttachedItems,
  onRemoveContextChip,
  onDragOver,
  onDragLeave,
  onDrop,
  fork,
  handoff,
  staging,
  // [u5b] onSteer 解构退役：Enter 路由收口在分发器（onSend 内部 steer 分支），组件内无直调消费方
  onFollowUp,
  onAbort,
  onSend,
  sendRoute,
  sendButtonState,
  canSubmit,
  boxClass,
  placeholder,
  // bash 态（draft.trimStart().startsWith('!')，core dispatch/bash.ts isBashMode 同源判定）：
  // 传 ComposerInput suppressTriggers——bash 模式下 $/#/@/ 全部不触发浮层（设计 D6 豁免）
  isBashMode,
} = shell

// composer-box 聚焦态 + 聚焦环视觉（v6 §6.1 .focused）：从本组件拆出（script 行数约束，
// 见 composer-focus-ring.ts）；依赖 shell 的 boxClass/staging，故在解构后调用
const { focusRingClass, onBoxFocusIn, onBoxFocusOut } = useComposerFocusRing(
  boxClass,
  () => !!staging.activeStaging.value,
)

watch(
  () => props.sessionId,
  (newId, oldId) => {
    if (oldId) {
      // browsing 态 getText() 返回历史条目，存用户实际输入
      drafts.saveDraft(oldId, isBrowsing.value ? (draft.value || '') : (inputRef.value?.getText() ?? ''))
    }
    // 切 session 退出活跃 staging 模式（fork/handoff），避免来源残留指向错误 session
    staging.exit()
    resetBrowsing()
    if (newId) {
      const saved = drafts.getDraft(newId)
      if (saved) {
        draft.value = saved
        inputRef.value?.setText(saved, 'end')
      } else {
        // saved 为空串 = 未保存 → 走清空分支（语义与原 Map.get 返回 undefined 一致：falsy）
        draft.value = ''
        inputRef.value?.clear()
      }
    }
  },
)

/** ComposerInput input 事件 → 维护 draft（纯文本，用于发送判断）+ 刷新 image chips + 已选 skill 集合 */
function onInputChange(text: string): void {
  draft.value = text
  refreshAttachedItems()
  // 已选禁选数据面（多 skill 注入 D2）：skill segment 有 name，其余类型跳过
  // （TS 5.5 推断 type predicate：filter 后 s 收窄为 skill segment）
  selectedSkillNames.value = (inputRef.value?.getSegments() ?? [])
    .filter((s) => s.type === 'skill')
    .map((s) => s.name)
  // 用户修改了内容，重置浏览历史状态（下次按上重新从最后一条开始）
  resetBrowsing()
}

/** IME 组合态（window capture 监听，[GUI 快修④] 发送按钮 click 路径守卫消费） */
const { composing } = useCompositionFlag()

/** 键盘分发（composer-keydown.ts，U02 拆出）：staging 优先 ⏎ 提交（fork/handoff，含 streaming 中）；
 *  ⏎ / Alt+⏎ 全部汇入统一发送分发器（D6，u5b——Enter 按 sessionPhase 路由 direct/steer/defer；
 *  Alt+⏎ 保留 followUp 语义：steer 路由行走 followUp 下一轮，其余经分发器）；⇧⏎ 换行，↑/↓ 翻历史。
 *  命令浮层 open 时优先路由到浮层。[HISTORICAL] isActive→onSteer 与 isCompacting→onSend 两套
 *  分散判定（优先级倒挂根因）已退役，路由判定收口在 useComposerSend（core dispatch/send）。 */
const onKeydown = useComposerKeydown({
  cmdOpen,
  commandPopoverRef,
  inputRef: shellInputRef,
  staging,
  sendRoute,
  handleArrowUp,
  handleArrowDown,
  onFollowUp,
  onSend,
})

/**
 * stop 按钮点击：先尝试取消进行中的 staging 操作（handoff inflight），否则普通 LLM turn abort。
 * 在 Composer 包一层而非改 useComposerSubmit——避免影响其他消费方（onAbort 语义保持「取消 LLM turn」）。
 */
async function onStopClick(): Promise<void> {
  // staging 操作进行中（handoff inflight）→ 取消 staging（abortHandoff 乐观清 handingOff + RPC 中断）
  if (props.sessionId && await staging.abortIfInProgress(props.sessionId)) return
  // 否则普通 LLM turn abort
  await onAbort()
}

/**
 * 发送按钮点击入口 [GUI 快修④ 三吞点收口]（staging / queue / send 三颗发送位按钮共用）：
 * 1. IME 组字守卫补 click 路径——composer-keydown 的 e.isComposing 守卫只覆盖回车，
 *    点击路径此前缺失（组字中点击会提交半截拼音/竞态文本）；组字中静默不发送（与
 *    keydown 守卫同语义，组字提交后再点/回车即发）。
 * 2. canSubmit 与 draft 同步一帧竞态——点击瞬间分发器可能读到滞后一帧的 canSend/draft
 *    被守卫拦下（点了没反应）：canSubmit 为 false 时下一帧重读再走分发器（真·空输入/
 *    占用由 onSend 内 toast 反馈，不再静默）。
 */
async function onSendClick(): Promise<void> {
  if (composing.value) return
  if (!canSubmit.value) await nextTick()
  onSend()
}

// ── ui ComposerInput deps 注入（ADR-0058：pasteImage/renderIcon/t 三壳层能力）──
const composerInputDeps: ComposerInputDeps = {
  pasteImage: handleImagePaste,
  // renderIcon：图标查找 + vue render 内聚在壳层（dom-core 零 vue render，ADR-0058 边界）。
  // 返回 true = 已渲染图标（dom-core 侧挂载 host），false = 无图标不渲染。
  renderIcon: (host: HTMLElement, iconKey?: string) => {
    const Comp = iconKey
      ? SLASH_ICON_COMPONENTS[iconKey as keyof typeof SLASH_ICON_COMPONENTS]
      : undefined
    if (!Comp) return false
    render(createVNode(Comp, { size: 12 }), host)
    return true
  },
  t: (key: string) => t(key),
}
provide(ComposerInputDepsKey, composerInputDeps)

// Fork/Handoff 模式 API 暴露：modeRef 是 {value} 包装对象（非 ref 不被 defineExpose 解包）
defineExpose({
  forkMode: fork.forkModeRef,
  enterForkMode: fork.enterForkMode,
  exitForkMode: fork.exitForkMode,
  handoffMode: handoff.handoffModeRef,
  enterHandoffMode: handoff.enterHandoffMode,
  exitHandoffMode: handoff.exitHandoffMode,
  // 派生提交守卫（ref 解包为 boolean）：测试断言 staging 双发锁 / streaming 放行分支用
  canSubmit,
})
</script>
