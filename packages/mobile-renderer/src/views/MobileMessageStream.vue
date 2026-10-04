<script setup lang="ts">
// MobileMessageStream —— 移动壳消息流容器（remote-use D10「ChatViewDeps provide 义务」转移落点：
// 桌面由 MessageStream.vue provide，该组件不复用 → 义务转移到本组件）。
//
// 构成：ui ChatView 展示子树（复用）+ 轻量滚动容器（overflow-y + 贴底跟随）。
// 不含 virtua/@wheel/TurnRail/fork-notice——桌面壳层编排语义不进移动壳（D10 被否①）。
//
// ChatViewDeps 四类分派（D10 全表逐字段）：
// ① 真实现（core store/useChat + ui 渲染链下沉模块）：getMessages/isActive/isHandingOff/
//    getChangeSetStatus/isExpanded/toggleExpand/collapse/abortBash + renderMarkdown
//    （renderMarkdownSegments + copyLabel 经 i18n 注入）/renderMarkdownIncremental/
//    shouldFinalizeStreamingFence/streamingFenceSilenceMs
// ② no-op（hover 入口触屏不可见，D7）：onFork/onForkAsk/onHandoff/onHandoffAsk/editAndResend/toMarkdown
// ③ no-op + D7 登记（面板族 Phase 2）：openDrawer/onFileClick/onAmbiguousSelect +
//    loadFileCandidates（空数组——路径链接化降级普通文本，env 白名单同步空集）
// ④ 占位降级：renderMermaid 返回占位 svg（MarkdownRenderer 期望 {svg} 结构，纯 no-op 破图；
//    mermaid 库不进移动壳 bundle，D7 图表行）
// optional 三字段（isTakeover/isPendingSend/setTakeover）不 provide（D10：组件侧既有兜底
// ——Turn takeover 兜底 false 折叠态、submitEdit 不做双发互斥）。
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChatView, ChatViewDepsKey } from '@taiji/ui'
import type { ChatViewDeps } from '@taiji/ui'
import { renderMarkdownSegments } from '@taiji/ui/features/chat/markdown'
import {
  createIncrementalRenderCache,
  renderIncremental,
  shouldFinalizeStreamingFence,
  STREAMING_FENCE_SILENCE_MS,
} from '@taiji/ui/features/chat/markdown-incremental'
import type { Message } from '@taiji/shared'
import { chatStore, createTurnExpansion, useChatInstance } from '../shell/app-runtime'
import { renderMermaidPlaceholder } from '../shell/mermaid-placeholder'

const props = defineProps<{ sessionId: string }>()

const { t } = useI18n()

// ── ① 真实现（store 派生 + turn 展开分区 + 渲染链）────────────────────

const expansion = createTurnExpansion(computed(() => props.sessionId))

/** markdown 路径链接化 env：loadFileCandidates 空数组（D7 面板族降级）→ 白名单空集，
 *  路径渲染为普通文本（与桌面 load 失败降级形态一致） */
const EMPTY_ENV = { filePaths: new Set<string>(), localFiles: new Set<string>() }

const deps: ChatViewDeps = {
  // 数据获取器（core chat store 派生）
  getMessages: (sid) => chatStore.getMessages(sid),
  isActive: (sid) => chatStore.isActive(sid),
  isHandingOff: (sid) => chatStore.isHandingOff(sid),
  getChangeSetStatus: (sid, messageId) => chatStore.getChangeSetStatus(sid, messageId),
  isExpanded: (turnKey) => expansion.isExpanded(turnKey),

  // 操作回调
  toggleExpand: (turnKey) => expansion.toggle(turnKey),
  collapse: (turnKey) => expansion.collapse(turnKey),
  abortBash: (sid) => {
    void useChatInstance.abortBash(sid)
  },
  // hover 全族 no-op（D7：触屏不可见；恢复路径 = 桌面操作）
  editAndResend: () => {},
  onFork: () => {},
  onForkAsk: () => {},
  onHandoff: () => {},
  onHandoffAsk: () => {},
  openDrawer: () => {},
  onFileClick: () => {},
  onAmbiguousSelect: () => {},

  // 数据加载（D7 面板族 Phase 2：空候选 → 路径链接化降级普通文本）
  loadFileCandidates: () => [],

  // 渲染桥接（渲染链下沉 ui 单源；copyLabel 注入——ui 渲染模块不依赖壳 i18n 单例）
  renderMarkdown: (source) => renderMarkdownSegments(source, { ...EMPTY_ENV, copyLabel: t('composable.copyLabel') }),
  renderMarkdownIncremental: async (source, cache, _sid, opts) => {
    const c = cache ?? createIncrementalRenderCache()
    const result = await renderIncremental(source, c, { ...EMPTY_ENV, copyLabel: t('composable.copyLabel') }, opts)
    return { ...result, cache: c }
  },
  shouldFinalizeStreamingFence,
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
</script>

<template>
  <div
    ref="scrollEl"
    class="min-h-0 flex-1 overflow-y-auto"
    data-testid="mobile-message-stream"
    @scroll.passive="onScroll"
  >
    <div ref="contentEl" class="flex flex-col gap-2 p-2">
      <ChatView :messages="messages" :session-id="sessionId" :is-session-active="isSessionActive" />
    </div>
  </div>
</template>
