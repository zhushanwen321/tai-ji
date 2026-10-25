<script setup lang="ts">
// App.vue —— mobile 壳 v2 布局（remote-use-mobile-v2 §7.1 组件树：三目的域 + 聊天详情页 +
// 验身页，五态路由消费；§6.6 bootstrap 先挂载后连接的壳侧承接）。
//
// 视图分支由路由状态机（shell/route.ts 五态）驱动，连接态（connection-view 四态）经本组件
// watch 段驱动路由转移（connect 域与连接装配域的正交边界在此收口）：
// - token-input / failed → navigateRoute('connect')（验身页：ConnectScreen 三态分流呈现）
// - connected 且当前在 connect → navigateRoute('sessions')（首连进初始目的域）
// 瞬时断连（connected → connecting）不换视图：路由保持挂载，仅顶部插轻量断线条（BM5 语义
// 保留——composer 卸载会丢输入草稿；u-chat 交付后草稿/视图保持语义随 ChatScreen 落位）。
//
// chat 态 BottomNav 整体隐藏（聊天是详情页不占目的域，§7.1；返回经 popstate 回 chatFrom）。
// 路由内容区分段：
// - sessions → SessionsScreen（搜索/分组/未读/长按动作 Sheet；会话行切入导航内聚屏内，
//   新建入口上抛 new-task 走 openSheet('newTask') 通道）
// - activity → 占位锚（v1 无对应视图；u-activity 交付 ActivityScreen）
// - chat     → ChatScreen（u-chat：页头/计时/模型 chip/更多 + 消息流 density=mobile +
//   输入区固定顺序；待回答/待授权状态经 props 传入，App 单点订阅 companion-bridge hooks）
//
// companion 区（§6.5 三通道 Sheet 化，本单元呈现出口改造落位）：v1 呈现三件
// （CompanionBand 顶部条 / PermissionRequestDialog / MobileFormCard 聊天内卡片）挂载摘除，
// 统一走 sheet-manager activeSheet 驱动的 Sheet 族（FormSheet 三源三节 / PermissionSheet）；
// 数据源与回传通路零变化（§6.5 回传通道不变——dialog queue 宿主已迁 companion-bridge
// 模块级，无需 provide 注入键）。请求到达自动开 Sheet = u-chat 待回答条交付前的呈现出口
// 兜底（条点击 openSheet 幂等，单槽覆盖语义天然互斥）；条↔Sheet 联动断言归 D3 验收（A6）。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@taiji/ui'
import {
  mobilePermissionTransport,
  useMobileDialogRequests,
  useFormSubmitSuspended,
  useMobileFormRequests,
  useMobilePermissionRequest,
} from './shell/companion-bridge'
import {
  activeSessionId,
  loadSessions,
  markConnectedNow,
  refreshHistory,
} from './shell/app-runtime'
import { connectionBannerI18nKey, hasConnectedOnce, shellConnectionState } from './shell/connection-view'
import { navigateRoute, shellRoute, type ChatSourceDomain } from './shell/route'
import { activeSheet, closeSheet, openSheet } from './shell/sheet-manager'
import { useVisualViewport } from './shell/use-visual-viewport'
import BottomNav from './components/BottomNav.vue'
import ActivityScreen from './screens/ActivityScreen.vue'
import ChatScreen from './screens/ChatScreen.vue'
import CommandSheet from './features/CommandSheet.vue'
import ConnectScreen from './screens/ConnectScreen.vue'
import FormSheet from './features/FormSheet.vue'
import ModelSheet from './features/ModelSheet.vue'
import NewTaskSheet from './features/NewTaskSheet.vue'
import PermissionSheet from './features/PermissionSheet.vue'
import SessionsScreen from './screens/SessionsScreen.vue'
import SettingsScreen from './screens/SettingsScreen.vue'
import SubagentSheet from './features/SubagentSheet.vue'
import ErrorBar from './views/ErrorBar.vue'

// 权限审批状态（companion-bridge bus 订阅驱动；§6.18 降级分支 = 恒全局呈现，无归属一等分支）
const permission = useMobilePermissionRequest()

