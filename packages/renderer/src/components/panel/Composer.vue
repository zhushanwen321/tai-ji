<!-- split-justified: composer 容器域（发送四态 + steer/followUp/defer 统一路由 + staging 优先 + 子组件装配——composer-shell 迁移后的视觉壳与面板装配汇聚点，多轨特性天然在同一容器接线） -->
<template>
  <!--
    容器组件 · composer（panel/spec.md zone ④，draft-composer-states）。
    发送位四态（u6b / D6 表）：send（↑ idle 直发）/ stop（■ turn 活跃 dispatching|generating 无 compacting；settling 单独；
    **compacting 任意 turn 组合——中止压缩流程**）/ queue（↑ 时钟角标：bash、settling+bash，点击统一提交——排队 lane 由内核裁定）/
    spinner（isSending）。staging 模式优先（fork/handoff）。
    steer/followUp/queued 路由：⏎/Alt+⏎ 全部汇入统一发送分发器（D6，composer-shell
    sendRoute——turn 活跃→steer、占用→queued、idle→direct），Alt+⏎ 在 steer 路由行保留
    followUp 语义。**按钮形态与 Enter 车道分立**：压缩期按钮是「终止压缩」（中止入口），⏎ 仍走
    内核 queued 排队（compaction-end flush）——两问题不混谈（2026-10 用户裁决）。
    staging 优先（fork/handoff，与视觉层 boxClass/placeholder 优先级对齐）：staging 活跃时 ⏎/Alt+⏎
      均提交 staging（发送位也替换为 staging 发送按钮，streaming 中同样生效）；handoff 的
      streaming 拦截在 enterHandoffMode/handleHandoffSend（isSessionActive 检查）。

    [W4 迁移] 壳改写：消费 composer-shell.ts（core dispatch/context/model-thinking deps 组装 +
    视觉派生），ComposerInput 从 ui 包渲染（D5 占位：壳内硬编码渲染，P4 ExtensionHost 前不走
    contribution 路由）。子组件（CommandPopover/AddMenu/ModelSelect 等）留壳，不在本 wave 范围。
  -->
  <!-- 宽度契约：恒 content-col（居中 + 封顶 --content-max-w），与消息列（Turn 根）/FormOverlay 同一内容列——composer 与消息流同宽同缘，overlay 互斥替换不跳变；landing 消费 Landing 根覆写的 --content-max-w=720 阅读列。[HISTORICAL] 曾按 demo .composer 无 max-width 做 panel 全宽（band padding 承接 14px 外距），与消息列 720 居中不同缘，用户裁决回归内容列。 -->
  <div class="composer content-col">
    <!-- retry/queue 指示位（spec C10，#13，composer 上方独立行）：
         auto_retry_end / message_start 到达时 store 自动清 → state=undefined → 组件 v-if 消失 -->
    <RetryIndicator :state="retryState" />
    <!-- 命令浮层（§2d @/#//）：anchor = composer-box（slot），reka-ui Popover portal body。
         composer-box 内 focus 算 inside 不触发 dismiss，键盘路由见 onKeydown。
         cwd：landing 态 $ 候选的 cwd 通道（landing-composer-session-file-symbols D2；
         panel 有 sid 不消费。flow.currentCwd 是普通对象内嵌套 ComputedRef，模板不自动
         解包，须显式 .value；缺失即无 cwd 不弹，与 S4b 空态语义一致） -->
    <CommandPopover
      ref="commandPopoverRef"
      v-model:open="cmdOpen"
      :type="cmdType"
      :session-id="sessionId ?? undefined"
      :cwd="flow.currentCwd.value"
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
        class="composer-box relative border bg-bg"
        :class="[boxClass, focusRingClass, boxRadiusClass]"
        data-testid="composer-box"
        @dragover.prevent="onDragOver"
        @dragleave.prevent="onDragLeave"
        @drop.prevent="onDrop"
      >
        <!-- QueueBubble（v6 §8.5：内嵌 composer-box 顶部，去独立卡片/pulse/标签/chevron，
             仅 border-b 分隔）——6 区第 1 位。
             [u3c/D7 单源化] 行数据 = session.delivery 状态帧派生视图（useQueueRows），
             × 撤销 → delivery.cancel、failed 行重试 → delivery.resync -->
        <QueueBubble
          :rows="queueRows"
          :hint="queueHint"
          @cancel="onCancelQueueEntry"
          @retry="onRetryQueueEntry"
        />
        <!-- Staging 模式 banner（fork/handoff 统一，demo .mode-banner 形态对齐）：composer-box 顶缘
             整条横幅，图标染 accent = 模式在途唯一染色点（标题粗体中性 fg，描述 fg-2，× 中性）。
             [HISTORICAL] 前身 mode-chip（accent-soft 底 + accent 字 + accent × + placeholder/box
             整框染色）已随 banner 形态整体退役。经 staging.activeStaging 统一渲染（ADR-0057），
             退出调 staging.exit()（Esc / 发送 / 切 session 三路退出链不变） -->
        <div v-if="staging.activeStaging.value" class="mx-2 mt-2 flex items-center gap-[8px] rounded-[var(--radius)] border border-border bg-bg-card px-2.5 py-[6px]"
          :data-testid="staging.activeStaging.value.type === 'fork' ? 'composer-mode-banner' : 'composer-handoff-banner'"
        >
          <component :is="staging.activeStaging.value.visual.chipIcon" class="size-[14px] shrink-0 text-accent" :stroke-width="1.8" />
          <span class="min-w-0 flex-1 truncate text-[length:var(--text-xs)] text-neutral-fg-2">
            <span class="text-neutral-fg [font-weight:var(--fw-mid)]">{{ stagingBannerTitle }}</span> · {{ stagingBannerDesc }}
          </span>
          <Button variant="ghost" size="icon" class="size-[22px] rounded-[var(--radius-sm)] p-0 text-neutral-dim hover:text-neutral-fg" :title="staging.activeStaging.value.type === 'fork' ? t('panel.composer.forkExit') : t('panel.composer.handoffExit')" @click="staging.exit">
            <X class="size-[12px]" :stroke-width="2" />
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

      <!-- 底栏三簇（「三步聚合」目标次序 = 指标 → 左簇 → 模型）：左簇（`+` / btw / 托盘 /
           插件 toolbar + headerAction，shrink-0）· 中簇（可压缩占位）· 右簇（指标 / 模型+思考 /
           发送位，shrink-0 且发送位右锚）。**flex-nowrap 永不换行**；逐组形态由密度状态机
           （ResizeObserver 实测两簇占宽 vs 可用宽 → composer-density）驱动：序 0 发送位/`+`/btw
           不退化不裁剪 · 序 1 指标 L1 起收**单图标**聚合按钮（hover 聚合页；右簇信息先让位）·
           序 2 左簇收**单图标**聚合按钮 · 序 3 模型+思考收单图标聚合按钮（click 弹层 + hover
           行内切换；非聚合态模型名**恒完整展示**，无截断态）· 顶格仍溢出 → 锚点保护（中部让位）。
           禁硬编码 px 断点（判据全在实测回路，`»` 省略号入口已退役）。左右两簇挂
           data-composer-cluster：fit 回路据二者占宽之和判「放不放得下」（中簇可压到 0）。 -->
      <div
        ref="composerBarRef"
        data-testid="composer-bar"
        :data-fit="density.fitLevel"
        :data-anchor-protected="density.anchorProtected ? 'true' : undefined"
        :data-slot-left-cluster="density.slots.leftCluster"
        :data-slot-metrics="density.slots.metrics"
        :data-slot-model-thinking="density.slots.modelThinking"
        class="composer-bar flex flex-nowrap items-center justify-end gap-0 px-2.5 pb-2.5 mt-1.5"
      >
        <!-- 左簇（landing 不渲染：demo ComposerBar 同判据「左簇挂载 = 有 session」，空态卸载——
             r4 landing 对齐修复：原 AddMenuPopover 无 sessionId 检查，空态左下角多出一颗「+」）：
             `+`（序 0，不退化不裁剪）/ btw 旁路提问（序 0，退化序登记见
             use-composer-bar-density COMPOSER_BTW_BUTTON_DEGRADATION_ORDER）/ 任务托盘
             （左簇唯一聚合入口：aggregated 时单图标按钮承载托盘分段 + 插件 toolbar）/
             展开态插件 toolbar 挂载点 -->
        <div v-if="sessionId" data-composer-cluster="left" class="flex min-w-0 shrink-0 items-center gap-[4px]">
          <AddMenuPopover @select="onAddSelect" />
          <!-- plugin headerAction 挂载点（demo 裁决落点 = composer 左簇、「+」之后；用户裁决
               2026-10-06）。显隐由 hidden 管线唯一裁决：无任务插件推 hidden=true → 列表构建层
               剔除，零 DOM 不渲染；无声明同样零 DOM。密度归属（demo composer-bar spec §2.1/§4.2
               B3：L2 聚合范围 = 定时任务 + 托盘 → layers 单钮）：expanded 在左簇渲染；aggregated
               起摘除、同一挂载点数据源改在托盘聚合面板首段渲染（与插件 toolbar 同构）；
               anchorProtected 随托盘折叠（L4）。 -->
          <HeaderActionsHost v-if="sessionId && density.slots.leftCluster === 'expanded'" :session-id="sessionId" />
          <!-- btw 入口（btw-question D7，M3-b）：`+` 之后、托盘之前。show-btw 实例开关
               （false 不出按钮——drawer 内 BtwPanel 的 Composer 传 false 防递归出 btw 入口）；
               无 session 不出（与托盘同判据，badge 数据范围需主会话）。点击 = openDrawerTab('btw')，
               badge = useBtwTabData 聚合 Σ unread（清除 = 线内容进视口）。 -->
          <ComposerBtwButton v-if="showBtw && sessionId" :session-id="sessionId" :class="btwSpacingClass" />
          <!-- 任务托盘（设计 docs/design/composer-task-tray.md——已删除，git 可追溯——D1：`+` 之后、composer.toolbar 之前）。
               挂载/可见拆两层：v-if="sessionId"（landing 态卸载，与指标聚合按钮同判据，无 session 无任务面）；
               锚点保护态 v-show 样式折叠
               **不卸载**——`update:has-items` 的 emitter 与 useTrayCounts 数据范围唯一实例都活在
               本组件内，保护态阈值附近的宽度抖动（拖拽窗口/分屏）每次 protect/unprotect 往返
               若走 v-if 都会重订阅 + 重首次拉取。
               aggregated = 序 2 生效：托盘 + 插件 toolbar 收为**单图标**聚合按钮（角标仅运行数数字，
               禁多 icon 重叠），面板内分段展示。
               **可见性不吃 `leftCluster === 'absent'`**：若按「无条目」卸载托盘，emitter 永冻
               false → 切回有条目会话时托盘永不重挂（e2e workflow-sidebar-sync T2 死锁回归）。
               无条目/零贡献的「不留死入口」由托盘内部三态（逐件不渲染）与聚合按钮自身可见条件
               （有条目或有贡献才出）承接。
               @update:has-items = 托盘三态上抛（托盘数据范围唯一实例在外壳，Composer 不建第二份）。 -->
          <ComposerTray
            v-if="sessionId"
            v-show="!density.anchorProtected"
            :session-id="sessionId"
            :aggregated="density.slots.leftCluster === 'aggregated'"
            @update:has-items="onTrayItemsChange"
          />
          <!-- ExtensionHost composer.toolbar 挂载点（audit §12.1，MountPointRegistry composer.toolbar）。
               展开态渲染（零贡献时 empty=hidden 零 DOM）；序 2 聚合后本处不渲染，同一挂载点 view
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
        <div data-composer-cluster="right" class="flex min-w-0 shrink-0 items-center gap-[4px]">
          <!-- 序 1：指标（容量 + TTFT + 速度 + 缓存）。expanded（fit 0）= 纯文本触发器平铺
               （TTFT / 速度 / 缓存 + 容量，各自 hover 浮层保留为再入路径，demo `.mtr-exp` 同款）；
               aggregated（L1 起，右簇信息先让位）= **单图标**聚合按钮（hover 弹指标聚合页，
               容量/TTFT/速度/缓存四卡全量）；absent = 锚点保护让位（不渲染）。landing（无 session）不渲染。 -->
          <div
            v-if="sessionId && density.slots.metrics !== 'absent'"
            :class="density.slots.metrics === 'aggregated' ? AGGREGATE_GROUP_CLASS : EXPANDED_GROUP_CLASS"
          >
            <ComposerMetricsAggregate v-if="density.slots.metrics === 'aggregated'" :session-id="sessionId" :model-id="currentModelId" />
            <template v-else>
              <GenStatsTriggers :session-id="sessionId" :model-id="currentModelId" />
              <ContextCapacityPopover :session-id="sessionId" :model-id="currentModelId" />
            </template>
          </div>
          <!-- 序 3：模型 + 推理档位。展开 = 模型名**恒完整展示**（无 88/56px 截断态）+ 档位按钮
               （组容器 = demo 行 gap 4px 对齐位 EXPANDED_MODEL_THINKING_GROUP_CLASS）；
               aggregated = **单图标**聚合按钮（click 弹模型列表+思考档位，hover 行内即切换，D2），
               ml-[8px] 还原 demo L3 下「Gauge ↔ Boxes」12px（demo 由 mt-exp 两个零宽 pop-anchor
               的行 gap 叠出，real 是 v-if 摘除，故补在组容器左距）。
               组间距条件值见 modelThinkingGroupClass 注释（r4 项 3/4，接线件 useComposerSpacingClasses）。 -->
          <div :class="modelThinkingGroupClass">
            <ModelThinkingAggregate
              v-if="density.slots.modelThinking === 'aggregated'"
              :selected="currentModelId"
              :level="currentThinkingLevel"
              :level-map="currentThinkingLevelMap"
              :supported-levels="currentSupportedLevels"
              :switching="isSwitching"
              @select-model="onModelSelect"
              @select-thinking="onThinkingSelect"
            />
            <template v-else>
              <!-- 模型（spec §2b：click 出模型切换 popover；U4 切换中 = 转圈 + 锁开合/点选） -->
              <ModelSelectPopover :selected="currentModelId" :switching="isSwitching" @select="onModelSelect" />
              <!-- 思考等级（spec §2c：click 出档位 popover；level 从 session 透传；reasoning 决定可用档集；U4 同上） -->
              <ThinkingLevelPopover :level="currentThinkingLevel" :level-map="currentThinkingLevelMap" :supported-levels="currentSupportedLevels" :switching="isSwitching" @select="onThinkingSelect" />
            </template>
          </div>

          <!-- 发送位四态（u6b / D6 表「发送位」列·序 0 不退化）：staging（fork/handoff，含 streaming 中）→
             stop（■ 中止：turn 活跃 dispatching|generating 无 compacting；settling 单独；**compacting 任意 turn 组合——
             点击中止压缩流程，title 分型「终止压缩」**）/ queue（bash、settling+bash）→ ↑ 带时钟角标（可点入队，flush 于占用
             解除后自动投递）/ S5 sending→spinner / 全 idle→send。
             派生源 = shell sendButtonState（与分发器 sendRoute 同源 effectivePhase）。
             **按钮形态与 Enter 车道故意分立**（2026-10 用户裁决）：按钮回答「现在能中止什么」（忙 → 终止钮，
             压缩期中止对象是压缩流程本身），Enter 回答「消息走哪条车道」（compacting → 内核 queued 排队，
             compaction-end flush）——压缩期排队提交走 ⏎，按钮位专作中止入口，不再二选一。
             staging 优先于 stop（用户决策）：streaming 中提交 fork 合法（对源只读）；需停止时
             先 Esc 退出 staging 再点 stop。staging 发送中（isSending）仍走 spinner。 -->
        <Button
          v-if="staging.activeStaging.value && !isSending"
          variant="default"
          size="icon"
          class="ml-[4px] size-[var(--composer-btn-size)] rounded-md bg-accent text-accent-fg transition-colors enabled:hover:bg-accent-hover disabled:bg-accent-soft disabled:text-neutral-mid disabled:opacity-100"
          :disabled="!canSubmit"
          :data-testid="staging.activeStaging.value.type === 'fork' ? 'fork-send-btn' : 'handoff-send-btn'"
          :title="staging.activeStaging.value.type === 'fork' ? t('panel.composer.forkSend') : t('panel.composer.handoffSend')"
          @click="onSendClick"
        >
          <ArrowUp class="size-[16px]" />
        </Button>
        <Button
          v-else-if="sendButtonState === 'stop'"
          variant="ghost"
          size="icon"
          class="stop-btn ml-[4px] size-[var(--composer-btn-size)] rounded-md bg-surface-hover text-neutral-mid hover:bg-danger-soft hover:text-danger"
          :title="sendButtonStopTarget === 'compacting' ? t('panel.composer.stopCompacting') : t('panel.composer.stop')"
          @click="onStopClick"
        >
          <Square class="size-[13px]" />
        </Button>
        <Button
          v-else-if="sendButtonState === 'queue'"
          variant="default"
          size="icon"
          class="queue-send-btn relative ml-[4px] size-[var(--composer-btn-size)] rounded-md bg-accent text-accent-fg transition-colors enabled:hover:bg-accent-hover disabled:bg-accent-soft disabled:text-neutral-mid disabled:opacity-100"
          :disabled="!canSubmit"
          :title="canSubmit ? `${t('panel.composer.queueSend')} · ⏎` : t('panel.composer.sendHint')"
          @click="onSendClick"
        >
          <ArrowUp class="size-[16px]" />
          <!-- 时钟角标（D6 场景 1）：排队语义视觉锚点，右上角 1/4 尺寸 -->
          <Clock class="absolute right-[2px] top-[2px] size-[8px]" aria-hidden="true" />
        </Button>
        <!-- 发送中 spinner = 呼吸弧（chat 域统一 loader 规格同构：15px accent + 三重动画）。
             svg 骨架与 ui 包 RUNNING_LOADER_SVG 同构（该常量未在 ui 包 exports 白名单，
             共享需动 package.json 归交接项）；弧段动画原语 .ld-track/.ld-arc 仍由
             style.css 全局单源承载，此处仅静态属性无独立样式。 -->
        <div
          v-else-if="isSending"
          class="ml-[4px] grid size-[var(--composer-btn-size)] place-items-center rounded-md bg-accent text-accent-fg"
          :title="t('panel.composer.sending')"
        >
          <span class="inline-block size-[15px] animate-loader-spin" aria-hidden="true">
            <svg
              class="size-full"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle class="ld-track" cx="12" cy="12" r="10" opacity="0.16" />
              <circle class="ld-arc" cx="12" cy="12" r="10" pathLength="100" />
            </svg>
          </span>
        </div>
        <Button
          v-else
          variant="default"
          size="icon"
          class="ml-[4px] size-[var(--composer-btn-size)] rounded-md bg-accent text-accent-fg transition-colors enabled:hover:bg-accent-hover disabled:bg-accent-soft disabled:text-neutral-mid disabled:opacity-100"
          :disabled="!canSubmit"
          :title="canSubmit ? `${t('panel.composer.send')} · ⏎` : t('panel.composer.sendHint')"
          @click="onSendClick"
        >
          <ArrowUp class="size-[16px]" />
        </Button>
        </div>
      </div>

        <!-- 顶缘容量细条（ui-optimize 决策 6 / N7）：2px 色阶预警条，只显分档不显数字
             （精确读数在指标聚合按钮 hover 页）；数字 aria 提示见组件自身。 -->
        <ComposerCapacityBar v-if="sessionId" :session-id="sessionId" />
    </div>
    </CommandPopover>

  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUp, Clock, Square, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { ComposerInput } from '@taiji/ui/features/composer'
