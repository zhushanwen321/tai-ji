/**
 * useTrayCounts —— composer 任务托盘（Widget Tray）built-in 三件的数据面
 * （设计 docs/design/composer-task-tray.md §3.3 D2/D13 + §3.4 终态数据流）。
 *
 * 职责三件：
 * - **三件计数与分桶**：bash / subagent / workflow 的「进行中 / 已结束」两视图行集与
 *   计数。计数恒等于行集长度（同一 computed 派生），杜绝「tab 数字与列表条数不一致」
 *   的双口径穿帮面（§1 设计目标 4）。
 *   [两视图裁决 2026-09-16] subagent 面板收窄为两视图——「已收起」机制已全链路删除
 *   （2026-09-16 裁决，intent 意愿维度自 shared 契约至执行层均不复存在），已结束桶
 *   判据 = !isRunningProjection，托盘无第三状态。
 * - **D13 首拉触发迁移**：**外壳挂载即** `watch(sessionId)` → `loadSubagents` / `loadWorkflows`
 *   ——范式 = useBackgroundTasks 的 watch(sid) 拉取腿（原侧栏任务列表的首拉腿已随该视图退役，
 *   迁入此处成为唯一实现；「外壳挂载」而非「面板打开」是 U1 的语义前提：面板每次 hover 打开
 *   都重新挂载，数据面必须活在外壳上，打开时数据已在）。
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
 *   进行中）；已结束 = `!isRunningProjection`（两态语义：idle 与死亡纳管态全落此桶）。
 * - workflow：`workflowStore.recordsOf(sid)`；进行中 = `status === 'running'`，
 *   已结束 = 其余（done）。
 * - session（第 4 件，u7）：**native 直连 session store**（`useSessionStore().list`），过滤
 *   `parentAgentSessionId === 当前 sessionId`（agent 经 session-manager 派发的子会话），
 *   **零新协议**（不新增 RPC/订阅——子会话标记 live 从内存透传、reload 从 `.agent.json` 读）。
 *   进行中判据 = `SessionSummary.status === 'active'`（进程级真值）；行集按 `lastActiveAt` 倒序。
 *   说明：设计 `.tmp/tech-design/mode-system-composer-density.md` §6.7 D7 原文描述状态点与
 *   侧栏 `derivedStatus` 同源，但 agent 派发的子会话**通常未被 hydrate**（无消息分区）——
 *   `derivedStatus` 对 `status='active'` 且无消息会兜底 done，无法表达「运行中」；故托盘计数
 *   与状态点统一取进程级 `SessionSummary.status`（色语言仍复用 DOT_CLASS，见 TraySessionPanel）。
 *
 * [迁移语义 D14「复制不抽走」] 计数口径与首拉范式自侧栏任务视图域复制迁入；该域组件 /
 * composable 已随退役单元删除（原件不在，本文件为唯一实现）。谓词本体一律 import SSOT
 * （lib/subagent-bucket、lib/background-task-bucket），本文件不重写任何判定。
 *
 * 消费方：u-tray-shell（三件 icon 计数/三态——**唯一实例创建者**，创建后经
 * TRAY_COUNTS_KEY provide 给面板）+ TrayNativePanel（分桶列表与 tab 计数，经
 * useTrayCountsContext inject 消费外壳实例，**不自建实例**）。本文件不渲染 UI、不发任何
 * 写类 RPC（行内操作在面板组件内）。
 */
import { computed, inject, watch } from 'vue'
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useBackgroundTasks } from '@/composables/features/sidebar/useBackgroundTasks'
import type { UseBackgroundTasksReturn } from '@/composables/features/sidebar/useBackgroundTasks'
import { useSessionStore } from '@/stores/session'
import { isRunningProjection } from '@/lib/subagent-bucket'
import { filterBackgroundTasks } from '@/lib/background-task-bucket'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'
import type { SessionSummary, SubagentRecord, WorkflowRunRecord } from '@taiji/shared'

/** built-in 三件（任务域面板类型 / TrayNativePanel 分桶键 / retry 分派键） */
export type TrayTaskKind = 'bash' | 'subagent' | 'workflow'

/**
 * 外壳 built-in 条目键（u7 第 4 件）：三件任务域 + `session`（子会话）。
 *
 * `session` **不在** `TrayTaskKind`/`TRAY_BUCKETS` 内——它走独立扁平列表面板
 * （TraySessionPanel，不参与两视图分桶），复用同一份计数/聚合/三态契约。
 */
export type TrayBuiltinKind = TrayTaskKind | 'session'

/** 分桶视图值：三件共有的两视图（[两视图裁决 2026-09-16] subagent 不再有第三桶） */
export type TrayBucketValue = 'running' | 'ended'

