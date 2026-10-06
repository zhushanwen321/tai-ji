/**
 * useDetailPane —— 文件预览编排（#6，UC-6 点文件落地预览）+ detail 多文件 tab
 * （display-containers W3 §6.3/§7.1）。
 *
 * 职责（单一变化轴「文件预览内容加载 + tab 实例编排」）：
 * - 注入语义（§6.3）：openPreview = 「未开新增并激活 / 已开仅激活 / 不设上限」；
 *   注入本体在 fileTreeStore.selectFile / openDetailTab（**同步**落分区——旧实现靠
 *   watch(selectedPath) 在组件挂载后才注入，git tab / 消息链接等 DetailPane 未挂载的入口
 *   会丢点击；现 store 分区是唯一事实源，本 composable 只做加载编排与视图投影）
 * - 加载编排：per-tab 任务（git 改动文件 → git.getDiff(patch)；未改动 → file.read(content)），
 *   实例状态回写 fileTreeStore.detailTabs（per-session Map<path, 实例>，单值→map）
 * - keep-alive 多实例语义：每个打开的文件是一条独立状态实例（内容/模式态/滚动锚点），
 *   切 tab 不重载不丢状态——「滚动保持」由 per-tab scrollTop（滚动即存、激活恢复）承载，
 *   「模式态保持」由 per-tab viewMode 承载（DetailPane.vue 是分区的单内容视图）
 *
 * 数据流（code-architecture §4 功能3）：
 *   点文件 → store.selectFile(sid, path)（同步注入 tab 实例）→ DetailPane 挂载 →
 *   useDetailPane 拉起 idle 实例 → (gitOverlay 判定: 改动→git.getDiff / 未改动→file.read) →
 *   渲染（禁 v-html，文本插值/<pre>）
 *
 * HTML 形态（chat-html-support v16 形态变更，§6.4 D4）：.html/.htm 恢复 code 类 shiki
 * 源码高亮（渲染态退役，预览面收敛到消息流内联容器 HtmlPreviewInline）；产物目录文件
 * （session cwd 外，runtime file.read 的 cwd 守门不可达）的抽屉源码读取走 localFile:read
 * 白名单通道（§6.9 D9，readFileContent 两通道分发）。
 *
 * 依赖方向：useDetailPane → fileTreeStore + api/domains（file/git）。不直接 import chat store。
 *
 * [NFR-AC-S4] 禁 v-html：本 composable 只负责取数据，渲染层 DetailPane.vue 用文本插值/<pre>，
 * 不用 v-html（T6.10 XSS 断言——含 <script> 的内容被转义不执行）。
 */
import { computed, watch, watchEffect, type Ref } from 'vue'
import { useFileTreeStore, type DetailTabState, type DetailViewMode } from '@/stores/fileTree'
import { useSessionStore } from '@/stores/session'
import { useSideDrawer } from '@/composables/features/drawer/useSideDrawer'
import { registerSessionCleanup } from '@/composables/useSessionScopedState'
import { file as fileApi, git as gitApi } from '@/api'
import { parseDiff } from '@/composables/logic/parseDiff'
import { resolvePreviewPath } from '@/lib/path-utils'
import { localFileRead, type LocalFileReadReason } from '@/lib/ipc'
import i18n from '@/i18n'

export type { DetailViewMode, DetailTabState } from '@/stores/fileTree'

const t = i18n.global.t

/**
 * per-tab 请求版本号（L3 并发守卫：同 tab 内「初始加载 vs 模式切换重载」互相抢占时丢弃
 * stale write）。模块级按 (sid, path) 记账——跨 DetailPane 重挂载仍连续（重挂载不得让
 * 旧请求的慢响应覆盖新内容）。旧实现是单实例全局 token，map 化后 token 随实例粒度记账。
 * taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构）：请求版本号计数表，非 GUI 数据
 */
const loadTokens = new Map<string, number>()

