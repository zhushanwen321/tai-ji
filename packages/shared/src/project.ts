/**
 * Project 数据模型（v6 D14：Project 一级导航，2026-08-04 语义修正）。
 *
 * ## 关系模型（重要，SSOT）
 *
 * ```
 * Project（用户逻辑分组，跨任意多个目录）
 *   └── 直接关联 Session（session.projectId，创建时归属）
 *
 * cwd（session 属性）→ 仅前端展示聚合（侧栏按目录分组），与 Project 无层级关系
 * ```
 *
 * - **Project**：用户管理的逻辑分组（如「多仓重构」「taiji-dev」）。一个 project
 *   可以跨多个目录做事——用户为了这个 project 服务，可以在任何目录下开 session。
 * - **Session**：关联主体。session 创建时归属当前 activeProject（`session.projectId`），
 *   与 session 的 cwd 无关。projectId 为空（历史 session / 未归类）在展示层归入
 *   默认项目（proj-default 兜底聚合）。
 * - **cwd 不是层级**：侧栏 session 列表按 cwd 分组只是前端展示聚合（SessionGroup 机制），
 *   不存在 Workspace 实体。~~Project → Workspace → Session 三层结构~~ 已废弃（2026-08-04
 *   语义修正：workspace 是展示概念，不该进模型）。
 *
 * 持久化：project 列表存 runtime projects.json（唯一权威持久化，runtime ProjectStore
 * 唯一读写入口含 revision 校验；legacy renderer localStorage 持久化已删除）；
 * session 归属存 runtime sidecar `<sessionFile>.project.json`（磁盘权威，删除 session
 * 归属自动消失，fork 继承父归属）。
 *
 * 历史背景：早期实现把 Workspace 物化成 Project.workspaces[]（目录集合）并用 cwd 匹配
 * 过滤 session，后按用户语义修正为 session 直接关联。教训：展示聚合概念不要物化成模型。
 */
export interface Project {
  id: string
  name: string
  /** 项目分组稳定排序键（ms）。0 = 未记录（稳定殿后，默认项目不受此影响——固定最后）。
   *
   * 字段名沿用 demo 与旧持久化（projects.json 零转换兼容），现行语义 = 仅 addProject
   * 新建时写入一次，此后不可变（R6.2 用户裁决 2026-10-11「顺序稳定不置顶」：锚定切换
   * 只改变展开态，不重排组位置，因此任何切换/使用动作都不得更新该字段）。
   * 存量数据带有的旧值（历史切换留痕）作为一次性初始排序键，稳定不变。 */
  lastUsedAt: number
}

/** project store 持久化结构（runtime projects.json，ProjectStore 唯一读写入口） */
export interface ProjectStoreState {
  projects: Project[]
  activeProjectId: string
}

/**
 * 默认项目 id（connection-datasync-ssot §6.6① 归一化迁 runtime 时上移的领域常量）：
 * nameless 默认项目 = 未归类/孤儿 session 的兜底聚合。消费方 = runtime ProjectStore
 * 归一化（默认项缺失补插 + activeProjectId 失配回退链终点）与 renderer project store
 * （本地导出随 u6b 收敛对齐此单一登记处）。跨包禁止手抄字面量。
 */
export const DEFAULT_PROJECT_ID = 'proj-default'
