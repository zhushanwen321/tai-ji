/**
 * useTrayCounts —— composer 任务托盘（Widget Tray）built-in 任务域件的数据范围
 * （设计 docs/design/composer-task-tray.md（已删除，git 可追溯）§3.3 D2/D13 + §3.4 终态数据流）。
 *
 * [容器扩展点统一 §6.6/U9+U10] subagent 与 workflow 两件已迁插件推 widget 树（宿主
 * widget 区，数据源 = pi 扩展进程投影），宿主自建 subagent/workflow 计数/分桶/首拉/
 * 错误态随之退役——本 composable 只剩 bash 一个任务域件 + session / canvas 两直连件。
 *
 * 职责两件：
 * - **件计数与分桶**：bash 的「进行中 / 已结束」两视图行集与计数。计数恒等于行集长度
 *   （同一 computed 派生），杜绝「tab 数字与列表条数不一致」的双口径穿帮面（§1 设计目标 4）。
 *   [两视图裁决 2026-09-16] 两视图——「已收起」机制已全链路删除
 *   （2026-09-16 裁决，intent 意愿维度自 shared 契约至执行层均不复存在），已结束桶
 *   判据 = background-task-bucket SSOT 谓词（运行中 = active 桶，含 killing「已发令
 *   待确认」瞬态；已结束 = exited / orphaned）。
 * - **D13 首次拉取触发迁移**：bash 的首拉路径在 useBackgroundTasks 内（watch(sid) 拉取），
 *   本处不重复挂；原 workflow 首拉/错误态 retry 随件迁移退役（插件侧冷读收敛覆盖；
 *   bash 失败恢复 = useBackgroundTasks 重连路径自动重拉）。
 *
 * 数据链路（D2：native 组件直连既有 store，零新协议）：
 * - bash：useBackgroundTasks（per-session 分区，拉取 + 广播双路径）+ background-task-bucket
 *   SSOT 谓词分桶——两视图由 `filterBackgroundTasks` 派生，排序同源。
 * - session（第 4 件，u7）：**native 直连 session store**（`useSessionStore().list`），过滤
 *   `parentAgentSessionId === 当前 sessionId`（agent 经 session-manager 派发的子会话），
 *   **零新协议**（不新增 RPC/订阅——子会话标记 live 从内存透传、reload 从 `.agent.json` 读）。
 *   进行中判据 = `SessionSummary.status === 'active'`（进程级真值）；行集按 `lastActiveAt` 倒序。
 *   说明：设计 `mode-system-composer-density` §6.7 D7 原文描述状态点与
 *   侧栏 `derivedStatus` 同源，但 agent 派发的子会话**通常未被 hydrate**（无消息分区）——
 *   `derivedStatus` 对 `status='active'` 且无消息会兜底 done，无法表达「运行中」；故托盘计数
 *   与状态点统一取进程级 `SessionSummary.status`（色语言仍复用 DOT_CLASS，见 TraySessionPanel）。
 * - canvas（第 5 件，problem-solve-canvas §3.1(3) u-tray-entry + session-store-layout-
 *   inversion D4 隔离化）：**native 直连 canvas store**（经 useCanvasSync 的单条订阅——
 *   首拉 + `canvas.updated` 失效重拉在订阅链内收敛，本数据面只读 store 清单投影）。
 *   画布按归属会话隔离（runtime 清单只返回本会话画布）：本件计数 = 本会话画布；
 *   btw 线托盘构造性归零（[D9③ 抑制执行点③]——画布已是会话维度资源，线内画布经线
 *   owner 会话托盘承载）。计数口径 = 未收敛即进行中
 *   （生长中 / 审查中都在活动），converged 终态落已结束；阶段徽标（生长中/审查中/已收敛）
 *   是面板行的派生展示值，不在数据面建第二词表。
 *
 * [迁移语义 D14「复制不抽走」] 计数口径与首次拉取范式自侧栏任务视图域复制迁入；该域组件 /
 * composable 已随退役单元删除（原件不在，本文件为唯一实现）。谓词本体一律 import SSOT
 * （lib/background-task-bucket），本文件不重写任何判定。
 *
 * 消费方：u-tray-shell（件 icon 计数/三态——**唯一实例创建者**，创建后经
 * TRAY_COUNTS_KEY provide 给面板）+ TrayNativePanel（分桶列表与 tab 计数，经
 * useTrayCountsContext inject 消费外壳实例，**不自建实例**）。本文件不渲染 UI、不发任何
 * 写类 RPC（行内操作在面板组件内）。
 */
