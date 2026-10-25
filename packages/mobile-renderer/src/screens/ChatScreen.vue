<script setup lang="ts">
// ChatScreen —— 移动壳聊天屏 v2（remote-use-mobile-v2 §7.1；v1 App.vue chat 段暂留挂载的
// 整段替换落位，v1 视图文件清退归 u-cleanup）。
//
// 构成（自上而下）：
// - 页头：返回（goBackFromChat——popstate 单点回 chatFrom，F12）/ 标题（会话 label）/
//   状态行（回合计时「已观察 MM:SS」+ 步数，§6.21 客户端派生）/ 模型 chip（liveState
//   权威值 + 思考档短词，点击 → openSheet('model')，回执写显示态在 ModelSheet）/
//   更多（命令面板入口 → openSheet('command')，M-11 承接）。
// - RunBand（运行中子代理带，点击 → subagentList Sheet）。
// - MobileMessageStream v2（density=mobile + 贴底跟流 + 回到最新 + 加载更早保位）。
// - 输入区固定顺序（§7.1）：QueueStrip → 待回答条（form/planReview/dialog）→ 待授权条
//   （permission）→ 出错条（回合失败 + 重试）→ Composer。待回答在场时 Composer 隐藏。
//
// 数据消费分界：待回答/待授权两状态由 App.vue 单点订阅（companion-bridge hooks 含
// reconcile watch，双调用会重复触发对账）经 props 传入；条只做呈现 + openSheet（幂等，
// 单槽覆盖互斥）——条↔Sheet 联动 = D3 验收面。
//
// 出错条（§6.14 / V-3 结论主路径）：回合失败（分区尾 assistant error 消息 ∧ 非活跃）时
// 显示失败条；「重试」= 取最后一条 user 消息 id + segments 经 core editAndResend 重投
// （truncateFrom 截断重发整轮，内部新 clientUuid = 幂等口径二）；成功后插「重试本轮…」
// 动作通知（§6.20）。
//
// 草稿第三条边界（§7.1「返回列表即丢弃」）落位：路由离开 chat（去目的域——返回/侧滑/
// Android 返回键均经 popstate 单点）时清当前会话草稿条目；connect（验身失效）不清——
// 草稿跨断线保留（§7.1 边界一）。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronLeft, MoreHorizontal } from '@lucide/vue'
import { Button } from '@taiji/ui'
import { normalizeContent } from '@taiji/shared'
import type { Message, Segment } from '@taiji/shared'
import {
  appendActionNotice,
  chatStore,
  liveStateOf,
  sessionList,
  useChatInstance,
} from '../shell/app-runtime'
import { goBackFromChat, shellRoute } from '../shell/route'
import { openSheet } from '../shell/sheet-manager'
import { setDraft } from '../shell/sessions-runtime'
import { THINKING_LEVEL_LABEL_KEYS } from '../features/thinking-levels'
import { useTurnObservation } from '../features/turn-observation'
import RunBand from '../features/RunBand.vue'
import QueueStrip from '../features/QueueStrip.vue'
import Composer from '../features/Composer.vue'
import MobileMessageStream from '../views/MobileMessageStream.vue'

const props = defineProps<{
  sessionId: string
  /** 待回答条显隐：form/planReview/dialog 任一在场（条点击 openSheet('form')） */
  askPending: boolean
  /** Composer 显隐互斥：仅 ask-user 表单在场时隐藏（桌面 PlanReviewBar 行同构——
   *  planReview/dialog 节与 Composer 并存，mobile-form.spec 锁定契约，互斥面禁扩大） */
  formPending: boolean
  /** 待授权权限请求在场（待授权条显示；Composer 不隐藏——权限条与输入并存） */
  permissionPending: boolean
}>()

const { t } = useI18n()

// ── 页头数据（标题 / 模型 chip）────────────────────────────────────────────

const summary = computed(() => sessionList.value.find((s) => s.id === props.sessionId))
const title = computed(() => summary.value?.label ?? t('mobile.chat.untitled'))

/** 模型 chip 文案：liveState 权威值（切入链 getState 拉取）；缺失 = 显式未知占位（不回退
 *  列表种子字段——W1 状态层契约）；思考档经七值短词表（A-03 教训：值域自 PI_THINKING_LEVELS，
 *  词表外值不标注思考档——runtime 钳制值域扩展时短词缺失显式降级，不硬造文案） */
