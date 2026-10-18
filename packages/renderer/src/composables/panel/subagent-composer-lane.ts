/**
 * subagent composer 车道（subagent-composer 2026-10-18）：drawer subagent 详情页的
 * composer 复用主 composer 同一 shell（composer-shell），发送/中止/占用三个终端按
 * 虚拟 id 形状分流到本车道——传输通道复用 `@` 定向消息既有链路（session.subagentAction
 * message 动作 → runtime skill 注入 → /subagents message → core messageHandler 全守卫
 * → Continuation 续聊轮），不新建协议面。
 *
 * 与主 session 车道的行为差异（有意）：
 * - 发送 = subagentAction('message')，无乐观气泡——回显事实源是 SubagentTee entry 帧
 *   （applySubagentEntries 写虚拟分区，含 user entry），与主 agent 发送消息的既有回显
 *   同一链路；冷启窗口（秒级）内 composer 呈 spinner → 轮启动后 stop 态（ADR-0122⑨
 *   UI 跟随事实，不做乐观回显）。
 * - 中止 = cancelSubagent（store：subagentAction('cancel') + 乐观翻 idle），映射发送位
 *   stop 态；主车道的压缩中止/回合中止分型不适用（subagent 无压缩维度）。
 * - 占用相位只有 idle/generating 两态（subagent 无 bash/compacting/settling 维度）。
 * - Alt+⏎ followUp 语义 = 直发（打断入队由 Continuation D2 统一语义承接，无独立车道）。
 *
 * 错误契约对齐 useChat.send（R2-A5）：toast 在本车道内完成，返回 false = 失败
 * （调用方 core dispatch/send 据此 restoreSegments 恢复草稿），不双提示。
 */
import { computed, type ComputedRef } from 'vue'
import type { Segment } from '@taiji/shared'
import { segmentsToPrompt } from '@taiji/shared'
import { session as sessionApi } from '@/api'
import i18n from '@/i18n'
import { useSubagentStore, extractMainSessionId, extractSubagentId, isSubagentVirtualId } from '@/stores/subagent'
import { useToast } from '@/composables/useToast'
import { toErrorMessage } from '@taiji/core'

/** 非 setup 上下文可用的翻译窄口（useChat tFn 同款：vue-i18n 复杂重载 cast 成单签名）。 */
const tFn = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

export interface SubagentComposerLane { // oe-exempt:20261018:framework:车道端口面（composable 返回契约，DI 单实现常态——lane 是唯一生产实装，测试经模块 mock 消费）
  /** 当前 sessionId 是否落在 subagent 车道（三段式虚拟 id） */
  isLane: ComputedRef<boolean>
  /** 目标 record 是否有轮次在飞（占用相位派生源；sendButtonState stop 态 + 视觉 accent） */
  isStreaming: ComputedRef<boolean>
  /** 发送（subagentAction message）；true = 已受理，false = 失败（toast 已在本车道完成） */
  send: (segments: Segment[]) => Promise<boolean>
  /** 中止当前轮（cancelSubagent：subagentAction cancel + store 乐观翻边） */
  abort: () => Promise<void>
}

/**
 * SubagentTab composer 挂载门（chatCapable 判据单点，组件行数治理外移）：三段式虚拟 id
 * （chat 域 record，有实时流）∧ 引擎声明续聊能力（chatCapable——runtime 投影层按引擎
 * manifest conversation 能力位派生，与宿主 message 资格门同轴同源；undefined = 未刷新的
 * 旧帧按不支持处理）。agentcall 快照视图（两段式，D4 只读裁决）与不支持引擎返回 false。
 */
export function isSubagentComposerEligible(
  vid: string | null,
  record: { chatCapable?: boolean } | null | undefined,
): boolean {
  return vid !== null && isSubagentVirtualId(vid) && record?.chatCapable === true
}