/**
 * 在途加载 promise（ensureLoaded 对已拉起实例返回同一 promise；settle 即移除）。
 * taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构）：RPC pending promise 去重簿记，非 GUI 数据
 */
const pendingLoads = new Map<string, Promise<void>>()

function loadKey(sid: string, path: string): string {
  return `${sid}\u0000${path}`
}

/**
 * session 销毁清理（模块级注册一次，triggerSessionCleanups 统一编排）：删除该 session
 * 的全部请求版本号记账键。loadTokens 只 set 不删（L3 并发守卫按键覆盖即可工作），
 * 长寿会话反复预览会无界累积——清理挂接在既有销毁沿（tab 关闭删单键见 closeTab /
 * session 删除删全键见本函数），不设定时器不上限。
 */
function cleanupLoadTokensForSession(sessionId: string): void {
  const prefix = `${sessionId}\u0000`
  for (const key of loadTokens.keys()) {
    if (key.startsWith(prefix)) loadTokens.delete(key)
  }
}
registerSessionCleanup(cleanupLoadTokensForSession)

/** 无激活 tab 时的只读空态（DetailPane 渲染 detail-empty 分支） */
function emptyDetailState(): DetailTabState {
  return {
    path: '',
    status: 'idle',
    content: '',
    truncated: false,
    binary: false,
    error: '',
    viewMode: 'preview',
    hasGitChange: false,
    kind: 'text',
    forceDiff: false,
    scrollTop: 0,
  }
}

