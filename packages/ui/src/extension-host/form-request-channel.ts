// form-request-channel —— form/planReview 类请求通道的共享 factory（双壳算法单点，
// MF-1-7 收敛落点；extension-host 三通道家族中 dialog/permission 已下沉先例
// createCompanionDialogAdapters / createPermissionRequestController 之后的最后一个成员）。
//
// 下沉范围 = 双壳共同不变量的算法段（纯翻译件零壳裁决，壳层能力经钩子注入，对齐
// shell-adapters 先例）：
// - C4 富交互门：form ∨ planReview 放行（isRichInteractionFrame 单点，帧守卫在 form-protocol）
// - 快照对账算法：getPendingRequests 差集剔除（不在快照中的旧条目一律移除，**空快照也
//   执行剔除**——覆盖「runtime 已清 pending 而壳分区仍留僵尸请求」主路径）；补入只入
//   富交互帧（快照补入过滤），空分区 no-op
// - 失效摘除：按 requestId 摘除（幂等）；摘除前条目集随钩子外发（桌面 planReview
//   answered 判定的输入）
// - respond 核心流：定位 → sendExtensionUIResponse 回传 → 未送达保留分区条目可重试
//   （M1/RD-3#1）/ 送达即摘除
// - 读口：队首 form 帧 / planReview 审批帧列表（响应性由 partitions 实现自带——桌面
//   pinia store ref 分区、移动 reactive Map 分区，读口在 computed 内调用即建立依赖）
//
// 壳各自保留的装配裁决（不进本模块）：
// - bus 订阅生命周期（桌面 per-panel refCount 防多实例翻倍 / 移动模块级永驻）：壳 handler
//   判空 sid（C2）后经 ingest / invalidate 写口入帧；
// - 帧适配：桌面 toExtensionUIRequest（全字段白名单 + receivedAt 戳）/ 移动
//   toMobileFormRequest（消费面子集），经 adaptFrame / adaptSnapshot 注入；
// - 桌面特有编排：planReview 镜像同步（syncPlanReviewWindow / markPlanReviewAnswered）、
//   pendingSend 分型收口（clearPendingSend）、btw 草稿终结清理（clearBtwBarDrafts）、
//   toast 反馈——经 onIngested / onInvalidated / onSnapshotReconciled / onRespondExpired /
//   onRespondUndelivered / onRespondDelivered 各钩子注入（未注入 = 空操作）。
import { getPendingRequests, sendExtensionUIResponse, type ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import type { DialogRequest } from '@taiji/core'
import { isPlanReviewFrame, isRichInteractionFrame, type PlanReviewFrame } from './form-protocol'

/**
 * 请求分区容器最小操作面（双壳各自适配）：桌面 = extensionUIStore 四件套；移动 =
 * companion-bridge reactive Map 分区。requestId dedup 语义由实现保证（两壳 add 均幂等）。
 */
export interface FormChannelPartitions { // oe-exempt:20261016:framework:双壳分区接缝（桌面 store 四件套 / 移动 reactive Map 各一实现，ADR-0140 通道家族形态——接口先立、单实现常态）
  /** 分区当前条目（无则空数组；响应式上下文内调用建立依赖——由实现自保证） */
  get(sessionId: string): ExtensionUIRequest[]
  /** 入分区（requestId dedup：实时帧 + 快照补入双源幂等，由实现保证） */
  add(sessionId: string, req: ExtensionUIRequest): void
  /** 按 requestId 集合摘除（失效链 / respond 送达后共用；幂等，空清单 no-op） */
  remove(sessionId: string, requestIds: readonly string[]): void
  /**
   * 快照差集剔除（只保留 keepIds；单次不可变替换）。可选：缺省由本 factory 以 remove
   * 表达（移动侧形态）；桌面提供 store.retainOnly（批量单次替换，避免逐条替换的
   * 响应式重算放大）。
   */
  retainOnly?(sessionId: string, keepIds: ReadonlySet<string>): void
}

/** form/planReview 通道 factory 的壳层注入（帧适配必选；钩子可选，未注入 = 空操作） */
export interface FormRequestChannelOptions { // oe-exempt:20261016:framework:壳层策略回调注入面（dialog/permission 先例同族），单 factory 双壳消费
  /** 请求分区容器（桌面 store 分区 / 移动 reactive Map 分区适配） */
  partitions: FormChannelPartitions
  /**
   * C4 富交互门（默认 isRichInteractionFrame：form ∨ planReview 放行）。入帧（bus 热帧）
   * 与快照补入共用一道门；legacy 帧归一已在 runtime event-adapter 完成，本通道只认
   * view-ready 键。
   */
  frameFilter?: (req: unknown) => boolean
  /** bus 热帧适配（DialogRequest → ExtensionUIRequest，桌面白名单 + receivedAt 戳） */
  adaptFrame: (sessionId: string, request: DialogRequest) => ExtensionUIRequest
  /** 快照补入适配（解包帧 → 分区条目；移动与热帧同一适配器，桌面补 receivedAt 缺省） */
  adaptSnapshot: (sessionId: string, req: ExtensionUIRequest) => ExtensionUIRequest
  /** 入帧后钩子（桌面 planReview 镜像同步；适配后、dedup 写入后无条件调用） */
  onIngested?: (sessionId: string, req: ExtensionUIRequest) => void
  /**
   * 失效摘除后钩子：removed = 摘除前分区中实际被摘除的条目（桌面据此判定 planReview
   * answered / btw 草稿终结清理 / pendingSend 收口）。
   */
  onInvalidated?: (sessionId: string, requestIds: readonly string[], removed: readonly ExtensionUIRequest[]) => void
  /** 快照对账收尾钩子：removedIds = 本次被剔除的旧条目 id（桌面 btw 草稿 diff 清理 + 镜像同步） */
  onSnapshotReconciled?: (sessionId: string, removedIds: readonly string[]) => void
  /** respond 定位失败（请求已终结）钩子（桌面 toast requestExpired / 移动 console 留痕） */
  onRespondExpired?: (sessionId: string, requestId: string) => void
  /** respond 未送达钩子（桌面 toast / 移动错误条；分区条目保留可重试不变） */
  onRespondUndelivered?: (sessionId: string, requestId: string) => void
  /** respond 送达摘除后钩子（桌面 planReview answered / pendingSend 分型收口） */
  onRespondDelivered?: (sessionId: string, req: ExtensionUIRequest, result: boolean | string | null) => void
}

/** form/planReview 通道 factory 产出（写口 + 读口 + 回传） */
export interface FormRequestChannel { // oe-exempt:20261016:framework:form/planReview 通道产出接缝（createFormRequestChannel 单 factory，双壳策略面，ADR-0140）
  /**
   * bus 热帧入帧口（壳 bus 订阅 handler 消费；C4 门 → adaptFrame → 可选第二道闸
   * filter → 分区写入）：filter 是桌面实例分型闸（store 共享，实例只放各自标记——
   * formFilter / planReviewFilter / 恒真，requestId dedup 兜底多实例幂等），移动不传。
   */
  ingest(sessionId: string, request: DialogRequest, filter?: (req: ExtensionUIRequest) => boolean): void
  /** 失效摘除口（壳 requests-invalidated 订阅 handler 消费） */
  invalidate(sessionId: string, requestIds: readonly string[]): void
  /**
   * 快照对账（getPendingRequests 权威 pending 集：差集剔除 + 富交互帧补入）。失败静默
   * warn（RPC 降级不抛）。
   */
  reconcile(sessionId: string): void
  /** 用户回复指定请求（按 requestId 精确定位）。返回 true = 已送达并摘除；false = 未送达
   * （保留可重试）或请求已终结（经 onRespondExpired 呈现，不静默）。 */
  respond(sessionId: string, requestId: string, result: boolean | string | null): boolean
  /** 取消（等价 respond(sessionId, requestId, null)） */
  cancel(sessionId: string, requestId: string): void
  /** 队首 form 类请求（form 帧；桌面 formFilter 实例 / 移动 form 卡渲染面共用） */
  firstFormRequest(sessionId: string): ExtensionUIRequest | undefined
  /** 挂起 planReview 审批帧列表（正常时序恒单条，列表形态防多请求并发队首假设） */
  planReviewRequests(sessionId: string): PlanReviewFrame[]
}

/**
 * 创建 form/planReview 请求通道（每壳一次装配；算法单点在本 factory，分区与编排裁决在壳）。
 */
export function createFormRequestChannel(options: FormRequestChannelOptions): FormRequestChannel {
  const partitions = options.partitions
  const isFrame = options.frameFilter ?? isRichInteractionFrame

  function ingest(sessionId: string, request: DialogRequest, filter?: (req: ExtensionUIRequest) => boolean): void {
    // C4 富交互门（双壳共同放行面）：普通 dialog 帧由 CompanionBand 消费 bus 直连，
    // 与本通道零重叠
    if (!isFrame(request)) return
    const adapted = options.adaptFrame(sessionId, request)
    if (filter && !filter(adapted)) return
    partitions.add(sessionId, adapted)
    options.onIngested?.(sessionId, adapted)
  }

  function invalidate(sessionId: string, requestIds: readonly string[]): void {
    // 摘除前条目快照（removed 判定的输入；桌面 planReview answered 判据）
    const before = partitions.get(sessionId)
    const ids = new Set(requestIds)
    const removed = before.filter((r) => ids.has(r.requestId))
    partitions.remove(sessionId, requestIds)
    if (removed.length > 0) options.onInvalidated?.(sessionId, requestIds, removed)
  }

  function reconcile(sessionId: string): void {
    void getPendingRequests(sessionId)
      .then((pending) => {
        // keepIds 只含富交互帧（快照补入过滤）：普通 dialog 帧不入本通道分区（C4 语义
        // 对快照路径同扩），分区是富交互请求的权威消费副本
        const keepIds = new Set(
          pending.filter((r) => isFrame(r)).map((r) => r.requestId),
        )
        const existing = partitions.get(sessionId)
        const removedIds = existing
          .filter((r) => !keepIds.has(r.requestId))
          .map((r) => r.requestId)
        // 剔除调用在补入循环之外——空快照（keepIds 空集）同样执行剔除（僵尸请求修剪主算法）
        if (partitions.retainOnly) partitions.retainOnly(sessionId, keepIds)
        else partitions.remove(sessionId, removedIds)
        for (const req of pending) {
          if (!isFrame(req)) continue
          partitions.add(sessionId, options.adaptSnapshot(sessionId, req))
        }
        options.onSnapshotReconciled?.(sessionId, removedIds)
      })
      .catch((err) => {
        console.warn('[form-request-channel] failed to reconcile pending form requests:', err)
      })
  }

  function respond(sessionId: string, requestId: string, result: boolean | string | null): boolean {
    const target = partitions.get(sessionId).find((r) => r.requestId === requestId)
    if (!target) {
      // 已终结 requestId 的应答丢弃（失效呈现归壳层钩子，不静默）
      options.onRespondExpired?.(sessionId, requestId)
      return false
    }
    const delivered = sendExtensionUIResponse(target.sessionId ?? sessionId, target.requestId, target.dialogKind, result)
    if (!delivered) {
      // 未送达：保留分区条目，连接恢复后同 requestId 重发幂等（M1/RD-3#1）
      options.onRespondUndelivered?.(sessionId, requestId)
      return false
    }
    partitions.remove(sessionId, [requestId])
    options.onRespondDelivered?.(sessionId, target, result)
    return true
  }

  return {
    ingest,
    invalidate,
    reconcile,
    respond,
    cancel(sessionId: string, requestId: string): void {
      respond(sessionId, requestId, null)
    },
    firstFormRequest(sessionId: string): ExtensionUIRequest | undefined {
      return partitions.get(sessionId).find((r) => r.form === true)
    },
    planReviewRequests(sessionId: string): PlanReviewFrame[] {
      return partitions.get(sessionId).filter(isPlanReviewFrame)
    },
  }
}

/** 会话视图作用域的通道动作（bindSessionFormActions 产出，壳会话视图层直接返回消费） */
export interface SessionFormActions {
  /** 快照对账（sid 缺省跳过——无会话分区可对账） */
  reconcile(): void
  /** 回传（sid 缺省返回 false：无会话不可回传） */
  respond(requestId: string, result: boolean | string | null): boolean
  /** 取消（等价 respond(requestId, null)；sid 缺省 no-op） */
  cancel(requestId: string): void
}

/**
 * 会话视图作用域的通道动作绑定（双壳同构装配段收敛）：「当前会话 id 取值 + sid 守卫 +
 * channel 委托」的 respond/cancel/reconcile 薄包装此前在桌面 useExtensionUI 与移动
 * companion-bridge 的会话视图层各持逐字节同构副本（gate duplication E 组），收敛为
 * 本单点——sid 缺省语义（respond 返回 false / reconcile 跳过 / cancel 走 channel.cancel
 * 的 null 应答）在此单点维护。getSid 由壳注入（两壳均为 `() => sessionId.value` 的
 * Ref 读口），本模块保持零 Vue 依赖。
 */
export function bindSessionFormActions(
  channel: FormRequestChannel,
  getSid: () => string | null | undefined,
): SessionFormActions {
  return {
    reconcile(): void {
      const sid = getSid()
      if (sid) channel.reconcile(sid)
    },
    respond(requestId: string, result: boolean | string | null): boolean {
      const sid = getSid()
      if (!sid) return false
      return channel.respond(sid, requestId, result)
    },
    cancel(requestId: string): void {
      const sid = getSid()
      if (sid) channel.cancel(sid, requestId)
    },
  }
}