import { ViewHost } from '@taiji/ui/extension-host'
import HeaderActionsHost from '@/components/extension/HeaderActionsHost.vue'
import AddMenuPopover from './AddMenuPopover.vue'
import ComposerBtwButton from './tray/ComposerBtwButton.vue'
import ComposerTray from './tray/ComposerTray.vue'
import CommandPopover from './CommandPopover.vue'
import ModelSelectPopover from './ModelSelectPopover.vue'
import ThinkingLevelPopover from './ThinkingLevelPopover.vue'
import ComposerMetricsAggregate from './ComposerMetricsAggregate.vue'
import ComposerCapacityBar from './ComposerCapacityBar.vue'
import GenStatsTriggers from './GenStatsTriggers.vue'
import ContextCapacityPopover from './ContextCapacityPopover.vue'
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
import { useQueueRows } from '@/composables/panel/useQueueRows'
import { useComposerModeChip } from '@/composables/panel/useComposerModeChip'
import { useComposerFocusRing } from '@/composables/panel/composer-focus-ring'
import {
  useComposerBarDensity, useComposerSpacingClasses, AGGREGATE_GROUP_CLASS, EXPANDED_GROUP_CLASS,
} from '@/components/panel/tray/use-composer-bar-density'
import { useComposerShell, createComposerDrafts, type ShellInputInstance } from '@/composables/panel/composer-shell'
import { useComposerKeydown } from '@/composables/panel/composer-keydown'
import { useCompositionFlag } from '@/composables/panel/composition-flag'
import type { DraftStore } from '@taiji/dom-core/composer/input'
import { provideComposerInputDeps } from '@/composables/panel/composer-input-deps'

