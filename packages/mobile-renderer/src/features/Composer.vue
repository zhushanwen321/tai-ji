<script setup lang="ts">
// Composer —— 移动壳聊天输入条 v2（remote-use-mobile-v2 §7.1；v1 views/MobileComposer 的
// 重写承接，v1 文件清退归 u-cleanup）。
//
// 相对 v1 的两处契约升级：
// ① 发送幂等两口径（§7.1）：「未送达重发」（弱网失败重试）复用原 clientUuid——runtime 按
//    clientUuid 幂等，防已受理回执丢失导致双投；「出错回合重试」（§6.14，出错条入口）是
//    新投递意图用新 clientUuid（editAndResend 内部生成，两口径不可混用）。实现：每次发送
//    意图生成幂等键（randomUuid，secure-context 安全包装——LAN http 下 crypto.randomUUID
//    为 undefined，与 core submitNewMessage 同一包装）；RPC 失败（send 返回 false）时记录
//    「失败键 + segments 快照」，下次发送内容与快照一致 = 重发意图 → 复用该键；内容被修改
//    = 新意图 → 新键。送达成功清记录。
// ② 会话草稿三条边界（§7.1 草稿生命周期，载体 = sessions-runtime 草稿表 draftOf/setDraft
//    ——壳层唯一草稿表，删除级联已挂 registerSessionCleanup）：输入即写（跨断线、跨 Sheet
//    开关保留）；切会话恢复目标会话草稿（再切回保留）；「返回列表即丢弃」由 ChatScreen 在
//    路由离开 chat（非 connect）时清当前会话条目——本组件不感知路由。
//
// 其余承接 v1：ui ComposerInput 复用（pasteImage web 降级 / renderIcon 恒 false）；发送走
// core useChat.send（乐观气泡/lane 判定/受理回执上屏为 core 编排内置）；发送失败契约
//（D6：false = 回填 + 内联错误行，草稿不丢）；锚定编辑分流（delivery.edit 原位替换）；
// 停止按钮（D5 内容驱动双形态）；队列取消全文回填消费端（composerInjection 通道）。
// 新增：中断成功插动作通知（§6.20「已中断本轮生成」，appendActionNotice 壳层唯一出口）。
import { computed, onMounted, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clock, Send, Square } from '@lucide/vue'
import { randomUuid } from '@taiji/core'
import { Button } from '@taiji/ui'
import { ComposerInput, ComposerInputDepsKey } from '@taiji/ui/features/composer'
import type { ComposerInputDeps } from '@taiji/ui/features/composer'
import type { HandleImagePasteResult } from '@taiji/dom-core/composer/input'
import type { Segment } from '@taiji/shared'
import { isActiveTurnPhase, segmentsToPrompt } from '@taiji/shared'
import {
  appendActionNotice,
  chatStore,
  composerInjectionStore,
  clearQueueEditFor,
  editDelivery,
  queueEditAnchorOf,
  useChatInstance,
} from '../shell/app-runtime'
import { draftOf, setDraft } from '../shell/sessions-runtime'
import { showErrorBar } from '../shell/error-bar'

const props = defineProps<{ sessionId: string }>()

const { t } = useI18n()

/** ComposerInput 实例句柄（getText/getSegments/clear/setText 经 expose 契约消费） */
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

// ── 会话草稿三条边界（§7.1；载体 = sessions-runtime 草稿表，壳层唯一）──────────────
// 输入即写（onInputChange）；挂载/切会话恢复目标会话草稿（setText 触发 input 事件，
// hasInput 自动归位——v1 已核实的 ComposerInput 程序化写入语义）。

function onInputChange(text: string): void {
  // 输入内容跟踪（发送/停止按钮分档依据 D5）：clear/setText 程序化写入同样 emit input
  //（dom-core contenteditable），无陈旧窗口——草稿恢复后按钮态自动归位
  hasInput.value = text.trim().length > 0
  setDraft(props.sessionId, text)
  // 清空草稿解除锚定（chat-flow-consistency Q4 解除路径；sid 守卫同桌面 composer-shell——
  // 切会话的草稿保存/恢复链 sid 变化不触发，同会话内「有内容 → 空」边沿（发送 clear /
  // 手动删空）才解除）。发送分流已先行清除时幂等无害。
  if (text.trim() === '' && queueEditAnchorOf(props.sessionId) !== null) {
    clearQueueEditFor(props.sessionId)
  }
}

