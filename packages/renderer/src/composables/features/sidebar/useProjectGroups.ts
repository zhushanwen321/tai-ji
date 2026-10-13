/**
 * useProjectGroups —— 侧栏项目锚定分组的派生与动作集合（R6.2，从 SessionList 提取）。
 *
 * 职责：项目分组视图模型（归属切分 + 组序 + 组内平铺序）、锚定交互（组头点击按模式
 * 裁决 / 组头「+」落点新建）、项目新建草稿流、行内重命名与删除确认的壳侧状态。
 * 归属切分规则 SSOT = sessionBelongsToProject（默认项目聚未归类 + 孤儿）；组序 SSOT =
 * projectStore.orderedProjects（lastUsedAt 稳定序 + 默认项目固定最后，锚定切换不重排）；
 * 组内平铺序 = sessionsInRuntimeGroupOrder（runtime 组序展平，客户端零重排）。
 *
 * 依赖注入说明：groups 由调用方以 getter 注入（SessionList 的 props 非响应式直传边界）；
 * mode 由调用方注入（模式持久化留在 SessionList，目录模式开合集 dirClosed 与其联动）。
 * useProjectStore 为 pinia store 可在 composable 内直调。
 */
import { computed, nextTick, ref, type ComponentPublicInstance, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import { sessionsInRuntimeGroupOrder } from '@taiji/core'
import {
  collectNamedProjectIds,
  isDefaultProjectOf,
  sessionBelongsToProject,
} from '@/composables/logic/project-session'
import { useProjectStore } from '@/stores/project'

/** 项目分组视图模型：项目元信息 + 组内 cwd 目录切分（目录模式渲染源）+ 组内平铺序（平铺模式渲染源）。
 *  数据形状用 type（assign-targets.AssignTarget 同例）——非行为接口，无多实现演进面。 */
export type ProjectGroupVM = {
  id: string
  name: string
  isDefault: boolean
  dirs: SessionGroup[]
  items: SessionSummary[]
}

/** 侧栏会话列表展示模式（与 SessionList 的持久化模式同型） */
export type SidebarSessionMode = 'flat' | 'groups'

export function useProjectGroups(options: {
  /** 全量 cwd 分组（未预过滤——分组归属在本 composable 按项目切分） */
  groups: () => SessionGroup[]
  /** 展示模式（平铺 = 锚定聚焦 / 目录 = 浏览态，决定组头点击语义） */
  mode: Ref<SidebarSessionMode>
  /** 组头「+」落点后进入空态新建（SessionList 向上 emit newSession） */
  onNewSession: () => void
}) {
  const { groups, mode, onNewSession } = options
  const { t } = useI18n()
  const projectStore = useProjectStore()

  /**
   * 项目分组列表（R6.2 锚定分组核心派生）：每个 session 恰好落在一个分组，全部项目
   * 并列可见；目录切分保持 runtime cwd 组序（不重排、不归并——多项目同名目录各自展示，
   * 跨项目归并见 spec sidebar §6 待裁决）。
   */
  const projectGroups = computed<ProjectGroupVM[]>(() => {
    const namedIds = collectNamedProjectIds(projectStore.projects)
    return projectStore.orderedProjects.map((p) => {
      const isDefault = isDefaultProjectOf(p)
      const dirs = groups()
        .map((g) => ({
          cwd: g.cwd,
          sessions: g.sessions.filter((s) => sessionBelongsToProject(s, p.id, isDefault, namedIds)),
        }))
        .filter((g) => g.sessions.length > 0)
      return {
        id: p.id,
        name: p.name || t('sidebar.projectGroup.defaultName'),
        isDefault,
        dirs,
        items: sessionsInRuntimeGroupOrder(dirs),
      }
    })
  })

  /** 全部 session 总数（区头计数，demo .sess-head .count = 全量口径，跨组汇总） */
  const totalCount = computed(() =>
    groups().reduce((sum, g) => sum + g.sessions.length, 0),
  )

  // ── 锚定分组交互（方案 A：显式锚定 + 零隐式行为）──

  /** 平铺模式当前组展开态（内存态；切换锚定/新建落点时重置为展开） */
  const curOpen = ref(true)

  /** 目录模式「被手动收起的组 id」集合（空集 = 全开，新增项目天然展开）；组头只开合、不切换锚定 */
  const dirClosed = ref(new Set<string>())

  /** 组头点击（父级按模式裁决，demo onGroupHead/onGroupHeadDir 同构） */
  function onGroupHeadClick(pg: ProjectGroupVM): void {
    if (mode.value === 'flat') {
      if (pg.id === projectStore.activeProjectId) {
        curOpen.value = !curOpen.value
        return
      }
      projectStore.setActiveProject(pg.id)
      curOpen.value = true
      return
    }
    const next = new Set(dirClosed.value)
    if (next.has(pg.id)) next.delete(pg.id)
    else next.add(pg.id)
    dirClosed.value = next
  }

  /** 组头「+」：先落点该项目（新会话归属读 activeProjectId）再进空态新建 */
  function onCreateTaskIn(pg: ProjectGroupVM): void {
    projectStore.setActiveProject(pg.id)
    curOpen.value = true
    onNewSession()
  }

  // ── 项目重命名（ProjectGroup 行内输入）/ 删除（二次确认）──

  const deleteOpen = ref(false)
  const pendingDelete = ref<ProjectGroupVM | null>(null)

  function requestDelete(pg: ProjectGroupVM): void {
    pendingDelete.value = pg
    deleteOpen.value = true
  }

  function confirmDelete(): void {
    if (pendingDelete.value) projectStore.removeProject(pendingDelete.value.id)
    pendingDelete.value = null
    deleteOpen.value = false
    // 删除当前项目后锚定回落（store 回落默认项目），展开让归回的会话直接可见（spec sidebar §3.7）
    curOpen.value = true
  }

  /** 组头行内重命名提交（ProjectGroup 已做空名守卫，store 层再守卫默认项目/未知 id） */
  function onRenameCommit(pg: ProjectGroupVM, name: string): void {
    projectStore.renameProject(pg.id, name)
  }

  // ── 新建项目（区头「+」入口，用户裁决 2026-10-11：点击后列表顶部出现草稿输入行）──

  const creating = ref(false)
  const draft = ref('')
  const createInputRef = ref<ComponentPublicInstance | null>(null)

  function startCreate(): void {
    if (creating.value) {
      // 草稿行已开着：二次点击只回焦输入框，不重置已输入内容
      const el = createInputRef.value?.$el
      if (el instanceof HTMLInputElement) el.focus()
      return
    }
    creating.value = true
    draft.value = ''
    nextTick(() => {
      // Input 组件根元素是 <input>，template ref 拿到组件实例，$el 是 input DOM
      const el = createInputRef.value?.$el
      if (el instanceof HTMLInputElement) el.focus()
    })
  }

  /** 提交草稿：非空名创建并锚定展开（addProject 内部锚定新项目）；空名 = 丢弃草稿不创建 */
  function commitCreate(): void {
    const name = draft.value.trim()
    if (name) {
      projectStore.addProject(name)
      curOpen.value = true
    }
    creating.value = false
    draft.value = ''
  }

  /** 失焦提交（草稿行无浮层后「点外」无统一关闭路径，失焦即落编辑结果；Esc 先清 creating，
   *  随后的 blur 命中 creating=false 守卫无副作用） */
  function onDraftBlur(): void {
    if (creating.value) commitCreate()
  }

  function cancelCreate(): void {
    creating.value = false
    draft.value = ''
  }

  return {
    projectGroups,
    totalCount,
    curOpen,
    dirClosed,
    onGroupHeadClick,
    onCreateTaskIn,
    deleteOpen,
    pendingDelete,
    requestDelete,
    confirmDelete,
    onRenameCommit,
    creating,
    draft,
    createInputRef,
    startCreate,
    commitCreate,
    onDraftBlur,
    cancelCreate,
  }
}
