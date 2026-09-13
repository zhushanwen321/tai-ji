<template>
  <!--
    展示组件 · trace 块（message-stream 折叠区内的单个块）。Demo H 视觉：灰阶 + SVG ICON +
    唯一 accent 蓝（running）+ failed hover muted 暖橙。
    - thinking：lightbulb ICON + header 可点击 toggle，长块独立再折叠（本地折叠态）。
    - tool：默认 1 行收起（streaming/running 也收起），点击展开详情。failed 终态默认展开（streaming 中失败不 remount，只 header 红）。
    - workflow：list-checks ICON + WORKFLOW. prefix + 状态动词 + workflow 名，详情区走 list-tree GUI / 文本。
    - subagent：渲染委托给 BlockSubagent（users ICON + SUBAGENT. prefix + 去卡片化）。
    - failed：无鲜红全展开（红框已删），改中性灰默认 + hover 染 warn，错误摘要进 body 文本。
    审批按钮 DEFERRED（G-018），v1 不渲染。failed 救生按钮不做（agent 自处理，design.md 决策 3）。
  -->
  <div class="trace-blk transition-[background-color,box-shadow] duration-[var(--duration)] ease-[var(--ease)] py-2" :class="blockClass" :data-testid="testId">
    <!-- thinking 块：同行展开（float 布局——第一行环绕 label，第二行起从最左侧开始） -->
    <div v-if="type === 'thinking'" class="trace-think">
      <div
        class="group/think relative cursor-pointer select-none"
        :title="thinkingExpanded ? t('panel.message.collapseReasoning') : t('panel.message.expandReasoning')"
        @click="toggleThinking"
      >
        <!-- 摘要行：flex 布局，min-h 锁定高度避免展开时跳动 -->
        <div class="flex items-center gap-1.5 min-h-[1.5rem]">
          <component :is="BLOCK_ICON_LUCIDE.thinking" class="size-3.5 shrink-0 text-neutral-ico hover:text-neutral-ico-hover" />
          <span class="mr-0.5 inline-block shrink-0 whitespace-nowrap font-mono text-[length:var(--text-2xs)] font-semibold uppercase tracking-[0.08em] text-neutral-dim">{{ t('panel.message.thinkingBlock') }}</span>
          <span v-if="!working" class="text-neutral-faint" :class="thinkingExpanded ? 'invisible' : ''">·</span>
          <!-- working 态：单行尾行视口（2026-08 抖动修复重写）。横向钉右 = viewport flex
               justify-end + 行右对齐 + mr-auto（溢出裁左纯 CSS 无 scrollLeft 时序；mr-auto
               短行左贴 label、长行溢出时钉右）；纵向换行 = useTailScroll settled/sliding
               状态机 translateY(-50%) 滑入（-50% 基于自身 2 行高度，与行高数值解耦）；
               h-[1lh] 视口高度 = 1 行行高。leading-normal（无单位）必需：normal 行高下
               行盒高度随内容 fallback 字体变（实测 system-ui 16px / PingFang 18px /
               emoji 21px，CJK 行被裁 2-5px）；无单位系数使行盒恒 = 系数×字号，字体无关。 -->
          <span
            v-if="working && thinkingTailLines.length > 0"
            class="flex h-[1lh] min-w-0 flex-1 justify-end overflow-hidden text-[length:var(--text-sm)] leading-normal text-neutral-dim"
            :class="thinkingExpanded ? 'invisible' : ''"
          >
            <span class="mr-auto flex flex-col items-end self-start" :style="thinkScrollStyle">
              <span v-for="(line, i) in thinkDisplayLines" :key="i" class="whitespace-nowrap">{{ line }}</span>
            </span>
          </span>
          <span v-else class="flex-1 min-w-0 truncate text-[length:var(--text-sm)] text-neutral-dim" :class="thinkingExpanded ? 'invisible' : ''">{{ previewText }}</span>
          <!-- thinking 块行尾时刻 -->
          <span v-if="messageTimestamp" class="ml-auto shrink-0 font-mono text-[length:var(--text-2xs)] text-neutral-dim tabular-nums" data-testid="thinking-time-slot">{{ formatClock(messageTimestamp) }}</span>
        </div>
        <!-- 展开内容区：copy 按钮在左上角，始终可见 -->
        <Transition name="block-expand">
        <div v-if="thinkingExpanded" class="group/result relative mt-1 pl-4 text-[length:var(--text-sm)] leading-[1.7] text-neutral-mid">
          <Button
            variant="ghost"
            size="icon"
            class="absolute top-0 left-0 size-5 rounded-sm text-neutral-dim opacity-0 transition-opacity hover:text-neutral-fg group-hover/result:opacity-100"
            :title="t('panel.message.copy')"
            @click.stop="content && copy(content, `thinking-${thinkingId ?? 'block'}`)"
          >
            <Check v-if="copied === `thinking-${thinkingId ?? 'block'}`" class="size-3 text-success" />
            <CopyIcon v-else class="size-3" />
          </Button>
          <MarkdownRenderer v-if="!working" :content="content ?? ''" :session-id="sessionId ?? undefined" variant="thinking" />
          <span v-else class="whitespace-pre-wrap">{{ content ?? '' }}</span>
        </div>
        </Transition>
      </div>
    </div>

    <!-- 正文 text 块：全 inline 统一正文样式（text-base/leading-7），颜色跟所属 assistant streaming 态
         （streaming→neutral-mid，complete/缺省→neutral-fg，单调不随兄弟 message 翻转）。
         streaming-tail 光标在 Turn.vue trace 容器末尾（跟在所有 block 后，不受 contentBlocks 时序影响）。
         [M2 error-visibility] status==='error' 形态判定（SSOT §3.3.2）：
         纯 error（无 msg.error，errorText 即全文）→ 整条 danger（AlertCircle + text-danger）；
         追加形态（msg.error 有值）→ content 崩溃前正常正文保持原色 + msg.error 独立 danger 行。 -->
    <div v-else-if="type === 'text'" data-testid="block-text" class="flex items-start gap-2 pb-2 text-[length:var(--text-base)] leading-7" :class="textColorClass">
      <div class="min-w-0 flex-1">
      <!-- 纯 error：AlertCircle + 整条 danger（正文 text-danger，由 textColorClass 承担） -->
      <div v-if="isPureError" class="flex items-start gap-1.5">
        <AlertCircle data-testid="block-text-error-icon" class="mt-1.5 size-3.5 shrink-0 text-danger" />
        <div class="min-w-0 flex-1">
          <MarkdownRenderer :content="content ?? ''" :session-id="sessionId ?? undefined" :streaming="streaming" />
        </div>
      </div>
      <template v-else>
        <MarkdownRenderer v-if="content" :content="content ?? ''" :session-id="sessionId ?? undefined" :streaming="streaming" />
        <!-- 追加形态：msg.error 独立 danger 行（content 保持原色，不误染崩溃前正文） -->
        <div v-if="isAppendError" data-testid="block-text-error" class="mt-1 flex items-start gap-1.5 text-danger">
          <AlertCircle class="mt-1.5 size-3.5 shrink-0 text-danger" />
          <span class="min-w-0 flex-1 whitespace-pre-wrap">{{ error }}</span>
        </div>
      </template>
      </div>
      <!-- text 块行尾时刻 -->
      <span v-if="messageTimestamp" class="w-28 shrink-0 font-mono text-[length:var(--text-2xs)] text-neutral-dim tabular-nums" data-testid="text-time-slot">{{ formatClock(messageTimestamp) }}</span>
    </div>

    <!-- tool_call 块：默认 1 行收起（streaming/running 也收起），header 含摘要，点击展开详情。
         subagent（pi-subagents 的 "subagent" tool）渲染委托给 BlockSubagent（独立样式：users ICON +
         SUBAGENT. prefix + 去卡片化）——subagent 逻辑已抽离到 BlockSubagent.vue。
         workflow（pi-workflow 的 "workflow" tool）：list-checks ICON + WORKFLOW. prefix + list-tree GUI。 -->
    <div v-else class="trace-tool">
      <!-- ── subagent 块：委托 BlockSubagent ── -->
      <BlockSubagent v-if="isSubagent" :tool="tool!" :session-id="sessionId" />

      <!-- ── workflow 块：collapsed only 单行（icon + workflow prefix + name · slug），点击开 drawer workflow tab（spec §11 / design D2）── -->
      <div v-else-if="isWorkflow" class="trace-workflow pb-2.5 mb-0.5" data-testid="workflow-block">
        <div
          data-testid="tool-block-header"
          class="flex min-w-0 cursor-pointer select-none items-center gap-1.5 text-[length:var(--text-base)] font-medium text-neutral-dim transition-opacity hover:opacity-80"
          @click="openWorkflowDrawer"
        >
          <!-- running 态 loader（双环 + accent），其余走 list-checks ICON -->
          <span v-if="isRunning" class="inline-flex size-[13px] shrink-0 items-center justify-center text-accent animate-loader-spin" v-html="RUNNING_LOADER_SVG" /> <!-- eslint-disable-line vue/no-v-html -- hardcoded constant from block-icon.ts -->
          <component :is="BLOCK_ICON_LUCIDE.workflow" v-else class="size-3.5 shrink-0 text-neutral-ico hover:text-neutral-ico-hover" :class="isFailed ? 'hover:text-warn' : ''" />
          <span class="mr-0.5 inline-block shrink-0 whitespace-nowrap font-mono text-[length:var(--text-2xs)] font-semibold tracking-[0.08em] text-neutral-dim">{{ t('panel.message.workflow') }}</span>
          <span v-if="workflowFields.name" class="shrink-0 whitespace-nowrap font-mono text-[length:var(--text-sm)] text-accent">{{ workflowFields.name }}</span>
          <template v-if="workflowFields.slug">
            <span class="text-neutral-faint">·</span>
            <span class="min-w-0 shrink-0 truncate font-mono text-[length:var(--text-sm)] text-accent">{{ workflowFields.slug }}</span>
          </template>
        </div>
      </div>

      <!-- ── 普通 tool 块：1 行收起（header 含 toolName+argPath 摘要+状态），点击展开详情 ── -->
      <div v-else>
        <div
          data-testid="tool-block-header"
          class="tool-header flex min-w-0 cursor-pointer select-none items-center gap-1.5 text-[length:var(--text-sm)] font-medium transition-opacity hover:opacity-80"
          :class="[toolStatusClass, isRunning ? 'animate-[toolcall-breathe_2.4s_ease-in-out_infinite]' : '']"
          :title="toolExpanded ? t('panel.message.collapse') : t('panel.message.expand')"
          @click="toggleTool"
        >
          <!-- running 态 loader（双环 + accent），其余走 BLOCK_ICON_LUCIDE[iconKind] -->
          <span v-if="isRunning" class="inline-flex size-[13px] shrink-0 items-center justify-center text-accent animate-loader-spin" v-html="RUNNING_LOADER_SVG" /> <!-- eslint-disable-line vue/no-v-html -- hardcoded constant from block-icon.ts -->
          <component :is="headerBlockIcon" v-else class="size-3.5 shrink-0 text-neutral-ico hover:text-neutral-ico-hover" :class="isFailed ? 'hover:text-warn' : ''" />
          <span class="shrink-0 normal-case tracking-normal">{{ toolName }}</span>
          <!-- running + 有流式输出：单行尾行视口（同 thinking header 结构：leading-normal
               字体无关行高 + mr-auto 短行左贴/溢出钉右 + 纵向状态机滑入）；否则静态 shortenForHeader -->
          <span
            v-if="isRunning && toolTailLines.length > 0"
            class="flex h-[1lh] min-w-0 flex-1 justify-end overflow-hidden normal-case leading-normal tracking-normal text-neutral-dim"
            :class="{ invisible: toolExpanded && isBashTool }"
          >
            <span class="mr-auto flex flex-col items-end self-start" :style="toolScrollStyle">
              <span v-for="(line, i) in toolDisplayLines" :key="i" class="whitespace-nowrap">{{ line }}</span>
            </span>
          </span>
          <span v-else-if="argPath" class="min-w-0 normal-case tracking-normal text-neutral-dim truncate" :class="{ invisible: toolExpanded && isBashTool }">· {{ shortenForHeader(argPath) }}</span>
          <!-- tool 块行尾槽：耗时 · 时刻 -->
          <span v-if="tool?.startTime" class="ml-auto shrink-0 flex items-center gap-1 font-mono text-[length:var(--text-2xs)] tabular-nums" data-testid="tool-time-slot">
            <span v-if="toolDuration" :class="isRunning ? 'text-accent' : 'text-neutral-dim'">{{ toolDuration }}</span>
            <span v-if="toolDuration" class="text-neutral-faint">·</span>
            <span class="text-neutral-dim">{{ formatClock(tool.startTime) }}</span>
          </span>
        </div>
        <Transition name="block-expand">
          <!-- 内容区：统一 group 包裹，copy 按钮浮在左上角复制全部内容 -->
          <!-- bash 展开恒渲染容器（命令块必显，D2：空输出/running 无输出不再「header 摘要消失 + 内容空白」假展开） -->
          <div v-if="toolExpanded && (displayContent || guiComponent || isBashTool)" class="group/content relative mt-1">
            <!-- copy 按钮：hover 显示，复制 copyContent（bash=命令+输出，其余=输出） -->
            <div class="absolute top-0 left-0 z-10 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/content:opacity-100">
              <Button
                variant="ghost"
                size="icon"
                class="size-5 rounded-sm text-neutral-dim hover:text-neutral-fg"
                :title="t('panel.message.copy')"
                @click.stop="copy(copyContent, `tool-${tool!.id}`)"
              >
                <Check v-if="copied === `tool-${tool!.id}`" class="size-3 text-success" />
                <CopyIcon v-else class="size-3" />
              </Button>
            </div>
            <!-- bash 整体容器：v6 §5 扁平凹槽（无 border + bg-input 深于父级，深度差即边界） -->
            <div v-if="isBashTool" class="rounded-sm bg-bg-input">
              <div v-if="argPath" class="border-b border-hairline pl-4 py-1.5 font-mono text-[length:var(--text-sm)] text-neutral-fg">
                {{ argPath }}
              </div>
              <!-- 输出文本区内容守卫：均空时不渲染该 div（只剩命令块，无空白假展开） -->
              <div v-if="displayContent || outputRaw || parsedJsonOutput" class="tool-result font-mono text-[length:var(--text-sm)] leading-snug whitespace-pre-wrap pl-4 py-1.5 select-text text-neutral-mid">
                <AnsiText v-if="outputRaw" :content="outputRaw" />
                <!-- JSON output（如 bash 执行 cw 命令的结构化输出）格式化缩进，限高滚动避免撑爆对话流 -->
                <pre v-else-if="parsedJsonOutput" class="m-0 max-h-80 overflow-auto whitespace-pre">{{ parsedJsonOutput }}</pre>
                <span v-else>{{ displayContent }}</span>
              </div>
            </div>
            <!-- 非 bash：meta 条 + 输出 -->
            <template v-else>
              <div v-if="filteredMetaItems.length" class="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-4 font-mono text-[length:var(--text-xs)]">
                <span
                  v-for="(item, idx) in filteredMetaItems"
                  :key="idx"
                  class="text-neutral-dim"
                >{{ item.text }}</span>
              </div>
              <div
                class="tool-result font-mono text-[length:var(--text-sm)] leading-snug whitespace-pre-wrap pl-4 select-text"
                :class="isFailed ? 'text-neutral-mid hover:text-neutral-fg' : 'text-neutral-mid'"
              >
                <GuiComponentRenderer v-if="guiComponent" :component="guiComponent" />
                <AnsiText v-else-if="outputRaw" :content="outputRaw" />
                <pre v-else-if="parsedJsonOutput" class="m-0 max-h-80 overflow-auto whitespace-pre">{{ parsedJsonOutput }}</pre>
                <span v-else>{{ displayContent }}</span>
              </div>
            </template>
            <!-- [D6-⑨ u7] toolResult 图片（bash/非 bash 分支共用的统一出口；路径引用渲染
                 + 帽满占位/降级 badge，见 ToolResultImages） -->
            <ToolResultImages
              v-if="tool?.images?.length"
              :session-id="sessionId"
              :images="tool.images"
            />
            <!-- bash meta 条（耗时等，内容区内） -->
            <div v-if="isBashTool && filteredMetaItems.length" class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-4 font-mono text-[length:var(--text-xs)]">
              <span
                v-for="(item, idx) in filteredMetaItems"
                :key="idx"
                class="text-neutral-dim"
              >{{ item.text }}</span>
            </div>
          </div>
        </Transition>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, Check, Copy as CopyIcon } from '@lucide/vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import { extractGui } from '@xyz-agent/extension-protocol'
