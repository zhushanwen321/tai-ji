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
 * - chatStore（isActive/isHandingOff/getChangeSetStatus/isPendingSend）→ useChatStore
 * - useChat（abortBash/editAndResend/revokeMessage）→ createUseChat 薄包装
 * - useTurnExpansion（isExpanded/isTakeover/toggle/collapse/setTakeover）→ turn-expansion store per-session 分区
 * - triggerEnterForkMode/triggerEnterHandoffMode → forkAsk/handoffAsk 回调
 * - useSideDrawer（open）→ openDrawer
 * - useFileTreeStore（selectFile）→ onFileClick
 * - useFileSearch（load）+ collectFilePaths/collectBasenames → loadFileCandidates + renderMarkdown env；
 *   虚拟 id（subagent:/agentcall:/btw:）先经 shared resolveVirtualSessionId 解析到真实 session id
 *   再发起 file.search（runtime 只登记真实 pi session，vid 直传必 session_not_found——fileSearch vid 修复）
 * - renderMarkdownSegments（markdown.ts，含 shiki 高亮 + 路径链接化）→ renderMarkdown
 * - renderMermaid（mermaid.ts）→ renderMermaid
 * - assistantToMarkdown（messageFormat.ts）→ toMarkdown
 */
import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FileNode, Message, Segment } from '@taiji/shared'
import { normalizeContent } from '@taiji/shared'
import type { ChatViewDeps } from '@taiji/ui'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useChat } from '@/composables/features/chat/useChat'
import { useTtsPlayer } from '@/composables/features/chat/useTtsPlayer'
import { useTtsSpeechEnabled } from '@/components/settings/tts/use-tts-enabled'
import { useTurnExpansion } from '@/composables/panel/useTurnExpansion'
import { useSideDrawer, type RightDrawerTab } from '@/composables/features/drawer/useSideDrawer'
import { openBrowser } from '@taiji/core/domain/overlay'
import * as events from '@taiji/core/transport/api'
import { useFileTreeStore } from '@/stores/fileTree'
import { resolveVirtualSessionId } from '@taiji/shared'
import { useFileSearch } from '@/composables/features/search/useFileSearch'
import { useToast } from '@/composables/useToast'
import { triggerEnterForkMode } from '@/composables/panel/useForkModeChannel'
import { triggerEnterHandoffMode } from '@/composables/panel/useHandoffModeChannel'
import { renderMarkdownSegments } from '@/composables/logic/markdown'
import {
  createIncrementalRenderCache,
  renderIncremental,
  STREAMING_FENCE_SILENCE_MS,
} from '@/composables/logic/markdown-incremental'
import { renderMermaid } from '@/composables/logic/mermaid'
import { assistantToMarkdown } from '@/composables/logic/messageFormat'
import { collectBasenames, collectFilePaths } from '@/lib/file-basename'
import { localFileRead, localFileServable } from '@/lib/ipc'