const props = withDefaults(
  defineProps<{
    sessionId: string | null
    variant?: 'panel' | 'landing'
    /** btw 入口实例开关（D7，M3-b）：false 不出按钮（drawer 内 BtwPanel 的 Composer 传 false 防递归出 btw 入口；不传默认 true，主 panel 零改动） */
    showBtw?: boolean
  }>(),
  { variant: 'panel', showBtw: true },
)

const { t } = useI18n()
const sessionIdRef = computed(() => props.sessionId)
/** 底栏密度接线（D6 修订「三步聚合」）：ResizeObserver 实测溢出 → `density`（逐组形态 / fit 级 / 锚点
 * 保护）；判据与退化序全在 `composer-density.ts` + 本件测量回路，本处零 px 常量（容器 class 见接线件导出）。 */
const { barRef: composerBarRef, density, onTrayItemsChange } = useComposerBarDensity(sessionIdRef)
// 右簇组容器 / btw 左间距的档位条件值（r4 视觉对齐，判据与 demo 权威值见接线件注释）
const { modelThinkingGroupClass, btwSpacingClass } = useComposerSpacingClasses(sessionIdRef, density)
const chatStore = useChatStore()
const sessionStore = useSessionStore()
const flow = useNewTaskFlow()
// 对话态只读模式 chip（u4，判据与 E7 三态闸见 useComposerModeChip）
const { modeChipPresetId, modeChipFallbackTo } = useComposerModeChip(() => props.sessionId, () => props.variant)
// 项目 skill 的 cwd 源（ADR-0050 修订）：panel 态 = sessionStore 派生视图的 session cwd（创建时锁定，split 各 pane 天然分流）；landing 态 = flow.currentCwd（嵌套 ComputedRef 须显式 .value）
const projectSkillsCwd = computed<string | null>(() => {
  if (props.variant === 'panel') {
    if (!props.sessionId) return null
    return sessionStore.list.find((s) => s.id === props.sessionId)?.cwd ?? null
  }
  return flow.currentCwd.value
})
const { projectSkills } = useProjectSkills(projectSkillsCwd) // W3 ADR-0051：当前 cwd 项目 skill（两态接线见上）
const { globalSkills } = useGlobalSkills() // W4 FR-5：全局 skill（skill 段两态共用）
const isActive = computed(() => (props.sessionId ? chatStore.isActive(props.sessionId) : false))

