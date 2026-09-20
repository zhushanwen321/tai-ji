/**
 * Extension UI store —— 统一表单 / dialog pending 请求的 session 级 SSOT。
 *
 * 依赖方向：无（stores 间禁止互相 import，对齐 subagent.ts / workflow.ts 铁律）。
 * 只 import 类型（ExtensionUIRequest），不 import 其他 store。
 *
 * 背景（CW wave `session-active-ssot` T1）：
 * 原表单 pending 状态困在 useExtensionUI composable 的 Panel 实例局部作用域
 *（useSessionScopedState reactive 数组），store/deriveStatus 读不到，导致表单提问
 * 等待期间对话流收起（bug）。本 store 把 pending 提升为 session 级 store SSOT，供
 * derivedStatus computed 经 hasPendingBlockingOverlay 非响应式查询当前 session 是否有
 * 阻塞 overlay 在等。
 *
 * 范式（镜像 subagent.ts / command.ts，ADR-0049 Map 分区派）：
 * - requestsBySession: ref<Map<sessionId, ExtensionUIRequest[]>> —— per-sessionId 分区
 * - recordsOf(sessionId): ComputedRef —— 响应式视图，组件订阅用
 * - getRequestsBySession(sessionId): ExtensionUIRequest[] —— 非响应式读（无则空数组）
 * - hasPendingBlockingOverlay / hasPendingDialog: 非响应式 getter，供 derivedStatus
 *   computed 内调（hasPendingBlockingOverlay 语义 = 有 pending 统一表单 overlay：
 *   form 键，见函数注释）
 * - applyRecords / addRequest / removeRequest: 不可变 Map 写（new Map(...).set(...)）
 * - clearSession: deleteSession 精确释放分区（防泄漏）
 * - clearAllPending: runtime 重连全局清理（R3/T5）
 *
 * 该 store 只持有 pending 状态 SSOT；订阅建立 / RPC 拉取 / response 发送仍在
 * useExtensionUI composable（T2 范围把 composable 改为写入本 store）。
 */
import { defineStore } from 'pinia'
import type { ComputedRef } from 'vue'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import { createPartitionedRecords } from '../lib/partitioned-session-records'

export const useExtensionUIStore = defineStore('extension-ui', () => {
  // ── state ──
  /**
   * 按 sessionId 分区的 pending UI 请求（含统一表单富交互 form + 非 form dialog 原语）。
   * 切走不清、切回直接读 Map 分区；deleteSession 经 clearSession(sid) 精确释放。
   * 四件套实现单源在 lib/partitioned-session-records（S4 A1，行为逐字等价迁移）。
   */
  const partition = createPartitionedRecords<ExtensionUIRequest>()

  // ── 响应式视图（组件订阅用）──
  /**
   * 响应式视图：指定 session 的 pending UI 请求（供组件 computed 订阅，对齐 subagent.ts recordsOf）。
   * 切会话时读不同分区，requestsBySession 变化（不可变替换）自动重算。
   */
  function recordsOf(sessionId: string): ComputedRef<ExtensionUIRequest[]> {
    return partition.recordsOf(sessionId)
  }

  // ── 非响应式读（getter / derivedStatus computed 内调）──
  /** 非响应式读：指定 session 的 pending 请求（不写 Map，无则空数组，对齐 subagent.ts getRecordsBySession） */
  function getRequestsBySession(sessionId: string): ExtensionUIRequest[] {
    return partition.get(sessionId)
  }

  /**
   * 该 session 是否有统一表单 overlay 请求 pending（form 键；核心查询，
   * 对称 subagent.ts hasRunning）。三消费方（经本 getter 扩义自动联动）：
   * deriveStatus waiting 状态点判定源（useSessionDerivations）；原 TurnProgressBar warn 豁免消费方已随 remove-turn-progress-bar 移除
   * （getAwaitingUser 回调——scheduler 确认等待同样 block turn，漏接则等待超
   * 10min 被误挂「turn 超时」警示）；③ usePanelView 挂载判据（经 currentFormRequest
   * computed，同谓词）。
   *
   * 判定键（ui-presentation-protocol D5 收敛）：form 键——新 form 帧原生携带、
   * legacy askUser / scheduleCreate 帧经 useExtensionUI 归一层附加后统一命中
   *（store 记录入队前必经归一，双挂点见 normalizeFormRequest 注释）。
   *
   * 非响应式普通函数：供 derivedStatus computed 内调用，computed 通过其引用的响应式
   * requestsBySession 建立依赖（写入时不可变替换 ref，触发重算）。
   */
  function hasPendingBlockingOverlay(sessionId: string): boolean {
    return getRequestsBySession(sessionId).some(
      (r) => r.form === true,
    )
  }

  /**
   * 该 session 是否有非 overlay 类的简单原语 dialog pending（供外部消费者查询；当前无消费方，
   * 公共接口保留）。对称判据：form 类富交互 overlay 不归 dialog（漏排会把它误归
   * dialog 类，与 hasPendingBlockingOverlay 双真）。
   */
  function hasPendingDialog(sessionId: string): boolean {
    return getRequestsBySession(sessionId).some(
      (r) => r.form !== true,
    )
  }

  // ── 写操作（不可变 Map 替换，确保响应性触发）──
  /**
   * 写入指定 session 的 pending 请求（不可变写，确保 Map 响应性触发）。
   * @param sessionId 分区 key
   * @param requests runtime 推送 / RPC 拉取的请求列表（整体替换该分区）
   */
  function applyRecords(sessionId: string, requests: ExtensionUIRequest[]): void {
    partition.apply(sessionId, requests)
  }

  /**
   * 追加单个请求到指定 session 分区（不可变写）。
   * requestId dedup：若分区已有同 requestId 则不追加（迁移自 useExtensionUI push 去重，
   * 防实时帧 + RPC 拉取双源、或 split 模式两消费者重复入队）。
   */
  function addRequest(sessionId: string, request: ExtensionUIRequest): void {
    const prev = getRequestsBySession(sessionId)
    if (prev.some((r) => r.requestId === request.requestId)) return
    applyRecords(sessionId, [...prev, request])
  }

  /**
   * 移除单个请求（respond / cancel / timeout 调）。不可变写。
   * 按 requestId 精确移除：pi 无串行保证，队列可能同时有多个 pending。
   */
  function removeRequest(sessionId: string, requestId: string): void {
    const prev = getRequestsBySession(sessionId)
    if (!prev.some((r) => r.requestId === requestId)) return
    applyRecords(sessionId, prev.filter((r) => r.requestId !== requestId))
  }

  /** 清除指定 session 的 pending 分区（deleteSession 调，防泄漏，对齐 subagent.ts:171） */
  function clearSession(sessionId: string): void {
    partition.clear(sessionId)
  }

  /** 清空所有 session 的 pending（runtime 重连全局清理用，R3/T5） */
  function clearAllPending(): void {
    partition.recordsBySession.value = new Map()
  }

  return {
    // state
    requestsBySession: partition.recordsBySession,
    // 响应式视图
    recordsOf,
    // 非响应式读 / getter
    getRequestsBySession,
    hasPendingBlockingOverlay,
    hasPendingDialog,
    // 写操作（不可变 Map 替换）
    applyRecords,
    addRequest,
    removeRequest,
    clearSession,
    clearAllPending,
  }
})
