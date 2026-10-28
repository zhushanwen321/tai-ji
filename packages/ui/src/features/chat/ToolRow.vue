<!--
  展示组件 · 工具行（trace 块 tool / agentgraph 类型行组件，W2 壳化拆分自 Block.vue）。
  壳根类名契约（.trace-blk）与 data-testid（block-tool-<id>）留在 Block 壳，本组件根 =
  原 tool 分支根 div（.trace-tool），无新 DOM 层。
  agentgraph 数据结构同 tool（ToolCall），Turn 层 type 语义与渲染分派在本组件内统一：
  按工具名两分——subagent → SubagentRow / 其余（含 workflow 工具组）普通 tool 形态。
  [容器扩展点统一 §7.4 workflow 层 2] workflow 专属行组件（WorkflowRow，collapsed-only
  + phases chips + 点击开 overlay）已删：workflow 工具落通用 tool 形态（展开区消费
  details.__gui__ 插件树，恢复产树后的通用渲染路径；行内点击 = 展开/收起树）。
  普通 tool：默认 1 行收起（streaming/running 也收起），点击展开详情。failed 终态默认展开
  （streaming 中失败不 remount，只图标染 danger）。展开区：copy 按钮 + bash 凹槽（命令头恒吸顶）
  + meta 条 / GUI 协议输出 / 富渲染 / 文本输出 + ToolResultImages 统一图片出口。
  展开块限高统一走 BlockScrollBox（240px 块内滚动 + 渐隐提示 + 行区间信息条）。
  审批按钮 DEFERRED（G-018），v1 不渲染。failed 救生按钮不做（agent 自处理，design.md 决策 3）。