import type { MessageStatus, ToolCall } from '@xyz-agent/shared'
import { SUBAGENT_TOOL_NAMES, WORKFLOW_TOOL_NAMES } from '@xyz-agent/shared'
import { openWorkflow } from '@xyz-agent/core/domain/drawer'
import { AnsiText, GuiComponentRenderer } from '../../rendering-protocol'
import MarkdownRenderer from './MarkdownRenderer.vue'
import BlockSubagent from './BlockSubagent.vue'
import ToolResultImages from './ToolResultImages.vue'
import { BLOCK_ICON_LUCIDE, RUNNING_LOADER_SVG, getBlockIcon } from './block-icon'
import { formatDuration, formatClock, shortenForHeader, tailLines, stripAnsi } from './format-utils'
// primitives 直接路径（不经 @xyz-agent/ui 顶层 barrel）：chat 组件被 barrel 再导出，
// barrel 自引用会闭合一族循环依赖环（详见 BashOutputBlock.vue 同款注释）
import { Button } from '../../primitives/button'
import { useToolMeta } from './composables/useToolMeta'
import { useCopy } from './composables/useCopy'
import { useTailScroll } from './composables/useTailScroll'

const { t } = useI18n()
const { copied, copy } = useCopy()

const props = defineProps<{
  type: 'thinking' | 'tool' | 'text' | 'agentgraph'
  /** thinking / text 内容 */
  content?: string
  /** thinking 块 id（thinking 类型时由父组件透传，用于 data-testid 精确锚定；其他类型忽略） */
  thinkingId?: string
  /** tool_call 数据（type==='tool' 时必填） */
  tool?: ToolCall
  /** thinking 块初始折叠态（来自 ThinkingBlock.collapsed，默认收起） */
  collapsed?: boolean
  /** working 态（turn 进行中）：thinking 各态默认折叠（collapsed 初值 true），working→false
   *  未手动操作过的块回落收起（SSOT §3.3.3）。
   *  折叠态 working=true 时渲染尾部行窗口 + 双轴尾部追踪（W4 D4），
   *  working=false 保持头部 60 字符静态预览。
   *  tool 块不因 working 强制展开（streaming 态也 1 行收起，header 自带状态指示）。 */
  working?: boolean
  /** streaming 态（所属 assistant 正在流式）：驱动 text 分支颜色——streaming→text-neutral-mid，
   *  complete/缺省→text-neutral-fg（单调，不随兄弟 message 到达翻转）。
   *  由 Turn.vue 传 assistant.status === 'streaming'。thinking/tool/agentgraph 分支不消费此 prop。 */
  streaming?: boolean
  /** 所属 assistant 消息终态（text 分支 error 形态判定，SSOT §3.3.2）：
   *  status==='error' 且 error 有值 → 追加形态（content 原色 + error 独立 danger 行）；
   *  status==='error' 且无 error → 纯 error（整条 danger）。thinking/tool 分支不消费。 */
  status?: MessageStatus
  /** 追加形态错误文本（assistant Message.error 字段，status==='error' 时有值）。 */
  error?: string
  /** 所属 assistant message 时刻（epoch ms，行尾时刻显示） */
  messageTimestamp?: number
  /** 所属 session（透传给 MarkdownRenderer 供文件路径打开 DetailPane 用） */
  sessionId?: string | null
}>()