// form/planReview/dialog 三源请求（§6.5 统一「待回答」数据源）：队首请求派生 + 快照对账
// （companion-bridge form 通道 + dialog queue 单例）；作答经 respond 回传既有通路
// （form/planReview → extension.ui_response；dialog → queue 双源路由）。
const {
  currentFormRequest: pendingFormRequest,
  currentPlanReviewRequest: pendingPlanReview,
  respond: respondFormRequest,
  reconcileNow: reconcileFormRequests,
} = useMobileFormRequests(activeSessionId)

const { currentDialogRequest: pendingDialogRequest, respond: respondDialogRequest } = useMobileDialogRequests()

// §6.23 restart 提交挂起（对账完成前 FormSheet 全节禁答；companion-bridge 单例状态）
const submitSuspended = useFormSubmitSuspended()

// 作答回传失败（WS 未送达）的可见反馈：记录失败 requestId，经 prop 传入 FormSheet
// 渲染内联错误行（不静默）；错误行按 requestId 匹配渲染——同请求重试成功或请求被摘除后
// 不再显示，后续新请求不继承旧错误态
const formRespondFailedId = ref<string | null>(null)

/** FormSheet 作答回传（按 requestId 归属路由通道；送达即关 Sheet，未送达留层显错误行） */
function onSheetSubmit(payload: { requestId: string; result: string | boolean }): void {
  const isDialog = pendingDialogRequest.value?.requestId === payload.requestId
  const delivered = isDialog
    ? respondDialogRequest(payload.requestId, payload.result)
    : respondFormRequest(payload.requestId, payload.result)
  formRespondFailedId.value = delivered ? null : payload.requestId
  if (delivered) closeSheet()
}

/** FormSheet 取消（回传 result:null——送达即请求终结收层；未送达保留可重试 + 错误行） */
function onSheetCancel(payload: { requestId: string; source: 'form' | 'dialog' }): void {
  const delivered = payload.source === 'dialog'
    ? respondDialogRequest(payload.requestId, null)
    : respondFormRequest(payload.requestId, null)
  formRespondFailedId.value = delivered ? null : payload.requestId
  if (delivered) closeSheet()
}

/** PermissionSheet 审批回传（controller transport 既有通路；成败呈现由 controller state 收敛） */
function onPermissionApprove(payload: { pluginId: string; permissions: string[] }): void {
  mobilePermissionTransport.approve(payload.pluginId, payload.permissions)
}

function onPermissionDeny(payload: { pluginId: string }): void {
  mobilePermissionTransport.deny(payload.pluginId)
}

const { t } = useI18n()

// ── 请求呈现联动（§6.5/§7.1 Sheet 生命周期）──────────────────────────────
// 请求到达自动开对应 Sheet（u-chat 待回答条交付前的呈现出口兜底；不抢已打开的 Sheet——
// activeSheet 为 null 才开，用户正在操作的浮层不被新请求顶掉，关掉后条仍可再开）；
// form 槽三源全空时收槽（最后一个请求作答/摘除后 Sheet 不留空壳）。
watch([pendingFormRequest, pendingPlanReview], ([f, p]) => {
  if ((f !== undefined || p !== undefined) && activeSheet.value === null) openSheet('form')
})
watch(pendingDialogRequest, (r) => {
  if (r !== undefined && activeSheet.value === null) openSheet('form')
})
watch(() => permission.pending, (p) => {
  if (p && activeSheet.value === null) openSheet('permission')
})
watch([pendingFormRequest, pendingPlanReview, pendingDialogRequest], ([f, p, d]) => {
  if (activeSheet.value === 'form' && f === undefined && p === undefined && d === undefined) closeSheet()
})
// 审批收尾（approve/deny RPC 成功 → controller pending 翻 false；失败 BM3 保持 true 留层重试）
watch(() => permission.pending, (pending) => {
  if (!pending && activeSheet.value === 'permission') closeSheet()
})

// 新建任务入口统一走 openSheet('newTask')（SessionsScreen 上抛 + 聊天空态入口共用）；
// 创建完成关槽 + 切入聊天（u-shell-skeleton 立契的迁移落位）。
function onTaskCreated(): void {
  closeSheet()
  navigateRoute('chat')
}

// 子代理行直落详情（u-activity 进行中屏上抛）：记直落目标 + 打开 subagentList 槽——
// SubagentSheet 清单拉取后按 initialSubagentId 推进详情态（直落意图单次消费）。
// target 生命周期 = subagentList 槽位打开期间（单槽覆盖关闭不经 @close——watch 槽位
// 统一清，防残留 target 让下次普通打开误直落旧子代理）。
const subagentDetailTarget = ref<string | undefined>(undefined)

