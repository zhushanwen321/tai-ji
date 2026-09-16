/**
 * useTrayCounts —— composer 任务托盘（Widget Tray）built-in 三件的数据面
 * （设计 docs/design/composer-task-tray.md §3.3 D2/D13 + §3.4 终态数据流）。
 *
 * 职责三件：
 * - **三件计数与分桶**：bash / subagent / workflow 的「进行中 / 已结束（subagent 另有
 *   已收起）」行集与计数。计数恒等于行集长度（同一 computed 派生），杜绝「tab 数字与
 *   列表条数不一致」的双口径穿帮面（§1 设计目标 4）。
 * - **D13 首拉触发迁移**：挂载即 `watch(sessionId)` → `loadSubagents` / `loadWorkflows`
 *   ——范式 = useBackgroundTasks 的 watch(sid) 拉取腿（原侧栏任务列表的首拉腿已随该视图退役，
 *   迁入此处成为唯一实现）。
 *   历史 record（已结束桶 / dim 常驻判据）依赖首拉：广播腿只覆盖在跑任务，缺此腿切 session
 *   后托盘空/滞后。WS 重连腿仍归 useSidebar.onConnected（D13 明文不迁），本处不重复挂。
 * - **面板错误态 retry 支撑**：按类重拉（bash → useBackgroundTasks.refresh；
 *   subagent / workflow → load*）。
 *
 * 数据链路（D2：native 组件直连既有 store，零新协议）：
 * - bash：useBackgroundTasks（per-session 分区，拉取 + 广播双腿）+ background-task-bucket
 *   SSOT 谓词分桶（运行中 = active 桶，含 killing「已发令待确认」瞬态；已结束 = exited /
 *   orphaned）——两视图由 `filterBackgroundTasks` 派生，排序同源。
 * - subagent：`subagentStore.recordsOf(sid)` 过滤 `origin !== 'workflow'`（workflow 派发的
 *   record 由 workflow 面板承载；该过滤口径原在侧栏任务计数内，已随侧栏任务视图退役、
 *   托盘为唯一实现）+ subagent-bucket SSOT 谓词：
 *   进行中 = `isRunningProjection`（running 且无 stopReason——死亡纳管态 running+failed 不落
 *   进行中）；已结束 = `!isRunningProjection` 且 `subagentBucket(record) !== 'archived'`；
 *   已收起 = `intent === 'archived'`（意愿维度与 status 正交，已退役的侧栏筛选条原承载的
 *   寻回入口现由托盘「已收起」视图唯一承载）。
 * - workflow：`workflowStore.recordsOf(sid)`；进行中 = `status ∈ {running, paused}`，
 *   已结束 = 其余（done）。
 *
 * [迁移语义 D14「复制不抽走」] 计数口径与首拉范式自侧栏任务视图域复制迁入；该域组件 /
 * composable 已随退役单元删除（原件不在，本文件为唯一实现）。谓词本体一律 import SSOT
 * （lib/subagent-bucket、lib/background-task-bucket），本文件不重写任何判定。
 *
 * 消费方：u-tray-shell（三件 icon 计数/三态）+ TrayNativePanel（分桶列表与 tab 计数）。
 * 本文件不渲染 UI、不发任何写类 RPC（行内操作在面板组件内）。
 */
import { computed, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useBackgroundTasks } from '@/composables/features/sidebar/useBackgroundTasks'
import type { UseBackgroundTasksReturn } from '@/composables/features/sidebar/useBackgroundTasks'
import { isRunningProjection, subagentBucket } from '@/lib/subagent-bucket'
import { filterBackgroundTasks } from '@/lib/background-task-bucket'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'
import type { SubagentRecord, WorkflowRunRecord } from '@taiji/shared'

/** built-in 三件（面板类型 / 数据面分区键） */
export type TrayTaskKind = 'bash' | 'subagent' | 'workflow'