/* ── thinking 折叠（streaming-trace-window 验收修正）：working 态也默认折叠（60 字符预览），
 *    与过程块收编理念一致（收编减体积 + thinking 折叠 = 视觉体积最小）；用户可手动展开，展开后保持。
 *    原 SSOT §3.3.3「working→false 展开」导致 streaming 中所有 thinking 全展开，与收编减体积冲突。── */
const thinkingCollapsed = ref(props.collapsed ?? true)
const thinkingExpanded = computed(() => !thinkingCollapsed.value)
/** 用户是否手动 toggle 过（收起/展开均置位）——置位后完成态不回落（显式意图优先，CQ1） */
const userToggledThinking = ref(false)

function toggleThinking(): void {
  userToggledThinking.value = true
  thinkingCollapsed.value = !thinkingCollapsed.value
}

/** working true→false：未手动操作过的块回落收起（用户手动操作过的保持用户意图不回滚） */
watch(
  () => props.working,
  (working) => {
    if (working === false && !userToggledThinking.value) {
      thinkingCollapsed.value = true
    }
  },
)

/** 收起态的正文预览（截断，draft：收起时显一行摘要） */
const PREVIEW_LIMIT = 60
const previewText = computed(() => {
  const c = props.content?.trim() ?? ''
  if (c.length <= PREVIEW_LIMIT) return c
  return `${c.slice(0, PREVIEW_LIMIT)}…`
})

