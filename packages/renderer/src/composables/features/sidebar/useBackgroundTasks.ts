/**
 * useBackgroundTasks —— 后台命令列表的 per-session 状态根
 *（docs/architecture/background-task-sidebar-view.md §3.3 D8①，u-renderer-store）。
 *
 * 职责：registry 全量投影的 per-session Map 分区（useSessionScopedState，ADR-0049）+
 * 变更通道编排。两个数据来源：
 * - 拉取腿（C6 唯一真相入口）：watch sid 变化 / WS 重连 connected 边沿 / 调 refresh() 时
 *   `backgroundTask.list` RPC（切换/激活 session、打开 plugin tab 由消费层触发）；模块级
 *   in-flight 去重（同 sid 并发拉取复用同一 RPC Promise，各实例消费快照写各自分区，参照
 *   useContextUsage）；
 * - 广播腿（增量刷新）：`backgroundTask:updated` session 级广播——订阅收敛为**模块级
 *   refCount**（AGENTS 规则 2：同 sid 多实例只开一条底层 events.on 物理订阅；消费组件
 *   ——列表视图 + split mode 下 per-pane 多实例的 DetailPanel——只读写分区状态，不各自挂
 *   listener）。物理 handler 闭包捕获注册时 sid，分发经实例 listener →
 *   `updateFor(capturedSid)` 写「消息所属 sid」分区，结构性消除切 session 竞态（M1）。
 *
 * 分区形态：{ tasks: 全量投影, loaded: 是否成功拉到过一次, corrupted: 损坏拍 sticky 标志,
 * fetchFailed: 最近一次 list RPC 失败 }。loaded 区分「从未拉取」与「拉到空表」（S6 全量空态
 * 判定需要）；corrupted/fetchFailed 分别驱动损坏错误条（S7，sticky——损坏后一拍的 corrupted:false
 * 空表广播不清位，由 tasks 非空的自愈拍清位）与断连提示条（S6）。拉取失败保留分区缓存不降级
 * （下次切入/refresh/重连自愈）。
 *
 * 生命周期：session 销毁经 registerSessionCleanup 挂进 useSidebar.deleteSession 编排——
 * 清分区 + 抑制在途写入（迟到的 RPC resolve / 广播不得把已销毁 session 的分区僵尸式写回：
 * updateFor 会重建分区，形成泄漏条目）。抑制条目有界（BG-7 / D6 #2）：迟到写入源
 * （物理订阅 + 在途 RPC）全部枯竭后自动释放，Set 不随销毁次数只增不减。
 *
 * 切走 session 后旧 sid 订阅释放（refCount--），其分区停更、切回时由拉取腿兜底刷新
 *（C6：广播只做增量刷新，拉取是唯一真相入口）。
 */