watch(activeSheet, (slot) => {
  if (slot !== 'subagentList' && subagentDetailTarget.value !== undefined) {
    subagentDetailTarget.value = undefined
  }
})

function onOpenSubagentDetail(subagentId: string): void {
  subagentDetailTarget.value = subagentId
  openSheet('subagentList')
}

// ── 连接态 → 路由转移（connect 域与连接装配域的正交收口，见文件头）────────────
// immediate：挂载时同步路由与连接态（bootstrap 重排后挂载先于连接编排，正常时序挂载点
// 恒 connecting——immediate 分支防挂载时已是终态的重装配形态，对齐 v1 isConnected watch
// immediate 语义）。
watch(shellConnectionState, (s) => {
  if (s === 'token-input' || s === 'failed') {
    navigateRoute('connect')
    return
  }
  if (s === 'connected' && shellRoute.value === 'connect') {
    navigateRoute('sessions')
  }
}, { immediate: true })

// ── 路由消费桥接 ────────────────────────────────────────────────────────
// chat 态 BottomNav 不挂载（get 的兜底分支仅为类型闭合，不渲染）
const navRoute = computed<ChatSourceDomain>({
  get: () => (shellRoute.value === 'chat' || shellRoute.value === 'connect' ? 'sessions' : shellRoute.value),
  set: (to) => navigateRoute(to),
})

// 壳级键盘处理（§6.16）：visualViewport 高度 → --shell-viewport-h，输入条贴可视区下沿
useVisualViewport()

// ── connected 边沿三件套（v1 接线保留：connected-reconcile 契约）──────────────
// 连接成功即拉取会话列表 + form/planReview 快照对账 + 当前活跃会话历史对账；同时记录
// 连接建立时刻（§6.11 设置页「已连接时长」派生源，每次重连重算）。
watch(() => shellConnectionState.value === 'connected', (connected) => {
  if (connected) {
    markConnectedNow()
    void loadSessions()
    reconcileFormRequests()
    if (activeSessionId.value) void refreshHistory(activeSessionId.value)
  }
}, { immediate: true })
</script>

