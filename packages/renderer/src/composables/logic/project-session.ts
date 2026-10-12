/**
 * Project ↔ Session 归属判定（纯函数，无 Vue 依赖）。
 *
 * 规则 SSOT：sessionBelongsToProject。消费方：
 *  - SessionList.projectGroups：全部会话按项目切分为锚定分组（R6.2，替换旧「按 activeProject
 *    过滤」形态）——默认项目组聚未归类 + 孤儿，命名组精确匹配，每个 session 恰落一组
 *  - ProjectGroup 组头计数 / 删除确认计数：切分结果自然承载（组内条数），无独立计数函数
 *    （原 ProjectSwitcher 徽章计数族随卡片网格退役删除）
 *
 * 判定语义（2026-08-04 D14 语义修正）：见 sessionBelongsToProject 注释。
 */
import type { Project } from '@taiji/shared'

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