/* ── thinking 尾行视口（2026-08 抖动修复重写）──
 * working 态折叠预览：单行视口显示最新行（横向 CSS 钉右 + 纵向滑入动画，
 * 机制见 useTailScroll 头注释）；非 working 保持 previewText 头部 60 字符静态。
 * 尾 2 行即状态机所需（旧行 + 新行）。 */
const TAIL_LINE_COUNT = 2
const thinkingTailLines = computed(() =>
  props.working ? tailLines(props.content ?? '', TAIL_LINE_COUNT) : [],
)
const { displayLines: thinkDisplayLines, contentStyle: thinkScrollStyle } = useTailScroll(thinkingTailLines)

/** 纯 error：status==='error' 且无 msg.error（markSessionError/registry 无 streaming 实体时
 *  手动追加的整条 error 消息，errorText 即 content 全文）。 */
const isPureError = computed(() => props.status === 'error' && !props.error)
/** 追加形态：status==='error' 且 msg.error 有值（finalizeMessages 双通道写入的崩溃错误）。 */
const isAppendError = computed(() => props.status === 'error' && !!props.error)

/** text 分支颜色：纯 error 整条 danger；追加形态/正常正文 streaming→neutral-mid、complete→neutral-fg */
const textColorClass = computed(() => {
  if (isPureError.value) return 'text-danger'
  return props.streaming ? 'text-neutral-mid' : 'text-neutral-fg'
})