import { computed, onScopeDispose, reactive, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import * as events from '@xyz-agent/core/transport/api'
import { getState } from '@xyz-agent/core/transport/ws-client'
import { createInflightDedup } from '@xyz-agent/core/foundation/create-inflight-dedup'
import { registerSessionCleanup, useSessionScopedState } from '@/composables/useSessionScopedState'
import * as backgroundTaskApi from '@xyz-agent/core/transport/api/domains/background-task'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'

/** 广播消息 type（shared protocol.ts SSOT；Server→Client 冒号 camelCase）。 */
const UPDATED_TYPE = 'backgroundTask:updated'

/** per-session 分区形态。 */
interface BackgroundTasksPartition {
  /** registry 全量投影（list reply / 广播 payload 原样，不做二次加工）。 */
  tasks: BackgroundTaskEntry[]
  /** 是否成功拉到过一次 list reply（空表也算）——区分「从未拉取」与「拉到空表」。 */
  loaded: boolean
  /** 该拍 registry 解析失败（runtime 安全降级空表；协议 corrupted 字段，缺省按 false 前向兼容，S7）。 */
  corrupted: boolean
  /** 最近一次 list RPC 失败（断连提示条条件之一，S6；成功拍翻回 false）。 */
  fetchFailed: boolean
}

function createPartition(): BackgroundTasksPartition {
  return reactive({ tasks: [] as BackgroundTaskEntry[], loaded: false, corrupted: false, fetchFailed: false })
}

// ── 模块级 refCount 广播订阅（AGENTS 规则 2：同 sid 多实例共享单条物理订阅）──

type BroadcastListener = (sid: string, tasks: BackgroundTaskEntry[], corrupted: boolean) => void

/** 各实例注册的分区写入 listener（物理 handler 分发时遍历；各实例写各自的分区 Map，幂等）。 */
// @data-owner #25
const broadcastListeners = new Set<BroadcastListener>()

/** per-sid 物理订阅表：sid → { count: 实例引用数, unsub: 退订函数 }。 */
// @data-owner #25
const sidSubscriptions = new Map<string, { count: number; unsub: () => void }>()

function acquireBroadcastSubscription(sid: string): void {
  const existing = sidSubscriptions.get(sid)
  if (existing) {
    existing.count += 1
    return
  }
  // 物理 handler 闭包捕获注册时 sid（capturedSid）：watch flush:pre 异步退订窗口内该 sid
  // 的迟到广播仍带旧 sid 进来，实例 listener 拿 capturedSid 调 updateFor 写旧 sid 分区，
  // 不污染新 sid 分区（M1 竞态结构性消除，ADR-0049）。
  const unsub = events.on(sid, (msg) => {
    if (msg.type !== UPDATED_TYPE) return
    // session 通道 handler 无泛型收窄（events.ts 宽 MessageHandler）；payload 形状由
    // shared protocol.ts ServerMessageMap 契约化，运行时仅守卫 tasks 数组（坏形状跳过本拍，
    // 下拍广播/拉取自愈）。corrupted 缺省按 false（协议字段前向兼容，S7）。
    const payload = msg.payload as { tasks?: unknown; corrupted?: unknown }
    if (!Array.isArray(payload.tasks)) return
    const corrupted = payload.corrupted === true
    for (const listener of broadcastListeners) {
      listener(sid, payload.tasks as BackgroundTaskEntry[], corrupted)
    }
  })
  sidSubscriptions.set(sid, { count: 1, unsub })
}

function releaseBroadcastSubscription(sid: string): void {
  const existing = sidSubscriptions.get(sid)
  if (!existing) return
  existing.count -= 1
  if (existing.count <= 0) {
    existing.unsub()
    sidSubscriptions.delete(sid)
    // 广播迟到源枯竭：若在途 RPC 也已 settle，抑制使命完成（BG-7 有界化）
    releaseSuppressionIfIdle(sid)
  }
}

// ── 模块级拉取 in-flight 去重（同 sid 并发 refresh/恢复腿复用同一 Promise）──
//
// 「同 key 复用 / settle 即清 / 引用比对防误删」生命周期收编于 createInflightDedup
// （D9 共享原语，state-truth-sync §3.3）；本模块保留快照消费形态（各实例消费
// ListReplySnapshot 写各自分区）与迟到写入源的抑制释放编排（下方 requestSharedList）。

// @data-owner #25
const listFetchDedup = createInflightDedup<ListReplySnapshot | null>()

/** 单次 list RPC 的解析结果快照（RPC 结果与分区写入解耦：in-flight 去重共享同一 RPC，
 *  各实例消费快照写各自分区——旧形态共享 void Promise 会让复用者的分区永不更新）。 */
interface ListReplySnapshot {
  tasks: BackgroundTaskEntry[]
  corrupted: boolean
}

/**
 * list reply 形状收窄：生产路径为 api domain 透传的全形对象（backgroundTask.tasks payload：
 * { sessionId, tasks, corrupted? }，corrupted 语义见协议 SSOT）。返回 null = 契约外形状——
 * 按失败拍处理（fetchInto 置 fetchFailed=true 并保留分区缓存，不空表降级不清缓存，
 * 外部格式不信任防线）。
 */
function parseListReply(raw: unknown): ListReplySnapshot | null {
  if (typeof raw === 'object' && raw !== null && Array.isArray((raw as { tasks?: unknown }).tasks)) {
    const reply = raw as { tasks: BackgroundTaskEntry[]; corrupted?: unknown }
    return { tasks: reply.tasks, corrupted: reply.corrupted === true }
  }
  return null
}

// ── 已销毁 session 抑制表（迟到写入不得僵尸式重建分区，参照 useContextUsage）──

// @data-owner #25
const suppressedSids = new Set<string>()

/**
 * 抑制条目有界化释放（BG-7 / D6 #2）：该 sid 的全部迟到写入源枯竭（物理订阅已退订 +
 * 在途 RPC 已 settle）后移除抑制登记——防已销毁 session 的 sid 永久滞留（只增不减）。
 * 移除后该 sid 无任何写入路径可达（订阅退订后广播不再投递、RPC settle 后无 resolve），
 * 分区不会被僵尸式重建，语义与抑制期间等价。
 */
function releaseSuppressionIfIdle(sid: string): void {
  if (!sidSubscriptions.has(sid) && !listFetchDedup.has(sid)) suppressedSids.delete(sid)
}

/** 测试隔离钩子：清空全部模块级簿记（用例间残留防污染）。生产代码禁止调用。 */
export function __resetBackgroundTasksForTest(): void {
  for (const { unsub } of sidSubscriptions.values()) unsub()
  sidSubscriptions.clear()
  broadcastListeners.clear()
  listFetchDedup.clear()
  suppressedSids.clear()
}

/** 测试观察钩子：抑制表当前成员（BG-7 有界性断言用）。生产代码禁止调用。 */
export function __suppressedSidsForTest(): readonly string[] {
  return [...suppressedSids]
}

export interface UseBackgroundTasksReturn {
  /** 当前 sid 的分区（computed 按 sidRef 惰性查分区；null sid 返回临时默认实例不写 Map）。 */
  current: ComputedRef<BackgroundTasksPartition>
  /**
   * 手动重拉（C6：打开 plugin tab / WS 重连等场景由消费层触发）。省略参数时拉当前 sid。
   * 同 sid 在途拉取复用同一 Promise（去重）；失败保留分区缓存不降级（resolve 不 reject，
   * 调用方无需 try-catch）。
   */
  refresh: (targetSid?: string) => Promise<void>
}

/**
 * 后台命令状态根。必须在组件 setup 同步调用（内部 watch/onScopeDispose 依赖实例上下文）。
 *
 * @param sessionIdRef 焦点 session id（string | null | undefined；undefined 归一为 null）
 */
export function useBackgroundTasks(sessionIdRef: Ref<string | null | undefined>): UseBackgroundTasksReturn {
  // null 归一：useSessionScopedState 契约要求 Ref<string|null>（null=无活跃 session）
  const normalizedSid = computed(() => sessionIdRef.value ?? null)

  const scoped = useSessionScopedState<BackgroundTasksPartition>(normalizedSid, createPartition)

  /** 快照写入分区的统一应用（广播/拉取两路同型，S7 sticky 语义唯一实现点）：
   *  corrupted 按来源拍判定置位，但**不按最后拍严格清位**——runtime 实测时序：损坏检测拍
   *  （.corrupt rename）后下一拍 stat=undefined 属真实文件消失，会自然发出一条 corrupted:false
   *  空表广播（D1 空表重建既有语义、单广播源判定内）——若该拍清位，错误条会在损坏后一拍闪断。
   *  故 corrupted 置位后由「恢复条目拍」（tasks 非空，extension 自愈空表重建/新任务出现）清位。 */
  function applySnapshot(p: BackgroundTasksPartition, tasks: BackgroundTaskEntry[], corrupted: boolean): void {
    p.tasks = tasks
    p.loaded = true
    if (corrupted) p.corrupted = true
    else if (tasks.length > 0) p.corrupted = false
  }

  /** 实例分区写入 listener：写「消息所属 sid」（capturedSid）分区，非当前视图 sid 也合法
   *  （分区写入与视图无关；视图显示由 current 按 sidRef 派生）。 */
  const listener: BroadcastListener = (sid, tasks, corrupted) => {
    if (suppressedSids.has(sid)) return
    scoped.updateFor(sid, (p) => applySnapshot(p, tasks, corrupted))
  }
  broadcastListeners.add(listener)

  /**
   * 发起/复用同 sid 的 list RPC（模块级去重：并发复用同一 RPC Promise，list 只发一次）；
   * 复用者与发起者**各自**消费快照写各自分区（分区 per-instance，共享 void Promise 会让
   * 复用者分区永不更新）。RPC 失败统一在上游 catch 成 null（debug 单次），各实例据 null
   * 置分区 fetchFailed（保留缓存不降级，S6 断连提示条条件之一），调用方无需 try-catch。
   * settle 即清（下次切入重拉）+ 引用比对防误删由 factory 内建。
   * 回滚窗口说明：RPC 往返期间若更新的广播先落地，较旧的 reply 会短暂覆盖（list reply
   * 是当下 registry 全量快照，后到写赢）；下一拍广播 / 下次切入重拉自愈，不做 recency 对账。
   */
  function requestSharedList(sid: string): Promise<ListReplySnapshot | null> {
    const { promise } = listFetchDedup.run(sid, () =>
      backgroundTaskApi
        .list(sid)
        .then((raw): ListReplySnapshot | null => parseListReply(raw))
        .catch((err: unknown) => {
          // debug 级：可重试瞬态 + transport/pending 层已记错误，避免断连期刷屏（§3.1 断连路径）。
          console.debug('[background-tasks] list failed, keep cached partition', sid, err)
          return null
        }),
    )
    // RPC 迟到源枯竭 → 尝试释放抑制（BG-7 有界化）。必须延迟一个 macrotask：本回调与
    // factory 的 settle 清理都先于 fetchInto 挂在 promise 上的消费回调执行（promise 回调
    // 按注册序），此处同步释放会让「销毁后迟到 resolve」通过消费回调的抑制检查（微任务
    // 窗口内 Set 已清）→ 僵尸写回。macrotask 排到本 settle 派生的全部消费微任务之后，语义精确。
    // （promise 恒 resolve：上游 catch 已吞错，finally 链无 unhandled rejection 面）
    void promise.finally(() => {
      setTimeout(() => releaseSuppressionIfIdle(sid), 0)
    })
    return promise
  }

  function fetchInto(sid: string): Promise<void> {
    return requestSharedList(sid).then((reply) => {
      if (suppressedSids.has(sid)) return
      scoped.updateFor(sid, (p) => {
        if (reply) {
          applySnapshot(p, reply.tasks, reply.corrupted)
          p.fetchFailed = false
        } else {
          p.fetchFailed = true
        }
      })
    })
  }

  async function refresh(targetSid?: string): Promise<void> {
    const sid = targetSid ?? normalizedSid.value
    if (!sid) return
    await fetchInto(sid)
  }

  // 订阅编排：sid 变化先释放旧订阅（refCount--）再获取新订阅（refCount++）。
  // watch 默认 flush:'pre'——切换后旧 sid 的迟到广播在退订前仍经 capturedSid 写旧分区。
  watch(normalizedSid, (sid, oldSid) => {
    if (oldSid) releaseBroadcastSubscription(oldSid)
    if (sid) acquireBroadcastSubscription(sid)
  }, { immediate: true })

  // 拉取腿（C6）：每次进入 sid 视图无条件重拉（immediate 覆盖首挂载；切走期间广播已退订，
  // 分区缓存可能过期，不能依赖缓存不拉——对齐 useContextUsage D3 恢复腿语义）。
  watch(normalizedSid, (sid) => {
    if (sid) {
      suppressedSids.delete(sid) // 重新进入 = 新生命周期，解除清理抑制
      void fetchInto(sid)
    }
  }, { immediate: true })

  // 重连恢复腿（S6）：runtime 重启/WS 断连后 ring 为空（重放无补偿），列表停留旧缓存——
  // connected 边沿重拉当前焦点 sid。每实例各自 watch 并写各自分区（badge 常驻实例 + 列表
  // 视图实例同 sid 时 RPC 经 requestSharedList 去重收敛为一次）；不 immediate（挂载期由
  // 拉取腿覆盖，仅响应断→连边沿）。
  watch(getState(), (s) => {
    if (s === 'connected') void refresh()
  })

  // cleanup 编排：session 销毁（useSidebar.deleteSession → triggerSessionCleanups）时
  // 清分区 + 抑制迟到写入（在途 RPC resolve / 退订前的广播）。分区删除本身已由
  // useSessionScopedState 自动注册（幂等），这里补抑制表簿记。
  const unregisterCleanup = registerSessionCleanup((sid) => {
    scoped.cleanup(sid)
    suppressedSids.add(sid)
  })

  onScopeDispose(() => {
    unregisterCleanup()
    broadcastListeners.delete(listener)
    // 释放本实例持有的订阅引用（watch 维护的 acquire/release 在卸载后不再触发，此处按
    // 卸载时刻的 sid 补一次 release；旧 sid 已在切换时释放过）
    const sid = normalizedSid.value
    if (sid) releaseBroadcastSubscription(sid)
  })

  return { current: scoped.current, refresh }
}
