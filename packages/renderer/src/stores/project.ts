/**
 * Project store —— v6 D14 Project 一级导航的状态层（2026-08-04 语义修正 + 持久化迁移）。
 *
 * 职责：Project CRUD + activeProjectId 切换 + runtime 持久化（projects.json）。
 *
 * 关系模型（SSOT 见 shared/project.ts + docs/architecture/project-session-model.md）：
 * Project 直接关联 Session（session.projectId，创建时归属，runtime sidecar 持久化）。
 * 本 store 只管 project 列表本身，**不持有** session 归属（无 workspaces 字段——
 * cwd 只是前端展示聚合，不是模型层级）。
 *
 * 持久化（2026-08-04 迁 runtime）：runtime `<configDir>/projects.json`（WriteBackCache
 * debounce 落盘，跨实例一致）。localStorage 仅作首启迁移源（一次读取后废弃，不再写入）。
 *
 * 历史：
 * - 2026-08-04 前：Project.workspaces[]（目录集合）+ localStorage 持久化——两者均已废弃
 *   （workspace 是展示概念不该进模型；project 列表应与 session 归属同层持久化）。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { Project, ProjectStoreState } from '@taiji/shared'
import { project as projectApi } from '@/api'

export const STORAGE_KEY = 'taiji:projects'
export const DEFAULT_PROJECT_ID = 'proj-default'

/** 同毫秒内多次 addProject 的 id 去重（模块级自增，避免 Date.now() 碰撞）。 */
let projectSeq = 0

/** 默认 project 工厂（name 空 = 未命名默认项目，未归类 session 的兜底聚合）。 */
function makeDefaultProject(): Project {
  return { id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 }
}

/**
 * 从 localStorage 读取旧数据（2026-08-04 前持久化层，仅首启迁移源）。
 * 兼容：剥离旧 workspaces 字段、lastUsedAt 补 0。损坏/空 → null。
 */
function loadLegacyFromStorage(): ProjectStoreState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ProjectStoreState
    if (!Array.isArray(parsed.projects) || parsed.projects.length === 0) return null
    return {
      projects: parsed.projects.map((p) => {
        const { workspaces: _legacy, ...rest } = p as Project & { workspaces?: unknown[] }
        return { ...rest, lastUsedAt: rest.lastUsedAt ?? 0 }
      }),
      activeProjectId: parsed.activeProjectId,
    }
  } catch (e) {
    console.warn('[project-store] failed to parse legacy localStorage projects, ignoring', e)
    return null
  }
}

