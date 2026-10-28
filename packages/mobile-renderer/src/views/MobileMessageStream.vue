<script setup lang="ts">
// MobileMessageStream v2 —— 移动壳消息流容器（remote-use-mobile-v2 §6.2 消费半；v1 文件
// 原地升级，remote-use D10「ChatViewDeps provide 义务」转移落点不变：桌面由 MessageStream.vue
// provide，该组件不复用 → 义务在本组件）。
//
// v2 相对 v1 的三处变化：
// ① density:'mobile' provide（§6.2 移动 variant 注入——正文 16px/1.62、思考块收起一行、
//    工具行 13px 密度；additive 维度经 ChatViewDeps 单一 provide 树，桌面缺省不受影响）。
// ② 「回到最新」浮钮（§5.1：上滑看历史右下浮出，≥44px 触控档；nearBottom 单谓词驱动显隐，
//    点击回底并恢复贴底跟随）。
// ③ 流尾内嵌 QueueStrip 摘除——输入区固定顺序（§7.1：运行带→队列条→待回答条→待授权条→
//    出错条→Composer）收拢 ChatScreen，消息流回归纯消息。
//
// 其余承接 v1（逐项核对不丢失）：
// - 贴底自动跟流 + 上滑不抢滚动（nearBottom 阈值 + MutationObserver 覆盖流式 delta 增高）
// - 加载更早前插保位（TruncatedHistoryBar + core loadMoreHistory 游标翻页；前插后非贴底态
//   scrollTop += 增量补偿，贴底态两路写入以 nearBottom 单谓词互斥）
// - 按需加载（游标扩窗，渲染不虚拟化 §7.1——ChatView 全量渲染窗口内消息）
// - M-7 撤回常显：deps.onRevokeMessage 接线（UserBubble msg-revoke-button 常显，
//   core useChat.revokeMessage 单点路由）——v1 :70-72 原样保留
// - M-8 运行中 bash 停止：deps.abortBash 接线（ToolRow 停止入口）——v1 :65-67 原样保留
// - hover 族 no-op（M-9）/ mermaid 占位降级 / 图片粘贴降级（M-13）/ markdown 渲染桥接
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDown } from '@lucide/vue'
import { ChatView, ChatViewDepsKey, TruncatedHistoryBar } from '@taiji/ui'
import type { ChatViewDeps } from '@taiji/ui'
import { renderMarkdownSegments } from '@taiji/ui/features/chat/markdown'
import {
  createIncrementalRenderCache,
  renderIncremental,
  STREAMING_FENCE_SILENCE_MS,
} from '@taiji/ui/features/chat/markdown-incremental'
import type { Message } from '@taiji/shared'
import { chatStore, createTurnExpansion, useChatInstance } from '../shell/app-runtime'
import { renderMermaidPlaceholder } from '../shell/mermaid-placeholder'

const props = defineProps<{ sessionId: string }>()

const { t } = useI18n()

// ── ① 真实现（store 派生 + turn 展开分区 + 渲染链）────────────────────

const expansion = createTurnExpansion(computed(() => props.sessionId))

/** markdown 路径链接化 env：loadFileCandidates 空数组（remote-use-mobile D7 面板族降级）→ 白名单空集，
 *  路径渲染为普通文本（与桌面 load 失败降级形态一致） */
const EMPTY_ENV = { filePaths: new Set<string>(), localFiles: new Set<string>() }

