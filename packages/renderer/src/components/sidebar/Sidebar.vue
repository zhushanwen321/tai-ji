<template>
  <!--
    容器组件 · L1 Sidebar（sidebar/spec.md 四态）。
    分层（自上而下，对齐 demo .sidebar 区块序）：Brand → 新建任务 →
    次操作 nav（导入会话 ⌘I / 搜索 ⌘K）→ segmented tab（会话|文件|Plugins）→ 子视图区 → 用户区。
    项目管理 = 会话视图内的锚定分组（R6.2，SessionList + ProjectGroup），顶部无独立切换条——
    原 ProjectSwitcher 卡片网格随 R6.2 复刻退役（切换路径唯一化到组头点击）。
    折叠态 C：整体隐藏（width:0 + opacity:0），spec §收起态。
    File View 内容 G2-003 defer。
    [HISTORICAL] 2026-09-16 五 tab 收敛为三 tab：Agents（子代理列表）/ Flows（工作流列表 +
    详情视图）两 tab 及其挂载分支退役，任务观察入口唯一化收敛到 composer 任务托盘——原
    「侧栏任务 tab 数 vs 托盘计数」双口径穿帮面随之消灭。
  -->
  <div
    data-fs-scope="sidebar"
    class="sidebar h-full [--edge-fade-sink:var(--bg)] data-[collapsed=true]:invisible motion-reduce:data-[collapsed=true]:hidden"
    :class="{ 'w-0 opacity-0 overflow-hidden': sidebar.collapsed }"
    :data-collapsed="sidebar.collapsed ? 'true' : undefined"
  >
    <div class="sidebar__inner flex h-full w-[252px] flex-col">
      <!-- Brand（太极 logo + 产品名 + 版本号 + 升级指示器，v6 §6.2） -->
      <Brand :version-label="versionLabel">
        <template #trailing>
          <!-- 升级状态指示器（useAppUpdate 单例 state，idle/checking 不渲染） -->
          <UpdateButton class="ml-auto" />
        </template>
      </Brand>

      <!-- 新建任务（demo .newtask：卡主操作，中性浮起底——用户裁决 2026-10-06；2026-10-14
           全族迁移：旧 bg-bg-elevated 浮层档 → bg-bg-card 操作域浮起档）。
           快捷键提示并入 :title（demo data-tip 悬停形态），不渲染常驻 kbd。 -->
      <Button
        variant="ghost"
        class="mx-[10px] mt-[2px] mb-[4px] flex h-auto justify-start gap-[8px] rounded border border-hairline bg-bg-card px-[10px] py-[8px] text-[length:var(--text-sm)] [font-weight:var(--fw-mid)] text-neutral-fg transition-colors hover:bg-bg-card hover:border-border-strong"
        :title="`${t('sidebar.newTask')} · ${formatKbd('n')}`"
        @click="onNewSession"
      >
        <Plus class="size-[15px] shrink-0" :stroke-width="1.8" />
        <span class="flex-1 text-left">{{ t('sidebar.newTask') }}</span>
      </Button>

      <!-- 次操作 nav：导入会话 ⌘I / 搜索 ⌘K（demo .snav ghost 行）。
           导入会话入口（import-session 设计 §3.1）：外部 pi session 纳入管理；open 状态
           本组件持有，⌘I 经 useGlobalShortcuts 注入的 onOpenImportSession 派发同一状态。 -->
      <nav class="flex flex-col px-[6px] py-[2px]">
        <Button
          variant="ghost"
          data-testid="sidebar-import-session-btn"
          class="group flex h-auto w-full justify-start gap-[9px] rounded-sm px-[8px] py-[7px] text-[length:var(--text-sm)] text-neutral-mid transition-colors hover:bg-surface-hover hover:text-neutral-fg"
          :title="`${t('importSession.title')} · ${formatKbd('i')}`"
          @click="importOpen = true"
        >
          <Download class="size-[15px] shrink-0" :stroke-width="1.6" />
          <span class="flex-1 text-left">{{ t('importSession.title') }}</span>
        </Button>
        <Button
          variant="ghost"
          class="group flex h-auto w-full justify-start gap-[9px] rounded-sm px-[8px] py-[7px] text-[length:var(--text-sm)] text-neutral-mid transition-colors hover:bg-surface-hover hover:text-neutral-fg"
          :title="`${t('sidebar.search')} · ${formatKbd('k')}`"
          @click="searchModal.open()"
        >
          <Search class="size-[15px] shrink-0" :stroke-width="1.6" />
          <span class="flex-1 text-left">{{ t('sidebar.search') }}</span>
        </Button>
      </nav>

      <!-- segmented tab（会话 | 文件 | Plugins） -->
      <SegmentedTab
        v-model="sidebar.activeTab"
        :session-count="sessionCount"
        :file-count="fileCount"
      />

      <!-- 子视图区：会话列表 / 归档列表 / 文件视图 / plugin sidebar view。
           视图切换方向滑入（spec §3.1 裁决 P1-6，demo vt-slide 同语言）：三个分支各挂
           viewSlideCls——目标视图序号更大自右滑入、反之自左；v-if 分支重挂载使动画每次
           切换重播；首次进入不播（方向类初始为空，watch 置值前无类）。
           [session-archive D10，u-renderer-entry] sessions tab 内容区二态视图：
           archive store.viewOpen 时切为归档列表（ArchiveListView），否则会话列表。 -->
      <div class="min-h-0 flex-1 overflow-hidden">
        <template v-if="sidebar.activeTab === 'sessions'">
          <div class="h-full min-h-0" :class="viewSlideCls">
            <!-- S5：加载失败态 + 重试（session.listLoadError 非空时） -->
            <div
              v-if="session.listLoadError"
              class="flex flex-col items-center justify-center gap-2 py-10 text-center"
              data-testid="session-list-error"
            >
              <AlertCircle class="size-5 text-danger opacity-60" />
              <p class="text-[length:var(--text-2xs)] text-neutral-mid">{{ t('sidebar.sessionListLoadFailed', { error: session.listLoadError }) }}</p>
              <Button variant="ghost" class="h-6 text-[length:var(--text-2xs)] text-accent" data-testid="session-list-retry" @click="onRetryLoadSessions">{{ t('sidebar.retry') }}</Button>
            </div>
            <!-- 归档列表视图（D10：工具组归档入口打开；返回钮/恢复成功切回） -->
            <ArchiveListView
              v-else-if="archiveStore.viewOpen"
              :archives="archiveStore.archives"
              :loading="archiveStore.loading"
              :list-error="archiveStore.listError"
              @back="onArchiveBack"
              @select="onArchiveSelect"
              @restore="onArchiveRestore"
              @purge="onArchivePurge"
              @retry="onArchiveRetry"
            />
            <SessionList
              v-else
              :groups="session.groups"
              :active-id="focusedSessionId"
              :status-of="statusOf"
              :archive-count="archiveStore.archiveCount"
              @select="onSelectSession"
              @new-session="onNewSession"
              @rename="onRenameSession"
              @archive="onArchiveSession"
              @open-archives="onOpenArchives"
              @delete-folder="onDeleteFolder"
              @new-session-in-folder="onNewSessionInFolder"
              @abort="onAbortSession"
              @force-quit="onForceQuitSession"
              @set-project="onAssignProject"
              @export-jsonl="onExportSessionJsonl"
            />
          </div>
        </template>
        <!-- ExtensionHost sidebar view 宿主（audit §12.1 sidebar.tab 挂载点）。
             L2 二级路由：PluginViewContainer 经 VIEWS_SOURCE_KEY 取 plugin view 清单
             （ContributionRegistry sidebar.tab 贡献）→ L2TabBar 切 tab → ViewHost 渲染
             （数据按 viewId 'todo'/'goal' 落，见 02-extension-host-wiring.md 重构 2）。
             sessionId 绑定焦点 session。 -->
        <template v-else-if="sidebar.activeTab === 'plugins'">
          <div class="h-full min-h-0" :class="viewSlideCls">
            <PluginViewContainer
              v-if="focusedSessionId"
              :session-id="focusedSessionId"
            />
            <!-- 无焦点 session 时空态占位，与 files tab 同范式 -->
            <div
              v-else
              class="flex flex-col items-center justify-center gap-2 py-10 text-center"
              data-testid="sidebar-plugin-no-session"
            >
              <Puzzle class="size-5 text-neutral-dim opacity-40" />
              <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-55">{{ t('sidebar.selectSessionHint') }}</p>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="h-full min-h-0" :class="viewSlideCls">
            <FileView
              v-if="focusedSessionId"
              :session-id="focusedSessionId"
              :session-label="currentSession?.label"
              :branch="currentSession?.gitBranch"
            />
            <!-- 无 active session（无聚焦态）→ 文件视图空态占位 -->
            <div
              v-else
              class="flex flex-col items-center justify-center gap-2 py-10 text-center"
              data-testid="file-view-no-session"
            >
              <FolderOpen class="size-5 text-neutral-dim opacity-40" />
              <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-55">{{ t('sidebar.selectSessionHint') }}</p>
            </div>
          </div>
        </template>
      </div>

      <!-- 用户区（footer）· demo .side-foot：hairline 顶线分隔 + 开发者身份行（accent 软底头像
           + 名字 + 三图标钮）。三钮左→右 = 远程连接 / 外观快捷面板 / 设置（demo Sidebar.vue:437-445；
           原 M1「无对应功能不补」裁决经用户反馈覆盖——前两钮接线到真实功能：设置弹层 remote-access
           分区 + 六主题 setSystem 即时切换）。钮形 = demo .tbtn（32px 方钮——.app 作用域
           --hb-chrome-btn 继承值，fallback 24 不生效——+ 15px 图标 + dim→fg hover）。 -->
      <!-- 净内缩 14/12/10 = demo .side-foot padding 10px + .user 行 padding 2px 4px 0 折算（本结构无
           .user 中间行，直接写净值）；14px rem 基准下 px-3.5/pb-2.5/pt-3 会收缩为 12.25/8.75/10.5，
           故 px-bracket 定值 -->
      <div class="mt-auto flex-none border-t border-hairline px-[14px] pt-[12px] pb-[10px]">
        <div class="flex items-center gap-[9px]">
          <span class="size-[20px] shrink-0 rounded-full border border-accent-ring bg-accent-soft" />
          <span class="min-w-0 flex-1 truncate text-[length:var(--text-sm)] [font-weight:var(--fw-mid)] text-neutral-fg-2">{{ t('sidebar.developer') }}</span>
          <Button
            variant="ghost"
            class="grid size-[32px] shrink-0 place-items-center rounded-sm p-0 text-neutral-dim transition-colors hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-[15px]"
            :title="t('sidebar.remoteConnect')"
            :aria-label="t('sidebar.remoteConnect')"
            data-testid="sidebar-remote-connect"
            @click="openSettings('remote-access')"
          >
            <Smartphone :stroke-width="1.6" />
          </Button>
          <Popover v-model:open="quickThemeOpen">
            <PopoverTrigger as-child>
              <Button
                variant="ghost"
                class="ml-[4px] grid size-[32px] shrink-0 place-items-center rounded-sm p-0 text-neutral-dim transition-colors hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-[15px]"
                :title="t('sidebar.quickAppearance')"
                :aria-label="t('sidebar.quickAppearance')"
                data-testid="sidebar-quick-appearance"
                @mouseenter="quickThemeEnter"
                @mouseleave="quickThemeLeave"
                @click="quickThemeTriggerClick"
              >
                <Palette :stroke-width="1.6" />
              </Button>
            </PopoverTrigger>
            <!-- 外观快捷面板 = demo .qs-panel（workbench.css:209-218）：212px 浮层卡（2026-10-13
                 用户裁决 demo 方案 A 全族迁移：bg-bg + border 同源档，旧 elevated 底 + border-strong
                 退役 / r-lg / shadow-3），头「主题」（11px）+ 双列色卡 chip（外框主题底 +
                 内点 accent）；选中态 = demo Tier A 范式（--sel-bg accent tint 底 + inset 1px
                 --sel-edge 描边）；左对齐锚钮 + 底距钮顶 8px（demo placeQs 公式）；hover 开 +
                 离开 260ms 延迟关（demo qsEnter/qsLeave 同款）；z 取 demo --z-hovercard 档 -->
            <PopoverContent
              side="top"
              align="start"
              :side-offset="8"
              class="z-[var(--z-hovercard)] w-[212px] min-w-[212px] rounded-[var(--radius-lg)] border-border p-[10px] shadow-3 ![transition-property:none]"
              data-testid="sidebar-quick-appearance-panel"
              @open-auto-focus="onQuickThemeOpenAutoFocus"
              @mouseenter="quickThemeCancelClose"
              @mouseleave="quickThemeLeave"
            >
              <div class="mb-[6px] mt-[2px] px-[2px] text-[length:var(--text-2xs)] [font-weight:var(--fw-mid)] tracking-[0.05em] text-neutral-dim">{{ t('sidebar.quickThemeTitle') }}</div>
              <div class="grid grid-cols-2 gap-[4px]">
                <Button
                  v-for="th in TAIJI_THEMES"
                  :key="th.label"
                  type="button"
                  variant="ghost"
                  class="flex items-center gap-[7px] rounded-[var(--radius-sm)] border border-transparent px-[8px] py-[5px] text-left text-[length:var(--text-xs)] transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]"
                  :class="th.label === currentTheme.label
                    ? 'bg-[var(--sel-bg)] text-neutral-fg shadow-[inset_0_0_0_1px_var(--sel-edge)] [font-weight:var(--fw-mid)] hover:bg-[var(--sel-bg)]'
                    : 'font-normal text-neutral-fg-2 hover:bg-surface-hover hover:text-neutral-fg'"
                  :aria-pressed="th.label === currentTheme.label"
                  :data-testid="`sidebar-quick-theme-${th.preset || th.theme}`"
                  @click="applyTheme(th)"
                >
                  <span
                    class="flex size-[14px] flex-none items-center justify-center rounded-[var(--radius-xs)] border border-border-strong"
                    :style="{ background: th.swatch[3] }"
                  >
                    <i class="block size-[6px] rounded-full" :style="{ background: th.swatch[0] }" />
                  </span>
                  <span class="min-w-0 truncate">{{ th.shortName }}</span>
                </Button>
              </div>
              <!-- 对话流字号快捷段（chat-flow-text-color 同批：字号/主题快调，分支合并折入）：
                   chat 分区 4 档 segmented，写 settings.fontScales.chat（SSOT 回落 DEFAULT_FONT_SCALES），
                   DOM 同步由 applySystemToDom 承接。选中态同面板 Tier A 语言。 -->
              <div class="mb-[6px] mt-[10px] px-[2px] text-[length:var(--text-2xs)] [font-weight:var(--fw-mid)] tracking-[0.05em] text-neutral-dim">{{ t('settings.appearance.quickChatFont') }}</div>
              <div class="flex gap-[2px] rounded-[var(--radius-sm)] bg-bg-input p-[3px]" data-testid="sidebar-quick-chat-font">
                <Button
                  v-for="tier in FONT_SCALE_TIERS"
                  :key="tier"
                  type="button"
                  variant="ghost"
                  class="h-[24px] flex-1 justify-center rounded-[var(--radius-xs)] px-[4px] text-[length:var(--text-2xs)] transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]"
                  :class="chatTier === tier
                    ? 'bg-surface-hover text-neutral-fg shadow-[inset_0_0_0_1px_var(--sel-edge)] [font-weight:var(--fw-mid)] hover:bg-surface-hover hover:text-neutral-fg'
                    : 'font-normal text-neutral-mid hover:bg-transparent hover:text-neutral-fg'"
                  :data-testid="`sidebar-quick-chat-${tier}`"
                  :aria-pressed="chatTier === tier"
                  @click="applyChatTier(tier)"
                >
                  {{ t(`settings.appearance.${TIER_LABEL_KEYS[tier]}`) }}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            class="ml-[4px] grid size-[32px] shrink-0 place-items-center rounded-sm p-0 text-neutral-dim transition-colors hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-[15px]"
            :title="t('sidebar.settingsTitle')"
            :aria-label="t('sidebar.settingsTitle')"
            data-testid="sidebar-settings"
            @click="openSettings('appearance')"
          >
            <!-- 内联 gear = demo Sidebar.vue side-foot 设置钮的同一 path（经典 feather settings
                 几何，齿形外沿 x3–21 占 viewBox 18/24）。现役 @lucide/vue v1.23 的 Settings 已重绘
                 为小齿形（占 16/24），同 15px 盒内墨迹比 demo 小一圈（r4 footer 项：demo ~14×14 vs
                 real ~12×13）；footer 三钮中另两钮的 lucide 几何与 demo 一致，仅此一枚需对齐源
                 path。尺寸 15px 由容器类 [&_svg]:size-[15px] 单点声明，描边 1.6 与同排另两钮一致。 -->
            <svg class="shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </Button>
        </div>
      </div>
    </div>

    <!-- 搜索浮层（⌘K 触发的全局 Overlay，spec §搜索浮层剥离） -->
    <SearchModal
      v-model:open="isOpen"
      :active-session-id="focusedSessionId"
      :deps="searchDeps"
      :on-open-drawer="onOpenSearchDrawer"
      :on-toast-error="toastError"
    />

    <RenameSessionDialog
      v-model:open="renameOpen"
      :session-id="targetSessionId"
      @confirm="onConfirmRename"
    />

    <!-- 导入会话对话框（u5 组件，u6 入口接线）：成功导入后 runtime 广播 session.list，
         侧边栏经既有链路刷新；imported 事件在此驱动 fresh「导入」徽标（u7，会话条目
         数秒后淡出，无需其他补偿动作） -->
    <ImportSessionDialog v-model:open="importOpen" @imported="onSessionImported" />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Plus, Search, FolderOpen, AlertCircle, Puzzle, Download, Smartphone, Palette } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SearchModal } from '@taiji/ui'