/** 各件的分桶视图集合（顺序 = 面板 tab 渲染顺序） */
export const TRAY_BUCKETS: Record<TrayTaskKind, readonly TrayBucketValue[]> = {
  bash: ['running', 'ended'],
  subagent: ['running', 'ended'],
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

export interface TrayCounts {
  bash: TrayKindCounts
  subagent: TrayKindCounts
  workflow: TrayKindCounts
  /** 第 4 件子会话（u7）：running = `status === 'active'`，total = 全部子会话数 */
  session: TrayKindCounts
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
  }
  workflow: {
    running: ComputedRef<WorkflowRunRecord[]>
    ended: ComputedRef<WorkflowRunRecord[]>
  }
  /** 第 4 件子会话（u7）：扁平列表（不分桶；顺序 = lastActiveAt 倒序） */
  session: {
    children: ComputedRef<SessionSummary[]>
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
 * 数据面单例注入键：外壳（ComposerTray）在 setup 创建**唯一**实例并 provide，built-in 面板
 * inject 消费。面板随 Popover 每次打开重新挂载（reka Presence 卸载/重建），若各自调
 * useTrayCounts 则每次打开重发首拉 RPC（loadSubagents + loadWorkflows，bash 另加 list）；
 * 单例把实例生命周期钉在外壳（= Composer 生命周期）上，面板卸载不销毁、不重拉。
 */
export const TRAY_COUNTS_KEY: InjectionKey<UseTrayCountsReturn> = Symbol('tray-counts')

/**
 * 消费外壳提供的托盘数据面（TrayNativePanel 专用）。token 缺失即抛错：面板只能在
 * ComposerTray 内渲染；**刻意不设「自建实例」回退**——回退即面板自持第二数据实例，正是
 * 「每次 hover 打开重发首拉 RPC」的根因（错误信息给出恢复动作）。
 */
export function useTrayCountsContext(): UseTrayCountsReturn {
  const tray = inject(TRAY_COUNTS_KEY)
  if (!tray) {
    throw new Error(
      '[tray] 数据面注入缺失：TrayNativePanel 必须在 ComposerTray 内渲染' +
        '（外壳需 provide(TRAY_COUNTS_KEY, useTrayCounts(sessionId))）。',
    )
  }
  return tray
}

/**
 * 托盘 built-in 三件数据面。必须在组件 setup 同步调用（内部 watch 依赖实例 scope；
 * useBackgroundTasks 同样要求 setup 上下文）。**整个应用只有一个调用点**——外壳
 * ComposerTray；面板走 useTrayCountsContext 消费同一实例（见 TRAY_COUNTS_KEY）。
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

  // ── subagent：origin 过滤（workflow 派发 record 归 workflow 面板）→ 两视图分桶 ──
  // excludeOrigin 选项式（S1 判据单源化，与 hasRunning 同形态；禁止内联 filter 第二判据）
  const subagentRecords = computed(() =>
    subagentStore
      .recordsOf(normalizedSid.value ?? '', { excludeOrigin: 'workflow' })
      .value,
  )
  const subagentRunning = computed(() => subagentRecords.value.filter((r) => isRunningProjection(r)))
  // 已结束 = !isRunningProjection（[两视图裁决 2026-09-16]：「已收起」机制已全链路删除，
  // 已结束桶判据 = !isRunningProjection）。两桶互斥且并集 = 全量。
  const subagentEnded = computed(() =>
    subagentRecords.value.filter((r) => !isRunningProjection(r)),
  )

  // ── workflow：进行中 = running（一次性生命周期 D-2：paused 值已从状态机删除）──
  const workflowRecords = computed(() => workflowStore.recordsOf(normalizedSid.value ?? '').value)
  const workflowRunning = computed(() =>
    workflowRecords.value.filter((r) => r.status === 'running'),
  )
  const workflowEnded = computed(() =>
    workflowRecords.value.filter((r) => r.status !== 'running'),
  )

  // ── session（第 4 件，u7）：native 直连 session store，零新协议 ──
  // 过滤 parentAgentSessionId === 当前 sessionId（我派发的子会话）；行集 lastActiveAt 倒序（最近在前）。
  const sessionStore = useSessionStore()
  const sessionChildren = computed<SessionSummary[]>(() => {
    const sid = normalizedSid.value
    if (!sid) return []
    return sessionStore.list
      .filter((s) => s.parentAgentSessionId === sid)
      .slice()
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  })
  // 进行中 = 进程级 status === 'active'（见文件头 session 条：derivedStatus 对未 hydrate 的
  // agent 子会话兜底 done，不能作为运行中判据）
  const sessionRunning = computed(() =>
    sessionChildren.value.filter((s) => s.status === 'active'),
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
      total: subagentRecords.value.length,
    },
    workflow: {
      running: workflowRunning.value.length,
      ended: workflowEnded.value.length,
      total: workflowRecords.value.length,
    },
    session: {
      running: sessionRunning.value.length,
      ended: sessionChildren.value.length - sessionRunning.value.length,
      total: sessionChildren.value.length,
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
      subagent: { running: subagentRunning, ended: subagentEnded },
      workflow: { running: workflowRunning, ended: workflowEnded },
      session: { children: sessionChildren },
    },
    bashPartition: backgroundTasks.current,
    errors: {
      // per-sid 分区读（ADR-0049）：split 模式 pane A 的加载失败不得遮蔽 pane B 面板
      subagent: computed(() => subagentStore.loadErrorOf(normalizedSid.value ?? '')),
      workflow: computed(() => workflowStore.loadErrorOf(normalizedSid.value ?? '')),
    },
    loading: {
      bash: computed(() => !backgroundTasks.current.value.loaded),
      subagent: computed(() => subagentStore.isLoadingOf(normalizedSid.value ?? '')),
      workflow: computed(() => workflowStore.isLoadingOf(normalizedSid.value ?? '')),
    },
    retry,
  }
}
