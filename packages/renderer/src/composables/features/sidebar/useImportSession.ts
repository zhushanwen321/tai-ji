/**
 * useImportSession —— 「导入会话」对话框状态编排（import-session U5）。
 *
 * 来源设计：docs/design/import-session.md（已删除，git 可追溯）§3.3 D5（RPC 契约）+ §3.1 终态交互样例。
 *
 * 职责边界：纯状态编排（来源选择 + query debounce 拉候选 / 目录过滤 / 选中 /
 * 执行导入 /「选择其他目录」切扫描根重拉），不含 DOM 与 i18n 文案映射（错误码 →
 * 恢复指引文案在组件层，按 source 分支取 zcode 特化文案）。无 per-session 状态
 * （ADR-0049 不适用：对话框是全局单例 UI，非 session 隔离域）。
 *
 * 模块级导出（跨组件共享的导入瞬时信号）：
 *  - 成功 toast 组装在 importSession 内（对话框关闭后 toast 仍需展示）
 *  - markImportedFresh / isImportedFresh：fresh「导入」徽标状态机（Sidebar 标记、
 *    SessionItem 消费——与 useSessionMarkers.isUnread 同款模块级状态范式，避免
 *    Sidebar → SessionList → SessionItem 逐层透传 prop）
 *
 * 竞态防护：快速连续输入时 debounce 触发的并发请求用递增 seq 守卫——仅最新
 * 一次请求允许写回 items/dirs/total，stale 响应静默丢弃（避免旧结果覆盖新结果）。
 */
import { computed, ref, shallowRef, watch } from 'vue'
import type {
  ImportCandidate,
  ImportCandidateDir,
  ImportErrorCode,
  ImportRequest,
  ImportSourceKind,
  ImportWarning,
} from '@taiji/shared'
import { session as sessionApi } from '@/api'
import { useToast } from '@/composables/useToast'
import { useProjectStore } from '@/stores/project'
import { pickDirectory } from '@/lib/ipc'
import i18n from '@/i18n'

const t = i18n.global.t

/** 搜索输入到发起候选查询的防抖间隔（D5：renderer 侧 debounce 250ms） */
export const IMPORT_SEARCH_DEBOUNCE_MS = 250

/** 短 ID = uuid 前 6 位（D5 匹配语义同款截断；toast 显示名回退用，组件列表行复用） */
export const IMPORT_SHORT_ID_LENGTH = 6

// ── fresh「导入」徽标状态机（模块级，Sidebar 写 / SessionItem 读）──

/** fresh 徽标生命周期：visible（实显）→ fading（200ms 淡出过渡）→ 移除 */
export type ImportFreshState = 'visible' | 'fading'

/**
 * fresh 徽标开始淡出前的实显时长（demo doImport 3.2s 后加 fade class；
 * 侧边栏 fresh 信号统一节奏）。
 */
export const IMPORT_FRESH_VISIBLE_MS = 3_200

/** 淡出过渡时长（demo --dur: 200ms；SessionItem transition-opacity duration-200 对应） */
export const IMPORT_FRESH_FADE_MS = 200

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，随登记表 §4 ⑧ 补登落定非草稿）：导入 fresh 徽标状态（sessionId → 生命周期阶段）
const freshImports = shallowRef(new Map<string, ImportFreshState>())

// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，随登记表 §4 ⑧ 补登落定非草稿）：fresh 徽标计时器句柄表，非 GUI 数据
/** 每 sessionId 两个 timer（实显 → fading / fading → 移除），重复标记时清旧 */
const freshTimers = new Map<string, ReturnType<typeof setTimeout>[]>()

/**
 * 标记某 session 为「刚导入」（Sidebar 在 imported 事件中调用）。
 * 已在集合中时重置计时（先清旧 timer）；3.2s 后转 fading、再 200ms 后移除——
 * SessionItem 的 computed 经 isImportedFresh 订阅 freshImports 响应式更新。
 */
