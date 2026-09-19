/**
 * ChatViewDeps —— ui 包 chat 组件消费壳层依赖的唯一契约（w6 chat-ui-and-shell）。
 *
 * ui 包展示组件不直接 import renderer store/composable（反向依赖禁令），
 * 所有跨层依赖（store 数据 / RPC 回调 / DOM 副作用编排 / 重库渲染）经此 inject token 注入。
 * renderer 壳层（MessageStream.vue）provide 真 renderer 实现。
 *
 * 设计依据：clarify Q3 inject token 裁决（避免 Turn→Block→MarkdownRenderer 三层 prop-drilling）。
 *
 * 字段分四类：
 * - 数据获取器（读 store 派生状态）
 * - 操作回调（触发 RPC / store action，含 turn 展开/fork/handoff/编辑/中止）
 * - 数据加载（纯函数经壳桥接，文件候选加载）
 * - 渲染桥接（重库渲染经壳注入：markdown/mermaid/MD 转换，ui 不带 shiki/mermaid 依赖）
 */
import type { InjectionKey } from 'vue'
import { inject } from 'vue'
import type { FileNode, Message, Segment, ChangeSetStatus } from '@taiji/shared'
import type { IncrementalMarkdownCache, IncrementalMarkdownResult, MarkdownSegment } from './markdown-types'

/** drawer 打开参数（按 tab 携带不同上下文） */
export interface DrawerOpenOptions {
  /** detail tab：指定文件路径（ChangeSetCard 点击文件行） */
  filePath?: string
  /** doc tab：指定命令名（UserBubble 点击 skill chip） */
  commandName?: string
}

/**
 * ChatView 依赖端口（shell → ui 展示层注入）。
 */
export interface ChatViewDeps {
  // ── 数据获取器（读 chat/session store 派生状态）──
  /** 取当前 session 的消息列表（经 useChatStore 分区派生） */
  getMessages: (sessionId: string) => Message[]
  /** session 是否活跃（有 pi 子进程，决定 user 气泡可编辑态） */
  isActive: (sessionId: string) => boolean
  /** session 是否正在 handoff 中（TurnSummary handoff 按钮防重复点击） */
  isHandingOff: (sessionId: string) => boolean
  /** 取 session 内某消息的 changeset 状态（Turn.vue ChangeSetCard 状态渲染，messageId 锁定具体消息） */
  getChangeSetStatus: (sessionId: string, messageId: string) => ChangeSetStatus | undefined
  /** turn 是否展开（useTurnExpansion store 派生，Turn/TurnMeta 消费。key=turnStableId(turn)
   *  首条消息 id，M5 stable-key——不随消息插删漂移） */
  isExpanded: (turnKey: string) => boolean
  /** turn 是否处于「展开全部」接管态（useTurnExpansion store 派生，Turn 消费。
   *  key=turnStableId(turn)，D6/TC2 窗口级语义：takeover=true 时 computeTraceWindow 全量展开。
   *  optional：takeover 是窗口增强能力，仅 Turn 单消费者；未 provide 时 Turn 兜底 false（折叠态）。
   *  renderer useChatViewDeps 运行时总 provide 真实实现，测试 mock 可省略） */
  isTakeover?: (turnKey: string) => boolean
  /** session 是否有「正在提交直发」的 pendingSend 瞬时态（chat store 投影，UserBubble
   *  submitEdit 双发锁消费——D3：防 send 与 editAndResend 并发覆盖 pendingDirectSends）。
   *  optional，同 isTakeover：未 provide 时 submitEdit 不做互斥（旧壳层兼容），renderer
   *  useChatViewDeps 运行时总 provide 真实实现，测试 mock 可省略 */
  isPendingSend?: (sessionId: string) => boolean
  /** 取 session 的相对资源解析基准目录（session cwd，与工厂内 resourceBaseDir env 装配
   *  同源同层查询）。MarkdownRenderer ④路相对链接点击的 props 缺省 fallback——设计
   *  markdown-html-sanitize-render D4 双通道矩阵：props 覆盖优先（drawer 文件目录语义），
   *  props 缺省（对话流/命令文档零模板传 props 的消费面）经此拿 session cwd。
   *  optional，同 isTakeover：未 provide（测试 mock 壳）时 MarkdownRenderer 可选链容错
   *  （fallback undefined → ④路 preventDefault 无动作），renderer useChatViewDeps 运行时
   *  总 provide 真实实现 */
  sessionCwdOf?: (sessionId: string) => string | undefined

