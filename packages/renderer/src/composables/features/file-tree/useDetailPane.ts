/**
 * useDetailPane —— 文件预览编排（#6，UC-6 点文件落地预览）。
 *
 * 职责（单一变化轴「文件预览内容加载」）：
 * - watch fileTreeStore.selectedPath + sessionId → openPreview
 * - openPreview：git 改动文件 → git.getDiff（patch）；未改动 → file.read（content）
 * - viewMode 切换（diff/preview），当文件既有 git 改动又是普通文件可手动切换
 *
 * 数据流（code-architecture §4 功能3）：
 *   点文件 → store.selectFile → DetailPane 挂载 → useDetailPane.openPreview →
 *   (gitOverlay 判定: 改动→git.getDiff / 未改动→file.read) → 渲染（禁 v-html，文本插值/<pre>）
 *
 * 依赖方向：useDetailPane → fileTreeStore + api/domains（file/git）。不直接 import chat store。
 *
 * [NFR-AC-S4] 禁 v-html：本 composable 只负责取数据，渲染层 DetailPane.vue 用文本插值/<pre>，
 * 不用 v-html（T6.10 XSS 断言——含 <script> 的内容被转义不执行）。
 */
import { ref, watch, type Ref } from 'vue'
import { useFileTreeStore } from '@/stores/fileTree'
import { useSessionStore } from '@/stores/session'
import { useSideDrawer } from '@/composables/features/drawer/useSideDrawer'
import { file as fileApi, git as gitApi } from '@/api'
import { detectFileKind, type FileKind } from '@/composables/logic/file-type'
import { parseDiff } from '@/composables/logic/parseDiff'
import { resolvePreviewPath } from '@/lib/path-utils'
import i18n from '@/i18n'

const t = i18n.global.t

/** 预览加载态 */
type PreviewStatus = 'idle' | 'loading' | 'content' | 'error'

/** 预览视图模式（diff=显示 git patch，preview=显示文件原始内容） */
export type DetailViewMode = 'diff' | 'preview'

interface DetailPaneState {
  status: PreviewStatus
  /** 文件内容（preview 模式）或 diff patch（diff 模式） */
  content: string
  /** 是否截断（>1MB，file.read 返回） */
  truncated: boolean
  /** 是否二进制文件（git.diff 返回 binary=true） */
  binary: boolean
  /** 错误信息（status='error' 时） */
  error: string
  /** 当前视图模式 */
  viewMode: DetailViewMode
  /** 当前预览的文件路径 */
  path: string | null
  /** 该文件是否有 git 改动（决定默认 viewMode：改动→diff，未改动→preview） */
  hasGitChange: boolean
  /**
   * 文件渲染类别（preview 模式下由 detectFileKind 判定，决定 DetailPane 选哪个渲染器）。
   * diff 模式下渲染层用 DiffView（统一），kind 仅供兜底参考。
   */
  kind: FileKind
}

function initialState(): DetailPaneState {
  return {
    status: 'idle',
    content: '',
    truncated: false,
    binary: false,
    error: '',
    viewMode: 'preview',
    path: null,
    hasGitChange: false,
    kind: 'text',
  }
}

