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
      :project-skills="projectSkills"
      :global-skills="globalSkills"
      :selected-skill-names="selectedSkillNames"
      :query="popoverQuery"
      :shell-input-ref="shellInputHolder.ref"
      @select="onCmdSelect"
      @select-and-send="onSelectAndSend"
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
        <!-- 顶部元信息行（u4 mode-visibility-chip）：对话态只读模式 chip（**仅非默认模式**渲染，
             设计 D5）+ landing 态 slot（directory/branch/模式选择 chip，panel 态不传 slot 即空）。 -->
        <div v-if="modeChipPresetId" class="flex min-w-0 items-center px-2.5 pt-2.5">
          <PresetChip :preset-id="modeChipPresetId" :fallback-to="modeChipFallbackTo" />
        </div>
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

      <!-- 底栏三簇（D6 修订「三步聚合」）：左簇（`+` / 托盘 / 插件 toolbar，shrink-0）· 中簇（可压缩占位）·
           右簇（指标 / 模型+思考 / 发送位，shrink-0 且发送位右锚）。**flex-nowrap 永不换行**；
           逐组形态由密度状态机（ResizeObserver 实测两簇占宽 vs 可用宽 → composer-density）驱动，
           累计三步退化：序 0 发送位/`+` 不退化不裁剪 · 序 1 左簇收**单图标**聚合按钮 · 序 2 指标收
           单图标聚合按钮（hover 聚合页）· 序 3 模型+思考收单图标聚合按钮（click 弹层 + hover 行内
           切换；非聚合态模型名**恒完整展示**，无截断态）· 顶格仍溢出 → 锚点保护（中部让位）。
           禁硬编码 px 断点（判据全在实测回路，`»` 省略号入口已退役）。
           左右两簇挂 data-composer-cluster：fit 回路据二者占宽之和判「放不放得下」（中簇可压到 0）。 -->
      <div
        ref="composerBarRef"
        data-testid="composer-bar"
        :data-fit="density.fitLevel"
        :data-anchor-protected="density.anchorProtected ? 'true' : undefined"
        :data-slot-left-cluster="density.slots.leftCluster"
        :data-slot-metrics="density.slots.metrics"
        :data-slot-model-thinking="density.slots.modelThinking"
        class="composer-bar flex flex-nowrap items-center justify-end gap-0 px-2.5 pb-2 mt-1"
      >
        <!-- 左簇：`+`（序 0，不退化不裁剪）/ 任务托盘（左簇唯一聚合入口：aggregated 时单图标按钮
             承载托盘分段 + 插件 toolbar）/ 展开态插件 toolbar 挂载点 -->
        <div data-composer-cluster="left" class="flex min-w-0 shrink-0 items-center gap-0.5">
          <AddMenuPopover @select="onAddSelect" />
          <!-- 任务托盘（设计 docs/design/composer-task-tray.md——已删除，git 可追溯——D1：`+` 之后、composer.toolbar 之前）。
               landing 态隐藏与 GenStatsTriggers / ContextCapacityPopover 同判据（无 session 无任务面）。
               aggregated = 序 1 生效：托盘 + 插件 toolbar 收为**单图标**聚合按钮（角标仅运行数数字，
               禁多 icon 重叠），面板内分段展示。
               **挂载条件刻意只门锚点保护，不吃 `leftCluster === 'absent'`**：`update:has-items` 的
               emitter 活在本组件内，若按「无条目」卸载托盘，标志永冻 false → 切回有条目会话时
               托盘永不重挂（e2e workflow-sidebar-sync T2 死锁回归）。无条目/零贡献的「不留死入口」
               由托盘内部三态（逐件不渲染）与聚合按钮自身可见条件（有条目或有贡献才出）承接。
               @update:has-items = 托盘三态上抛（托盘数据面唯一实例在外壳，Composer 不建第二份）。 -->
          <ComposerTray
            v-if="sessionId && !density.anchorProtected"
            :session-id="sessionId"
            :aggregated="density.slots.leftCluster === 'aggregated'"
            @update:has-items="onTrayItemsChange"
          />
          <!-- ExtensionHost composer.toolbar 挂载点（audit §12.1，MountPointRegistry composer.toolbar）。
               展开态渲染（零贡献时 empty=hidden 零 DOM）；序 1 聚合后本处不渲染，同一挂载点 view
               改在托盘聚合面板内渲染（仍是同一份缓存）。[HISTORICAL] `»` Ellipsis 溢出菜单已随
               三步聚合退役（底栏不再有省略号入口）。 -->
          <ViewHost
            v-if="sessionId && density.slots.leftCluster === 'expanded'"
            view-id="composer.toolbar"
            :session-id="sessionId"
            empty="hidden"
          />
        </div>
        <!-- 中簇：可压缩占位（宽度不足时只压它，两簇元素不因换行漂位） -->
        <span class="min-w-0 flex-1" />

        <!-- 右簇：指标 / 模型+思考 / 发送位（shrink-0，发送位右锚不漂移） -->
        <div data-composer-cluster="right" class="flex min-w-0 shrink-0 items-center gap-0">
          <!-- 序 2：指标（容量 + 速度 + 缓存）。展开 = 三触发器平铺（各自浮层保留为再入路径）；
               aggregated = **单图标**聚合按钮（hover 弹指标聚合页，容量/速度/缓存三段全量）；
               absent = 锚点保护让位（不渲染）。landing（无 session）不渲染。 -->
          <div
            v-if="sessionId && density.slots.metrics !== 'absent'"
            :class="density.slots.metrics === 'aggregated' ? AGGREGATE_GROUP_CLASS : EXPANDED_GROUP_CLASS"
          >
            <ComposerMetricsAggregate
              v-if="density.slots.metrics === 'aggregated'"
              :session-id="sessionId"
              :model-id="currentModelId"
            />
            <template v-else>
              <!-- 生成指标双触发器（composer-gen-stats §3.1：速度 t/s + 缓存命中率 %，位于上下文容量左侧）。
                   landing（无 session，尚未开始）隐藏：无采样无用量，两项恒「—」横线无信息量。
                   [HISTORICAL] variant（simplified/iconic 中间态）已随三步聚合退役——收不完就整组聚合。 -->
              <GenStatsTriggers :session-id="sessionId" :model-id="currentModelId" />
              <!-- 上下文容量（spec §2a：hover 出容量 popover；session 通道订阅 context.update） -->
              <ContextCapacityPopover :session-id="sessionId" :model-id="currentModelId" />
            </template>
          </div>
          <!-- 序 3：模型 + 推理档位。展开 = 模型名**恒完整展示**（无 88/56px 截断态）+ 档位按钮；
               aggregated = **单图标**聚合按钮（click 弹模型列表+思考档位，hover 行内即切换，D2）。 -->
          <div
            :class="density.slots.modelThinking === 'aggregated' ? AGGREGATE_GROUP_CLASS : EXPANDED_GROUP_CLASS"
          >
            <ModelThinkingAggregate
              v-if="density.slots.modelThinking === 'aggregated'"
              :selected="currentModelId"
              :level="currentThinkingLevel"
              :level-map="currentThinkingLevelMap"
              :supported-levels="currentSupportedLevels"
              @select-model="onModelSelect"
              @select-thinking="onThinkingSelect"
            />
            <template v-else>
              <!-- 模型（spec §2b：click 出模型切换 popover） -->
              <ModelSelectPopover :selected="currentModelId" @select="onModelSelect" />
              <!-- 思考等级（spec §2c：click 出档位 popover；level 从 session 透传；reasoning 决定可用档集） -->
              <ThinkingLevelPopover :level="currentThinkingLevel" :level-map="currentThinkingLevelMap" :supported-levels="currentSupportedLevels" @select="onThinkingSelect" />
            </template>
          </div>

          <!-- 发送位四态（u6b / D6 表「发送位」列·序 0 不退化）：staging（fork/handoff，含 streaming 中）→
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
    </div>
    </CommandPopover>

  </div>