export const useProjectStore = defineStore('project', () => {
  // 同步初始态：默认 project 兜底（UI 永不空态）；init() RPC 加载后替换。
  const projects = ref<Project[]>([makeDefaultProject()])
  const activeProjectId = ref<string>(DEFAULT_PROJECT_ID)

  /**
   * 启动加载结果（RD-3#3 / 审计 M4 族：真实读失败与「无数据」不可区分 → deep watch 全量
   * save 整表覆写 projects.json）。'failed' 时本 store 只读降级：所有变化不落盘（见 watch
   * 回调 early-return），UI 可据 loadError + 重试（重新执行 init）恢复——runtime 恢复后
   * init 成功即回到 'loaded'，落盘随之恢复。
   */
  const loadState = ref<'loaded' | 'failed'>('loaded')
  /** loadState='failed' 时的失败原因（错误条展示用；重试成功后清空）。 */
  const loadError = ref<string>('')

  /** failed 态下「改动不会落盘」只 warn 一次（防每次操作刷屏）。 */
  let saveBlockedWarned = false

  /** 当前活跃 project（id 失配时回退首个，保证非空） */
  const activeProject = computed<Project>(
    () => projects.value.find((p) => p.id === activeProjectId.value) ?? projects.value[0],
  )

  /** 默认 project 判定（name 空 = 未命名默认 project）。默认项目是未归类 session 的兜底聚合。 */
  const isDefaultProject = computed(() => !activeProject.value.name)

  /**
   * Project 列表渲染序（供 ProjectSwitcher 网格渲染，D7；名字沿用历史——曾按最近使用
   * 排序，2026-09-02 起语义修正为「顺序完全由用户控制」）。
   *
   * 排序规则（任何自动因素不参与，active 置顶 / lastUsedAt 均已移除）：
   *  1. 有 userOrder：按 userOrder 升序排前段——拖拽意图跨重启稳定；
   *  2. 无 userOrder：按原数组顺序（projects.json 持久化序 / 创建序）稳定排后段——
   *     新建项目 push 数组尾自然落在末尾。
   * setActiveProject 只更新 lastUsedAt 留痕，不改变列表顺序（切换 ≠ 排序意图，点击
   * 任何项目顺序均不变）；首次拖拽后 reorderProject 全量重编号，整表顺序固化。
   * 默认项目（isDefault）同卡同权参与排序，无特殊待遇。
   */
  const recentProjects = computed<Project[]>(() => {
    // userOrder 升序；未排序项视为 +∞ 殿后；同值（外部脏数据 / 同为 ∞）用原数组
    // index 做稳定 tiebreaker
    const indexed = projects.value.map((p, i) => ({ p, i }))
    indexed.sort((a, b) => {
      const ao = a.p.userOrder ?? Number.MAX_SAFE_INTEGER
      const bo = b.p.userOrder ?? Number.MAX_SAFE_INTEGER
      return ao !== bo ? ao - bo : a.i - b.i
    })
    return indexed.map((x) => x.p)
  })

  /**
   * 运行时持久化（2026-08-04 迁 runtime projects.json）：deep watch 变化 → 全量 RPC save。
   * runtime WriteBackCache debounce 落盘；RPC 失败降级静默（下次变化重试）。
   * 初始化 watch 不触发（无 immediate），首启迁移由 init() 显式 save。
   *
   * [Q1-9 评估结论] deep 必须保留：写点存在原地变更（addProject push / removeProject splice /
   * normalizeLoadedProjects unshift / setActiveProject 嵌套 lastUsedAt 赋值），改浅 watch 会漏
   * 持久化（如删除非活跃项目时 activeProjectId 不变、数组引用不变 → 不触发 save → 重启后删除丢失）。
   * 改浅的前提是全部写点先改为不可变替换（projects.value = [...]），不属于本次优化范围。
   */
  watch(
    [projects, activeProjectId],
    () => {
      // 读失败禁回写（RD-3#3）：load 失败时内存态是默认兜底而非 projects.json 权威数据，
      // 全量 save 会把真实数据整表覆盖。禁止落盘直到 init 重试成功（loadState 回 'loaded'）。
      if (loadState.value === 'failed') {
        if (!saveBlockedWarned) {
          saveBlockedWarned = true
          console.warn(
            `[project-store] projects.json 加载失败（${loadError.value || 'unknown error'}），` +
              '当前改动不会落盘（防整表覆盖真实数据）；runtime 恢复后重新执行 init() 即恢复落盘',
          )
        }
        return
      }
      const state: ProjectStoreState = {
        projects: projects.value,
        activeProjectId: activeProjectId.value,
      }
      void projectApi.save(state).catch(() => {
        console.warn('[project-store] save failed, will retry on next change')
      })
    },
    { deep: true },
  )

  /**
   * 归一化（[review MF-2] 存在性校验）：init() 加载数据后校验一致性，必须在 deep watch save
   * 触发前同步完成（init 内无后续 await，watcher flush 见到的即归一化后状态）——否则 stale id
   * 被持久化回 projects.json，重启后 bug 依旧。
   * ① activeProjectId 失配（legacy 迁移残留 / projects.json 被外部编辑或跨实例残留，指向已删除
   *    项目）→ 回退：nameless 默认项 → 首个 → DEFAULT_PROJECT_ID。失配时 SessionList 过滤与
   *    recentProjects 高亮消费原始 id，activeProject computed 兜底只覆盖显示层 → 会话列表空态
   *    + 默认聚合进不去，且无自动恢复路径。
   * ② nameless 默认项缺失（legacy/外部数据）→ 补插 makeDefaultProject()：默认项目是未归类/孤儿
   *    session 的兜底聚合，缺失则默认项目视图永久不可达（makeDefaultProject 仅初始态，init 整体替换）。
   * 合法数据（id 命中、默认项存在）原样保留，不覆盖 runtime 权威。
   */
  function normalizeLoadedProjects(): void {
    // ① 默认项目占用检查（[review S-1]）：按 id 判占用而非按 nameless——外部编辑把默认项改名
    //    （name 非空）时旧条件会 unshift 第二个同 id 项（重复 id 被 deep watch 全量持久化，
    //    recentProjects 的 filter/find 语义错乱）。id 占用即默认项存在，改名不触发补插。
    //    注：默认项被改名后不再 nameless，下方 stale-id 回退链 find(p=>!p.name) 会落到
    //    projects[0]（已收录在回退链「首个」档），行为可接受。
    if (!projects.value.some((p) => p.id === DEFAULT_PROJECT_ID)) {
      projects.value.unshift(makeDefaultProject())
    }
    if (!projects.value.some((p) => p.id === activeProjectId.value)) {
      activeProjectId.value =
        projects.value.find((p) => !p.name)?.id ?? projects.value[0]?.id ?? DEFAULT_PROJECT_ID
    }
  }

  /**
   * 启动加载（initApp 调用，必须在 newSession 之前——create 归属读 activeProjectId）。
   * 优先级：runtime projects.json → 旧 localStorage（一次性迁移）→ 默认 project。
   * RPC 失败（RD-3#3）：置 loadState='failed' 后直接返回——不走 legacy 迁移（迁移的显式
   * save 会以迁移数据覆写可能完好的 projects.json），不阻断启动；重试 = 重新执行 init。
   */
  async function init(): Promise<void> {
    try {
      const state = await projectApi.load()
      loadState.value = 'loaded'
      loadError.value = ''
      saveBlockedWarned = false // 重试成功：若再次失败，blocked warn 重新可提示一次
      if (state.projects.length > 0) {
        // runtime 权威：直接用（含 activeProjectId）；id 失配/默认项缺失由归一化修复
        projects.value = state.projects
        if (state.activeProjectId) activeProjectId.value = state.activeProjectId
        normalizeLoadedProjects()
        return
      }
    } catch (e) {
      // RPC 失败（runtime 未就绪/首启竞态）→ 只读降级：内存保持默认兜底、禁一切落盘
      //（此前回落默认后被 deep watch 全量 save 整表覆盖 projects.json，读失败与首启不可分）
      loadState.value = 'failed'
      loadError.value = e instanceof Error ? e.message : String(e)
      console.warn('[project-store] load failed, write-back disabled until init retry succeeds', e)
      return
    }
    // runtime 空（首启，RPC 成功）：localStorage 一次性迁移（有则用之 + 写回 runtime；无则默认）
    const legacy = loadLegacyFromStorage()
    if (legacy) {
      projects.value = legacy.projects
      activeProjectId.value = legacy.activeProjectId || DEFAULT_PROJECT_ID
      // 归一化先于显式 save：迁移落盘即归一化状态（stale id 不持久化）
      normalizeLoadedProjects()
      void projectApi
        .save({ projects: projects.value, activeProjectId: activeProjectId.value })
        .catch((e: unknown) => {
          // 迁移写回失败需留痕（此前空吞）：迁移数据仍在 localStorage，下次 init 空表时重试
          console.warn('[project-store] legacy migration save failed, will retry on next init/change', e)
        })
    }
  }

  function setActiveProject(id: string): void {
    const target = projects.value.find((p) => p.id === id)
    if (target) {
      // 切换即「最近使用」：lastUsedAt 仅作持久化留痕，不驱动列表排序（点击不改顺序，
      // deep watch 照常触发 save）
      target.lastUsedAt = Date.now()
      activeProjectId.value = id
    }
  }

  /** 新建 project：生成 id、push、设为活跃。返回新 id；空名不创建。 */
  function addProject(name: string): string {
    const trimmed = name.trim()
    if (!trimmed) return activeProjectId.value
    projectSeq += 1
    const id = `proj-${Date.now()}-${projectSeq}`
    projects.value.push({ id, name: trimmed, lastUsedAt: Date.now() })
    activeProjectId.value = id
    return id
  }

  /**
   * 拖拽/键盘 reorder 提交（D7 赋号语义：drop 位置密集重排，ProjectSwitcher 拖拽与方向键
   * 共用此单一入口）。
   *
   * 算法：以 recentProjects 当前显示顺序为基准执行 splice（dragId 移到 targetId 位置），
   * 然后把 splice 后的完整显示序全量密集重编号 0..n-1 写回（review MF-12）——不做 midpoint
   * 稀疏编号，删除项目留下的空洞由下次 drop 自然消除。首次拖拽后整表顺序固化；
   * 后续新增项目（无 userOrder）按创建序落在末尾，直到再次拖拽。
   *
   * 推演（覆盖验收关键场景）：
   *  - 有序卡之间拖动：换位后整段重编 0..n-1；
   *  - 无序卡拖到任意位置（含首位/中间）：落点即位次，连同其余卡一起全量编号；
   *  - 全量定序保证显示序 ≡ splice 结果，无序卡被拖不再瞬移到网格边缘。
   * 持久化：deep watch 感知 userOrder 原地写 → 全量 RPC save，无需额外调用。
   */
  function reorderProject(dragId: string, targetId: string): void {
    if (!dragId || dragId === targetId) return
    const display = recentProjects.value
    const from = display.findIndex((p) => p.id === dragId)
    const to = display.findIndex((p) => p.id === targetId)
    if (from === -1 || to === -1) return
    const next = [...display]
    const [dragged] = next.splice(from, 1)
    // 插入位 = 移除后的 to：from>to（上移）时目标仍在 to，落目标前；from<to（下移）
    // 时目标已左移到 to-1，落 to 即目标后——键盘 ↑/↓ 的相邻交换两个方向都成立
    //（D↔E 互换语义对称），无需方向修正（曾试 `from<to?to:to-1`，to=0 时负索引 splice
    // 尾插致错序，见 review MF-12 回归）。
    next.splice(to, 0, dragged!)
    // 全量定序（review MF-12）：把 splice 后的完整显示序固化为用户序（0..n-1）。
    // 旧实现只 pin「旧有序段 ∪ 被拖卡」，无序卡片被拖时仅其自身获得 userOrder=0
    // → 渲染时瞬移到用户序段头部（[A,B,C,D,E] 上移 D 实际显示 [D,A,B,C,E]），
    // 且该错序被持久化。全量 pin 后显示序 ≡ splice 结果；后续新增项目（userOrder
    // null）按创建序排在末尾，语义不变。
    let order = 0
    for (const p of next) {
      projects.value.find((q) => q.id === p.id)!.userOrder = order
      order++
    }
  }

  /** 删除 project：移除；若删的是活跃则切到第一个；保底不删最后一个（UI 永远有项可显）。
   *  删除不影响已归属该 project 的 session（归属在 session sidecar，project 删除后这些
   *  session 在展示层落入默认项目聚合——projectId 匹配不到任何命名 project）。
   *  [MANDATORY] 默认项目（DEFAULT_PROJECT_ID）不可删除（review MF-1）：默认项目是未归类/孤儿
   *  session 的兜底聚合，删除后这些 session 在任何命名 project 过滤下都匹配不到 → SessionList 空态，
   *  且无重建路径（makeDefaultProject 仅初始态），归属无法修复。组件侧删除按钮亦对默认行不渲染（双保险）。 */
  function removeProject(id: string): void {
    if (id === DEFAULT_PROJECT_ID) return
    if (projects.value.length <= 1) return
    const idx = projects.value.findIndex((p) => p.id === id)
    if (idx === -1) return
    projects.value.splice(idx, 1)
    if (activeProjectId.value === id) {
      activeProjectId.value = projects.value[0]?.id ?? ''
    }
  }

  return { projects, activeProjectId, activeProject, isDefaultProject, recentProjects, loadState, loadError, init, setActiveProject, addProject, removeProject, reorderProject }
})