/** 分桶视图值：running/ended 三类共有；archived 仅 subagent（寻回视图，subagent-bucket §D4） */
export type TrayBucketValue = 'running' | 'ended' | 'archived'

/** 各件的分桶视图集合（顺序 = 面板 tab 渲染顺序；已收起恒在末位） */
export const TRAY_BUCKETS: Record<TrayTaskKind, readonly TrayBucketValue[]> = {
  bash: ['running', 'ended'],
  subagent: ['running', 'ended', 'archived'],
  workflow: ['running', 'ended'],
}

/** bash 分区形态（useBackgroundTasks 的 current；loaded/corrupted/fetchFailed 驱动面板提示条） */
export type TrayBashPartition = UseBackgroundTasksReturn['current']['value']

/** 单件计数（total = 该 session 该件全量 record 数，供外壳「有历史 dim / 全无隐藏」判定） */
export interface TrayKindCounts {
  running: number
  ended: number
  total: number
}

/** subagent 计数（多一桶：已收起） */
export interface TraySubagentCounts extends TrayKindCounts {
  archived: number
}

export interface TrayCounts {
  bash: TrayKindCounts
  subagent: TraySubagentCounts
  workflow: TrayKindCounts
}

/** 分桶行集（面板列表渲染源；计数由行集长度派生，二者恒等） */
export interface TrayLists {
  bash: {
    running: ComputedRef<BackgroundTaskEntry[]>
    ended: ComputedRef<BackgroundTaskEntry[]>
  }
  subagent: {
    running: ComputedRef<SubagentRecord[]>
    ended: ComputedRef<SubagentRecord[]>
    archived: ComputedRef<SubagentRecord[]>
  }
  workflow: {
    running: ComputedRef<WorkflowRunRecord[]>
    ended: ComputedRef<WorkflowRunRecord[]>
  }
}

export interface UseTrayCountsReturn {
  /** 三件计数（行集长度派生，切 session 跟随分区） */
  counts: ComputedRef<TrayCounts>
  /** 三件分桶行集（面板 tab 列表） */
  lists: TrayLists
  /** bash 分区（面板顶部损坏/断连提示条判据） */
  bashPartition: ComputedRef<TrayBashPartition>
  /** 首拉/重拉错误（null = 无错误）；bash 的失败由 bashPartition.fetchFailed 承载 */
  errors: {
    subagent: ComputedRef<string | null>
    workflow: ComputedRef<string | null>
  }
  /** 面板加载态（bash = 从未成功拉到过一次） */
  loading: {
    bash: ComputedRef<boolean>
    subagent: ComputedRef<boolean>
    workflow: ComputedRef<boolean>
  }
  /** 面板错误态 retry：按类重拉（bash → refresh；subagent/workflow → load*） */
  retry: (kind: TrayTaskKind) => Promise<void>
}

/**
 * 托盘 built-in 三件数据面。必须在组件 setup 同步调用（内部 watch 依赖实例 scope；
 * useBackgroundTasks 同样要求 setup 上下文）。
 *
 * @param sessionIdRef 焦点 session id（string | null | undefined；undefined 归一为 null）
 */
