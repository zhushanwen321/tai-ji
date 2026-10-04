<script setup lang="ts">
// App.vue —— mobile 壳多视图布局（remote-use D10：单屏四 zone → 列表/聊天/token 输入多视图态）。
//
// 三视图态（消费 bootstrap 的 shellConnectionState + hasConnectedOnce，U1.3 装配）：
// - token-input：TokenInputView（D8 恢复入口，submit 走 submitRemoteToken 重试编排）
// - failed：重连预算用尽终态，全屏接管给可行动指引
// - 连接成功过（hasConnectedOnce）：两 tab 视图——
//     列表视图 = MobileSessionList + BottomTabBar（D10 三视图 zone 布局行）
//     聊天视图 = message-stream + companion + slash（隐藏保留）+ 输入条 + BottomTabBar
//   瞬时断连（掉回 connecting）不换视图：connected 布局保持挂载（composer 卸载会丢
//   输入草稿，BM5），仅壳顶部插轻量断线条
// - 首连尚未 connected：轻量「连接中」呈现（无重 UI；D8 裁决③：不复用桌面 runtime 不可用状态条）
//
// companion 区挂 ui CompanionBand（AskUserForm 是其 askUser method 的内部子组件）；
// source/transport 经 companion-bridge provide（回传走 core 既有通路，D7 ask-user 行）。
// 权限审批弹窗（D7「手机可批」行）全局挂根：bus 'plugin-permission-request' →
// companion-bridge 弹窗状态 → PermissionRequestDialog；回传经 provide 的
// PermissionTransport（plugin.approvePermissions/denyPermissions 既有通路）。
// zone 容器 data-testid（zone-*//bottom-tab-bar）延续 AC5 结构断言锚点。
import { computed, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@taiji/ui'
import {
  CompanionBand,
  DIALOG_REQUEST_SOURCE_KEY,
  PermissionRequestDialog,
  PERMISSION_TRANSPORT_KEY,
  UI_RESPONSE_TRANSPORT_KEY,
} from '@taiji/ui/extension-host'
import {
  mobileDialogRequestSource,
  mobilePermissionTransport,
  mobileUiResponseTransport,
  useMobilePermissionRequest,
} from './shell/companion-bridge'
import { activeSessionId, loadSessions } from './shell/app-runtime'
import { hasConnectedOnce, shellConnectionState, submitRemoteToken, tokenSubmit } from './shell/connection-view'
import BottomTabBar, { type MobileTab } from './shell/BottomTabBar.vue'
import SlashBarStub from './shell/stubs/SlashBarStub.vue'
import TokenInputView from './shell/TokenInputView.vue'
import MobileComposer from './views/MobileComposer.vue'
import MobileMessageStream from './views/MobileMessageStream.vue'
import MobileSessionList from './views/MobileSessionList.vue'
import NewTaskSheet from './views/NewTaskSheet.vue'

// companion 数据源/回传通道（App 级 provide，CompanionBand 经 inject 消费）
provide(DIALOG_REQUEST_SOURCE_KEY, mobileDialogRequestSource)
provide(UI_RESPONSE_TRANSPORT_KEY, mobileUiResponseTransport)
// 审批回传通道（D7 权限审批行）：PermissionRequestDialog 经 inject 调 transport RPC
provide(PERMISSION_TRANSPORT_KEY, mobilePermissionTransport)

// 权限审批弹窗状态（companion-bridge bus 订阅驱动，全局单例 session 无关）
const permission = useMobilePermissionRequest()

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

// 连接成功即拉取会话列表（首屏数据；后续 config.sessions 广播经 SessionApiPort 自动更新）
watch(isConnected, (connected) => {
  if (connected) void loadSessions()
}, { immediate: true })
</script>

<template>
  <div class="mobile-shell flex h-screen flex-col bg-bg" data-testid="mobile-shell">
    <!-- token 输入视图（D8：凭据缺失/验身失败的恢复入口；submitting/error 反馈见 TokenInputView） -->
    <TokenInputView
      v-if="isTokenInput"
      :submitting="tokenSubmit.submitting"
      :error="tokenSubmit.error"
      @submit="onTokenSubmit"
    />

    <!-- failed：重连预算用尽终态，全屏接管必须给可行动指引
         （禁无限期「连接中」假态——重试入口 = 刷新页面重走 bootstrap 验身链） -->
    <div
      v-else-if="shellConnectionState === 'failed'"
      class="flex h-screen flex-col items-center justify-center gap-2 bg-bg"
      data-testid="shell-connecting"
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
        {{ t('mobile.reconnecting') }}
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
          <!-- 主内容区：message-stream（B 对话流），flex-1 占主体 -->
          <main class="mobile-shell__main flex min-h-0 flex-1 flex-col" data-testid="zone-message-stream">
            <MobileMessageStream :session-id="activeSessionId" />
          </main>

          <!-- companion（B 伴随）：ui CompanionBand（AskUserForm 随 askUser method 路由渲染；
               无请求时组件 v-if 自隐藏，容器保留 testid 锚点） -->
          <section class="mobile-shell__companion shrink-0" data-testid="zone-companion">
            <CompanionBand :session-id="activeSessionId" />
          </section>

          <!-- slash（D 命令，composer 命令栏）：隐藏保留占位（D10 stub 处置行） -->
          <div class="mobile-shell__slash shrink-0" data-testid="zone-slash">
            <SlashBarStub />
          </div>

          <!-- 输入条（发送/中断键在拇指区，D7 中断行） -->
          <MobileComposer :session-id="activeSessionId" />
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