const isFailed = computed(() => props.tool?.status === 'error')
const isRunning = computed(() => props.tool?.status === 'running')

/** running 工具耗时实时跳动：仅 isRunning 期间挂载 interval，onUnmounted 清理，页面 hidden 停 tick */
const nowTs = ref(Date.now())
let liveDurTimer: ReturnType<typeof setInterval> | null = null
function startLiveDurTick(): void {
  if (liveDurTimer) return
  nowTs.value = Date.now()
  liveDurTimer = setInterval(() => { nowTs.value = Date.now() }, 100)
}
function stopLiveDurTick(): void {
  if (liveDurTimer) { clearInterval(liveDurTimer); liveDurTimer = null }
}
watch(isRunning, (running) => {
  if (running) startLiveDurTick()
  else stopLiveDurTick()
}, { immediate: true })
onUnmounted(() => { stopLiveDurTick() })

/** tool 块行尾耗时（running 实时算，completed 用 startTime/endTime） */
const toolDuration = computed(() => {
  const start = props.tool?.startTime
  if (typeof start !== 'number') return ''
  if (isRunning.value) {
    return formatDuration(nowTs.value - start)
  }
  const end = props.tool?.endTime
  if (typeof end !== 'number' || end <= start) return ''
  return formatDuration(end - start)
})
/* end_not_received（流结束未收到 tool_call_end，进程崩溃/WS 断连）原单独分支已并入
 * completed 的 neutral-mid 置灰（同为非 running 非失败的中性态，无需视觉区分）。 */