import { PluginViewContainer } from '@taiji/ui/extension-host'
import { useSearchModal, getSettingsStore } from '@taiji/core'
import { TAIJI_THEMES, resolveTaijiTheme, type TaijiTheme } from '@/composables/useTaijiThemes'
import { DEFAULT_FONT_SCALES, type FontScaleTier } from '@taiji/core'
import { useSessionStore } from '@/stores/session'
import { useSidebarStore } from '@/stores/sidebar'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { useSessionDerivations } from '@/composables/features/chat/useSessionDerivations'
import SegmentedTab from './SegmentedTab.vue'
import SessionList from './SessionList.vue'
import UpdateButton from './UpdateButton.vue'
import Brand from './Brand.vue'
import FileView from './FileView.vue'
import RenameSessionDialog from './RenameSessionDialog.vue'
import ImportSessionDialog from './ImportSessionDialog.vue'
import {
  markImportedFresh,
  type ImportSessionImportedPayload,
} from '@/composables/features/sidebar/useImportSession'
import { useGlobalShortcuts } from '@/composables/shell/useGlobalShortcuts'
import { useNavigationStore } from '@/stores/navigation'
import { useSidebarCounts } from '@/composables/features/sidebar/useSidebarCounts'
import { useSidebarSessionActions } from '@/composables/features/sidebar/useSidebarSessionActions'
import { useArchiveView, useArchiveCountBroadcast } from '@/composables/features/sidebar/useArchiveView'
import { useArchiveStore } from '@/stores/archive'
import ArchiveListView from './ArchiveListView.vue'
import { useAppUpdate } from '@/composables/features/settings/useAppUpdate'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { usePlatformShortcut } from '@/composables/usePlatformShortcut'
import * as events from '@taiji/core/transport/api'

