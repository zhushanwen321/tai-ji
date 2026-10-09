<template>
  <!--
    展示组件 · panel-header（ui-replica M2：demo Workbench.vue .panelhead 40px 档形态）。
    demo 权威值（.app 变量 --hb-*）：卡头高 40（N16 单档终态）、内边距 0 14px、行 gap 8px、
    基色 --mid、字号 14px、底边框 1px --hairline 与对话流分隔（bg 沉底与对话流连成一体）。
    布局：状态图标 + 会话名 + 目录/分支次要行 + ... + [jsonl|对话/Trace|终端|drawer]。
    折叠态：收起/←/→ 三钮迁入卡头最左 chrome 槽位（34 宽 × 30 高，demo .pch）+ 新建任务钮（demo .hdr-fold）；
    非全屏 pl-[88px] 让位红黄绿（右缘 60），全屏态 pl-4。唤回侧栏靠 ⌘B + chrome 按钮。
    中线几何：main-panel 顶 y4（AppShell 上内边距）+ chat 卡 1px 上边框 = 卡头顶 y5，
    40px 高 → 中线 y25 = 窗口 chrome 行（AppNavControls top 9 + 32/2）与红黄绿（trafficLightPosition y16）共线。
    拖拽区：header 空白 -webkit-app-region:drag，交互元素 no-drag。
    背景 = bg-surface（沉底连体保留）。
  -->
  <header
    class="flex h-[40px] flex-shrink-0 items-center gap-2 border-b border-hairline bg-surface px-3.5 text-[length:var(--text-base)] text-neutral-mid [-webkit-app-region:drag]"
    :class="showChrome && !isFullscreen ? 'pl-[88px]' : 'pl-4'"
  >
    <!-- 折叠态 chrome 槽位：收起/←/→ + 新建任务（demo .pch ×3 + .hdr-fold）。
         组内 gap 8px（demo .panelhead gap）；整组 no-drag；flex-shrink:0 让会话名自动右移。 -->
    <div
      v-if="showChrome"
      class="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]"
    >
      <Button
        variant="ghost"
        size="icon"
        class="nav-btn h-[30px] w-[34px] rounded-sm text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg"
        :title="sidebar.collapsed ? t('panel.header.toggleSidebarExpand') : t('panel.header.toggleSidebarCollapse')"
        :aria-label="t('panel.header.toggleSidebarAria')"
        data-testid="sidebar-collapse-toggle"
        @click="sidebar.toggleCollapsed()"
      >
        <PanelLeftOpen v-if="sidebar.collapsed" class="size-[17px]" stroke-width="1.6" />
        <PanelLeftClose v-else class="size-[17px]" stroke-width="1.6" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="nav-btn h-[30px] w-[34px] rounded-sm text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-dim"
        :disabled="!navigation.canBack"
        :title="t('panel.header.back')"
        :aria-label="t('panel.header.back')"
        @click="navigation.back()"
      >
        <ArrowLeft class="size-[17px]" stroke-width="1.8" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="nav-btn h-[30px] w-[34px] rounded-sm text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-dim"
        :disabled="!navigation.canForward"
        :title="t('panel.header.forward')"
        :aria-label="t('panel.header.forward')"
        @click="navigation.forward()"
      >
        <ArrowRight class="size-[17px]" stroke-width="1.8" />
      </Button>
      <!-- 新建任务钮（demo .hdr-fold：折叠态卡头唯一新建入口，展开态随组隐藏） -->
      <Button
        variant="ghost"
        size="icon"
        class="h-[30px] w-[30px] rounded-sm text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg"
        :title="t('workspace.newTask')"
        :aria-label="t('workspace.newTask')"
        data-testid="panel-header-new-task"
        @click="onNewTask"
      >
        <Plus class="size-[17px]" stroke-width="1.8" />
      </Button>
    </div>
    <component
      :is="ICON_COMPONENTS[iconConfig.icon]"
      data-testid="panel-session-icon"
      :data-icon="iconConfig.icon"
      class="size-[13px] shrink-0"
      :class="[iconConfig.color, iconConfig.animation]"
    />
    <!-- 会话名（demo 问题 7 裁决：卡头只显会话名）+ 目录/分支次要行（real 独有信息保留，
         mono 小字弱化，demo crumb 语言：sep 用 faint）。长会话名截断优先发生于此，
         绝不盖右侧按钮组（按钮组 ml-auto + shrink-0）。 -->
    <div class="flex min-w-0 shrink items-center gap-1.5 [-webkit-app-region:no-drag]">
      <span
        class="truncate font-bold"
        data-testid="panel-session-label"
        :title="sessionLabel || t('workspace.newTask')"
      >{{ sessionLabel || t('workspace.newTask') }}</span>
      <span
        v-if="dirName"
        class="truncate font-mono text-[length:var(--text-2xs)] text-neutral-dim"
        :title="`${t('panel.header.workingDir')}：${sessionDir}`"
      >{{ dirName }}</span>
      <template v-if="gitBranch">
        <span aria-hidden="true" class="shrink-0 text-neutral-faint">/</span>
        <span
          class="truncate font-mono text-[length:var(--text-2xs)] text-neutral-dim"
          :title="`${t('panel.header.branch')}：${gitBranch}`"
        >{{ gitBranch }}</span>
      </template>
    </div>

    <div class="ml-auto flex items-center gap-2 [-webkit-app-region:no-drag]">
      <!-- session JSONL 文件名（id 前 8 位 + .jsonl）：点击复制磁盘真实绝对路径。
           路径为空（pi 延迟写入窗口，规则 #6）时不渲染。放右侧按钮组最前。
           [U7] overlay 移除后恒用主 sessionFile（不再有 overlaySessionFile 两态）。 -->
      <Button
        v-if="sessionFile"
        variant="ghost"
        data-testid="panel-session-file"
        class="h-5 shrink-0 gap-1 rounded px-1 font-mono text-[length:var(--text-2xs)] text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg [-webkit-app-region:no-drag]"
        :title="t('panel.header.copySessionFile')"
        @click="copy(sessionFile, 'file')"
      >
        <Check v-if="copied === 'file'" class="size-3 text-accent" />
        <FileText v-else class="size-3 opacity-60" />
        <span>{{ shortFileName }}</span>
      </Button>
      <!-- session-trace（D5a）：「对话 | Trace」SegmentedTab。视图态 per-session 分区（store
           view 字段），切换仅切 main 区渲染分支，不重建数据（A42）。
           landing（无 session）恒渲染但 disabled（demo Workbench.vue 卡头分段
           :disabled="route.name === 'new-task'" 同款——分段是卡头常驻形态，空态不可点）。 -->
      <TraceViewToggle
        :model-value="tracePartition.view"
        :disabled="!sessionId"
        @update:model-value="onTraceViewChange"
      />
      <!-- ExtensionHost panel.header 挂载点（audit §12.1，MountPointRegistry panel.header）。
           plugin 经 views.update 贡献 header action 视图 → ViewHost 渲染。
           empty="hidden"：无贡献时整组件零 DOM，不挤压右侧内置按钮。见 02-extension-host-wiring.md。 -->
      <ViewHost
        v-if="sessionId"
        view-id="panel.header"
        :session-id="sessionId"
        empty="hidden"
      />
      <!-- 终端开关（三卡化 2026-10-04 迁入：原 StatusBar 底栏落点退役，鼠标路径入口与其它
           容器开关同区，位于右侧抽屉开关左边）。恒显（不随折叠态 chrome 迁移、不随 sessionId
           消失——landing 态也开终端区，与原 StatusBar 按钮行为对齐）。 -->
      <TerminalToggleButton />
      <!-- SideDrawer toggle（always-visible）。demo 形态：30×30 钮 + 17px 图标（--hb-btn/--hb-icon），
           开态无选中视觉（demo 选中态范式不含卡头开关钮），开关反馈由抽屉面板本身承担。 -->
      <Button
        v-if="!showChrome"
        variant="ghost"
        size="icon"
        class="size-[30px] rounded-sm text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg [-webkit-app-region:no-drag]"
        data-testid="drawer-toggle"
        :title="t('panel.sideDrawer.title')"
        @click="emit('toggleDrawer')"
      >
        <PanelRight class="size-[17px]" stroke-width="1.6" />
      </Button>
      <!-- 三点更多 ⋯（G2-005 rename 等）全 DEFERRED，按 G3-002 hide 规则不显示 -->
    </div>
  </header>
