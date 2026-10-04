/**
 * useGenStats —— Composer 生成指标（token 速度 + 缓存命中率）的 per-session 分区状态源
 * （composer-gen-stats P4，D4/D5）。
 *
 * 职责（照 useContextUsage 五件套范式：分区 / 订阅 / 恢复腿 / in-flight 去重 / cleanup）：
 * - 分区：useSessionScopedState 建 per-session 分区（Map 分区范式，ADR-0049），值直接存
 *   GenStatsFrame 本体（§3.4：null = 从未收到合法帧；status 字段已删——unknown 与
 *   「ok 但字段全 null」渲染均为「—」，无消费方）；字段级无值由帧内 null 表达（D4 编码纪律）。
 * - 订阅：只订 session.stats_update，handler 用第二参数 sid 写「消息所属 sid」分区
 *   （updateFor，不读当前 sid 实时值），帧无条件落地——纯显示，不做归属比对（A4/S18：
 *   帧归属判定权威在 runtime，见下方「帧归属契约」）；
 * - 帧归属契约（A4/S18 上移，plan-mode-audit-remediation）：帧内 model 字段 = runtime
 *   权威解析的「该 session 当前模型」复合 key（gen-stats-service 三写一清映射 + D4 条件
 *   回写 + MF9 帧序 + 恢复腿降级链共同保证「发给某 sid 的帧归属该 sid 当前模型」）。
 *   本 composable 曾在消费侧本地比对 frame.model 与当前 modelId（genStatsModelMatches
 *   尾段兜底）——信息在产生处已传递、消费处重复推断，且尾段规则对 Model.id 自含 '/'
 *   的 openrouter 系（"vendor/model"）失配、会丢弃合法帧（S18 登记债）。现删除消费侧
 *   推断，runtime 帧即真相。
 * - 恢复腿：切入 sid 视图无条件拉 session.getGenStats（架构约定 #7 时序竞争）；RPC 失败
 *   保留分区缓存不降级；
 * - in-flight 去重：模块级 createInflightDedup 表（D9 共享原语收编，meta 携带发起时刻
 *   帧序号），多实例 await 同一 Promise 后各写各分区；resolve/reject 即清条目；带 live
 *   帧 recency 守卫（RPC 发起后已有更新帧落地则跳过写入，防陈旧 reply 回滚）；
 * - cleanup：分区删除由 useSessionScopedState 工厂自动注册进 useSidebar.deleteSession
 *   清理编排（含 deletedSids 僵尸写回拦截，D-B2-1）。
 *
 * 显示语义 = 混合视角：分区值是「session 当前模型」的帧——current 字段为本会话私有样本
 * （本会话最近一次请求；同模型多 session 各自独立，无回落），day/d7/d30 为该模型跨会话
 * 全局聚合（同模型多 session 聚合值相同是预期行为，非串台）。
 *
 * 消费方：GenStatsTriggers.vue 纯读。必须在组件 setup 同步调用（内部 useSessionEvents
 * 依赖 getCurrentInstance 守卫）。
 */