/** Set 内容等价（大小 + 逐成员），白名单去重赋值的判等基础 */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

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
  override?: {
    resourceBaseDir?: ComputedRef<string | undefined>
    /** 虚拟 id 归属真实 session（agentcall 两段式 vid 无 mainSid 命名空间，挂载链显式传入——
     *  MessageStream mainSessionId prop 一跳；subagent:/btw: vid 自带归属，不消费本字段）。
     *  缺失时 agentcall vid 无 cwd 数据源 → 白名单空集 + 不发起必失败的 file.search。 */
    mainSessionId?: ComputedRef<string | undefined>
  },
): ChatViewDeps {
  const { t } = useI18n()
  const { error: toastError } = useToast()
  const chat = useChatStore()
  const sessionStore = useSessionStore()
  const { abortBash, editAndResend, revokeMessage } = useChat()
  const tts = useTtsPlayer()
  const { enabled: ttsSpeechEnabled } = useTtsSpeechEnabled()
  const turnExpansion = useTurnExpansion(sessionId)
  const drawer = useSideDrawer()
  const fileTreeStore = useFileTreeStore()
  const { load: loadFileCandidates } = useFileSearch()

  /** vid → 真实 session id（shared resolveVirtualSessionId，跨层 SSOT）：file.search 与
   *  cwd 查询只认真实 pi session，vid 直传必 session_not_found。ownerSid 是挂载链显式
   *  传入的归属 session（agentcall 专属；读 .value 保持响应式，owner 切换后解析跟随）。 */
  const ownerSid = override?.mainSessionId
  const realSidOf = (sid: string): string | undefined => resolveVirtualSessionId(sid, ownerSid?.value)

  /** 当前 session 的本地文件白名单（filePaths 含 / 路径 + localFiles 裸 basename）。
   *  对齐旧 MarkdownRenderer 的 refreshLocalFiles：sessionId 变化重新 load（无缓存，
   *  缓存治理 U1 1-3 退役——每次现拉 file.search），fire-and-forget RPC 完成后赋值触发重渲染；
   *  另有 agent turn settled 刷新（下方订阅，覆盖 turn 内新建文件）。renderMarkdown 消费
   *  这两个 Set 作 markdown 路径/basename 链接化白名单。 */
  const filePaths = ref<Set<string>>(new Set())
  const localFiles = ref<Set<string>>(new Set())
  async function refreshLocalFiles(sid: string | null): Promise<void> {
    if (!sid) {
      filePaths.value = new Set()
      localFiles.value = new Set()
      return
    }
    const realSid = realSidOf(sid)
    if (!realSid) {
      // 虚拟 id 无归属 session（agentcall 挂载链未传 mainSessionId 等未知形态）→ 无 cwd
      // 数据源，白名单空集（该视图 markdown 路径降级纯文本）。不发必失败的 file.search
      // （修复前每次挂载打一发 session_not_found 的 fileSearch warn——fileSearch vid 修复）。
      filePaths.value = new Set()
      localFiles.value = new Set()
      return
    }
    try {
      const nodes = await loadFileCandidates(realSid)
      // 代际守卫（ADR-0049 updateFor(capturedSid) 同源思路）：await 期间 sessionId 可能已切到
      // 新 session——迟到的 file.search 结果属旧 session，写入会跨 session 串台（新 session 的
      // markdown 路径按旧文件集判定链接化）。不等则整体丢弃，由新 session 自己的加载负责落位。
      if (sid !== sessionId.value) return
      const nextPaths = collectFilePaths(nodes)
      const nextBasenames = collectBasenames(nodes)
      // 内容等价 → 不赋值：保持 Set 引用稳定（env 签名不变 → 增量渲染缓存不失效、已完成
      // 消息不重渲染）。turn-settle 每 turn 触发一次刷新，绝大多数 turn 文件集未变。
      if (setsEqual(filePaths.value, nextPaths) && setsEqual(localFiles.value, nextBasenames)) return
      filePaths.value = nextPaths
      localFiles.value = nextBasenames
    } catch (e) {
      // 降级：load 失败时白名单为空集，markdown 路径降级纯文本（与无 env 一致，无回归）。
      // 同样受代际守卫约束：旧 session 的失败结果不得清空新 session 已加载的白名单。
      if (sid !== sessionId.value) return
      // [RD-1#8] 降级本身正确，但须留痕：否则「路径链接化能力消失」零日志零标记，
      // 排障时无法区分「session 无文件」与「file.search 失败」。
      console.warn(`[useChatViewDeps] file whitelist load failed for session ${sid}; markdown 路径链接化降级为纯文本:`, e)
      filePaths.value = new Set()
      localFiles.value = new Set()
    }
  }
  watch(sessionId, (sid) => { void refreshLocalFiles(sid) }, { immediate: true })

  /** agent turn settled → 白名单刷新（complete / error 收口帧均触发；abort 经 complete{stopReason:'aborted'}）。
   *  动机（2026-10-03 display-containers 交付复盘缺陷）：白名单快照在会话视图挂载时拉取（上方
   *  watch 只随 sessionId 变化重拉），turn 内 agent 新建/删除的文件不进白名单 → 该 turn 回复里
   *  反引号引用的新落盘文件路径不链接化（纯文本死链）。turn 收口帧是天然刷新锚点：此时本 turn
   *  的全部写盘已完成。内容等价守卫保证无文件变化的 turn 零赋值零重渲染，常态成本 = 一次
   *  file.search RPC。
   *  订阅生命周期：裸 events.on（useSessionEvents 有 getCurrentInstance 守卫，本装配器存在
   *  effectScope 直调形态不满足）+ watch(sessionId) 重订 + onScopeDispose 退订；切 sid 边界的
   *  迟到帧由 refreshLocalFiles 内代际守卫兜底。 */
  let unsubTurnSettle: (() => void) | null = null
  watch(sessionId, (sid) => {
    unsubTurnSettle?.()
    unsubTurnSettle = null
    if (!sid) return
    unsubTurnSettle = events.on(sid, (msg) => {
      if (msg.type === 'message.complete' || msg.type === 'message.error') {
        void refreshLocalFiles(sid)
      }
    })
  }, { immediate: true })
  onScopeDispose(() => {
    unsubTurnSettle?.()
    unsubTurnSettle = null
  })

  /** 按 id 查 session cwd（sessionStore.list 线性查，与 useDetailPane.sessionCwd 同源同层）。
   *  虚拟 id 先解析到归属真实 session 再查（sessionCwdOf 的 deps 消费方传的是 vid——
   *  MarkdownRenderer ④路点击解析拿 cwd）。resourceBaseDir env 装配与 deps.sessionCwdOf
   *  （ui MarkdownRenderer ④路 props 缺省 fallback，设计 D4 双通道）共用此单一实现，
   *  避免双份查询逻辑漂移。 */
  function sessionCwdOf(sid: string): string | undefined {
    if (!sid) return undefined
    const real = realSidOf(sid)
    if (!real) return undefined
    return sessionStore.list.find((s) => s.id === real)?.cwd ?? undefined
  }

  /** 当前 session 的相对资源解析基准目录（resourceBaseDir，设计 markdown-html-sanitize-render
   *  D4）：默认 session cwd；调用点传 override 时直接沿用调用方的 computed（自带响应式，值 =
   *  打开文件所在目录），不再包一层 computed。无 session / 查不到 → undefined（该消息不做
   *  相对资源解析）。cwd 变化经 env 签名触发增量全量重建。 */
  const resourceBaseDir = override?.resourceBaseDir
    ?? computed<string | undefined>(() => sessionCwdOf(sessionId.value))

  return {
    // ── 数据获取器（读 chatStore 派生状态）──
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
    /** 产物 servable 预检（chat-html-support §6.3 D3「跨层依赖注入」/ §6.9 D9）：HtmlPreviewInline
     *  挂载前经此调主进程 localFile:servable 判定（白名单 ∪ 存在 ∪ 非目录，与协议 handler
     *  同谓词）。electronAPI 消费收敛在 lib/ipc（唯一适配点）；无 IPC（web/mock）时 reject，
     *  容器按「预检不可用」跳过预检直接挂载（不阻塞预览入口，真实服务判定在协议 handler）。 */
    probeArtifact: (absPath: string) => localFileServable(absPath),
    /** 产物源码读取（chat-html-support v16 §6.3「源码态」/ §6.9 D9 localFile:read 通道）：
     *  HtmlPreviewInline 切「源码」后经此读产物文件全文（产物目录在 session cwd 外，runtime
     *  file.read 的 cwd 守门不可达）。lib/ipc 的结构化失败原因（not_found / is_dir /
     *  out_of_whitelist / read_failed）以 err.reason 结构化属性附于 reject 的 Error（message
     *  保留供 console 诊断）——容器按原因显具体文案（复用 panel.detail.htmlReason* 词条，
     *  not_found「产物已被保留期回收」等真实原因用户侧可见）；无 IPC（web/mock）同样 reject
     *  （无 reason 属性 → 容器 fallback 固定占位文案）。 */
    readArtifact: async (absPath: string) => {
      const result = await localFileRead(absPath)
      if (!result.ok) {
        throw Object.assign(new Error(`localFileRead failed: ${result.reason}`), { reason: result.reason })
      }
      return { content: result.content }
    },

    // ── 操作回调 ──
    toggleExpand: (turnKey: string): void => turnExpansion.toggle(turnKey),
    collapse: (turnKey: string): void => turnExpansion.collapse(turnKey),
    setTakeover: (turnKey: string, on: boolean): void => turnExpansion.setTakeover(turnKey, on),
    abortBash: (sid: string): void => {
      // core abortBash 仅按 session 取消（api-port 单参），不区分消息
      void abortBash(sid)
    },
    editAndResend: (sid: string, messageId: string, segments: Segment[]): void => {
      void editAndResend(sid, messageId, segments)
    },
    // [U5 消息撤回 D6] 撤回统一单入口：UserBubble 透传 targetId，在途 cancel / 已送达
    // 树内回退的路由判定只在 core useChat.revokeMessage 单点（内核投影复核分派）。
    onRevokeMessage: (sid: string, targetId: string): void => {
      void revokeMessage(sid, targetId)
    },
    /** fork 提问：进 composer fork 模式（发 signal，由 Composer 监听完成 fork+发送） */
    onForkAsk: (sid: string, msg: Message): void => {
      if (!msg) return
      triggerEnterForkMode(sid, msg.id)
    },
    /** handoff 备注：进 composer handoff 模式（发 signal） */
    onHandoffAsk: (sid: string, msg: Message): void => {
      if (!msg) return
      triggerEnterHandoffMode(sid)
    },
    /** 朗读（ai-voice-tts §5.1）：点击动作分流收敛在装配侧——idle = 朗读（清洗由
     *  useTtsPlayer 内部承担，文本源 = 消息正文 normalizeContent）；loading/playing =
     *  取消/停止（stop 与「点击停止」同源复用，§5.1 状态机非 idle 态点击语义）。
     *  ui 包不 import renderer（反向依赖禁令），状态机数据面经 speakStateOf 投影。
     *  朗读总开关（§5.2 通用配置）只在 idle 分支拦截：关闭时 toast「语音服务未配置」
     *  不发 RPC；非 idle 态点击 = 停止，不受开关约束（关掉开关也应能停掉在播的声音）。 */
    onSpeak: (sid: string, msg: Message): void => {
      if (!msg) return
      if (tts.speakStateOf(msg.id) === 'idle') {
        if (!ttsSpeechEnabled.value) {
          toastError(t('panel.message.speakNotConfigured'))
          return
        }
        tts.speak(sid, msg.id, normalizeContent(msg.content))
      } else {
        tts.stop()
      }
    },
    /** 朗读态查询：useTtsPlayer 全局单例（D11）按 messageId 投影，三态直通 */
    speakStateOf: (messageId: string) => tts.speakStateOf(messageId),
    openDrawer: (tab, opts?): void => {
      drawer.open(tab as RightDrawerTab, opts)
    },
    // [display-containers §7.4 URL 注入链] localhost 链接 → 浮层浏览器（core openBrowser：
    // 单例换内容 + BrowserPane 挂浮层壳）；发起会话 = 调用方（MarkdownRenderer）透传的 sessionId
    openBrowser: (url: string, sessionId: string): void => {
      openBrowser(url, sessionId)
    },
    onFileClick: (path: string): void => {
      // per-session：选中态落位 + 同步注入 detail tab（W3 注入语义；目标会话 = 本 deps 绑定会话）
      fileTreeStore.selectFile(sessionId.value, path)
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
    streamingFenceSilenceMs: STREAMING_FENCE_SILENCE_MS,
    renderMermaid: (source: string, theme: 'dark' | 'light') => renderMermaid(source, theme),
    toMarkdown: (msg: Message): string => assistantToMarkdown(msg),
  }
}