/** composer-box 圆角分档（demo 同款）：panel = --radius-lg 12px（workbench.css .composer-box）；
 *  landing = --radius 8px（unpacked.css .landing .composer，M9 交接项对齐）。 */
const boxRadiusClass = computed(() => (props.variant === 'landing' ? 'rounded' : 'rounded-lg'))

/** #13 retry 指示位数据源（store 由 W0/#8 维护，不可变 Map 更新触发响应）。[u3c] queueState 已退役：队列区数据源收敛为 session.delivery 帧派生视图（useQueueRows）。 */
const retryState = computed(() => (props.sessionId ? chatStore.getRetryState(props.sessionId) : undefined))

const draft = ref('')
const inputRef = ref<InstanceType<typeof ComposerInput> | null>(null)
// W4：shell input 契约是结构类型 ShellInputInstance（ComposerInput 实例结构兼容）——Vue 实例类型含 props/emits 无法直接赋给结构契约 ref，故断言传递
const shellInputRef = inputRef as Ref<ShellInputInstance | null>
// 模板顶层 ref 会被渲染代理解包成值——经普通对象字段中转保活「传引用」语义（通道缺口③，fail-closed 见 CommandPopover）
const shellInputHolder = { ref: shellInputRef }

/**
 * U4「切换中」（设计 §5.1 U4 语义②③）：core 的 `switching` 是**每实例**瞬态真值，
 * 但读条件必须判 `sessionId` 等值——split 面板/切 session 后不得残留旧面板的「切换中」，
 * 也不得误禁新 session 的 chip；语义③ = **任一在途即禁全部模型/档位 chip**（防两条
 * 切换 RPC 并发 → 回执乱序与 `session.modelId` 双写竞争），故两个 chip 共用同一布尔。
 */