export function useTrayCounts(sessionIdRef: Ref<string | null | undefined>): UseTrayCountsReturn {
  // null 归一：useBackgroundTasks / 分区读路径的契约（null = 无活跃 session，不写 Map 分区）
  const normalizedSid = computed(() => sessionIdRef.value ?? null)

  const subagentStore = useSubagentStore()
  const workflowStore = useWorkflowStore()
  // bash 数据面：useBackgroundTasks 自带 watch(sid) 拉取腿 + 广播增量腿 + 重连腿，
  // 托盘不另挂订阅（AGENTS 规则 2：物理订阅在 store/状态根层收敛）。
  const backgroundTasks = useBackgroundTasks(normalizedSid)

  // ── subagent：origin 过滤（workflow 派发 record 归 workflow 面板）→ 三视图分桶 ──
  const subagentRecords = computed(() =>
    subagentStore
      .recordsOf(normalizedSid.value ?? '')
      .value.filter((r) => r.origin !== 'workflow'),
  )
  const subagentRunning = computed(() => subagentRecords.value.filter((r) => isRunningProjection(r)))
  // 已收起与已结束互斥（archived 优先归寻回视图）：两桶 + 进行中 = 全量，无重叠无遗漏
  const subagentArchived = computed(() =>
    subagentRecords.value.filter((r) => subagentBucket(r) === 'archived'),
  )
  const subagentEnded = computed(() =>
    subagentRecords.value.filter(
      (r) => !isRunningProjection(r) && subagentBucket(r) !== 'archived',
    ),
  )

  // ── workflow：进行中 = running | paused（paused 仍是「进行中的 run」，设计 D2 明文）──
  const workflowRecords = computed(() => workflowStore.recordsOf(normalizedSid.value ?? '').value)
  const workflowRunning = computed(() =>
    workflowRecords.value.filter((r) => r.status === 'running' || r.status === 'paused'),
  )
  const workflowEnded = computed(() =>
    workflowRecords.value.filter((r) => r.status !== 'running' && r.status !== 'paused'),
  )

  // ── bash：两视图由 background-task-bucket SSOT 谓词派生（过滤 + 排序同源，不二次加工）──
  const bashTasks = computed(() => backgroundTasks.current.value.tasks)
  const bashRunning = computed(() => filterBackgroundTasks(bashTasks.value, 'active'))
  const bashEnded = computed(() => filterBackgroundTasks(bashTasks.value, 'ended'))

  const counts = computed<TrayCounts>(() => ({
    bash: {
      running: bashRunning.value.length,
      ended: bashEnded.value.length,
      total: bashTasks.value.length,
    },
    subagent: {
      running: subagentRunning.value.length,
      ended: subagentEnded.value.length,
      archived: subagentArchived.value.length,
      total: subagentRecords.value.length,
    },
    workflow: {
      running: workflowRunning.value.length,
      ended: workflowEnded.value.length,
      total: workflowRecords.value.length,
    },
  }))

  // ── D13 首拉触发：挂载即拉 + 切 session 重拉（范式 = useBackgroundTasks 拉取腿）──
  // immediate 覆盖首挂载；切走期间广播腿仍投递（订阅按 sid refCount 收敛在状态根），
  // 但切回时必须无条件重拉一次——聚合快照以拉取为唯一真相入口（承自原侧栏任务列表
  // 首拉腿的语义）。
  watch(
    normalizedSid,
    (sid) => {
      if (!sid) return
      void subagentStore.loadSubagents(sid)
      void workflowStore.loadWorkflows(sid)
    },
    { immediate: true },
  )

  /** 面板错误态 retry：按类重拉（load* 内部已收口错误到 loadError，调用方无需 try-catch） */
  async function retry(kind: TrayTaskKind): Promise<void> {
    const sid = normalizedSid.value
    if (!sid) return
    if (kind === 'subagent') {
      await subagentStore.loadSubagents(sid)
      return
    }
    if (kind === 'workflow') {
      await workflowStore.loadWorkflows(sid)
      return
    }
    await backgroundTasks.refresh()
  }

  return {
    counts,
    lists: {
      bash: { running: bashRunning, ended: bashEnded },
      subagent: { running: subagentRunning, ended: subagentEnded, archived: subagentArchived },
      workflow: { running: workflowRunning, ended: workflowEnded },
    },
    bashPartition: backgroundTasks.current,
    errors: {
      subagent: computed(() => subagentStore.loadError),
      workflow: computed(() => workflowStore.loadError),
    },
    loading: {
      bash: computed(() => !backgroundTasks.current.value.loaded),
      subagent: computed(() => subagentStore.isLoading),
      workflow: computed(() => workflowStore.isLoading),
    },
    retry,
  }
}
