/**
 * useSkillNoticeStream —— session.skillNotice 广播的消费与呈现编排（composer-multi-skill-injection u5）。
 *
 * 职责（单一变化轴「skill 注入提示数据」）：
 * - 订阅 session.skillNotice（payload 带 sessionId，routeInbound FALLBACK 走 session 通道，
 *   经 useSessionEvents 编排；无需改 ws-client/event-bus 注册）。
 * - 提示写入 per-session 分区（ADR-0049 useSessionScopedState 工厂；WS handler 用
 *   updateFor(capturedSid)，结构性消除切 session 竞态——架构关键规则 8）。
 * - 失效类（D8：skill_missing/skill_read_failed/marker_malformed/mapping_unavailable）
 *   触发 toast（复用 useToast 模块级单例）；降级类（D6：budget_exceeded/context_window_unavailable）
 *   仅内联呈现，不 toast（场景 2③/2b② 的轻量提示要求，实施形态为消息内联提示行——impl-plan §5 R6）。
 * - 无消息锚点（clientUuid 缺省：steer/followUp 路径无 <!--taiji:msg:--> 标记）时降级为仅 toast，
 *   降级类此时也 toast（否则静默丢弃，违反「不得静默」；设计未规定该边界，取保守可用方向，
 *   见实施计划 §5 合理偏差登记）。
 *
 * 呈现数据消费方：MessageStream.vue（interleaveSkillNoticeItems 把 notice 项插到锚点 turn 之后，
 * SkillNoticeInline.vue 渲染单行）。
 *
 * 持久性声明：提示是会话内存态（不写 sidecar / 不落盘）——设计场景 2/3 的步骤语境只要求
 * 发送后即时呈现；renderer 刷新后提示消失是接受的行为（若 session.subscribe 回放 ring 里
 * 仍有该帧则自然恢复，不作为契约依赖）。
 *
 * 幂等去重：signature = clientUuid|reason|skills——runtime 对 bus.publish 的帧可能经
 * reconcile 回放重放（seq gap 回拉），双 panel 同 session 多实例也各有一条订阅；同签名
 * 只入分区一次、只 toast 一次。无锚点的不同消息若 reason+skills 全同则合并为一条提示
 * （无锚点本就无法区分消息，信息无损失）。
 */
import { computed, reactive, type ComputedRef, type DeepReadonly, type Ref } from 'vue'
import i18n from '@/i18n'
import type { ServerMessageMap } from '@taiji/shared'
import type { RenderItem } from '@taiji/core/domain/chat'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import { useSessionEvents } from '@/composables/features/chat/useSessionEvents'
import { useToast } from '@/composables/useToast'

/** SkillNoticeReason 联合从 protocol 契约索引提取（shared index.ts 未单独导出该联合，
 *  不越权补登记——与 runtime skill-injector 同款单一事实源）。 */
export type SkillNoticeReason = ServerMessageMap['session.skillNotice']['reason']

/** 单条 skill 注入提示（会话内存态，见文件头持久性声明）。 */
export interface SkillNoticeEntry {
  /** 稳定渲染 key（virtua item key，`n-` 前缀与 renderKey 的 t-/s- 空间区分）= 去重签名。 */
  id: string
  /** 消息锚点 = appendUser 生成的 user message id（runtime 从发送文本 <!--taiji:msg:<uuid>--> 提取）。
   *  缺省 = 无锚点（steer/followUp / 纯文本消息），仅 toast 呈现不内联。 */
  clientUuid?: string
  reason: SkillNoticeReason
  /** 受影响 skill 名（runtime 侧已去重；marker_malformed 提取不出 name 时可为空数组）。 */
  skills: string[]
}

/** 降级类（整条降级为标记模式注入，badge 提示两文案可区分——场景 2③/2b②）。
 *  失效类 = reason 全集闭集的补集（D8 四类），判定统一走 isDegradeReason，双集合不并存防漂移。 */
const DEGRADE_REASONS: ReadonlySet<SkillNoticeReason> = new Set(['budget_exceeded', 'context_window_unavailable'])

/** 提示形态判定（toast 策略与 SkillNoticeInline 视觉 variant 共用单一来源）。 */
export function isDegradeReason(reason: SkillNoticeReason): boolean {
  return DEGRADE_REASONS.has(reason)
}

/** MessageStream 渲染项全集：core RenderItem 三态 + skill notice 项（u5 新增，仅存在于
 *  MessageStream 的渲染层拼接，不进 core RenderItem union——core 类型不在 renderer 领地）。
 *  entry 用 DeepReadonly：渲染层只读消费（分区内的 mutable 原型不经此类型外泄）。 */
export type SkillNoticeStreamItem = RenderItem | { kind: 'skillNotice'; entry: DeepReadonly<SkillNoticeEntry> }

/** per-session 分区状态：seen 做幂等去重，entries 是呈现数据（渲染只消费 entries）。 */
// @data-owner #27 —— #27 skill 注入提示的 renderer 消费分区（live-only 瞬态，会话内存态
// 不落盘；权威广播写入口/live-only 语义见登记表主表 #27 行，非第二写方）
interface SkillNoticePartition {
  seen: Set<string>
  entries: SkillNoticeEntry[]
}

function createPartition(): SkillNoticePartition {
  return reactive({ seen: new Set<string>(), entries: [] as SkillNoticeEntry[] })
}

function signatureOf(payload: { clientUuid?: string; reason: string; skills: string[] }): string {
  return `${payload.clientUuid ?? ''}|${payload.reason}|${[...payload.skills].join(',')}`
}

