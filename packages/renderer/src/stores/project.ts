/**
 * Project store —— v6 D14 Project 一级导航的状态层（R6.2 锚定分组语义保留）。
 *
 * connection-datasync-ssot §6.5/§6.6/§6.9 改造：本 store 从「权威内存」降为 runtime
 * projects.json 的**缓存视图**——
 * - 加载走 4 值状态机 idle/loading/loaded/failed（§6.5 转移表见 transition()；loaded 态
 *   单条命令失败不改状态机，内存保持命令前状态）；另有 loadAbandoned 出口（loading→
 *   发起前状态，被丢弃尝试的收尾——域同步器判旧丢弃不经 store，残留 loading 由下一轮
 *   syncLoad 入口回滚，丢弃点补发轮才可达）；failed 态禁止一切回写（RD-3#3 语义
 *   保留并扩展为「无有效数据形态禁命令」，§6.9）。
 * - 编辑动作命令化（§6.6）：createProject/renameProject/removeProject/setActiveProject
 *   发 project.* 命令、以回执更新本地视图；同窗口命令**串行排队**（上一条回执到达后才
 *   发下一条——独立排队语义，非域同步器的并发合流），消除同窗口快速连续操作的版本竞争。
 * - revision 跟随回执更新（load 回执学得水位、命令回执推进），对域同步器暴露
 *   isStaleLoadReceipt 判据（§6.4 命令×同步交错裁决的输入）。
 * - 归一化（默认项补插 + stale id 回退）已迁 runtime 权威侧（§6.6①，load 回执即归一化
 *   视图）；legacy localStorage 一次性迁移已删除（旧通道整表写与缓存视图矛盾，§6.6②）。
 *
 * 关系模型（SSOT 见 shared/project.ts + docs/architecture/project-session-model.md）：
 * Project 直接关联 Session（session.projectId，创建时归属，runtime sidecar 持久化）。
 * 本 store 只管 project 列表本身，**不持有** session 归属（无 workspaces 字段——
 * cwd 只是前端展示聚合，不是模型层级）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Project, ProjectCommandReply, ProjectLoadReply } from '@taiji/shared'
import { project as projectApi } from '@/api'
import { isDefaultProjectOf } from '@/composables/logic/project-session'
import i18n from '@/i18n'
import { useToast } from '@/composables/useToast'

export const DEFAULT_PROJECT_ID = 'proj-default'

/** project 加载状态机 4 值词表（§6.5：idle 初始未加载 / loading 在途 / loaded 成功 / failed 失败）。 */
export type ProjectLoadState = 'idle' | 'loading' | 'loaded' | 'failed'

/**
 * 加载状态机的领域事件（转移唯一入参，§6.5 转移表）：
 * - loadStarted：idle→loading（首次同步）/ failed→loading（重试或连接边沿）/
 *   loaded→loading（重连边沿重拉，不丢已持有数据——呈现语义见 §6.7 重拉子形态）；
 *   loading 态重入 = 表外转移（域同步器并发合流保证正常路径不发生），warn 不动作。
 * - loadSucceeded：loading→loaded（提交回执整表 + revision 水位；stale 回执由域同步器
 *   交错裁决拦截，不进本转移）。
 * - loadFailed：loading→failed（RPC 拒绝 / 兜底超时 / 错误信封三类失败，原因入 loadError）。
 * - loadAbandoned：loading→发起前状态（被丢弃尝试的收尾，放弃在途）——域同步器判旧
 *   丢弃回执（旧连接代 / 过时 revision）的路径不经本 store（loadSucceeded/loadFailed
 *   均不触发），loading 会残留；下一轮 syncLoad 入口先经本转移回滚，丢弃点补发轮才
 *   可达（否则补发轮恒被重入守卫拒绝，project 域重拉能力永久失效）。仅回滚加载状态，
 *   不动数据与 revision（丢弃 = 本轮回执不提交，非失败）。
 * - commandApplied：命令回执提交（仅更新数据视图与 revision，不改加载状态机——命令按
 *   editingEnabled 判据被接受（loaded 或重拉子形态，§6.9），单条命令失败即无回执、
 *   内存保持命令前状态）。
 */
type ProjectLoadEvent =
  | { type: 'loadStarted' }
  | { type: 'loadSucceeded'; receipt: ProjectLoadReply }
  | { type: 'loadFailed'; error: unknown }
  | { type: 'loadAbandoned' }
  | { type: 'commandApplied'; reply: ProjectCommandReply }

/** 默认 project 工厂（name 空 = 未命名默认项目，未归类 session 的兜底聚合）。 */
function makeDefaultProject(): Project {
  return { id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 }
}

