<template>
  <!--
  懒加载组件 loading/error 兜底（D-8 §3.5 错误规格 · D6 交付后修复改版）。
  loading 态：轻量 spinner（defineAsyncComponent delay 200ms 内不显示——本地 file:// 加载毫秒级，
  避免快速打开时闪烁）。
  error 态：错误占位 + 自动重试穷尽指引。**无重试按钮**（2026-10-03 用户裁决：重试由系统内部
  有界自动重试承接——createLazyChunkRetry，穷尽后才进入本错误态；出路 = 关闭后重新打开
  恢复（每轮重开均重置计数重新自动重试）+ Esc/⌘W 可退出，见文案）。
  overlay（[W31 review minor-4]）：全屏遮罩形态（fixed inset-0 z-modal，与正常 modal 视觉层级
  一致），供挂载点在布局流内的懒加载弹窗（AppShell 的 SettingsModal）用——默认形态 h-full
  w-full 会作为 flex 子项参与宿主布局、挤压 MainPanel；drawer 内面板挂载点有独立定位容器，
  用默认形态。
-->
<div
  v-if="error"
  class="flex flex-col items-center justify-center gap-2 bg-bg p-4"
  :class="overlay ? 'fixed inset-0 z-[var(--z-modal)]' : 'h-full w-full'"
  data-testid="async-error-fallback"
>
  <AlertCircle class="size-5 text-danger" />
  <span class="text-[13px] text-neutral-mid">{{ t('common.loadFailed') }}</span>
  <span class="text-[12px] text-neutral-dim">{{ t('common.loadFailedHint', { n: LAZY_RETRY_LIMIT }) }}</span>
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
/**
 * [D6 2026-10-03] 旧 LAZY_RETRY_KEY（占位重试按钮注入键）已随「去界面按钮、内部自动重试」
 * 裁决删除——重试现在由 createLazyChunkRetry（lazy-chunk-retry.ts）在宿主侧自动执行，
 * 错误占位不再承载任何重试入口。
 */
import { LAZY_RETRY_LIMIT } from '@/components/ui/lazy-chunk-retry'

/** 实例级注册键的模块级递增器（script setup 变量是每实例的，计数器必须模块级） */
let surfaceSeq = 0

/** 取下一个实例注册键（AsyncErrorFallback 多懒加载占位可并存，各报各的开态） */
export function nextAsyncErrorSurfaceKey(): string {
  return `async-error-fallback-${++surfaceSeq}`
}
</script>

<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, Loader2 } from '@lucide/vue'
import { registerModalSurface } from '@/composables/features/app/modal-surface-registry'

/** defineAsyncComponent 的 errorComponent 注入 error prop；loading 态无 props。
 *  overlay 由宿主包装组件显式传入（defineAsyncComponent 的 loading/error 组件无法直接传 props）。 */
const props = defineProps<{ error?: unknown; overlay?: boolean }>()

const { t } = useI18n()

// 模态表面聚合注册（§6.7）：overlay 形态（fixed inset-0 z-modal 全屏遮罩）才入聚合——
// 本组件挂载即覆盖（根 v-if 只分 loading/error 两分支，必渲染其一），开合态绑 props.overlay
// 状态本体；实例级 key 取模块级递增（HMR 重挂换 key，旧键已随卸载注销）。旗标组由登记表按 id 读取。
const disposeSurfaceRegistration = registerModalSurface({
  surface: 'async-error-fallback-overlay',
  key: nextAsyncErrorSurfaceKey(),
  isOpen: () => props.overlay === true,
})
onBeforeUnmount(disposeSurfaceRegistration)
</script>