-->
<template>
  <div class="trace-tool">
    <!-- ── subagent 块：委托 SubagentRow（users ICON + SUBAGENT. prefix + 去卡片化）── -->
    <SubagentRow v-if="isSubagent" :tool="tool!" :session-id="sessionId" />

    <!-- ── 普通 tool 块（含 workflow 工具组——§7.4 workflow 层 2 删专属行组件）：1 行收起
         （header 含 toolName+argPath 摘要+状态），点击展开详情。
         group/tool 命名分组承载行尾时刻槽的悬停/键盘聚焦两翼显现（D2）── -->
    <div v-else class="group/tool">
      <div
        data-testid="tool-block-header"
        class="tool-header flex min-w-0 cursor-pointer select-none items-baseline gap-[8px] [font-weight:var(--fw-mid)] text-neutral-mid"
        :title="toolExpanded ? t('panel.message.collapse') : t('panel.message.expand')"
        @click="toggleTool"
      >
        <!-- running 态 loader（呼吸弧 + accent），其余走 BLOCK_ICON_LUCIDE[iconKind]
             （瞬时切换；tico 交叉过渡已随 Vue 3.5.39 out-in 调度 bug 移除，见 thinking 行
             [HISTORICAL]）。
             [M3b demo 复刻]（workbench.css .tool/.run-ic）：行文字恒行层级 mid 不随状态染色
             （demo .tool .t-name 恒 mid，无 accent/danger 文字态），状态色只落在图标——
             running = accent 呼吸弧、failed = danger（.line.subagent.failed .sicon）。
             bash 豁免动效图标（2026-10-17 方案 A 裁决）：running 中与完成态同款静态展开
             箭头（tool-cmd），命令字符串常显；扫光只扫「bash」工具名，不扫命令。 -->
        <RunningBlockIcon v-if="isRunning && !isBashTool" :kind="toolRunningKind" />
        <component :is="headerBlockIcon" v-else :class="[headerIconClass, 'self-center']" />
        <span class="shrink-0 normal-case tracking-normal transition-opacity duration-[var(--duration-fast)] group-hover/tool:opacity-80" :class="isBashTool && isRunning ? 'text-sweep [--sweep-base:var(--neutral-mid)]' : ''">{{ toolName }}</span>
        <!-- running + 有流式输出：单行尾行视口（同 thinking header 结构：leading-normal
             字体无关行高 + mr-auto 短行左贴/溢出钉右 + 纵向状态机滑入）；否则静态 shortenForHeader。
             bash 不进尾行视口（2026-10-17 方案 A 裁决：running 中 header 保持命令字符串，
             进度看展开区输出），故 v-if 带 !isBashTool（toolTailLines 数据层同源排除）。
             [M3b demo 复刻] 摘要/尾行走 mono（demo .tool .cmd = font-mono 命令语境），字号随
             trace 容器行主体统一档（15px），mono 字族承担命令语境区分。 -->
        <span
          v-if="isRunning && !isBashTool && toolTailLines.length > 0"
          class="flex h-[1lh] min-w-0 flex-1 self-center justify-end overflow-hidden font-mono normal-case leading-normal tracking-normal text-neutral-dim transition-opacity duration-[var(--duration-fast)] group-hover/tool:opacity-80"
          :class="{ invisible: toolExpanded && isBashTool }"
        >
          <span class="text-sweep mr-auto flex flex-col items-end self-start" :style="toolScrollStyle">
            <span v-for="(line, i) in toolDisplayLines" :key="i" class="whitespace-nowrap">{{ line }}</span>
          </span>
        </span>
        <!-- N1（ui-optimize-unified 决策 8）：edit/write 行 = 工具名 + basename chip，
             与 UserBubble 文件 badge 同语义（openFileDetail 双通道 + @click.stop 防行展开 +
             title 完整路径 + ellipsis）。
             [M3b demo 复刻] chip 形态对齐 demo .tool .fchip（workbench.css:372）：card-inset
             凹陷底 + hairline 边 + fg-2 字 + mono + 1px 8px 内边距，字号随 trace 容器行主体
             统一档（15px）；demo chip 无图标（FileText 移除）。hover 提亮为 real 保留 affordance
             （demo 无 hover 形态）。
             [MF-1-24]（demo workbench.css:372-386 同款）：max-w-[320px] 上限（长文件名不再
             吃满整行）+ 内层 fchip-roll 双 span 轻方案——静态 truncate 截断，hover 时容器
             text-overflow:clip + 内层 roll 滚到文末停（forwards）、短名 min(0px,…) 取 0
             不滚、reduced-motion 停（动画与 media 查询在本文件 scoped 尾部）。 -->
        <span
          v-else-if="argPath && isFileWriteTool"
          data-testid="tool-file-chip"
          class="tool-file-chip inline-flex min-w-0 max-w-[320px] cursor-pointer items-center gap-1 truncate rounded-sm border border-hairline bg-bg-input px-2 py-px font-mono normal-case tracking-normal [font-weight:var(--fw-text)] text-[color:var(--neutral-fg-2)] transition-[color,border-color,opacity] duration-[var(--duration-fast)] hover:border-border-strong hover:text-neutral-fg hover:[text-overflow:clip] group-hover/tool:opacity-80"
          role="button"
          tabindex="0"
          :title="argPath"
          @click.stop="openFileDetail(argPath)"
          @keydown.enter.stop.prevent="openFileDetail(argPath)"
          @keydown.space.stop.prevent="openFileDetail(argPath)"
        >
          <span class="fchip-roll inline-block whitespace-nowrap">{{ fileChipBasename }}</span>
          <!-- 统计段：edit 工具 diff 增删行数（core parseDiffStat 数据层；write 工具/历史会话
               缺省不渲染）。mono dim，与行尾耗时槽同档灰阶。 -->
          <span
            v-if="fileChipDiffStat"
            data-testid="tool-file-chip-diffstat"
            class="shrink-0 tabular-nums text-neutral-dim"
          >+{{ fileChipDiffStat.additions }} −{{ fileChipDiffStat.deletions }}</span>
        </span>
        <!-- details.summary（extension 自报一行摘要，约定见 docs/extensions/extension-conventions.md
             「Tool result details.summary 约定」）：header 摘要优先级 = edit/write chip > 自报摘要 >
             argPath 参数派生 > 仅工具名（edit/write chip 是既定升级形态——basename + diff 统计 +
             打开文件详情，信息量高于通用摘要，故排在自报摘要之前；声明与上方 v-else-if 链顺序一致）。
             样式与 argPath 摘要同款 mono dim（M3b demo .tool .cmd 命令语境档）。 -->
        <span
          v-else-if="detailsSummary"
          data-testid="tool-details-summary"
          class="min-w-0 font-mono normal-case tracking-normal text-neutral-dim truncate transition-opacity duration-[var(--duration-fast)] group-hover/tool:opacity-80"
        >{{ shortenForHeader(detailsSummary) }}</span>
        <span v-else-if="argPath" class="min-w-0 font-mono normal-case tracking-normal text-neutral-dim truncate transition-opacity duration-[var(--duration-fast)] group-hover/tool:opacity-80" :class="[{ invisible: toolExpanded && isBashTool }, isRunning && !isBashTool ? 'text-sweep' : '']">{{ shortenForHeader(argPath) }}</span>
        <!-- tool 块行尾槽（[M3b demo 复刻] demo .dur/.ts）：耗时常驻显形（demo .dur 无显隐
             门控，fs-md 12px mono dim——running 也保持 dim，accent 只在呼吸弧图标），
             时刻保留 D2 悬停化（demo .ts opacity 0→1 hover 显形）；耗时与时刻间无分隔点
             （demo 两 span 裸相邻，行 gap 8px 承担间距）。 -->
        <span v-if="tool?.startTime" class="ml-auto shrink-0 flex items-center gap-2 self-center font-mono tabular-nums" data-testid="tool-time-slot">
          <span v-if="toolDuration" class="text-[length:var(--text-xs)] text-neutral-dim">{{ toolDuration }}</span>
          <span class="text-[length:var(--text-2xs)] text-neutral-dim opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover/tool:opacity-100 group-focus-within/tool:opacity-100">{{ formatClock(tool.startTime) }}</span>
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
            <!-- 命令头：保持在凹槽内、BlockScrollBox 之外 = 不随输出滚动（恒吸顶是布局的免费性质，
                 无需「移入滚动区首位 + sticky + 底色遮盖」三件套，见设计 D6 接入点②） -->
            <div v-if="argPath" class="border-b border-hairline pl-4 py-1.5 font-mono text-[length:var(--text-sm)] text-neutral-fg">
              {{ argPath }}
            </div>
            <!-- 输出文本区内容守卫：均空时不渲染（只剩命令块，无空白假展开）；
                 限高滚动 + 行区间信息条由 BlockScrollBox 统一承担（含原 max-h-80 的 JSON 分支） -->
            <BlockScrollBox v-if="displayContent || outputRaw || parsedJsonOutput" surface="recessed">
              <div :class="toolResultClass">
                <AnsiText v-if="outputRaw" :content="outputRaw" />
                <!-- JSON output（如 bash 执行 cw 命令的结构化输出）格式化缩进 -->
                <pre v-else-if="parsedJsonOutput" class="m-0 whitespace-pre">{{ parsedJsonOutput }}</pre>
                <span v-else>{{ displayContent }}</span>
              </div>
            </BlockScrollBox>
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
            <!-- GUI 协议输出自管理高度，不包 BlockScrollBox（设计 D6 接入点③） -->
            <div v-if="guiComponent" :class="toolResultClass">
              <GuiComponentRenderer :component="guiComponent" />
            </div>
            <!-- [tool-detail-rich] read/write/edit 经壳注入组件富渲染（diff / 行号代码块）。
                 水平滚动自管理（BlockScrollBox 仅 overflow-y）；壳未注入（mock 壳）或非三类
                 工具 → 走下方纯文本兑底。 -->
            <BlockScrollBox v-else-if="hasRichDetail">
              <component :is="chatViewDeps.toolDetailRenderer" :tool="tool!" :session-id="sessionId" />
            </BlockScrollBox>
            <!-- 文本 / ANSI / JSON 输出：统一块内滚动（G5/D6） -->
            <BlockScrollBox v-else>
              <div :class="toolResultClass">
                <AnsiText v-if="outputRaw" :content="outputRaw" />
                <pre v-else-if="parsedJsonOutput" class="m-0 whitespace-pre">{{ parsedJsonOutput }}</pre>
                <span v-else>{{ displayContent }}</span>
              </div>
            </BlockScrollBox>
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
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy as CopyIcon } from '@lucide/vue'
import type { GuiComponent } from '@zhushanwen/extension-protocol'
import { extractGui } from '@zhushanwen/extension-protocol'
import type { ToolCall } from '@taiji/shared'
import { SUBAGENT_TOOL_NAMES } from '@taiji/shared'
import { AnsiText, GuiComponentRenderer } from '../../rendering-protocol'
import SubagentRow from './SubagentRow.vue'
import BlockScrollBox from './BlockScrollBox.vue'
import ToolResultImages from './ToolResultImages.vue'
import RunningBlockIcon from './RunningBlockIcon.vue'
import type { RunningIconKind } from './block-icon'
import { BLOCK_ICON_CLASS, BLOCK_ICON_LUCIDE, getBlockIcon } from './block-icon'
import { formatClock, formatJsonIfValid, shortenForHeader, tailLines } from './format-utils'
// primitives 直接路径（不经 @taiji/ui 顶层 barrel）：chat 组件被 barrel 再导出，
// barrel 自引用会闭合一族循环依赖环（详见 BashOutputBlock.vue 同款注释）
import { Button } from '../../primitives/button'
import { useToolMeta } from './composables/useToolMeta'
import { useCopy } from './composables/useCopy'
import { TAIL_WINDOW_LINES, useTailScroll } from './composables/useTailScroll'
import { useLiveToolDuration } from './composables/useLiveToolDuration'
import { useChatViewDeps } from './chat-view-deps'