export const useProjectStore = defineStore('project', () => {
  // 缓存视图初值：默认 project 兜底（idle 窗口的 orderedProjects 消费方不空）；initApp
  // 等 project 域首次落定后才进落地页（§6.4②），正常路径下首个回执很快替换本初值。
  const projects = ref<Project[]>([makeDefaultProject()])
  const activeProjectId = ref<string>(DEFAULT_PROJECT_ID)

  /** 加载状态机当前态（4 值，§6.5）。 */
  const loadState = ref<ProjectLoadState>('idle')
  /** loadState='failed' 时的失败原因（失败状态条展示用；重拉/重试成功后清空）。 */
  const loadError = ref<string>('')
  /**
   * 已提交的 revision 水位（文件写入代数）：load 回执学得、命令回执推进；null = 从未
   * 收到过任何回执（无期望 revision 可携带，命令注定被 runtime 拒绝——§6.9「无有效
   * 数据形态」判据输入，也是 §6.7 重拉子形态判据：loading 且非 null = 持有最后已知回执）。
   */
  const revision = ref<number | null>(null)

  // ── 状态机（§6.5 转移表唯一执行体；表外转移 warn 不动作，正常路径由域同步器合流保证不发生）──

  /**
   * 进入 loading 前的状态（loadAbandoned 的回退目标）：loading 只经 loadStarted 进入，
   * 该值在进入时捕获即恒与当前在途尝试对应。
   */
  let stateBeforeLoading: ProjectLoadState = 'idle'

  function transition(event: ProjectLoadEvent): void {
    switch (event.type) {
      case 'loadStarted':
        if (loadState.value === 'loading') {
          console.warn('[project-store] loadStarted while loading — ignored (sync coalescing owns in-flight uniqueness)')
          return
        }
        stateBeforeLoading = loadState.value
        loadState.value = 'loading'
        return
      case 'loadSucceeded':
        if (loadState.value !== 'loading') {
          console.warn(`[project-store] loadSucceeded in state=${loadState.value} — ignored (out-of-table transition)`)
          return
        }
        projects.value = event.receipt.projects
        activeProjectId.value = event.receipt.activeProjectId || DEFAULT_PROJECT_ID
        revision.value = event.receipt.revision
        loadState.value = 'loaded'
        loadError.value = ''
        return
      case 'loadFailed':
        if (loadState.value !== 'loading') {
          console.warn(`[project-store] loadFailed in state=${loadState.value} — ignored (out-of-table transition)`)
          return
        }
        loadState.value = 'failed'
        loadError.value = event.error instanceof Error ? event.error.message : String(event.error)
        console.warn('[project-store] project load failed — sidebar shows failure bar; retry via connection edge or manual retry', event.error)
        return
      case 'loadAbandoned':
        if (loadState.value !== 'loading') {
          console.warn(`[project-store] loadAbandoned in state=${loadState.value} — ignored (out-of-table transition)`)
          return
        }
        loadState.value = stateBeforeLoading
        return
      case 'commandApplied':
        // 命令回执只更新数据视图与水位，不改加载状态机（§6.5：loaded 态命令失败不改状态机；
        // 成功同理——命令通道与加载通道正交）。守卫 = 命令按 editingEnabled 判据被接受
        // （loaded 或重拉子形态，§6.9，runCommand）。
        projects.value = event.reply.state.projects
        activeProjectId.value = event.reply.state.activeProjectId || DEFAULT_PROJECT_ID
        revision.value = event.reply.revision
        return
    }
  }

  /**
   * 本 store 自身 load RPC 是否在途：区分 loading 态的两种重入形态——真重入（上一轮
   * RPC 还在途，拒绝）与残留 loading（上一轮回执被域同步器判旧丢弃，丢弃路径不经本
   * store、RPC 已落定，放行并先收尾）。域同步器在丢弃点立即补发（connection-edge-sync
   * 丢弃分支），补发轮对本函数的调用即触发收尾，故 store 侧无需机制回调。
   */
  let loadRpcPending = false

  /**
   * 发起一轮 project 域同步拉取（域同步器 descriptor.sync 的接线形态）：进入 loading、
   * 拉取回执；失败转 failed 后把错误 rethrow 交域同步器按 failure='blocking' 留痕——
   * 失败呈现走本状态机（侧栏失败状态条），本函数不自建重试（重试通道 = 连接边沿或
   * 手动重试钮，均经域同步器 requestDomainSync('project')，ADR-0097 事实驱动）。
   * loading 态重入分两型：RPC 仍在途 = 绕过域同步器并发合流的装配错误（表外转移
   * fail-fast，不静默吞），拒绝拉取，防同一窗口出现重复在途加载；RPC 已落定 = 上一轮
   * 回执被判旧丢弃的残留 loading，先经 loadAbandoned 回滚到发起前状态再重新 loadStarted
   * （丢弃点补发轮由此可达，回执/丢弃/补发三代语义收敛不变）。
   */
  async function syncLoad(): Promise<ProjectLoadReply> {
    if (loadState.value === 'loading') {
      if (loadRpcPending) {
        throw new Error('[project-store] syncLoad re-entered while loading — load attempts must go through connection-edge-sync coalescing (requestDomainSync)')
      }
      transition({ type: 'loadAbandoned' })
    }
    transition({ type: 'loadStarted' })
    loadRpcPending = true
    try {
      return await projectApi.load()
    } catch (e) {
      transition({ type: 'loadFailed', error: e })
      throw e
    } finally {
      loadRpcPending = false
    }
  }

  /** 拦截型提交（域同步器代次/revision 裁决通过后调用）：loading→loaded，回执整表替换。 */
  function applyLoadReceipt(receipt: ProjectLoadReply): void {
    transition({ type: 'loadSucceeded', receipt })
  }

  /**
   * 命令×同步交错判据（§6.4，知识与决策同地）：回执 revision 早于本地已提交水位 =
   * 在途 load 期间有命令回执提交过，该回执是命令执行前旧快照——域同步器按过时内容
   * 丢弃并在丢弃点补发。null 水位（从未读过）恒不判旧。
   */
  function isStaleLoadReceipt(receipt: ProjectLoadReply): boolean {
    return revision.value !== null && receipt.revision < revision.value
  }

  /**
   * 重拉子形态判据（§6.7）：loading 态且已持有上一轮回执数据 = loaded→loading 的重连
   * 边沿重拉——分组区保留最后已知分组渲染，不闪加载占位。
   */
  const hasReceivedReceipt = computed(() => revision.value !== null)

  /**
   * 编辑入口可用性（§6.9）：loaded 恒可用；重拉子形态（loading + 已持有回执）不禁用
   * ——命令化后编辑正确性由 runtime revision 校验与串行排队保证，且重拉是读操作不改
   * revision，窗口内发命令携带的 revision 恒匹配；无有效数据形态（idle / 从未成功的
   * loading / failed）禁用——无回执则期望 revision 缺失，发命令注定被拒，入口禁用把
   * 注定失败的交互挡在前面。
   */
  const editingEnabled = computed(() => loadState.value === 'loaded' || (loadState.value === 'loading' && revision.value !== null))

  /** 当前活跃 project（id 失配时回退首个，保证非空——显示层防御，权威侧归一化已保证不变量） */
  const activeProject = computed<Project>(
    () => projects.value.find((p) => p.id === activeProjectId.value) ?? projects.value[0],
  )

  /** 默认 project 判定（name 空 = 未命名默认 project）。默认项目是未归类 session 的兜底聚合。 */
  const isDefaultProject = computed(() => !activeProject.value.name)

  /**
   * 项目分组渲染序（R6.2 锚定分组，侧栏会话列表组序 SSOT；消费方 = SessionList 组列表
   * + ImportSessionDialog 目标下拉——两处同序，下拉顺序与列表组序一致）。
   *
   * 排序规则（用户裁决 2026-10-11「顺序稳定不置顶」）：
   *  1. 默认项目（nameless）固定最后——未归类/孤儿 session 的兜底聚合恒在列表尾部；
   *  2. 其余按 lastUsedAt 倒序（该字段仅创建时写入，见 shared/project.ts——因此组位置
   *     对切换/使用动作完全稳定，锚定切换只改变展开态不重排）；
   *  3. 同值用持久化序（原数组 index）稳定 tiebreaker（ES2019+ sort 稳定，此处显式化）。
   */
  const orderedProjects = computed<Project[]>(() => {
    const indexed = projects.value.map((p, i) => ({ p, i }))
    indexed.sort((a, b) => {
      const ad = isDefaultProjectOf(a.p)
      const bd = isDefaultProjectOf(b.p)
      if (ad !== bd) return ad ? 1 : -1
      if (a.p.lastUsedAt !== b.p.lastUsedAt) return b.p.lastUsedAt - a.p.lastUsedAt
      return a.i - b.i
    })
    return indexed.map((x) => x.p)
  })

  // ── 编辑动作命令化（§6.6：同窗口命令串行排队，回执驱动更新）──

  /**
   * 串行队列（§6.6「上一条回执到达后才发下一条」）：链式 promise，前一条 settle 后才
   * 执行下一条——独立排队语义，非域同步器的并发合流（排队 = 命令逐条串行发送，合流 =
   * 同域在途加载去重不重复发）。前一条失败不阻塞后一条（catch 保链）。
   */
  let commandChain: Promise<unknown> = Promise.resolve()

  function enqueueCommand(op: () => Promise<void>): Promise<void> {
    const run = commandChain.then(op, op)
    commandChain = run.catch(() => {})
    return run
  }

  /**
   * 命令公共编排：守卫判据与 editingEnabled **同源**（§6.9——入口可用性与命令可执行性
   * 同一判据，杜绝「入口可用但命令必被拒」形态）——loaded 恒可执行；重拉子形态
   * （loading + 已持有回执）同样放行：重拉是读操作不改 revision，窗口内命令携带的
   * revision 恒匹配，正确性由 runtime revision 校验与串行排队保证；无有效数据形态
   * （idle / 从未成功的 loading / failed）入队时快速反馈拒绝——无回执则期望 revision
   * 缺失，发命令注定被拒，store 层保底，主防线是入口禁用。→ 排队串行 → **执行时**读取
   * 最新水位发命令（快照不在入队时取——前一条命令回执在排队窗口内推进水位，后者必须
   * 携带推进后的值，否则同窗口快速连续操作正是 §6.6 要消除的版本竞争）→ 成功以回执
   * 提交（transition commandApplied）；失败 toast 出声 + 内存保持命令前状态（命令
   * 失败不改加载状态机，§6.5）+ rethrow（调用方按需感知成败，如「先锚定后建」
   * 时序依赖锚定回执落定）。
   */
  function runCommand(op: (expectedRevision: number) => Promise<ProjectCommandReply>): Promise<void> {
    if (!editingEnabled.value) {
      return Promise.reject(new Error(`project data not loaded (state=${loadState.value}) — editing disabled until first successful load`))
    }
    return enqueueCommand(async () => {
      // 执行时二次守卫：排队等待期间状态可能被同步链改写（如 load 失败转 failed），
      // 此时发命令注定被拒且 revision 语义失效——按无有效数据形态拒绝。
      const expectedRevision = revision.value
      if (!editingEnabled.value || expectedRevision === null) {
        throw new Error(`project data not loaded (state=${loadState.value}) before command execution — retry after reload`)
      }
      try {
        const reply = await op(expectedRevision)
        transition({ type: 'commandApplied', reply })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        useToast().error(i18n.global.t('sidebar.projectCommandFailed', { msg }))
        throw e
      }
    })
  }

  /**
   * 新建 project（runtime 生成 id 并设为活跃；空名不动作——与旧本地版守卫同语义，
   * 把空名挡在命令之前）。resolve = 回执已提交（activeProjectId 已指向新项目）。
   */
  async function addProject(name: string): Promise<void> {
    if (!name.trim()) return
    await runCommand((revision) => projectApi.createProject(name.trim(), revision))
  }

  /**
   * 重命名 project。空名 / 默认项目（nameless 身份 = 未归类聚合判据）/ 未知 id 不动作
   * （与 runtime 侧拒绝双保险；把注定被拒的命令挡在前面）。
   */
  async function renameProject(id: string, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return
    const target = projects.value.find((p) => p.id === id)
    if (!target || isDefaultProjectOf(target)) return
    await runCommand((revision) => projectApi.renameProject(id, trimmed, revision))
  }

  /**
   * 删除 project。默认项目（DEFAULT_PROJECT_ID）不可删（review MF-1：未归类/孤儿 session
   * 的兜底聚合，无重建路径）、保底不删最后一个（UI 永远有项可显）——均与 runtime 侧
   * 拒绝双保险。删除不影响已归属该 project 的 session（展示层落入默认项目聚合）。
   */
  async function removeProject(id: string): Promise<void> {
    if (id === DEFAULT_PROJECT_ID) return
    if (projects.value.length <= 1) return
    await runCommand((revision) => projectApi.removeProject(id, revision))
  }

  /**
   * 锚定切换（不更新 lastUsedAt：该字段是分组排序键且仅创建时写入——切换锚定若留痕会
   * 把被点组顶到最前，违反「顺序稳定不置顶」裁决 R6.2；runtime 侧同语义）。未知 id 不动作。
   */
  async function setActiveProject(id: string): Promise<void> {
    if (!projects.value.some((p) => p.id === id)) return
    await runCommand((revision) => projectApi.setActiveProject(id, revision))
  }

  return {
    projects,
    activeProjectId,
    activeProject,
    isDefaultProject,
    orderedProjects,
    loadState,
    loadError,
    revision,
    hasReceivedReceipt,
    editingEnabled,
    syncLoad,
    applyLoadReceipt,
    isStaleLoadReceipt,
    addProject,
    setActiveProject,
    renameProject,
    removeProject,
  }
})
