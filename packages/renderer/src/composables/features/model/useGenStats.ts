/**
 * useGenStats —— Composer 生成指标（token 速度 + 缓存命中率）的 per-session 分区状态源
 * （composer-gen-stats P4，设计 docs/design/composer-gen-stats.md §3.3 D4/D5 + §3.4）。
 *
 * 职责（照 useContextUsage 五件套范式：分区 / 订阅 / 恢复腿 / in-flight 去重 / cleanup）：
 * - 分区：useSessionScopedState 建 per-session 分区（Map 分区范式，ADR-0049），值直接存
 *   GenStatsFrame 本体（§3.4：null = 从未收到合法帧；status 字段已删——unknown 与
 *   「ok 但字段全 null」渲染均为「—」，无消费方）；字段级无值由帧内 null 表达（D4 编码纪律）。
 * - 订阅：只订 session.stats_update，handler 用第二参数 sid 写「消息所属 sid」分区
 *   （updateFor，不读当前 sid 实时值）；
 * - 前端兜底（D4 纵深防御）：帧内 model 缺省 → 丢弃（所有 live 推帧路径均有 model，缺省即
 *   异常）；帧内 model 与该 session 当前 modelId 不匹配 → 丢弃（后端 sid→modelKey 映射
 *   任意空窗产生的脏帧从「覆盖显示」降级为「无害丢弃」）。恢复腿 reply 不经此校验
 *   （RPC 主动拉取语义，modelId 由 runtime 侧降级链权威解析）。
 * - 恢复腿：切入 sid 视图无条件拉 session.getGenStats（架构约定 #7 时序竞争）；RPC 失败
 *   保留分区缓存不降级；
 * - in-flight 去重：模块级 createInflightDedup 表（D9 共享原语收编，meta 携带发起时刻
 *   帧序号），多实例 await 同一 Promise 后各写各分区；resolve/reject 即清条目；带 live
 *   帧 recency 守卫（RPC 发起后已有更新帧落地则跳过写入，防陈旧 reply 回滚）；
 * - cleanup：registerSessionCleanup 挂进 useSidebar.deleteSession 清理编排。
 *
 * 显示语义 = 混合视角：分区值是「session 当前模型」的帧——current 字段为本会话私有样本
 * （本会话最近一次请求；同模型多 session 各自独立，无回落），day/d7/d30 为该模型跨会话
 * 全局聚合（同模型多 session 聚合值相同是预期行为，非串台）。
 *
 * 消费方：GenStatsTriggers.vue 纯读。必须在组件 setup 同步调用（内部 useSessionEvents
 * 依赖 getCurrentInstance 守卫）。
 */
import { computed, onScopeDispose, reactive, watch, type ComputedRef, type Ref } from 'vue'
import { registerSessionCleanup, useSessionScopedState } from '@/composables/useSessionScopedState'
import { useSessionEvents } from '@/composables/features/chat/useSessionEvents'
import { createInflightDedup } from '@taiji/core/foundation/create-inflight-dedup'
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

/**
 * 帧内 model 与该 session 当前 modelId 的匹配判定（D4 前端兜底的比对规则）。
 *
 * 帧 model 语义已锚定 PS-25（docs/pi-semantics.json）：AssistantMessage.model = 请求侧
 * Model.id（pi 模型注册表的模型 id；非 responseModel——那是 provider 实际报告的响应模型，
 * 仅 openai-completions 在路由结果 ≠ 请求 id 时才有，不采）。本函数是 modelKey 语义的
 * 第二个消费端实现（runtime splitModelKey/broadcastModel 为第一个）：runtime 推帧的
 * payload.model 恒为**复合 id** "provider/<Model.id>"（gen-stats-service snapshot 的
 * model 字段 = modelKey，与 currentModelId 同域同构，D6 #14 注释更正——曾误记为
 * Model.id 本体）→ 双形态兼容：① 精确相等（主路径：两侧同为复合 id 直接同域比对）；
 * ② 复合 id 取最后一段 '/' 后缀相等（防御性兜底：currentModelId 或帧缺 provider 段的
 * 旧形态/裸 Model.id 输入）。
 * 其余（真正他模型帧）才丢弃。已知局限（归 S18）：Model.id 自身含 '/'（openrouter 系
 * "vendor/model"）时尾段失配 → 合法帧被无害丢弃，修复须把归属判定上移 runtime（帧内带
 * 结构化归属标记，view-ready），renderer 退化为纯显示——在此之前本函数是兜底权威。
 */
export function genStatsModelMatches(frameModel: string, currentModelId: string): boolean {
  if (frameModel === currentModelId) return true
  const slash = currentModelId.lastIndexOf('/')
  return slash >= 0 && frameModel === currentModelId.slice(slash + 1)
}