const { t } = useI18n()
const { copied, copy } = useCopy()
// N1 文件 chip 的 drawer 双通道经壳依赖注入（与 UserBubble 同一契约面；inject 强契约，
// 须在 provide ChatViewDepsKey 的容器内渲染）
const chatViewDeps = useChatViewDeps()

const props = defineProps<{
  /** tool_call 数据（tool / agentgraph 块数据；agentgraph 数据结构同 ToolCall） */
  tool?: ToolCall
  /** 所属 session（透传给富渲染 / 图片出口 / workflow overlay 反查） */
  sessionId?: string | null
}>()

const isFailed = computed(() => props.tool?.status === 'error')
const isRunning = computed(() => props.tool?.status === 'running')

/** running 工具耗时实时跳动（tick 生命周期 + 终态 startTime/endTime 换算拆至 useLiveToolDuration） */
const toolDuration = useLiveToolDuration(computed(() => props.tool), isRunning)
/* end_not_received（流结束未收到 tool_call_end，进程崩溃/WS 断连）原单独分支已并入
 * completed 的 neutral-mid 置灰（同为非 running 非失败的中性态，无需视觉区分）。 */
const toolName = computed(() => props.tool?.toolName ?? 'tool')
const isBashTool = computed(() => toolName.value === 'bash')
const result = computed(() => props.tool?.output)
/** 展示用内容：output 优先，failed 时兜底 tool.error（如 read ENOENT 输出为空但 error 有值） */
const displayContent = computed(() => result.value || (isFailed.value ? (props.tool?.error ?? '') : ''))
/** 输出区容器 class（bash 凹槽 / 非 bash / GUI 分支共用）：
 *  - py-1.5：bash 凹槽内的竖向留白（既有形态；非 bash 输出区无此留白）
 *  - hover:text-neutral-fg：非 bash 失败态提升可读性（既有形态，bash 无） */
