/**
 * Subagent store —— subagent 列表 + streaming 生命周期。
 *
 * 依赖方向：无（stores 间禁止互相 import）。跨 store 编排（chatStore.setMessages 等）
 * 由调用方通过回调注入，store 内不 import 其他 store。
 *
 * 职责：
 * - 共享 subagent 列表（records）—— Sidebar 管理，所有 panel 只读消费
 * - streaming 订阅（streamUnsub）—— 非响应式资源表，按 drawer scope token keyed（U8）
 *
 * [HISTORICAL] overlay 展示层已于 U7 移除（drawer tab 化）：
 * 原 per-panel viewing 状态机（panelViewingMap + isViewing/getViewingSubagentId/
 * getActiveSubagentVirtualId/getCurrentSubagent/setViewingSubagentId + selectSubagent/backToMain）
 * 与 tombstone 防复活（clearedVirtualIds/tryInjectIfNotCleared/clearSubagentTombstones）均为
 * overlay 全屏替换模式的产物。drawer tab 并排模型下，subagent 详情在 drawer SubagentTab 内
 * 自治（直接 fetchAndInject + subscribeStream），不再经 store viewing 状态机。
 * 数据加载层（records / fetchAndInject / subscribeStream / stopStream / streaming delta/finalize）
 * 完整保留，被 drawer SubagentTab 复用。
 *
 * 虚拟 session ID 格式：`subagent:<mainSessionId>:<subagentId>`（三段式）
 * chatStore.messages Map 支持任意 string key，直接用虚拟 session ID 注入消息。
 * 工厂 SSOT 在 @xyz-agent/shared/virtual-session-id（跨层协议级约定），本文件 re-export 保持
 * 现有 import 路径向后兼容。
 */
import { defineStore } from 'pinia'
import { getCurrentScope, onScopeDispose, ref } from 'vue'
import type { ComputedRef } from 'vue'
import type { SubagentRecord, Message } from '@xyz-agent/shared'
import { subagentVirtualId } from '@xyz-agent/shared'
// 虚拟 session ID 工厂 SSOT 迁至 @xyz-agent/shared/virtual-session-id（跨层协议级约定，
// ui chat 块 / drawer tab / runtime 均消费）。此处 re-export 保持现有 import 路径向后兼容。
export {
  SUBAGENT_PREFIX,
  subagentVirtualId,
  isSubagentVirtualId,
  extractSubagentId,
  extractMainSessionId,
} from '@xyz-agent/shared'
import { session as sessionApi } from '@/api'
import * as events from '@xyz-agent/core/transport/api'
import { toErrorMessage } from '@xyz-agent/core'
import { createEmptyResultStrikeGuard, createPartitionedRecords } from '../lib/partitioned-session-records'

/**
 * fetchAndInject 的 chat 注入回调类型。
 * store 不 import chatStore（铁律），由调用方（drawer SubagentTab）注入。
 *
 * W4：assistant content mutation 收口进 chat store（applySubagentStreamDelta /
 * finalizeSubagentStream），本 store 经回调委托，不再自己 applyStreamDelta。
 * fetchAndInject 仍用 setMessages（含 IO 的历史拉取留在本 store，chat store 保持纯状态机）。
 */
type SetMessagesFn = (virtualId: string, messages: Message[]) => void
/** chat.applySubagentStreamDelta 注入回调（W4：streaming delta 收口进 chat store） */
type ApplyDeltaFn = (virtualId: string, lines: string[]) => void
/** chat.finalizeSubagentStream 注入回调（W4：streaming → complete 收口进 chat store） */
type FinalizeStreamFn = (virtualId: string) => void

