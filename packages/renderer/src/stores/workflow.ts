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
import { createEmptyResultStrikeGuard, createPartitionedRecords } from '../lib/partitioned-session-records'

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

  /** 加载态（M1：loadWorkflows 在途时 true；per-session Map 分区，ADR-0049 派——
   * split 模式双面板并行拉取时，任一 pane 的在途/失败不得遮蔽另一 pane 的状态） */
  const loadingBySession = ref(new Map<string, boolean>())
  /** 加载错误（M1：失败时设该 sid 分区错误消息；缺省 null = 无错误；records 保留旧数据不清空.
   * 全局单值形态会把 pane A 的失败显示到 pane B 的面板（store 级串扰），分区化治根） */
  const loadErrorBySession = ref(new Map<string, string | null>())
  /**
   * [RT-4#8] oversize 降级标志（per-session 分区，语义同 subagent store）：session 文件
   * >32MB 时列表不可用（records 恒空），面板显示降级提示；置位时保留旧分区数据。
   */
  const oversizeBySession = ref(new Map<string, boolean>())

  /** per-session 加载态读取（消费方 computed 内调用建立响应依赖） */
  function isLoadingOf(sessionId: string): boolean {
    return loadingBySession.value.get(sessionId) ?? false
  }

  /** per-session 加载错误读取 */
  function loadErrorOf(sessionId: string): string | null {
    return loadErrorBySession.value.get(sessionId) ?? null
  }

  /** [RT-4#8] per-session oversize 降级读取（面板降级提示判据） */
  function oversizeOf(sessionId: string): boolean {
    return oversizeBySession.value.get(sessionId) ?? false
  }

  /**
   * [M7 D6] mainSessionId → Set<agentCallVirtualId> 映射。
   * agentcall 虚拟 key 是两段式（agentcall:<agentCallSessionId>），不含 mainSid 命名空间，
   * 主 session delete 时无法按前缀定位。此映射让 deleteSession 经它清全部 agentcall virtualId。
   */
  const mainSessionAgentCalls = new Map<string, Set<string>>()

  /**
   * [W3-3] sid → running 信号延迟重试的 setTimeout id 映射。
   * triggerWorkflowReload 对 running 信号调度 500ms 后的兜底 loadWorkflows，用此 Map 去重——
   * 同 sid 多次 running 信号只保留最后一次的重试 timer，旧 timer clearTimeout。store dispose
   * 时经 onScopeDispose 全部 clearTimeout，防 HMR 后操作已废弃的 store。
   */
  const workflowReloadTimers = new Map<string, ReturnType<typeof setTimeout>>()

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
   * [W0/D4] 释放 sid 的拉取收敛簿记 + running 重试 timer（clearSession / clearWorkflows /
   * dispose 收口点共用）。timer 清理此前只在 clearWorkflows / onScopeDispose，clearSession
   * 缺口是既有 bug（已删 session 的重试在 500ms 后对已清空的 store 触发 loadWorkflows），
   * 本次顺手补齐。
   */
  function releaseLoadBookkeeping(sessionId: string): void {
    inflightDedup.delete(sessionId)
    dirtyWorkflows.delete(sessionId)
    const timer = workflowReloadTimers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      workflowReloadTimers.delete(sessionId)
    }
  }

  /**
   * loadWorkflows 空结果守卫（R1 business-logic S3，与 subagent.ts 同款）：达到 LIMIT 判
   * 真实删空放行覆盖。strike 语义单源在 createEmptyResultStrikeGuard JSDoc
   * （lib/partitioned-session-records），此处只声明本 store 的阈值与 log tag。
   */
  const EMPTY_RESULT_STRIKE_LIMIT = 2
  const strikeGuard = createEmptyResultStrikeGuard(EMPTY_RESULT_STRIKE_LIMIT, 'workflow-store', 'getWorkflows')

  // [W15] 防御性清理：workflowReloadTimers 是模块级 Map（不在 ref 里），HMR / store dispose
  // 时若不主动 clearTimeout，在途的 running 重试 timer 仍会在 500ms 后触发 loadWorkflows(sid)
  // 操作已废弃的 store。参照 subagent.ts 的 onScopeDispose panelStreamUnsub 模式。
  // mainSessionAgentCalls 由 clearWorkflows / clearAgentCallMapping 显式管理（业务路径触发），
  // 此处不重复清理（避免与 deleteSession 的精确清理冲突）。
  if (getCurrentScope()) {
    onScopeDispose(() => {
      workflowReloadTimers.forEach((t) => clearTimeout(t))
      workflowReloadTimers.clear()
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
    strikeGuard.reset(sessionId)
    partition.clear(sessionId)
    loadingBySession.value.delete(sessionId)
    loadErrorBySession.value.delete(sessionId)
    oversizeBySession.value.delete(sessionId)
    // [W0/D4] 簿记 + running 重试 timer 随分区一并释放（dirty 不复活已删分区；timer 缺口补齐）
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
    loadingBySession.value.set(sessionId, true)
    loadErrorBySession.value.delete(sessionId)
    try {
      // [RT-4#8] 结构化返回：oversize=true（文件 >32MB 列表不可用）置降级标志 + 保留旧
      // 分区数据（不经 strike guard——不可用 ≠ 删空）；面板显示降级提示而非空列表。
      const { workflows: records, oversize } = await sessionApi.getWorkflows(sessionId)
      if (oversize) {
        strikeGuard.reset(sessionId)
        oversizeBySession.value.set(sessionId, true)
        return
      }
      oversizeBySession.value.delete(sessionId)
      // 空结果守卫（sidebar-sync-plan P1 + R1 business-logic S3，与 subagent.ts 同款）：
      // strike 语义单源在 createEmptyResultStrikeGuard JSDoc（lib/partitioned-session-records），
      // 此处只判定 + 覆盖前清零。推送路径是权威数据，不经此守卫。
      if (
        strikeGuard.shouldKeepExisting(sessionId, records.length, getRecordsBySession(sessionId).length)
      ) {
        return
      }
      strikeGuard.reset(sessionId)
      applyRecords(sessionId, records)
    } catch (e) {
      // M1：失败不覆盖现有分区（保留旧数据），设该 sid 分区 loadError；strike 重置
      //（「连续 RPC 成功且空」语义纯净，读失败与数据空不同通道，不让 RPC 故障累计出误清分区）
      strikeGuard.reset(sessionId)
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[workflow-store] loadWorkflows failed:', e)
      loadErrorBySession.value.set(sessionId, msg)
    } finally {
      // delete 而非 set(sid, false)：load 在途时 clearSession 已删分区的话，set 会
      // 为已删 session 重生条目（残留）；get ?? false 缺省读取语义等价（无条目 = 不在途）
      loadingBySession.value.delete(sessionId)
    }
  }

  /** running 信号延迟重试间隔（ms）。workflow-state-link 可能刚写入，首次 RPC 拉取为空。 */
  const RUNNING_RETRY_MS = 500

  /**
   * workflow 增量信号处理：立即拉一次全量 + running 信号延迟重试。
   *
   * runtime 在 workflow 发起/结束时刻推送 session.workflowUpdate 增量信号，前端收到后触发
   * loadWorkflows RPC 拉取完整列表。由 useConnection.routeInbound 在所有 session（含非活跃）
   * 无条件兜底调用——不能只依赖 per-focus 订阅（切走即退订 → 终态丢弃 → 托盘/详情缺终态）。
   *
   * running 信号特殊处理：workflow tool-call-end 触发 running 信号时，主 session JSONL 的
   * workflow-state-link 可能刚 append 还未 flush（pi 延迟写入时序）。延迟 RUNNING_RETRY_MS 再拉一次兜底。
   *
   * @param sessionId 信号归属的 session ID
   * @param status 信号里的 workflow status（'running' 触发延迟重试，其他只拉一次。
   *   [D2] 显式裁决维持：interrupted 落「其他」分支只拉一次——中断 run 事件流静止
   *   无需轮询，resume 复活变 running 后自然进入重试分支）
   */
  function triggerWorkflowReload(sessionId: string, status: string): void {
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
    // running 信号延迟重试：workflow-state-link 可能刚写入，首次拉取为空
    if (status === 'running') {
      // W3-3：用模块级 Map 跟踪 timer，去重（同 sid 多次 running 信号只保留最后一次的重试）
      const existing = workflowReloadTimers.get(sid)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        workflowReloadTimers.delete(sid)
        void loadWorkflows(sid)
      }, RUNNING_RETRY_MS)
      workflowReloadTimers.set(sid, timer)
    }
  }

  /** 清空所有 workflow 分区 + 清 agentcall 映射（全局重置场景用） */
  function clearWorkflows(): void {
    // RD-3#12：先按当前分区键重置 strike 簿记（strike 仅在对非空分区连续空结果时残留，
    // recordsBySession 键即残留 strike 键全集），再整表替换 + 清 loading/error/oversize 三
    // facet（+ oversize），与 clearSession 全清对齐——否则残留 loading=true → spinner 永转 /
    // 残留 error → 错误态卡死 / 残留 strike → 重新预置后首次空结果误判删空。顺带清在途 running
    // 重试 timer（否则 500ms 后对已清空的 store 触发 loadWorkflows）。
    for (const sid of partition.recordsBySession.value.keys()) strikeGuard.reset(sid)
    partition.recordsBySession.value = new Map()
    // W3-2：清非响应式的 mainSessionAgentCalls（registerAgentCall 写入，deleteSession/clearWorkflows 调本函数清）
    mainSessionAgentCalls.clear()
    loadingBySession.value = new Map()
    loadErrorBySession.value = new Map()
    oversizeBySession.value = new Map()
    workflowReloadTimers.forEach((t) => clearTimeout(t))
    workflowReloadTimers.clear()
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