import { computed, reactive, watch, type ComputedRef, type Ref } from 'vue'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import { useSessionEvents } from '@/composables/features/chat/useSessionEvents'
import { createInflightDedup } from '@taiji/core/foundation/create-inflight-dedup'
import { createFrameBookkeeping } from '@taiji/core/foundation/create-frame-bookkeeping'
import { command, RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'
import type { GenStatsFrame } from '@taiji/shared'

/** 分区容器（useSessionScopedState 响应式契约要求 reactive 容器：mutate 才触发下游失效） */
// @data-owner #26 —— #26 生成指标的 renderer 消费分区（live 帧 + 恢复腿 reply 双路喂入；
// 权威源/唯一写入口/null 空值语义见登记表主表 #26 行，非第二写方）
interface GenStatsPartition {
  frame: GenStatsFrame | null
}

export interface UseGenStatsReturn {
  /** 当前 sid 的帧分区（纯读；无合法帧时为 null，UI 显「—」） */
  current: ComputedRef<GenStatsFrame | null>
}

// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已落定登记表 §4 ⑧ 补登 2026-09-07）：getGenStats RPC 的 in-flight 去重簿记（Promise 句柄，非指标数据；指标数据本体在 per-session 分区 @data-owner #26，经 useSessionScopedState 持有）
/**
 * 模块级 in-flight 去重表：sid → 在途 getGenStats（createInflightDedup 收编，
 * state-truth-sync §3.3 D9）。entry 持 Promise 本体（非发起实例回调）：多实例快速切入
 * 同一 sid 复用同一次 RPC；entry.meta 携带发起时刻该 sid 的 live 帧序号（recency 基准，
 * 见 applyReply）；settle 即清条目：下次切入重拉（无条件恢复腿，不依赖分区缓存时效）。
 */
const inflightGenStatsFetch = createInflightDedup<GenStatsFrame, { seqAtIssue: number }>()

/** 测试隔离钩子：清模块级 in-flight 表（防用例间残留）。生产代码禁止调用。 */
export function __clearInFlightGenStatsForTest(): void {
  inflightGenStatsFetch.clear()
}

export function useGenStats(
  sessionIdRef: Ref<string | null | undefined>,
  /**
   * 已退役（A4/S18 归属上移 runtime）：帧归属判定权威在 gen-stats-service（帧 model 字段
   * = runtime 权威解析的复合 modelKey），renderer 不再本地比对。参数签名保留——生产调用方
   * GenStatsTriggers.vue 仍按双参形态传 props.modelId，删参会破坏其编译；该调用方与
   * Composer 下传链的 prop 清理属 composable 之外，随调用方后续清扫一并移除。
   */
  _modelIdRef?: Ref<string | null | undefined>,
): UseGenStatsReturn {
  /** null 归一：useSessionScopedState 契约要求 Ref<string|null>（null=无活跃 session） */
  const normalizedSid = computed(() => sessionIdRef.value ?? null)

  const scoped = useSessionScopedState(normalizedSid, () => reactive<GenStatsPartition>({ frame: null }))

  /**
   * 帧写入仲裁簿记（recency 序号表）：共享原语单点 createFrameBookkeeping
   * （与 useContextUsage 同构收敛），行为语义见原语模块头注——序号表 session cleanup
   * 不清（清零会假性「已覆盖」误跳合法写入）。已删分区的僵尸写回拦截由工厂
   * deletedSids 承担（D-B2-1），本 composable 不自养抑制簿记。
   */
  const bookkeeping = createFrameBookkeeping()

  // ── 订阅（D4）：只订 session.stats_update；handler 用第二参数 sid（消息所属 session）写分区。
  // 帧无条件落地（纯显示，A4/S18）：归属判定权威在 runtime 推帧侧（帧 model = 权威复合
  // modelKey），renderer 不再做 model 缺省/匹配校验——消费侧重复推断曾对 openrouter 系
  // （Model.id 自含 '/'）尾段失配、丢弃合法帧，见文件头「帧归属契约」。
  const onMessage = useSessionEvents(sessionIdRef)
  onMessage('session.stats_update', (msg, sid) => {
    const payload = msg.payload
    // 帧落地：bump recency 序号（applyReply 的 skip 判定基准）
    bookkeeping.bumpSeq(sid)
    scoped.updateFor(sid, (p) => {
      p.frame = payload
    })
  })

  /**
   * 恢复腿 reply 落地：recency 守卫 + 写分区（不经 model 校验——RPC 主动拉取语义，
   * modelId 由 runtime 侧降级链权威解析，见 D4）。
   */
  function applyReply(sid: string, reply: GenStatsFrame, seqAtIssue: number): void {
    // RPC 发起后该 sid 已有更新的合法 live 帧落地 → 跳过写入（帧即真相，写入会用陈旧
    // 采样回滚 newer 帧值）
    if (bookkeeping.hasNewerFrame(sid, seqAtIssue)) return
    scoped.updateFor(sid, (p) => {
      p.frame = reply
    })
  }

  /**
   * 恢复腿（D4）：进入 sid 视图时无条件拉取。in-flight 去重：同 sid 已有在途 RPC 则复用
   * （多实例/同实例快速来回切），不重复发。
   */
  function recover(sid: string): void {
    // meta（seqAtIssue）仅在首次发起时捕获，复用条目的实例共享发起时刻值——按 attach
    // 时刻捕获会让发起后落地过 live 帧的分区被陈旧 reply 回滚。settle 即清与引用比对
    // 防误删由 factory 内建（settle 清理先于调用方 then，err 分支接管不产生 unhandled
    // rejection）。
    const entry = inflightGenStatsFetch.run(
      sid,
      () => command('session.getGenStats', { sessionId: sid }, RPC_BACKSTOP_TIMEOUT_MS),
      { seqAtIssue: bookkeeping.seqAt(sid) },
    )
    void entry.promise.then(
      (reply) => applyReply(sid, reply, entry.meta.seqAtIssue),
      (err: unknown) => {
        // RPC 失败：保留分区缓存不降级（分区缓存角色 = 失败兜底显示），下次切入重拉自愈。
        // debug 级而非 warn/error：可重试瞬态 + transport/pending 层已记错误，避免断连期刷屏
        console.debug('[gen-stats] getGenStats failed, keep cached partition', sid, err)
      },
    )
  }

  // 恢复腿触发源：每次进入某 sid 视图（immediate 覆盖首挂载）。null/undefined 不拉
  watch(
    sessionIdRef,
    (sid) => {
      if (sid) recover(sid)
    },
    { immediate: true },
  )

  // cleanup 编排：分区删除由 useSessionScopedState 自动注册进 triggerSessionCleanups
  //（含 deletedSids 僵尸写回拦截，D-B2-1），本 composable 无自有簿记需登记。

  return { current: computed(() => scoped.current.value.frame) }
}