const TOOL_RESULT_CLASS = 'tool-result font-mono text-[length:var(--text-sm)] leading-snug whitespace-pre-wrap pl-4 select-text text-neutral-mid'
const toolResultClass = computed(() => [
  TOOL_RESULT_CLASS,
  {
    'py-1.5': isBashTool.value,
    'hover:text-neutral-fg': !isBashTool.value && isFailed.value,
  },
])

/** JSON output 格式化（合法 JSON → 2 空格缩进；非 JSON 回退 null 原样渲染）——实现拆至 format-utils（行数预算，无行为差异）。 */
const parsedJsonOutput = computed(() => formatJsonIfValid(displayContent.value))
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
 * 非 bash 工具 running + 有流式输出时取 displayContent 尾行。bash 行 running 态已改
 * 命令字符串常显（2026-10-17 方案 A 裁决：进度看展开区输出），不进尾行视口——
 * bash 专属的 outputRaw 回退取数与 stripAnsi 随之移除。无流式输出或非 running
 * 保持静态 shortenForHeader(argPath)。 */
const toolTailLines = computed(() => {
  if (!isRunning.value || isBashTool.value) return []
  if (!displayContent.value) return []
  return tailLines(displayContent.value, TAIL_WINDOW_LINES)
})
const { displayLines: toolDisplayLines, contentStyle: toolScrollStyle } = useTailScroll(toolTailLines)

