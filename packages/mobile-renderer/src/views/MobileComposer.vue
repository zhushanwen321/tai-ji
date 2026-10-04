<script setup lang="ts">
// MobileComposer —— 移动壳输入条（ui ComposerInput 复用 + 发送/中断键拇指区）。
//
// ComposerInputDeps 注入（W4 C1 契约三字段）：
// - pasteImage：web 降级实现（D7 图片粘贴行——返回文本占位「[图片粘贴：需桌面环境]」，
//   contenteditable 按 kind:'text' 走文本降级路径，消息正常发出）
// - renderIcon：恒 false（移动壳不建命令浮层，slash chip 不可达；D7 slash bar Phase 2）
// - t：vue-i18n（chip × 按钮 aria-label 文案，单源 ui locale 下沉域）
//
// 发送走 core useChat.send（乐观气泡/steer 路由/sidecar 写入均为 core send 编排内置）；
// 中断键（isActive 时可见）调 useChat.abort（D7 中断行）。
import { computed, provide, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Send, Square } from '@lucide/vue'
import { Button } from '@taiji/ui'
import { ComposerInput, ComposerInputDepsKey } from '@taiji/ui/features/composer'
import type { ComposerInputDeps } from '@taiji/ui/features/composer'
import type { HandleImagePasteResult } from '@taiji/dom-core/composer/input'
import { chatStore, useChatInstance } from '../shell/app-runtime'

const props = defineProps<{ sessionId: string | null }>()

const { t } = useI18n()

/** ComposerInput 实例句柄（getText/getSegments/clear 经 expose 契约消费） */
const input = ref<InstanceType<typeof ComposerInput> | null>(null)

const deps: ComposerInputDeps = {
  pasteImage: async (): Promise<HandleImagePasteResult> => {
    // D7 图片粘贴降级：移动浏览器无 writeSessionImage IPC 落盘通路，文本占位语义
    return { kind: 'text', text: t('mobile.pasteImageFallback') }
  },
  renderIcon: () => false,
  t: (key: string) => t(key),
}

provide(ComposerInputDepsKey, deps)

const canSend = computed(() => props.sessionId !== null)
const isActive = computed(() => (props.sessionId ? chatStore.isActive(props.sessionId) : false))

/** 发送：segments 交 core send 编排（空文本 guard 由 core 内部 + 此处双挡） */
async function onSend(): Promise<void> {
  const sid = props.sessionId
  if (!sid) return
  const comp = input.value
  if (!comp) return
  const segments = comp.getSegments()
  if (segments.length === 0) return
  comp.clear()
  try {
    await useChatInstance.send(sid, segments)
  } catch (e) {
    // 降级策略：乐观气泡由 core send 编排回滚，console 记录供诊断（移动壳 v1 无 toast 通道）
    console.error('[mobile-composer] send failed:', e)
  }
}

/** 中断当前回合（D7 中断行） */
async function onStop(): Promise<void> {
  const sid = props.sessionId
  if (!sid) return
  try {
    await useChatInstance.abort(sid)
  } catch (e) {
    // 降级策略：abort RPC 失败仅记录——turn 收口由断连/runtime 事件兜底（core finalize 链）
    console.error('[mobile-composer] abort failed:', e)
  }
}

/** Enter 发送（触屏主路径是发送键；物理键盘 Enter 顺带支持，Shift+Enter 换行由 dom-core 处理） */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void onSend()
  }
}
</script>

<template>
  <div class="flex shrink-0 items-end gap-2 border-t border-[var(--border)] bg-bg p-2" data-testid="mobile-composer">
    <div class="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-bg-input">
      <ComposerInput
        ref="input"
        :session-id="sessionId"
        :placeholder="t('mobile.composer.placeholder')"
        :disabled="!canSend"
        @keydown="onKeydown"
      />
    </div>
    <Button
      v-if="isActive"
      variant="default"
      size="icon"
      data-testid="mobile-composer-stop"
      :aria-label="t('mobile.composer.stop')"
      :title="t('mobile.composer.stop')"
      @click="onStop"
    >
      <Square class="size-4" />
    </Button>
    <Button
      v-else
      variant="default"
      size="icon"
      data-testid="mobile-composer-send"
      :disabled="!canSend"
      :aria-label="t('mobile.composer.send')"
      :title="t('mobile.composer.send')"
      @click="onSend"
    >
      <Send class="size-4" />
    </Button>
  </div>
</template>