export function useGenStats(
  sessionIdRef: Ref<string | null | undefined>,
  modelIdRef?: Ref<string | null | undefined>,
): UseGenStatsReturn {
  /** null 归一：useSessionScopedState 契约要求 Ref<string|null>（null=无活跃 session） */
  const normalizedSid = computed(() => sessionIdRef.value ?? null)

  const scoped = useSessionScopedState(normalizedSid, () => reactive<GenStatsPartition>({ frame: null }))

  /**
   * per-instance live 帧序号表：每次「合法帧」（过 model 校验）到达本实例 handler 时
   * bump。用途：applyReply 判定「RPC 发起后分区是否已被更新的 live 帧覆盖」。
   * 注：session cleanup 不清此表——序号是单调 recency 计数，清零会让在途条目的
   * seqAtIssue 比对出现假性「已覆盖」，误跳过合法写入（与 useContextUsage 同论证）。
   */
  const liveFrameSeqs = new Map<string, number>()

  /**
   * 已清理 sid 抑制表：deleteSession 清掉分区后，在途 RPC resolve / 迟到帧不得把分区
   * 僵尸式写回。重新进入该 sid 视图时解除抑制（新生命周期）。
   */
  const suppressedSids = new Set<string>()

  // ── 订阅（D4）：只订 session.stats_update；handler 用第二参数 sid（消息所属 session）写分区 ──
  const onMessage = useSessionEvents(sessionIdRef)
  onMessage('session.stats_update', (msg, sid) => {
    // 已销毁 session 的迟到帧：静默丢弃（分区已清理，写回即僵尸条目）
    if (suppressedSids.has(sid)) return
    const payload = msg.payload
    // 前端兜底 ①：model 缺省的 live 帧丢弃（所有 live 推帧路径均有 modelKey，缺省即异常）
    if (!payload.model) return
    // 前端兜底 ②：帧内 model ≠ 该 session 当前 modelId → 丢弃（脏映射空窗的脏帧无害化）。
    // renderer 侧 modelId 未知（空/undefined）时无法判定不匹配，放行（保守丢弃会误杀合法帧）
    const currentModel = modelIdRef?.value
    if (currentModel && !genStatsModelMatches(payload.model, currentModel)) return
    // 合法帧落地：bump recency 序号（applyReply 的 skip 判定基准）
    liveFrameSeqs.set(sid, (liveFrameSeqs.get(sid) ?? 0) + 1)
    scoped.updateFor(sid, (p) => {
      p.frame = payload
    })
  })

  /**
   * 恢复腿 reply 落地：recency 守卫 + 写分区（不经 model 校验——RPC 主动拉取语义，
   * modelId 由 runtime 侧降级链权威解析，见 D4）。
   */
  function applyReply(sid: string, reply: GenStatsFrame, seqAtIssue: number): void {
    if (suppressedSids.has(sid)) return
    // RPC 发起后该 sid 已有更新的合法 live 帧落地 → 跳过写入（帧即真相，写入会用陈旧
    // 采样回滚 newer 帧值）
    if ((liveFrameSeqs.get(sid) ?? 0) !== seqAtIssue) return
    scoped.updateFor(sid, (p) => {
      p.frame = reply
    })
  }

  /**
   * 恢复腿（D4）：进入 sid 视图时无条件拉取。in-flight 去重：同 sid 已有在途 RPC 则复用
   * （多实例/同实例快速来回切），不重复发。
   */
  function recover(sid: string): void {
    // 重新进入视图 = 新生命周期：解除该 sid 的清理抑制
    suppressedSids.delete(sid)

    // meta（seqAtIssue）仅在首次发起时捕获，复用条目的实例共享发起时刻值——按 attach
    // 时刻捕获会让发起后落地过 live 帧的分区被陈旧 reply 回滚。settle 即清与引用比对
    // 防误删由 factory 内建（settle 清理先于调用方 then，err 分支接管不产生 unhandled
    // rejection）。
    const entry = inflightGenStatsFetch.run(
      sid,
      () => command('session.getGenStats', { sessionId: sid }, RPC_BACKSTOP_TIMEOUT_MS),
      { seqAtIssue: liveFrameSeqs.get(sid) ?? 0 },
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

  // cleanup 编排：挂进 useSidebar.deleteSession 的 triggerSessionCleanups。
  // 分区删除本已由 useSessionScopedState 自身注册（幂等，二次 Map.delete 是 no-op），
  // 这里显式再挂以对齐设计，同时登记本 composable 自有簿记（抑制表）。
  const unregisterGenStatsCleanup = registerSessionCleanup((sid) => {
    scoped.cleanup(sid)
    suppressedSids.add(sid)
  })
  onScopeDispose(() => {
    unregisterGenStatsCleanup()
  })

  return { current: computed(() => scoped.current.value.frame) }
}