</template>

<script setup lang="ts">
import { computed, createVNode, nextTick, provide, ref, render, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUp, Clock, Loader2, Square, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { ComposerInput, ComposerInputDepsKey, type ComposerInputDeps } from '@taiji/ui/features/composer'
import { ViewHost } from '@taiji/ui/extension-host'
import AddMenuPopover from './AddMenuPopover.vue'
import ComposerTray from './tray/ComposerTray.vue'
import CommandPopover from './CommandPopover.vue'
import ContextCapacityPopover from './ContextCapacityPopover.vue'
import GenStatsTriggers from './GenStatsTriggers.vue'
import ModelSelectPopover from './ModelSelectPopover.vue'
import ThinkingLevelPopover from './ThinkingLevelPopover.vue'
import ComposerMetricsAggregate from './ComposerMetricsAggregate.vue'
import ModelThinkingAggregate from './ModelThinkingAggregate.vue'
import ContextChipsBar from './ContextChipsBar.vue'
import RetryIndicator from './RetryIndicator.vue'
import QueueBubble from './QueueBubble.vue'
import PresetChip from './PresetChip.vue'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useProjectSkills, useGlobalSkills } from '@/composables/features/settings/useProjectSkills'
import { useNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow'
import { useCommandPopoverTrigger } from '@/composables/panel/useCommandPopoverTrigger'
import { useDeferQueueRows } from '@/composables/panel/useDeferQueueRows'
import { useComposerModeChip } from '@/composables/panel/useComposerModeChip'
import { useComposerFocusRing } from '@/composables/panel/composer-focus-ring'
import {
  useComposerBarDensity,
  AGGREGATE_GROUP_CLASS,
  EXPANDED_GROUP_CLASS,
} from '@/components/panel/tray/use-composer-bar-density'
import { useComposerShell, createComposerDrafts, type ShellInputInstance } from '@/composables/panel/composer-shell'
import { useComposerKeydown } from '@/composables/panel/composer-keydown'
import { useCompositionFlag } from '@/composables/panel/composition-flag'
import type { DraftStore } from '@taiji/dom-core/composer/input'
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
/** 底栏密度接线（D6 修订「三步聚合」）：ResizeObserver 实测溢出 → `density`（逐组形态 / fit 级 / 锚点
 * 保护）；判据与退化序全在 `composer-density.ts` + 本件测量回路，本处零 px 常量（容器 class 见接线件导出）。 */
const { barRef: composerBarRef, density, onTrayItemsChange } = useComposerBarDensity(
  computed(() => props.sessionId),
)
const chatStore = useChatStore()
const sessionStore = useSessionStore()
const flow = useNewTaskFlow()
// 对话态只读模式 chip（u4，判据与 E7 三态闸见 useComposerModeChip）
const { modeChipPresetId, modeChipFallbackTo } = useComposerModeChip(() => props.sessionId, () => props.variant)
// 项目 skill 的 cwd 源（ADR-0050 修订）：panel 态 = sessionStore 投影的 session cwd（创建时锁定，
// split mode 各 pane 各自 session 天然分流）；landing 态 = flow.currentCwd（嵌套 ComputedRef 须显式 .value）
const projectSkillsCwd = computed<string | null>(() => {
  if (props.variant === 'panel') {
    if (!props.sessionId) return null
    return sessionStore.list.find((s) => s.id === props.sessionId)?.cwd ?? null
  }
  return flow.currentCwd?.value ?? null
})
const { projectSkills } = useProjectSkills(projectSkillsCwd) // W3 ADR-0051：当前 cwd 项目 skill（两态接线见上）
const { globalSkills } = useGlobalSkills() // W4 FR-5：全局 skill（skill 段两态共用）
const isActive = computed(() => {
  if (!props.sessionId) return false
  return chatStore.isActive(props.sessionId)
})

/** #13 retry/queue 指示位数据源（store 由 W0/#8 维护，不可变 Map 更新触发响应） */
const retryState = computed(() => (props.sessionId ? chatStore.getRetryState(props.sessionId) : undefined))
const queueState = computed(() => (props.sessionId ? chatStore.getQueueState(props.sessionId) : undefined))

const draft = ref('')
const inputRef = ref<InstanceType<typeof ComposerInput> | null>(null)
// W4：shell 的 input 契约是结构类型 ShellInputInstance（ui 包 ComposerInput 实例含全部 expose
// 方法，与契约结构兼容）——Vue 实例类型含 props/emits，无法直接赋给结构契约 ref，故此处断言传递
const shellInputRef = inputRef as Ref<ShellInputInstance | null>
// 模板顶层 ref 会被渲染代理解包成值——经普通对象字段中转保活「传引用」语义（通道缺口③，fail-closed 见 CommandPopover）
const shellInputHolder = { ref: shellInputRef }

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
  onSelectAndSend,
  // 第三参 = 晚绑定闭包：本调用先于 useComposerKeydown，事件发生时 onKeydown（dispatchEnter 链）已就绪
} = useCommandPopoverTrigger(shellInputRef, sessionIdRef, (e) => onKeydown(e))

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
// [u6b] 本地 isCompacting computed 已退役：压缩维度唯一读口 = shell sendButtonState（与 sendRoute 同源）

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
  cmdOpen,
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
  shortcutActions: shell.shortcutActions,
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
