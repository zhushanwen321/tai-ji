<!--
  StreamItemBoundary —— 对话流单条渲染项的错误边界（RD-2#1 / code-harden RD-2）。

  问题：Turn/BashOutputBlock/SystemNotice/SkillNoticeInline 等子组件 render 抛错发生在
  MessageStream 的渲染帧内，全仓 onErrorCaptured=0，错误直达全局 errorHandler（只落盘
  renderer-error.log）——一条坏数据炸掉整屏消息流（退化旧帧/空白），用户零感知。

  机制：本组件包住每条渲染项，onErrorCaptured 捕获子树内（slot 内容 = 各渲染子组件）
  的 render/setup 错误 → 记录（console.error + reportCapturedError 落盘，与全局 errorHandler
  同一上报通道）→ return false 阻断向全局传播 → 切换为「本条渲染失败」占位行（含原文
  预览 + 重试入口）。其余 item 不受影响——故障隔离粒度从整屏收敛到单条。

  重试语义：占位行期间 slot 内容已随 v-if 分支卸载；点重试复位 failed → slot 内容重新
  挂载（slot 函数重新执行，子组件全新实例），数据已被修复时恢复渲染，仍坏则再次落入
  本边界。

  边界自身 render 不消费响应式子树（占位行是静态模板），自身抛错面结构性为零；slot
  函数体的表达式抛错由上层前置求值兜（stream-view-items.ts，本组件捕获不到自身 render
  帧内的错误——Vue errorCaptured 只链式上报后代组件的错误）。
-->
<template>
  <div
    v-if="failed"
    class="content-col flex min-w-0 items-center gap-2 py-1"
    data-testid="stream-item-error"
  >
    <AlertTriangle class="size-3.5 shrink-0 text-warn" />
    <div class="flex min-w-0 flex-col gap-0.5">
      <span class="text-[length:var(--text-xs)] text-warn">{{ t('panel.message.itemRenderFailed') }}</span>
      <span
        v-if="preview"
        class="min-w-0 truncate text-[length:var(--text-2xs)] text-neutral-dim"
        :title="preview"
      >{{ preview }}</span>
    </div>
    <Button variant="ghost" size="sm" data-testid="stream-item-error-retry" @click="retry">
      {{ t('panel.message.itemRenderRetry') }}
    </Button>
  </div>
  <template v-else>
    <slot />
  </template>
</template>

<script setup lang="ts">
import { onErrorCaptured, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { reportCapturedError } from '@/boot/error-reporter'

defineProps<{
  /** 原文预览（占位行诊断信息；由上层视图模型算好传入，空串时不显示） */
  preview: string
}>()

const { t } = useI18n()

const failed = ref(false)

onErrorCaptured((err, _instance, info) => {
  if (failed.value) return false
  failed.value = true
  // 记录与全局 errorHandler 同通道（D2 单一上报出口）：console 留现场 + 落盘取证
  console.error(`[StreamItemBoundary] item render failed (${info}):`, err)
  reportCapturedError(err, `stream-item-boundary:${info}`)
  // 阻断向全局 errorHandler 传播：单条故障不升级为整流故障，用户侧已有占位行显形
  return false
})

function retry(): void {
  failed.value = false
}
</script>
