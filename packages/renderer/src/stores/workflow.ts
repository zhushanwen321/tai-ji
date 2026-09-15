/**
 * Workflow store —— workflow 列表 + sidebar 视图层级（列表/详情）+ agentcall 虚拟 key 清理映射。
 *
 * 依赖方向：无（stores 间禁止互相 import）。跨 store 编排（chatStore.setMessages 等）
 * 由调用方通过回调注入，store 内不 import 其他 store。
 *
 * 职责：
 * - 共享 workflow 列表（records）—— Sidebar 管理，所有 panel 只读消费
 * - sidebar 视图层级：detailRunIdMap（视图 2 选中的 workflow runId，仅影响 Sidebar 渲染）
 * - agentcall 虚拟 key 清理映射（mainSessionAgentCalls）：deleteSession 时清 agentcall 虚拟分区
 *
 * [HISTORICAL] overlay 展示层已于 U7 移除（drawer tab 化）：
 * 原 agentCallMap（Panel overlay 的 agent call sessionId）+ isViewing/getViewingAgentCallId/
 * getActiveAgentCallVirtualId + selectAgentCall/backFromAgentCall 均为 overlay 全屏替换模式产物。
 * drawer tab 并排模型下，agent call 详情在 drawer SubagentTab 内自治（直接 getAgentCallHistory +
 * setMessages），不再经 store overlay 状态机。agentcall 虚拟 key 的 deleteSession 清理映射
 * （mainSessionAgentCalls + getAgentCallVirtualIdsByMain + clearAgentCallMapping）保留——
 * isVirtualKeyOf 只匹配 subagent: 前缀不匹配 agentcall:，此映射是 agentcall 清理唯一通路
 * （review MUST_FIX 1）。drawer SubagentTab agentcall 分支经 registerAgentCall 登记到此映射。
 * sidebar 视图 2（detailRunIdMap + selectWorkflow/backToWorkflowList/getViewingRunId）保留——
 * 那是 sidebar 内的 workflow 详情视图，与 overlay 无关。
 *
 * 虚拟 session ID 格式：`agentcall:<sessionId>`（agent call 对话流）
 * chatStore.messages Map 支持任意 string key，直接用虚拟 session ID 注入消息。
 */
import { defineStore } from 'pinia'
import { getCurrentScope, onScopeDispose, ref } from 'vue'
import type { ComputedRef } from 'vue'
import type { WorkflowRunRecord } from '@xyz-agent/shared'
// 虚拟 session ID 工厂 SSOT 迁至 @xyz-agent/shared/virtual-session-id（跨层协议级约定）。
// 此处 re-export 保持现有 import 路径向后兼容；本 store body 清理逻辑用本地 import。
export {
  AGENTCALL_PREFIX,
  agentCallVirtualId,
  isAgentCallVirtualId,
  extractAgentCallSessionId,
} from '@xyz-agent/shared'
import { session as sessionApi } from '@/api'
import { createEmptyResultStrikeGuard, createPartitionedRecords } from '../lib/partitioned-session-records'

