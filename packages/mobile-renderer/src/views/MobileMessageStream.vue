<script setup lang="ts">
// MobileMessageStream —— 移动壳消息流容器（remote-use D10「ChatViewDeps provide 义务」转移落点：
// 桌面由 MessageStream.vue provide，该组件不复用 → 义务转移到本组件）。
//
// 构成：ui ChatView 展示子树（复用）+ 轻量滚动容器（overflow-y + 贴底跟随）
// + TruncatedHistoryBar 加载更早（A2：core loadMoreHistory 游标翻页消费，见 handleLoadMore）。
// 不含 virtua/@wheel/TurnRail/fork-notice——桌面壳层编排语义不进移动壳（D10 被否①）。
//
// ChatViewDeps 四类分派（D10 全表逐字段）：
// ① 真实现（core store/useChat + ui 渲染链下沉模块）：isActive/isHandingOff/
//    getChangeSetStatus/isPendingSend/isExpanded/toggleExpand/collapse/abortBash/
//    onRevokeMessage + renderMarkdown（renderMarkdownSegments + copyLabel 经 i18n 注入）/
//    renderMarkdownIncremental/streamingFenceSilenceMs（finalize 判定已并入 ui 组件内派生：
//    message complete ∨ token 静默 ≥ 阈值，谓词注入字段已随审计候选 18 收单删除）
// ② 惰性（D10 移动壳无接管态——turn 展开分区只留展开集合，接管读写恒 false/no-op，
//    与 ui 组件侧原兜底行为等价）：isTakeover/setTakeover
// ③ no-op（hover 入口触屏不可见，D7）：onForkAsk/onHandoffAsk/editAndResend/toMarkdown
// ④ no-op + D7 登记（面板族 Phase 2）：openDrawer/onFileClick +
//    loadFileCandidates（空数组——路径链接化降级普通文本，env 白名单同步空集）
// ⑤ 占位降级：renderMermaid 返回占位 svg（MarkdownRenderer 期望 {svg} 结构，纯 no-op 破图；
//    mermaid 库不进移动壳 bundle，D7 图表行）
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
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
import QueueStrip from './QueueStrip.vue'

const props = defineProps<{ sessionId: string }>()

const { t } = useI18n()

// ── ① 真实现（store 派生 + turn 展开分区 + 渲染链）────────────────────

const expansion = createTurnExpansion(computed(() => props.sessionId))

/** markdown 路径链接化 env：loadFileCandidates 空数组（D7 面板族降级）→ 白名单空集，
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
  // pendingSend 投影（core chat store 派生，UserBubble submitEdit 双发锁消费）
  isPendingSend: (sid) => chatStore.isPendingSend(sid),

  // 操作回调
  toggleExpand: (turnKey) => expansion.toggle(turnKey),
  collapse: (turnKey) => expansion.collapse(turnKey),
  // 惰性接管写入（同 isTakeover：移动壳无接管态，no-op）
  setTakeover: () => {},
  abortBash: (sid) => {
    void useChatInstance.abortBash(sid)
  },
  // 撤回统一单入口（core useChat.revokeMessage：在途 cancel / 已送达树内回退的路由判定
  // 在 core 单点，壳透传 targetId）
  onRevokeMessage: (sid, targetId) => {
    void useChatInstance.revokeMessage(sid, targetId)
  },
  // hover 全族 no-op（D7：触屏不可见；恢复路径 = 桌面操作）
  editAndResend: () => {},
  onForkAsk: () => {},
  onHandoffAsk: () => {},
  openDrawer: () => {},
  onFileClick: () => {},

  // 数据加载（D7 面板族 Phase 2：空候选 → 路径链接化降级普通文本）
  loadFileCandidates: () => [],

  // 渲染桥接（渲染链下沉 ui 单源；copyLabel 注入——ui 渲染模块不依赖壳 i18n 单例）
  renderMarkdown: (source) => renderMarkdownSegments(source, { ...EMPTY_ENV, copyLabel: t('composable.copyLabel') }),
  renderMarkdownIncremental: async (source, cache, _sid, opts) => {
    const c = cache ?? createIncrementalRenderCache()
    const result = await renderIncremental(source, c, { ...EMPTY_ENV, copyLabel: t('composable.copyLabel') }, opts)
    return { ...result, cache: c }
  },
  streamingFenceSilenceMs: STREAMING_FENCE_SILENCE_MS,
  // ④ 占位降级（D7 mermaid 行：图表在桌面查看；文案经 i18n，不养文案副本）
  renderMermaid: (source, _theme) => {
    void source
    return renderMermaidPlaceholder(t('mobile.mermaid.placeholder'))
  },
  // copy-as-MD 无消费者（D7 hover 全族），不可达
  toMarkdown: () => '',
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
  <div
    ref="scrollEl"
    class="min-h-0 flex-1 overflow-y-auto"
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
      <!-- [D7/U10] 流尾队列条：busy 期被 morph 移出对话流的排队消息可见可取消（与对话流
           同视野——D7 不采用②「抽屉/独立页签」）；数据源/取消/回填编排内聚组件内，此处纯挂载，
           空队列结构性不渲染 -->
      <QueueStrip :session-id="sessionId" />
    </div>
  </div>
</template>
