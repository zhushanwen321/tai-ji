/**
 * Workflow store —— workflow 列表 + agentcall 虚拟 key 清理映射。
 *
 * 依赖方向：无（stores 间禁止互相 import）。跨 store 编排（chatStore.setMessages 等）
 * 由调用方通过回调注入，store 内不 import 其他 store。
 *
 * 职责：
 * - 共享 workflow 列表（records）—— 所有消费面（composer 任务托盘 / drawer WorkflowTab）只读消费
 * - agentcall 虚拟 key 清理映射（mainSessionAgentCalls）：deleteSession 时清 agentcall 虚拟分区
 * - [可视化 U5/D11] 事件流缓存（runId 分区 + LRU5 + 活跃 run 锚 + workflowUpdate 信号
 *   联动 force 重拉）—— workflow-viz 面板（overlay 右栏实况面板）消费
 *
 * [HISTORICAL] overlay 展示层已于 U7 移除（drawer tab 化）：
 * 原 agentCallMap（Panel overlay 的 agent call sessionId）+ isViewing/getViewingAgentCallId/
 * getActiveAgentCallVirtualId + selectAgentCall/backFromAgentCall 均为 overlay 全屏替换模式产物。
 * drawer tab 并排模型下，agent call 详情在 drawer SubagentTab 内自治（直接 getAgentCallHistory +
 * setMessages），不再经 store overlay 状态机。agentcall 虚拟 key 的 deleteSession 清理映射
 * （mainSessionAgentCalls + getAgentCallVirtualIdsByMain + clearAgentCallMapping）保留——
 * isVirtualKeyOf 只匹配 subagent: 前缀不匹配 agentcall:，此映射是 agentcall 清理唯一通路
 * （review MUST_FIX 1）。drawer SubagentTab agentcall 分支经 registerAgentCall 登记到此映射。
 * [2026-09-16 侧栏任务 tab 退役] sidebar 视图 2 簇（per-panel 选中 runId 状态 + 选中 /
 * 返回 / 读取当前详情三支函数）随 Agents/Flows tab 删除——生产消费面（侧栏列表与详情挂载
 * 分支 + 侧栏子代理动作 composable 的选中与返回 handler）已退役，workflow 详情统一收口
 * drawer workflow tab。
 *
 * 虚拟 session ID 格式：`agentcall:<sessionId>`（agent call 对话流）
 * chatStore.messages Map 支持任意 string key，直接用虚拟 session ID 注入消息。
 */
import { defineStore } from 'pinia'
import { getCurrentScope, onScopeDispose, ref } from 'vue'
import type { ComputedRef } from 'vue'
import type { WorkflowAgentCall, WorkflowRunEventEntry, WorkflowRunRecord, WorkflowRunEventsErrorCode } from '@taiji/shared'
// 虚拟 session ID 工厂 SSOT 迁至 @taiji/shared/virtual-session-id（跨层协议级约定）。
// 此处 re-export 保持现有 import 路径向后兼容；本 store body 清理逻辑用本地 import。
export {
  AGENTCALL_PREFIX,
  agentCallVirtualId,
  isAgentCallVirtualId,
  extractAgentCallSessionId,
} from '@taiji/shared'
import { createInflightDedup } from '@taiji/core/foundation/create-inflight-dedup'
import { session as sessionApi } from '@/api'
import { createPartitionedLoadState, createPartitionedRecords } from '../lib/partitioned-session-records'

// ── [P3/D6] progress 投影消费（纯函数，drawer WorkflowTab 与托盘面板共用）──

/**
 * [P3/D6] 单 ask 已执行时长（「每 ask 已执行时长」槽）：running 且 trace.startedAt
 * 可解析 → now - startedAt；其余（pending/done 或旧快照缺 startedAt）→ null
 * （槽省略）。done ask 的耗时走既有 durationMs 通道，不经本函数。
 */
export function agentCallElapsedMs(call: WorkflowAgentCall, nowMs: number): number | null {
  if (call.status !== 'running' || call.startedAt === undefined) return null
  const started = Date.parse(call.startedAt)
  if (Number.isNaN(started)) return null
  return Math.max(0, nowMs - started)
}

