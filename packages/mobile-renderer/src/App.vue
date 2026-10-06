<script setup lang="ts">
// App.vue —— mobile 壳多视图布局（remote-use D10：单屏四 zone → 列表/聊天/token 输入多视图态）。
//
// 三视图态（消费 bootstrap 的 shellConnectionState + hasConnectedOnce，U1.3 装配）：
// - token-input：TokenInputView（D8 恢复入口，submit 走 submitRemoteToken 重试编排）
// - failed：重连预算用尽终态，全屏接管给可行动指引
// - 连接成功过（hasConnectedOnce）：两 tab 视图——
//     列表视图 = MobileSessionList + BottomTabBar（D10 三视图 zone 布局行）
//     聊天视图 = message-stream + slash（隐藏保留）+ 输入条 + BottomTabBar
//   瞬时断连（掉回 connecting）不换视图：connected 布局保持挂载（composer 卸载会丢
//   输入草稿，BM5），仅壳顶部插轻量断线条
// - 首连尚未 connected：轻量「连接中」呈现（无重 UI；D8 裁决③：不复用桌面 runtime 不可用状态条）
//
// companion 区挂 ui CompanionBand（简单 dialog 渲染）——D3 根级常驻：不随页签/视图分支
// 卸载（订阅随组件卸载退订，页签分支内挂载会静默丢请求），任意页签直接可见可作答；
// form/planReview 类请求（C4 门排除面）由 MobileFormCard 承接（D7 form 行恢复）；
// source/transport/OverlayLifecycle 经 App provide（回传走 core 既有通路，D7 ask-user 行）。
// 权限审批弹窗（D7「手机可批」行）全局挂根：bus 'plugin-permission-request' →
// companion-bridge 弹窗状态 → PermissionRequestDialog；回传经 provide 的
// PermissionTransport（plugin.approvePermissions/denyPermissions 既有通路）。
// zone 容器 data-testid（zone-*//bottom-tab-bar）延续 AC5 结构断言锚点。
import { computed, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { createSessionScopedMap, InternalEventBus, OverlayLifecycle, type OverlayState } from '@taiji/core'
import { Button } from '@taiji/ui'
import {
  CompanionBand,
  DIALOG_QUEUE_HANDLE_KEY,
  DIALOG_REQUEST_SOURCE_KEY,
  OVERLAY_LIFECYCLE_KEY,
  PermissionRequestDialog,
  PERMISSION_TRANSPORT_KEY,
  UI_RESPONSE_TRANSPORT_KEY,
} from '@taiji/ui/extension-host'
import {
  mobileDialogRequestSource,
  mobilePermissionTransport,
  mobileUiResponseTransport,
  registerDialogQueueHandle,
  useMobileFormRequests,
  useMobilePermissionRequest,
} from './shell/companion-bridge'
import { activeSessionId, loadSessions, refreshHistory } from './shell/app-runtime'
import { connectionBannerI18nKey, hasConnectedOnce, shellConnectionState, submitRemoteToken, tokenSubmit } from './shell/connection-view'
import BottomTabBar, { type MobileTab } from './shell/BottomTabBar.vue'
import SlashBarStub from './shell/stubs/SlashBarStub.vue'
import TokenInputView from './shell/TokenInputView.vue'
import MobileChatHeader from './views/MobileChatHeader.vue'
import MobileComposer from './views/MobileComposer.vue'
import MobileFormCard from './views/MobileFormCard.vue'
import MobileMessageStream from './views/MobileMessageStream.vue'
import MobileSessionList from './views/MobileSessionList.vue'
import NewTaskSheet from './views/NewTaskSheet.vue'
import SubagentStatusLine from './views/SubagentStatusLine.vue'
import ErrorBar from './views/ErrorBar.vue'

// companion 数据源/回传通道（App 级 provide，CompanionBand 经 inject 消费）
provide(DIALOG_REQUEST_SOURCE_KEY, mobileDialogRequestSource)
provide(UI_RESPONSE_TRANSPORT_KEY, mobileUiResponseTransport)
// 审批回传通道（D7 权限审批行）：PermissionRequestDialog 经 inject 调 transport RPC
provide(PERMISSION_TRANSPORT_KEY, mobilePermissionTransport)

// exited 分通道重置的句柄登记回调（U6 / D5 exited 分区清理段）：CompanionBand 创建 queue
// 后经此把实例句柄回传 companion-bridge（bootstrap 的 session.exited 编排经其调 resetFor）。
// 桌面壳不 provide 该 key（桌面 exited 清理走壳侧 store 单点）→ CompanionBand inject 缺失
// 静默跳过——登记通道必须 provide/inject 形态（ui 不得依赖壳）。
provide(DIALOG_QUEUE_HANDLE_KEY, registerDialogQueueHandle)

// OverlayLifecycle（D3 假按钮处置：provide 真实状态机）——CompanionBand 的收起/展开按钮
// 在 inject 缺失时仍在场但点击 no-op（假行为）；provide 后 minimize/restore 经
// transition→getState 闭环真实生效（expanded→minimized→restored，对齐桌面
// useExtensionHostBridge 同类 provide）。bus 为独立实例：移动壳共享 bus 私居
// companion-bridge（无导出面），本实例不 subscribe——状态迁移不依赖订阅（transition/getState
// 直读分区 Map），订阅无事件源的 bus 属无效监听；桌面订阅才有的 ui-request 自动建 expanded
// 分区（z-index 派生）与 session-destroyed cleanup 在移动壳消费面之外（移动壳未定义
// --z-dialog，bandStyle 的 expanded 分支本就无有效投影）。
provide(
  OVERLAY_LIFECYCLE_KEY,
  new OverlayLifecycle({
    bus: new InternalEventBus(),
    sessionScoped: createSessionScopedMap(() => new Map<string, OverlayState>()),
  }),
)

// 权限审批弹窗状态（companion-bridge bus 订阅驱动，全局单例 session 无关）
const permission = useMobilePermissionRequest()

// form/planReview 类请求（C4 门排除出 CompanionBand 的富交互面，D7 form 行恢复）：
// 队首请求派生 + 快照对账（companion-bridge form 通道）；作答经 respond 回传
// extension.ui_response 既有通路。form 请求呈现时替换 composer（桌面 FormOverlay 与
// composer 互斥同构——输入禁止）；planReview 卡与 composer 并存（桌面 PlanReviewBar 同式）。
const {
  currentFormRequest: pendingFormRequest,
  currentPlanReviewRequest: pendingPlanReview,
  respond: respondFormRequest,
  reconcileNow: reconcileFormRequests,
} = useMobileFormRequests(activeSessionId)

// 作答回传失败（WS 未送达）的可见反馈：记录失败 requestId，经 prop 传入 MobileFormCard
// 渲染内联错误行（不静默）；错误行按 requestId 匹配渲染——同请求重试成功或请求被摘除后
// 不再显示，后续新请求不继承旧错误态
const formRespondFailedId = ref<string | null>(null)

function onFormSubmit(payload: { requestId: string; result: string }): void {
  formRespondFailedId.value = respondFormRequest(payload.requestId, payload.result) ? null : payload.requestId
}

function onFormCancel(payload: { requestId: string }): void {
  formRespondFailedId.value = respondFormRequest(payload.requestId, null) ? null : payload.requestId
}

const { t } = useI18n()

const activeTab = ref<MobileTab>('sessions')
const newTaskOpen = ref(false)

const isTokenInput = computed(() => shellConnectionState.value === 'token-input')
const isConnected = computed(() => shellConnectionState.value === 'connected')

function onOpenChat(sessionId: string): void {
  if (sessionId) activeTab.value = 'chat'
}

function onTaskCreated(): void {
  activeTab.value = 'chat'
}

function onTokenSubmit(token: string): void {
  void submitRemoteToken(token)
}

// 连接成功即拉取会话列表（首屏数据；后续 config.sessions 广播经 SessionApiPort 自动更新）；
// connected 边沿同时补拉 form/planReview 快照对账（静默重连保持视图挂载、sessionId 不变，
// 断连期间到达的请求重连后补挂——dialog/permission 通道不在此列：dialog 另立任务、
// permission 有超时撤窗有界）；并对当前活跃会话触发重连对账（U9/A6——断连期间完成的
// turn + D1 链外残留窗口经 core 统一编排入口收敛；无活跃会话跳过，未 hydrate 由 core
// 方法内 no-op）。对账执行的真机层无独立可观测锚点，接线防线 = connected-reconcile 单测。
watch(isConnected, (connected) => {
  if (connected) {
    void loadSessions()
    reconcileFormRequests()
    if (activeSessionId.value) void refreshHistory(activeSessionId.value)
  }
}, { immediate: true })
</script>

<template>
  <!-- 壳根吃顶部 + 横向 safe-area（A16 顶栏/横向职责）：顶部元素随视图态变化
       （ErrorBar/token/failed/connecting/chat header），壳根一处覆盖所有视图态；
       底部 inset 分治给贴底 chrome BottomTabBar（此处不挂 pb，防双倍扣除） -->
  <div
    class="mobile-shell flex h-screen flex-col bg-bg pt-[var(--safe-area-top)] pr-[var(--safe-area-right)] pl-[var(--safe-area-left)]"
    data-testid="mobile-shell"
  >
    <!-- 全局错误条（A7/U14）：三条驱动链（onSessionError/onGlobalError/notifyNotDelivered）
         经 bootstrap effects + companion-bridge 单例状态驱动，壳顶部细行呈现（对齐断线条
         的轻量内联形态），视图态无关常驻根级；单槽覆盖 + 手动关闭（无自动消失 timer）。 -->
    <ErrorBar />

    <!-- companion（B 伴随）：ui CompanionBand（简单 dialog 渲染）——D3 根级常驻（对齐桌面
         Workspace 常驻形态；根级挂载先例 = 尾部 PermissionRequestDialog）。不随页签/视图
         分支卸载：DialogRequestQueue 的消息订阅随组件卸载退订，页签条件分支内挂载会让
         停留列表页签期间到达的请求静默丢失（S3）——请求到达即当前页签直接可见可作答
         （前提 = 请求所属会话为当前活跃会话）。组件无请求时 v-if 自隐藏（不占位）；
         DOM 居首使 band 绘制序低于 BottomTabBar / PermissionRequestDialog 等后继定位层
         （fixed 弹窗不遮挡壳 chrome，页签切换保持可用）。容器保留 testid 锚点（AC5）。 -->
    <section class="mobile-shell__companion shrink-0" data-testid="zone-companion">
      <CompanionBand :session-id="activeSessionId" />
    </section>

    <!-- token 输入视图（D8：凭据缺失/验身失败的恢复入口；submitting/error 反馈见 TokenInputView） -->
    <TokenInputView
      v-if="isTokenInput"
      :submitting="tokenSubmit.submitting"
      :error="tokenSubmit.error"
      @submit="onTokenSubmit"
    />

    <!-- failed：重连预算用尽终态，全屏接管必须给可行动指引
         （禁无限期「连接中」假态——重试入口 = 刷新页面重走 bootstrap 验身链）。
         容器独立 testid（shell-failed-screen），不复用首连分支的 shell-connecting：
         「failed 态无 connecting 视图」类断言依赖二者不撞名；可行动指引元素是 shell-failed -->
    <div
      v-else-if="shellConnectionState === 'failed'"
      class="flex h-screen flex-col items-center justify-center gap-2 bg-bg"
      data-testid="shell-failed-screen"
    >
      <p class="text-sm text-neutral-fg" role="alert" data-testid="shell-failed">
        {{ t('mobile.connectionFailed') }}
      </p>
      <p class="text-xs text-neutral-mid">{{ t('mobile.connectionFailedHint') }}</p>
    </div>

    <!-- 连接成功过：列表 / 聊天 两 tab 视图。瞬时断连不换视图（composer 卸载丢草稿，BM5），
         仅壳顶部插轻量断线条 -->
    <template v-else-if="hasConnectedOnce">
      <div
        v-if="!isConnected"
        role="status"
        data-testid="shell-reconnecting-banner"
        class="shrink-0 px-3 py-1.5 text-xs text-neutral-mid text-center"
      >
        {{ t(connectionBannerI18nKey) }}
      </div>

      <MobileSessionList v-if="activeTab === 'sessions'" @new-task="newTaskOpen = true" @open-chat="onOpenChat" />

      <template v-else>
        <!-- 聊天视图空态：无激活 session 时给新建入口（G1 新建链路） -->
        <div
          v-if="!activeSessionId"
          class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3"
          data-testid="mobile-chat-empty"
        >
          <p class="text-sm text-neutral-mid">{{ t('mobile.chat.empty') }}</p>
          <Button variant="default" data-testid="mobile-chat-empty-new" @click="newTaskOpen = true">
            {{ t('mobile.chat.start') }}
          </Button>
        </div>
        <template v-else>
          <!-- 主内容区：聊天头部（u13/A5 当前会话模型/思考档只读标签）+ subagent 运行状态行
               （A9/U15：onSubagents 分区驱动的 running 汇总，无运行不占位）+ message-stream
               （B 对话流），flex-1 占主体 -->
          <main class="mobile-shell__main flex min-h-0 flex-1 flex-col" data-testid="zone-message-stream">
            <MobileChatHeader :session-id="activeSessionId" />
            <SubagentStatusLine :session-id="activeSessionId" />
            <MobileMessageStream :session-id="activeSessionId" />
          </main>

          <!-- form/planReview 类请求卡（D7 form 行恢复）：C4 门排除的富交互面；
               form 请求在场时 composer 隐藏（桌面 overlay 与 composer 互斥同构） -->
          <MobileFormCard
            :request="pendingFormRequest"
            :plan-review="pendingPlanReview"
            :respond-failed-id="formRespondFailedId"
            @submit="onFormSubmit"
            @cancel="onFormCancel"
          />

          <!-- slash（D 命令，composer 命令栏）：隐藏保留占位（D10 stub 处置行） -->
          <div class="mobile-shell__slash shrink-0" data-testid="zone-slash">
            <SlashBarStub />
          </div>

          <!-- 输入条（发送/中断键在拇指区，D7 中断行）；form 请求呈现时隐藏（互斥） -->
          <MobileComposer v-if="!pendingFormRequest" :session-id="activeSessionId" />
        </template>
      </template>

      <!-- 底部 tab 导航（壳 chrome，非挂载点） -->
      <BottomTabBar v-model="activeTab" />
      <NewTaskSheet :open="newTaskOpen" @close="newTaskOpen = false" @created="onTaskCreated" />
    </template>

    <!-- 首连尚未 connected：轻量「连接中」呈现（无重 UI；D8 裁决③：不复用桌面 runtime 不可用状态条） -->
    <div
      v-else
      class="flex h-screen flex-col items-center justify-center gap-2 bg-bg"
      data-testid="shell-connecting"
    >
      <p class="text-sm text-neutral-mid">{{ t('mobile.connecting') }}</p>
    </div>

    <!-- 权限审批弹窗（D7「手机可批」）：全局单例挂根，视图态无关；pending 驱动开合 -->
    <PermissionRequestDialog
      :plugin-id="permission.pluginId"
      :permissions="permission.permissions"
      :pending="permission.pending"
      :error="permission.error"
    />
  </div>
</template>