const deps: ChatViewDeps = {
  // 数据获取器（core chat store 派生；messages 经 props 传入 ChatView，不再走 deps）
  isActive: (sid) => chatStore.isActive(sid),
  isHandingOff: (sid) => chatStore.isHandingOff(sid),
  getChangeSetStatus: (sid, messageId) => chatStore.getChangeSetStatus(sid, messageId),
  isExpanded: (turnKey) => expansion.isExpanded(turnKey),
  // 惰性接管态（D10：移动壳 turn 展开分区无接管态，恒 false——与 ui 组件侧原兜底等价）
  isTakeover: () => false,
  // pendingSend 派生视图（core chat store 派生视图，UserBubble submitEdit 双发锁消费）
  isPendingSend: (sid) => chatStore.isPendingSend(sid),

  // 操作回调
  toggleExpand: (turnKey) => expansion.toggle(turnKey),
  // [chat-flow-consistency C3] ChatViewDeps.collapse 已随 Turn.vue onComplete 接线退役删除
  // 惰性接管写入（同 isTakeover：移动壳无接管态，no-op）
  setTakeover: () => {},
  // [M-8] 运行中 bash 停止入口（ToolRow 停止按钮消费）——v1 :65-67 接线原样保留
  abortBash: (sid) => {
    void useChatInstance.abortBash(sid)
  },
  // [M-7] 撤回统一单入口（UserBubble msg-revoke-button 常显消费；core useChat.revokeMessage：
  // 在途 cancel / 已送达树内回退的路由判定在 core 单点，壳透传 targetId）——v1 :70-72 原样保留
  onRevokeMessage: (sid, targetId) => {
    void useChatInstance.revokeMessage(sid, targetId)
  },
  // hover 全族 no-op（M-9：触屏不可见；恢复路径 = 桌面操作。F13 重试走独立失败条入口）
  editAndResend: () => {},
  onForkAsk: () => {},
  onHandoffAsk: () => {},
  openDrawer: () => {},
  onFileClick: () => {},
  // 浮层浏览器为桌面壳能力（display-containers §7.4）；移动壳无浮层容器，降级系统浏览器
  openBrowser: (url) => {
    window.open(url, '_blank', 'noopener')
  },

  // 数据加载（remote-use-mobile D7 面板族 Phase 2：空候选 → 路径链接化降级普通文本）
  loadFileCandidates: () => [],

  // 渲染桥接（渲染链下沉 ui 单源；copyLabel 注入——ui 渲染模块不依赖壳 i18n 单例）
  renderMarkdown: (source) => renderMarkdownSegments(source, { ...EMPTY_ENV, copyLabel: t('composable.copyLabel') }),
  renderMarkdownIncremental: async (source, cache, _sid, opts) => {
    const c = cache ?? createIncrementalRenderCache()
    const result = await renderIncremental(source, c, { ...EMPTY_ENV, copyLabel: t('composable.copyLabel') }, opts)
    return { ...result, cache: c }
  },
  streamingFenceSilenceMs: STREAMING_FENCE_SILENCE_MS,
  // ④ 占位降级（M-13 mermaid 行：图表在桌面查看；文案经 i18n，不养文案副本）
  renderMermaid: (source, _theme) => {
    void source
    return renderMermaidPlaceholder(t('mobile.mermaid.placeholder'))
  },

  // [§6.2] 移动 variant：density=mobile（正文 16px/1.62、用户气泡 82%、思考块收起一行、
  // 工具行 13px——u-foundation 交付的 additive 维度，单一 provide 树注入）
  density: 'mobile',
}

provide(ChatViewDepsKey, deps)

// ── 轻量滚动容器（贴底跟随：用户在底部附近才跟随，上翻阅读不拉底）────────

const scrollEl = ref<HTMLDivElement | null>(null)
const contentEl = ref<HTMLDivElement | null>(null)
const nearBottom = ref(true)

/** 贴底判定阈值（px）：距底小于该值视为「用户在底部」，新内容跟随滚动 */
const NEAR_BOTTOM_THRESHOLD_PX = 80

function onScroll(): void {
  const el = scrollEl.value
  if (!el) return
  nearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD_PX
}

/** 贴底跟随（MutationObserver 覆盖流式 delta 的文本增高——不依赖 Vue 响应深度） */
let observer: MutationObserver | null = null

function scrollToBottom(): void {
  const el = scrollEl.value
  if (el) el.scrollTop = el.scrollHeight
}

/** 「回到最新」（§5.1 ≥44px 触控档）：回底 + 恢复贴底跟随（单谓词复位，无时序窗）。 */
function onBackToLatest(): void {
  nearBottom.value = true
  scrollToBottom()
}