function restoreDraft(sid: string): void {
  const comp = input.value
  if (!comp) return
  const draft = draftOf(sid)
  if (draft) comp.setText(draft)
  else comp.clear()
}

onMounted(() => restoreDraft(props.sessionId))

watch(
  () => props.sessionId,
  (sid) => restoreDraft(sid),
)

// ── 发送位形态判定（D5 内容驱动双形态，v1 承接）────────────────────────────
const hasInput = ref(false)

// occupancy 派生视图 + 乐观窗（chatStore.isActive 含 pendingSend 乐观成分——本地 send 的
// 乐观置位先于 occupancy 广播，投影化为 dispatching 对齐桌面壳 effectivePhase 同款）。
const effectivePhase = computed(() => {
  const sid = props.sessionId
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

// 错误与失败重发键归属被失败的发送尝试，不跨会话跟随（对齐 form 通道「请求被摘除/新请求
// 到达不残留」语义）
watch(
  () => props.sessionId,
  () => {
    sendFailed.value = false
    clearResendKey()
  },
)

// ── 发送幂等两口径（§7.1）──────────────────────────────────────────────────
// 失败重发键：uuid + segments 快照。重发判定 = 新输入 segments 序列化后与快照一致（内容
// 未被修改 = 同一发送意图的弱网重试 → 复用键防双投；修改过 = 新意图 → 新键）。键形态
// `u-<uuid>` 与 core submitNewMessage 既有生成格式一致（标记正则兼容面）。
const resendKey = ref<{ clientUuid: string; prompt: string } | null>(null)

function clearResendKey(): void {
  resendKey.value = null
}

function newClientUuid(): string {
  return `u-${randomUuid()}`
}

/** 发送：segments 交 core send 编排（空文本 guard 由 core 内部 + 此处双挡）。 */
async function onSend(): Promise<void> {
  const sid = props.sessionId
  const comp = input.value
  if (!comp) return
  const segments = comp.getSegments()
  if (segments.length === 0) return
  sendFailed.value = false
  try {
    // 锚定编辑分流（chat-flow-consistency D6）：锚定在册 → delivery.edit 原位替换
    //（成功 = 无乐观气泡——条目已在队列条，preview 随 session.delivery 帧更新）；
    // edited=false 四值降级 = 内容按普通新消息发出（useChatInstance.send 乐观气泡通路）
    // + 错误条分型提示（Q3 处置同构不变式：内容不丢，仅 toast 分型）。
    const anchorUuid = queueEditAnchorOf(sid)
    if (anchorUuid !== null) {
      const reply = await editDelivery(sid, anchorUuid, segmentsToPrompt(segments))
      clearQueueEditFor(sid)
      if (reply.edited) {
        comp.clear()
        return
      }
      showErrorBar(t(editReplyNoticeKey(reply.reason)))
      if (!(await deliverNew(sid, segments, comp))) return
      // 降级成功显式清输入（对齐 v1 MobileComposer delivered !== false 分支的 comp.clear()；
      // D6 成功分支才清输入——不清则已发内容残留输入框与草稿分区，再点发送 = 同一内容双投）。
      // 不能改删 return 落到底部统一 clear：会穿入下方普通新消息路径再投一次（双投）
      comp.clear()
      return
    }
    if (!(await deliverNew(sid, segments, comp))) return
  } catch (e) {
    // 契约外异常防御（对齐桌面 useComposerSend catch 分支；core send 契约内不 throw）：
    // 回填 + 错误行可见，console 记录供诊断（错误条单槽留给 core 失败情形文案）
    comp.setSegments(segments)
    sendFailed.value = true
    console.error('[composer] send failed:', e)
    return
  }
  // 成功分支才清输入（D6：clear 移到成功分支，失败路径草稿原地保留可重发）
  comp.clear()
}

/**
 * 新消息投递（幂等口径一承载点）：未送达重发复用失败键（内容一致），其余新键。
 * 返回 true = 投递受理成功（调用方清输入）；false = 失败（回填 + 错误行已落，输入保留）。
 */
async function deliverNew(sid: string, segments: Segment[], comp: NonNullable<typeof input.value>): Promise<boolean> {
  const prompt = segmentsToPrompt(segments)
  // 幂等键判定：内容与上次失败尝试一致 → 复用该键（重发意图）；不一致或无记录 → 新键
  const reused = resendKey.value !== null && resendKey.value.prompt === prompt
  const clientUuid = reused ? resendKey.value!.clientUuid : newClientUuid()
  // 严格比较 false（对齐桌面 useComposerSend）：只认显式失败信号，真值判断会把成功发送误判为失败
  const delivered = await useChatInstance.send(sid, segments, { clientUuid })
  if (delivered === false) {
    resendKey.value = { clientUuid, prompt }
    comp.setSegments(segments)
    sendFailed.value = true
    return false
  }
  clearResendKey()
  return true
}

/** edit 回执 reason → 错误条文案 key（四值分型，Q3；undefined = 契约违规按 unconfirmed 口径兜底）。 */
function editReplyNoticeKey(reason: 'delivered' | 'unconfirmed' | 'cancelled' | 'not-found' | undefined): string {
  switch (reason) {
    case 'delivered':
      return 'mobile.queueStrip.editDelivered'
    case 'cancelled':
      return 'mobile.queueStrip.editCancelled'
    case 'not-found':
      return 'mobile.queueStrip.editNotFound'
    default:
      return 'mobile.queueStrip.editUnconfirmed'
  }
}

/** 中止会话当前占用（v1 承接 + §6.20 动作通知）：abort RPC 成功（动作回执成立）后插
 *  「已中断本轮生成」system 提示行；RPC 失败仅记录——turn 收尾由断连/runtime 事件兜底。 */
async function onStop(): Promise<void> {
  const sid = props.sessionId
  try {
    await useChatInstance.abort(sid)
    appendActionNotice(sid, t('mobile.notices.turnAborted'))
  } catch (e) {
    // 降级策略（best-effort 中断）：abort RPC 失败不传播不提示——turn 收尾由断连/runtime
    // 事件兜底（core finalize 链）；不插通知（回执未成立不造假事实，§6.20）。console 留
    // 排障依据，错误条单槽留给 core 失败情形文案。
    console.error('[composer] abort failed:', e)
  }
}

// ── 队列取消全文回填消费端（v1 承接）────────────────────────────────────
// QueueStrip 取消成功经 composerInjectionStore 通道送来全文；本组件是消费侧。
// watch + onMounted 补检查互补（挂载晚于写入 / 早于写入两时序）；form 请求期 v-if 卸载
// 窗口的请求落槽位残留，重挂载时补消费（文本不丢）。sessionId 匹配门：取消 A 会话条目
// 不落 B 会话输入框。insertTextAtCursor = 光标处插入（追加不覆盖）。
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
    <!-- 发送失败内联错误行（D6，respondFailedId 范式：role=alert + 专用 testid）；
         失败后直接再点发送 = 未送达重发（复用幂等键，§7.1 口径一） -->
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
          @input="onInputChange"
          @keydown="onKeydown"
        />
      </div>
      <!-- 停止按钮（无内容 + 会话占用；title 两档对齐桌面：回合中止=停止 / 仅压缩=终止压缩）；
           icon-44 档（§6.9 专为移动建的 44px 档，§2 目标 2 中断拇指可达） -->
      <Button
        v-if="showStop"
        variant="default"
        size="icon-44"
        data-testid="mobile-composer-stop"
        :aria-label="stopTarget === 'compacting' ? t('mobile.composer.stopCompacting') : t('mobile.composer.stop')"
        :title="stopTarget === 'compacting' ? t('mobile.composer.stopCompacting') : t('mobile.composer.stop')"
        @click="onStop"
      >
        <Square class="size-4" />
      </Button>
      <!-- 发送按钮（±排队角标）：有内容恒发送；无内容空闲 = 禁用态发送占位；
           icon-44 档（44px 触控，§2 目标 2） -->
      <Button
        v-else
        variant="default"
        size="icon-44"
        class="relative"
        data-testid="mobile-composer-send"
        :disabled="!hasInput"
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
