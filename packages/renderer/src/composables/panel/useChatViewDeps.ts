/**
 * useChatViewDeps —— 壳层 ChatViewDeps 装配器（w6 chat-ui-and-shell T6）。
 *
 * 职责：把 renderer 侧 store/composable/纯函数绑定到 ChatViewDeps inject token 的 ~20 个字段，
 * 供 ui 包 chat 展示组件（Turn/Block/MarkdownRenderer/TurnSummary/UserBubble/...）经
 * useChatViewDeps() inject 消费。ui 展示层不直接 import renderer store（反向依赖禁令），
 * 所有跨层数据/回调经此装配器单点注入。
 *
 * 设计依据：design-review TD3（inject token 装决，避免 Turn→Block→MarkdownRenderer 三层
 * prop-drilling）+ R4（TS interface 编译期保证字段完整 + useChatViewDeps() 抛错兜底）。
 *
 * 对应 plan T6 step 2 的「useChatNew 壳层 ChatViewDeps 装配器」角色（此处用具名 useChatViewDeps，
 * 与 ui 侧 useChatViewDeps() inject helper 语义对称、自文档化）。
 *
 * 字段绑定来源：
 * - chatStore（getMessages/isActive/isHandingOff/getChangeSetStatus）→ useChatStore
 * - useChat（abortBash/editAndResend）→ createUseChat 薄包装
 * - useTurnExpansion（isExpanded/toggle/collapse）→ turn-expansion store per-session 分区
 * - useSidebar（forkSession/handoff）+ triggerEnterForkMode/triggerEnterHandoffMode → fork/handoff 4 回调
 * - useSideDrawer（open）→ openDrawer
 * - useFileTreeStore（selectFile）→ onFileClick
 * - useFileSearch（load）+ collectFilePaths/collectBasenames → loadFileCandidates + renderMarkdown env
 * - renderMarkdownSegments（markdown.ts，含 shiki 高亮 + 路径链接化）→ renderMarkdown
 * - renderMermaid（mermaid.ts）→ renderMermaid
 * - assistantToMarkdown（messageFormat.ts）→ toMarkdown
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FileNode, Message, Segment } from '@taiji/shared'
import type { ChatViewDeps } from '@taiji/ui'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useChat } from '@/composables/features/chat/useChat'
import { useTurnExpansion } from '@/composables/panel/useTurnExpansion'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { useSideDrawer, type SideDrawerTab } from '@/composables/features/drawer/useSideDrawer'
import { useFileTreeStore } from '@/stores/fileTree'
import { useFileSearch } from '@/composables/features/search/useFileSearch'
import { triggerEnterForkMode } from '@/composables/panel/useForkModeChannel'
import { triggerEnterHandoffMode } from '@/composables/panel/useHandoffModeChannel'
import { renderMarkdownSegments } from '@/composables/logic/markdown'
import {
  createIncrementalRenderCache,
  renderIncremental,
  shouldFinalizeStreamingFence,
  STREAMING_FENCE_SILENCE_MS,
} from '@/composables/logic/markdown-incremental'
import { renderMermaid } from '@/composables/logic/mermaid'
import { assistantToMarkdown } from '@/composables/logic/messageFormat'
import { collectBasenames, collectFilePaths } from '@/lib/file-basename'
import { useToast } from '@/composables/useToast'

/**
 * 装配 ChatViewDeps。
 *
 * @param sessionId 当前 panel 绑定的 session（Ref，驱动 turn-expansion 分区 + 文件白名单刷新）
 * @param override 基准目录覆盖（设计 markdown-html-sanitize-render D4 双通道矩阵）：传入
 *   `resourceBaseDir` 时 env 通道（sanitize hook img 相对 src 重写）改用该值而非 session
 *   cwd——drawer DetailPane 调用点传「打开文件所在目录」computed，使 env 与 MarkdownRenderer
 *   props 通道（④路点击）同值；主 provide（MessageStream/ChatView）与 CommandDocPanel 不传，
 *   env 保持 session cwd。
 */