const toolName = computed(() => props.tool?.toolName ?? 'tool')
const isBashTool = computed(() => toolName.value === 'bash')
const result = computed(() => props.tool?.output)
/** 展示用内容：output 优先，failed 时兜底 tool.error（如 read ENOENT 输出为空但 error 有值） */
const displayContent = computed(() => result.value || (isFailed.value ? (props.tool?.error ?? '') : ''))

/** JSON.stringify 缩进空格数（具名常量避 no-magic-numbers） */
const JSON_INDENT = 2

/**
 * JSON output 格式化：displayContent 为合法 JSON 时返回 2 空格缩进格式化串，否则 null。
 *
 * 背景：subagent（cw 递归编排）大量用 bash 执行 `cw ...` 命令，其 stdout 是 JSON
 *（cw execute/design/review 等结构化输出）。原样 whitespace-pre-wrap 渲染时，
 * 单行 JSON 既长又不可读，展开工具卡片看到一整坨压缩 JSON。
 * 格式化后缩进换行，可读性大幅提升；非 JSON（普通命令输出/文本）回退原样渲染。
 *
 * 判定：trim 后首字符为 `{` 或 `[` 才尝试 parse（避免对普通文本白跑 JSON.parse）。
 * 大对象开销可接受——computed 缓存 + 仅 toolExpanded（tool-result 渲染）时求值。
 */
const parsedJsonOutput = computed<string | null>(() => {
  const raw = displayContent.value
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null
  try {
    return JSON.stringify(JSON.parse(trimmed), null, JSON_INDENT)
  } catch {
    return null
  }
})
/** 复制用内容：bash 包含命令+输出，其余同 displayContent */
const copyContent = computed(() => {
  if (isBashTool.value && argPath.value) {
    return displayContent.value ? `${argPath.value}\n${displayContent.value}` : argPath.value
  }
  return displayContent.value
})
/** 原始 ANSI 文本（未经 stripAnsi）。有此字段时用 AnsiText 渲染着色，无则回退 output 纯文本。 */
const outputRaw = computed(() => props.tool?.outputRaw)