const { t } = useI18n()
const { formatKbd } = usePlatformShortcut()
const searchModal = useSearchModal()
const { isOpen } = searchModal
const session = useSessionStore()
const sidebar = useSidebarStore()
const { error: toastError } = useToast()
const openSettings = inject<(section?: string) => void>('openSettings', () => {})
// 外观快捷面板（demo .qs-panel）：六主题即时切换，写同一条 setSystem 通道（settings 弹层
// onSystemUpdate 同源——持久化 + DOM 同步在 store 内完成），选中项经 resolveTaijiTheme 解析。
// 交互 = demo qsEnter/qsLeave 同款：hover 立即开、离开 260ms 延迟关（钮与面板共享定时——
// 鼠标在钮与面板间移动不闪关）、click 由 Popover v-model 切换、点外/Esc 走 reka dismiss
const quickThemeOpen = ref(false)
let quickThemeCloseTimer: number | undefined
const QUICK_THEME_CLOSE_DELAY_MS = 260

/**
 * 打开来源旗标（demo toggleQs 焦点语义，r2 条 8）：hover 打开不移焦——鼠标划过抢焦点
 * 会中断正在输入的用户；click 打开保留 reka 默认移焦（对齐 aria-haspopup="dialog" 语义）。
 * open-auto-focus 在 FocusScope 挂载时同步读旗标：mouseenter 置位先于 reka 弹层渲染，
 * click 置位（同步 handler）先于 open 状态驱动的 FocusScope 挂载，两路时序均成立。
 */
