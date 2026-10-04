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
//
// 发送失败契约（D6，对齐 core R2-A5 失败信号）：send 返回 false = RPC 失败（内部已
// 消化——乐观气泡已回滚、transport 级 toast 已发；契约内不 throw）→ ComposerInput
// 回填原文本（setSegments）+ 内联错误行（复用 form 通道 respondFailedId 范式）；
// comp.clear() 只在成功分支执行——失败不丢草稿（S5 修复，V5 验收面）。
import { computed, onMounted, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Send, Square } from '@lucide/vue'
import { Button } from '@taiji/ui'
import { ComposerInput, ComposerInputDepsKey } from '@taiji/ui/features/composer'
import type { ComposerInputDeps } from '@taiji/ui/features/composer'
import type { HandleImagePasteResult } from '@taiji/dom-core/composer/input'
import { chatStore, composerInjectionStore, useChatInstance } from '../shell/app-runtime'

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

/** 发送失败内联错误行（D6，respondFailedId 范式：新尝试或切换 session 时不残留） */
const sendFailed = ref(false)

// 错误归属被失败的发送尝试，不跨会话跟随（对齐 form 通道「请求被摘除/新请求到达不残留」语义）
watch(
  () => props.sessionId,
  () => {
    sendFailed.value = false
  },
)

/** 发送：segments 交 core send 编排（空文本 guard 由 core 内部 + 此处双挡） */
async function onSend(): Promise<void> {
  const sid = props.sessionId
  if (!sid) return
  const comp = input.value
  if (!comp) return
  const segments = comp.getSegments()
  if (segments.length === 0) return
  sendFailed.value = false
  try {
    // 严格比较 false（对齐桌面 useComposerSend）：只认显式失败信号，真值判断会把成功发送误判为失败
    const delivered = await useChatInstance.send(sid, segments)
    if (delivered === false) {
      comp.setSegments(segments)
      sendFailed.value = true
      return
    }
  } catch (e) {
    // 契约外异常防御（对齐桌面 useComposerSend catch 分支；core send 契约内不 throw）：
    // 回填 + 错误行可见，console 记录供诊断（移动壳 v1 无 toast 通道）
    comp.setSegments(segments)
    sendFailed.value = true
    console.error('[mobile-composer] send failed:', e)
    return
  }
  // 成功分支才清输入（D6：clear 移到成功分支，失败路径草稿原地保留可重发）
  comp.clear()
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

// ── 队列取消全文回填消费端（remote-use D7/U10）────────────────────────────
// QueueStrip 取消成功经 composerInjectionStore 通道送来全文；本组件是消费侧。
// watch + onMounted 补检查互补（挂载晚于写入 / 早于写入两时序——core injection-store
// 消费范式与桌面 useComposerInjection 同构）；form 请求期 v-if 卸载窗口的请求落槽位
// 残留，重挂载时补消费（文本不丢）。sessionId 匹配门：取消 A 会话条目不落 B 会话
// 输入框。insertTextAtCursor = 光标处插入（追加不覆盖：用户正在输入的内容不丢，G5
// 同族语义；桌面消费端同款 API），消费后立即清槽（一次性通道，防重复注入）。
function consumePendingInjection(): void {
  const pending = composerInjectionStore.pendingInjection.value
  const comp = input.value
  if (!pending || !comp) return
  if (pending.target !== 'current' || pending.sessionId !== props.sessionId) return
  if (!pending.text) return
  comp.insertTextAtCursor(pending.text)
  composerInjectionStore.clearInjection()
}

watch(composerInjectionStore.pendingInjection, consumePendingInjection)
onMounted(consumePendingInjection)

/** Enter 发送（触屏主路径是发送键；物理键盘 Enter 顺带支持，Shift+Enter 换行由 dom-core 处理） */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void onSend()
  }
}
</script>

<template>
  <div class="flex shrink-0 flex-col border-t border-[var(--border)] bg-bg" data-testid="mobile-composer">
    <!-- 发送失败内联错误行（D6，复用 form 通道 respondFailedId 范式：role=alert + 专用 testid） -->
    <p
      v-if="sendFailed"
      class="px-2 pt-2 text-xs text-neutral-fg"
      role="alert"
      data-testid="mobile-composer-send-error"
    >
      {{ t('mobile.composer.sendFailed') }}
    </p>
    <div class="flex items-end gap-2 p-2">
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
  </div>
</template>
