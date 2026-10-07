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
 * 工厂 SSOT 在 @taiji/shared/virtual-session-id（跨层协议级约定），本文件 re-export 保持
 * 现有 import 路径向后兼容。
 */
import { defineStore } from 'pinia'
import { computed, getCurrentScope, onScopeDispose } from 'vue'
import type { ComputedRef } from 'vue'
import type { SubagentRecord, Message } from '@taiji/shared'
import { subagentVirtualId } from '@taiji/shared'
// 虚拟 session ID 工厂 SSOT 迁至 @taiji/shared/virtual-session-id（跨层协议级约定，
// ui chat 块 / drawer tab / runtime 均消费）。此处 re-export 保持现有 import 路径向后兼容。
export {
  SUBAGENT_PREFIX,
  subagentVirtualId,
  isSubagentVirtualId,
  extractSubagentId,
  extractMainSessionId,
} from '@taiji/shared'
import { session as sessionApi } from '@/api'
import * as events from '@taiji/core/transport/api'
import { toErrorMessage } from '@taiji/core'
import { isRunningProjection } from '@/lib/subagent-bucket'
import { createPartitionedLoadState, createPartitionedRecords } from '../lib/partitioned-session-records'

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

/**
 * [B2 subagent-stream-chunk §4.3] chunk 通道回调束（subscribeStream 第 7 参，可选）。
 * R 路径增量消费的三入口，全部是 chat store ops 面（core streaming-state-machine 管线），
 * 由调用方（drawer SubagentTabData 编排）注入；缺省 = chunk / 定稿水位不接线（旧调用方
 * 兼容形态——W 路径全量 delta 与清除收口不受影响，chunk 帧静默忽略）。
 */
export interface SubagentStreamChunkOps {
  /** subagent.stream_chunk 分派 → chat.applySubagentStreamChunk（边界推进/追加/失步入缓冲管线） */
  applyChunk: (virtualId: string, recordId: string, msgSeq: number, deltaSeq: number, delta: string) => void
  /** 清除帧携带 msgSeq 时置定稿水位 → chat.sealSubagentStream（sealedMsgSeq 单调；W 路径清除帧无 msgSeq 不调） */
  seal: (virtualId: string, recordId: string, msgSeq: number) => void
  /** 触发点①接入拉取（订阅建立完成后运行中 record 主动拉取）→ chat.requestSubagentStreamState（core pullInFlight 去重） */
  requestState: (virtualId: string, recordId: string) => void
}