/**
 * [可视化 D9] run 已用时长 ms（「中断/终局停走」口径的单点派生——overlay 壳 header
 * 与实况面板 header 两消费位共用，禁各自实现）。停走锚：running = 当前时刻；terminal
 * （done）= completedAt（不可解析回退 start）；interrupted（暂停态，无 completedAt）=
 * health.lastProgressAt（不计挂起时间）。返回 null = 时长槽省略（消费方显示 '—'）：
 * startedAt 不可解析，或 interrupted 无 health 锚（缺省 / 早于 start——v2 事件 fold 投影
 * 恒不产出 health 字段，见 shared/workflow.ts 注释；数据缺口不展示为确定的 0 值）。
 */
export function deriveWorkflowRunElapsedMs(
  run: Pick<WorkflowRunRecord, 'status' | 'startedAt' | 'completedAt' | 'health'>,
  nowMs: number,
): number | null {
  const start = Date.parse(run.startedAt)
  if (Number.isNaN(start)) return null
  let endMs: number
  if (run.status === 'running') {
    endMs = nowMs
  } else if (run.completedAt !== undefined) {
    const parsed = Date.parse(run.completedAt)
    endMs = Number.isNaN(parsed) ? start : parsed
  } else {
    const lastProgress = run.health?.lastProgressAt
    if (lastProgress === undefined || lastProgress < start) return null
    endMs = lastProgress
  }
  return Math.max(0, endMs - start)
}

// ── [可视化 U5/D11] 事件流缓存条目（runId 分区值形态）─────────────────────────

/**
 * 单 run 事件流缓存条目（workflow-visualization D11②：overlay 关闭不清——重开秒显；
 * session 删除随 clearSession 清；LRU 上界 5）。错误二分数据源（设计 §3.1-2 降级路径）：
 * errorCode = 结构化领域回执（record_not_found——静态指引无重试按钮）；errorMessage =
 * RPC 通道错误（暂时性失败——子页错误 + 重试按钮）。
 */
export interface WorkflowRunEventsEntry {
  /** 归属主 session（clearSession 按 sid 反查清理的依据）。 */
  sessionId: string
  status: 'loading' | 'ready' | 'error'
  /** 事件流原文行（status === 'ready' 时有值；行形态含截断标注，见 WorkflowRunEventEntry）。 */
  events?: WorkflowRunEventEntry[]
  /** 结构化领域回执错误码（协议闭集 = record_not_found）。 */
  errorCode?: WorkflowRunEventsErrorCode
  /** RPC 通道错误消息（恢复指引展示位）。 */
  errorMessage?: string
  /**
   * oversize 降级标志（[RT-4#8] 语义同 subagent/workflow 列表款，run 粒度）：record
   * 文件超 32MB 读取上限——runtime 不全文读取，events 恒空数组 + 本标志置位；
   * 「不可用」与「无数据」（eventsEmpty）显式分形，事件流子页按标志显示降级提示。
   */
  oversize?: boolean
}