/** 补充细节条 meta 项（耗时 + 工具特化行数/字符数 + 失败错误摘要），逻辑拆到 useToolMeta */
const { metaItems } = useToolMeta({
  tool: computed(() => props.tool),
  toolName,
  isFailed,
})

/**
 * [tool-detail-rich] 富渲染路由谓词（容器注入 toolDetailRenderer 后，read/write/edit 三类
 * 非失败工具展开区改走富渲染，其余工具维持纯文本）：
 * - read：output 即文件内容，有值即可渲染（失败态在上方短路——错误信息不走代码渲染）；
 * - edit：pi details.patch（unified patch；details.diff 是展示格式不可用）存在才路由
 *  （历史会话缺字段回退纯文本）；
 * - write：input.content（写入全文）存在才路由（git diff 由壳组件内懒加载）。
 */
const hasRichDetail = computed(() => {
  if (!chatViewDeps.toolDetailRenderer || isFailed.value) return false
  const name = toolName.value
  if (name === 'read') return !!displayContent.value
  if (name === 'edit') return typeof props.tool?.details?.patch === 'string'
  if (name === 'write') {
    const input = props.tool?.input as Record<string, unknown> | undefined
    return typeof input?.content === 'string'
  }
  return false
})

/** bash 展开后去掉行数统计（命令+output 已完整展示，行数无参考价值） */
const filteredMetaItems = computed(() => {
  if (!isBashTool.value) return metaItems.value
  return metaItems.value.filter((item) => item.kind !== 'lines')
})

/* ── 块类型路由：subagent（workflow 工具组落通用 tool 形态，§7.4 workflow 层 2）── */
const isSubagent = computed(() => SUBAGENT_TOOL_NAMES.has(toolName.value))

/** 普通 tool header 的块类型 ICON（running 用 RunningBlockIcon，其余走 BLOCK_ICON_LUCIDE）。
 *  bash running 豁免动效图标（2026-10-17 方案 A 裁决）：status 归一 completed，
 *  经 TOOL_ICON_MAP 落完成档 tool-cmd 静态箭头（与完成态同形同色）；其余工具 running
 *  kind 为 'running'，回退 tool-other 字形（实际渲染走模板 RunningBlockIcon 分支）。 */
const headerBlockIcon = computed(() => {
  const status = isBashTool.value && isRunning.value ? 'completed' : (props.tool?.status ?? 'completed')
  const kind = getBlockIcon(toolName.value, status, false, false)
  return kind === 'running' ? BLOCK_ICON_LUCIDE['tool-other'] : BLOCK_ICON_LUCIDE[kind]
})