export function useSubagentComposerLane(sessionIdRef: ComputedRef<string | null>): SubagentComposerLane {
  const { error: toastError } = useToast()
  const subagentStore = useSubagentStore()

  const isLane = computed(() => sessionIdRef.value !== null && isSubagentVirtualId(sessionIdRef.value))
  const mainSid = computed(() => {
    const vid = sessionIdRef.value
    return vid !== null && isSubagentVirtualId(vid) ? extractMainSessionId(vid) : null
  })
  const subId = computed(() => {
    const vid = sessionIdRef.value
    return vid !== null && isSubagentVirtualId(vid) ? extractSubagentId(vid) : null
  })
  const isStreaming = computed(() =>
    mainSid.value !== null
    && subId.value !== null
    && subagentStore.isStreamingSubagent(mainSid.value, subId.value),
  )

  async function send(segments: Segment[]): Promise<boolean> {
    const targetMain = mainSid.value
    const targetSub = subId.value
    if (targetMain === null || targetSub === null) return false
    try {
      await sessionApi.subagentAction(targetMain, 'message', {
        subagentId: targetSub,
        text: segmentsToPrompt(segments),
      })
      return true
    } catch (e) {
      toastError(tFn('panel.panel.sendFailed', { error: toErrorMessage(e) }))
      return false
    }
  }

  async function abort(): Promise<void> {
    const targetMain = mainSid.value
    const targetSub = subId.value
    if (targetMain === null || targetSub === null) return
    try {
      await subagentStore.cancelSubagent(targetMain, targetSub)
    } catch (e) {
      toastError(toErrorMessage(e))
    }
  }

  return { isLane, isStreaming, send, abort }
}

// ── 车道终端包装（composer-shell 消费）─────────────────────────────────────

/** 主车道动作族窄口（useChat 解构产物的结构子集——包装只透传，不扩面）。 */
interface ChatTerminals { // oe-exempt:20261018:framework:useChat 动作族结构窄口（透传包装的类型承载，单实现常态）
  send: (sessionId: string, segments: Segment[]) => Promise<boolean>
  followUp: (sessionId: string, segments: Segment[]) => Promise<boolean>
  abort: (sessionId: string) => Promise<void>
  compact: (sessionId: string, customInstructions?: string) => Promise<boolean>
  sendBash: (sessionId: string, command: string, excludeFromContext: boolean) => Promise<boolean>
}

/** 车道感知终端族（composer-shell 各 deps 注入点直接消费）。 */
export interface LaneAwareTerminals { // oe-exempt:20261018:framework:车道终端族契约（composer-shell deps 注入面，DI 单实现常态——包装体 wireSubagentLaneTerminals 是唯一实装）
  /** 车道感知活跃视图：lane = record 在飞；主车道 = isActive 原值透传 */
  activeView: ComputedRef<boolean>
  send: ChatTerminals['send']
  followUp: ChatTerminals['followUp']
  abort: ChatTerminals['abort']
  compact: ChatTerminals['compact']
  sendBash: ChatTerminals['sendBash']
}

/**
 * 终端包装（vid 分流，非 lane 输入逐成员透传原实现——主车道行为零变化）：
 * - send / followUp = lane.send（打断入队由 Continuation D2 统一语义承接，无独立车道）；
 * - abort = lane.abort（中止对象 = 当前轮，无压缩分型）；
 * - compact = '/compact …' 文本按字面消息直发（subagent 无压缩流程，拒绝式拦截会
 *   吞掉用户输入）；
 * - sendBash = 恒 false（bash.ts 失败信号契约 = 不分流继续普通提交链，`!` 是普通文本）。
 */
export function wireSubagentLaneTerminals(
  isLane: ComputedRef<boolean>,
  lane: SubagentComposerLane,
  chat: ChatTerminals,
  isActive: ComputedRef<boolean>,
): LaneAwareTerminals {
  return {
    activeView: computed(() => (isLane.value ? lane.isStreaming.value : isActive.value)),
    send: (sid, segments) => (isLane.value ? lane.send(segments) : chat.send(sid, segments)),
    followUp: (sid, segments) => (isLane.value ? lane.send(segments) : chat.followUp(sid, segments)),
    abort: (sid) => (isLane.value ? lane.abort() : chat.abort(sid)),
    compact: (sid, customInstructions) => {
      if (!isLane.value) return chat.compact(sid, customInstructions)
      return lane.send([{ type: 'text', text: customInstructions ? `/compact ${customInstructions}` : '/compact' }])
    },
    sendBash: (sid, command, excludeFromContext) =>
      isLane.value ? Promise.resolve(false) : chat.sendBash(sid, command, excludeFromContext),
  }
}