</template>

<script setup lang="ts">
 
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { PanelLeftOpen, PanelLeftClose, PanelRight, ArrowLeft, ArrowRight, Plus, RefreshCw, ArrowUpCircle, Hourglass, Wrench, Zap, CheckCircle2, Ban, AlertCircle, FileText, Check } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useNavigationStore } from '@/stores/navigation'
import { useSidebarStore } from '@/stores/sidebar'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { usePlatformChrome } from '@/composables/effects/usePlatformChrome'
import { useCopy } from '@/composables/panel/useCopy'
import TerminalToggleButton from './TerminalToggleButton.vue'
import { useSessionTrace, setTraceView, type TraceMainView } from '@/composables/features/trace/useSessionTrace'
import TraceViewToggle from './trace/TraceViewToggle.vue'
import { ViewHost } from '@taiji/ui/extension-host'
import type { DerivedStatus } from '@/types'
import { STATUS_ICON } from '@/composables/logic/sessionStatus'
import { formatShortSessionFile } from '@/composables/logic/session-file-format'

const props = defineProps<{
  sessionLabel: string
  sessionDir: string
  /** 当前 session id（ExtensionHost panel.header 挂载点 ViewHost 路由键） */
  sessionId?: string
  /** session JSONL 绝对路径（pi 延迟写入窗口可能为空，不渲染文件名） */
  sessionFile?: string
  gitBranch?: string
  status: DerivedStatus
}>()