export function markImportedFresh(sessionId: string): void {
  for (const timer of freshTimers.get(sessionId) ?? []) clearTimeout(timer)
  setFreshState(sessionId, 'visible')
  const fadeTimer = setTimeout(() => {
    setFreshState(sessionId, 'fading')
    freshTimers.set(sessionId, [
      setTimeout(() => {
        removeFresh(sessionId)
      }, IMPORT_FRESH_FADE_MS),
    ])
  }, IMPORT_FRESH_VISIBLE_MS)
  freshTimers.set(sessionId, [fadeTimer])
}

/** 查询 session 的 fresh 状态（null = 无徽标）。computed 内调用可建立响应式依赖。 */
export function isImportedFresh(sessionId: string): ImportFreshState | null {
  return freshImports.value.get(sessionId) ?? null
}

function setFreshState(sessionId: string, state: ImportFreshState): void {
  const next = new Map(freshImports.value)
  next.set(sessionId, state)
  freshImports.value = next
}

function removeFresh(sessionId: string): void {
  const next = new Map(freshImports.value)
  next.delete(sessionId)
  freshImports.value = next
  const timers = freshTimers.get(sessionId)
  if (timers) {
    for (const timer of timers) clearTimeout(timer)
    freshTimers.delete(sessionId)
  }
}

/** 测试隔离：清空 fresh 集合与计时器（fake timers 下次 advance 不再触发旧链） */
export function __resetImportedFreshForTest(): void {
  for (const timers of freshTimers.values()) {
    for (const timer of timers) clearTimeout(timer)
  }
  freshTimers.clear()
  freshImports.value = new Map()
}

/**
 * error envelope 透传到 Error.code 的合法值集合：ImportErrorCode 全集（不含
 * `import_sidecar_failed`——它走成功 reply 的 warning 通道，r4-INFO）+
 * transport 层唯一透传 code `timeout`（pending.ts）。
 * 归一化规则因通道而异：导入动作集合外归 `unknown`；候选加载集合外（含表外
 * 兜底码 import_unsupported/import_failed）归 null → 通用失败文案 + 重试
 * （设计 §3.3 表外兜底码说明：勿按表穷举，须有 default 分支）。
 */
const FAILURE_CODES: ReadonlySet<string> = new Set([
  'import_source_missing',
  'import_invalid_session',
  'import_marker_filename',
  'import_dir_unreadable',
  'import_already_imported',
  'import_target_conflict',
  'import_copy_failed',
  'import_project_invalid',
  'timeout',
])

/** 导入失败码（内联展示用；文案映射 key = `importSession.errors.<code>`） */
export type ImportFailureCode = ImportErrorCode | 'timeout' | 'unknown'

/** 导入成功回调载荷（消费方据此 toast / 刷新，runtime 侧已广播 session.list） */
export interface ImportSessionImportedPayload {
  sessionId: string
  /** 会话显示名（name 为空时回退所属目录名，与列表行一致） */
  sessionName: string
  /** 导入目标 project 显示名（默认 project 回退「默认项目」） */
  projectName: string
  /** 导入落地路径 */
  targetPath: string
  /** sidecar 写失败降级标记（文件已落地不回滚，消费方可选提示） */
  warning?: ImportWarning
}

export interface UseImportSessionOptions {
  /** 导入成功（reply 已返回、对话框即将关闭）后的回调 */
  onImported?: (payload: ImportSessionImportedPayload) => void
}