export function useChatViewDeps(
  sessionId: Ref<string>,
  override?: { resourceBaseDir?: ComputedRef<string | undefined> },
): ChatViewDeps {
  const { t } = useI18n()
  const { error: toastError } = useToast()
  const chat = useChatStore()
  const sessionStore = useSessionStore()
  const { abortBash, editAndResend } = useChat()
  const turnExpansion = useTurnExpansion(sessionId)
  const { forkSession, handoff } = useSidebar()
  const drawer = useSideDrawer()
  const fileTreeStore = useFileTreeStore()
  const { load: loadFileCandidates } = useFileSearch()

  /** 当前 session 的本地文件白名单（filePaths 含 / 路径 + localFiles 裸 basename）。
   *  对齐旧 MarkdownRenderer 的 refreshLocalFiles：sessionId 变化重新 load（无缓存，
   *  缓存治理 U1 1-3 退役——每次现拉 file.search），fire-and-forget RPC 完成后赋值触发重渲染。
   *  renderMarkdown 消费这两个 Set 作 markdown 路径/basename 链接化白名单。 */
  const filePaths = ref<Set<string>>(new Set())
  const localFiles = ref<Set<string>>(new Set())
  async function refreshLocalFiles(sid: string | null): Promise<void> {
    if (!sid) {
      filePaths.value = new Set()
      localFiles.value = new Set()
      return
    }
    try {
      const nodes = await loadFileCandidates(sid)
      filePaths.value = collectFilePaths(nodes)
      localFiles.value = collectBasenames(nodes)
    } catch {
      // 降级：load 失败时白名单为空集，markdown 路径降级纯文本（与无 env 一致，无回归）
      filePaths.value = new Set()
      localFiles.value = new Set()
    }
  }
  watch(sessionId, (sid) => { void refreshLocalFiles(sid) }, { immediate: true })

  /** 按 id 查 session cwd（sessionStore.list 线性查，与 useDetailPane.sessionCwd 同源同层）。
   *  resourceBaseDir env 装配与 deps.sessionCwdOf（ui MarkdownRenderer ④路 props 缺省
   *  fallback，设计 D4 双通道）共用此单一实现，避免双份查询逻辑漂移。 */
  function sessionCwdOf(sid: string): string | undefined {
    if (!sid) return undefined
    return sessionStore.list.find((s) => s.id === sid)?.cwd ?? undefined
  }

  /** 当前 session 的相对资源解析基准目录（resourceBaseDir，设计 markdown-html-sanitize-render
   *  D4）：默认 session cwd；调用点传 override 时直接沿用调用方的 computed（自带响应式，值 =
   *  打开文件所在目录），不再包一层 computed。无 session / 查不到 → undefined（该消息不做
   *  相对资源解析）。cwd 变化经 env 签名触发增量全量重建。 */
  const resourceBaseDir = override?.resourceBaseDir
    ?? computed<string | undefined>(() => sessionCwdOf(sessionId.value))

  return {
    // ── 数据获取器（读 chatStore 派生状态）──
    getMessages: (sid: string): Message[] => chat.getMessages(sid),
    isActive: (sid: string): boolean => chat.isActive(sid),
    isHandingOff: (sid: string): boolean => chat.isHandingOff(sid),
    getChangeSetStatus: (sid: string, messageId: string) => chat.getChangeSetStatus(sid, messageId),
    isExpanded: (turnKey: string): boolean => turnExpansion.isExpanded(turnKey),
    isTakeover: (turnKey: string): boolean => turnExpansion.isTakeover(turnKey),
    // [D3] pendingSend 投影桥接：UserBubble submitEdit 双发锁（「正在提交」最贴近的既有信号
    // ——send/editAndResend 提交前置位、message_start 清；语义窄于 isActive）
    isPendingSend: (sid: string): boolean => chat.isPendingSend(sid),
    // D4 双通道：ui MarkdownRenderer ④路相对链接点击的 props 缺省 fallback（与上方
    // resourceBaseDir env 装配共用 sessionCwdOf 单一实现；override 存在时 env 与 deps
    // 字段取值不同是有意的——override 只覆盖 env 通道，deps 恒按 id 查 session cwd）
    sessionCwdOf,

    // ── 操作回调 ──
    toggleExpand: (turnKey: string): void => turnExpansion.toggle(turnKey),
    collapse: (turnKey: string): void => turnExpansion.collapse(turnKey),
    setTakeover: (turnKey: string, on: boolean): void => turnExpansion.setTakeover(turnKey, on),
    abortBash: (sid: string, _messageId?: string): void => {
      // core abortBash 仅按 session 取消（api-port 单参），不区分消息；ui 接口的 messageId 为兼容占位
      void abortBash(sid)
    },
    editAndResend: (sid: string, messageId: string, segments: Segment[]): void => {
      void editAndResend(sid, messageId, segments)
    },
    /** fork 后台：从指定 assistant 空白 fork，留在原线（includeFrom=true）。失败 toast 反馈。 */
    onFork: (sid: string, msg: Message): void => {
      if (!msg) return
      void forkSession(sid, msg.id, { includeFrom: true, openInStandby: false }).catch((e: unknown) => {
        const error = e instanceof Error ? e.message : String(e)
        toastError(t('panel.message.forkFailed', { error }))
      })
    },
    /** fork 提问：进 composer fork 模式（发 signal，由 Composer 监听完成 fork+发送） */
    onForkAsk: (sid: string, msg: Message): void => {
      if (!msg) return
      triggerEnterForkMode(sid, msg.id)
    },
    /** handoff 后台：runtime 从末条 assistant 提取文档到新 session。失败 toast 反馈。
     *  streaming 中拦截（与 handoff 模式入口同策略）：源 session 忙时 pi 会拒绝 handoff
     *  prompt（"Agent is already processing"），提前拦下换友好提示，不打 RPC。 */
    onHandoff: (sid: string): void => {
      if (chat.isActive(sid)) {
        toastError(t('panel.composer.handoffBusy'))
        return
      }
      void handoff(sid).catch((e: unknown) => {
        const error = e instanceof Error ? e.message : String(e)
        toastError(t('panel.message.handoffFailed', { error }))
      })
    },
    /** handoff 备注：进 composer handoff 模式（发 signal） */
    onHandoffAsk: (sid: string, msg: Message): void => {
      if (!msg) return
      triggerEnterHandoffMode(sid)
    },
    openDrawer: (tab, opts?): void => {
      drawer.open(tab as SideDrawerTab, opts)
    },
    onFileClick: (path: string): void => {
      fileTreeStore.selectFile(path)
    },
    onAmbiguousSelect: (path: string): void => {
      fileTreeStore.selectFile(path)
      drawer.open('detail', { filePath: path })
    },

    // ── 数据加载 ──
    loadFileCandidates: (sid: string): Promise<FileNode[]> => loadFileCandidates(sid),

    // ── 渲染桥接 ──
    /** 渲染 markdown 为 segments（含 shiki 高亮 + 路径/basename 链接化 + img 相对 src 重写，
     *  白名单与 resourceBaseDir 由上方 computed/watch 维护） */
    renderMarkdown: (source: string, sid?: string) => {
      void sid // sid 仅作 sessionId 派生提示，实际白名单/基准目录由 watch(sessionId) 统一刷新（单 session 壳）
      return renderMarkdownSegments(source, {
        filePaths: filePaths.value,
        localFiles: localFiles.value,
        resourceBaseDir: resourceBaseDir.value,
      })
    },
    /** D-5 增量渲染（W22 协议 / W23 消费）：前缀段引用恒等缓存 + tail 段每帧重建 + streaming-fence
     *  占位。cache 为 opaque 句柄（ui 组件 per-instance 持有）：首次 null 由本桥接创建，随返回值
     *  带回；env（filePaths/localFiles/resourceBaseDir）引用/值变化由 renderIncremental 内部
     *  全量重建处理。 */
    renderMarkdownIncremental: async (source, cache, sid, opts) => {
      void sid // 同 renderMarkdown：白名单/基准目录由 watch(sessionId) 统一刷新
      const c = cache ?? createIncrementalRenderCache()
      const result = await renderIncremental(
        source,
        c,
        {
          filePaths: filePaths.value,
          localFiles: localFiles.value,
          resourceBaseDir: resourceBaseDir.value,
        },
        opts,
      )
      return { ...result, cache: c }
    },
    shouldFinalizeStreamingFence,
    streamingFenceSilenceMs: STREAMING_FENCE_SILENCE_MS,
    renderMermaid: (source: string, theme: 'dark' | 'light') => renderMermaid(source, theme),
    toMarkdown: (msg: Message): string => assistantToMarkdown(msg),
  }
}