import { computed, inject, shallowRef, watch } from 'vue'
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import { useBackgroundTasks } from '@/composables/features/sidebar/useBackgroundTasks'
import type { UseBackgroundTasksReturn } from '@/composables/features/sidebar/useBackgroundTasks'
import { useSessionStore } from '@/stores/session'
import { useCanvasSync } from '@/composables/use-canvas-sync'
import { filterBackgroundTasks } from '@/lib/background-task-bucket'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'
import type { SessionSummary } from '@taiji/shared'
import type { CanvasListEntry } from '@zhushanwen/extension-protocol'
import { isKnownBtwLine, ensureBtwLineMembership } from '@/composables/panel/btw-line-membership'

/** built-in 任务域件（任务域面板类型 / TrayNativePanel 分桶键 / retry 分派键）。
 *  [容器扩展点统一 §6.6/U9+U10] subagent / workflow 已迁插件 widget 区，本词表只剩 bash。 */
export type TrayTaskKind = 'bash'

/**
 * 外壳 built-in 条目键（u7 第 4 件）：任务域一件 + `session`（子会话）。
 *
 * `session` **不在** `TrayTaskKind`/`TRAY_BUCKETS` 内——它走独立扁平列表面板
 * （TraySessionPanel，不参与两视图分桶），复用同一份计数/聚合/三态契约。
 * `canvas`（第 5 件，u-tray-entry）同理独立列表面板（TrayCanvasPanel）。
 */
export type TrayBuiltinKind = TrayTaskKind | 'session' | 'canvas'

/** 分桶视图值：任务域件共有的两视图（[两视图裁决 2026-09-16] 无第三桶） */
export type TrayBucketValue = 'running' | 'ended'

/** 件的分桶视图集合（顺序 = 面板 tab 渲染顺序） */
export const TRAY_BUCKETS: Record<TrayTaskKind, readonly TrayBucketValue[]> = {
  bash: ['running', 'ended'],
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
  /** 第 4 件子会话（u7）：running = `status === 'active'`，total = 全部子会话数 */
  session: TrayKindCounts
  /**
   * 第 5 件画布（u-tray-entry）：running = 未收敛数（生长中/审查中都在活动），
   * ended = 已收敛数，total = 全部画布数。
   */
  canvas: TrayKindCounts
}

/** 分桶行集（面板列表渲染源；计数由行集长度派生，二者恒等） */
export interface TrayLists {
  bash: {
    running: ComputedRef<BackgroundTaskEntry[]>
    ended: ComputedRef<BackgroundTaskEntry[]>
  }
  /** 第 4 件子会话（u7）：扁平列表（不分桶；顺序 = lastActiveAt 倒序） */
  session: {
    children: ComputedRef<SessionSummary[]>
  }
  /** 第 5 件画布（u-tray-entry）：扁平列表（不分桶；清单 = canvas.list 投影，含阶段徽标派生输入） */
  canvas: {
    entries: ComputedRef<CanvasListEntry[]>
  }
}

export interface UseTrayCountsReturn {
  /** 件计数（行集长度派生，切 session 跟随分区） */
  counts: ComputedRef<TrayCounts>
  /** 件分桶行集（面板 tab 列表） */
  lists: TrayLists
  /** bash 分区（面板顶部损坏/断连提示条判据） */
  bashPartition: ComputedRef<TrayBashPartition>
}

/**
 * 数据范围单例注入键：外壳（ComposerTray）在 setup 创建**唯一**实例并 provide，built-in 面板
 * inject 消费。面板随 Popover 每次打开重新挂载（reka Presence 卸载/重建），若各自调
 * useTrayCounts 则每次打开重发首次拉取 RPC（bash list）；单例把实例生命周期固定在外壳
 * （= Composer 生命周期）上，面板卸载不销毁、不重新拉取。
 */
export const TRAY_COUNTS_KEY: InjectionKey<UseTrayCountsReturn> = Symbol('tray-counts')

/**
 * 消费外壳提供的托盘数据范围（TrayNativePanel 专用）。token 缺失即抛错：面板只能在
 * ComposerTray 内渲染；**刻意不设「自建实例」回退**——回退即面板自持第二数据实例，正是
 * 「每次 hover 打开重发首次拉取 RPC」的根因（错误信息给出恢复动作）。
 */
export function useTrayCountsContext(): UseTrayCountsReturn {
  const tray = inject(TRAY_COUNTS_KEY)
  if (!tray) {
    throw new Error(
      '[tray] 数据范围注入缺失：TrayNativePanel 必须在 ComposerTray 内渲染' +
        '（外壳需 provide(TRAY_COUNTS_KEY, useTrayCounts(sessionId))）。',
    )
  }
  return tray
}