/** 工具名 → 运行中动效 kind（RunningBlockIcon 消费；grep/find 探索单列透镜扫掠，
 *  未命中工具走 tool-other 字形呼吸兜底。与 block-icon TOOL_ICON_MAP 同构但独立声明——
 *  本表键值语义是「动效档」而非「图标档」，两表各自服务动效/静态 SSOT。
 *  bash 不在表内：running 态豁免动效图标（2026-10-17 方案 A 裁决），不渲染 RunningBlockIcon。 */
const TOOL_RUNNING_KIND: Record<string, RunningIconKind> = {
  read: 'tool-read',
  edit: 'tool-edit',
  write: 'tool-edit',
  grep: 'tool-grep',
  find: 'tool-grep',
}
const toolRunningKind = computed<RunningIconKind>(() => TOOL_RUNNING_KIND[toolName.value] ?? 'tool-other')

/** header 图标状态色（[M3b demo 复刻] workbench.css）：状态色只落图标不落行文字——
 *  running 走模板 loader 分支（accent 呼吸弧，行文字恒 mid），failed 图标染 danger
 *  （demo .line.subagent.failed .sicon，常驻非 hover——原 hover:text-warn 形态废弃）。
 *  failed 分支显式整类重写而非在 BLOCK_ICON_CLASS 上追加 text-danger：两个 text 色
 *  工具类同特异性，追加后由样式表序裁决、覆盖不成立。行文字层级 = static
 *  text-neutral-mid（D5 工具行档 + demo .tool .t-name 恒 mid 双依据）。 */
const headerIconClass = computed(() => (isFailed.value ? 'size-[15px] shrink-0 text-danger [stroke-width:1.6]' : BLOCK_ICON_CLASS))

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
 * bash→command、read/write/edit→path、grep→pattern、tool_search→query、codemode→code。
 * （file_path/tasks 为死分支已删：pi 1.0.0 内置 edit/write 主参数是 path；tasks 参数
 * 工具 subagent_batch 的 name 是脚本路径——落在通用 header 摘要之外，展开区渲插件树。）
 * 未覆盖的工具返回空串（header 只显 toolName，
 * 或由 details.summary 自报摘要接管）。
 */
const argPath = computed(() => {
  const input = props.tool?.input as Record<string, unknown> | undefined
  if (!input) return ''
  if (typeof input.command === 'string') return input.command
  if (typeof input.path === 'string') return input.path
  if (typeof input.pattern === 'string') return input.pattern
  if (typeof input.query === 'string') return input.query
  if (typeof input.code === 'string') return input.code
  return ''
})

/** 收起态一行摘要（extension 自报）：tool.details.summary（details 是各扩展自定的自由
 *  结构，summary 字段经 unknown typeof 守卫读取）。非空时优先于 argPath 参数派生摘要。 */
const detailsSummary = computed(() => {
  const details = props.tool?.details
  if (!details) return ''
  const summary = details.summary
  return typeof summary === 'string' ? summary : ''
})

/* ── N1（ui-optimize-unified 决策 8）：edit/write 工具行文件 basename chip ──
 * edit/write = pi builtin 写文件工具（shared BUILTIN_TOOLS；block-icon 同族归并 tool-edit），
 * header 摘要从完整路径 shortenForHeader 升级为 basename chip；read/bash 等其他工具行不变。 */
const isFileWriteTool = computed(() => toolName.value === 'edit' || toolName.value === 'write')

/** chip 显示名：路径末段（UserBubble file badge 的 fileBasename 同款口径，仅按 / 切分） */
const fileChipBasename = computed(() => {
  const parts = argPath.value.split('/')
  return parts[parts.length - 1] ?? argPath.value
})

/** edit 工具 diff 增删行数统计（core computeToolCallFill 解析 details.diff；write 工具
 * details 恒 undefined、历史会话缺字段 → undefined 不渲染统计段，形态回退现状） */