const chipText = computed(() => {
  const live = liveStateOf(props.sessionId)
  if (!live?.modelId) return t('mobile.model.unknown')
  const level = live.thinkingLevel
  const levelKey = level !== undefined && level in THINKING_LEVEL_LABEL_KEYS ? THINKING_LEVEL_LABEL_KEYS[level as keyof typeof THINKING_LEVEL_LABEL_KEYS] : undefined
  return levelKey ? `${live.modelId} · ${t(levelKey)}` : live.modelId
})

// ── 回合计时与步数（§6.21 客户端派生；观察形态在 ./features/turn-observation，两屏共用）──

const isActive = computed(() => chatStore.isActive(props.sessionId))
const { observedDuration, completedSteps } = useTurnObservation(computed(() => props.sessionId))

// ── 出错条（§6.14；回合失败 = 分区尾 assistant error 消息 ∧ 非生成中）────────────

const messages = computed<Message[]>(() => chatStore.getMessages(props.sessionId))

const turnError = computed(() => {
  const msgs = messages.value
  const last = msgs[msgs.length - 1]
  if (!last || last.role !== 'assistant' || last.status !== 'error' || !last.error) return null
  // 生成中（用户已重发/新回合在跑）不出错条——isActive 时错误消息随重试截断离场或待收敛
  if (chatStore.isActive(props.sessionId)) return null
  return last
})

const retrying = ref(false)

/** 出错回合重试（V-3 结论主路径）：最后一条 user 消息经 core editAndResend 截断重发整轮
 *  （内部新 clientUuid = 幂等口径二，两口径不混用——§7.1）。segments 还原 = user 消息
 *  content（Segment[] 契约）归一兜底（历史回放的纯文本形态降级单 text 段）。 */
async function onRetryTurn(): Promise<void> {
  const sid = props.sessionId
  const failed = turnError.value
  if (!failed || retrying.value) return
  const msgs = chatStore.getMessages(sid)
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
  if (!lastUser) return
  const segments: Segment[] = Array.isArray(lastUser.content)
    ? lastUser.content
    : [{ type: 'text', text: normalizeContent(lastUser.content) }]
  retrying.value = true
  try {
    const ok = await useChatInstance.editAndResend(sid, lastUser.id, segments)
    // ok = 提交成功 → 插「重试本轮…」动作通知（§6.20，动作回执成功后）。editAndResend 的
    // isActive guard 早退分支（无事发生也返回 true）在本入口不可达：出错条显隐含
    // !isActive 谓词，生成中重试钮不在 DOM。
    if (ok) {
      appendActionNotice(sid, t('mobile.notices.turnRetried'))
    }
  } finally {
    retrying.value = false
  }
}

// ── 草稿第三条边界（§7.1「返回列表即丢弃」）────────────────────────────────
// 路由离开 chat → 目的域（popstate 单点：返回钮/侧滑/Android 返回键）清当前会话草稿；
// connect 不清（验身失效草稿跨断线保留，§7.1 边界一）。删除会话的草稿清理已挂
// registerSessionCleanup（sessions-runtime 删除级联），不在此重复。