export function useDetailPane(sessionId: Ref<string | null>) {
  const store = useFileTreeStore()
  const sessionStore = useSessionStore()

  /** 打开的 tab 实例列表（开序，per-session 分区投影） */
  const tabs = computed(() => (sessionId.value ? store.getDetailTabs(sessionId.value) : []))

  /** 当前激活 tab 的 path */
  const activePath = computed(() =>
    sessionId.value ? store.getDetailActivePath(sessionId.value) : null,
  )

  /** 当前激活 tab 的实例状态（无激活 tab → 只读空态） */
  const state = computed<DetailTabState>(() => {
    const sid = sessionId.value
    const path = activePath.value
    return (sid && path ? store.getDetailTab(sid, path) : null) ?? emptyDetailState()
  })

  /**
   * 取当前 session 的 cwd 绝对路径（图片渲染拼 local-file:// URL 用）。
   * sessionStore.list 按 id 查 SessionSummary.cwd；无 session 返回 null。
   */
  function sessionCwd(sid: string | null): string | null {
    if (!sid) return null
    return sessionStore.list.find((s) => s.id === sid)?.cwd ?? null
  }

  /** git 相对路径（cwd 内绝对路径转相对路径，用于 gitOverlay 查询和 git diff） */
  function gitPathOf(sid: string, path: string): string | null {
    return resolvePreviewPath(sessionCwd(sid) ?? '', path).relative
  }

  /**
   * preview 模式内容读取（两通道，「白名单先行」沿袭 chat-html-support §6.9 D9 源码读取语义）。
   * cwd 内路径 → 既有 file.read cwd 守门通道；cwd 外路径（产物目录 <dataDir>/artifacts/<sessionId>
   * 等——变更集卡/文件树可点开产物文件，runtime file.read 的 cwd 守门不可达）→ localFile:read
   * 白名单通道（与 servable 预检同一白名单谓词，main 侧单一实现）。只有 out_of_whitelist 才回落
   * cwd 通道；not_found / is_dir / read_failed 是真实失败，带原因直接进错误态（不静默吞掉）。
   * IPC 通道不可用（mock / 旧 preload 的 reject）同样回落 cwd 通道。
   */
  async function readFileContent(
    sid: string,
    path: string,
  ): Promise<{ content: string; truncated: boolean }> {
    const resolved = resolvePreviewPath(sessionCwd(sid) ?? '', path)
    if (resolved.relative !== null) return fileApi.read(path, sid)
    const result = await localFileRead(resolved.absolute).catch((e) => {
      console.warn('[useDetailPane] localFileRead failed, falling back to cwd channel:', e)
      return null
    })
    if (result?.ok) return { content: result.content, truncated: result.truncated }
    if (result && result.reason !== 'out_of_whitelist') {
      throw new Error(sourceReadErrorText(result.reason))
    }
    return fileApi.read(path, sid)
  }

  /** 白名单读取真实失败原因 → 用户可见文案（panel.detail.htmlReasonNotFound/htmlReasonIsDir
   *  为 chat-html-support 新增键；read_failed 无专用词条落通用 loadFailed） */
  function sourceReadErrorText(reason: Exclude<LocalFileReadReason, 'out_of_whitelist'>): string {
    if (reason === 'not_found') return t('panel.detail.htmlReasonNotFound')
    if (reason === 'is_dir') return t('panel.detail.htmlReasonIsDir')
    return t('composable.loadFailed')
  }

  /**
   * 取数据并回写 tab 实例（code-architecture §4 功能3 时序）。
   * - diff 模式 → git.getDiff(sid, gitPath ?? path)
   * - preview 模式 → file.read(path, sid) cwd 守门
   * - 每次 await 后校验 token（stale write 防护）：旧请求被同 tab 新加载抢占时丢弃，
   *   不覆盖新内容（U6 并发守卫，map 化后按 tab 粒度）
   *
   * @param autoFallback diff 空 patch 时是否自动降级 preview：初始加载传 true（空 diff 无
   *   信息量，改显文件内容）；toggleView 传 false（用户主动选 Diff，尊重选择显空态）。
   */
  async function runLoad(
    sid: string,
    path: string,
    mode: DetailViewMode,
    autoFallback: boolean,
  ): Promise<void> {
    const key = loadKey(sid, path)
    const token = (loadTokens.get(key) ?? 0) + 1
    loadTokens.set(key, token)
    const stale = (): boolean => loadTokens.get(key) !== token
    try {
      if (mode === 'diff') {
        // git diff 必须用相对 cwd 路径；gitPath 为 null 时回退原始 path（越界会自然失败）
        const gitPath = gitPathOf(sid, path)
        const result = await gitApi.getDiff(sid, gitPath ?? path)
        if (stale()) return
        store.updateDetailTab(sid, path, { binary: result.binary, content: result.patch })
        // diff 无 hunk 且非二进制 → 自动降级 preview：untracked 文件 git diff 必空，
        // 此时展示「无差异内容」空态无信息量，改显文件内容更实用。
        // 仅初始加载（autoFallback=true）降级；toggleView 传 false，尊重用户主动选择 Diff。
        if (autoFallback && !result.binary && parseDiff(result.patch).hunks.length === 0) {
          store.updateDetailTab(sid, path, { viewMode: 'preview' })
          const fileResult = await readFileContent(sid, path)
          if (stale()) return
          store.updateDetailTab(sid, path, {
            content: fileResult.content,
            truncated: fileResult.truncated,
          })
        }
      } else {
        const result = await readFileContent(sid, path)
        if (stale()) return
        store.updateDetailTab(sid, path, {
          content: result.content,
          truncated: result.truncated,
        })
      }
      if (stale()) return
      store.updateDetailTab(sid, path, { status: 'content' })
    } catch (e) {
      if (stale()) return
      store.updateDetailTab(sid, path, {
        status: 'error',
        error: (e as Error)?.message ?? t('composable.loadFailed'),
      })
    }
  }

  /** 在途 promise 记账（settle 自清；同 key 重复拉起返回同一 promise） */
  function trackPending(key: string, p: Promise<void>): Promise<void> {
    const wrapped = p.finally(() => {
      if (pendingLoads.get(key) === wrapped) pendingLoads.delete(key)
    })
    pendingLoads.set(key, wrapped)
    return wrapped
  }

  /**
   * 拉起一个 tab 实例的初始加载：gitOverlay 判定改动 → 定 viewMode（forceDiff 恒 diff）+
   * hasGitChange（DetailPane 的 diff/preview 切换钮显隐依据）后取数据。
   * status 'idle' → 'loading' 同步翻转 = 幂等闸（watchEffect 与显式拉起不重复发请求）。
   */
  function startLoad(sid: string, path: string): void {
    const tab = store.getDetailTab(sid, path)
    if (!tab || tab.status !== 'idle') return
    const gitPath = gitPathOf(sid, path)
    // 判断 git 改动：gitOverlay per-session 查（含 untracked，T2.8b untracked 也算改动可 diff）
    const gitStatus = gitPath ? store.getGitStatus(sid, gitPath)?.status : undefined
    const hasGitChange = !!gitStatus
    // 默认 viewMode：forceDiff（变更集卡/消息链接等已知有改动的入口）优先；否则按 gitOverlay 判定
    const mode: DetailViewMode = tab.forceDiff ? 'diff' : gitStatus ? 'diff' : 'preview'
    store.updateDetailTab(sid, path, { status: 'loading', hasGitChange, viewMode: mode, error: '' })
    void trackPending(loadKey(sid, path), runLoad(sid, path, mode, true))
  }

  /** 确保实例已加载（idle → 拉起；已拉起/已完成 → 等待或立即返回） */
  async function ensureLoaded(sid: string, path: string): Promise<void> {
    const tab = store.getDetailTab(sid, path)
    if (!tab) return
    if (tab.status === 'idle') startLoad(sid, path)
    await pendingLoads.get(loadKey(sid, path))
  }

  /**
   * 打开文件预览（注入语义 §6.3：未开新增并激活 / 已开仅激活 / 不设上限）。
   * 注入同步落 store 分区，随后拉起待加载实例。
   * @param forceDiff 强制 diff 模式（变更集卡/消息链接等已知有改动的入口，绕过 gitOverlay 判定）
   */
  async function openPreview(sid: string, path: string, forceDiff = false): Promise<void> {
    store.openDetailTab(sid, path, { forceDiff })
    if (forceDiff) ensureDiffMode(sid, path)
    await ensureLoaded(sid, path)
  }

  /**
   * 强制 diff 收敛（forceDiff 注入的模式修正，事件序无关）：
   * 实例尚未展示内容（非 status='content'）即钉在 diff 模式——在途的非 diff 加载作废重拉
   * （token 自增即丢弃旧响应）。同 tick 双通道注入（ui 链接点击 = selectFile +
   * openDrawer({filePath})）不依赖两个监听器的 flush 先后：无论拉起先于还是后于强制注入，
   * 最终恒收敛为 diff 内容；已展示内容的实例走 §6.3「已开仅激活」，不改模式。
   */
  function ensureDiffMode(sid: string, path: string): void {
    const tab = store.getDetailTab(sid, path)
    if (!tab || tab.status === 'idle') return // 未拉起：加载拉起时按 forceDiff 定模式
    if (tab.status === 'content' || tab.viewMode === 'diff') return // 已展示内容/已是 diff：仅激活语义
    store.updateDetailTab(sid, path, {
      forceDiff: true,
      viewMode: 'diff',
      status: 'loading',
      error: '',
    })
    void trackPending(loadKey(sid, path), runLoad(sid, path, 'diff', false))
  }

  /**
   * 切换当前激活 tab 的视图模式（diff ↔ preview）。切换后重新加载对应内容。
   * 仅当文件同时有 git 改动（可 diff）且可读（可 preview）时有效。
   */
  async function toggleView(mode: DetailViewMode): Promise<void> {
    const sid = sessionId.value
    const path = state.value.path
    if (!sid || !path || state.value.viewMode === mode) return
    store.updateDetailTab(sid, path, { viewMode: mode, status: 'loading', error: '' })
    await trackPending(loadKey(sid, path), runLoad(sid, path, mode, false))
  }

  /** 激活已开 tab（keep-alive：实例状态原样保持，不重载） */
  function activateTab(path: string): void {
    const sid = sessionId.value
    if (!sid) return
    store.activateDetailTab(sid, path)
  }

  /** 关闭 tab（激活者关闭时激活右邻/左邻；关闭选中文件同步清选中态防复活） */
  function closeTab(path: string): void {
    const sid = sessionId.value
    if (!sid) return
    store.closeDetailTab(sid, path)
    // 请求版本号记账随实例销毁释放（唯一关闭入口，防长寿会话无界累积）。键已删使在途
    // 加载的 stale 判据随即成立——迟到回写本就被 updateDetailTab 的分区/tab 缺席 no-op
    // 守卫拦住，双防线语义一致。
    loadTokens.delete(loadKey(sid, path))
  }

  /**
   * 保存当前激活 tab 的滚动锚点（DetailPane 内容区 @scroll 即存——切 tab 恢复，
   * S4「切 tab 不丢滚动位置」）。
   */
  function saveScroll(top: number): void {
    const sid = sessionId.value
    const path = activePath.value
    if (!sid || !path) return
    store.updateDetailTab(sid, path, { scrollTop: top })
  }

  /**
   * watch drawer.detailFilePath：变更集卡等非文件树入口点击文件行时，
   * useSideDrawer.open('detail', { filePath }) 设置 detailFilePath。
   * 变化时以 forceDiff 注入该文件（绕过 gitOverlay 判定——变更集文件来源即 git diff，
   * 一定有改动，overlay 可能未刷新会导致误判 preview 模式）。消费后清空避免残留。
   *
   * immediate=true 兜底首次挂载时序：DetailPane 在抽屉内是条件挂载
   * （v-else-if="drawerTab==='detail'"），首次从变更集卡点文件时 drawer.open 同步设置
   * detailFilePath，但此时 DetailPane（及本 watch）尚未建立；等挂载建立时 detailFilePath
   * 早已是目标值。watch 默认不对「建立时已存在的值」触发回调，导致首次打开显示空态。
   * immediate 让 setup 阶段同步消费当前值。消费后清空，无残留误触发风险。
   *
   * 双通道注入（消息链接 = selectFile + openDrawer({filePath}) 同 tick）的模式修正不依赖
   * 本 watch 与下方加载 watchEffect 的 flush 先后——ensureDiffMode 是收敛式（事件序无关）。
   */
  const { detailFilePath } = useSideDrawer()
  watch(
    detailFilePath,
    (path) => {
      const sid = sessionId.value
      if (!sid || !path) return
      void openPreview(sid, path, true)
      detailFilePath.value = null
    },
    { immediate: true },
  )

  /**
   * 加载编排（watchEffect 拉起 idle 实例）：
   * - 覆盖「DetailPane 挂载前注入」的实例（selectFile 同步注入、组件尚未挂载/加载未拉起）
   * - 会话切换后拉起新会话的待加载实例（切回 A 恢复 A 的文件详情——§7.1 W3 承接）
   * 'idle' → 'loading' 的同步翻转保证幂等（与 openPreview/ensureLoaded 显式拉起不重复）。
   */
  watchEffect(() => {
    const sid = sessionId.value
    if (!sid) return
    for (const tab of store.getDetailTabs(sid)) {
      if (tab.status === 'idle') startLoad(sid, tab.path)
    }
  })

  return {
    tabs,
    activePath,
    state,
    openPreview,
    toggleView,
    activateTab,
    closeTab,
    saveScroll,
    sessionCwd,
  }
}

// ── 测试专用 hooks（生产代码禁止调用，参照 useTerminal __resetTerminalStateForTest 先例）──

/** 测试专用：loadTokens 记账键数（断言 tab 关闭 / session 清理后键释放）。 */
export function __loadTokenKeyCountForTest(): number {
  return loadTokens.size
}
