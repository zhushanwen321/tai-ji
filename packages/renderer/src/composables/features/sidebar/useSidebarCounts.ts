/**
 * useSidebarCounts —— Sidebar tab 计数（从 Sidebar.vue 提取，减行用）。
 *
 * 职责：session（全局）+ fileTree / subagent / workflow（焦点 session）的计数 computed，
 * 供 SegmentedTab 渲染计数数字 + SubagentList/WorkflowList 列表数据。
 *
 * 依赖 sessionStore / fileTreeStore / subagentStore / workflowStore / panelStore
 * （pinia 单例 store，composable 内部安全调用）+ useSessionMarkers.isMarkedDone
 * （模块级响应式 Map cache）。focusedSessionId 由调用方注入（来自 useSidebar）。
 */
import { computed } from 'vue'
import type { Ref } from 'vue'
import { useFileTreeStore } from '@/stores/fileTree'
import { usePanelStore } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { isMarkedDone } from '@/composables/useSessionMarkers'
import { subagentBucket } from '@/lib/subagent-bucket'

export function useSidebarCounts(focusedSessionId: Ref<string | null>) {
  const sessionStore = useSessionStore()
  const fileTreeStore = useFileTreeStore()
  const panelStore = usePanelStore()
  const subagentStore = useSubagentStore()
  const workflowStore = useWorkflowStore()

  /** tab 计数（session / fileTree / subagent / workflow） */
  // session tab 计数（设计 sidebar-tab-count-restore §2.3 口径表第 1 行 / §3.1 终态）：
  // 侧边栏全量会话数 − 已归档（markedDone）数。为什么是全局口径（不按焦点 session 过滤）：
  // 会话 tab 列表 = 全局列表，数字与列表一致才不穿帮；死会话（dead）计入——列表仍渲染
  // （置灰降权），数字跟随列表。session 列表为空或首载失败时 groups 为空 → 0；重载失败
  // groups 保留旧快照，计数跟随现值（错误态由列表区错误卡承载，计数不重复报错）。
  // 为什么 computed 内逐条调 isMarkedDone：markers 是模块级响应式 Map cache，读 cache.value
  // 即建立依赖，归档 toggle / session 列表广播（groups 变化）任一变化都触发重算；O(n) 遍历
  // + Map 查询（n = 侧边栏会话数，§3.3 性能账 <0.1ms），不加索引/缓存层（决策 3）。
  const sessionCount = computed(() => {
    const sessions = sessionStore.list
    return sessions.length - sessions.filter((s) => isMarkedDone(s.id)).length
  })
  const fileCount = computed(() => {
    const sid = focusedSessionId.value
    if (!sid) return 0
    return fileTreeStore.getTree(sid)?.length ?? 0
  })
  // R3-7（H2 阶段 3 一致性审查）：列表链组装点过滤 workflow origin record——Agents tab
  // 域 = 手动派发 subagent，workflow 派发 record（origin==='workflow'）由 workflow tab/
  // run 视图承载（与上方 badge 过滤 D1② 同语义，TUI 面全量隐藏对称）。
  // 为什么落在组装点而非 filterSubagents/countSubagents（subagent-bucket SSOT）：此处一处
  // 过滤后，下游三桶（active/ended/all）、FilterBar 计数、「查看全部 (N)」自动一致；
  // 若在 SSOT 桶逻辑里过滤，active/ended 滤而 all 不滤会破 active+ended=all 自洽，
  // 全滤则需双函数联动，侵入面更大。origin 缺省（undefined = tool 语义）恒保留。
  const subagentList = computed(() =>
    subagentStore
      .recordsOf(focusedSessionId.value ?? '')
      .value.filter((r) => r.origin !== 'workflow'),
  )
  const subagentCount = computed(() => subagentList.value.length)
  // D8 口径收窄：badge 判据 =「进行中」桶 SSOT（subagentBucket === 'active'，D6 #5）——
  // 与 SubagentList/FilterBar 的 active 计数恒同源（含 done 投影排除 + waiting 计入语义），
  // 消除 badge 与列表计数口径漂移
  // H2 W1（record-unification D1②）：workflow 脚本派发的 record（origin==='workflow'）
  // 不计入 subagent badge——workflow 进度由 workflow tab/run 视图承载，混入会虚亮
  // subagent 徽标。origin 缺省（undefined = tool 语义，存量 record）恒计入。
  const subagentRunningCount = computed(
    () =>
      subagentList.value.filter((r) => r.origin !== 'workflow' && subagentBucket(r) === 'active')
        .length,
  )
  const workflowCount = computed(() => workflowStore.recordsOf(focusedSessionId.value ?? '').value.length)
  const workflowRunningCount = computed(
    () =>
      workflowStore
        .recordsOf(focusedSessionId.value ?? '')
        .value.filter((r) => r.status === 'running' || r.status === 'paused').length,
  )
  const workflowList = computed(() => workflowStore.recordsOf(focusedSessionId.value ?? '').value)
  /** workflow 详情态（null 时显示列表） */
  const currentWorkflow = computed(() =>
    focusedSessionId.value ? workflowStore.getCurrentWorkflow(panelStore.activePanelId, focusedSessionId.value) : null,
  )

  return {
    sessionCount,
    fileCount,
    subagentCount,
    subagentRunningCount,
    subagentList,
    workflowCount,
    workflowRunningCount,
    workflowList,
    currentWorkflow,
  }
}
