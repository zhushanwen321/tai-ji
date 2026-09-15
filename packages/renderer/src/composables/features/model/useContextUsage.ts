/**
 * useContextUsage —— Composer 上下文用量的 per-session 分区状态源
 * （context-consistency Phase 2，设计 context-consistency-design §3.3）。
 *
 * 职责（D2 分区 / D3 恢复腿 / D4 0 帧哨兵 / D5-G4 dev 漂移检测器）：
 * - 分区：useSessionScopedState 建 per-session 分区（Map 分区范式，ADR-0049）——B 的帧
 *   物理上写不进 A 分区，结构性消除串台；
 * - 订阅：只订 context.update（D1 协议收敛后 usage 单帧贯穿，不订 state_changed），
 *   handler 用第二参数 sid 写「消息所属 sid」分区（不读当前 sid 实时值）；
 * - 恢复腿：每次进入某 sid 视图无条件拉 session.getContext——no-value 也重拉（切走期间
 *   后台 turn 可能产生新值，组件级订阅已退订收不到帧，不能依赖分区缓存）；RPC 失败保留
 *   分区缓存不降级；
 * - in-flight 去重：模块级 createInflightDedup 表（D9 共享原语收编，meta 携带发起时刻
 *   帧序号），多实例 await 同一 Promise 后各写各分区；resolve 即清条目（下次切入重拉）；
 *   组件 remount 的重复拉取接受（幂等查询）；
 * - cleanup：registerSessionCleanup 挂进 useSidebar.deleteSession 清理编排；
 * - G4 dev 漂移检测器：TAIJI_AGENT_DEBUG=1 时恢复腿 resolve 后对账（口径见 applyReply）。
 *
 * 分区缓存的角色 = RPC 往返期的显示初值 + RPC 失败时的兜底显示（防闪横线），
 * 不是「切回不拉」的依据（理由见设计 D3 后台 turn 论证）。
 *
 * 消费方（Wave 3）：ContextCapacityPopover 改 `const { current } = useContextUsage(...)`
 * 纯读。必须在组件 setup 同步调用（内部 useSessionEvents 依赖 getCurrentInstance 守卫）。
 */
import { computed, onScopeDispose, reactive, watch, type ComputedRef, type Ref } from 'vue'
import { registerSessionCleanup, useSessionScopedState } from '@/composables/useSessionScopedState'
import { useSessionEvents } from '@/composables/features/chat/useSessionEvents'
import { createInflightDedup } from '@taiji/core/foundation/create-inflight-dedup'
import { session as sessionApi } from '@/api'

/** context.update 帧 / getContext reply 的 usage 载荷形状（D1：字段缺失 = 无值）。 */
interface ContextUsageReply {
  sessionId: string
  inputTokens?: number
  contextLimit?: number
  usagePercent?: number
}

/**
 * 分区形态。
 * - unknown：从未收到合法帧也未拉到过 resolve（含恢复腿 in-flight 的过渡态）；
 * - no-value：权威源明确无值（pi tokens=null，如 compact 后无新 turn）；
 * - ok：有真值（used=inputTokens / total=contextLimit / percent=usagePercent）。
 */
export interface UsagePartition {
  status: 'unknown' | 'no-value' | 'ok'
  used: number
  total: number
  percent: number
}

export interface UseContextUsageReturn {
  /** 当前 sid 的用量分区（纯读；null/undefined sid 返回 unknown 默认实例，UI 显「—」） */
  current: ComputedRef<UsagePartition>
}

// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已落定 data-source-registry #3 例外列）：getContext RPC 的 in-flight 去重簿记（Promise 句柄，非用量数据；用量数据本体在 #3 链路的 per-session 分区，经 useSessionScopedState 持有）
/**
 * 模块级 in-flight 去重表（D3 机制约束）：sid → 在途 getContext（createInflightDedup
 * 收编，state-truth-sync §3.3 D9）。
 *
 * 为什么条目必须持 Promise 本体而不是「发起实例的回调」：useSessionScopedState 是
 * per-instance 的（每个 useContextUsage 调用建自己的分区 Map），split panel 双实例同时
 * 切入同一 sid 时，若存回调则第二实例分区永不更新——factory entry 即持 Promise 本体，
 * 每个实例各自 attach then 写自己的分区。entry.meta 携带发起时刻该 sid 的 live 帧序号
 * （recency 基准，存「发起时」而非「attach 时」——复用条目的实例 attach 更晚，若按
 * attach 时序号捕获，发起后落地过 live 帧的分区会被陈旧 reply 回滚，详见 applyReply
 * 的 coveredByNewerFrame 判定）。resolve/reject 即清条目：下次切入同一 sid 重新拉取
 * （无条件恢复腿，不依赖分区缓存的时效）。
 */
