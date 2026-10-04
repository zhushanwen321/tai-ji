<template>
  <!--
    容器组件 · L1 Sidebar（sidebar/spec.md 四态）。
    分层（自上而下）：Brand → 主操作 nav（新建 ⌘N / 导入会话 ⌘I / 搜索 ⌘K）→ segmented tab（会话|文件|Plugins）→ 子视图区 → 用户区。
    折叠态 C：整体隐藏（width:0 + opacity:0），spec §收起态。
    File View 内容 G2-003 defer。
    [HISTORICAL] 2026-09-16 五 tab 收敛为三 tab：Agents（子代理列表）/ Flows（工作流列表 +
    详情视图）两 tab 及其挂载分支退役，任务观察入口唯一化收口到 composer 任务托盘——原
    「侧栏任务 tab 数 vs 托盘计数」双口径穿帮面随之消灭。
  -->
  <div
    data-fs-scope="sidebar"
    class="sidebar h-full transition-[width,opacity] duration-[var(--duration-slow)] ease-[var(--ease)]"
    :class="{ 'w-0 opacity-0 overflow-hidden': sidebar.collapsed }"
  >
    <div class="sidebar__inner flex h-full w-[300px] flex-col pl-0.5">
      <!-- Brand（太极 logo + 产品名 + 版本号 + 升级指示器，v6 §6.2） -->
      <Brand :version-label="versionLabel">
        <template #trailing>
          <!-- 升级状态指示器（useAppUpdate 单例 state，idle/checking 不渲染） -->
          <UpdateButton class="ml-auto" />
        </template>
      </Brand>

      <!-- 主操作 nav：新建任务 ⌘N（primary 主操作）/ 导入会话 ⌘I / 搜索 ⌘K（ghost 次操作）。
           NavItem 层级：primary=accent 实色 / ghost=透明 双层级。 -->
      <nav class="flex flex-col gap-1 px-1">
        <Button
          variant="ghost"
          class="group h-8 w-full justify-start gap-2.5 rounded-md bg-accent px-3 text-[length:var(--text-xs)] font-medium text-accent-fg transition-colors hover:bg-accent-hover hover:text-accent-fg"
          @click="onNewSession"
        >
          <Plus class="size-[15px] text-accent-fg" />
          <span class="flex-1 text-left">{{ t('sidebar.newTask') }}</span>
          <kbd class="font-mono text-[length:var(--text-3xs)] text-accent-fg opacity-70">{{ formatKbd('n') }}</kbd>
        </Button>
        <!-- 导入会话入口（import-session 设计 §3.1）：外部 pi session
             纳入管理。ghost 次操作；open 状态本组件持有，
             ⌘I 经 useGlobalShortcuts 注入的 onOpenImportSession 派发同一状态。 -->
        <Button
          variant="ghost"
          data-testid="sidebar-import-session-btn"
          class="group h-8 w-full justify-start gap-2.5 rounded-md px-3 text-[length:var(--text-xs)] text-neutral-mid transition-colors hover:bg-surface-hover hover:text-neutral-fg"
          @click="importOpen = true"
        >
          <Download class="size-[15px] text-neutral-dim transition-colors group-hover:text-neutral-mid" />
          <span class="flex-1 text-left">{{ t('importSession.title') }}</span>
          <kbd class="rounded-sm border border-border-strong px-1.5 py-0.5 font-mono text-[length:var(--text-3xs)] text-neutral-dim">{{ formatKbd('i') }}</kbd>
        </Button>
        <Button
          variant="ghost"
          class="group h-8 w-full justify-start gap-2.5 rounded-md px-3 text-[length:var(--text-xs)] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
          @click="searchModal.open()"
        >
          <Search class="size-[15px] text-neutral-dim transition-colors group-hover:text-neutral-mid" />
          <span class="flex-1 text-left">{{ t('sidebar.search') }}</span>
          <kbd class="rounded-sm border border-border-strong px-1.5 py-0.5 font-mono text-[length:var(--text-3xs)] text-neutral-dim">{{ formatKbd('k') }}</kbd>
        </Button>
      </nav>

      <div class="my-2 mx-2.5 h-px bg-border" />

      <!-- ProjectSwitcher（v6 D14：nav 下方 Project 一级导航，spec §6.2） -->
      <ProjectSwitcher />

      <!-- segmented tab（会话 | 文件 | Plugins） -->
      <SegmentedTab
        v-model="sidebar.activeTab"
        :session-count="sessionCount"
        :file-count="fileCount"
      />

      <!-- 子视图区：会话列表 / 文件视图 / plugin sidebar view -->
      <div class="mt-1 min-h-0 flex-1 overflow-hidden">
        <template v-if="sidebar.activeTab === 'sessions'">
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
          <SessionList
            v-else
            :groups="session.groups"
            :active-id="focusedSessionId"
            :status-of="statusOf"
            @select="onSelectSession"
            @new-session="onNewSession"
            @rename="onRenameSession"
            @delete="onDeleteSession"
            @delete-folder="onDeleteFolder"
            @new-session-in-folder="onNewSessionInFolder"
            @abort="onAbortSession"
            @force-quit="onForceQuitSession"
            @set-project="onAssignProject"
          />
        </template>
        <!-- ExtensionHost sidebar view 宿主（audit §12.1 sidebar.tab 挂载点）。
             L2 二级路由：PluginViewContainer 经 VIEWS_SOURCE_KEY 取 plugin view 清单
             （ContributionRegistry sidebar.tab 贡献）→ L2TabBar 切 tab → ViewHost 渲染
             （数据按 viewId 'todo'/'goal' 落，见 02-extension-host-wiring.md 重构 2）。
             sessionId 绑定焦点 session。 -->
        <template v-else-if="sidebar.activeTab === 'plugins'">
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
        </template>
        <template v-else>
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
        </template>
      </div>

      <!-- 用户区（footer）· §6.2 UserArea：accent 纯色头像（去装饰渐变）+ 用户名 + 设置齿轮。 -->
      <div class="mt-auto flex items-center gap-2 rounded-md px-2 py-2 text-[length:var(--text-xs)] text-neutral-mid transition-colors hover:bg-surface-hover">
        <span class="size-5 shrink-0 rounded-full bg-accent" />
        <span class="flex-1 truncate text-neutral-fg">{{ t('sidebar.developer') }}</span>
        <Button
          variant="ghost"
          class="grid size-6 shrink-0 place-items-center rounded-sm p-0 text-neutral-dim transition-colors hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-[14px]"
          :title="t('sidebar.settingsTitle')"
          @click="openSettings()"
        >
          <Settings class="size-[14px]" />
        </Button>
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
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import { Plus, Search, Settings, FolderOpen, AlertCircle, Puzzle, Download } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { SearchModal } from '@taiji/ui'
import { PluginViewContainer } from '@taiji/ui/extension-host'
import { useSearchModal } from '@taiji/core'
import { useSessionStore } from '@/stores/session'
import { useSidebarStore } from '@/stores/sidebar'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { useSessionDerivations } from '@/composables/features/chat/useSessionDerivations'
import SegmentedTab from './SegmentedTab.vue'
import SessionList from './SessionList.vue'
import UpdateButton from './UpdateButton.vue'
import Brand from './Brand.vue'
import ProjectSwitcher from './ProjectSwitcher.vue'
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
const openSettings = inject<() => void>('openSettings', () => {})
const { selectSession, restoreSession, newSession, loadSessions, renameSession, deleteSession, deleteFolder, assignSessionToProject, focusedSessionId, focusedSession: currentSession, forkFromLastAssistant, enterForkModeFromLastAssistant, handoffFromLastAssistant } = useSidebar()
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
const { onSelectSession, onNewSession, onNewSessionInFolder, onRenameSession, onDeleteSession, onDeleteFolder, onAbortSession, onForceQuitSession, onConfirmRename, onAssignProject, onRetryLoadSessions, searchDeps, onOpenSearchDrawer } = useSidebarSessionActions({ selectSession, restoreSession, newSession, loadSessions, renameSession, deleteSession, deleteFolder, assignSessionToProject, renameOpen, targetSessionId })
useGlobalShortcuts({ onNewSession, onOpenImportSession: () => { importOpen.value = true }, forkFromLastAssistant, enterForkModeFromLastAssistant, handoffFromLastAssistant, navigation: useNavigationStore(), openSettings })
// [B3 / 2026-09-14 内存审计 §2.4] app.info 退订函数保存 + onBeforeUnmount 调用：App.vue 以
// v-if="connectionState !== 'connected'" 卸载 AppShell，runtime 崩溃自动重启下断连重连是
// 设计内常态——丢弃退订函数会每次重挂泄漏一份 handler + 组件响应式子图
// （piVersion ref → versionLabel computed → 渲染 effect）；A4 断言（重连后 handler 数恒 1）
// 由 Sidebar.test.ts B3 组退订对称单测守卫（原挂载/卸载探针日志行验收后已删）。
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
</style>