  // ── 操作回调（触发 RPC / store action）──
  /** 切换 turn 展开/折叠（useTurnExpansion store action。key=turnStableId(turn)） */
  toggleExpand: (turnKey: string) => void
  /** 折叠 turn（useTurnExpansion collapse，Turn.vue 完成自动收起用。key=turnStableId(turn)） */
  collapse: (turnKey: string) => void
  /** 设/清「展开全部」接管态（useTurnExpansion setTakeover。key=turnStableId(turn)。
   *  optional，同 isTakeover：仅 Turn 消费，未 provide 时 onToggleTakeover no-op） */
  setTakeover?: (turnKey: string, on: boolean) => void
  /** 中止 bash 执行（useChat.abortBash 经壳桥接） */
  abortBash: (sessionId: string, messageId?: string) => void
  /** 编辑并重发 user message（useChat.editAndResend，segments 是重建后的 Segment[]） */
  editAndResend: (sessionId: string, messageId: string, segments: Segment[]) => void
  /** fork turn（后台，useTurnActions.fork） */
  onFork: (sessionId: string, message: Message) => void
  /** fork 并提问（useTurnActions.forkAsk） */
  onForkAsk: (sessionId: string, message: Message) => void
  /** handoff turn（交接并新开，useTurnActions.handoff） */
  onHandoff: (sessionId: string) => void
  /** handoff 并备注（useTurnActions.handoffAsk） */
  onHandoffAsk: (sessionId: string, message: Message) => void
  /** 打开 drawer tab（useSideDrawer.open 经壳桥接，opts 携带 filePath/commandName） */
  openDrawer: (tab: string, opts?: DrawerOpenOptions) => void
  /** 点击文件路径（useFileTree.selectFile 经壳桥接） */
  onFileClick: (path: string) => void
  /** 歧义文件选择（AmbiguousFilePopover select 经壳桥接） */
  onAmbiguousSelect: (path: string) => void

  // ── 数据加载（纯函数经壳桥接）──
  /** 加载文件候选（MarkdownRenderer 路径识别白名单 + 歧义解析，useFileSearch 经壳桥接） */
  loadFileCandidates: (sessionId: string, basename?: string) => FileNode[] | Promise<FileNode[]>

  // ── 渲染桥接（重库渲染经壳注入，ui 不带 shiki/mermaid 依赖）──
  /** 渲染 markdown 为 segments（renderer 壳 renderMarkdownSegments，含 shiki 高亮 + 路径链接化；
   *  env 携带相对资源基准目录 resourceBaseDir——对话流 = session cwd，设计 markdown-html-sanitize-render D4） */
  renderMarkdown: (source: string, sessionId?: string) => MarkdownSegment[] | Promise<MarkdownSegment[]>
  /**
   * D-5 增量渲染（W22 协议 / W23 消费，renderer 壳 renderIncremental）：前缀段引用恒等缓存 +
   * tail 段每帧重建。cache 是 opaque 句柄——首次传 null 由壳创建（随返回值带回，组件持有后透传），
   * 壳内原地更新；env（filePaths/localFiles 引用恒等 + resourceBaseDir 值恒等，设计 D4 相对资源
   * 基准目录）变化由壳内全量重建处理。
   * optional：未 provide（mock 壳/降级）时 MarkdownRenderer 回退 renderMarkdown 全量渲染（等价旧版）。
   */
  renderMarkdownIncremental?: (
    source: string,
    cache: IncrementalMarkdownCache | null,
    sessionId?: string,
    opts?: { finalizeOpenFence?: boolean },
  ) => Promise<IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }>
  /**
   * streaming-fence 占位转完整渲染判定（renderer 壳 shouldFinalizeStreamingFence）：
   * message complete 或 token 静默 ≥ 阈值。未 provide 时组件按 complete-only 判定。
   */
  shouldFinalizeStreamingFence?: (state: { complete: boolean; silenceMs: number }) => boolean
  /** streaming-fence 静默阈值 ms（renderer 壳 STREAMING_FENCE_SILENCE_MS，SSOT 在 renderer）；
   *  组件据此安排 finalize 定时器。未提供则静默路径不激活（仅 complete 触发）。 */
  streamingFenceSilenceMs?: number
  /** 渲染 mermaid 为 SVG（renderer 壳 renderMermaid，依赖 mermaid 库） */
  renderMermaid: (source: string, theme: 'dark' | 'light') => Promise<{ svg: string }>
  /** 把 assistant 消息转为 markdown（copy-as-MD 功能，依赖 i18n 文案） */
  toMarkdown: (message: Message) => string
}

/** ChatViewDeps inject token（InjectionKey 保类型安全） */
export const ChatViewDepsKey: InjectionKey<ChatViewDeps> = Symbol('ChatViewDeps')

/**
 * inject ChatViewDeps helper。token 缺失时抛错（防运行时 undefined 调用崩溃）。
 * ui 组件 setup 顶部调 const deps = useChatViewDeps()。
 */
export function useChatViewDeps(): ChatViewDeps {
  const deps = inject(ChatViewDepsKey)
  if (!deps) {
    throw new Error(
      '[ChatViewDeps] inject 缺失：组件必须在 <ChatView>（或 provide ChatViewDepsKey 的容器）内渲染。' +
        'renderer 壳层 MessageStream.vue 应 provide(ChatViewDepsKey, realDeps)。',
    )
  }
  return deps
}
