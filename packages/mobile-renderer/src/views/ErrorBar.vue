<script setup lang="ts">
// ErrorBar —— 移动壳轻量错误条（remote-use A7/A11 / U14）。
//
// 纯展示组件：文本源 = error-bar 模块级单例 errorBarMessage（shell 持状态、views
// 持呈现，依赖方向 views → shell 与 App 消费 shell 状态同向）；四条驱动链——
// onSessionError（markSessionError 流内持久反馈 + 置顶）/ onGlobalError（直显）/
// notifyNotDelivered（dialog 作答未送达内联错误行）/ core toast 通道（revoke/stop/bash/
// compact 等 RPC 失败文案，app-runtime errorBarToast 注入）——前两条见 companion-bridge
// 「全局错误条」段，toast 通道见 error-bar 模块头注释。
// 单槽覆盖式 + 手动关闭（无自动消失 timer——时间平抑类逻辑红线；关闭后持久反馈仍在流内）。
// role=alert + 细行形态对齐 form 通道内联错误行范式（MobileFormCard respond-error）。
import { useI18n } from 'vue-i18n'
import { X } from '@lucide/vue'
import { Button } from '@taiji/ui'
import { errorBarMessage, dismissErrorBar } from '../shell/error-bar'

const { t } = useI18n()
</script>

<template>
  <div
    v-if="errorBarMessage"
    class="flex shrink-0 items-start gap-1 px-3 py-1.5 text-xs text-neutral-fg"
    role="alert"
    data-testid="mobile-error-bar"
  >
    <span class="min-w-0 flex-1 break-words leading-5" data-testid="mobile-error-bar-text">
      {{ errorBarMessage }}
    </span>
    <Button
      variant="ghost"
      size="icon"
      class="size-6 shrink-0 rounded-sm"
      :aria-label="t('mobile.errorBar.dismiss')"
      data-testid="mobile-error-bar-dismiss"
      @click="dismissErrorBar"
    >
      <X class="size-3.5" />
    </Button>
  </div>
</template>