const fileChipDiffStat = computed(() => props.tool?.diffStat)

/** 点击 chip → 开 drawer detail tab（与 UserBubble badge 同语义双通道：selectFile 同 tick
 * 注入 detail tab 实例 + openDrawer 切 tab 开抽屉，缺一不可——见容器层 useDetailPane 注释） */
function openFileDetail(path: string): void {
  chatViewDeps.onFileClick(path)
  chatViewDeps.openDrawer('detail', { filePath: path })
}
</script>

<style scoped>
/* 块展开/收起过渡（chat-flow-polish P0-2）：消除 v-if 瞬时切换的生硬感。
   opacity + 轻微 translateY（从 header 方向淡入），120ms；保持 v-if 卸载折叠块的长输出
   （不做 grid 恒渲染，避免 streaming 中折叠块长 bash 输出恒挂载的性能代价）。
   escape hatch：Vue Transition 类用 scoped 表达（enter-from/leave-to 同时设 opacity+transform）。
   与 Block.vue 壳内 run-group 展开区各持一份同款规则——scoped 样式只作用于本组件
   模板元素。 */
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

/* 执行中文字扫光（ui-optimize-unified 决策 10 / N13）：扫光对象 = 执行中工具行正在发生的
   内容文字（执行命令/摘要），稳定标识（工具名/时间戳/计数）不扫。机制 =
   background-clip:text + 透明字色，base（--sweep-base，缺省 dim 档 = 尾行视口/摘要常态字色）
   与 peak（--neutral-fg）全令牌化，六主题免逐个定值。周期 2.6s：前 55% 扫程（peak 自元素
   左外 -25% 移至右外 125%），后 45% 停帧。keyframes（text-sweep）在 renderer style.css
   动画区全局定义——scoped 内定义会被编译器哈希改名而失效（同全局动画区先例理由）。
   prefers-reduced-motion 由 style.css 全局兜底（duration 0.01ms 停终态帧 position 0%，
   元素内恒 base 段 = 常态字色，「退回常态字色」构造性成立，无需额外覆盖）。
   escape hatch 理由：多属性组合类 + 变量参数化 + 停帧几何推导，Tailwind 任意值
   内联需 6 类 × 5 消费点且 motion-reduce 变体逐点易漏。与 ThinkingRow.vue 各持一份
   同款规则（scoped 样式只作用于本组件模板元素）。 */
.text-sweep {
  --sweep-base: var(--neutral-dim);
  background-image: linear-gradient(100deg, var(--sweep-base) 42%, var(--neutral-fg) 50%, var(--sweep-base) 58%);
  background-size: 250% 100%;
  background-repeat: no-repeat;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: text-sweep 2.6s cubic-bezier(0.45, 0, 0.25, 1) infinite;
}

/* 工具行文件 chip hover 滚动（MF-1-24，demo workbench.css .fchip-roll 轻方案原样移植）：
   静态截断由容器 truncate（ellipsis）承担，hover 时容器 text-overflow:clip（模板
   hover:[text-overflow:clip] 任意属性类）+ 内层 .fchip-roll 从原位滚到文末停（forwards），
   短名 min(0px, 304px-100%) 取 0 不滚（304 = max-w 320 - 左右 padding 16）。
   escape hatch：keyframes + 后代选择器组合（Tailwind 无法表达 hover 触发的位移动画）。
   keyframes 在 scoped 内定义 + 同块引用自洽（Vue SFC 编译器对 scoped keyframes 同块重写
   动画名；仅本组件单消费点，无跨组件引用失效问题）。 */
.tool-file-chip:hover .fchip-roll { animation: fchip-roll-x 2.4s var(--ease-out) 0.35s forwards; }
@keyframes fchip-roll-x { to { transform: translateX(min(0px, calc(304px - 100%))); } }
@media (prefers-reduced-motion: reduce) { .tool-file-chip:hover .fchip-roll { animation: none; } }

</style>