let quickThemeOpenedByHover = false

/** hover 进入（钮）：取消待关定时并打开（demo qsEnter 同款），标记来源 = hover */
function quickThemeEnter(): void {
  window.clearTimeout(quickThemeCloseTimer)
  quickThemeOpenedByHover = true
  quickThemeOpen.value = true
}

/** 钮 click（reka Trigger 原生 click 切 v-model，与 hover 共用同一显隐状态）：
 *  标记来源 = click——open=false 时 click 打开（键盘 Enter/Space 路径）保留移焦 */
function quickThemeTriggerClick(): void {
  quickThemeOpenedByHover = false
}

/** 弹层自动聚焦仲裁（demo toggleQs）：hover 来源不抢焦点，click 来源保留 reka 默认移焦 */
function onQuickThemeOpenAutoFocus(event: Event): void {
  if (quickThemeOpenedByHover) event.preventDefault()
}

/** hover 离开（钮或面板）：延迟后收面板（demo qsLeave 同款；click 打开态同样被收——
 *  demo click 打开后鼠标移出同样 260ms 关，click 与 hover 共用同一显隐状态） */
function quickThemeLeave(): void {
  window.clearTimeout(quickThemeCloseTimer)
  quickThemeCloseTimer = window.setTimeout(() => {
    quickThemeOpen.value = false
  }, QUICK_THEME_CLOSE_DELAY_MS)
}