export const useSubagentStore = defineStore('subagent', () => {
  // ── state ──
  /**
   * 按 sessionId 分区的 subagent 列表（ADR-0049 Map 分区派）。
   * 切走不清、切回直接读 Map 分区；deleteSession 经 clearSession(sid) 精确释放。
   * 四件套实现单源在 lib/partitioned-session-records（S4 A1，行为逐字等价迁移）。
   */
  const partition = createPartitionedRecords<SubagentRecord>()

  /**
   * 每 session 加载态三件套（loading / loadError / oversize 分区，ADR-0049 派）。
   * 实现单源在 lib/partitioned-session-records 的 createPartitionedLoadState
   * （待裁决项 1 收敛 2026-10-04，原手抄 71 行退役）；facet 的领域语义注释保留在各
   * 使用点——loading：split 双面板并行拉取任一 pane 的在途/失败不得遮蔽另一 pane；
   * loadError：失败设该 sid 分区错误消息（全局单值形态会把 pane A 的失败显示到 pane B，
   * 分区化治根）；oversize：[RT-4#8] session 文件 >32MB 列表不可用，置位时保留旧分区
   * 数据（不可用 ≠ 删空），面板据此显示降级提示而非空列表。
   */
  const loadState = createPartitionedLoadState()
  const { isLoadingOf, loadErrorOf, oversizeOf } = loadState

  // ── 非响应式资源表（参照 chat.ts streamingTimers 模式）──
  /**
   * streaming 订阅取消函数表。U8 起按 **drawer scope token** keyed（不再按 panelId）——
   * overlay 全屏替换模式移除后，subagent 实时增量唯一消费方是 drawer SubagentTab，
   * 它用固定 token（STREAM_SCOPE='drawer:subagent'）调 subscribeStream/stopStream。
   * 同一 token 覆盖（subscribeStream 先 stopStream 再 set），drawer 单实例同一时刻只订阅一个 subagent。
   */
  const streamUnsub = new Map<string, () => void>()

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
   * opts.excludeOrigin：origin 过滤选项（S1 判据单源化——与 hasRunning 同一参数形态，
   * 调用方需要把 workflow 派发 record 归 workflow 面板时排除，禁止消费侧各写内联 filter
   * 形成第二判据）。
   */
  function recordsOf(
    sessionId: string,
    opts?: { excludeOrigin?: SubagentRecord['origin'] },
  ): ComputedRef<SubagentRecord[]> {
    const base = partition.recordsOf(sessionId)
    if (opts?.excludeOrigin === undefined) return base
    const exclude = opts.excludeOrigin
    return computed(() => base.value.filter((s) => s.origin !== exclude))
  }

  /** 非响应式读：指定 session 的 subagent 列表（不写 Map，无则空数组，对齐 command.ts getCommands） */
  function getRecordsBySession(sessionId: string): SubagentRecord[] {
    return partition.get(sessionId)
  }

  /**
   * 该 session 是否有 subagent 仍在 running（供 derivedStatus 计算 hasBackgroundWork）。
   *
   * [two-state-convergence D2 判据单一化] 占用判据 = subagent-bucket 的严格口径 SSOT
   * （isRunningProjection：running + result=∅ + resumable≠true）——本函数是 import
   * wrapper，禁止在此重组判据字段。历史背景（review findings-confirmation #8）：v4 轮终
   * 迁移故意回写 status='running'（可冷路径 resume）但已携带本轮 result，「已有轮终信号
   * 的 running」不是后台真在跑，不算 working——否则 subagent 完成注入后 derivedStatus
   * 恒 working → isSessionActive 恒 true → 末位 turn 永久「工作中」。
   * origin 过滤（S1 判据单源化）保留在调用点参数：调用方（如 useBackgroundWork）需排除
   * workflow 派发的 record（生命周期归 workflow run 承载，不算宿主 session 的后台工作）。
   */
  function hasRunning(sessionId: string, opts?: { excludeOrigin?: SubagentRecord['origin'] }): boolean {
    return getRecordsBySession(sessionId).some(
      (s) =>
        isRunningProjection(s) &&
        (opts?.excludeOrigin === undefined || s.origin !== opts.excludeOrigin),
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
    partition.clear(sessionId)
    loadState.clear(sessionId)
  }

  /**
   * 指定主 session 名下的 subagent 是否仍在 running（读该 sid 分区，不全扫）。
   *
   * [two-state-convergence D2] 宽松口径（仅 `status==='running'`），与占用判据
   * isRunningProjection 的分工是刻意设计、非重复：SubagentTab 依赖它决定是否订阅
   * 实时增量流——resumable 续轮瞬间仍有真实流活动，收紧会断数据通路。写面翻边
   * （Phase 2 markRoundIdle 落 idle）后本口径与占用判据天然合流，保留订阅语义。
   */
  function isRunning(mainSessionId: string, subagentId: string): boolean {
    return getRecordsBySession(mainSessionId).find((s) => s.subagentId === subagentId)?.status === 'running'
  }

  /**
   * 指定 subagent 是否「真在流活动中」——虚拟 session working 判定 [review round2 R1-遗留-1]。
   *
   * [two-state-convergence D2 判据单一化] 本函数 = 占用判据 SSOT（isRunningProjection）
   * 的单 record wrapper：running + result=∅ + resumable≠true（轮终 running-resumable
   * 不是后台真在跑，见 hasRunning 注释）。与 isRunning 的分工（两口径并存是刻意设计）：
   * isRunning（宽松，running 即 true）供 SubagentTab 决定是否订阅增量流——resumable 续轮
   * 仍有真实流活动，收紧会断数据通路；本函数（窄口径）供 MessageStream 虚拟 session
   * forceWorking——轮终后虚拟 session 末位 turn 不再卡 streaming，与主 session working
   * 判定（hasRunning）语义一致。续轮流活动的 streaming 显示由消息级 status 承担
   * （subscribeStream → applySubagentStreamDelta push status='streaming' 消息），不依赖本函数。
   */
  function isStreamingSubagent(mainSessionId: string, subagentId: string): boolean {
    const record = getRecordsBySession(mainSessionId).find((s) => s.subagentId === subagentId)
    return record !== undefined && isRunningProjection(record)
  }

  // ── actions ──
  /**
   * 加载 session 的 subagent 列表（写入该 sid 分区）。
   * 在 Sidebar 切到 Agents tab 或 session 切换时调用。
   */
  async function loadSubagents(sessionId: string): Promise<void> {
    if (!sessionId) return // 空 sid 不写分区
    loadState.beginLoad(sessionId)
    try {
      // [RT-4#8] 结构化返回：oversize=true 时 records 恒空（文件 >32MB 列表不可用）——
      // 置降级标志 + 保留旧分区数据（不可用 ≠ 删空），面板显示降级提示而非空列表。
      // [待裁决项 4] found=false = 会话不在册（pi 延迟落盘窗口 / 扫描竞态）——「读不到
      // 会话」≠「会话数据为空」，保留分区不覆盖；found=true 的空列表是真实空，直接覆盖
      // （真实删空语义；原连续空计数 strike 守卫随歧义根治退役）。缺省（undefined，mock /
      // 旧 runtime）按 found 处理。推送路径是权威数据，不经本判定。
      const { subagents: records, oversize, found } = await sessionApi.getSubagents(sessionId)
      if (oversize) {
        loadState.setOversize(sessionId)
        return
      }
      loadState.clearOversize(sessionId)
      if (found === false) return
      applyRecords(sessionId, records)
    } catch (e) {
      // M1：失败不覆盖现有分区，设该 sid 分区 loadError
      const msg = toErrorMessage(e)
      console.error('[subagent-store] loadSubagents failed:', e)
      loadState.setLoadError(sessionId, msg)
    } finally {
      loadState.endLoad(sessionId)
    }
  }

  /** 清空所有 subagent 分区 + 停止所有 streaming（全局重置场景用） */
  function clearSubagents(): void {
    for (const pid of streamUnsub.keys()) stopStream(pid)
    // RD-3#12：全局重置须整表替换 records + 全清 loading/error（+ oversize）三 facet，
    // 与 clearSession 全清语义对齐——残留 loading=true → spinner 永转 / 残留 error → 错误态卡死。
    partition.recordsBySession.value = new Map()
    loadState.clearAll()
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
   * 返回拉取到的 history 数组，供调用方编排使用（drawer-blank-fix：空历史不擦分区）。
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
   * 订阅 subagent 流式 WS 消息（B2 subagent-stream-chunk 改造后三路分派）。
   *
   * 分派（按 msg.type）：
   * - `subagent.stream_chunk`（R 路径唯一内容推送通道，transient）→ chunkOps.applyChunk
   *   （core 状态机管线：边界推进 / 顺序追加 / 失步入缓冲 + 拉取）。chunkOps 缺省时忽略
   *   （chunk 通道未接线的调用方兼容形态）。
   * - `subagent.stream_delta` lines === undefined（清除帧 = 单条 assistant 定稿）：
   *   R 路径携带 additive msgSeq → chunkOps.seal 置定稿水位（sealedMsgSeq 单调，晚到拉取
   *   响应据此防复活）；随后 chatFinalizeStream 收口 streaming 实体（原样保留，不停订阅
   *   不 refetch——E-4 R1 消解：tee 每条 assistant message_end 都发清除帧，定稿内容由同
   *   事件必发的 entry 帧投影覆盖）。W 路径清除帧无 msgSeq，不进 chunk 状态机（§4.1）。
   * - `subagent.stream_delta` lines 非空（W 路径全量形态，R 路径已不产生）→ chatApplyDelta
   *   全量替换原样（W 产生端不动，行为零变化）。
   *
   * W4 契约保持：内容 mutation 全部经注入的 chat store 回调，store 不直接碰 chat 分区。
   *
   * 拉取触发接线（§4.3，执行体在 core 状态机，本函数只做分派与接入编排）：
   * - ② 首见缺前缀 / ③ 失步（跳号）：chunk 帧进 chunkOps.applyChunk 后由 core 状态机判定
   *   （新建分区 + deltaSeq > 0 必失步入缓冲并触发拉取；pullInFlight 单在途去重）。
   * - ① 接入拉取：双键订阅挂载**完成之后**，对订阅范围内运行中 record 主动拉取一次——
   *   覆盖「流已停顿、等不到下一条 chunk」的角落；时序由调用方编排保证（loadSubagentData
   *   中本函数在 fetchAndInject 即 entry 基线恢复完成之后执行，拉取结果不会被后到的整体
   *   恢复抹掉）。运行中判定用宽松口径 isRunning（resumable 续轮仍有真实流活动，拉取是
   *   幂等只读查询，found:false 分支安全无副作用）；非 running 不拉（done/idle 无进行中流，
   *   拉取是稳态冗余 RPC）。chunkOps 缺省不接线。
   *
   * 双键订阅（E-4 差异适配）：tee 产出帧 payload.sessionId 是**虚拟分区 id**（relay-tee），
   * routeInbound 按 payload.sessionId 路由 → dispatchSession(virtualId)；旧 widget 通道
   * payload.sessionId 是主 sid。两个 key 挂同一 handler，每条消息只命中一键。
   *
   * U8：第一个参数 `scope` 是 **drawer scope token**（非 panelId）——streamUnsub 按此 token
   * keyed，drawer 单实例同一时刻只订阅一个 subagent（切 subagent 时先 stopStream 清旧再 set 起新）。
   *
   * @param scope drawer scope token（消费方传固定常量，如 SubagentTab 的 STREAM_SCOPE）
   * @param mainSessionId 主 session ID（WS 事件订阅键：旧 widget 通道帧路由 key）
   * @param recordId subagent record id（过滤 chunk / stream_delta payload.recordId）
   * @param virtualId 虚拟 session ID（tee 帧路由 key + chatStore.messages 分区 key + 各收口入口目标）
   * @param chatApplyDelta chatStore.applySubagentStreamDelta（注入，W 路径全量替换 + core 拉取响应应用复用）
   * @param chatFinalizeStream chatStore.finalizeSubagentStream（注入，清除帧收口入口）
   * @param chunkOps chunk 通道回调束（可选，§4.3 三入口；缺省 = chunk / 水位不接线）
   */
  function subscribeStream(
    scope: string,
    mainSessionId: string,
    recordId: string,
    virtualId: string,
    chatApplyDelta: ApplyDeltaFn,
    chatFinalizeStream: FinalizeStreamFn,
    chunkOps?: SubagentStreamChunkOps,
  ): void {
    stopStream(scope)
    const handler = (msg: { type?: string; payload?: unknown }): void => {
      // ── R 路径增量 chunk（唯一内容推送通道）──
      if (msg.type === 'subagent.stream_chunk') {
        if (!chunkOps) return // chunk 通道未接线（旧调用方兼容窗口）：忽略
        const payload = msg.payload as { recordId?: string; msgSeq?: number; deltaSeq?: number; delta?: string }
        if (payload.recordId !== recordId) return
        chunkOps.applyChunk(virtualId, recordId, payload.msgSeq ?? 0, payload.deltaSeq ?? 0, payload.delta ?? '')
        return
      }
      if (msg.type !== 'subagent.stream_delta') return
      const payload = msg.payload as { recordId?: string; lines?: string[] | undefined; msgSeq?: number }
      if (payload.recordId !== recordId) return

      if (payload.lines === undefined) {
        // 清除帧 = 单条 assistant 定稿：R 路径携带 additive msgSeq → 先置定稿水位
        //（sealedMsgSeq 单调，拦截晚到拉取响应复活定稿消息）；W 路径无 msgSeq 不进状态机。
        if (payload.msgSeq !== undefined && chunkOps) {
          chunkOps.seal(virtualId, recordId, payload.msgSeq)
        }
        // 只收口 streaming 实体。订阅保留（续聊轮的后续 chunk 仍可达，R1 构造性消解）；
        // 定稿内容由 entry 帧投影链覆盖。
        chatFinalizeStream(virtualId)
        return
      }
      // W 路径全量形态（余留）：累积全文替换原样
      chatApplyDelta(virtualId, payload.lines)
    }
    // 双键：旧 widget 通道（payload.sessionId=主 sid）与 tee（payload.sessionId=虚拟分区 id）
    const unsubs = [events.on(mainSessionId, handler), events.on(virtualId, handler)]
    streamUnsub.set(scope, () => {
      for (const unsub of unsubs) unsub()
    })
    // [B2 §4.3 触发点①] 接入拉取：订阅建立完成之后对运行中 record 主动拉取一次。
    if (chunkOps && isRunning(mainSessionId, recordId)) {
      chunkOps.requestState(virtualId, recordId)
    }
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
    isLoadingOf,
    loadErrorOf,
    oversizeOf,
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