/* ── tool 尾行视口（同 thinking，2026-08 抖动修复重写）──
 * isRunning + 有流式输出时，bash 用 outputRaw 去 ANSI 取尾行；其余 tool 用 displayContent 取尾行。
 * 无流式输出或非 running 保持静态 shortenForHeader(argPath)。 */
const toolTailLines = computed(() => {
  if (!isRunning.value) return []
  // bash：outputRaw 缺失（无 ANSI 输出）时回退 displayContent（D3 尾行取数）
  const raw = isBashTool.value ? (outputRaw.value ?? displayContent.value) : displayContent.value
  if (!raw) return []
  return tailLines(isBashTool.value ? stripAnsi(raw) : raw, TAIL_LINE_COUNT)
})
const { displayLines: toolDisplayLines, contentStyle: toolScrollStyle } = useTailScroll(toolTailLines)

/** 补充细节条 meta 项（耗时 + 工具特化行数/字符数 + 失败错误摘要），逻辑拆到 useToolMeta */
const { metaItems } = useToolMeta({
  tool: computed(() => props.tool),
  toolName,
  isFailed,
})

/** bash 展开后去掉行数统计（命令+output 已完整展示，行数无参考价值） */
const filteredMetaItems = computed(() => {
  if (!isBashTool.value) return metaItems.value
  return metaItems.value.filter((item) => !item.text.endsWith('行'))
})

/* ── 块类型路由：subagent / workflow ── */
const isSubagent = computed(() => SUBAGENT_TOOL_NAMES.has(toolName.value))
const isWorkflow = computed(() => WORKFLOW_TOOL_NAMES.has(toolName.value))

/** 普通 tool header 的块类型 ICON（running 用 loader，其余走 BLOCK_ICON_LUCIDE） */
const headerBlockIcon = computed(() => {
  const kind = getBlockIcon(toolName.value, props.tool?.status ?? 'completed', false, false)
  // running 态走模板的 loader 分支（v-if isRunning），不走此 computed
  return kind === 'running' ? BLOCK_ICON_LUCIDE['tool-other'] : BLOCK_ICON_LUCIDE[kind]
})

/** 普通 tool header 状态色：running 染 accent，failed 染 danger（错误醒目），
 *  completed 置灰降两档（feat-chat-flow-dim）：neutral-fg → mid → dim（#74747a）。
 *  dim 3.56:1 不过 AA（critique 第 3 轮曾据此禁用），用户实测 mid 档置灰感不足、
 *  明确裁决再降一档——可读性让位于「完成块扫视即灰」的层级对比，此裁决仅限
 *  过程块折叠 header（正文/输出内容不适用）。unfinished 与 completed 同档中性灰（abort/中断非失败，不标 danger 防 abort 满屏红误读）。 */
const toolStatusClass = computed(() => {
  if (isRunning.value) return 'text-accent'
  if (isFailed.value) return 'text-danger'
  return 'text-neutral-dim'
})

/** workflow 顶层 input 安全读取（拍平 schema：action/name/slug/args/runId 都在顶层） */
const workflowInputObj = computed(() => {
  const input = props.tool?.input as Record<string, unknown> | undefined
  return input && typeof input === 'object' ? input : {}
})

/** workflow 标题行字段：name / slug（collapsed only，spec §11） */
const workflowFields = computed(() => {
  const input = workflowInputObj.value
  const name = typeof input.name === 'string' ? input.name : ''
  const slug = typeof input.slug === 'string' ? input.slug : ''
  return { name, slug }
})

/** 点击 workflow 块 → drawer 开 workflow tab（D1/D2）。name 为空时 openWorkflow 仅切 tab不记录选中。 */
function openWorkflowDrawer(): void {
  openWorkflow(workflowFields.value.name)
}

/**
 * 从 tool.details.__gui__ 提取结构化渲染组件（extension GUI 协议，spec §9.1）。
 * extension RPC 模式把 GuiComponent 放进 details.__gui__.component，前端用 extractGui
 * 统一校验版本后路由到 GuiComponentRenderer。无 __gui__ 时 undefined（走 AnsiText/纯文本兜底）。
 * 注：ToolCall 的结构化扩展数据存在 details 字段（pi tool_execution_end result.details）。
 *
 * streaming __gui__ 仅在 running 态有效——tool_call_end 后若 details 无 __gui__，
 * 不应回退到过期的 streaming detail（如 extension streaming 推了进度组件但最终返回纯文本）。
 * 否则已完成工具会错误显示 streaming 过程中的临时 GUI 组件。
 */