export function useDetailPane(sessionId: Ref<string | null>) {
  const store = useFileTreeStore()
  const sessionStore = useSessionStore()
  const state = ref<DetailPaneState>(initialState())

  /**
   * 请求版本号（L3 并发守卫：快速切换文件时丢弃旧请求的 stale write）。
   * openPreview/toggleView 开头自增 token，loadContent 内每次 await 后校验，
   * 不匹配则 return（旧请求的慢响应不覆盖新选中文件的 state）。
   */
  let loadToken = 0

  /**
   * 取当前 session 的 cwd 绝对路径（图片渲染拼 local-file:// URL 用）。
   * sessionStore.list 按 id 查 SessionSummary.cwd；无 session 返回 null。
   */
  function sessionCwd(sid: string | null): string | null {
    if (!sid) return null
    return sessionStore.list.find((s) => s.id === sid)?.cwd ?? null
  }

  /**
   * 加载文件预览（code-architecture §4 功能3 时序）。
   * - git 改动文件（gitOverlay 有记录）→ git.getDiff，默认 viewMode='diff'
   * - 未改动文件 → file.read(sessionId, path) cwd 守门，默认 viewMode='preview'
   * - 加载在途 → status='loading'（DetailPane 显骨架态，AC-6.6/T6.7）
   * - 失败 → status='error'（AC-6.4/T6.4）
   *
   * 调用方负责定 viewMode 并设 status='loading'，再委托 loadContent 取数据。
   * @param autoFallback diff 空 patch 时是否自动降级 preview：openPreview 传 true（自动加载
   *   时空 diff 无信息量，改显文件内容）；toggleView 传 false（用户主动选 Diff，尊重选择显空态）。
   */
  async function loadContent(
    sid: string,
    path: string,
    gitPath: string | null,
    mode: DetailViewMode,
    token: number,
    autoFallback = false,
  ): Promise<void> {
    try {
      if (mode === 'diff') {
        // git diff 必须用相对 cwd 路径；gitPath 为 null 时回退原始 path（越界会自然失败）
        const diffPath = gitPath ?? path
        const result = await gitApi.getDiff(sid, diffPath)
        // L3：await 后校验 token，旧请求被新 openPreview 抢占时丢弃（stale write 防护）
        if (token !== loadToken) return
        state.value.binary = result.binary
        state.value.content = result.patch
        // diff 无 hunk 且非二进制 → 自动降级 preview：untracked 文件 git diff 必空，
        // 此时展示「无差异内容」空态无信息量，改显文件内容更实用。
        // 仅 openPreview（autoFallback=true）降级；toggleView 传 false，尊重用户主动选择 Diff。
        if (autoFallback && !result.binary && parseDiff(result.patch).hunks.length === 0) {
          state.value.viewMode = 'preview'
          const fileResult = await fileApi.read(path, sid)
          if (token !== loadToken) return
          state.value.content = fileResult.content
          state.value.truncated = fileResult.truncated
        }
      } else {
        const result = await fileApi.read(path, sid)
        if (token !== loadToken) return
        state.value.content = result.content
        state.value.truncated = result.truncated
      }
      state.value.status = 'content'
    } catch (e) {
      if (token !== loadToken) return
      state.value.status = 'error'
      state.value.error = (e as Error)?.message ?? t('composable.loadFailed')
    }
  }

  async function openPreview(sid: string, path: string, forceDiff = false): Promise<void> {
    const token = ++loadToken
    state.value = { ...initialState(), status: 'loading', path, viewMode: state.value.viewMode }
    // 解析路径：cwd 内绝对路径转相对路径，用于 gitOverlay 查询和 git diff
    const cwd = sessionCwd(sid) ?? ''
    const resolved = resolvePreviewPath(cwd, path)
    const gitPath = resolved.relative
    // 判断 git 改动：gitOverlay per-session 查（含 untracked，T2.8b untracked 也算改动可 diff）
    const gitStatus = gitPath ? store.getGitStatus(sid, gitPath)?.status : undefined
    state.value.hasGitChange = !!gitStatus
    // 默认 viewMode：forceDiff（变更集卡等已知有改动的入口）优先；否则按 gitOverlay 判定
    const mode: DetailViewMode = forceDiff ? 'diff' : gitStatus ? 'diff' : 'preview'
    state.value.viewMode = mode
    // 文件渲染类别（preview 模式渲染器选择依据；diff 模式统一走 DiffView）
    state.value.kind = detectFileKind(path)

    await loadContent(sid, path, gitPath, mode, token, true)
  }

  /**
   * 切换视图模式（diff ↔ preview）。切换后重新加载对应内容。
   * 仅当文件同时有 git 改动（可 diff）且可读（可 preview）时有效。
   */
  async function toggleView(mode: DetailViewMode): Promise<void> {
    const sid = sessionId.value
    const path = state.value.path
    if (!sid || !path || state.value.viewMode === mode) return
    const token = ++loadToken
    state.value.viewMode = mode
    state.value.status = 'loading'
    state.value.error = ''
    const cwd = sessionCwd(sid) ?? ''
    const resolved = resolvePreviewPath(cwd, path)
    const gitPath = resolved.relative
    await loadContent(sid, path, gitPath, mode, token)
  }

  /** 清空预览（关闭 drawer / 取消选中时） */
  function clearPreview(): void {
    state.value = initialState()
  }

  /**
   * watch selectedPath + sessionId：选中文件变化 → 自动 openPreview。
   * selectedPath 由 FileTreeRow.onSelectFile 经 useFileTree.selectFile 设置。
   * sessionId 为 null（无 active session）→ 清空预览。
   */
  watch(
    [() => store.selectedPath, sessionId],
    ([path, sid]) => {
      if (!sid || !path) {
        clearPreview()
        return
      }
      void openPreview(sid, path)
    },
    { immediate: true },
  )

  /**
   * watch drawer.detailFilePath：变更集卡等非文件树入口点击文件行时，
   * useSideDrawer.open('detail', { filePath }) 设置 detailFilePath。
   * 变化时用 forceDiff 打开该文件（绕过 gitOverlay 判定——变更集文件来源即 git diff，
   * 一定有改动，overlay 可能未刷新会导致误判 preview 模式）。消费后清空避免残留。
   *
   * immediate=true 兜底首次挂载时序：DetailPane 在 SideDrawer 内是条件挂载
   * （<aside v-if="isOpen"><DetailPane v-else-if="activeTab==='detail'">），
   * 首次从变更集卡点文件时 drawer.open 同步设置 detailFilePath，但此时 DetailPane
   * 尚未挂载、watch 尚未建立；等 Vue 渲染完成、DetailPane 挂载、watch 建立时，
   * detailFilePath 早已是目标值。watch 默认不对「建立时已存在的值」触发回调，
   * 导致首次打开 drawer 显示空态（要再点别的文件让值变化才能加载）。
   * immediate 让 setup 阶段同步消费当前值。消费后清空，无残留误触发风险。
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

  return {
    state,
    openPreview,
    toggleView,
    clearPreview,
    sessionCwd,
  }
}