export const useSubagentStore = defineStore('subagent', () => {
  // ── state ──
  /**
   * 按 sessionId 分区的 subagent 列表（ADR-0049 Map 分区派）。
   * 切走不清、切回直接读 Map 分区；deleteSession 经 clearSession(sid) 精确释放。
   * 四件套实现单源在 lib/partitioned-session-records（S4 A1，行为逐字等价迁移）。
   */
  const partition = createPartitionedRecords<SubagentRecord>()

  /** 加载态（M1：loadSubagents 在途时 true） */
  const isLoading = ref(false)
  /** 加载错误（M1：loadSubagents 失败时设错误消息，null = 无错误） */
  const loadError = ref<string | null>(null)

  // ── 非响应式资源表（参照 chat.ts streamingTimers 模式）──
  /**
   * streaming 订阅取消函数表。U8 起按 **drawer scope token** keyed（不再按 panelId）——
   * overlay 全屏替换模式移除后，subagent 实时增量唯一消费方是 drawer SubagentTab，
   * 它用固定 token（STREAM_SCOPE='drawer:subagent'）调 subscribeStream/stopStream。
   * 同一 token 覆盖（subscribeStream 先 stopStream 再 set），drawer 单实例同一时刻只订阅一个 subagent。
   */
  const streamUnsub = new Map<string, () => void>()

  /**
   * loadSubagents 空结果守卫（R1 business-logic S3）：达到 LIMIT 判真实删空。
   * strike 语义单源在 createEmptyResultStrikeGuard JSDoc（lib/partitioned-session-records），
   * 此处只声明本 store 的阈值与 log tag。
   */
  const EMPTY_RESULT_STRIKE_LIMIT = 2
  const strikeGuard = createEmptyResultStrikeGuard(EMPTY_RESULT_STRIKE_LIMIT, 'subagent-store', 'getSubagents')

  // 防御性清理：正常由 SubagentTab onBeforeUnmount→stopStream 清理，
  // 此处防止消费方未清的兜底。
  if (getCurrentScope()) {
    onScopeDispose(() => {
      for (const unsub of streamUnsub.values()) {
        try {
          unsub()
        // eslint-disable-next-line taste/no-silent-catch -- 作用域销毁兜底清理：unsub 失败不应阻断其余清理，仅记录便于诊断
        } catch (e) {
          console.warn('[subagent-store] stream unsub on scope dispose failed:', e)
        }
      }
      streamUnsub.clear()
    })
  }

  /**
   * 响应式视图：指定 session 的 subagent 列表（供组件 computed 订阅，对齐 command.ts commandsOf）。
   * 切会话时读不同分区，records 变化自动重算。
   */
  function recordsOf(sessionId: string): ComputedRef<SubagentRecord[]> {
    return partition.recordsOf(sessionId)
  }

  /** 非响应式读：指定 session 的 subagent 列表（不写 Map，无则空数组，对齐 command.ts getCommands） */
  function getRecordsBySession(sessionId: string): SubagentRecord[] {
    return partition.get(sessionId)
  }

  /**
   * 该 session 是否有 subagent 仍在 running（供 derivedStatus 计算 hasBackgroundWork）。
   *
   * [review findings-confirmation #8] 排除 running-resumable：v4 轮终迁移故意回写
   * status='running'（可冷路径 resume）但已携带本轮 result（轮终写点恒写非空）——「已有
   * 轮终信号的 running」不是后台真在跑，不算 working。否则 subagent 完成注入后
   * derivedStatus 恒 working → isSessionActive 恒 true → 末位 turn 永久「工作中」（重开
   * 后 record=closed 才恢复，live 与 reload 不一致）。result === undefined 的 running
   * （首轮在跑 / legacy W16 前旧 session）仍算真在跑。isRunning（单 record 判定）不随之
   * 收紧——SubagentTab 依赖它决定是否订阅实时增量流（resumable 续轮仍有流活动）；
   * 单 record 窄口径（虚拟 session forceWorking 用）见 isStreamingSubagent。
   */
  function hasRunning(sessionId: string): boolean {
    // resumable（无活进程驱动的 running，residual-fixes）与轮终 result 一样不算真在跑
    return getRecordsBySession(sessionId).some(
      (s) => s.status === 'running' && s.result === undefined && s.resumable !== true,
    )
  }

  /**
   * 写入指定 session 的 subagent 列表（不可变写，确保 Map 响应性触发）。
   * @param sessionId 分区 key
   * @param list runtime 推送 / RPC 拉取的 subagent 列表
   */
  function applyRecords(sessionId: string, list: SubagentRecord[]): void {
    partition.apply(sessionId, list)
  }

  /** 清除指定 session 的 subagent 列表分区（deleteSession 调，防泄漏，ADR-0049 AC-8） */
  function clearSession(sessionId: string): void {
    strikeGuard.reset(sessionId)
    partition.clear(sessionId)
  }

  /** 指定主 session 名下的 subagent 是否仍在 running（读该 sid 分区，不全扫） */
  function isRunning(mainSessionId: string, subagentId: string): boolean {
    return getRecordsBySession(mainSessionId).find((s) => s.subagentId === subagentId)?.status === 'running'
  }

  /**
   * 指定 subagent 是否「真在流活动中」（running 且无轮终 result）——虚拟 session working
   * 判定的窄口径 [review round2 R1-遗留-1]。
   *
   * hasRunning 同判据的单 record 版：running + result 在场 = 轮终 running-resumable
   * （v4 轮终迁移故意回写 running，见 hasRunning 注释），不是后台真在跑。与 isRunning 的
   * 分工（两口径并存是刻意设计，非重复）：isRunning（宽松，running 即 true）供 SubagentTab
   * 决定是否订阅增量流——resumable 续轮仍有真实流活动，收紧会断数据通路；本函数（窄口径）
   * 供 MessageStream 虚拟 session forceWorking——轮终后虚拟 session 末位 turn 不再卡
   * streaming，与主 session working 判定（hasRunning）语义一致。续轮流活动的 streaming
   * 显示由消息级 status 承担（subscribeStream → applySubagentStreamDelta push
   * status='streaming' 消息），不依赖本函数。
   */
  function isStreamingSubagent(mainSessionId: string, subagentId: string): boolean {
    const record = getRecordsBySession(mainSessionId).find((s) => s.subagentId === subagentId)
    // resumable 排除（residual-fixes R3-SG1）：孤儿兜底/轮终 running 无流活动，不算
    // streaming——否则与 SubagentList 的四形态口径分叉（列表 waiting、虚拟 session 转圈）。
    return record?.status === 'running' && record.result === undefined && record.resumable !== true
  }

  // ── actions ──
  /**
   * 加载 session 的 subagent 列表（写入该 sid 分区）。
   * 在 Sidebar 切到 Agents tab 或 session 切换时调用。
   */
  async function loadSubagents(sessionId: string): Promise<void> {
    if (!sessionId) return // 空 sid 不写分区
    isLoading.value = true
    loadError.value = null
    try {
      const records = await sessionApi.getSubagents(sessionId)
      // 空结果守卫（sidebar-sync-plan P1 + R1 business-logic S3）：strike 语义单源在
      // createEmptyResultStrikeGuard JSDoc（S4 A1），此处只判定 + 覆盖前清零。推送路径
      // 是权威数据，不经此守卫。
      if (
        strikeGuard.shouldKeepExisting(sessionId, records.length, getRecordsBySession(sessionId).length)
      ) {
        return
      }
      strikeGuard.reset(sessionId)
      applyRecords(sessionId, records)
    } catch (e) {
      // M1：失败不覆盖现有分区，设 loadError；strike 重置（「连续 RPC 成功且空」语义纯净，
      // 读失败与数据空不同通道，不让 RPC 故障累计出误清分区）
      strikeGuard.reset(sessionId)
      const msg = toErrorMessage(e)
      console.error('[subagent-store] loadSubagents failed:', e)
      loadError.value = msg
    } finally {
      isLoading.value = false
    }
  }

  /** 清空所有 subagent 分区 + 停止所有 streaming（全局重置场景用） */
  function clearSubagents(): void {
    for (const pid of streamUnsub.keys()) stopStream(pid)
    partition.recordsBySession.value = new Map()
  }

  /**
   * 停止指定 scope 的 streaming 订阅。
   * @param targetScope drawer scope token（U8：drawer SubagentTab 用 STREAM_SCOPE 常量）
   */
  function stopStream(targetScope?: string): void {
    if (!targetScope) return
    const unsub = streamUnsub.get(targetScope)
    if (unsub) {
      unsub()
      streamUnsub.delete(targetScope)
    }
  }

  /**
   * 拉取单个 subagent 的历史并注入 chatStore（经 setMessages 回调）。
   *
   * 返回拉取到的 history 数组，供调用方编排使用（drawer-blank-fix：空历史不擦分区，
   * 设计 docs/design/subagent-drawer-blank.md §6.2）。
   *
   * 空结果不写入：history.length === 0 时**不调** setMessages——分区是否种兜底
   * （task 气泡）由编排层依据「分区当前是否为空」决定；无条件写入会把 E-4 已投影的
   * 内容擦空（重开 drawer 空白闪退）。非空历史照旧整体替换（定稿权威语义，天然清除兜底气泡）。
   *
   * [W2 / M5] fail-fast：失败时 throw（不静默 setMessages([])）。调用方（drawer SubagentTab）
   * 负责 catch + 显示错误态 + 重试入口。
   */
  async function fetchAndInject(
    mainSessionId: string,
    subagentId: string,
    setMessages: SetMessagesFn,
  ): Promise<Message[]> {
    const virtualId = subagentVirtualId(mainSessionId, subagentId)
    const history = await sessionApi.getSubagentHistory(mainSessionId, subagentId)
    if (history.length > 0) {
      setMessages(virtualId, history)
    }
    return history
  }

  /**
   * 订阅 subagent.stream_delta WS 帧（路径 A-1，逐字增量 streaming）。
   *
   * W4：delta / 终态收口均经注入的 chat store 回调（chatApplyDelta / chatFinalizeStream），
   * chat store 成为所有 assistant content mutation 的唯一入口。
   * - lines 非空 → chatApplyDelta（chat.applySubagentStreamDelta）
   * - lines === undefined → 单条 assistant 定稿的清除帧：仅收口 streaming 实体
   *   （chatFinalizeStream），**不停订阅不 refetch**——E-4（subagent-realtime-channel
   *   §6.3 退役步骤 1 + R1 消解）：tee 侧每条 assistant message_end 都发清除帧（非任务
   *   终态），停订阅会断 chatMode 续聊轮（R1 复活）；定稿内容由同事件必发的
   *   session.subagentEntriesAppended entry 帧投影覆盖（routeInbound 兜底链，不经本订阅），
   *   refetch 变冗余。旧 extension widget 通道（E-3 合入前的过渡窗口）的 delta 为累积全文
   *   替换式，收口即完整文本，无 entry 帧也不丢定稿。
   *
   * 双键订阅（E-4 差异适配）：tee 产出的 stream_delta payload.sessionId 是**虚拟分区 id**
   * （relay-tee），routeInbound 按 payload.sessionId 路由 → dispatchSession(virtualId)；
   * 旧 widget 通道 payload.sessionId 是主 sid。过渡期两通道并存（E-3 未合入前 extension
   * 仍发 widget 帧），两个 key 挂同一 handler——内容同为累积全文替换式，重复到达幂等。
   *
   * U8：第一个参数 `scope` 是 **drawer scope token**（非 panelId）——overlay 移除后唯一消费方是
   * drawer SubagentTab，它传固定常量 STREAM_SCOPE='drawer:subagent'。streamUnsub 按此 token keyed，
   * drawer 单实例同一时刻只订阅一个 subagent（切 subagent 时先 stopStream 清旧再 set 起新）。
   *
   * @param scope drawer scope token（消费方传固定常量，如 SubagentTab 的 STREAM_SCOPE）
   * @param mainSessionId 主 session ID（WS 事件订阅键：旧 widget 通道帧路由 key）
   * @param recordId subagent record id（过滤 stream_delta payload.recordId）
   * @param virtualId 虚拟 session ID（tee 帧路由 key + chatStore.messages 分区 key + streaming delta/finalize 目标）
   * @param chatApplyDelta chatStore.applySubagentStreamDelta（注入，W4 streaming delta 收口入口）
   * @param chatFinalizeStream chatStore.finalizeSubagentStream（注入，W4 终态收口入口）
   */
  function subscribeStream(
    scope: string,
    mainSessionId: string,
    recordId: string,
    virtualId: string,
    chatApplyDelta: ApplyDeltaFn,
    chatFinalizeStream: FinalizeStreamFn,
  ): void {
    stopStream(scope)
    const handler = (msg: { type?: string; payload?: unknown }): void => {
      if (msg.type !== 'subagent.stream_delta') return
      const payload = msg.payload as { recordId?: string; lines?: string[] | undefined }
      if (payload.recordId !== recordId) return

      if (payload.lines === undefined) {
        // 清除帧 = 单条 assistant 定稿：只收口 streaming 实体。订阅保留（chatMode 续聊轮
        // 的后续 delta 仍可达，R1 构造性消解）；定稿内容由 entry 帧投影链覆盖。
        chatFinalizeStream(virtualId)
        return
      }
      chatApplyDelta(virtualId, payload.lines)
    }
    // 双键：旧 widget 通道（payload.sessionId=主 sid）与 tee（payload.sessionId=虚拟分区 id）
    const unsubs = [events.on(mainSessionId, handler), events.on(virtualId, handler)]
    streamUnsub.set(scope, () => {
      for (const unsub of unsubs) unsub()
    })
  }

  /**
   * 取消 running subagent（调 RPC + 乐观更新该 sid 分区）。
   * 成功后立即将分区中对应项翻 idle + stopReason=interrupted（永久会话模型 §3.2.5
   * cancel = abort 当前轮 → settle 为 idle，U8b 乐观更新与宿主终态同形态；不等 WS 推送
   * 避免 UI 延迟——spinner 即刻消失、状态点落中性灰「已中断」）。
   * RPC 失败时不改 status（乐观更新回滚），error 向上抛由调用方 toast。
   */
  async function cancelSubagent(sessionId: string, subagentId: string): Promise<void> {
    const prevRecords = getRecordsBySession(sessionId)
    // 乐观更新（假设成功）：不可变 map 替换目标 record
    applyRecords(
      sessionId,
      prevRecords.map((s) =>
        s.subagentId === subagentId
          ? { ...s, status: 'idle' as const, stopReason: 'interrupted', endedAt: Date.now() }
          : s,
      ),
    )
    try {
      await sessionApi.subagentAction(sessionId, 'cancel', { subagentId })
    } catch (e) {
      // 回滚乐观更新：整体恢复 prevRecords
      applyRecords(sessionId, prevRecords)
      throw e
    }
  }

  return {
    // state
    recordsBySession: partition.recordsBySession,
    isLoading,
    loadError,
    // getters
    isRunning,
    isStreamingSubagent,
    // per-session 分区读写（ADR-0049 Map 分区派）
    recordsOf,
    getRecordsBySession,
    hasRunning,
    applyRecords,
    clearSession,
    // actions
    loadSubagents,
    clearSubagents,
    cancelSubagent,
    stopStream,
    subscribeStream,
    fetchAndInject,
  }
})

// [HISTORICAL] extractMainSessionId 经顶部 re-export 块暴露，供 LRU 前缀清理等数据层路径消费。
// 原 clearSubagentTombstones（overlay tombstone 防复活）已随 U7 overlay 移除删除。
