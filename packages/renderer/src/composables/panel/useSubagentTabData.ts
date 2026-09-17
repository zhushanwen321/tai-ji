/**
 * SubagentTab 对话流数据编排（chat store ops 面消费收口，renderer-deepening D6/u6.1）。
 *
 * 从 SubagentTab.vue 内联编排下沉而来（行为逐字等价）：组件只保留 readers 面消费
 * （getMessages），写虚拟分区（setMessages / applySubagentStreamDelta /
 * finalizeSubagentStream）属 chat store ops 面——taste-lint 规则
 * no-chat-ops-in-components 禁止组件直取，编排动作归 composable 层。
 *
 * 职责（原组件 loadSubagentData 全量迁移 + drawer-blank 修复 u2 增补）：
 * - subagent 三段式虚拟 id：fetchAndInject 拉历史（空历史不写分区，u1）+
 *   恒订阅 stream_delta（E-4 / R3 消解：不依赖 isRunning 陈旧缓存判定订阅时机）
 *   + 客户端 outcome-only 兜底投影（U4 A8，判定先行）
 *   + 空历史时 task 用户气泡种入（drawer-blank u2：outcome 先行、seed 复用分区空守卫随后，
 *   判定顺序即优先级）
 * - agentcall 两段式：快照只读，仅拉历史（D4：不接实时流式）+ 登记虚拟 key 到主
 *   session 清理映射（[MUST_FIX 1]，防 deleteSession 泄漏）
 */
import { ref, type ComputedRef } from 'vue'
import { useChatStore } from '@/stores/chat'
import { usePanelStore } from '@/stores/panel'
import {
  useSubagentStore,
  isSubagentVirtualId,
  extractSubagentId,
  extractMainSessionId,
} from '@/stores/subagent'
import {
  useWorkflowStore,
  isAgentCallVirtualId,
  extractAgentCallSessionId,
} from '@/stores/workflow'
import { getAgentCallHistory } from '@taiji/core/transport/api/domains/session'
import type { Message, SubagentRecord } from '@taiji/shared'
import { DEFAULT_ENGINE_ID } from '@/constants/engine-icons'
import { toErrorMessage } from '@taiji/core'

export interface SubagentTabDataDeps {
  /** 当前选中 subagent 的 record（组件 computed；三段式虚拟 id 才有，agentcall 两段式为 null） */
  currentRecord: ComputedRef<SubagentRecord | null>
  /** 兜底投影的「无结果」文案（i18n key 由组件注入，composable 不绑 useI18n） */
  noOutcomeText: () => string
}

/**
 * subscribeStream 的 drawer scope token（U8 已落地）。
 * subagent store 的 streamUnsub 是单例 Map<scope, unsub>，按此 token keyed（非 panelId）。
 * drawer 单实例同一时刻只订阅一个 subagent：切换 selectedSubagentId 时先 stop 清旧，
 * 再 subscribeStream 起新（同 token 覆盖，store 内部先 stop 再 set）。
 */
const STREAM_SCOPE = 'drawer:subagent'

/** record 实际执行引擎（缺省映射 pi，与 runtime extractRecordEngine 同语义，D5） */
function recordEngine(record: SubagentRecord): string {
  return record.engine || DEFAULT_ENGINE_ID
}

/**
 * 客户端 outcome-only 兜底投影（读链空结果时，U4 A8）：形状对齐 runtime
 * subagent-engine-history 的 ③级 outcomeOnlyMessages（user task + result/error 摘要）。
 */
function outcomeFallbackMessages(record: SubagentRecord, noOutcomeText: string): Message[] {
  const base = record.startedAt ?? Date.now()
  const isErrorOutcome = record.result === undefined && record.error !== undefined
  const messages: Message[] = []
  if (record.task.length > 0) {
    messages.push({ id: `outcome-u-${record.subagentId}`, role: 'user', content: record.task, status: 'complete', timestamp: base })
  }
  messages.push({
    id: `outcome-a-${record.subagentId}`,
    role: 'assistant',
    content: record.result ?? record.error ?? noOutcomeText,
    status: isErrorOutcome ? 'error' : 'complete',
    timestamp: record.endedAt ?? base,
  })
  return messages
}

