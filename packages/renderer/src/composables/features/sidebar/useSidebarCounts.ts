/**
 * useSidebarCounts —— Sidebar tab 计数（从 Sidebar.vue 提取，减行用）。
 *
 * 职责：session（全局）+ fileTree（焦点 session）的计数 computed，供 SegmentedTab 渲染计数数字。
 *
 * 依赖 sessionStore / fileTreeStore（pinia 单例 store，composable 内部安全调用）
 * + useSessionMarkers.isMarkedDone（模块级响应式 Map cache）。focusedSessionId 由调用方注入
 * （来自 useSidebar）。
 *
 * [HISTORICAL] 2026-09-16 五 tab 收敛为三 tab：本模块的子代理 / 工作流计数段（列表组装、
 * 进行中计数、列表与详情态读取）随两枚任务 tab 退役删除——计数口径（含 workflow 派发来源
 * 过滤与「正在跑」占用谓词判据）在 P2 阶段已复制迁入 composer 任务托盘
 * （`components/panel/tray/useTrayCounts.ts`，D14「复制不抽走」→ 本处为 P3 删除原件）。
 */
import { computed } from 'vue'
import type { Ref } from 'vue'
import { useFileTreeStore } from '@/stores/fileTree'
import { useSessionStore } from '@/stores/session'
import { isMarkedDone } from '@/composables/useSessionMarkers'

export function useSidebarCounts(focusedSessionId: Ref<string | null>) {
  const sessionStore = useSessionStore()
  const fileTreeStore = useFileTreeStore()

  /** tab 计数（session / fileTree） */
  // session tab 计数：
  // 侧边栏全量会话数 − 已归档（markedDone）数。为什么是全局口径（不按焦点 session 过滤）：
  // 会话 tab 列表 = 全局列表，数字与列表一致才不穿帮；死会话（dead）计入——列表仍渲染
  // （置灰降权），数字跟随列表。session 列表为空或首载失败时 groups 为空 → 0；重载失败
  // groups 保留旧快照，计数跟随现值（错误态由列表区错误卡承载，计数不重复报错）。
  // 为什么 computed 内逐条调 isMarkedDone：markers 是模块级响应式 Map cache，读 cache.value
  // 即建立依赖，归档 toggle / session 列表广播（groups 变化）任一变化都触发重算；O(n) 遍历
  // + Map 查询（n = 侧边栏会话数，<0.1ms 量级），不加索引/缓存层（决策 3）。
  const sessionCount = computed(() => {
    const sessions = sessionStore.list
    return sessions.length - sessions.filter((s) => isMarkedDone(s.id)).length
  })
  // file tab 计数 = 文件树根层条目数（目录计入），刻意不做递归全量：文件树懒加载
  // （children 未展开前 undefined）决定 renderer 内存中没有全量文件清单，递归计数需
  // eager 拉整树（一次大 IPC + 常驻内存），为一个小数字付出真实开销——根层口径与
  // 数字删除前用户所见一致，无感知差异。
  const fileCount = computed(() => {
    const sid = focusedSessionId.value
    if (!sid) return 0
    return fileTreeStore.getTree(sid)?.length ?? 0
  })

  return {
    sessionCount,
    fileCount,
  }
}