watch(shellRoute, (to, from) => {
  if (from === 'chat' && to !== 'connect') {
    setDraft(props.sessionId, '')
  }
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="chat-screen">
    <!-- 页头：返回 / 标题+状态行 / 模型 chip / 更多 -->
    <header
      class="flex shrink-0 items-center gap-1 border-b border-[var(--border)] px-1 py-1.5"
      data-testid="chat-header"
    >
      <Button
        variant="ghost"
        size="icon"
        class="size-11 shrink-0"
        data-testid="chat-back"
        :aria-label="t('mobile.back')"
        @click="goBackFromChat()"
      >
        <ChevronLeft class="size-5" />
      </Button>
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium text-neutral-fg" data-testid="chat-title">{{ title }}</p>
        <!-- 状态行（§6.21）：计时仅生成中显示（已观察措辞——显示的是本端观察时长非回合
             真实耗时）；步数 = 本回合工具完成计数 -->
        <p class="truncate text-xs text-neutral-mid" data-testid="chat-status-line">
          <template v-if="isActive && observedDuration">
            <span data-testid="chat-observed-timer">{{ t('mobile.chat.observed', { duration: observedDuration }) }}</span>
            <span v-if="completedSteps > 0"> · <span data-testid="chat-step-count">{{ t('mobile.chat.steps', { count: completedSteps }) }}</span></span>
          </template>
        </p>
      </div>
      <!-- 模型 chip（§7.2 F9）：liveState 权威值 + 思考档短词；点击 → ModelSheet（回执写
           显示态在 Sheet 内） -->
      <div
        role="button"
        tabindex="0"
        class="shrink-0 cursor-pointer rounded-full border border-[var(--border)] px-2.5 py-1.5 text-xs text-neutral-mid outline-none active:bg-bg-input focus-visible:ring-2 focus-visible:ring-accent"
        data-testid="chat-model-chip"
        :aria-label="t('mobile.chat.modelChip')"
        @click="openSheet('model')"
        @keydown.enter="openSheet('model')"
      >
        <span class="max-w-[120px] truncate">{{ chipText }}</span>
      </div>
      <!-- 更多（M-11 承接：命令面板入口） -->
      <Button
        variant="ghost"
        size="icon"
        class="size-11 shrink-0"
        data-testid="chat-more"
        :aria-label="t('mobile.chat.more')"
        @click="openSheet('command')"
      >
        <MoreHorizontal class="size-5" />
      </Button>
    </header>

    <RunBand :session-id="sessionId" />

    <MobileMessageStream :session-id="sessionId" />

    <!-- 输入区固定顺序（§7.1）：队列条 → 待回答条 → 待授权条 → 出错条 → Composer -->
    <div class="flex shrink-0 flex-col gap-1.5 px-2 pt-1.5">
      <QueueStrip :session-id="sessionId" />

      <!-- 待回答条（form/planReview/dialog；§6.5 呈现出口：条点击 openSheet 幂等） -->
      <div
        v-if="askPending"
        role="button"
        tabindex="0"
        class="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-[var(--warning-border,--border)] bg-[var(--accent-soft)] px-3 text-sm text-accent outline-none active:opacity-80 focus-visible:ring-2 focus-visible:ring-accent"
        data-testid="chat-ask-bar"
        :aria-label="t('mobile.chat.askBar')"
        @click="openSheet('form')"
        @keydown.enter="openSheet('form')"
      >
        <span class="min-w-0 flex-1 truncate">{{ t('mobile.chat.askBar') }}</span>
        <ChevronLeft class="size-4 rotate-180 shrink-0" aria-hidden="true" />
      </div>

      <!-- 待授权条（§6.18 消费半；条点击 openSheet，无归属/归属呈现分流在 PermissionSheet） -->
      <div
        v-if="permissionPending"
        role="button"
        tabindex="0"
        class="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] bg-bg-input px-3 text-sm text-neutral-fg outline-none active:opacity-80 focus-visible:ring-2 focus-visible:ring-accent"
        data-testid="chat-permission-bar"
        :aria-label="t('mobile.chat.permissionBar')"
        @click="openSheet('permission')"
        @keydown.enter="openSheet('permission')"
      >
        <span class="min-w-0 flex-1 truncate">{{ t('mobile.chat.permissionBar') }}</span>
        <ChevronLeft class="size-4 rotate-180 shrink-0" aria-hidden="true" />
      </div>

      <!-- 出错条（§6.14：失败条 + 重试；重试 = editAndResend 最后一条 user 消息） -->
      <div
        v-if="turnError"
        class="flex min-h-11 items-center gap-2 rounded-lg border border-[var(--border)] bg-bg-input px-3"
        data-testid="chat-turn-error-bar"
      >
        <span class="min-w-0 flex-1 truncate text-xs text-neutral-fg" data-testid="chat-turn-error-text">
          {{ turnError.error }}
        </span>
        <Button
          variant="secondary"
          size="sm"
          class="shrink-0"
          data-testid="chat-turn-retry"
          :disabled="retrying"
          :aria-label="t('mobile.chat.retryTurn')"
          @click="onRetryTurn"
        >
          {{ t('mobile.chat.retryTurn') }}
        </Button>
      </div>
    </div>

    <!-- Composer（仅 ask-user 表单在场时隐藏——作答优先互斥；planReview/dialog 并存） -->
    <Composer v-if="!formPending" :session-id="sessionId" />
  </div>
</template>
