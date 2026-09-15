<template>
  <!-- 懒加载组件 loading/error 兜底（D-8 §3.5 错误规格）。
       loading 态：轻量 spinner（defineAsyncComponent delay 200ms 内不显示——本地 file:// 加载毫秒级，
       避免快速打开时闪烁）。
       error 态：错误占位 + 重试按钮。inject LAZY_RETRY_KEY（宿主 provide）触发 defineAsyncComponent
       loader 重跑（onError 捕获的 userRetry 会重置 pendingRequest 并重新 import）。
       overlay（[W31 review minor-4]）：全屏遮罩形态（fixed inset-0 z-modal，与正常 modal 视觉层级
       一致），供挂载点在布局流内的懒加载弹窗（AppShell 的 SettingsModal）用——默认形态 h-full
       w-full 会作为 flex 子项参与宿主布局、挤压 MainPanel；drawer 内面板挂载点有独立定位容器，
       用默认形态。 -->
  <div
    v-if="error"
    class="flex flex-col items-center justify-center gap-2 bg-bg p-4"
    :class="overlay ? 'fixed inset-0 z-[var(--z-modal)]' : 'h-full w-full'"
    data-testid="async-error-fallback"
  >
    <AlertCircle class="size-5 text-danger" />
    <span class="text-[13px] text-neutral-mid">{{ t('common.loadFailed') }}</span>
    <Button
      variant="secondary"
      size="sm"
      class="mt-1"
      data-testid="async-retry-btn"
      @click="onRetry"
    >
      <RotateCw class="size-3.5" />
      {{ t('common.retry') }}
    </Button>
  </div>
  <div
    v-else
    class="flex items-center justify-center bg-bg p-4"
    :class="overlay ? 'fixed inset-0 z-[var(--z-modal)]' : 'h-full w-full'"
    data-testid="async-loading"
  >
    <Loader2 class="size-5 animate-spin text-neutral-dim" />
  </div>
</template>

<script lang="ts">
import type { InjectionKey } from 'vue'

/**
 * 懒加载重试注入键（D-8 §3.5）：宿主组件 provide 一个「重新触发懒加载 loader」的回调。
 * defineAsyncComponent 的 errorComponent 无法直接拿到 retry（模块作用域闭包），
 * 宿主在 onError 里捕获 userRetry 并经本键注入，错误占位按钮点击时调用。
 */
export const LAZY_RETRY_KEY: InjectionKey<() => void> = Symbol('lazy-retry')
</script>

<script setup lang="ts">
import { inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, Loader2, RotateCw } from '@lucide/vue'
import { Button } from '@/components/ui/button'

/** defineAsyncComponent 的 errorComponent 注入 error prop；loading 态无 props。
 *  overlay 由宿主包装组件显式传入（defineAsyncComponent 的 loading/error 组件无法直接传 props）。 */
defineProps<{ error?: unknown; overlay?: boolean }>()

const { t } = useI18n()
const retry = inject(LAZY_RETRY_KEY, null)

function onRetry(): void {
  retry?.()
}
</script>
