<script setup lang="ts">
// MobileComposer —— 移动壳输入条（ui ComposerInput 复用 + 发送/中断键拇指区）。
//
// ComposerInputDeps 注入（W4 C1 契约三字段）：
// - pasteImage：web 降级实现（remote-use-mobile D7（移动壳 v1 功能集裁定）图片粘贴行——返回文本占位「[图片粘贴：需桌面环境]」，
//   contenteditable 按 kind:'text' 走文本降级路径，消息正常发出）
// - renderIcon：恒 false（移动壳不建命令浮层，slash chip 不可达；remote-use-mobile D7 slash 命令 bar 行 Phase 2）
// - t：vue-i18n（chip × 按钮 aria-label 文案，单源 ui locale 下沉域）
//
// 发送走 core useChat.send（乐观气泡/steer 路由/sidecar 写入均为 core send 编排内置）；
// 停止键（无内容 + 会话占用时可见）调 useChat.abort（remote-use-mobile D7 中断行）。
//
// 发送位形态（chat-flow-consistency D5 内容驱动双形态，移动壳裁剪集 = 有内容/无内容 + 乐观窗，
// 不含 Alt/交接/landing 首发形态/subagent 变体——设计 D5 变体条）：有内容恒发送按钮（排队去向
// 叠加时钟角标）；无内容 + 会话占用（回合进行中/压缩中）→ 停止按钮；无内容 + 空闲 → 禁用态
// 发送占位。bash 不触发停止（取消入口在其输出块自身）；角标判定读 shared isActiveTurnPhase
// （D1 判定集合，与桌面壳共用同一函数——裁剪集内两壳同格同形态）。
//
// 发送失败契约（D6，对齐 core R2-A5 失败信号）：send 返回 false = RPC 失败（内部已
// 消化——乐观气泡已回滚、transport 级 toast 已发；契约内不 throw）→ ComposerInput
// 回填原文本（setSegments）+ 内联错误行（复用 form 通道 respondFailedId 范式）；
// comp.clear() 只在成功分支执行——失败不丢草稿（S5 修复，V5 验收范围）。
// 双通道并存口径（两类失败可见提示数不同）：传输级失败（断连/超时）= ErrorBar（core
// toast 带原因，A7 通道）+ 本内联行（操作指引）同帧双提示；classified 否决级（hook
// 否决）= core toast 抑制（runtime 已广播流内错误气泡），仅本内联行一条。是否收敛为
// 单通道留 UX 复审裁决。
import { computed, onMounted, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clock, Send, Square } from '@lucide/vue'
import { Button } from '@taiji/ui'
import { ComposerInput, ComposerInputDepsKey } from '@taiji/ui/features/composer'
import type { ComposerInputDeps } from '@taiji/ui/features/composer'
import type { HandleImagePasteResult } from '@taiji/dom-core/composer/input'
import { IDLE_SESSION_PHASE, isActiveTurnPhase } from '@taiji/shared'
import { chatStore, composerInjectionStore, useChatInstance } from '../shell/app-runtime'

const props = defineProps<{ sessionId: string | null }>()

const { t } = useI18n()

/** ComposerInput 实例句柄（getText/getSegments/clear 经 expose 契约消费） */
const input = ref<InstanceType<typeof ComposerInput> | null>(null)

const deps: ComposerInputDeps = {
  pasteImage: async (): Promise<HandleImagePasteResult> => {
    // remote-use-mobile D7 图片粘贴降级：移动浏览器无 writeSessionImage IPC 落盘通路，文本占位语义
    return { kind: 'text', text: t('mobile.pasteImageFallback') }
  },
  renderIcon: () => false,
  t: (key: string) => t(key),
}

provide(ComposerInputDepsKey, deps)

const canSend = computed(() => props.sessionId !== null)

// ── 发送位形态判定（D5 内容驱动双形态，移动壳裁剪集）────────────────────────────
// 输入内容跟踪（有内容 = 发送按钮的分档依据）：ComposerInput input 事件驱动；clear/setText
// 程序化写入同样 emit input（dom-core contenteditable），无陈旧窗口。
const hasInput = ref(false)
function onInputChange(text: string): void {
  hasInput.value = text.trim().length > 0
}

