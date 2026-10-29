// pending-todos —— 「需要你处理」待办聚合纯函数（remote-use-mobile-v2 §6.18 聚合半）。
//
// 聚合范围裁决（§6.18 收窄口径）：「需要你处理」区与底部导航计数 = 全部会话的可归属待办
// + 全局（无归属）待办；进行中页的回合面板/子代理/队列只看 activeSession（订阅数据只对
// 活跃会话完备）。BottomNav 计数角标与本聚合消费同一快照（单数据源），「导航计数与聚合区
// 计数一致」由构造性保证，不留第二套计数逻辑。
//
// 数据源分界（快照注入形态，纯函数零壳层依赖）：
// - form/planReview：companion-bridge form 通道分区（per-session Map）全表计数快照；
// - dialog：ui 包 createDialogRequestQueue.pendingCountBySession 跨分区计数读口（§6.18
//   聚合对 dialog 的唯一跨分区通路——currentRequest/pendingCount 只读活跃分区）；
// - permission：审批通道全局单例 pending（V-6 两问不成立 → protocol sessionId 恒不填 →
//   权限请求恒无归属 = 全局区一等分支，u-runtime-adapt 降级分支的消费落点）。
//
// 「无归属」的壳层落点：现行三通道数据面下 form/planReview/dialog 全部带会话归属
// （form 通道 C2 门跳过无 sid 帧；dialog 分区键必填），全局区实际条目 = permission；
// 聚合仍保留无效归属键（空串）进全局区的分支——「无归属是一等分支」的结构性承接，
// 通道放开（如 §6.18 降级回退）时零改动。

/** 会话归属待办组（会话区一行 = 一个有挂起待办的会话） */
export interface SessionPendingGroup {  // oe-exempt:20261026:framework:待办聚合视图模型契约（ActivityScreen 消费边界）
  sessionId: string
  /** ask-user 富交互表单挂起数 */
  formCount: number
  /** planReview 计划审批挂起数 */
  planReviewCount: number
  /** dialog 四型（confirm/select/input/editor）挂起数 */
  dialogCount: number
  /** 该会话待办合计（导航计数与条目徽标的同一口径） */
  total: number
}

/** 无归属全局区汇总（§6.18：不归属、不参与删除级联） */
export interface GlobalPendingSummary {  // oe-exempt:20261026:framework:待办聚合视图模型契约（导航计数与聚合区同源）
  /** 权限审批待答数（全局单例，0/1） */
  permissionCount: number
  /** 无归属 form/planReview/dialog 条目数（当前通道结构性为 0，分支保留见文件头） */
  unattributedCount: number
}

/** 聚合快照（聚合区渲染与导航计数的同一数据形态） */
export interface PendingTodoSummary {  // oe-exempt:20261026:framework:待办聚合视图模型契约
  /** 可归属组（按 sessionOrder 排序，未知 sid 殿后——客户端不重排原则） */
  sessionGroups: SessionPendingGroup[]
  global: GlobalPendingSummary
  /** 全部待办条目合计（BottomNav 计数角标的唯一来源） */
  total: number
}

/** 聚合输入（三源快照 + 排序基准；各源由 companion-bridge 读口供给） */
export interface PendingTodoInput {  // oe-exempt:20261026:framework:待办聚合输入契约（纯函数模块边界）
  /** form/planReview 分区计数快照：sid → { form, planReview } */
  formCounts: ReadonlyMap<string, { form: number; planReview: number }>
  /** dialog 分区计数快照（queue pendingCountBySession） */
  dialogCounts: ReadonlyMap<string, number>
  /** 权限审批待答在场（全局单例 pending） */
  permissionPending: boolean
  /** 会话序（sessionList 顺序；组内排序基准） */
  sessionOrder: readonly string[]
}

/** 单会话待办组的可变累加载体（聚合内部态，不出函数） */
interface MutableGroup {  // oe-exempt:20261026:framework:待办聚合内部装配模型（纯函数实现细节）
  formCount: number
  planReviewCount: number
  dialogCount: number
}

const EMPTY_GROUP: Readonly<MutableGroup> = { formCount: 0, planReviewCount: 0, dialogCount: 0 }

/**
 * 三源待办聚合（§6.18 聚合半唯一实现点）：
 * - 可归属（有效 sid）进 sessionGroups，按 sessionOrder 排序、未知 sid 殿后；
 * - 无归属（permission 恒无归属 + 无效归属键兜底）进 global；
 * - total = 全部条目合计（导航计数与聚合区一致的同源口径）。
 */
export function summarizePendingTodos(input: PendingTodoInput): PendingTodoSummary {
  const bySid = new Map<string, MutableGroup>()
  const unattributed: MutableGroup = { ...EMPTY_GROUP }

  const groupOf = (sid: string): MutableGroup | null => {
    if (sid === '') {
      // 无归属一等分支（§6.18）：无效归属键不归属到任何会话区
      return null
    }
    let g = bySid.get(sid)
    if (!g) {
      g = { formCount: 0, planReviewCount: 0, dialogCount: 0 }
      bySid.set(sid, g)
    }
    return g
  }

  for (const [sid, counts] of input.formCounts) {
    const g = groupOf(sid) ?? unattributed
    g.formCount += counts.form
    g.planReviewCount += counts.planReview
  }
  for (const [sid, count] of input.dialogCounts) {
    const g = groupOf(sid) ?? unattributed
    g.dialogCount += count
  }

  const orderIndex = new Map(input.sessionOrder.map((sid, i) => [sid, i]))
  const sessionGroups: SessionPendingGroup[] = [...bySid.entries()]
    .map(([sessionId, g]): SessionPendingGroup & { order: number } => ({
      sessionId,
      formCount: g.formCount,
      planReviewCount: g.planReviewCount,
      dialogCount: g.dialogCount,
      total: g.formCount + g.planReviewCount + g.dialogCount,
      order: orderIndex.get(sessionId) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...group }) => group)

  const global: GlobalPendingSummary = {
    permissionCount: input.permissionPending ? 1 : 0,
    unattributedCount: unattributed.formCount + unattributed.planReviewCount + unattributed.dialogCount,
  }

  const sessionTotal = sessionGroups.reduce((sum, g) => sum + g.total, 0)
  return {
    sessionGroups,
    global,
    total: sessionTotal + global.permissionCount + global.unattributedCount,
  }
}