/** 面板 hover 进入：只清待关定时（面板已随钮打开，无需重复置位） */
function quickThemeCancelClose(): void {
  window.clearTimeout(quickThemeCloseTimer)
}

onBeforeUnmount(() => window.clearTimeout(quickThemeCloseTimer))

// ── 视图切换方向滑入（spec §3.1 裁决 P1-6，demo Sidebar.vue VIEW_ORDER 同源）──
// 方向判定 = 激活位索引比较：目标序号更大自右滑入、反之自左；初始为空 = 首次进入不播
// （无前序方向不叠动画，与抽屉面板同纪律）。reduced-motion 由 style.css 全局 reduce 块归零。
const VIEW_ORDER = ['sessions', 'files', 'plugins'] as const
const viewSlideCls = ref('')
watch(
  () => sidebar.activeTab,
  (nv, ov) => {
    if (ov === undefined) return
    viewSlideCls.value
      = VIEW_ORDER.indexOf(nv) > VIEW_ORDER.indexOf(ov) ? 'vt-slide-r' : 'vt-slide-l'
  },
)

const settingsStore = getSettingsStore()
const currentTheme = computed(() => resolveTaijiTheme(settingsStore.system.value))
async function applyTheme(th: TaijiTheme): Promise<void> {
  try {
    await settingsStore.setSystem({ theme: th.theme, themePreset: th.preset })
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

// ── 对话流字号快捷段（chat-flow-text-color 同批，分支合并折入快捷面板）──
/** chat 分区档位显示回落（SSOT = DEFAULT_FONT_SCALES，浅合并可能缺 key） */
const chatTier = computed<FontScaleTier>(
  () => settingsStore.system.value.fontScales?.chat ?? DEFAULT_FONT_SCALES.chat,
)
const FONT_SCALE_TIERS: readonly FontScaleTier[] = ['small', 'medium', 'large', 'xlarge']
/** tier → i18n 档位文案键（tierXLarge 等既有 ui locale 键复用，不新增词表） */
const TIER_LABEL_KEYS: Record<FontScaleTier, string> = {
  small: 'tierSmall',
  medium: 'tierMedium',
  large: 'tierLarge',
  xlarge: 'tierXLarge',
}
async function applyChatTier(tier: FontScaleTier): Promise<void> {
  try {
    await settingsStore.setSystem({ fontScales: { ...settingsStore.system.value.fontScales, chat: tier } })
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}
const { selectSession, restoreSession, newSession, loadSessions, renameSession, deleteSession, archiveSession, deleteFolder, assignSessionToProject, focusedSessionId, focusedSession: currentSession, forkFromLastAssistant, enterForkModeFromLastAssistant, handoffFromLastAssistant } = useSidebar()
const piVersion = ref('')
const versionLabel = computed(() => piVersion.value ? `v${__APP_VERSION__} · pi v${piVersion.value}` : `v${__APP_VERSION__}`)
const renameOpen = ref(false)
const targetSessionId = ref('')
/** 「导入会话」对话框 open 状态（入口按钮 + ⌘I 双通道派发同一状态） */
const importOpen = ref(false)
/** 导入成功 → 新会话条目挂 fresh「导入」徽标（设计 §3.1：数秒后淡出） */
function onSessionImported(payload: ImportSessionImportedPayload): void {
  markImportedFresh(payload.sessionId)
}
const { sessionCount, fileCount } = useSidebarCounts(focusedSessionId)
const { derivedStatus } = useSessionDerivations()
function statusOf(id: string) { return derivedStatus(id).value }
const { onSelectSession, onNewSession, onNewSessionInFolder, onRenameSession, onArchiveSession, onDeleteFolder, onAbortSession, onForceQuitSession, onConfirmRename, onAssignProject, onExportSessionJsonl, onRetryLoadSessions, searchDeps, onOpenSearchDrawer } = useSidebarSessionActions({ selectSession, restoreSession, newSession, loadSessions, renameSession, deleteSession, archiveSession, deleteFolder, assignSessionToProject, renameOpen, targetSessionId })

// ── 归档视图编排（session-archive D10/D11，u-renderer-entry）──
const archiveStore = useArchiveStore()
const {
  openArchiveView: onOpenArchives,
  closeArchiveView: onArchiveBack,
  openSummary: onArchiveSelect,
  restoreArchive: onArchiveRestore,
  purgeArchiveEntry: onArchivePurge,
  refreshArchives: onArchiveRetry,
} = useArchiveView()
// archiveCount 角标广播订阅（config.sessions 帧携带值；Sidebar 单实例挂载，见 composable 注释）
useArchiveCountBroadcast()
useGlobalShortcuts({ onNewSession, onOpenImportSession: () => { importOpen.value = true }, forkFromLastAssistant, enterForkModeFromLastAssistant, handoffFromLastAssistant, navigation: useNavigationStore(), openSettings })
// [B3 / 2026-09-14 内存审计 §2.4] app.info 退订函数保存 + onBeforeUnmount 调用：App.vue 以
// v-if="connectionState !== 'connected'" 卸载 AppShell，runtime 崩溃自动重启下断连重连是
// 设计内常态——丢弃退订函数会每次重挂泄漏一份 handler + 组件响应式子图
// （piVersion ref → versionLabel computed → 渲染 effect）；A4 断言（重连后 handler 数恒 1）
// 由 Sidebar.test.ts B3 组退订对称单测检查（原挂载/卸载探针日志行验收后已删）。
let unsubscribeAppInfo: (() => void) | null = null
onMounted(() => {
  void loadSessions()
  unsubscribeAppInfo = events.onGlobalType('app.info', (msg) => { piVersion.value = msg.payload.piVersion })
})
onBeforeUnmount(() => {
  unsubscribeAppInfo?.()
  unsubscribeAppInfo = null
})
useAppUpdate().initAutoCheck() // setup 顶层同步调用（非 onMounted）：initAutoCheck 的 onScopeDispose 须在活跃 effect scope 内绑定
</script>

<style scoped>
/* 折叠过渡（demo shell spec §3.6 裁决 5A）：宽度 320ms 收拢 + 200ms 淡出（--duration 与
   demo --dur-base 同值）——transition 从 Tailwind 类收编到此处单点声明：① 淡出/收拢分属性
   时长 Tailwind transition-* 类表达不了（duration 类是全属性单值）；② 折叠态 visibility
   延迟翻转（过渡结束后才 hidden，隐藏行不进 Tab 焦点序）需要分属性 delay。
   作用对象 = 本组件 width/opacity（w-0/opacity-0 类切换值）；aside flexBasis 归零不挂过渡
   （CDP 环境下 flex-basis transition 锁死 declared value，AsideRegion 头注既有登记，不改）。
   reduce 降级：全局 style.css reduce 块把过渡压到 0.01ms（瞬切），此处补 display:none
   （demo .app.folded .sidebar 同款——直接离场不留 0 宽占位）。 */
.sidebar { transition: width var(--duration-slow) var(--ease-out), opacity var(--duration) var(--ease-out), visibility 0s 0s; }
.sidebar[data-collapsed='true'] { transition: width var(--duration-slow) var(--ease-out), opacity var(--duration) var(--ease-out), visibility 0s var(--duration-slow); }
/* 视图切换方向滑入（demo workbench.css 动效基元 vt-slide 同参数：300ms + --ease-out-soft，
   位移 ≤10px 动效纪律）：单组件消费 → scoped 声明，不进 style.css 全局动画原语白名单；
   选择器挂 .sidebar 祖先（后代形式，同 ActivityStrip .wait-dots i 先例）。
   reduced-motion 降级由 style.css 全局 reduce 块兜底（animation-duration 归零 = 瞬切）。 */
.sidebar .vt-slide-r {
  animation: vt-slide-r 300ms var(--ease-out-soft);
}
.sidebar .vt-slide-l {
  animation: vt-slide-l 300ms var(--ease-out-soft);
}
@keyframes vt-slide-r {
  from { opacity: 0; transform: translateX(10px); }
}
@keyframes vt-slide-l {
  from { opacity: 0; transform: translateX(-10px); }
}
</style>