const isSwitching = computed(
  () => switching.value !== null && switching.value.sessionId === sessionIdRef.value,
)

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
 * 已插入 skill 名集合（多 skill 注入 D2 已选禁选数据范围）：从 composer 当前 segments 取，
 * 透传 CommandPopover.selectedSkillNames。显式刷新（非 computed）——getSegments 读 DOM
 * 非响应式，随 onInputChange 同步刷新（chip 插入/删除走 onChanged → emit input，
 * 与 refreshAttachedItems 同一模式）。
 */
const selectedSkillNames = ref<string[]>([])

const isSending = ref(false)
// [u6b] 本地 isCompacting computed 已退役：压缩维度唯一读口 = shell sendButtonState / sendButtonStopTarget
// （与 sendRoute 同源 effectivePhase；压缩期按钮 = stop，title 分型见 sendButtonStopTarget——
//   仅 turn 非生成中的压缩（idle /compact、settling+overflow）标「终止压缩」，生成中压缩标「停止」）

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
  switching,
  onModelSelect,
  onThinkingSelect,
  handleArrowUp,
  handleArrowDown,
  resetBrowsing,
  isBrowsingFor,
  getSavedDraft,
  attachedItems,
  refreshAttachedItems,
  onRemoveContextChip,
  onDragOver,
  onDragLeave,
  onDrop,
  staging,
  onFollowUp,
  onAbort,
  onSend,
  // [u3c] 队列条目撤销/回收的文本回草稿（useQueueRows 的 restoreDraft 注入）
  restoreToDraft,
  sendRoute,
  sendButtonState,
  sendButtonStopTarget,
  canSubmit,
  boxClass,
  placeholder,
  stagingBannerTitle,
  stagingBannerDesc,
  // bash 态（draft.trimStart().startsWith('!')，core dispatch/bash.ts isBashMode 同源判定）：
  // 传 ComposerInput suppressTriggers——bash 模式下 $/#/@/ 全部不触发浮层（设计 D6 豁免）
  isBashMode,
} = shell