// occupancy 派生视图 + 乐观窗（D5-4 变体：chatStore.isActive 含 pendingSend 乐观成分——本地
// send 的乐观置位先于 occupancy 广播，投影化为 dispatching 对齐桌面壳 effectivePhase 同款）。
// 无会话（landing 等价态）= 全 idle → 恒禁用发送占位（移动壳无首条发送形态）。
const effectivePhase = computed(() => {
  const sid = props.sessionId
  if (!sid) return IDLE_SESSION_PHASE
  const phase = chatStore.sessionPhase(sid)
  return chatStore.isActive(sid) && phase.turn === 'idle' ? { ...phase, turn: 'dispatching' as const } : phase
})
const activeTurn = computed(() => isActiveTurnPhase(effectivePhase.value.turn))
/** 无内容 + 会话占用（回合进行中/压缩中）→ 停止按钮；bash 不参与（D5 采用 2） */
const showStop = computed(() => !hasInput.value && (activeTurn.value || effectivePhase.value.compacting))
/** 停止 title 两档（对齐桌面 sendButtonStopTarget 规则：回合中止优先于压缩取消） */
const stopTarget = computed<'compacting' | 'turn' | null>(() => {
  const phase = effectivePhase.value
  if (phase.turn === 'dispatching' || phase.turn === 'generating') return 'turn'
  if (phase.compacting) return 'compacting'
  if (phase.turn === 'settling') return 'turn'
  return null
})
/** 发送按钮排队角标（有内容 ∧ 回合进行中/压缩中——bash 不参与、空闲无角标，D5 采用 3） */
const queueBadge = computed(() => hasInput.value && (activeTurn.value || effectivePhase.value.compacting))

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
    // 回填 + 错误行可见，console 记录供诊断（错误条单槽留给 core 失败情形文案）
    comp.setSegments(segments)
    sendFailed.value = true
    console.error('[mobile-composer] send failed:', e)
    return
  }
  // 成功分支才清输入（D6：clear 移到成功分支，失败路径草稿原地保留可重发）
  comp.clear()
}

/** 中止会话当前占用（remote-use-mobile D7 中断行；中止对象 = 压缩流程/当前回合由 runtime 按权威态判定） */
async function onStop(): Promise<void> {
  const sid = props.sessionId
  if (!sid) return
  try {
    await useChatInstance.abort(sid)
  } catch (e) {
    // 降级策略：abort RPC 失败仅记录——turn 收尾由断连/runtime 事件兜底（core finalize 链）
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
          @input="onInputChange"
          @keydown="onKeydown"
        />
      </div>
      <!-- 停止按钮（无内容 + 会话占用；title 两档对齐桌面：回合中止=停止 / 仅压缩=终止压缩） -->
      <Button
        v-if="showStop"
        variant="default"
        size="icon"
        data-testid="mobile-composer-stop"
        :aria-label="stopTarget === 'compacting' ? t('mobile.composer.stopCompacting') : t('mobile.composer.stop')"
        :title="stopTarget === 'compacting' ? t('mobile.composer.stopCompacting') : t('mobile.composer.stop')"
        @click="onStop"
      >
        <Square class="size-4" />
      </Button>
      <!-- 发送按钮（±排队角标）：有内容恒发送；无内容空闲 = 禁用态发送占位（title「输入内容后发送」） -->
      <Button
        v-else
        variant="default"
        size="icon"
        class="relative"
        data-testid="mobile-composer-send"
        :disabled="!canSend || !hasInput"
        :aria-label="queueBadge ? t('mobile.composer.queueSend') : t('mobile.composer.send')"
        :title="queueBadge ? t('mobile.composer.queueSend') : !hasInput ? t('mobile.composer.sendHint') : t('mobile.composer.send')"
        @click="onSend"
      >
        <Send class="size-4" />
        <Clock v-if="queueBadge" class="absolute right-[2px] top-[2px] size-[8px]" aria-hidden="true" />
      </Button>
    </div>
  </div>
</template>