export const useWorkflowStore = defineStore('workflow', () => {
  // ── state ──
  /**
   * 按 sessionId 分区的 workflow 列表（ADR-0049 Map 分区派）。
   * 切走不清、切回直接读 Map 分区；deleteSession 经 clearSession(sid) 精确释放。
   * 四件套实现单源在 lib/partitioned-session-records（S4 A1，行为逐字等价迁移）。
   */
  const partition = createPartitionedRecords<WorkflowRunRecord>()

  /**
   * 每 session 加载态三件套（loading / loadError / oversize 分区，ADR-0049 派）。
   * 实现单源在 lib/partitioned-session-records 的 createPartitionedLoadState
   * （待裁决项 1 收敛 2026-10-04，原手抄 71 行退役）；facet 的领域语义注释保留在各
   * 使用点——与 subagent store 同款（loading：split 双面板互不遮蔽；loadError：失败设
   * 该 sid 分区错误消息、分区数据保留旧值不清空；oversize：[RT-4#8] 列表不可用降级提示，
   * 置位时保留旧分区数据）。
   */
  const loadState = createPartitionedLoadState()
  const { isLoadingOf, loadErrorOf, oversizeOf } = loadState

  /**
   * [M7 D6] mainSessionId → Set<agentCallVirtualId> 映射。
   * agentcall 虚拟 key 是两段式（agentcall:<agentCallSessionId>），不含 mainSid 命名空间，
   * 主 session delete 时无法按前缀定位。此映射让 deleteSession 经它清全部 agentcall virtualId。
   */
  const mainSessionAgentCalls = new Map<string, Set<string>>()

  /**
   * [W0/D4] per-session in-flight 拉取登记（并发失效共享一次拉取）。
   * 同 sid 在途期间的新调用（信号 / running 重试）不另起 RPC——返回在途 promise 并置
   * dirty，由在途完成后的补拉兜底。renderer 的信号一次性不可重放，只合并不补拉会丢
   * 更新（起步竞态 / 终态吞没两个真实交织，设计 D4）。
   * 「同 key 复用 / settle 即清 / 引用比对防误删 / settle 清理链无 unhandled rejection」
   * 四不变量收编于 createInflightDedup（C-data-18：D9 共享原语，禁手写同构实现）。
   */
  const inflightDedup = createInflightDedup<void>()

  /**
   * [W0/D4] per-session dirty 标志（可再武装）：在途拉取期间有新信号到达置位；在途完成
   * 时若置位 → 清位补拉一次。补拉自身在途期间新信号同样置位 → 再补，不设递归上限
   * （链深天然有界：每条信号至多驱动一次拉取——自启或转补拉）。一次性消费标志
   * （delete 原子裁决）：同周期多个调用方各挂的 drain 中恰有一个消费到补拉。
   * 与 in-flight 同为非响应式簿记，随 clearWorkflows / clearSession / onScopeDispose
   * 三点清理（releaseLoadBookkeeping），防已删 session 的幻影补拉复活已删分区。
   */
  const dirtyWorkflows = new Map<string, boolean>()

  /**
   * [W0/D4] 释放 sid 的拉取收敛簿记（clearSession / clearWorkflows / dispose 收口点共用）。
   */
  function releaseLoadBookkeeping(sessionId: string): void {
    inflightDedup.delete(sessionId)
    dirtyWorkflows.delete(sessionId)
  }

  // [W15] 防御性清理：参照 subagent.ts 的 onScopeDispose 模式（原 running 重试 timer 的
  // clearTimeout 簿记随 500ms 盲等重试删除——待裁决项 5 根治，无 timer 即无清理义务）。
  // mainSessionAgentCalls 由 clearWorkflows / clearAgentCallMapping 显式管理（业务路径触发），
  // 此处不重复清理（避免与 deleteSession 的精确清理冲突）。
  if (getCurrentScope()) {
    onScopeDispose(() => {
      // [W0/D4] 拉取收敛簿记一并清：在途 promise 完成后的 drainDirty 读到空簿记 → 不补拉
      inflightDedup.clear()
      dirtyWorkflows.clear()
      // [可视化 U5/D11] 事件流簿记随实例回收（缓存 Map 本体随 ref 回收；LRU 序、活跃 run
      // 锚与在途去重是实例级非持久状态，清空防旧实例幻影写入）
      runEventsLruOrder.length = 0
      activeWorkflowRun.value = null
      runEventsInflight.clear()
    })
  }

  /**
   * 响应式视图：指定 session 的 workflow 列表（供组件 computed 订阅，对齐 command.ts commandsOf）。
   * 切会话时读不同分区，records 变化自动重算。
   */
  function recordsOf(sessionId: string): ComputedRef<WorkflowRunRecord[]> {
    return partition.recordsOf(sessionId)
  }

  /** 非响应式读：指定 session 的 workflow 列表（不写 Map，无则空数组） */
  function getRecordsBySession(sessionId: string): WorkflowRunRecord[] {
    return partition.get(sessionId)
  }

  /**
   * 该 session 是否有进行中的 workflow（供 derivedStatus 计算 hasBackgroundWork）。
   * [D2] 三态维持现状语义：interrupted（暂停态）不计入进行中——判据 `status ===
   * 'running'` 自然排除（显式裁决：中断 run 事件流静止，无后台工作量）。
   */
  function hasRunningWorkflow(sessionId: string): boolean {
    return getRecordsBySession(sessionId).some((s) => s.status === 'running')
  }

  /**
   * 写入指定 session 的 workflow 列表（不可变写，确保 Map 响应性触发）。
   * store 私有（仅 loadWorkflows 内部消费），不在导出面——分区写权威入口是 loadWorkflows
   * 拉取，无生产直写场景；计数等派生一律从 recordsOf 分区读侧派生。
   */
  function applyRecords(sessionId: string, list: WorkflowRunRecord[]): void {
    partition.apply(sessionId, list)
  }

  /** 清除指定 session 的 workflow 列表分区（deleteSession 调，防泄漏，ADR-0049 AC-8） */
  function clearSession(sessionId: string): void {
    partition.clear(sessionId)
    loadState.clear(sessionId)
    // [W0/D4] 拉取收敛簿记随分区一并释放（dirty 不复活已删分区）
    releaseLoadBookkeeping(sessionId)
    // [可视化 U5/D11⑤] 该 session 名下 run 的事件流缓存随分区一并释放；活跃 run 归属该
    // session 时清除活跃锚（overlay 关闭编排归 useSidebar.deleteSession 链，数据面在此收口）
    clearRunEventsBySession(sessionId)
  }

  // ── [可视化 U5/D11] 事件流缓存（runId 分区）+ 活跃 run 锚（在途丢弃检查）────────
  //
  // 生命周期五条（D11）：
  // ① 在途丢弃检查——overlay 关闭/切换 run 后返回的拉取结果一律丢弃（activeWorkflowRun
  //    校验，对齐 SearchModal close 后不再调度查询先例）；
  // ② 缓存按 runId 分区——overlay 关闭不清（重开秒显）、session 删除随 clearSession 清、
  //    LRU 上界 5（防长会话内存累积）；
  // ③ 切换 run——关全部 run 级 tab 归 overlay 容器（面板按 runId 重挂载，tab 随挂载态
  //    消亡）；store 侧活跃锚换指 + 在途丢弃即数据面完备；
  // ④ agentcall 分区——复用现状 LRU 联动与 registerAgentCall（面板 agent tab 经
  //    useSubagentTabData 走既有编排，本 store 零新增）；
  // ⑤ session 删除——clearSession 扩展清缓存与活跃锚（上方 clearSession 内）。

  const WORKFLOW_RUN_EVENTS_LRU_LIMIT = 5
  /** runId → 事件流缓存条目（D11②；overlay 关闭不清）。 */
  const runEventsByRun = ref(new Map<string, WorkflowRunEventsEntry>())
  /** LRU 访问序（最近使用在后；元素 = runId。非响应式簿记）。 */
  const runEventsLruOrder: string[] = []
  /**
   * 活跃 run（overlay 正在查看的 run）——在途拉取 settle 时的丢弃检查锚（D11①）。
   * 面板挂载/卸载经 setActiveWorkflowRun 登记。overlay 全局单例 → 至多一个活跃 run。
   */
  const activeWorkflowRun = ref<{ sessionId: string; runId: string } | null>(null)

  /**
   * [可视化 U5/D11] 事件流拉取在途去重（runId 级键）：组装 createInflightDedup 共享
   * 原语（C-data-18——「同 key 并发异步操作去重」禁手写同构实现）。同 runId 在途期间的
   * 新调用（含 force）共享在途 promise 不另起 RPC；settle 即清 + 引用比对防误删由原语
   * 内建。缓存条目（runEventsByRun）只承载 loading/ready/error 展示三态，不兼任去重簿记
   * ——「在途合并」判据不再落在条目 status 上（残留 loading 条目不会拦截后续拉取）。
   * 随 clearSession / clearWorkflows / dispose 三点与缓存一并释放。
   */
  const runEventsInflight = createInflightDedup<void>()

  /**
   * [可视化 D11] 活跃 run 信号纪元（每次 workflowUpdate 信号命中活跃 run 分支时自增）。
   * 消费方 = overlay 内的 agent tab 快照面（AgentTabContent watch 本纪元重调快照拉取，
   * 设计 §3.1-2/D8「实时性由列表 status + workflowUpdate 信号重新拉取体现」的 agentcall
   * 半边接线）；纪元自增即代表「活跃 run 有新信号」，重拉目标由消费方各自的 virtualId 决定。
   */
  const activeRunSignalEpoch = ref(0)

  /** 活跃 run 登记（面板挂载时 set；切换 run = 新面板先 set 覆盖）。 */
  function setActiveWorkflowRun(sessionId: string, runId: string): void {
    activeWorkflowRun.value = { sessionId, runId }
  }

  /**
   * 活跃 run 条件释放（面板卸载时调）：仅当锚仍是 (sessionId, runId) 本尊时才清 null。
   * 条件化原因：Vue 替换组件时旧面板 onUnmounted 晚于新面板 setup——无条件清会误删新
   * 面板刚登记的锚（切 run 时序）。判据复用 isActiveRun（同一定义，防双处漂移）。
   */
  function releaseActiveWorkflowRun(sessionId: string, runId: string): void {
    if (isActiveRun(sessionId, runId)) {
      activeWorkflowRun.value = null
    }
  }

  function touchRunEventsLru(runId: string): void {
    const idx = runEventsLruOrder.indexOf(runId)
    if (idx >= 0) runEventsLruOrder.splice(idx, 1)
    runEventsLruOrder.push(runId)
  }

  function removeFromRunEventsLru(runId: string): void {
    const idx = runEventsLruOrder.indexOf(runId)
    if (idx >= 0) runEventsLruOrder.splice(idx, 1)
  }

  /** LRU 超界驱逐（活跃 run 移队尾保留——正在显示的 run 不驱逐；至多绕活跃一圈必收敛）。 */
  function evictRunEventsLru(): void {
    while (runEventsLruOrder.length > WORKFLOW_RUN_EVENTS_LRU_LIMIT) {
      const victim = runEventsLruOrder.shift()
      if (victim === undefined) break
      if (activeWorkflowRun.value?.runId === victim) {
        runEventsLruOrder.push(victim)
        continue
      }
      runEventsByRun.value.delete(victim)
    }
  }

  /** D11⑤ 清理执行体（clearSession 调）。 */
  function clearRunEventsBySession(sessionId: string): void {
    for (const [runId, entry] of runEventsByRun.value) {
      if (entry.sessionId === sessionId) {
        runEventsByRun.value.delete(runId)
        removeFromRunEventsLru(runId)
        // 在途去重簿记随条目一并释放：已删 session 的在途拉取结果会被活跃锚检查丢弃，
        // 不让后续调用并入这条注定丢弃的在途（无 loading 占位可显示的静默窗口）
        runEventsInflight.delete(runId)
      }
    }
    if (activeWorkflowRun.value?.sessionId === sessionId) activeWorkflowRun.value = null
  }

  /** 指定 run 的事件流缓存读（响应式——组件 computed 内调用建立依赖）。 */
  function runEventsOf(runId: string): WorkflowRunEventsEntry | undefined {
    return runEventsByRun.value.get(runId)
  }

  /**
   * D11① 在途丢弃的收尾（settle 且活跃锚已切走时由 performLoadRunEvents 调用）：撤除本次
   * 拉取发起时写的 loading 占位条目——结果已被丢弃，条目若残留则该 run 的事件流分区永久
   * 显示加载中（幻影 loading 展示）。status === 'loading' 条件防误删：只撤本次拉取的
   * loading 占位，不碰已被新拉取覆盖的条目（同 runId 并发拉取已被 runEventsInflight 合并，
   * loading 态至多一条，无交错窗口）。
   */
  function discardStaleRunEvents(sessionId: string, runId: string): void {
    const entry = runEventsByRun.value.get(runId)
    if (entry?.status === 'loading' && entry.sessionId === sessionId) {
      runEventsByRun.value.delete(runId)
      removeFromRunEventsLru(runId)
    }
  }

  /**
   * 事件流拉取执行体（loadWorkflowRunEvents 收敛壳内调用；只做「发起 + 写缓存」）。
   * 在途合并由 runEventsInflight 承载（同 runId 仅首次发起，复用者共享 promise）。
   */
  async function performLoadRunEvents(sessionId: string, runId: string): Promise<void> {
    runEventsByRun.value.set(runId, { sessionId, status: 'loading' })
    touchRunEventsLru(runId)
    evictRunEventsLru()
    try {
      const reply = await sessionApi.getWorkflowRunEvents(sessionId, runId)
      if (!isActiveRun(sessionId, runId)) {
        discardStaleRunEvents(sessionId, runId) // D11① 在途丢弃（撤 loading 占位防幻影 loading）
        return
      }
      if ('events' in reply) {
        runEventsByRun.value.set(runId, {
          sessionId,
          status: 'ready',
          events: reply.events,
          // oversize 降级标志透传（[RT-4#8] 分形：events 恒空 + oversize=true——
          // 「record 过大不可用」，与「run 无事件」显式区分，子页按标志降级提示）
          ...(reply.oversize ? { oversize: true } : {}),
        })
      } else {
        runEventsByRun.value.set(runId, {
          sessionId,
          status: 'error',
          errorCode: reply.code,
          errorMessage: reply.message,
        })
      }
    } catch (e) {
      if (!isActiveRun(sessionId, runId)) {
        discardStaleRunEvents(sessionId, runId) // D11① 同检（关后失败的拉取同样不复活条目）
        return
      }
      const msg = e instanceof Error ? e.message : String(e)
      runEventsByRun.value.set(runId, { sessionId, status: 'error', errorMessage: msg })
    }
  }

  /** D11① 活跃锚判据（overlay 正在查看该 run）。 */
  function isActiveRun(sessionId: string, runId: string): boolean {
    const anchor = activeWorkflowRun.value
    return anchor !== null && anchor.runId === runId && anchor.sessionId === sessionId
  }

  /**
   * 事件流拉取入口（面板挂载首拉 / 信号触发 force 重拉 / 子页重试按钮 force）。
   * 缓存语义（run 级粒度）：ready 缓存复用（force 覆盖重拉）；error 态非 force 不自动
   * 重拉（重试是用户显式动作——record_not_found 静态指引恒无重试）；在途合并由
   * runEventsInflight 承载（force 在途窗口到达同样并入该次在途，不另起 RPC——
   * 同 runId 的新数据由后续信号/重开再触发拉取送达）。
   */
  function loadWorkflowRunEvents(sessionId: string, runId: string, opts?: { force?: boolean }): Promise<void> {
    if (!sessionId || !runId) return Promise.resolve() // 空 sid/runId 不写分区（对齐 loadWorkflows 同款守卫）
    const existing = runEventsByRun.value.get(runId)
    if (!opts?.force && existing?.status === 'ready') {
      touchRunEventsLru(runId)
      return Promise.resolve()
    }
    if (!opts?.force && existing?.status === 'error') return Promise.resolve()
    const { promise } = runEventsInflight.run(runId, () => performLoadRunEvents(sessionId, runId))
    return promise
  }

  // ── actions ──
  /**
   * 加载 session 的 workflow 列表（写入该 sid 分区）——[W0/D4] 拉取收敛入口。
   *
   * 并发语义（per-session 键：split mode 双面板与 routeInbound 对所有 session 无条件
   * 触发是常态，全局单例键会跨 session 互吞拉取）：
   * - in-flight 合并：同 sid 在途期间的新调用共享在途 promise（不另起 RPC），同时置 dirty；
   * - 可再武装 dirty 补拉：在途完成时 dirty 置位 → 清位补拉一次；补拉在途期间新信号
   *   同样置 dirty → 再补，不设递归上限。只合并不补拉会丢更新（起步竞态：run-created
   *   拉取在途期间 record 落盘；终态吞没：最后终态信号合并进 stale 在途拉取）；封顶版
   *   dirty（只补一次）会在补拉在途窗口复刻终态吞没，故 dirty 必须可再武装。
   *
   * 现行调用拓扑：托盘首拉/retry（useTrayCounts，D13 首拉触发迁移）、abort 后刷新
   * （TrayNativePanel / drawer WorkflowTab）、WS 重连重拉（useSidebar.onConnected）、
   * workflowUpdate 信号（triggerWorkflowReload）。
   */
  function loadWorkflows(sessionId: string): Promise<void> {
    if (!sessionId) return Promise.resolve() // 空 sid 不写分区
    if (inflightDedup.has(sessionId)) {
      // 新信号到达：共享在途拉取 + 置 dirty，由在途完成后的补拉兜底（不丢更新）
      dirtyWorkflows.set(sessionId, true)
    }
    const { promise } = inflightDedup.run(sessionId, () => performLoadWorkflows(sessionId))
    // 执行体不 reject（失败写 loadError 分区），两分支同 drain——补拉判定在成功/失败
    // 路径都成立（失败后的补拉由后续信号驱动，与成功路径语义一致）。drain 晚于 factory
    // 内建的 settle 清理注册（promise 回调按注册序）：drain 执行时条目已清，补拉经
    // loadWorkflows 重新登记在途，不会命中本周期残留条目形成自引用
    return promise.then(
      () => drainDirtyAfterLoad(sessionId),
      () => drainDirtyAfterLoad(sessionId),
    )
  }

  /**
   * [W0/D4] 在途完成后的补拉判定（可再武装语义的收口点）：dirty 置位则清位补拉，补拉经
   * loadWorkflows 重新登记在途，返回值串进本 drain 所属调用方的 promise 链。每个调用方
   * （发起方与合并方）各挂一个 drain：dirty 是一次性消费标志（delete 原子裁决），恰有
   * 一个 drain（注册最早的发起方）await 到「含补拉的完整收敛」，其余 drain no-op 先行
   * settle——补拉写入分区后数据经响应式到达，合并方无需串行等待补拉完成。settle 即清 +
   * 引用比对防误删（clearSession / clearWorkflows / dispose 清位后，旧 promise settle 不
   * 动同 key 新登记的条目）由 createInflightDedup 内建；dirty 同点清理保证被清 session
   * 无幻影补拉。
   */
  function drainDirtyAfterLoad(sessionId: string): Promise<void> {
    if (dirtyWorkflows.delete(sessionId)) {
      return loadWorkflows(sessionId)
    }
    return Promise.resolve()
  }

  /** 实际拉取执行体（loadWorkflows 收敛壳内调用；失败不抛——写 loadError 分区） */
  async function performLoadWorkflows(sessionId: string): Promise<void> {
    loadState.beginLoad(sessionId)
    try {
      // [RT-4#8] 结构化返回：oversize=true（文件 >32MB 列表不可用）置降级标志 + 保留旧
      // 分区数据（不可用 ≠ 删空）；面板显示降级提示而非空列表。
      // [待裁决项 4] found=false = 会话不在册（pi 延迟落盘窗口 / 扫描竞态）——保留分区
      // 不覆盖；found=true 的空列表是真实空，直接覆盖（原连续空计数 strike 守卫随歧义
      // 根治退役）。缺省（undefined，mock / 旧 runtime）按 found 处理。推送路径不经本判定。
      const { workflows: records, oversize, found } = await sessionApi.getWorkflows(sessionId)
      if (oversize) {
        loadState.setOversize(sessionId)
        return
      }
      loadState.clearOversize(sessionId)
      if (found === false) return
      applyRecords(sessionId, records)
    } catch (e) {
      // M1：失败不覆盖现有分区（保留旧数据），设该 sid 分区 loadError
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[workflow-store] loadWorkflows failed:', e)
      loadState.setLoadError(sessionId, msg)
    } finally {
      loadState.endLoad(sessionId)
    }
  }

  /**
   * workflow 增量信号处理：信号到达即拉一次全量列表（running 与否同待遇）。
   *
   * runtime 在 workflow 发起/结束时刻推送 session.workflowUpdate 增量信号，前端收到后触发
   * loadWorkflows RPC 拉取完整列表。由 useConnection.routeInbound 在所有 session（含非活跃）
   * 无条件兜底调用——不能只依赖 per-focus 订阅（切走即退订 → 终态丢弃 → 托盘/详情缺终态）。
   *
   * [时间平抑红线登记]（原 RUNNING_RETRY_MS=500 running 信号盲等重试已删除——待裁决项 5
   * 根治 2026-10-04）：
   *   原 500ms 延迟重试补偿的根因：担忧 workflow-state-link 条目刚 append 还未落盘稳定，
   *   信号后的首次拉取可能空。该担忧属 [W1/D6] 读侧换源（磁盘直读时代）的残留——现行信号
   *   由 runtime 投影合并后发出（session-records.ts publishRecordChanges），renderer 拉取
   *   读同一投影实例：信号发出时数据构造性可读，首拉空的时序窗口不存在；runtime 发射点
   *   另有可读性门（filterReadableWorkflowSignals）拦截未来信号源与读源解耦的形态，
   *   不可读则推迟到下一轮水位 diff（无定时器）。会话不在册窗口（found=false）由
   *   [待裁决项 4] 的保留分区语义承接，不靠时间兜底。
   *   退役条件（重审触发）：pi 侧出现「信号发出时数据不必然可读」的机制变化（信号源与
   *   读源解耦且 runtime 可读性门未覆盖）——届时在 runtime 发射点补读前校验，禁止恢复
   *   消费侧定时盲等。
   *
   * @param sessionId 信号归属的 session ID
   * @param status 信号里的 workflow status（[D2] 显式裁决：interrupted 与终态同待遇只拉
   *   一次——中断 run 事件流静止，resume 复活变 running 后随下一次信号刷新）
   */
  function triggerWorkflowReload(sessionId: string): void {
    const sid = sessionId
    // 增量信号 → 立即拉取完整列表
    void loadWorkflows(sid)
    // [可视化 U5/D4] overlay 活跃 run 的事件流重新拉取（§3.1-4：overlay 订阅 run 级信号
    // 触发 getWorkflows + 事件流重新拉取——store 内聚合接线，信号处理链零改动）。force
    // 覆盖 ready 缓存；在途丢弃检查由 performLoadRunEvents 内建（信号到达时 overlay 已切
    // 走的结果自动丢弃）。无 500ms 延迟：事件流与 getWorkflows 同链读 record 文件，信号
    // 由 runtime 投影发出时 record 帧已落盘（构造性时序，无需时间平抑兜底）。
    const anchor = activeWorkflowRun.value
    if (anchor !== null && anchor.sessionId === sid) {
      void loadWorkflowRunEvents(sid, anchor.runId, { force: true })
      // [可视化 D11] 信号纪元自增——通知活跃 run 的 agent tab 快照面重拉（§3.1-2：
      // 对话流子页 = 拉取时刻快照 + 信号触发重新拉取；事件流 force 重拉之外，
      // agentcall 快照通道同链刷新）
      activeRunSignalEpoch.value += 1
    }
  }

  /** 清空所有 workflow 分区 + 清 agentcall 映射（全局重置场景用） */
  function clearWorkflows(): void {
    // RD-3#12：整表替换 records + 全清 loading/error（+ oversize）三 facet，与 clearSession
    // 全清对齐——残留 loading=true → spinner 永转 / 残留 error → 错误态卡死。
    partition.recordsBySession.value = new Map()
    // W3-2：清非响应式的 mainSessionAgentCalls（registerAgentCall 写入，deleteSession/clearWorkflows 调本函数清）
    mainSessionAgentCalls.clear()
    loadState.clearAll()
    // [W0/D4] 拉取收敛簿记一并清（同 clearSession / dispose 三点清理义务）
    inflightDedup.clear()
    dirtyWorkflows.clear()
    // [可视化 U5/D11] 事件流缓存 + LRU 序 + 活跃 run 锚 + 在途去重簿记随全局重置一并清
    runEventsByRun.value = new Map()
    runEventsLruOrder.length = 0
    activeWorkflowRun.value = null
    runEventsInflight.clear()
  }

  /**
   * [U7 MUST_FIX 1] 登记 agentcall 虚拟 key 到主 session 清理映射。
   *
   * drawer SubagentTab agentcall 分支（workflow tab 点 agent call 入口）拉取历史 + setMessages 后，
   * 调本方法登记 virtualId → mainSessionId。deleteSession 时 cleanupSessionState 经
   * getAgentCallVirtualIdsByMain(mainSid) 反查全部 agentcall virtualId，逐一 evictVirtualKey 清理。
   *
   * 必要性：agentcall 虚拟 key 是两段式（agentcall:<acsId>），不含 mainSid 命名空间，
   * LRU isVirtualKeyOf 前缀清理（仅匹配 subagent:）覆盖不到，此映射是 agentcall 清理唯一通路。
   * 原 overlay 时代由 selectAgentCall 内部维护此映射；overlay 移除后 SubagentTab 显式调本方法接管。
   */
  function registerAgentCall(mainSessionId: string, virtualId: string): void {
    const set = mainSessionAgentCalls.get(mainSessionId) ?? new Set<string>()
    set.add(virtualId)
    mainSessionAgentCalls.set(mainSessionId, set)
  }

  /**
   * [M7 D6] 查询主 session 名下的全部 agentcall virtualId（deleteSession 调，精确清理不泄漏）。
   * 返回后调用方负责 delete messages[key]。virtualId 由 registerAgentCall 登记。
   * [B9] 消费方新增 LRU 联动驱逐（agentcall-lru-linkage 装配回调：筛除 viewedVids 后
   * 交 core lru.ts 执行删除）；deleteSession 路径仍全量清理（无豁免）。
   */
  function getAgentCallVirtualIdsByMain(mainSessionId: string): string[] {
    return [...(mainSessionAgentCalls.get(mainSessionId) ?? [])]
  }

  /** [M7 D6] deleteSession 后清映射条目（主 session 已删，映射无意义） */
  function clearAgentCallMapping(mainSessionId: string): void {
    mainSessionAgentCalls.delete(mainSessionId)
  }

  return {
    // state
    recordsBySession: partition.recordsBySession,
    isLoadingOf,
    loadErrorOf,
    oversizeOf,
    // per-session 分区读（ADR-0049 Map 分区派；写权威入口 = loadWorkflows 拉取，
    // applyRecords 为 store 私有）
    recordsOf,
    getRecordsBySession,
    hasRunningWorkflow,
    clearSession,
    // actions
    loadWorkflows,
    triggerWorkflowReload,
    clearWorkflows,
    // [可视化 U5/D11] 事件流缓存（runId 分区）+ 活跃 run 锚
    runEventsOf,
    setActiveWorkflowRun,
    releaseActiveWorkflowRun,
    loadWorkflowRunEvents,
    activeRunSignalEpoch,
    registerAgentCall,
    getAgentCallVirtualIdsByMain,
    clearAgentCallMapping,
  }
})