// [u3c/D7] 队列区行（session.delivery 帧派生视图）+ 撤销/重试编排（行数约束拆出 useQueueRows；
// 依赖 shell 的 restoreToDraft，故在解构后调用）
const { rows: queueRows, hint: queueHint, onCancelEntry: onCancelQueueEntry, onRetryEntry: onRetryQueueEntry } =
  useQueueRows(sessionIdRef, { restoreDraft: restoreToDraft })

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
      // browsing 态 getText() 已被历史条目替换，用户真实输入存在 history navState.savedDraft。
      // browsing 判定与草稿读取都按旧 sid 显式取分区——watch 回调触发时 sessionIdRef 已指向
      // 新 session，isBrowsing 只能读到新分区恒 false（R2-A6：此前该分支恒死、存入的恒是
      // 历史条目文本，用户切回后草稿不可见、重新输入即永久丢失）。
      drafts.saveDraft(oldId, isBrowsingFor(oldId) ? getSavedDraft(oldId) : (inputRef.value?.getText() ?? ''))
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
  // 单次 getSegments 遍历复用（性能 A 档）：attachedItems 与 selectedSkillNames 消费同一
  // segments 快照（同帧无 DOM 写，两次独立读取原本就恒等；getSegments 是全树递归解析，
  // 长草稿每次击键省一次 O(节点数) 遍历）
  const segments = inputRef.value?.getSegments() ?? []
  refreshAttachedItems(segments)
  // 已选禁选数据范围（多 skill 注入 D2）：skill segment 有 name，其余类型跳过
  // （TS 5.5 推断 type predicate：filter 后 s 收窄为 skill segment）
  selectedSkillNames.value = segments.filter((s) => s.type === 'skill').map((s) => s.name)
  // 用户修改了内容，重置浏览历史状态（下次按上重新从最后一条开始）
  resetBrowsing()
}

