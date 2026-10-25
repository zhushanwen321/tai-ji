<script setup lang="ts">
// ConnectScreen —— 移动壳验身页（connect 路由态；remote-use-mobile-v2 §6.6 首屏三态 +
// §6.11 扫码连接链路的呈现层）。
//
// 三态分流（connection-view 状态机驱动，本组件只呈现不拥有连接态）：
// - connecting → 会话列表骨架（Skeleton 胶囊条）+ 连接中文案：mount 先于连接编排（§6.6
//   bootstrap 重排），首屏任意时点 #app 非空的载体
// - token-input → 验身入口（TokenInputView：扫码 URL ?token= 摄取 / 地址栏抹除 / 坏 token
//   不毁既有凭据的凭据三分支在 platform/connection-profile 既有装配层，提交重试经
//   submitRemoteToken）
// - failed → 重连预算用尽指引（可行动恢复文案；重试 = 刷新页面重走验身链）
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Skeleton } from '@taiji/ui'
import {
  shellConnectionState,
  submitRemoteToken,
  tokenSubmit,
} from '../shell/connection-view'
import TokenInputView from '../shell/TokenInputView.vue'

const { t } = useI18n()

const isConnecting = computed(() => shellConnectionState.value === 'connecting')
const isTokenInput = computed(() => shellConnectionState.value === 'token-input')
const isFailed = computed(() => shellConnectionState.value === 'failed')

// 骨架行宽序列（首屏会话列表骨架形态：行高取 --m-row-h 档、宽交错——纯呈现数组）
const SKELETON_ROWS: ReadonlyArray<string> = ['w-3/4', 'w-full', 'w-5/6', 'w-2/3']

function onTokenSubmit(token: string): void {
  void submitRemoteToken(token)
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col bg-bg" data-testid="connect-screen">
    <!-- 骨架 + 连接中（首屏默认态）：列表骨架行 + 状态文案（「连接中」可感知，非静默骨架） -->
    <div
      v-if="isConnecting"
      class="flex flex-1 flex-col gap-3 p-[var(--m-gutter)] pt-[calc(var(--safe-area-top)+var(--m-gutter))]"
      data-testid="shell-boot-skeleton"
    >
      <Skeleton class="h-6 w-40" data-testid="boot-skeleton-header" />
      <div
        v-for="(row, i) in SKELETON_ROWS"
        :key="i"
        class="flex min-h-[var(--m-row-h)] items-center rounded-lg border border-[var(--border)] bg-surface px-4"
        :data-testid="`boot-skeleton-row-${i}`"
      >
        <Skeleton :class="row" class="h-4" />
      </div>
      <p class="text-center text-xs text-neutral-mid" role="status" data-testid="shell-connecting-label">
        {{ t('mobile.connecting') }}
      </p>
    </div>

    <!-- 验身入口：token 输入（凭据缺失 / 验身失败 / 重连预算用尽前的手动重试入口） -->
    <TokenInputView
      v-else-if="isTokenInput"
      :submitting="tokenSubmit.submitting"
      :error="tokenSubmit.error"
      @submit="onTokenSubmit"
    />

    <!-- failed：重连预算用尽终态，全屏接管必须给可行动指引（禁无限期「连接中」假态；
         容器独立 testid 不复用 boot 骨架：「failed 态无 connecting 视图」类断言依赖二者不撞名） -->
    <div
      v-else-if="isFailed"
      class="flex flex-1 flex-col items-center justify-center gap-2"
      data-testid="shell-failed-screen"
    >
      <p class="text-sm text-neutral-fg" role="alert" data-testid="shell-failed">
        {{ t('mobile.connectionFailed') }}
      </p>
      <p class="px-8 text-center text-xs text-neutral-mid">{{ t('mobile.connectionFailedHint') }}</p>
    </div>
  </div>
</template>