const inflightContextFetch = createInflightDedup<ContextUsageReply, { seqAtIssue: number }>()

/** 测试隔离钩子：清模块级 in-flight 表（防用例间残留）。生产代码禁止调用。 */
export function __clearInFlightContextFetchForTest(): void {
  inflightContextFetch.clear()
}

/**
 * G4 dev 漂移检测器开关：TAIJI_AGENT_DEBUG=1。
 *
 * renderer 是浏览器上下文读不到主进程 env，用守卫探测 globalThis.process（vitest /
 * Electron 环境注入时存在；纯浏览器安全降级 false，生产零开销）。
 */
function isDriftDetectorEnabled(): boolean {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.TAIJI_AGENT_DEBUG === '1'
}

export function useContextUsage(sessionIdRef: Ref<string | null | undefined>): UseContextUsageReturn {
  /** null 归一：useSessionScopedState 契约要求 Ref<string|null>（null=无活跃 session） */
  const normalizedSid = computed(() => sessionIdRef.value ?? null)

  // init 必须返回 reactive 容器（useSessionScopedState 响应式契约：plain object 的 mutate
  // 不触发下游 computed 失效）
  const scoped = useSessionScopedState(normalizedSid, () =>
    reactive<UsagePartition>({ status: 'unknown', used: 0, total: 0, percent: 0 }),
  )

  /**
   * per-instance live 帧序号表：每次「合法帧」（真值或无值占位）到达本实例 handler 时
   * bump。全 0 残帧不 bump（未写入分区，不构成 recency 前沿）。用途：
   * applyReply 判定「RPC 发起后分区是否已被更新的 live 帧覆盖」。
   * 注：session cleanup 不清此表——序号是单调 recency 计数，清零会让在途条目的
   * seqAtIssue 比对出现假性「已覆盖」，误跳过合法写入。
   */
  const liveFrameSeqs = new Map<string, number>()

  /**
   * 已清理 sid 抑制表：deleteSession 清掉分区后，在途 RPC resolve / 迟到帧不得把分区
   * 僵尸式写回（updateFor 会重新创建分区，形成已销毁 session 的泄漏条目）。
   * 重新进入该 sid 视图时解除抑制（新生命周期）。
   */
  const suppressedSids = new Set<string>()

  // ── 订阅（D2）：只订 context.update；handler 用第二参数 sid（消息所属 session）写分区 ──
  const onMessage = useSessionEvents(sessionIdRef)
  onMessage('context.update', (msg, sid) => {
    // 已销毁 session 的迟到帧：静默丢弃（分区已清理，写回即僵尸条目）
    if (suppressedSids.has(sid)) return
    const { inputTokens, contextLimit, usagePercent } = msg.payload
    // D4 0 帧哨兵：三字段全 0 物理上不可能是真值（任何模型 contextWindow > 0），属协议
    // 演进期/regression 的 0 基线残帧——丢弃 + dev 冒泡。防御纵深：即使 D1 的 runtime
    // 不变量被未来改动破坏，分区也不被清零（生产静默忽略）
    if (inputTokens === 0 && contextLimit === 0 && usagePercent === 0) {
      console.warn('[context-usage] dropping impossible all-zero frame', sid)
      return
    }
    // 合法帧落地：bump recency 序号（applyReply 的 skip 判定基准）
    liveFrameSeqs.set(sid, (liveFrameSeqs.get(sid) ?? 0) + 1)
    if (inputTokens === undefined || contextLimit === undefined || usagePercent === undefined) {
      // 无值占位帧（仅含 sessionId）：权威源明确无值。数值字段一并清零，防止 ok→no-value
      // 迁移后（如 compact）陈旧数值从 no-value 分区漏出
      scoped.updateFor(sid, (p) => {
        p.status = 'no-value'
        p.used = 0
        p.total = 0
        p.percent = 0
      })
      return
    }
    scoped.updateFor(sid, (p) => {
      p.status = 'ok'
      p.used = inputTokens
      p.total = contextLimit
      p.percent = usagePercent
    })
  })

  /** reply → 分区期望值（独立副本，避免引用分区可变对象） */
  function snapshotFromReply(reply: ContextUsageReply): UsagePartition {
    const { inputTokens, contextLimit, usagePercent } = reply
    if (inputTokens === undefined || contextLimit === undefined || usagePercent === undefined) {
      return { status: 'no-value', used: 0, total: 0, percent: 0 }
    }
    return { status: 'ok', used: inputTokens, total: contextLimit, percent: usagePercent }
  }

  /**
   * 恢复腿 resolve 落地：G4 对账（debug 时）+ 写分区。
   *
   * G4 对账口径（对设计 D5-G4 的精确化，避免误报），按序判定：
   * 1. RPC 发起后该 sid 已有更新的合法 live 帧落地 → 跳过对账**并跳过写入**——帧即真相，
   *    分区新于 reply 属正常；写入反而会用陈旧采样回滚 newer 帧值；
   * 2. 分区仍是 unknown → 跳过对账（从未有值，无漂移可言——首拉必经态）；
   * 3. 其余情形分区应已收敛到 owner 快照：值不等 → console.warn 带两值与 sid。
   *    此时分区显示确与 owner 快照不一致（如某写入路径被丢），warn 即 G4 目标信号；
   *    warn 后照常写 reply，恢复腿自愈。
   * 对账只对「当前视图 sid」进行（经 scoped.current 读分区）：G4 关心的是用户眼前显示的
   * 漂移，非当前视图分区无 UI 意义且无读取 API。
   */
  function applyReply(sid: string, reply: ContextUsageReply, seqAtIssue: number): void {
    if (suppressedSids.has(sid)) return
    const coveredByNewerFrame = (liveFrameSeqs.get(sid) ?? 0) !== seqAtIssue
    if (coveredByNewerFrame) return

    if (isDriftDetectorEnabled() && normalizedSid.value === sid) {
      const partition = scoped.current.value
      if (partition.status !== 'unknown') {
        const expectedSnap = snapshotFromReply(reply)
        if (
          partition.status !== expectedSnap.status ||
          partition.used !== expectedSnap.used ||
          partition.total !== expectedSnap.total ||
          partition.percent !== expectedSnap.percent
        ) {
          console.warn('[context-usage] drift detected', {
            sid,
            partition: { status: partition.status, used: partition.used, total: partition.total, percent: partition.percent },
            reply,
          })
        }
      }
    }

    const next = snapshotFromReply(reply)
    scoped.updateFor(sid, (p) => {
      p.status = next.status
      p.used = next.used
      p.total = next.total
      p.percent = next.percent
    })
  }

  /**
   * 恢复腿（D3）：进入 sid 视图时无条件拉取。in-flight 去重：同 sid 已有在途 RPC 则复用
   * （多实例/同实例快速来回切），不重复发。
   */
  function recover(sid: string): void {
    // 重新进入视图 = 新生命周期：解除该 sid 的清理抑制
    suppressedSids.delete(sid)

    // meta（seqAtIssue）仅在首次发起时捕获，复用条目的实例共享发起时刻值（理由见模块级
    // 表注释）。settle 即清与引用比对防误删由 factory 内建（settle 清理先于调用方 then，
    // err 分支接管不产生 unhandled rejection）。
    const entry = inflightContextFetch.run(
      sid,
      () => sessionApi.getContext(sid),
      { seqAtIssue: liveFrameSeqs.get(sid) ?? 0 },
    )
    void entry.promise.then(
      (reply) => applyReply(sid, reply, entry.meta.seqAtIssue),
      (err: unknown) => {
        // RPC 失败：保留分区缓存不降级（分区缓存角色 = 失败兜底显示），下次切入重拉自愈。
        // debug 级而非 warn/error：可重试瞬态 + transport/pending 层已记错误，避免断连期刷屏
        console.debug('[context-usage] getContext failed, keep cached partition', sid, err)
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

  // cleanup 编排（D2 第 3 条）：挂进 useSidebar.deleteSession 的 triggerSessionCleanups。
  // 分区删除本已由 useSessionScopedState 自身注册（幂等，二次 Map.delete 是 no-op），
  // 这里显式再挂以对齐设计，同时清理本 composable 自有簿记（抑制表登记 + 分区）。
  const unregisterUsageCleanup = registerSessionCleanup((sid) => {
    scoped.cleanup(sid)
    suppressedSids.add(sid)
  })
  onScopeDispose(() => {
    unregisterUsageCleanup()
  })

  return { current: scoped.current }
}