const guiComponent = computed<GuiComponent | undefined>(() => {
  // tool_call_end 的 details（复数，最终态）优先
  const fromEnd = extractGui(props.tool?.details)?.component
  if (fromEnd) return fromEnd
  // streaming 态 fallback：仅在 tool 仍在 running 时用 detail（单数）。
  // tool_call_end 后 detail 残留不应被当作渲染源（最终态无 __gui__ → 不渲染 GUI 组件）。
  if (isRunning.value) {
    const streamingDetail = props.tool?.detail
    if (typeof streamingDetail === 'object' && streamingDetail !== null) {
      return extractGui(streamingDetail)?.component
    }
  }
  return undefined
})

/**
 * tool 折叠：默认 1 行收起（含 streaming/running 态——header 行已含摘要+状态指示，
 * 1 行即可观察进度，点击才展开详情）。failed 终态默认展开（错误输出立即可见）。
 * mount 快照：toolCollapsed 仅在挂载时求值，Block key 不含 status（running→error 不 remount），
 * 故 streaming 中失败的工具不展开（只 header 染 danger），仅终态挂载（重开/回看）才展开（§3.3.1 选项 A）。
 * 被否：watch(tool.status) 强制展开——streaming 高度突变破坏跟底/回到底部浮层（P0 级风险）。
 */
const toolCollapsed = ref(!isFailed.value)
const toolExpanded = computed(() => !toolCollapsed.value)

function toggleTool(): void {
  toolCollapsed.value = !toolCollapsed.value
}

/**
 * 从 input 提取可读参数摘要（header 单行展示）。覆盖高频工具：
 * bash→command、read/write/edit→path、grep→pattern、todo_write→tasks 数量等。
 * 未覆盖的工具返回空串（header 只显 toolName）。
 */
const argPath = computed(() => {
  const input = props.tool?.input as Record<string, unknown> | undefined
  if (!input) return ''
  if (typeof input.command === 'string') return input.command
  if (typeof input.path === 'string') return input.path
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.pattern === 'string') return input.pattern
  if (Array.isArray(input.tasks)) return `${input.tasks.length} todos`
  return ''
})


/** 活动 block 态（chat-flow-polish P0-1）：running 块左缘 accent rail（inset box-shadow，
 *  不改布局）+ accent-soft 微染，让 streaming 中「当前跑到哪了」扫视可见；rail 是无彩色依赖的
 *  第二通道（色弱友好）。完成（running→completed）时染色 200ms 淡出——根 div 常驻
 *  transition-[background-color,box-shadow]，状态切换自动过渡。bash 展开容器 bg-bg-input 压盖
 *  染色，容器内不被染脏（design §1.2 方案 A 风险已规避）。
 *  failed/unfinished/completed 不染色（中性灰，header 已有状态指示）。 */
const blockClass = computed(() => {
  if (!isRunning.value) return ''
  return 'bg-accent-soft [box-shadow:inset_2px_0_0_0_var(--accent)]'
})

/** data-testid 锚点：按块类型拼接可定位 id，供 E2E 精确断言特定块。
 *  格式：block-tool-${tool.id}（type==='tool'/'agentgraph' 且有 tool）/ block-thinking-${thinkingId}（type==='thinking'）。
 *  agentgraph（subagent/workflow）数据结构同 tool（ToolCall 有 id），故共用 block-tool 前缀。
 *  无 id（text / thinking 无 id）时回退 undefined（不输出 data-testid 属性，避免污染选择器）。 */
const testId = computed(() => {
  if (props.type === 'tool' || props.type === 'agentgraph') {
    const id = props.tool?.id
    return id ? `block-tool-${id}` : undefined
  }
  if (props.type === 'thinking') {
    return props.thinkingId ? `block-thinking-${props.thinkingId}` : undefined
  }
  return undefined
})
</script>

<style scoped>
/* 块展开/收起过渡（chat-flow-polish P0-2）：消除 v-if 瞬时切换的生硬感。
   opacity + 轻微 translateY（从 header 方向淡入），120ms；保持 v-if 卸载折叠块的长输出
   （不做 grid 恒渲染，避免 streaming 中折叠块长 bash 输出恒挂载的性能代价）。
   escape hatch：Vue Transition 类用 scoped 表达（enter-from/leave-to 同时设 opacity+transform）。 */
.block-expand-enter-active,
.block-expand-leave-active {
  transition:
    opacity var(--duration-fast) var(--ease),
    transform var(--duration-fast) var(--ease);
}
.block-expand-enter-from,
.block-expand-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>

