/**
 * 归类目标列表单一实现（demo「移动到项目」分组数据源）：
 * SessionItemContextMenu 的菜单分组与 SessionItemActions 的 ghost Popover 共用，
 * 两处消费场景同一数据口径——目标集与归属判定不允许各自演化。
 */
import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProjectStore } from '@/stores/project'

/** 归类目标行：id + 展示名（数据形状用 type——非行为接口，无多实现演进面）。 */
export type AssignTarget = {
  id: string
  name: string
}

/**
 * 归类目标列表：默认项目（未归类聚合）+ 全部命名 project。
 * 默认项目项 id=''：未归类 session 的 projectId 是 undefined，必须归一为空串才能
 * 命中高亮/✓ 判定（review S-2）；归回默认 = projectId 空串（D14 语义修正）。
 */
export function useAssignTargets(): ComputedRef<AssignTarget[]> {
  const projectStore = useProjectStore()
  const { t } = useI18n()
  return computed(() => [
    { id: '', name: t('sidebar.projectSwitcher.defaultName') },
    ...projectStore.projects.filter((p) => p.name).map((p) => ({ id: p.id, name: p.name })),
  ])
}