/** IME 组合态（window capture 监听，[GUI 快修④] 发送按钮 click 路径检查消费） */
const { composing } = useCompositionFlag()

/** 键盘分发（composer-keydown.ts，U02 拆出）：staging 优先 ⏎ 提交（fork/handoff，含 streaming 中）；
 *  ⏎ / Alt+⏎ 全部汇入统一发送分发器（D6，u5b——Enter 按 sessionPhase 路由 direct/steer/queued；
 *  Alt+⏎ 保留 followUp 语义：steer 路由行走 followUp 下一轮，其余经分发器）；⇧⏎ 换行，↑/↓ 翻历史。
 *  命令浮层 open 时优先路由到浮层。[HISTORICAL] isActive→onSteer 与 isCompacting→onSend 两套
 *  分散判定（优先级倒挂根因）已退役，路由判定收敛在 useComposerSend（core dispatch/send）。 */
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
 * stop 按钮点击：先尝试取消进行中的 staging 操作（handoff inflight），否则 abort。
 * abort 的中止对象由 runtime 权威态判定（renderer 只表达「停止」意图）：
 * - isCompacting ∧ ¬isGenerating（= sendButtonStopTarget='compacting'：idle /compact、
 *   settling+overflow；生成中压缩 isGenerating=true → 归回合中止，title=停止）→ 中止压缩流程
 *   （pi session.abort → abortCompaction，runtime 走压缩取消语义：不写 stopped 终态、
 *   不广播 message.complete，队列经 abort-idle 对账立即 flush）
 * - 否则 → 中止当前 LLM turn（既有语义）
 * 在 Composer 包一层而非改 useComposerSubmit——避免影响其他消费方（onAbort 语义保持「取消 LLM turn」）。
 */