const emit = defineEmits<{
  /** 切换 SideDrawer 开关（always-visible 按钮） */
  toggleDrawer: []
}>()

const { t } = useI18n()
const navigation = useNavigationStore()
const sidebar = useSidebarStore()
const { newSession } = useSidebar()
const { isFullscreen } = usePlatformChrome()
// session-trace：视图态读 store 当前分区（分区键 focusedSessionId == props.sessionId，单 panel 恒真）
const { partition: tracePartition } = useSessionTrace()

/** trace 切换接收点：仅在有 session 时落库（landing 态分段已 disabled，此处是类型面守卫冗余）。 */
function onTraceViewChange(view: TraceMainView): void {
  if (props.sessionId) setTraceView(props.sessionId, view)
}

/** 折叠态新建任务钮（demo .hdr-fold）：复用 sidebar 新建任务流（landing/会话创建统一入口）。 */
async function onNewTask(): Promise<void> {
  await newSession()
}

/**
 * 折叠态 chrome 槽位判据：sidebar 折叠 → 收起/←/→ + 新建任务迁入此 header（demo .app.folded
 * .panelhead .pch { display:inline-flex } 同语义）。v2：单 panel 恒 P1，不再需要 isFirstPanel 判据。
 * 安全区 padding 由 template 的 `showChrome && !isFullscreen` 二级判断：
 * 非全屏留 pl-[88px] 让位 traffic-light（红黄绿 x8~60）；全屏红黄绿 OS 隐藏，header pl-4 不让位。
 */
const showChrome = computed(() => sidebar.collapsed)

/** 工作目录名（cwd 末段）：只显最后一级目录，避免目录+分支过长盖住右侧按钮（title 仍显全路径）。 */
const dirName = computed(() => {
  const segs = props.sessionDir.split('/').filter(Boolean)
  return segs.length ? segs[segs.length - 1] : props.sessionDir
})

/** 当前状态对应的语义图标配置（icon / color / animation） */
const iconConfig = computed(() => STATUS_ICON[props.status])

/** session JSONL 短文件名（前 8 位 + .jsonl）；sessionFile 为空时返回空串 */
const shortFileName = computed(() => (props.sessionFile ? formatShortSessionFile(props.sessionFile) : ''))

/** 复制反馈（点击文件名后 1.2s 显示 Check 图标） */
const { copied, copy } = useCopy()

/** lucide 图标名 → 组件映射 */
const ICON_COMPONENTS: Record<string, unknown> = {
  RefreshCw,
  ArrowUpCircle,
  Hourglass,
  Wrench,
  Zap,
  CheckCircle2,
  Ban,
  AlertCircle,
}
</script>