/**
 * 托盘 built-in 数据范围。必须在组件 setup 同步调用（内部 watch 依赖实例 scope；
 * useBackgroundTasks 同样要求 setup 上下文）。**整个应用只有一个调用点**——外壳
 * ComposerTray；面板走 useTrayCountsContext 消费同一实例（见 TRAY_COUNTS_KEY）。
 *
 * @param sessionIdRef 焦点 session id（string | null | undefined；undefined 归一为 null）
 */
export function useTrayCounts(sessionIdRef: Ref<string | null | undefined>): UseTrayCountsReturn {
  // null 归一：useBackgroundTasks / 分区读路径的契约（null = 无活跃 session，不写 Map 分区）
  const normalizedSid = computed(() => sessionIdRef.value ?? null)

  // bash 数据范围：useBackgroundTasks 自带 watch(sid) 拉取路径 + 广播增量路径 + 重连路径，
  // 托盘不另挂订阅（AGENTS 规则 2：物理订阅在 store/状态根层收敛）。
  const backgroundTasks = useBackgroundTasks(normalizedSid)

  // ── btw 线抑制（D9③ 派生视图收窄·任务托盘抑制执行点①）──
  // btw 线（drawer 内 Composer 同样挂载本托盘）不派生虚拟任务：画布-run 件按线
  // owner 分区读，在此构造性归零——派生过程仅在消息流工具调用中可见，托盘不为线内
  // 派生提供 opener（对齐 zcode）。bash（线自身后台命令）与 session 件（真实子会话）
  // 非派生虚拟键，照常。[容器扩展点统一 §6.6/U9+U10] subagent / workflow 两件已迁
  // 插件 widget 区（线内派生归零由插件侧分区读自行承载），抑制面只剩 canvas 一件。
  // W4b 收编判别器 = session.list {surface:'btw'} 拉取缓存成员判别（登记于
  // docs/constraints.json C-data-28 抑制类清单——语义抑制本体、非性能优化，故保留判别器；
  // 旧 isBtwVirtualId 前缀判别随 vid 退役、session.surfaces 派生表随 W4b 收编删除，
  // 设计 §5-W4b 四步之①）。渲染路径同步读缓存；焦点切换（托盘事件）落空时按需补拉一次
  // 再判（拉取失败 = 显式未知，当次不抑制——失败方向 = 偶发托盘派生，已接受）。
  const derivedSuppressed = shallowRef(false)
  watch(
    normalizedSid,
    async (sid) => {
      const suppressed = sid !== null && (isKnownBtwLine(sid) || (await ensureBtwLineMembership(sid)))
      // 时效守卫：回写前校验 sid 仍是当前焦点会话。在途补拉期间从「未缓存主会话」切回
      // 「已缓存线会话」时，旧 sid 的 Promise 续写会把 derivedSuppressed 覆写为 false
      // （线内派生任务漏进托盘计数），且 knownLines 写入不触发本
      // watch、无自纠触发点，错误状态会停留到下次会话切换。只用当前焦点 sid 的判定结果回写。
      if (sid !== normalizedSid.value) return
      derivedSuppressed.value = suppressed
    },
    { immediate: true },
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

  // ── canvas（第 5 件，u-tray-entry）：native 直连 canvas store（per-session 分区读）──
  // 订阅生命周期归 useCanvasSync（模块级单条订阅 + per-session 分流，见其文件头）：首拉与
  // canvas.updated 失效重拉在订阅链内收敛，本数据面只读清单投影、零新协议。[D9③ 抑制
  // 执行点③] btw 线托盘构造性归零——画布按归属会话隔离（D4）后已是会话维度资源，
  // 线内画布经线 owner 会话托盘承载。进行中 = 未收敛（生长中 / 审查中都在活动），
  // 已结束 = converged 终态（回看资产）。
  const canvasStore = useCanvasSync(normalizedSid)
  const canvasEntries = computed<CanvasListEntry[]>(() => {
    if (derivedSuppressed.value) return []
    return canvasStore.list.value
  })
  const canvasActive = computed(() => canvasEntries.value.filter((c) => !c.converged))

  const counts = computed<TrayCounts>(() => ({
    bash: {
      running: bashRunning.value.length,
      ended: bashEnded.value.length,
      total: bashTasks.value.length,
    },
    session: {
      running: sessionRunning.value.length,
      ended: sessionChildren.value.length - sessionRunning.value.length,
      total: sessionChildren.value.length,
    },
    canvas: {
      running: canvasActive.value.length,
      ended: canvasEntries.value.length - canvasActive.value.length,
      total: canvasEntries.value.length,
    },
  }))

  return {
    counts,
    lists: {
      bash: { running: bashRunning, ended: bashEnded },
      session: { children: sessionChildren },
      canvas: { entries: canvasEntries },
    },
    bashPartition: backgroundTasks.current,
  }
}