<template>
  <!-- 壳根吃顶部 + 横向 safe-area（A16 顶栏/横向职责）；高度走 --shell-viewport-h
       （visualViewport 接管，§6.16——静态满屏高在 iOS 不可靠，audit P2 修复）；
       底部 inset 分治给贴底 chrome BottomNav（此处不挂 pb，防双倍扣除） -->
  <div
    class="mobile-shell flex flex-col bg-bg pt-[var(--safe-area-top)] pr-[var(--safe-area-right)] pl-[var(--safe-area-left)]"
    data-testid="mobile-shell"
    :style="{ height: 'var(--shell-viewport-h, 100dvh)' }"
  >
    <!-- 全局错误条（A7/U14）：三条驱动链经 bootstrap effects + companion-bridge 单例状态
         驱动，壳顶部细行呈现，路由态无关常驻根级 -->
    <ErrorBar />

    <!-- 瞬时断连条：已连接过且当前断连、且不在验身页（token-input/failed 已由路由进
         connect，全屏指引优先，不叠断线条） -->
    <div
      v-if="hasConnectedOnce && shellRoute !== 'connect' && shellConnectionState !== 'connected'"
      role="status"
      data-testid="shell-reconnecting-banner"
      class="shrink-0 px-3 py-1.5 text-xs text-neutral-mid text-center"
    >
      {{ t(connectionBannerI18nKey) }}
    </div>

    <!-- 验身页（connect 路由态）：骨架/连接中/验身入口/失败指引三态分流在屏内 -->
    <ConnectScreen v-if="shellRoute === 'connect'" />

    <!-- 三目的域 + 聊天详情页（路由态内容区；v1 视图暂留段见文件头） -->
    <template v-else>
      <!-- sessions：u-sessions SessionsScreen（W3 交付接线；搜索/分组/未读/长按动作 Sheet） -->
      <section
        v-if="shellRoute === 'sessions'"
        class="flex min-h-0 flex-1 flex-col"
        data-testid="screen-sessions"
      >
        <SessionsScreen @new-task="openSheet('newTask')" />
      </section>

      <!-- activity：u-activity ActivityScreen（W4）：回合面板（activeSession 计时/步数/子代理数）
           + 「需要你处理」（全表可归属待办 + 无归属全局区，§6.18 聚合半）+ 子代理行直落
           （open-subagent-detail 上抛 → SubagentSheet initialSubagentId）+ 排队消息 + 四空态 -->
      <ActivityScreen
        v-else-if="shellRoute === 'activity'"
        @open-subagent-detail="onOpenSubagentDetail"
      />

      <!-- settings：本单元交付 -->
      <SettingsScreen v-else-if="shellRoute === 'settings'" />

      <!-- chat：u-chat ChatScreen（W3 整段替换落位）：页头（返回/标题/已观察计时/模型
           chip/更多）+ RunBand + 消息流 density=mobile + 输入区固定顺序（§7.1）。待回答/
           待授权状态经 props 传入（companion-bridge hooks 含 reconcile watch，App 单点
           订阅不重复触发对账）；返回语义 = popstate 单点回 chatFrom（ChatScreen 内聚） -->
      <ChatScreen
        v-else-if="shellRoute === 'chat' && activeSessionId"
        :session-id="activeSessionId"
        :ask-pending="pendingFormRequest !== undefined || pendingPlanReview !== undefined || pendingDialogRequest !== undefined"
        :form-pending="pendingFormRequest !== undefined"
        :permission-pending="permission.pending"
      />

      <!-- 聊天视图空态：无激活 session 时给新建入口（G1 新建链路） -->
      <div
        v-else-if="shellRoute === 'chat'"
        class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3"
        data-testid="screen-chat"
      >
        <p class="text-sm text-neutral-mid">{{ t('mobile.chat.empty') }}</p>
        <Button variant="default" data-testid="mobile-chat-empty-new" @click="openSheet('newTask')">
          {{ t('mobile.chat.start') }}
        </Button>
      </div>

      <!-- 底部导航（壳 chrome；chat 态隐藏——详情页全屏） -->
      <BottomNav v-if="shellRoute !== 'chat'" v-model="navRoute" />
    </template>

    <!-- ── Sheet 族挂载段（§6.5/§6.13：activeSheet 单槽驱动，路由态无关常驻根级）────── -->
    <!-- 待回答（form/planReview/dialog 三源三节；§6.23 提交挂起直通） -->
    <FormSheet
      :open="activeSheet === 'form'"
      :request="pendingFormRequest"
      :plan-review="pendingPlanReview"
      :dialog="pendingDialogRequest"
      :submit-failed-id="formRespondFailedId"
      :submit-suspended="submitSuspended"
      @submit="onSheetSubmit"
      @cancel="onSheetCancel"
      @close="closeSheet()"
    />
    <!-- 权限审批（无归属一等分支：恒全局呈现，§6.18 降级分支） -->
    <PermissionSheet
      :open="activeSheet === 'permission'"
      :plugin-id="permission.pluginId"
      :permissions="permission.permissions"
      :pending="permission.pending"
      :error="permission.error"
      @approve="onPermissionApprove"
      @deny="onPermissionDeny"
      @close="closeSheet()"
    />
    <!-- 新建任务（§6.12 项目 chip 主路径 + 手输兜底） -->
    <NewTaskSheet :open="activeSheet === 'newTask'" @close="closeSheet()" @created="onTaskCreated" />
    <!-- 模型与思考档切换（§7.2 七值四段映射） -->
    <ModelSheet
      v-if="activeSessionId"
      :open="activeSheet === 'model'"
      :session-id="activeSessionId"
      @close="closeSheet()"
    />
    <!-- 命令面板（§6.13 插入输入框语义，不直接执行） -->
    <CommandSheet
      :open="activeSheet === 'command'"
      :session-id="activeSessionId"
      @close="closeSheet()"
    />
    <!-- 子代理两级（列表态/详情态同 key 内部推进，§6.13；直落目标经 ActivityScreen 上抛） -->
    <SubagentSheet
      v-if="activeSessionId"
      :open="activeSheet === 'subagentList'"
      :session-id="activeSessionId"
      :initial-subagent-id="subagentDetailTarget"
      @close="closeSheet()"
    />
  </div>
</template>