/** 提示文案（SkillNoticeInline 与 toast 共用单一来源，禁硬编码规范 → i18n）。
 *  参数为独立结构类型（skills readonly）：兼容 mutable payload 与 DeepReadonly entry 两种传入。 */
export function skillNoticeText(entry: { reason: SkillNoticeReason; skills: readonly string[] }): string {
  // vue-i18n 复杂重载窄化（useConnection.ts 同款 cast）
  const t = i18n.global.t as (key: string, params?: Record<string, unknown>) => string
  switch (entry.reason) {
    case 'budget_exceeded':
      return t('panel.skillNotice.degradeBudget')
    case 'context_window_unavailable':
      return t('panel.skillNotice.degradeWindow')
    case 'skill_missing':
      return t('panel.skillNotice.missing', { names: entry.skills.join(', ') })
    case 'skill_read_failed':
      return t('panel.skillNotice.readFailed', { names: entry.skills.join(', ') })
    case 'marker_malformed':
      return t('panel.skillNotice.malformed')
    case 'mapping_unavailable':
      return t('panel.skillNotice.mappingUnavailable')
    default:
      return t('panel.skillNotice.malformed')
  }
}

/**
 * session.skillNotice 消费编排。在组件 setup 内调用（useSessionEvents 要求实例上下文）。
 *
 * @param sessionId 当前 session id ref（MessageStream 传 props 同源 computed；null 视为无活跃
 *   session——useSessionScopedState 工厂要求 Ref<string | null>，undefined 在此归一）
 */
export function useSkillNoticeStream(sessionId: Ref<string | null>): {
  /** 当前 session 的提示列表（响应式，渲染层经 interleaveSkillNoticeItems 拼进对话流）。 */
  notices: ComputedRef<DeepReadonly<SkillNoticeEntry[]>>
} {
  // per-session 分区（ADR-0049）：实例级 Map 由工厂持有，删 session 经 triggerSessionCleanups 释放
  const state = useSessionScopedState<SkillNoticePartition>(sessionId, createPartition)
  const onMessage = useSessionEvents(sessionId)
  const toast = useToast()

  onMessage('session.skillNotice', (msg, sid) => {
    const payload = msg.payload
    const signature = signatureOf(payload)
    let duplicate = false
    // [架构关键规则 8] WS handler 用 updateFor(capturedSid)：写入「消息所属 session」分区，
    // 不读 sid.value 实时值——切 session 竞态下不污染新分区。
    state.updateFor(sid, (part) => {
      if (part.seen.has(signature)) {
        duplicate = true
        return
      }
      part.seen.add(signature)
      part.entries.push({
        id: `n-${signature}`,
        ...(payload.clientUuid !== undefined ? { clientUuid: payload.clientUuid } : {}),
        reason: payload.reason,
        skills: [...payload.skills],
      })
    })
    if (duplicate) return

    // toast 副作用（分区写入成功后执行一次）：失效类必 toast（D8 禁静默）；降级类仅在
    // 无锚点（不内联）时 toast 兜底，有锚点走内联轻量提示不弹 toast。
    if (isDegradeReason(payload.reason)) {
      if (payload.clientUuid === undefined) {
        toast.info(skillNoticeText(payload))
      }
      return
    }
    toast.warning(skillNoticeText(payload))
  })

  /** 当前 session 的提示列表（供渲染层拼接）。 */
  const notices = computed(() => state.current.value.entries)

  return { notices }
}

/**
 * 把 notice 渲染项插入对话流渲染项：锚点命中的 notice 紧跟其 turn 之后（到达序），
 * 无锚点 / 宿主不在场（消息被删、未 hydrate）的 notice 不产出渲染项（toast 已承担可见性，
 * 数据保留在分区不丢）。纯函数：无 notice 时原样返回（保持增量派生引用恒等路径零开销）。
 */
export function interleaveSkillNoticeItems(
  items: RenderItem[],
  notices: DeepReadonly<SkillNoticeEntry[]>,
): SkillNoticeStreamItem[] {
  if (notices.length === 0) return items
  const out: SkillNoticeStreamItem[] = []
  for (const item of items) {
    out.push(item)
    if (item.kind !== 'turn' || !item.turn.user) continue
    for (const notice of notices) {
      // 锚点匹配：clientUuid 即 appendUser 的 user message id（= turn.user.id，同一 id 空间）
      if (notice.clientUuid !== undefined && notice.clientUuid === item.turn.user.id) {
        out.push({ kind: 'skillNotice', entry: notice })
      }
    }
  }
  return out
}

/**
 * MessageStream 侧组装封装：订阅 notice 流 + 把渲染项拼进对话流基准数组（streamItems）。
 *
 * 从 MessageStream.vue 拆出（vue_rules_checker script ≤300 行规范；合并叠加后触线）。
 * [索引一致性硬约束] 返回的 streamItems 必须是 :data / lastUserTurnIdx / useStreamingPin /
 * rail 四处消费的同一数组基准——virtua 的 keepMounted 与 rail jump 都是下标空间操作，
 * 混用 renderItems 与 streamItems 两个基准会错钉/错跳。
 */
export function useSkillNoticeStreamItems(
  sessionId: ComputedRef<string>,
  renderItems: ComputedRef<RenderItem[]>,
): { streamItems: ComputedRef<SkillNoticeStreamItem[]> } {
  const { notices } = useSkillNoticeStream(sessionId)
  const streamItems = computed(() => interleaveSkillNoticeItems(renderItems.value, notices.value))
  return { streamItems }
}