onMounted(() => {
  nextTick(scrollToBottom)
  if (contentEl.value && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      if (nearBottom.value) scrollToBottom()
    })
    observer.observe(contentEl.value, { subtree: true, childList: true, characterData: true })
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

// 切 session 重置贴底（新会话从底部开始读）
watch(
  () => props.sessionId,
  () => {
    nearBottom.value = true
    nextTick(scrollToBottom)
  },
)

const messages = computed<Message[]>(() => chatStore.getMessages(props.sessionId))
const isSessionActive = computed(() => chatStore.isActive(props.sessionId))

// ── 加载更早（A2：core loadMoreHistory 游标翻页消费 + TruncatedHistoryBar 接线）────
// 显隐与「已加载最近 N 轮」的唯一来源 = store 截断窗口状态（per-session 分区），
// 无独立布尔表（对齐 core hasMoreHistory 的 SSOT 派生口径）。

const loadingMore = ref(false)
const historyWindow = computed(() => chatStore.getHistoryWindow(props.sessionId))
const showLoadMore = computed(() => historyWindow.value?.truncated ?? false)
const loadedTurns = computed(() => historyWindow.value?.loadedTurns ?? 0)

/**
 * 「加载更早」：core loadMoreHistory 游标翻页（游标 = 分区最旧消息文件侧身份，
 * 页响应前插更早轮次 + 窗口状态收敛；false = 失败，分区与窗口均不变，条保留可重试）。
 *
 * 前插保位（验收「滚动位置不跳」）：prepend 在分区头部增高 scrollHeight，不补偿会把
 * 视口内容下推。非贴底阅读态 scrollTop += 高度增量；贴底态不补偿——既有贴底跟随
 * 已把视口钉在底部，前插后「贴底」与「补偿后」收敛到同一 scrollTop，两路写入以
 * nearBottom 单谓词互斥，无时序窗。
 */
async function handleLoadMore(): Promise<void> {
  if (loadingMore.value || !showLoadMore.value) return
  loadingMore.value = true
  try {
    const el = scrollEl.value
    const prevScrollHeight = el?.scrollHeight ?? 0
    const ok = await useChatInstance.loadMoreHistory(props.sessionId)
    if (ok && el && !nearBottom.value) {
      // 前插渲染落 DOM 后再读增量（真实浏览器下 nextTick 后 scrollHeight 才反映新内容）
      await nextTick()
      el.scrollTop += el.scrollHeight - prevScrollHeight
    }
  } finally {
    loadingMore.value = false
  }
}
</script>

<template>
  <div class="relative min-h-0 flex-1">
    <div
      ref="scrollEl"
      class="h-full overflow-y-auto"
      data-testid="mobile-message-stream"
      @scroll.passive="onScroll"
    >
      <div ref="contentEl" class="flex flex-col gap-2 p-2">
        <!-- [A2] 历史截断顶部条：显隐 = store 截断窗口状态 truncated（窗口记录缺失按无截断）；
             分区为空时无翻页游标不渲染（对齐桌面 renderItems.length 条件）。
             N = loadedTurns，文案由 ui 组件经壳 i18n（ui locale 单源）；「加载更早」走
             handleLoadMore（core loadMoreHistory 游标翻页 + 前插保位补偿）。 -->
        <TruncatedHistoryBar
          v-if="showLoadMore && messages.length > 0"
          :loaded-turns="loadedTurns"
          :loading="loadingMore"
          @load="handleLoadMore"
        />
        <ChatView :messages="messages" :session-id="sessionId" :is-session-active="isSessionActive" />
      </div>
    </div>
    <!-- [§5.1] 回到最新浮钮：上滑阅读（!nearBottom）时浮出，≥44px 触控目标（--m-tap 档）；
         点击回底 + 恢复贴底跟随。流式跟流期间贴底态结构性不渲染（不抢滚动） -->
    <div
      v-if="!nearBottom"
      role="button"
      tabindex="0"
      class="absolute bottom-3 right-3 flex size-11 cursor-pointer items-center justify-center rounded-full border border-[var(--border)] bg-bg text-neutral-mid shadow-md outline-none active:bg-bg-input focus-visible:ring-2 focus-visible:ring-accent"
      data-testid="mobile-back-to-latest"
      :aria-label="t('mobile.messageStream.backToLatest')"
      @click="onBackToLatest"
      @keydown.enter="onBackToLatest"
    >
      <ArrowDown class="size-5" aria-hidden="true" />
    </div>
  </div>
</template>