async function onStopClick(): Promise<void> {
  // staging 操作进行中（handoff inflight）→ 取消 staging（abortHandoff 乐观清 handingOff + RPC 中断）
  if (props.sessionId && await staging.abortIfInProgress(props.sessionId)) return
  // 否则 abort（中止对象 = 压缩流程 / 当前回合，由 runtime 按权威态判定）
  await onAbort()
}

/**
 * 发送按钮点击入口 [GUI 快修④ 三吞点收尾]（staging / queue / send 三颗发送位按钮共用）：
 * 1. IME 组字检查补 click 路径——composer-keydown 的 e.isComposing 检查只覆盖回车，
 *    点击路径此前缺失（组字中点击会提交半截拼音/竞态文本）；组字中静默不发送（与
 *    keydown 检查同语义，组字提交后再点/回车即发）。
 * 2. canSubmit 与 draft 同步一帧竞态——点击瞬间分发器可能读到滞后一帧的 canSend/draft
 *    被检查拦下（点了没反应）：canSubmit 为 false 时下一帧重读再走分发器（真·空输入/
 *    占用由 onSend 内 toast 反馈，不再静默）。
 */
async function onSendClick(): Promise<void> {
  if (composing.value) return
  if (!canSubmit.value) await nextTick()
  onSend()
}

// ── ui ComposerInput deps 注入（ADR-0058：pasteImage/renderIcon/t 三壳层能力）──
// 共享装配器（user-bubble-edit-composer）：底部 composer 与消息流内用户气泡编辑框
// （简化版 composer）复用同一 ComposerInput，deps 实现单点在此，防两份 renderIcon 漂移。
provideComposerInputDeps()
</script>