export const useWorkflowStore = defineStore('workflow', () => {
  // ── state ──
  /**
   * 按 sessionId 分区的 workflow 列表（ADR-0049 Map 分区派）。
   * 切走不清、切回直接读 Map 分区；deleteSession 经 clearSession(sid) 精确释放。
   * 四件套实现单源在 lib/partitioned-session-records（S4 A1，行为逐字等价迁移）。
   */
  const partition = createPartitionedRecords<WorkflowRunRecord>()

  /** 加载态（M1：loadWorkflows 在途时 true，组件据此显示 spinner） */
  const isLoading = ref(false)
  /** 加载错误（M1：loadWorkflows 失败时设错误消息，null = 无错误；records 保留旧数据不清空） */
  const loadError = ref<string | null>(null)

  /**
   * per-panel 侧边栏视图 2 选中状态（workflow detail）。
   * key = panelId, value = 该 panel 侧边栏正在查看的 workflow runId。
   * 仅影响 Sidebar 渲染（列表 vs detail）。
   */
  const detailRunIdMap = ref<Map<string, string>>(new Map())

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

  /** 该 session 是否有 workflow 仍在 running 或 paused（供 derivedStatus 计算 hasBackgroundWork） */
  function hasRunningOrPaused(sessionId: string): boolean {
    return getRecordsBySession(sessionId).some((s) => s.status === 'running' || s.status === 'paused')
  }

  /** 写入指定 session 的 workflow 列表（不可变写，确保 Map 响应性触发） */
  function applyRecords(sessionId: string, list: WorkflowRunRecord[]): void {
    partition.apply(sessionId, list)
  }

  /** 清除指定 session 的 workflow 列表分区（deleteSession 调，防泄漏，ADR-0049 AC-8） */
  function clearSession(sessionId: string): void {
    strikeGuard.reset(sessionId)
    partition.clear(sessionId)
  }

  // ── getters ──
  /**
   * 响应式视图：指定 session 的 workflow 计数（Sidebar badge 用，读取 recordsOf 分区）。
   * 旧的无参 workflowCount() 已移除（store 拿不到 focusedSessionId，调用方传 sid）。
   */
  function workflowCount(sessionId: string): number {
    return getRecordsBySession(sessionId).length
  }

  /** 本 panel 当前查看的 runId（侧边栏视图 2 详情态），非详情态返回 null */
  function getViewingRunId(panelId: string): string | null {
    return detailRunIdMap.value.get(panelId) ?? null
  }

  /** 本 panel 当前查看的 workflow record（视图 2 详情态，从 mainSessionId 分区查） */
  function getCurrentWorkflow(panelId: string, mainSessionId: string): WorkflowRunRecord | null {
    const rid = getViewingRunId(panelId)
    if (!rid) return null
    return getRecordsBySession(mainSessionId).find((w) => w.runId === rid) ?? null
  }

  // ── actions ──
  /**
   * 加载 session 的 workflow 列表（写入该 sid 分区）。
   * 在 Sidebar 切到 Flows tab 或 session 切换时调用。
   */
  async function loadWorkflows(sessionId: string): Promise<void> {
    if (!sessionId) return // 空 sid 不写分区
    isLoading.value = true
    loadError.value = null
    try {
      const records = await sessionApi.getWorkflows(sessionId)
      // 空结果守卫（sidebar-sync-plan P1 + R1 business-logic S3，与 subagent.ts 同款）：
      // strike 语义单源在 createEmptyResultStrikeGuard JSDoc（S4 A1），此处只判定 +
      // 覆盖前清零。推送路径是权威数据，不经此守卫。
      if (
        strikeGuard.shouldKeepExisting(sessionId, records.length, getRecordsBySession(sessionId).length)
      ) {
        return
      }
      strikeGuard.reset(sessionId)
      applyRecords(sessionId, records)
    } catch (e) {
      // M1：失败不覆盖现有分区（保留旧数据），设 loadError 让组件显示重试态；strike 重置
      //（「连续 RPC 成功且空」语义纯净，读失败与数据空不同通道，不让 RPC 故障累计出误清分区）
      strikeGuard.reset(sessionId)
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[workflow-store] loadWorkflows failed:', e)
      loadError.value = msg
    } finally {
      isLoading.value = false
    }
  }

  /** running 信号延迟重试间隔（ms）。workflow-state-link 可能刚写入，首次 RPC 拉取为空。 */
  const RUNNING_RETRY_MS = 500

  /**
   * workflow 增量信号处理：立即拉一次全量 + running 信号延迟重试。
   *
   * runtime 在 workflow 发起/结束时刻推送 session.workflowUpdate 增量信号，前端收到后触发
   * loadWorkflows RPC 拉取完整列表。由 useConnection.routeInbound 在所有 session（含非活跃）
   * 无条件兜底调用——不能只依赖 per-focus 订阅（切走即退订 → 终态丢弃 → 侧栏卡 running）。
   *
   * running 信号特殊处理：workflow tool-call-end 触发 running 信号时，主 session JSONL 的
   * workflow-state-link 可能刚 append 还未 flush（pi 延迟写入时序）。延迟 RUNNING_RETRY_MS 再拉一次兜底。
   *
   * @param sessionId 信号归属的 session ID
   * @param status 信号里的 workflow status（'running' 触发延迟重试，其他只拉一次）
   */
  function triggerWorkflowReload(sessionId: string, status: string): void {
    const sid = sessionId
    // 增量信号 → 立即拉取完整列表
    void loadWorkflows(sid)
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

  /** 清空所有 workflow 分区 + 退出侧边栏视图 2 + 清 agentcall 映射（全局重置场景用） */
  function clearWorkflows(): void {
    partition.recordsBySession.value = new Map()
    detailRunIdMap.value = new Map()
    // W3-2：清非响应式的 mainSessionAgentCalls（registerAgentCall 写入，deleteSession/clearWorkflows 调本函数清）
    mainSessionAgentCalls.clear()
  }

  /**
   * 进入侧边栏视图 2（workflow 详情，sidebar 内展示 phase/agent call）。
   * 写 detailRunIdMap（sidebar 视图 2 状态）。
   */
  function selectWorkflow(panelId: string, runId: string): void {
    const next = new Map(detailRunIdMap.value)
    next.set(panelId, runId)
    detailRunIdMap.value = next
  }

  /** 视图 2 → 视图 1（从 workflow 详情返回列表）。清 detailRunIdMap。 */
  function backToWorkflowList(panelId: string): void {
    const next = new Map(detailRunIdMap.value)
    next.delete(panelId)
    detailRunIdMap.value = next
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
    isLoading,
    loadError,
    // getters
    workflowCount,
    getViewingRunId,
    getCurrentWorkflow,
    // per-session 分区读写（ADR-0049 Map 分区派）
    recordsOf,
    getRecordsBySession,
    hasRunningOrPaused,
    applyRecords,
    clearSession,
    // actions
    loadWorkflows,
    triggerWorkflowReload,
    clearWorkflows,
    selectWorkflow,
    backToWorkflowList,
    registerAgentCall,
    getAgentCallVirtualIdsByMain,
    clearAgentCallMapping,
  }
})
