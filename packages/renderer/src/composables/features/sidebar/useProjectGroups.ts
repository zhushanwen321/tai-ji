/**
 * useProjectGroups —— 侧栏项目锚定分组的派生与动作集合（R6.2，从 SessionList 提取）。
 *
 * 职责：项目分组视图模型（归属切分 + 组序 + 组内平铺序）、锚定交互（组头点击按模式
 * 裁决；平铺模式展开态按组独立记忆支持多项目同开——锚定只决定新会话归属与「当前」
 * chip，不再互斥收起其他组 / 组头「+」落点新建）、项目新建草稿流、行内重命名与删除
 * 确认的壳侧状态。
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
import { requestDomainSync, sessionsInRuntimeGroupOrder } from '@taiji/core'
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
   * 项目分组区呈现形态（connection-datasync-ssot §6.7 三形态，按「是否持有最后已知
   * 回执数据」降级）：
   * - 'failed'：project 加载失败——分组区整体替换为失败状态条（原因 + 重试钮）；
   * - 'loading'：无数据形态（idle，或从未成功加载过的 loading）——渲染加载占位行；
   * - 'groups'：loaded，或重拉子形态（loaded→loading 的重连边沿重拉，store 已持有
   *   上一轮回执的项目清单）——正常渲染分组。重拉子形态下 projects 保持最后已知值
   *   （回执未到不替换），下方切分结果自动等于最后已知分组——「保留最后已知分组、
   *   不闪占位」由缓存视图的更新时机构造性成立，无需额外缓存。
   * 「未分组/默认组」这个展示概念只在 loaded 态下由真实项目清单派生（无数据形态不把
   * 兜底默认表渲染成「只有一个空默认组」——本次事故的可见症状，§6.7 不采用段）。
   */
  const projectAreaMode = computed<'groups' | 'loading' | 'failed'>(() => {
    if (projectStore.loadState === 'failed') return 'failed'
    if (projectStore.hasReceivedReceipt) return 'groups'
    return 'loading'
  })

  /** 编辑入口可用性（§6.9：无有效数据形态禁用、重拉子形态不禁用）——store 判据透出。 */
  const editingEnabled = computed(() => projectStore.editingEnabled)

  /** 失败状态条重试钮：触发 project 域同步（域同步器编程入口，并发合流保证在途不重复发）。 */
  function retryProjectLoad(): void {
    requestDomainSync('project')
  }

  /**
   * 项目分组列表（R6.2 锚定分组核心派生）：每个 session 恰好落在一个分组，全部项目
   * 并列可见；目录切分保持 runtime cwd 组序（不重排、不归并——多项目同名目录各自展示，
   * 跨项目归并见 spec sidebar §6 待裁决）。
   *
   * 切分输入 = projectStore.projects（缓存视图）+ sessions（props 派生）。重拉子形态
   * 下 projects 未被替换（回执未到），切分结果即「最后已知分组」。
   *
   * §6.7 前置条件：项目切分仅在持有有效回执数据时执行（loaded，或 loaded→loading 的
   * 重拉子形态——判据即 projectAreaMode==='groups'）。无数据形态与 failed 态不派生
   * 项目分组：「未分组/默认组」这个展示概念只在 loaded 态由真实项目清单派生，不把
   * 兜底默认表（idle 初值）或上次已知表（failed 态保留在缓存视图里）渲染成分组——
   * 失败态由状态条整体替换项目分组区，会话本体照常呈现见 degradedZone。
   */
  const projectGroups = computed<ProjectGroupVM[]>(() => {
    if (projectAreaMode.value !== 'groups') return []
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

  /**
   * 降级形态的会话本体（§6.7「会话列表本体（目录/分组视图的 cwd 结构，来自 runtime
   * 会话清单）不受影响正常呈现」）：projectAreaMode !== 'groups' 时项目分组区由
   * ProjectLoadStatus（失败状态条 / 无数据加载占位行）替换，会话本体按 runtime 会话
   * 清单的 cwd 目录结构照常呈现。
   *
   * 与 projectGroups 的关键差异：不经项目切分——不渲染默认项目头行、不渲染兜底默认表，
   * 数据源只有 groups()（与 project 域正交，project 加载失败/在途都不影响它可取）。
   * 形状取 ProjectGroupVM 的渲染源子集（dirs / items），目录模式与平铺模式共用。
   */
  const degradedZone = computed<Pick<ProjectGroupVM, 'dirs' | 'items'> | null>(() => {
    if (projectAreaMode.value === 'groups') return null
    const dirs = groups().filter((g) => g.sessions.length > 0)
    return { dirs, items: sessionsInRuntimeGroupOrder(dirs) }
  })

  // ── 锚定分组交互（显式锚定 + 多开：展开态按组独立记忆，不与锚定互斥）──

  /** 平铺模式「被手动收起的组 id」集合（空集 = 全开，新增项目天然展开）。
   *  点锚定组头 = 翻转本组；点非锚定组头 = 切锚定并展开目标组，其余组保持自身开合态
   *  （多项目同时展开；锚定只决定新会话归属与「当前」chip，不再收起其他组）。 */
  const flatClosed = ref(new Set<string>())

  /** 目录模式「被手动收起的组 id」集合（空集 = 全开，新增项目天然展开）；组头只开合、不切换锚定 */
  const dirClosed = ref(new Set<string>())

  /** 从开合集移除单组（不可变替换触发响应，与 dirClosed 同范式） */
  function reopen(closed: Ref<Set<string>>, pgId: string): void {
    if (!closed.value.has(pgId)) return
    closed.value = new Set([...closed.value].filter((id) => id !== pgId))
  }

  /** 组头点击（父级按模式裁决，demo onGroupHead/onGroupHeadDir 同构）。
   *  锚定切换命令化（§6.6）：发命令、chip 跟随回执更新（本机毫秒级）；失败 toast 已由
   *  store 出声，此处吞掉 rejection（fire-and-forget 语义）。 */
  function onGroupHeadClick(pg: ProjectGroupVM): void {
    if (mode.value === 'flat') {
      if (pg.id === projectStore.activeProjectId) {
        const next = new Set(flatClosed.value)
        if (next.has(pg.id)) next.delete(pg.id)
        else next.add(pg.id)
        flatClosed.value = next
        return
      }
      void projectStore.setActiveProject(pg.id).catch(() => {})
      reopen(flatClosed, pg.id)
      return
    }
    const next = new Set(dirClosed.value)
    if (next.has(pg.id)) next.delete(pg.id)
    else next.add(pg.id)
    dirClosed.value = next
  }

  /** 组头「+」：先落点该项目（新会话归属读 activeProjectId）再进空态新建。
   *  「先锚定后建」时序在命令化下由回执承载（emit newSession 时刻 activeProjectId 必须
   *  已切换——归属预填读它）：await 锚定回执落定后才触发新建；锚定命令失败（revision
   *  失配被拒等，toast 已出声）不进新建流——落点语义无法保证，用户可直接重试。 */
  async function onCreateTaskIn(pg: ProjectGroupVM): Promise<void> {
    try {
      await projectStore.setActiveProject(pg.id)
    } catch {
      return
    }
    reopen(flatClosed, pg.id)
    onNewSession()
  }

  /** 强制展开某组（平铺/目录两套开合集都移除——拖拽落组后的展开保证，模式无关） */
  function expandGroup(pgId: string): void {
    reopen(flatClosed, pgId)
    reopen(dirClosed, pgId)
  }

  // ── 项目重命名（ProjectGroup 行内输入）/ 删除（二次确认）──

  const deleteOpen = ref(false)
  const pendingDelete = ref<ProjectGroupVM | null>(null)

  function requestDelete(pg: ProjectGroupVM): void {
    pendingDelete.value = pg
    deleteOpen.value = true
  }

  /** 删除确认（命令化：异步命令失败 toast 已由 store 出声，此处吞 rejection；归回的
   *  会话落默认项目区（恒展开可见，spec sidebar §3.7）——回执到达后分组视图自动更新，
   *  命名组开合记忆保留不动） */
  function confirmDelete(): void {
    if (pendingDelete.value) void projectStore.removeProject(pendingDelete.value.id).catch(() => {})
    pendingDelete.value = null
    deleteOpen.value = false
  }

  /** 组头行内重命名提交（ProjectGroup 已做空名检查，store 层再检查默认项目/未知 id；
   *  命令化：失败 toast 已由 store 出声，此处吞 rejection） */
  function onRenameCommit(pg: ProjectGroupVM, name: string): void {
    void projectStore.renameProject(pg.id, name).catch(() => {})
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

  /** 提交草稿：非空名发创建命令并关闭草稿行（回执到达后新项目锚定展开——命名组默认
   *  展开，新 id 不在收起集合；命令失败 toast 已由 store 出声，草稿行收起不重开）；
   *  空名 = 丢弃草稿不创建 */
  function commitCreate(): void {
    const name = draft.value.trim()
    if (name) void projectStore.addProject(name).catch(() => {})
    creating.value = false
    draft.value = ''
  }

  /** 失焦提交（草稿行无浮层后「点外」无统一关闭路径，失焦即落编辑结果；Esc 先清 creating，
   *  随后的 blur 命中 creating=false 检查无副作用） */
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
    projectAreaMode,
    degradedZone,
    editingEnabled,
    retryProjectLoad,
    flatClosed,
    dirClosed,
    expandGroup,
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
