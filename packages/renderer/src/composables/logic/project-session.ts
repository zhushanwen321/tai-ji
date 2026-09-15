/**
 * Project ↔ Session 归属判定与计数（纯函数，无 Vue 依赖）。
 *
 * 规则 SSOT：sessionBelongsToProject。两处消费同一规则，保证
 * 「徽章数字 = 点击该卡后 SessionList 实际显示的会话数」恒成立
 * （G3 / 设计 pi-evolution-consistency-and-project-switcher §3.2 badge 段）：
 *  - SessionList.visibleGroups：按 activeProject 过滤渲染（替换 2026-08-04 的内联三元）
 *  - ProjectSwitcher：per-project 徽章计数
 *
 * 判定语义（2026-08-04 D14 语义修正，提取自 SessionList 原内联实现）：
 *  - 命名 project：s.projectId === 该 project id
 *  - 默认 project（name 空）：未归类（无 projectId）+ 孤儿（归属的 project 已删除）聚合——
 *    保证任何 session 都至少在一个项目视图中可见
 */
import type { Project, SessionGroup } from '@taiji/shared'

/** 是否为默认项目（name 空 = 未命名兜底聚合）。与 store.isDefaultProject（!activeProject.name）同构：
 * activeProject 就是 projects 列表中的一项，per-project 泛化即 !p.name。 */
export function isDefaultProjectOf(p: Pick<Project, 'name'>): boolean {
  return !p.name
}

/** 全部命名 project 的 id 集合（孤儿判定基准：projectId 不在集合内即归属已删除）。 */
export function collectNamedProjectIds(projects: Project[]): Set<string> {
  return new Set(projects.filter((p) => p.name).map((p) => p.id))
}

/**
 * 单 session 是否归属指定 project（规则 SSOT，见文件头）。
 *
 * @param s 待判定 session（只依赖 projectId 字段）
 * @param projectId 目标 project id
 * @param isDefault 目标 project 是否默认项目
 * @param namedIds 全部命名 project id 集合（孤儿判定基准）
 */
export function sessionBelongsToProject(
  s: { projectId?: string },
  projectId: string,
  isDefault: boolean,
  namedIds: Set<string>,
): boolean {
  if (isDefault) return !s.projectId || !namedIds.has(s.projectId)
  return s.projectId === projectId
}

/**
 * 统计某 project 名下的 session 数（ProjectSwitcher 徽章用）。
 * 与 SessionList 过滤走同一 sessionBelongsToProject，徽章数 = 点击后列表实际条数。
 */
export function countProjectSessions(
  groups: SessionGroup[],
  projectId: string,
  isDefault: boolean,
  namedIds: Set<string>,
): number {
  let count = 0
  for (const g of groups) {
    for (const s of g.sessions) {
      if (sessionBelongsToProject(s, projectId, isDefault, namedIds)) count++
    }
  }
  return count
}

/**
 * 按 project 分组计数（ProjectSwitcher 一次算全卡）。
 * 返回 Map<projectId, count>，含默认项目键；计数规则同 countProjectSessions。
 */
export function computeProjectSessionCounts(
  groups: SessionGroup[],
  projects: Project[],
): Map<string, number> {
  const namedIds = collectNamedProjectIds(projects)
  const counts = new Map<string, number>()
  for (const p of projects) {
    counts.set(p.id, countProjectSessions(groups, p.id, isDefaultProjectOf(p), namedIds))
  }
  return counts
}