export function useSubagentTabData(deps: SubagentTabDataDeps) {
  const chatStore = useChatStore()
  const panelStore = usePanelStore()
  const subagentStore = useSubagentStore()
  const workflowStore = useWorkflowStore()

  const loadError = ref<string | null>(null)

  /**
   * 按虚拟 id 类型加载对话流数据并注入 chatStore 虚拟分区。
   * - subagent 三段式：fetchAndInject 拉历史（返回值 = 拉取的 history；空历史不写分区，u1 契约）
   *   + 恒订阅 stream_delta（E-4 / R3 消解：不再依赖 isRunning 陈旧缓存判定订阅时机——entry 帧
   *   消费走 routeInbound 兜底链不依赖 drawer，stream_delta 订阅打开即挂，非 running 时空转零成本）
   *   空历史时兜底判定顺序即优先级（drawer-blank-fix 设计 §7.2）：①outcome 投影（非 pi）先行
   *   ②task 气泡种入随后——两判定共用分区空守卫，①命中或 E-4 已投影时②自然跳过
   * - agentcall 两段式：快照只读，仅拉历史（D4：不接实时流式）
   */
  async function loadSubagentData(vid: string): Promise<void> {
    loadError.value = null
    try {
      if (isSubagentVirtualId(vid)) {
        const mainSessionId = extractMainSessionId(vid)
        const subId = extractSubagentId(vid)
        const history = await subagentStore.fetchAndInject(mainSessionId, subId, (id, msgs) => chatStore.setMessages(id, msgs))
        // 空历史兜底判定顺序即优先级（drawer-blank-fix 设计 §7.2，顺序写死禁止颠倒）：
        // ① outcome 先行 → ② task 种入随后；①命中后分区非空 → ②自然跳过（靠分区空守卫）。
        // ① U4 A8 兜底：非 pi record 读链异常返回空（③级保底失效等异常形态）→ 客户端
        // outcome 投影顶上，详情页不白屏。pi 空结果行为不变（正常空 session 也可能是空）。
        const record = deps.currentRecord.value
        if (
          record &&
          recordEngine(record) !== DEFAULT_ENGINE_ID &&
          chatStore.getMessages(vid).length === 0 &&
          (record.result !== undefined || record.error !== undefined)
        ) {
          chatStore.setMessages(vid, outcomeFallbackMessages(record, deps.noOutcomeText()))
        }
        // ② task 种入判定随后（drawer-blank-fix 设计 §7.2）：空历史 × 分区空 × task 非空 →
        // 种入 record.task 用户气泡（来自侧边栏已在 record，零额外 RPC 秒开初始态）。①命中或
        // E-4 已投影（u1 空历史不擦）时分区非空 → 自然跳过，不加额外排除条件。
        // history.length === 0 即「空历史」前提（fetchAndInject 返回值消费点）；非 pi 无 outcome
        // 的 seed 可达场景 = runtime 磁盘扫描滞后窗口（设计 §5.1 变体）。
        if (
          record &&
          history.length === 0 &&
          chatStore.getMessages(vid).length === 0 &&
          record.task.length > 0
        ) {
          chatStore.setMessages(vid, [
            {
              id: `task-u-${record.subagentId}`,
              role: 'user',
              content: record.task,
              status: 'complete',
              timestamp: record.startedAt ?? Date.now(),
            },
          ])
        }
        // 恒订阅（U8 scope token；E-4 R3 消解点：订阅时机与 record 状态机解耦）
        subagentStore.subscribeStream(
          STREAM_SCOPE,
          mainSessionId,
          subId,
          vid,
          (id, lines) => chatStore.applySubagentStreamDelta(id, lines),
          (id) => chatStore.finalizeSubagentStream(id),
        )
      } else if (isAgentCallVirtualId(vid)) {
        // D4：agentcall 快照只读。mainSid 从 panelStore 取（虚拟 id 两段式不含 mainSid）。
        const mainSessionId = panelStore.focusedSessionId
        const acsId = extractAgentCallSessionId(vid)
        if (!mainSessionId) return
        const history = await getAgentCallHistory(mainSessionId, acsId)
        chatStore.setMessages(vid, history)
        // [MUST_FIX 1] 登记 agentcall 虚拟 key 到主 session 清理映射：agentcall 两段式无 mainSid
        // 前缀，LRU isVirtualKeyOf 覆盖不到，deleteSession 须经此映射清 agentcall 虚拟分区（防泄漏）。
        // 原 overlay 时代由 workflow.selectAgentCall 内部登记；overlay 移除后 SubagentTab 显式接管。
        workflowStore.registerAgentCall(mainSessionId, vid)
      }
    } catch (e) {
      loadError.value = toErrorMessage(e)
    }
  }

  /** 停止当前 drawer scope 的 stream 订阅（切换 subagent / 组件卸载时调） */
  function stopSubagentStream(): void {
    subagentStore.stopStream(STREAM_SCOPE)
  }

  return { loadError, loadSubagentData, stopSubagentStream, recordEngine }
}