export function useImportSession(options: UseImportSessionOptions = {}) {
  const projectStore = useProjectStore()
  const toast = useToast()

  const open = ref(false)
  const query = ref('')
  /**
   * 导入源（两阶段视图：阶段一来源选择 → 阶段二该源候选列表）。缺省 'pi'
   * （契约向后兼容：renderer 侧总是显式携带 source，缺省值仅覆盖「未选择即交互」
   * 的初始态）；resetForOpen 重开对话框时回到缺省源。
   */
  const source = ref<ImportSourceKind>('pi')
  const items = ref<ImportCandidate[]>([])
  const dirs = ref<ImportCandidateDir[]>([])
  /** 过滤前总数（reply.total，供统计展示） */
  const total = ref(0)
  const loading = ref(false)
  const loadFailed = ref(false)
  /**
   * 候选加载失败码（与导入失败 importErrorCode 同套 FAILURE_CODES 归一化）：
   * null = 无专属恢复指引（表外兜底码 / 未识别码），组件层显示通用失败文案。
   */
  const loadErrorCode = ref<ImportFailureCode | null>(null)
  /** 目录 chip 过滤（'' = 全部目录；客户端过滤，RPC query 不含目录维度） */
  const selectedDir = ref('')
  /**
   * 当前扫描根（null = 缺省 ~/.pi/agent/sessions，D5 rootDir 可选语义——
   * 缺省不传字段，runtime 侧动态推导，禁止 renderer 硬编码路径）。
   */
  const rootDir = ref<string | null>(null)
  /** 导入目标 project（resetForOpen 时默认当前活跃 project） */
  const selectedProjectId = ref('')
  /** 当前点选的候选（sessionId；列表行高亮 + 底部导入按钮的作用对象） */
  const selectedId = ref<string | null>(null)
  const importing = ref(false)
  const importErrorCode = ref<ImportFailureCode | null>(null)

  /** 请求序号：仅最新请求可写回（stale 响应丢弃） */
  let requestSeq = 0
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  /** 目录 chip 过滤后的可见候选（已按 lastModified 降序，runtime 保证） */
  const filteredItems = computed<ImportCandidate[]>(() => {
    if (selectedDir.value === '') return items.value
    return items.value.filter((item) => item.dirLabel === selectedDir.value)
  })

  /** 路径模式判定：query 以 '/' 或 '~' 开头（D5 S7 renderer 侧切换；runtime 无分支）。纯 query 派生，数据面登记归 #22 */
  const isPathMode = computed<boolean>(() => /^[~/]/.test(query.value.trim()))

  /**
   * 路径模式命中条目：候选中 sourcePath includes query 的首条（items 已按
   * lastModified 降序；isPathMode/pathHit 均纯派生投影，数据面登记归 #22）。
   * runtime 的 includes 匹配天然覆盖路径输入，此处只在
   * renderer 侧收敛到「路径行」单一命中语义（demo 方案 A path-bar）。
   */
  const pathHit = computed<ImportCandidate | null>(() => {
    if (!isPathMode.value) return null
    const q = query.value.trim().toLowerCase()
    return items.value.find((item) => item.sourcePath.toLowerCase().includes(q)) ?? null
  })

  /**
   * 当前目标 project 显示名（trigger 常显 + imported payload 复用）。
   * 不用 SelectValue 自动 label：其依赖 optionsSet（SelectItem 渲染时注册），
   * 初始未打开过下拉时为空，用户看不到「默认当前激活 project」。
   */
  const selectedProjectName = computed<string>(() => {
    const project =
      projectStore.projects.find((p) => p.id === selectedProjectId.value) ?? projectStore.projects[0]
    return project ? project.name || t('importSession.defaultProjectName') : ''
  })

  const selectedItem = computed<ImportCandidate | null>(
    () => filteredItems.value.find((item) => item.sessionId === selectedId.value) ?? null,
  )

  /** 底部「导入」可用性：有选中 + 选中未导入过 + 不在导入中 */
  const canConfirm = computed<boolean>(() => {
    const item = selectedItem.value
    return item != null && !item.alreadyImported && !importing.value
  })

  function close(): void {
    open.value = false
    // [G4 / 2026-09-14 内存审计] 关闭即清扫描结果：items/dirs/total 是候选全量快照（可达数百条
    // path/name 对象），对话框为全局单例 UI（无 session 生命周期兑底），不清则驻留到下次打开。
    // requestSeq++ 使在途迟到的候选响应失效（stale 写回守卫——否则清了又被打回填）；
    // pending debounce 一并取消（组件侧 watch(open) 注释承诺的「取消 pending debounce」在此落实）。
    requestSeq++
    cancelPendingFetch()
    items.value = []
    dirs.value = []
    total.value = 0
  }

  /**
   * 拉取候选列表。query 为空 = 全量（limit 截断在 runtime）；rootDir 仅在
   * 「选择其他目录」切过根后携带（缺省根由 runtime 推导，payload 不含该字段；
   * zcode 源切源时 rootDir 已重置，天然不携带）。source 总是显式携带。
   */
  async function fetchCandidates(): Promise<void> {
    const seq = ++requestSeq
    loading.value = true
    loadFailed.value = false
    loadErrorCode.value = null
    try {
      const trimmed = query.value.trim()
      const payload: { source: ImportSourceKind; rootDir?: string; query?: string } = {
        source: source.value,
      }
      if (rootDir.value) payload.rootDir = rootDir.value
      if (trimmed) payload.query = trimmed
      const reply = await sessionApi.importCandidates(payload)
      if (seq !== requestSeq) return
      items.value = reply.items
      dirs.value = reply.dirs
      total.value = reply.total
    } catch (e) {
      if (seq !== requestSeq) return
      // 与导入动作同套归一化：识别码按码展示恢复指引（V6 dir_unreadable 可达），
      // 表外/未识别码归 null → 通用失败 + 重试（default 分支）
      const code = (e as { code?: unknown }).code
      loadErrorCode.value =
        typeof code === 'string' && FAILURE_CODES.has(code) ? (code as ImportFailureCode) : null
      loadFailed.value = true
      items.value = []
      dirs.value = []
      total.value = 0
    } finally {
      if (seq === requestSeq) loading.value = false
    }
  }

  /** debounce 包装的拉取（搜索框输入抖动防护）；pending 期间再输入则重置计时 */
  function debouncedFetch(): void {
    if (debounceTimer != null) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void fetchCandidates()
    }, IMPORT_SEARCH_DEBOUNCE_MS)
  }

  /** 取消 pending debounce（关闭对话框时；in-flight RPC 结果由 seq 守卫丢弃） */
  function cancelPendingFetch(): void {
    if (debounceTimer != null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
  }

  // 搜索输入 → 查询：清空立即拉取（回到全量），非空 debounce 250ms（D5）
  watch(query, (value) => {
    if (value.trim()) debouncedFetch()
    else void fetchCandidates()
  })

  /**
   * 打开对话框：重置全部状态 + 默认导入到当前活跃 project。不发起候选拉取——
   * 两阶段视图先展示来源选择（阶段一零 RPC），选定来源由 selectSource 按需拉取。
   * 例外：上次关闭时残留非空搜索词的场景，置空 query 会触发上方 watch 的立即
   * 拉取（此时 source 已重置为 pi，多拉一次缺省源候选，无害）。
   */
  function resetForOpen(): void {
    open.value = true
    cancelPendingFetch()
    requestSeq++
    source.value = 'pi'
    query.value = ''
    selectedDir.value = ''
    rootDir.value = null
    selectedId.value = null
    importing.value = false
    importErrorCode.value = null
    loadFailed.value = false
    loadErrorCode.value = null
    items.value = []
    dirs.value = []
    total.value = 0
    selectedProjectId.value = projectStore.activeProjectId
  }

  function select(sessionId: string): void {
    selectedId.value = sessionId
  }

  /**
   * 选定导入来源（对话框阶段一 → 阶段二的入口动作）。
   * 切源：清源相关状态（选中/目录筛选/扫描根/错误态/候选快照——两源候选域不同，
   * 旧数据对新源无意义；rootDir 是 pi 概念，zcode 换根 out-of-scope）并重拉。
   * 同源重进：候选保留（避免往返闪烁），仅清选中与错误态；上次结果为空（含加载
   * 失败——catch 路径已清空 items）时补拉，覆盖「重进失败列表 = 直接重试」与
   * 「resetForOpen 不首拉后直接点缺省源」两个首次拉取场景。
   */
  function selectSource(kind: ImportSourceKind): void {
    const switched = kind !== source.value
    source.value = kind
    selectedId.value = null
    importErrorCode.value = null
    if (switched) {
      selectedDir.value = ''
      rootDir.value = null
      loadFailed.value = false
      loadErrorCode.value = null
      items.value = []
      dirs.value = []
      total.value = 0
    }
    if (switched || items.value.length === 0) void fetchCandidates()
  }

  /**
   * 「选择其他目录」（V8）：OS 原生目录选择器 → 选中则切换扫描根并带新 rootDir
   * 重拉候选（D5：打开/搜索/切目录都走 importCandidates）；取消（canceled 或无
   * path）无任何操作。切根后目录过滤/选中/错误态回到初始（新根的 dirs 全新，
   * 旧 selectedDir 在其中无意义）；搜索词保留——跨根找同一目标的 V9 场景依赖。
   */
  async function chooseRootDir(): Promise<void> {
    const result = await pickDirectory({ title: t('importSession.chooseDirTitle') })
    if (result.canceled || !result.path) return
    rootDir.value = result.path
    selectedDir.value = ''
    selectedId.value = null
    importErrorCode.value = null
    void fetchCandidates()
  }

  /**
   * 执行导入（列表行按钮 / 底部确认共用）。
   * 成功：组装结果 toast（info 无事发生 / warning 带预警——死 cwd 追加与 sidecar
   * 降级合并展示；文件已落地不回滚）→ onImported 回调 → 关闭；失败：error
   * envelope code 归一化后内联展示（组件层映射文案）。
   */
  async function importSession(candidate: ImportCandidate): Promise<void> {
    if (importing.value || candidate.alreadyImported) return
    importing.value = true
    importErrorCode.value = null
    try {
      // 按源组装定位参数（契约：pi 以 sourcePath 文件定位；zcode 以 sessionId 定位，
      // sourcePath 是 db 路径占位仅满足必填类型，runtime 侧不消费）
      const request: ImportRequest =
        source.value === 'zcode'
          ? {
            source: 'zcode',
            sessionId: candidate.sessionId,
            sourcePath: candidate.sourcePath,
            projectId: selectedProjectId.value,
          }
          : {
            source: 'pi',
            sourcePath: candidate.sourcePath,
            projectId: selectedProjectId.value,
          }
      const reply = await sessionApi.importSession(request)
      notifyImportResult(candidate, reply.warning)
      options.onImported?.({
        sessionId: reply.sessionId,
        // name/dirLabel 均空（顶层文件无目录名）时回退短 ID——与 toast 显示名回退口径一致
        sessionName: candidate.name || candidate.dirLabel || candidate.sessionId.slice(0, IMPORT_SHORT_ID_LENGTH),
        projectName: selectedProjectName.value,
        targetPath: reply.targetPath,
        warning: reply.warning,
      })
      close()
    } catch (e) {
      const code = (e as { code?: unknown }).code
      importErrorCode.value =
        typeof code === 'string' && FAILURE_CODES.has(code) ? (code as ImportFailureCode) : 'unknown'
    } finally {
      importing.value = false
    }
  }

  /**
   * 导入结果 toast（V1/V9 验收依赖）。文案骨架 = 设计 §3.1「已导入「<名称>」到
   * <project> · 可继续对话」；显示名回退短 ID（目录编码名对用户不可读，toast 又有
   * 单行宽度约束）。预警（V9 死 cwd + sidecar 降级 + zcode 转换知情降级）追加在
   * 同一条消息里用分号分隔——一次导入一个结果块，拆多条 toast 会竞态闪烁；有预警
   * 走 warning 通道（8s 停留，给用户足够阅读时间），否则 info（4s 命令回显节奏）。
   */
  function notifyImportResult(candidate: ImportCandidate, warning: ImportWarning | undefined): void {
    const name = candidate.name || candidate.sessionId.slice(0, IMPORT_SHORT_ID_LENGTH)
    const parts = [t('importSession.toastImported', { name, project: selectedProjectName.value })]
    if (!candidate.cwdExists) parts.push(t('importSession.cwdMissing'))
    if (warning === 'sidecar_failed') parts.push(t('importSession.toastWarnSidecar'))
    if (warning === 'conversion_degraded') parts.push(t('importSession.toastWarnDegraded'))
    if (parts.length > 1) toast.warning(parts.join('; '))
    else toast.info(parts[0])
  }

  return {
    open,
    query,
    source,
    items,
    dirs,
    total,
    loading,
    loadFailed,
    loadErrorCode,
    selectedDir,
    rootDir,
    selectedProjectId,
    selectedProjectName,
    selectedId,
    importing,
    importErrorCode,
    filteredItems,
    isPathMode,
    pathHit,
    selectedItem,
    canConfirm,
    close,
    resetForOpen,
    select,
    selectSource,
    chooseRootDir,
    importSession,
    fetchCandidates,
    debouncedFetch,
    cancelPendingFetch,
  }
}
